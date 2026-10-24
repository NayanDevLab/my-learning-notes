# P1-07 · Testing backends

| | |
|---|---|
| **Phase** | 1 · Backend foundations |
| **Prerequisites** | P1-03 · REST API design |
| **Leads to** | P2-04 · Concurrency control · P5-04 · Feature flags |
| **Repo path** | `system-design/phase-1/p1-07-testing-backends.md` |

**After this card you can:**

1. Pick a test shape for a backend, and explain why integration tests on real Postgres and Redis carry most of the value.
2. Build an integration suite with Testcontainers where every test is isolated and data comes from factories, not hand-written fixtures.
3. Prove that idempotency and locking hold under 50 parallel requests, and show that the same test fails when the fix is removed.
4. Write fast-check properties for ledger invariants, and read a shrunk counterexample.
5. Judge any test suite, including one an AI wrote, by its mutation score instead of its line coverage.

> **About the numbers in this guide.** Everything marked **Real output** was run while writing this guide on 14 Oct 2026, on a 2-vCPU Linux sandbox with Node 22.22.0, PostgreSQL 16.15 and Redis 7.0.15. The lab itself targets `postgres:18` and `redis:8`. To run the P2-01 migrations on PostgreSQL 16, `uuidv7()` was swapped for `gen_random_uuid()` and nothing else was changed. The sandbox had no Docker daemon, so the Testcontainers start-up path was **not** run. The same suites ran through the CI path instead, which reads database and Redis URLs from environment variables. Everything marked **Expected** was not run.
>
> **Versions** (checked on npm and GitHub, 14 Oct 2026): Vitest 5.0.4, fast-check 4.10.2, StrykerJS 10.0.0, Testcontainers for Node 12.2.1, Pact JS 17.1.4, supertest 7.3.1, Fastify 5.12.7, node-postgres 8.23.1, ioredis 6.0.0, Ajv 8.20.0, TypeScript 6.0.3 (7.0.2 is `latest`, but see Deep dive 9), actions/checkout v7, actions/setup-node v7, actions/cache v6, actions/upload-artifact v7.

---

## 🧭 The concept in one minute

A **test** is a small program that runs your code and checks one behaviour. A **test suite** is the list of behaviours your team has promised to keep working.

**One line:** tests let you change money-moving code quickly, because a machine re-checks every promise in seconds.

**Analogy.** Indian Railways does not judge a new train only by checking each coach in the yard. Each coach is inspected on its own (unit tests). The coaches are coupled and run on a real track (integration tests). The doors must line up with every platform on the route (contract tests). A full Mumbai to Pune trial run happens rarely, because it is slow and costly (end-to-end tests). Most problems show up at the couplings and on the track, not inside one coach. A backend is the same. Most bugs live where your code meets Postgres, Redis and HTTP.

**On the ledger platform.** Riya sends ₹500 to Amit. The tests prove four things: the fee is right to the paisa, the ledger entries sum to zero, the response matches the OpenAPI contract, and 50 nervous taps on "Pay" move the money exactly once.

**Why this matters more with AI.** An AI agent can write a 200-line change in a minute. Your tests are the spec that change is checked against. If the tests are weak, wrong code gets through at AI speed.

---

## 🔥 The problem it solves

Here is the ledger platform with the kind of tests teams often have. Every number below was measured while writing this guide.

1. **"We have 100% coverage."** An AI assistant wrote 9 tests for the fee and ledger module. Every line ran, so line coverage was **100%**. Then Stryker made 88 small changes to the code. It removed the ₹25 fee cap, flipped debits and credits, and deleted the loop that updates balances. The tests failed for only 55 of the 88 changes. **33 real bugs would have shipped with a green build.**
2. **"The mocks say it works."** Three repository functions passed their tests against a mocked database. On real Postgres all three failed. `balanceMinor` came back as the string `"150000"`. An `ON CONFLICT` clause matched no unique constraint. A ₹0 fee line broke a `CHECK` constraint.
3. **"It worked when I tapped once."** We sent 50 parallel copies of one ₹500 transfer to real Postgres. The code checked for the idempotency key and then inserted (check-then-act). **44 transfers were applied.** Amit received ₹22,000 from a wallet that held ₹1,000. The bug showed up in 20 out of 20 rounds.
4. **"It passes on my machine."** One test depended on state left behind by another. It passed 20 out of 20 times in file order. In shuffled order it failed 11 out of 20 times.

This card fixes all four. You will write integration tests on real dependencies, concurrency tests that check the database, property tests for invariants, and mutation tests that check the tests themselves. Then CI runs all of it on every pull request.

---

## 📚 Before you start

**Prerequisite card:** P1-03 · REST API design. You need its transfer endpoint, idempotency keys, Problem Details errors and `openapi.yaml`.

**Also used, but not required:** the P2-01 schema (wallets, balances, transfers, ledger entries), the P1-05 auth helpers and the P1-06 typed config. The guide says where each one comes in. P1-03 promised that "`test/helpers/db.ts` resets the schema (P1-07)". This card builds that helper properly.

**Key terms**

| Term | Plain meaning |
|---|---|
| Test suite | All the tests of a project, run together. |
| Unit test | Tests one function or class with no I/O (no database, no network). It runs in milliseconds. |
| Integration test | Tests your code together with real dependencies such as Postgres and Redis. |
| HTTP-level test | Sends an HTTP request (method, URL, headers, body) into the app and checks the response. |
| Contract test | Checks that two sides agree on message shapes, for example that responses match `openapi.yaml`. |
| End-to-end (E2E) test | Drives the whole deployed system, often through the UI. Slow and fragile, so keep only a few. |
| Test double | A stand-in for a real dependency: a stub, mock, fake or spy (Deep dive 6). |
| Fixture, factory | Test data. A factory is a function that builds valid rows with sensible defaults. |
| Isolation | One test cannot see or change another test's data. |
| Flaky test | A test that sometimes passes and sometimes fails with no code change. |
| Property | A rule that must hold for every input, for example "ledger entries sum to zero". |
| Shrinking | After a random input fails, the tool searches for the smallest input that still fails. |
| Mutant | A copy of your code with one small change, for example `<` changed to `<=`. |
| Mutation score | The percentage of mutants that made at least one test fail ("killed"). |
| Coverage | The percentage of lines or branches that ran during the tests. It says nothing about what was checked. |
| CI | Continuous integration: a server builds and tests the code on every push or pull request. |
| Service container | A Docker container (for example Postgres) that GitHub Actions starts next to a CI job. |
| Testcontainers | A library that starts throwaway Docker containers from test code. |

---

## 🧠 How it works

### Mental model: buy the most confidence per minute

Every test has a cost: time to write it, time to run it, and time to fix it when it breaks for a silly reason. Every test also buys confidence that some behaviour still works. Kent C. Dodds frames the testing trophy as exactly this trade: confidence is the return, and time is the investment.

On a backend, confidence comes cheapest from three places:

- **Pure rules** (fees, ledger rules, validation) are cheap to test thoroughly with unit and property tests.
- **Code that touches Postgres, Redis or HTTP** is where most real bugs live: SQL, types at the boundary, transactions, constraints and serialisation. Only real dependencies test this honestly.
- **Promises to other teams** (the API contract) are tested by checking real responses against the spec.

A React comparison: you would not trust a component test that mocks React itself. Mocking Postgres in a backend test is the same mistake. The database is not an outside detail; it is half of your program.

### Diagram: the test shape for a backend

**Diagram: the ledger platform's test trophy (area = share of effort and confidence, not number of tests)**

```text
             ┌───────────────────────┐
             │    E2E smoke (few)    │
       ┌─────┴───────────────────────┴─────┐
       │       Contract (every route)      │
┌──────┴───────────────────────────────────┴──────┐
│               Integration + HTTP +              │
│              concurrency (the most)             │
└──────┬───────────────────────────────────┬──────┘
       │       Unit + property (many)      │
       └─────┬───────────────────────┬─────┘
             │   Static: tsc + lint  │
             └───────────────────────┘
```

**How to read this diagram.** Read it from the bottom up. Static checks (TypeScript in strict mode, lint) run on every save and catch typos for free. Unit and property tests cover the pure fee and ledger rules: many small, fast tests. The widest band is integration: requests go through the real Fastify app into real Postgres and Redis, including parallel-request tests. Contract checks sit on top of those same HTTP tests, so every response is checked against `openapi.yaml`. A handful of end-to-end smoke tests run against staging.

**Diagram: what each layer runs against**

```mermaid
flowchart TD
  subgraph few["Few, slow"]
    E2E["E2E smoke on staging<br/>sign in, pay, statement"]
  end
  subgraph most["Most of the value"]
    CON["Contract checks<br/>every response vs openapi.yaml"]
    INT["Integration and HTTP<br/>app.inject, real Postgres, Redis"]
    CONC["Concurrency<br/>50 parallel requests"]
  end
  subgraph many["Many, fast"]
    UNIT["Unit and property<br/>fees and ledger rules"]
    STAT["Static checks<br/>tsc strict, lint"]
  end
  E2E --> CON
  CON --> INT
  INT --> CONC
  CONC --> UNIT
  UNIT --> STAT
```

**How to read this diagram.** Each box is one kind of test, and the second line says what it runs against. Only the bottom group runs without any real dependency. The middle group, where most of the suite lives, always talks to a real database. The arrows go from slow and broad to fast and narrow. When a broad test fails, a narrower test below it should tell you exactly why.

### Diagram: how the test infrastructure fits together

```mermaid
flowchart TD
  GS["globalSetup, once per run<br/>start or reuse Postgres, Redis"]
  MIG["Migrate ledger_template<br/>P2-01 migrations"]
  PG[("Postgres 18<br/>ledger_template")]
  RD[("Redis 8")]
  subgraph workers["Test workers, in parallel"]
    W1["Worker 1<br/>database ledger_test_w1"]
    W2["Worker 2<br/>database ledger_test_w2"]
  end
  GS --> MIG
  MIG --> PG
  GS --> RD
  PG -->|"clone per file,<br/>truncate per test"| W1
  PG -->|"clone per file,<br/>truncate per test"| W2
  RD --> W1
  RD --> W2
```

**How to read this diagram.** `globalSetup` runs once, before any test. It either starts throwaway Postgres and Redis containers (on your laptop) or uses the ones CI already started. It migrates one database, `ledger_template`. Each worker process then clones its own database from that template before every test file, and empties the tables before every test. Workers run in parallel without seeing each other's rows, and each test starts from a known, empty state.

---
## 🔬 Deep dive

One subsection per item on the card, in the card's order.

### 1. Test shapes: the pyramid vs the trophy

**What it is.** A test shape is a picture of how much of each kind of test you write.

- **The test pyramid** (Mike Cohn; made popular by Martin Fowler) puts many unit tests at the bottom, fewer service tests in the middle and very few UI tests on top. The idea: fast, cheap tests should be the majority.
- **The testing trophy** (Kent C. Dodds) puts static checks at the bottom, then unit tests, then a **wide integration layer**, then a few E2E tests. It grew out of Guillermo Rauch's line from December 2016: *"Write tests. Not too many. Mostly integration."*

**Why integration tests carry most of the value in a backend.** Look at what a typical handler does: parse the request, check the user, run two or three queries, map rows to JSON, send a response. Most of that is glue between your code and other systems. If you unit test the glue with a mocked database, you only re-check your own guesses about how Postgres behaves. The bugs that hurt in production sit exactly in those guesses:

- SQL that is wrong, or that matches no index or constraint.
- Types that change at the boundary (`bigint` comes back from node-postgres as a string).
- Transactions, locks and constraints that only the real database enforces.
- Races that only appear with real parallel connections.

Twenty years ago a real database in tests was slow and painful, which pushed teams towards the pyramid. Testcontainers changed that. A Postgres container starts in seconds once per run, and each test then costs milliseconds.

**When the pyramid is still right.** Code that is mostly pure logic, like a pricing engine, tax rules or ledger maths, deserves many unit and property tests. The ledger platform uses both shapes: its pure domain core is pyramid-shaped (Deep dive 2 and 8) and everything around it is trophy-shaped.

| Shape | Biggest layer | Good for | Risk |
|---|---|---|---|
| Pyramid | Unit | Logic-heavy code; places where real dependencies are slow to start | Mock-heavy tests pass while the real integration is broken |
| Trophy | Integration | Web backends and apps, where most code is glue | Slow, leaky suites if isolation is poor (Deep dive 3) |
| Ice-cream cone (an anti-pattern) | Manual and E2E | Nothing | Slow, flaky, and bugs are found late |

**Trade-off.** Integration tests are slower than unit tests (milliseconds instead of microseconds) and need Docker. In return, one integration test checks SQL, types, constraints and transactions together. Measured here, 38 unit and integration tests together took 2.76 s in Vitest.

### 2. Unit tests: pure domain logic with Vitest

**What it is.** A unit test calls one function with no I/O and checks the exact result. On the ledger platform, the fee rules (`src/domain/fees.ts`) and the double-entry rules (`src/domain/ledger.ts`) are pure functions: data in, data out, no database. That design is deliberate. It is often called *functional core, imperative shell*. The core decides; the shell (the transfer service) loads balances, calls the core and writes rows.

**Minimal version:** `minimal/fee.test.ts`. One pure function and a table of cases. Run it with `npx vitest run minimal/fee.test.ts`.

```ts
// The smallest useful unit test: one pure function, a table of cases, exact expected values.
import { expect, it } from "vitest";

// Payout fee: 0.5% of the amount, rounded up, at least ₹2 (200 paise), at most ₹25 (2,500 paise).
const payoutFee = (amountMinor: number) => Math.min(2_500, Math.max(200, Math.ceil((amountMinor * 50) / 10_000)));

it.each([
  [1_00_000, 500], // ₹1,000 -> ₹5
  [1_000, 200], // below the minimum
  [40_001, 201], // just above the minimum: 200.005 rounds up
  [5_00_001, 2_500], // just above the maximum: capped
])("fee(%i) = %i", (amount, expected) => {
  expect(payoutFee(amount)).toBe(expected);
});
```

**Real output**

```text
 ✓ minimal/fee.test.ts > fee(100000) = 500 2ms
 ✓ minimal/fee.test.ts > fee(1000) = 200 1ms
 ✓ minimal/fee.test.ts > fee(40001) = 201 0ms
 ✓ minimal/fee.test.ts > fee(500001) = 2500 0ms
      Tests  4 passed (4)
```

**What to notice**
- `it.each` turns a table of cases into separate tests. Each row is one business rule or one boundary.
- The expected values are worked out **by hand** from the rule, not by calling the code. A test that computes its expected value with the same function can never fail.
- The rows sit right next to the limits: `40_001` is one paisa above the point where the ₹2 minimum stops applying.

**Rules for good unit tests**

1. **Test boundaries:** just below, at, and just above every limit (₹2 minimum at ₹400, ₹25 cap at ₹5,000).
2. **Assert exact values** with `toBe` and `toEqual`. `toBeDefined()` and `toBeGreaterThan(0)` let almost any bug through (Deep dive 9 has the numbers).
3. **Assert error codes**, not just "it throws". Clients switch on `INSUFFICIENT_FUNDS`, so a wrong code is a bug.
4. **Keep I/O out.** If a function needs the time, a random id or a network call, pass it in. Then the test controls it.
5. **One reason to fail.** A test name should say the rule, for example "rejects one paisa short with INSUFFICIENT_FUNDS".

**When not to unit test.** Do not unit test glue, such as a handler that only calls a repository. Test it at the HTTP level with a real database (Deep dive 4).

The full product module and its tests are in **Hands-on lab, step 1**.

### 3. Integration tests: Testcontainers, isolation and factories

**What it is.** An integration test runs your code against real Postgres and Redis. **Testcontainers** starts them as throwaway Docker containers from your test code. It waits until each one is ready and gives you its address. A small reaper container removes everything if your test process crashes.

**Minimal version:** `minimal/testcontainers-hello.ts`. Docker must be running.

```ts
// Start a real Postgres in Docker, run one query, throw the container away.
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";

const container = await new PostgreSqlContainer("postgres:18-alpine").start(); // pulls the image on first use
try {
  const client = new pg.Client({ connectionString: container.getConnectionUri() });
  await client.connect();
  const { rows } = await client.query<{ version: string }>("SELECT version()");
  console.log(rows[0]?.version);
  await client.end();
} finally {
  await container.stop(); // Testcontainers' reaper also cleans up if this process crashes
}
```

**Expected output** (not run here, because the sandbox has no Docker daemon): one line such as `PostgreSQL 18.x on x86_64-pc-linux-musl, compiled by gcc ...`. The first run is slower because Docker pulls the image.

**Why a real database at all? The same three tests, against a mock and against Postgres.** `demo/mock-vs-real/repo.ts` holds repository code as an assistant first wrote it. It type-checks, and each function has one real SQL bug.

```ts
// Repository code as an AI assistant first wrote it. It type-checks. Each function has one real SQL bug.
import type { QueryResult, QueryResultRow } from "pg";

export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<R>>;
}

export async function getWalletBalance(db: Queryable, walletId: string) {
  const { rows } = await db.query<{ wallet_id: string; balance_minor: number }>(
    "SELECT wallet_id, balance_minor FROM wallet_balances WHERE wallet_id = $1",
    [walletId],
  );
  const row = rows[0];
  return row ? { walletId: row.wallet_id, balanceMinor: row.balance_minor } : null;
}

export async function claimIdempotencyKey(db: Queryable, tenantId: string, clientId: string, key: string) {
  const { rowCount } = await db.query(
    `INSERT INTO idempotency_keys (tenant_id, client_id, key) VALUES ($1, $2, $3)
     ON CONFLICT (client_id, key) DO NOTHING`,
    [tenantId, clientId, key],
  );
  return rowCount === 1;
}

export interface EntryRow { transferId: number; accountId: string; direction: "debit" | "credit"; amountMinor: number }
export async function saveEntries(db: Queryable, entries: readonly EntryRow[]) {
  for (const e of entries) {
    await db.query(
      "INSERT INTO ledger_entries (transfer_id, account_id, direction, amount_minor) VALUES ($1, $2, $3, $4)",
      [e.transferId, e.accountId, e.direction, e.amountMinor],
    );
  }
}
```

`demo/mock-vs-real/repo.test.ts` runs the same tests twice with `describe.each`: once with a mocked `query()`, once with a real pool.

```ts
// The SAME three tests, run once against a mock and once against real Postgres.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { claimIdempotencyKey, getWalletBalance, saveEntries, type Queryable } from "./repo.js";

const mockDb: Queryable = {
  query: vi.fn(async (sql: string) =>
    sql.startsWith("SELECT")
      ? { rows: [{ wallet_id: "w_riya", balance_minor: 150_000 }], rowCount: 1 }
      : { rows: [], rowCount: 1 },
  ) as unknown as Queryable["query"],
};

const realDb = new pg.Pool({ connectionString: process.env.DATABASE_URL });
beforeAll(async () => {
  await realDb.query(`
    DROP TABLE IF EXISTS wallet_balances, idempotency_keys, ledger_entries;
    CREATE TABLE wallet_balances (wallet_id text PRIMARY KEY, balance_minor bigint NOT NULL CHECK (balance_minor >= 0));
    CREATE TABLE idempotency_keys (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      tenant_id text NOT NULL, client_id text NOT NULL, key text NOT NULL, UNIQUE (tenant_id, client_id, key));
    CREATE TABLE ledger_entries (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, transfer_id bigint NOT NULL,
      account_id text NOT NULL, direction text NOT NULL, amount_minor bigint NOT NULL CHECK (amount_minor > 0));
    INSERT INTO wallet_balances VALUES ('w_riya', 150000);`);
});
afterAll(() => realDb.end());

describe.each([
  ["mocked db", mockDb],
  ["real Postgres", realDb],
])("%s", (_name, db) => {
  it("reads Riya's balance as a number", async () => {
    expect(await getWalletBalance(db, "w_riya")).toEqual({ walletId: "w_riya", balanceMinor: 150_000 });
  });
  it("claims a new idempotency key", async () => {
    expect(await claimIdempotencyKey(db, "t1", "app-android", "k-0001")).toBe(true);
  });
  it("saves the entries of a p2p transfer", async () => {
    // From a builder bug: a ₹0 fee line slipped in (the `feeMinor >= 0` mutant from the Stryker run).
    await saveEntries(db, [
      { transferId: 1, accountId: "w_riya", direction: "debit", amountMinor: 5_000 },
      { transferId: 1, accountId: "w_amit", direction: "credit", amountMinor: 5_000 },
      { transferId: 1, accountId: "platform:fee_revenue", direction: "credit", amountMinor: 0 },
    ]);
  });
});
```

**Real output**

```text
 ✓ repo.test.ts > mocked db > reads Riya's balance as a number 3ms
 ✓ repo.test.ts > mocked db > claims a new idempotency key 1ms
 ✓ repo.test.ts > mocked db > saves the entries of a p2p transfer 0ms
 × repo.test.ts > real Postgres > reads Riya's balance as a number 14ms
 × repo.test.ts > real Postgres > claims a new idempotency key 4ms
 × repo.test.ts > real Postgres > saves the entries of a p2p transfer 12ms

 FAIL  repo.test.ts > real Postgres > reads Riya's balance as a number
-   "balanceMinor": 150000,
+   "balanceMinor": "150000",
 FAIL  repo.test.ts > real Postgres > claims a new idempotency key
error: there is no unique or exclusion constraint matching the ON CONFLICT specification
 FAIL  repo.test.ts > real Postgres > saves the entries of a p2p transfer
error: new row for relation "ledger_entries" violates check constraint "ledger_entries_amount_minor_check"
      Tests  3 failed | 3 passed (6)
```

**What to notice**
- **Bug 1:** node-postgres returns `bigint` as a string. The mock returned a number because the person who wrote the mock believed it would.
- **Bug 2:** the unique constraint is on `(tenant_id, client_id, key)`, but the code says `ON CONFLICT (client_id, key)`. Postgres needs the conflict target to match a real unique index or constraint exactly.
- **Bug 3:** a ₹0 fee line, the same bug as one of the Stryker survivors in step 6. The database's `CHECK (amount_minor > 0)` stopped it. A mock has no constraints.
- The mock passed all three, so it tested nothing except the mock.

**Isolation: the hard part.** Real dependencies are easy now. Keeping tests from seeing each other's data is the part that needs design. There are five common strategies:

| Strategy | How it works | Cost | Works when the app commits its own transactions? | Use it for |
|---|---|---|---|---|
| Roll back | Each test runs inside `BEGIN ... ROLLBACK` on one client | Cheapest | No: the app's `COMMIT` ends the test's transaction | Repository functions that accept a client |
| Truncate | `TRUNCATE` every table except reference data before each test | Milliseconds | Yes | HTTP and concurrency tests |
| Database per worker | `CREATE DATABASE ... TEMPLATE ledger_template` for each worker | Tens of ms per file | Yes | The base layer under everything |
| Snapshot and restore | Testcontainers' `snapshot()` and `restoreSnapshot()` | Slower per test | Yes | Data you cannot simply truncate |
| Unique data | Random keys per test and no cleanup | Free | Yes | Redis keys, append-only data |

The ledger suite stacks three of these:

1. **One database per worker**, cloned from a migrated template before each test file (`test/helpers/workerDatabase.ts`). Files running in parallel cannot collide.
2. **Truncate before each test** for tests that go through the app (`truncateAll`). `currencies` is kept because it is reference data seeded by a migration. The P2-01 append-only triggers fire on `UPDATE` and `DELETE`, not on `TRUNCATE`, so truncation works on those tables.
3. **Roll back** for repository tests (`withRollback`), which are the fastest.

**A gotcha you will meet with roll-back isolation.** Inside one transaction, `now()` returns the **same** time for every statement. So every row a test creates gets the same `created_at`. This is a feature, not a problem: it found a real pagination bug (below).

