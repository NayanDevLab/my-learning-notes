# P2-04 · Concurrency control

| | |
|---|---|
| **Phase** | 2 · Data and databases |
| **Prerequisites** | P2-03 · Transactions and isolation levels |
| **Leads to** | P3-04 · Rate limiting · P4-05 · Coordination: consensus, leader election, locks |
| **Repo path** | `system-design/phase-2/p2-04-concurrency-control.md` |

**After this card you can:**

1. Choose between an atomic conditional update, a pessimistic row lock, an optimistic version check and an advisory lock, based on the rule and the expected contention.
2. Use `FOR UPDATE`, `FOR NO KEY UPDATE`, `NOWAIT` and `SKIP LOCKED` correctly, and read what they do in `psql`.
3. Prevent deadlocks with a lock order, and recognise and retry the `40P01` error when one happens anyway.
4. Build a Postgres job queue where four worker processes never run the same job twice in normal operation.
5. Keep a hot merchant wallet fast with "hot row last", balance shards or batched credits, and show the numbers.

> **About the numbers in this guide.** Everything marked **Real output** was run while writing this guide on 23 Oct 2026, on a 2-vCPU Linux sandbox with PostgreSQL 16.15, Node.js 22.22, node-postgres 8.23.1 and async-mutex 0.5.0. The `psql` transcripts come from real interactive sessions driven by a script. The strategy benchmark is a Node.js harness that starts 1,000 transfers at once through a pool of 20 connections, against Postgres on the same machine; it stands in for the card's k6 run, which is in the lab for your machine (k6 was not installed here). Compare directions and ratios, not decimals. Anything marked **Expected** was not run here.
>
> **Versions** (checked 23 Oct 2026): k6 2.3.0 is the latest release; pg-boss 12.38.0 and graphile-worker 0.18.0 are the current Postgres-backed job queues on npm. Row locks, `SKIP LOCKED` and advisory locks behave the same on Postgres 16, 17 and 18.

---

## 🧭 The concept in one minute

Two requests want to change the same row at the same moment. **Concurrency control** is your rule for who goes first, and what the other one does: wait, retry, or give up.

Postgres gives you four practical tools:

| Tool | In one line |
|---|---|
| **Atomic conditional update** | Do the check and the change in one statement: `UPDATE ... SET balance = balance - 700 WHERE id = 3 AND balance >= 700`. |
| **Pessimistic lock** | Lock the row first (`SELECT ... FOR UPDATE`); everyone else waits until you finish. |
| **Optimistic lock** | Do not lock; at write time check that the row's `version` has not changed; if it has, start again. |
| **Advisory lock** | Lock a **name** you choose (`pg_advisory_xact_lock(...)`), for work that is not one row. |

**One line:** pessimistic means "wait your turn", optimistic means "try, and redo if someone beat you", atomic means "let the database do the check and the change in one step".

**Analogy: the railway reservation counter.** *Pessimistic:* you hold the berth chart while you fill the form; the queue behind you waits. *Optimistic:* everyone fills forms at the same time; at the window, if the chart changed since you looked, your form is torn up and you fill a new one. On a quiet day that is faster; on a Tatkal morning, most forms get torn up. *Atomic:* you just say "one lower berth if any is free", and the clerk checks and books in one action.

**On the ledger platform.** Ordinary transfers spread over many wallets: almost any correct tool works. Chai Point, a merchant wallet that receives a payment every millisecond at lunchtime, is a **hot row**: every tool slows down, and the optimistic one falls apart (in this guide, 280 to 295 of 1,000 payments gave up after 10 retries).

---

## 🔥 The problem it solves

Each item was measured in this guide.

1. **Locks taken in request order.** Transfers between 10 wallets lock the source row first, then the destination. Opposite transfers wait on each other in a circle: **106 to 112 deadlocks per 1,000 transfers**. Throughput fell from about 900 to **24 transfers a second**, and 751 to 791 of the 1,000 requests failed with lock or pool timeouts.
2. **Optimistic locking on a busy row.** 1,000 payments into one merchant wallet, each re-reading a version and retrying on a conflict: **5.2 to 5.4 retries per payment**, and 280 to 295 payments gave up after 10 attempts.
3. **A JavaScript mutex in four processes.** Each process guards "read balance, add ₹1, write back" with an in-memory mutex. Four processes, 1,000 top-ups: **643 top-ups lost**.
4. **A job queue without row locks.** Four workers read "the next 10 queued jobs" and then mark them running: **250 of 2,000 receipts were sent twice**.
5. **A hot merchant wallet.** Payments that credit the merchant row directly, locking rows lowest id first: **472 to 612 payments a second**. With batched credits on the same machine: **1,574 to 1,758 a second**.

This card gives you the tool for each case, and the numbers to choose with.

---

## 📚 Before you start

**Earlier cards used here:** P2-03 (isolation levels, the guarded `UPDATE`, the `withTransaction` and `withRetry` helpers, `40001`), P1-03 (idempotency keys and Problem Details), P1-02 (processes vs worker threads, graceful shutdown), P2-02 (partial indexes, used by the job table).

**Key terms**

| Term | Plain meaning |
|---|---|
| Contention | How often concurrent requests want the same row. Low: spread over many rows. High: many requests on one row. |
| Row lock | A lock on one row, held until the transaction ends. Other writers to that row wait. |
| Pessimistic locking | Lock before you read, so nobody can change the row while you decide. |
| Optimistic locking | Read without a lock; at write time, change the row only if it has not changed since you read it. |
| Version column | A number that goes up on every change; the optimistic check compares it. |
| ETag / `If-Match` | HTTP's version of the same idea: the server sends a version tag, the client sends it back when saving. |
| Deadlock | Two transactions each wait for a lock the other holds; neither can continue. |
| Lock ordering | Everyone takes locks in the same order (for example, lowest wallet id first), so a circle of waiting cannot form. |
| Advisory lock | A lock on an application-chosen number, not on a row. |
| Hot row | One row that a large share of all writes touch, such as a popular merchant's balance. |
| `SKIP LOCKED` | "Give me matching rows, but skip any that someone else has locked", instead of waiting. |
| Lease | A claim that expires: "worker 3 owns this job until 10:05:30". |

---

## 🧠 How it works

### Mental model: Postgres row locks live in the row, and waiting means waiting for a transaction

- **A row lock is not held in Node.js memory.** Postgres records it on the row itself (in the row's header) and keeps it until the transaction that took it commits or rolls back.
- **Waiting for a row lock really means waiting for a transaction to end.** In `pg_locks`, a blocked session waits for a `ShareLock` on the holder's transaction ID (P2-03's long-transaction lab showed this).
- **Plain reads never wait for row locks.** A normal `SELECT` reads its snapshot (MVCC, P2-03). Only writes and locking reads (`FOR UPDATE`, `FOR SHARE` ...) queue.
- **Every process that talks to the same database sees the same locks.** That is why a database lock protects data across four Node.js processes and twenty pods, and a JavaScript mutex does not.

### The four row-lock modes

`UPDATE` and `DELETE` take these automatically; `SELECT ... FOR <mode>` takes them explicitly. From strongest to weakest:

| Mode | Taken automatically by | Blocks |
|---|---|---|
| `FOR UPDATE` | `DELETE`, and `UPDATE` of a key column | Every other row lock, including `FOR KEY SHARE` (so it blocks foreign-key checks from child inserts) |
| `FOR NO KEY UPDATE` | Any other `UPDATE` (the usual case) | `FOR SHARE`, `FOR NO KEY UPDATE`, `FOR UPDATE`; **not** `FOR KEY SHARE` |
| `FOR SHARE` | Explicit only | `FOR NO KEY UPDATE`, `FOR UPDATE` (writers); not other sharers |
| `FOR KEY SHARE` | Foreign-key checks when a child row is inserted | Only `FOR UPDATE` |

**Rule of thumb:** to lock a row you are about to update (and you will not change its primary key), use `FOR NO KEY UPDATE`. It is the same lock a plain `UPDATE` takes, so it does not block other tables inserting rows that reference this one.

### The decision table (must-include)

| | Atomic conditional update | Pessimistic lock (`FOR NO KEY UPDATE`) | Optimistic version check | Advisory lock |
|---|---|---|---|---|
| **How it works** | Check inside the statement's `WHERE` | Lock rows (lowest id first), then read, check, write | Read with version; write `WHERE version = $v`; 0 rows → start again | Lock a chosen name for the whole transaction |
| **Loser** | Waits for the row lock, re-checks, may update 0 rows | Waits in line | Does its work, then throws it away and retries | Waits in line (or skips, with `pg_try_...`) |
| **Best when** | The rule fits in one `UPDATE` (balance ≥ 0, stock > 0, seat free) | The decision needs a read and logic before writing, on a few rows | Contention is low, or the "transaction" spans HTTP requests (a user editing settings) | The thing to protect is not a row: a payout run, a daily report, a migration |
| **Worst when** | The rule spans several rows or tables | Many transactions want the same row (they queue) or locks are taken in different orders (deadlocks) | Contention is high: retry storms | Used instead of row locks for row data; session-level locks with a transaction-pooling proxy |
| **Retries needed** | No | Only for deadlocks (`40P01`), if order is not enforced | Yes, always | No |
| **This guide, 10 wallets** | 1,021 to 1,187 transfers/s, 0 retries | 840 to 899/s, 0 retries | 355 to 377/s, about 3.4 retries per transfer | Not used for transfers |
| **This guide, 1 hot merchant** | 555 to 612/s, 0 retries | 490 to 554/s, 0 retries | 236 to 257/s, 280 to 295 of 1,000 gave up | Not used for transfers |

**How to read it.** Start from the left. If one statement can carry the rule, use it. If you need to read and decide first, lock the rows (in order). Use optimistic checks where waiting on a lock is impossible or pointless: a user who loads a form, thinks for a minute and saves. Use an advisory lock only when there is no row to lock.

---

## 🔬 Deep dive

> **Reading the transcripts.** Two or three `psql` sessions (A, B, C) run against the same database; lines appear in the order things really happened. `ledger=*#` means "inside a transaction", `ledger=!#` "the transaction failed". Lines starting with `--` are notes added for reading; everything else is real `psql` input and output. The lab schema (wallets 1 Riya, 2 Amit, 3 Chai Point; amounts in paise) is in the Hands-on lab.

### 1. Pessimistic locking: FOR UPDATE, FOR NO KEY UPDATE, NOWAIT and SKIP LOCKED

**What it is.** You lock the rows before you read them, so nobody can change them while your code decides. Everyone else who wants to write or lock those rows waits until your transaction ends.

**`FOR UPDATE`, `NOWAIT`, and plain reads.** **Real output**

```text
(A) ledger=# BEGIN;
BEGIN
(A) ledger=*# SELECT id, balance_minor FROM wallets WHERE id = 1 FOR UPDATE;
 id | balance_minor
----+---------------
  1 |        600000
(1 row)
(B) ledger=# BEGIN;
BEGIN
(B) ledger=*# SELECT id, balance_minor FROM wallets WHERE id = 1 FOR UPDATE NOWAIT;
ERROR:  could not obtain lock on row in relation "wallets"
(B) ledger=!# ROLLBACK;
ROLLBACK
(B) ledger=# SELECT id, balance_minor FROM wallets WHERE id = 1;
 id | balance_minor
----+---------------
  1 |        600000
(1 row)
(B) ledger=# BEGIN;
BEGIN
(B) ledger=*# SELECT id, balance_minor FROM wallets WHERE id = 1 FOR UPDATE;
-- (B) is waiting...
(A) ledger=*# UPDATE wallets SET balance_minor = balance_minor - 10000 WHERE id = 1;
UPDATE 1
(A) ledger=*# COMMIT;
COMMIT
-- (B) continues:
 id | balance_minor
----+---------------
  1 |        590000
(1 row)
(B) ledger=*# COMMIT;
COMMIT
```

**What to notice**
- **`NOWAIT` failed at once** with `could not obtain lock on row in relation "wallets"` (SQLSTATE `55P03`, `lock_not_available`). Use it when waiting is worse than failing, for example "someone else is editing this, try again".
- **B's plain `SELECT` did not wait.** Readers never wait for row locks; they read their snapshot.
- **B's `FOR UPDATE` waited, then returned 590000**, the value A committed. A locking read at Read Committed always returns the newest committed version, which is why "lock, then read" is safe.

**`FOR UPDATE` vs `FOR NO KEY UPDATE`.** `withdrawals.wallet_id` references `wallets.id`. Inserting a withdrawal makes Postgres take a `FOR KEY SHARE` lock on the wallet row (to make sure the wallet is not deleted meanwhile). **Real output**

```text
-- A locks Riya's wallet row with FOR UPDATE
(A) ledger=# BEGIN;
BEGIN
(A) ledger=*# SELECT id FROM wallets WHERE id = 1 FOR UPDATE;
 id
----
  1
(1 row)
(B) ledger=# INSERT INTO withdrawals (wallet_id, amount_minor) VALUES (1, 5000);
-- (B) is waiting...
(A) ledger=*# ROLLBACK;
ROLLBACK
-- (B) continues:
INSERT 0 1
-- now A uses the weaker FOR NO KEY UPDATE (what a plain UPDATE takes)
(A) ledger=# BEGIN;
BEGIN
(A) ledger=*# SELECT id FROM wallets WHERE id = 1 FOR NO KEY UPDATE;
 id
----
  1
(1 row)
(B) ledger=# INSERT INTO withdrawals (wallet_id, amount_minor) VALUES (1, 5000);
INSERT 0 1
(A) ledger=*# COMMIT;
COMMIT
```

**What to notice**
- **Under `FOR UPDATE`, an unrelated insert into a child table waited.** In the ledger, that would be every ledger entry, withdrawal or transfer that references the wallet.
- **Under `FOR NO KEY UPDATE`, the same insert went straight through.** That is the lock a normal `UPDATE` takes, and the right one when you will update the row but never change its id.

**`SKIP LOCKED`.** Two workers ask for "the next 2 queued jobs" at the same time. **Real output**

```text
(A) ledger=# BEGIN;
BEGIN
(A) ledger=*# SELECT id, kind FROM jobs WHERE status = 'queued' ORDER BY id LIMIT 2 FOR UPDATE SKIP LOCKED;
 id |     kind
----+--------------
  1 | send_receipt
  2 | send_receipt
(2 rows)
(B) ledger=# BEGIN;
BEGIN
(B) ledger=*# SELECT id, kind FROM jobs WHERE status = 'queued' ORDER BY id LIMIT 2 FOR UPDATE SKIP LOCKED;
 id |     kind
----+--------------
  3 | send_receipt
  4 | send_receipt
(2 rows)
(A) ledger=*# UPDATE jobs SET status = 'done' WHERE id IN (1, 2);
UPDATE 2
(B) ledger=*# UPDATE jobs SET status = 'done' WHERE id IN (3, 4);
UPDATE 2
(A) ledger=*# COMMIT;
COMMIT
(B) ledger=*# COMMIT;
COMMIT
(A) ledger=# SELECT id, status FROM jobs ORDER BY id;
 id | status
----+--------
  1 | done
  2 | done
  3 | done
  4 | done
  5 | queued
  6 | queued
(6 rows)
```

**What to notice**
- **B did not wait for A and did not get A's jobs:** it skipped rows 1 and 2 (locked by A) and took 3 and 4.
- **The Postgres docs warn that `SKIP LOCKED` gives an inconsistent view** of the table, so it is not for general reads. It is made for queue-like tables, where "any unclaimed job" is the right answer. Lab step 4 builds the real worker on it.

**When to use pessimistic locks.** When the decision needs a read and some logic (fraud rules, limits, multi-row checks) and only a few rows are involved. Keep the transaction short, lock in a fixed order (Deep dive 4), and set `lock_timeout` so a stuck holder cannot make everyone wait forever (P2-03).

**When not to.** For a single-row rule an atomic statement is enough. On a hot row, every transaction waits in one line. And never across a network call or a user's think-time (common mistake 4).

### 2. Optimistic locking: a version column, ETag and If-Match

**What it is.** Each row carries a `version`. You read the row and its version without locking. When you write, you add `WHERE version = $v` and bump the version. If zero rows changed, someone else saved first: re-read and decide again.

**Real output**: two apps both try to withdraw ₹700 from Amit's ₹1,000, using version 1.

