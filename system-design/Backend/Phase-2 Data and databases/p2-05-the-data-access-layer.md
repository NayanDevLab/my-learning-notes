# P2-05 · The data access layer: pooling, N+1, ORMs

| | |
|---|---|
| **Phase** | 2 · Data and databases |
| **Prerequisites** | P2-02 · Indexes and query plans |
| **Leads to** | P3-03 · Load balancing and horizontal scaling · P5-07 · Cost engineering |
| **Repo path** | `system-design/phase-2/p2-05-the-data-access-layer.md` |

**After this card you can:**

1. Do the connection arithmetic for any deployment (pods × pool size, plus deploys and admin headroom) and choose pool sizes and PgBouncer settings from it.
2. Spot an N+1 query in code review and in per-request query counts, and fix it with a `LATERAL` join, a batched `= ANY($1)` query or DataLoader.
3. Choose between Prisma, Drizzle, Kysely and plain node-postgres, and know when to drop to raw SQL.
4. Protect every query with parameters and time limits, route reads to replicas without showing stale balances, and load bulk data with multi-row inserts or `COPY`.
5. Explain what PgBouncer's transaction mode breaks, and why serverless functions need a pooled proxy.

> **About the numbers in this guide.** Everything marked **Real output** was run while writing this guide on 24 Oct 2026, on a 2-vCPU Linux sandbox with PostgreSQL 16.15, PgBouncer 1.22.0 (the Ubuntu 24.04 package), Node.js 22.22, node-postgres 8.23.1, Drizzle 0.45.4, Kysely 0.29.7, DataLoader 2.2.3 and pg-copy-streams 7.0.0. Postgres, PgBouncer, a streaming replica and the app all ran on the same machine. Where "network delay" is mentioned, a small TCP proxy added about 2.5 ms to every round trip, to imitate a database in another availability zone. Compare directions and ratios, not decimals. Anything marked **Expected** was not run here.
>
> **Versions** (checked 24 Oct 2026): PgBouncer 1.26.1 is the latest release (14 Oct 2026). Since 1.24.0, `max_prepared_statements` defaults to 200; on 1.22 (used here) it defaults to 0, which matters in Deep dive 2. Prisma ORM 7 is the supported line and Prisma ORM 8 is a release candidate (P2-03).

---

## 🧭 The concept in one minute

The **data access layer** is the code between your route handlers and the database: the connection pool, the repositories that build queries, the ORM or query builder, timeouts and routing. Most "the database is slow" incidents start here, not in Postgres.

Three ideas carry this card:

- **Connections are expensive and limited.** Each one is a whole Postgres process. Reuse them through a **pool**, and keep the **total** across all your servers under the database's limit.
- **Round trips add up.** A page that runs one query per row (an **N+1**) is fast on your laptop and slow in production, where every round trip crosses a network.
- **The database must protect itself.** Parameters stop SQL injection, `statement_timeout` stops runaway queries, and a pooler such as PgBouncer stops connection storms.

**One line:** few connections, few round trips, and every query bounded in time.

**Analogy: a dabbawala team.** Postgres is the kitchen, and connections are dabbawalas. Hiring a new dabbawala for every tiffin (a new connection per request) wastes time on hiring. Hiring 500 for a kitchen that can fill 20 tiffins at a time (a huge pool) just fills the kitchen door with people waiting. And sending one dabbawala on 51 separate trips to deliver 51 tiffins to one office (N+1) is slower than one trip with a crate.

**On the ledger platform.** Chai Point's dashboard lists its 50 outlet wallets with their last five transactions. Written the obvious way, it runs **51 queries**; with about 2.5 ms per round trip, that took **136 ms** at p50. One `LATERAL` query returned the same data in **4.1 ms**.

---

## 🔥 The problem it solves

Here is the ledger API before this card. Every number was measured in this guide.

1. **The N+1 dashboard.** "Wallets with last five transactions" ran **51 queries** for Chai Point's 50 wallets: p95 **144.5 ms** with network delay, against **5.3 ms** for a single query.
2. **Four app instances with pools of 30** against Postgres's default `max_connections = 100`: **84 of 1,600 queries failed** with `53300 sorry, too many clients already` while the load lasted.
3. **A new connection per request.** Opening, authenticating, querying and closing took **5.5 ms** on localhost, against **0.08 ms** for a query on a pooled connection: about 69 times slower.
4. **"More connections = more throughput."** On the same 2-CPU database, read-only throughput was **50,477 transactions/s with 4 clients** and **34,807/s with 96**, while average latency grew 35 times.
5. **A search box built by string concatenation.** The input `' OR '1'='1' --` returned **all 2,050 wallets** instead of the user's own, and a second input **renamed another user's wallet**.
6. **A bank-statement import, one `INSERT` per row.** **4,166 rows/s** on localhost, and **325 rows/s** with network delay. `COPY` loaded **2,06,201 rows/s**.

This card fixes each one.

---

## 📚 Before you start

**Earlier cards used here:** P2-02 (the covering index `ledger_entries_by_wallet`, `EXPLAIN`, `pg_stat_statements`), P2-03 (`withTransaction`, `statement_timeout`, `lock_timeout`, `idle_in_transaction_session_timeout`), P1-08 (`AsyncLocalStorage` and pino logging), P1-03 (Problem Details errors), P1-07 (Vitest with a test database).

**Key terms**

| Term | Plain meaning |
|---|---|
| Connection | One open TCP session between your app and Postgres; on the server it is one operating-system process. |
| `max_connections` | The most connections Postgres accepts at once (100 by default); 3 are kept for superusers. |
| Connection pool | A set of open connections that requests borrow and return, instead of opening their own. |
| Pool size (`max`) | How many connections one pool may open. Total = pool size × number of app processes. |
| PgBouncer | A lightweight proxy that sits in front of Postgres and shares a few server connections among many clients. |
| Session / transaction pooling | PgBouncer modes: a server connection is tied to a client for the whole session, or only for one transaction. |
| Round trip | One request to the database and its answer; costs the network delay twice. |
| N+1 query | One query for a list, then one more query for each item in it. |
| DataLoader | A small library that collects many "load this id" calls in one tick and runs one batched query. |
| ORM | Object-relational mapper: you work with objects and relations, it writes the SQL (Prisma). |
| Query builder | You write SQL-shaped code in TypeScript, with types (Kysely, Drizzle's core API). |
| Parameterised query | SQL text with placeholders (`$1`), and values sent separately, so values are never read as SQL. |
| Read replica | A copy of the database that follows the primary through the WAL; serves reads, may lag behind. |
| `COPY` | Postgres's bulk-load command: streams many rows in one statement. |

---

## 🧠 How it works

### Mental model: the connection budget is shared by everyone

- **Postgres runs one process per connection.** Each connection costs memory, a slot in `max_connections`, and CPU time to switch between processes. More connections than CPU cores do not make the database do more work; they make it switch more.
- **Every app process has its own pool.** Four pods with `max: 30` can open 120 connections. The database does not see "four apps"; it sees 120 clients.
- **A pooler multiplexes.** PgBouncer accepts hundreds of client connections and serves them with a few server connections, one transaction at a time.
- **Latency is paid per round trip.** One query that returns 250 rows costs about one round trip. Fifty-one queries cost fifty-one.

React comparison: a connection pool is like a small, fixed set of Web Workers that all your components share, rather than spawning a new worker per click. And an N+1 is the backend version of fetching inside a list item's `useEffect`: 50 rows, 50 network requests.

### Diagram: app instances, pools, PgBouncer and Postgres (must-include)

**Diagram: where connections come from and where they are shared**

```mermaid
flowchart TD
  subgraph APP["4 app instances (pods)"]
    A1["ledger-api 1<br/>pg.Pool max 8"]
    A2["ledger-api 2<br/>pg.Pool max 8"]
    A3["ledger-api 3<br/>pg.Pool max 8"]
    A4["ledger-api 4<br/>pg.Pool max 8"]
  end
  B["PgBouncer, transaction mode<br/>up to 1,000 client connections<br/>default_pool_size 20"]
  P["Postgres primary<br/>max_connections 100<br/>20 busy backends"]
  R["Read replica<br/>its own connections"]
  A1 -->|"8 client conns"| B
  A2 -->|"8 client conns"| B
  A3 -->|"8 client conns"| B
  A4 -->|"8 client conns"| B
  B -->|"20 server conns"| P
  A1 -.->|"reads that may lag"| R
  P -.->|"WAL stream"| R
```

**How to read this diagram.** Each pod keeps its own small pool (8 connections), so 4 pods hold 32 client connections. They connect to PgBouncer, not to Postgres. PgBouncer lends each transaction one of its 20 server connections and takes it back at `COMMIT`, so Postgres sees at most 20 busy backends however many pods you run. Reads that can tolerate a little staleness may go to a replica (dotted), which follows the primary through the WAL stream (Deep dive 7).

---

## 🔬 Deep dive

### 1. The cost of a connection: one process, one slot, some memory

**What it is.** When a client connects, Postgres starts (forks) a new backend **process** for it, authenticates it (SCRAM, often over TLS), and keeps that process alive until the client disconnects. So a connection costs:

- **Time to open:** several network round trips plus password hashing on the server.
- **A slot:** `max_connections` (100 by default; 3 of them kept for superusers via `superuser_reserved_connections`).
- **Memory:** each process has its own private memory, which grows with what it does (sorts and hashes can each use up to `work_mem`, 4 MB by default, per operation), on top of the shared buffer cache all processes share.
- **CPU scheduling:** hundreds of busy processes on a few cores spend time switching instead of working.

**Minimal version** (from `bench/connectionCost.ts`): a new client per query vs a pooled connection, 100 times each.

```ts
for (let i = 0; i < 100; i++) {                       // a new client per request: connect, auth, query, close
  const client = new pg.Client({ connectionString: url(port) });
  await client.connect(); await client.query("SELECT 1"); await client.end();
}
const pool = new pg.Pool({ connectionString: url(port), max: 5 });
for (let i = 0; i < 100; i++) await pool.query("SELECT 1"); // reuse an open, authenticated connection
```

**Real output**

```text
localhost        | new client per query: p50 5.52 ms, p95 7.58 ms | pooled: p50 0.08 ms, p95 0.17 ms
+ network delay  | new client per query: p50 13.56 ms, p95 15.18 ms | pooled: p50 2.50 ms, p95 2.70 ms
50 connections -> 50 backend processes | private memory per backend: idle 1.1 MB, after one join query 1.7 MB (max 1.7 MB)
```

**What to notice**
- **On localhost, opening a connection cost 5.5 ms; reusing one cost 0.08 ms**: about 69 times more, mostly SCRAM authentication and process start.
- **With 2.5 ms of network delay, a new connection cost 13.6 ms** against 2.5 ms pooled: the handshake needs several round trips.
- **Each idle backend used about 1.1 MB of private memory here, 1.7 MB after one join.** On a real database with many tables, big catalog caches and sorts, budget several MB to tens of MB per busy connection.

**More connections do not mean more throughput.** `pgbench` on the same 2-CPU database, 8 seconds per run, with 4 to 96 client connections:

**Real output**

```text
-S           clients   4 | latency average = 0.079 ms | tps = 50477.286249
-S           clients  16 | latency average = 0.409 ms | tps = 39096.381504
-S           clients  48 | latency average = 1.354 ms | tps = 35454.704617
-S           clients  96 | latency average = 2.758 ms | tps = 34806.506209
tpcb-like    clients   4 | latency average = 1.289 ms | tps = 3104.068167
tpcb-like    clients  16 | latency average = 4.939 ms | tps = 3239.321365
tpcb-like    clients  48 | latency average = 16.548 ms | tps = 2900.656500
tpcb-like    clients  96 | latency average = 38.387 ms | tps = 2500.815858
```

**What to notice**
- **Read-only (`-S`) throughput was highest at 4 clients** (50,477/s) and 31% lower at 96, while average latency went from 0.08 ms to 2.76 ms (35 times).
- **The write workload (`tpcb-like`) peaked at 16 clients** (3,239/s) and fell 23% by 96, with latency 7.8 times higher than at 16.
- Two CPUs can run two things at once. Past a small multiple of the core count, extra connections only queue inside Postgres, where queueing is more expensive than in your app's pool. (The `pgbench` client ran on the same machine, so this sandbox exaggerates the effect a little; the shape is the same on real servers.)

**When it matters.** Always: pool every connection in long-running services. It matters most with many app instances, serverless functions (Deep dive 9), and managed databases with small `max_connections`.

### 2. Pooling: pg.Pool settings, the connection budget, and PgBouncer

**`pg.Pool` settings that matter** (defaults from the node-postgres docs)

| Option | Default | What it does | Ledger setting |
|---|---|---|---|
| `max` | 10 | Most connections this pool opens | 8, from the budget below |
| `idleTimeoutMillis` | 10,000 | Close a connection idle this long | 10,000 |
| `connectionTimeoutMillis` | **0 = wait for ever** | How long `query()`/`connect()` waits for a free connection | 2,000: fail fast with a clear error |
| `maxLifetimeSeconds` | 0 = never | Recycle connections after this age | 1,800: failovers and load balancers take effect |
| `maxUses` | Infinity | Recycle after N uses | Not used |
| `allowExitOnIdle` | false | Let the process exit when all clients are idle | Scripts only |

**Product version:** `src/lib/db/pool.ts`. One pool per process, created at startup and shared by every request.

```ts
// src/lib/db/pool.ts: ONE pool per process. Size it from the connection budget (see "Pool sizing").
import pg from "pg";

export interface PoolOptions extends pg.PoolConfig {
  viaPgBouncer?: boolean;   // true when DATABASE_URL points at PgBouncer in transaction mode
}

export function createPool(connectionString: string, { viaPgBouncer = false, ...overrides }: PoolOptions = {}): pg.Pool {
  // Postgres accepts these as startup parameters; PgBouncer rejects the connection ("unsupported startup
  // parameter"). Behind PgBouncer the same limits come from ALTER ROLE ... SET (db/roles.sql) and SET LOCAL.
  const serverTimeouts = viaPgBouncer ? {} : {
    statement_timeout: 5_000,                    // one statement
    lock_timeout: 2_000,                         // waiting for a row or table lock
    idle_in_transaction_session_timeout: 10_000, // a transaction the app forgot about
  };
  return new pg.Pool({
    connectionString,
    max: 8,                                      // per process; total = max x processes, see the sizing table
    idleTimeoutMillis: 10_000,                   // give idle connections back after 10 s
    connectionTimeoutMillis: 2_000,              // fail fast when the pool is exhausted (the default 0 waits for ever)
    maxLifetimeSeconds: 30 * 60,                 // recycle connections, so failovers and rebalancing take effect
    application_name: "ledger-api",              // visible in pg_stat_activity (PgBouncer passes it through)
    ...serverTimeouts,
    ...overrides,
  });
}
```

**What to notice**
- **`connectionTimeoutMillis: 2_000`.** The default (0) makes a request wait for ever when the pool is exhausted; then a slow database turns into a hung API.
- **Timeouts are sent as startup parameters only when connecting directly.** PgBouncer refuses connections that carry them (shown below), so behind PgBouncer they come from the role (`db/roles.sql`) and from `SET LOCAL`.
- **`max: 8` is not a guess:** it comes from the sizing arithmetic next.

`db/roles.sql`: time limits as role defaults, applied to every new server connection, direct or through PgBouncer.

```sql
-- db/roles.sql: the app's role, with its time limits as role defaults. These apply to every new
-- server connection, direct or through PgBouncer, without any startup parameters.
CREATE ROLE ledger_app LOGIN PASSWORD :'app_password';      -- psql -v app_password=... ; never hard-code it
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ledger_app;
ALTER ROLE ledger_app SET statement_timeout = '5s';
ALTER ROLE ledger_app SET lock_timeout = '2s';
ALTER ROLE ledger_app SET idle_in_transaction_session_timeout = '10s';
```

**Pool sizing, computed (must-include).** The rule: **(pods during a deploy) × (pool max) + admin headroom ≤ max_connections − reserved slots**.

| Input | Value | Why |
|---|---|---|
| `max_connections` | 100 | Postgres default; a small managed instance often has about this |
| Superuser reserved | 3 | `superuser_reserved_connections` default; your app role cannot use them |
| Admin headroom | 10 | Migrations, `psql` during an incident, monitoring, replication tools |
| **Budget for the app** | **100 − 3 − 10 = 87** | |
| Pods normally | 10 | |
| Extra pods during a rolling deploy | 3 | Kubernetes `maxSurge: 25%` of 10, rounded up |
| **Pool max per pod** | **⌊87 ÷ 13⌋ = 6** | 13 pods × 6 = 78 during a deploy, 60 normally |

(Computed with a short script.) Two more checks:
- **Little's law for "is that enough?"** Connections busy at once ≈ queries per second × average query time. 1,000 queries/s at 5 ms each keeps about **5** connections busy; at 50 ms each, about **50**. If your pods need more than the budget, fix the query time or add PgBouncer, not `max_connections`.
- **A starting point for the database side.** The HikariCP pool-sizing guide quotes a formula from the PostgreSQL project: about **(CPU cores × 2) + effective disk spindles** active connections. For a 2-core database on SSD that is about 4, which matches where `pgbench` peaked above.

**Four instances with pools of 30 against `max_connections = 100`** (lab step 3): each instance received 400 requests at once, each running a 20 ms query. **Real output**

```text
4 instances x pool 30 -> Postgres  | ok 1516/1600 | errors {"53300 sorry, too many clients already":60,"53300 remaining connection slots are reserved for roles with the SUPERUSER attribute":24} | p95 (ok) 612 ms | 1148 queries/s | peak server connections 91
4 instances x pool 20 -> Postgres  | ok 1600/1600 | errors {} | p95 (ok) 557 ms | 1284 queries/s | peak server connections 81
4 instances x pool 30 -> PgBouncer | ok 1600/1600 | errors {} | p95 (ok) 1577 ms | 711 queries/s | peak server connections 20
4 instances x pool 30 -> PgBouncer (pool 60) | ok 1600/1600 | errors {} | p95 (ok) 859 ms | 1079 queries/s | peak server connections 60
```

**What to notice**
- **4 × 30 = 120 > 97 slots** for a normal role: 84 queries failed with `53300`. The two messages are the same error: the second says the last 3 slots are for superusers.
- **4 × 20 = 80 fitted:** no errors, and slightly better throughput.
- **Through PgBouncer, 120 client connections became 20 (or 60) server connections, with no errors.** With a 20-connection server pool, throughput fell to 711 queries/s and p95 rose to 1,577 ms, because each of these queries mostly sleeps: for waiting-heavy queries, more server connections do help. With 60, it was back to 1,079/s. Size PgBouncer's pool by measurement, like any pool.

**PgBouncer in one paragraph.** PgBouncer is a single small process that speaks the Postgres protocol. Clients connect to it (cheap: no backend process is started), and it hands them server connections from its own pool. In **session** mode a client keeps its server connection until it disconnects (safe, little sharing). In **transaction** mode a server connection is lent for one transaction and returned at `COMMIT`/`ROLLBACK` (most sharing; what most teams run). **Statement** mode is transaction mode with multi-statement transactions forbidden.

`pgbouncer.ini` used in the lab (the parts that matter)

```ini
[databases]
ledger_dal = host=127.0.0.1 port=5432 dbname=ledger_dal user=ledger_app password=...   ; from your secret store

[pgbouncer]
listen_port = 6432
pool_mode = transaction
default_pool_size = 20           ; server connections per database+user: the number Postgres sees
max_client_conn = 1000           ; client connections PgBouncer accepts: cheap
max_prepared_statements = 100    ; needed on 1.21 to 1.23 for named prepared statements (default 200 from 1.24)
```

**What transaction mode breaks.** Anything that lives in the **session**, because your next transaction may run on a different server connection, and the next client may get yours. **Real output** (`minimal/pgbouncerBreaks.ts`, against a PgBouncer database with 2 server connections)

```ts
// minimal/pgbouncerBreaks.ts: three things that behave differently behind PgBouncer in transaction mode.
import pg from "pg";

const tiny = "postgres://ledger_app:lab@127.0.0.1:6432/ledger_dal_tiny";   // PgBouncer, 2 server connections
const run = async (title: string, fn: () => Promise<string>) => {
  try { console.log(`${title}: ${await fn()}`); } catch (err) { const e = err as { code?: string; message: string }; console.log(`${title}: ERROR ${e.code ?? ""} ${e.message}`); }
};

// 1. Timeouts sent as startup parameters (what pg.Pool's statement_timeout option does).
await run("1. pool with statement_timeout option", async () => {
  const pool = new pg.Pool({ connectionString: tiny, statement_timeout: 5000 });
  try { return JSON.stringify((await pool.query("SHOW statement_timeout")).rows[0]); } finally { await pool.end(); }
});

// 2. A session-level SET leaks into whoever uses that server connection next.
await run("2. SET leaks to another client", async () => {
  const a = new pg.Client({ connectionString: tiny }), b = new pg.Client({ connectionString: tiny });
  await a.connect(); await b.connect();
  await a.query("SET statement_timeout = '1s'");                 // A means "only for me"
  const seen = (await b.query("SHOW statement_timeout")).rows[0].statement_timeout; // B never asked for it
  await a.query("RESET statement_timeout"); await a.end(); await b.end();
  return `client B now sees statement_timeout = ${seen}`;
});

// 3. SET LOCAL inside a transaction is safe: it ends with the transaction.
await run("3. SET LOCAL in a transaction", async () => {
  const a = new pg.Client({ connectionString: tiny }), b = new pg.Client({ connectionString: tiny });
  await a.connect(); await b.connect();
  await a.query("BEGIN"); await a.query("SET LOCAL statement_timeout = '1s'");
  const inside = (await a.query("SHOW statement_timeout")).rows[0].statement_timeout; await a.query("COMMIT");
  const other = (await b.query("SHOW statement_timeout")).rows[0].statement_timeout;
  await a.end(); await b.end();
  return `inside A's transaction ${inside}, client B sees ${other}`;
});