**Data factories instead of fixtures.** A fixture file is a big SQL dump that every test shares. Change one row and unrelated tests break. A **factory** is a function that builds one valid row with sensible defaults. The test overrides only what it cares about:

```ts
const { riya, amit } = await makeRiyaAndAmit(tx, 1_00_000); // Riya has ₹1,000, Amit has ₹0, same tenant
await makeCompletedTransfer(tx, riya, amit, 500);
```

Factories make unique values (emails, slugs, keys) from a counter plus the worker id, so parallel workers never clash. Be honest about shortcuts. `makeWallet` writes an opening balance with no ledger entries behind it, and its comment says so. A reconciliation test must fund wallets through real transfers instead.

**Real output** — the integration project, run through the CI path against Postgres and Redis:

```text
 ✓ |integration| test/integration/entryRepository.test.ts > listWalletEntries > walks every entry exactly once across pages, even when created_at ties
 ✓ |integration| test/integration/entryRepository.test.ts > listWalletEntries > returns an empty page and no cursor for a wallet with no entries 10ms
 ✓ |integration| test/integration/attemptLimiter.test.ts > attempt limiter > allows 5 wrong OTPs and blocks the 6th 13ms
 ✓ |integration| test/integration/attemptLimiter.test.ts > attempt limiter > starts the window on the first attempt and never extends it 1ms
 ✓ |integration| test/integration/isolation.test.ts > first test can register riya@kirana.test 55ms
 ✓ |integration| test/integration/isolation.test.ts > second test can register riya@kirana.test 47ms
      Tests  6 passed (6)
   Duration  1.87s (setup 52%, tests 26%, import 11%, transform 9%, worker 2%)
```

**Two real bugs this layer caught while the guide was being written.**

1. **In the test helper itself.** The first version of the transfer factory used `$3` both as text and as `$3::bytea`. Postgres refused: `error: inconsistent types deduced for parameter $3` (SQLSTATE `42P08`, detail `bytea versus text`). The fix was `sha256(convert_to($3, 'UTF8'))`. A mocked `query()` would have accepted that SQL happily.
2. **In a pagination query.** A version of `listWalletEntries` that sorts and pages by `created_at` only (no `id` tie-breaker) failed the tie test:

```text
     × walks every entry exactly once across pages, even when created_at ties 49ms
AssertionError: expected [ 100, 200 ] to deeply equal [ 500, 400, 300, 200, 100 ]
```

All five entries shared one `created_at`. The first page returned two of them in no particular order. The cursor then said "older than this time", which excluded the other three. This exact bug ships in many real APIs, and only real data with real ties finds it.

**Trade-off.** You need Docker locally and in CI, and the first run pulls images. Here the whole integration project took 1.87 s, and about half of that was setup: migrating the template and cloning databases. On a laptop, starting the containers adds a few seconds more (**Expected**; measure yours in the lab).

### 4. HTTP-level tests: `app.inject` or supertest

**What it is.** An HTTP-level test sends a request through the whole app: routing, auth hooks, Zod validation, the handler, the error handler and serialisation. Then it checks the status, headers and body, and the database side-effects.

- **`app.inject()`** is built into Fastify (it uses the light-my-request library). It fakes the HTTP request inside the process. No port is opened, so it is fast and cannot clash with another test's port.
- **supertest** sends real HTTP to a real listening server. With Fastify you call `await app.ready()` and pass `app.server`.

**Minimal version:** `minimal/inject-vs-supertest.ts`

```ts
// The same request, two ways: Fastify's inject (no socket) and supertest (real HTTP on a random port).
import Fastify from "fastify";
import request from "supertest";

const app = Fastify();
app.get("/v1/health", async () => ({ status: "ok" }));

const injected = await app.inject({ method: "GET", url: "/v1/health" });
console.log("inject:   ", injected.statusCode, injected.json());

await app.ready(); // supertest needs the underlying Node server
const viaHttp = await request(app.server).get("/v1/health");
console.log("supertest:", viaHttp.status, viaHttp.body);
await app.close();
```

**Real output**

```text
inject:    200 { status: 'ok' }
supertest: 200 { status: 'ok' }
```

| | `app.inject` | supertest |
|---|---|---|
| Network socket | None | Real, on a random port |
| Speed | Fastest | A little slower |
| Works with | Fastify only | Any Node HTTP server (Express, Nest, Fastify) |
| Tests the real socket layer (keep-alive, `headersTimeout`) | No | Yes |
| Use on this platform | Default for every route test | Socket-level behaviour, such as P1-06's request limits |

**What an HTTP test should assert:**

1. The status code, and the headers that matter (`Location`, `Idempotent-Replayed`, `Retry-After`).
2. The body, checked against the spec (Deep dive 5).
3. The **database** afterwards. A 201 with no row in `transfers` is a bug, and only a query finds it.

The product tests for `POST /v1/transfers` are in **Hands-on lab, step 3**.

### 5. Contract tests: OpenAPI validation and Pact

A contract is a promise about message shapes between two sides. There are two styles.

**a) Provider-side: validate every response against `openapi.yaml`.** In P1-03 the spec came first. Here, every HTTP test passes its response to `expectMatchesSpec`. That helper looks up the documented response for the method, path and status, and validates the body with Ajv. Ajv is a JSON Schema validator, and OpenAPI 3.1 schemas are JSON Schema 2020-12. Two failures are caught: an **undocumented status** (the handler returned 500 or 418 and the spec does not mention it) and a **body that does not match the schema**.

Here is the classic bug this catches. node-postgres returns `bigint` columns as **strings**, because a JavaScript number cannot hold every 64-bit integer. A mapper that forgets `Number(...)` sends `"balanceMinor": "150000"`. The TypeScript row type said `number`, so `tsc` is happy. Then the Android app adds a top-up and gets string concatenation: `"150000" + 500` is `"150000500"`.

**Minimal version:** a two-route slice of the API, reading from real Postgres. `castBigint` switches the bug on and off.

```ts
// A two-route slice of the ledger API, reading from real Postgres.
import Fastify from "fastify";
import type { Pool } from "pg";

export function buildApp(db: Pool, opts: { castBigint: boolean }) {
  const app = Fastify();
  app.get<{ Params: { walletId: string } }>("/v1/wallets/:walletId", async (req, reply) => {
    const { rows } = await db.query<{ id: string; currency: string; balance_minor: string; status: string }>(
      "SELECT id, currency, balance_minor, status FROM wallets WHERE id = $1",
      [req.params.walletId],
    );
    const row = rows[0];
    if (!row) {
      return reply.code(404).type("application/problem+json")
        .send({ type: "https://api.ledger.example/problems/not-found", title: "Wallet not found", status: 404 });
    }
    const balanceMinor = opts.castBigint ? Number(row.balance_minor) : row.balance_minor; // the bug: no cast
    return { id: row.id, currency: row.currency, balanceMinor, status: row.status };
  });
  return app;
}
```

```ts
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadContract } from "../../test/helpers/openapiContract.js";
import { buildApp } from "./app.js";

const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const contract = await loadContract(new URL("./openapi.yaml", import.meta.url).pathname, { recordFile: "reports/demo-hits.jsonl" });
beforeAll(async () => {
  await db.query(`DROP TABLE IF EXISTS wallets;
    CREATE TABLE wallets (id text PRIMARY KEY, currency text NOT NULL, balance_minor bigint NOT NULL, status text NOT NULL);
    INSERT INTO wallets VALUES ('w_riya', 'INR', 150000, 'active');`);
});
afterAll(async () => {
  console.log("operations with no test:", contract.untestedOperations());
  await db.end();
});

describe.each([false, true])("castBigint=%s", (castBigint) => {
  const app = buildApp(db, { castBigint });
  it("GET /v1/wallets/{walletId} 200 matches the spec", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/wallets/w_riya" });
    expect(res.statusCode).toBe(200);
    contract.expectMatchesSpec(res, "get", "/v1/wallets/{walletId}");
  });
  it("GET /v1/wallets/{walletId} 404 matches the spec", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/wallets/w_nobody" });
    expect(res.statusCode).toBe(404);
    contract.expectMatchesSpec(res, "get", "/v1/wallets/{walletId}");
  });
});
```

**Real output**

```text
 × contract.test.ts > castBigint=false > GET /v1/wallets/{walletId} 200 matches the spec 92ms
   → get /v1/wallets/{walletId} 200 application/json does not match the spec:
  data/balanceMinor must be integer
 ✓ contract.test.ts > castBigint=false > GET /v1/wallets/{walletId} 404 matches the spec 7ms
 ✓ contract.test.ts > castBigint=true > GET /v1/wallets/{walletId} 200 matches the spec 4ms
 ✓ contract.test.ts > castBigint=true > GET /v1/wallets/{walletId} 404 matches the spec 2ms
operations with no test: [ 'GET /v1/transfers/{transferId}' ]
```

**What to notice**
- The 404 passes in both modes because its `application/problem+json` body matches the `Problem` schema. Error responses are part of the contract too.
- `untestedOperations()` lists spec operations that no test touched. The product version records this across all workers and fails CI (Hands-on lab, step 3).
- The fix is one `Number(...)` in a mapper. The lesson is that only a real database plus a real schema check found it.

**Two more contract checks from P1-03.** Keep `oasdiff breaking` in CI to block breaking spec changes. Use Schemathesis to fuzz the running API from the spec. This card adds "every response the tests see must match the spec".

**b) Consumer-driven contracts (Pact), at concept level.** OpenAPI says what the provider *offers*. Pact records what each consumer *actually uses*. The Android app's test describes the requests it makes and the fields it reads. Pact runs a mock server for that test and writes a **pact file**. The API team's CI then replays every interaction against the real API. A Pact Broker (or PactFlow) stores the pacts. Its `can-i-deploy` check answers "is this version compatible with what is deployed?" before a release.

**Diagram: the Pact flow**

```mermaid
sequenceDiagram
  participant App as Android app CI
  participant Mock as Pact mock server
  participant Broker as Pact Broker
  participant API as Ledger API CI
  App->>Mock: 1. real client code calls GET wallet
  Mock-->>App: 2. canned response from the test
  App->>Broker: 3. publish pact file
  API->>Broker: 4. fetch pacts of all consumers
  API->>API: 5. replay each request on the real API
  API->>Broker: 6. publish verification result
  App->>Broker: 7. can-i-deploy before release
```

**How to read this diagram.** Steps 1 to 3 happen in the app team's pipeline. Their test calls their real API client against a Pact mock server, and the expectations become a pact file. Steps 4 to 6 happen in the API team's pipeline: the API proves it satisfies every consumer's pact. Step 7 is the safety gate: an app release is blocked if its pact has not been verified against the API version in production.

The consumer side ran here for real. This is the test from the app's repo (Pact JS 17, the `PactV4` API):

```ts
// Consumer side (lives in the MOBILE app's repo): "this is what I need from GET /v1/wallets/{id}".
import { MatchersV3, PactV4 } from "@pact-foundation/pact";
import { describe, expect, it } from "vitest";

// The app's real API client function (simplified).
async function fetchWallet(baseUrl: string, walletId: string): Promise<{ id: string; balanceMinor: number }> {
  const res = await fetch(`${baseUrl}/v1/wallets/${walletId}`, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as { id: string; balanceMinor: number };
}

const pact = new PactV4({ consumer: "ledger-android-app", provider: "ledger-api" });

describe("wallet screen contract", () => {
  it("reads a wallet's balance as an integer number of paise", () =>
    pact
      .addInteraction()
      .given("Riya has a wallet with ₹1,500")
      .uponReceiving("a request for Riya's wallet")
      .withRequest("GET", "/v1/wallets/w_riya", (req) => req.headers({ Accept: "application/json" }))
      .willRespondWith(200, (res) =>
        res.jsonBody({ id: MatchersV3.string("w_riya"), balanceMinor: MatchersV3.integer(150000) }),
      )
      .executeTest(async (mockServer) => {
        const wallet = await fetchWallet(mockServer.url, "w_riya");
        expect(wallet.balanceMinor).toBe(150000);
      }));
});
```

**Real output** (test passed; excerpt of the generated `pacts/ledger-android-app-ledger-api.json`):

```text
 Test Files  1 passed (1)
      Tests  1 passed (1)

"providerStates": [ { "name": "Riya has a wallet with ₹1,500" } ],
"request":  { "method": "GET", "path": "/v1/wallets/w_riya", "headers": { "Accept": [ "application/json" ] } },
"response": { "status": 200, "body": { "content": { "balanceMinor": 150000, "id": "w_riya" } },
  "matchingRules": { "body": { "$.balanceMinor": { "matchers": [ { "match": "integer" } ] },
                               "$.id":           { "matchers": [ { "match": "type" } ] } } } }
"pactSpecification": { "version": "4.0" }
```

`MatchersV3.integer` means "any integer". The pact says "I need `balanceMinor` to be an integer", not "I need exactly 150000". The provider side (the `Verifier` with `providerBaseUrl`, `pactBrokerUrl`, provider states) was not run here.

| | OpenAPI response validation | Pact consumer-driven contracts |
|---|---|---|
| Source of truth | The provider's spec | Each consumer's real usage |
| Catches | Responses that drift from the spec | Provider changes that break a specific consumer |
| Setup cost | Low: one helper | Higher: broker, provider states, two pipelines |
| Use it when | Always, for every HTTP API | Many consumers whose releases you do not control (old mobile app versions), or service-to-service messages |

### 6. Test doubles: mocks, stubs and fakes

**What it is.** A test double stands in for a real dependency. The names come from Gerard Meszaros' *xUnit Test Patterns*. Martin Fowler's "Mocks Aren't Stubs" explains the differences well.

| Double | What it does | Example on the platform |
|---|---|---|
| Dummy | Fills a parameter and is never used | A logger argument a test does not care about |
| Stub | Returns canned answers | A bank API that always says "rejected" |
| Spy | Records calls; the test checks them afterwards | `vi.fn()` wrapping the SMS sender |
| Mock | Has expectations about calls built in | "`send` must be called once with ref `po_2`" |
| Fake | A small working implementation with real rules | An in-memory bank that rejects duplicate refs |

**Minimal version:** `minimal/doubles.ts`

```ts
// Stub, mock, fake: three test doubles for a payment provider we do NOT own (a bank payout API).
interface PayoutProvider {
  send(req: { ref: string; amountMinor: number }): Promise<{ status: "accepted" | "rejected" }>;
}

// Code under test: pays out, and never sends the same ref twice.
async function payOut(provider: PayoutProvider, ref: string, amountMinor: number): Promise<string> {
  const res = await provider.send({ ref, amountMinor });
  return res.status === "accepted" ? "PAID" : "FAILED";
}

// STUB: returns a canned answer. Use it to steer the code down one path.
const rejectingStub: PayoutProvider = { send: async () => ({ status: "rejected" }) };

// MOCK: records calls so the test can check HOW the code talked to the boundary.
const calls: unknown[] = [];
const recordingMock: PayoutProvider = { send: async (req) => (calls.push(req), { status: "accepted" }) };

// FAKE: a small working implementation with real rules (here: duplicate refs are rejected, like the real bank).
class FakeBank implements PayoutProvider {
  private seen = new Set<string>();
  async send(req: { ref: string; amountMinor: number }) {
    if (this.seen.has(req.ref) || req.amountMinor <= 0) return { status: "rejected" as const };
    this.seen.add(req.ref);
    return { status: "accepted" as const };
  }
}

console.log("stub  ->", await payOut(rejectingStub, "po_1", 50_000));
console.log("mock  ->", await payOut(recordingMock, "po_2", 50_000), "| calls:", JSON.stringify(calls));
const bank = new FakeBank();
console.log("fake  ->", await payOut(bank, "po_3", 50_000), "then retry with same ref ->", await payOut(bank, "po_3", 50_000));
```

**Real output**

```text
stub  -> FAILED
mock  -> PAID | calls: [{"ref":"po_2","amountMinor":50000}]
fake  -> PAID then retry with same ref -> FAILED
```

**The rule: mock only boundaries you do not own.** The bank's payout API, the SMS gateway and the KYC vendor are slow, cost money, and you cannot reset their data. Replace them in tests. Do it **through your own interface** (a port), such as `PayoutProvider`, not by patching `fetch`. Then test the real adapter separately: against the vendor's sandbox in a nightly job, or with an HTTP-level stub such as msw or nock.

**What you should never mock:**
- **Your own database and Redis** in integration tests. Your SQL is your code.
- **The code under test.** Mocking part of the thing you test makes the test check nothing.
- **Your own repositories in service tests.** Go one level down to the real database instead; it costs milliseconds.
- **Time and randomness by monkey-patching deep inside.** Pass a clock, a `sleep` or an id generator in, as `sendPayout` does below.

**Prefer fakes over mocks for stateful boundaries.** A mock checks *how* you called something. A fake checks *what happened*. Mock-heavy tests break when you refactor, even if behaviour stays correct.

**Product version.** The port and the real HTTP adapter, a retry helper that is safe because the ref doubles as the bank's idempotency key, and a fake bank with failure switches.

`src/payouts/payoutProvider.ts`: the port and the real adapter (timeout on every call).

```ts
// Our port for the bank's payout API. Production uses the HTTP adapter; tests use a fake.
export interface PayoutRequest { ref: string; amountMinor: number; beneficiaryId: string }
export type PayoutResult = { status: "accepted"; providerRef: string } | { status: "rejected"; reason: string };
export interface PayoutProvider { send(req: PayoutRequest): Promise<PayoutResult> }

export class PayoutProviderUnavailable extends Error {
  override name = "PayoutProviderUnavailable";
}

// The real adapter: a timeout on every call, and our ref doubles as the bank's idempotency key.
export function createHttpPayoutProvider(cfg: { baseUrl: string; apiKey: string; timeoutMs: number }): PayoutProvider {
  return {
    async send(req) {
      let res: Response;
      try {
        res = await fetch(`${cfg.baseUrl}/payouts`, {
          method: "POST",
          headers: { authorization: `Bearer ${cfg.apiKey}`, "content-type": "application/json", "idempotency-key": req.ref },
          body: JSON.stringify(req),
          signal: AbortSignal.timeout(cfg.timeoutMs),
        });
      } catch (error) {
        throw new PayoutProviderUnavailable("bank did not answer in time", { cause: error });
      }
      if (res.status >= 500) throw new PayoutProviderUnavailable(`bank returned ${res.status}`);
      const body = (await res.json()) as { id?: string; status?: string; reason?: string };
      return body.status === "accepted" && body.id
        ? { status: "accepted", providerRef: body.id }
        : { status: "rejected", reason: body.reason ?? "UNKNOWN" };
    },
  };
}
```

`src/payouts/sendPayout.ts`: retry only when the bank was unavailable, with backoff, always with the same ref.

```ts
// Retries only when the bank was unavailable, always with the SAME ref, so the bank pays at most once.
import { PayoutProviderUnavailable, type PayoutProvider, type PayoutRequest, type PayoutResult } from "./payoutProvider.js";

export interface RetryOptions { attempts: number; baseDelayMs: number; sleep?: (ms: number) => Promise<void> }
const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function sendPayout(provider: PayoutProvider, req: PayoutRequest, opts: RetryOptions): Promise<PayoutResult> {
  const sleep = opts.sleep ?? realSleep; // injectable, so tests never really wait
  for (let attempt = 1; ; attempt++) {
    try {
      return await provider.send(req);
    } catch (error) {
      if (!(error instanceof PayoutProviderUnavailable) || attempt >= opts.attempts) throw error;
      await sleep(opts.baseDelayMs * 2 ** (attempt - 1)); // 200 ms, 400 ms, 800 ms ...
    }
  }
}
```

`test/helpers/fakePayoutProvider.ts`: a fake bank with the real bank's key rule (same ref, same answer).

```ts
// A fake bank: real rules (same ref = same answer), in memory, with switches to inject failures.
import { PayoutProviderUnavailable, type PayoutProvider, type PayoutRequest, type PayoutResult } from "../../src/payouts/payoutProvider.js";

export class FakePayoutProvider implements PayoutProvider {
  readonly paid: PayoutRequest[] = [];
  private readonly answers = new Map<string, PayoutResult>();
  failures: Array<"down" | "lose_response"> = []; // consumed one per call

  async send(req: PayoutRequest): Promise<PayoutResult> {
    const failure = this.failures.shift();
    if (failure === "down") throw new PayoutProviderUnavailable("fake bank is down");
    const result = this.answers.get(req.ref) ?? this.pay(req);
    if (failure === "lose_response") throw new PayoutProviderUnavailable("paid, but the response was lost");
    return result;
  }

  private pay(req: PayoutRequest): PayoutResult {
    this.paid.push(req);
    const result: PayoutResult = { status: "accepted", providerRef: `fake_${this.paid.length}` };
    this.answers.set(req.ref, result);
    return result;
  }
}
```

`test/unit/sendPayout.test.ts`

```ts
// The payout provider is a boundary we do not own, so here (and only here) a test double stands in for it.
import { describe, expect, it } from "vitest";
import { PayoutProviderUnavailable } from "../../src/payouts/payoutProvider.js";
import { sendPayout } from "../../src/payouts/sendPayout.js";
import { FakePayoutProvider } from "../helpers/fakePayoutProvider.js";

const request = { ref: "po_riya_0001", amountMinor: 50_000, beneficiaryId: "ben_amit" };
const noWait = { attempts: 3, baseDelayMs: 200, sleep: async () => {} };

describe("sendPayout", () => {
  it("bank paid but the response was lost: the retry reuses the ref, so Amit is paid once", async () => {
    const bank = new FakePayoutProvider();
    bank.failures = ["lose_response"];
    expect(await sendPayout(bank, request, noWait)).toEqual({ status: "accepted", providerRef: "fake_1" });
    expect(bank.paid).toHaveLength(1);
  });

  it("waits 200 ms then 400 ms between attempts", async () => {
    const bank = new FakePayoutProvider();
    bank.failures = ["down", "down"];
    const waits: number[] = [];
    await sendPayout(bank, request, { ...noWait, sleep: async (ms) => void waits.push(ms) });
    expect(waits).toEqual([200, 400]);
  });

  it("gives up after 3 attempts and surfaces the error", async () => {
    const bank = new FakePayoutProvider();
    bank.failures = ["down", "down", "down"];
    await expect(sendPayout(bank, request, noWait)).rejects.toBeInstanceOf(PayoutProviderUnavailable);
    expect(bank.paid).toHaveLength(0);
  });
});
```

**Real output**

```text
 ✓ |unit| test/unit/sendPayout.test.ts > sendPayout > bank paid but the response was lost: the retry reuses the ref, so Amit is paid once 3ms
 ✓ |unit| test/unit/sendPayout.test.ts > sendPayout > waits 200 ms then 400 ms between attempts 0ms
 ✓ |unit| test/unit/sendPayout.test.ts > sendPayout > gives up after 3 attempts and surfaces the error 1ms
      Tests  3 passed (3)
```

**What to notice**
- `lose_response` is the dangerous case: the bank paid, but our request timed out. A test with a stub that just throws would never reveal a double payout. The fake has the real bank's rule (same ref, same answer), so the test proves Amit is paid once.
- `sleep` is injected. The backoff test checks `[200, 400]` without waiting 600 ms, so it cannot be flaky.
- The fake lives in `test/helpers`, beside the factories. Product code only knows the `PayoutProvider` interface.

**Diagram: should I use a test double here?**

```mermaid
flowchart TD
  Q1{"Do we own it?<br/>our code, our DB, our Redis"}
  Q2{"Is it a paid or slow<br/>third-party API?"}
  Q3{"Does the test need<br/>its state or rules?"}
  REAL["Use the real thing<br/>e.g. Testcontainers"]
  FAKE["Fake behind our port<br/>plus a nightly sandbox test"]
  STUB["Stub behind our port"]
  Q1 -->|"yes"| REAL
  Q1 -->|"no"| Q2
  Q2 -->|"no, e.g. a local library"| REAL
  Q2 -->|"yes"| Q3
  Q3 -->|"yes"| FAKE
  Q3 -->|"no, one answer is enough"| STUB
```