```text
(A) ledger=# SELECT id, balance_minor, version FROM wallets WHERE id = 2;
 id | balance_minor | version
----+---------------+---------
  2 |        100000 |       1
(1 row)
(B) ledger=# SELECT id, balance_minor, version FROM wallets WHERE id = 2;
 id | balance_minor | version
----+---------------+---------
  2 |        100000 |       1
(1 row)
-- both apps want to withdraw 70000 from Amit's 100000, based on version 1
(A) ledger=# UPDATE wallets SET balance_minor = 30000, version = version + 1 WHERE id = 2 AND version = 1 RETURNING version;
 version
---------
       2
(1 row)

UPDATE 1
(B) ledger=# UPDATE wallets SET balance_minor = 30000, version = version + 1 WHERE id = 2 AND version = 1 RETURNING version;
 version
---------
(0 rows)

UPDATE 0
-- zero rows: the version moved on. B re-reads and decides again
(B) ledger=# SELECT id, balance_minor, version FROM wallets WHERE id = 2;
 id | balance_minor | version
----+---------------+---------
  2 |         30000 |       2
(1 row)
-- 30000 < 70000: B rejects the withdrawal
```

**What to notice**
- **No locks were held between the read and the write.** The check happens inside A's and B's `UPDATE` statements.
- **B got `UPDATE 0`**, re-read the row (version 2, ₹300) and rejected its withdrawal. Nothing was lost.
- **In Postgres, B's `UPDATE` still waits** if A's update is in an uncommitted transaction; it then re-checks `version = 1` and finds 2. Optimistic does not mean "never waits"; it means "never holds a lock while thinking".

**Where optimistic locking shines: edits that span HTTP requests.** Riya opens wallet settings on her phone and on her laptop. Both load version 1. She saves a new nickname on the phone, then changes the daily limit on the laptop. You cannot hold a database lock between "page loaded" and "Save tapped" (minutes, maybe forever), so the version travels to the client as an **ETag**, and comes back in **`If-Match`**:

- `GET` returns the settings and `ETag: "1"`.
- `PATCH` with `If-Match: "1"` succeeds only if the version is still 1, and returns the new `ETag: "2"`.
- A stale `If-Match` gets **`412 Precondition Failed`**; a missing one gets **`428 Precondition Required`**, so no client can skip the check by accident.

**Product version:** `src/routes/walletSettings.ts`

```ts
// src/routes/walletSettings.ts: optimistic locking at the API edge with ETag and If-Match.
// Two devices edit the same wallet settings; the second save must not silently overwrite the first.
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";

const Params = z.object({ walletId: z.uuid() });
const Patch = z.object({
  nickname: z.string().trim().min(1).max(40).optional(),
  dailyLimitMinor: z.number().int().positive().max(10_00_00_000).optional(), // up to ₹10 lakh a day
}).refine((p) => Object.keys(p).length > 0, "nothing to change");

type Row = { nickname: string; daily_limit_minor: string; version: string };
const etagOf = (version: string | number) => `"${version}"`;            // a strong ETag: the row's version
const body = (r: Row) => ({ nickname: r.nickname, dailyLimitMinor: Number(r.daily_limit_minor) });
const problem = (status: number, type: string, title: string) => ({ type: `https://errors.ledger.example/${type}`, title, status });

// If-Match: "7"  ->  7.   If-Match: *  ->  "any".   Weak tags (W/"7") never match for If-Match (RFC 9110).
function expectedVersion(header: string | undefined): number | "any" | undefined {
  if (header === undefined) return undefined;
  if (header.trim() === "*") return "any";
  const match = /^"(\d+)"$/.exec(header.trim());
  return match ? Number(match[1]) : -1; // -1 never equals a real version, so the request gets 412
}

export function walletSettingsRoutes(pool: Pool) {
  return async function register(app: FastifyInstance): Promise<void> {
    app.get("/v1/wallets/:walletId/settings", async (request, reply) => {
      const { walletId } = Params.parse(request.params);
      const { rows: [row] } = await pool.query<Row>("SELECT nickname, daily_limit_minor, version FROM wallets WHERE id = $1", [walletId]);
      if (!row) return reply.code(404).type("application/problem+json").send(problem(404, "wallet-not-found", "Wallet not found"));
      return reply.header("etag", etagOf(row.version)).send(body(row));
    });

    app.patch("/v1/wallets/:walletId/settings", async (request, reply) => {
      const { walletId } = Params.parse(request.params);
      const patch = Patch.parse(request.body);
      const expected = expectedVersion(request.headers["if-match"]);
      if (expected === undefined) {
        return reply.code(428).type("application/problem+json")
          .send(problem(428, "precondition-required", "Send If-Match with the ETag you last read"));
      }
      // Compare-and-set: the WHERE clause is the whole lock. Zero rows = someone saved first (or no such wallet).
      const { rows: [row] } = await pool.query<Row>(
        `UPDATE wallets SET nickname = coalesce($3, nickname), daily_limit_minor = coalesce($4, daily_limit_minor),
                            version = version + 1
          WHERE id = $1 AND ($2::bigint IS NULL OR version = $2)
          RETURNING nickname, daily_limit_minor, version`,
        [walletId, expected === "any" ? null : expected, patch.nickname ?? null, patch.dailyLimitMinor ?? null]);
      if (row) return reply.header("etag", etagOf(row.version)).send(body(row));
      const exists = await pool.query("SELECT 1 FROM wallets WHERE id = $1", [walletId]);
      return exists.rowCount === 0
        ? reply.code(404).type("application/problem+json").send(problem(404, "wallet-not-found", "Wallet not found"))
        : reply.code(412).type("application/problem+json").send(problem(412, "edit-conflict", "Settings changed since you loaded them; reload and try again"));
    });
  };
}
```

**What to notice**
- **The compare-and-set is one `UPDATE` with `version = $2` in the `WHERE`.** That single statement is the whole lock.
- **Zero rows is two different answers:** the wallet does not exist (`404`), or someone saved first (`412`). The extra `SELECT` tells them apart.
- **`If-Match: *`** (allowed by HTTP) means "update whatever is there" and skips the version check; weak tags such as `W/"1"` never match, as RFC 9110 requires for `If-Match`.
- **The settings have their own `version` on `wallets`, separate from the balance row.** If transfers bumped the same version, every save during a payment would get a false `412`. Version the thing the user edits.

`test/walletSettings.test.ts`

```ts
// test/walletSettings.test.ts: two devices, one wallet's settings, If-Match decides who wins.
import Fastify from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createPool } from "../src/lib/db/pool.js";
import { walletSettingsRoutes } from "../src/routes/walletSettings.js";

const pool = createPool(process.env.TEST_DATABASE_URL ?? "postgres://postgres:lab@127.0.0.1/ledger_cc");
const app = Fastify();
await app.register(walletSettingsRoutes(pool));
let walletId = "";
beforeEach(async () => {
  const { rows } = await pool.query<{ id: string }>("INSERT INTO wallets (kind, nickname) VALUES ('user', 'Riya main') RETURNING id");
  walletId = rows[0]!.id;
});
afterAll(async () => { await app.close(); await pool.end(); });

const url = () => `/v1/wallets/${walletId}/settings`;

describe("PATCH /v1/wallets/:id/settings", () => {
  it("lets the first save win and answers 412 to the second device that read the same version", async () => {
    const etag = (await app.inject({ method: "GET", url: url() })).headers.etag as string;   // both devices read "1"
    const phone = await app.inject({ method: "PATCH", url: url(), headers: { "if-match": etag }, payload: { nickname: "Daily spends" } });
    const laptop = await app.inject({ method: "PATCH", url: url(), headers: { "if-match": etag }, payload: { dailyLimitMinor: 5_00_000 } });
    expect(phone.statusCode).toBe(200);
    expect(phone.headers.etag).toBe('"2"');
    expect(laptop.statusCode).toBe(412);
    const now = await app.inject({ method: "GET", url: url() });
    expect(now.json()).toEqual({ nickname: "Daily spends", dailyLimitMinor: 10_00_000 }); // the laptop's change was NOT applied
  });

  it("requires If-Match (428) so a client cannot skip the check by accident", async () => {
    const res = await app.inject({ method: "PATCH", url: url(), payload: { nickname: "x" } });
    expect(res.statusCode).toBe(428);
  });
});
```

**Real output** (from `npx vitest run --reporter=verbose`)

```text
✓ test/walletSettings.test.ts > PATCH /v1/wallets/:id/settings > lets the first save win and answers 412 to the second device that read the same version 50ms
✓ test/walletSettings.test.ts > PATCH /v1/wallets/:id/settings > requires If-Match (428) so a client cannot skip the check by accident 4ms
```

**Where optimistic locking fails: busy rows.** Every conflict throws away a whole transaction's work and starts again. In the benchmark, optimistic transfers needed **3.4 retries per transfer** among 10 wallets and **5.2 to 5.4 per payment** into one merchant, and 2 to 3.5% (10 wallets) and 28 to 30% (one merchant) of requests gave up after 10 attempts.

### 3. Atomic conditional updates: often the simplest correct tool

**What it is.** The check and the change in one statement, as in P2-03:

```sql
UPDATE wallet_balances SET balance_minor = balance_minor + $2
 WHERE wallet_id = $1 AND balance_minor + $2 >= 0;   -- $2 is negative for a debit