// 4. A named (protocol-level) prepared statement, used again later on a different server connection.
await run("4. named prepared statement", async () => {
  const a = new pg.Client({ connectionString: tiny }), c = new pg.Client({ connectionString: tiny });
  await a.connect(); await c.connect();
  const q = { name: "wallet-count", text: "SELECT count(*)::int AS n FROM wallets" };
  await a.query(q);                                  // prepared on server connection S1
  await c.query("BEGIN"); await c.query("SELECT 1"); // C's transaction now holds a server connection (likely S1)
  try { return `second run returned ${JSON.stringify((await a.query(q)).rows[0])}`; }
  finally { await c.query("COMMIT"); await a.end(); await c.end(); }
});
```

```text
1. pool with statement_timeout option: ERROR 08P01 unsupported startup parameter: statement_timeout
2. SET leaks to another client: client B now sees statement_timeout = 1s
3. SET LOCAL in a transaction: inside A's transaction 1s, client B sees 0
4. named prepared statement: ERROR 26000 prepared statement "wallet-count" does not exist
```

With `max_prepared_statements = 100` (PgBouncer 1.21+; the default since 1.24 is 200), check 4 passes:

```text
4. named prepared statement: second run returned {"n":2050}
```

**What to notice**
- **Startup parameters other than a small known list are refused** (`08P01 unsupported startup parameter`). That includes node-postgres's `statement_timeout` option. Use role defaults or `SET LOCAL`.
- **A plain `SET` leaked into another client's session.** Client B got a 1-second statement timeout it never asked for. In transaction mode, never use session `SET`.
- **`SET LOCAL` inside a transaction stayed inside it.** That is the safe form (and `set_config(name, value, true)` when you need a parameter).
- **Named prepared statements failed** (`26000 prepared statement does not exist`) when the second execution ran on another server connection, until PgBouncer was told to track them.

The PgBouncer docs' feature table, for the rest: in transaction mode, `SET`/`RESET`, `LISTEN`, `WITH HOLD` cursors, SQL-level `PREPARE`/`DEALLOCATE`, temporary tables that outlive a transaction, `LOAD` and session-level advisory locks (`pg_advisory_lock`, P2-04) **never** work. Protocol-level prepared statements work once `max_prepared_statements` is non-zero; `NOTIFY` and `ON COMMIT DROP` temp tables work.

**When to add PgBouncer.** When pods × pool size would exceed your budget, with many small services, with serverless functions, or when connection count (not queries) is what limits you. **When not:** a single small service whose pools fit comfortably, or code that depends on session features you cannot remove. Managed alternatives exist (for example Amazon RDS Proxy, or the pooler your Postgres provider runs for you); check which features each supports.

### 3. N+1 queries: spot them, then fix them with a join, a batched query or DataLoader

**What it is.** One query fetches a list; then the code runs one more query **per item**. Chai Point's dashboard asks for its 50 outlet wallets, then for each wallet's last five entries: 1 + 50 = **51 queries**. Each one is fast. Together they cost 51 round trips.

**Diagram: 51 round trips vs 1**

```mermaid
sequenceDiagram
  participant API as ledger-api
  participant PG as Postgres
  Note over API,PG: Naive, N+1
  API->>PG: 1 query, list 50 wallets
  PG-->>API: 50 rows
  loop once per wallet, 50 times
    API->>PG: last 5 entries of this wallet
    PG-->>API: 5 rows
  end
  Note over API,PG: Fixed, one LATERAL query
  API->>PG: wallets with last 5 entries each
  PG-->>API: 250 rows
```

**How to read this diagram.** Every arrow pair is a network round trip. The naive version pays it 51 times, one after another; the fixed version pays it once and lets Postgres do the per-wallet work next to the data. With 2.5 ms per round trip, that difference alone is about 125 ms (computed: 50 extra round trips × 2.5 ms).

**How to spot it in code review.** Look for any of these:
- **`await` inside a loop over query results** (`for (const w of wallets) { await db.query(...) }`).
- **`Promise.all(items.map((item) => db.query(...)))`.** Still N queries; it only hides the latency by grabbing up to N pool connections at once.
- **ORM relation access inside a loop** (`wallet.entries` in a template or a GraphQL resolver), or a repository method called per item (`getRecentEntries(walletId)`).
- **A function that takes one id** being called from a function that has many ids.

**How to spot it in production.** Count queries per request. The N+1 signature is **the same SQL text many times in one request**. Also: `pg_stat_statements` shows a cheap statement with a huge `calls` count (P2-02), and traces show a ladder of identical database spans (P5-01).

**Product version:** `src/lib/db/queryStats.ts`. Counts queries per request with `AsyncLocalStorage` (P1-08) and finds repeated statements.

```ts
// src/lib/db/queryStats.ts: count queries per request, so an N+1 shows up in logs and tests.
import { AsyncLocalStorage } from "node:async_hooks";
import type pg from "pg";

export interface QueryStats {
  count: number;
  byStatement: Map<string, number>;   // normalised SQL text -> times run in this request
}

const storage = new AsyncLocalStorage<QueryStats>();
const newStats = (): QueryStats => ({ count: 0, byStatement: new Map() });

export function currentQueryStats(): QueryStats | undefined {
  return storage.getStore();
}

export async function withQueryStats<T>(fn: () => Promise<T>): Promise<{ result: T; stats: QueryStats }> {
  const stats = newStats();
  const result = await storage.run(stats, async () => await fn()); // await INSIDE run: ORM queries are lazy thenables
  return { result, stats };
}

// Fastify: every request gets its own counter (the hook calls done() inside the new async context).
export const queryStatsHook = (_req: unknown, _reply: unknown, done: () => void): void => storage.run(newStats(), done);

// Count every query against the request that checked the client out. The request is captured at
// checkout time, because pool callbacks can run in another request's async context.
export function instrumentPool(pool: pg.Pool): pg.Pool {
  const owner = new WeakMap<pg.PoolClient, QueryStats | undefined>();
  const connect = pool.connect.bind(pool) as (cb?: (err: Error | undefined, client?: pg.PoolClient, done?: () => void) => void) => Promise<pg.PoolClient> | void;
  (pool as unknown as { connect: typeof connect }).connect = (cb) => {
    const stats = storage.getStore();                        // pool.query() also calls this.connect(cb)
    if (cb) return connect((err, client, done) => { if (client) owner.set(client, stats); cb(err, client, done); });
    return (connect() as Promise<pg.PoolClient>).then((client) => { owner.set(client, stats); return client; });
  };
  pool.on("connect", (client) => {                            // once per physical connection
    const original = client.query.bind(client) as (...args: unknown[]) => unknown;
    (client as unknown as { query: (...args: unknown[]) => unknown }).query = (...args: unknown[]) => {
      const stats = owner.get(client as pg.PoolClient);
      if (stats) {
        const first = args[0];
        const text = typeof first === "string" ? first : (first as { text?: string } | undefined)?.text ?? "?";
        const key = text.replace(/\s+/g, " ").trim().slice(0, 80);
        stats.count++;
        stats.byStatement.set(key, (stats.byStatement.get(key) ?? 0) + 1);
      }
      return original(...args);
    };
  });
  return pool;
}

// The N+1 signature: the same statement many times in one request.
export function repeatedStatements(stats: QueryStats, threshold = 5): Array<{ sql: string; times: number }> {
  return [...stats.byStatement].filter(([, n]) => n >= threshold).map(([sql, times]) => ({ sql, times }));
}
```

**What to notice**
- **The request is captured when a client is checked out of the pool,** not when the query runs. Pools hand connections over through callbacks, which can run in another request's async context; capturing at checkout keeps the counts honest.
- **`withQueryStats` awaits inside `storage.run`.** ORM queries such as Drizzle's are lazy "thenables" that start only when awaited; awaiting outside the context counted 0 queries in a first version of this lab.
- **`repeatedStatements` is the N+1 detector:** the same normalised SQL 5 or more times in one request.

`src/routes/walletList.ts`: a query budget on every request, logged when exceeded.

```ts
// src/routes/walletList.ts: the wallet list endpoint, with query counting on every request.
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { currentQueryStats, queryStatsHook, repeatedStatements } from "../lib/db/queryStats.js";
import { listLateral, listNaive } from "../repositories/walletListRepository.js";

const Params = z.object({ ownerId: z.uuid() });
const MAX_QUERIES_PER_REQUEST = 10;   // a budget: list pages should need 1 to 3 queries

export function walletListRoutes(pool: Pool, opts: { naive?: boolean } = {}) {
  return async function register(app: FastifyInstance): Promise<void> {
    app.addHook("onRequest", queryStatsHook);
    app.addHook("onSend", async (_request, reply) => {
      const stats = currentQueryStats();
      if (stats) reply.header("x-db-queries", String(stats.count));   // lab and staging only: easy to see in DevTools
    });
    app.addHook("onResponse", async (request) => {
      const stats = currentQueryStats();
      if (!stats) return;
      const repeated = repeatedStatements(stats);
      if (stats.count > MAX_QUERIES_PER_REQUEST || repeated.length > 0) {
        request.log.warn({ db_queries: stats.count, repeated }, "query budget exceeded: possible N+1");
      }
    });
    app.get("/v1/users/:ownerId/wallets", async (request) => {
      const { ownerId } = Params.parse(request.params);
      return { wallets: await (opts.naive ? listNaive : listLateral)(pool, ownerId) };
    });
  };
}
```

**Real output** (the naive version, with Fastify's logger at `warn`)

```text
{"level":40,"time":1792818526844,"pid":3768,"hostname":"vm","reqId":"req-1","db_queries":51,"repeated":[{"sql":"SELECT id, direction, amount_minor, created_at FROM ledger_entries WHERE wallet_","times":50}],"msg":"query budget exceeded: possible N+1"}
```

**The fixes.** `src/repositories/walletListRepository.ts` has the naive version and three fixes.

```ts
// src/repositories/walletListRepository.ts: "my wallets, each with its last five entries", four ways.
import type pg from "pg";