**How to read this diagram.** Start at the top. Anything you own, including your database, is used for real. A third-party library that runs locally and is fast is also used for real. Only a paid or slow outside API gets a double, always behind your own interface. Choose a fake when the test depends on the API's rules (such as duplicate refs) and a stub when one canned answer is enough.

### 7. Concurrency tests: prove idempotency and locking really work

**What it is.** A concurrency test fires many requests **at the same time** and then checks the database. It is the only test that can show a race condition, which is a bug that depends on timing between two requests.

**How to write one that proves something:**

1. **Start everything together.** Build all 50 promises first, then `await Promise.all(...)`. Never put an `await` inside the loop that creates them.
2. **Give the race enough room.** Use a connection pool of 20 or more, or the requests just queue up one by one.
3. **Assert on the database, not only on responses.** Count transfers and ledger entries, read balances, and check that the total money in the system did not change.
4. **Repeat.** One green run is weak evidence. Run it many times: 20 rounds here, and a nightly job in CI.
5. **Prove the test can fail.** Run it once against the broken version, either by reverting the fix or with a mutant. If it stays green, it is not testing the race.

**Real experiment:** `demo/race.ts`. Fifty parallel transfers against real Postgres, comparing naive code with fixed code, 20 rounds each.

```ts
// 50 parallel transfers against real Postgres. Naive code vs fixed code, 20 rounds each.
import pg from "pg";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 25 });
type Outcome = "applied" | "replayed" | "insufficient";

async function reset(riyaMinor: number): Promise<void> {
  await pool.query(`
    DROP TABLE IF EXISTS transfers, idempotency_keys, wallet_balances;
    CREATE TABLE wallet_balances (wallet_id text PRIMARY KEY, balance_minor bigint NOT NULL);
    CREATE TABLE idempotency_keys (idem_key text PRIMARY KEY);
    CREATE TABLE transfers (id bigserial PRIMARY KEY, idem_key text NOT NULL, amount_minor bigint NOT NULL);
    INSERT INTO wallet_balances VALUES ('riya', ${riyaMinor}), ('amit', 0);`);
}

async function inTx<T>(work: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// NAIVE: check the key, then act. Read the balance in JS, then write it back.
async function naiveTransfer(key: string, amount: number): Promise<Outcome> {
  const seen = await pool.query("SELECT 1 FROM transfers WHERE idem_key = $1", [key]);
  if (seen.rowCount) return "replayed";
  return inTx(async (c) => {
    const { rows } = await c.query<{ balance_minor: string }>("SELECT balance_minor FROM wallet_balances WHERE wallet_id = 'riya'");
    const balance = Number(rows[0]?.balance_minor);
    if (balance < amount) return "insufficient";
    await c.query("UPDATE wallet_balances SET balance_minor = $1 WHERE wallet_id = 'riya'", [balance - amount]);
    await c.query("UPDATE wallet_balances SET balance_minor = balance_minor + $1 WHERE wallet_id = 'amit'", [amount]);
    await c.query("INSERT INTO transfers (idem_key, amount_minor) VALUES ($1, $2)", [key, amount]);
    return "applied";
  });
}

// FIXED: claim the key with a unique index, and debit with one conditional UPDATE.
async function safeTransfer(key: string, amount: number): Promise<Outcome> {
  return inTx(async (c) => {
    const claim = await c.query("INSERT INTO idempotency_keys VALUES ($1) ON CONFLICT DO NOTHING", [key]);
    if (claim.rowCount === 0) return "replayed";
    const debit = await c.query(
      "UPDATE wallet_balances SET balance_minor = balance_minor - $1 WHERE wallet_id = 'riya' AND balance_minor >= $1",
      [amount],
    );
    if (debit.rowCount === 0) throw new Error("insufficient"); // roll back the key claim too
    await c.query("UPDATE wallet_balances SET balance_minor = balance_minor + $1 WHERE wallet_id = 'amit'", [amount]);
    await c.query("INSERT INTO transfers (idem_key, amount_minor) VALUES ($1, $2)", [key, amount]);
    return "applied";
  }).catch((e: Error) => (e.message === "insufficient" ? "insufficient" : Promise.reject(e)));
}

async function state() {
  const { rows } = await pool.query<{ riya: string; amit: string; transfers: string }>(`
    SELECT (SELECT balance_minor FROM wallet_balances WHERE wallet_id='riya') AS riya,
           (SELECT balance_minor FROM wallet_balances WHERE wallet_id='amit') AS amit,
           (SELECT count(*) FROM transfers) AS transfers`);
  const r = rows[0]!;
  return { riya: Number(r.riya), amit: Number(r.amit), transfers: Number(r.transfers) };
}

type Impl = (key: string, amount: number) => Promise<Outcome>;
async function scenario(name: string, impl: Impl, sameKey: boolean, rounds = 20) {
  let broken = 0;
  let example = "";
  for (let round = 1; round <= rounds; round++) {
    await reset(1_00_000); // Riya starts with ₹1,000
    const amount = sameKey ? 50_000 : 10_000; // ₹500 once, or ₹100 x 50 different transfers
    await Promise.all(Array.from({ length: 50 }, (_, i) => impl(sameKey ? "key-1" : `key-${i}`, amount)));
    const s = await state();
    const ok = sameKey
      ? s.transfers === 1 && s.riya === 50_000 && s.amit === 50_000
      : s.transfers === 10 && s.riya === 0 && s.amit === 1_00_000;
    if (!ok) broken++;
    if (round === 1) example = `round 1: transfers=${s.transfers}, riya=${s.riya}, amit=${s.amit}, money total=${s.riya + s.amit}`;
  }
  console.log(`${name.padEnd(44)} broken in ${broken}/${rounds} rounds | ${example}`);
}

await scenario("naive, 50 duplicates of one ₹500 transfer", naiveTransfer, true);
await scenario("fixed, 50 duplicates of one ₹500 transfer", safeTransfer, true);
await scenario("naive, 50 different ₹100 transfers", naiveTransfer, false);
await scenario("fixed, 50 different ₹100 transfers", safeTransfer, false);
await pool.end();
```

**Real output**

```text
naive, 50 duplicates of one ₹500 transfer    broken in 20/20 rounds | round 1: transfers=40, riya=50000, amit=2000000, money total=2050000
fixed, 50 duplicates of one ₹500 transfer    broken in 0/20 rounds | round 1: transfers=1, riya=50000, amit=50000, money total=100000
naive, 50 different ₹100 transfers           broken in 20/20 rounds | round 1: transfers=50, riya=70000, amit=500000, money total=570000
fixed, 50 different ₹100 transfers           broken in 0/20 rounds | round 1: transfers=10, riya=0, amit=100000, money total=100000
```

All 80 rounds took about 6 s. The exact count changes with timing: the first run of this script applied 44 duplicates in round 1 (Amit received ₹22,000), this one 40. What never changes is that the naive code broke in every round and the fixed code in none.

**What to notice**
- **Naive duplicates:** 40 copies of one ₹500 transfer were applied. Amit received ₹20,000 and Riya still shows ₹500, so the books hold ₹20,500 that started as ₹1,000. Every request ran `SELECT ... WHERE idem_key` before any of them inserted. That is check-then-act.
- **Naive different transfers:** all 50 "succeeded", Riya still shows ₹700 and Amit ₹5,000. Each request read the balance into JavaScript and wrote back `balance - amount`, so most updates were lost (a *lost update*).
- **Fixed:** the unique index on the key lets exactly one request claim it. The rest wait, then do nothing. The conditional `UPDATE ... WHERE balance_minor >= $1` checks and debits in one atomic step. Exactly 10 transfers of ₹100 fit into ₹1,000.
- The check `money total` is the strongest assertion here: money is conserved no matter what the responses said.

**Diagram: the lost update in the naive code**

```mermaid
sequenceDiagram
  participant A as Request A
  participant DB as Postgres
  participant B as Request B
  A->>DB: SELECT balance, gets 100000
  B->>DB: SELECT balance, gets 100000
  A->>A: 100000 minus 10000 is 90000
  B->>B: 100000 minus 10000 is 90000
  A->>DB: SET balance to 90000, COMMIT
  B->>DB: SET balance to 90000, COMMIT
  Note over DB: two ₹100 transfers, one debit<br/>Amit was credited twice
```

**How to read this diagram.** Time runs downwards. Both requests read the same balance before either writes. Each computes the new balance in JavaScript and writes it back, so B overwrites A's debit. Amit's credit uses `balance_minor + $1` inside the database, so both credits land. That is how money is created. P2-04 · Concurrency control covers the fixes in depth: atomic updates, `SELECT ... FOR UPDATE`, and optimistic version checks.

**In-process races: fast-check's scheduler.** Some races live inside one Node process, between two `await`s. `fc.scheduler()` lets fast-check choose the order in which promises resolve. It tries many orders, then shrinks the failing one.

**Minimal version:** `minimal/scheduler-race.ts`

```ts
// fast-check's scheduler tries many orders of async steps to find a race, then shrinks the schedule.
import fc from "fast-check";

function makeStore(s: fc.Scheduler, claimFirst: boolean) {
  const saved = new Map<string, string>();
  let applied = 0;
  const slowTransfer = s.scheduleFunction(async () => `transfer #${++applied}`);
  return {
    applied: () => applied,
    async create(key: string) {
      const hit = saved.get(key);
      if (hit) return hit;
      if (claimFirst) saved.set(key, "processing"); // FIX: claim the key before any await
      const result = await slowTransfer(); // BUG without the fix: other requests run while we wait
      saved.set(key, result);
      return result;
    },
  };
}

for (const claimFirst of [false, true]) {
  const outcome = await fc.check(
    fc.asyncProperty(fc.scheduler(), async (s) => {
      const store = makeStore(s, claimFirst);
      const first = store.create("key-1");
      // The duplicate (a network retry) arrives at a moment the scheduler chooses.
      const retry = s.schedule(Promise.resolve("retry arrives")).then(() => store.create("key-1"));
      await s.waitIdle();
      await Promise.all([first, retry]);
      return store.applied() === 1; // duplicates must apply once
    }),
    { seed: 2 },
  );
  const label = claimFirst ? "claim first" : "check then act";
  console.log(outcome.failed
    ? `${label}: race found after ${outcome.numRuns} run(s). Schedule:\n${String(outcome.counterexample?.[0])}`
    : `${label}: no race in ${outcome.numRuns} runs`);
}
```

**Real output**

```text
check then act: race found after 4 run(s). Schedule:
schedulerFor()`
-> [task${2}] promise resolved with value "retry arrives"
-> [task${3}] function::() resolved with value "transfer #2"
-> [task${1}] function::() resolved with value "transfer #1"`
claim first: no race in 100 runs
```

The printed schedule is the exact interleaving that breaks the store. The retry arrived before the first transfer finished, so both ran. With the claim moved before the `await`, 100 different schedules found nothing.

The product concurrency test, which goes through the API with `app.inject`, is in **Hands-on lab, step 5**.

### 8. Property-based tests with fast-check

**What it is.** In an example test, you pick the inputs. In a property test, you state a rule that must hold for **every** input. The tool then generates hundreds of random inputs to try to break it. When one fails, it **shrinks** the input to the smallest case that still fails, so you get a clear bug report instead of a huge random input.

**Minimal version:** `minimal/property-check.ts`. This is what fast-check does, written by hand.

```ts
// What fast-check does, by hand: random inputs, a rule that must always hold, then shrink the failure.
const MIN = 200, MAX = 2_500; // ₹2 .. ₹25 in paise

// A buggy fee: someone dropped the Math.min, so there is no ₹25 cap.
const fee = (amount: number) => Math.max(MIN, Math.ceil((amount * 50) / 10_000));
const rule = (amount: number) => { const f = fee(amount); return f >= MIN && f <= MAX; };

