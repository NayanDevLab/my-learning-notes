# P2-03 · Transactions and isolation levels

| | |
|---|---|
| **Phase** | 2 · Data and databases |
| **Prerequisites** | P2-01 · Relational data modelling |
| **Leads to** | P2-04 · Concurrency control · P4-04 · Consistency models, CAP and PACELC · P4-07 · Consistency across services: outbox, CDC, sagas, CQRS |
| **Repo path** | `system-design/phase-2/p2-03-transactions-and-isolation-levels.md` |

**After this card you can:**

1. Say what each letter of ACID guarantees on Postgres, and, just as important, what it does not.
2. Name the five classic anomalies, reproduce each one in two `psql` sessions, and say which isolation level stops it.
3. Choose between a guarded single-statement `UPDATE`, `SELECT ... FOR UPDATE` and Serializable for a given money rule.
4. Write a transfer that runs at Serializable inside a safe `40001` retry loop, and explain its retry and throughput cost.
5. Spot long transactions in production with `pg_locks` and `pg_stat_activity`, and stop them with timeouts.

> **About the numbers in this guide.** Everything marked **Real output** was run while writing this guide on 23 Oct 2026, on a 2-vCPU Linux sandbox with PostgreSQL 16.15, Node.js 22.22, node-postgres 8.23.1 and drizzle-orm 0.45.4. The `psql` transcripts were recorded from real interactive sessions driven by a script. The 200-transfer benchmark ran on the same machine as Postgres, so compare directions, not decimals. Anything marked **Expected** was not run here.
>
> **Versions** (checked 23 Oct 2026): PostgreSQL 18.6 is the current release; 19 RC 1 came out on 15 Oct 2026; 14 reaches end of life on 12 Nov 2026. Isolation levels, MVCC and the error codes in this guide behave the same on 16, 17 and 18. `transaction_timeout` needs 17 or newer. Prisma ORM 7 is the supported line; Prisma ORM 8 is a release candidate with a different transaction API (Deep dive 7).

---

## 🧭 The concept in one minute

A **transaction** is a group of SQL statements that succeed or fail as one unit. A transfer debits Riya's wallet, credits Amit's wallet and writes two ledger entries. Either all four changes happen, or none do.

The **isolation level** decides what a transaction can see of other transactions running at the same time. A weaker level is faster and simpler, but allows certain concurrency bugs, called **anomalies**. A stronger level stops more anomalies, but makes some transactions fail with an error that you must retry.

**One line:** a transaction makes your changes all-or-nothing; the isolation level decides which race conditions you still have to handle yourself.

**Analogy.** A shared family account in a bank passbook. Two family members visit two branches at the same time. Each clerk looks at the passbook balance (₹1,000), each allows a ₹700 withdrawal, and each writes "₹300" as the new balance. The bank paid out ₹1,400 from ₹1,000, and the passbook looks fine. Each clerk did their own work correctly. The bug is in how the two jobs overlapped, and that overlap is what isolation is about.

**On the ledger platform.** That exact bug, a **lost update**, happened in this guide's `psql` lab at Postgres's default level: Amit's ₹1,000 wallet paid two ₹700 withdrawals and ended at ₹300. At Repeatable Read or Serializable, the second withdrawal failed with error `40001` instead. With a one-line change (a guarded `UPDATE`), it was rejected cleanly even at the default level.

---

## 🔥 The problem it solves

Here is the ledger API with code a new team often writes. Every number was measured in this guide.

1. **Read, check, write.** The app reads Amit's balance (₹1,000), checks it, and writes back balance minus ₹700. Two requests at once: **both succeed, the balance shows ₹300**, and ₹700 was paid out of thin air.
2. **A rule that spans rows.** Riya's daily limit is ₹10,000 across her two wallets, and she has used ₹4,000. Two ₹5,000 withdrawals from different wallets each check the total and see ₹4,000. **Both commit; she withdrew ₹14,000 today.** This happened at Read Committed **and** at Repeatable Read.
3. **The same bug at scale.** 200 concurrent ₹100 transfers from one wallet with a ₹10,000 limit: **119 succeeded**, ₹1,900 over the limit, in all three runs.
4. **A payment API call inside the transaction.** 20 withdrawals from one wallet, each with a 200 ms provider call while the row is locked: **4.1 seconds** for all 20, instead of 0.22 s with the call moved after `COMMIT`.
5. **A transaction left open.** One idle transaction stopped `VACUUM` from removing **10,000 dead row versions**; a 3-row table grew from 8 KB to 672 kB.
6. **`pool.query("BEGIN")` in node-postgres.** Amit's top-up returned "1 row updated" to the API, and was then **silently rolled back** by another request's `ROLLBACK`.

This card fixes all six: atomic statements, the right isolation level, a retry loop for `40001`, short transactions with no network calls, timeouts, and transactions on one client.

---

## 📚 Before you start

**Earlier cards used here:** P2-01 (the `wallets`, `wallet_balances`, `transfers` and `ledger_entries` tables, and why amounts are stored in paise), P1-03 (idempotency keys), P1-07 (Vitest and a throwaway test database), P1-08 (pino logging), P2-02 (indexes, `EXPLAIN`, and why `VACUUM` matters for index-only scans).

**Key terms**

| Term | Plain meaning |
|---|---|
| Transaction | Statements that commit together or roll back together. |
| Commit / rollback | Make all changes permanent and visible / throw all of them away. |
| Autocommit | Without `BEGIN`, each statement is its own transaction. |
| Concurrency | Two or more transactions running at overlapping times. |
| Anomaly | A wrong result that can only happen because transactions overlapped. |
| Isolation level | The rules for what one transaction can see of others while it runs. |
| Snapshot | A frozen view of the committed data at one moment. |
| MVCC | Multi-version concurrency control: an update writes a new row version, and old versions stay for readers who still need them. |
| Row lock | A lock on one row, taken by `UPDATE`, `DELETE` or `SELECT ... FOR UPDATE`; other writers to that row wait. |
| Dead tuple | An old row version that no transaction can see any more; `VACUUM` removes it. |
| SQLSTATE | A five-character error code from the database, such as `40001`. |
| `40001` | `serialization_failure`: "your transaction conflicted, run it again". |
| Invariant | A rule that must always be true, such as "balance never below zero". |
| Savepoint | A marker inside a transaction that you can roll back to without losing the whole transaction. |

---

## 🧠 How it works

### Mental model: everyone works on a photo, writers queue per row

- **Each transaction reads from a snapshot**, a photo of the committed data. At Read Committed, it takes a new photo for every statement. At Repeatable Read and Serializable, it takes one photo for the whole transaction.
- **An update never overwrites a row in place.** It writes a new version and marks the old one as replaced. Readers using an older photo still see the old version, so **readers never wait for writers**.
- **Two writers to the same row do queue.** The second one waits for the first to commit or roll back. What happens next depends on the isolation level: at Read Committed it continues on the new version; at Repeatable Read and Serializable it fails with `40001`.
- **Serializable adds one more check.** Postgres remembers what each transaction read. If a set of concurrent transactions could not have produced the same result when run one after another, it aborts one of them with `40001`.

React comparison: a snapshot is like a component reading state from a closure. The value is from the moment of the render, and it can be stale by the time an event handler uses it to "set state to value minus 700". That is exactly the lost update.

### Diagram: the life of a transaction

**Diagram: transaction states, as the psql prompt shows them**

```mermaid
stateDiagram-v2
  [*] --> Idle
  Idle --> InTransaction: BEGIN
  InTransaction --> InTransaction: statement succeeds
  InTransaction --> Failed: any error
  Failed --> InTransaction: ROLLBACK TO SAVEPOINT
  Failed --> Idle: ROLLBACK or COMMIT, nothing kept
  InTransaction --> Idle: COMMIT, all changes kept
  InTransaction --> Idle: ROLLBACK, nothing kept
```

**How to read this diagram.** `psql` shows these states in its prompt: `ledger=#` is Idle, `ledger=*#` is inside a transaction, and `ledger=!#` is a failed transaction. After any error, Postgres refuses every further statement until you roll back, either fully or to a savepoint. A `COMMIT` in the Failed state does not commit; it answers `ROLLBACK`. You will see all three prompts in this guide's transcripts.

---

## 🔬 Deep dive

> **Reading the transcripts.** Two (sometimes three) `psql` sessions, A and B, run against the same database; lines appear in the order things really happened. Lines starting with `--` are notes added for reading. Everything else is `psql`'s real input and output. The lab schema (wallets 1 and 2 are Riya's, wallet 3 is Amit's, amounts in paise) is in the Hands-on lab, step 1.

### 1. ACID in plain terms: what each letter guarantees, and what it does not

| Letter | What Postgres guarantees | What it does NOT guarantee |
|---|---|---|
| **A**tomicity | All statements in a transaction take effect, or none do, even if the server crashes halfway. | Anything outside this database: a Kafka message, an email, a payment provider call. Those need the outbox pattern (P4-07). |
| **C**onsistency | Constraints you declared (`CHECK`, `NOT NULL`, `UNIQUE`, foreign keys) hold at every commit. | Business rules you did not write as constraints, such as "total withdrawals today ≤ ₹10,000". Those depend on isolation and on your code. |
| **I**solation | Concurrent transactions do not see each other's uncommitted changes, and are protected from the anomalies of the chosen level. | Protection from anomalies your level allows. The default, Read Committed, allows lost updates and write skew. |
| **D**urability | Once `COMMIT` returns, the change survives a crash: it is in the write-ahead log (WAL) on disk. | Survival of a lost disk without replicas or backups, or with `synchronous_commit = off`. An asynchronous replica may also be a few milliseconds behind. |

**Atomicity, seen in psql.** Session A records a withdrawal, then its cashback event fails a unique constraint. The whole transaction is now failed; even the `COMMIT` comes back as `ROLLBACK`.

**Real output** (the first half of a savepoint session; the second half is in Deep dive 7)

```text
-- without a savepoint
(A) ledger=# BEGIN;
BEGIN
(A) ledger=*# INSERT INTO withdrawals (user_id, wallet_id, amount_minor) VALUES (7, 3, 20000);
INSERT 0 1
(A) ledger=*# INSERT INTO outbox_events (dedupe_key, payload) VALUES ('cashback:7:2026-10', '{"amount_minor": 5000}');
ERROR:  duplicate key value violates unique constraint "outbox_events_dedupe_key_key"
DETAIL:  Key (dedupe_key)=(cashback:7:2026-10) already exists.
(A) ledger=!# SELECT count(*) FROM withdrawals WHERE user_id = 7;
ERROR:  current transaction is aborted, commands ignored until end of transaction block
(A) ledger=!# COMMIT;
ROLLBACK
```

**What to notice**
- **The prompt changed from `=*#` to `=!#`** after the error: the transaction is failed, and Postgres ignores every statement until it ends.
- **`COMMIT` answered `ROLLBACK`.** The withdrawal that succeeded was thrown away too. That is atomicity: no half-done transfers. Deep dive 7 shows how a savepoint keeps the withdrawal.

### 2. Transaction boundaries: BEGIN, COMMIT, ROLLBACK, and keeping them short

**What it is.** `BEGIN` starts a transaction; `COMMIT` makes it permanent; `ROLLBACK` throws it away. Without `BEGIN`, Postgres runs each statement in its own transaction (autocommit), so a single `UPDATE` is always atomic by itself.

**Where the boundary goes.** Put the statements that must succeed together, and nothing else, inside one transaction:
- **Inside:** reads that decide what to write, the writes, and the checks on them.
- **Outside, before:** input validation, loading config, anything slow that does not need a consistent view.
- **Outside, after:** network calls (payment providers, email, SMS, other services), publishing events (through an outbox, P4-07), logging the result.

**Why short.** While a transaction is open it holds its row locks, one pool connection, and a snapshot that stops `VACUUM` from cleaning up (Deep dive 8). Every millisecond inside a transaction is a millisecond other writers to the same rows may wait.

**Minimal version:** `minimal/networkInsideTx.ts`. 20 withdrawals from the same wallet, each with a fake 200 ms payment-provider call, either inside the transaction (row lock held) or after `COMMIT`.

```ts
// minimal/networkInsideTx.ts: a 200 ms "payment provider call" inside vs outside the transaction.
// 20 withdrawals from the same wallet (Riya's main wallet in the psql lab tables).
import pg from "pg";
import { setTimeout as sleep } from "node:timers/promises";

const pool = new pg.Pool({ connectionString: "postgres://postgres:lab@127.0.0.1/ledger", max: 20 });
const fakeProviderCall = () => sleep(200); // stands in for an HTTPS call to a payment provider

async function withdraw(callInside: boolean): Promise<number> {
  const started = performance.now();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("UPDATE wallets SET balance_minor = balance_minor - 100 WHERE id = 1 AND balance_minor >= 100");
    if (callInside) await fakeProviderCall();      // the row lock is held during the call
    await client.query("COMMIT");
  } finally {
    client.release();
  }
  if (!callInside) await fakeProviderCall();       // after COMMIT (in real code: via the outbox, P4-07)
  return performance.now() - started;
}

for (const callInside of [true, false]) {
  const t0 = performance.now();
  const times = (await Promise.all(Array.from({ length: 20 }, () => withdraw(callInside)))).sort((a, b) => a - b);
  console.log(`provider call ${callInside ? "INSIDE " : "OUTSIDE"} the transaction: all 20 done in ${(performance.now() - t0).toFixed(0)} ms, ` +
    `fastest ${times[0]!.toFixed(0)} ms, slowest ${times[19]!.toFixed(0)} ms`);
}
await pool.end();
```

**Real output** (two runs)

```text
provider call INSIDE  the transaction: all 20 done in 4112 ms, fastest 258 ms, slowest 4109 ms
provider call OUTSIDE the transaction: all 20 done in 221 ms, fastest 205 ms, slowest 221 ms
provider call INSIDE  the transaction: all 20 done in 4114 ms, fastest 248 ms, slowest 4111 ms
provider call OUTSIDE the transaction: all 20 done in 223 ms, fastest 206 ms, slowest 222 ms
```

**What to notice**
- **Inside, the calls ran one after another:** 20 × 200 ms = 4 s, because each withdrawal held the wallet's row lock during its call. One wallet can then do at most 5 withdrawals a second (computed: 1,000 ms ÷ 200 ms).
- **Outside, the 20 calls overlapped:** 221 ms total. The database part took a few milliseconds.
- **It is not only speed.** If `COMMIT` fails after the provider already moved money, you cannot roll the provider back, and a retry would call it again. Card question 4 has the full answer.

### 3. The anomalies: dirty read, non-repeatable read, phantom read, lost update, write skew

Each anomaly is a wrong result that cannot happen when transactions run one at a time.

| Anomaly | What happens | Ledger example |
|---|---|---|
| **Dirty read** | You read another transaction's **uncommitted** change, which may later be rolled back. | A balance check sees ₹0 from a transfer that then fails. |
| **Non-repeatable read** | You read the same row twice in one transaction and get different values, because someone committed in between. | A statement job reads Amit's balance at the start and end, and the two do not match. |
| **Phantom read** | You run the same query twice and get **different rows**, because someone inserted or deleted matching rows. | A daily-limit check counts Riya's withdrawals; a second count finds a new one. |
| **Lost update** | Two transactions read the same row, each computes a new value from what it read, and the second write silently replaces the first. | Two ₹700 withdrawals from ₹1,000, both write ₹300. |
| **Write skew** | Two transactions read the **same set of rows**, each writes a **different** row based on what it read, and together they break a rule neither broke alone. | Two ₹5,000 withdrawals from two wallets, each sees ₹4,000 used of a ₹10,000 limit. |

**Dirty read: Postgres never allows it,** even when you ask for Read Uncommitted.

**Real output**

```text
(A) ledger=# BEGIN;
BEGIN
(A) ledger=*# UPDATE wallets SET balance_minor = 0 WHERE id = 3;
UPDATE 1
(B) ledger=# BEGIN ISOLATION LEVEL READ UNCOMMITTED;
BEGIN
(B) ledger=*# SELECT balance_minor FROM wallets WHERE id = 3;
 balance_minor
---------------
        100000
(1 row)
(A) ledger=*# ROLLBACK;
ROLLBACK
(B) ledger=*# COMMIT;
COMMIT
```

**Non-repeatable read at Read Committed:** A reads Amit's balance twice and gets two answers.

**Real output**

```text
(A) ledger=# BEGIN ISOLATION LEVEL READ COMMITTED;
BEGIN
(A) ledger=*# SELECT balance_minor FROM wallets WHERE id = 3;
 balance_minor
---------------
        100000
(1 row)
(B) ledger=# UPDATE wallets SET balance_minor = balance_minor - 70000 WHERE id = 3;
UPDATE 1
(A) ledger=*# SELECT balance_minor FROM wallets WHERE id = 3;
 balance_minor
---------------
         30000
(1 row)
(A) ledger=*# COMMIT;
COMMIT
```

At Repeatable Read, the same steps returned `100000` both times (**Real output**): the transaction keeps its first snapshot.

**Phantom read at Read Committed:** the count of Riya's withdrawals today changes inside one transaction.

**Real output**

```text
(A) ledger=# BEGIN ISOLATION LEVEL READ COMMITTED;
BEGIN
(A) ledger=*# SELECT count(*), sum(amount_minor) FROM withdrawals WHERE user_id = 42 AND created_on = current_date;
 count |  sum
-------+--------
     1 | 400000
(1 row)
(B) ledger=# INSERT INTO withdrawals (user_id, wallet_id, amount_minor) VALUES (42, 2, 100000);
INSERT 0 1
(A) ledger=*# SELECT count(*), sum(amount_minor) FROM withdrawals WHERE user_id = 42 AND created_on = current_date;
 count |  sum
-------+--------
     2 | 500000
(1 row)
(A) ledger=*# COMMIT;
COMMIT
```