```

One row updated means "done"; zero rows means "not enough money". At Read Committed, a concurrent update waits for the row lock and then re-checks the `WHERE` on the newest version, so two debits can never both pass.

**Product version:** `applyBalanceChange` in `src/repositories/balanceRepository.ts` (lab step 1), used by the atomic strategy and by the hot-wallet payments.

**Why it often wins.** No read round trip, no lock held while your code thinks, no retries. In this guide's benchmark it had the best or near-best throughput in every scenario: 1,090 to 1,657 transfers/s with 1,000 wallets, 1,021 to 1,187 with 10 wallets, and 555 to 612 on one hot merchant.

**Credits are even easier.** Adding money never breaks "balance ≥ 0", so a credit needs no check at all: `SET balance_minor = balance_minor + $2`. That is why hot-merchant credits can be sharded or batched (Deep dive 6).

**When it is not enough.** When the decision needs data from other rows or tables (a daily limit over many transfers, a fraud score, "only if the order is still open"). Then lock the rows (Deep dive 1), use Serializable (P2-03), or keep a counter row you can guard in one statement.

### 4. Deadlocks: lock ordering, detection, and the error you get

**What it is.** Riya sends ₹100 to Amit while Amit sends ₹50 to Riya. Each transfer debits its source first. Transfer A locks wallet 1 and wants wallet 2; transfer B locks wallet 2 and wants wallet 1. Each waits for the other, forever. Postgres notices, aborts one of them, and lets the other finish.

**Real output**: the deadlock.

```text
-- A: Riya -> Amit (debit wallet 1, then credit wallet 2)
-- B: Amit -> Riya (debit wallet 2, then credit wallet 1)
(A) ledger=# BEGIN;
BEGIN
(B) ledger=# BEGIN;
BEGIN
(A) ledger=*# UPDATE wallets SET balance_minor = balance_minor - 10000 WHERE id = 1;
UPDATE 1
(B) ledger=*# UPDATE wallets SET balance_minor = balance_minor - 5000 WHERE id = 2;
UPDATE 1
(A) ledger=*# UPDATE wallets SET balance_minor = balance_minor + 10000 WHERE id = 2;
-- (A) is waiting...
(B) ledger=*# UPDATE wallets SET balance_minor = balance_minor + 5000 WHERE id = 1;
ERROR:  deadlock detected
DETAIL:  Process 328 waits for ShareLock on transaction 90561; blocked by process 326.
Process 326 waits for ShareLock on transaction 90562; blocked by process 328.
HINT:  See server log for query details.
CONTEXT:  while updating tuple (0,1) in relation "wallets"
-- (B's statement returned after 1.1 s: deadlock_timeout is 1 s)
-- (A) continues:
UPDATE 1
(A) ledger=*# COMMIT;
COMMIT
(B) ledger=!# COMMIT;
ROLLBACK
(A) ledger=# SELECT id, balance_minor FROM wallets WHERE id IN (1, 2) ORDER BY id;
 id | balance_minor
----+---------------
  1 |        590000
  2 |        110000
(2 rows)
```

**Diagram: the deadlock (debit first, in request order)**

```mermaid
sequenceDiagram
  participant A as Transfer A, Riya to Amit
  participant PG as Postgres
  participant B as Transfer B, Amit to Riya
  A->>PG: 1. UPDATE wallet 1, debit. Lock on 1
  B->>PG: 2. UPDATE wallet 2, debit. Lock on 2
  A->>PG: 3. UPDATE wallet 2, credit. Waits for B
  B->>PG: 4. UPDATE wallet 1, credit. Waits for A
  Note over A,B: a circle: A waits for B, B waits for A
  PG-->>B: 5. after deadlock_timeout, 1 s. ERROR 40P01 deadlock detected
  PG-->>A: 6. lock on 2 granted, UPDATE 1
  A->>PG: 7. COMMIT. B must retry from the start
```

**How to read this diagram.** Steps 1 and 2 each take one lock. Steps 3 and 4 each wait for the lock the other holds, so neither can ever continue. Postgres only checks for this circle after a waiter has waited `deadlock_timeout` (1 second by default), then aborts one transaction (5); which one is not predictable. The survivor continues (6, 7). B's transfer did not happen; your code must retry it.

**The fix: everyone locks the lower wallet id first.** **Real output**

```text
-- same two transfers, but each touches the LOWER wallet id first
(A) ledger=# BEGIN;
BEGIN
(B) ledger=# BEGIN;
BEGIN
(A) ledger=*# UPDATE wallets SET balance_minor = balance_minor - 10000 WHERE id = 1;
UPDATE 1
(B) ledger=*# UPDATE wallets SET balance_minor = balance_minor + 5000 WHERE id = 1;
-- (B) is waiting...
(A) ledger=*# UPDATE wallets SET balance_minor = balance_minor + 10000 WHERE id = 2;
UPDATE 1
(A) ledger=*# COMMIT;
COMMIT
-- (B) continues:
UPDATE 1
(B) ledger=*# UPDATE wallets SET balance_minor = balance_minor - 5000 WHERE id = 2;
UPDATE 1
(B) ledger=*# COMMIT;
COMMIT
(A) ledger=# SELECT id, balance_minor FROM wallets WHERE id IN (1, 2) ORDER BY id;
 id | balance_minor
----+---------------
  1 |        595000
  2 |        105000
(2 rows)
```

**Diagram: the same two transfers, lower wallet id first**

```mermaid
sequenceDiagram
  participant A as Transfer A, Riya to Amit
  participant PG as Postgres
  participant B as Transfer B, Amit to Riya
  A->>PG: 1. UPDATE wallet 1 first, debit. Lock on 1
  B->>PG: 2. UPDATE wallet 1 first, credit. Waits for A
  A->>PG: 3. UPDATE wallet 2, credit. Lock on 2
  A->>PG: 4. COMMIT, both locks released
  PG-->>B: 5. lock on 1 granted
  B->>PG: 6. UPDATE wallet 2, debit. Lock on 2
  B->>PG: 7. COMMIT
```

**How to read this diagram.** Both transfers start with wallet 1, the lower id, whatever their direction. B simply queues behind A at step 2, and nothing ever waits for a lower id while holding a higher one. No circle can form, so no deadlock: B waited a few milliseconds instead of being aborted after a second.

**Why ordering works (card question 2).** A circle of waiting needs someone holding a higher id to wait for a lower one. With "lowest id first", a transaction only ever waits for ids above everything it already holds. Follow any chain of waiting and the ids only go up, so it can never come back to where it started.

**In code**, order in both places you take locks:

```ts
// TypeScript: decide the order once. Plain < compares code units, which matches Postgres's uuid order
// for lowercase UUIDs; localeCompare is locale-sensitive and promises no such thing.
const lowerFirst = (a: string, b: string): [string, string] => (a < b ? [a, b] : [b, a]);
```

```sql
-- SQL: lock several rows in one statement, in id order.
SELECT wallet_id, balance_minor FROM wallet_balances
 WHERE wallet_id = ANY($1::uuid[]) ORDER BY wallet_id FOR NO KEY UPDATE;
```

**Detection and the error.** Postgres reports `ERROR: deadlock detected` with SQLSTATE **`40P01`**, a `DETAIL` naming the processes and transactions, and the full queries in the server log. The aborted transaction must be retried from the start, which P2-03's `withRetry` already does for `40P01`. Every deadlock costs at least `deadlock_timeout` of waiting, while both transactions hold their locks and connections.

**At scale, measured.** The same lab with locks taken in request order (source first), 1,000 transfers among 10 wallets: **106 to 112 deadlocks**, and the waiting spread. **Real output** (errors grouped by SQLSTATE):

```text
spread: 10 wallets | pessimistic, UNORDERED locks | ok  225 | gave up   0 | errors 775 {"57014":3,"55P03":114,"timeout exceeded when trying to connect":658} | retries   110 {"40P01":110} |    24/s | p50 30003 ms | p95 37336 ms | conserved true | min 9890000
```

Each deadlock held two connections for a second; transactions queued behind those locks hit `lock_timeout` (`55P03`, 114 of them) or `statement_timeout` (`57014`, 3); and with the pool's 20 connections stuck, 658 requests timed out waiting for a connection. With the product pool's 2-second connection timeout, it was worse: 938 to 980 of 1,000 failed. The money stayed correct throughout, but the service was effectively down. With ordered locks, the same workload ran at 840 to 899 transfers a second with zero errors.

### 5. Advisory locks: pg_advisory_xact_lock for application-level critical sections

**What it is.** A lock on a number you choose, not on a row. Postgres keeps it in its lock table like any other lock, so every process and pod connected to the database sees it. Use it to make sure only one instance does some job at a time: one payout run per merchant per day, one statement export per wallet, one migration.

**Two flavours.**
- **Transaction-level** (`pg_advisory_xact_lock`, `pg_try_advisory_xact_lock`): released automatically at `COMMIT` or `ROLLBACK`. Use this one by default.
- **Session-level** (`pg_advisory_lock`, `pg_advisory_unlock`): held until you unlock or the connection closes, **even across a rollback**, and counted (lock twice, unlock twice). With a connection pool, a forgotten unlock leaks the lock into the next request that borrows the connection, and with a transaction-pooling proxy such as PgBouncer, the "session" is not yours. Avoid unless you really need it.

**Keys.** The functions take a `bigint` (or two `int`s). Turn a readable name into one with `hashtextextended(text, 0)`, which returns a 64-bit hash. Two different names could hash to the same key; the only effect is that two unrelated jobs would wait for each other, which is safe.

**Real output**

```text
(A) ledger=# BEGIN;
BEGIN
(A) ledger=*# SELECT pg_advisory_xact_lock(hashtextextended('payout-run:merchant-3:2026-10-23', 0));
 pg_advisory_xact_lock
-----------------------

(1 row)
(B) ledger=# BEGIN;
BEGIN
(B) ledger=*# SELECT pg_try_advisory_xact_lock(hashtextextended('payout-run:merchant-3:2026-10-23', 0)) AS got_it;
 got_it
--------
 f
(1 row)
(C) ledger=# SELECT pid, locktype, mode, granted FROM pg_locks WHERE locktype = 'advisory';
 pid | locktype |     mode      | granted
-----+----------+---------------+---------
 338 | advisory | ExclusiveLock | t
(1 row)
(B) ledger=*# SELECT pg_advisory_xact_lock(hashtextextended('payout-run:merchant-3:2026-10-23', 0));
-- (B) is waiting...
(A) ledger=*# COMMIT;
COMMIT
-- (B) continues:
 pg_advisory_xact_lock
-----------------------

(1 row)
(B) ledger=*# COMMIT;
COMMIT
```

**What to notice**
- **`pg_try_advisory_xact_lock` returned `f`** at once: "someone else is running this payout", so B can skip instead of wait.
- **`pg_locks` shows it as `locktype = 'advisory'`**, granted to A's backend: the same tool you use to debug row locks.
- **B's blocking call waited until A committed**, then got the lock. No unlock call anywhere.

**Product pattern:** one payout run per merchant per day, whichever pod's scheduler fires first.

```ts
// src/services/payoutRun.ts (excerpt)
export async function runDailyPayout(pool: Pool, log: Logger, merchantId: string, day: string): Promise<"done" | "skipped"> {
  return withTransaction(pool, { isolationLevel: "READ COMMITTED" }, async (tx) => {
    const { rows } = await tx.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS locked", [`payout-run:${merchantId}:${day}`]);
    if (!rows[0]!.locked) {
      log.info({ merchant_id: merchantId, day }, "payout run already in progress elsewhere; skipping");
      return "skipped";
    }
    // ... compute the payout, INSERT INTO payouts (merchant_id, day, ...) with UNIQUE (merchant_id, day) as a backstop,
    //     and an outbox row for the bank transfer (P4-07). The bank call itself happens after COMMIT.
    return "done";
  });
}
```

**When not to use advisory locks.** To protect a row: lock the row itself, so code that forgets the advisory lock is still safe. For long work: the lock lives as long as the transaction, and long transactions hurt (P2-03); for long jobs, use a job row with a lease instead (lab step 4). And across databases or services: an advisory lock exists in one Postgres only (P4-05 covers distributed locks, leases and fencing tokens).

### 6. Hot rows: one popular wallet or merchant

**What it is.** Chai Point receives a payment every millisecond at lunchtime. Every payment credits the same `wallet_balances` row, so every payment transaction takes the same row lock, and they run one at a time **however many servers and connections you add**. The ceiling is roughly 1 ÷ (how long each transaction holds that lock).

**Measured here:** 1,000 payments from 1,000 customers into one merchant. With the merchant row updated directly, throughput was **472 to 612 payments a second**, half or less of what the same transactions achieved when spread over 1,000 wallets.

**Mitigations, from cheapest to most involved**

1. **Hold the hot lock for less time.** Touch the hot row **last** in the transaction, just before `COMMIT`, and keep the transaction short. All other lock orders must agree (payer first, merchant last, for payments and refunds alike), or you reintroduce deadlocks. Any fixed order works; it does not have to be by id.
2. **Split the balance into sub-accounts (shards).** Keep N rows per merchant (`balance_shards`, 16 here). Each credit adds to a random shard; the balance is the sum. Debits (payouts) are rare: lock all shards in shard order, or take from one shard with enough money.
3. **Batch the credits.** The payment transaction appends a row to `pending_credits` (no merchant lock at all). A batcher, every 50 ms here, applies all pending credits in **one** `UPDATE`. The ledger entries are written at payment time, so the books are always right; only the cached balance lags, by one batch interval.
4. **A queue per key.** Send payments for one merchant to one Kafka partition (keyed by merchant id), and let one consumer apply them in batches (P3-05, P4-06). The same idea as batching, across services. Not run here.

**Real output** (`bench/hotWallet.ts`, three runs each)

```text
direct, lower id first     |   472 payments/s | p50  1235 ms | p95  2037 ms | merchant total correct
direct, lower id first     |   560 payments/s | p50   938 ms | p95  1716 ms | merchant total correct
direct, lower id first     |   543 payments/s | p50   980 ms | p95  1742 ms | merchant total correct
direct, merchant row last  |   900 payments/s | p50   551 ms | p95  1062 ms | merchant total correct
direct, merchant row last  |   906 payments/s | p50   555 ms | p95  1061 ms | merchant total correct
direct, merchant row last  |   982 payments/s | p50   533 ms | p95   982 ms | merchant total correct
16 balance shards          |  1553 payments/s | p50   357 ms | p95   622 ms | merchant total correct
16 balance shards          |  1386 payments/s | p50   375 ms | p95   697 ms | merchant total correct
16 balance shards          |  1577 payments/s | p50   320 ms | p95   600 ms | merchant total correct
batched credits            |  1574 payments/s | p50   348 ms | p95   610 ms | merchant total correct | 12 batches | balance caught up 44 ms after the last payment
batched credits            |  1720 payments/s | p50   331 ms | p95   557 ms | merchant total correct | 11 batches | balance caught up 46 ms after the last payment
batched credits            |  1758 payments/s | p50   282 ms | p95   542 ms | merchant total correct | 11 batches | balance caught up 51 ms after the last payment
```

**What to notice**
- **Just moving the merchant update to the end roughly doubled throughput** (472 to 560 → 900 to 982 per second): the hot lock was held for less of each transaction.
- **Shards and batching reached 1,386 to 1,758 per second**, about 3 times the starting point and close to the speed of payments spread over 1,000 wallets. The hot row stopped being the bottleneck.
- **Batching applied 1,000 payments in 11 or 12 `UPDATE`s**, and the cached balance caught up 44 to 51 ms after the last payment.
- **Every run ended with the correct merchant total.** The cost is somewhere else: shards make reads a `SUM` and payouts harder; batching makes the cached balance slightly stale.

| Mitigation | Payments/s here | Balance read | Payouts (debits) | Extra moving parts |
|---|---|---|---|---|
| Direct, lower id first | 472 to 612 | One row | Simple | None |
| Hot row last | 900 to 982 | One row | Simple, same lock order | A documented lock order |
| 16 shards | 1,386 to 1,577 | `SUM` of 16 rows | Lock all shards, or pick one with enough money | Shard table |
| Batched credits | 1,574 to 1,758 | Cached row + unapplied credits | Must apply pending credits first, or check the sum | A batcher process, lag of one interval |
| Queue per key | Not run | Consumer's state | Through the same queue | Kafka (P4-06) |

### 7. Unique constraints as concurrency control: idempotency keys and seat booking

**What it is.** A `UNIQUE` index is a lock you do not have to manage. When two transactions insert the same key, the second one **waits** for the first: if the first commits, the second fails (or does nothing with `ON CONFLICT DO NOTHING`); if the first rolls back, the second succeeds.

**Real output**: a double-tapped transfer (same idempotency key) and two users picking the same seat.

```text
-- the same transfer request arrives twice (a double tap), same idempotency key
(A) ledger=# BEGIN;
BEGIN
(B) ledger=# BEGIN;
BEGIN
(A) ledger=*# INSERT INTO transfers (idempotency_key, from_wallet_id, to_wallet_id, amount_minor) VALUES ('idem-6f1c', 1, 2, 10000) ON CONFLICT (idempotency_key) DO NOTHING RETURNING id;
 id
----
  1
(1 row)

INSERT 0 1
(B) ledger=*# INSERT INTO transfers (idempotency_key, from_wallet_id, to_wallet_id, amount_minor) VALUES ('idem-6f1c', 1, 2, 10000) ON CONFLICT (idempotency_key) DO NOTHING RETURNING id;
-- (B) is waiting...
(A) ledger=*# COMMIT;
COMMIT
-- (B) continues:
 id
----
(0 rows)

INSERT 0 0
(B) ledger=*# SELECT id, amount_minor FROM transfers WHERE idempotency_key = 'idem-6f1c';
 id | amount_minor
----+--------------
  1 |        10000
(1 row)
(B) ledger=*# COMMIT;
COMMIT
-- seat booking: two users pick seat C7 for show 101
(A) ledger=# BEGIN;
BEGIN
(B) ledger=# BEGIN;
BEGIN
(A) ledger=*# INSERT INTO bookings (show_id, seat_no, user_id) VALUES (101, 'C7', 42);
INSERT 0 1
(B) ledger=*# INSERT INTO bookings (show_id, seat_no, user_id) VALUES (101, 'C7', 7);
-- (B) is waiting...
(A) ledger=*# COMMIT;
COMMIT
-- (B) continues:
ERROR:  duplicate key value violates unique constraint "bookings_pkey"
DETAIL:  Key (show_id, seat_no)=(101, C7) already exists.
(B) ledger=!# ROLLBACK;
ROLLBACK
```

**What to notice**
- **B's insert waited on A's uncommitted row**, exactly like a row lock, then returned `INSERT 0 0`, and B read back A's transfer: the double tap became one transfer (P1-03).
- **The second seat booking failed with `23505`** once A committed. No `SELECT ... FOR UPDATE`, no check-then-insert race: the index decides.

**At scale.** `minimal/seatRace.ts`: 200 users tap the same seat; then 1,000 users race for 100 seats, each picking at random.

```ts
// minimal/seatRace.ts: a UNIQUE (primary key) constraint as concurrency control for seat booking.
import pg from "pg";

const pool = new pg.Pool({ connectionString: "postgres://postgres:lab@127.0.0.1/ledger", max: 20 });
const book = (userId: number, seat: string) =>
  pool.query("INSERT INTO bookings (show_id, seat_no, user_id) VALUES (101, $1, $2) ON CONFLICT DO NOTHING RETURNING user_id", [seat, userId])
    .then((r) => r.rowCount === 1);

await pool.query("TRUNCATE bookings");
const sameSeat = await Promise.all(Array.from({ length: 200 }, (_, u) => book(u, "C7")));
console.log(`200 users tap seat C7 at once: ${sameSeat.filter(Boolean).length} booked, ${sameSeat.filter((x) => !x).length} told "seat taken"`);

const seats = Array.from({ length: 100 }, (_, i) => `R${Math.floor(i / 10)}-${i % 10}`);
const flash = await Promise.all(Array.from({ length: 1000 }, (_, u) => book(1000 + u, seats[Math.floor(Math.random() * 100)]!)));
const { rows } = await pool.query(`SELECT count(*)::int AS bookings, count(DISTINCT seat_no)::int AS seats,
  max(c)::int AS max_per_seat FROM (SELECT seat_no, count(*) OVER (PARTITION BY seat_no) AS c FROM bookings WHERE seat_no <> 'C7') b`);
console.log(`1,000 users race for 100 seats: ${flash.filter(Boolean).length} succeeded; table has ${rows[0].bookings} bookings for ${rows[0].seats} seats; most bookings on one seat: ${rows[0].max_per_seat}`);
await pool.end();
```

**Real output**

```text
200 users tap seat C7 at once: 1 booked, 199 told "seat taken"
1,000 users race for 100 seats: 100 succeeded; table has 100 bookings for 100 seats; most bookings on one seat: 1
```

**When to use it.** Whenever the rule is "at most one of these": one transfer per idempotency key, one booking per seat, one active subscription per user (a partial unique index), one payout per merchant per day. It is the cheapest and most reliable tool there is, and it still works if someone forgets to use the right code path.

**When not.** For counts and sums ("at most 4 tickets per user") a unique index cannot help; use a guarded counter row or Serializable (P2-03).

### 8. In-process vs cross-process: why a JavaScript mutex cannot protect the database

**What it is.** A mutex in Node.js (for example `async-mutex`) lives in one process's memory. Production runs several processes: four `cluster` workers, or twenty pods. Each has its own mutex, and none knows about the others.

**Diagram: four processes, four mutexes, one row**

```mermaid
flowchart TD
  P1["Process 1<br/>its own mutex"]
  P2["Process 2<br/>its own mutex"]
  P3["Process 3<br/>its own mutex"]
  P4["Process 4<br/>its own mutex"]
  ROW["Amit's wallet row<br/>in Postgres"]
  P1 -->|"read, add, write"| ROW
  P2 -->|"read, add, write"| ROW
  P3 -->|"read, add, write"| ROW
  P4 -->|"read, add, write"| ROW
```

**How to read this diagram.** Each mutex only orders the requests inside its own process. Four read-add-write sequences can still interleave at the row. The only thing all four share is the database, so the lock must live there: a row lock, an atomic statement, or an advisory lock.

**Minimal version:** `minimal/mutexAcrossProcesses.ts`. Four processes, each doing 250 top-ups of ₹1 through 5 concurrent lanes.

```ts
// minimal/mutexAcrossProcesses.ts: an in-process mutex (async-mutex) guarding a read-modify-write.
// 4 processes x 250 top-ups of ₹1 each into Amit's wallet (psql lab DB). Expected: +₹1,000.
import { spawn } from "node:child_process";
import { once } from "node:events";
import pg from "pg";
import { Mutex } from "async-mutex";

const url = "postgres://postgres:lab@127.0.0.1/ledger";
const [mode, role] = process.argv.slice(2) as [string, string | undefined];

async function child(): Promise<void> {
  const pool = new pg.Pool({ connectionString: url, max: 5 });
  const mutex = new Mutex();                         // one per process: that is the whole problem
  const topUp = async () => {
    if (mode === "mutex") return mutex.runExclusive(async () => {
      const { rows } = await pool.query("SELECT balance_minor FROM wallets WHERE id = 2");
      await pool.query("UPDATE wallets SET balance_minor = $1 WHERE id = 2", [Number(rows[0].balance_minor) + 100]);
    });
    if (mode === "advisory") {                       // the same critical section, guarded by Postgres instead
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        await c.query("SELECT pg_advisory_xact_lock(hashtextextended('wallet:2', 0))");
        const { rows } = await c.query("SELECT balance_minor FROM wallets WHERE id = 2");
        await c.query("UPDATE wallets SET balance_minor = $1 WHERE id = 2", [Number(rows[0].balance_minor) + 100]);
        await c.query("COMMIT");
      } finally { c.release(); }
      return;
    }
    await pool.query("UPDATE wallets SET balance_minor = balance_minor + 100 WHERE id = 2"); // atomic
  };
  await Promise.all(Array.from({ length: 5 }, async () => { for (let i = 0; i < 50; i++) await topUp(); }));
  await pool.end();
}