let seed = 7; // tiny deterministic random generator so the run is repeatable
const random = () => ((seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31);

for (let run = 1; run <= 100; run++) {
  const amount = 1 + Math.floor(random() * 10_00_00_000); // 1 paisa .. ₹10 lakh
  if (rule(amount)) continue;
  // Shrink: try smaller amounts (halving, then minus one) while the rule still fails.
  let smallest = amount;
  for (let candidate = Math.floor(smallest / 2); candidate >= 1; candidate = Math.floor(candidate / 2))
    if (!rule(candidate)) smallest = candidate;
  while (smallest > 1 && !rule(smallest - 1)) smallest--;
  console.log(`run ${run}: failed for amount ${amount}, fee ${fee(amount)}`);
  console.log(`shrunk to amount ${smallest}, fee ${fee(smallest)}`);
  process.exit(1);
}
console.log("100 runs passed");
```

**Real output**

```text
run 1: failed for amount 59705606, fee 298529
shrunk to amount 500001, fee 2501
```

The random failure (₹5,97,056 paying a ₹2,985 fee) is hard to read. The shrunk one says exactly where the cap stops working: one paisa above ₹5,000. fast-check does this generating and shrinking for any data shape, and it prints a seed so you can replay the exact run.

**Good properties for a ledger:**

| Property | Example on the platform |
|---|---|
| Conservation | Money is moved, never created or lost: the total of all balances stays the same |
| Invariant | No user wallet goes below zero; every transfer's entries sum to zero |
| Bounds | The payout fee always stays between ₹2 and ₹25 |
| Monotonic | A bigger payout never pays a smaller fee |
| Round trip | `decode(encode(cursor))` gives back the same cursor |
| Idempotence | Replaying the same request twice has the same effect as once |
| Model-based (advanced) | Run random commands on the real service and on a simple `Map` model and compare them (fast-check's `fc.commands`) |

**Check your generators.** If 95% of random transfers are rejected for insufficient funds, the property mostly tests the rejection path. `fc.statistics` shows what the generator really produces. Here it ran on the generator from the product property test (`demo/generator-stats.ts`, seed 42, 500 runs):

**Real output**

```text
1-5 accepted............69.00%
saw INSUFFICIENT_FUNDS..58.20%
saw SAME_ACCOUNT........49.00%
0 accepted..............18.60%
6+ accepted.............12.40%
```

81% of scenarios moved some money and more than half also hit the insufficient-funds rule, so both paths get exercised.

**Diagram: what happens inside `fc.assert`**

```mermaid
flowchart TD
  GEN["Generate random input<br/>from the seed"]
  RUN["Run the property"]
  OK{"Did it hold?"}
  MORE{"Runs left?<br/>default 100"}
  PASS["Pass"]
  SHRINK["Shrink: try smaller inputs<br/>that still fail"]
  REPORT["Report counterexample,<br/>seed and path"]
  GEN --> RUN
  RUN --> OK
  OK -->|"yes"| MORE
  MORE -->|"yes"| GEN
  MORE -->|"no"| PASS
  OK -->|"no"| SHRINK
  SHRINK --> REPORT
```

**How to read this diagram.** fast-check loops: generate an input, run the property, repeat (100 times by default; the ledger test asks for 500). The first failure stops the loop. Shrinking then searches for a simpler failing input. The report includes the seed and the path, so `fc.assert(..., { seed, path })` replays exactly that case.

**When not to use it.** Use it for rules, not for one-off examples. If you cannot state the rule in one sentence, write example tests instead. Keep each property fast. 500 runs of a 25-step transfer sequence took 93 ms here.

The product property test and its real failing output are in **Hands-on lab, step 4**.

### 9. Mutation testing with Stryker

**What it is.** Coverage tells you which lines **ran**. Mutation testing tells you which behaviours are **checked**. The tool makes many small changes to your code, called **mutants**: `<` becomes `<=`, `+` becomes `-`, `Math.min` becomes `Math.max`, a condition becomes `true`, a function call disappears. It runs your tests against each mutant. If a test fails, the mutant is **killed** (good). If every test still passes, the mutant **survived**, and that is a bug your tests would miss.

**Minimal version:** `minimal/mutant.ts`. This is mutation testing by hand.

```ts
// What Stryker does, by hand: change the code a little, and see if the tests notice.
type Fee = (amount: number) => number;
const original: Fee = (a) => Math.min(2_500, Math.max(200, Math.ceil((a * 50) / 10_000)));
const mutants: Record<string, Fee> = {
  "min <-> max (no cap)": (a) => Math.max(2_500, Math.max(200, Math.ceil((a * 50) / 10_000))),
  "ceil -> floor": (a) => Math.min(2_500, Math.max(200, Math.floor((a * 50) / 10_000))),
  "drop the minimum": (a) => Math.min(2_500, Math.ceil((a * 50) / 10_000)),
};

// Two test suites. Both execute every line of `original` (100% line coverage).
const weakTests = [(f: Fee) => f(1_00_000) > 0];
const strongTests = [
  (f: Fee) => f(1_00_000) === 500, // 0.5% of ₹1,000
  (f: Fee) => f(1_00_001) === 501, // rounds up
  (f: Fee) => f(1_000) === 200, // minimum
  (f: Fee) => f(1_00_00_000) === 2_500, // capped
];

for (const [suiteName, tests] of [["weak", weakTests], ["strong", strongTests]] as const) {
  if (!tests.every((t) => t(original))) throw new Error(`${suiteName} suite fails on correct code`);
  const results = Object.entries(mutants).map(([name, m]) => `${name}: ${tests.every((t) => t(m)) ? "SURVIVED" : "killed"}`);
  console.log(`${suiteName.padEnd(6)} | ${results.join(" | ")}`);
}
```

**Real output**

```text
weak   | min <-> max (no cap): SURVIVED | ceil -> floor: SURVIVED | drop the minimum: SURVIVED
strong | min <-> max (no cap): killed | ceil -> floor: killed | drop the minimum: killed
```

Both suites execute every line of the fee function, so both have 100% line coverage. Only the strong one notices when the cap, the rounding or the minimum breaks.

**How Stryker does it at scale.** StrykerJS puts every mutant into one instrumented copy of your code, each behind a switch (*mutation switching*). It runs your tests once to learn which tests cover which mutant. Then, for each mutant, it turns that switch on and runs only the covering tests.

| Status | Meaning | What you do |
|---|---|---|
| Killed | At least one test failed | Nothing: the tests caught it |
| Survived | All tests passed with the bug in place | Add or sharpen a test, or justify it as equivalent |
| No coverage | No test even ran that code | Add a test |
| Timeout | The mutant caused an infinite loop | Counted as detected |
| Ignored | Excluded on purpose, with a written reason | Review the reason now and then |

**Mutation score** = (killed + timeout) ÷ (all mutants except ignored and compile errors).

**Equivalent mutants.** Some mutants cannot change behaviour. In `ledger.ts`, `buildEntries` calls `assertBalanced(entries)` as a safety net. With correct code, no input can ever reach that throw, so deleting the call changes nothing a test can see. Do not write a strange test to kill it. Mark it with a reason:

```ts
// Stryker disable next-line all: defence in depth; no valid input reaches it. assertBalanced has its own tests.
assertBalanced(entries);
```

**Two real gotchas found while building this lab (14 Oct 2026):**

1. **TypeScript 7.0.2 crashed Stryker 10.0.0**: `TypeError: ts.parseConfigFileTextToJson is not a function`. TypeScript 7 is the new native compiler, and its package does not provide the function that Stryker's tsconfig step calls. Pinning `typescript@6.0.3` fixed it. (P1-03 hit the same class of problem with `openapi-typescript`.)
2. **`@stryker-mutator/vitest-runner` 10.0.0 with Vitest 5.0.4 killed 0 of 86 mutants.** Every mutant "survived", including `if (true) { throw ... }`, which the tests clearly catch. The same tests on Vitest 4.1.11 killed 55. The runner passes the active mutant to Vitest workers through `provide`/`inject`, and with Vitest 5 the mutants were never switched on. The lab therefore uses Stryker's framework-neutral **command runner**, which runs `vitest run` once per mutant and is slower but correct:

| Setup (same 88 mutants) | First-draft tests | Improved tests |
|---|---|---|
| vitest-runner 10.0.0 + Vitest 5.0.4 | 0 killed: 0.00% (broken) | not used |
| vitest-runner 10.0.0 + Vitest 4.1.11 | 55 killed: 62.50%, 15 s | 87 killed, 1 ignored: 100%, 17.8 s |
| command runner + Vitest 5.0.4 (used in the lab) | 55 killed: 62.50%, 61 s | 87 killed, 1 survived: 98.86%, 94 s |

(The 100% run already had the one equivalent mutant marked as ignored; the 98.86% run had not. Same tests, same kills.)

The lesson is bigger than one version clash: **check that your quality tool can fail.** A mutation score of 0% (or a coverage of 100%) is a claim. Kill one known mutant by hand before you trust the number. When the vitest runner works with Vitest 5 in that same check, switch back to `testRunner: "vitest"`. Its per-test coverage made it 4.1 to 5.3 times faster here.

**Cost and scope.** Mutation testing costs (number of mutants) × (time of the covering tests). Run it on the code where a silent bug costs money (`src/domain/**`), not on the whole repo. Use `--incremental` in CI: after a one-line change, Stryker reused 86 of 88 results and finished in 7 s.

Before and after numbers, the list of survivors and the config are in **Hands-on lab, step 6**.

### 10. CI with GitHub Actions

**What it is.** CI runs the whole suite on a clean machine for every pull request, so "works on my machine" stops being an argument. The ledger workflow (in full in **Hands-on lab, step 7**) does this:

1. **Triggers:** every `pull_request`, plus pushes to `main`. A `concurrency` group cancels the old run when you push again to the same PR.
2. **Service containers:** GitHub starts `postgres:18-alpine` and `redis:8-alpine` next to the job, with health checks, so the job waits until they are ready. Service containers need a Linux runner.
3. **Caching:** `actions/setup-node@v7` with `cache: npm` restores the npm download cache, keyed on `package-lock.json`. Stryker's incremental report is cached with `actions/cache@v6`.
4. **Steps:** type check, unit and property tests with coverage, then integration, HTTP and concurrency tests in shuffled order, then the contract-coverage check.
5. **A separate mutation job** that fails when the score drops below the `break` threshold (85%).
6. **A nightly flaky-hunt workflow** that runs the suite 20 times with different seeds and lists the seeds that failed.

**Testcontainers or service containers in CI?**

| | Service containers | Testcontainers in CI |
|---|---|---|
| Who starts the database | GitHub, before the steps | Your test code |
| Same setup as a laptop | No (URLs come from env vars) | Yes |
| Needs Docker access in the job | No | Yes (GitHub's Ubuntu runners have it) |
| The card asks for | This one | Fine too |

The ledger's `globalSetup` supports both. If `TEST_ADMIN_DATABASE_URL` and `TEST_REDIS_URL` are set, it uses them. Otherwise it starts containers. One code path is used everywhere, and only the source of the URLs changes.

**Coverage is a signal, not a target.** When a measure becomes a target, people optimise the measure (Goodhart's law). A rule such as "PRs need 90% coverage" produces tests like the first AI draft in Deep dive 9: 100% of lines, 62.5% of mutants. Use coverage to **find untested code**: a red file in the report is a question to ask in review. Put a hard gate on the mutation score of the money modules instead.

**Diagram: the CI pipeline for one pull request**

```mermaid
flowchart TD
  PR["Pull request opened<br/>or updated"]
  SVC["Start service containers<br/>Postgres 18, Redis 8"]
  INSTALL["Checkout, setup-node,<br/>npm ci with cache"]
  TSC["Type check"]
  UNIT["Unit and property tests<br/>with coverage"]
  INT["Integration, HTTP and<br/>concurrency tests, shuffled"]
  CC["Contract coverage<br/>every operation tested"]
  MUT["Mutation job<br/>incremental, break at 85%"]
  MERGE{"All green?"}
  PR --> SVC
  SVC --> INSTALL
  INSTALL --> TSC
  TSC --> UNIT
  UNIT --> INT
  INT --> CC
  CC --> MUT
  MUT --> MERGE
```

**How to read this diagram.** Follow one pull request from top to bottom. The cheapest checks run first, so a type error fails in seconds before Postgres is ever queried. The mutation job runs only after the test job passes, because mutating code under a red suite tells you nothing. Branch protection requires every box to be green before merge.

### 11. Flaky tests: causes and fixes

**What it is.** A flaky test passes and fails with no code change. Flaky tests are worse than no tests: people learn to press "re-run", and then a real failure gets re-run too.

| Cause | How it looks | Fix |
|---|---|---|
| Shared state | Passes alone, fails after another test | Pass state in; reset in `beforeEach`; run with `--sequence.shuffle` in CI |
| Time | Fails at certain hours, often 00:00 to 05:30 IST (UTC is still yesterday) | Inject a clock or use `vi.useFakeTimers()` + `vi.setSystemTime()`; test the boundary times |
| Unordered SQL | A list comes back in a different order | Always `ORDER BY` with a unique tie-breaker |
| Shared database across workers | Unique-key clashes, wrong counts | One database per worker (Deep dive 3) |
| Async leaks | A missing `await`; a timer or promise outlives its test | Await everything; close pools and apps in `afterAll` |
| Real network | A third-party API is slow or down | A fake behind a port (Deep dive 6) |
| Randomness without a seed | Fails once in 500 runs, impossible to repeat | Seeded generators; fast-check prints `seed` and `path` |
| Tight timeouts | Fine on a laptop, times out on a busy CI runner | Wait for a condition (`expect.poll`), not a fixed `sleep`; sensible `testTimeout` |
| Container start time | The first test after an image pull times out | A larger `hookTimeout` for `globalSetup`; cache images |

**Real demo 1: shared state.** `demo/flaky/flaky.test.ts`. The second test changes a module-level flag and never resets it.

```ts
import { describe, expect, it } from "vitest";
import { flags, payoutEta } from "./payouts.js";

describe("payout ETA (shares state)", () => {
  it("is T+1 by default", () => {
    expect(payoutEta()).toBe("T+1"); // passes only while it runs BEFORE the test below
  });
  it("is instant when the flag is on", () => {
    flags.instantPayouts = true; // changed and never reset
    expect(payoutEta()).toBe("instant");
  });
});
```

**Real output** (20 runs each):

```text
flaky.test.ts in file order: 0/20 runs failed
flaky.test.ts shuffled:      11/20 runs failed (failing seeds: 3992 11424 2055 24346 4068 11046 16113 8129 10857 6924 16039)

$ npx vitest run flaky.test.ts --sequence.shuffle --sequence.seed=3992
     × is T+1 by default 7ms
AssertionError: expected 'instant' to be 'T+1' // Object.is equality
```

In file order the bug hides forever. Shuffling exposes it, and the seed reproduces it every time. The fixed version passes the flag in instead of sharing it, and failed 0 of 20 shuffled runs.

**Real demo 2: time.** `toISOString()` gives the **UTC** date. From midnight to 05:30 IST it is still "yesterday" in UTC, so a settlement date computed that way is wrong for 5.5 hours every night. A test that runs at 3 pm always passes, and a nightly CI run at 1 am IST fails.

```ts
// A module-level singleton: every test file in the same worker shares this object.
export const flags = { instantPayouts: false };

export function payoutEta(f: { instantPayouts: boolean } = flags): "instant" | "T+1" {
  return f.instantPayouts ? "instant" : "T+1";
}

// BUG: toISOString() is UTC. Between 00:00 and 05:30 IST it returns yesterday's date.
export function settlementDateBuggy(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

// FIX: ask for the calendar date in India explicitly. en-CA formats as YYYY-MM-DD.
const istDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" });
export function settlementDate(now = new Date()): string {
  return istDate.format(now);
}
```

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { payoutEta, settlementDate, settlementDateBuggy } from "./payouts.js";

describe("payout ETA (no shared state)", () => {
  it("is instant when the flag is on", () => {
    expect(payoutEta({ instantPayouts: true })).toBe("instant"); // state is passed in, not shared
  });
  it("is T+1 by default", () => {
    expect(payoutEta({ instantPayouts: false })).toBe("T+1");
  });
});

describe("settlement date uses the Indian calendar day", () => {
  afterEach(() => vi.useRealTimers());
  it.each([
    ["2026-10-14T15:00:00+05:30", "2026-10-14"], // afternoon
    ["2026-10-15T00:00:00+05:30", "2026-10-15"], // IST midnight
    ["2026-10-15T05:29:59+05:30", "2026-10-15"], // last second where UTC is still "yesterday"
    ["2026-10-15T05:30:00+05:30", "2026-10-15"], // UTC midnight
  ])("at %s it is %s", (instant, expected) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(instant));
    expect(settlementDate()).toBe(expected);
  });
  it("shows the bug: the UTC version is a day behind at 01:00 IST", () => {
    expect(settlementDateBuggy(new Date("2026-10-15T01:00:00+05:30"))).toBe("2026-10-14");
  });
});
```

**Real output:** `Tests  7 passed (7)`. The four boundary instants and the bug demonstration all pass on any machine at any hour, because the test sets the clock.

**Real demo 3: SQL without `ORDER BY`.**

```text
 before update (no ORDER BY)  ->  w1, w2, w3
 after update (no ORDER BY)   ->  w2, w3, w1
 with ORDER BY id             ->  w1, w2, w3
```

An `UPDATE` in Postgres writes a new row version, which can land in a different place in the table, so an unordered `SELECT` returns rows in a new order. A test that expects `[w1, w2, w3]` without `ORDER BY` breaks the first time some other test updates a wallet.

**A policy for flaky tests:**
1. Treat a flaky test as a bug with an owner, not as noise.
2. Reproduce it with the seed (`--sequence.seed`, fast-check's `seed` and `path`).
3. If it cannot be fixed today, quarantine it with `it.skip`, an owner and a date. Never leave it as a silent automatic retry on a money test.
4. Vitest's `retry` option is fine for a known-flaky external dependency, but it hides races. Keep it off for concurrency tests.

---
## ⚖️ Comparisons and trade-offs

### Test types: tools, and what each one catches

| Test type | Tools on this platform | Runs against | Catches | Misses | Speed here |
|---|---|---|---|---|---|
| Static | `tsc` (strict), ESLint | Source code | Type errors, wrong field names, unhandled union cases | Anything about runtime data: `tsc` trusted the row type that said `balance_minor: number` | Seconds |
| Unit | Vitest | Pure functions | Wrong rules, boundaries, rounding, error codes | SQL, I/O, wiring | 29 domain tests in under 1 s (**Real**) |
| Property | fast-check inside Vitest | Pure functions, random inputs | Edge cases nobody thought of; broken invariants such as negative balances | Only checks what the property states | 500 transfer sequences in 93 ms (**Real**) |
| Integration | Vitest, Testcontainers, node-postgres, ioredis | Real Postgres and Redis | Bad SQL, type changes at the boundary, constraint errors, TTL rules, pagination ties | HTTP concerns: routing, auth, serialisation | 6 tests in 1.87 s with setup (**Real**) |
| HTTP-level | `app.inject` (supertest for socket-level cases) | The whole app and a real database | Validation, auth, error mapping, status codes, headers, side-effects | Socket-level details when using `inject` | Fill in after the lab |
| Contract (provider) | Ajv against `openapi.yaml`, plus the contract-coverage script | Every response in the HTTP tests | Responses drifting from the spec; undocumented statuses; untested operations | What consumers actually rely on | Not measured separately; each schema is compiled once and cached |
| Contract (consumer) | Pact | Consumer expectations replayed on the provider | A provider change that breaks one specific consumer | Behaviour no consumer has written down | Fill in |
| Concurrency | `Promise.all` with `app.inject` or a `pg` pool; `fc.scheduler` in-process | A real database with parallel connections | Double-applied requests, lost updates, missing locks | Rare interleavings, unless repeated | 80 rounds of 50 requests in 6.2 s (**Real**) |
| Mutation | StrykerJS | Your tests | Weak assertions, missing boundaries, untested branches | Bugs in code it is not configured to mutate | 88 mutants in 61 to 94 s (**Real**) |
| E2E smoke | Playwright or k6 against staging | The deployed system | Configuration, wiring, infrastructure | Most specific behaviour; slow and fragile | Minutes |

### Coverage vs mutation score

| | Line coverage | Mutation score |
|---|---|---|
| Answers | "Did this line run?" | "Would a test fail if this line were wrong?" |
| First AI-draft tests (**Real**) | 100% lines, 91.66% branches | 62.50% (33 bugs survived) |
| Improved tests (**Real**) | 100% lines, 100% branches | 98.86% → 100% after marking 1 equivalent mutant |
| Cost | Nearly free | Mutants × test time (61 to 94 s here for one module) |
| Use it for | Finding code with no tests at all | Judging the tests on money-critical code |
| Gaming | Easy: call the code and assert nothing | Hard: the only way up is real checks |

### Where should a new test go?

| You are testing... | Write a... | Because |
|---|---|---|
| A rule with no I/O (fee, ledger, validation) | Unit test, plus a property if there is an invariant | Fast and exact; property tests find the edge cases you did not think of |
| A SQL query or a Redis script | Integration test with roll-back or unique keys | Only the real engine knows its types, ties and rules |
| An endpoint | HTTP test with `app.inject`, real database, contract check | It covers wiring, auth, errors and the spec in one go |
| Anything with an idempotency key, a lock or a counter | Concurrency test, repeated, asserting on the database | Single requests cannot show races |
| A call to a bank, SMS or KYC vendor | A fake behind your port, plus a nightly sandbox test of the adapter | You cannot reset their data or pay for every run |
| The quality of the tests above | Stryker on the domain module | Coverage cannot tell you |

---

## 🚶 Walkthrough on the ledger platform: an AI agent makes transfers "faster"

A developer asks an AI coding agent to speed up `POST /v1/transfers`. This walkthrough follows that change through the tests. The steps match the numbers in the diagram.

1. **The request.** The developer writes: *"p95 of POST /v1/transfers is 40 ms. Cut a database round trip. The tests in `test/` are the spec: do not edit them."*
2. **The change.** The agent moves the idempotency check to Redis: `GET idem:{key}` first, and write the key only after the transfer commits. Each request now does one less database write before it starts. This is check-then-act again, split across Redis and Postgres.
3. **Unit and property tests pass** in about 1 s. Nothing in `src/domain` changed, so this is correct and tells us nothing about the new code.
4. **HTTP tests pass.** Each one sends a single request, and a single request is handled correctly.
5. **The concurrency test fails.** In the "50 parallel duplicates" test, several requests miss the Redis key at the same moment. Each one moves money, so `ledgerState` shows more than one transfer row and Riya debited more than once. **Expected** result; the real Postgres experiment in Deep dive 7 shows the same race at 20 out of 20 rounds.
6. **The agent tries to "fix" the test.** It wants to change `toBe(1)` to `toBeGreaterThanOrEqual(1)` and add `retry: 3`. The prompt forbids it, and `CODEOWNERS` on `test/` means a human must approve any test change. The reviewer sees a test made weaker in the diff and rejects it.
7. **The real fix.** The unique-key claim in Postgres stays the guard. Redis is used only as a read-through cache for **completed** responses, so replays get faster without touching the race. The concurrency test passes, and the nightly flaky hunt passes 20 out of 20 shuffled runs.
8. **CI on the pull request.** The test job, contract coverage and the incremental mutation job all pass. The domain code did not change, so Stryker reuses its earlier results. The PR merges.

**Diagram: the change through the test layers**

```mermaid
sequenceDiagram
  participant Dev as Developer
  participant Agent as AI agent
  participant Tests as Local Vitest
  participant CI as GitHub Actions
  participant Rev as Reviewer
  Dev->>Agent: 1. cut a round trip, tests are the spec
  Agent->>Agent: 2. check key in Redis first
  Agent->>Tests: 3. unit and property tests
  Tests-->>Agent: pass, domain unchanged
  Agent->>Tests: 4. HTTP tests
  Tests-->>Agent: pass, single requests
  Agent->>Tests: 5. concurrency test
  Tests-->>Agent: FAIL, duplicates applied
  Agent->>Rev: 6. proposes a weaker assertion
  Rev-->>Agent: rejected, tests are the spec
  Agent->>Agent: 7. keep Postgres claim, Redis for replays
  Agent->>CI: 8. push PR
  CI-->>Dev: all jobs green, merge
```

**How to read this diagram.** Time runs downwards, and each numbered message matches a step above. The cheap layers (3 and 4) pass because the bug is not in what they test. Only the layer built for races (5) catches it. Step 6 is the moment most teams lose: when a test fails, the fastest way to green is to edit the test. Tests protect you only if changing them needs a human.

---

## 🧪 Hands-on lab

Seven steps, in the card's order, on the ledger platform. Steps 1, 4 and 6 run without Docker. Steps 2, 3 and 5 need Docker (or the CI-style URLs). Step 7 runs on GitHub.

### Prerequisites

- **Node 22.12 or newer** (Vitest 5 needs `^22.12.0 || ^24.0.0 || >=26.0.0`). Put the version in `.nvmrc`; CI reads it.
- **Docker** running, for Testcontainers.
- **The ledger project from earlier cards:** P1-03's `src/app.ts`, `src/db/pool.ts`, routes and `openapi/openapi.yaml`; P2-01's `db/migrations/*.sql`; P1-05's token issuing; P1-06's typed config. They are not reprinted here.

```bash
npm install -D vitest@5 vite @vitest/coverage-v8 fast-check \
  @testcontainers/postgresql @testcontainers/redis \
  @stryker-mutator/core @stryker-mutator/vitest-runner \
  @apidevtools/swagger-parser ajv ajv-formats openapi-types \
  supertest @types/supertest @pact-foundation/pact tsx typescript@6
npm install fastify pg ioredis zod
```

`typescript@6` is pinned on purpose: TypeScript 7.0.2 crashes Stryker 10.0.0 (Deep dive 9). `vite` is listed because Vitest 5 made it a peer dependency.

**Optional `docker-compose.yml`**, for poking at data with `psql` or running the suite the CI way on your laptop:

```yaml
services:
  postgres:
    image: postgres:18-alpine
    environment: { POSTGRES_PASSWORD: postgres }
    ports: ["5432:5432"]
  redis:
    image: redis:8-alpine
    ports: ["6379:6379"]
```

With it running, `TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres TEST_REDIS_URL=redis://localhost:6379 npx vitest run` skips Testcontainers.

**`package.json` scripts**

```json
{
  "scripts": {
    "test": "vitest run",
    "test:unit": "vitest run --project unit",
    "test:int": "vitest run --project integration",
    "test:contract-coverage": "tsx scripts/contractCoverage.ts openapi/openapi.yaml reports/contract-hits.jsonl",
    "test:mutation": "stryker run",
    "test:flaky-hunt": "for i in $(seq 20); do vitest run --sequence.shuffle || echo \"run $i failed\"; done"
  }
}
```

**Files added in this card**

```text
src/domain/fees.ts                 # step 1: pure fee rules
src/domain/ledger.ts               # step 1: pure double-entry rules
src/repositories/entryRepository.ts
src/lib/attemptLimiter.ts          # Redis-backed OTP attempt counter
src/payouts/payoutProvider.ts      # port + HTTP adapter (Deep dive 6)
src/payouts/sendPayout.ts
src/db/migrate.ts                  # applies P2-01 migrations to the template
test/unit/                         # steps 1 and 4
test/integration/                  # step 2
test/http/                         # step 3
test/concurrency/                  # step 5
test/helpers/                      # globalSetup, workerDatabase, db, factories, contract, fakes
scripts/contractCoverage.ts        # step 3
stryker.config.mjs                 # step 6
vitest.config.ts
.github/workflows/ci.yml           # step 7
.github/workflows/flaky-hunt.yml   # step 7
```

### Step 1: Unit tests for fee calculation and ledger rules

**The fee rules.** P2P transfers are free. A payout to a bank costs 0.5%, rounded up to the paisa, at least ₹2 and at most ₹25, plus 18% GST on the fee. These are example rates for the lab, not real bank pricing. Every amount is an integer number of paise, as in P2-01.

`src/domain/fees.ts`

```ts
// Pure fee rules. Every amount is an integer number of paise (₹1 = 100 paise).
export type TransferKind = "p2p" | "payout";

export interface FeeQuote {
  amountMinor: number; // what the receiver gets
  feeMinor: number; // platform fee
  gstMinor: number; // 18% GST on the fee
  totalDebitMinor: number; // what leaves the sender's wallet
}

export const PAYOUT_FEE_BPS = 50; // 0.50% (1 bps = 0.01%)
export const PAYOUT_FEE_MIN_MINOR = 200; // ₹2
export const PAYOUT_FEE_MAX_MINOR = 2_500; // ₹25
export const GST_PERCENT = 18;

export function quoteFee(amountMinor: number, kind: TransferKind): FeeQuote {
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    throw new RangeError(`amountMinor must be a positive integer, got ${amountMinor}`);
  }
  const feeMinor = kind === "payout" ? payoutFee(amountMinor) : 0;
  const gstMinor = roundHalfUp(feeMinor * GST_PERCENT, 100);
  return { amountMinor, feeMinor, gstMinor, totalDebitMinor: amountMinor + feeMinor + gstMinor };
}

function payoutFee(amountMinor: number): number {
  // Round UP to whole paise, so the platform never under-charges by a fraction.
  const raw = Math.ceil((amountMinor * PAYOUT_FEE_BPS) / 10_000);
  return Math.min(PAYOUT_FEE_MAX_MINOR, Math.max(PAYOUT_FEE_MIN_MINOR, raw));
}

// Integer-only rounding. No floats touch money (see P2-01).
function roundHalfUp(numerator: number, denominator: number): number {
  return Math.floor((numerator + denominator / 2) / denominator);
}
```

`src/domain/ledger.ts`: builds double-entry lines for one transfer and applies them to balances. Platform fee revenue and GST payable are accounts too, so money never leaves the books.

```ts
// Pure double-entry rules. No I/O, so they are cheap to unit test, property test and mutate.
import { quoteFee, type TransferKind } from "./fees.js";

export type AccountId = string;
export type Balances = ReadonlyMap<AccountId, number>;
export const FEE_REVENUE = "platform:fee_revenue";
export const GST_PAYABLE = "platform:gst_payable";

export interface Entry {
  accountId: AccountId;
  direction: "debit" | "credit";
  amountMinor: number;
}
export interface TransferRequest {
  from: AccountId;
  to: AccountId;
  amountMinor: number;
  kind: TransferKind;
}

export type LedgerRuleCode = "SAME_ACCOUNT" | "UNKNOWN_ACCOUNT" | "INSUFFICIENT_FUNDS" | "UNBALANCED";
export class LedgerRuleError extends Error {
  constructor(readonly code: LedgerRuleCode, message: string) {
    super(message);
    this.name = "LedgerRuleError";
  }
}

// Sign convention: a credit adds to an account, a debit takes away.
export function signedAmount(entry: Entry): number {
  return entry.direction === "credit" ? entry.amountMinor : -entry.amountMinor;
}

export function buildEntries(req: TransferRequest, balances: Balances): Entry[] {
  if (req.from === req.to) throw new LedgerRuleError("SAME_ACCOUNT", "source and destination are the same");
  const available = balances.get(req.from);
  if (available === undefined || !balances.has(req.to)) {
    throw new LedgerRuleError("UNKNOWN_ACCOUNT", `unknown account in ${req.from} -> ${req.to}`);
  }
  const quote = quoteFee(req.amountMinor, req.kind);
  // The sender pays amount + fee + GST, so check the total, not just the amount.
  if (available < quote.totalDebitMinor) {
    throw new LedgerRuleError("INSUFFICIENT_FUNDS", `need ${quote.totalDebitMinor}, have ${available}`);
  }
  const entries: Entry[] = [
    { accountId: req.from, direction: "debit", amountMinor: quote.totalDebitMinor },
    { accountId: req.to, direction: "credit", amountMinor: quote.amountMinor },
  ];
  if (quote.feeMinor > 0) entries.push({ accountId: FEE_REVENUE, direction: "credit", amountMinor: quote.feeMinor });
  if (quote.gstMinor > 0) entries.push({ accountId: GST_PAYABLE, direction: "credit", amountMinor: quote.gstMinor });
  // Stryker disable next-line all: defence in depth; no valid input reaches it. assertBalanced has its own tests.
  assertBalanced(entries);
  return entries;
}

export function assertBalanced(entries: readonly Entry[]): void {
  const sum = entries.reduce((total, entry) => total + signedAmount(entry), 0);
  if (sum !== 0) throw new LedgerRuleError("UNBALANCED", `entries sum to ${sum}, expected 0`);
}

export function applyEntries(balances: Balances, entries: readonly Entry[]): Map<AccountId, number> {
  const next = new Map(balances); // never mutate the caller's map
  for (const entry of entries) {
    next.set(entry.accountId, (next.get(entry.accountId) ?? 0) + signedAmount(entry));
  }
  return next;
}
```

**What to notice**
- `buildEntries` checks `available < quote.totalDebitMinor`, the amount **plus** fee and GST. Checking only the amount is the bug that the property test in step 4 catches.
- `LedgerRuleError` carries a machine `code`. Tests assert the code, because the API maps it to Problem Details (P1-03).
- `applyEntries` returns a new `Map`. Tests can compare "before" and "after" without the function changing the input under them.
- **Scope note:** P2-01's `ledger_entries` allows one debit and one credit per transfer. Fee and GST lines need the multi-leg entries of P2-09, so in this card the fee rules live in the pure module, and the API's P2P transfers carry no fee.

`test/unit/fees.test.ts`

```ts
// Example-based tests: one row per business rule and per boundary.
import { describe, expect, it } from "vitest";
import { quoteFee } from "../../src/domain/fees.js";

describe("quoteFee: p2p", () => {
  it("is free, so the sender pays exactly the amount", () => {
    expect(quoteFee(50_000, "p2p")).toEqual({ amountMinor: 50_000, feeMinor: 0, gstMinor: 0, totalDebitMinor: 50_000 });
  });
});

describe("quoteFee: payout is 0.5%, min ₹2, max ₹25, plus 18% GST on the fee", () => {
  it.each([
    // amount       fee    gst   why
    [1_00_000, 500, 90, "₹1,000 x 0.5% = ₹5"],
    [1_00_001, 501, 90, "fee rounds UP to whole paise"],
    [1_000, 200, 36, "below the minimum, so ₹2"],
    [40_000, 200, 36, "exactly at the minimum"],
    [40_001, 201, 36, "one paisa above the minimum"],
    [45_000, 225, 41, "GST 40.5 paise rounds half up to 41"],
    [5_00_000, 2_500, 450, "exactly at the maximum"],
    [5_00_001, 2_500, 450, "one paisa above the maximum, so capped"],
    [1_00_00_000, 2_500, 450, "₹1 lakh is still capped at ₹25"],
  ])("amount %i -> fee %i, GST %i (%s)", (amount, fee, gst) => {
    expect(quoteFee(amount, "payout")).toEqual({
      amountMinor: amount,
      feeMinor: fee,
      gstMinor: gst,
      totalDebitMinor: amount + fee + gst,
    });
  });
});

describe("quoteFee: input guard", () => {
  it("accepts the smallest amount, 1 paisa", () => {
    expect(quoteFee(1, "p2p").totalDebitMinor).toBe(1);
  });
  it.each([0, -1, 10.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])("rejects %s", (amount) => {
    expect(() => quoteFee(amount, "p2p")).toThrow(new RangeError(`amountMinor must be a positive integer, got ${amount}`));
  });
});
```

`test/unit/ledger.test.ts`

```ts
// Exact expected entries and balances, plus every rejection code.
import { describe, expect, it } from "vitest";
import { applyEntries, assertBalanced, buildEntries, LedgerRuleError, type Entry } from "../../src/domain/ledger.js";

const opening = () =>
  new Map([["riya", 1_00_590], ["amit", 0], ["platform:fee_revenue", 0], ["platform:gst_payable", 0]]);

function ruleError(fn: () => unknown): LedgerRuleError {
  try {
    fn();
  } catch (error) {
    if (error instanceof LedgerRuleError) return error;
    throw error;
  }
  throw new Error("expected a LedgerRuleError, but nothing was thrown");
}

describe("buildEntries", () => {
  it("payout: debits amount + fee + GST and credits receiver, fee revenue and GST payable", () => {
    // Riya has exactly ₹1,005.90, so this also proves she can spend her balance to the last paisa.
    expect(buildEntries({ from: "riya", to: "amit", amountMinor: 1_00_000, kind: "payout" }, opening())).toEqual([
      { accountId: "riya", direction: "debit", amountMinor: 1_00_590 },
      { accountId: "amit", direction: "credit", amountMinor: 1_00_000 },
      { accountId: "platform:fee_revenue", direction: "credit", amountMinor: 500 },
      { accountId: "platform:gst_payable", direction: "credit", amountMinor: 90 },
    ]);
  });

  it("p2p: exactly two entries, no zero-amount fee lines", () => {
    expect(buildEntries({ from: "riya", to: "amit", amountMinor: 5_000, kind: "p2p" }, opening())).toEqual([
      { accountId: "riya", direction: "debit", amountMinor: 5_000 },
      { accountId: "amit", direction: "credit", amountMinor: 5_000 },
    ]);
  });

  it("rejects one paisa short with INSUFFICIENT_FUNDS", () => {
    const balances = opening().set("riya", 1_00_589);
    const error = ruleError(() => buildEntries({ from: "riya", to: "amit", amountMinor: 1_00_000, kind: "payout" }, balances));
    expect(error).toMatchObject({ name: "LedgerRuleError", code: "INSUFFICIENT_FUNDS", message: "need 100590, have 100589" });
  });

  it("rejects a transfer to the same wallet", () => {
    const error = ruleError(() => buildEntries({ from: "riya", to: "riya", amountMinor: 100, kind: "p2p" }, opening()));
    expect(error).toMatchObject({ code: "SAME_ACCOUNT", message: "source and destination are the same" });
  });

  it.each([
    ["zoya", "amit"],
    ["riya", "zoya"],
  ])("rejects unknown account in %s -> %s", (from, to) => {
    const error = ruleError(() => buildEntries({ from, to, amountMinor: 100, kind: "p2p" }, opening()));
    expect(error).toMatchObject({ code: "UNKNOWN_ACCOUNT", message: `unknown account in ${from} -> ${to}` });
  });
});

describe("assertBalanced", () => {
  const debit = (amountMinor: number): Entry => ({ accountId: "riya", direction: "debit", amountMinor });
  const credit = (amountMinor: number): Entry => ({ accountId: "amit", direction: "credit", amountMinor });

  it("accepts entries that sum to zero", () => {
    expect(() => assertBalanced([debit(100), credit(60), credit(40)])).not.toThrow();
  });
  it("rejects entries that do not sum to zero", () => {
    const error = ruleError(() => assertBalanced([debit(100), credit(99)]));
    expect(error).toMatchObject({ code: "UNBALANCED", message: "entries sum to -1, expected 0" });
  });
});

describe("applyEntries", () => {
  it("applies signed amounts and leaves the input map untouched", () => {
    const before = opening();
    const entries = buildEntries({ from: "riya", to: "amit", amountMinor: 1_00_000, kind: "payout" }, before);
    expect(Object.fromEntries(applyEntries(before, entries))).toEqual({
      riya: 0,
      amit: 1_00_000,
      "platform:fee_revenue": 500,
      "platform:gst_payable": 90,
    });
    expect(before.get("riya")).toBe(1_00_590);
  });
  it("starts an unseen account from zero", () => {
    const after = applyEntries(new Map(), [{ accountId: "lakshmi", direction: "credit", amountMinor: 700 }]);
    expect(after.get("lakshmi")).toBe(700);
  });
});
```

**What to notice**
- Every limit has a row just below, at, or just above it. The `45_000` row exists only to pin the GST rounding (40.5 paise rounds up to 41).
- `toEqual` on the whole quote and on the whole entry list. One assertion checks every field, so a wrong fee line or a wrong order fails loudly.
- `ruleError` returns the typed error, so tests check `code` and `message` instead of just "it threw".
- Riya's opening balance is **exactly** the total debit (₹1,005.90). The happy-path test also proves she can spend to the last paisa. That one detail killed the `<` to `<=` mutant.

```bash
npx vitest run --project unit
```

**Real output**

```text
 RUN  v5.0.4
 Test Files  4 passed (4)
      Tests  32 passed (32)
   Duration  951ms (tests 55%, import 26%, transform 12%, worker 7%)
```

The 32 tests are 16 fee tests, 10 ledger tests, 3 properties (step 4) and the 3 payout tests from Deep dive 6.

### Step 2: An integration suite on Testcontainers, each test isolated

`vitest.config.ts`: two projects. `unit` needs nothing. `integration` gets the global setup and the per-file database.

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      { test: { name: "unit", include: ["test/unit/**/*.test.ts"] } },
      {
        test: {
          name: "integration",
          include: ["test/integration/**/*.test.ts", "test/http/**/*.test.ts", "test/concurrency/**/*.test.ts"],
          globalSetup: ["test/helpers/globalSetup.ts"],
          setupFiles: ["test/helpers/workerDatabase.ts"],
          testTimeout: 20_000,
          hookTimeout: 120_000, // the first local run pulls Docker images
        },
      },
    ],
    coverage: { provider: "v8", include: ["src/**"], reporter: ["text-summary", "lcov"] },
  },
});
```

`test/helpers/globalSetup.ts`: runs once per run. It starts containers (or uses CI's), migrates a template database and passes the URLs to the workers with `provide`.

```ts
// Runs ONCE per `vitest run`: starts Postgres and Redis, migrates a template database, shares the URLs.
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import { mkdir, rm } from "node:fs/promises";
import pg from "pg";
import type { TestProject } from "vitest/node";
import { runMigrations } from "../../src/db/migrate.js";