At Repeatable Read, the second query still returned `1 | 400000` (**Real output**). Postgres's Repeatable Read prevents phantoms, which is stronger than the SQL standard requires.

**Lost update and write skew** are the two that move money. Their full transcripts are in the Hands-on lab, steps 1 and 2. Here are their timelines.

**Diagram: a lost update (two ₹700 withdrawals from Amit's ₹1,000)**

```mermaid
sequenceDiagram
  participant A as Session A
  participant DB as Postgres
  participant B as Session B
  A->>DB: 1. BEGIN, read balance 100000
  B->>DB: 2. BEGIN, read balance 100000
  Note over A,B: both apps compute 100000 minus 70000 = 30000
  A->>DB: 3. UPDATE balance = 30000, row now locked
  B->>DB: 4. UPDATE balance = 30000, waits for the lock
  A->>DB: 5. COMMIT
  DB-->>B: 6. Read Committed: UPDATE 1. RR and Serializable: ERROR 40001
  B->>DB: 7. COMMIT
  Note over DB: RC: balance 30000, both paid
```

**How to read this diagram.** Time runs down. Both sessions read ₹1,000 before either writes (steps 1 and 2). Each app computes the new balance from its own stale read and writes a fixed number (3 and 4). B's write waits for A's row lock, but at Read Committed it then simply overwrites A's value (6), and A's withdrawal disappears from the balance. At Repeatable Read and Serializable, step 6 is an error instead, because B tried to change a row that changed after its snapshot.

**Diagram: a write skew (two ₹5,000 withdrawals against Riya's ₹10,000 daily limit)**

```mermaid
sequenceDiagram
  participant A as Session A, main wallet
  participant DB as Postgres
  participant B as Session B, savings wallet
  A->>DB: 1. BEGIN, sum of today = 400000
  B->>DB: 2. BEGIN, sum of today = 400000
  Note over A,B: both check 400000 plus 500000 against 1000000, OK
  A->>DB: 3. INSERT withdrawal 500000, wallet 1
  B->>DB: 4. INSERT withdrawal 500000, wallet 2
  A->>DB: 5. COMMIT
  B->>DB: 6. COMMIT
  Note over DB: RC and RR: 1400000 today. SER: 40001 at step 6
```

**How to read this diagram.** The two sessions never touch the same row: A inserts one withdrawal and B inserts another (3 and 4). So there is no lock to wait for, and Repeatable Read's "row changed" check never fires. The bug is in the **read** (1 and 2): each decision was based on a total that the other transaction was about to change. Only Serializable notices this read-write dependency, and it fails B's `COMMIT` (6).

### 4. Postgres isolation levels: Read Committed, Repeatable Read, Serializable

**How to choose a level.** Per transaction, or as a default:

```sql
BEGIN ISOLATION LEVEL SERIALIZABLE;                       -- this transaction only
BEGIN; SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;   -- same, must come before the first query
ALTER ROLE ledger_api SET default_transaction_isolation = 'serializable';  -- default for one role
```

Postgres accepts all four standard names but implements three: **Read Uncommitted behaves exactly like Read Committed** (the docs say so, and the dirty-read transcript above shows it).

**Read Committed (the default).**
- Every **statement** gets a fresh snapshot of what is committed at that moment. Two `SELECT`s in one transaction can disagree.
- When an `UPDATE` or `DELETE` finds a row locked by another writer, it **waits**. If that writer commits, the statement re-reads the **newest** version of the row and checks its `WHERE` clause again. That re-check is why a guarded `UPDATE ... WHERE balance_minor >= 70000` is safe here (Deep dive 9), and why "read in one statement, write a computed value in another" is not.
- Never fails with `40001`. Cheap and predictable.

**Repeatable Read (snapshot isolation).**
- One snapshot for the whole transaction, taken at its **first statement** (not at `BEGIN`). Every read sees the same data, so no non-repeatable reads and no phantoms.
- **First updater wins.** If you try to update or delete a row that another transaction changed and committed after your snapshot, you get `ERROR: could not serialize access due to concurrent update` (SQLSTATE `40001`). That stops lost updates.
- **Write skew still happens**, because the two transactions write different rows; nothing collides.

**Serializable (SSI, Serializable Snapshot Isolation).**
- Repeatable Read, plus tracking of **what each transaction read**. Postgres records reads as `SIReadLock` entries in `pg_locks`. They never block anyone; they only remember.
- When it finds a pattern of read-write dependencies that could not happen in any one-at-a-time order, it aborts one transaction with `ERROR: could not serialize access due to read/write dependencies among transactions` (`40001`).
- The guarantee: if every transaction runs at Serializable and commits, the result equals **some** serial order. Your application code no longer needs to reason about interleavings, only to retry.

**The anomaly table (must-include).** Two columns of truth: what the SQL standard allows, and what this guide reproduced on Postgres 16.15 with two real `psql` sessions.

| Anomaly | Read Uncommitted (Postgres runs it as RC) | Read Committed (default) | Repeatable Read | Serializable |
|---|---|---|---|---|
| Dirty read | **No**: standard allows it, Postgres does not | No | No | No |
| Non-repeatable read | **Yes**, reproduced | **Yes**, reproduced | No | No |
| Phantom read | **Yes**, reproduced | **Yes**, reproduced | **No**: standard allows it, Postgres does not | No |
| Lost update (read-check-write) | **Yes**: ₹1,400 paid from ₹1,000 | **Yes**: ₹1,400 paid from ₹1,000 | No: `40001` "concurrent update" | No: `40001` "concurrent update" |
| Write skew | **Yes**: ₹14,000 against a ₹10,000 limit | **Yes**: ₹14,000 | **Yes**: ₹14,000 | No: `40001` "read/write dependencies" |
| Can fail with `40001`, so needs a retry loop | No | No | Yes | Yes |

**Real output** (the script ran each scenario at each level, from a fresh copy of the data each time; `anomalies.py`)

```text
anomaly              RU                   RC                   RR                   SER
dirty_read           no                   no                   no                   no
non_repeatable_read  YES                  YES                  no                   no
phantom_read         YES                  YES                  no                   no
lost_update          YES: both committed  YES: both committed  no: ERROR 40001      no: ERROR 40001
write_skew           YES: 1400000 today   YES: 1400000 today   YES: 1400000 today   no: ERROR 40001
```

(`YES` means the anomaly happened. The full lost-update and write-skew sessions are in the lab, steps 1 and 2.)

**What Serializable remembers, seen in `pg_locks`.** One transfer at Serializable (the lab's `transferOnce`), stopped just before `COMMIT`, then:

```sql
SELECT locktype, relation::regclass, page, tuple FROM pg_locks
WHERE mode = 'SIReadLock' AND pid = pg_backend_pid() ORDER BY 2, 1, 3;
```

**Real output**, on production-like data (1 lakh wallets, 2 lakh transfers, statistics up to date):

```text
 locktype |           relation            | page | tuple
----------+-------------------------------+------+-------
 tuple    | wallets                       | 1005 |   119
 page     | wallets_pkey                  |  385 |
 page     | wallet_balances_pkey          |  222 |
 page     | wallet_balances_pkey          |  385 |
 page     | transfers_idempotency_key_key |  147 |
 page     | transfers_by_source_day       |  778 |
```

**Real output**, the same transfer on tiny tables (21 wallets, 100 transfers, like a fresh dev or CI database), where the planner prefers sequential scans:

```text
 locktype |    relation     | page | tuple
----------+-----------------+------+-------
 page     | wallets         |    0 |
 page     | wallets_pkey    |    1 |
 relation | wallet_balances |      |
 relation | transfers       |      |
```

**What to notice**
- **On real data, the reads are remembered per index page or per row.** Another transaction conflicts only if it writes into one of those few pages: small chance.
- **On tiny tables, the planner chose sequential scans, and a sequential scan is remembered as the whole table** (`relation`). Every concurrent transfer then "conflicts" with every other. The Break-it section measured the cost: 670 to 1,050 retries for 200 transfers, against 9 to 15 on real data.
- **Reads through an index are remembered per index page, not per key**, so Serializable sometimes aborts transactions that did not really conflict (false positives). That is the price of not blocking. Retrying makes them harmless; keeping them rare is about indexes and short transactions.

**When to use which**
- **Read Committed:** the default for most work. Make each rule safe with a single atomic statement, a constraint, or an explicit row lock.
- **Repeatable Read:** consistent multi-query reads, such as a statement export or a reconciliation report. Use `READ ONLY`.
- **Serializable:** rules that span several rows or a sum, where no single row is a natural lock (daily limits across wallets, "at most 4 tickets per user", "a doctor must stay on call"). Pay for it with retries.

### 5. MVCC: row versions, snapshots, VACUUM and dead tuples

**What it is.** Every row version carries hidden columns. `xmin` is the ID of the transaction that created it; `xmax` is the ID of the transaction that deleted or replaced it (0 if none); `ctid` is its physical address (page, item). An `UPDATE` creates a new version and sets `xmax` on the old one. A snapshot decides which versions you see: those created by transactions that had committed when the snapshot was taken, and not yet replaced by them.

**Real output**: A holds a Repeatable Read snapshot while B updates Amit's balance.

```text
(A) ledger=# SELECT ctid, xmin, xmax, balance_minor FROM wallets WHERE id = 3;
 ctid  | xmin | xmax | balance_minor
-------+------+------+---------------
 (0,3) |  949 |    0 |        100000
(1 row)
(A) ledger=# BEGIN ISOLATION LEVEL REPEATABLE READ;
BEGIN
(A) ledger=*# SELECT ctid, xmin, xmax, balance_minor FROM wallets WHERE id = 3;
 ctid  | xmin | xmax | balance_minor
-------+------+------+---------------
 (0,3) |  949 |    0 |        100000
(1 row)
(B) ledger=# UPDATE wallets SET balance_minor = balance_minor - 10000 WHERE id = 3 RETURNING ctid, xmin, xmax, balance_minor;
 ctid  | xmin | xmax | balance_minor
-------+------+------+---------------
 (0,4) |  951 |    0 |         90000
(1 row)

UPDATE 1
(A) ledger=*# SELECT ctid, xmin, xmax, balance_minor FROM wallets WHERE id = 3;
 ctid  | xmin | xmax | balance_minor
-------+------+------+---------------
 (0,3) |  949 |  951 |        100000
(1 row)
(A) ledger=*# COMMIT;
COMMIT
(A) ledger=# SELECT ctid, xmin, xmax, balance_minor FROM wallets WHERE id = 3;
 ctid  | xmin | xmax | balance_minor
-------+------+------+---------------
 (0,4) |  951 |    0 |         90000
(1 row)
```

**What to notice**
- **B's update did not wait for A's open transaction:** readers do not block writers, and writers do not block readers.
- **The update wrote a new version at `(0,4)`** created by transaction 951. The old version `(0,3)` is still there, now with `xmax = 951`.
- **A kept seeing `(0,3)`** because its snapshot was taken before 951 committed. After A committed, a new snapshot showed `(0,4)`.

**Diagram: two versions of Amit's wallet row**

```mermaid
flowchart TD
  V1["Old version (0,3)<br/>xmin 949<br/>xmax 951<br/>balance 100000"]
  V2["New version (0,4)<br/>xmin 951<br/>xmax 0<br/>balance 90000"]
  S1["Session A's snapshot<br/>taken before 951 committed"]
  S2["Any snapshot taken<br/>after 951 committed"]
  VAC["VACUUM removes (0,3)<br/>once no snapshot needs it"]
  V1 -->|"replaced by xid 951"| V2
  S1 -.->|"sees"| V1
  S2 -.->|"sees"| V2
  V1 --> VAC
```

**How to read this diagram.** The table holds both versions at once. Which one you see depends only on your snapshot. The old version becomes a **dead tuple** when no running transaction can still see it, and only then can `VACUUM` (usually autovacuum, in the background) reclaim its space. A single long-running transaction keeps every version since it started "possibly visible", so nothing can be removed. Lab step 4 measures exactly that.

**Trade-off.** MVCC gives non-blocking reads, which is why a Postgres API can run heavy reports next to transfers. The cost is cleanup: every update leaves a dead version, so `VACUUM` must keep up, and long transactions stop it. Updates that change no indexed column and fit on the same page are **HOT** (heap-only tuple) updates, which are cheaper to clean; that is one reason `wallet_balances` has no extra indexes.

### 6. Serialization failures: SQLSTATE 40001 and a safe retry loop

**What it is.** At Repeatable Read and Serializable, Postgres prevents anomalies by **aborting** one of the conflicting transactions with SQLSTATE `40001` (`serialization_failure`). The two messages you saw:

```text
ERROR:  could not serialize access due to concurrent update
ERROR:  could not serialize access due to read/write dependencies among transactions
DETAIL:  Reason code: Canceled on identification as a pivot, during commit attempt.
HINT:  The transaction might succeed if retried.
```

A `40001` is not a bug. It means "if I let you commit, the result would not match any one-at-a-time order; run again on fresh data". It can arrive on any statement, **including `COMMIT`**.

**The rules for a safe retry** (from the Postgres docs, section 13.5, plus practice):
1. **Retry the whole transaction from `BEGIN`**, including every read and every decision. Re-running only the failed statement would reuse the stale reads that caused the conflict.
2. **Retry `40001` always; also retry `40P01`** (`deadlock_detected`). Do not blindly retry anything else: a `23505` unique violation is sometimes a disguised conflict, but often a real duplicate. In this design, a duplicate idempotency key is caught by the lookup at the start of the next attempt.
3. **Back off with jitter.** Wait a random time that grows with each attempt, so the transactions that just collided do not collide again.
4. **Cap the attempts.** Under heavy contention a transaction can lose again and again. After the cap, return `503` with `Retry-After`; the client retries with the **same idempotency key**.
5. **No side effects inside the retried function.** No emails, no HTTP calls, no in-memory counters that would double-count on a re-run.

**Minimal version:** `minimal/serializableRetry.ts`. The write-skew race from Deep dive 3, now in Node.js at Serializable, with a plain retry loop.

```ts
// minimal/serializableRetry.ts: two withdrawals race against one daily limit, at SERIALIZABLE, with a retry loop.
// Uses the psql lab tables (wallets, withdrawals). Run: npx tsx minimal/serializableRetry.ts
import pg from "pg";

const pool = new pg.Pool({ connectionString: "postgres://postgres:lab@127.0.0.1/ledger", max: 2 });
const LIMIT = 1_000_000, AMOUNT = 500_000; // ₹10,000 limit, ₹5,000 each

async function withdraw(name: string, walletId: number): Promise<string> {
  for (let attempt = 1; attempt <= 5; attempt++) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      const { rows } = await client.query("SELECT coalesce(sum(amount_minor), 0)::int AS used FROM withdrawals WHERE user_id = 42 AND created_on = current_date");
      await new Promise((r) => setTimeout(r, 50)); // widen the race window, like a slow app server
      if (rows[0].used + AMOUNT > LIMIT) { await client.query("ROLLBACK"); return `${name}: rejected on attempt ${attempt} (used ${rows[0].used})`; }
      await client.query("INSERT INTO withdrawals (user_id, wallet_id, amount_minor) VALUES (42, $1, $2)", [walletId, AMOUNT]);
      await client.query("COMMIT");
      return `${name}: committed on attempt ${attempt}`;
    } catch (err) {
      await client.query("ROLLBACK");
      if ((err as { code?: string }).code !== "40001") throw err;
      console.log(`${name}: attempt ${attempt} failed with 40001, retrying the whole transaction`);
    } finally {
      client.release();
    }
  }
  return `${name}: gave up`;
}

console.log(await Promise.all([withdraw("A", 1), withdraw("B", 2)]));
const { rows } = await pool.query("SELECT sum(amount_minor)::int AS total FROM withdrawals WHERE user_id = 42 AND created_on = current_date");
console.log(`withdrawn today: ${rows[0].total} (limit ${LIMIT})`);
await pool.end();
```

**Real output**

```text
A: attempt 1 failed with 40001, retrying the whole transaction
[
  'A: rejected on attempt 2 (used 900000)',
  'B: committed on attempt 1'
]
withdrawn today: 900000 (limit 1000000)
```

**What to notice**
- **A's first attempt read ₹4,000 used**, like before, but Postgres refused to let both commit.
- **A's second attempt re-read the total (₹9,000)** and its own logic rejected the withdrawal. The retry did not "force" A through; it made A decide again on true data.
- **The total stayed within the limit:** ₹9,000 of ₹10,000.

**Product version:** `src/lib/db/retryTransaction.ts`, the retry wrapper the transfer service uses (must-include).

```ts
// src/lib/db/retryTransaction.ts: re-run a WHOLE transaction when Postgres says "try again".
import { setTimeout as sleep } from "node:timers/promises";

// 40001 serialization_failure, 40P01 deadlock_detected: transient, safe to retry from the start.
const RETRYABLE_SQLSTATES = new Set(["40001", "40P01"]);

export interface RetryOptions {
  maxAttempts: number;   // including the first try
  baseDelayMs: number;
  maxDelayMs: number;
  onRetry?: (info: { attempt: number; sqlstate: string; delayMs: number }) => void;
}

export class TransactionRetriesExhaustedError extends Error {
  override name = "TransactionRetriesExhaustedError";
  constructor(readonly attempts: number, options: { cause: unknown }) {
    super(`transaction still conflicting after ${attempts} attempts`, options);
  }
}

export function sqlstateOf(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null || !("code" in err)) return undefined;
  return typeof err.code === "string" ? err.code : undefined;
}

export async function withRetry<T>(runTransaction: () => Promise<T>, options: RetryOptions): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await runTransaction();
    } catch (err) {
      const sqlstate = sqlstateOf(err);
      if (sqlstate === undefined || !RETRYABLE_SQLSTATES.has(sqlstate)) throw err; // business errors, bugs, timeouts
      if (attempt >= options.maxAttempts) throw new TransactionRetriesExhaustedError(attempt, { cause: err });
      // Exponential backoff with "full jitter": a random wait up to the cap, so the
      // transactions that just collided do not all come back at the same moment.
      const capMs = Math.min(options.maxDelayMs, options.baseDelayMs * 2 ** (attempt - 1));
      const delayMs = Math.random() * capMs;
      options.onRetry?.({ attempt, sqlstate, delayMs });
      await sleep(delayMs);
    }
  }
}
```

**What to notice**
- **`runTransaction` is a function that runs a complete transaction**, `BEGIN` to `COMMIT`. The wrapper calls it again; it never resumes halfway.
- **Only `40001` and `40P01` are retried.** Business errors (insufficient funds, limit exceeded), constraint violations, `lock_timeout` (`55P03`) and `statement_timeout` (`57014`) go straight to the caller. The unit test in the lab checks exactly this.
- **Full jitter:** the wait is random between 0 and a cap that doubles each attempt (5, 10, 20 ... up to 250 ms here).
- **The typed `TransactionRetriesExhaustedError` keeps the last database error as `cause`**, so logs show why it gave up, and the route can map it to `503`.

**When not to use Serializable plus retries.** When one row is touched by almost every transaction (a merchant's or a hot wallet's balance). Then most attempts conflict: in this guide's one-wallet benchmark, that was about **6 retries per transfer**. A row lock (`SELECT ... FOR UPDATE`, P2-04) makes them wait in line instead, with zero retries.

### 7. Transactions in Node.js: node-postgres, Drizzle, Prisma, and savepoints

**node-postgres: one client for the whole transaction.** A `pg.Pool` holds many connections. A transaction lives on **one connection**, so you must `pool.connect()` a client, run every statement on it, and release it at the end. `pool.query()` picks any free connection for each call.

**The bug, measured:** `minimal/poolQueryBug.ts`. Riya's request sends `BEGIN` with `pool.query()`, then waits 50 ms for a fraud check. Amit's top-up runs meanwhile, also with `pool.query()`.

```ts
// minimal/poolQueryBug.ts: the classic node-postgres mistake. "BEGIN" sent with pool.query() leaves a
// pooled connection inside a transaction, and the NEXT request that borrows it writes inside it.
import pg from "pg";
import { setTimeout as sleep } from "node:timers/promises";

const pool = new pg.Pool({ connectionString: "postgres://postgres:lab@127.0.0.1/ledger", max: 4 });

async function riyaTransferWrongWay(): Promise<void> {
  await pool.query("BEGIN");        // runs on some connection, which goes back to the pool still in a transaction
  await sleep(50);                  // e.g. waiting for a fraud check
  await pool.query("ROLLBACK");     // fraud check failed: "undo my transaction"
}

async function amitTopUp(): Promise<number | null> {
  await sleep(10);                  // arrives while Riya's request is waiting
  const result = await pool.query("UPDATE wallets SET balance_minor = balance_minor + 50000 WHERE id = 3");
  return result.rowCount;           // 1: the API tells Amit his top-up worked
}

const balance = async () => (await pool.query("SELECT balance_minor FROM wallets WHERE id = 3")).rows[0].balance_minor;
console.log(`Amit's balance before: ${await balance()}`);
const [, rowCount] = await Promise.all([riyaTransferWrongWay(), amitTopUp()]);
console.log(`Amit's top-up returned rowCount ${rowCount}`);
console.log(`Amit's balance after:  ${await balance()}`);
await pool.end();
```

**Real output** (two runs, same result)

```text
Amit's balance before: 100000
Amit's top-up returned rowCount 1
Amit's balance after:  100000
```

**What to notice**
- **Riya's `BEGIN` left a pooled connection inside a transaction.** Amit's top-up borrowed that same connection, so his `UPDATE` ran inside Riya's transaction.
- **Riya's `ROLLBACK` then undid Amit's top-up.** The API had already told Amit it worked. Nothing failed, nothing was logged.
- **The node-postgres docs say it plainly:** use the same client for every statement of a transaction, and never use `pool.query` for transactions.

**Product version:** `src/lib/db/withTransaction.ts`

```ts
// src/lib/db/withTransaction.ts: BEGIN, run the work on ONE client, COMMIT or ROLLBACK, always release.
import type { Pool, PoolClient } from "pg";

export type IsolationLevel = "READ COMMITTED" | "REPEATABLE READ" | "SERIALIZABLE";

export interface TransactionOptions {
  isolationLevel: IsolationLevel;
  readOnly?: boolean;
}

export async function withTransaction<T>(
  pool: Pool,
  options: TransactionOptions,
  work: (tx: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let destroyConnection = false;
  try {
    // The level is a typed constant, never user input, so building the string is safe.
    await client.query(`BEGIN ISOLATION LEVEL ${options.isolationLevel}${options.readOnly ? " READ ONLY" : ""}`);
    const result = await work(client);
    await client.query("COMMIT"); // a Serializable conflict can surface here, as 40001
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      destroyConnection = true; // the connection is in an unknown state: do not hand it to the next request
    }
    throw err;
  } finally {
    client.release(destroyConnection);
  }
}
```

**What to notice**
- **One `client` from `pool.connect()`** carries `BEGIN`, the work and `COMMIT`; the `work` callback receives it as `tx`, so every repository call runs inside the transaction.
- **The `finally` always releases the client.** If even `ROLLBACK` failed, `release(true)` destroys the connection instead of returning a broken one to the pool.
- **`COMMIT` can throw** (`40001` at Serializable). The catch rolls back, and the error reaches `withRetry`.

**Drizzle (0.45).** `db.transaction(async (tx) => { ... }, config)` with `isolationLevel` (`"read uncommitted" | "read committed" | "repeatable read" | "serializable"`), `accessMode` (`"read only" | "read write"`) and `deferrable`. Calling `tx.transaction(...)` inside creates a **savepoint**; `tx.rollback()` throws to roll back. Drizzle does not retry `40001` for you: wrap the call in `withRetry`.

**Minimal version:** `minimal/drizzleSavepoint.ts`. A withdrawal plus an optional cashback event; the cashback fails, the withdrawal still commits.

```ts
// minimal/drizzleSavepoint.ts: a nested Drizzle transaction is a SAVEPOINT. The inner failure is undone,
// the outer transaction still commits.
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { bigint, integer, jsonb, pgTable, text } from "drizzle-orm/pg-core";

const withdrawals = pgTable("withdrawals", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  userId: bigint("user_id", { mode: "number" }).notNull(),
  walletId: bigint("wallet_id", { mode: "number" }).notNull(),
  amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
});
const outboxEvents = pgTable("outbox_events", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  dedupeKey: text("dedupe_key").notNull().unique(),
  payload: jsonb("payload").notNull(),
});

const pool = new pg.Pool({ connectionString: "postgres://postgres:lab@127.0.0.1/ledger" });
const db = drizzle(pool);

await db.transaction(async (tx) => {
  await tx.insert(withdrawals).values({ userId: 7, walletId: 3, amountMinor: 20_000 });
  try {
    await tx.transaction(async (inner) => {          // SAVEPOINT
      await inner.insert(outboxEvents).values({ dedupeKey: "cashback:7:2026-10", payload: { amountMinor: 5_000 } });
    });
  } catch (err) {
    console.log("cashback skipped:", (err as { cause?: { message?: string } }).cause?.message ?? String(err));
  }
}, { isolationLevel: "read committed" });

const { rows } = await pool.query("SELECT count(*)::int AS n FROM withdrawals WHERE user_id = 7");
console.log(`withdrawals for user 7 after commit: ${rows[0].n}`);
await pool.end();
```

**Real output**, plus the SQL Drizzle actually sent (from the Postgres server log, with `log_statement = 'all'` on the lab database)

```text
cashback skipped: duplicate key value violates unique constraint "outbox_events_dedupe_key_key"
withdrawals for user 7 after commit: 1
```

```text
statement: begin isolation level read committed
execute <unnamed>: insert into "withdrawals" ("id", "user_id", "wallet_id", "amount_minor") values (default, $1, $2, $3)
statement: savepoint sp1
execute <unnamed>: insert into "outbox_events" ("id", "dedupe_key", "payload") values (default, $1, $2)
duplicate key value violates unique constraint "outbox_events_dedupe_key_key"
statement: rollback to savepoint sp1
statement: commit
```

**The same thing in psql** (the second half of the session from Deep dive 1). **Real output**

```text
-- with a savepoint
(A) ledger=# BEGIN;
BEGIN
(A) ledger=*# INSERT INTO withdrawals (user_id, wallet_id, amount_minor) VALUES (7, 3, 20000);
INSERT 0 1
(A) ledger=*# SAVEPOINT cashback;
SAVEPOINT
(A) ledger=*# INSERT INTO outbox_events (dedupe_key, payload) VALUES ('cashback:7:2026-10', '{"amount_minor": 5000}');
ERROR:  duplicate key value violates unique constraint "outbox_events_dedupe_key_key"
DETAIL:  Key (dedupe_key)=(cashback:7:2026-10) already exists.
(A) ledger=!# ROLLBACK TO SAVEPOINT cashback;
ROLLBACK
(A) ledger=*# COMMIT;
COMMIT
(A) ledger=# SELECT count(*) FROM withdrawals WHERE user_id = 7;
 count
-------
     1
(1 row)
```

**When to use savepoints, and when not.** Use them when part of a transaction is optional and may fail, and you want to keep the rest. For "insert if not already there", `INSERT ... ON CONFLICT DO NOTHING` is simpler and cheaper. A savepoint does **not** help with `40001`: a serialization failure means the whole transaction's reads are stale, so the whole transaction must be retried.

**Prisma.** Prisma ORM 7 (the supported line) has interactive transactions: `prisma.$transaction(async (tx) => { ... }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 2000, timeout: 5000 })`. `maxWait` (default 2,000 ms) is how long to wait for a connection; `timeout` (default 5,000 ms) is the longest the transaction may run. Write conflicts and deadlocks surface as Prisma error `P2034`, and the docs show a retry loop around `$transaction`. Prisma 7's docs do not describe savepoints for nested interactive transactions.

**Prisma ORM 8 (release candidate, Oct 2026).** `$transaction` is replaced by `db.transaction(async (tx) => ...)`, with **no** `isolationLevel`, `timeout` or `maxWait` options: you run `SET TRANSACTION ISOLATION LEVEL SERIALIZABLE` yourself as the first statement, and set `idle_in_transaction_session_timeout` (or `transaction_timeout` on Postgres 17+) on the connection. A `db.transaction` called inside another **does not nest**: it is a separate transaction. Its docs show a retry helper for `40001` and `40P01`. Check the release status before you start a new project on it.

| | node-postgres | Drizzle 0.45 | Prisma 7 | Prisma 8 RC |
|---|---|---|---|---|
| Start a transaction | `pool.connect()`, then `BEGIN` on that client | `db.transaction(fn, config)` | `prisma.$transaction(fn, options)` | `db.transaction(fn)` |
| Isolation level | In the `BEGIN` statement | `config.isolationLevel` | `options.isolationLevel` | Raw `SET TRANSACTION` first |
| Nested call | Your own `SAVEPOINT` | Savepoint (`sp1`, `sp2`...) | Not documented | Separate transaction |
| Time limits | Pool options: `statement_timeout`, `lock_timeout`, `idle_in_transaction_session_timeout` | Driver or server settings | `maxWait`, `timeout` | Server settings |
| Retries `40001` for you | No | No | No (`P2034`) | No |

### 8. Long transactions: held locks, table bloat, replication lag

A transaction that stays open, even an idle one, costs you three ways. Lab step 4 shows all of them with real output; here is the summary.

**1. It holds its locks.** Every row it updated stays locked until it ends. In the lab, session B waited on one row for 5 seconds until its `lock_timeout` fired: `ERROR: canceling statement due to lock timeout`. `pg_stat_activity` showed the culprit as `idle in transaction`, and `pg_blocking_pids()` pointed straight at it.

**2. It stops cleanup (bloat).** Its snapshot might still need old row versions, so `VACUUM` cannot remove any version newer than the oldest open transaction. In the lab, 10,000 ordinary updates on **another** row left **10,000 dead tuples "not yet removable"**, and the 3-row table grew from 8 KB to 672 kB. Once the transaction committed, `VACUUM` removed 10,001 dead versions. Bloat makes scans and index lookups slower, and the space is reused, not returned to the OS.

**3. It hurts replicas (replication lag).** This was not run here (no replica in the sandbox); this is the expected behaviour:
- **Long queries on a replica** conflict with cleanup arriving from the primary. Postgres either cancels the replica query after `max_standby_streaming_delay` (30 s by default), or, with `hot_standby_feedback = on`, tells the primary to keep old versions, which brings back problem 2 on the primary.
- **One huge transaction** (a backfill that updates 50 lakh rows at once) produces a burst of WAL that replicas must replay, so read replicas fall behind and serve stale balances (P4-02, P4-04).

**Time limits.** Set them at the connection (the lab's `pool.ts` does), so a forgotten transaction cannot hurt the database for long:

| Setting | What it stops | Lab pool value | Default |
|---|---|---|---|
| `statement_timeout` | Any single statement running too long | 5 s | 0 (off) |
| `lock_timeout` | Waiting too long for a lock | 2 s | 0 (off) |
| `idle_in_transaction_session_timeout` | A session sitting idle inside an open transaction | 10 s | 0 (off) |
| `transaction_timeout` (Postgres 17+) | A whole transaction, busy or idle, running too long | not set (lab is on 16) | 0 (off) |

**Real output**: the server ends a forgotten transaction.

```text
(D) ledger=# SET idle_in_transaction_session_timeout = '2s';
SET
(D) ledger=# BEGIN;
BEGIN
(D) ledger=*# UPDATE wallets SET balance_minor = balance_minor - 100 WHERE id = 1;
UPDATE 1
-- the app forgets this transaction for 3 seconds
(D) ledger=*# COMMIT;
FATAL:  terminating connection due to idle-in-transaction timeout
SSL connection has been closed unexpectedly
The connection to the server was lost. Attempting reset: Succeeded.
SSL connection (protocol: TLSv1.3, cipher: TLS_AES_256_GCM_SHA384, compression: off)
(D) ledger=# SELECT balance_minor FROM wallets WHERE id = 1;
 balance_minor