export interface Entry { id: string; direction: "debit" | "credit"; amountMinor: number; createdAt: Date }
export interface WalletWithRecent { id: string; nickname: string; balanceMinor: number; recent: Entry[] }
type Db = Pick<pg.Pool, "query">;

const WALLETS = `SELECT w.id, w.nickname, b.balance_minor FROM wallets w JOIN wallet_balances b ON b.wallet_id = w.id
                  WHERE w.owner_id = $1 ORDER BY w.created_at, w.id`;
type WalletRow = { id: string; nickname: string; balance_minor: string };
type FlatRow = WalletRow & { entry_id: string | null; direction: Entry["direction"] | null; amount_minor: string | null; created_at: Date | null };

const toWallet = (r: WalletRow): WalletWithRecent => ({ id: r.id, nickname: r.nickname, balanceMinor: Number(r.balance_minor), recent: [] });
function groupFlat(rows: FlatRow[]): WalletWithRecent[] {
  const byId = new Map<string, WalletWithRecent>();
  for (const r of rows) {
    const wallet = byId.get(r.id) ?? byId.set(r.id, toWallet(r)).get(r.id)!;
    if (r.entry_id) wallet.recent.push({ id: r.entry_id, direction: r.direction!, amountMinor: Number(r.amount_minor), createdAt: r.created_at! });
  }
  return [...byId.values()];
}

// 1. The N+1: one query for the list, then one more per wallet.
export async function listNaive(db: Db, ownerId: string): Promise<WalletWithRecent[]> {
  const wallets = (await db.query<WalletRow>(WALLETS, [ownerId])).rows.map(toWallet);
  for (const wallet of wallets) {
    const { rows } = await db.query<{ id: string; direction: Entry["direction"]; amount_minor: string; created_at: Date }>(
      `SELECT id, direction, amount_minor, created_at FROM ledger_entries
        WHERE wallet_id = $1 ORDER BY created_at DESC, id DESC LIMIT 5`, [wallet.id]);
    wallet.recent = rows.map((r) => ({ id: r.id, direction: r.direction, amountMinor: Number(r.amount_minor), createdAt: r.created_at }));
  }
  return wallets;
}

// 2. One query: for each wallet, a LATERAL subquery reads its newest 5 entries from the covering index and stops.
export async function listLateral(db: Db, ownerId: string): Promise<WalletWithRecent[]> {
  const { rows } = await db.query<FlatRow>(`
    SELECT w.id, w.nickname, b.balance_minor, e.id AS entry_id, e.direction, e.amount_minor, e.created_at
      FROM wallets w
      JOIN wallet_balances b ON b.wallet_id = w.id
      LEFT JOIN LATERAL (
        SELECT id, direction, amount_minor, created_at FROM ledger_entries
         WHERE wallet_id = w.id ORDER BY created_at DESC, id DESC LIMIT 5) e ON true
     WHERE w.owner_id = $1
     ORDER BY w.created_at, w.id, e.created_at DESC, e.id DESC`, [ownerId]);
  return groupFlat(rows);
}

// 3. One query with a window function: numbers every entry of these wallets, keeps rows 1 to 5.
export async function listWindow(db: Db, ownerId: string): Promise<WalletWithRecent[]> {
  const { rows } = await db.query<FlatRow>(`
    SELECT w.id, w.nickname, b.balance_minor, e.id AS entry_id, e.direction, e.amount_minor, e.created_at
      FROM wallets w
      JOIN wallet_balances b ON b.wallet_id = w.id
      LEFT JOIN (
        SELECT id, wallet_id, direction, amount_minor, created_at,
               row_number() OVER (PARTITION BY wallet_id ORDER BY created_at DESC, id DESC) AS rn
          FROM ledger_entries
         WHERE wallet_id IN (SELECT id FROM wallets WHERE owner_id = $1)) e ON e.wallet_id = w.id AND e.rn <= 5
     WHERE w.owner_id = $1
     ORDER BY w.created_at, w.id, e.created_at DESC, e.id DESC`, [ownerId]);
  return groupFlat(rows);
}

// 4. Two queries: the list, then ONE batched query for all its wallets (= ANY($1) is IN with one array parameter).
export async function recentEntriesFor(db: Db, walletIds: readonly string[]): Promise<Map<string, Entry[]>> {
  const { rows } = await db.query<{ wallet_id: string; id: string; direction: Entry["direction"]; amount_minor: string; created_at: Date }>(`
    SELECT w.id AS wallet_id, e.id, e.direction, e.amount_minor, e.created_at FROM wallets w
      CROSS JOIN LATERAL (SELECT id, direction, amount_minor, created_at FROM ledger_entries
                           WHERE wallet_id = w.id ORDER BY created_at DESC, id DESC LIMIT 5) e
     WHERE w.id = ANY($1::uuid[])
     ORDER BY w.id, e.created_at DESC, e.id DESC`, [walletIds]);
  const byWallet = new Map<string, Entry[]>(walletIds.map((id) => [id, []]));
  for (const r of rows) byWallet.get(r.wallet_id)?.push({ id: r.id, direction: r.direction, amountMinor: Number(r.amount_minor), createdAt: r.created_at });
  return byWallet;
}

export async function listBatched(db: Db, ownerId: string): Promise<WalletWithRecent[]> {
  const wallets = (await db.query<WalletRow>(WALLETS, [ownerId])).rows.map(toWallet);
  const recent = await recentEntriesFor(db, wallets.map((w) => w.id));
  return wallets.map((w) => ({ ...w, recent: recent.get(w.id) ?? [] }));
}
```

**What to notice**
- **`LATERAL`** lets the subquery refer to the current wallet row (`w.id`), so for each wallet Postgres reads the newest 5 entries from P2-02's covering index and stops. One query.
- **The window function** numbers **every** entry of these wallets, then keeps 1 to 5. Correct, but it reads all 100,000 entries of Chai Point's 50 wallets to return 250 rows.
- **The batched version** runs the list query, then **one** query for all wallet ids with `= ANY($1::uuid[])` (an `IN` list passed as a single array parameter; a literal `IN ($1, $2, ...)` list works too, but needs a placeholder per id). Two queries, whatever the number of wallets.

**DataLoader.** When code is written per item (GraphQL resolvers, or a component tree that asks "entries for this wallet" one by one), you cannot easily write one query by hand. DataLoader collects every `.load(id)` call made in the same tick and calls your batch function once.

`src/repositories/entryLoader.ts`

```ts
// src/repositories/entryLoader.ts: DataLoader turns N separate .load(walletId) calls in one tick into ONE query.
// Create one loader per request: its cache must never leak data between users.
import DataLoader from "dataloader";
import type pg from "pg";
import { recentEntriesFor, type Entry } from "./walletListRepository.js";