declare module "vitest" {
  export interface ProvidedContext {
    adminDatabaseUrl: string; // the server's default database; used only to create and drop databases
    templateDatabase: string;
    redisUrl: string;
  }
}

const TEMPLATE = "ledger_template";

export default async function setup(project: TestProject) {
  await mkdir("reports", { recursive: true });
  await rm("reports/contract-hits.jsonl", { force: true }); // fresh contract-coverage record per run

  // CI passes the URLs of its service containers. On a laptop, Testcontainers starts throwaway ones.
  let postgres: StartedPostgreSqlContainer | undefined;
  let redis: StartedRedisContainer | undefined;
  const adminDatabaseUrl =
    process.env.TEST_ADMIN_DATABASE_URL ??
    (postgres = await new PostgreSqlContainer("postgres:18-alpine").start()).getConnectionUri();
  const redisUrl =
    process.env.TEST_REDIS_URL ?? (redis = await new RedisContainer("redis:8-alpine").start()).getConnectionUrl();

  const admin = new pg.Client({ connectionString: adminDatabaseUrl });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${TEMPLATE} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${TEMPLATE}`);
  } finally {
    await admin.end();
  }
  const templateUrl = new URL(adminDatabaseUrl);
  templateUrl.pathname = `/${TEMPLATE}`;
  await runMigrations(templateUrl.toString()); // migrate once; every worker clones the result

  project.provide("adminDatabaseUrl", adminDatabaseUrl);
  project.provide("templateDatabase", TEMPLATE);
  project.provide("redisUrl", redisUrl);

  return async () => {
    await Promise.all([postgres?.stop(), redis?.stop()]);
  };
}
```

`src/db/migrate.ts`: the small runner `globalSetup` calls. In production a migration tool also records which files ran; tests always start from an empty database, so they do not need that.

```ts
// Applies db/migrations/*.sql in name order, each file in its own transaction.
import { readdir, readFile } from "node:fs/promises";
import pg from "pg";

export async function runMigrations(databaseUrl: string, dir = "db/migrations"): Promise<string[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    for (const file of files) {
      await client.query("BEGIN");
      await client.query(await readFile(`${dir}/${file}`, "utf8"));
      await client.query("COMMIT");
    }
    return files;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end(); // a template database must have no open connections
  }
}
```

`test/helpers/workerDatabase.ts`: runs before every integration test file. It clones a fresh database for this worker and points `DATABASE_URL` at it before the app's pool is imported.

```ts
// setupFiles entry: runs before EACH integration test file. Gives this worker a fresh database cloned
// from the migrated template, so files running in parallel never see each other's rows.
import pg from "pg";
import { afterAll, inject } from "vitest";

const adminUrl = inject("adminDatabaseUrl");
const dbName = `ledger_test_w${process.env.VITEST_POOL_ID ?? "1"}`; // 1..maxWorkers

const admin = new pg.Client({ connectionString: adminUrl });
await admin.connect();
try {
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${dbName} TEMPLATE ${inject("templateDatabase")}`); // copies data, runs no SQL
} finally {
  await admin.end();
}

const workerUrl = new URL(adminUrl);
workerUrl.pathname = `/${dbName}`;
process.env.DATABASE_URL = workerUrl.toString(); // read when the app's pool module is imported
process.env.REDIS_URL = inject("redisUrl");

afterAll(async () => {
  const { pool } = await import("../../src/db/pool.js");
  await pool.end();
});
```

`test/helpers/db.ts`: the two per-test isolation tools.

```ts
// Two ways to isolate tests that share one database.
import type { PoolClient } from "pg";
import { pool } from "../../src/db/pool.js";

const REFERENCE_TABLES = ["currencies"]; // seeded by migrations; never truncated

// 1. Truncate: for tests that go through the app, which opens and commits its own transactions.
export async function truncateAll(): Promise<void> {
  const { rows } = await pool.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> ALL($1)",
    [REFERENCE_TABLES],
  );
  const tables = rows.map((r) => `"${r.tablename}"`).join(", ");
  await pool.query(`TRUNCATE ${tables} RESTART IDENTITY CASCADE`);
}

// 2. Roll back: for repository code that accepts a client. Nothing the test writes is ever committed.
export async function withRollback<T>(work: (tx: PoolClient) => Promise<T>): Promise<T> {
  const tx = await pool.connect();
  try {
    await tx.query("BEGIN");
    return await work(tx);
  } finally {
    await tx.query("ROLLBACK");
    tx.release();
  }
}
```

`test/helpers/factories.ts`

```ts
// Data factories: valid rows with sensible defaults. A test overrides only what it cares about.
import { pool } from "../../src/db/pool.js";
import type { Queryable } from "../../src/db/queryable.js";

let sequence = 0;
const unique = () => `${process.env.VITEST_POOL_ID ?? "1"}-${++sequence}`; // unique across workers too

export interface TestUser { tenantId: string; userId: string }
export interface TestWallet extends TestUser { accountId: string; walletId: string }

export async function makeTenant(db: Queryable = pool, over: { name?: string } = {}): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    "INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id",
    [`tenant-${unique()}`, over.name ?? "Test tenant"],
  );
  return rows[0]!.id;
}

export async function makeUser(db: Queryable = pool, over: { tenantId?: string; email?: string } = {}): Promise<TestUser> {
  const tenantId = over.tenantId ?? (await makeTenant(db));
  const { rows } = await db.query<{ id: string }>(
    "INSERT INTO users (tenant_id, email) VALUES ($1, $2) RETURNING id",
    [tenantId, over.email ?? `user-${unique()}@ledger.test`],
  );
  return { tenantId, userId: rows[0]!.id };
}

export async function makeWallet(
  db: Queryable = pool,
  over: { owner?: TestUser; balanceMinor?: number; status?: "active" | "frozen" } = {},
): Promise<TestWallet> {
  const owner = over.owner ?? (await makeUser(db));
  const account = await db.query<{ id: string }>(
    "INSERT INTO accounts (tenant_id, kind, display_name) VALUES ($1, 'personal', 'Test account') RETURNING id",
    [owner.tenantId],
  );
  const accountId = account.rows[0]!.id;
  await db.query(
    "INSERT INTO account_members (tenant_id, account_id, user_id, relation) VALUES ($1, $2, $3, 'owner')",
    [owner.tenantId, accountId, owner.userId],
  );
  const wallet = await db.query<{ id: string }>(
    "INSERT INTO wallets (tenant_id, account_id, status) VALUES ($1, $2, $3) RETURNING id",
    [owner.tenantId, accountId, over.status ?? "active"],
  );
  const walletId = wallet.rows[0]!.id;
  // Shortcut: an opening balance with no ledger entries behind it. Fine for most tests;
  // a test of reconciliation must fund wallets through real transfers instead.
  await db.query("INSERT INTO wallet_balances (wallet_id, currency, balance_minor) VALUES ($1, 'INR', $2)", [
    walletId,
    over.balanceMinor ?? 0,
  ]);
  return { ...owner, accountId, walletId };
}

// The scenario most transfer tests need: Riya with money, Amit with none, same tenant.
export async function makeRiyaAndAmit(db: Queryable = pool, riyaBalanceMinor = 1_00_000) {
  const tenantId = await makeTenant(db, { name: "Kirana Pay" });
  const riya = await makeWallet(db, { owner: await makeUser(db, { tenantId }), balanceMinor: riyaBalanceMinor });
  const amit = await makeWallet(db, { owner: await makeUser(db, { tenantId }) });
  return { tenantId, riya, amit };
}

// A completed transfer with its key and both entries. Rows only: it does not touch wallet_balances.
export async function makeCompletedTransfer(db: Queryable, from: TestWallet, to: TestWallet, amountMinor: number) {
  const key = await db.query<{ id: string }>(
    `INSERT INTO idempotency_keys (tenant_id, client_id, key, request_hash, status, response_status, expires_at)
     VALUES ($1, $2, $3, sha256(convert_to($3, 'UTF8')), 'completed', 201, now() + interval '1 day') RETURNING id`,
    [from.tenantId, from.userId, `factory-key-${unique()}-0000`],
  );
  const transfer = await db.query<{ id: string }>(
    `INSERT INTO transfers (tenant_id, source_wallet_id, destination_wallet_id, currency, amount_minor, status, idempotency_key_id)
     VALUES ($1, $2, $3, 'INR', $4, 'completed', $5) RETURNING id`,
    [from.tenantId, from.walletId, to.walletId, amountMinor, key.rows[0]!.id],
  );
  const transferId = transfer.rows[0]!.id;
  await db.query(
    `INSERT INTO ledger_entries (tenant_id, transfer_id, wallet_id, currency, direction, amount_minor)
     VALUES ($1, $2, $3, 'INR', 'debit', $5), ($1, $2, $4, 'INR', 'credit', $5)`,
    [from.tenantId, transferId, from.walletId, to.walletId, amountMinor],
  );
  return transferId;
}
```

**What to notice**
- **Template cloning.** Migrations run once. `CREATE DATABASE ... TEMPLATE` copies the migrated database's data directly and runs no SQL, which is much faster than re-running five migration files for every test file. The one rule: nobody may be connected to the template while it is copied, which is why `runMigrations` closes its connection.
- **`inject` and `provide`** are how values travel from `globalSetup` (main process) to tests (worker processes). Plain global variables do not cross that boundary. The `ProvidedContext` declaration makes `inject("redisUrl")` typed.
- **`VITEST_POOL_ID`** is 1 to `maxWorkers` in Vitest 5, so each parallel worker gets its own database name.
- **Truncation reads the table list from `pg_tables`**, so a new migration's table is cleaned without anyone updating a list. Reference data is the only exception.
- **Factories return ids**, not whole rows, and every value they invent is unique per worker.

`src/repositories/entryRepository.ts`: keyset pagination over a wallet's entries.

```ts
// One page of a wallet's ledger entries, newest first, with a keyset cursor (P1-03).
import type { Queryable } from "../db/queryable.js";

export interface EntryView { id: string; direction: "debit" | "credit"; amountMinor: number; createdAt: string }
export interface EntryPage { items: EntryView[]; nextCursor: string | null }
interface Cursor { at: string; id: string } // `at` is Postgres's own text form: keeps microseconds

const encode = (c: Cursor) => Buffer.from(JSON.stringify(c)).toString("base64url");
const decode = (s: string) => JSON.parse(Buffer.from(s, "base64url").toString("utf8")) as Cursor;

export async function listWalletEntries(
  db: Queryable,
  walletId: string,
  opts: { limit: number; cursor?: string },
): Promise<EntryPage> {
  const after = opts.cursor ? decode(opts.cursor) : null;
  const { rows } = await db.query<{ id: string; direction: "debit" | "credit"; amount_minor: string; at: string }>(
    `SELECT id::text, direction, amount_minor, created_at::text AS at
     FROM ledger_entries
     WHERE wallet_id = $1
       AND ($2::timestamptz IS NULL OR (created_at, id) < ($2::timestamptz, $3::bigint))
     ORDER BY created_at DESC, id DESC -- id breaks ties: many rows can share one created_at
     LIMIT $4`,
    [walletId, after?.at ?? null, after?.id ?? null, opts.limit + 1], // one extra row tells us if more exist
  );
  const page = rows.slice(0, opts.limit);
  const last = page.at(-1);
  return {
    items: page.map((r) => ({ id: r.id, direction: r.direction, amountMinor: Number(r.amount_minor), createdAt: r.at })),
    nextCursor: rows.length > opts.limit && last ? encode({ at: last.at, id: last.id }) : null,
  };
}
```

`test/integration/entryRepository.test.ts`: roll-back isolation, and real ties in `created_at`.

```ts
// Real SQL, real data, isolated by a transaction that is always rolled back.
import { describe, expect, it } from "vitest";
import { listWalletEntries } from "../../src/repositories/entryRepository.js";
import { withRollback } from "../helpers/db.js";
import { makeCompletedTransfer, makeRiyaAndAmit } from "../helpers/factories.js";

describe("listWalletEntries", () => {
  it("walks every entry exactly once across pages, even when created_at ties", () =>
    withRollback(async (tx) => {
      const { riya, amit } = await makeRiyaAndAmit(tx);
      // Same transaction, so now() is the SAME for all 5 transfers: every created_at ties.
      for (const amount of [100, 200, 300, 400, 500]) await makeCompletedTransfer(tx, riya, amit, amount);

      const seen: number[] = [];
      let cursor: string | undefined;
      do {
        const page = await listWalletEntries(tx, riya.walletId, { limit: 2, cursor });
        seen.push(...page.items.map((e) => e.amountMinor));
        cursor = page.nextCursor ?? undefined;
      } while (cursor);

      expect(seen).toEqual([500, 400, 300, 200, 100]); // newest first, none lost, none repeated
    }));

  it("returns an empty page and no cursor for a wallet with no entries", () =>
    withRollback(async (tx) => {
      const { amit } = await makeRiyaAndAmit(tx);
      expect(await listWalletEntries(tx, amit.walletId, { limit: 2 })).toEqual({ items: [], nextCursor: null });
    }));
});
```

`test/integration/isolation.test.ts`: a guard that fails if truncation ever stops working.

```ts
// Both tests create the same unique email. They pass in any order only because each test starts clean.
import { beforeEach, expect, it } from "vitest";
import { pool } from "../../src/db/pool.js";
import { truncateAll } from "../helpers/db.js";
import { makeTenant, makeUser } from "../helpers/factories.js";

beforeEach(() => truncateAll());

it.each(["first", "second"])("%s test can register riya@kirana.test", async () => {
  const tenantId = await makeTenant(pool, { name: "Kirana Pay" });
  await makeUser(pool, { tenantId, email: "riya@kirana.test" });
  const { rows } = await pool.query("SELECT count(*)::int AS n FROM users");
  expect(rows[0]).toEqual({ n: 1 });
});
```

**Redis, for real.** `src/lib/attemptLimiter.ts` counts wrong OTP attempts (P1-05's step-up OTP). The bug-prone part is the expiry: start the window on the first attempt, never extend it, and never leave a key without a TTL.

```ts
// Counts attempts (e.g. wrong OTPs) per key in Redis and blocks after `max` within a fixed window.
import type { Redis } from "ioredis";

export interface AttemptResult { allowed: boolean; attempts: number; retryAfterSeconds: number }

export function createAttemptLimiter(redis: Redis, opts: { max: number; windowSeconds: number }) {
  return {
    async hit(key: string): Promise<AttemptResult> {
      // One MULTI: INCR, start the window only if none exists (EXPIRE ... NX), read the TTL.
      // The key can never be left without an expiry, even if this process dies mid-way.
      const replies = await redis.multi().incr(key).expire(key, opts.windowSeconds, "NX").ttl(key).exec();
      if (!replies) throw new Error("Redis transaction was aborted");
      const [incr, , ttl] = replies;
      if (incr?.[0] || ttl?.[0]) throw incr?.[0] ?? ttl?.[0];
      const attempts = Number(incr?.[1]);
      return { allowed: attempts <= opts.max, attempts, retryAfterSeconds: Math.max(0, Number(ttl?.[1])) };
    },
  };
}
```

```ts
// Real Redis: the TTL rules are exactly what a mock would get wrong.
import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { afterAll, describe, expect, it } from "vitest";
import { createAttemptLimiter } from "../../src/lib/attemptLimiter.js";

const redis = new Redis(process.env.REDIS_URL ?? "", { maxRetriesPerRequest: 1, connectTimeout: 2_000 });
afterAll(() => redis.quit());
const limiter = createAttemptLimiter(redis, { max: 5, windowSeconds: 600 });
const freshKey = () => `test:otp:${randomUUID()}`; // unique key per test: no cleanup, no clashes

describe("attempt limiter", () => {
  it("allows 5 wrong OTPs and blocks the 6th", async () => {
    const key = freshKey();
    const results = [];
    for (let i = 0; i < 6; i++) results.push(await limiter.hit(key));
    expect(results.map((r) => r.allowed)).toEqual([true, true, true, true, true, false]);
  });

  it("starts the window on the first attempt and never extends it", async () => {
    const key = freshKey();
    await limiter.hit(key);
    await redis.expire(key, 30); // pretend most of the window has passed
    const later = await limiter.hit(key);
    expect(later.retryAfterSeconds).toBeLessThanOrEqual(30); // EXPIRE NX did not reset it to 600
    expect(later.retryAfterSeconds).toBeGreaterThan(0);
  });
});
```

**What to notice**
- `EXPIRE key seconds NX` (Redis 7 and later) sets the TTL only if none exists. A mock `expire()` returns whatever you told it, so only real Redis can prove the window is not reset by later attempts.
- Each Redis test uses a random key, so no cleanup is needed and parallel tests cannot clash.
- `cursor.at` keeps Postgres's own text form of the timestamp. A JavaScript `Date` keeps only milliseconds and would lose the microseconds the comparison needs.

```bash
npx vitest run --project integration          # laptop: Testcontainers starts Postgres 18 and Redis 8
```

**Real output** (CI path, sandbox Postgres and Redis; see Deep dive 3 for the full list):

```text
      Tests  6 passed (6)
   Duration  1.87s (setup 52%, tests 26%, import 11%, transform 9%, worker 2%)
```

**Expected on your laptop:** the first run pulls `postgres:18-alpine` and `redis:8-alpine`, so it takes longer. Later runs add a few seconds for container start-up. Write both numbers in the measurements table.

### Step 3: Cover every endpoint with `app.inject`, validated against the OpenAPI spec

`test/helpers/openapiContract.ts`: validates any injected response against the spec and records what was checked.

```ts
// Checks real responses against openapi.yaml and remembers which operations the tests touched.
import { appendFileSync } from "node:fs";
import SwaggerParser from "@apidevtools/swagger-parser";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import type { LightMyRequestResponse } from "fastify";
import type { OpenAPIV3_1 } from "openapi-types";