---------------
        599900
(1 row)
```

**What to notice**
- **The server closed the connection** and rolled the transaction back. D's `-100` was not kept: 599900 is from an earlier, committed update in lab step 4.
- **The app sees a connection error, not a business error.** node-postgres removes that client from the pool, and the request fails. That is the right trade: one failed request instead of a locked row and a growing table.

### 9. Single-statement atomicity: the guarded UPDATE

**What it is.** One SQL statement is always atomic, and at Read Committed an `UPDATE` re-checks its `WHERE` clause on the newest committed version of the row after waiting for a lock. So putting the check **inside** the statement makes the check and the change one indivisible step:

```sql
UPDATE wallets SET balance_minor = balance_minor - $1
WHERE id = $2 AND balance_minor >= $1
RETURNING *;
```

`RETURNING` gives back the new row. Zero rows means "not enough money", and nothing changed.

**Real output**: two ₹700 withdrawals from Amit's ₹1,000, both at Read Committed.

```text
(A) ledger=# BEGIN ISOLATION LEVEL READ COMMITTED;
BEGIN
(B) ledger=# BEGIN ISOLATION LEVEL READ COMMITTED;
BEGIN
(A) ledger=*# UPDATE wallets SET balance_minor = balance_minor - 70000 WHERE id = 3 AND balance_minor >= 70000 RETURNING balance_minor;
 balance_minor
---------------
         30000
(1 row)

UPDATE 1
(B) ledger=*# UPDATE wallets SET balance_minor = balance_minor - 70000 WHERE id = 3 AND balance_minor >= 70000 RETURNING balance_minor;
-- (B) is waiting...
(A) ledger=*# COMMIT;
COMMIT
-- (B) continues:
 balance_minor
---------------
(0 rows)

UPDATE 0
(B) ledger=*# COMMIT;
COMMIT
(A) ledger=# SELECT balance_minor FROM wallets WHERE id = 3;
 balance_minor
---------------
         30000