async function parent(processes: number): Promise<void> {
  const db = new pg.Client({ connectionString: url }); await db.connect();
  await db.query("UPDATE wallets SET balance_minor = 100000 WHERE id = 2");
  const t0 = performance.now();
  const kids = Array.from({ length: processes }, () => spawn(process.execPath, ["--import", "tsx", import.meta.filename, mode, "child"], { stdio: "inherit" }));
  await Promise.all(kids.map((k) => once(k, "exit")));
  const { rows } = await db.query("SELECT balance_minor FROM wallets WHERE id = 2");
  const added = (Number(rows[0].balance_minor) - 100000) / 100, expected = processes * 250;
  console.log(`${mode.padEnd(8)} ${processes} process(es): expected +₹${expected}, got +₹${added}, lost ${expected - added} top-ups, ${(performance.now() - t0).toFixed(0)} ms`);
  await db.end();
}

if (role === "child") await child(); else await parent(Number(process.env.PROCESSES ?? 4));
```

**Real output**

```text
mutex    4 process(es): expected +₹1000, got +₹357, lost 643 top-ups, 1290 ms
advisory 4 process(es): expected +₹1000, got +₹1000, lost 0 top-ups, 2108 ms
atomic   4 process(es): expected +₹1000, got +₹1000, lost 0 top-ups, 1228 ms
mutex    1 process(es): expected +₹250, got +₹250, lost 0 top-ups, 541 ms
```

**What to notice**
- **The mutex works in one process** (last line), which is exactly why it passes local tests and fails in production.
- **With four processes, 643 of 1,000 top-ups were lost.** Each process's mutex let its own lane through while the other processes' lanes interleaved.
- **The advisory lock fixed it** (the same read-add-write, guarded inside Postgres), at some cost: 2,108 ms against 1,228 ms.
- **The atomic `UPDATE ... SET balance = balance + 100` fixed it with no lock code at all**, and was the fastest.

**When an in-process mutex is fine.** For in-memory state of one process: a local cache refresh, a single connection's handshake, rate-limiting your own outgoing calls. Never for shared data.

---
## ⚖️ Comparisons and trade-offs

The decision table (optimistic vs pessimistic vs atomic vs advisory) is in "How it works". Here are the measurements behind it.

### Low vs high contention, per strategy (must-include)

1,000 transfers of ₹100 started at once, through a pool of 20 connections. Three runs per cell; ranges shown. Retries are capped at 10 attempts. **Real output**, summarised by a script.

| Contention | Strategy | Completed of 1,000 | Gave up / failed | Retries | Transfers/s | p50 | p95 |
|---|---|---|---|---|---|---|---|
| **Low:** 1,000 wallets | Atomic conditional update | 1,000 | 0 | 0 | 1,090 to 1,657 | 347 to 581 ms | 571 to 885 ms |
| | Pessimistic, ordered locks | 1,000 | 0 | 0 | 1,286 to 1,539 | 333 to 422 ms | 617 to 752 ms |
| | Optimistic version + retry | 1,000 | 0 | 44 to 68 | 1,202 to 1,396 | 368 to 412 ms | 680 to 801 ms |
| | Pessimistic, **unordered** locks | 1,000 | 0 | 0 | 1,326 to 1,544 | 330 to 415 ms | 612 to 724 ms |
| **Spread:** 10 wallets | Atomic conditional update | 1,000 | 0 | 0 | **1,021 to 1,187** | 442 to 516 ms | 802 to 936 ms |
| | Pessimistic, ordered locks | 1,000 | 0 | 0 | 840 to 899 | 563 to 605 ms | 1,017 to 1,112 ms |
| | Optimistic version + retry | 965 to 977 | 23 to 35 | 3,423 to 3,470 | 355 to 377 | 1,333 to 1,490 ms | 2,389 to 2,559 ms |
| | Pessimistic, **unordered** locks | 209 to 249 | **751 to 791** | 106 to 112 deadlocks | **23 to 24** | 30,002 to 30,005 ms | 35,354 to 37,251 ms |
| **Hot:** 1 merchant | Atomic conditional update | 1,000 | 0 | 0 | **555 to 612** | 864 to 909 ms | 1,552 to 1,710 ms |
| | Pessimistic, ordered locks | 1,000 | 0 | 0 | 490 to 554 | 936 to 1,102 ms | 1,742 to 1,972 ms |
| | Optimistic version + retry | 705 to 720 | **280 to 295** | 5,205 to 5,380 | 236 to 257 | 2,604 to 3,008 ms | 3,708 to 4,087 ms |
| | Pessimistic, unordered locks | 1,000 | 0 | 0 | 502 to 581 | 906 to 1,135 ms | 1,648 to 1,904 ms |

Latency includes the wait for one of the 20 pool connections, because 1,000 requests arrive at once; that is why even the best p50 is a few hundred milliseconds. Every run of every strategy ended with the money conserved and no negative balance.

**How to read it**
- **At low contention, every strategy is fine.** The differences are within run-to-run noise, and even unordered locks rarely collide among 1,000 wallets. This is why "it worked in testing" means little.
- **At 10 wallets, the atomic update is fastest, pessimistic ordered locks are close behind, and optimistic falls to a third**, with about 3.4 retries per transfer and 2 to 3.5% of requests giving up.
- **Unordered locks turn contention into deadlocks, and deadlocks into an outage**: 23 to 24 transfers a second and most requests failing.
- **On the hot merchant, everything correct is limited by one row lock** (490 to 612/s), and optimistic is the worst choice: 28 to 30% of payments gave up. The hot-wallet mitigations in Deep dive 6 are the real fix.
- **Unordered locks did not deadlock on the hot merchant** only because every payment locked "its own payer, then the merchant", which happens to be a consistent order. One refund in the opposite direction would change that.

### Lock waits vs retries

| | Waiting (pessimistic, atomic) | Retrying (optimistic, Serializable) |
|---|---|---|
| Under low contention | Almost never waits | Almost never retries |
| Under high contention | Requests queue fairly; throughput limited by lock hold time | Work is done and thrown away; retries collide again; some requests starve |
| Failure mode | Long waits; deadlocks if order is not fixed | Retry storms; give-ups after max attempts |
| Protects against | A transaction holding a lock too long (use timeouts) | Nothing to hold, so works across HTTP requests (ETags) |

---

## 🚶 Walkthrough on the ledger platform: a payment into Chai Point with batched credits

It is 1:15 pm. Chai Point's wallet receives hundreds of UPI-style payments a second. Amit pays ₹100. The numbers below match the diagram.

1. **Amit's app sends** `POST /v1/payments` with an `Idempotency-Key`; the route validates the body with Zod.
2. **The API opens a short transaction** at Read Committed on one pooled client.
3. **It debits Amit's wallet** with the guarded `UPDATE` (balance stays ≥ 0). Only Amit's row is locked, and nobody else is paying from Amit's wallet.
4. **It inserts the transfer and both ledger entries.** The books now say "Amit −₹100, Chai Point +₹100".
5. **It appends a `pending_credits` row** for Chai Point. No lock on Chai Point's balance row.
6. **`COMMIT`.** Amit gets `201` in a few milliseconds, however busy Chai Point is.
7. **Every 50 ms, the batcher claims pending credits** with `FOR UPDATE SKIP LOCKED` (so two batchers never take the same rows).
8. **It adds their sum to Chai Point's balance in one `UPDATE`**, and marks them applied, in one statement and one transaction.
9. **Chai Point's dashboard reads its balance** as the cached row plus any credits not yet applied, so it is exact even between batches.

**Diagram: one payment, one batch**

```mermaid
sequenceDiagram
  participant App as Amit's app
  participant API as Payments API
  participant PG as Postgres
  participant Bat as Credit batcher
  App->>API: 1. POST /v1/payments, Idempotency-Key
  API->>PG: 2. BEGIN, Read Committed
  API->>PG: 3. guarded debit of Amit's wallet
  API->>PG: 4. INSERT transfer and two ledger entries
  API->>PG: 5. INSERT pending credit for Chai Point
  API->>PG: 6. COMMIT
  API-->>App: 6. 201 Created
  Bat->>PG: 7. claim pending credits, SKIP LOCKED
  Bat->>PG: 8. one UPDATE adds their sum, mark applied
  Note over PG: 9. balance read = cached row plus unapplied credits
```

**How to read this diagram.** The payment path (1 to 6) never touches Chai Point's balance row, so payments do not queue behind each other. The batcher (7, 8) touches it once per batch instead of once per payment. In the lab, that turned 1,000 lock acquisitions into 11 or 12, and payments ran about 3 times faster than crediting the row directly.

---

## 🧪 Hands-on lab

Five steps, in the card's order.

### Prerequisites

- Docker, Node.js 24 or 26, `psql`, and **k6** (v2.x; install it from Grafana's k6 docs).
- The ledger project from earlier cards, including P2-03's `withTransaction` and `withRetry`.

`docker-compose.yml`

```yaml
services:
  postgres:
    image: postgres:18
    environment:
      POSTGRES_PASSWORD: lab          # lab only; real secrets come from the environment (P1-06)
      POSTGRES_DB: ledger
    ports:
      - "5432:5432"
```

```bash
docker compose up -d
createdb -h 127.0.0.1 -U postgres ledger_cc         # the Node.js part (password: lab)
npm install pg zod pino fastify async-mutex
npm install -D typescript tsx vitest @types/pg @types/node
```

**Schemas.** `psql/00-schema.sql` is the small `psql` lab schema used by every transcript (run it before each experiment). `db/schema.sql` is the Node.js lab's copy of the P2-01 tables plus a job table and the two hot-wallet helpers.

```sql
-- P2-04 psql lab schema: readable bigint ids, amounts in paise.
DROP TABLE IF EXISTS withdrawals, transfers, jobs, bookings, wallets CASCADE;

CREATE TABLE wallets (
  id            bigint PRIMARY KEY,
  owner_name    text   NOT NULL,
  balance_minor bigint NOT NULL CHECK (balance_minor >= 0),
  version       bigint NOT NULL DEFAULT 1           -- for optimistic locking
);

CREATE TABLE withdrawals (                          -- a child table: its foreign key points at wallets
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  wallet_id    bigint NOT NULL REFERENCES wallets (id),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0)
);

CREATE TABLE transfers (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  idempotency_key text   NOT NULL UNIQUE,
  from_wallet_id  bigint NOT NULL REFERENCES wallets (id),
  to_wallet_id    bigint NOT NULL REFERENCES wallets (id),
  amount_minor    bigint NOT NULL CHECK (amount_minor > 0)
);

CREATE TABLE jobs (
  id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind    text   NOT NULL,
  status  text   NOT NULL DEFAULT 'queued'
);

CREATE TABLE bookings (
  show_id bigint NOT NULL,
  seat_no text   NOT NULL,
  user_id bigint NOT NULL,
  PRIMARY KEY (show_id, seat_no)                    -- one booking per seat, enforced by an index
);

INSERT INTO wallets (id, owner_name, balance_minor) VALUES
  (1, 'Riya', 600000), (2, 'Amit', 100000), (3, 'Chai Point (merchant)', 5000000);
INSERT INTO jobs (kind) SELECT 'send_receipt' FROM generate_series(1, 6);
```

```sql
-- Lab copy of the ledger tables this card touches (P2-01), plus a job table and two hot-wallet helpers.
DROP TABLE IF EXISTS pending_credits, balance_shards, job_runs, jobs, ledger_entries, transfers, wallet_balances, wallets CASCADE;

CREATE TABLE wallets (
  id                uuid   PRIMARY KEY DEFAULT gen_random_uuid(),
  kind              text   NOT NULL CHECK (kind IN ('user', 'merchant')),
  nickname          text   NOT NULL DEFAULT '',
  daily_limit_minor bigint NOT NULL DEFAULT 10_00_000,
  version           bigint NOT NULL DEFAULT 1        -- settings version: the ETag of PATCH /settings
);