const addFormats = addFormatsModule as unknown as (ajv: Ajv2020) => Ajv2020; // CJS default export under NodeNext
type Method = "get" | "post" | "put" | "patch" | "delete";

export async function loadContract(specPath: string, opts: { recordFile?: string } = {}) {
  const api = (await SwaggerParser.dereference(specPath)) as OpenAPIV3_1.Document;
  const ajv = addFormats(new Ajv2020({ allErrors: true, strict: false }));
  const validators = new Map<string, ValidateFunction>();
  const touched = new Set<string>();

  function expectMatchesSpec(res: LightMyRequestResponse, method: Method, pathTemplate: string): void {
    const operation = api.paths?.[pathTemplate]?.[method];
    if (!operation) throw new Error(`${method.toUpperCase()} ${pathTemplate} is not in the spec`);
    const status = String(res.statusCode);
    const documented = operation.responses?.[status] as OpenAPIV3_1.ResponseObject | undefined;
    if (!documented) throw new Error(`${method.toUpperCase()} ${pathTemplate} returned ${status}, which the spec does not document`);
    const checked = `${method.toUpperCase()} ${pathTemplate}`;
    touched.add(checked);
    // One line per checked response; scripts/contractCoverage.ts merges the files from all workers.
    if (opts.recordFile) appendFileSync(opts.recordFile, `${JSON.stringify({ operation: checked, status })}\n`);

    const mediaType = String(res.headers["content-type"] ?? "").split(";")[0] ?? "";
    const schema = documented.content?.[mediaType]?.schema;
    if (!schema) {
      if (documented.content) throw new Error(`${status} must be one of: ${Object.keys(documented.content).join(", ")}; got "${mediaType}"`);
      return; // e.g. 204: nothing to validate
    }
    const key = `${method} ${pathTemplate} ${status} ${mediaType}`;
    const validate = validators.get(key) ?? ajv.compile(schema);
    validators.set(key, validate);
    if (!validate(res.json())) {
      throw new Error(`${key} does not match the spec:\n  ${ajv.errorsText(validate.errors, { separator: "\n  " })}`);
    }
  }

  function untestedOperations(): string[] {
    const all = Object.entries(api.paths ?? {}).flatMap(([path, item]) =>
      (["get", "post", "put", "patch", "delete"] as const).filter((m) => item?.[m]).map((m) => `${m.toUpperCase()} ${path}`),
    );
    return all.filter((op) => !touched.has(op));
  }

  return { expectMatchesSpec, untestedOperations };
}
```

`test/helpers/contract.ts`: one checker per test file.

```ts
// One contract checker per test file, recording hits for the coverage script.
import { loadContract } from "./openapiContract.js";
export const contract = await loadContract("openapi/openapi.yaml", { recordFile: "reports/contract-hits.jsonl" });
```

`test/http/transfers.http.test.ts`: one test per documented outcome of `POST /v1/transfers`.

```ts
// HTTP-level tests: real app, real database, requests injected without a network socket.
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { pool } from "../../src/db/pool.js";
import { bearerFor } from "../helpers/auth.js";
import { contract } from "../helpers/contract.js";
import { truncateAll } from "../helpers/db.js";
import { makeRiyaAndAmit, makeWallet } from "../helpers/factories.js";

let app: FastifyInstance;
beforeAll(async () => {
  app = await buildApp();
});
afterAll(() => app.close());
beforeEach(() => truncateAll()); // the app commits its own transactions, so roll-back isolation cannot work here

const newKey = () => `key-${randomUUID()}`;
const balanceOf = async (walletId: string) =>
  Number((await pool.query("SELECT balance_minor FROM wallet_balances WHERE wallet_id = $1", [walletId])).rows[0]?.balance_minor);

describe("POST /v1/transfers", () => {
  it("201: moves ₹500 from Riya to Amit, and the response matches the spec", async () => {
    const { riya, amit } = await makeRiyaAndAmit(pool, 1_00_000);
    const res = await app.inject({
      method: "POST",
      url: "/v1/transfers",
      headers: { ...(await bearerFor(riya)), "idempotency-key": newKey() },
      payload: { sourceWalletId: riya.walletId, destinationWalletId: amit.walletId, amountMinor: 50_000, currency: "INR" },
    });
    expect(res.statusCode).toBe(201);
    contract.expectMatchesSpec(res, "post", "/v1/transfers");
    expect(res.headers.location).toBe(`/v1/transfers/${res.json<{ id: string }>().id}`);
    expect([await balanceOf(riya.walletId), await balanceOf(amit.walletId)]).toEqual([50_000, 50_000]);
  });

  it("422 INSUFFICIENT_FUNDS: a Problem Details body, and no money moves", async () => {
    const { riya, amit } = await makeRiyaAndAmit(pool, 10_000);
    const res = await app.inject({
      method: "POST",
      url: "/v1/transfers",
      headers: { ...(await bearerFor(riya)), "idempotency-key": newKey() },
      payload: { sourceWalletId: riya.walletId, destinationWalletId: amit.walletId, amountMinor: 50_000, currency: "INR" },
    });
    expect(res.statusCode).toBe(422);
    contract.expectMatchesSpec(res, "post", "/v1/transfers");
    expect(res.json()).toMatchObject({ code: "INSUFFICIENT_FUNDS" });
    expect(await balanceOf(riya.walletId)).toBe(10_000);
  });

  it("400 without an Idempotency-Key header", async () => {
    const { riya, amit } = await makeRiyaAndAmit(pool);
    const res = await app.inject({
      method: "POST",
      url: "/v1/transfers",
      headers: await bearerFor(riya),
      payload: { sourceWalletId: riya.walletId, destinationWalletId: amit.walletId, amountMinor: 100, currency: "INR" },
    });
    expect(res.statusCode).toBe(400);
    contract.expectMatchesSpec(res, "post", "/v1/transfers");
  });

  it("404 for a wallet in another tenant: no hint that it exists (P1-05)", async () => {
    const { riya } = await makeRiyaAndAmit(pool);
    const outsider = await makeWallet(pool); // a different tenant
    const res = await app.inject({
      method: "POST",
      url: "/v1/transfers",
      headers: { ...(await bearerFor(riya)), "idempotency-key": newKey() },
      payload: { sourceWalletId: riya.walletId, destinationWalletId: outsider.walletId, amountMinor: 100, currency: "INR" },
    });
    expect(res.statusCode).toBe(404);
    contract.expectMatchesSpec(res, "post", "/v1/transfers");
  });
});
```

**What to notice**
- Every test calls `contract.expectMatchesSpec`, so status codes and bodies are checked against `openapi.yaml`, not against what the handler happens to return today.
- Each test also checks the **database**: the 422 test proves no money moved.
- The 404 test uses a wallet from another tenant. It checks P1-05's rule that a user cannot even learn that a wallet exists elsewhere.
- `bearerFor` comes from P1-05's helpers. It signs a real access token, so the auth hook runs exactly as in production.

`scripts/contractCoverage.ts`: run after the HTTP tests. It fails CI if any operation in the spec has no test, and lists documented responses that no test produced.

```ts
// After the HTTP tests: fail if any operation in the spec was never tested, and list untested responses.
// Usage: npx tsx scripts/contractCoverage.ts openapi/openapi.yaml reports/contract-hits.jsonl
import { readFile } from "node:fs/promises";
import SwaggerParser from "@apidevtools/swagger-parser";
import type { OpenAPIV3_1 } from "openapi-types";

const [specPath = "openapi/openapi.yaml", hitsPath = "reports/contract-hits.jsonl"] = process.argv.slice(2);
const api = (await SwaggerParser.dereference(specPath)) as OpenAPIV3_1.Document;
const lines = (await readFile(hitsPath, "utf8").catch(() => "")).split("\n").filter(Boolean);
const hits = new Set(lines.map((l) => { const h = JSON.parse(l) as { operation: string; status: string }; return `${h.operation} ${h.status}`; }));

const untestedOperations: string[] = [];
const untestedResponses: string[] = [];
for (const [path, item] of Object.entries(api.paths ?? {})) {
  for (const method of ["get", "post", "put", "patch", "delete"] as const) {
    const responses = Object.keys(item?.[method]?.responses ?? {});
    if (responses.length === 0) continue;
    const operation = `${method.toUpperCase()} ${path}`;
    const missing = responses.filter((status) => !hits.has(`${operation} ${status}`));
    if (missing.length === responses.length) untestedOperations.push(operation);
    else untestedResponses.push(...missing.map((s) => `${operation} ${s}`));
  }
}
console.log(`responses checked against the spec: ${hits.size}`);
console.log(`documented responses never exercised (${untestedResponses.length}):`, untestedResponses);
console.log(`operations with NO test (${untestedOperations.length}):`, untestedOperations);
process.exitCode = untestedOperations.length > 0 ? 1 : 0;
```

**Real output** (on the demo spec from Deep dive 5):

```text
responses checked against the spec: 2
documented responses never exercised (0): []
operations with NO test (1): [ 'GET /v1/transfers/{transferId}' ]
exit code: 1
```

**Every endpoint of P1-03, and where it is tested.** Write one test file per resource, with the same pattern as the transfers file.

| Operation | Test file | Responses to cover |
|---|---|---|
| `POST /v1/accounts` | `test/http/accounts.http.test.ts` | 201, 400, 409 |
| `GET /v1/accounts/{accountId}` | `test/http/accounts.http.test.ts` | 200, 400, 404 |
| `POST /v1/accounts/{accountId}/wallets` | `test/http/wallets.http.test.ts` | 201, 400, 404, 409 |
| `GET /v1/wallets/{walletId}` | `test/http/wallets.http.test.ts` | 200 (with `ETag`), 400, 404 |
| `PATCH /v1/wallets/{walletId}` | `test/http/wallets.http.test.ts` | 200, 400, 404, 412, 428 |
| `GET /v1/wallets/{walletId}/transactions` | `test/http/transactions.http.test.ts` | 200 (two pages), 400, 404 |
| `POST /v1/wallets/{walletId}/statement-exports` | `test/http/statementExports.http.test.ts` | 202, 400, 404, 409 |
| `GET /v1/statement-exports/{exportId}` | `test/http/statementExports.http.test.ts` | 200, 400, 404 |
| `POST /v1/transfers` | `test/http/transfers.http.test.ts`, `test/concurrency/` | 201, 400, 404, 409, 422, 429 |
| `GET /v1/transfers` | `test/http/transfers.http.test.ts` | 200, 400 |
| `GET /v1/transfers/{transferId}` | `test/http/transfers.http.test.ts` | 200, 400, 404 |

**Expected** from `npm run test:contract-coverage` once only the transfers file exists: exit code 1, with the 8 operations of the other three resources listed under "operations with NO test", plus documented responses such as `POST /v1/transfers 409` and `429` under "never exercised". Keep adding tests until the operations list is empty. A 429 test needs the rate limiter configured with a tiny limit in tests (P3-04 builds the real limiter).

### Step 4: A fast-check property test for the ledger

`test/unit/ledger.property.test.ts`

```ts
// Property-based tests: fast-check generates hundreds of random cases and checks rules that must ALWAYS hold.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { PAYOUT_FEE_MAX_MINOR, PAYOUT_FEE_MIN_MINOR, quoteFee } from "../../src/domain/fees.js";
import {
  applyEntries, buildEntries, FEE_REVENUE, GST_PAYABLE, LedgerRuleError, signedAmount,
  type Balances, type Entry, type TransferRequest,
} from "../../src/domain/ledger.js";

const USERS = ["riya", "amit", "lakshmi"] as const;
const BANK_SETTLEMENT = "platform:bank_settlement"; // where payouts go before they reach a bank

const userArb = fc.constantFrom(...USERS);
const amountArb = fc.integer({ min: 1, max: 2_00_000 }); // 1 paisa to ₹2,000
const balanceArb = fc.integer({ min: 0, max: 5_00_000 }); // ₹0 to ₹5,000
const transferArb: fc.Arbitrary<TransferRequest> = fc.oneof(
  fc.record({ from: userArb, to: userArb, amountMinor: amountArb, kind: fc.constant("p2p" as const) }),
  fc.record({ from: userArb, to: fc.constant(BANK_SETTLEMENT), amountMinor: amountArb, kind: fc.constant("payout" as const) }),
);

function openingBalances([riya, amit, lakshmi]: [number, number, number]): Map<string, number> {
  return new Map([["riya", riya], ["amit", amit], ["lakshmi", lakshmi],
    [FEE_REVENUE, 0], [GST_PAYABLE, 0], [BANK_SETTLEMENT, 0]]);
}
const totalMoney = (balances: Balances) => [...balances.values()].reduce((a, b) => a + b, 0);

describe("ledger invariants (property-based)", () => {
  it("any sequence of transfers keeps the books balanced and no wallet below zero", () => {
    fc.assert(
      fc.property(fc.tuple(balanceArb, balanceArb, balanceArb), fc.array(transferArb, { maxLength: 25 }), (opening, transfers) => {
        let balances: Balances = openingBalances(opening);
        const moneyAtStart = totalMoney(balances);
        for (const transfer of transfers) {
          let entries: Entry[];
          try {
            entries = buildEntries(transfer, balances);
          } catch (error) {
            if (error instanceof LedgerRuleError) continue; // a clean rejection is fine
            throw error; // any other error is a bug
          }
          expect(entries.reduce((sum, entry) => sum + signedAmount(entry), 0)).toBe(0);
          balances = applyEntries(balances, entries);
          for (const user of USERS) expect(balances.get(user)).toBeGreaterThanOrEqual(0);
        }
        expect(totalMoney(balances)).toBe(moneyAtStart); // money moves; it is never created or lost
      }),
      { numRuns: 500 },
    );
  });

  it("payout fee stays between ₹2 and ₹25, and the sender pays amount + fee + GST", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 10_00_00_000 }), (amount) => {
        const quote = quoteFee(amount, "payout");
        expect(quote.feeMinor).toBeGreaterThanOrEqual(PAYOUT_FEE_MIN_MINOR);
        expect(quote.feeMinor).toBeLessThanOrEqual(PAYOUT_FEE_MAX_MINOR);
        expect(quote.totalDebitMinor).toBe(amount + quote.feeMinor + quote.gstMinor);
      }),
    );
  });

  it("a bigger payout never pays a smaller fee", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 10_00_00_000 }), fc.integer({ min: 1, max: 10_00_00_000 }), (a, b) => {
        const [small, big] = a <= b ? [a, b] : [b, a];
        expect(quoteFee(small, "payout").feeMinor).toBeLessThanOrEqual(quoteFee(big, "payout").feeMinor);
      }),
    );
  });
});
```

**What to notice**
- The generator builds whole **scenarios**: three opening balances and up to 25 transfers, a mix of P2P and payouts. Payouts go to `platform:bank_settlement`, an account inside the books, so the total-money check stays exact.
- A rejection with `LedgerRuleError` is allowed: refusing a transfer is fine. Any other error fails the property, because a crash is a bug.
- Three invariants are checked after every step: entries sum to zero, no user wallet goes below zero, and the total money never changes.
- `numRuns: 500` instead of the default 100, because this is the most valuable test in the file and it is still cheap.

**Real output** (passing):

```text
 ✓ |unit| test/unit/ledger.property.test.ts > ledger invariants (property-based) > any sequence of transfers keeps the books balanced and no wallet below zero 93ms
 ✓ |unit| test/unit/ledger.property.test.ts > ledger invariants (property-based) > payout fee stays between ₹2 and ₹25, and the sender pays amount + fee + GST 3ms
 ✓ |unit| test/unit/ledger.property.test.ts > ledger invariants (property-based) > a bigger payout never pays a smaller fee 1ms
```

**Now break the code** the way a hurried change might. In `buildEntries`, check only the amount and forget fee and GST:

```ts
if (available < quote.amountMinor) { // BUG: should be quote.totalDebitMinor
```

**Real output** (same property, broken code):

```text
 FAIL  test/unit/ledger.property.test.ts > ledger invariants (property-based) > any sequence of transfers keeps the books balanced and no wallet below zero
Error: Property failed after 6 tests
{ seed: -2094567946, path: "5:0:0:4:4:1:4:4", endOnFailure: true }
Counterexample: [[0,0,1],[{"from":"lakshmi","to":"platform:bank_settlement","amountMinor":1,"kind":"payout"}]]
Shrunk 7 time(s)
Hint: Enable verbose mode in order to have the list of all failing values encountered during the run
Caused by: AssertionError: expected -236 to be greater than or equal to 0
```

**How to read it.** After 6 random scenarios, fast-check found a failure and shrank it 7 times to the smallest story possible. Riya and Amit have ₹0, Lakshmi has 1 paisa, and Lakshmi pays out 1 paisa to her bank. The check sees 1 ≥ 1 and allows it. The debit is amount + ₹2 minimum fee + 36 paise GST = 237 paise, so her balance becomes −236. A random input of 25 transfers across three wallets was reduced to one transfer of one paisa. To replay exactly this case while you fix it:

```ts
fc.assert(property, { seed: -2094567946, path: "5:0:0:4:4:1:4:4" });
```

**Optional advanced understanding.** `@fast-check/vitest` (0.5.0, checked 14 Oct 2026) adds `test.prop([arbitraries], fn)` so properties read like normal Vitest tests. For services with state, model-based testing with `fc.commands` runs random command sequences on the real code and on a simple model at the same time. It is the next step after this card.

### Step 5: A concurrency test: 50 parallel duplicate transfers apply exactly once

`test/concurrency/transfers.concurrency.test.ts`

```ts
// Proves idempotency and locking under real parallel load. Asserts on the database, not just on responses.
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { pool } from "../../src/db/pool.js";
import { bearerFor } from "../helpers/auth.js";
import { truncateAll } from "../helpers/db.js";
import { makeRiyaAndAmit } from "../helpers/factories.js";

let app: FastifyInstance;
beforeAll(async () => {
  app = await buildApp();
});
afterAll(() => app.close());
beforeEach(() => truncateAll());

async function ledgerState(riyaWallet: string, amitWallet: string) {
  const { rows } = await pool.query<{ transfers: number; entries: number; riya: string; amit: string }>(
    `SELECT (SELECT count(*)::int FROM transfers) AS transfers,
            (SELECT count(*)::int FROM ledger_entries) AS entries,
            (SELECT balance_minor FROM wallet_balances WHERE wallet_id = $1) AS riya,
            (SELECT balance_minor FROM wallet_balances WHERE wallet_id = $2) AS amit`,
    [riyaWallet, amitWallet],
  );
  const s = rows[0]!;
  return { transfers: s.transfers, entries: s.entries, riya: Number(s.riya), amit: Number(s.amit) };
}

const countBy = (responses: LightMyRequestResponse[]) =>
  responses.reduce<Record<string, number>>((acc, r) => {
    const label = `${r.statusCode}${r.headers["idempotent-replayed"] === "true" ? " replay" : ""}`;
    return { ...acc, [label]: (acc[label] ?? 0) + 1 };
  }, {});

describe("transfers under concurrency", () => {
  it("50 parallel duplicates of one ₹500 transfer apply exactly once", async () => {
    const { riya, amit } = await makeRiyaAndAmit(pool, 1_00_000);
    const auth = await bearerFor(riya);
    const send = () =>
      app.inject({
        method: "POST",
        url: "/v1/transfers",
        headers: { ...auth, "idempotency-key": "key-riya-rent-october-0001" },
        payload: { sourceWalletId: riya.walletId, destinationWalletId: amit.walletId, amountMinor: 50_000, currency: "INR" },
      });

    const responses = await Promise.all(Array.from({ length: 50 }, send)); // all 50 start together

    const counts = countBy(responses);
    expect(counts["201"]).toBe(1); // exactly one request did the work
    expect(Object.keys(counts).every((k) => ["201", "201 replay", "409"].includes(k))).toBe(true); // never a 500
    expect(await ledgerState(riya.walletId, amit.walletId)).toEqual({ transfers: 1, entries: 2, riya: 50_000, amit: 50_000 });

    const late = await send(); // a retry after the dust settles gets the stored response
    expect([late.statusCode, late.headers["idempotent-replayed"]]).toEqual([201, "true"]);
  });

  it("50 parallel ₹100 transfers from a ₹1,000 wallet: exactly 10 succeed, nothing goes negative", async () => {
    const { riya, amit } = await makeRiyaAndAmit(pool, 1_00_000);
    const auth = await bearerFor(riya);
    const responses = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        app.inject({
          method: "POST",
          url: "/v1/transfers",
          headers: { ...auth, "idempotency-key": `key-riya-chai-${String(i).padStart(4, "0")}-oct` },
          payload: { sourceWalletId: riya.walletId, destinationWalletId: amit.walletId, amountMinor: 10_000, currency: "INR" },
        }),
      ),
    );
    expect(countBy(responses)).toEqual({ "201": 10, "422": 40 });
    expect(await ledgerState(riya.walletId, amit.walletId)).toEqual({ transfers: 10, entries: 20, riya: 0, amit: 1_00_000 });
  });
});
```

**What to notice**
- `Promise.all(Array.from({ length: 50 }, send))` creates all 50 requests before any of them is awaited, so they really race.
- Exactly **one** fresh 201. The other 49 are either `409 IDEMPOTENCY_REQUEST_IN_PROGRESS` or replays with `Idempotent-Replayed: true`, depending on timing (P1-03's design). The test allows both and never allows a 500.
- `ledgerState` reads the truth from the database: one transfer, two entries, both balances right.
- The second test is the lost-update case: 50 **different** ₹100 transfers from ₹1,000 must produce exactly 10 successes and a balance of zero.
- The app's pool size limits how many requests really overlap. With the default of 10 connections the test still races; the experiment in Deep dive 7 used 25.

```bash
npx vitest run test/concurrency
```

**Expected output:** 2 passed. In the first test, the split between `409` and `201 replay` changes from run to run, because it depends on timing. `"201"` is always exactly 1.

**Prove the test can fail.** In P1-03's `claimKey`, temporarily change the claim to "SELECT the key; if absent, INSERT without `ON CONFLICT`", and drop the `UNIQUE (tenant_id, client_id, key)` constraint in a scratch migration. Run the test again. **Expected:** it fails, with `transfers` greater than 1. Then restore the code. The real experiment in Deep dive 7 shows the size of this failure with the same 50-request shape: 44 transfers, 20 out of 20 rounds.

### Step 6: Run Stryker on the ledger module and kill the surviving mutants

**Before: the first AI draft of the tests.** This is the kind of suite an assistant produces when asked to "add tests for the ledger module".

```ts
// The "first AI draft": every line runs, almost nothing is really checked.
import { describe, expect, it } from "vitest";
import { quoteFee } from "../../src/domain/fees.js";
import { applyEntries, assertBalanced, buildEntries } from "../../src/domain/ledger.js";

const balances = new Map([["riya", 1_00_000], ["amit", 0], ["platform:fee_revenue", 0], ["platform:gst_payable", 0]]);

describe("quoteFee", () => {
  it("returns a quote for p2p", () => {
    const quote = quoteFee(10_000, "p2p");
    expect(quote).toBeDefined();
    expect(quote.feeMinor).toBe(0);
  });
  it("charges a fee for payouts", () => {
    const quote = quoteFee(50_000, "payout");
    expect(quote.feeMinor).toBeGreaterThan(0);
    expect(quote.totalDebitMinor).toBeGreaterThan(quote.amountMinor);
  });
  it("throws for a bad amount", () => {
    expect(() => quoteFee(-1, "p2p")).toThrow();
  });
});