(1 row)
```

**What to notice**
- **B waited for A's row lock**, then re-checked `balance_minor >= 70000` against the new value (30000), and updated nothing: `UPDATE 0`. The app maps zero rows to "insufficient funds".
- **No retry and no error** at Read Committed. This is the cheapest correct way to protect a single-row rule.

**The same statement without the guard** (`... SET balance_minor = balance_minor - 70000 WHERE id = 3`) would have taken the balance to −₹400. The table's `CHECK (balance_minor >= 0)` caught it. **Real output** (the end of that session)

```text
-- (B) continues:
ERROR:  new row for relation "wallets" violates check constraint "wallets_balance_minor_check"
DETAIL:  Failing row contains (3, Amit (main), 7, -40000).
(B) ledger=!# COMMIT;
ROLLBACK
```

**And the guarded statement at Repeatable Read** gave `ERROR: could not serialize access due to concurrent update` instead of `UPDATE 0` (**Real output**). Same safety, but now the caller needs a retry. That is why the guarded `UPDATE` fits best at Read Committed.

**When it is enough, and when not.** Enough for rules about **one row**: balance not below zero, stock not below zero, a seat still available. Not enough for rules about **many rows or a sum**: a daily limit computed from many transfers, "at most 4 tickets per user". Those need Serializable, or one row that every writer locks (P2-04), or a constraint that expresses the rule.

---
## ⚖️ Comparisons and trade-offs

### Read Committed vs Repeatable Read vs Serializable

| | Read Committed | Repeatable Read | Serializable |
|---|---|---|---|
| Snapshot | New one per statement | One per transaction | One per transaction |
| Two writers on one row | Second waits, then continues on the new version | Second waits, then fails `40001` if the first committed | Same as Repeatable Read |
| Extra checking | None | None | Tracks reads (`SIReadLock`) and aborts dangerous patterns |
| Lost update with read-check-write | Possible | Prevented (`40001`) | Prevented (`40001`) |
| Write skew | Possible | Possible | Prevented (`40001`) |
| Needs a retry loop | No | Yes | Yes |
| Blocks readers | Never | Never | Never (except `READ ONLY DEFERRABLE`, which may wait at the start) |
| Good for | Most OLTP work, with atomic statements and row locks | Consistent read-only reports and exports | Multi-row rules where no single row can be locked |

### Tools for protecting a money rule

| Tool | Protects | What the loser sees | Cost |
|---|---|---|---|
| Guarded `UPDATE ... WHERE balance_minor >= $1` | A rule about one row | Waits, then `UPDATE 0` | Almost free |
| `CHECK (balance_minor >= 0)` | The same rule, as a last line of defence | Error `23514` | Free; catches bugs in code paths you forgot |
| `SELECT ... FOR UPDATE` on one row every writer touches | Rules that hang off that row (a wallet's daily limit) | Waits in line | Writers to that row run one at a time (P2-04) |
| `UNIQUE` or `EXCLUDE` constraint | "Only one of these may exist" (a seat booked once, one active hold) | Error `23505` / `23P01` | An index |
| Serializable plus retries | Any rule, including sums over many rows | Error `40001`, then a retry | Retries; heavy under contention; needs good indexes |

### 200 concurrent transfers in three designs (Measure item 2)

200 transfers of ₹100 started at once from Node.js, through a pool of 20 connections, against Postgres with 1 lakh wallets and 2 lakh older transfers. Three runs of each; ranges shown. Retries are capped at 10 attempts per transfer. **Real output**, summarised by a script.

| Scenario | Design | Completed | Rejected | Retries | Gave up | Transfers/s | p95 | Daily limit broken? |
|---|---|---|---|---|---|---|---|---|
| Spread: 1,000 wallets | Serializable + retry | 200 | 0 | 9 to 15 | 0 | 305 to 845 | 231 to 641 ms | No |
| Spread: 1,000 wallets | Read Committed, no lock | 200 | 0 | 0 | 0 | 1,003 to 1,256 | 157 to 195 ms | No |
| Spread: 1,000 wallets | Read Committed + `FOR UPDATE` | 200 | 0 | 0 | 0 | 885 to 967 | 202 to 225 ms | No |
| Hot: 10 wallets | Serializable + retry | 199 to 200 | 0 | 686 to 730 | 0 to 1 | 193 to 241 | 702 to 884 ms | No |
| Hot: 10 wallets | Read Committed, no lock | 200 | 0 | 0 | 0 | 862 to 882 | 217 to 221 ms | No |
| Hot: 10 wallets | Read Committed + `FOR UPDATE` | 200 | 0 | 0 | 0 | 632 to 697 | 258 to 293 ms | No |
| One wallet, ₹10,000 daily limit | Serializable + retry | **100** | 95 to 99 | 1,204 to 1,217 | 1 to 5 | 181 to 190 | 980 to 1,020 ms | **No** |
| One wallet, ₹10,000 daily limit | Read Committed, no lock | **119** | 81 | 0 | 0 | 763 to 799 | 236 to 249 ms | **Yes: ₹11,900** |
| One wallet, ₹10,000 daily limit | Read Committed + `FOR UPDATE` | **100** | 100 | 0 | 0 | 546 to 578 | 339 to 358 ms | **No** |

**How to read it**
- **Only the daily-limit scenario breaks a rule at Read Committed with no lock**: 119 transfers of ₹100 got through a ₹10,000 limit, a ₹1,900 write skew, in all three runs. In the other two scenarios, the only rule is "balance never below zero", and the guarded `UPDATE` protects it at any level.
- **Serializable kept every rule with zero extra code, but paid in retries.** With spread-out wallets, 9 to 15 retries for 200 transfers. With 10 hot wallets, about 3.5 per transfer. With one hot wallet, about 6 per transfer, and 1 to 5 transfers per run still gave up after 10 attempts (those would get `503` and be retried by the client).
- **The row lock kept the rule with zero retries.** Read Committed plus `SELECT ... FOR UPDATE` on both wallets made the one-wallet transfers wait in line: exactly 100 completed, and it was about 3 times faster than Serializable there.
- **Spread-out traffic is the normal case** for a wallet platform, and there Serializable cost one retry per 13 to 22 transfers. The first Serializable run (305/s) was the first one after loading the data, with cold caches.

**Diagram: which tool for which rule**

```mermaid
flowchart TD
  Q1{"Is the rule about one row?"}
  A1["Guarded UPDATE<br/>check inside WHERE<br/>plus a CHECK constraint"]
  Q2{"Does every writer touch one shared row?"}
  A2["Read Committed<br/>plus SELECT FOR UPDATE<br/>on that row"]
  Q3{"Can a constraint express it?"}
  A3["UNIQUE or EXCLUDE constraint"]
  A4["Serializable plus a 40001 retry loop"]
  Q1 -->|"yes"| A1
  Q1 -->|"no, many rows or a sum"| Q2
  Q2 -->|"yes, like the source wallet"| A2
  Q2 -->|"no"| Q3
  Q3 -->|"yes"| A3
  Q3 -->|"no"| A4
```

**How to read this diagram.** Start at the top with the rule you must protect. Prefer the cheapest tool that fits: one statement, then one row lock (P2-04 covers locks in depth), then a constraint. Serializable is the general answer when nothing simpler fits, and it is a good default for code paths where rules are easy to get wrong, as long as you can afford the retries.

---

## 🚶 Walkthrough on the ledger platform: two transfers race against Riya's daily limit

Riya's wallet has a ₹10,000 daily limit and nothing sent today. Her phone and her laptop each send ₹6,000 to Amit at the same moment. The numbers below match the diagram, and the lab's Vitest test runs exactly this race.

1. **Riya's app sends** `POST /v1/transfers` with an `Idempotency-Key` header and `amountMinor: 600000`. The other device does the same with a different key.
2. **The route validates** the body and the key with Zod before touching the database.
3. **The service calls `withRetry`**, which runs the whole transfer as one function.
4. **Attempt 1 begins at Serializable**, on one pooled client. It looks up the idempotency key (not found) and reads today's total (₹0). ₹0 + ₹6,000 is within ₹10,000.
5. **The two balance rows are updated** with guarded statements, in wallet-id order so two opposite transfers cannot deadlock.
6. **The transfer row and two ledger entries are inserted.**
7. **`COMMIT` is sent.**
8. **Postgres answers `40001`.** The other ₹6,000 transfer committed first, and this transaction read a total that the other one changed.
9. **The client is rolled back and released**, a warning is logged with the attempt number and SQLSTATE, and `withRetry` waits a random few milliseconds.
10. **Attempt 2 begins** on a fresh snapshot and reads today's total: ₹6,000. ₹6,000 + ₹6,000 is over ₹10,000.
11. **The service throws `DailyLimitExceededError`.** The transaction rolls back; this business error is not retried.
12. **The route answers `422`** with a Problem Details body (`daily-limit-exceeded`). Exactly one transfer went through.

**Diagram: one transfer, one conflict, one retry**

```mermaid
sequenceDiagram
  participant App as Riya's app
  participant API as Transfer route
  participant Svc as transferService
  participant PG as Postgres
  App->>API: 1. POST /v1/transfers, Idempotency-Key
  API->>API: 2. Zod validates
  API->>Svc: 3. createTransfer, withRetry
  Svc->>PG: 4. BEGIN SERIALIZABLE, key lookup, today = 0
  Svc->>PG: 5. guarded balance updates, id order
  Svc->>PG: 6. INSERT transfer and two entries
  Svc->>PG: 7. COMMIT
  PG-->>Svc: 8. ERROR 40001
  Svc->>Svc: 9. ROLLBACK, log warn, random backoff
  Svc->>PG: 10. BEGIN SERIALIZABLE, today = 600000
  Svc->>PG: 11. ROLLBACK, DailyLimitExceededError
  API-->>App: 12. 422 daily-limit-exceeded
```

**How to read this diagram.** The first attempt does everything right on its own snapshot, and still fails at `COMMIT` (7 and 8), because the other device's transfer changed what it read. The retry (10) is not a repeat of the old writes; it is a fresh decision on fresh data, and that decision is "no" (11). If the other device's transfer had failed instead, attempt 2 would have succeeded.

---

## 🧪 Hands-on lab

Four steps, in the card's order.

### Prerequisites

- Docker, Node.js 24 or 26, and `psql` (any recent client).
- The ledger project from earlier cards: Fastify, Zod, pino and Vitest are already set up (P1-07, P1-08).

`docker-compose.yml` (a throwaway Postgres for the lab)

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
createdb -h 127.0.0.1 -U postgres ledger_app      # a second database for the Node.js part (password: lab)
npm install pg zod pino fastify drizzle-orm
npm install -D typescript tsx vitest @types/pg @types/node
```

### Step 1: Reproduce a lost update and a write skew in two psql sessions

`psql/00-schema.sql`: the small lab schema. Run it before every experiment to start from the same data.

```sql
-- P2-03 lab schema: small readable ids so the psql transcripts are easy to follow.
-- (The product tables from P2-01 use UUIDs; the ideas are identical.)
DROP TABLE IF EXISTS withdrawals, outbox_events, wallets;

CREATE TABLE wallets (
  id            bigint PRIMARY KEY,
  owner_name    text   NOT NULL,
  user_id       bigint NOT NULL,
  balance_minor bigint NOT NULL CHECK (balance_minor >= 0)   -- paise; ₹1,000 = 100000
);

CREATE TABLE withdrawals (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id      bigint NOT NULL,
  wallet_id    bigint NOT NULL REFERENCES wallets (id),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  created_on   date   NOT NULL DEFAULT current_date
);
CREATE INDEX withdrawals_by_user_day ON withdrawals (user_id, created_on);

CREATE TABLE outbox_events (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  dedupe_key text   NOT NULL UNIQUE,
  payload    jsonb  NOT NULL
);

INSERT INTO wallets VALUES
  (1, 'Riya (main)',    42, 600000),   -- ₹6,000
  (2, 'Riya (savings)', 42, 800000),   -- ₹8,000
  (3, 'Amit (main)',     7, 100000);   -- ₹1,000

-- Riya already withdrew ₹4,000 today. Her daily limit across all wallets is ₹10,000.
INSERT INTO withdrawals (user_id, wallet_id, amount_minor) VALUES (42, 1, 400000);
```

Open two terminals. The prompt names each session, and `%x` shows `*` inside a transaction and `!` in a failed one:

```bash
psql "postgres://postgres:lab@127.0.0.1:5432/ledger" -f psql/00-schema.sql      # reset the data
psql "postgres://postgres:lab@127.0.0.1:5432/ledger" -v PROMPT1='(A) %/%R%x%# '  # terminal 1
psql "postgres://postgres:lab@127.0.0.1:5432/ledger" -v PROMPT1='(B) %/%R%x%# '  # terminal 2
```

Type each line in the session it belongs to, in the order shown. When a session "is waiting", go to the other terminal.