export function createRecentEntriesLoader(db: Pick<pg.Pool, "query">): DataLoader<string, Entry[]> {
  return new DataLoader<string, Entry[]>(async (walletIds) => {
    const byWallet = await recentEntriesFor(db, walletIds);
    return walletIds.map((id) => byWallet.get(id) ?? []);   // same order as the keys, as DataLoader requires
  }, { maxBatchSize: 500 });
}
```

**What to notice**
- **One loader per request.** DataLoader caches results by key; a loader shared across requests would serve one user's data to another and never see updates.
- **The batch function must return results in the same order as the keys**, one per key (an empty list when a wallet has no entries).
- **It reuses `recentEntriesFor`**, the same `= ANY($1)` query as the batched fix, so it also ran 2 queries in total.

**Real output** (`bench/nPlusOne.ts`: 100 calls for Chai Point and 200 for an ordinary user, per version; queries counted by `queryStats`)

```text
--- localhost: one SELECT 1 round trip = 0.24 ms
Chai Point, 50 wallets     | naive loop (N+1)   |  51 queries | p50    7.5 ms | p95   18.2 ms
Chai Point, 50 wallets     | LATERAL join       |   1 queries | p50    1.4 ms | p95    2.3 ms
Chai Point, 50 wallets     | window function    |   1 queries | p50   23.1 ms | p95   29.6 ms
Chai Point, 50 wallets     | batched = ANY($1)  |   2 queries | p50    2.3 ms | p95    3.1 ms
Chai Point, 50 wallets     | DataLoader         |   2 queries | p50    2.3 ms | p95    3.4 ms
ordinary user, 2 wallets   | naive loop (N+1)   |   3 queries | p50    0.5 ms | p95    1.0 ms
ordinary user, 2 wallets   | LATERAL join       |   1 queries | p50    0.3 ms | p95    0.6 ms
ordinary user, 2 wallets   | window function    |   1 queries | p50    0.9 ms | p95    1.3 ms
ordinary user, 2 wallets   | batched = ANY($1)  |   2 queries | p50    0.5 ms | p95    1.1 ms
ordinary user, 2 wallets   | DataLoader         |   2 queries | p50    0.5 ms | p95    0.9 ms
--- + network delay: one SELECT 1 round trip = 2.55 ms
Chai Point, 50 wallets     | naive loop (N+1)   |  51 queries | p50  136.4 ms | p95  144.5 ms
Chai Point, 50 wallets     | LATERAL join       |   1 queries | p50    4.1 ms | p95    5.3 ms
Chai Point, 50 wallets     | window function    |   1 queries | p50   28.0 ms | p95   32.6 ms
Chai Point, 50 wallets     | batched = ANY($1)  |   2 queries | p50    6.7 ms | p95    7.4 ms
Chai Point, 50 wallets     | DataLoader         |   2 queries | p50    6.9 ms | p95    7.8 ms
ordinary user, 2 wallets   | naive loop (N+1)   |   3 queries | p50    8.0 ms | p95    8.7 ms
ordinary user, 2 wallets   | LATERAL join       |   1 queries | p50    2.8 ms | p95    3.1 ms
ordinary user, 2 wallets   | window function    |   1 queries | p50    3.1 ms | p95    3.4 ms
ordinary user, 2 wallets   | batched = ANY($1)  |   2 queries | p50    5.5 ms | p95    6.0 ms
ordinary user, 2 wallets   | DataLoader         |   2 queries | p50    5.7 ms | p95    6.1 ms
```

**Query counts before and after the N+1 fix (must-include)**

| Version | Queries for Chai Point (50 wallets) | p95 on localhost | p95 with 2.5 ms per round trip |
|---|---|---|---|
| Naive loop (N+1) | **51** | 18.2 ms | **144.5 ms** |
| `LATERAL` join | **1** | 2.3 ms | **5.3 ms** |
| Window function | 1 | 29.6 ms | 32.6 ms |
| Batched `= ANY($1)` | 2 | 3.1 ms | 7.4 ms |
| DataLoader | 2 | 3.4 ms | 7.8 ms |

**How to read it**
- **On localhost the N+1 looked harmless** (18 ms). With realistic network delay it was **27 times slower** at p95 than the `LATERAL` query. Local timings hide N+1s; query counts do not.
- **Fewer queries is not automatically faster:** the window function was 1 query but slower than the N+1 on localhost, because it read every entry. Check the plan (P2-02).
- **For an ordinary user with 2 wallets, the N+1 is only 3 queries** (8.7 ms vs 3.1 ms p95 with delay). N+1s hurt most on the accounts with the most rows: your biggest customers.

**When an N+1 is acceptable.** When N is small and bounded by design (a fixed 3 tabs), or behind a cache. Make it explicit, and keep the query budget in the test.

### 4. ORMs vs query builders vs raw SQL: Prisma, Drizzle, Kysely and node-postgres

**The same read in each style.** Drizzle and Kysely ran here against the lab database; Prisma is shown from its docs, not run.

`minimal/ormCompare.ts` (Drizzle relational query and Kysely)

```ts
// minimal/ormCompare.ts: the same "wallets with last 5 entries" read, via Drizzle's relational query and Kysely.
import { relations, desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { bigint, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { Kysely, PostgresDialect } from "kysely";
import { jsonArrayFrom } from "kysely/helpers/postgres";
import { createPool } from "../src/lib/db/pool.js";
import { instrumentPool, withQueryStats } from "../src/lib/db/queryStats.js";

const OWNER = "00000000-0000-4000-8000-00000000c0de";
const pool = instrumentPool(createPool("postgres://ledger_app:lab@127.0.0.1:5432/ledger_dal", { max: 4 }));

// --- Drizzle: schema in TypeScript, relations declared, then a nested "with" query.
const wallets = pgTable("wallets", { id: uuid("id").primaryKey(), ownerId: uuid("owner_id").notNull(), nickname: text("nickname").notNull(), createdAt: timestamp("created_at", { withTimezone: true }).notNull() });
const ledgerEntries = pgTable("ledger_entries", { id: bigint("id", { mode: "number" }).primaryKey(), walletId: uuid("wallet_id").notNull(), direction: text("direction").notNull(), amountMinor: bigint("amount_minor", { mode: "number" }).notNull(), createdAt: timestamp("created_at", { withTimezone: true }).notNull() });
const walletRelations = relations(wallets, ({ many }) => ({ entries: many(ledgerEntries) }));
const entryRelations = relations(ledgerEntries, ({ one }) => ({ wallet: one(wallets, { fields: [ledgerEntries.walletId], references: [wallets.id] }) }));
const db = drizzle(pool, { schema: { wallets, ledgerEntries, walletRelations, entryRelations } });

const drizzleRun = await withQueryStats(() => db.query.wallets.findMany({
  where: eq(wallets.ownerId, OWNER),
  with: { entries: { orderBy: [desc(ledgerEntries.createdAt), desc(ledgerEntries.id)], limit: 5 } },
}));
console.log(`Drizzle 0.45 relational query: ${drizzleRun.stats.count} query, ${drizzleRun.result.length} wallets, ${drizzleRun.result[0]!.entries.length} entries in the first`);
console.log(`  SQL: ${[...drizzleRun.stats.byStatement.keys()][0]}...`);

// --- Kysely: a typed query builder; the lateral subquery is written explicitly with a helper.
interface Database {
  wallets: { id: string; owner_id: string; nickname: string; created_at: Date };
  ledger_entries: { id: string; wallet_id: string; direction: "debit" | "credit"; amount_minor: string; created_at: Date };
}
const kysely = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
const kyselyRun = await withQueryStats(() => kysely.selectFrom("wallets as w")
  .select((eb) => ["w.id", "w.nickname", jsonArrayFrom(eb.selectFrom("ledger_entries as e")
    .select(["e.id", "e.direction", "e.amount_minor", "e.created_at"])
    .whereRef("e.wallet_id", "=", "w.id").orderBy("e.created_at", "desc").orderBy("e.id", "desc").limit(5)).as("recent")])
  .where("w.owner_id", "=", OWNER).orderBy("w.created_at").execute());
console.log(`Kysely 0.29 with jsonArrayFrom: ${kyselyRun.stats.count} query, ${kyselyRun.result.length} wallets, ${kyselyRun.result[0]!.recent.length} entries in the first`);
console.log(`  SQL: ${[...kyselyRun.stats.byStatement.keys()][0]}...`);
await pool.end();
```

**Real output**

```text
Drizzle 0.45 relational query: 1 query, 50 wallets, 5 entries in the first
  SQL: select "wallets"."id", "wallets"."owner_id", "wallets"."nickname", "wallets"."cr...
Kysely 0.29 with jsonArrayFrom: 1 query, 50 wallets, 5 entries in the first
  SQL: select "w"."id", "w"."nickname", (select coalesce(json_agg(agg), '[]') from (sel...
```

The SQL each one sent, from the Postgres statement log (trimmed). **Real output**

```text
-- Drizzle 0.45: a LEFT JOIN LATERAL with json_agg, written for you
select "wallets"."id", "wallets"."owner_id", "wallets"."nickname", "wallets"."created_at", "wallets_entries"."data" as "entries" from "wallets" "wallets" left join lateral (select coalesce(json_agg(json_build_array("wallets_entries"."id", "wallets_entries"."wallet_id", "wallets_entries"."direction", "wallets_entries"."amount_minor", "wallets_entries"."created_at") order by "wallets_entries"."created_at" desc, "wallets_entries"."id" desc), '[]'::json) as "data" from (select * from "ledger_entries" "wallets_entries" where "wallets_entries"."wallet_id" = "wallets"."id" order by "wallets_entries"."created_at" desc, "wallets_entries"."id" desc limit $1) "wallets_entries") ...
-- Kysely 0.29: the correlated subquery you wrote, with json_agg from the helper
select "w"."id", "w"."nickname", (select coalesce(json_agg(agg), '[]') from (select "e"."id", "e"."direction", "e"."amount_minor", "e"."created_at" from "ledger_entries" as "e" where "e"."wallet_id" = "w"."id" order by "e"."created_at" desc, "e"."id" desc limit $1) as agg) as "recent" from "wallets" as "w" where "w"."owner_id" = $2 order by "w"."created_at"
```

**Prisma ORM 7** (from its docs; not run here): `prisma.wallet.findMany({ where: { ownerId }, include: { entries: { orderBy: { createdAt: "desc" }, take: 5 } } })`. By default Prisma loads each relation with its own query (one per table, not one per row) and joins the results in the app. With the `relationJoins` preview feature, `relationLoadStrategy: "join"` makes it one query with `LATERAL` joins and JSON aggregation on Postgres. Prisma ORM 8 (release candidate) changes the client API; check its docs before starting a new project on it.

**ORM vs query builder vs raw SQL (must-include)**

| | Prisma (ORM) | Drizzle (ORM-lite + query builder) | Kysely (query builder) | node-postgres (raw SQL) |
|---|---|---|---|---|
| You write | Objects and relations (`include`, `select`) | Table definitions in TS; SQL-like builder or relational `with` | SQL-shaped TypeScript | SQL strings with `$1` parameters |
| Control over SQL | Lowest; raw SQL escape hatch available | High; you can see and shape the SQL | Highest of the typed options | Total |
| Type safety | Generated client from `schema.prisma` | Inferred from TS table definitions | Inferred from a `Database` interface (often generated) | Only what you add (Zod, generics) |
| Migrations | Built in (`prisma migrate`) | Drizzle Kit generates SQL migrations | Not included; plain SQL files or a library | Your own SQL files (P2-01's runner) |
| Relations / N+1 | `include` batches per table; `join` strategy in preview | Relational queries become one `LATERAL` query (seen above) | Explicit: you write the join or subquery | Explicit |
| Complex SQL (CTEs, window functions, `LATERAL`, `COPY`, locking clauses) | Through raw queries | Mostly supported; `sql` template for the rest | Mostly supported | All of it |
| Learning curve for a team | Lowest | Low if you know SQL | Low if you know SQL | You must know SQL |
| Best fit | CRUD-heavy apps, fast start | Teams who know SQL and want types | SQL-first teams who want types | Hot paths, bulk work, anything unusual |

**When to drop from an ORM to raw SQL** (card question 4): when the ORM cannot express the query well (`LATERAL`, window functions, `FOR UPDATE SKIP LOCKED`, `ON CONFLICT ... RETURNING`, recursive CTEs), when the generated SQL has a bad plan you cannot fix through the API, for bulk loads (`COPY`), and on the few hot paths where you need to control every round trip. Keep those queries in the repository layer, parameterised and tested, and keep the ORM for the rest.

### 5. Parameterised queries: the defence against SQL injection

**What it is.** A **parameterised query** sends the SQL text with placeholders (`$1`, `$2`) and the values **separately**. Postgres parses the SQL first and only then binds the values, so a value can never become SQL, whatever characters it contains. node-postgres does this whenever you pass a values array.

**Minimal version:** `minimal/sqlInjection.ts`. Chai Point searches its own wallets by nickname.

```ts
// minimal/sqlInjection.ts: a wallet search box, built by string concatenation vs with a parameter.
import pg from "pg";

const pool = new pg.Pool({ connectionString: "postgres://ledger_app:lab@127.0.0.1:5432/ledger_dal", max: 2 });
const OWNER = "00000000-0000-4000-8000-00000000c0de";   // Chai Point is logged in and searches its own wallets

const searchConcatenated = (term: string) =>
  pool.query(`SELECT id, nickname FROM wallets WHERE owner_id = '${OWNER}' AND nickname ILIKE '%${term}%'`);
const searchParameterised = (term: string) =>
  pool.query("SELECT id, nickname FROM wallets WHERE owner_id = $1 AND nickname ILIKE '%' || $2 || '%'", [OWNER, term]);

const rowsOf = (r: pg.QueryResult | pg.QueryResult[]) => (Array.isArray(r) ? r.map((x) => x.rowCount).join(" + ") : r.rowCount);
const attacks = [
  "Outlet 1",                                                                  // a normal search
  "' OR '1'='1' --",                                                           // read everyone's wallets
  "x'; UPDATE wallets SET nickname = 'pwned' WHERE id = (SELECT id FROM wallets WHERE nickname = 'Main' ORDER BY id LIMIT 1); --",
];
for (const term of attacks) {
  const bad = await searchConcatenated(term).then(rowsOf, (e: Error) => `error: ${e.message}`);
  const good = await searchParameterised(term).then(rowsOf, (e: Error) => `error: ${e.message}`);
  console.log(`search ${JSON.stringify(term.slice(0, 40))}${term.length > 40 ? "..." : ""}\n  concatenated: ${bad} rows | parameterised: ${good} rows`);
}
const { rows } = await pool.query("SELECT count(*)::int AS n FROM wallets WHERE nickname = 'pwned'");
console.log(`wallets renamed to 'pwned' by the search box: ${rows[0].n}`);
await pool.query("UPDATE wallets SET nickname = 'Main' WHERE nickname = 'pwned'");   // undo the lab damage
await pool.end();
```

**Real output**

```text
search "Outlet 1"
  concatenated: 11 rows | parameterised: 11 rows
search "' OR '1'='1' --"
  concatenated: 2050 rows | parameterised: 0 rows
search "x'; UPDATE wallets SET nickname = 'pwned"...
  concatenated: 0 + 1 rows | parameterised: 0 rows
wallets renamed to 'pwned' by the search box: 1
```

**What to notice**
- **`' OR '1'='1' --` turned the search into "every wallet in the database"**: 2,050 rows, every customer's wallet names and ids.
- **The second input ran a second statement** (`0 + 1 rows`: the search, then an `UPDATE`) and renamed another user's wallet. Without parameters, node-postgres sends the text as a simple query, which may contain several statements.
- **The parameterised version returned 0 rows both times:** the input was only ever a string to compare against.

**Prepared statements.** Every parameterised query in node-postgres uses Postgres's extended protocol: *Parse* (the SQL with `$1`), *Bind* (the values), *Execute*. Giving the query a `name` (`{ name: "wallet-count", text, values }`) keeps the parsed statement on that connection and skips parsing next time; behind PgBouncer that needs `max_prepared_statements` (Deep dive 2). The safety comes from the parameters, with or without a name.

**Identifiers cannot be parameters.** Table and column names (for example a user-chosen sort column) cannot be `$1`. Map them through an allow-list (`{ newest: "created_at DESC" }[sort]`), or quote with `pg.escapeIdentifier` when the name really is dynamic. Never concatenate user input into SQL.

### 6. Timeouts: statement_timeout and lock_timeout per connection or per transaction

**What it is.** Without a limit, one bad query (a missing index, a huge date range, a lock wait) holds its connection until it finishes, which may be never. Hold a few of those and the pool is empty for everyone. Two server-side limits, both from P2-03:

- **`statement_timeout`**: the longest one statement may run. Error `57014` (`canceling statement due to statement timeout`).
- **`lock_timeout`**: the longest a statement may wait for a lock. Error `55P03`.

**Three places to set them, from widest to narrowest**

| Where | How | Works through PgBouncer (transaction mode) |
|---|---|---|
| Per role (or database) | `ALTER ROLE ledger_app SET statement_timeout = '5s'` | Yes: applied when the server connection logs in |
| Per connection | `pg.Pool` options `statement_timeout`, `lock_timeout` (sent as startup parameters) | **No**: PgBouncer refuses the connection |
| Per transaction | `SET LOCAL statement_timeout = '2s'`, or `SELECT set_config('statement_timeout', $1, true)` | Yes |

A role default as the safety net, plus a tighter per-transaction limit for known-heavy work (reports, exports), covers almost everything.

**Client-side vs server-side.** node-postgres also has `query_timeout`, which makes **your app** stop waiting. The server may keep running the query and holding locks. Prefer `statement_timeout`, which stops the work in Postgres itself.

**Product version:** `src/lib/db/timeouts.ts`

```ts
// src/lib/db/timeouts.ts: run a query with its own time limit, and turn "too slow" into a typed error.
import type { Pool, PoolClient } from "pg";
import { withTransaction } from "./withTransaction.js";

export class QueryTimeoutError extends Error {
  override name = "QueryTimeoutError";
}

const sqlstateOf = (err: unknown) =>
  typeof err === "object" && err !== null && "code" in err && typeof err.code === "string" ? err.code : undefined;

export async function withStatementTimeout<T>(pool: Pool, timeoutMs: number, work: (tx: PoolClient) => Promise<T>): Promise<T> {
  try {
    return await withTransaction(pool, { isolationLevel: "READ COMMITTED", readOnly: true }, async (tx) => {
      // Same as SET LOCAL statement_timeout, but accepts a bind parameter. "true" = only for this transaction,
      // so it is safe on a pooled connection and behind PgBouncer in transaction mode.
      await tx.query("SELECT set_config('statement_timeout', $1, true)", [`${timeoutMs}ms`]);
      return await work(tx);
    });
  } catch (err) {
    // 57014 query_canceled: the server stopped the statement. The connection itself is fine and goes back to the pool.
    if (sqlstateOf(err) === "57014") throw new QueryTimeoutError(`query exceeded ${timeoutMs} ms`, { cause: err });
    throw err;
  }
}
```

**What to notice**
- **`set_config('statement_timeout', $1, true)`** is `SET LOCAL` that accepts a bind parameter (`SET` does not). `true` means "only for this transaction", so it never leaks to the next user of the connection.
- **`57014` becomes a typed `QueryTimeoutError`**; anything else is rethrown unchanged.
- **The transaction is `READ ONLY`**, so a report can never write by mistake.

`src/routes/merchantReports.ts`: a report that answers `503` instead of hanging.

```ts
// src/routes/merchantReports.ts: a report endpoint that cannot hold a connection for ever.
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { QueryTimeoutError, withStatementTimeout } from "../lib/db/timeouts.js";

const Params = z.object({ merchantId: z.uuid() });
const Query = z.object({ days: z.coerce.number().int().min(1).max(90).default(30) });
const REPORT_TIMEOUT_MS = 2_000;

export function merchantReportRoutes(pool: Pool) {
  return async function register(app: FastifyInstance): Promise<void> {
    app.get("/v1/merchants/:merchantId/daily-totals", async (request, reply) => {
      const { merchantId } = Params.parse(request.params);
      const { days } = Query.parse(request.query);
      try {
        const rows = await withStatementTimeout(pool, REPORT_TIMEOUT_MS, async (tx) => (await tx.query(
          `SELECT date_trunc('day', e.created_at AT TIME ZONE 'Asia/Kolkata') AS day, e.direction,
                  count(*)::int AS entries, sum(e.amount_minor)::bigint AS total_minor
             FROM wallets w JOIN ledger_entries e ON e.wallet_id = w.id
            WHERE w.owner_id = $1 AND e.created_at >= now() - make_interval(days => $2)
            GROUP BY 1, 2 ORDER BY 1 DESC, 2`, [merchantId, days])).rows);
        return { merchantId, days, rows };
      } catch (err) {
        if (!(err instanceof QueryTimeoutError)) throw err;
        request.log.warn({ err, merchant_id: merchantId, days }, "report query hit its statement timeout");
        return reply.code(503).header("retry-after", "30").type("application/problem+json").send({
          type: "https://errors.ledger.example/report-timeout", status: 503,
          title: "This report is taking too long. Try fewer days, or request it as an export.",
        });
      }
    });
  };
}
```

`test/statementTimeout.test.ts`

```ts
// test/statementTimeout.test.ts: a slow query is cut off at 2 s, mapped to 503, and the pool stays healthy.
import Fastify from "fastify";
import { afterAll, describe, expect, it } from "vitest";
import { createPool } from "../src/lib/db/pool.js";
import { withStatementTimeout, QueryTimeoutError } from "../src/lib/db/timeouts.js";
import { merchantReportRoutes } from "../src/routes/merchantReports.js";

const pool = createPool(process.env.TEST_DATABASE_URL ?? "postgres://ledger_app:lab@127.0.0.1:5432/ledger_dal", { max: 2 });
afterAll(() => pool.end());

describe("statement timeouts", () => {
  it("stops a 5 s query after about 2 s with a typed error", async () => {
    const started = performance.now();
    const err = await withStatementTimeout(pool, 2_000, (tx) => tx.query("SELECT pg_sleep(5)")).catch((e: unknown) => e);
    const seconds = (performance.now() - started) / 1000;
    expect(err).toBeInstanceOf(QueryTimeoutError);
    expect(seconds).toBeGreaterThan(1.9);
    expect(seconds).toBeLessThan(3);
  });

  it("leaves the connection usable, with no leftover timeout", async () => {
    const { rows } = await pool.query("SHOW statement_timeout");   // the role default, not the 2 s SET LOCAL
    expect(rows[0].statement_timeout).toBe("5s");
    expect(pool.totalCount).toBeLessThanOrEqual(2);
  });

  it("serves the real report quickly", async () => {
    const app = Fastify();
    await app.register(merchantReportRoutes(pool));
    const res = await app.inject({ url: "/v1/merchants/00000000-0000-4000-8000-00000000c0de/daily-totals?days=7" });
    expect(res.statusCode).toBe(200);
    expect(res.json().rows.length).toBeGreaterThan(0);
    await app.close();
  });
});
```

**Real output** (`npx vitest run test/statementTimeout.test.ts --reporter=verbose`)

```text
✓ test/statementTimeout.test.ts > statement timeouts > stops a 5 s query after about 2 s with a typed error 2028ms
✓ test/statementTimeout.test.ts > statement timeouts > leaves the connection usable, with no leftover timeout 1ms
✓ test/statementTimeout.test.ts > statement timeouts > serves the real report quickly 97ms
Tests  3 passed (3)
Duration  2.42s (tests 92%, import 6%, transform 2%)
```

**What to notice**
- **The 5-second query was stopped at 2.03 s**, and the caller got a `QueryTimeoutError`.
- **The same connection then showed `statement_timeout = 5s`**, the role default: the 2-second limit ended with its transaction.
- **The pool still had at most 2 connections**: a statement timeout does not break the connection.

### 7. Read replicas: routing reads, and not showing stale balances

**What it is.** A **read replica** is a copy of the database that replays the primary's write-ahead log (WAL). It can serve reads (statements, reports, search), taking load off the primary. It is always a little behind: usually milliseconds, sometimes seconds or minutes (a long query on the replica, a big write burst, network trouble). P4-02 covers replication properly; here is what the data access layer must do.

**The danger: read-your-writes.** Riya tops up ₹500 and the app immediately shows her balance from the replica. If the replica has not replayed that change yet, she sees her old balance and taps "top up" again.

**This lab ran a real streaming replica** (on port 5433, created with `pg_basebackup -R`). To make the lag visible, the demo **paused** replay on the replica with `pg_wal_replay_pause()`.

**Product version:** `src/lib/db/router.ts`. Writes return the WAL position (LSN) after them; reads take the user's last-write LSN and use the replica only if it has replayed that far.

```ts
// src/lib/db/router.ts: writes go to the primary; reads go to a replica unless it might be stale for this user.
import type { Pool } from "pg";

export interface DbRouter {
  /** Run a write on the primary. Returns the WAL position (LSN) after it, to remember for this user. */
  write<T>(fn: (db: Pool) => Promise<T>): Promise<{ result: T; lsn: string }>;
  /** Run a read on the replica if it has replayed `minLsn` (the user's last write); otherwise on the primary. */
  read<T>(fn: (db: Pool) => Promise<T>, minLsn?: string): Promise<{ result: T; servedBy: "replica" | "primary" }>;
}

export function createDbRouter(primary: Pool, replica: Pool): DbRouter {
  return {
    async write(fn) {
      const result = await fn(primary);
      const { rows } = await primary.query<{ lsn: string }>("SELECT pg_current_wal_lsn()::text AS lsn");
      return { result, lsn: rows[0]!.lsn };
    },
    async read(fn, minLsn) {
      if (minLsn) {
        // Has the replica applied everything up to this user's last write? (One cheap round trip.)
        const { rows } = await replica.query<{ caught_up: boolean | null }>(
          "SELECT pg_last_wal_replay_lsn() >= $1::pg_lsn AS caught_up", [minLsn]);
        if (rows[0]?.caught_up !== true) return { result: await fn(primary), servedBy: "primary" };
      }
      return { result: await fn(replica), servedBy: "replica" };
    },
  };
}
```

`minimal/replicaLag.ts`

```ts
// minimal/replicaLag.ts: a top-up on the primary, a balance read on the replica, with replay paused.
import pg from "pg";
import { createDbRouter } from "../src/lib/db/router.js";

const primary = new pg.Pool({ connectionString: "postgres://ledger_app:lab@127.0.0.1:5432/ledger_dal", max: 2 });
const replica = new pg.Pool({ connectionString: "postgres://ledger_app:lab@127.0.0.1:5433/ledger_dal", max: 2 });
const replicaAdmin = new pg.Client({ connectionString: "postgres://postgres:lab@127.0.0.1:5433/ledger_dal" });
await replicaAdmin.connect();
const router = createDbRouter(primary, replica);
const { rows: [w] } = await primary.query("SELECT wallet_id, balance_minor FROM wallet_balances ORDER BY wallet_id LIMIT 1");
const balanceOn = async (db: pg.Pool) => (await db.query("SELECT balance_minor FROM wallet_balances WHERE wallet_id = $1", [w.wallet_id])).rows[0].balance_minor;
const lag = async () => (await replicaAdmin.query("SELECT pg_last_wal_receive_lsn() AS received, pg_last_wal_replay_lsn() AS replayed")).rows[0];

console.log(`before: primary ${await balanceOn(primary)}, replica ${await balanceOn(replica)}`);
await replicaAdmin.query("SELECT pg_wal_replay_pause()");      // imitate a replica that is behind
const { lsn } = await router.write((db) => db.query("UPDATE wallet_balances SET balance_minor = balance_minor + 50000 WHERE wallet_id = $1", [w.wallet_id]));
await new Promise((r) => setTimeout(r, 200));
const l = await lag();
console.log(`after a ₹500 top-up (write LSN ${lsn}): replica received ${l.received}, replayed only ${l.replayed}`);
console.log(`plain read from replica:           ${await balanceOn(replica)}   <- stale`);
const routed = await router.read(balanceOn, lsn);
console.log(`router.read with the user's LSN:  ${routed.result}   (served by ${routed.servedBy})`);
await replicaAdmin.query("SELECT pg_wal_replay_resume()");
await new Promise((r) => setTimeout(r, 200));
const again = await router.read(balanceOn, lsn);
console.log(`after replay resumes:             ${again.result}   (served by ${again.servedBy})`);
await primary.query("UPDATE wallet_balances SET balance_minor = balance_minor - 50000 WHERE wallet_id = $1", [w.wallet_id]); // undo
await Promise.all([primary.end(), replica.end(), replicaAdmin.end()]);
```

**Real output**

```text
before: primary 1000000, replica 1000000
after a ₹500 top-up (write LSN 0/62003900): replica received 0/62003900, replayed only 0/62000060
plain read from replica:           1000000   <- stale
router.read with the user's LSN:  1050000   (served by primary)
after replay resumes:             1050000   (served by replica)
```

**What to notice**
- **The replica had received the change (`0/62003900`) but replayed only up to `0/62000060`**, so a plain read showed the old balance.
- **The router compared the user's write LSN with the replica's replay LSN, saw it was behind, and read from the primary**: Riya saw ₹10,500.
- **Once replay resumed, the same call was served by the replica again.**

**Diagram: where a read goes**

```mermaid
flowchart TD
  Q{"Money check, or<br/>inside a write?"}
  P1["Primary"]
  W{"User wrote in the<br/>last few seconds?"}
  L{"Replica caught up<br/>to user's LSN?"}
  R["Replica"]
  Q -->|"yes"| P1
  Q -->|"no"| W
  W -->|"no"| R
  W -->|"yes"| L
  L -->|"yes"| R
  L -->|"no"| P1
```

**How to read this diagram.** Start at the top. Balance checks and anything in a writing transaction always go to the primary. Other reads go to the replica, unless this user has just written something the replica may not have replayed yet; then one cheap LSN comparison decides.

**Ways to route reads** (from simplest to most precise)

| Strategy | How | Trade-off |
|---|---|---|
| Never read money from replicas | Balances and anything a user just changed always go to the primary; replicas get reports and search | Simple and safe; the primary does more reads |
| Stick to the primary after a write | After a user writes, read from the primary for the next N seconds (a cookie or a Redis key) | Simple; N must be larger than your worst normal lag |
| Wait for the LSN | Store the write LSN per user; read from the replica only if `pg_last_wal_replay_lsn() >= lsn` (this lab) | Precise; one extra cheap query, or wait briefly for the replica |
| Lag guard | Stop routing to a replica whose lag (`now() - pg_last_xact_replay_timestamp()`) exceeds a limit | Protects everyone during incidents; needs monitoring |

**When to use replicas.** Heavy read-only work that can tolerate staleness: statements, analytics, search indexing, exports. **When not:** checks that guard money (balance, limits) and anything inside a transaction that writes. Those always use the primary.

### 8. Batching writes: multi-row inserts and COPY

**What it is.** Importing a bank statement, backfilling a column or loading test data means writing many rows. Each `INSERT` is a round trip, and in autocommit mode each one is also a transaction commit (a disk flush). Batching cuts both.

**Product version:** `src/repositories/ledgerImport.ts`. Three ways, each taking a client that is already in a transaction.

```ts
// src/repositories/ledgerImport.ts: three ways to write many ledger rows (bank statement imports, backfills).
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import type { PoolClient } from "pg";
import { from as copyFrom } from "pg-copy-streams";

export interface ImportRow { transferId: string; walletId: string; direction: "debit" | "credit"; amountMinor: number; createdAt: Date }
const COLUMNS = "(transfer_id, wallet_id, direction, amount_minor, created_at)";

// 1. One INSERT per row: one round trip (and, in autocommit, one commit) per row.
export async function insertOneByOne(tx: PoolClient, table: string, rows: ImportRow[]): Promise<void> {
  for (const r of rows) {
    await tx.query(`INSERT INTO ${table} ${COLUMNS} VALUES ($1, $2, $3, $4, $5)`, [r.transferId, r.walletId, r.direction, r.amountMinor, r.createdAt]);
  }
}

// 2. Multi-row INSERT through unnest: five array parameters, any number of rows, one round trip per batch.
//    (A VALUES list with $1..$5000 also works, but Postgres caps one statement at 65,535 parameters.)
export async function insertBatched(tx: PoolClient, table: string, rows: ImportRow[], batchSize = 5_000): Promise<void> {
  for (let i = 0; i < rows.length; i += batchSize) {
    const b = rows.slice(i, i + batchSize);
    await tx.query(
      `INSERT INTO ${table} ${COLUMNS}
       SELECT * FROM unnest($1::uuid[], $2::uuid[], $3::text[], $4::bigint[], $5::timestamptz[])`,
      [b.map((r) => r.transferId), b.map((r) => r.walletId), b.map((r) => r.direction), b.map((r) => r.amountMinor), b.map((r) => r.createdAt)]);
  }
}

// 3. COPY: stream rows in Postgres's text format; the fastest bulk path, still inside the caller's transaction.
export async function insertWithCopy(tx: PoolClient, table: string, rows: ImportRow[]): Promise<void> {
  const lines = Readable.from((function* () {
    for (const r of rows) yield `${r.transferId}\t${r.walletId}\t${r.direction}\t${r.amountMinor}\t${r.createdAt.toISOString()}\n`;
  })());
  await pipeline(lines, tx.query(copyFrom(`COPY ${table} ${COLUMNS} FROM STDIN`)));
}
```

**What to notice**
- **`unnest` sends five arrays as five parameters,** so one statement can insert any number of rows. A `VALUES ($1, $2, ...), (...)` list also works but needs a placeholder per value, and Postgres allows at most 65,535 parameters in one statement.
- **`COPY ... FROM STDIN`** streams rows in Postgres's own text format; `pipeline()` (P1-02) handles backpressure.
- **The table name is a trusted constant from the caller,** never user input (Deep dive 5).

**100,000 ledger rows, four ways (must-include).** Same table, same index, 2-vCPU sandbox. **Real output**

```text
localhost | one INSERT per row, autocommit               | 100000 rows |   24.01 s |      4,166 rows/s
localhost | one INSERT per row, one transaction          | 100000 rows |    9.27 s |     10,790 rows/s
localhost | multi-row INSERT (unnest), 5,000 per batch   | 100000 rows |    0.76 s |   1,32,108 rows/s
localhost | COPY FROM STDIN                              | 100000 rows |    0.48 s |   2,06,201 rows/s
```

With about 2.5 ms per round trip (the per-row methods ran 5,000 rows, since 100,000 would take minutes). **Real output**

```text
+delay    | one INSERT per row, autocommit               |   5000 rows |   15.40 s |        325 rows/s
+delay    | one INSERT per row, one transaction          |   5000 rows |   13.30 s |        376 rows/s
+delay    | multi-row INSERT (unnest), 5,000 per batch   | 100000 rows |    0.84 s |   1,19,552 rows/s
+delay    | COPY FROM STDIN                              | 100000 rows |    0.83 s |   1,20,493 rows/s
```

| Method | Rows/s, localhost | Rows/s, 2.5 ms round trips | 1,00,000 rows with delay (computed) |
|---|---|---|---|
| One `INSERT` per row, autocommit | 4,166 | 325 | about 308 s (5.1 min) |
| One `INSERT` per row, one transaction | 10,790 | 376 | about 266 s |
| Multi-row `INSERT` (`unnest`, 5,000 per batch) | 1,32,108 | 1,19,552 | 0.84 s |
| `COPY FROM STDIN` | **2,06,201** | **1,20,493** | 0.83 s |

**How to read it**
- **On localhost, `COPY` was 49 times faster than row-by-row autocommit**, and multi-row inserts 32 times faster. One transaction alone helped 2.6 times, by removing 99,999 commits.
- **With network delay, per-row inserts collapsed to a few hundred rows a second** (each row pays a round trip), while batched methods hardly noticed.
- **For a few thousand rows, a multi-row insert is enough.** Use `COPY` for big loads, and remember it stops at the first bad row: validate the rows first, or `COPY` into a staging table and `INSERT ... SELECT` from it.

### 9. Serverless connection storms: many short-lived functions, one database

**What it is.** A serverless function (AWS Lambda and similar) runs in many short-lived instances. A traffic spike can start hundreds at once, and each one opens its own connection, because there is no long-lived process to hold a pool. The database runs out of slots in seconds.

**Minimal version:** `minimal/serverlessStorm.ts`. 200 "invocations" start at once; each connects, runs a 50 ms query and disconnects.

```ts
// minimal/serverlessStorm.ts: 200 "function invocations" start at once; each opens its own connection.
import pg from "pg";

async function invocation(port: number): Promise<string> {
  const client = new pg.Client({ connectionString: `postgres://ledger_app:lab@127.0.0.1:${port}/ledger_dal` });
  try {
    await client.connect();                                   // a cold function has no pool to reuse
    await client.query("SELECT pg_sleep(0.05)");              // 50 ms of real work
    return "ok";
  } catch (err) {
    return `${(err as { code?: string }).code} ${(err as Error).message}`;
  } finally {
    await client.end().catch(() => undefined);
  }
}

for (const [label, port] of [["direct to Postgres", 5432], ["through PgBouncer", 6432]] as const) {
  const t0 = performance.now();
  const results = await Promise.all(Array.from({ length: 200 }, () => invocation(port)));
  const counts: Record<string, number> = {};
  for (const r of results) counts[r] = (counts[r] ?? 0) + 1;
  console.log(`${label.padEnd(18)} | ${((performance.now() - t0) / 1000).toFixed(2)} s | ${JSON.stringify(counts)}`);
}
```

**Real output**

```text
direct to Postgres | 0.49 s | {"53300 remaining connection slots are reserved for roles with the SUPERUSER attribute":3,"ok":95,"53300 sorry, too many clients already":102}
through PgBouncer  | 0.64 s | {"ok":200}
```

**What to notice**
- **Direct to Postgres, 105 of 200 invocations failed** with `53300`: only about 95 got one of the 97 slots a normal role can use.
- **Through PgBouncer, all 200 succeeded** in 0.64 s: client connections to PgBouncer are cheap, and it queued the work onto its 20 server connections.

**The fixes**
1. **A pooled proxy in front of the database:** PgBouncer you run, or a managed one (for example Amazon RDS Proxy, or your provider's built-in pooler). Point functions at it, in transaction mode, and follow its rules (Deep dive 2).
2. **One tiny pool per function instance, created outside the handler** (`max: 1` or `2`), so warm invocations reuse it; and a short `idleTimeoutMillis` so idle instances give connections back.
3. **Limit concurrency** at the platform (reserved concurrency per function) so a spike cannot exceed what the database and proxy can take.
4. **HTTP-based drivers** that some managed Postgres providers offer avoid long-lived TCP connections from functions altogether; check what yours supports.

---
## ⚖️ Comparisons and trade-offs

The ORM vs query builder vs raw SQL table is in Deep dive 4, and the insert-method table in Deep dive 8.

### Where pooling happens

| | App pool only (`pg.Pool` per process) | PgBouncer, session mode | PgBouncer, transaction mode | Managed proxy (RDS Proxy and similar) |
|---|---|---|---|---|
| Server connections | Pods × pool max | One per connected client | `default_pool_size` per database and user | Set by the service |
| Session features (`SET`, `LISTEN`, session advisory locks, temp tables) | All work | All work | Do not work (Deep dive 2) | Depends on the product |
| Good for | Few long-running services whose pools fit the budget | Many idle clients, little sharing needed | Many services, many pods, serverless | Serverless on that cloud, no proxy to run yourself |
| You must | Do the sizing arithmetic | Size the pool | Avoid session state; use `SET LOCAL`, role defaults | Learn its limits and pricing (P5-07) |

### Ways to remove an N+1

| | `JOIN` / `LATERAL` (one query) | Window function (one query) | Batched `= ANY($1)` (two queries) | DataLoader (two queries) |
|---|---|---|---|---|
| Round trips | 1 | 1 | 2 | 2 (one per "level" of nesting) |
| Uses the index to stop at N rows per parent | Yes | No: numbers every child row | Yes (with `LATERAL` inside) | Same as its batch query |
| Code shape | One repository method | One repository method | List method + "children for many ids" method | Per-item code stays per-item |
| Best for | Fixed shapes like "list with last 5" | Small child sets, or when you need ranks | Reusing a "for many ids" query in several places | GraphQL resolvers and other per-item code |
| Here, Chai Point, p95 with delay | **5.3 ms** | 32.6 ms | 7.4 ms | 7.8 ms |

---

## 🚶 Walkthrough on the ledger platform: Chai Point opens its outlets dashboard

The numbers below match the diagram.

1. **The dashboard calls** `GET /v1/users/{chaiPointId}/wallets`.
2. **Fastify's `onRequest` hook starts a query counter** for this request (`queryStatsHook`).
3. **Zod validates the id**; the route calls the repository's `listLateral`.
4. **`pool.query` borrows an idle client** from this pod's pool (`max: 8`). It is already connected and authenticated, so no TCP or TLS handshake.
5. **The client's connection goes to PgBouncer**, which lends it one of its 20 server connections for this single-statement transaction.
6. **Postgres runs one `LATERAL` query**: for each of the 50 wallets, the newest 5 entries straight from the covering index. 250 rows come back.
7. **PgBouncer takes its server connection back at the end of the transaction**, and the pool takes the client back. Both are ready for the next request.
8. **The repository groups the 250 rows into 50 wallets**, five entries each.
9. **`onSend` adds `x-db-queries: 1`**, and `onResponse` checks the query budget: 1 query, no repeated statements, no warning.

**Diagram: one request, one query**

```mermaid
sequenceDiagram
  participant D as Dashboard
  participant API as ledger-api pod
  participant Pool as pg.Pool, max 8
  participant B as PgBouncer
  participant PG as Postgres
  D->>API: 1. GET /v1/users/id/wallets
  API->>API: 2. start query counter
  API->>API: 3. Zod validates, call listLateral
  API->>Pool: 4. borrow an open client
  Pool->>B: 5. query on an existing client connection
  B->>PG: 5. lend a server connection
  PG-->>B: 6. one LATERAL query, 250 rows
  B-->>Pool: 7. server connection back to PgBouncer
  Pool-->>API: 7. client back to the pool
  API->>API: 8. group rows into 50 wallets
  API-->>D: 9. 200, x-db-queries 1
```

**How to read this diagram.** Nothing on this path opens a connection: the pod's client and PgBouncer's server connection already exist, and each is held only for the one statement. The naive version would repeat steps 4 to 7 fifty-one times, and each repetition pays the network round trip.

---

## 🧪 Hands-on lab

Five steps, in the card's order.

### Prerequisites

- Docker, Node.js 24 or 26, `psql`, `pgbench` (comes with Postgres client tools), and PgBouncer (`apt install pgbouncer` or `brew install pgbouncer`; any 1.21+ release supports protocol-level prepared statements).
- The ledger project from earlier cards (Fastify, Zod, pino, Vitest), plus `npm install dataloader pg-copy-streams kysely drizzle-orm`.

`docker-compose.yml`

```yaml
services:
  postgres:
    image: postgres:18
    command: ["postgres", "-c", "max_connections=100"]   # the default, written down on purpose
    environment:
      POSTGRES_PASSWORD: lab          # lab only; real secrets come from the environment (P1-06)
      POSTGRES_DB: ledger_dal
    ports:
      - "5432:5432"
```

**Seed:** `db/schema.sql` creates the tables, P2-02's covering index, Chai Point with 50 outlet wallets of 2,000 entries each, and 1,000 ordinary users with 2 wallets of 200 entries (5 lakh entries, about 5 seconds to load). Then run `db/roles.sql` (Deep dive 2) for the `ledger_app` role.

```sql
-- Lab copy of the P2-01 tables this card reads, with P2-02's covering index on wallet history.
DROP TABLE IF EXISTS ledger_entries_import, ledger_entries, wallet_balances, wallets, users CASCADE;

CREATE TABLE users (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name text NOT NULL
);

CREATE TABLE wallets (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id   uuid        NOT NULL REFERENCES users (id),
  nickname   text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX wallets_by_owner ON wallets (owner_id);

CREATE TABLE wallet_balances (
  wallet_id     uuid   PRIMARY KEY REFERENCES wallets (id),
  balance_minor bigint NOT NULL CHECK (balance_minor >= 0)
);

CREATE TABLE ledger_entries (
  id           bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  transfer_id  uuid        NOT NULL,
  wallet_id    uuid        NOT NULL REFERENCES wallets (id),
  direction    text        NOT NULL CHECK (direction IN ('debit', 'credit')),
  amount_minor bigint      NOT NULL CHECK (amount_minor > 0),
  created_at   timestamptz NOT NULL DEFAULT now()
);
-- P2-02's covering index: newest entries of one wallet, without touching the table.
CREATE INDEX ledger_entries_by_wallet ON ledger_entries (wallet_id, created_at DESC, id DESC) INCLUDE (direction, amount_minor);

-- Target for the insert benchmark: same columns and index, no foreign key (so we time inserts, not FK checks).
CREATE TABLE ledger_entries_import (LIKE ledger_entries INCLUDING DEFAULTS INCLUDING IDENTITY);
CREATE INDEX ON ledger_entries_import (wallet_id, created_at DESC, id DESC);

-- Seed: Chai Point (a merchant with 50 outlet wallets, 2,000 entries each) and 1,000 ordinary users (2 wallets, 200 each).
INSERT INTO users (id, display_name) VALUES ('00000000-0000-4000-8000-00000000c0de', 'Chai Point');
INSERT INTO users (display_name) SELECT 'User ' || g FROM generate_series(1, 1000) g;
INSERT INTO wallets (owner_id, nickname)
  SELECT '00000000-0000-4000-8000-00000000c0de', 'Outlet ' || g FROM generate_series(1, 50) g;
INSERT INTO wallets (owner_id, nickname) SELECT u.id, n FROM users u, (VALUES ('Main'), ('Savings')) v(n)
  WHERE u.display_name <> 'Chai Point';
INSERT INTO wallet_balances SELECT id, 10_00_000 FROM wallets;
INSERT INTO ledger_entries (transfer_id, wallet_id, direction, amount_minor, created_at)
  SELECT gen_random_uuid(), w.id, CASE WHEN g % 3 = 0 THEN 'debit' ELSE 'credit' END, 100 + (g * 37) % 50000,
         now() - g * interval '7 minutes'
    FROM wallets w
    JOIN users u ON u.id = w.owner_id
    CROSS JOIN LATERAL generate_series(1, CASE WHEN u.display_name = 'Chai Point' THEN 2000 ELSE 200 END) g;
VACUUM ANALYZE;
```

**A delay proxy** for realistic round trips: `bench/latencyProxy.ts` (start it on port 6543 in front of 5432, and point the app at 6543).

```ts
// LAB: a TCP proxy that delays every chunk, to imitate a database that is not on localhost.
import net from "node:net";

export function startLatencyProxy(listenPort: number, targetPort: number, oneWayDelayMs: number): Promise<net.Server> {
  const server = net.createServer((client) => {
    const upstream = net.connect(targetPort, "127.0.0.1");
    client.setNoDelay(true); upstream.setNoDelay(true);
    const forward = (from: net.Socket, to: net.Socket) =>
      from.on("data", (chunk) => setTimeout(() => to.write(chunk), oneWayDelayMs)); // equal delays keep order
    forward(client, upstream); forward(upstream, client);
    const close = () => { client.destroy(); upstream.destroy(); };
    client.on("error", close).on("close", close); upstream.on("error", close).on("close", close);
  });
  return new Promise((resolve) => server.listen(listenPort, "127.0.0.1", () => resolve(server)));
}
```

### Step 1: Count queries per request, and watch the N+1 appear

Wire `instrumentPool` and the route from Deep dive 3, then test the count as part of the contract:

`test/walletList.test.ts`

```ts
// test/walletList.test.ts: the query count is part of the contract.
import Fastify from "fastify";
import { afterAll, describe, expect, it } from "vitest";
import { createPool } from "../src/lib/db/pool.js";
import { instrumentPool } from "../src/lib/db/queryStats.js";
import { walletListRoutes } from "../src/routes/walletList.js";

const pool = instrumentPool(createPool(process.env.TEST_DATABASE_URL ?? "postgres://ledger_app:lab@127.0.0.1:5432/ledger_dal"));
afterAll(() => pool.end());
const CHAI_POINT = "00000000-0000-4000-8000-00000000c0de";

describe("GET /v1/users/:ownerId/wallets", () => {
  it.each([[true, 51], [false, 1]])("naive=%s runs %i queries for 50 wallets", async (naive, expected) => {
    const app = Fastify();
    await app.register(walletListRoutes(pool, { naive }));
    const res = await app.inject({ url: `/v1/users/${CHAI_POINT}/wallets` });
    expect(res.statusCode).toBe(200);
    expect(res.json().wallets).toHaveLength(50);
    expect(Number(res.headers["x-db-queries"])).toBe(expected);
    await app.close();
  });
});
```

**Real output**

```text
✓ test/walletList.test.ts > GET /v1/users/:ownerId/wallets > naive=true runs 51 queries for 50 wallets 100ms
✓ test/walletList.test.ts > GET /v1/users/:ownerId/wallets > naive=false runs 1 queries for 50 wallets 14ms
```

In the browser, open DevTools → Network and read the `x-db-queries` header on each API call.

### Step 2: Fix it with LATERAL and with a batched IN, then compare latency

The four versions are in `src/repositories/walletListRepository.ts` and `src/repositories/entryLoader.ts` (Deep dive 3). The benchmark calls each one 100 times for Chai Point and 200 times for an ordinary user, directly and through the delay proxy:

```bash
DATABASE_URL=postgres://ledger_app:lab@127.0.0.1:5432/ledger_dal npx tsx bench/nPlusOne.ts
```

**Real output:** the table "Query counts before and after the N+1 fix" in Deep dive 3. **For an HTTP-level p95**, run `npx autocannon -c 20 -d 15 http://127.0.0.1:3000/v1/users/<chai-point-id>/wallets` against each version with the app pointed at the delay proxy. **Expected:** the naive version's p95 is tens of times worse, and it also holds pool connections longer, so other endpoints slow down too.

### Step 3: Four instances with pools of 30 against max_connections = 100, then fix it

**What ran here:** `bench/poolStorm.ts` starts 4 Node.js processes; each makes a `pg.Pool` and sends 400 queries (`SELECT pg_sleep(0.02)`) at once. A separate session samples `pg_stat_activity` for the peak number of server connections. The instance code:

```ts
// bench/poolStorm.ts (one instance; the parent starts four and adds up their results)
const pool = new pg.Pool({ connectionString: url, max: Number(poolMax), connectionTimeoutMillis: 10_000 });
await Promise.all(Array.from({ length: 400 }, async () => {
  try { await pool.query("SELECT pg_sleep(0.02)"); /* ... record latency */ }
  catch (err) { /* ... count errors by SQLSTATE and message */ }
}));
```

```bash
npx tsx bench/poolStorm.ts 5432 30    # 4 x 30 straight to Postgres
npx tsx bench/poolStorm.ts 5432 20    # smaller pools
npx tsx bench/poolStorm.ts 6432 30    # 4 x 30 through PgBouncer (default_pool_size 20, then 60)
```

**Real output:** in Deep dive 2 (84 errors with 4 × 30 direct; none with 4 × 20 or through PgBouncer). The third line used `default_pool_size = 20`.

**On your machine with the real API (Expected).** Start 4 copies of the app (`PORT=3001..3004`, `DB_POOL_MAX=30`), load all four at once (`autocannon -c 50 -d 20` each), and watch the logs: some requests fail with `53300 sorry, too many clients already` (mapped to `503` by your error handler) while `pg_stat_activity` counts sit near 97. Then set `DB_POOL_MAX=20`, or point `DATABASE_URL` at PgBouncer with `viaPgBouncer: true`: the errors stop.

### Step 4: statement_timeout = '2s' on a slow query, handled cleanly

`src/lib/db/timeouts.ts`, the report route and the test are in Deep dive 6.

```bash
npx vitest run test/statementTimeout.test.ts
curl -s -i "http://127.0.0.1:3000/v1/merchants/<chai-point-id>/daily-totals?days=90"
```

**Real output:** the three passing tests in Deep dive 6 (stopped at 2.03 s, connection reusable, no leftover timeout). **Expected for the curl:** a normal `200` here; on a database where the report takes over 2 s, a `503` Problem Details response with `Retry-After: 30`, one `warn` log line with the request ID, and no stuck connection in `pg_stat_activity`.

### Step 5: Insert 100,000 ledger rows three ways

```bash
npx tsx bench/inserts.ts 5432 100000             # localhost
npx tsx bench/inserts.ts 6543 5000 "one INSERT"  # per-row methods through the delay proxy
npx tsx bench/inserts.ts 6543 100000 "multi"     # batched methods through the delay proxy
```

**Real output:** the insert-method table in Deep dive 8.

---

## 💥 Break it and measure it

| # | Break this | What you should see | Result here |
|---|---|---|---|
| 1 | Loop over wallets with one query each | 1 + N queries; a repeated statement in logs | **Real:** 51 queries; warning log with `"times":50` |
| 2 | Same N+1 with 2.5 ms per round trip | p95 grows with N | **Real:** p95 144.5 ms vs 5.3 ms for one query |
| 3 | 4 instances × pool 30 on `max_connections = 100` | `53300` errors under load | **Real:** 84 of 1,600 queries failed |
| 4 | 200 serverless-style invocations, each with its own connection | Half of them rejected | **Real:** 105 of 200 failed direct; 0 through PgBouncer |
| 5 | 96 connections on a 2-CPU database | Lower throughput, much higher latency | **Real:** read-only 50,477 → 34,807 tps; latency 35 times higher |
| 6 | A new client per request | Each request pays the connection handshake | **Real:** 5.5 ms vs 0.08 ms on localhost |
| 7 | Concatenate a search term into SQL | Data leak and data change | **Real:** 2,050 rows returned; another user's wallet renamed |
| 8 | `SET statement_timeout` through PgBouncer (transaction mode) | Another client inherits it | **Real:** client B saw `1s` |
| 9 | Named prepared statement through PgBouncer with `max_prepared_statements = 0` | `prepared statement ... does not exist` | **Real:** `26000` on the second run |
| 10 | Pool `statement_timeout` option through PgBouncer | Connection refused | **Real:** `08P01 unsupported startup parameter: statement_timeout` |
| 11 | Read your own write from a lagging replica | Stale balance | **Real:** replica showed ₹10,000 after a ₹500 top-up; router read the primary |
| 12 | No `statement_timeout`, a 5-minute query, 8 concurrent requests | The pool is empty; every endpoint waits | **Expected:** with `connectionTimeoutMillis: 2_000`, other requests fail fast with "timeout exceeded when trying to connect"; with the default 0, they hang |

### Measurements

The card's Measure items. **Real output** where marked; fill the last column on your machine.

| Measure | Before | After | Your machine |
|---|---|---|---|
| Queries per request, Chai Point wallet list | 51 (naive) | 1 (`LATERAL`), 2 (batched or DataLoader) | |
| p95 before and after the N+1 fix, localhost | 18.2 ms | 2.3 ms (`LATERAL`) | |
| p95 before and after the N+1 fix, 2.5 ms round trips | 144.5 ms | 5.3 ms (`LATERAL`) | |
| Connection errors under load, 4 instances × pool 30 | 84 of 1,600 (`53300`) | 0 with pools of 20; 0 through PgBouncer | |
| Connection errors, 200 serverless invocations | 105 of 200 | 0 through PgBouncer | |
| Rows/s, one `INSERT` per row (autocommit / one transaction) | 4,166 / 10,790 | | |
| Rows/s, multi-row `INSERT` (`unnest`, 5,000 per batch) | | 1,32,108 | |
| Rows/s, `COPY` | | 2,06,201 | |

---
## 🚫 Common mistakes and wrong mental models

### 1. Wrong mental model: "a bigger pool means more throughput"

**The truth.** A pool larger than the database can work on at once only moves the queue from your app (cheap) into Postgres (expensive: processes, memory, context switching, lock contention). On a 2-CPU database, read-only throughput was **50,477/s at 4 connections and 34,807/s at 96**, with latency 35 times higher. And every pod multiplies the pool.

```ts
// Beginner way: "the API is slow, give it more connections".
const pool = new pg.Pool({ connectionString, max: 100 });   // x 10 pods = 1,000 connections for a 100-slot database
```

```ts
// Product way: size from the budget (87 slots / 13 pods during a deploy = 6), and let PgBouncer multiplex if you need more pods.
const pool = createPool(env.DATABASE_URL, { max: env.DB_POOL_MAX /* 6 */, viaPgBouncer: env.DB_VIA_PGBOUNCER });
```

What breaks in the beginner way: `53300 too many clients` during the next deploy or traffic spike, and a slower database even before that.

### 2. Creating a new client per request instead of using a pool

```ts
// Beginner way: connect inside the handler.
app.get("/v1/wallets/:id", async (request) => {
  const client = new pg.Client({ connectionString });
  await client.connect();                       // 5.5 ms on localhost, more over a network, and a new Postgres process
  const { rows } = await client.query("SELECT * FROM wallets WHERE id = $1", [request.params.id]);
  await client.end();
  return rows[0];
});
```

```ts
// Product way: one pool per process, created at startup, closed on shutdown (P1-02); handlers just query it.
const pool = createPool(env.DATABASE_URL);
app.get("/v1/wallets/:id", async (request) => (await pool.query("SELECT id, nickname FROM wallets WHERE id = $1", [request.params.id])).rows[0]);
app.addHook("onClose", () => pool.end());
```

What breaks in the beginner way: 69 times the cost per query here, and under load a storm of new connections (Deep dive 9). A close cousin: `pool.connect()` without `release()` in a `finally`, which leaks one connection per error until the pool is empty.

### 3. Building SQL by string concatenation

```ts
// Beginner way: the search term becomes part of the SQL.
pool.query(`SELECT id, nickname FROM wallets WHERE owner_id = '${ownerId}' AND nickname ILIKE '%${term}%'`);
```

```ts
// Product way: values as parameters; identifiers (like a sort column) from an allow-list.
const ORDER = { newest: "created_at DESC", name: "nickname ASC" } as const;
pool.query(`SELECT id, nickname FROM wallets WHERE owner_id = $1 AND nickname ILIKE '%' || $2 || '%' ORDER BY ${ORDER[sort]}`, [ownerId, term]);
```

What breaks in the beginner way: one search box exposed all 2,050 wallets and let a user rename someone else's (Deep dive 5).

### 4. No statement timeout, so one bad query holds a connection for ever

```ts
// Beginner way: no limits anywhere. A 90-day report on the biggest merchant runs for minutes, eight times in parallel.
const { rows } = await pool.query(REPORT_SQL, [merchantId, days]);
```

```ts
// Product way: a role default (5 s) as the net, and a tighter limit for known-heavy queries, mapped to a clean 503.
const rows = await withStatementTimeout(pool, 2_000, async (tx) => (await tx.query(REPORT_SQL, [merchantId, days])).rows);
```

What breaks in the beginner way: eight slow reports take all eight pool connections; every other endpoint on that pod waits (or, with the default `connectionTimeoutMillis: 0`, hangs).

### More wrong mental models

| Wrong model | Correct model |
|---|---|
| "Each query in the N+1 is fast, so it's fine." | Each is fast on localhost. With 2.5 ms round trips, 51 fast queries took 136 ms (p50) vs 4 ms for one. |
| "`Promise.all` fixes the N+1." | It still runs N queries, and grabs up to N pool connections at once, starving other requests. |
| "The ORM prevents N+1." | It depends how you use it: a relation accessed inside a loop or a resolver is still one query per item. Count queries per request. |
| "PgBouncer makes Postgres faster." | It reduces **connections**; each query still costs the same, plus one extra hop. Size its pool like any pool. |
| "Raise `max_connections` to 1,000." | Every connection is a process with its own memory, and contention grows. Pool, multiplex, and fix slow queries instead. |
| "`query_timeout` in the client is the same as `statement_timeout`." | The client stops waiting; the server may keep running the query and holding locks. Use `statement_timeout`. |
| "Read replicas have the same data." | They replay the WAL, a little behind; read-your-writes needs routing (Deep dive 7). |

---

## ✅ Production checklist

**Connections**
- [ ] One pool per process, created at startup and closed on shutdown; no `new Client()` in request paths.
- [ ] Pool size from the arithmetic: (pods during a deploy) × `max` + admin headroom ≤ `max_connections` − reserved; written down next to the config.
- [ ] `connectionTimeoutMillis` set (fail fast), `idleTimeoutMillis` and `maxLifetimeSeconds` set.
- [ ] Every `pool.connect()` has `release()` in a `finally` (or uses a `withTransaction` helper).
- [ ] Dashboards: connections by state (`pg_stat_activity`), pool waiting count (`pool.waitingCount`), `53300` errors.

**PgBouncer (if used)**
- [ ] Transaction mode, `default_pool_size` sized by measurement, `max_client_conn` above total client pools.
- [ ] No session features: no `SET` (use `SET LOCAL` / `set_config(..., true)`), no `LISTEN`, no session advisory locks, no `WITH HOLD` cursors.
- [ ] Time limits as role defaults (`ALTER ROLE ... SET`), not as pool startup parameters.
- [ ] `max_prepared_statements` > 0 if any client uses named or protocol-level prepared statements (default 200 from PgBouncer 1.24).
- [ ] Migrations and admin tools connect to Postgres directly (or through a session-mode pool).

**Queries**
- [ ] Query count per request measured in tests for list endpoints; a log warning when a request exceeds its budget or repeats a statement.
- [ ] `pg_stat_statements` enabled; top statements by total time and by calls reviewed regularly.
- [ ] Every value is a parameter; identifiers come from allow-lists.
- [ ] Role-level `statement_timeout`, `lock_timeout`, `idle_in_transaction_session_timeout`; tighter `SET LOCAL` for reports and exports; `57014` mapped to a clean error.
- [ ] Bulk writes batched (multi-row or `COPY`), inside transactions, in chunks.

**Replicas**
- [ ] Money checks and anything a user just changed read from the primary (or after an LSN check).
- [ ] Replica lag monitored, with a cut-off that sends reads back to the primary.

---

## 🤖 Engineering with AI

**Where AI tools help**
- Rewriting an N+1 loop as one `LATERAL` query or a batched `= ANY($1)` query, and writing the DataLoader batch function.
- Translating between Prisma, Drizzle, Kysely and raw SQL for the same query, so you can compare the SQL each produces.
- Doing the pool-sizing arithmetic for your deploy settings, and drafting `pgbouncer.ini`.
- Writing `COPY` import code and the staging-table pattern.

**Where AI commonly goes wrong on this concept**
- Generates "fetch the list, then `await` per item" code (or `Promise.all(items.map(query))`) and calls it efficient.
- Sets `max: 50` or `max: 100` "for performance", without multiplying by the number of pods.
- Creates a `new Client()` inside a handler, or a new `Pool` per request in serverless code.
- Builds SQL with template literals that include user input, or uses an ORM's raw-query function with string interpolation.
- Uses session `SET` (or `pg.Pool` startup timeouts) in an app that runs behind PgBouncer in transaction mode.
- Reads a just-written value from a replica pool.
- Inserts thousands of rows in a `for` loop of single `INSERT`s.

**Review checklist for AI-generated data access code**
- [ ] How many queries does this endpoint run for a list of 50? (Write the test.)
- [ ] Is there an `await` on a query inside a loop, or a `.map` that creates queries?
- [ ] Is every value a parameter? Any `${}` inside SQL that is not a trusted constant or an allow-listed identifier?
- [ ] Is the pool created once? Is every checked-out client released in `finally`?
- [ ] Will this work through PgBouncer in transaction mode (no `SET`, no session state)?
- [ ] Does any query lack a time limit, or read money from a replica?
- [ ] Are bulk writes batched?

**Prompts that work**

1. *"Here is a repository method and the route that calls it. Count how many SQL queries run for a user with 50 wallets. If it is more than 3, rewrite it as one query using LEFT JOIN LATERAL with the existing index on ledger_entries (wallet_id, created_at DESC, id DESC), and keep the TypeScript return type the same."*
   **Verify by:** the query-count test (`x-db-queries`), and `EXPLAIN (ANALYZE, BUFFERS)` showing an index scan with a limit per wallet.
2. *"We run 10 pods (maxSurge 25%), max_connections is 100, we keep 10 for admin, and our app role is not a superuser. Compute the largest safe pg.Pool max per pod, then write a pgbouncer.ini for transaction mode that lets us scale to 40 pods, and list every session feature our code must stop using."*
   **Verify by:** recomputing the numbers yourself, and running the PgBouncer "what breaks" script against the config.
3. *"Review this file for SQL injection: list every query whose text includes anything other than literal SQL and $n placeholders, and rewrite each with parameters or an identifier allow-list."*
   **Verify by:** trying `' OR '1'='1' --` and a `; UPDATE ...` input against the endpoints, and a grep for template literals inside `query(` calls.

---

## 🎤 Interview script

**How it shows up.** Bottleneck questions ("the database CPU is at 100%", "the API got slow after we scaled to 30 pods", "Lambda + Postgres keeps failing") and machine-coding rounds that expect a clean repository layer. Strong answers do the pool arithmetic out loud and name N+1 before the interviewer does.

### 2-minute answer: "Database CPU is at 100%. What do you check?"

1. **What is running right now.** `pg_stat_activity`: how many sessions are `active` vs `idle in transaction`, what they wait on, the oldest queries. Hundreds of active sessions on a few cores means too many connections; one long query means a bad plan.
2. **What costs the most over time.** `pg_stat_statements` sorted by total time, then by calls. A cheap statement with millions of calls is usually an N+1; a statement with a high mean time is usually a missing index or a bad plan (`EXPLAIN ANALYZE`, P2-02).
3. **Where it comes from.** The app's per-request query counts and pool metrics, and what changed recently: a deploy, more pods (connections multiply), a big customer (N+1s scale with them).
4. **Stop the bleeding.** Cancel runaway queries (`pg_cancel_backend`), set `statement_timeout`, cap pools or put PgBouncer in front, move heavy reads to a replica.
5. **Fix the cause.** Rewrite the N+1 as one query, add the index, batch writes, and add a query budget test so it cannot come back.

### Five likely follow-ups

1. **"10 pods, pool 20 each, max_connections 100. What happens?"**
   200 connections wanted, about 97 available to a normal role. Under load the pools grow past that, and new connections fail with `53300 too many clients`, so requests fail on whichever pods connect last; deploys make it worse because old and new pods overlap. In my test, 4 pods × 30 failed 84 of 1,600 queries. Fix: compute the budget (87 after reserved and admin slots; 13 pods during a deploy → 6 per pod), or put PgBouncer in front so pods hold cheap client connections and Postgres sees a fixed 20 to 60.
2. **"What breaks with PgBouncer in transaction mode?"**
   Anything tied to the session: `SET` (it leaked to another client in my test), `LISTEN`, session advisory locks, `WITH HOLD` cursors, SQL `PREPARE`, temp tables that outlive a transaction, and startup parameters such as `statement_timeout` (the connection is refused). Named prepared statements need `max_prepared_statements` on 1.21+, which defaults to 200 since 1.24. Use `SET LOCAL`, role defaults and transaction-scoped advisory locks.
3. **"How do you find N+1s?"**
   In review: `await` inside a loop over results, `Promise.all` over queries, relation access in loops or resolvers. In production: query count per request (the same SQL repeated in one request is the signature), `pg_stat_statements` calls, and traces with a ladder of identical database spans. I make the count part of the test for list endpoints.
4. **"Serverless functions and Postgres?"**
   Each instance opens its own connection, so a spike exhausts the database: 105 of 200 invocations failed in my test, 0 through PgBouncer. Put a pooling proxy in front, keep a tiny pool outside the handler for warm reuse, limit concurrency, or use an HTTP-based driver if the provider offers one.
5. **"Can we read balances from a replica?"**
   Not right after a write without care: the replica replays the WAL slightly behind. I route money checks to the primary, and for other reads either stick to the primary for a few seconds after a user writes, or compare the user's last-write LSN with the replica's replay LSN. I showed a ₹500 top-up invisible on a paused replica, and the router falling back to the primary.

### Red flags interviewers notice

- "Increase `max_connections`" or "increase the pool size" as the first answer.
- Not multiplying pool size by the number of instances.
- Not recognising an `await` in a loop as an N+1, or "`Promise.all` fixes it".
- String-built SQL anywhere.
- No timeouts, or relying on client-side timeouts only.
- Reading just-written data from a replica.

### LLD sketch: a clean repository layer (machine coding)

```ts
// src/repositories/types.ts: what services depend on. Queryable is a Pool or a transaction's client.
import type pg from "pg";
export type Queryable = Pick<pg.Pool, "query">;

export interface WalletRepository {
  listWithRecentEntries(ownerId: string, recent: number): Promise<WalletWithRecent[]>;  // ONE query, whatever N
  findById(walletId: string): Promise<Wallet | undefined>;
}
export interface LedgerImportRepository {
  importRows(tx: pg.PoolClient, rows: ImportRow[]): Promise<number>;                     // COPY or batched, inside the caller's tx
}

// Constructor functions take their database handle: easy to test, easy to run inside withTransaction.
export function createWalletRepository(db: Queryable): WalletRepository {
  return {
    listWithRecentEntries: (ownerId, recent) => listLateral(db, ownerId /* , recent */),
    findById: async (walletId) => /* ... */ undefined,
  };
}
```

**Say out loud:** repositories own all SQL and take a `Queryable` so the same code runs on the pool or inside a transaction; list methods have a query-count budget and a test; services never build SQL; the pool is created once in the composition root.

---

## ❓ Questions from the card, answered

Try each one yourself first, then open the answer.

<details>
<summary><b>1. Ten pods each run a pool of 20, and Postgres allows 100 connections. What happens under load?</b></summary>

The pods want up to 10 × 20 = **200 connections**. Postgres allows 100, and keeps 3 for superusers, so a normal app role gets about **97**. While load is light, pools stay small and nothing happens. Under load, each pool grows towards 20, and once about 97 are open, every new connection attempt fails with **`53300 sorry, too many clients already`** (or "remaining connection slots are reserved..."). Requests on whichever pods connect last fail or wait, depending on `connectionTimeoutMillis`. A rolling deploy (old and new pods both up) makes it worse, and the database is also slower than it would be with fewer connections (Deep dive 1).

In this guide, the smaller version of the same mistake, 4 instances × 30 = 120, failed **84 of 1,600 queries**. With pools of 20 (80 total) there were no errors.

**Fixes:** compute the budget (100 − 3 reserved − 10 admin = 87; with 13 pods during a deploy, a pool of 6 per pod), and if you need more pods than that allows, put **PgBouncer in transaction mode** in front, so pods keep cheap client connections and Postgres sees a fixed server pool. Do not just raise `max_connections`.

</details>

<details>
<summary><b>2. How do you spot an N+1 query during code review?</b></summary>

Look for a query that runs **once per item of a list**:
- an `await db.query(...)` (or a repository call) inside a `for`/`for...of` loop over rows;
- `Promise.all(items.map((item) => db.query(...)))`, which is still N queries;
- ORM relation access inside a loop, a template or a GraphQL resolver (`wallet.entries`);
- a function that takes one id, called from code that has many ids.

Then confirm it, not by timing on localhost (the N+1 here was only 18 ms locally), but by **counting queries per request**: the same SQL text many times in one request is the signature. This guide's route logged `"db_queries":51` with one statement repeated 50 times, and a test asserts the count (51 → 1). In production, `pg_stat_statements` shows the repeated statement with a huge `calls` count.

</details>

<details>
<summary><b>3. What breaks when you put PgBouncer in transaction mode?</b></summary>

Each transaction may run on a different server connection, and your server connection is lent to other clients between transactions. So anything that lives in the **session** breaks:

- **`SET` / `RESET`:** the setting stays on that server connection and leaks to whoever gets it next. In the lab, client B inherited client A's `statement_timeout = 1s`.
- **Startup parameters** other than a few PgBouncer tracks: node-postgres's `statement_timeout` pool option made PgBouncer refuse the connection (`08P01 unsupported startup parameter`).
- **Named / protocol-level prepared statements**, unless `max_prepared_statements` is set (1.21+; default 200 since 1.24; 0 in the 1.22 used here, which gave `26000 prepared statement does not exist`). SQL-level `PREPARE`/`DEALLOCATE` never work.
- **`LISTEN`**, **session-level advisory locks**, **`WITH HOLD` cursors**, **temporary tables** that outlive a transaction, and **`LOAD`**.

What still works: transactions, `SET LOCAL` and `set_config(..., true)`, transaction-level advisory locks, `NOTIFY`, `ON COMMIT DROP` temp tables. Put time limits on the role (`ALTER ROLE ... SET`), and let migrations and tools that need session features connect to Postgres directly.

</details>

<details>
<summary><b>4. When would you drop from an ORM to raw SQL?</b></summary>

Keep the ORM for ordinary reads and writes, and drop to raw SQL (inside the repository, parameterised and tested) when:

- **The ORM cannot express the query well:** `LATERAL` joins, window functions, recursive CTEs, `FOR UPDATE SKIP LOCKED` (P2-04), `INSERT ... ON CONFLICT ... RETURNING`, set-based updates.
- **The generated SQL is slow** and you cannot fix it through the API (check with `EXPLAIN ANALYZE`; check query counts too, since some relation loads issue one query per table).
- **Bulk work:** `COPY` loaded 2,06,201 rows/s here; per-row ORM inserts are in the thousands at best.
- **Hot paths** where every round trip and every column matters, such as the transfer path from P2-03 and P2-04.
- **Database features the ORM does not know about** (advisory locks, `set_config`, replication functions).

Query builders such as Kysely, or Drizzle's SQL-like API, are a middle ground: you keep types and still control the SQL.

</details>

---

## 🏋️ Exercises

### Beginner (no code)

1. **Pool arithmetic.** Your database allows 200 connections; you keep 15 for admin; you run 3 services with 12, 6 and 4 pods, and deploys surge by 25%. Compute a safe pool size per service if each gets an equal share of the budget.
   **Expected:** budget 200 − 3 − 15 = 182; 60 per service; pods during a deploy 15, 8 and 5; pools of 4, 7 and 12. **Verify:** with a short Python script.
2. **Find the N+1.** Read a GraphQL resolver that returns `wallet.owner` for each wallet in a list, and say how many queries a list of 100 wallets runs.
   **Expected:** 1 + 100 without DataLoader; 2 with a per-request DataLoader. **Verify:** count queries with `queryStats`.

### Intermediate (extend the lab)

3. **Statement view with a query budget.** Add `GET /v1/wallets/:id/statement?month=` that returns entries plus running totals, with a test asserting at most 2 queries.
   **Expected:** one query for entries (window function for the running total) and one for the wallet. **Verify:** `x-db-queries` and `EXPLAIN`.
4. **Staging-table import.** Import a CSV with `COPY` into an unlogged staging table, validate rows with SQL, then `INSERT ... SELECT` the good ones into `ledger_entries` in one transaction.
   **Expected:** bad rows reported, good rows loaded, close to `COPY` speed. **Verify:** rows/s and a row count per status.

### Advanced (failure injection and 10x)

5. **Kill the pool.** Run the report endpoint with `pg_sleep(30)` inside it, 8 times at once, on a pod with `max: 8`, first without any timeouts, then with role defaults and `connectionTimeoutMillis: 2_000`.
   **Expected:** without limits, every endpoint on the pod stalls for 30 s; with limits, reports fail with `503` after 2 s and other endpoints keep working. **Verify:** autocannon on a cheap endpoint while the reports run.
6. **10x pods.** Scale the lab to 40 app processes through PgBouncer with `default_pool_size` 10, 20 and 40, under a mixed read/write load.
   **Expected:** no `53300` errors at any size; throughput peaks at a small server pool and falls or plateaus beyond it. **Verify:** queries/s, p95, and `SHOW POOLS` (`cl_waiting`, `sv_active`) in PgBouncer's admin console.

---

## 📝 Quiz

1. Why is opening a new Postgres connection per request expensive?
2. What is the connection budget for a normal app role on a default Postgres with 10 connections kept for admin tools?
3. Name two code-review signs of an N+1.
4. Why can a window-function rewrite of an N+1 be slower than the N+1 itself?
5. What does DataLoader do, and why must each request get its own loader?
6. Why does a `SET statement_timeout` sent through PgBouncer in transaction mode cause trouble?
7. How do you give a single transaction a 2-second statement timeout safely behind PgBouncer?
8. Why are parameterised queries safe from SQL injection?
9. What is "read-your-writes", and one way to provide it with a replica?
10. Which loads 1,00,000 rows fastest: one `INSERT` per row in a transaction, a multi-row `INSERT`, or `COPY`? Roughly how big was the gap here?

## 🔑 Quiz answer key

1. **Postgres starts a new backend process and authenticates** (several round trips, password hashing) for each connection: 5.5 ms vs 0.08 ms pooled on localhost here, and every open connection holds a slot and memory.
2. **100 − 3 superuser-reserved − 10 admin = 87**, shared by every process of every service, including during deploys.
3. **An `await` on a query inside a loop over rows; `Promise.all(items.map(query))`;** also relation access inside loops or resolvers, and one-id functions called with many ids.
4. **It numbers every child row** of all parents before keeping the first N, so it reads far more data (here all 100,000 entries) than a `LATERAL` query that stops after 5 per wallet using the index.
5. **It collects every `.load(id)` call made in the same tick and runs one batched query**, returning results in key order. It caches by key, so a shared loader would leak data between users and serve stale results.
6. **The setting stays on that server connection**, which PgBouncer then lends to other clients: they inherit your timeout (client B saw `1s` here), and your next transaction may not have it.
7. **Inside the transaction, `SET LOCAL statement_timeout = '2s'`**, or `SELECT set_config('statement_timeout', $1, true)` to pass it as a parameter; it ends with the transaction.
8. **The SQL text and the values travel separately:** Postgres parses the SQL with placeholders first, then binds the values, so a value is never read as SQL.
9. **A user always sees their own latest write.** Route that user's reads to the primary for a short time after a write, or store the write's LSN and read from the replica only once `pg_last_wal_replay_lsn()` has reached it.
10. **`COPY`.** 2,06,201 rows/s vs 1,32,108 for multi-row and 10,790 for row-by-row in one transaction: about 19 times faster than row-by-row here, and far more with network delay.

---

## 📖 Glossary

| Term | Meaning |
|---|---|
| Admin headroom | Connections kept free for migrations, incident `psql` sessions and monitoring. |
| Backend process | The Postgres process that serves one connection. |
| Connection budget | The connections all your app processes may hold together. |
| `connectionTimeoutMillis` | How long `pg.Pool` waits for a free connection; 0 (the default) means for ever. |
| `COPY` | Bulk load or unload of rows in one statement. |
| DataLoader | Batches and caches per-key loads made in one tick into one query. |
| Extended query protocol | Parse, Bind, Execute: how parameterised queries travel. |
| Little's law | Busy connections ≈ queries per second × average query time. |
| LSN | Log sequence number: a position in the WAL. Used to tell if a replica has caught up. |
| `max_connections` | The most connections Postgres accepts (default 100). |
| `max_prepared_statements` | PgBouncer setting that enables protocol-level prepared statements in transaction mode. |
| N+1 query | One query for a list plus one per item. |
| Parameterised query | SQL with `$1` placeholders and values sent separately. |
| PgBouncer | A connection pooler that multiplexes many clients over few server connections. |
| `pg_stat_statements` | Extension that records per-statement calls and time. |
| Pool | A set of reusable open connections. |
| Query builder | Typed, SQL-shaped code that produces SQL (Kysely). |
| Read-your-writes | A guarantee that a user sees their own latest changes. |
| Read replica | A copy of the database that follows the primary through the WAL. |
| `SET LOCAL` | A setting that lasts only until the end of the current transaction. |
| Startup parameter | A setting sent when a connection opens (application name, timeouts). |
| `statement_timeout` | Server-side limit on one statement's run time (`57014`). |
| `superuser_reserved_connections` | Slots kept for superusers (default 3). |
| Transaction pooling | PgBouncer lends a server connection for one transaction at a time. |
| WAL | Write-ahead log: every change, in order; what replicas replay. |

---

## 🧾 Cheat sheet

**Diagram: the data access layer on one screen**

```mermaid
mindmap
  root((Data access layer))
    Connections
      one process each
      budget pods x pool
      deploy surge and admin headroom
    Pooling
      one pg.Pool per process
      connectionTimeoutMillis set
      PgBouncer transaction mode
      no session state behind it
    N+1
      count queries per request
      LATERAL or batched ANY
      DataLoader for resolvers
    Safety
      parameters always
      statement_timeout by role
      SET LOCAL for heavy queries
    Scale
      replicas with LSN check
      COPY for bulk
      proxy for serverless
```

**How to read this diagram.** Five branches: what a connection costs, how to share them, how to keep round trips down, how to keep the database safe, and how to scale reads and writes. Each leaf is a rule for code review.

**Rules**
1. One pool per process; never a client per request; always `release()` in `finally`.
2. (Pods during a deploy) × pool max + admin headroom ≤ `max_connections` − reserved. Do the arithmetic.
3. Small pools beat big ones; past a few connections per core, Postgres slows down.
4. Count queries per request; the same SQL repeated in one request is an N+1.
5. Fix N+1 with one `LATERAL` query, a batched `= ANY($1)`, or a per-request DataLoader.
6. Behind PgBouncer (transaction mode): no `SET`, no `LISTEN`, no session locks; timeouts on the role; `SET LOCAL` per transaction.
7. Every value is a parameter; identifiers come from allow-lists.
8. `statement_timeout` everywhere, tighter for reports, mapped to a clean error.
9. Money and just-written data read from the primary; replicas after an LSN check.
10. Bulk writes: multi-row inserts or `COPY`, in transactions.

---

## ☑️ Completion checklist

- [ ] I can explain why a connection is expensive and do the pool arithmetic for my deployment.
- [ ] Lab run on my machine: steps 1 to 5.
- [ ] Numbers filled in: queries per request before and after the N+1 fix.
- [ ] Numbers filled in: p95 before and after the N+1 fix (with network delay).
- [ ] Numbers filled in: connection errors under load with 4 × 30, then with smaller pools and with PgBouncer.
- [ ] Numbers filled in: rows per second for row-by-row, multi-row and `COPY`.
- [ ] My list endpoints have query-count tests, and my app role has time limits.
- [ ] I can give the 2-minute "database CPU at 100%" answer and the five follow-ups.
- [ ] Phase 2 gate: a test proves balances never go negative under concurrency (P2-03, P2-04), and the data access layer survives a load test without connection errors.
- [ ] Post published.

---

## 📣 Learn in public

**Post 1: 51 queries for one page**
- **Problem:** Our merchant dashboard ran [your number] queries per request; p95 was [your number] ms in staging.
- **Decision:** Counted queries per request, then replaced the loop with one `LEFT JOIN LATERAL` query that uses our covering index.
- **Result:** 1 query, p95 [your number] ms.
- **Lesson:** N+1s hide on localhost. Count queries, not milliseconds, and put the count in a test.

**Post 2: we gave the API more connections and it got slower**
- **Problem:** [pods] pods × pool [size] = [total] connections against `max_connections = 100`: `53300` errors during deploys.
- **Decision:** Did the arithmetic (budget [your number], pool [your number] per pod) and put PgBouncer in transaction mode in front.
- **Result:** zero connection errors at [your number] queries/s; Postgres stable at [your number] server connections.
- **Lesson:** Pool size × instances is a number you must write down. Bigger pools move the queue into the database.

**Post 3: COPY vs INSERT for a bank statement import**
- **Problem:** Importing [your number] rows one `INSERT` at a time took [your number] minutes.
- **Decision:** Switched to `COPY` into a staging table, then one `INSERT ... SELECT`.
- **Result:** [your number] rows/s, the import now takes [your number] seconds.
- **Lesson:** Round trips are the cost. Batch them.

**Hinglish video idea: "Database slow nahi tha, hum 51 baar pooch rahe the"**
Screen-share the dashboard with a `x-db-queries: 51` header in DevTools. Add the delay proxy and show the page crawl. Fix it with one `LATERAL` query: `x-db-queries: 1`. Then the connection-storm demo: 4 instances × 30 vs `max_connections = 100`, errors on screen, then PgBouncer, errors gone. Hook line: "Database ko dosh mat do: pehle gino kitni queries aur kitne connections."

---

## ➡️ Next cards

- **P3-03 · Load balancing and horizontal scaling:** adding pods multiplies database connections. The pool arithmetic and PgBouncer from this card decide how far you can scale out before the database becomes the limit.
- **P5-07 · Cost engineering:** N+1s, oversized pools and per-row writes burn database CPU you pay for. Right-sizing the database instance, proxies and replicas starts with the measurements in this card.

---

## 🔗 Sources and further reading

Checked on 24 Oct 2026.

- [node-postgres: Pool](https://node-postgres.com/apis/pool): options and defaults (`max`, `idleTimeoutMillis`, `connectionTimeoutMillis`, `maxLifetimeSeconds`), `pool.query` vs `pool.connect`
- [node-postgres: Queries](https://node-postgres.com/features/queries): parameterised queries and named prepared statements
- [PostgreSQL: Connection settings](https://www.postgresql.org/docs/current/runtime-config-connection.html): `max_connections`, `superuser_reserved_connections`, `reserved_connections`
- [PostgreSQL: Client connection defaults](https://www.postgresql.org/docs/current/runtime-config-client.html): `statement_timeout`, `lock_timeout`, `idle_in_transaction_session_timeout`
- [PostgreSQL: COPY](https://www.postgresql.org/docs/current/sql-copy.html) and [Populating a database](https://www.postgresql.org/docs/current/populate.html)
- [PostgreSQL: Hot standby](https://www.postgresql.org/docs/current/hot-standby.html) and [recovery control functions](https://www.postgresql.org/docs/current/functions-admin.html) (`pg_wal_replay_pause`, `pg_last_wal_replay_lsn`)
- [PostgreSQL: pg_stat_statements](https://www.postgresql.org/docs/current/pgstatstatements.html) and [pgbench](https://www.postgresql.org/docs/current/pgbench.html)
- [PgBouncer: features and pooling modes](https://www.pgbouncer.org/features.html), [configuration](https://www.pgbouncer.org/config.html), [changelog](https://www.pgbouncer.org/changelog.html) (1.26.1; `max_prepared_statements` default 200 since 1.24.0)
- [HikariCP: About Pool Sizing](https://github.com/brettwooldridge/HikariCP/wiki/About-Pool-Sizing): the "(cores × 2) + effective spindles" starting point
- [DataLoader](https://github.com/graphql/dataloader)
- [Drizzle: relational queries](https://orm.drizzle.team/docs/rqb), [Kysely](https://kysely.dev/), [Prisma ORM 7: relation queries and `relationLoadStrategy`](https://www.prisma.io/docs/orm/v7/prisma-client/queries/relation-queries)
- [pg-copy-streams](https://github.com/brianc/node-pg-copy-streams)
- [OWASP SQL Injection Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/SQL_Injection_Prevention_Cheat_Sheet.html)