describe("buildEntries", () => {
  it("creates entries for a payout", () => {
    const entries = buildEntries({ from: "riya", to: "amit", amountMinor: 50_000, kind: "payout" }, balances);
    expect(entries.length).toBeGreaterThan(0);
  });
  it("rejects a transfer to self", () => {
    expect(() => buildEntries({ from: "riya", to: "riya", amountMinor: 100, kind: "p2p" }, balances)).toThrow();
  });
  it("rejects unknown accounts", () => {
    expect(() => buildEntries({ from: "zoya", to: "amit", amountMinor: 100, kind: "p2p" }, balances)).toThrow();
  });
  it("rejects when funds are low", () => {
    expect(() => buildEntries({ from: "amit", to: "riya", amountMinor: 100, kind: "p2p" }, balances)).toThrow();
  });
});

describe("assertBalanced and applyEntries", () => {
  it("accepts balanced entries", () => {
    expect(() => assertBalanced([])).not.toThrow();
  });
  it("updates balances", () => {
    const entries = buildEntries({ from: "riya", to: "amit", amountMinor: 1_000, kind: "p2p" }, balances);
    const next = applyEntries(balances, entries);
    expect(next.get("amit")).toBeDefined();
  });
});
```

**Real output** (line coverage of the draft):

```text
 Test Files  1 passed (1)
      Tests  9 passed (9)
Statements   : 97.56% ( 40/41 )
Branches     : 91.66% ( 22/24 )
Functions    : 100% ( 9/9 )
Lines        : 100% ( 36/36 )
```

`stryker.config.mjs`

```js
// Mutation testing for the pure ledger module. Run: npx stryker run
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  // Vitest 5 + @stryker-mutator/vitest-runner 10.0.0 killed 0 mutants in our run,
  // so we use the framework-agnostic command runner (slower, but correct).
  testRunner: "command",
  commandRunner: { command: "npx vitest run --config vitest.unit.config.ts" },
  mutate: ["src/domain/**/*.ts"],
  reporters: ["clear-text", "progress", "html", "json"],
  thresholds: { high: 90, low: 80, break: 85 }, // CI fails below 85%
  incremental: true, // reuse results for code and tests that did not change
  tempDirName: ".stryker-tmp",
};
```

**What to notice**
- `testRunner: "command"` runs the unit project once per mutant. It is slower than the vitest runner, but it works with Vitest 5 (Deep dive 9).
- `mutate` limits Stryker to `src/domain`, where a silent bug costs money. Glue code is covered by integration tests instead.
- `thresholds.break: 85` makes `stryker run` exit with an error below 85%, which fails the CI job.
- `incremental: true` stores results in `reports/stryker-incremental.json`. CI caches that file per branch.

```bash
npx stryker run                 # first run: all mutants
npx stryker run --incremental   # later runs: only what changed (the config already sets incremental: true)
```

**Real output, before** (first-draft tests, command runner):

```text
-----------|--------|---------|----------|-----------|------------|----------|----------|
File       |  total | covered | # killed | # timeout | # survived | # no cov | # errors |
-----------|--------|---------|----------|-----------|------------|----------|----------|
All files  |  62.50 |   62.50 |       55 |         0 |         33 |        0 |        0 |
 fees.ts   |  70.37 |   70.37 |       19 |         0 |          8 |        0 |        0 |
 ledger.ts |  59.02 |   59.02 |       36 |         0 |         25 |        0 |        0 |
-----------|--------|---------|----------|-----------|------------|----------|----------|
```

**The survivors that matter** (from the same run's JSON report), and the test that killed each one:

| Survived mutant | The bug it represents | Killed by (step 1 tests) |
|---|---|---|
| `fees.ts:17` `amountMinor <= 0` → `< 0` | A ₹0 transfer is accepted | `rejects 0` |
| `fees.ts:21` `feeMinor * GST_PERCENT` → `/` | GST is wrong on every payout | Exact `toEqual` on the quote |
| `fees.ts:28` `Math.min(MAX, ...)` → `Math.max(MAX, ...)` | No ₹25 cap: ₹1 lakh pays ₹500 | `5_00_001` and ₹1 lakh rows |
| `fees.ts:33` `denominator / 2` → `* 2` | GST rounding is off by a paisa | The `45_000` row (40.5 → 41) |
| `ledger.ts:31` `=== "credit"` → `!==` | Debits and credits swapped everywhere | `applyEntries` exact balances |
| `ledger.ts:42` `<` → `<=` | Riya cannot spend her last paisa | Opening balance equals total debit |
| `ledger.ts:49-50` `> 0` → `>= 0` | ₹0 fee lines written (the DB `CHECK` rejects them) | Exact two-entry list for P2P |
| `ledger.ts:55-57` | `assertBalanced` never fails | Direct unbalanced-entries test |
| `ledger.ts:62-63` loop body removed | Balances never change | `applyEntries` exact balances |
| String literals for error codes | `INSUFFICIENT_FUNDS` becomes `""` | `toMatchObject({ code, message })` |

**Real output, after** (step 1 and step 4 tests):

```text
-----------|--------|---------|----------|-----------|------------|----------|----------|
File       |  total | covered | # killed | # timeout | # survived | # no cov | # errors |
-----------|--------|---------|----------|-----------|------------|----------|----------|
All files  |  98.86 |   98.86 |       87 |         0 |          1 |        0 |        0 |
 fees.ts   | 100.00 |  100.00 |       27 |         0 |          0 |        0 |        0 |
 ledger.ts |  98.36 |   98.36 |       60 |         0 |          1 |        0 |        0 |
-----------|--------|---------|----------|-----------|------------|----------|----------|
[Survived] CallExpression
src/domain/ledger.ts:51:3
-     assertBalanced(entries);
+     ;
```

That last survivor is the equivalent mutant from Deep dive 9. After the `// Stryker disable next-line all: ...` comment, an incremental run gave:

```text
	Result:		86 of 88 mutant result(s) are reused.
All files  | 100.00 |  100.00 |       87 |         0 |          0 |        0 |        0 |
```

in 7 s.

**Stryker results before and after**

| | Before (first AI draft) | After (step 1 + step 4 tests) |
|---|---|---|
| Tests | 9 | 29 |
| Line coverage | 100% | 100% |
| Branch coverage | 91.66% | 100% |
| Mutants killed | 55 of 88 | 87 of 88, then 87 of 87 with 1 ignored |
| Mutation score | **62.50%** | **98.86%**, then **100%** |
| Stryker time (command runner) | 61 s | 94 s full; 7 s incremental |

Branch coverage moved by about 8 points. The mutation score moved by about 36 points. That gap is exactly what coverage cannot see.

### Step 7: Run everything in GitHub Actions on every pull request

`.github/workflows/ci.yml`

```yaml
# Runs on every pull request and on main. Postgres and Redis come from service containers.
name: ci

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read

concurrency: # a new push to the same PR cancels the old run
  group: ci-${{ github.workflow }}-${{ github.head_ref || github.ref }}
  cancel-in-progress: true

jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    services:
      postgres:
        image: postgres:18-alpine
        env:
          POSTGRES_PASSWORD: postgres
        ports: ["5432:5432"]
        options: >-
          --health-cmd pg_isready
          --health-interval 5s
          --health-timeout 5s
          --health-retries 10
      redis:
        image: redis:8-alpine
        ports: ["6379:6379"]
        options: >-
          --health-cmd "redis-cli ping"
          --health-interval 5s
          --health-timeout 5s
          --health-retries 10
    env:
      # globalSetup sees these and skips Testcontainers.
      TEST_ADMIN_DATABASE_URL: postgres://postgres:postgres@localhost:5432/postgres
      TEST_REDIS_URL: redis://localhost:6379
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version-file: .nvmrc
          cache: npm
      - run: npm ci
      - run: npx tsc --noEmit
      - name: Unit and property tests, with coverage
        run: npx vitest run --project unit --coverage
      - name: Integration, HTTP and concurrency tests
        run: npx vitest run --project integration --sequence.shuffle
      - name: Every API operation has at least one HTTP test
        run: npx tsx scripts/contractCoverage.ts openapi/openapi.yaml reports/contract-hits.jsonl
      - uses: actions/upload-artifact@v7
        if: always()
        with:
          name: coverage
          path: coverage/
          retention-days: 7

  mutation:
    needs: test
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version-file: .nvmrc
          cache: npm
      - run: npm ci
      - name: Restore Stryker's incremental report
        uses: actions/cache@v6
        with:
          path: reports/stryker-incremental.json
          key: stryker-${{ github.head_ref || github.ref_name }}-${{ github.sha }}
          restore-keys: |
            stryker-${{ github.head_ref || github.ref_name }}-
            stryker-main-
      - name: Mutation testing on the ledger module (fails below the break threshold)
        run: npx stryker run --incremental
      - uses: actions/upload-artifact@v7
        if: always()
        with:
          name: mutation-report
          path: reports/mutation/
          retention-days: 7
```

`.github/workflows/flaky-hunt.yml`: the "20 runs in a row" measurement, every night.

```yaml
# Nightly: run the whole suite 20 times in shuffled order and report which seeds failed.
name: flaky-hunt

on:
  schedule:
    - cron: "30 21 * * *" # 03:00 IST
  workflow_dispatch:

permissions:
  contents: read

jobs:
  repeat:
    runs-on: ubuntu-latest
    timeout-minutes: 60
    services:
      postgres:
        image: postgres:18-alpine
        env:
          POSTGRES_PASSWORD: postgres
        ports: ["5432:5432"]
        options: --health-cmd pg_isready --health-interval 5s --health-timeout 5s --health-retries 10
      redis:
        image: redis:8-alpine
        ports: ["6379:6379"]
        options: --health-cmd "redis-cli ping" --health-interval 5s --health-timeout 5s --health-retries 10
    env:
      TEST_ADMIN_DATABASE_URL: postgres://postgres:postgres@localhost:5432/postgres
      TEST_REDIS_URL: redis://localhost:6379
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version-file: .nvmrc
          cache: npm
      - run: npm ci
      - name: Run the suite 20 times with different seeds
        run: |
          failed=""
          for i in $(seq 1 20); do
            seed=$((RANDOM * 100 + i))
            npx vitest run --sequence.shuffle --sequence.seed="$seed" > "run-$i.log" 2>&1 || failed="$failed $seed"
          done
          echo "Failing seeds:${failed:- none}" >> "$GITHUB_STEP_SUMMARY"
          test -z "$failed"
```

**What to notice**
- `TEST_ADMIN_DATABASE_URL` and `TEST_REDIS_URL` point `globalSetup` at the service containers, so CI and laptops run the same code.
- Health checks (`pg_isready`, `redis-cli ping`) make the job wait until the services are ready. Without them the first test can hit a database that is still starting.
- `permissions: contents: read` gives the workflow's token the least it needs.
- The integration step runs with `--sequence.shuffle` on every PR, so order-dependent tests fail early instead of one day.
- The mutation job restores the incremental report keyed by branch, falling back to `main`'s.
- The flaky hunt writes failing seeds to the job summary. Reproduce one locally with `--sequence.seed`.

**Real output** (`actionlint` 1.7.12 on both files):

```text
actionlint: no problems
```

**Branch protection** (repository settings, not YAML): require the `test` and `mutation` checks to pass before merge, and add a `CODEOWNERS` rule so that changes under `test/` need a reviewer.

---
## 💥 Break it and measure it

Each experiment breaks one thing on purpose and names the test that should catch it. The ones marked **Real** were run here.

| # | Break this | Test that should go red | Result |
|---|---|---|---|
| 1 | Remove `id` from `ORDER BY` and from the cursor in `listWalletEntries` | `walks every entry exactly once across pages` | **Real:** `expected [ 100, 200 ] to deeply equal [ 500, 400, 300, 200, 100 ]` |
| 2 | Check `quote.amountMinor` instead of `totalDebitMinor` in `buildEntries` | The ledger property test | **Real:** shrunk to Lakshmi paying out 1 paisa, balance −236 |
| 3 | Replace the unique-key claim with check-then-insert | Both concurrency tests | **Real** (Deep dive 7 script): 44 transfers applied, 20 of 20 rounds |
| 4 | Delete `beforeEach(() => truncateAll())` in `isolation.test.ts` | `second test can register riya@kirana.test` | **Real:** `expected { n: 2 } to deeply equal { n: 1 }` |
| 5 | Swap `Math.min` and `Math.max` in `payoutFee` | Fee rows at ₹5,000.01 and ₹1 lakh | **Real** (Stryker): the first-draft tests missed it; the step 1 tests killed it |
| 6 | Remove `Number(...)` from the wallet mapper | Contract check on `GET /v1/wallets/{walletId}` | **Real:** `data/balanceMinor must be integer` |
| 7 | Run the shared-state test file with `--sequence.shuffle` | The test that reads the flag | **Real:** 11 of 20 runs failed; 0 of 20 in file order |
| 8 | Set the clock to 01:00 IST and use `toISOString()` for the date | The settlement-date tests | **Real:** the UTC version returns `2026-10-14` for 15 Oct IST |
| 9 | Stop Docker in the middle of a run | Every integration test | **Expected:** connection errors, a loud red run, never a silent pass. Fill in what you see. |

### Measurements

One row per item in the card's Measure field.

| Measure | Here (**Real**) | Your machine (fill after the lab) |
|---|---|---|
| Suite runtime: unit project (32 tests) | 951 ms (Vitest duration) | |
| Suite runtime: unit + integration (38 tests, CI-style URLs) | 2.76 s Vitest duration; 3.76 s median wall-clock over 20 runs, including `npx` start-up | |
| Suite runtime: integration with Testcontainers start-up | Not run (no Docker here) | |
| Suite runtime: full suite on the P1-03 app (HTTP + concurrency included) | Not run here | |
| Suite runtime: the `test` job in GitHub Actions | Not run here | |
| Mutation score before (first AI-draft tests) | **62.50%** (55 of 88 killed) | |
| Mutation score after | **98.86%** (87 of 88); **100%** with 1 equivalent mutant marked | |
| Stryker run time | 61 s before, 94 s after (command runner); 7 s incremental | |
| Flaky failures in 20 shuffled runs: unit + integration | **0 of 20** | |
| Flaky failures in 20 runs: shared-state demo | **11 of 20** shuffled, 0 of 20 in file order | |
| Flaky failures in 20 runs: the fixed demo | **0 of 20** shuffled | |

---

## 🚫 Common mistakes and wrong mental models

### Wrong mental model: "high coverage means good tests"

Coverage records which lines **ran**. It does not record whether anything was **checked**. The first-draft tests in step 6 had 100% line coverage and still let 33 of 88 mutants live.

**Beginner way**

```ts
it("updates balances", () => {
  const next = applyEntries(balances, entries);
  expect(next.get("amit")).toBeDefined(); // Amit was already in the map with 0, so this can never fail
});
```

**Product way**

```ts
it("applies signed amounts and leaves the input map untouched", () => {
  expect(Object.fromEntries(applyEntries(before, entries))).toEqual({
    riya: 0, amit: 1_00_000, "platform:fee_revenue": 500, "platform:gst_payable": 90,
  });
  expect(before.get("riya")).toBe(1_00_590);
});
```

**What breaks in the beginner way:** Stryker deleted the whole loop in `applyEntries`, so balances never changed, and the test still passed.

### Mocking the database and missing real SQL bugs

**Beginner way**

```ts
const db = { query: vi.fn().mockResolvedValue({ rows: [{ wallet_id: "w_riya", balance_minor: 150_000 }] }) };
expect(await getWalletBalance(db, "w_riya")).toEqual({ walletId: "w_riya", balanceMinor: 150_000 }); // passes
```

**Product way**

```ts
const { riya } = await makeRiyaAndAmit(tx, 1_50_000); // real rows in real Postgres, rolled back afterwards
expect(await getWalletBalance(tx, riya.walletId)).toEqual({ walletId: riya.walletId, balanceMinor: 1_50_000 });
```

**What breaks in the beginner way:** the mock returns what you told it, a number. Real Postgres returns `"150000"`. The product-way test fails on the buggy mapper, which is exactly what you want, and passes once the mapper does `Number(row.balance_minor)`. In the mock-vs-real demo (Deep dive 3), the same three tests passed against the mock and all three failed against Postgres.

### Tests that share state, so the result depends on run order

**Beginner way**

```ts
it("is instant when the flag is on", () => {
  flags.instantPayouts = true; // a module-level object, never reset
  expect(payoutEta()).toBe("instant");
});
```

**Product way**

```ts
it("is instant when the flag is on", () => {
  expect(payoutEta({ instantPayouts: true })).toBe("instant"); // state passed in, nothing shared
});
// and for the database: one DB per worker + truncateAll() in beforeEach
```

**What breaks in the beginner way:** green in file order, red in 11 of 20 shuffled runs. Then someone adds a test above it and the "random" failures start.

### Accepting AI-written tests without checking that they fail when the code is broken

**Beginner way**

```ts
it("rejects when funds are low", () => {
  expect(() => buildEntries({ from: "amit", to: "riya", amountMinor: 100, kind: "p2p" }, balances)).toThrow();
});
```

**Product way**

```ts
it("rejects one paisa short with INSUFFICIENT_FUNDS", () => {
  const balances = opening().set("riya", 1_00_589);
  const error = ruleError(() => buildEntries({ from: "riya", to: "amit", amountMinor: 1_00_000, kind: "payout" }, balances));
  expect(error).toMatchObject({ code: "INSUFFICIENT_FUNDS", message: "need 100590, have 100589" });
});
```

**What breaks in the beginner way:** `toThrow()` passes for **any** error: a typo, a `TypeError`, the wrong rule. And "Amit has ₹0, sends ₹1" sits far from the boundary, so the `<` to `<=` mutant survived. Before you accept any test, break the code it claims to check and watch the test fail with the message you expect. Stryker does that for you, 88 times.

### More wrong mental models

| Wrong model | Correction |
|---|---|
| "The concurrency test passed once, so the race is fixed." | One green run is weak evidence. Repeat it (20 rounds, a nightly job), assert on the database, and show it fails on the broken version. |
| "Retries fix flaky tests." | Retries hide them, and on concurrency tests they hide real races. Find the cause with the seed. |
| "Mocks make tests fast, so mock more." | Postgres in a container costs milliseconds per test. Mocks are fast at checking the wrong thing. |
| "E2E tests are the most realistic, so write mostly E2E." | They are slow, flaky and bad at saying *what* broke. Keep a few smoke tests. |
| "Mutation score must be 100% everywhere." | Aim high on money code. Mark equivalent mutants with a reason. Skip glue code that integration tests already cover. |

---

## ✅ Production checklist

Before merging a change that touches money movement:

- [ ] Pure rules (fees, ledger) have boundary tests with exact values and error codes.
- [ ] Every invariant has a property test: entries sum to zero, money is conserved, no negative balances.
- [ ] Repositories are tested against real Postgres, never a mocked `query()`.
- [ ] Each integration test is isolated (database per worker, truncate or roll back) and passes in shuffled order.
- [ ] Every endpoint has `app.inject` tests for its documented outcomes, and every response is checked against `openapi.yaml`.
- [ ] `scripts/contractCoverage.ts` reports no untested operation.
- [ ] Anything with an idempotency key, a counter or a balance has a concurrency test that asserts on the database.
- [ ] That concurrency test was seen to **fail** once on the broken version.
- [ ] Mutation score on `src/domain` is at or above the break threshold (85%), and each ignored mutant has a written reason.
- [ ] No test depends on the real clock, real network, fixed ports or unseeded randomness.
- [ ] Third-party APIs sit behind a port and use fakes in tests; the real adapter has a sandbox test.
- [ ] CI runs on every pull request with service containers; branch protection requires it; `test/` has CODEOWNERS.
- [ ] Coverage is reported for review, not used as a merge gate.
- [ ] The nightly flaky hunt is green, or every failing seed has an owner.

---

## 🤖 Engineering with AI

**Where AI tools help with testing**
- Turning a rule written in plain words into a table of boundary rows (`it.each`).
- Writing factories from a schema, and scenario factories such as `makeRiyaAndAmit`.
- Suggesting properties for a function ("what must always be true here?").
- Turning a bug report into a failing test **before** anyone touches the fix.
- Reading Stryker's survivors and proposing the smallest test that kills each one.
- Writing the repetitive part of contract tests across many endpoints.

**Where AI tools commonly go wrong in tests**
- **Mirroring the implementation:** the expected value is computed by calling the code under test, so the test can never fail.
- **Weak assertions:** `toBeDefined()`, `toBeTruthy()`, `toHaveBeenCalled()`, a bare `toThrow()`.
- **Mocking everything:** `vi.mock("pg")`, mocked repositories, mocked Redis. Real SQL bugs then pass.
- **Editing the test to match buggy code:** the fastest way to green, and the most dangerous.
- **Fake concurrency:** an `await` inside the loop, so 50 "parallel" requests actually run one after another.
- **Missing `await`:** the test ends before the assertion runs, and it passes.
- **Real time and `sleep()`:** flaky by construction.
- **Snapshots of everything:** the next diff gets accepted with `-u`.
- **Leftovers:** `it.only`, `it.skip`, a global `retry: 3`.

**Review checklist for AI-written tests**
- [ ] I broke the code under test (or ran Stryker) and this test failed, with the expected message.
- [ ] Expected values are written out, not computed by the code under test.
- [ ] Assertions are exact (`toBe`, `toEqual`, `toMatchObject` with codes), not existence checks.
- [ ] Our own database and Redis are real; only third-party boundaries are doubles, behind our port.
- [ ] Each test creates its own data with factories and passes in shuffled order.
- [ ] Concurrency tests create all promises before awaiting, and assert on database state.
- [ ] Every promise is awaited; no `sleep`, no real clock, no `it.only`.
- [ ] The diff does not weaken an existing assertion. If it does, the reason is in the PR description.

**Tests as the spec for agents.** Put this in the repo's agent instructions file (`CLAUDE.md`, `AGENTS.md` or similar):

```md
## Tests
- Run `npm run test:unit` after every change and `npm test` before you say you are done.
- Tests under test/ are the specification. Never change an assertion to make a failing test pass.
  If you believe a test is wrong, stop and explain why instead of editing it.
- New behaviour needs a test that fails before your change. Show that failing run.
- Money code (src/domain) must keep the Stryker score at or above 85%: `npm run test:mutation`.
```

**Prompts that work**

1. *"Here is the fee rule in plain words: [rule]. Write Vitest `it.each` rows for every boundary: just below, at and just above each limit, with expected values worked out by hand in a comment. Do not import or call the implementation to compute expected values."*
   **Verify by:** run the rows against the current code. Then change one constant (for example the ₹25 cap) and confirm at least one row fails.
2. *"Here is Stryker's JSON report for `src/domain`. For each survived mutant, write the smallest test that kills it, or explain why it is equivalent. Do not change files under `src/`."*
   **Verify by:** `npx stryker run --incremental`. The survivors you were given must now be killed or marked with a reason you agree with.
3. *"Write a Vitest test that sends 50 parallel `POST /v1/transfers` with the same Idempotency-Key through `app.inject`, then asserts on the database (transfers, entries, both balances). Then tell me the smallest code change that should make it fail."*
   **Verify by:** apply that breaking change and watch the test go red; revert and watch it go green. Check that no `await` sits inside the loop that creates the requests.

---

## 🎤 Interview script

**How it comes up**
- **Machine-coding rounds** score testability: a pure core, dependencies passed in, and a few meaningful tests written in the time box.
- **Behavioural rounds** ask: *"How do you keep quality high when a lot of code is AI-generated?"*
- **System design follow-ups** ask: *"How would you test this idempotent transfer API?"*

**A 2-minute spoken answer: "How do you test a payments backend?"**