**Lost update at Read Committed** (Amit's ₹1,000; two ₹700 withdrawals). **Real output**

```text
(A) ledger=# BEGIN ISOLATION LEVEL READ COMMITTED;
BEGIN
(B) ledger=# BEGIN ISOLATION LEVEL READ COMMITTED;
BEGIN
(A) ledger=*# SELECT balance_minor FROM wallets WHERE id = 3;
 balance_minor
---------------
        100000
(1 row)
(B) ledger=*# SELECT balance_minor FROM wallets WHERE id = 3;
 balance_minor
---------------
        100000
(1 row)
-- both apps compute 100000 - 70000 = 30000 and write it back
(A) ledger=*# UPDATE wallets SET balance_minor = 30000 WHERE id = 3;
UPDATE 1
(B) ledger=*# UPDATE wallets SET balance_minor = 30000 WHERE id = 3;
-- (B) is waiting...
(A) ledger=*# COMMIT;
COMMIT
-- (B) continues:
UPDATE 1
(B) ledger=*# COMMIT;
COMMIT
(A) ledger=# SELECT balance_minor FROM wallets WHERE id = 3;
 balance_minor
---------------
         30000
(1 row)
```

**What to notice**
- **Both sessions read 100000 and wrote 30000.** B waited for A's lock (`-- (B) is waiting...`), then overwrote A's value.
- **Both withdrawals committed**, and the balance is ₹300. ₹1,400 left a ₹1,000 wallet.

**Write skew at Read Committed** (Riya: ₹4,000 used, ₹10,000 limit; two ₹5,000 withdrawals from two wallets). **Real output**

```text
(A) ledger=# BEGIN ISOLATION LEVEL READ COMMITTED;
BEGIN
(B) ledger=# BEGIN ISOLATION LEVEL READ COMMITTED;
BEGIN
(A) ledger=*# SELECT sum(amount_minor) AS withdrawn_today FROM withdrawals WHERE user_id = 42 AND created_on = current_date;
 withdrawn_today
-----------------
          400000
(1 row)
(B) ledger=*# SELECT sum(amount_minor) AS withdrawn_today FROM withdrawals WHERE user_id = 42 AND created_on = current_date;
 withdrawn_today
-----------------
          400000
(1 row)
-- both apps check 400000 + 500000 <= 1000000 (the daily limit): OK
(A) ledger=*# INSERT INTO withdrawals (user_id, wallet_id, amount_minor) VALUES (42, 1, 500000);
INSERT 0 1
(B) ledger=*# INSERT INTO withdrawals (user_id, wallet_id, amount_minor) VALUES (42, 2, 500000);
INSERT 0 1
(A) ledger=*# COMMIT;
COMMIT
(B) ledger=*# COMMIT;
COMMIT
(A) ledger=# SELECT sum(amount_minor) AS withdrawn_today FROM withdrawals WHERE user_id = 42 AND created_on = current_date;
 withdrawn_today
-----------------
         1400000
(1 row)
```

**What to notice**
- **No session ever waited:** the two inserts are different rows, so there was no lock to collide on.
- **Both checks were true when they ran**, and both commits succeeded. Together they broke the limit: ₹14,000 today.

### Step 2: Repeat at Repeatable Read and Serializable

Change the `BEGIN` lines to `BEGIN ISOLATION LEVEL REPEATABLE READ;` and then `SERIALIZABLE;`, reset the data each time, and repeat.

**Lost update at Repeatable Read.** **Real output**

```text
(A) ledger=# BEGIN ISOLATION LEVEL REPEATABLE READ;
BEGIN
(B) ledger=# BEGIN ISOLATION LEVEL REPEATABLE READ;
BEGIN
(A) ledger=*# SELECT balance_minor FROM wallets WHERE id = 3;
 balance_minor
---------------
        100000
(1 row)
(B) ledger=*# SELECT balance_minor FROM wallets WHERE id = 3;
 balance_minor
---------------
        100000
(1 row)
-- both apps compute 100000 - 70000 = 30000 and write it back
(A) ledger=*# UPDATE wallets SET balance_minor = 30000 WHERE id = 3;
UPDATE 1
(B) ledger=*# UPDATE wallets SET balance_minor = 30000 WHERE id = 3;
-- (B) is waiting...
(A) ledger=*# COMMIT;
COMMIT
-- (B) continues:
ERROR:  could not serialize access due to concurrent update
(B) ledger=!# COMMIT;
ROLLBACK
(A) ledger=# SELECT balance_minor FROM wallets WHERE id = 3;
 balance_minor
---------------
         30000
(1 row)
```

**Lost update at Serializable.** **Real output**

```text
(A) ledger=# BEGIN ISOLATION LEVEL SERIALIZABLE;
BEGIN
(B) ledger=# BEGIN ISOLATION LEVEL SERIALIZABLE;
BEGIN
(A) ledger=*# SELECT balance_minor FROM wallets WHERE id = 3;
 balance_minor
---------------
        100000
(1 row)
(B) ledger=*# SELECT balance_minor FROM wallets WHERE id = 3;
 balance_minor
---------------
        100000
(1 row)
-- both apps compute 100000 - 70000 = 30000 and write it back
(A) ledger=*# UPDATE wallets SET balance_minor = 30000 WHERE id = 3;
UPDATE 1
(B) ledger=*# UPDATE wallets SET balance_minor = 30000 WHERE id = 3;
-- (B) is waiting...
(A) ledger=*# COMMIT;
COMMIT
-- (B) continues:
ERROR:  could not serialize access due to concurrent update
(B) ledger=!# COMMIT;
ROLLBACK
(A) ledger=# SELECT balance_minor FROM wallets WHERE id = 3;
 balance_minor
---------------
         30000
(1 row)
```

**Write skew at Repeatable Read: still happens.** **Real output**

```text
(A) ledger=# BEGIN ISOLATION LEVEL REPEATABLE READ;
BEGIN
(B) ledger=# BEGIN ISOLATION LEVEL REPEATABLE READ;
BEGIN
(A) ledger=*# SELECT sum(amount_minor) AS withdrawn_today FROM withdrawals WHERE user_id = 42 AND created_on = current_date;
 withdrawn_today
-----------------
          400000
(1 row)
(B) ledger=*# SELECT sum(amount_minor) AS withdrawn_today FROM withdrawals WHERE user_id = 42 AND created_on = current_date;
 withdrawn_today
-----------------
          400000
(1 row)
-- both apps check 400000 + 500000 <= 1000000 (the daily limit): OK
(A) ledger=*# INSERT INTO withdrawals (user_id, wallet_id, amount_minor) VALUES (42, 1, 500000);
INSERT 0 1
(B) ledger=*# INSERT INTO withdrawals (user_id, wallet_id, amount_minor) VALUES (42, 2, 500000);
INSERT 0 1
(A) ledger=*# COMMIT;
COMMIT
(B) ledger=*# COMMIT;
COMMIT
(A) ledger=# SELECT sum(amount_minor) AS withdrawn_today FROM withdrawals WHERE user_id = 42 AND created_on = current_date;
 withdrawn_today
-----------------
         1400000
(1 row)
```

**Write skew at Serializable, and B's retry.** **Real output**

```text
(A) ledger=# BEGIN ISOLATION LEVEL SERIALIZABLE;
BEGIN
(B) ledger=# BEGIN ISOLATION LEVEL SERIALIZABLE;
BEGIN
(A) ledger=*# SELECT sum(amount_minor) AS withdrawn_today FROM withdrawals WHERE user_id = 42 AND created_on = current_date;
 withdrawn_today
-----------------
          400000
(1 row)
(B) ledger=*# SELECT sum(amount_minor) AS withdrawn_today FROM withdrawals WHERE user_id = 42 AND created_on = current_date;
 withdrawn_today
-----------------
          400000
(1 row)
(A) ledger=*# INSERT INTO withdrawals (user_id, wallet_id, amount_minor) VALUES (42, 1, 500000);
INSERT 0 1
(B) ledger=*# INSERT INTO withdrawals (user_id, wallet_id, amount_minor) VALUES (42, 2, 500000);
INSERT 0 1
(A) ledger=*# COMMIT;
COMMIT
(B) ledger=*# COMMIT;
ERROR:  could not serialize access due to read/write dependencies among transactions
DETAIL:  Reason code: Canceled on identification as a pivot, during commit attempt.
HINT:  The transaction might succeed if retried.
-- B's app sees SQLSTATE 40001 and runs the WHOLE transaction again
(B) ledger=# BEGIN ISOLATION LEVEL SERIALIZABLE;
BEGIN
(B) ledger=*# SELECT sum(amount_minor) AS withdrawn_today FROM withdrawals WHERE user_id = 42 AND created_on = current_date;
 withdrawn_today
-----------------
          900000
(1 row)
-- 900000 + 500000 > 1000000: the app rejects the withdrawal (daily limit reached)
(B) ledger=*# ROLLBACK;
ROLLBACK
```

**What to notice**
- **Repeatable Read and Serializable stopped the lost update the same way:** B's `UPDATE` waited, then failed with `could not serialize access due to concurrent update`, and its `COMMIT` turned into `ROLLBACK`.
- **Repeatable Read did not stop the write skew.** Nothing collided at the row level, so snapshot isolation had nothing to complain about.
- **Serializable failed B at `COMMIT`**, with the reason code "pivot". B's retry read ₹9,000 and its logic rejected the withdrawal.
- **A row lock also fixes the lost update at Read Committed**, with waiting instead of an error (P2-04 goes deeper):

**Lost update fixed with `SELECT ... FOR UPDATE` at Read Committed.** **Real output**

```text
(A) ledger=# BEGIN;
BEGIN
(B) ledger=# BEGIN;
BEGIN
(A) ledger=*# SELECT balance_minor FROM wallets WHERE id = 3 FOR UPDATE;
 balance_minor
---------------
        100000
(1 row)
(B) ledger=*# SELECT balance_minor FROM wallets WHERE id = 3 FOR UPDATE;
-- (B) is waiting...
(A) ledger=*# UPDATE wallets SET balance_minor = 30000 WHERE id = 3;
UPDATE 1
(A) ledger=*# COMMIT;
COMMIT
-- (B) continues:
 balance_minor
---------------
         30000
(1 row)
-- B's app sees 30000 < 70000 and rejects the withdrawal
(B) ledger=*# ROLLBACK;
ROLLBACK
```

**Record your results**

| Anomaly | Read Committed | Repeatable Read | Serializable | Error that appears instead |
|---|---|---|---|---|
| Lost update | Reproduced here | Prevented here | Prevented here | `40001` could not serialize access due to concurrent update |
| Write skew | Reproduced here | **Reproduced here** | Prevented here | `40001` could not serialize access due to read/write dependencies among transactions |
| Your machine | | | | |

### Step 3: A Node.js transfer with a 40001 retry helper

The product code, in the ledger repo. Repository functions take the transaction's client (`tx`), the service decides, and two small helpers own the transaction and the retry.

`db/schema.sql`: the P2-01 tables this card touches (lab copy, without `tenant_id`).

```sql
-- Lab copy of the P2-01 tables this card touches (no tenant_id, to keep it short).
DROP TABLE IF EXISTS ledger_entries, transfers, wallet_balances, wallets;

CREATE TABLE wallets (
  id                uuid   PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid   NOT NULL,
  currency          text   NOT NULL DEFAULT 'INR',
  daily_limit_minor bigint NOT NULL CHECK (daily_limit_minor > 0)   -- max outgoing per IST day
);

CREATE TABLE wallet_balances (
  wallet_id     uuid        PRIMARY KEY REFERENCES wallets (id),
  balance_minor bigint      NOT NULL CHECK (balance_minor >= 0),    -- the last line of defence
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE transfers (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key       text        NOT NULL UNIQUE,                -- P1-03 keeps these in their own table
  source_wallet_id      uuid        NOT NULL REFERENCES wallets (id),
  destination_wallet_id uuid        NOT NULL REFERENCES wallets (id),
  amount_minor          bigint      NOT NULL CHECK (amount_minor > 0),
  status                text        NOT NULL CHECK (status IN ('pending', 'completed', 'failed', 'reversed')),
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX transfers_by_source_day ON transfers (source_wallet_id, created_at);

CREATE TABLE ledger_entries (
  id           bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  transfer_id  uuid        NOT NULL REFERENCES transfers (id),
  wallet_id    uuid        NOT NULL REFERENCES wallets (id),
  direction    text        NOT NULL CHECK (direction IN ('debit', 'credit')),
  amount_minor bigint      NOT NULL CHECK (amount_minor > 0),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (transfer_id, direction)
);
```

`src/lib/db/pool.ts`: one pool per process, with server-side time limits on every connection.

```ts
// src/lib/db/pool.ts: one pool per process, with server-side time limits on every connection.
import pg from "pg";

export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({
    connectionString,
    max: 20,                                     // stay well below Postgres max_connections across all pods
    connectionTimeoutMillis: 2_000,              // waiting for a free connection
    statement_timeout: 5_000,                    // one statement
    lock_timeout: 2_000,                         // waiting for a row or table lock
    idle_in_transaction_session_timeout: 10_000, // a transaction the app forgot about
    application_name: "ledger-api",              // shows up in pg_stat_activity
  });
}
```

`src/lib/db/withTransaction.ts` and `src/lib/db/retryTransaction.ts` are shown in Deep dives 7 and 6. `src/errors/transferErrors.ts` defines `InsufficientFundsError` (422), `DailyLimitExceededError` (422) and `WalletNotFoundError` (404) on top of the Problem Details error base from P1-03; business errors are never retried.

`src/repositories/transferRepository.ts`: the SQL.

```ts
// src/repositories/transferRepository.ts: the SQL a transfer needs. Every function takes the
// transaction's client (tx), so all of it runs inside the caller's transaction.
import type { PoolClient } from "pg";

export async function findTransferByKey(tx: PoolClient, idempotencyKey: string): Promise<{ id: string } | undefined> {
  const { rows } = await tx.query<{ id: string }>("SELECT id FROM transfers WHERE idempotency_key = $1", [idempotencyKey]);
  return rows[0];
}

// Today's outgoing total in IST, plus the wallet's limit. This read decides whether we may write,
// so it is exactly the kind of read a write skew attacks.
export async function dailyUsage(tx: PoolClient, walletId: string): Promise<{ limitMinor: number; usedMinor: number } | undefined> {
  const { rows } = await tx.query<{ limit_minor: string; used_minor: string }>(
    `SELECT w.daily_limit_minor AS limit_minor,
            (SELECT coalesce(sum(t.amount_minor), 0) FROM transfers t
              WHERE t.source_wallet_id = w.id AND t.status = 'completed'
                AND t.created_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata') AS used_minor
       FROM wallets w WHERE w.id = $1`,
    [walletId],
  );
  const row = rows[0];
  return row && { limitMinor: Number(row.limit_minor), usedMinor: Number(row.used_minor) };
}

// One atomic statement: the check (never below zero) and the change happen together.
export async function applyBalanceChange(tx: PoolClient, walletId: string, deltaMinor: number): Promise<boolean> {
  const result = await tx.query(
    `UPDATE wallet_balances SET balance_minor = balance_minor + $2, updated_at = now()
      WHERE wallet_id = $1 AND balance_minor + $2 >= 0`,
    [walletId, deltaMinor],
  );
  return result.rowCount === 1;
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

// Pessimistic alternative (P2-04): lock both balance rows, always in the same order.
export async function lockWallets(tx: PoolClient, walletIds: string[]): Promise<void> {
  await tx.query("SELECT wallet_id FROM wallet_balances WHERE wallet_id = ANY($1::uuid[]) ORDER BY wallet_id FOR UPDATE", [walletIds]);
}
```

`src/services/transferService.ts`: one transfer = one Serializable transaction, retried on conflict.

```ts
// src/services/transferService.ts: one transfer = one Serializable transaction, retried on conflict.
import type { Pool, PoolClient } from "pg";
import type { Logger } from "pino";
import { withTransaction } from "../lib/db/withTransaction.js";
import { withRetry } from "../lib/db/retryTransaction.js";
import { DailyLimitExceededError, InsufficientFundsError, WalletNotFoundError } from "../errors/transferErrors.js";
import { applyBalanceChange, dailyUsage, findTransferByKey, insertCompletedTransfer } from "../repositories/transferRepository.js";

export interface TransferInput {
  idempotencyKey: string;
  sourceWalletId: string;
  destinationWalletId: string;
  amountMinor: number; // paise, a positive safe integer (validated by Zod at the route)
}

export interface TransferResult { transferId: string; replayed: boolean }

export function createTransferService(deps: { pool: Pool; log: Logger; maxAttempts?: number }) {
  return {
    createTransfer(input: TransferInput): Promise<TransferResult> {
      return withRetry(
        () => withTransaction(deps.pool, { isolationLevel: "SERIALIZABLE" }, (tx) => transferOnce(tx, input)),
        {
          maxAttempts: deps.maxAttempts ?? 10,
          baseDelayMs: 5,
          maxDelayMs: 250,
          onRetry: ({ attempt, sqlstate, delayMs }) =>
            deps.log.warn({ attempt, sqlstate, delay_ms: Math.round(delayMs), idempotency_key: input.idempotencyKey },
              "transfer transaction conflicted, retrying"),
        },
      );
    },
  };
}

// Everything that decides WHAT to write is read inside the transaction, so a retry decides again on fresh data.
// No network calls in here: this function may run several times, and it holds locks while it runs.
export async function transferOnce(tx: PoolClient, input: TransferInput): Promise<TransferResult> {
  const existing = await findTransferByKey(tx, input.idempotencyKey);
  if (existing) return { transferId: existing.id, replayed: true };

  const usage = await dailyUsage(tx, input.sourceWalletId);
  if (!usage) throw new WalletNotFoundError(input.sourceWalletId);
  if (usage.usedMinor + input.amountMinor > usage.limitMinor) {
    throw new DailyLimitExceededError(input.sourceWalletId, usage.limitMinor - usage.usedMinor);
  }

  // Touch the two balance rows in a fixed order (by id), so opposite transfers cannot deadlock each other.
  const changes = [
    { walletId: input.sourceWalletId, deltaMinor: -input.amountMinor },
    { walletId: input.destinationWalletId, deltaMinor: input.amountMinor },
  ].sort((a, b) => a.walletId.localeCompare(b.walletId));
  for (const change of changes) {
    if (await applyBalanceChange(tx, change.walletId, change.deltaMinor)) continue;
    throw change.deltaMinor < 0 ? new InsufficientFundsError(change.walletId) : new WalletNotFoundError(change.walletId);
  }

  const transferId = await insertCompletedTransfer(tx, input);
  return { transferId, replayed: false };
}
```

**What to notice**
- **`transferOnce` reads everything that decides the outcome inside the transaction:** the idempotency key, today's total, the balances (through the guarded `UPDATE`). A retry re-runs all of it on a fresh snapshot.
- **Serializable is there for the daily limit**, a sum over many rows. The balance rule is already safe through `applyBalanceChange`, at any level.
- **The two balance updates run in wallet-id order**, so a transfer from Riya to Amit and one from Amit to Riya never wait on each other in opposite order (no deadlock).
- **No network calls, no emails, no events published** inside `transferOnce`. In the full platform, a `transfer.completed` row goes into the outbox table in this same transaction, and a separate worker publishes it after commit (P4-07).

`src/routes/transfers.ts`: validate at the edge, map outcomes to Problem Details.

```ts
// src/routes/transfers.ts: validate at the edge, map outcomes to Problem Details.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { TransferRejectedError } from "../errors/transferErrors.js";
import { TransactionRetriesExhaustedError } from "../lib/db/retryTransaction.js";
import type { createTransferService } from "../services/transferService.js";

const TransferBody = z.object({
  sourceWalletId: z.uuid(),
  destinationWalletId: z.uuid(),
  amountMinor: z.number().int().positive().max(10_000_000_00), // ₹1 crore per transfer
});
const Headers = z.object({ "idempotency-key": z.string().min(8).max(100) });

export function transferRoutes(service: ReturnType<typeof createTransferService>) {
  return async function register(app: FastifyInstance): Promise<void> {
    app.post("/v1/transfers", async (request, reply) => {
      const body = TransferBody.parse(request.body);
      const { "idempotency-key": idempotencyKey } = Headers.parse(request.headers);
      try {
        const result = await service.createTransfer({ ...body, idempotencyKey });
        return reply.code(result.replayed ? 200 : 201).send(result);
      } catch (err) {
        if (err instanceof TransferRejectedError) {
          return reply.code(err.status).type("application/problem+json")
            .send({ type: `https://errors.ledger.example/${err.type}`, title: err.message, status: err.status });
        }
        if (err instanceof TransactionRetriesExhaustedError) {
          request.log.error({ err, attempts: err.attempts }, "transfer gave up after repeated conflicts");
          return reply.code(503).header("retry-after", "1").type("application/problem+json")
            .send({ type: "https://errors.ledger.example/busy", title: "Please retry with the same Idempotency-Key", status: 503 });
        }
        throw err; // unknown: the global error handler logs it and returns 500
      }
    });
  };
}
```

**What to notice**
- **A replayed idempotency key returns `200`** with the original transfer; a new one returns `201`.
- **Retries exhausted becomes `503` with `Retry-After`**, and the message tells the client to retry with the same key. The client cannot cause a double transfer by retrying.
- **Unknown errors are rethrown** to the global handler (P1-08 logs them with the request ID), never swallowed.

**Tests.** `test/retryTransaction.test.ts` checks the retry rules without a database; `test/transferService.test.ts` runs the race from the walkthrough against Postgres.

```ts
// test/retryTransaction.test.ts: the retry rules, with no database.
import { describe, expect, it, vi } from "vitest";
import { TransactionRetriesExhaustedError, withRetry } from "../src/lib/db/retryTransaction.js";

const pgError = (code: string) => Object.assign(new Error(`pg error ${code}`), { code });
const fast = { maxAttempts: 4, baseDelayMs: 1, maxDelayMs: 2 };