CREATE TABLE wallet_balances (
  wallet_id     uuid        PRIMARY KEY REFERENCES wallets (id),
  balance_minor bigint      NOT NULL CHECK (balance_minor >= 0),
  version       bigint      NOT NULL DEFAULT 1,      -- balance version: used only by the optimistic strategy
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE transfers (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key       text        NOT NULL UNIQUE,
  source_wallet_id      uuid        NOT NULL REFERENCES wallets (id),
  destination_wallet_id uuid        NOT NULL REFERENCES wallets (id),
  amount_minor          bigint      NOT NULL CHECK (amount_minor > 0),
  status                text        NOT NULL CHECK (status IN ('pending', 'completed', 'failed', 'reversed')),
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ledger_entries (
  id           bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  transfer_id  uuid        NOT NULL REFERENCES transfers (id),
  wallet_id    uuid        NOT NULL REFERENCES wallets (id),
  direction    text        NOT NULL CHECK (direction IN ('debit', 'credit')),
  amount_minor bigint      NOT NULL CHECK (amount_minor > 0),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (transfer_id, direction)
);

CREATE TABLE jobs (
  id           bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind         text        NOT NULL,
  payload      jsonb       NOT NULL DEFAULT '{}',
  status       text        NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
  attempts     int         NOT NULL DEFAULT 0,
  run_at       timestamptz NOT NULL DEFAULT now(),
  locked_by    text,
  locked_until timestamptz,
  last_error   text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_ready ON jobs (run_at, id) WHERE status = 'queued';   -- workers only scan ready jobs
CREATE INDEX jobs_leased ON jobs (locked_until) WHERE status = 'running';

CREATE TABLE job_runs (job_id bigint NOT NULL, worker text NOT NULL, ran_at timestamptz NOT NULL DEFAULT now()); -- lab only: proof table

-- Hot-wallet relief 1: one merchant balance split into N shards.
CREATE TABLE balance_shards (
  wallet_id     uuid   NOT NULL REFERENCES wallets (id),
  shard_no      int    NOT NULL,
  balance_minor bigint NOT NULL CHECK (balance_minor >= 0),
  PRIMARY KEY (wallet_id, shard_no)
);

-- Hot-wallet relief 2: credits are appended here and applied in batches.
CREATE TABLE pending_credits (
  id           bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  wallet_id    uuid        NOT NULL REFERENCES wallets (id),
  transfer_id  uuid        NOT NULL REFERENCES transfers (id),
  amount_minor bigint      NOT NULL CHECK (amount_minor > 0),
  created_at   timestamptz NOT NULL DEFAULT now(),
  applied_at   timestamptz
);
CREATE INDEX pending_credits_unapplied ON pending_credits (wallet_id, id) WHERE applied_at IS NULL;
```

### Step 1: Transfers three ways

P2-03's helpers are reused: `withTransaction` (BEGIN on one client, COMMIT or ROLLBACK, always release) and `withRetry`, with one addition so optimistic version conflicts can be retried too:

```ts
// src/lib/db/retryTransaction.ts (the change from P2-03)
export interface RetryOptions {
  // ... maxAttempts, baseDelayMs, maxDelayMs, onRetry as before
  isRetryable?: (err: unknown) => boolean;   // extra rule, e.g. an optimistic version conflict
}
// inside the catch:
const retryable = (sqlstate !== undefined && RETRYABLE_SQLSTATES.has(sqlstate)) || options.isRetryable?.(err) === true;
```

`src/repositories/balanceRepository.ts`: the SQL for all three strategies.

```ts
// src/repositories/balanceRepository.ts: the SQL behind the three transfer strategies.
import type { PoolClient } from "pg";

export interface BalanceRow { walletId: string; balanceMinor: number; version: number }
type Raw = { wallet_id: string; balance_minor: string; version: string };
const toRow = (r: Raw): BalanceRow => ({ walletId: r.wallet_id, balanceMinor: Number(r.balance_minor), version: Number(r.version) });

// Strategy 1 (atomic): the check and the change in one statement.
export async function applyBalanceChange(tx: PoolClient, walletId: string, deltaMinor: number): Promise<boolean> {
  const result = await tx.query(
    `UPDATE wallet_balances SET balance_minor = balance_minor + $2, updated_at = now()
      WHERE wallet_id = $1 AND balance_minor + $2 >= 0`,
    [walletId, deltaMinor],
  );
  return result.rowCount === 1;
}

// Strategy 2 (pessimistic): lock every row we will change, lowest id first, before reading them.
// FOR NO KEY UPDATE is enough (we never change the key) and does not block foreign-key checks.
export async function lockBalances(tx: PoolClient, walletIds: string[]): Promise<Map<string, BalanceRow>> {
  const { rows } = await tx.query<Raw>(
    `SELECT wallet_id, balance_minor, version FROM wallet_balances
      WHERE wallet_id = ANY($1::uuid[]) ORDER BY wallet_id FOR NO KEY UPDATE`,
    [walletIds],
  );
  return new Map(rows.map((r) => [r.wallet_id, toRow(r)]));
}

export async function setBalance(tx: PoolClient, walletId: string, balanceMinor: number): Promise<void> {
  await tx.query("UPDATE wallet_balances SET balance_minor = $2, updated_at = now() WHERE wallet_id = $1", [walletId, balanceMinor]);
}

// Strategy 3 (optimistic): read without locks, then write only if nobody changed the row since.
export async function readBalances(tx: PoolClient, walletIds: string[]): Promise<Map<string, BalanceRow>> {
  const { rows } = await tx.query<Raw>(
    "SELECT wallet_id, balance_minor, version FROM wallet_balances WHERE wallet_id = ANY($1::uuid[])", [walletIds]);
  return new Map(rows.map((r) => [r.wallet_id, toRow(r)]));
}

export async function compareAndSetBalance(tx: PoolClient, row: BalanceRow, newBalanceMinor: number): Promise<boolean> {
  const result = await tx.query(
    `UPDATE wallet_balances SET balance_minor = $3, version = version + 1, updated_at = now()
      WHERE wallet_id = $1 AND version = $2`,
    [row.walletId, row.version, newBalanceMinor],
  );
  return result.rowCount === 1; // 0 rows: the version moved on, someone else won
}

export async function insertCompletedTransfer(
  tx: PoolClient,
  t: { idempotencyKey: string; sourceWalletId: string; destinationWalletId: string; amountMinor: number },
): Promise<string> {
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO transfers (idempotency_key, source_wallet_id, destination_wallet_id, amount_minor, status)
     VALUES ($1, $2, $3, $4, 'completed') RETURNING id`,
    [t.idempotencyKey, t.sourceWalletId, t.destinationWalletId, t.amountMinor],
  );
  const transferId = rows[0]!.id;
  await tx.query(
    `INSERT INTO ledger_entries (transfer_id, wallet_id, direction, amount_minor)
     VALUES ($1, $2, 'debit', $4), ($1, $3, 'credit', $4)`,
    [transferId, t.sourceWalletId, t.destinationWalletId, t.amountMinor],
  );
  return transferId;
}
```

`src/services/transferStrategies.ts`: the three strategies side by side.

```ts
// src/services/transferStrategies.ts: one transfer, three ways to stay correct under concurrency.
import type { Pool } from "pg";
import { withTransaction } from "../lib/db/withTransaction.js";
import { withRetry, type RetryOptions } from "../lib/db/retryTransaction.js";
import { InsufficientFundsError, VersionConflictError, WalletNotFoundError } from "../errors/transferErrors.js";
import { applyBalanceChange, compareAndSetBalance, insertCompletedTransfer, lockBalances, readBalances, setBalance } from "../repositories/balanceRepository.js";

export interface TransferInput { idempotencyKey: string; sourceWalletId: string; destinationWalletId: string; amountMinor: number }
export type Strategy = "atomic" | "pessimistic" | "optimistic";

// Always touch the lower wallet id first, so two opposite transfers can never wait on each other in a circle.
// Plain < compares code units, which matches Postgres's uuid order for lowercase UUIDs (localeCompare does not promise that).
const lowerFirst = (a: string, b: string): [string, string] => (a < b ? [a, b] : [b, a]);

export function createTransferStrategies(pool: Pool, retry: Omit<RetryOptions, "isRetryable">) {
  const rc = { isolationLevel: "READ COMMITTED" } as const;
  const run = (fn: () => Promise<string>) =>
    withRetry(fn, { ...retry, isRetryable: (err) => err instanceof VersionConflictError });

  const strategies: Record<Strategy, (t: TransferInput) => Promise<string>> = {
    // 1. Atomic conditional update: no explicit lock, no read; the UPDATE's WHERE is the check.
    atomic: (t) => run(() => withTransaction(pool, rc, async (tx) => {
      for (const id of lowerFirst(t.sourceWalletId, t.destinationWalletId)) {
        const delta = id === t.sourceWalletId ? -t.amountMinor : t.amountMinor;
        if (!(await applyBalanceChange(tx, id, delta))) {
          throw delta < 0 ? new InsufficientFundsError(id) : new WalletNotFoundError(id);
        }
      }
      return insertCompletedTransfer(tx, t);
    })),

    // 2. Pessimistic: lock both rows (ordered), then read, check and write while nobody else can.
    pessimistic: (t) => run(() => withTransaction(pool, rc, async (tx) => {
      const rows = await lockBalances(tx, [t.sourceWalletId, t.destinationWalletId]);
      const source = rows.get(t.sourceWalletId), destination = rows.get(t.destinationWalletId);
      if (!source || !destination) throw new WalletNotFoundError(source ? t.destinationWalletId : t.sourceWalletId);
      if (source.balanceMinor < t.amountMinor) throw new InsufficientFundsError(t.sourceWalletId);
      await setBalance(tx, source.walletId, source.balanceMinor - t.amountMinor);
      await setBalance(tx, destination.walletId, destination.balanceMinor + t.amountMinor);
      return insertCompletedTransfer(tx, t);
    })),

    // 3. Optimistic: read versions without locking, write only if they did not change, else start again.
    optimistic: (t) => run(() => withTransaction(pool, rc, async (tx) => {
      const rows = await readBalances(tx, [t.sourceWalletId, t.destinationWalletId]);
      const source = rows.get(t.sourceWalletId), destination = rows.get(t.destinationWalletId);
      if (!source || !destination) throw new WalletNotFoundError(source ? t.destinationWalletId : t.sourceWalletId);
      if (source.balanceMinor < t.amountMinor) throw new InsufficientFundsError(t.sourceWalletId);
      const next = new Map([[source.walletId, source.balanceMinor - t.amountMinor], [destination.walletId, destination.balanceMinor + t.amountMinor]]);
      for (const id of lowerFirst(source.walletId, destination.walletId)) {
        if (!(await compareAndSetBalance(tx, rows.get(id)!, next.get(id)!))) throw new VersionConflictError(id);
      }
      return insertCompletedTransfer(tx, t);
    })),
  };
  return strategies;
}
```

**What to notice**
- **Atomic:** no read at all. The guarded `UPDATE`s are the check, run lower id first.
- **Pessimistic:** one `SELECT ... ORDER BY wallet_id FOR NO KEY UPDATE` locks both rows in a fixed order, so reading and deciding is safe, and opposite transfers cannot deadlock.
- **Optimistic:** reads without locks; each write carries `version = $read`; a zero-row write throws `VersionConflictError`, which `withRetry` treats as "start again". Writes still go lower id first, because an `UPDATE` takes a row lock even in the optimistic strategy.
- **All three use the same `insertCompletedTransfer`** and the same transaction helper, so the benchmark compares only the concurrency strategy.

**Test:** `test/transferStrategies.test.ts` runs 100 concurrent transfers among 3 wallets through each strategy.

```ts
// test/transferStrategies.test.ts: every strategy keeps the money right under concurrency.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createPool } from "../src/lib/db/pool.js";
import { createTransferStrategies, type Strategy } from "../src/services/transferStrategies.js";

const pool = createPool(process.env.TEST_DATABASE_URL ?? "postgres://postgres:lab@127.0.0.1/ledger_cc");
const strategies = createTransferStrategies(pool, { maxAttempts: 20, baseDelayMs: 2, maxDelayMs: 50 });
afterAll(() => pool.end());

describe.each(["atomic", "pessimistic", "optimistic"] satisfies Strategy[])("%s transfers", (strategy) => {
  it("100 concurrent transfers among 3 wallets: money conserved, nothing negative, no deadlock", async () => {
    const { rows } = await pool.query<{ id: string }>("INSERT INTO wallets (kind) SELECT 'user' FROM generate_series(1, 3) RETURNING id");
    const ids = rows.map((r) => r.id);
    await pool.query("INSERT INTO wallet_balances (wallet_id, balance_minor) SELECT unnest($1::uuid[]), 50_000", [ids]);
    const results = await Promise.allSettled(Array.from({ length: 100 }, (_, i) => strategies[strategy]({
      idempotencyKey: randomUUID(), sourceWalletId: ids[i % 3]!, destinationWalletId: ids[(i + 1 + (i % 2)) % 3]!, amountMinor: 1_000,
    })));
    const { rows: [sum] } = await pool.query("SELECT sum(balance_minor)::int AS total, min(balance_minor)::int AS min FROM wallet_balances WHERE wallet_id = ANY($1::uuid[])", [ids]);
    expect(sum.total).toBe(150_000);
    expect(sum.min).toBeGreaterThanOrEqual(0);
    expect(results.filter((r) => r.status === "rejected" && !/insufficient/.test(String(r.reason)))).toEqual([]);
  });
});
```

**Real output**

```text
✓ test/transferStrategies.test.ts > atomic transfers > 100 concurrent transfers among 3 wallets: money conserved, nothing negative, no deadlock 456ms
✓ test/transferStrategies.test.ts > pessimistic transfers > 100 concurrent transfers among 3 wallets: money conserved, nothing negative, no deadlock 321ms
✓ test/transferStrategies.test.ts > optimistic transfers > 100 concurrent transfers among 3 wallets: money conserved, nothing negative, no deadlock 825ms
Tests  5 passed (5)
Duration  2.38s (tests 78%, import 12%, transform 10%)
```

(The 5 tests include the two ETag tests from Deep dive 2.)

### Step 2: Load test each strategy with k6 (1,000 at once; spread, then hot)

`src/routes/labTransfers.ts`: lab-only, one endpoint per strategy.

```ts
// src/routes/labTransfers.ts: LAB ONLY. One endpoint per strategy so k6 can compare them.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { TransferRejectedError } from "../errors/transferErrors.js";
import { TransactionRetriesExhaustedError } from "../lib/db/retryTransaction.js";
import type { createTransferStrategies } from "../services/transferStrategies.js";

const Params = z.object({ strategy: z.enum(["atomic", "pessimistic", "optimistic"]) });
const Body = z.object({ sourceWalletId: z.uuid(), destinationWalletId: z.uuid(), amountMinor: z.number().int().positive() });

export function labTransferRoutes(strategies: ReturnType<typeof createTransferStrategies>) {
  return async function register(app: FastifyInstance): Promise<void> {
    app.post("/lab/transfers/:strategy", async (request, reply) => {
      const { strategy } = Params.parse(request.params);
      const input = { ...Body.parse(request.body), idempotencyKey: z.string().min(8).parse(request.headers["idempotency-key"]) };
      try {
        return reply.code(201).send({ transferId: await strategies[strategy](input) });
      } catch (err) {
        if (err instanceof TransferRejectedError) return reply.code(err.status).send({ type: err.type, status: err.status });
        if (err instanceof TransactionRetriesExhaustedError) return reply.code(503).header("retry-after", "1").send({ type: "busy", status: 503 });
        throw err;
      }
    });
  };
}
```

`bench/k6-transfers.js`: 1,000 virtual users, one transfer each, all at once.

```js
// bench/k6-transfers.js: 1,000 transfers at the same moment, against one strategy.
// k6 run -e STRATEGY=atomic -e SCENARIO=spread bench/k6-transfers.js     (SCENARIO: spread | hot)
import http from "k6/http";
import { check } from "k6";
import { SharedArray } from "k6/data";
import { uuidv4 } from "https://jslib.k6.io/k6-utils/1.4.0/index.js";

// Written by the seed script: { "merchant": "<uuid>", "users": ["<uuid>", ...] }
const seed = new SharedArray("seed", () => [JSON.parse(open("./wallets.json"))]);

export const options = {
  scenarios: {
    burst: { executor: "per-vu-iterations", vus: 1000, iterations: 1, maxDuration: "2m" }, // 1,000 at once
  },
  thresholds: { "checks{kind:outcome}": ["rate>0.99"] },
};

export default function () {
  const { merchant, users } = seed[0];
  const pick = (n) => users[Math.floor(Math.random() * n)];
  let source = pick(10), destination = pick(10);              // spread: 10 wallets
  while (destination === source) destination = pick(10);
  if (__ENV.SCENARIO === "hot") { source = pick(users.length); destination = merchant; } // everyone pays one merchant

  const res = http.post(`${__ENV.BASE_URL ?? "http://127.0.0.1:3000"}/lab/transfers/${__ENV.STRATEGY}`,
    JSON.stringify({ sourceWalletId: source, destinationWalletId: destination, amountMinor: 10000 }),
    { headers: { "content-type": "application/json", "idempotency-key": uuidv4() }, tags: { strategy: __ENV.STRATEGY } });
  // 201 = done; 503 = gave up after retries (count these: they are the "aborts" in the Measure row)
  check(res, { "201 created": (r) => r.status === 201 }, { kind: "outcome" });
}
```

```bash
# seed 10 users + 1 merchant + 1,000 payers and write bench/wallets.json (your seed script), start the API, then:
for s in atomic pessimistic optimistic; do
  k6 run -e STRATEGY=$s -e SCENARIO=spread bench/k6-transfers.js
  k6 run -e STRATEGY=$s -e SCENARIO=hot    bench/k6-transfers.js
done
```

**What to watch:** `http_reqs` (throughput), `http_req_duration` p(95), the `201 created` check rate, and the count of `503`s (gave up after retries). Add a log line or a metric in `onRetry` to count retries per strategy.

**Expected on your laptop:** the same shape as the benchmark table above. Atomic at or near the top in both scenarios; pessimistic close behind; optimistic far behind on 10 wallets and failing a large share of requests on the hot merchant. k6 adds HTTP and JSON work, so absolute numbers will be lower than the in-process harness.

**What ran here instead (Real output).** The same three strategies, called directly from a Node.js harness with no HTTP layer (`bench/strategies.ts`; a benchmark harness, so only its core is shown):

```ts
// bench/strategies.ts (core; seeding, the unordered variant and the invariant checks are omitted)
await Promise.all(inputs.map(async (t) => {             // 1,000 transfers started at the same moment
  const started = performance.now();
  try { await design(t); out.ok++; }
  catch (err) { if (err instanceof TransactionRetriesExhaustedError) out.gaveUp++; else /* ... */ out.errors++; }
  latencies.push(performance.now() - started);
}));
// ... then: transfers/s, p50, p95, retries by reason, money conserved, no negative balance
```

Results: the low-vs-high table in "Comparisons and trade-offs".

### Step 3: Cause a deadlock on purpose, then fix it with lock ordering

Two `psql` terminals, as in P2-03:

```bash
psql "postgres://postgres:lab@127.0.0.1:5432/ledger" -f psql/00-schema.sql
psql "postgres://postgres:lab@127.0.0.1:5432/ledger" -v PROMPT1='(A) %/%R%x%# '   # terminal 1
psql "postgres://postgres:lab@127.0.0.1:5432/ledger" -v PROMPT1='(B) %/%R%x%# '   # terminal 2
```

Type the statements from Deep dive 4 in the order shown: first the deadlock (each session debits its own source first), then the fixed version (both start with wallet 1). Then find the full deadlock report in the server log:

```bash
docker compose logs postgres | grep -A 6 "deadlock detected"
```

**Expected:** the log shows `Process ... waits for ShareLock on transaction ...` for both processes, plus the two `UPDATE` statements involved, which `psql` does not show.

| Run | What happened here (Real output) | Your machine |
|---|---|---|
| Debit first, request order | `ERROR: deadlock detected` after 1.1 s; B rolled back | |
| Lower wallet id first | B waited for A, then both committed; balances 595000 and 105000 | |

### Step 4: A job table with FOR UPDATE SKIP LOCKED and four workers (must-include)

**Minimal version:** hold the row lock while the job runs. Simple, and correct, but the lock lives as long as the job, so the job must be quick and must not call the network. From `bench/jobWorkerProcess.ts`:

```ts
// The minimal pattern: lock one queued job, run it, mark it done, all in one transaction.
async function claimInTransaction(skipLocked: boolean): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<Job>(`SELECT id, kind, payload, attempts FROM jobs WHERE status = 'queued'
      ORDER BY id LIMIT 1 FOR UPDATE${skipLocked ? " SKIP LOCKED" : ""}`);
    for (const job of rows) { await sendReceipt(job); await client.query("UPDATE jobs SET status = 'done' WHERE id = $1", [job.id]); }
    await client.query("COMMIT");
    return rows.length;
  } catch (err) { await client.query("ROLLBACK"); throw err; } finally { client.release(); }
}
```

**Product version:** `src/workers/jobWorker.ts`. Claim a batch in one short statement, run the jobs **outside** any transaction, and use a lease so a crashed worker's jobs come back.

```ts
// src/workers/jobWorker.ts: many workers, one jobs table. FOR UPDATE SKIP LOCKED hands each ready job
// to exactly one worker; a lease (locked_until) brings jobs back if a worker dies mid-job.
import type { Pool } from "pg";
import type { Logger } from "pino";
import { setTimeout as sleep } from "node:timers/promises";

export interface Job { id: string; kind: string; payload: unknown; attempts: number }
export type JobHandler = (job: Job, signal: AbortSignal) => Promise<void>;

export interface WorkerOptions {
  pool: Pool;
  log: Logger;
  workerId: string;                      // hostname:pid, visible in jobs.locked_by
  handlers: Record<string, JobHandler>;
  batchSize?: number;                    // jobs claimed per round trip
  leaseMs?: number;                      // after this, another worker may take the job again
  maxAttempts?: number;
  idleDelayMs?: number;                  // pause when the queue is empty
}

// One short statement: lock up to N ready rows, skipping rows other workers hold, and mark them ours.
const CLAIM = `
  UPDATE jobs SET status = 'running', locked_by = $1, attempts = attempts + 1,
                  locked_until = now() + make_interval(secs => $3::int / 1000.0)
   WHERE id IN (SELECT id FROM jobs
                 WHERE status = 'queued' AND run_at <= now()
                 ORDER BY run_at, id
                 LIMIT $2
                 FOR UPDATE SKIP LOCKED)
  RETURNING id, kind, payload, attempts`;
// Only the current lease holder may finish a job (if our lease expired and someone re-took it, we lose).
const DONE = `UPDATE jobs SET status = 'done', locked_by = NULL, locked_until = NULL WHERE id = $1 AND locked_by = $2`;
const FAIL = `
  UPDATE jobs SET status = CASE WHEN attempts >= $3 THEN 'failed' ELSE 'queued' END,
                  run_at = now() + make_interval(secs => least(300, 2 ^ attempts)),
                  locked_by = NULL, locked_until = NULL, last_error = $4
   WHERE id = $1 AND locked_by = $2`;
const REQUEUE_EXPIRED = `
  UPDATE jobs SET status = 'queued', locked_by = NULL, locked_until = NULL
   WHERE status = 'running' AND locked_until < now()`;

export function createJobWorker(o: WorkerOptions) {
  const { pool, log, workerId, handlers } = o;
  const batchSize = o.batchSize ?? 10, leaseMs = o.leaseMs ?? 30_000;
  const maxAttempts = o.maxAttempts ?? 5, idleDelayMs = o.idleDelayMs ?? 500;
  const stopping = new AbortController();

  // Claim a batch, then run each job OUTSIDE any transaction: no row locks are held while handlers do network calls.
  async function runOnce(): Promise<number> {
    const { rows } = await pool.query<Job>(CLAIM, [workerId, batchSize, leaseMs]);
    for (const job of rows) {
      const handler = handlers[job.kind];
      try {
        if (!handler) throw new Error(`no handler for job kind ${job.kind}`);
        await handler(job, AbortSignal.timeout(leaseMs)); // stop before the lease runs out
        const done = await pool.query(DONE, [job.id, workerId]);
        if (done.rowCount === 0) log.warn({ job_id: job.id }, "lease lost before completion; job may run again");
      } catch (err) {
        log.error({ err, job_id: job.id, attempts: job.attempts }, "job failed");
        await pool.query(FAIL, [job.id, workerId, maxAttempts, String(err)]);
      }
    }
    return rows.length;
  }

  let loop: Promise<void> | undefined;
  return {
    runOnce,
    start(): void {
      loop = (async () => {
        let rounds = 0;
        while (!stopping.signal.aborted) {
          if (rounds++ % 100 === 0) await pool.query(REQUEUE_EXPIRED); // cheap, safe for every worker to run
          const claimed = await runOnce();
          if (claimed === 0) await sleep(idleDelayMs, undefined, { signal: stopping.signal }).catch(() => undefined);
        }
      })();
    },
    // Graceful shutdown (P1-02): finish the jobs already claimed, claim nothing new.
    async stop(): Promise<void> {
      stopping.abort();
      await loop;
    },
  };
}
```

**What to notice**
- **The claim is one `UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED)`.** Rows another worker is claiming are skipped, not waited for, and the same statement marks the rows `running`, so after it commits they are no longer "queued" for anyone.
- **No lock is held while a job runs.** The handler can call an email or SMS provider for seconds without blocking other workers or `VACUUM`.
- **The lease (`locked_until`) makes it crash-safe:** if a worker dies, `REQUEUE_EXPIRED` puts its jobs back after the lease ends. That makes the queue **at-least-once**: a worker that finishes after its lease expired may have run a job that another worker also runs. Handlers must be idempotent (send receipts with a dedupe key, P1-03).
- **`DONE` and `FAIL` check `locked_by = $2`**, so a worker whose lease expired cannot mark someone else's run as done.
- **`stop()` aborts the loop and waits for the current batch**: graceful shutdown on SIGTERM (P1-02).

**Prove no job runs twice.** `bench/jobs.ts` inserts 2,000 jobs, starts **four separate worker processes**, and each job's handler writes a row to `job_runs` (a lab-only table with no unique constraint, so duplicates would show).

```bash
DATABASE_URL=postgres://postgres:lab@127.0.0.1:5432/ledger_cc npx tsx bench/jobs.ts
```

**Real output**

```text
skip-locked  | 3.7 s | runs 2000 | distinct jobs 2000 | duplicate runs 0 | worker-1=500 worker-2=520 worker-3=490 worker-4=490
for-update   | 3.2 s | runs 2000 | distinct jobs 2000 | duplicate runs 0 | worker-1=500 worker-2=500 worker-3=500 worker-4=500
no-lock      | 3.6 s | runs 2250 | distinct jobs 2000 | duplicate runs 250 | worker-1=590 worker-2=560 worker-3=550 worker-4=550
tx-skip-locked | 4.2 s | runs 2000 | distinct jobs 2000 | duplicate runs 0 | worker-1=505 worker-2=502 worker-3=480 worker-4=513
tx-for-update | 10.3 s | runs 2000 | distinct jobs 2000 | duplicate runs 0 | worker-1=498 worker-2=493 worker-3=511 worker-4=498
```

**What to notice**
- **`skip-locked` (the product worker): 2,000 runs, 0 duplicates**, work spread evenly over four processes.
- **`no-lock` (read the next 10 jobs, then mark them running): 250 duplicate runs.** Two workers read the same "next 10" before either marked them.
- **`for-update` without `SKIP LOCKED` was also correct**, because the claim is one short statement: workers waited only milliseconds for each other.
- **The difference appears when locks are held during the work:** `tx-for-update` (the minimal pattern without `SKIP LOCKED`) took **10.3 s**, because all four workers queued behind the same first job; `tx-skip-locked` took **4.2 s**.
- Times include starting four Node.js processes (about a second).

**Diagram: a job's life**

```mermaid
stateDiagram-v2
  [*] --> queued: INSERT
  queued --> running: claimed with SKIP LOCKED, lease set
  running --> done: handler succeeded, still lease holder
  running --> queued: handler failed, attempts left, run_at pushed back
  running --> failed: handler failed, no attempts left
  running --> queued: lease expired, worker died
  done --> [*]
  failed --> [*]
```

**How to read this diagram.** Every arrow out of `running` is a single `UPDATE` guarded by `locked_by`, so only the worker that holds the lease can move the job on, except the lease-expiry arrow, which any worker may take. A job can pass through `running` more than once (failures, expired leases), which is why handlers must be idempotent.

### Step 5: Relieve the hot wallet with shards or batched credits

`src/services/merchantPayments.ts`

```ts
// src/services/merchantPayments.ts: payments INTO one very busy merchant wallet, three ways to credit it.
import { randomInt } from "node:crypto";
import type { Pool } from "pg";
import { withTransaction } from "../lib/db/withTransaction.js";
import { InsufficientFundsError } from "../errors/transferErrors.js";
import { applyBalanceChange, insertCompletedTransfer } from "../repositories/balanceRepository.js";
import type { TransferInput } from "./transferStrategies.js";

export type CreditMode = "direct" | "sharded" | "batched";

export function createMerchantPayments(pool: Pool, shardCount: number) {
  return {
    // Lock order for this path: the payer's row first, the hot merchant row LAST, so the hot lock is held
    // for the shortest time. Refunds must follow the same order (payer, then merchant) to stay deadlock-free.
    pay(input: TransferInput, mode: CreditMode): Promise<string> {
      return withTransaction(pool, { isolationLevel: "READ COMMITTED" }, async (tx) => {
        if (!(await applyBalanceChange(tx, input.sourceWalletId, -input.amountMinor))) {
          throw new InsufficientFundsError(input.sourceWalletId);
        }
        const transferId = await insertCompletedTransfer(tx, input); // ledger entries are written now, in every mode
        const merchant = input.destinationWalletId;
        if (mode === "direct") {
          await applyBalanceChange(tx, merchant, input.amountMinor);
        } else if (mode === "sharded") {
          // 16 rows instead of 1: concurrent payments usually land on different shards.
          await tx.query("UPDATE balance_shards SET balance_minor = balance_minor + $3 WHERE wallet_id = $1 AND shard_no = $2",
            [merchant, randomInt(shardCount), input.amountMinor]);
        } else {
          // No merchant row lock at all: append, and let the batcher apply many credits in one UPDATE.
          await tx.query("INSERT INTO pending_credits (wallet_id, transfer_id, amount_minor) VALUES ($1, $2, $3)",
            [merchant, transferId, input.amountMinor]);
        }
        return transferId;
      });
    },

    // Run every few hundred ms by ONE batcher per merchant (or several: SKIP LOCKED keeps their batches apart).
    async applyPendingCredits(walletId: string, limit = 5_000): Promise<number> {
      const { rows } = await pool.query<{ applied: string }>(`
        WITH batch AS (
          SELECT id FROM pending_credits WHERE wallet_id = $1 AND applied_at IS NULL
           ORDER BY id LIMIT $2 FOR UPDATE SKIP LOCKED),
        marked AS (
          UPDATE pending_credits p SET applied_at = now() FROM batch WHERE p.id = batch.id RETURNING p.amount_minor)
        UPDATE wallet_balances SET balance_minor = balance_minor + (SELECT coalesce(sum(amount_minor), 0) FROM marked),
                                   updated_at = now()
         WHERE wallet_id = $1
        RETURNING (SELECT count(*) FROM marked) AS applied`, [walletId, limit]);
      return Number(rows[0]?.applied ?? 0);
    },

    // The merchant's real balance: the cached row, plus all shards, plus credits not yet applied.
    async balance(walletId: string): Promise<number> {
      const { rows } = await pool.query<{ total: string }>(`
        SELECT (SELECT balance_minor FROM wallet_balances WHERE wallet_id = $1)
             + (SELECT coalesce(sum(balance_minor), 0) FROM balance_shards WHERE wallet_id = $1)
             + (SELECT coalesce(sum(amount_minor), 0) FROM pending_credits WHERE wallet_id = $1 AND applied_at IS NULL) AS total`,
        [walletId]);
      return Number(rows[0]!.total);
    },
  };
}
```

**What to notice**
- **The payment always writes the transfer and both ledger entries in its own transaction.** Only the cached balance is sharded or batched; the books are never behind.
- **Lock order on this path is "payer, then merchant"**, so the hot lock is the last and shortest one. Refunds must use the same order.
- **The batcher's claim uses `FOR UPDATE SKIP LOCKED`**, so you can run two batchers for safety without double-applying a credit; marking and adding happen in one statement.
- **`balance()` adds all three places a merchant's money can be.** Any read that must be exact (a payout check, a dashboard) uses it, not the cached row alone.

```bash
DATABASE_URL=postgres://postgres:lab@127.0.0.1:5432/ledger_cc npx tsx bench/hotWallet.ts
```

**Real output**: in Deep dive 6 (472 to 560 → 900 to 982 → 1,386 to 1,577 → 1,574 to 1,758 payments a second).

---

## 💥 Break it and measure it

| # | Break this | What you should see | Result here |
|---|---|---|---|
| 1 | Lock source then destination, in request order, among 10 wallets | Deadlocks, then a pile-up | **Real:** 106 to 112 deadlocks per 1,000; 23 to 24 transfers/s; 751 to 791 requests failed |
| 2 | The same, with the product pool's 2 s wait for a connection | Requests fail before they start | **Real:** 938 to 980 of 1,000 failed with "timeout exceeded when trying to connect" |
| 3 | Optimistic version checks on one hot merchant | Retry storm | **Real:** 5.2 to 5.4 retries per payment; 280 to 295 of 1,000 gave up |
| 4 | An `async-mutex` around read-add-write, in 4 processes | Lost updates | **Real:** 643 of 1,000 top-ups lost |
| 5 | Workers read "next 10 queued jobs", then mark them running | Jobs run twice | **Real:** 250 duplicate runs out of 2,000 jobs |
| 6 | Hold the job's row lock during the job, without `SKIP LOCKED` | Workers queue behind one job | **Real:** 10.3 s for 2,000 jobs vs 4.2 s with `SKIP LOCKED` |
| 7 | `FOR UPDATE` on a wallet row, then insert a child row elsewhere | The insert waits | **Real:** waited until the lock holder rolled back; `FOR NO KEY UPDATE` did not block it |
| 8 | `FOR UPDATE NOWAIT` on a locked row | Immediate error instead of a wait | **Real:** `could not obtain lock on row in relation "wallets"` (`55P03`) |
| 9 | Credit a hot merchant's row directly, lower id first | One lock limits everyone | **Real:** 472 to 612 payments/s; batched credits 1,574 to 1,758/s |
| 10 | Kill a worker process in the middle of a job (`kill -9`) | The job comes back after its lease | **Expected:** after `locked_until`, `REQUEUE_EXPIRED` sets it to `queued` and another worker runs it again; this is why handlers must be idempotent |
| 11 | Take a session-level `pg_advisory_lock` and forget to unlock, behind a connection pool | The lock leaks to the next request on that connection | **Expected:** other pods wait forever for a lock nobody thinks they hold; use the `_xact_` functions |

### Measurements

**The card's Measure items: throughput, p95 and retry or abort counts per strategy, under low and high contention.** Low = 1,000 transfers spread over 10 wallets; high = 1,000 payments into one hot merchant (the card's two k6 scenarios). **Real output** from the Node.js harness, three runs each; fill the last column from your k6 runs.

| Strategy | Low: transfers/s | Low: p95 | Low: retries / aborts | High: transfers/s | High: p95 | High: retries / aborts | Your machine (k6) |
|---|---|---|---|---|---|---|---|
| Atomic conditional update | 1,021 to 1,187 | 802 to 936 ms | 0 / 0 | 555 to 612 | 1,552 to 1,710 ms | 0 / 0 | |
| Pessimistic, ordered locks | 840 to 899 | 1,017 to 1,112 ms | 0 / 0 | 490 to 554 | 1,742 to 1,972 ms | 0 / 0 | |
| Optimistic version + retry | 355 to 377 | 2,389 to 2,559 ms | 3,423 to 3,470 / 23 to 35 | 236 to 257 | 3,708 to 4,087 ms | 5,205 to 5,380 / 280 to 295 | |
| Pessimistic, unordered (the mistake) | 23 to 24 | 35,354 to 37,251 ms | 106 to 112 deadlocks / 751 to 791 failed | 502 to 581 | 1,648 to 1,904 ms | 0 / 0 | |
| Hot merchant, merchant row last | | | | 900 to 982 | 982 to 1,062 ms | 0 / 0 | |
| Hot merchant, 16 shards | | | | 1,386 to 1,577 | 600 to 697 ms | 0 / 0 | |
| Hot merchant, batched credits | | | | 1,574 to 1,758 | 542 to 610 ms | 0 / 0 | |

---

## 🚫 Common mistakes and wrong mental models

### 1. Wrong mental model: "locks are slow, so avoid them"

**The truth.** A short row lock costs microseconds when nobody else wants the row, and puts requests in a fair queue when they do. "Avoiding locks" usually means a read-check-write race, and wrong balances cost far more than a queue. Measure under real contention before deciding: in this guide, ordered row locks ran at **840 to 899 transfers/s** on 10 busy wallets, while the "lock-free" optimistic strategy managed **355 to 377/s**, with thousands of retries.

```ts
// Beginner way: "no lock, it's faster". Read, check in JavaScript, write back.
const { rows } = await tx.query("SELECT balance_minor FROM wallet_balances WHERE wallet_id = $1", [walletId]);
if (Number(rows[0].balance_minor) < amountMinor) throw new InsufficientFundsError(walletId);
await tx.query("UPDATE wallet_balances SET balance_minor = $2 WHERE wallet_id = $1", [walletId, Number(rows[0].balance_minor) - amountMinor]);
```

```ts
// Product way: the database does the check and the change together (or lock the rows first, lowest id first).
if (!(await applyBalanceChange(tx, walletId, -amountMinor))) throw new InsufficientFundsError(walletId);
```

What breaks in the beginner way: two debits read the same balance and both pass (the lost update from P2-03: ₹1,400 paid out of ₹1,000).

### 2. Using an in-memory mutex in a multi-instance deployment

```ts
// Beginner way: a mutex per process. Correct on your laptop (one process), wrong in production (many).
const walletMutex = new Mutex();
await walletMutex.runExclusive(async () => {
  const balance = await readBalance(walletId);
  await writeBalance(walletId, balance + amountMinor);
});
```

```ts
// Product way: let Postgres serialise it. An atomic statement needs no lock code at all...
await pool.query("UPDATE wallet_balances SET balance_minor = balance_minor + $2 WHERE wallet_id = $1", [walletId, amountMinor]);
// ...and when it really is a multi-step critical section, an advisory lock inside a transaction:
await withTransaction(pool, { isolationLevel: "READ COMMITTED" }, async (tx) => {
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`wallet:${walletId}`]);
  // ... read, decide, write
});
```

What breaks in the beginner way: 643 of 1,000 top-ups were lost with four processes (Deep dive 8).

### 3. Optimistic locking under heavy contention

```ts
// Beginner way: optimistic version checks for every merchant credit, "because it's lock-free".
const row = await readBalanceWithVersion(merchantId);
if (!(await compareAndSetBalance(tx, row, row.balanceMinor + amountMinor))) throw new VersionConflictError(merchantId);
```

```ts
// Product way: a credit cannot break "balance >= 0", so make it a commutative increment...
await applyBalanceChange(tx, merchantId, amountMinor);
// ...and for a truly hot merchant, shard or batch it (src/services/merchantPayments.ts).
// Keep optimistic checks for what they are good at: human edits across HTTP requests (ETag / If-Match).
```

What breaks in the beginner way: 5.2 to 5.4 retries per payment, and 280 to 295 of 1,000 payments gave up (the retry storm in the benchmark).

### 4. Holding row locks while waiting on a network call

```ts
// Beginner way: lock the job (or wallet) row, then call the SMS provider while holding the lock.
await withTransaction(pool, { isolationLevel: "READ COMMITTED" }, async (tx) => {
  const { rows } = await tx.query("SELECT id, payload FROM jobs WHERE status = 'queued' LIMIT 1 FOR UPDATE SKIP LOCKED");
  await smsProvider.send(rows[0].payload);                   // 300 ms to 30 s, with the row locked and a connection held
  await tx.query("UPDATE jobs SET status = 'done' WHERE id = $1", [rows[0].id]);
});
```

```ts
// Product way: claim with a lease in one short statement, do the network call with no transaction open,
// then finish with a guarded UPDATE (src/workers/jobWorker.ts).
const worker = createJobWorker({ pool, log, workerId, handlers: { send_sms: sendSms }, leaseMs: 30_000 });
worker.start();
```

What breaks in the beginner way: every second the provider takes is a second the lock, the connection and an open transaction are held; P2-03 measured 4,112 ms vs 221 ms for 20 operations on one wallet with a 200 ms call inside vs outside.

### More wrong mental models

| Wrong model | Correct model |
|---|---|
| "`SKIP LOCKED` gives exactly-once processing." | It gives each claim to one worker. With leases and crashes, a job can run again: at-least-once. Make handlers idempotent. |
| "A deadlock is a Postgres bug." | It is two transactions taking locks in different orders. Fix the order in your code; retry `40P01` for the rest. |
| "`FOR UPDATE` is the lock to use before an update." | Usually `FOR NO KEY UPDATE`: it is what `UPDATE` itself takes, and it does not block foreign-key checks from child inserts. |
| "Optimistic locking never waits." | In Postgres, the `UPDATE ... WHERE version = $v` still waits for a concurrent writer's row lock, then finds the version changed. |
| "More connections or pods will speed up a hot row." | They queue for the same row lock. Shorten the lock, shard, batch, or queue per key. |
| "Check for duplicates with a `SELECT`, then insert." | Two requests can both see "no duplicate". Let a `UNIQUE` index decide. |
| "An advisory lock protects the wallet row." | Only from code that also takes the same advisory lock. Anything else can still update the row. Prefer row locks for row data. |

---
## ✅ Production checklist

**Choosing the tool**
- [ ] Every write path that two requests can hit at once has a named strategy: atomic statement, ordered row lock, version check, unique constraint or advisory lock.
- [ ] Single-row rules use one guarded statement; `CHECK` constraints back them up.
- [ ] "At most one of these" rules (idempotency keys, seats, payouts per day) are `UNIQUE` indexes, not `SELECT`-then-`INSERT`.
- [ ] Optimistic checks are used where contention is low or the edit spans HTTP requests; `PATCH` endpoints require `If-Match` (`428` without it, `412` on mismatch).

**Locks**
- [ ] One documented lock order for each table group (for example "wallet rows, lowest id first"; or "payer, then merchant" on the payment path), followed by transfers, refunds and admin tools alike.
- [ ] Multi-row locks are taken in one statement with `ORDER BY ... FOR NO KEY UPDATE`.
- [ ] `FOR UPDATE` only where a key may change or a row may be deleted; `FOR NO KEY UPDATE` otherwise.
- [ ] `lock_timeout`, `statement_timeout` and `idle_in_transaction_session_timeout` set on every pool (P2-03); `NOWAIT` where an immediate "busy" answer is better than waiting.
- [ ] No row lock, advisory lock or open transaction across a network call, a sleep or a user's think-time.
- [ ] `40P01` and optimistic conflicts are retried with jittered backoff and a cap; retries and give-ups are metrics.

**Queues and hot rows**
- [ ] Job workers claim with `FOR UPDATE SKIP LOCKED` and a lease, run jobs outside transactions, finish with a guarded `UPDATE`, and requeue expired leases.
- [ ] Job handlers are idempotent (at-least-once delivery).
- [ ] Known hot keys (big merchants, flash-sale items, celebrity posts) are listed, with a plan: hot row last, shards, batched credits, or a queue per key.
- [ ] Any read that must be exact for a sharded or batched balance uses the full sum (cached + shards + unapplied).
- [ ] `log_lock_waits = on` in Postgres, and a dashboard on lock waits and deadlocks (`pg_stat_database.deadlocks`).

**Multi-instance safety**
- [ ] No in-process mutex guards shared data. Shared state lives in Postgres (or Redis with its own atomic operations, P2-07).
- [ ] Advisory locks use the transaction-level functions, so a connection pool or PgBouncer cannot leak them.

---

## 🤖 Engineering with AI

**Where AI tools help**
- Turning a read-check-write into a guarded `UPDATE ... RETURNING`, or into a locked, ordered `SELECT ... FOR NO KEY UPDATE`.
- Writing the `SKIP LOCKED` claim query, the lease and requeue statements, and a multi-process test that counts duplicate runs.
- Generating two-session `psql` scripts that reproduce a deadlock or a lost update before you fix it.
- Writing k6 scenarios and summarising their output into a per-strategy table.

**Where AI commonly goes wrong on this concept**
- Adds an in-memory mutex (`async-mutex`, a `Map` of promises, a "lock" flag) and calls the code thread-safe.
- Locks rows in request order (`source`, then `destination`), which deadlocks under opposite transfers.
- Uses `FOR UPDATE` everywhere, blocking unrelated child-table inserts.
- Picks optimistic locking for counters, balances or inventory under load, or retries a version conflict by re-running only the failed `UPDATE` with the stale values.
- Writes a job queue as `SELECT ... LIMIT 10` followed by `UPDATE ... SET status = 'running'`, with no lock: duplicate runs.
- Holds the job's transaction open while calling an email or SMS API.
- Uses session-level `pg_advisory_lock` with a pool and forgets the unlock path on errors.
- Suggests a Redis lock for data that lives in Postgres, without fencing tokens.

**Review checklist for AI-generated concurrency code**
- [ ] What happens if two requests run this at exactly the same moment, on the same row? On rows in opposite order?
- [ ] Is there any read whose value is written back after a decision, without a lock or a guard in the `WHERE`?
- [ ] Are multi-row locks taken in one fixed order? Do all code paths (refunds, admin, jobs) use the same order?
- [ ] Is any lock or transaction held across `await fetch(...)`, a provider SDK call, a queue publish or a sleep?
- [ ] For optimistic code: is the whole read-decide-write retried, with a cap? What is the expected contention?
- [ ] For queues: `SKIP LOCKED`, lease, guarded completion, requeue of expired leases, idempotent handler?
- [ ] Is there a multi-process or multi-connection test, not just a single-process unit test?

**Prompts that work**

1. *"Here is my transfer code. Run a thought experiment: transfer A (wallet 1 to 2) and transfer B (wallet 2 to 1) start at the same instant on Postgres Read Committed. List the locks each statement takes, in order, and say whether they can deadlock or lose an update. Then rewrite it so rows are locked lowest id first in one statement with FOR NO KEY UPDATE."*
   **Verify by:** reproducing both orders in two `psql` sessions (lab step 3) and checking that only the original deadlocks.
2. *"Write a Postgres job worker in TypeScript with node-postgres: claim up to N jobs with UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED) RETURNING, a lease column, handlers run outside any transaction, completion and failure guarded by locked_by, exponential run_at backoff, requeue of expired leases, and graceful stop on SIGTERM. Then write a script that runs 4 worker processes over 2,000 jobs and counts duplicate runs."*
   **Verify by:** the duplicate count is 0, and killing a worker with `kill -9` brings its jobs back after the lease.
3. *"For each write path in this service, estimate contention (how many concurrent writers per row at peak) and recommend atomic update, ordered pessimistic lock, optimistic version, unique constraint or advisory lock. Flag any hot keys and propose a mitigation."*
   **Verify by:** a k6 run per path at your expected peak, comparing p95 and retry counts with the recommendation.

---

## 🎤 Interview script

**How it shows up.** Seat booking ("two users click the last seat"), flash-sale inventory ("1,000 phones, 2 lakh users at noon"), wallet debits, and like or view counters. Strong answers pick the tool from the expected contention, say what the losing request experiences, and bring up hot keys before the interviewer does.

### 2-minute answer: "How would you handle concurrent updates to the same row?"

1. **First, the rule and the contention.** What must stay true (balance ≥ 0, one booking per seat), and how many writers per row at peak: a user's wallet sees a few, a big merchant thousands.
2. **If the rule fits one statement, use an atomic conditional update.** `UPDATE ... SET balance = balance - $1 WHERE id = $2 AND balance >= $1`. No locks to manage, no retries; in my benchmark it was the fastest at both low and high contention.
3. **If I must read and decide first, lock the rows pessimistically, in a fixed order.** `SELECT ... ORDER BY id FOR NO KEY UPDATE`, short transaction, `lock_timeout`, nothing slow inside. Lock ordering is what keeps it deadlock-free; when I broke the order, 1,000 transfers among 10 wallets produced over 100 deadlocks and the service fell to 24 requests a second.
4. **Optimistic version checks for low contention or long think-time.** Settings edits with ETag and `If-Match`. Never for hot rows: on one merchant wallet, 28 to 30% of payments gave up after 10 retries.
5. **"At most one" rules go to a unique index; non-row critical sections to an advisory lock; hot keys get special treatment:** hot row last, sharded balances, batched credits, or a queue per key.

### Five likely follow-ups

1. **"When is optimistic better than pessimistic?"**
   When conflicts are rare and holding a lock is impossible or wasteful: users editing a form for minutes, mobile clients syncing offline changes, read-mostly data. Pessimistic is better when conflicts are frequent: waiting in a queue is cheaper than redoing work, and it is fair. My measurements: at 10 busy wallets, ordered locks did 840 to 899 transfers a second with zero retries; optimistic did 355 to 377 with about 3.4 retries per transfer.
2. **"How do you prevent deadlocks?"**
   Lock in a consistent order everywhere: for wallets, lowest id first, in one `SELECT ... ORDER BY id FOR NO KEY UPDATE`. Take the strongest lock you need first, keep transactions short, set `lock_timeout`, and still retry `40P01`, because a code path you do not control may break the order. Postgres detects a deadlock after `deadlock_timeout` (1 s), aborts one transaction and lets the other finish.
3. **"Build a job queue on Postgres."**
   A `jobs` table with a partial index on ready jobs. Workers claim a batch with `UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED) RETURNING`, setting a lease; they run jobs outside any transaction and finish with an `UPDATE` guarded by `locked_by`; expired leases are requeued. It is at-least-once, so handlers are idempotent. My test: four processes, 2,000 jobs, zero duplicates; without the lock, 250 duplicates. Past a few thousand jobs a second, or for fan-out to many consumers, I would move to a broker (P3-05, P4-06).
4. **"One merchant receives thousands of payments a second. What do you do?"**
   Measure first; the row lock caps throughput at roughly one over the lock hold time. Then: credit the merchant last in each transaction (about 2x in my test), split the balance into shards (about 3x), or append credits and apply them in batches (about 3x, 11 updates per 1,000 payments, 50 ms of lag). The ledger entries are written in every payment transaction, so only the cached balance is sharded or delayed. Across services, partition the payment stream by merchant id and let one consumer batch the credits.
5. **"Why not just use a Redis lock?"**
   The data lives in Postgres, so the lock should too: a row lock or advisory lock is released with the transaction and cannot outlive a crashed process's writes. A Redis lock can expire while the holder is paused and still writing, so it needs fencing tokens to be safe (P4-05). Redis is great for its own atomic operations (`INCR`, Lua scripts), not as a lock for another database.

### Red flags interviewers notice

- "I'll use a mutex" or "I'll use a lock" without saying where the lock lives.
- Picking optimistic locking for inventory, counters or a merchant balance at high traffic.
- `SELECT` to check, then `INSERT`/`UPDATE`, with no lock, guard or unique index.
- No mention of lock order when two rows are locked.
- A transaction that calls a payment provider or sends an email.
- "Add more servers" as the answer to a hot row.

### Mini design: a flash sale, 1,000 phones, 2 lakh users at 12:00

**Numbers** (computed): 2 lakh users in the first minute is about **3,333 order attempts a second**. One stock row with an atomic `stock = stock - 1 WHERE stock > 0` is a single hot row; on this guide's hardware, a full payment transaction on one hot row managed 490 to 612 a second, about **6 times too slow** for that peak.

| Need | Tool |
|---|---|
| Never sell more than 1,000 | Split stock into **20 buckets of 50** (`inventory_buckets`). Each attempt picks a random bucket and runs `UPDATE ... SET stock = stock - 1 WHERE sale_id = $1 AND bucket = $2 AND stock > 0`; on zero rows it tries another bucket, and when all are empty, the sale is sold out. |
| One phone per user | `UNIQUE (sale_id, user_id)` on `orders`; a double click becomes `ON CONFLICT DO NOTHING`. |
| Pay within 10 minutes | The order and the stock decrement commit together as a "hold"; payment happens outside the transaction; a `SKIP LOCKED` job releases expired holds (adds the unit back to its bucket). |
| Survive the spike | Rate limiting and a waiting room in front (P3-04), so the database sees a steady flow, not 2 lakh requests at 12:00:00. |

**Decisions to say out loud.** Every step is an atomic statement or a unique index: no optimistic retries on a hot item, no long locks. Buckets turn one hot row into 20 warm ones. The order of locks is simple (one bucket row per transaction). Stock that is held but unpaid comes back through a job, not through a user's open transaction.

---

## ❓ Questions from the card, answered

Try each one yourself first, then open the answer.

<details>
<summary><b>1. When is optimistic locking better than pessimistic, and when is it worse?</b></summary>

**Better** when conflicts are rare, or when you cannot hold a lock: a user editing wallet settings on two devices (the version travels as an ETag and comes back in `If-Match`), mobile apps syncing offline edits, read-mostly records. It holds no lock while the user or the app thinks, never blocks readers, and needs nothing from the database except a version column. At low contention (1,000 wallets) it performed like the other strategies here: 1,202 to 1,396 transfers a second with 44 to 68 retries per 1,000.

**Worse** when many writers want the same row. Every conflict throws away a whole transaction's work, the retries collide again, and some requests starve. Here, at 10 busy wallets: 355 to 377 transfers a second (atomic: 1,021 to 1,187), about 3.4 retries per transfer, and 23 to 35 of 1,000 gave up. On one hot merchant: 5.2 to 5.4 retries per payment and 280 to 295 gave up. In Postgres it also still waits for the competing writer's row lock before discovering the conflict. Under high contention, pessimistic locks (waiting in a fair queue) or an atomic statement are better.

</details>

<details>
<summary><b>2. How does locking rows in a consistent order prevent deadlocks?</b></summary>

A deadlock is a circle: A holds wallet 1 and waits for 2, while B holds 2 and waits for 1. For a circle to form, at least one transaction must wait for a row that comes **earlier** in the order than one it already holds.

If every transaction locks rows in the same order (for wallets, lowest id first), a transaction only ever waits for a row that comes **after** everything it holds. Any chain of waiting then moves only forward through the order, so it can never loop back: no circle, no deadlock. The later transaction simply queues.

In this guide's `psql` lab, debiting the source first deadlocked after 1.1 s (`ERROR: deadlock detected`, `40P01`); with both transfers starting at wallet 1, B just waited for A and both committed. At scale, unordered locks gave 106 to 112 deadlocks per 1,000 transfers and collapsed throughput to 24 a second; ordered locks gave none, at 840 to 899 a second.

</details>

<details>
<summary><b>3. How does SKIP LOCKED let many workers pull jobs from one table safely?</b></summary>

Each worker claims jobs with `SELECT ... FOR UPDATE SKIP LOCKED` (inside an `UPDATE ... WHERE id IN (...)` that marks them `running`). The `FOR UPDATE` row lock means two workers can never claim the same row at the same time. `SKIP LOCKED` means a worker that finds a row already locked **skips it and takes the next one** instead of waiting. So four workers asking at once get four different batches, with no queueing between them. Once the claiming statement commits, the rows are `running`, so later claims do not match them.

Two more pieces make it production-safe: a **lease** (`locked_until`), so a crashed worker's jobs return to the queue, and completion guarded by `locked_by`, so a worker that lost its lease cannot mark the job done. That makes delivery at-least-once, so handlers must be idempotent.

Measured here: four worker processes, 2,000 jobs, **0 duplicate runs**; the same workers reading jobs without a lock ran **250** jobs twice. When the lock is held for the whole job, `SKIP LOCKED` matters for speed too: 4.2 s vs 10.3 s without it.

</details>

<details>
<summary><b>4. What do you do when one merchant wallet receives thousands of payments per second?</b></summary>

Every payment that updates the merchant's balance row takes the same row lock, so payments run one at a time however many servers you add. The limit is about one over the lock hold time. In this guide that was 472 to 612 payments a second.

In order of effort:
1. **Hold the hot lock for less time:** short transactions, and touch the merchant row **last**, with the same order on every path (payer, then merchant). Measured: 900 to 982 a second.
2. **Split the balance into sub-accounts (shards):** 16 rows per merchant, each credit picks one, the balance is their sum; payouts lock all shards in order. Measured: 1,386 to 1,577 a second.
3. **Batch the credits:** append a `pending_credits` row per payment (no merchant lock); a batcher applies them every 50 ms in one `UPDATE`, claiming with `SKIP LOCKED`. Measured: 1,574 to 1,758 a second, 11 or 12 updates per 1,000 payments, balance caught up within 51 ms.
4. **A queue per key:** partition the payment stream by merchant id (Kafka, P4-06) so one consumer applies that merchant's credits in batches.

In every option, the ledger entries are written in the payment's own transaction, so the books are always right; only the cached balance is sharded or delayed, and exact reads add up all the parts. And avoid optimistic locking here: it gave up on 28 to 30% of payments.

</details>

---

## 🏋️ Exercises

### Beginner (no code)

1. **Draw the circle.** Three transfers run at once: 1→2, 2→3 and 3→1, each debiting its source first. Draw who holds what and who waits for whom. Then redraw with "lowest id first".
   **Expected:** a three-way circle in the first drawing; a straight line of waiting in the second. **Verify:** reproduce it in three `psql` sessions.
2. **Pick the tool.** For each, choose atomic, pessimistic, optimistic, unique constraint or advisory lock: (a) a like counter on a viral post, (b) editing a merchant's display name, (c) one refund per order, (d) a nightly settlement job, (e) moving money between two wallets after a fraud check.
   **Expected:** (a) atomic increment, sharded if very hot; (b) optimistic with ETag; (c) unique constraint; (d) advisory lock (`pg_try_...`); (e) pessimistic, ordered. **Verify:** against the decision table.

### Intermediate (extend the lab)

3. **`NOWAIT` for a better UX.** Add a "wallet is busy" path: the pessimistic strategy uses `FOR NO KEY UPDATE NOWAIT` for user-initiated transfers and maps `55P03` to `409 Conflict` with `Retry-After: 1`. Run the 10-wallet benchmark.
   **Expected:** no long lock waits; some requests get `409` under contention; p95 drops. **Verify:** count `409`s and compare p95 with the waiting version.
4. **A batcher with two instances.** Run two batchers for the hot merchant at once.
   **Expected:** the merchant total is still exactly right, because claims use `SKIP LOCKED`. **Verify:** `balance()` equals the sum of payments, and no `pending_credits` row is applied twice (`applied_at` set once).

### Advanced (failure injection and 10x)

5. **Kill workers.** Run the 4-process job test with a 2-second lease and `kill -9` one worker halfway.
   **Expected:** its claimed jobs return to `queued` after the lease and run again; `job_runs` shows a few duplicates (at-least-once). **Verify:** the duplicates are exactly jobs the killed worker had claimed; add a dedupe key in the handler and show zero duplicate side effects.
6. **10x the hot merchant.** 10,000 payments with 100 connections (raise Postgres `max_connections` if needed), comparing direct, row last, 16 and 64 shards, and batching at 50 ms and 500 ms.
   **Expected:** direct credit does not scale with connections; shards scale until another bottleneck (CPU, WAL) appears; longer batches mean higher throughput but more lag. **Verify:** payments/s, p95 and lag per design.

---

## 📝 Quiz

1. Which row lock does a plain `UPDATE` of a non-key column take, and why does it matter for child-table inserts?
2. What does `SELECT ... FOR UPDATE NOWAIT` do when the row is locked, and what SQLSTATE do you get?
3. In an optimistic update, what does `UPDATE 0` mean, and what must the code do next?
4. Which HTTP status should a `PATCH` get when its `If-Match` ETag is stale? When `If-Match` is missing?
5. Two transfers deadlock. How long does Postgres wait before checking, which transaction does it abort, and what is the error code?
6. Why does "lowest wallet id first" prevent deadlocks?
7. Why is an `async-mutex` around a database read-modify-write unsafe in production?
8. Your queue workers use `FOR UPDATE SKIP LOCKED` and leases. Can a job ever run twice?
9. Why does adding database connections not speed up payments into one merchant wallet?
10. Which is the safest default for advisory locks behind a connection pool: session-level or transaction-level? Why?

## 🔑 Quiz answer key

1. **`FOR NO KEY UPDATE`.** It does not conflict with `FOR KEY SHARE`, the lock a foreign-key check takes when a child row is inserted, so child inserts are not blocked. `FOR UPDATE` would block them.
2. **It fails at once** with `could not obtain lock on row in relation ...`, SQLSTATE **`55P03`** (`lock_not_available`), instead of waiting.
3. **Someone changed the row since you read it** (the version moved on). Re-read the row and re-run the whole decision, with backoff and a retry cap.
4. **`412 Precondition Failed`** for a stale ETag; **`428 Precondition Required`** when `If-Match` is missing.
5. **`deadlock_timeout`, 1 second by default**; Postgres aborts one of them, and which one is not predictable; the error is **`40P01`** (`deadlock detected`). Retry the aborted transaction.
6. **A transaction only waits for rows later in the order than all the rows it holds**, so waiting can never form a circle.
7. **The mutex lives in one process's memory.** Other processes and pods have their own, so their read-modify-writes interleave: 643 of 1,000 top-ups were lost with four processes here.
8. **Yes: delivery is at-least-once.** If a worker dies or runs past its lease, the job is requeued and may run again. Handlers must be idempotent.
9. **Every payment needs the same row lock**, so they run one at a time; more connections just queue. Shorten the lock, shard, batch or queue per key.
10. **Transaction-level** (`pg_advisory_xact_lock`): it is released automatically at commit or rollback, so it cannot leak to the next request that borrows the connection.

---

## 📖 Glossary

| Term | Meaning |
|---|---|
| Advisory lock | A lock on an application-chosen number, visible to every session on the database. |
| At-least-once | Every job runs, but some may run more than once; handlers must be idempotent. |
| Atomic conditional update | One statement that checks and changes a row, such as `... WHERE balance >= $1`. |
| Batching (credits) | Appending changes and applying many of them in one update. |
| Contention | How many concurrent requests want the same row. |
| Deadlock | Transactions waiting for each other in a circle; Postgres aborts one with `40P01`. |
| `deadlock_timeout` | How long Postgres waits on a lock before checking for a deadlock (1 s by default). |
| ETag | A version tag a server sends with a resource; strong ETags compare exactly. |
| Fencing token | A number that increases with every lock grant, so storage can reject writes from an old holder (P4-05). |
| `FOR NO KEY UPDATE` | The row lock a normal `UPDATE` takes; does not block foreign-key checks. |
| `FOR UPDATE` | The strongest row lock; also blocks foreign-key checks from child inserts. |
| Hot row / hot key | One row or key that receives a large share of all writes. |
| `If-Match` | HTTP header: "apply this change only if the current ETag is this one". |
| Lease | A time-limited claim on a job (`locked_until`). |
| Lock order | The fixed order in which all code takes locks, to prevent deadlocks. |
| `lock_timeout` | Give up waiting for a lock after this long (`55P03`). |
| `NOWAIT` | Fail immediately instead of waiting for a locked row. |
| Optimistic locking | No lock at read time; the write checks a version and fails if it changed. |
| Pessimistic locking | Lock first, then read and write; others wait. |
| Queue per key | Routing all work for one key (merchant) to one consumer, which applies it in order. |
| Retry storm | Many failed attempts retrying and colliding again, wasting most of the work. |
| Shard (balance) | One of N rows that together hold one account's balance. |
| `SKIP LOCKED` | Skip rows locked by others instead of waiting; made for queue tables. |
| Starvation | A request that keeps losing races and never completes. |
| Version column | A counter bumped on every change, used for optimistic checks. |

---

## 🧾 Cheat sheet

**Diagram: concurrency control on one screen**

```mermaid
mindmap
  root((Concurrency control))
    Atomic update
      check inside WHERE
      fastest in every test here
      credits need no check
    Pessimistic
      FOR NO KEY UPDATE
      lowest id first
      NOWAIT or lock_timeout
    Optimistic
      version column
      ETag and If-Match
      low contention only
    Other tools
      UNIQUE index for at most one
      advisory xact lock for non rows
      SKIP LOCKED for queues
    Hot rows
      hot row last
      shards
      batched credits
      queue per key
```

**How to read this diagram.** Five branches: the three main strategies, the specialised tools, and what to do when one row gets most of the traffic. Read each leaf as a rule for code review.

**Rules**
1. Name the rule and the expected contention before picking a tool.
2. If one statement can carry the rule, use an atomic conditional update.
3. If you must read and decide, lock with `FOR NO KEY UPDATE`, lowest id first, in one statement.
4. Optimistic versions for low contention and edits across HTTP requests (ETag, `If-Match`, `412`, `428`); never for hot rows.
5. "At most one" is a `UNIQUE` index; non-row critical sections are `pg_advisory_xact_lock`.
6. Never hold a lock or a transaction across a network call; claim with a lease instead.
7. Queues: `FOR UPDATE SKIP LOCKED`, lease, guarded completion, idempotent handlers.
8. Hot rows: hot row last, shards, batching, queue per key; more connections do not help.
9. A JavaScript mutex protects one process only.
10. Retry `40P01` and version conflicts with jitter and a cap; watch the counts.

---

## ☑️ Completion checklist

- [ ] I can explain the four row-lock modes and why `FOR NO KEY UPDATE` is the usual choice.
- [ ] Lab run on my machine: the three transfer strategies pass the concurrency test.
- [ ] Numbers filled in: throughput, p95 and retry or abort counts per strategy at low contention (10 wallets), from k6.
- [ ] Numbers filled in: the same at high contention (one hot merchant), from k6.
- [ ] I caused a deadlock in two `psql` sessions, found it in the server log, and fixed it with lock ordering.
- [ ] Four worker processes ran 2,000 jobs with zero duplicates; the no-lock version showed duplicates.
- [ ] Hot-merchant numbers filled in for direct, hot row last, shards and batching.
- [ ] I can give the 2-minute answer and the five follow-ups without notes.
- [ ] Phase 2 gate: a test proves balances never go negative under concurrency, for every transfer path.
- [ ] Post published.

---

## 📣 Learn in public

**Post 1: our deadlocks came from the order of two lines**
- **Problem:** 1,000 transfers among 10 wallets: [your number] deadlocks, and throughput fell to [your number] a second.
- **Decision:** Locked both wallets in one statement, lowest id first, with `FOR NO KEY UPDATE`.
- **Result:** zero deadlocks, [your number] transfers a second.
- **Lesson:** Deadlocks are not bad luck; they are two code paths that disagree on lock order.

**Post 2: optimistic locking gave up on a third of our payments**
- **Problem:** Payments into one busy merchant used version checks: [your number] retries per payment, [your number]% gave up.
- **Decision:** Atomic increments for credits, and batched credits for the hottest merchant.
- **Result:** [your number] payments a second, zero retries, balance lag under [your number] ms.
- **Lesson:** Pick optimistic or pessimistic by contention, not by fashion. Measure under the real hot key.

**Post 3: a mutex that passed every test and lost 64% of updates**
- **Problem:** An in-memory mutex guarded a read-modify-write. With 4 processes, [your number] of 1,000 top-ups vanished.
- **Decision:** Replaced it with one atomic `UPDATE` (and an advisory lock where a real critical section was needed).
- **Result:** zero lost updates, and faster.
- **Lesson:** A lock must live where every instance can see it: in the database.

**Hinglish video idea: "Lock lagaun ya na lagaun? Wallet, flash sale aur deadlock ka live demo"**
Split screen with two `psql` terminals. Show the deadlock live (Riya → Amit and Amit → Riya), then fix it by just changing the order of two `UPDATE`s. Then the benchmark table: optimistic vs pessimistic vs atomic at 10 wallets and on one hot merchant. End with the 4-process mutex demo losing top-ups. Hook line: "Mutex lagaya, test pass hua, production mein paisa gayab. Kyun? Lock galat jagah tha."

---

## ➡️ Next cards

- **P3-04 · Rate limiting:** a token bucket is an atomic counter under heavy contention, the same hot-key problem in Redis, and admission control is how you keep a flash sale from overwhelming the hot rows in this card.
- **P4-05 · Coordination: consensus, leader election, locks:** advisory locks and job leases are coordination inside one Postgres. Next: locks across machines, leases that can expire while a holder is paused, fencing tokens, and leader election.

---

## 🔗 Sources and further reading

Checked on 23 Oct 2026.

- [Explicit Locking](https://www.postgresql.org/docs/current/explicit-locking.html) (PostgreSQL 18 docs): row-level lock modes and their conflict table, deadlocks, advisory locks
- [SELECT: the locking clause](https://www.postgresql.org/docs/current/sql-select.html) (PostgreSQL docs): `FOR UPDATE`, `FOR NO KEY UPDATE`, `NOWAIT`, `SKIP LOCKED` and its warning
- [Advisory lock functions](https://www.postgresql.org/docs/current/functions-admin.html) (PostgreSQL docs): `pg_advisory_xact_lock`, `pg_try_advisory_xact_lock`
- [Lock management settings](https://www.postgresql.org/docs/current/runtime-config-locks.html) (PostgreSQL docs): `deadlock_timeout`
- [Error codes](https://www.postgresql.org/docs/current/errcodes-appendix.html) (PostgreSQL docs): `40P01`, `55P03`, `23505`
- [RFC 9110, Conditional Requests](https://www.rfc-editor.org/rfc/rfc9110#name-conditional-requests): `If-Match`, ETags, `412 Precondition Failed`
- [RFC 6585](https://www.rfc-editor.org/rfc/rfc6585): `428 Precondition Required`
- [k6: per-vu-iterations executor](https://grafana.com/docs/k6/latest/using-k6/scenarios/executors/per-vu-iterations/), [k6-utils (uuidv4)](https://grafana.com/docs/k6/latest/javascript-api/jslib/utils/), [Migrating to k6 v2](https://grafana.com/docs/k6/latest/get-started/migrating-to-v2/), [k6 release notes](https://grafana.com/docs/k6/v2.3.x/release-notes/)
- [node-postgres: Transactions](https://node-postgres.com/features/transactions)
- [async-mutex](https://github.com/DirtyHairy/async-mutex): the in-process mutex used in the demo
- [pg-boss](https://github.com/timgit/pg-boss) and [Graphile Worker](https://worker.graphile.org/): production job queues for Node.js built on Postgres