1. **(15 s) Shape.** "Mostly integration tests on real dependencies, a pure core with unit and property tests, contract checks on every response, and a few E2E smoke tests. The value in a backend is at the boundaries, so that is where most tests go."
2. **(25 s) Real dependencies.** "Postgres and Redis run in Testcontainers locally and as service containers in CI. Each worker gets its own database cloned from a migrated template, and tests truncate or roll back. Mocks are only for third parties like the bank, behind our own interface."
3. **(25 s) Money invariants.** "fast-check generates random transfer sequences and checks that entries sum to zero, money is conserved and no balance goes negative. When it fails, it shrinks to something like 'one payout of one paisa', which is a ready-made bug report."
4. **(25 s) Races.** "For idempotency and locking I fire 50 parallel requests and assert on the database: one transfer, two entries, the right balances. I also run it against the broken version once to prove it can fail."
5. **(20 s) Quality of tests.** "Coverage only says what ran. I use Stryker's mutation score on the money module. An AI-written suite with 100% coverage scored 62.5% for me; after fixing the assertions it was about 99%."
6. **(10 s) CI.** "All of it runs on every PR, shuffled, and a nightly job runs the suite 20 times to catch flaky tests early."

**Five likely follow-ups**

1. **"Isn't a real database too slow for tests?"** Containers start once per run. A test costs milliseconds. Here, 38 tests including 6 database tests took 2.76 s. Cloning a migrated template avoids re-running migrations for every file. Slowness usually comes from poor isolation, not from Postgres.
2. **"How do you isolate tests that go through the app, when the app commits its own transactions?"** Roll back cannot work there. Use one database per worker and truncate before each test, keeping reference data. Use roll back only for repository code that accepts a client.
3. **"How do you know your concurrency test isn't just lucky?"** Three things: it asserts on database state, it fails reliably on the broken version (20 of 20 rounds here), and it runs many times (a nightly 20-run job). For in-process races, `fc.scheduler` explores many orderings on purpose.
4. **"What if the mutation score is low but coverage is high?"** That is the normal state of AI-written or deadline-written tests. Read the survivors; each one is a missing assertion or a missing boundary. Kill the ones that map to money bugs. Mark true equivalents with a reason. Gate CI on a threshold for the money module only.
5. **"When would you use Pact instead of OpenAPI validation?"** When there are many consumers whose releases you do not control, for example old Android versions or other teams' services. Then a pact per consumer plus `can-i-deploy` stops a provider change from breaking a specific consumer. For one consumer in the same repo, response validation is enough.

**Red flags interviewers notice**
- "We have 90% coverage" given as proof of quality.
- Mocking the ORM or database driver in "integration" tests.
- A concurrency test that awaits each request in a loop.
- No answer to "how do you know the test can fail?"
- "We just re-run flaky tests."
- Accepting AI-written tests because they are green.

**Machine-coding sketch: design for testability.** Everything that does I/O, reads time or makes ids comes in through the constructor. The pure core (`buildEntries`) is called from the service and tested on its own.

```ts
// A machine-coding sketch: every source of I/O, time and randomness comes in through the constructor.
import type { Balances, Entry, TransferRequest } from "../src/domain/ledger.js";
import { buildEntries } from "../src/domain/ledger.js";

export interface Clock { now(): Date }
export interface IdGenerator { next(): string }
export interface LedgerStore {
  // Runs `work` in one transaction with the source wallet locked; the real one uses Postgres.
  withLockedBalances<T>(walletIds: string[], work: (balances: Balances) => Promise<T>): Promise<T>;
  appendEntries(transferId: string, entries: Entry[], at: Date): Promise<void>;
}

export class TransferService {
  constructor(private readonly deps: { store: LedgerStore; clock: Clock; ids: IdGenerator }) {}

  async transfer(req: TransferRequest): Promise<{ transferId: string; entries: Entry[] }> {
    return this.deps.store.withLockedBalances([req.from, req.to], async (balances) => {
      const entries = buildEntries(req, balances); // pure core: unit and property tested
      const transferId = this.deps.ids.next();
      await this.deps.store.appendEntries(transferId, entries, this.deps.clock.now());
      return { transferId, entries };
    });
  }
}
```

**What to notice**
- In a machine-coding round, the in-memory `LedgerStore` is a **fake** you can write in 15 lines. In production it is Postgres, tested with Testcontainers.
- `Clock` and `IdGenerator` make every test deterministic, with no `vi.useFakeTimers()` needed.
- The interesting logic stays in `buildEntries`, so most of the round's tests are fast, exact unit tests.

---
## ❓ Questions from the card, answered

Try to answer each one yourself first, then open the answer.

<details>
<summary><b>1. Why are integration tests on a real database worth more than mocking the ORM?</b></summary>

Because in a backend the database is half of the program, and a mock contains only your guesses about it.

- **A mock returns what you told it.** Real Postgres returned `bigint` as the string `"150000"`. It rejected an `ON CONFLICT` target that matched no unique constraint, and it rejected a ₹0 entry through a `CHECK`. The same three tests passed against a mock and failed against Postgres (Deep dive 3).
- **SQL is code.** Joins, `ORDER BY` with ties, keyset cursors, parameter types (`42P08` in my own factory) and locks only run in the database. A test with a mocked ORM never executes them.
- **Constraints are your last line of defence.** A real database enforces the P2-01 constraints in every test for free, so a bug upstream (the `>= 0` fee mutant) still fails loudly.
- **The cost is now small.** Testcontainers starts Postgres once per run. Cloning a migrated template and truncating takes milliseconds. Here, 38 tests including 6 database tests took 2.76 s.
- **Mock-based tests also lock in the implementation.** They assert "this query was called with these arguments", so a correct refactor breaks them, while a real-database test only checks behaviour.

Mocks still have a place: at boundaries you do not own (Question 2).
</details>

<details>
<summary><b>2. What should you mock, and what should you never mock?</b></summary>

**Replace with a double (behind your own interface):** third-party systems you do not own or control. The bank payout API, SMS and email gateways, KYC vendors, and anything that costs money per call or whose data you cannot reset. Prefer a **fake** with the vendor's real rules (same ref, same answer) over a mock that only checks calls. Test the real adapter separately against the vendor's sandbox or an HTTP-level stub.

**Inject rather than mock:** time, sleep and random ids. Pass a `Clock`, a `sleep` or an `IdGenerator` in, or use `vi.useFakeTimers()` and `vi.setSystemTime()` for code you cannot change.

**Never mock:**
- Your own database and Redis in integration tests. Your SQL and your Lua scripts are your code.
- The ORM or driver (`vi.mock("pg")`).
- The unit you are testing, or parts of it.
- Your own repositories inside service tests, when the real database costs milliseconds.
- Anything just to make a slow test fast. Fix the isolation instead.

Rule of thumb: **if you own it, run it for real; if you don't own it, put it behind a port and fake the port.**
</details>

<details>
<summary><b>3. How do you prove a race condition is actually fixed?</b></summary>

A single green run proves almost nothing. A convincing proof has five parts:

1. **A test that creates the race.** Start all requests at once (`Promise.all` over 50 requests, no `await` in the loop), with enough database connections that they really overlap.
2. **Assertions on the database, not just responses.** One transfer row, two entries, the right balances, and total money unchanged.
3. **Red on the broken version.** Run the test against the old code, or a deliberately broken version, and watch it fail. The naive code failed 20 of 20 rounds here (44 transfers from one request). If the test cannot fail, it proves nothing.
4. **Green, many times, on the fixed version.** 0 of 20 rounds failed here, and a nightly job runs the whole suite 20 times with shuffled order.
5. **A reason the fix is correct.** A test samples timings; it does not cover all of them. Point to the mechanism: a unique index that lets exactly one claim win, an atomic conditional `UPDATE`, or a row lock. For races inside one process, `fc.scheduler` tries many orderings on purpose and shrinks the failing one.
</details>

<details>
<summary><b>4. What does mutation testing tell you that coverage cannot?</b></summary>

Coverage tells you a line **ran**. Mutation testing tells you whether a test would **fail if that line were wrong**.

On the ledger module, the first AI-written suite had 100% line coverage, and Stryker showed that 33 of 88 deliberate bugs went unnoticed. Among them: no ₹25 fee cap, debits and credits swapped, and the balance loop deleted. After fixing the assertions, coverage barely moved (91.66% to 100% branches) while the mutation score went from 62.50% to 98.86%.

So mutation testing tells you:
- **Which assertions are too weak** (`toBeDefined`, bare `toThrow`).
- **Which boundaries are untested** (`<` vs `<=`, ₹0 amounts).
- **Which code is dead or purely defensive** (equivalent mutants, such as the `assertBalanced` safety net).
- **Whether you can trust a test suite you did not write**, including one an AI wrote.

Its cost is CPU time (mutants × tests), so run it on money-critical modules and incrementally in CI.
</details>

---

## 🏋️ Exercises

**Beginner (no code)**

1. Draw the test shape of a project you work on today. Mark which layer each existing test belongs to.
   *Expected outcome:* you can name the biggest layer and one risk of the shape.
   *Verify by:* explaining to a teammate why the bigint-as-string bug would or would not be caught.
2. Take five tests from any codebase and, for each one, write the smallest code change that would still pass it.
   *Expected outcome:* at least one weak assertion found.
   *Verify by:* make that change for real and run the test.

**Intermediate (extend the lab)**

1. Add HTTP tests for the `wallets` resource until `scripts/contractCoverage.ts` no longer lists `GET`, `POST` or `PATCH` wallet operations. Include `412` and `428` for `PATCH` with `If-Match`.
   *Expected outcome:* the "operations with NO test" list shrinks by three.
   *Verify by:* the script's output, and one contract failure seen on purpose (remove `ETag` from the response).
2. Add a property: for any cursor, `decode(encode(cursor))` equals the cursor, and paging through any number of entries with any page size returns every entry exactly once.
   *Expected outcome:* passes on the real repository, and fails on a version without the `id` tie-breaker (Break it, row 1).
   *Verify by:* the shrunk counterexample from the buggy version.
3. Add a test for `409 IDEMPOTENCY_KEY_REUSED`: the same key with a different body.
   *Expected outcome:* 409, Problem Details matching the spec, and no second transfer row.
   *Verify by:* remove the request-hash comparison in `claimKey` and watch it fail.

**Advanced (failure injection and 10x)**

1. **10x concurrency:** 500 parallel duplicates, with the app's pool at 10 and then at 50. Record the split of 201, 201-replay and 409, and the run time.
   *Expected outcome:* still exactly one transfer. The 409 share grows with more overlap.
   *Verify by:* `ledgerState`, and the nightly flaky hunt staying green.
2. **Model-based testing:** use `fc.commands` to run random sequences of "transfer", "replay" and "check balance" against the API through `app.inject`, and against a plain `Map` model.
   *Expected outcome:* the model and the real system agree. Break idempotency and get a shrunk command sequence.
   *Verify by:* the printed command list replays the failure with its seed.
3. **Mutation testing beyond the domain:** run Stryker on `src/repositories/idempotencyRepository.ts` with the integration project as the test command (the vitest runner's `related` setting does not apply to the command runner; scope the command to `test/integration test/concurrency`).
   *Expected outcome:* a much slower run. Survivors point at SQL paths no test covers.
   *Verify by:* the time per mutant, compared with the domain module.

---

## 📝 Quiz

1. A suite has 100% line coverage. What does that tell you about bug detection?
2. Why can't you use transaction roll-back isolation for a test that calls `POST /v1/transfers` through `app.inject`?
3. node-postgres returns a `bigint` column as what JavaScript type, and which kind of test catches a missing conversion?
4. What does fast-check do after it finds a failing input, and what two values let you replay it?
5. In a concurrency test, what is wrong with `for (let i = 0; i < 50; i++) await send();`?
6. Stryker reports a survived mutant that removes a defensive `assertBalanced(entries)` call no valid input can reach. What should you do?
7. Which service gets a test double on the ledger platform: Postgres, Redis, or the bank payout API? Why?
8. A test passes at 3 pm and fails in the 1 am CI run. Name the likely cause and the fix.
9. What does `--sequence.shuffle` add to a CI run?
10. Your coverage gate is 90%, and an AI agent's PR adds tests that reach it. What check would you add before trusting them?

### Answer key

1. Only that every line ran. Bug detection needs checks; the first-draft suite here had 100% line coverage and a 62.50% mutation score.
2. The app opens and commits its own transaction, so the test's `BEGIN ... ROLLBACK` cannot wrap it. Use a database per worker and truncate before each test.
3. A `string` (it has no registered type parser). A test against real Postgres catches it, best with a contract check (`balanceMinor must be integer`).
4. It shrinks the input to a smaller failing case, then reports it with the `seed` and `path`; pass both to `fc.assert` to replay.
5. Each request waits for the previous one, so nothing runs in parallel and the race can never happen. Build all promises first, then `await Promise.all(...)`.
6. Treat it as an equivalent mutant: mark it with `// Stryker disable next-line all: <reason>`, and test `assertBalanced` directly.
7. The bank payout API: it is a third party you do not own, it moves real money and you cannot reset its data. Postgres and Redis are yours, so they run for real.
8. Time: the code uses the UTC date (`toISOString()`), which is still "yesterday" between 00:00 and 05:30 IST. Use an IST calendar date and control the clock in tests with `vi.setSystemTime`.
9. It runs files and tests in random order (with a printed seed), so tests that depend on each other's leftover state fail early.
10. A mutation run (Stryker) on the changed money code, and a manual check that each new test fails when the code it covers is broken.

---

## 📖 Glossary

| Term | Meaning |
|---|---|
| `app.inject` | Fastify's in-process fake HTTP request (light-my-request); no socket is opened. |
| Arbitrary | In fast-check, a generator of random values that also knows how to shrink them. |
| Boundary test | A test at, just below or just above a limit. |
| `can-i-deploy` | A Pact Broker check that a version is compatible with what is deployed. |
| Check-then-act | Reading a condition and acting on it in two separate steps; another request can act in between. |
| Command runner | Stryker's framework-neutral runner: runs a shell command per mutant. |
| Consumer-driven contract | A contract written from what a consumer actually uses (Pact). |
| Equivalent mutant | A mutant that cannot change observable behaviour, so no test can kill it. |
| Factory | A function that builds valid test data with defaults and overrides. |
| Fake | A small working implementation with real rules, used instead of a real service. |
| Flaky test | A test whose result changes without a code change. |
| `globalSetup` | Vitest code that runs once per run, before any worker starts. |
| Incremental mode | Stryker reuses results for code and tests that did not change. |
| Lost update | Two writers read the same value and the second write erases the first. |
| Mock | A double with built-in expectations about how it is called. |
| Mutation score | Detected mutants ÷ valid mutants. |
| Pact file | The JSON contract a consumer test produces. |
| Port | Your own interface in front of an outside system, such as `PayoutProvider`. |
| Property | A rule that must hold for all inputs. |
| `provide` / `inject` | Vitest's way to pass values from `globalSetup` to test workers. |
| Ryuk | Testcontainers' reaper container, which removes containers if tests crash. |
| Service container | A container GitHub Actions starts next to a job (Postgres, Redis). |
| Shrinking | Reducing a failing random input to the smallest one that still fails. |
| Spy | A double that records calls for later checks. |
| Stub | A double that returns canned answers. |
| Template database | A migrated database that `CREATE DATABASE ... TEMPLATE` copies for each worker. |
| Testcontainers | A library that starts throwaway Docker containers from test code. |
| Testing trophy | A test shape with integration tests as the largest layer. |
| Truncate | Empty tables quickly with `TRUNCATE ... RESTART IDENTITY CASCADE`. |
| `VITEST_POOL_ID` | The worker number (1 to `maxWorkers`), used to name per-worker databases. |

---

## 🗒️ Cheat sheet

```mermaid
mindmap
  root((Testing backends))
    Shape
      Trophy for backends
      Integration is the widest
      Pure core gets unit tests
    Real dependencies
      Testcontainers locally
      Service containers in CI
      DB per worker from template
      Truncate or roll back
      Factories not fixtures
    HTTP and contracts
      app.inject on every route
      Responses vs openapi.yaml
      Contract coverage script
      Pact for many consumers
    Doubles
      Fake third parties behind a port
      Never mock your own DB
      Inject clock and sleep
    Proof
      Properties with fast-check
      50 parallel requests
      Assert on the database
      Watch it fail once
    Quality of tests
      Coverage is a signal
      Mutation score is the gate
      Shuffle and hunt flakes
```

**How to read this diagram.** The centre is the card. Each branch is one decision area, and its leaves are the rules to remember. Read it before an interview or when you review a test PR.

**Rules on one screen**

- Most backend bugs live at the boundaries, so most tests should cross them: real Postgres, real Redis, real HTTP pipeline.
- Pure rules get exact, table-driven unit tests at every boundary, plus property tests for invariants.
- Isolation: one database per worker (template clone), truncate before each HTTP test, roll back for repository tests, unique keys in Redis.
- Every HTTP test checks the response against `openapi.yaml` and checks the database side-effect.
- Mock only what you do not own, through your own port. Prefer fakes. Inject time.
- Concurrency proof: `Promise.all`, assert on the database, repeat, and see it fail on the broken code.
- Judge tests with a mutation score, not coverage. Mark equivalent mutants with a reason.
- Check that your tools can fail: kill one mutant by hand, break one line and watch the test go red.
- CI on every PR, shuffled order, service containers, cached installs, and a nightly 20-run flaky hunt.
- With AI: tests are the spec. Agents must not weaken assertions, and `test/` needs a human reviewer.

---

## ✔️ Completion checklist

**Card measures**
- [ ] Suite runtime recorded: unit, integration with Testcontainers, full suite, and the GitHub Actions job.
- [ ] Mutation score recorded before and after improving the tests, with the survivors you killed.
- [ ] Flaky failures recorded over 20 shuffled runs of the full suite (target: 0).

**Lab steps**
- [ ] Step 1: fee and ledger unit tests pass, with boundary rows and error codes.
- [ ] Step 2: the integration suite runs on Testcontainers, each test isolated; the isolation guard passes in shuffled order.
- [ ] Step 3: every operation in `openapi.yaml` has an `app.inject` test; the contract-coverage script exits 0.
- [ ] Step 4: the ledger property passes, and I saw it shrink a real failure.
- [ ] Step 5: 50 parallel duplicates apply exactly once, and I saw the test fail on broken code.
- [ ] Step 6: Stryker runs on `src/domain`, with the score above the break threshold.
- [ ] Step 7: the CI workflow runs on a real pull request and blocks merge when a test fails.

**Phase 1 gate**
- [ ] I can explain the testing trophy for a backend and defend "mostly integration" in an interview.
- [ ] I can review an AI-written test PR with the checklist above.

**Publishing**
- [ ] Lab run on my machine.
- [ ] My numbers filled in the measurements table.
- [ ] One post published from the ideas below.

---

## 📣 Learn in public

Use **your own** measured numbers. The numbers here are from this guide's sandbox.

**Post 1: "100% coverage, 62% of bugs caught"**
- *Problem:* an AI assistant wrote tests for my ledger module. 100% line coverage, all green.
- *Decision:* I ran Stryker mutation testing on it before trusting it.
- *Result:* the tests missed [33 of 88] deliberate bugs, including no fee cap and swapped debits and credits. After fixing the assertions: [98.86%].
- *Lesson:* coverage shows what ran, not what was checked. Ask "would this test fail if the code were wrong?"

**Post 2: "Fifty taps on Pay"**
- *Problem:* does my idempotency really work when a user taps "Pay" 50 times on a slow network?
- *Decision:* a test that fires 50 parallel requests at real Postgres and checks the database, not the responses.
- *Result:* the naive version applied [44] transfers and created [₹21,000] from nothing, in [20 of 20] rounds. The fixed version: exactly one, in [20 of 20].
- *Lesson:* a concurrency test is only proof if you have seen it fail on the broken code.

**Post 3: "My mocks lied to me"**
- *Problem:* three repository tests passed with a mocked database.
- *Decision:* run the same tests against Postgres in a container.
- *Result:* all three failed: bigint came back as a string, an `ON CONFLICT` matched nothing, and a `CHECK` rejected a ₹0 line.
- *Lesson:* never mock what you own. Containers make the real thing cheap.

**Hinglish video idea: "Coverage 100%, phir bhi bug? Mutation testing samjho"**
Open with the first-draft tests on screen and the coverage report at 100%. Then run Stryker live and show `Math.min` changed to `Math.max` surviving: "fee cap gayab, test phir bhi green". Fix the tests one boundary at a time and re-run until the score crosses 95%. Close with the Vitest 5 runner story: tool ne 0% bola, check karo tool sach bol raha hai ya nahi.

---

## ➡️ Next cards

- **P2-04 · Concurrency control.** This card proved races exist and showed tests that catch them. P2-04 explains the fixes in depth: isolation levels, `SELECT ... FOR UPDATE`, atomic conditional updates, optimistic versions and deadlocks. Each fix there should come with a concurrency test from this card.
- **P5-04 · Feature flags.** The shared-flag demo in Deep dive 11 was a flaky test caused by a global flag. P5-04 builds a real flag system. The testing rules carry over: pass flag values in, test both sides of every flag, and never let one test's flag leak into another.

---

## 🔗 Sources and further reading

All links checked on 14 Oct 2026.

- [Vitest: migration guide](https://vitest.dev/guide/migration) — Vitest 5 changes: Node and Vite requirements, `clearMocks` default, removed `sequential`, fake timers and `Temporal`.
- [Vitest: globalSetup](https://vitest.dev/config/globalsetup) — `setup(project)`, `project.provide`, `inject`, `ProvidedContext`.
- [Vitest: sequence options](https://vitest.dev/config/sequence) — `sequence.shuffle`, `sequence.seed`.
- [Testcontainers for Node: PostgreSQL module](https://node.testcontainers.org/modules/postgresql/) — `PostgreSqlContainer`, `getConnectionUri`, `snapshot` and `restoreSnapshot`.
- [fast-check: getting started](https://fast-check.dev/docs/introduction/getting-started/) and [race conditions](https://fast-check.dev/docs/advanced/race-conditions/) — properties, shrinking and `fc.scheduler`.
- [StrykerJS: configuration](https://stryker-mutator.io/docs/stryker-js/configuration/), [vitest runner](https://stryker-mutator.io/docs/stryker-js/vitest-runner/) and [mutation switching (Stryker 4)](https://stryker-mutator.io/blog/announcing-stryker-4-beta-mutation-switching/).
- [Pact: introduction](https://docs.pact.io/) and [how Pact works](https://docs.pact.io/getting_started/how_pact_works).
- [GitHub Docs: PostgreSQL service containers](https://docs.github.com/en/actions/tutorials/use-containerized-services/create-postgresql-service-containers) and [actions/setup-node](https://github.com/actions/setup-node).
- [actionlint](https://github.com/rhysd/actionlint) — the workflow linter used in step 7.
- [Fastify: testing guide](https://fastify.dev/docs/latest/Guides/Testing/) — `inject`, and supertest with `fastify.server`.
- [node-postgres: data types](https://node-postgres.com/features/types) — types without a parser, such as `int8`, come back as strings.
- [PostgreSQL 18: current date and time](https://www.postgresql.org/docs/18/functions-datetime.html) — `now()` is fixed for the whole transaction.
- [PostgreSQL 18: template databases](https://www.postgresql.org/docs/18/manage-ag-templatedbs.html) — cloning with `CREATE DATABASE ... TEMPLATE` and its connection rule.
- [Redis: EXPIRE](https://redis.io/docs/latest/commands/expire/) — the `NX` option.
- [Ajv: JSON Schema](https://ajv.js.org/json-schema.html) — draft 2020-12 support, the dialect of OpenAPI 3.1 schemas.
- [Kent C. Dodds: The Testing Trophy and Testing Classifications](https://kentcdodds.com/blog/the-testing-trophy-and-testing-classifications) (2021).
- [Martin Fowler: Test Pyramid](https://martinfowler.com/bliki/TestPyramid.html) (2012) and [Mocks Aren't Stubs](https://martinfowler.com/articles/mocksArentStubs.html).
- Versions: the npm registry (`npm view <package> version`) and the GitHub tags of `actions/checkout`, `actions/setup-node`, `actions/cache` and `actions/upload-artifact`, 14 Oct 2026.