describe("withRetry", () => {
  it("re-runs the whole transaction after 40001 and returns the result", async () => {
    const run = vi.fn().mockRejectedValueOnce(pgError("40001")).mockRejectedValueOnce(pgError("40P01")).mockResolvedValue("ok");
    await expect(withRetry(run, fast)).resolves.toBe("ok");
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("gives up after maxAttempts with a typed error that keeps the cause", async () => {
    const run = vi.fn().mockRejectedValue(pgError("40001"));
    const err = await withRetry(run, fast).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransactionRetriesExhaustedError);
    expect((err as TransactionRetriesExhaustedError).attempts).toBe(4);
    expect(run).toHaveBeenCalledTimes(4);
  });

  it("never retries other errors (constraint violations, timeouts, business rules)", async () => {
    for (const code of ["23514", "57014", "55P03"]) {
      const run = vi.fn().mockRejectedValue(pgError(code));
      await expect(withRetry(run, fast)).rejects.toMatchObject({ code });
      expect(run).toHaveBeenCalledTimes(1);
    }
  });
});
```

```ts
// test/transferService.test.ts: the daily limit holds under concurrency (needs the lab Postgres).
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import pino from "pino";
import { createPool } from "../src/lib/db/pool.js";
import { createTransferService } from "../src/services/transferService.js";
import { DailyLimitExceededError, InsufficientFundsError } from "../src/errors/transferErrors.js";

const pool = createPool(process.env.TEST_DATABASE_URL ?? "postgres://postgres:lab@127.0.0.1/ledger_app");
const warnings: string[] = [];
const log = pino({ level: "warn" }, { write: (line: string) => { warnings.push(line); } });
const service = createTransferService({ pool, log });
let riya = "", amit = "";

beforeEach(async () => {
  await pool.query(readFileSync(new URL("../db/schema.sql", import.meta.url), "utf8"));
  const { rows } = await pool.query<{ id: string }>(
    "INSERT INTO wallets (user_id, daily_limit_minor) VALUES (gen_random_uuid(), 10_00_000), (gen_random_uuid(), 10_00_000) RETURNING id");
  [riya, amit] = rows.map((r) => r.id) as [string, string];
  await pool.query("INSERT INTO wallet_balances (wallet_id, balance_minor) VALUES ($1, 50_00_000), ($2, 0)", [riya, amit]);
  warnings.length = 0;
});
afterAll(() => pool.end());

const transfer = (amountMinor: number, from = riya, to = amit) =>
  service.createTransfer({ idempotencyKey: randomUUID(), sourceWalletId: from, destinationWalletId: to, amountMinor });

describe("createTransfer at Serializable", () => {
  it("lets only one of two concurrent ₹6,000 transfers through a ₹10,000 daily limit", async () => {
    const results = await Promise.allSettled([transfer(6_00_000), transfer(6_00_000)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason).toBeInstanceOf(DailyLimitExceededError);
    const { rows } = await pool.query("SELECT balance_minor FROM wallet_balances WHERE wallet_id = $1", [amit]);
    expect(Number(rows[0].balance_minor)).toBe(6_00_000);
  });

  it("rejects insufficient funds once, without retrying", async () => {
    await expect(transfer(1_000, amit, riya)).rejects.toBeInstanceOf(InsufficientFundsError);
    expect(warnings).toHaveLength(0);
  });

  it("returns the same transfer for a repeated idempotency key", async () => {
    const input = { idempotencyKey: randomUUID(), sourceWalletId: riya, destinationWalletId: amit, amountMinor: 1_000 };
    const first = await service.createTransfer(input);
    const again = await service.createTransfer(input);
    expect(again).toEqual({ transferId: first.transferId, replayed: true });
  });
});
```

**Real output** (`npx vitest run --reporter=verbose`)

```text
✓ test/transferService.test.ts > createTransfer at Serializable > lets only one of two concurrent ₹6,000 transfers through a ₹10,000 daily limit 118ms
✓ test/transferService.test.ts > createTransfer at Serializable > rejects insufficient funds once, without retrying 24ms
✓ test/transferService.test.ts > createTransfer at Serializable > returns the same transfer for a repeated idempotency key 24ms
✓ test/retryTransaction.test.ts > withRetry > re-runs the whole transaction after 40001 and returns the result 5ms
✓ test/retryTransaction.test.ts > withRetry > gives up after maxAttempts with a typed error that keeps the cause 4ms
✓ test/retryTransaction.test.ts > withRetry > never retries other errors (constraint violations, timeouts, business rules) 2ms
Tests  6 passed (6)
Duration  484ms (tests 66%, import 19%, transform 12%, worker 3%)
```

**200 concurrent transfers.** The benchmark's core: three designs that share the same `transferOnce`, and 200 transfers started at once.

```ts
// bench/concurrentTransfers.ts (core only; seeding and the invariant checks are omitted)
const retry = { maxAttempts: 10, baseDelayMs: 5, maxDelayMs: 250, onRetry: () => { retries++; } };
const designs: Record<string, (input: TransferInput) => Promise<TransferResult>> = {
  "Serializable + retry": (input) =>
    withRetry(() => withTransaction(pool, { isolationLevel: "SERIALIZABLE" }, (tx) => transferOnce(tx, input)), retry),
  "Read Committed, no lock": (input) =>
    withRetry(() => withTransaction(pool, { isolationLevel: "READ COMMITTED" }, (tx) => transferOnce(tx, input)), retry),
  "Read Committed + FOR UPDATE": (input) =>
    withRetry(() => withTransaction(pool, { isolationLevel: "READ COMMITTED" }, async (tx) => {
      await lockWallets(tx, [input.sourceWalletId, input.destinationWalletId]); // both rows, in id order
      return transferOnce(tx, input);
    }), retry),
};
// ... seed: 1 lakh wallets, 2 lakh transfers from earlier days, VACUUM ANALYZE (production-like plans)
// ... per scenario: reset balances and limits, build 200 inputs with random UUID idempotency keys
await Promise.all(inputs.map((input) => designs[name]!(input).then(countSuccess, countFailure)));
// ... then check: money conserved, no negative balance, no wallet over its daily limit, 2 entries per transfer
```

```bash
DATABASE_URL=postgres://postgres:lab@127.0.0.1:5432/ledger_app npx tsx bench/concurrentTransfers.ts
```

**Real output** (first of three runs per design, one-wallet scenario; the full table is in "200 concurrent transfers in three designs" above)

```text
one wallet, ₹10,000 daily limit  | Serializable + retry         | ok 100 | rejected  96 | retries 1204 {"40001":1204} | gave up 4 | errors 0 |   181/s | p95  1020 ms | money conserved true | min balance 9000000 | wallets over daily limit 0
one wallet, ₹10,000 daily limit  | Read Committed, no lock      | ok 119 | rejected  81 | retries    0 {} | gave up 0 | errors 0 |   799/s | p95   236 ms | money conserved true | min balance 8810000 | wallets over daily limit 1 | entries 238
one wallet, ₹10,000 daily limit  | Read Committed + FOR UPDATE  | ok 100 | rejected 100 | retries    0 {} | gave up 0 | errors 0 |   546/s | p95   357 ms | money conserved true | min balance 9000000 | wallets over daily limit 0 | entries 200
```

**Expected on your laptop:** more cores make every row faster, but the shape stays: Serializable needs few retries on spread-out wallets and many on one hot wallet; Read Committed with no lock lets more than 100 transfers through the limit; the row-lock design completes exactly 100 with zero retries.

### Step 4: Hold a transaction open; watch locks and dead tuples

Three sessions: A opens a transaction and goes idle, B tries to update the same row, and C is the on-call engineer's monitoring session. Autovacuum is switched off on `wallets` for the lab, so only our own `VACUUM` runs. `psql/upd.sql` is one line (`UPDATE wallets SET balance_minor = balance_minor + 1 WHERE id = 3;`), run 10,000 times by `pgbench`.

```bash
LEDGER=postgres://postgres:lab@127.0.0.1:5432/ledger
psql "$LEDGER" -c "ALTER TABLE wallets SET (autovacuum_enabled = false)" -c "VACUUM wallets"
pgbench -n -c 1 -t 10000 -f psql/upd.sql "$LEDGER"    # while A is still open
```

**Real output** (lines starting with `-- pgbench:` are pgbench's own output, copied into the transcript)

```text
-- C is the on-call engineer's monitoring session
(C) ledger=# SELECT n_live_tup, n_dead_tup, pg_size_pretty(pg_relation_size('wallets')) AS table_size FROM pg_stat_user_tables WHERE relname = 'wallets';
 n_live_tup | n_dead_tup | table_size
------------+------------+------------
          3 |          0 | 8192 bytes
(1 row)
(A) ledger=# BEGIN;
BEGIN
(A) ledger=*# UPDATE wallets SET balance_minor = balance_minor - 100 WHERE id = 1;
UPDATE 1
(A) ledger=*# SELECT pg_backend_pid() AS pid, pg_current_xact_id() AS xid;
 pid | xid
-----+-----
 631 | 998
(1 row)
-- A now sits idle inside its transaction (think: an app waiting on a slow payment API)
(B) ledger=# SET lock_timeout = '5s';
SET
(B) ledger=# UPDATE wallets SET balance_minor = balance_minor + 100 WHERE id = 1;
-- (B) is waiting...
(C) ledger=# SELECT l.pid, l.locktype, l.relation::regclass AS relation, l.transactionid AS xid, l.mode, l.granted FROM pg_locks l JOIN pg_stat_activity a USING (pid) WHERE a.datname = 'ledger' AND l.pid <> pg_backend_pid() AND l.locktype IN ('relation', 'transactionid', 'tuple') ORDER BY l.pid, l.granted DESC, l.locktype, l.relation::text;
 pid |   locktype    |   relation   | xid |       mode       | granted
-----+---------------+--------------+-----+------------------+---------
 631 | relation      | wallets      |     | RowExclusiveLock | t
 631 | relation      | wallets_pkey |     | RowExclusiveLock | t
 631 | transactionid |              | 998 | ExclusiveLock    | t
 633 | relation      | wallets      |     | RowExclusiveLock | t
 633 | relation      | wallets_pkey |     | RowExclusiveLock | t
 633 | transactionid |              | 999 | ExclusiveLock    | t
 633 | tuple         | wallets      |     | ExclusiveLock    | t
 633 | transactionid |              | 998 | ShareLock        | f
(8 rows)
(C) ledger=# SELECT pid, state, wait_event_type AS wait_type, pg_blocking_pids(pid) AS blocked_by, date_trunc('second', now() - xact_start) AS xact_age, left(query, 50) AS last_query FROM pg_stat_activity WHERE datname = 'ledger' AND pid <> pg_backend_pid() ORDER BY pid;
 pid |        state        | wait_type | blocked_by | xact_age |                     last_query
-----+---------------------+-----------+------------+----------+----------------------------------------------------
 631 | idle in transaction | Client    | {}         | 00:00:01 | SELECT pg_backend_pid() AS pid, pg_current_xact_id
 633 | active              | Lock      | {631}      | 00:00:01 | UPDATE wallets SET balance_minor = balance_minor +
(2 rows)
-- (B) continues:
ERROR:  canceling statement due to lock timeout
CONTEXT:  while updating tuple (0,1) in relation "wallets"
-- meanwhile, 10,000 normal transfers update Amit's wallet (pgbench, one transaction each)
-- pgbench: number of transactions actually processed: 10000/10000
-- pgbench: latency average = 0.538 ms
-- pgbench: tps = 1857.475186 (without initial connection time)
(C) ledger=# SELECT n_live_tup, n_dead_tup, pg_size_pretty(pg_relation_size('wallets')) AS table_size FROM pg_stat_user_tables WHERE relname = 'wallets';
 n_live_tup | n_dead_tup | table_size
------------+------------+------------
          3 |      10000 | 672 kB
(1 row)
(C) ledger=# VACUUM (VERBOSE) wallets;
INFO:  finished vacuuming "ledger.public.wallets": index scans: 0
pages: 0 removed, 84 remain, 84 scanned (100.00% of total)
tuples: 0 removed, 10003 remain, 10000 are dead but not yet removable
removable cutoff: 998, which was 10002 XIDs old when operation ended
INFO:  finished vacuuming "ledger.pg_toast.pg_toast_17255": index scans: 0
pages: 0 removed, 0 remain, 0 scanned (100.00% of total)
tuples: 0 removed, 0 remain, 0 are dead but not yet removable
removable cutoff: 998, which was 10002 XIDs old when operation ended
(A) ledger=*# COMMIT;
COMMIT
(C) ledger=# VACUUM (VERBOSE) wallets;
INFO:  finished vacuuming "ledger.public.wallets": index scans: 1
pages: 0 removed, 84 remain, 84 scanned (100.00% of total)
tuples: 10001 removed, 3 remain, 0 are dead but not yet removable
removable cutoff: 11000, which was 0 XIDs old when operation ended
INFO:  finished vacuuming "ledger.pg_toast.pg_toast_17255": index scans: 0
pages: 0 removed, 0 remain, 0 scanned (100.00% of total)
tuples: 0 removed, 0 remain, 0 are dead but not yet removable
removable cutoff: 11000, which was 0 XIDs old when operation ended
(C) ledger=# SELECT n_live_tup, n_dead_tup, pg_size_pretty(pg_relation_size('wallets')) AS table_size FROM pg_stat_user_tables WHERE relname = 'wallets';
 n_live_tup | n_dead_tup | table_size
------------+------------+------------
          3 |          0 | 672 kB
(1 row)
```

**What to notice**
- **`pg_locks` explains the wait.** A (pid 631) holds `ExclusiveLock` on its own transaction ID 998 (and a row lock it does not list separately). B (pid 633) holds the `tuple` lock (it is first in line for the row) and waits for a `ShareLock` on transaction 998 with `granted = f`: "wake me when 998 ends".
- **`pg_stat_activity` names the culprit:** A is `idle in transaction`, and `pg_blocking_pids()` says B is blocked by 631.
- **`lock_timeout` saved B** after 5 s with `canceling statement due to lock timeout`. Without it, B would wait as long as A stays open.
- **10,000 dead versions, none removable.** `VACUUM` reported `10000 are dead but not yet removable` and a `removable cutoff` of 998, A's transaction, now 10,002 transaction IDs old. The table grew from 8 KB to 672 kB (84 pages) for 3 live rows.
- **After A committed, one `VACUUM` removed 10,001 versions.** The file stayed 672 kB: the space is free for reuse inside the table, not returned to the OS.

---

## 💥 Break it and measure it

| # | Break this | What you should see | Result here |
|---|---|---|---|
| 1 | Read the balance, compute in the app, write the number back, at Read Committed | Lost update | **Real:** ₹1,400 paid from ₹1,000; balance ₹300 |
| 2 | Check the daily limit with a `SELECT sum(...)`, at Repeatable Read | Write skew | **Real:** ₹14,000 withdrawn against ₹10,000 |
| 3 | The same limit check at Read Committed, 200 concurrent transfers | Many over the limit | **Real:** 119 of 200 succeeded, ₹1,900 over, in 3 of 3 runs |
| 4 | Serializable on tiny tables, as in a fresh dev database | Coarse predicate locks (whole tables or the same few pages), retry storm | **Real:** 670 to 1,050 retries and up to 8 gave up, vs 9 to 15 retries on real data |
| 5 | Idempotency keys that share a prefix (`bench-<uuid>`) at Serializable | Every key in the same index pages | **Real:** 504 to 871 retries vs 9 to 15 with plain UUIDs |
| 6 | Serializable on one hot wallet | Retries pile up | **Real:** about 6 retries per transfer; 1 to 5 of 200 gave up |
| 7 | A 200 ms provider call inside the transaction | Writers queue behind the lock | **Real:** 4,112 ms for 20 withdrawals vs 221 ms |
| 8 | Leave a transaction idle | Locks held, VACUUM blocked | **Real:** B timed out after 5 s; 10,000 dead tuples not removable |
| 9 | `pool.query("BEGIN")` in node-postgres | Statements on different connections | **Real:** Amit's top-up returned rowCount 1, then vanished |
| 10 | Remove the `WHERE balance_minor >= $1` guard | Negative balance | **Real:** blocked only by the `CHECK` constraint (`23514`) |
| 11 | Catch `40001` and return `{ ok: false }` instead of retrying | Transfers fail at random under load | **Expected:** the failure rate follows contention; users see "transfer failed" for a perfectly valid transfer |

### Measurements

**Measure 1: does each anomaly reproduce at each level?** **Real output** from two `psql` sessions per cell.

| Anomaly | Read Committed | Repeatable Read | Serializable | Your machine |
|---|---|---|---|---|
| Dirty read | No | No | No | |
| Non-repeatable read | **Yes** | No | No | |
| Phantom read | **Yes** | No | No | |
| Lost update | **Yes** | No (`40001`) | No (`40001`) | |
| Write skew | **Yes** | **Yes** | No (`40001`) | |

**Measure 2: retries and throughput at Serializable under 200 concurrent transfers.** **Real output**, three runs each; pool of 20; 2-vCPU sandbox.

| Scenario | Retries (for 200 transfers) | Gave up after 10 attempts | Transfers/s | p95 | Same scenario at Read Committed + `FOR UPDATE` | Your machine |
|---|---|---|---|---|---|---|
| Spread: 1,000 wallets | 9 to 15 | 0 | 305 to 845 | 231 to 641 ms | 885 to 967/s, 0 retries | |
| Hot: 10 wallets | 686 to 730 | 0 to 1 | 193 to 241 | 702 to 884 ms | 632 to 697/s, 0 retries | |
| One wallet, ₹10,000 limit | 1,204 to 1,217 | 1 to 5 | 181 to 190 | 980 to 1,020 ms | 546 to 578/s, 0 retries | |
| Spread, tiny tables (fresh database) | 670 to 1,050 | 0 to 8 | 109 to 171 | 935 to 1,730 ms | not run | |

---

## 🚫 Common mistakes and wrong mental models

### 1. Wrong mental model: "inside a transaction I am alone in the database"

**The truth.** At Read Committed, other transactions keep committing while yours runs, and **each of your statements sees their latest commits**. Only your uncommitted changes are private. The non-repeatable-read and phantom transcripts in Deep dive 3 show two `SELECT`s in one transaction disagreeing.

```ts
// Beginner way: a monthly statement that reads entries, then the closing balance, at Read Committed.
// A transfer that commits between the two queries makes the statement not add up.
await withTransaction(pool, { isolationLevel: "READ COMMITTED" }, async (tx) => {
  const entries = await listEntriesForMonth(tx, walletId, month);
  const closing = await currentBalance(tx, walletId);
  return renderStatement(entries, closing);
});
```

```ts
// Product way: one snapshot for the whole read, and READ ONLY so it can never write by mistake.
await withTransaction(pool, { isolationLevel: "REPEATABLE READ", readOnly: true }, async (tx) => {
  const entries = await listEntriesForMonth(tx, walletId, month);
  const closing = await currentBalance(tx, walletId);
  return renderStatement(entries, closing);
});
```

What breaks in the beginner way: the closing balance includes a transfer that the entry list does not, and support gets a ticket saying "your statement is wrong".

### 2. Read-check-write in application code

```ts
// Beginner way: read, check in JavaScript, write the computed number back.
const { rows } = await tx.query("SELECT balance_minor FROM wallet_balances WHERE wallet_id = $1", [walletId]);
const balance = Number(rows[0].balance_minor);
if (balance < amountMinor) throw new InsufficientFundsError(walletId);
await tx.query("UPDATE wallet_balances SET balance_minor = $2 WHERE wallet_id = $1", [walletId, balance - amountMinor]);
```

```ts
// Product way: the check and the change in one statement (src/repositories/transferRepository.ts).
const debited = await applyBalanceChange(tx, walletId, -amountMinor); // ... WHERE wallet_id = $1 AND balance_minor + $2 >= 0
if (!debited) throw new InsufficientFundsError(walletId);
```

What breaks in the beginner way: the lost update from lab step 1. Two concurrent debits both pass the check and the second write replaces the first.

### 3. Calling a payment provider or sending email inside the transaction

```ts
// Beginner way: everything in one transaction "so it is atomic".
await withTransaction(pool, { isolationLevel: "READ COMMITTED" }, async (tx) => {
  if (!(await applyBalanceChange(tx, walletId, -amountMinor))) throw new InsufficientFundsError(walletId);
  await payoutProvider.sendToUpi({ upiId, amountMinor });     // network call while the wallet row is locked
  await email.send(userEmail, "₹ sent to your bank");        // cannot be taken back if COMMIT fails
});
```

```ts
// Product way: the transaction records the intent; the network work happens after COMMIT.
const payoutId = await withTransaction(pool, { isolationLevel: "READ COMMITTED" }, async (tx) => {
  if (!(await applyBalanceChange(tx, walletId, -amountMinor))) throw new InsufficientFundsError(walletId);
  const id = await insertPayout(tx, { walletId, upiId, amountMinor, status: "pending" });
  await insertOutboxEvent(tx, "payout.requested", { payoutId: id }); // a worker calls the provider after commit (P4-07)
  return id;
});
// The worker calls the provider with payoutId as the provider's idempotency key, then marks the
// payout completed, or reverses the debit in a new transaction if the provider says no.
```

What breaks in the beginner way: the wallet row stays locked for the provider's whole response time (4.1 s for 20 withdrawals in Deep dive 2); if `COMMIT` then fails, the money has left through the provider but the ledger says it did not, and a retry pays it twice.

### 4. Swallowing serialization errors instead of retrying them

```ts
// Beginner way: a 40001 is treated as a final failure (or, worse, logged and ignored).
try {
  await withTransaction(pool, { isolationLevel: "SERIALIZABLE" }, (tx) => transferOnce(tx, input));
} catch (err) {
  log.error({ err }, "transfer failed");
  return { ok: false };
}
```

```ts
// Product way: retry the whole transaction on 40001/40P01; anything else goes to the caller.
return withRetry(
  () => withTransaction(pool, { isolationLevel: "SERIALIZABLE" }, (tx) => transferOnce(tx, input)),
  { maxAttempts: 10, baseDelayMs: 5, maxDelayMs: 250, onRetry: logRetry },
);
```

What breaks in the beginner way: valid transfers fail at random whenever traffic overlaps, and the failure rate rises exactly when the business is busiest.

### More wrong mental models

| Wrong model | Correct model |
|---|---|
| "Serializable means everything runs one at a time, so it is very slow." | Serializable does not block; transactions run concurrently and some are aborted. With spread-out data, it cost 9 to 15 retries per 200 transfers here. Under one hot row, it is expensive. |
| "Repeatable Read in Postgres is the same as in MySQL." | Postgres's Repeatable Read is snapshot isolation with first-updater-wins errors. MySQL InnoDB's Repeatable Read uses locking reads and gap locks and behaves differently. Test, do not assume. |
| "On `40001`, retry the statement that failed." | Retry the whole transaction from `BEGIN`; the earlier reads are what went stale. |
| "Read Uncommitted shows me other transactions' uncommitted changes." | Not in Postgres; it behaves like Read Committed. |
| "A transaction makes my HTTP call and my email atomic with my SQL." | Atomicity covers this database only. Use an outbox, and idempotency keys at the provider. |
| "`ROLLBACK` undoes everything." | Not sequences: `nextval()` is never rolled back, so identity values have gaps. Not anything outside the database. |
| "Read-only transactions are harmless, so they can stay open." | An open snapshot still blocks `VACUUM` and keeps dead tuples alive (lab step 4). |
| "A higher isolation level means I can drop my `CHECK` constraints." | Constraints are cheap, work at every level and catch code paths you forgot. Keep them. |

---
## ✅ Production checklist

**Correctness**
- [ ] Every money rule is written down, with the tool that protects it (guarded `UPDATE`, `CHECK`, `UNIQUE`/`EXCLUDE`, row lock, or Serializable).
- [ ] No read-check-write on balances: every debit is a single guarded statement, and `CHECK (balance_minor >= 0)` backs it up.
- [ ] Rules over many rows (daily limits, quotas) run at Serializable, or behind one row every writer locks, or on a counter row with a guarded update.
- [ ] Every transaction at Repeatable Read or Serializable goes through a retry helper: whole transaction, `40001` and `40P01` only, backoff with jitter, a maximum attempt count.
- [ ] Every money-moving endpoint takes an idempotency key, so a client retry after `503` cannot double-apply (P1-03).
- [ ] Opposite operations touch rows in a fixed order (by id), so they cannot deadlock.

**Boundaries**
- [ ] No HTTP calls, emails, queue publishes or file uploads inside a transaction. Side effects go through an outbox written in the same transaction (P4-07).
- [ ] Transactions run on one client (`pool.connect()`), never through `pool.query("BEGIN")`.
- [ ] Read-only multi-query work (statements, reconciliations) uses `REPEATABLE READ READ ONLY`.

**Time limits and visibility**
- [ ] `statement_timeout`, `lock_timeout` and `idle_in_transaction_session_timeout` are set per connection pool or role; `transaction_timeout` on Postgres 17+ for batch roles.
- [ ] A dashboard or alert on `pg_stat_activity`: oldest `xact_start`, sessions `idle in transaction`, and waits with `wait_event_type = 'Lock'`.
- [ ] Retries are a metric (by endpoint and SQLSTATE), and "retries exhausted" is an alert.
- [ ] Backfills and migrations update in small batches with a commit per batch, never one 50-lakh-row transaction.

**Before shipping a Serializable path**
- [ ] Load-tested on production-like volume, with statistics up to date (`ANALYZE`), so predicate locks are fine-grained.
- [ ] Hot rows identified; for those, a row lock or a counter row instead of retry storms.

---

## 🤖 Engineering with AI

**Where AI tools help**
- Writing the `withTransaction` and `withRetry` helpers, and tests that fake `40001` errors.
- Turning a read-check-write into a guarded `UPDATE ... RETURNING`.
- Generating two-session `psql` scripts that reproduce a suspected race, so you can see it before fixing it.
- Explaining a `pg_locks` or `pg_stat_activity` output, or a `VACUUM VERBOSE` report.

**Where AI commonly goes wrong on this concept**
- Writes `SELECT balance`, checks it in JavaScript, then `UPDATE ... SET balance = $computed`: the lost update, in clean-looking code.
- Uses `pool.query("BEGIN")` with node-postgres, or Prisma's array form `$transaction([a, b])` and assumes later reads see a consistent snapshot.
- Sets Serializable but adds no retry, or retries only the failing statement, or retries every error (including `23514` and timeouts).
- Puts `await fetch(...)` to a payment provider, or an email send, inside the transaction callback.
- Suggests a Redis lock or an in-process mutex for a rule that one guarded statement or one row lock in Postgres already handles; an in-process mutex does nothing across pods.
- Assumes MySQL semantics for "Repeatable Read", or claims Read Uncommitted shows dirty data in Postgres.
- Uses `SELECT ... FOR UPDATE` on two rows in request order, which deadlocks under opposite transfers.

**Review checklist for AI-generated code that touches transactions**
- [ ] Which rule does this transaction protect, and which tool protects it?
- [ ] Is there any read whose result is later written back as a computed value?
- [ ] Does every statement run on the same client, and is the client always released?
- [ ] Is there a network call, `setTimeout`, or anything slow between `BEGIN` and `COMMIT`?
- [ ] At Repeatable Read or Serializable: is the **whole** transaction retried on `40001`/`40P01` only, with a cap and backoff?
- [ ] Is the retried function free of side effects, and is the endpoint idempotent?
- [ ] Are rows locked in a consistent order?
- [ ] Is there a test that runs two of these concurrently and checks the rule?

**Prompts that work**

1. *"Here is my transfer function and the table definitions. List every rule this code must keep (balance, limits, uniqueness). For each, name the anomaly that could break it under concurrency at Postgres Read Committed, and the cheapest fix: guarded UPDATE, constraint, row lock, or Serializable."*
   **Verify by:** reproducing each anomaly it names in two `psql` sessions (lab step 1), then checking the fix in the same sessions.
2. *"Write a TypeScript `withRetry` for node-postgres that re-runs a whole transaction on SQLSTATE 40001 and 40P01 only, with exponential backoff and full jitter, a max attempt count, a typed error that keeps the cause, and an onRetry hook for logging. Add Vitest tests that fake the errors: success after two failures, giving up, and no retry for 23514, 57014 and 55P03."*
   **Verify by:** reading the error filter yourself, and running the tests plus the 200-transfer benchmark at Serializable.
3. *"Review this code for anything slow or external between BEGIN and COMMIT: HTTP, email, queue publishes, file I/O, sleeps. For each, propose how to move it after COMMIT using an outbox row written inside the transaction."*
   **Verify by:** timing 20 concurrent requests on one wallet before and after (Deep dive 2's script), and checking `pg_stat_activity` for `idle in transaction` during a load test.

---

## 🎤 Interview script

**How it shows up.** Payment and booking prompts: "design a wallet debit", "two people book the last seat", "a user has a daily limit", "build a coupon that can be used once". Strong answers name the exact anomaly (lost update, write skew) and the exact protection (a guarded statement, a lock, a constraint, or Serializable plus retry). LLD rounds may ask you to write the debit code; senior rounds ask what happens under 10x load and during an outage.

### 2-minute answer: "How do you prevent double spending in a wallet debit?"

1. **Name the race.** Two debits read the same balance and both pass the check. If the code writes back a computed balance, that is a **lost update**. If the rule spans rows, like a daily limit across wallets, it is a **write skew**.
2. **Single-row rule: one atomic statement.** `UPDATE wallet_balances SET balance = balance - $1 WHERE wallet_id = $2 AND balance >= $1 RETURNING balance`. At Postgres's default Read Committed, a concurrent debit waits for the row lock, re-checks the condition on the new balance, and updates zero rows if the money is gone. A `CHECK (balance >= 0)` is the backstop.
3. **Multi-row rule: stronger tools.** Lock one row every writer touches (`SELECT ... FOR UPDATE` on the source wallet), or keep a counter row and guard it the same way, or run at Serializable and retry `40001`. Repeatable Read is not enough: it stops lost updates but not write skew.
4. **Keep the transaction short and local.** No provider calls inside. Write a pending payout and an outbox event in the transaction; call the provider after commit with an idempotency key.
5. **Make retries safe.** Client idempotency keys, a capped retry with jitter for `40001`, timeouts, and a metric for retries and long transactions.

### Five likely follow-ups

1. **"Why not use Serializable for everything?"**
   It is correct by default and does not block, which is attractive. The cost is retries: in my measurements, about one retry per 13 to 22 transfers on spread-out wallets, but about 6 per transfer on one hot wallet, where a row lock was 3 times faster with zero retries. It also needs good indexes: on tiny tables with sequential scans, predicate locks covered whole tables and retries jumped to over 1,000 per 200 transfers. I use it where rules are complex and contention is low, and measure.
2. **"What does Postgres's default level allow? Would Repeatable Read fix the bug?"**
   Read Committed gives each statement a new snapshot, so it allows non-repeatable reads, phantoms, lost updates from read-check-write, and write skew. Repeatable Read gives one snapshot and fails the second writer of a row with `40001`, so it fixes the lost update, but write skew still commits, as my two-session test showed (₹14,000 against a ₹10,000 limit).
3. **"How would you enforce a daily limit without Serializable?"**
   Make the rule hang off one row. Either lock the source wallet's row `FOR UPDATE` at the start of each transfer, so transfers from that wallet queue, or keep a `wallet_daily_usage (wallet_id, day, used_minor)` row and update it with a guarded upsert: add the amount only if `used_minor + amount <= limit`. Both turn a write skew into a single-row problem.
4. **"Your transfer must call a bank API. Where does the transaction end?"**
   Before the call. Transaction 1 debits, writes a pending payout and an outbox event, and commits. A worker calls the bank with the payout ID as idempotency key. Transaction 2 marks it completed, or a compensating transaction reverses the debit. A database rollback cannot undo a bank transfer, so I design the compensation explicitly (sagas, P4-07).
5. **"The database is slow, tables are bloating, and replicas lag. What do you check?"**
   `pg_stat_activity` for `idle in transaction` sessions and the oldest `xact_start`; `pg_locks` and `pg_blocking_pids()` for blockers; `VACUUM VERBOSE` for "dead but not yet removable" and its removable cutoff. Then fix the cause (a missing commit, a provider call inside a transaction, one giant backfill) and set `idle_in_transaction_session_timeout`, `lock_timeout` and `statement_timeout`.

### Red flags interviewers notice

- "I'll wrap it in a transaction" with no isolation level or mechanism named; a transaction alone does not stop a lost update at Read Committed.
- Reading the balance, checking it in code and writing it back.
- An in-process mutex or a `Redis` lock for a rule that one guarded statement in Postgres handles; a mutex in one Node.js process does nothing for the other pods.
- "Repeatable Read prevents all anomalies."
- Retrying only the failed statement, or never retrying `40001`.
- Calling the payment provider inside the transaction.

### Mini design: seat booking for a big cricket match

**Scenario.** 40,000 seats, 5 lakh fans trying in the first 5 minutes, at most 4 tickets per user.

**Numbers** (computed): 5 lakh attempts in 300 s is about **1,667 attempts a second**. 40,000 seats at 4 per user means at least **10,000 buyers**; selling out in 5 minutes is about **133 seats a second**.

**The rules and the tool for each**

| Rule | Anomaly if done naively | Tool |
|---|---|---|
| A seat is sold at most once | Lost update (two buyers read "available") | Guarded `UPDATE seats SET status = 'held', held_by = $user, held_until = now() + interval '10 minutes' WHERE match_id = $1 AND seat_id = $2 AND (status = 'available' OR held_until < now()) RETURNING seat_id`, plus `UNIQUE (match_id, seat_id)` on bookings as the backstop |
| At most 4 tickets per user per match | Write skew (two requests count 3 each, both add 1) | A counter row per user and match, updated with a guarded upsert (`held + $n <= 4`), or Serializable |
| Payment before the hold expires | Long transaction, money taken for a lost seat | Hold and quota in one short transaction; payment outside it; a confirm transaction that checks `held_by` and `held_until`; an expiry job releases old holds |

**Decisions to say out loud.** Every hot-path rule is one guarded statement at Read Committed, so there are no retries at 1,667 attempts a second. The one multi-row rule (4 per user) is turned into a single-row rule with a counter. Payment never runs inside a transaction. If the business later adds a rule that is hard to express this way, that path moves to Serializable with retries, and I load-test it first.

---

## ❓ Questions from the card, answered

Try each one yourself first, then open the answer.

<details>
<summary><b>1. Which anomaly lets two concurrent withdrawals both succeed when only one should?</b></summary>

When both withdrawals hit **the same balance row** with read-check-write code (read the balance, check it in the app, write back the computed value), it is a **lost update**. Both read ₹1,000, both pass the check, both write ₹300, and the second write silently replaces the first. In this guide's lab at Read Committed, a ₹1,000 wallet paid out ₹1,400.

When the rule spans **several rows**, it is a **write skew**. Riya's two ₹5,000 withdrawals from two different wallets each read "₹4,000 used of ₹10,000" and each inserted its own withdrawal row. Nothing collided, both committed, and she withdrew ₹14,000. That happened at Read Committed **and** Repeatable Read.

Fixes: for the single row, a guarded `UPDATE ... WHERE balance_minor >= $1` (works at Read Committed), a row lock, or Repeatable Read/Serializable (which fail the second writer with `40001`). For the multi-row rule, Serializable plus retry, or one row every writer locks, or a counter row with a guarded update.

</details>

<details>
<summary><b>2. What does Postgres's default isolation level allow?</b></summary>

The default is **Read Committed**. Each statement sees a fresh snapshot of everything committed before it started. So:

- **No dirty reads**: you never see uncommitted data (Postgres never allows them, at any level).
- **Non-repeatable reads and phantoms are allowed**: two `SELECT`s in one transaction can return different values or different rows, because others commit in between.
- **Lost updates are allowed** when the app reads, computes and writes back a value in separate statements.
- **Write skew is allowed.**
- When an `UPDATE` waits for another writer's row lock, it then **re-checks its `WHERE` clause on the newest version** and continues. That makes single-statement guards like `balance_minor >= $1` safe, and it means Read Committed never fails with `40001`.

All of these were reproduced in this guide with two real `psql` sessions.

</details>

<details>
<summary><b>3. Why must serializable transactions be retried, and how?</b></summary>

**Why.** Serializable does not prevent anomalies by making transactions wait; it lets them run concurrently and, when their reads and writes could not match any one-at-a-time order, it **aborts** one with SQLSTATE `40001`. The error can come on any statement, including `COMMIT`. It is a normal outcome, not a bug: without a retry, valid requests fail at random whenever traffic overlaps. In this guide's benchmark, 200 concurrent transfers needed 9 to 15 retries when spread over 1,000 wallets, and about 6 per transfer on one hot wallet.

**How.**
1. Retry the **whole transaction from `BEGIN`**, including every read and every decision; the old reads are what went stale.
2. Retry only `40001` (and `40P01`, deadlock). Pass every other error to the caller.
3. Wait with exponential backoff and **jitter** between attempts, so the same transactions do not collide again.
4. **Cap the attempts** (10 in this guide), then return `503` with `Retry-After`.
5. Keep the retried function **free of side effects** (no emails, no HTTP), and make the endpoint **idempotent** so a client retry after `503` cannot double-apply.

The guide's `withRetry` (Deep dive 6) does exactly this, and its tests check the rules.

</details>

<details>
<summary><b>4. Why should you never call an external API inside a database transaction?</b></summary>

1. **Locks are held for the whole call.** Every row the transaction changed stays locked while the provider thinks. In this guide, a 200 ms call inside the transaction made 20 withdrawals from one wallet take **4,112 ms**; with the call after `COMMIT`, **221 ms**. One wallet can then do at most 5 operations a second.
2. **Connections and snapshots are held too.** A slow provider (or a timeout of 30 s) keeps pool connections busy, so other requests queue for a connection, and the open snapshot stops `VACUUM`, which bloats tables and can delay replicas.
3. **Atomicity does not reach the provider.** If the provider moved the money and then your `COMMIT` fails (a `40001`, a crash, a timeout), the database rolls back but the provider does not. The ledger and reality now disagree.
4. **Retries become dangerous.** A retried transaction would call the provider again: a double payout, unless the provider call is idempotent.

Instead: write the intent (a pending payout and an outbox event) inside a short transaction, call the provider after commit with an idempotency key, and record the result in a second transaction, with a compensating transaction if it failed (P4-07).

</details>

---

## 🏋️ Exercises

### Beginner (no code)

1. **Two refunds.** Amit has ₹300. Two ₹100 refunds arrive at once, and the code reads the balance, adds ₹100 in the app, and writes back. Draw the two-session timeline at Read Committed. What is the final balance?
   **Expected:** ₹400 instead of ₹500: a lost update loses Amit's money. **Verify:** reproduce it in two `psql` sessions with the lab schema.
2. **Pick the tool.** For each rule, choose from the decision flowchart: (a) stock never below zero, (b) one active subscription per user, (c) a merchant's total refunds today ≤ total sales today, (d) a coupon used once.
   **Expected:** (a) guarded `UPDATE`; (b) partial `UNIQUE` index; (c) Serializable or a lock on the merchant's row; (d) `UNIQUE` on redemptions or a guarded `UPDATE` on the coupon. **Verify:** compare with the "Tools for protecting a money rule" table.

### Intermediate (extend the lab)

3. **A counter row for the daily limit.** Add `wallet_daily_usage (wallet_id, day, used_minor, PRIMARY KEY (wallet_id, day))` and replace `dailyUsage` with a guarded upsert. Run the one-wallet benchmark at Read Committed.
   **Expected:** exactly 100 completed, 0 retries, throughput close to the `FOR UPDATE` design. **Verify:** "wallets over daily limit 0" in the benchmark output.
4. **Retry metrics.** Count retries by SQLSTATE and endpoint in `onRetry`, and log one line per exhausted transfer.
   **Expected:** the counts match the benchmark's `retries` column. **Verify:** run the hot-wallet scenario and compare.

### Advanced (failure injection and 10x)

5. **Coarse predicate locks on purpose.** Drop `transfers_by_source_day`, `ANALYZE`, and rerun the spread scenario at Serializable. Inside one transfer, list `SIReadLock` rows from `pg_locks`.
   **Expected:** a `relation`-level lock on `transfers` and many more retries than 9 to 15. **Verify:** recreate the index and watch the retries fall back.
6. **10x concurrency.** Run 2,000 concurrent transfers with pool sizes 20 and 50 on the hot-wallet scenario.
   **Expected:** a bigger pool does not raise throughput on hot rows; it raises conflicts and p95. **Verify:** compare retries, gave-up counts and p95; then explain why a queue in front of the database (P3-05) helps more than more connections.

---

## 📝 Quiz

1. Two sessions both read Amit's balance as 100000, and both write `balance_minor = 30000`. Which anomaly is this?
2. At Postgres's Read Committed, can two `SELECT`s in the same transaction return different values for the same row?
3. What is the lowest Postgres isolation level that stops write skew?
4. Which SQLSTATE means "serialization failure", and which means "deadlock detected"?
5. After a `40001`, what exactly should the application retry?
6. Why does `UPDATE ... WHERE balance_minor >= 70000` stay safe at Read Committed when two sessions run it at once?
7. In `psql`, what does a prompt like `ledger=!#` mean, and what does `COMMIT` do there?
8. `VACUUM VERBOSE` says "10000 are dead but not yet removable". What is the most likely cause?
9. Why is `pool.query("BEGIN")` a bug with node-postgres?
10. Why did Serializable need far more retries on tiny tables than on production-like data?

## 🔑 Quiz answer key

1. **Lost update.** Both computed from a stale read; the second write replaced the first.
2. **Yes.** Each statement takes a new snapshot, so commits made between your statements become visible (a non-repeatable read).
3. **Serializable.** Repeatable Read still allowed it: ₹14,000 against a ₹10,000 limit in the lab.
4. **`40001`** is `serialization_failure`; **`40P01`** is `deadlock_detected`.
5. **The whole transaction, from `BEGIN`,** including all its reads and decisions, with backoff and a cap.
6. **The second `UPDATE` waits for the row lock, then re-checks the `WHERE` clause on the newest committed version.** With 30000 left, the condition is false, so it updates zero rows.
7. **The transaction has failed**; every statement is ignored until it ends. `COMMIT` answers `ROLLBACK`; use `ROLLBACK TO SAVEPOINT` to recover part of it.
8. **An older transaction is still open** (often `idle in transaction`), and its snapshot might still need those versions. Find it in `pg_stat_activity`.
9. **Each `pool.query()` may use a different connection.** `BEGIN` leaves one pooled connection inside a transaction, and another request's statements can run inside it; in the lab, Amit's top-up was rolled back by Riya's `ROLLBACK`.
10. **On tiny tables the planner uses sequential scans, and a sequential scan takes a predicate lock on the whole table** (the reads cover only a few pages anyway). Every concurrent transfer then conflicts with every other: 670 to 1,050 retries, against 9 to 15.

---

## 📖 Glossary

| Term | Meaning |
|---|---|
| ACID | Atomicity, consistency, isolation, durability: the four guarantees of a database transaction. |
| Autocommit | Running each statement as its own transaction, without `BEGIN`. |
| Backoff with jitter | Waiting a random, growing time between retries so colliding clients spread out. |
| Dead tuple | An old row version no transaction can see any more. |
| Deadlock | Two transactions each waiting for a lock the other holds; Postgres aborts one with `40P01`. |
| Dirty read | Reading another transaction's uncommitted change. Never happens in Postgres. |
| First updater wins | Repeatable Read's rule: the second transaction to change a row fails with `40001`. |
| Guarded update | An `UPDATE` whose `WHERE` clause contains the business check, so check and change are one step. |
| HOT update | A heap-only-tuple update: no indexed column changed and the new version fits on the same page, so no index entries are added. |
| Idempotency key | A client-chosen ID that makes repeating a request safe (P1-03). |
| `idle in transaction` | A session that opened a transaction and is not running anything. |
| Isolation level | What a transaction may see of concurrent ones: Read Committed, Repeatable Read, Serializable. |
| Lost update | A write based on a stale read silently replacing another transaction's write. |
| MVCC | Multi-version concurrency control: updates create new row versions; snapshots pick which to see. |
| Non-repeatable read | The same row read twice in one transaction gives different values. |
| Outbox | A table written in the same transaction as the business change; a worker publishes its rows after commit (P4-07). |
| Phantom read | The same query run twice in one transaction returns different rows. |
| Predicate lock (`SIReadLock`) | Serializable's record of what a transaction read; it never blocks, it only detects conflicts. |
| Read Committed | Postgres's default level: a fresh snapshot per statement. |
| Repeatable Read | One snapshot per transaction (snapshot isolation in Postgres). |
| `RETURNING` | Makes `INSERT`, `UPDATE` or `DELETE` return the changed rows. |
| Savepoint | A point inside a transaction you can roll back to without losing everything. |
| Serializable (SSI) | Serializable Snapshot Isolation: Repeatable Read plus detection of read-write dependency cycles. |
| Snapshot | A frozen view of committed data at one moment. |
| SQLSTATE | The five-character error code Postgres returns, such as `40001`. |
| `VACUUM` | Removes dead tuples so their space can be reused; usually run by autovacuum. |
| WAL | Write-ahead log: changes are written here and flushed before `COMMIT` returns, which gives durability. |
| Write skew | Two transactions read overlapping data, write different rows, and together break a rule. |
| `xmin` / `xmax` / `ctid` | A row version's creating transaction, replacing transaction, and physical address. |

---

## 🧾 Cheat sheet

**Diagram: transactions and isolation on one screen**

```mermaid
mindmap
  root((Transactions))
    ACID
      atomic within one database
      constraints are your consistency
    Anomalies
      lost update
      write skew
      phantom and non repeatable read
    Postgres levels
      Read Committed is the default
      Repeatable Read is one snapshot
      Serializable aborts with 40001
    Tools
      guarded UPDATE
      FOR UPDATE row lock
      UNIQUE and CHECK constraints
      Serializable with retry
    Operations
      short transactions
      no network calls inside
      timeouts on every pool
      watch idle in transaction
```

**How to read this diagram.** Five branches: what a transaction promises, the bugs to name, the levels that stop them, the tools that protect a rule, and how to run it in production. Use it as a review checklist.

**Rules**
1. Name the rule, name the anomaly that breaks it, then pick the cheapest tool.
2. A single-row rule is one guarded statement: `... WHERE balance_minor >= $1 RETURNING ...`. Keep a `CHECK` as backup.
3. Read Committed allows lost updates and write skew; Repeatable Read stops lost updates but not write skew; Serializable stops both.
4. At Repeatable Read or Serializable, always retry the **whole** transaction on `40001` (and `40P01`), with jitter and a cap.
5. Retried code has no side effects; money endpoints are idempotent.
6. One transaction = one client. Never `pool.query("BEGIN")`.
7. No network calls inside a transaction. Outbox inside, provider outside.
8. Touch rows in a fixed order to avoid deadlocks.
9. Set `statement_timeout`, `lock_timeout`, `idle_in_transaction_session_timeout` on every pool.
10. Watch `idle in transaction` and the oldest `xact_start`; long transactions block `VACUUM`.

---

## ☑️ Completion checklist

- [ ] I can explain each ACID letter, and what it does not promise, without notes.
- [ ] Lab run on my machine: lost update and write skew reproduced in two `psql` sessions.
- [ ] Numbers filled in, Measure 1: whether each anomaly reproduces at Read Committed, Repeatable Read and Serializable.
- [ ] Numbers filled in, Measure 2: retries and throughput at Serializable under 200 concurrent transfers, for spread-out and hot wallets.
- [ ] The transfer service and `withRetry` pass their tests, including the concurrent daily-limit test.
- [ ] I saw a held lock in `pg_locks`, a blocker in `pg_blocking_pids()`, and "dead but not yet removable" in `VACUUM VERBOSE`.
- [ ] I can give the 2-minute "double spending" answer and handle the five follow-ups.
- [ ] Phase 2 gate: my ledger API protects every money rule with a named tool, retries `40001` safely, and has time limits on every pool.
- [ ] Post published.

---

## 📣 Learn in public

**Post 1: ₹1,400 from a ₹1,000 wallet**
- **Problem:** Two concurrent ₹700 withdrawals on Postgres's default isolation level both succeeded. Balance after: ₹[your number].
- **Decision:** Replaced "read balance, check in code, write back" with one guarded `UPDATE ... WHERE balance >= amount RETURNING`.
- **Result:** The second withdrawal now gets `UPDATE 0` and a clean "insufficient funds", with no retries and no errors.
- **Lesson:** A transaction alone does not stop a lost update at Read Committed. Put the check inside the statement.

**Post 2: Repeatable Read did not save our daily limit**
- **Problem:** Two ₹5,000 withdrawals from two wallets both passed a ₹10,000 daily-limit check. Total today: ₹[your number], at Read Committed and at Repeatable Read.
- **Decision:** Ran the transfer at Serializable with a `40001` retry loop, and compared it with a `SELECT ... FOR UPDATE` on the wallet.
- **Result:** Both kept the limit; Serializable needed [your number] retries for 200 transfers on one wallet, the row lock needed 0.
- **Lesson:** Write skew needs Serializable or a single row everyone locks. Name the anomaly before choosing the level.

**Post 3: 1,000 retries for 200 transfers, and why it was our test data**
- **Problem:** Serializable on a fresh dev database retried [your number] times for 200 transfers on different wallets.
- **Decision:** Looked at `pg_locks` (`SIReadLock`) and found whole-table predicate locks from sequential scans; reran on production-like volume with fresh statistics.
- **Result:** Retries fell to [your number].
- **Lesson:** Load-test Serializable on realistic data. Predicate locks follow your query plans.

**Hinglish video idea: "Ek account, do ATM: ₹1,000 mein ₹1,400 kaise nikle?"**
Two terminals side by side, A aur B. Pehle Read Committed pe lost update live dikhao, phir same steps Repeatable Read pe: `40001` error. Phir daily-limit wala write skew, jo Repeatable Read pe bhi ho jaata hai, aur Serializable pe pakda jaata hai. End mein ek guarded `UPDATE` se pura problem ek line mein fix. Hook line: "Transaction lagaya, phir bhi paisa gayab? Isolation level ka khel hai."

---

## ➡️ Next cards

- **P2-04 · Concurrency control:** this card used `SELECT ... FOR UPDATE` and ordered updates as the alternative to Serializable. Next: row lock modes, `SKIP LOCKED` for job queues, optimistic locking with version columns, deadlock detection, and advisory locks.
- **P4-04 · Consistency models, CAP and PACELC:** Serializable is a guarantee about transactions on one database. Next: what changes with replicas and many nodes, such as linearizability, read-your-writes, and why a replica can show a balance that is a few milliseconds old.
- **P4-07 · Consistency across services: outbox, CDC, sagas, CQRS:** atomicity stops at the database edge. The payout outbox in this card's mistakes section, and compensating transactions instead of rollbacks, are the starting point.

---

## 🔗 Sources and further reading

Checked on 23 Oct 2026.

- [Transaction Isolation](https://www.postgresql.org/docs/current/transaction-iso.html) (PostgreSQL 18 docs): the levels, the anomaly table, error messages, Serializable performance tips
- [Serialization Failure Handling](https://www.postgresql.org/docs/current/mvcc-serialization-failure-handling.html) (PostgreSQL docs): which SQLSTATEs to retry, and retrying the whole transaction
- [MVCC introduction](https://www.postgresql.org/docs/current/mvcc-intro.html) and [Explicit Locking](https://www.postgresql.org/docs/current/explicit-locking.html) (PostgreSQL docs)
- [SET TRANSACTION](https://www.postgresql.org/docs/current/sql-set-transaction.html) (PostgreSQL docs)
- [pg_locks](https://www.postgresql.org/docs/current/view-pg-locks.html) (PostgreSQL docs)
- [Routine Vacuuming](https://www.postgresql.org/docs/current/routine-vacuuming.html) (PostgreSQL docs)
- [Client Connection Defaults](https://www.postgresql.org/docs/current/runtime-config-client.html) (PostgreSQL docs): `statement_timeout`, `lock_timeout`, `idle_in_transaction_session_timeout`, `transaction_timeout`, `default_transaction_isolation`
- [Hot Standby](https://www.postgresql.org/docs/current/hot-standby.html) (PostgreSQL docs): query conflicts on replicas, `max_standby_streaming_delay`, `hot_standby_feedback`
- [pgbench](https://www.postgresql.org/docs/current/pgbench.html) (PostgreSQL docs)
- [PostgreSQL versioning policy](https://www.postgresql.org/support/versioning/): supported versions and end-of-life dates
- [SSI on the PostgreSQL wiki](https://wiki.postgresql.org/wiki/SSI): worked examples of Serializable Snapshot Isolation
- [node-postgres: Transactions](https://node-postgres.com/features/transactions)
- [Drizzle ORM: Transactions](https://orm.drizzle.team/docs/transactions)
- [Prisma ORM 7: Transactions](https://www.prisma.io/docs/orm/v7/prisma-client/queries/transactions) and [Prisma ORM 8 (release candidate): Transactions](https://www.prisma.io/docs/orm/prisma-client/queries/transactions); [Prisma release status](https://www.prisma.io/docs/orm/release-status)
- [Hermitage](https://github.com/ept/hermitage): tests of isolation levels across many databases, including Postgres and MySQL
