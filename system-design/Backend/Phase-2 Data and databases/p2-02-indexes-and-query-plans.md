# P2-02 · Indexes and query plans

| | |
|---|---|
| **Phase** | 2 · Data and databases |
| **Prerequisites** | P2-01 · Relational data modelling |
| **Leads to** | P2-05 · The data access layer: pooling, N+1, ORMs · P3-08 · Search basics · P4-03 · Partitioning and consistent hashing |
| **Repo path** | `system-design/phase-2/p2-02-indexes-and-query-plans.md` |

**After this card you can:**

1. Explain how a B-tree finds one row among 5 million by reading 4 pages, and why the column order of a composite index decides whether it helps.
2. Read `EXPLAIN (ANALYZE, BUFFERS)` output: estimated vs actual rows, timing, loops, buffer hits, heap fetches.
3. Choose between a composite, covering, partial, expression, BRIN, GIN or hash index for a real ledger query, and say what it costs on writes.
4. Add an index to a busy production table without blocking writes, and prove with a test that the hot queries keep using it.
5. Find the slowest queries in production with `pg_stat_statements`, and the indexes nobody uses with `pg_stat_user_indexes`.

> **About the numbers in this guide.** Everything marked **Real output** was run while writing this guide on 17 Oct 2026, on a 2-vCPU Linux sandbox with 7 GB of RAM, using **PostgreSQL 18.4** (the official build, installed from the `@embedded-postgres/linux-x64` npm package because the sandbox has no Docker) with `shared_buffers = 1GB` and default planner settings. Most of the data fit in memory, so these are **warm-cache** numbers. On a production server where the table does not fit in RAM, the slow plans get much slower; the fast plans barely change. Everything marked **Expected** was not run here.
>
> **Versions** (checked 17 Oct 2026): PostgreSQL 18.6 is the latest release (13 Aug 2026). PostgreSQL 19 is at Release Candidate 1 (15 Oct 2026), so not yet for production. pgvector 0.8.7, k6 2.3.0, node-postgres 8.23.1, Vitest 5.0.4. PostgreSQL 18 changed `EXPLAIN` output (more on that in Deep dive 6), so plans from older blog posts look slightly different.

---

## 🧭 The concept in one minute

An **index** is a separate, sorted copy of one or more columns, where each entry points to the row it came from. A **query plan** is the step-by-step recipe Postgres picks to answer a query: which table or index to read, in which order, and how to join and sort.

**One line:** an index turns "read 5 million rows to find 20" into "jump to the right page and read 20".

**Analogy.** Think of the index at the back of your NCERT textbook. To find "photosynthesis", you do not read all 300 pages. You open the index, which is sorted A to Z, find the word, and jump to page 142. A phone directory sorted by **city, then surname** works the same way: "all Sharmas in Pune" is a few pages, but "all Sharmas in India" means looking in every city's section. That second fact is the whole story of composite indexes.

**On the ledger platform.** Riya opens her app and sees her latest 20 transactions. Without the right index, Postgres reads all 5 million ledger entries to find her 86, which took **205 ms** here. With an index on `(wallet_id, created_at DESC, id DESC)`, it reads 24 pages and takes **0.17 ms**, about 1,236 times faster.

---

## 🔥 The problem it solves

Here is the ledger platform from P2-01, seeded with 5 million ledger entries, 2.5 million transfers and only the primary-key indexes. Every number was measured.

1. **The history screen reads the whole table.** "Latest 20 entries for Riya's wallet" did a parallel sequential scan of all 5,000,000 rows and threw away 4,999,914 of them: **205 ms** per call. At 100 million rows that becomes roughly **4 to 5.5 seconds, even from memory**.
2. **The payout worker does the same.** "Oldest 100 pending transfers" scanned all 2.5 million transfers to find 4,999 pending ones: **198 ms**, every few seconds, forever.
3. **A report hides in plain sight.** One daily report ran only 16 times in a 30-second load test, yet used **70%** of the database time spent by the top five queries. Nobody noticed it in the code review, because its `WHERE` clause wraps the indexed column in a function.
4. **Then someone indexes every column.** Bulk inserts became **7.4 times slower** with six indexes than with none, and each row wrote **6.4 times more WAL** (the write-ahead log, which replicas and backups must also process). Two of those indexes were never used by any query.
5. **And the fix itself can cause an outage.** A plain `CREATE INDEX` on the 5-million-row table blocked a normal `INSERT` for **3 seconds**. On a 100-million-row table that is minutes of failed payments.

This card fixes all five: the right composite index, reading plans to prove it, covering and partial indexes, measuring the write cost, and building indexes safely.

---

## 📚 Before you start

**Earlier cards used here:** P2-01 (the `ledger_entries`, `transfers` and `audit_log` tables, and the index `ledger_entries_by_wallet` that this card explains), P1-03 (cursor pagination for wallet history), P1-07 (the throwaway test database and Vitest setup), P1-08 (pino logging in the migration runner).

**Key terms**

| Term | Plain meaning |
|---|---|
| Page (block) | Postgres stores tables and indexes in 8 KB pages. It reads and caches whole pages, never single rows. |
| Heap | The table itself: rows stored in pages, roughly in insert order, not sorted. |
| ctid | A row's physical address: (page number, slot in page), for example `(60606,4)`. Index entries point to it. |
| B-tree | The default index type: a balanced tree of sorted pages. Lookups and range scans are fast. |
| Leaf page | The bottom level of a B-tree, holding the sorted keys and ctids. Leaf pages are linked left to right. |
| Composite index | An index on more than one column, sorted by the first column, then the second, and so on. |
| Selectivity | The fraction of rows a condition keeps. `wallet_id = Riya` keeps 0.002%; `direction = 'debit'` keeps 50%. |
| Planner (optimiser) | The part of Postgres that estimates the cost of possible plans and picks the cheapest. |
| Statistics | Per-column summaries in `pg_stats` (distinct values, most common values, histogram) that the planner uses for estimates. |
| `ANALYZE` | Command that samples a table and refreshes its statistics. |
| `VACUUM` | Command that cleans up dead row versions and marks pages "all visible" in the visibility map. |
| Visibility map | One bit per heap page: "every row here is visible to everyone". Index-only scans need it. |
| `EXPLAIN` | Shows the chosen plan with estimates. `EXPLAIN ANALYZE` also runs the query and shows what really happened. |
| Buffer | A page in Postgres's shared memory cache (`shared_buffers`). "Hit" means it was already there; "read" means it came from the OS or disk. |
| WAL | The write-ahead log: every change is written here first, for crash safety and replication. |
| Bloat | Space inside a table or index that holds dead or empty entries and will not shrink by itself. |

---

## 🧠 How it works

### Mental model: two structures and a chooser

1. **The heap** holds the rows, in no useful order. Reading it fully is a **sequential scan**: simple, fast per page, but it reads everything.
2. **An index** holds sorted keys and the ctid of each row. Finding a key costs a few page reads, whatever the table size. Then Postgres usually visits the heap page to get the other columns.
3. **The planner** looks at the query, the indexes that exist and the statistics, estimates the cost of each possible plan, and picks the cheapest. It does not "use an index because one exists". It uses one only when its estimate says that is cheaper.

A React comparison: the heap is an array of objects in insertion order. An index is a `Map` from a key to positions in that array, kept sorted. The planner is the code deciding whether to loop over the array or look up the `Map`, based on how many items it expects to find.

### Diagram: a real B-tree lookup (must-include)

These page numbers are real. They were read with the `pageinspect` extension from `ledger_entries_pkey` (5 million rows) while looking up `id = 4242424`.

**Diagram: B-tree lookup of one ledger entry**

```mermaid
flowchart TD
  Q["WHERE id = 4242424"]
  R["Root page 412<br/>48 downlinks"]
  I["Inner page 11566<br/>286 downlinks"]
  L["Leaf page 11634<br/>367 keys, item 119"]
  N["Next leaf page<br/>via right link"]
  H["Heap page 60606<br/>row slot 4"]
  Q -->|"1. read root"| R
  R -->|"2. pick child"| I
  I -->|"3. pick leaf"| L
  L -->|"4. ctid (60606,4)"| H
  L -.->|"range scans keep going"| N
```

**How to read this diagram.** Postgres starts at the root page and, inside each page, does a binary search to choose which child page can hold the key. Three index pages later it is at the leaf, which holds the key and its ctid `(60606,4)`. One more read fetches the row from heap page 60606. That is 4 page reads for one row out of 5 million: `EXPLAIN` reported `Buffers: shared hit=4`. For a range (all of Riya's entries in September), Postgres finds the first matching key the same way and then walks right along the leaf pages, which are linked in sorted order.

### Diagram: how a query becomes a plan

**Diagram: from SQL text to rows**

```mermaid
flowchart TD
  SQL["SQL text from the app"]
  P["Parser and rewriter"]
  PL["Planner: estimate cost<br/>of each possible plan"]
  ST[("pg_stats and pg_class<br/>row counts, histograms")]
  EX["Executor runs the<br/>cheapest plan"]
  SB[("shared_buffers<br/>8 KB pages")]
  DK[("OS cache and disk")]
  SQL --> P
  P --> PL
  ST --> PL
  PL --> EX
  EX --> SB
  SB -->|"miss"| DK
```

**How to read this diagram.** The planner never looks at the data itself. It looks at statistics, which `ANALYZE` keeps fresh, and at cost settings such as `random_page_cost`. Plain `EXPLAIN` stops after the planner and shows its estimates. `EXPLAIN ANALYZE` also runs the executor and reports what really happened, including how many pages came from `shared_buffers` (hit) and how many from the OS or disk (read). When estimates and reality differ a lot, the plan is often wrong, and the statistics are the first suspect.

---
## 🔬 Deep dive

One subsection per item on the card, in the card's order. Plans are often trimmed to the lines that matter (`I/O Timings`, `Planning:` and similar lines removed); every line that is shown is unchanged. The SQL in each one ran against the seeded tables from **Hands-on lab, step 1**: `perf.ledger_entries` (5,000,000 rows, 558 MB), `perf.transfers` (2,500,000 rows, 320 MB), `perf.merchants` (200,000 rows) and `perf.audit_log` (500,000 rows). Three wallets appear again and again:

| Wallet | Entries | Share of table | Role in the examples |
|---|---|---|---|
| Riya (`e73a25de-…`) | 86 | 0.002% | A normal user: the common case |
| Sharma Kirana, a merchant (`a95dcb8a-…`) | 25,000 | 0.5% | A busy wallet |
| Platform fee wallet (`7e75f612-…`) | 500,000 | 10% | One wallet that receives a fee from every tenth entry |

### 1. B-tree indexes: sorted pages, logarithmic lookups, range scans

**What it is.** A B-tree ("balanced tree") keeps keys sorted inside 8 KB pages. Leaf pages hold the keys and ctids. Above them, inner pages hold one "first key" per child page, and one root page sits at the top. Every leaf is at the same depth, so every lookup costs the same number of page reads.

**Why "logarithmic".** Each inner page holds hundreds of links, so each level multiplies the reach by hundreds. Real numbers from `ledger_entries_pkey` (a `bigint` key):

**Real output** (`pgstatindex` and `bt_page_stats` from the `pgstattuple` and `pageinspect` extensions)

```text
 tree_level | internal_pages | leaf_pages | avg_leaf_density
------------+----------------+------------+------------------
          2 |             49 |      13662 |            90.03

page    412  level 2  items 48
page  11566  level 1  items 286
page  11634  level 0  items 367
leaf item for 4242424 -> heap block/ctid (60606,4) | leaf item [(119, 60606, 4242424)]
```

**Minimal version:** `minimal/btree-pages.ts`. A B-tree with the same page sizes, built from plain arrays, compared with a linear scan.

```ts
// A B-tree in 30 lines: sorted keys cut into pages, plus a small index of "first key of each page" above.
// Page sizes are the real ones measured on ledger_entries_pkey: 365 keys per leaf, 286 links per inner page.
const N = 5_000_000, LEAF = 365, FANOUT = 286;
const keys = Array.from({ length: N }, (_, i) => i + 1);           // ids 1..5,000,000, already sorted

type Level = number[][];                                            // a level = list of pages; a page = sorted keys
const leaves: Level = [];
for (let i = 0; i < N; i += LEAF) leaves.push(keys.slice(i, i + LEAF));
const levels: Level[] = [leaves];
while (levels[0]!.length > 1) {                                     // build upwards until one root page is left
  const below = levels[0]!, above: Level = [];
  for (let i = 0; i < below.length; i += FANOUT) above.push(below.slice(i, i + FANOUT).map((page) => page[0]!));
  levels.unshift(above);
}

function lookup(target: number): { pagesRead: number; found: boolean } {
  let child = 0, pagesRead = 0;
  for (const [depth, level] of levels.entries()) {
    const page = level[child]!; pagesRead++;
    let lo = 0, hi = page.length - 1;                               // binary search inside one page
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (page[mid]! <= target) lo = mid; else hi = mid - 1; }
    if (depth === levels.length - 1) return { pagesRead, found: page[lo] === target };
    child = child * FANOUT + lo;                                    // follow the link down
  }
  return { pagesRead, found: false };
}

let t = performance.now(), linearChecks = 0;
for (const k of keys) { linearChecks++; if (k === 4_242_424) break; }
console.log(`linear scan:  ${linearChecks.toLocaleString("en-IN")} keys checked, ${(performance.now() - t).toFixed(2)} ms`);
t = performance.now();
const r = lookup(4_242_424);
console.log(`B-tree:       ${levels.length} levels, ${r.pagesRead} pages read, found=${r.found}, ${(performance.now() - t).toFixed(3)} ms`);
console.log(`pages per level, root first: ${levels.map((l) => l.length.toLocaleString("en-IN")).join(" -> ")}`);
```

**Real output** (`npx tsx minimal/btree-pages.ts`)

```text
linear scan:  42,42,424 keys checked, 89.97 ms
B-tree:       3 levels, 3 pages read, found=true, 0.167 ms
pages per level, root first: 1 -> 48 -> 13,699
```

**What to notice**
- The toy tree has the same shape as the real one: 1 root, 48 inner pages, about 13,700 leaves. Postgres's leaves are a little fuller, so it needs 13,662.
- The linear scan checked 42 lakh keys. The tree read 3 pages, and did about 9 comparisons inside each.
- Growth is slow. Computed from the real page sizes, a lookup reads **3 index pages at 5 million rows, 4 at 100 million and still 4 at 1 billion**, plus one heap page.

**Range scans.** Leaf pages are linked to their right neighbour. For `created_at BETWEEN a AND b` on an index whose leading columns match, Postgres descends once to the first key and then walks right until the key passes `b`. Riya's September statement read **12 pages** this way (Deep dive 3).

**Details that matter on the job**
- **Fill factor.** B-tree pages are built 90% full (the default `fillfactor`), leaving room for new keys. `avg_leaf_density = 90.03` above is exactly that.
- **Page splits.** A key that lands in a full page splits it into two half-full pages. Random keys (random UUIDs, wallet ids) split pages all over the index; increasing keys (`bigint` identity, `uuidv7()`, timestamps) only split the rightmost page. P2-01's ID benchmark showed the size effect; this card's bloat test shows it again.
- **Deduplication** (Postgres 13 and later). Many equal keys are stored once with a list of ctids. That is why an index on `direction`, with only two values, was only **33 MB** for 5 million rows.
- **Not free.** Every insert must also insert into every B-tree on the table. Deep dive 7 measures it.

**When not to use a B-tree.** Very small tables (Deep dive 5 shows why), columns you never filter or sort on, and columns where another index type fits better: containment in JSONB (GIN), huge append-only time series (BRIN), or vectors (HNSW).

### 2. Scan types: sequential, index, index-only and bitmap heap scans

**What they are.**

| Scan | What Postgres does | When the planner picks it | Seen in this guide |
|---|---|---|---|
| Seq Scan | Reads every heap page in order, checks every row | No usable index, a small table, or a large share of rows | No index on `wallet_id` (Step 1); `direction = 'debit'` (50% of rows) |
| Index Scan | Walks the index in order, visits the heap for each match | Few rows, or `ORDER BY ... LIMIT` that the index order already satisfies | Riya's latest 20 with the composite index |
| Index Only Scan | Reads only the index; skips the heap when the visibility map says "all visible" | Every column the query needs is in the index, and the table is vacuumed | The covering index after `VACUUM` |
| Bitmap Heap Scan | First collects all matching ctids from the index into a bitmap, sorts them by page, then reads each heap page once | A medium number of rows spread over many pages; combining two indexes (`BitmapAnd`, `BitmapOr`); BRIN and GIN | The merchant's September statement; BRIN; GIN |

The word "Backward" (`Index Scan Backward`) only means the index is read from the other end. One index on `(wallet_id, created_at DESC, id DESC)` serves both newest-first and oldest-first.

**Diagram: a rule of thumb for which scan you will see**

```mermaid
flowchart TD
  A{"An index matches the<br/>WHERE or ORDER BY?"}
  B{"Share of rows<br/>expected back?"}
  C{"All columns needed<br/>are in the index?"}
  D{"Heap pages marked<br/>all-visible?"}
  SEQ["Seq Scan"]
  BMP["Bitmap Heap Scan"]
  IDX["Index Scan"]
  IOS["Index Only Scan"]
  A -->|"no"| SEQ
  A -->|"yes"| B
  B -->|"large"| SEQ
  B -->|"medium, scattered"| BMP
  B -->|"small, or LIMIT in index order"| C
  C -->|"no"| IDX
  C -->|"yes"| D
  D -->|"mostly"| IOS
  D -->|"no"| IDX
```

**How to read this diagram.** Start at the top and follow your query's answers. This is a rule of thumb, not the planner's real logic: the planner computes a cost for every option and picks the lowest. The boundaries ("large", "medium") move with table size, row width, cache settings and statistics.

**The same query shape, three wallets.** `SELECT transfer_id, amount_minor FROM ledger_entries WHERE wallet_id = $1`, with the covering index from step 3 present (it does not contain `transfer_id`).

**Real output** (first plan line and execution time)

```text
riya       Bitmap Heap Scan ... (actual ... rows=86.00 loops=1)       Execution Time:   1.130 ms
merchant   Bitmap Heap Scan ... (actual ... rows=28000.00 loops=1)    Execution Time:  72.223 ms
fee wallet Bitmap Heap Scan ... (actual ... rows=500000.00 loops=1)   Execution Time: 498.794 ms
fee wallet, bitmap and seq scans disabled:  Index Scan ...            Execution Time: 349.384 ms
fee wallet, random_page_cost = 1.1:         Index Scan ...            Execution Time: 287.449 ms
```

**What to notice**
- With no `ORDER BY` and no `LIMIT`, the planner preferred a bitmap scan even for Riya's 86 rows: it reads each heap page once, in page order.
- For the fee wallet (10% of the table) a forced index scan was **faster** than the planner's choice. The planner assumes a random page read costs 4 times a sequential one (`random_page_cost = 4`), which is pessimistic when everything is in memory. With 1.1, it picked the index scan by itself.
- That is a real lever, but a global one. Change `random_page_cost` only after measuring your own workload; never with `SET enable_seqscan = off` in application code.

### 3. Composite indexes: column order and the leftmost-prefix rule

**What it is.** An index on `(a, b, c)` is sorted by `a`, then by `b` inside each `a`, then by `c`. That is the phone directory sorted by city, then surname, then first name.

**The rule** (from the PostgreSQL docs): equality conditions on the leading columns, plus a range on the first column without an equality, limit the part of the index that is read. Conditions on columns further right are still checked inside the index, but they do not shrink the part that is scanned.

**So the column order is:**
1. **Columns compared with `=`** first, most selective first when in doubt (`wallet_id`).
2. **Then the column you range over or sort by** (`created_at`), in the direction you sort.
3. **Then a tie-breaker** for stable ordering and cursors (`id`).

**Leftmost prefix.** `(wallet_id, created_at, id)` also serves queries on `wallet_id` alone and on `(wallet_id, created_at)`. It does not help a query on `created_at` alone very much, because the times are scattered across every wallet's section.

**Why the order matters, physically.** This is what the two orders look like in the leaf pages (illustration with made-up times):

```text
Index (wallet_id, created_at DESC, id DESC)     Index (created_at, wallet_id)
-------------------------------------------     ---------------------------------------------
...                                             2025-10-17 05:30:06  wallet 1937
w_rahul  2026-10-15 22:01  #4999873             2025-10-17 05:30:12  wallet 4402
w_riya   2026-10-16 09:12  #4999981  <- start   2025-10-17 05:30:18  w_riya     <- one of Riya's 86
w_riya   2026-10-14 18:40  #4991620  |          ...                             (scattered over
w_riya   2026-10-11 07:03  #4973105  | 20 rows  2026-10-16 09:12:00  w_riya        all 5,000,000
...                                  v          2026-10-16 09:12:06  wallet 288    entries)
w_rohan  2026-10-16 11:47  #4999990             ...
```

On the left, Riya's entries sit next to each other, newest first: Postgres reads 20 and stops. On the right, it must walk backwards through **every wallet's entries** by time, checking `wallet_id` on each, until it has found 20 of Riya's.

**Real output: the right order.** Index `(wallet_id, created_at DESC, id DESC)`, 237 MB, built in 9.3 s.

```text
Limit  (cost=0.56..81.68 rows=20 width=30) (actual time=0.072..0.230 rows=20.00 loops=1)
  Buffers: shared hit=20 read=4
  ->  Index Scan using ledger_entries_by_wallet on ledger_entries  (cost=0.56..418.33 rows=103 width=30) (actual time=0.070..0.226 rows=20.00 loops=1)
        Index Cond: (wallet_id = 'e73a25de-e42b-6ad6-b150-4c76d3a969c5'::uuid)
        Index Searches: 1
        Buffers: shared hit=20 read=4
Planning Time: 0.499 ms
Execution Time: 0.252 ms
```

**Real output: the wrong order.** Index `(created_at, wallet_id)`, 193 MB.

```text
Limit  (cost=1326.30..27586.99 rows=20 width=30) (actual time=68.783..68.788 rows=20.00 loops=1)
  Buffers: shared hit=33 read=6942
  ->  Incremental Sort  (cost=1326.30..136568.85 rows=103 width=30) (actual time=68.780..68.783 rows=20.00 loops=1)
        Sort Key: created_at DESC, id DESC
        Presorted Key: created_at
        ->  Index Scan Backward using ledger_entries_by_time_wallet on ledger_entries  (cost=0.43..136564.22 rows=103 width=30) (actual time=2.063..68.693 rows=21.00 loops=1)
              Index Cond: (wallet_id = 'e73a25de-e42b-6ad6-b150-4c76d3a969c5'::uuid)
              Index Searches: 1
              Buffers: shared hit=24 read=6942
Execution Time: 68.882 ms
```

**And the worst case for the wrong order:** a dormant wallet with no entries at all. Nothing ever matches, so the scan only stops at the far end of the index.

```text
wrong order:  Index Scan Backward using ledger_entries_by_time_wallet ... (actual time=337.437..337.437 rows=0.00 loops=1)
                Buffers: shared hit=3 read=24633                                   Execution Time: 337.506 ms
right order:  Index Scan using ledger_entries_by_wallet ... (actual time=0.082..0.082 rows=0.00 loops=1)
                Buffers: shared read=4                                             Execution Time:   0.104 ms
```

**What to notice**
- Both plans say `Index Cond: (wallet_id = ...)`. That line alone does not prove the index is used well. **Buffers** tell the truth: 24 pages against 6,975, and 4 pages against 24,636 for the dormant wallet.
- The wrong order needs an extra `Incremental Sort`, because `id` is not in that index. The scan returned 21 rows: the sort reads one extra row to be sure the last group of equal timestamps is complete.
- The wrong order was still faster than no index (31 ms against 205 ms, pgbench averages), which makes it dangerous: it looks like it "works" in a quick test.

**PostgreSQL 18: skip scan softens the leftmost-prefix rule.** If the leading column has **few distinct values**, Postgres 18 can jump through the index once per value. With an index on `transfers (status, created_at)` (4 statuses), a query with **no** `status` condition still used it:

**Real output**

```text
Aggregate  (cost=296.36..296.37 rows=1 width=8) (actual time=1.493..1.494 rows=1.00 loops=1)
  ->  Index Only Scan using transfers_by_status_time on transfers  (cost=0.43..279.23 rows=6853 width=0) (actual time=0.129..1.135 rows=6850.00 loops=1)
        Index Cond: ((created_at >= '2026-09-30 18:30:00+00'::timestamp with time zone) AND (created_at < '2026-10-01 18:30:00+00'::timestamp with time zone))
        Heap Fetches: 0
        Index Searches: 9
Execution Time: 1.535 ms
```

`Index Searches: 9` is the skip scan: several small descents instead of one long walk. It does **not** rescue `(created_at, wallet_id)`, because `created_at` has about 5 million distinct values. Design the column order for your queries; treat skip scan as a bonus.

**When not to add a composite index.** When a single-column index already narrows the result to a handful of rows; when the extra columns are never filtered or sorted on; and beyond three or four key columns, which the docs call "unlikely to be helpful unless the usage of the table is extremely stylized".

### 4. Special indexes: covering (INCLUDE), partial and expression

#### Covering indexes: `INCLUDE`

**What it is.** `INCLUDE` adds extra, non-key columns to the leaf entries. They cannot be searched or sorted on, but a query that needs only key and included columns can be answered from the index alone: an **Index Only Scan**.

```sql
CREATE INDEX ledger_entries_by_wallet_covering
  ON ledger_entries (wallet_id, created_at DESC, id DESC) INCLUDE (direction, amount_minor);
```

The card asks for `INCLUDE (amount)`. The ledger stores a positive `amount_minor` plus a `direction`, and both statement and balance queries need the sign, so both columns are included.

**The visibility-map catch.** Index entries do not know whether their row is visible to your transaction. So an index-only scan checks the visibility map: if the heap page is marked all-visible, it skips the heap; if not, it fetches the row anyway (`Heap Fetches`). Only `VACUUM` sets those bits.

**Real output: the merchant's September statement** (2,055 rows), in four states.

```text
1. Plain index (no INCLUDE):            Bitmap Heap Scan ... Heap Blocks: exact=2055     Execution Time: 6.109 ms
2. Covering index, table never vacuumed (relallvisible = 0 of 71,429 pages):
   the planner still chose:             Bitmap Heap Scan ... Heap Blocks: exact=2055     Execution Time: 6.541 ms
   forcing it (enable_bitmapscan off):  Index Only Scan Backward ... Heap Fetches: 2055  Buffers: shared hit=2076
3. After VACUUM (relallvisible = 71,429 of 71,429):
   Index Only Scan Backward using ledger_entries_by_wallet_covering on ledger_entries  (cost=0.56..126.69 rows=2228 width=30) (actual time=0.105..0.429 rows=2055.00 loops=1)
     Heap Fetches: 0
     Index Searches: 1
     Buffers: shared hit=23
   Execution Time: 0.544 ms
4. 3,000 new merchant entries inserted (October):  Heap Fetches: 3000
   ... after another VACUUM:                         Heap Fetches: 0
```

**What to notice**
- Before `VACUUM`, the planner knew the visibility map was empty (`pg_class.relallvisible = 0`), so it did not even try an index-only scan.
- After `VACUUM`: **23 buffers instead of 2,076**. Summing 23,905 of the merchant's entries for a balance check went from **43.2 ms to 3.9 ms** (pgbench averages).
- New rows land on pages that `VACUUM` has not seen yet, and new rows are exactly what users look at. Autovacuum handles this on insert-heavy tables (it vacuums after `autovacuum_vacuum_insert_threshold` = 1,000 rows plus 20% of the table, by default), but on very big tables 20% is a lot of rows: lower the scale factor for that table.
- The price: **322 MB instead of 237 MB** (+36%). Include only narrow columns that hot queries read. Never include a wide `note` or JSON column.

#### Partial indexes: `WHERE status = 'pending'`

**What it is.** An index over only the rows that match a condition. The payout worker asks "oldest 100 pending transfers" every few seconds, and only 4,999 of 2,500,000 transfers are pending.

**Real output** (pgbench averages for the worker's query; sizes from `pg_relation_size`)

| Index | Size | Plan | Latency |
|---|---|---|---|
| None | 0 | Seq Scan over 2.5 million rows | 197.7 ms |
| `(status)` | 17 MB | Bitmap scan of 4,999 rows, then a top-N sort | 2.04 ms |
| `(status, created_at)` | 97 MB | Index Scan, stops after 100 rows | 0.25 ms |
| `(created_at) WHERE status = 'pending'` | **128 kB** | Index Scan, stops after 100 rows | 0.29 ms |

The partial index is **776 times smaller** than the full composite one and just as fast. It is also cheaper to maintain: inserting a `completed` transfer never touches it.

**The catch: the query must match the condition.** The planner uses a partial index only when it can prove the query's `WHERE` implies the index's `WHERE`. `status = 'pending'` written as a literal works. `status = $1` in a generic prepared plan, or `status IN ('pending', 'failed')`, does not. A query for `completed` transfers could not use it at all:

```text
completed query cannot use the partial index:
Limit  (cost=94110.52..94122.17 rows=100 width=24) (actual time=365.654..370.319 rows=100.00 loops=1)
  Buffers: shared hit=16434 read=24607
Execution Time: 370.397 ms
```

#### Expression indexes: `lower(email)`

**What it is.** An index on the result of an expression. A query can use it only when it uses **the same expression**.

P2-01 stores `users.email` as `citext`, which compares case-insensitively by itself, so `users` does not need this. The ledger's `merchants` table, imported from a partner, keeps `contact_email` as plain text, and lookups use `lower(...)`.

**Real output**

```text
no index:                               Gather ... Parallel Seq Scan               Execution Time: 35.187 ms
plain index on (contact_email):         Gather ... Parallel Seq Scan (unused)      Execution Time: 35.495 ms
index on (lower(contact_email)), 8848 kB:
Index Scan using merchants_by_lower_email on merchants  (cost=0.42..8.44 rows=1 width=23) (actual time=0.041..0.042 rows=1.00 loops=1)
  Index Cond: (lower(contact_email) = 'owner4242@example.test'::text)
Execution Time: 0.070 ms
```

**What to notice**
- An index on `contact_email` cannot answer `lower(contact_email) = ...`. The function wraps the column, so the planner sees a different expression.
- After creating an expression index, run `ANALYZE`: statistics for the expression are only collected then.
- Functions in an index must be `IMMUTABLE` (same input, same output, forever). `created_at::date` on a `timestamptz` depends on the session's time zone, so Postgres refuses it. **Real output:** `ERROR:  functions in index expression must be marked IMMUTABLE`. The fix is to query a range on the bare column (Common mistakes).

### 5. Planner statistics: selectivity, ANALYZE, and why your index gets ignored

**What it is.** The planner estimates how many rows each step returns (its **selectivity**), using statistics in `pg_stats`: the number of distinct values, the most common values with their frequencies, a histogram of the rest, and the **correlation** between the column's order and the table's physical order.

**Real output** (`pg_stats` after `ANALYZE ledger_entries`)

```text
column      n_distinct | top_freqs                  | mcv_count | correlation
wallet_id        43289 | {0.10086667,0.005433333}   |         2 | 0.012005444
created_at          -1 |                            |           |           1
```

**What to notice**
- `n_distinct = 43289` for `wallet_id`: a guess from a sample of 30,000 rows (300 × `default_statistics_target`, which is 100). The true number is 50,002. Close enough for planning.
- The two "most common values" are the fee wallet (10.1%) and the merchant (0.54%). The planner knows those two wallets are special.
- `n_distinct = -1` means "every value is different". `correlation = 1` means `created_at` grows in exactly the order rows sit on disk. That is why BRIN works so well on it (Deep dive 8).

**Stale or missing statistics give bad estimates.** The same query before and after the very first `ANALYZE`:

**Real output**

```text
before ANALYZE:  Gather Merge  (cost=91126.16..93164.32 rows=17500 width=56) (actual rows=20.00 loops=1)
after ANALYZE:   Gather Merge  (cost=98471.62..98483.62 rows=103 width=30)   (actual ... rows=20.00 loops=1)
                 (Riya really has 86 entries)
```

Before `ANALYZE`, the planner assumed a default selectivity and expected 17,500 rows for Riya. After, it expected 103. Here both led to a sequential scan, because no useful index existed, but with wrong estimates the planner can pick a nested loop that runs 10,000 times instead of 10, or the wrong index.

**Who runs ANALYZE.** Autovacuum analyses a table after `autovacuum_analyze_threshold` (50) plus `autovacuum_analyze_scale_factor` (10%) of its rows have changed. Run `ANALYZE` yourself after a big load or a big delete, and after creating an expression index.

**Why the planner sometimes ignores your index, with evidence from this guide**

| Reason | What happened here |
|---|---|
| The query returns a large share of the table | `direction = 'debit'` (50% of rows): parallel Seq Scan, the 33 MB index unused |
| The table is tiny | A 300-row table (2 pages): Seq Scan, because reading 2 pages beats an index descent |
| The column is wrapped in a function or cast | `lower(email)` against a plain index; `created_at` converted to a date: Seq Scan, 951 ms |
| The leading index column has no condition | `(created_at, wallet_id)` for one wallet: used, but read 6,975 pages |
| Statistics are missing or stale | 17,500 rows expected, 86 real |
| Cost settings do not match the hardware | `random_page_cost = 4` chose a bitmap scan; the index scan was faster in memory |
| The index cannot answer the query's form | A partial index for `pending` cannot serve `completed`; a B-tree cannot serve `LIKE '%kirana%'` |

**Optional advanced understanding.**
- **Extended statistics.** The planner assumes columns are independent. For correlated columns (`city` and `pincode`), `CREATE STATISTICS ... (dependencies, ndistinct) ON city, pincode FROM ...` teaches it otherwise.
- **Generic plans.** A prepared statement may switch to one generic plan after five executions. With skewed data (Riya against the fee wallet), one plan may not fit every parameter. `plan_cache_mode` controls this; check `EXPLAIN (GENERIC_PLAN)` when a query is fast in `psql` but slow from the app.

---
### 6. Reading plans: EXPLAIN (ANALYZE, BUFFERS)

**What it is.** `EXPLAIN` prints the plan the planner chose, with its estimates. `EXPLAIN ANALYZE` **runs the query** and adds what really happened. `BUFFERS` adds how many 8 KB pages each step touched. In PostgreSQL 18, `EXPLAIN ANALYZE` includes `BUFFERS` by default.

> **Careful:** `EXPLAIN ANALYZE` on an `INSERT`, `UPDATE` or `DELETE` really changes data. Wrap it: `BEGIN; EXPLAIN ANALYZE UPDATE ...; ROLLBACK;`

**How to read a plan.** A plan is a tree. Read it from the most indented line (the first step) outwards (the last step). Each node has two brackets:

| Part | Example | Meaning |
|---|---|---|
| `cost=a..b` | `cost=0.56..81.68` | Planner's estimate in abstract units: `a` before the first row, `b` for all rows. Compare costs only within one plan. |
| `rows=` (in `cost`) | `rows=103` | Rows the planner **expects** this node to return |
| `width=` | `width=30` | Expected average row size in bytes |
| `actual time=a..b` | `actual time=0.070..0.226` | Real milliseconds to the first row and to the last row, **per loop** |
| `rows=` (in `actual`) | `rows=20.00` | Rows really returned, **per loop**. PostgreSQL 18 shows decimals, because it is an average over loops. |
| `loops=` | `loops=20` | How many times this node ran. Total rows = rows × loops; total time ≈ time × loops. |
| `Buffers: shared hit=` | `hit=20` | Pages found in Postgres's cache |
| `Buffers: shared read=` | `read=4` | Pages fetched from the OS cache or disk (slow on a cold server) |
| `written=` | `written=664` | Pages this query had to write out, often because of hint bits on a freshly loaded table |
| `Rows Removed by Filter` | `1666638` | Rows read and thrown away. A big number here means the wrong access path. |
| `Index Searches` (PG 18) | `1` | How many times the index was descended. Skip scans and `IN` lists show more than 1. |
| `Heap Fetches` | `0` | Index-only scan: rows that still needed a heap visit |
| `Planning Time`, `Execution Time` | | Planner time, and total run time inside the server (not network) |

**Annotated EXPLAIN ANALYZE: before and after (must-include).** The question is "latest 20 entries for Riya's wallet". The `←` markers are added by hand; every other character is real output.

**Before: no index on `wallet_id`** (after `ANALYZE`)

```text
Limit  (cost=98471.62..98473.95 rows=20 width=30) (actual time=239.068..242.483 rows=20.00 loops=1)
  Buffers: shared hit=70076 read=1443 written=565                          ← 1
  I/O Timings: shared read=48.031 write=7.321
  ->  Gather Merge  (cost=98471.62..98483.62 rows=103 width=30) (actual time=239.066..242.478 rows=20.00 loops=1)
        Workers Planned: 2                                                 ← 2
        Workers Launched: 2
        Buffers: shared hit=70076 read=1443 written=565
        I/O Timings: shared read=48.031 write=7.321
        ->  Sort  (cost=97471.60..97471.70 rows=43 width=30) (actual time=234.886..234.887 rows=15.00 loops=3)   ← 3
              Sort Key: created_at DESC, id DESC
              Sort Method: quicksort  Memory: 26kB
              Buffers: shared hit=70076 read=1443 written=565
              I/O Timings: shared read=48.031 write=7.321
              Worker 0:  Sort Method: quicksort  Memory: 27kB
              Worker 1:  Sort Method: quicksort  Memory: 27kB
              ->  Parallel Seq Scan on ledger_entries  (cost=0.00..97470.45 rows=43 width=30) (actual time=31.046..234.769 rows=28.67 loops=3)   ← 4
                    Filter: (wallet_id = 'e73a25de-e42b-6ad6-b150-4c76d3a969c5'::uuid)
                    Rows Removed by Filter: 1666638                        ← 5
                    Buffers: shared hit=69986 read=1443 written=565
                    I/O Timings: shared read=48.031 write=7.321
Planning:
  Buffers: shared hit=95
Planning Time: 0.316 ms
Execution Time: 242.535 ms                                                 ← 6
```

1. **71,519 pages** (about 559 MB) were touched to return 20 rows. That is the whole table.
2. Postgres split the scan across the main process and **2 parallel workers**. That hides the cost on an idle server and multiplies CPU use on a busy one.
3. `loops=3`: the sort ran once in each of the 3 processes, about 15 rows each.
4. The scan ran in all 3 processes. `rows=28.67 loops=3` means 86 matching rows in total. The planner expected 103 in total (the `rows=43` here is its per-process share). Estimates are close, so the plan is not "wrong"; it simply has no better option.
5. Each process discarded 1,666,638 rows: **4,999,914 rows read for nothing**.
6. 242 ms inside the server. pgbench measured 205 ms on average over 5 runs.

**After: index on `(wallet_id, created_at DESC, id DESC)`**

```text
Limit  (cost=0.56..81.68 rows=20 width=30) (actual time=0.072..0.230 rows=20.00 loops=1)          ← 1
  Buffers: shared hit=20 read=4                                                                     ← 2
  I/O Timings: shared read=0.033
  ->  Index Scan using ledger_entries_by_wallet on ledger_entries  (cost=0.56..418.33 rows=103 width=30) (actual time=0.070..0.226 rows=20.00 loops=1)   ← 3
        Index Cond: (wallet_id = 'e73a25de-e42b-6ad6-b150-4c76d3a969c5'::uuid)                     ← 4
        Index Searches: 1
        Buffers: shared hit=20 read=4
        I/O Timings: shared read=0.033
Planning:
  Buffers: shared hit=131 read=1
  I/O Timings: shared read=0.025
Planning Time: 0.499 ms
Execution Time: 0.252 ms                                                                            ← 5
```

1. No `Sort` node: the index already returns rows newest first, so `Limit` stops after 20.
2. **24 pages** instead of 71,519. This is the number to watch; it does not depend on how warm the cache is.
3. Estimated 103 rows for the whole wallet, but the `Limit` stops the scan early, so the cost is only 81.68 of 418.33.
4. `Index Cond`, not `Filter`: the condition decides where in the index to start, so nothing is thrown away.
5. 0.25 ms inside the server; pgbench averaged **0.166 ms** over 200 runs. With the covering index of Deep dive 4, the same query became an `Index Only Scan` with `Heap Fetches: 0` and 6 buffers.

**Loops, from a join.** The history screen also shows each transfer's status, so it joins the 20 entries to `transfers`:

**Real output**

```text
Nested Loop  (cost=1.00..138.77 rows=20 width=39) (actual time=0.086..0.678 rows=20.00 loops=1)
  ->  Limit  (cost=0.56..81.68 rows=20 width=46) (actual time=0.039..0.229 rows=20.00 loops=1)
        Buffers: shared hit=24
        ->  Index Scan using ledger_entries_by_wallet_covering on ledger_entries  (cost=0.56..418.33 rows=103 width=46) (actual time=0.038..0.225 rows=20.00 loops=1)
              Index Cond: (wallet_id = 'e73a25de-e42b-6ad6-b150-4c76d3a969c5'::uuid)
              Index Searches: 1
              Buffers: shared hit=24
  ->  Memoize  (cost=0.44..8.46 rows=1 width=25) (actual time=0.022..0.022 rows=1.00 loops=20)
        Cache Key: ledger_entries.transfer_id
        Cache Mode: logical
        Hits: 0  Misses: 20  Evictions: 0  Overflows: 0  Memory Usage: 3kB
        Buffers: shared hit=80
        ->  Index Scan using transfers_pkey on transfers t  (cost=0.43..8.45 rows=1 width=25) (actual time=0.021..0.021 rows=1.00 loops=20)
              Index Cond: (id = ledger_entries.transfer_id)
              Index Searches: 20
              Buffers: shared hit=80
Planning Time: 0.977 ms
Execution Time: 0.715 ms
```

**What to notice**
- The inner `Index Scan` ran **20 times** (`loops=20`), once per entry. Each loop took 0.021 ms and 4 pages (80 ÷ 20): 3 index pages and 1 heap page, the same shape as the B-tree diagram.
- `Memoize` caches inner results by `transfer_id`. Here every entry had a different transfer, so `Hits: 0`.
- This index is the covering one, but the plan says `Index Scan`, not `Index Only Scan`: the query also reads `transfer_id`, which is not in the index.
- A nested loop is great for 20 outer rows and terrible for 2 million. If `loops` is huge and estimated rows were tiny, suspect statistics.

**Habits that save time**
- Look at **Buffers** and **Rows Removed by Filter** first, then at time. Time changes with cache state; page counts do not.
- Compare **estimated rows with actual rows**, node by node. A factor of 10 or more is where wrong plans come from.
- Run a query twice: the first run pays for reading pages from disk (`read=`), the second shows the cached cost (`hit=`). Production sees a mix.
- `EXPLAIN ANALYZE` adds timing overhead to every row. Use it to see *why*; use pgbench or your load test to see *how much*.
- Visual tools such as explain.dalibo.com or explain.depesz.com help with big plans. Plans contain literal values (emails, IDs), so **never paste production plans with personal data into a public website**.

### 7. Index costs: slower writes, storage, bloat, and unused indexes

**Writes.** Every `INSERT` adds an entry to every index. Every `UPDATE` that changes an indexed column, or that cannot fit the new row version on the same page, adds an entry to **every** index on the table. Every index change is also written to the WAL, which replicas and backups replay.

**Benchmark: insert throughput against index count (must-include).** A copy of `ledger_entries` pre-filled with 1,000,000 rows; one run per configuration.

| Indexes | Which ones | Single-row inserts (4 clients, 15 s, one commit each) | Bulk insert of 500,000 rows | WAL per row | Index size after |
|---|---|---|---|---|---|
| 0 | none | **5,196 /s** (avg 0.77 ms) | 1.4 s, **367,379 rows/s** | 148 B | 0 |
| 3 | primary key, covering by-wallet, unique `(transfer_id, direction)` | **4,672 /s** (90%), avg 0.86 ms | 6.6 s, **75,741 rows/s** (21%) | 685 B (×4.6) | 239 MB |
| 6 | the 3 above + `(created_at)`, `(direction)`, `(amount_minor)` | **4,320 /s** (83%), avg 0.93 ms | 10.1 s, **49,465 rows/s** (13%) | 948 B (×6.4) | 324 MB |

**How to read it.**
- **Single-row inserts** lost "only" 10% and 17%, because each insert also waits for its commit to be flushed to disk, and that flush dominates. On a busier server, or when indexes no longer fit in memory, each extra index can mean a random disk read per insert.
- **Bulk inserts** show the raw work: three indexes made loading **4.9 times slower**, six indexes **7.4 times slower**.
- **WAL grew 6.4 times.** More WAL means more disk writes, slower replicas and bigger backups.
- **The indexes were bigger than the table** (324 MB against 175 MB).

**Storage.** Every index measured in this guide:

| Index | Size | Rows |
|---|---|---|
| `ledger_entries` table itself | 558 MB | 5,000,000 |
| `ledger_entries_pkey` (`bigint id`) | 107 MB | |
| `(wallet_id, created_at DESC, id DESC)` | 237 MB | |
| same + `INCLUDE (direction, amount_minor)` | 322 MB | |
| `(created_at, wallet_id)` (the wrong order) | 193 MB | |
| `(created_at)` B-tree | 107 MB | |
| `(created_at)` BRIN | **32 kB** | |
| `(direction)` | 33 MB | |
| `(amount_minor)` | 44 MB | |
| `transfers` table | 320 MB | 2,500,000 |
| `transfers_pkey` (`uuid`) | 96 MB (75 MB after `REINDEX`) | |
| `(status)` | 17 MB | |
| `(status, created_at)` | 97 MB | |
| `(created_at) WHERE status = 'pending'` | **128 kB** | |
| hash on `id` | 64 MB | |
| `merchants (lower(contact_email))` | 8.8 MB | 200,000 |
| `audit_log` GIN on `details` (`jsonb_ops` / `jsonb_path_ops`) | 29 MB / 27 MB | 500,000 |

**Bloat.** When a row is updated, Postgres writes a new row version. If an indexed column changed, every index gets a new entry, and the old entries stay until `VACUUM` removes them. `VACUUM` makes that space reusable, but the index file **does not shrink**.

**Real output:** an index on `transfers (status, created_at)`, then 20% of transfers flipped from `completed` to `failed` and back.

```text
before:                 transfers_by_status_time  97 MB, transfers_pkey  96 MB
after two updates:      transfers_by_status_time 126 MB, transfers_pkey 117 MB
n_tup_upd | n_tup_hot_upd | n_dead_tup:  986419 | 0 | 986419
after VACUUM:           transfers_by_status_time 126 MB, transfers_pkey 117 MB   (avg_leaf_density 58.05)
after REINDEX INDEX CONCURRENTLY (4.9 s for both):
                        transfers_by_status_time  97 MB, transfers_pkey  75 MB
```

**What to notice**
- `transfers_pkey` grew 22%, although nobody changed `id`. Because `status` is indexed, none of the 986,419 updates could be a **HOT update** (heap-only tuple: a new version on the same page, with no new index entries).
- `VACUUM` did not shrink anything: the pages are now 58% full.
- `REINDEX ... CONCURRENTLY` rebuilt both without blocking writes. The primary key came back at **75 MB**, smaller than the original 96 MB: it was first built row by row in random UUID order, which leaves half-empty pages after splits.
- Indexing a column that changes often costs more than its own size: it switches off HOT updates for the whole table.

**Unused indexes.** `pg_stat_user_indexes.idx_scan` counts how many times each index was used since statistics were last reset (PostgreSQL 16 and later also record `last_idx_scan`). After a 30-second mixed workload (Deep dive 10):

**Real output**

```text
  table_name    |            index_name             | idx_scan |  size
----------------+-----------------------------------+----------+---------
 ledger_entries | ledger_entries_pkey               |        0 | 107 MB
 transfers      | transfers_pkey                    |        0 | 75 MB
 ledger_entries | ledger_entries_by_amount          |        0 | 44 MB
 ledger_entries | ledger_entries_by_direction       |        0 | 33 MB
 merchants      | merchants_pkey                    |        0 | 4408 kB
 transfers      | transfers_pending_by_time         |     6935 | 128 kB
 merchants      | merchants_by_lower_email          |    13695 | 8848 kB
 ledger_entries | ledger_entries_by_wallet_covering |   103293 | 323 MB
```

**Before you drop an index with `idx_scan = 0`, check:**
1. **It enforces nothing.** Primary keys and unique indexes protect data even if no query reads them. The lab's report script skips them.
2. **The counters cover enough time.** A month-end job or a yearly audit may use an index once a month. Check when statistics were reset (`pg_stat_database.stats_reset`).
3. **Replicas.** Counters are per server. An index used only by reports on a read replica shows 0 on the primary.
4. **Then drop it safely:** `DROP INDEX CONCURRENTLY`, so the drop itself does not block queries.

### 8. Other index types

**Index types and when to use each (must-include).** Sizes and timings are **Real output** from this guide's tables unless marked otherwise.

| Type | Good at | Not good at | Ledger example | Measured here |
|---|---|---|---|---|
| **B-tree** (default) | `=`, `<`, `>`, `BETWEEN`, `ORDER BY`, prefix `LIKE 'abc%'` (with the right operator class), uniqueness | Containment, arrays, full text, `LIKE '%abc%'` | Wallet history, primary keys, idempotency keys | 107 MB for 5M `bigint` keys; 3 index pages per lookup |
| **Hash** | `=` only, on long or random values | Ranges, sorting, uniqueness, multi-column | Lookup by a long external reference | 64 MB vs 96 MB B-tree on 2.5M UUIDs; chosen for `id = ...` |
| **GIN** (generalised inverted index) | "Which rows contain this?": JSONB `@>`, arrays, full-text `tsvector`, trigrams (`pg_trgm`) | Range queries; it is slower to update | `audit_log.details @> '{"to": "admin"}'`; transaction search (P2-08, P3-08) | 53 ms → 0.21 ms; 29 MB (`jsonb_ops`) or 27 MB (`jsonb_path_ops`) |
| **GiST** (generalised search tree) | Ranges and overlaps, geometry, nearest-neighbour, exclusion constraints | Plain equality on scalar columns | P2-01's `EXCLUDE USING gist (wallet_id WITH =, valid_during WITH &&)` on wallet limits | Used in P2-01 |
| **SP-GiST** | Space-partitioned data: IP ranges, phone-number prefixes, points | General use | Rarely needed on this platform | Not run |
| **BRIN** (block range index) | Huge tables where a column follows physical order (append-only time series) | Randomly ordered columns; single-row lookups | `ledger_entries.created_at` for daily reports | **32 kB** vs 107 MB B-tree; one day in 2.8 ms vs 2.5 ms |
| **HNSW** (pgvector) | Approximate nearest-neighbour search on embeddings, high recall, fast queries | Exact results; build time and memory | Support-agent knowledge base (P2-08, Phase 6) | Not run (**Expected** in P2-08) |
| **IVFFlat** (pgvector) | Approximate nearest neighbour with faster builds and less memory | Recall without tuning `lists`/`probes`; must be built after data exists | Same, when build time matters more | Not run |

**GIN on JSONB.** `jsonb_ops` (the default) supports key-exists operators (`?`, `?|`, `?&`) as well as `@>`. `jsonb_path_ops` supports only `@>` and JSON path matches, and is usually smaller. Here the difference was small (29 MB against 27 MB) because the documents have few keys.

```sql
CREATE INDEX audit_log_details ON audit_log USING gin (details);                  -- @>, ?, ?|, ?&
CREATE INDEX audit_log_details_path ON audit_log USING gin (details jsonb_path_ops); -- @> only, smaller
SELECT id FROM audit_log WHERE details @> '{"to": "admin"}';                        -- both can serve this
```

**BRIN for time.** BRIN stores only the minimum and maximum value for each range of 128 heap pages. It is tiny and nearly free to maintain, but it can only skip ranges, never find a single row. It works because `ledger_entries` is append-only, so `created_at` follows physical order (`correlation = 1`).

**Real output** (one IST day of entries, 13,699 rows)

```text
Aggregate  (cost=41480.12..41480.13 rows=1 width=40) (actual time=4.891..4.893 rows=1.00 loops=1)
  ->  Bitmap Heap Scan on ledger_entries  (cost=19.82..41405.07 rows=15009 width=8) (actual time=0.331..3.794 rows=13699.00 loops=1)
        Recheck Cond: ((created_at >= '2026-09-14 18:30:00+00'::timestamp with time zone) AND (created_at < '2026-09-15 18:30:00+00'::timestamp with time zone))
        Rows Removed by Index Recheck: 4221
        Heap Blocks: lossy=256
        Buffers: shared hit=265
        ->  Bitmap Index Scan on ledger_entries_by_time_brin  (cost=0.00..16.06 rows=17900 width=0) (actual time=0.117..0.118 rows=2560.00 loops=1)
              Index Searches: 1
              Buffers: shared hit=9
Execution Time: 4.989 ms
```

`Heap Blocks: lossy=256` means two block ranges of 128 pages were read whole, and 4,221 rows from neighbouring days were thrown away. That is the BRIN trade: a little extra reading for an index 3,424 times smaller. On `transfers.status`, which is not in physical order, BRIN would be useless.

**HNSW and IVFFlat (pgvector 0.8.7).** Covered properly in P2-08. The shape, for later:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
CREATE INDEX help_chunks_embedding ON help_chunks USING hnsw (embedding vector_cosine_ops);
-- Approximate: a query may miss some true nearest neighbours. Always measure recall against an exact search.
```

### 9. Production safety: CREATE INDEX CONCURRENTLY

**The problem.** A plain `CREATE INDEX` takes a `SHARE` lock on the table for the whole build. Reads continue; **every insert, update and delete waits**.

**Real output** (index on `ledger_entries (transfer_id)`, 5 million rows, one build worker; an `INSERT` started 1 s into the build; locks read 1.3 s in; two runs each)

```text
plain CREATE INDEX
  ShareLock|t|CREATE INDEX ledger_entries_by_transfer ON pe
  RowExclusiveLock|f|INSERT INTO perf.ledger_entries (tenant_id, t
  INSERT took 2,970.7 ms; index build took 4.0 s
  INSERT took 3,283.0 ms; index build took 4.3 s

CREATE INDEX CONCURRENTLY
  ShareUpdateExclusiveLock|t|CREATE INDEX CONCURRENTLY ledger_entries_by_t
  INSERT took 5.9 ms; index build took 5.5 s
  INSERT took 6.8 ms; index build took 5.5 s
```

**Diagram: what a plain index build does to a payment**

```mermaid
sequenceDiagram
  participant M as Migration
  participant DB as Postgres
  participant A as Transfer API
  M->>DB: CREATE INDEX (SHARE lock)
  A->>DB: INSERT ledger entry
  Note over A,DB: waits, RowExclusiveLock not granted
  DB-->>M: index built after 4.0 s
  DB-->>A: INSERT done after 2.97 s
  M->>DB: CREATE INDEX CONCURRENTLY
  A->>DB: INSERT ledger entry
  DB-->>A: INSERT done after 5.9 ms
  DB-->>M: index built after 5.5 s
```

**How to read this diagram.** Time runs down. With a plain build, the API's insert sits in the lock queue until the build finishes; at 100 times the rows, that is minutes, and every request behind it times out. With `CONCURRENTLY`, the build takes a weaker lock that lets writes through. The price: it scanned the table twice and took about a third longer (5.5 s against 4.0 to 4.3 s).

**What can go wrong with CONCURRENTLY.**
- **It can fail half-way**, for example on a duplicate key in a unique index, a deadlock or a cancelled statement. It then leaves an `INVALID` index that no query uses but **every write still updates**.

  **Real output**

  ```text
  ERROR:  could not create unique index "ledger_entries_transfer_once"
  DETAIL:  Key (transfer_id)=(335c07de-d83f-8e3d-7fa4-5db186a0f8b9) is duplicated.

  \d perf.ledger_entries
      "ledger_entries_transfer_once" UNIQUE, btree (transfer_id) INVALID
  ```

  Fix: `DROP INDEX CONCURRENTLY` it and try again (or `REINDEX INDEX CONCURRENTLY`). Find them with `SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid;`.
- **It cannot run inside a transaction block.** Most migration tools wrap each file in a transaction, so they need a special mode for these files (the lab's runner handles this).
- **It waits for old transactions.** Before each phase it waits for transactions that might use the table to finish. One forgotten open transaction makes it hang.
- **One per table at a time**, and not directly on a partitioned parent: build it on each partition, then attach (P4-03).
- **Set `lock_timeout`** in the migration session. Any DDL waiting for a lock blocks every query that arrives after it. Better to fail after 5 s and retry than to queue the whole app (P2-06 goes deep on this).

The same rules give `REINDEX INDEX CONCURRENTLY` (rebuild a bloated index) and `DROP INDEX CONCURRENTLY` (drop without blocking).

### 10. Finding slow queries: pg_stat_statements

**What it is.** An extension that records, for every distinct query shape, how many times it ran and how much time and I/O it used. Constants are replaced by `$1`, `$2`, so "latest entries for wallet A" and "for wallet B" count as one query.

**Setup** (needs a restart, because it uses shared memory):

```sql
-- postgresql.conf (or the -c flags in the lab's docker-compose): shared_preload_libraries = 'pg_stat_statements'
CREATE EXTENSION pg_stat_statements;          -- once per database where you want to read it
SELECT pg_stat_statements_reset();            -- start a clean measurement window
```

On managed Postgres services, it is usually a parameter-group or flag setting plus the same `CREATE EXTENSION`.

**The query to remember:**

```sql
SELECT left(regexp_replace(query, '\s+', ' ', 'g'), 60) AS query, calls,
       round(total_exec_time) AS total_ms, round(mean_exec_time::numeric, 2) AS mean_ms,
       round(100.0 * shared_blks_hit / nullif(shared_blks_hit + shared_blks_read, 0), 1) AS hit_pct
FROM pg_stat_statements
ORDER BY total_exec_time DESC
LIMIT 5;
```

**Real output** after a 30-second mixed workload (4 clients, about 4,600 queries per second; Hands-on lab, step 5):

```text
                                 query                                  | calls | total_ms | mean_ms | hit_pct
------------------------------------------------------------------------+-------+----------+---------+---------
 SELECT count(*), sum(amount_minor) FROM perf.ledger_entries WHERE (cre |    16 |    35736 | 2233.47 |    47.9
 SELECT id, created_at, direction, amount_minor FROM perf.ledger_entrie | 68830 |     7675 |    0.11 |    94.4
 SELECT id, created_at, direction, amount_minor FROM perf.ledger_entrie | 27661 |     2903 |    0.10 |    94.6
 INSERT INTO perf.ledger_entries (tenant_id, transfer_id, wallet_id, cu | 13668 |     2367 |    0.17 |    97.3
 SELECT id, source_wallet_id, amount_minor, created_at FROM perf.transf |  6935 |     2166 |    0.31 |   100.0
```

**How to read it**
- **Sort by `total_exec_time`**, not by `mean_exec_time`. Total is where the server's time goes. The daily report ran only **16 times** (0.01% of calls) but used **35.7 s**, about 70% of the time of these five queries. Its 47.9% cache-hit rate means half of its pages came from outside Postgres's cache, and reading them pushes other queries' pages out.
- The "latest entries" query ran 68,830 times at 0.11 ms. It is fine; a 10% gain there is worth less than fixing the report.
- **Then `EXPLAIN (ANALYZE, BUFFERS)` the top query** with realistic parameters, fix it, reset the statistics, and measure again.

**Around it**
- `log_min_duration_statement = '500ms'` logs every slow statement with its parameters. Good for finding *which* parameter values are slow (the fee wallet, not Riya).
- The `auto_explain` module logs the **plan** of slow statements automatically. Useful when a query is only slow sometimes.
- `track_io_timing = on` adds I/O time to plans and to `pg_stat_statements`. Its overhead depends on the machine's clock; check it with `pg_test_timing` first.
- In the app, P1-08's request IDs and P5-01's traces tell you **which endpoint** sent the slow query.

---
## ⚖️ Comparisons and trade-offs

### One composite index or two single-column indexes?

| | `(wallet_id, created_at DESC, id DESC)` | `(wallet_id)` + `(created_at)` |
|---|---|---|
| "Latest 20 for a wallet" | Reads 20 entries in order and stops | Postgres can combine them with a `BitmapAnd`, but a bitmap has no order: it must fetch every match, then sort |
| "Entries in a date range, all wallets" | Poor (leading column has no condition) | Good, with the `(created_at)` index |
| Cost on writes | One index to update | Two indexes to update |
| Use it when | The query always filters by wallet | The two conditions really are used separately |

### Plain vs covering index

| | Plain `(wallet_id, created_at DESC, id DESC)` | Covering, `+ INCLUDE (direction, amount_minor)` |
|---|---|---|
| Size here | 237 MB | 322 MB (+36%) |
| Merchant's monthly statement (2,055 rows) | 3.6 ms | 1.75 ms (after `VACUUM`) |
| Merchant's balance check (23,905 rows) | 43.2 ms | 3.9 ms |
| Depends on | Nothing | `VACUUM` keeping the visibility map up to date |
| Worth it when | The table is updated often | The table is mostly appended (a ledger), and hot queries read only these columns |

### Partial vs full index

| | Full `(status, created_at)` | Partial `(created_at) WHERE status = 'pending'` |
|---|---|---|
| Size | 97 MB | 128 kB |
| Worker query latency | 0.25 ms | 0.29 ms |
| Serves other statuses | Yes | No |
| Write cost | Every transfer insert and status change | Only rows that are, or were, pending |

### B-tree vs BRIN on `created_at`

| | B-tree | BRIN |
|---|---|---|
| Size for 5M rows | 107 MB | 32 kB |
| One day's report (13,699 rows) | 2.5 ms | 2.8 ms (reads 2 whole block ranges) |
| Single-row lookup | Yes | No |
| Needs physical order | No | Yes: works only because the table is append-only |

### Plain vs CONCURRENTLY

| | `CREATE INDEX` | `CREATE INDEX CONCURRENTLY` |
|---|---|---|
| Writes during the build | Blocked (an insert waited 2,971 ms) | Allowed (an insert took 5.9 ms) |
| Build time here | 4.0 to 4.3 s | 5.5 s |
| Inside a transaction | Yes | No |
| On failure | Rolls back cleanly | Leaves an `INVALID` index to drop |
| Use it on | Empty or new tables, maintenance windows | Any table with live traffic |

---

## 🚶 Walkthrough on the ledger platform: Riya opens her wallet history

Riya opens the app at 9 am. The numbers in this list match the diagram below.

1. **The app asks for page 1.** `GET /v1/wallets/{walletId}/transactions?limit=20`, the route from P1-03.
2. **The route validates and authorises once.** Zod checks the parameters; the service checks that Riya may read this wallet (P1-05). The tenant is checked here, not per entry.
3. **The repository sends one SQL statement.** `listLatest` runs `LATEST_ENTRIES_SQL` with `(walletId, 'infinity', 9223372036854775807, 20)`: page 1 uses the same SQL as every later page.
4. **The planner picks the covering index.** Statistics say this wallet has about 103 entries; the index order matches `ORDER BY created_at DESC, id DESC`, and every selected column is in the index.
5. **The executor reads the index only.** It descends to Riya's newest entry, reads 20 entries along the leaf, and the visibility map says the heap pages are all visible. **Real output:** `Index Only Scan`, `Heap Fetches: 0`, 6 buffers, 0.113 ms.
6. **The route builds the page.** It returns the 20 entries and `page.nextCursor` made from the last entry's `(created_at, id)`.
7. **Riya scrolls; page 2 uses the cursor.** Same SQL, same plan. **Real output:** `Index Cond: ((wallet_id = ...) AND (ROW(created_at, id) < ROW(...)))`, 6 buffers, 0.089 ms.
8. **The platform keeps it this way.** `pg_stat_statements` counts every page under one query shape, and the plan test in CI fails if a change ever stops this query from using the index.

**Diagram: one history page, end to end**

```mermaid
sequenceDiagram
  participant App as Riya's app
  participant API as Transactions route
  participant Repo as entryRepository
  participant PG as Postgres
  App->>API: 1. GET transactions, limit 20
  API->>API: 2. validate, check wallet access
  API->>Repo: 3. listLatest(walletId, 20)
  Repo->>PG: 3. LATEST_ENTRIES_SQL
  PG->>PG: 4. plan: Index Only Scan on covering index
  PG->>PG: 5. read 6 pages, 0 heap fetches
  PG-->>Repo: 20 rows
  Repo-->>API: entries
  API-->>App: 6. 20 entries + nextCursor
  App->>API: 7. GET transactions, cursor
  API->>Repo: 7. listLatest(walletId, 20, cursor)
  Repo->>PG: 7. same SQL, same plan
  Note over Repo,PG: 8. pg_stat_statements counts one query shape
```

**How to read this diagram.** Time runs down. The database work is steps 4 and 5: one planning decision and 6 page reads. Nothing in the flow depends on how many entries the table holds: at 100 million rows, step 5 reads one more inner page.

---

## 🧪 Hands-on lab

Six steps, in the card's order, on the ledger platform's tables.

### Prerequisites

- Docker, Node 22, and the ledger project from earlier cards (P1-03 routes, P1-07 test setup, P2-01 migrations up to 006).
- `psql` and `pgbench` on your machine, or run them inside the container with `docker compose exec postgres ...`.
- About 3 GB of free disk for the seeded data and indexes.

**`docker-compose.yml`**

```yaml
services:
  postgres:
    image: postgres:18                      # 18.6 on 17 Oct 2026
    environment:
      POSTGRES_PASSWORD: postgres           # lab only
    ports: ["5432:5432"]
    shm_size: 1g                            # parallel queries need more than Docker's 64 MB default
    command: >
      postgres
      -c shared_preload_libraries=pg_stat_statements
      -c track_io_timing=on
      -c shared_buffers=1GB
      -c max_wal_size=8GB
```

```bash
docker compose up -d
export PGURL=postgres://postgres:postgres@localhost:5432/postgres
```

### Step 1: Seed 5 million ledger entries and save the plan without indexes

`seed.sql` creates a `perf` schema with the same columns as P2-01's tables, without foreign keys or triggers, so it loads in about a minute. Wallet ids are `md5('w' || n)::uuid`, so you can name wallets in queries: `n = 42` is Riya, `n = 1` the busy merchant, `n = 0` the fee wallet.

```sql
-- seed.sql: 5 million ledger entries + 2.5 million transfers on the ledger platform's columns.
-- A separate "perf" schema: same columns and types as P2-01, but no foreign keys or triggers, so it loads fast.
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
CREATE EXTENSION IF NOT EXISTS pageinspect;
CREATE EXTENSION IF NOT EXISTS pgstattuple;
DROP SCHEMA IF EXISTS perf CASCADE;
CREATE SCHEMA perf;
SET search_path = perf;
\timing on

-- Wallet ids are md5-based so the lab can name them: wallet n has id md5('w' || n)::uuid.
-- n = 0 is the platform fee wallet, n = 1 a busy merchant, n = 42 Riya.
CREATE TABLE ledger_entries (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id    uuid NOT NULL,
  transfer_id  uuid NOT NULL,
  wallet_id    uuid NOT NULL,
  currency     text NOT NULL,
  direction    text NOT NULL CHECK (direction IN ('debit', 'credit')),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  created_at   timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE ledger_entries SET (autovacuum_enabled = false); -- the lab decides when VACUUM and ANALYZE run

INSERT INTO ledger_entries (tenant_id, transfer_id, wallet_id, currency, direction, amount_minor, created_at)
SELECT '0192f0c1-0000-7000-8000-00000000c0de',
       md5('t' || ((g + 1) / 2))::uuid,                         -- two entries per transfer
       md5('w' || CASE WHEN g % 10 = 0 THEN 0                  -- 10% to the platform fee wallet
                       WHEN g % 200 = 2 THEN 1                 -- 0.5% to one busy merchant
                       ELSE 2 + floor(random() * 50000)::int   -- the rest spread over 50,000 wallets
                  END)::uuid,
       'INR',
       CASE WHEN g % 2 = 1 THEN 'debit' ELSE 'credit' END,
       100 + floor(random() * 500000)::bigint,                  -- ₹1 to ₹5,000, in paise
       timestamptz '2025-10-17 00:00:00+05:30' + g * interval '6.3072 seconds'  -- one year, in id order
FROM generate_series(1, 5000000) AS g;

CREATE TABLE transfers (
  tenant_id             uuid NOT NULL,
  id                    uuid PRIMARY KEY,
  source_wallet_id      uuid NOT NULL,
  destination_wallet_id uuid NOT NULL,
  currency              text NOT NULL,
  amount_minor          bigint NOT NULL CHECK (amount_minor > 0),
  status                text NOT NULL CHECK (status IN ('pending', 'completed', 'failed', 'reversed')),
  created_at            timestamptz NOT NULL
);
ALTER TABLE transfers SET (autovacuum_enabled = false);
INSERT INTO transfers
SELECT '0192f0c1-0000-7000-8000-00000000c0de', md5('t' || g)::uuid,
       md5('w' || (2 + floor(random() * 50000)::int))::uuid, md5('w' || (2 + floor(random() * 50000)::int))::uuid,
       'INR', 100 + floor(random() * 500000)::bigint,
       CASE WHEN g > 2496000 OR g % 2500 = 7 THEN 'pending'    -- the newest 4,000 plus 1,000 stuck ones
            WHEN g % 100 = 3 THEN 'failed'
            WHEN g % 200 = 5 THEN 'reversed'
            ELSE 'completed' END,
       timestamptz '2025-10-17 00:00:00+05:30' + g * interval '12.6144 seconds'
FROM generate_series(1, 2500000) AS g;

-- Merchants keep email as plain text (imported from a partner), so lookups use lower(email).
CREATE TABLE merchants (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  display_name  text NOT NULL,
  contact_email text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
INSERT INTO merchants (display_name, contact_email)
SELECT 'Merchant ' || g, CASE WHEN g % 3 = 0 THEN 'Owner' || g || '@Example.TEST' ELSE 'owner' || g || '@example.test' END
FROM generate_series(1, 200000) AS g;

CREATE TABLE audit_log (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id   uuid NOT NULL,
  action      text NOT NULL,
  entity_type text NOT NULL,
  entity_id   uuid NOT NULL,
  details     jsonb NOT NULL DEFAULT '{}',
  occurred_at timestamptz NOT NULL
);
INSERT INTO audit_log (tenant_id, action, entity_type, entity_id, details, occurred_at)
SELECT '0192f0c1-0000-7000-8000-00000000c0de',
       CASE WHEN g % 1000 = 0 THEN 'user.role_change' WHEN g % 50 = 0 THEN 'wallet.freeze' ELSE 'transfer.create' END,
       CASE WHEN g % 1000 = 0 THEN 'user' WHEN g % 50 = 0 THEN 'wallet' ELSE 'transfer' END,
       md5('a' || g)::uuid,
       CASE WHEN g % 1000 = 0 THEN jsonb_build_object('from', 'user', 'to', CASE WHEN g % 10000 = 0 THEN 'admin' ELSE 'support' END)
            WHEN g % 50 = 0 THEN jsonb_build_object('reason', 'kyc_review', 'by', 'risk_bot')
            ELSE jsonb_build_object('amount_minor', 100 + g % 500000, 'currency', 'INR', 'channel', CASE WHEN g % 3 = 0 THEN 'upi' ELSE 'app' END) END,
       timestamptz '2025-10-17 00:00:00+05:30' + g * interval '63 seconds'
FROM generate_series(1, 500000) AS g;

VACUUM (ANALYZE) merchants, audit_log;
SELECT relname, n_live_tup, pg_size_pretty(pg_table_size(relid)) AS table_size
FROM pg_stat_user_tables WHERE schemaname = 'perf' ORDER BY relname;
```

```bash
psql "$PGURL" -f seed.sql
```

**Real output**

```text
Time: 34032.975 ms (00:34.033)     <- 5,000,000 ledger entries
Time: 26526.091 ms (00:26.526)     <- 2,500,000 transfers
    relname     | n_live_tup | table_size
----------------+------------+------------
 audit_log      |     500000 | 87 MB
 ledger_entries |    5000000 | 558 MB
 merchants      |     200000 | 17 MB
 transfers      |    2500000 | 320 MB
```

Now run the statement queries without an index and save the plans:

```bash
mkdir -p plans
RIYA=e73a25de-e42b-6ad6-b150-4c76d3a969c5        # md5('w42')
psql "$PGURL" -c "ANALYZE perf.ledger_entries"
psql "$PGURL" -c "EXPLAIN (ANALYZE, BUFFERS)
  SELECT id, created_at, direction, amount_minor FROM perf.ledger_entries
  WHERE wallet_id = '$RIYA' ORDER BY created_at DESC, id DESC LIMIT 20" > plans/1-latest-no-index.txt
psql "$PGURL" -c "EXPLAIN (ANALYZE, BUFFERS)
  SELECT id, created_at, direction, amount_minor FROM perf.ledger_entries
  WHERE wallet_id = '$RIYA' AND created_at >= '2026-09-01 00:00+05:30' AND created_at < '2026-10-01 00:00+05:30'
  ORDER BY created_at, id" > plans/1-statement-no-index.txt
```

**Latency** is best measured with pgbench, not `EXPLAIN ANALYZE` (which adds timing overhead). Put one query in a file and run it 20 times:

```bash
cat > q_latest.sql <<EOF
SELECT id, created_at, direction, amount_minor FROM perf.ledger_entries
WHERE wallet_id = '$RIYA' ORDER BY created_at DESC, id DESC LIMIT 20;
EOF
pgbench -n -c 1 -t 20 -f q_latest.sql "$PGURL" | grep "latency average"
```

**Real output:** the full annotated plan is in Deep dive 6. Latest 20: `latency average = 205.104 ms`. September statement (8 rows): `latency average = 277.368 ms`. Both plans are a `Parallel Seq Scan` with `Rows Removed by Filter: 1666638` per process.

### Step 2: The right composite index, then the wrong column order

```sql
CREATE INDEX ledger_entries_by_wallet ON perf.ledger_entries (wallet_id, created_at DESC, id DESC);
-- run both EXPLAINs and pgbench again, then:
DROP INDEX perf.ledger_entries_by_wallet;
CREATE INDEX ledger_entries_by_time_wallet ON perf.ledger_entries (created_at, wallet_id);
-- run both again; also try a wallet with no entries: md5('w99999')::uuid
DROP INDEX perf.ledger_entries_by_time_wallet;
CREATE INDEX ledger_entries_by_wallet ON perf.ledger_entries (wallet_id, created_at DESC, id DESC);
```

**Real output** (pgbench averages; build time and size)

| Index | Build | Size | Latest 20 (Riya) | September statement (Riya) | Dormant wallet (EXPLAIN) |
|---|---|---|---|---|---|
| None | | | 205.1 ms | 277.4 ms | |
| `(wallet_id, created_at DESC, id DESC)` | 9.3 s | 237 MB | **0.166 ms** | **0.152 ms** | 0.104 ms, 4 pages |
| `(created_at, wallet_id)` | 3.1 s | 193 MB | 31.2 ms | 10.0 ms | 337.5 ms, 24,636 pages |

The right order is **1,236 times** faster than no index for "latest 20", and **188 times** faster than the wrong order. The wrong order built three times faster, because `created_at` arrives already sorted, which is no comfort at query time.

### Step 3: A covering index, VACUUM and the visibility map

```sql
CREATE INDEX ledger_entries_by_wallet_covering
  ON perf.ledger_entries (wallet_id, created_at DESC, id DESC) INCLUDE (direction, amount_minor);
DROP INDEX perf.ledger_entries_by_wallet;     -- the covering index replaces it, never add both
SELECT relpages, relallvisible FROM pg_class WHERE oid = 'perf.ledger_entries'::regclass;
-- EXPLAIN (ANALYZE, BUFFERS) the merchant's September statement (wallet md5('w1')): note Heap Fetches
VACUUM perf.ledger_entries;
-- the same EXPLAIN again; then insert a few thousand entries for the merchant and EXPLAIN October
```

**Real output:** the four states are in Deep dive 4. In short: `relallvisible` went from 0 to 71,429 pages; the statement went from `Heap Fetches: 2055` (when forced) to `Heap Fetches: 0` and 23 buffers; 3,000 new rows brought back `Heap Fetches: 3000` until the next `VACUUM`.

**The product version.** In the real project, this index arrives through migrations, the repository is written for it, and a test keeps it that way.

`db/migrations/008_ledger_entries_covering.concurrent.sql`

```sql
-- db/migrations/008_ledger_entries_covering.concurrent.sql
-- Replaces P2-01's ledger_entries_by_wallet with a covering copy: same keys, plus the two columns the
-- statement and "latest entries" screens read, so both become index-only scans.
-- A failed earlier attempt leaves an INVALID index behind; drop it first so a retry starts clean.
DROP INDEX CONCURRENTLY IF EXISTS ledger_entries_by_wallet_covering;
CREATE INDEX CONCURRENTLY ledger_entries_by_wallet_covering
  ON ledger_entries (wallet_id, created_at DESC, id DESC) INCLUDE (direction, amount_minor);
-- Only after the new index is valid: the old one is now a strict prefix of it, and costs every insert.
DROP INDEX CONCURRENTLY IF EXISTS ledger_entries_by_wallet;
```

`src/db/migrate.ts`: P1-07's migration runner, extended for files that must run outside a transaction.

```ts
// Applies db/migrations/*.sql in name order, once each. Two kinds of file:
//   NNN_name.sql             -> one transaction: all or nothing
//   NNN_name.concurrent.sql  -> CREATE/DROP INDEX CONCURRENTLY, which cannot run inside a transaction
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import type { Logger } from "pino";

export async function migrate(databaseUrl: string, dir: string, log: Logger): Promise<void> {
  const client = new pg.Client({ connectionString: databaseUrl, application_name: "migrate" });
  await client.connect();
  try {
    // Wait at most 5 s for a lock. A DDL statement queued behind a long query blocks every query behind IT.
    await client.query("SET lock_timeout = '5s'");
    await client.query("SET statement_timeout = 0"); // an index build on a big table may take many minutes
    await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    const done = new Set((await client.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
    const files = (await readdir(dir)).filter((f) => f.endsWith(".sql") && !done.has(f)).sort();
    for (const file of files) {
      const started = Date.now();
      const text = await readFile(join(dir, file), "utf8");
      if (file.endsWith(".concurrent.sql")) await applyConcurrent(client, file, text);
      else await applyInTransaction(client, file, text);
      log.info({ migration: file, duration_ms: Date.now() - started }, "migration applied");
    }
  } finally {
    await client.end();
  }
}

async function applyInTransaction(client: pg.Client, file: string, text: string): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query(text);
    await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw new Error(`migration ${file} failed`, { cause: error });
  }
}

async function applyConcurrent(client: pg.Client, file: string, text: string): Promise<void> {
  // One statement per call: several statements in one query string would run as one implicit transaction.
  const statements = text.split(/;\s*$/m).map((s) => s.replace(/^\s*--.*$/gm, "").trim()).filter(Boolean);
  try {
    for (const statement of statements) await client.query(statement);
  } catch (error) {
    throw new Error(`migration ${file} failed; check for INVALID indexes before retrying`, { cause: error });
  }
  // A failed CONCURRENTLY build leaves an INVALID index that is never used but still slows every write.
  const invalid = await client.query<{ index: string }>("SELECT indexrelid::regclass::text AS index FROM pg_index WHERE NOT indisvalid");
  if (invalid.rows.length > 0) throw new Error(`invalid indexes after ${file}: ${invalid.rows.map((r) => r.index).join(", ")}`);
  await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
}
```

**What to notice**
- **`.concurrent.sql` files run one statement at a time.** Several statements in one query string would form one implicit transaction, and `CREATE INDEX CONCURRENTLY` refuses to run in one.
- **`lock_timeout = 5s`** stops a migration from waiting behind a long query while every request queues behind the migration.
- **`statement_timeout = 0`** only for this session: a real index build may run for many minutes.
- **The invalid-index check** turns a silent half-built index into a failed deploy that someone will look at.
- The file drops a leftover copy first, so a retry after a failure starts clean, and drops P2-01's old index only after the new one is valid.

**Real output** (on a small copy of the tables, run twice)

```text
{"level":30,"migration":"007_transfer_states.sql","duration_ms":19,"msg":"migration applied"}
{"level":30,"migration":"008_ledger_entries_covering.concurrent.sql","duration_ms":206,"msg":"migration applied"}
{"level":30,"migration":"009_transfers_pending.concurrent.sql","duration_ms":26,"msg":"migration applied"}
second run exit 0
```

`src/repositories/entryRepository.ts`: both hot queries, written for this one index.

```ts
// The two hot reads on ledger_entries. Both are written for ONE index (migration 008):
//   ledger_entries_by_wallet_covering (wallet_id, created_at DESC, id DESC) INCLUDE (direction, amount_minor)
// Every column they read is in that index, so on a vacuumed table they are index-only scans.
import type { Queryable } from "../db/queryable.js";

export interface LedgerEntry { id: string; createdAt: Date; direction: "debit" | "credit"; amountMinor: number }
export interface EntryCursor { createdAt: Date; id: string } // the last entry of the previous page

interface EntryRow { id: string; created_at: Date; direction: "debit" | "credit"; amount_minor: string }
const toEntry = (r: EntryRow): LedgerEntry =>
  ({ id: r.id, createdAt: r.created_at, direction: r.direction, amountMinor: Number(r.amount_minor) }); // int8 arrives as a string

// Newest first, keyset pagination: "entries before this (created_at, id)". Never OFFSET.
export const LATEST_ENTRIES_SQL = `
  SELECT id, created_at, direction, amount_minor
  FROM ledger_entries
  WHERE wallet_id = $1
    AND (created_at, id) < ($2::timestamptz, $3::bigint)
  ORDER BY created_at DESC, id DESC
  LIMIT $4`;

// One month as a half-open range on the bare column. created_at::date = ... would skip the index.
export const STATEMENT_SQL = `
  SELECT id, created_at, direction, amount_minor
  FROM ledger_entries
  WHERE wallet_id = $1 AND created_at >= $2 AND created_at < $3
  ORDER BY created_at, id`;

export function createEntryRepository(db: Queryable) {
  return {
    // The wallet's tenant was checked once by the service (P1-05). A tenant_id filter here is not
    // in the index, so it would force a heap visit for every row.
    async listLatest(walletId: string, limit: number, before?: EntryCursor): Promise<LedgerEntry[]> {
      // No cursor: start after "the end of time", so page 1 uses the same SQL, and the same plan, as page 50.
      const params = [walletId, before?.createdAt ?? "infinity", before?.id ?? "9223372036854775807", limit];
      const { rows } = await db.query<EntryRow>(LATEST_ENTRIES_SQL, params);
      return rows.map(toEntry);
    },
    async monthlyStatement(walletId: string, month: string): Promise<LedgerEntry[]> {
      const { from, to } = istMonthRange(month);
      const { rows } = await db.query<EntryRow>(STATEMENT_SQL, [walletId, from, to]);
      return rows.map(toEntry);
    },
  };
}

// "2026-09" -> [1 Sep 2026 00:00 IST, 1 Oct 2026 00:00 IST). India has no daylight saving, so +05:30 is fixed.
export function istMonthRange(month: string): { from: Date; to: Date } {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new RangeError(`month must be YYYY-MM, got ${month}`);
  const [year, mon] = month.split("-").map(Number) as [number, number];
  const next = mon === 12 ? `${year + 1}-01` : `${year}-${String(mon + 1).padStart(2, "0")}`;
  return { from: new Date(`${month}-01T00:00:00+05:30`), to: new Date(`${next}-01T00:00:00+05:30`) };
}
```

**What to notice**
- **The SQL lives in exported constants**, so the plan test checks exactly what production runs.
- **Keyset pagination with a row comparison** `(created_at, id) < ($2, $3)` became part of the `Index Cond` (Walkthrough, step 7). `OFFSET` would read and discard every earlier row (P1-03).
- **The month is a half-open range on the bare column.** No `::date`, no `date_trunc` on `created_at`.
- **No `tenant_id` filter here.** Adding one turned the plan into an `Index Scan` with `Filter: (tenant_id = ...)` and 19 buffers instead of 6, because `tenant_id` is not in the index.

`src/db/planCheck.ts`: reads a plan as JSON.

```ts
// Reads a query's plan as JSON, so tests and scripts can check which indexes it uses.
import type { Queryable } from "./queryable.js";

interface PlanNode { "Node Type": string; "Index Name"?: string; "Relation Name"?: string; Plans?: PlanNode[] }
export interface PlanSummary { nodes: string[]; indexes: string[]; seqScans: string[] }

export async function explainPlan(db: Queryable, sql: string, params: unknown[]): Promise<PlanSummary> {
  // Plain EXPLAIN plans the query with these parameter values but does not run it: cheap and safe in CI.
  const { rows } = await db.query<{ "QUERY PLAN": [{ Plan: PlanNode }] }>(`EXPLAIN (FORMAT JSON) ${sql}`, params);
  const summary: PlanSummary = { nodes: [], indexes: [], seqScans: [] };
  const walk = (node: PlanNode): void => {
    summary.nodes.push(node["Node Type"]);
    if (node["Index Name"]) summary.indexes.push(node["Index Name"]);
    if (node["Node Type"] === "Seq Scan" && node["Relation Name"]) summary.seqScans.push(node["Relation Name"]);
    node.Plans?.forEach(walk);
  };
  walk(rows[0]!["QUERY PLAN"][0].Plan);
  return summary;
}
```

`test/integration/queryPlans.test.ts`: the plan regression test.

```ts
// Plan regression tests: the hot queries must keep using the index they were designed for.
// Runs on P1-07's throwaway, fully migrated test database (DATABASE_URL is set per worker).
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { explainPlan } from "../../src/db/planCheck.js";
import { LATEST_ENTRIES_SQL, STATEMENT_SQL, istMonthRange } from "../../src/repositories/entryRepository.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const RIYA = "e73a25de-e42b-6ad6-b150-4c76d3a969c5"; // md5('w42'), one of the 2,000 seeded wallets

beforeAll(async () => {
  // Realistic volume matters: on 500 rows a Seq Scan IS the best plan, and this test would prove nothing.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica"); // test DB only: skip FK checks while bulk-seeding
    await client.query(`
      INSERT INTO ledger_entries (tenant_id, transfer_id, wallet_id, currency, direction, amount_minor, created_at)
      SELECT gen_random_uuid(), gen_random_uuid(), md5('w' || (g % 2000))::uuid, 'INR',
             CASE WHEN g % 2 = 0 THEN 'credit' ELSE 'debit' END, 100 + g % 50000,
             timestamptz '2025-10-17 00:00+05:30' + g * interval '157 seconds'
      FROM generate_series(1, 200000) AS g`);
    await client.query("COMMIT");
  } finally {
    client.release();
  }
  await pool.query("VACUUM (ANALYZE) ledger_entries"); // fresh statistics and a set visibility map, like production
}, 60_000);
afterAll(() => pool.end());

describe("ledger_entries query plans", () => {
  it("latest entries: index-only scan on the covering index, no sort, no seq scan", async () => {
    const plan = await explainPlan(pool, LATEST_ENTRIES_SQL, [RIYA, "infinity", "9223372036854775807", 20]);
    expect(plan.indexes).toEqual(["ledger_entries_by_wallet_covering"]);
    expect(plan.nodes).toContain("Index Only Scan");
    expect(plan.nodes).not.toContain("Sort");
    expect(plan.seqScans).toEqual([]);
  });

  it("monthly statement: same index, read backwards, no sort", async () => {
    const { from, to } = istMonthRange("2026-09");
    const plan = await explainPlan(pool, STATEMENT_SQL, [RIYA, from, to]);
    expect(plan.indexes).toEqual(["ledger_entries_by_wallet_covering"]);
    expect(plan.nodes).not.toContain("Sort");
  });

  it("reading a column outside the index loses the index-only scan (what this guard is for)", async () => {
    // A new screen also wants transfer_id. The query still works, but every row now needs a heap visit.
    const widened = LATEST_ENTRIES_SQL.replace("amount_minor\n", "amount_minor, transfer_id\n");
    const plan = await explainPlan(pool, widened, [RIYA, "infinity", "9223372036854775807", 20]);
    expect(plan.nodes).toContain("Index Scan");
    expect(plan.nodes).not.toContain("Index Only Scan");
  });
});
```

**Real output** (`DATABASE_URL=... npx vitest run`, against a PostgreSQL 18.4 database with the migrated tables)

```text
 ✓ test/integration/queryPlans.test.ts > ledger_entries query plans > latest entries: index-only scan on the covering index, no sort, no seq scan 6ms
 ✓ test/integration/queryPlans.test.ts > ledger_entries query plans > monthly statement: same index, read backwards, no sort 2ms
 ✓ test/integration/queryPlans.test.ts > ledger_entries query plans > reading a column outside the index loses the index-only scan (what this guard is for) 2ms
      Tests  3 passed (3)
   Duration  2.76s (tests 95%, transform 3%, import 2%)
```

**Prove it can fail.** Recreate the index without `INCLUDE` (as an AI tool "simplifying" the migration might) and run it again. **Real output:**

```text
     × latest entries: index-only scan on the covering index, no sort, no seq scan 14ms
     × monthly statement: same index, read backwards, no sort 3ms
AssertionError: expected [ 'ledger_entries_by_wallet' ] to deeply equal [ 'ledger_entries_by_wallet_covering' ]
      Tests  2 failed | 1 passed (3)
```

**What to notice**
- **The test seeds 200,000 rows** and runs `VACUUM (ANALYZE)`. On a tiny table the planner would rightly choose a sequential scan, and the test would prove nothing.
- **`SET LOCAL session_replication_role = replica`** skips foreign-key triggers while seeding. It is safe only in a throwaway test database, and only inside that transaction.
- **Plain `EXPLAIN`, not `EXPLAIN ANALYZE`.** The test checks the plan's shape; it does not need to run the query, so it is fast and stable in CI.
- **The third test documents a trade-off** rather than a bug: adding `transfer_id` still works, but costs a heap visit per row. When it fails after a change, decide on purpose: include the column, or accept the cost.

### Step 4: A partial index for pending transfers

```sql
VACUUM (ANALYZE) perf.transfers;
-- the worker's query:
EXPLAIN (ANALYZE, BUFFERS) SELECT id, source_wallet_id, amount_minor, created_at
FROM perf.transfers WHERE status = 'pending' ORDER BY created_at LIMIT 100;

CREATE INDEX transfers_by_status_time ON perf.transfers (status, created_at);                       -- full
CREATE INDEX transfers_pending_by_time ON perf.transfers (created_at) WHERE status = 'pending';     -- partial
SELECT indexrelname, pg_size_pretty(pg_relation_size(indexrelid))
FROM pg_stat_user_indexes WHERE relname = 'transfers';
```

**Real output:** full index **97 MB**, partial index **128 kB**; worker query 197.7 ms with no index, 0.25 ms with the full index, 0.29 ms with the partial one (table in Deep dive 4).

**The product version.** P2-01's `transfers.status` allowed only `completed` and `reversed`. Bank payouts (P1-07) wait for the bank, so migration 007 widens the check, and 009 adds the partial index.

`db/migrations/007_transfer_states.sql`

```sql
-- db/migrations/007_transfer_states.sql — bank payouts (P1-07) wait for the bank, so transfers gain
-- 'pending' and 'failed'. NOT VALID + VALIDATE avoids holding a strong lock while old rows are checked.
ALTER TABLE transfers DROP CONSTRAINT transfers_status_check;
ALTER TABLE transfers ADD CONSTRAINT transfers_status_check
  CHECK (status IN ('pending', 'completed', 'failed', 'reversed')) NOT VALID;
ALTER TABLE transfers VALIDATE CONSTRAINT transfers_status_check;
```

`db/migrations/009_transfers_pending.concurrent.sql`

```sql
-- db/migrations/009_transfers_pending.concurrent.sql — the payout worker polls "oldest pending first".
-- Only about 0.2% of transfers are pending, so a partial index stays tiny and is never touched by the rest.
DROP INDEX CONCURRENTLY IF EXISTS transfers_pending_by_time;
CREATE INDEX CONCURRENTLY transfers_pending_by_time ON transfers (created_at) WHERE status = 'pending';
```

**What to notice**
- `NOT VALID` then `VALIDATE CONSTRAINT`: adding the constraint is instant, and validating takes a weaker lock that does not block writes (P2-06 covers this pattern).
- The worker's SQL must say `status = 'pending'` literally, or the planner cannot prove the partial index applies.

### Step 5: pg_stat_statements under load, top five queries

The card's version drives load through the API with k6. That needs the P1-03 app running on top of the seeded data. This guide ran the same idea directly against the database with pgbench.

**Workload run here** (one file per query; weights set the mix):

```sql
-- wl/latest.sql      (weight 5000)
\set n random(2, 50001)
SELECT id, created_at, direction, amount_minor FROM perf.ledger_entries WHERE wallet_id = md5('w' || :n)::uuid ORDER BY created_at DESC, id DESC LIMIT 20;
-- wl/statement.sql   (weight 2000)
\set n random(2, 50001)
SELECT id, created_at, direction, amount_minor FROM perf.ledger_entries WHERE wallet_id = md5('w' || :n)::uuid AND created_at >= '2026-09-01 00:00+05:30' AND created_at < '2026-10-01 00:00+05:30' ORDER BY created_at, id;
-- wl/balance.sql     (weight 500)
\set n random(1, 50001)
SELECT sum(CASE WHEN direction = 'credit' THEN amount_minor ELSE -amount_minor END) FROM perf.ledger_entries WHERE wallet_id = md5('w' || :n)::uuid;
-- wl/pending.sql     (weight 500)
SELECT id, source_wallet_id, amount_minor, created_at FROM perf.transfers WHERE status = 'pending' ORDER BY created_at LIMIT 100;
-- wl/merchant.sql    (weight 1000)
\set n random(1, 200000)
SELECT id, display_name FROM perf.merchants WHERE lower(contact_email) = lower('Owner' || :n || '@example.test');
-- wl/insert.sql      (weight 1000)
\set n random(2, 50001)
INSERT INTO perf.ledger_entries (tenant_id, transfer_id, wallet_id, currency, direction, amount_minor) VALUES ('0192f0c1-0000-7000-8000-00000000c0de', gen_random_uuid(), md5('w' || :n)::uuid, 'INR', 'credit', 100 + :n);
-- wl/daily_report.sql (weight 1): the bad one
SELECT count(*), sum(amount_minor) FROM perf.ledger_entries WHERE (created_at AT TIME ZONE 'Asia/Kolkata')::date = '2026-09-15';
```

```bash
psql "$PGURL" -c "CREATE EXTENSION IF NOT EXISTS pg_stat_statements" -c "SELECT pg_stat_statements_reset()" -c "SELECT pg_stat_reset()"
pgbench -n -c 4 -j 2 -T 30 -f wl/latest.sql@5000 -f wl/statement.sql@2000 -f wl/balance.sql@500 \
  -f wl/pending.sql@500 -f wl/merchant.sql@1000 -f wl/insert.sql@1000 -f wl/daily_report.sql@1 "$PGURL"
```

**Real output** (from pgbench, per script): the daily report ran 16 times at `latency average = 2233.988 ms`; the merchant lookup ran 13,693 times at 0.337 ms; inserts 13,668 times at 2.457 ms (including the commit). The top-five table is in Deep dive 10.

**With k6 through the API (Expected).** Export 200 wallet ids your lab user may read into `load/wallets.json`, then:

```js
// load/transactions.k6.js — k6 2.x: wallet history through the API (P1-03), first page, then the next page.
import http from "k6/http";
import { check, sleep } from "k6";

export const options = {
  vus: 20,
  duration: "2m",
  thresholds: { http_req_failed: ["rate<0.01"], "http_req_duration{page:first}": ["p(95)<50"] },
};

const BASE_URL = __ENV.BASE_URL || "http://localhost:3000";
const TOKEN = __ENV.TOKEN; // a lab user's access token (P1-05): pass it with -e TOKEN=..., never commit it
const WALLETS = JSON.parse(open("./wallets.json")); // ids of seeded wallets this user may read

export default function () {
  const walletId = WALLETS[Math.floor(Math.random() * WALLETS.length)];
  const params = { headers: { Authorization: `Bearer ${TOKEN}` }, timeout: "5s" };
  const first = http.get(`${BASE_URL}/v1/wallets/${walletId}/transactions?limit=20`, { ...params, tags: { page: "first" } });
  check(first, { "first page is 200": (r) => r.status === 200 });

  const cursor = first.status === 200 ? first.json("page.nextCursor") : null;
  if (cursor) {
    const url = `${BASE_URL}/v1/wallets/${walletId}/transactions?limit=20&cursor=${encodeURIComponent(cursor)}`;
    check(http.get(url, { ...params, tags: { page: "next" } }), { "next page is 200": (r) => r.status === 200 });
  }
  sleep(0.2);
}
```

```bash
k6 run -e BASE_URL=http://localhost:3000 -e TOKEN="$LAB_TOKEN" load/transactions.k6.js
```

**Expected:** the history query at the top of `pg_stat_statements` by **calls**, with a mean under 1 ms; any report or admin query you forgot about near the top by **total time**.

**The weekly report.** `scripts/db/indexReport.ts` prints the top queries, the never-used indexes and any invalid ones.

```ts
// npx tsx scripts/db/indexReport.ts — the weekly "where does database time go?" report.
// A CLI report: stdout IS its output, so console.table is fine here (not in request code).
import pg from "pg";

const TOP_QUERIES = `
  SELECT left(regexp_replace(query, '\\s+', ' ', 'g'), 60) AS query, calls,
         round(total_exec_time)::bigint AS total_ms, round(mean_exec_time::numeric, 2) AS mean_ms,
         rows, round(100.0 * shared_blks_hit / nullif(shared_blks_hit + shared_blks_read, 0), 1) AS cache_hit_pct
  FROM pg_stat_statements
  WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
  ORDER BY total_exec_time DESC
  LIMIT $1`;

// Never-used indexes that enforce nothing. Counters are per server: check every replica before dropping.
const UNUSED_INDEXES = `
  SELECT s.schemaname || '.' || s.relname AS table_name, s.indexrelname AS index_name, s.idx_scan,
         pg_size_pretty(pg_relation_size(s.indexrelid)) AS size
  FROM pg_stat_user_indexes s
  JOIN pg_index i ON i.indexrelid = s.indexrelid
  WHERE s.idx_scan = 0
    AND NOT i.indisunique                                                  -- unique/PK indexes enforce rules
    AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = s.indexrelid)
  ORDER BY pg_relation_size(s.indexrelid) DESC`;

const INVALID_INDEXES = `SELECT indexrelid::regclass::text AS index_name FROM pg_index WHERE NOT indisvalid`;
const STATS_SINCE = `SELECT stats_reset FROM pg_stat_database WHERE datname = current_database()`;

const client = new pg.Client({ connectionString: process.env.DATABASE_URL, statement_timeout: 10_000 });
await client.connect();
try {
  const since = (await client.query<{ stats_reset: Date | null }>(STATS_SINCE)).rows[0]?.stats_reset;
  console.log(`Statistics collected since: ${since?.toISOString() ?? "server start"}`);
  console.log("\nTop 5 queries by total execution time");
  console.table((await client.query(TOP_QUERIES, [5])).rows);
  console.log("\nIndexes never used since then (candidates to drop, after checking replicas)");
  console.table((await client.query(UNUSED_INDEXES)).rows);
  const invalid = (await client.query(INVALID_INDEXES)).rows;
  console.log(invalid.length ? `\nINVALID indexes (drop and rebuild): ${JSON.stringify(invalid)}` : "\nNo INVALID indexes.");
} finally {
  await client.end();
}
```

**Real output** (table borders and headers trimmed; the top five from a first run after the workload, the unused list from a second run after dropping the step 6 benchmark table and a GIN index left over from Deep dive 8)

```text
Statistics collected since: 2026-10-17T07:53:29.553Z

Top 5 queries by total execution time
│ 0 │ 'SELECT count(*), sum(amount_minor) FROM perf.ledger_entries ' │ '16'    │ '35736' │ '2233.47' │ '16'      │ '47.9'  │
│ 1 │ 'SELECT id, created_at, direction, amount_minor FROM perf.led' │ '68830' │ '7675'  │ '0.11'    │ '1376600' │ '94.4'  │
│ 2 │ 'SELECT id, created_at, direction, amount_minor FROM perf.led' │ '27661' │ '2903'  │ '0.10'    │ '202381'  │ '94.6'  │
│ 3 │ 'INSERT INTO perf.ledger_entries (tenant_id, transfer_id, wal' │ '13668' │ '2367'  │ '0.17'    │ '13668'   │ '97.3'  │
│ 4 │ 'SELECT id, source_wallet_id, amount_minor, created_at FROM p' │ '6935'  │ '2166'  │ '0.31'    │ '693500'  │ '100.0' │

Indexes never used since then (candidates to drop, after checking replicas)
│ 0 │ 'perf.ledger_entries' │ 'ledger_entries_by_amount'    │ '0' │ '44 MB' │
│ 1 │ 'perf.ledger_entries' │ 'ledger_entries_by_direction' │ '0' │ '33 MB' │

No INVALID indexes.
```

**What to notice**
- The numbers arrive as strings (`'16'`) because node-postgres returns `bigint` and `numeric` as text (P1-07).
- The primary keys had 0 scans too, but the report skips them: they enforce uniqueness.
- The two never-used indexes cost 77 MB of storage and a write on every insert, for nothing.

### Step 6: Insert throughput with 0, 3 and 6 indexes

For each configuration: recreate `perf.bench_entries` with the same columns, copy in 1,000,000 rows, add the indexes, `VACUUM (ANALYZE)` and `CHECKPOINT`, then measure.

`insert_one.sql` (one row per transaction, like the transfer API)

```sql
\set n random(2, 50001)
INSERT INTO perf.bench_entries (tenant_id, transfer_id, wallet_id, currency, direction, amount_minor, created_at)
VALUES ('0192f0c1-0000-7000-8000-00000000c0de', gen_random_uuid(), md5('w' || :n)::uuid, 'INR', 'credit', 100 + :n, now());
```

```sql
-- the 3-index configuration
ALTER TABLE perf.bench_entries ADD PRIMARY KEY (id);
CREATE INDEX bench_by_wallet ON perf.bench_entries (wallet_id, created_at DESC, id DESC) INCLUDE (direction, amount_minor);
CREATE UNIQUE INDEX bench_transfer_direction ON perf.bench_entries (transfer_id, direction);
-- the 6-index configuration adds the "index every column" ones
CREATE INDEX bench_by_time ON perf.bench_entries (created_at);
CREATE INDEX bench_by_direction ON perf.bench_entries (direction);
CREATE INDEX bench_by_amount ON perf.bench_entries (amount_minor);
```

```bash
pgbench -n -c 4 -j 2 -T 15 -f insert_one.sql "$PGURL"           # single-row throughput
psql "$PGURL" -c "CHECKPOINT" -At -c "SELECT pg_current_wal_lsn()"   # note the WAL position
psql "$PGURL" -c "\timing on" -c "INSERT INTO perf.bench_entries (tenant_id, transfer_id, wallet_id, currency, direction, amount_minor, created_at)
  SELECT tenant_id, gen_random_uuid(), wallet_id, currency, direction, amount_minor, created_at
  FROM perf.ledger_entries WHERE id BETWEEN 1000001 AND 1500000"   # bulk: 500,000 rows
psql "$PGURL" -At -c "SELECT pg_current_wal_lsn() - '<the LSN you noted>'::pg_lsn"   # WAL bytes; divide by 500,000
```

**Real output:** the benchmark table is in Deep dive 7 (5,196 → 4,672 → 4,320 single-row inserts per second; 367,379 → 75,741 → 49,465 bulk rows per second; 148 → 685 → 948 WAL bytes per row).

---

## 💥 Break it and measure it

| # | Break this | What you should see | Result here |
|---|---|---|---|
| 1 | Filter on `(created_at AT TIME ZONE 'Asia/Kolkata')::date` instead of a range | Parallel Seq Scan of 5M rows | **Real:** 951 ms against 2.5 ms for the range |
| 2 | Use `(created_at, wallet_id)` for a wallet with no entries | The whole index is read backwards | **Real:** 337.5 ms, 24,636 pages, against 0.104 ms |
| 3 | Add a covering index but never `VACUUM` | The planner ignores index-only scans | **Real:** Bitmap Heap Scan; forced: `Heap Fetches: 2055` |
| 4 | Insert new rows after `VACUUM` | Heap fetches come back for the newest data | **Real:** `Heap Fetches: 3000` |
| 5 | Plain `CREATE INDEX` while the app writes | Inserts wait for the build | **Real:** insert waited 2,971 ms and 3,283 ms |
| 6 | `CREATE UNIQUE INDEX CONCURRENTLY` on duplicate data | Error, and an `INVALID` index left behind | **Real:** `INVALID` in `\d` |
| 7 | Index a column that is updated often | No HOT updates; every index bloats | **Real:** 0 HOT of 986,419 updates; primary key +22% |
| 8 | Query before the first `ANALYZE` | Wild row estimates | **Real:** 17,500 expected, 86 real |
| 9 | Drop `INCLUDE` from the covering index | The plan test fails in CI | **Real:** 2 of 3 tests fail |
| 10 | Seed 50 million entries (10x) and repeat steps 1 and 2 | No-index time grows about 10x; indexed time barely moves; index sizes about 10x | **Expected:** fill in |

### Measurements

One section per item in the card's Measure field. "Here" is **Real output**; the last column is for your machine.

**Query latency before and after each index** (pgbench averages unless marked EXPLAIN; warm cache)

| Query | Before | After | Index | Your machine |
|---|---|---|---|---|
| Latest 20, Riya | 205.1 ms | 0.166 ms | `(wallet_id, created_at DESC, id DESC)` | |
| Latest 20, Riya, wrong order | 205.1 ms | 31.2 ms | `(created_at, wallet_id)` | |
| September statement, Riya | 277.4 ms | 0.152 ms | composite | |
| September statement, merchant (2,055 rows) | 3.6 ms | 1.75 ms | covering, after `VACUUM` | |
| Balance check, merchant (23,905 rows) | 43.2 ms | 3.9 ms | covering, after `VACUUM` | |
| Oldest 100 pending transfers | 197.7 ms | 0.29 ms | partial | |
| Merchant by `lower(contact_email)` | 35.1 ms | 0.133 ms | expression | |
| One day's entries (range query) | 951 ms (wrapped) | 2.5 ms / 2.8 ms | B-tree / BRIN | |
| Audit rows with `details @> {"to":"admin"}` | 53.0 ms | 0.21 ms | GIN | |

**Index sizes:** the full table is in Deep dive 7. Highlights: covering 322 MB vs plain 237 MB; partial 128 kB vs full 97 MB; BRIN 32 kB vs B-tree 107 MB.

**Insert throughput against index count**

| Indexes | Single-row inserts/s | Bulk rows/s | WAL bytes per row | Your machine |
|---|---|---|---|---|
| 0 | 5,196 | 367,379 | 148 | |
| 3 | 4,672 | 75,741 | 685 | |
| 6 | 4,320 | 49,465 | 948 | |

---
## 🚫 Common mistakes and wrong mental models

### Wrong mental model: "index every column"

An index helps only the queries that can use it, and every index costs every write. Two of the six indexes in the benchmark were never used by any query, yet each insert paid for them.

**Beginner way**

```sql
-- "The table is slow, let's index everything in a WHERE somewhere."
CREATE INDEX ON ledger_entries (wallet_id);
CREATE INDEX ON ledger_entries (created_at);
CREATE INDEX ON ledger_entries (direction);
CREATE INDEX ON ledger_entries (amount_minor);
CREATE INDEX ON ledger_entries (transfer_id);
```

**Product way**

```sql
-- One index per hot access pattern, shaped like the query, built without blocking writes.
-- Q1 "latest entries" and Q2 "monthly statement": equality column, then the sort column, then a tie-breaker.
CREATE INDEX CONCURRENTLY ledger_entries_by_wallet_covering
  ON ledger_entries (wallet_id, created_at DESC, id DESC) INCLUDE (direction, amount_minor);
-- "Entries of one transfer" is already served by UNIQUE (transfer_id, direction) from P2-01.
-- Daily reports run on a read replica, or with a tiny BRIN on created_at.
```

**What breaks in the beginner way:** bulk inserts ran at 13% of the no-index speed and wrote 6.4 times more WAL. `(wallet_id)` alone still needs a sort for "latest 20". `(created_at)` alone does not help any wallet query. `(transfer_id)` duplicates an index that already exists.

### Indexing a low-selectivity column on its own

**Beginner way**

```sql
CREATE INDEX ON ledger_entries (direction);     -- 2 values: 'debit', 'credit'
CREATE INDEX ON transfers (status);             -- 99.4% of rows are 'completed'
```

**Product way**

```sql
-- If the query asks for the RARE value, index only the rare rows:
CREATE INDEX CONCURRENTLY transfers_pending_by_time ON transfers (created_at) WHERE status = 'pending';
-- If a low-selectivity column helps a real query, put it AFTER a selective column, or in INCLUDE.
```

**What breaks in the beginner way:** `direction = 'debit'` matches 50% of rows, so the planner did a sequential scan and the 33 MB index was never used. `(status)` did help `pending` (2.04 ms), but the partial index was 7 times faster still, 136 times smaller, and costs nothing when a `completed` transfer is inserted.

### Wrapping an indexed column in a function

**Beginner way**

```ts
// "All entries on 15 September" — reads naturally, and skips every index on created_at
await db.query(
  `SELECT count(*), sum(amount_minor) FROM ledger_entries
   WHERE (created_at AT TIME ZONE 'Asia/Kolkata')::date = $1`, ["2026-09-15"]);
await db.query("SELECT id FROM merchants WHERE lower(contact_email) = lower($1)", [email]); // index on contact_email
```

**Product way**

```ts
// Half-open range on the bare column; compute the IST day boundaries in code (India has no DST).
const from = new Date("2026-09-15T00:00:00+05:30");
const to = new Date("2026-09-16T00:00:00+05:30");
await db.query(
  "SELECT count(*), sum(amount_minor) FROM ledger_entries WHERE created_at >= $1 AND created_at < $2", [from, to]);
// For lower(): an index on the SAME expression, created CONCURRENTLY, then ANALYZE.
// CREATE INDEX CONCURRENTLY merchants_by_lower_email ON merchants (lower(contact_email));
await db.query("SELECT id FROM merchants WHERE lower(contact_email) = lower($1)", [email]);
```

**What breaks in the beginner way:** the date query took **951 ms** instead of 2.5 ms, and an index on `created_at::date` cannot even be created (`functions in index expression must be marked IMMUTABLE`). The email lookup took 35 ms instead of 0.13 ms. Type mismatches do the same: comparing a `text` column with a number makes Postgres cast the column.

### Running CREATE INDEX without CONCURRENTLY on a busy table

**Beginner way**

```sql
-- db/migrations/008_ledger_entries_covering.sql  (runs inside the migration transaction)
CREATE INDEX ledger_entries_by_wallet_covering ON ledger_entries (wallet_id, created_at DESC, id DESC) INCLUDE (direction, amount_minor);
```

**Product way**

```sql
-- db/migrations/008_ledger_entries_covering.concurrent.sql  (run outside a transaction, with lock_timeout)
DROP INDEX CONCURRENTLY IF EXISTS ledger_entries_by_wallet_covering;
CREATE INDEX CONCURRENTLY ledger_entries_by_wallet_covering
  ON ledger_entries (wallet_id, created_at DESC, id DESC) INCLUDE (direction, amount_minor);
```

**What breaks in the beginner way:** every transfer insert waits for the whole build. Here, 3 seconds at 5 million rows; on a production ledger with 100 million rows, minutes of failed payments.

### More wrong mental models

| Wrong model | Correction |
|---|---|
| "If an index exists, Postgres uses it." | The planner uses it only when its cost estimate is lower. Large result sets, tiny tables, functions on the column and bad statistics all make it choose something else. |
| "A sequential scan is always bad." | For 50% of a table, or a 2-page table, it is the fastest plan. Worry about seq scans that return few rows from big tables. |
| "`Index Cond` in the plan means the index is used well." | The wrong-order index showed `Index Cond: (wallet_id = ...)` and still read 6,975 pages. Check Buffers and Rows Removed. |
| "`EXPLAIN` shows how long it takes." | Plain `EXPLAIN` shows only estimates. `EXPLAIN ANALYZE` shows real numbers, adds timing overhead, and really runs writes. |
| "My query is fast on my laptop, so it is fine." | With 1,000 rows, every plan is fast. Test plans with realistic volume and statistics (the lab's plan test seeds 200,000 rows). |
| "More `INCLUDE` columns make more queries index-only." | Each one makes the index bigger and slower to search, and index-only scans need a vacuumed table. Include only what hot queries read. |
| "`idx_scan = 0`, so drop it." | Check it is not unique, not used on a replica, and not used by a monthly job. Then drop it `CONCURRENTLY`. |

---

## ✅ Production checklist

- [ ] Every hot query is listed with its access pattern, and has one index shaped for it: equality columns first, then the range or sort column, then a tie-breaker.
- [ ] `EXPLAIN (ANALYZE, BUFFERS)` was checked on **production-sized** data, with realistic parameters, including skewed ones (the busiest merchant, the fee wallet, a dormant wallet).
- [ ] Hot queries do not wrap indexed columns in functions or casts; dates are half-open ranges.
- [ ] Covering indexes include only narrow columns that hot queries read, and autovacuum keeps up on the table (check `relallvisible`, and `Heap Fetches` in plans).
- [ ] Partial indexes match the exact `WHERE` the queries use, with literal values.
- [ ] Every index migration uses `CREATE INDEX CONCURRENTLY` (or `DROP INDEX CONCURRENTLY`), outside a transaction, with `lock_timeout` set.
- [ ] After a deploy, no `INVALID` indexes exist (`SELECT ... FROM pg_index WHERE NOT indisvalid`).
- [ ] A plan regression test guards the most important queries in CI.
- [ ] `pg_stat_statements` is enabled, and someone reviews the top queries by total time regularly.
- [ ] Unused, non-unique indexes are reviewed (after checking replicas and monthly jobs) and dropped concurrently.
- [ ] Index bloat is watched on frequently updated tables; `REINDEX INDEX CONCURRENTLY` is in the runbook.
- [ ] The write cost of each new index was considered: insert rate, WAL volume, replica lag.
- [ ] `random_page_cost` and `effective_cache_size` reflect the real hardware, changed only with measurements.

---

## 🤖 Engineering with AI

**Where AI tools help**
- Turning a slow query and its `EXPLAIN (ANALYZE, BUFFERS)` output into a short explanation: which node is expensive, and why.
- Proposing an index for a given query and access pattern, with the column order reasoned out.
- Rewriting function-wrapped conditions into range conditions, and `OFFSET` pagination into keyset pagination.
- Writing the boilerplate: migration files, the plan-check helper, the `pg_stat_statements` report.

**Where AI tools commonly go wrong here**
- **Indexing every column in the `WHERE` clause**, one by one, instead of one composite index in the right order.
- **Putting the range or sort column first** in a composite index: `(created_at, wallet_id)`.
- **Plain `CREATE INDEX` in a migration**, inside the migration's transaction.
- **`WHERE DATE(created_at) = ...` or `created_at::date`** in generated SQL.
- **Judging a plan from a tiny dev database**, where a seq scan is correct, and "fixing" it with `SET enable_seqscan = off`.
- **Adding a `tenant_id` filter or an extra selected column** that silently turns an index-only scan into heap visits.
- **Suggesting to drop "unused" indexes** that are primary keys, unique constraints, or used only on a replica.
- **Recommending hash indexes or BRIN by name** without checking the operators and physical order they need.

**Review checklist for AI-written SQL and migrations**
- [ ] Every new index matches a real query, and the column order follows equality → range/sort → tie-breaker.
- [ ] No indexed column is wrapped in a function or cast in `WHERE` or `JOIN`.
- [ ] Index migrations use `CONCURRENTLY`, run outside a transaction, set `lock_timeout`, and handle a leftover `INVALID` index.
- [ ] The plan was checked with `EXPLAIN (ANALYZE, BUFFERS)` on realistic data, not just "it returned rows".
- [ ] Selected columns are still covered by the index the query relies on.
- [ ] No `enable_*` planner switches in application code.
- [ ] Any dropped index is non-unique and unused on every server.

**Prompts that work**

1. *"Here is a query, the table definition with all its indexes, the row count, and the output of `EXPLAIN (ANALYZE, BUFFERS)`. Explain which plan node costs the most and why, using the buffers and the estimated vs actual rows. Then propose at most one new index, say what it costs on writes, and say which existing index it makes redundant."*
   **Verify by:** creating the index `CONCURRENTLY` on a production-sized copy and comparing Buffers and pgbench latency before and after.
2. *"Rewrite this repository function so every condition on `created_at` is a half-open range on the bare column, and pagination is keyset on `(created_at, id)` instead of `OFFSET`. Keep the SQL in exported constants."*
   **Verify by:** the plan regression test: `Index Only Scan` (or `Index Scan`) on the expected index, and no `Sort` node.
3. *"Review this migration for operations that block writes on a large table. For each, give the non-blocking alternative and the lock it takes."*
   **Verify by:** running the migration against a seeded copy while pgbench inserts, and checking that insert latency stays flat.

---

## 🎤 Interview script

**How it comes up**
- **Database deep dives:** "Your transactions table has 100 million rows. How will 'latest 20 transactions for a user' stay fast?"
- **Debugging rounds:** "This endpoint got slow last week. Walk me through what you check."
- **Design follow-ups:** "What indexes does this schema need, and what do they cost?"

**A 2-minute spoken answer: "How will this query stay fast at 100 million rows?"**

1. **(15 s) The access pattern.** "The query is: one wallet, newest first, 20 rows, then scroll with a cursor. So it is an equality on `wallet_id`, a sort on `created_at`, and a limit."
2. **(30 s) The index and its column order.** "I'd create `(wallet_id, created_at DESC, id DESC)`. Equality column first, so all of one wallet's entries sit together; then the sort column, so they are already in order and Postgres stops after 20; then `id` as a tie-breaker for a stable cursor. The other order, `(created_at, wallet_id)`, scatters one wallet across the whole index. In my lab at 5 million rows it was 188 times slower, and 3,000 times slower for a dormant wallet."
3. **(20 s) Why it scales.** "A B-tree lookup reads one page per level. In my lab the primary key needed 3 index pages at 5 million rows; the arithmetic says 4 at 100 million and still 4 at a billion. A wider composite index may need one more level, but the cost stays almost flat. The index grows to around 6 GB, and only the recent part needs to be hot in memory."
4. **(20 s) Make it index-only.** "If the screen needs only amount and direction, I'd `INCLUDE` them so it becomes an index-only scan, as long as autovacuum keeps the visibility map current, which is easy on an append-only ledger."
5. **(20 s) The write cost.** "Each index costs every insert. In my benchmark, going from 3 to 6 indexes cut bulk insert speed by a third and grew WAL by 38%. So one index per access pattern, nothing speculative."
6. **(15 s) Shipping it.** "I'd build it with `CREATE INDEX CONCURRENTLY`, guard it with a plan test, and watch it in `pg_stat_statements`. Beyond a few hundred million rows I'd look at partitioning by month."

**Five likely follow-ups**

1. **"Why not just index `wallet_id`?"** It finds the wallet's rows, but they come out in index-entry order, not by time. For a big wallet, Postgres must fetch all its rows and sort them before applying `LIMIT 20`. With `created_at` second in the index, it reads exactly 20.
2. **"When would Postgres ignore this index?"** When it expects a large share of the table (a fee wallet with 10% of all entries, queried without `LIMIT`), when statistics are stale, when the query wraps `created_at` in a function, or when the table is tiny. I would check estimated vs actual rows in `EXPLAIN ANALYZE` first.
3. **"How do you add this index to a live 100-million-row table?"** `CREATE INDEX CONCURRENTLY`, outside a transaction, with `lock_timeout` so it cannot queue behind a long query. It takes longer and scans twice, and if it fails it leaves an `INVALID` index that I drop and rebuild. A plain `CREATE INDEX` would block every insert for the whole build.
4. **"How do you find which queries to optimise in the first place?"** `pg_stat_statements`, sorted by total execution time, not mean. In my lab a report that ran 16 times used 70% of the time of the top five. Then `EXPLAIN (ANALYZE, BUFFERS)` on that query with real parameters, fix, reset the stats, measure again.
5. **"What about date-range reports over all wallets?"** Not on this index. For an append-only table, a BRIN index on `created_at` is tiny (32 kB against 107 MB for a B-tree here) and fast enough for reports. Heavy reporting belongs on a read replica or a warehouse.

**Red flags interviewers notice**
- "Just add an index on each column."
- Putting the timestamp first in the composite index.
- Never mentioning the write cost or `CONCURRENTLY`.
- `OFFSET` pagination on a 100-million-row table.
- "The index exists, so the query uses it."
- Judging a plan by `cost=` numbers alone, or from a 1,000-row dev table.

**Mini design: wallet history at 100 million entries**

| Access pattern | Frequency | Index or approach | Notes |
|---|---|---|---|
| Latest 20 entries, then scroll | Every app open | `(wallet_id, created_at DESC, id DESC) INCLUDE (direction, amount_minor)` | Index-only, keyset cursor |
| Monthly statement for one wallet | On demand, async export (P1-03) | Same index | Half-open IST month range |
| Current balance | Every transfer | `wallet_balances` row (P2-01), not a sum over entries | The covering index makes reconciliation sums cheap |
| Pending payouts, oldest first | Every few seconds | Partial `(created_at) WHERE status = 'pending'` | Tiny, untouched by completed transfers |
| Daily totals across all wallets | Once a day | BRIN on `created_at`, on a read replica | Or a pre-aggregated table |
| Entries of one transfer | Support and audits | `UNIQUE (transfer_id, direction)` from P2-01 | Already there |

At 100 million entries (computed from this lab's sizes ×20): the table is about 10.9 GB, the covering index about 6.3 GB, the BRIN about 640 kB. Writes: at 20 lakh transfers a day (4 million entries), 3 indexes produce about 2.6 GiB of WAL a day, 6 indexes about 3.5 GiB.

---

## ❓ Questions from the card, answered

Try to answer each one yourself first, then open the answer.

<details>
<summary><b>1. Why does an index on (wallet_id, created_at) serve "latest 20 transactions for a wallet" far better than (created_at, wallet_id)?</b></summary>

Because a composite B-tree is sorted by its first column, then by the second inside it.

- **`(wallet_id, created_at)`** stores all of one wallet's entries next to each other, already ordered by time. Postgres descends once to the wallet's newest entry, reads 20 consecutive entries and stops. Real result: **24 pages, 0.166 ms** for Riya, no sort needed.
- **`(created_at, wallet_id)`** stores entries by time across all wallets. One wallet's entries are scattered through the whole index. `wallet_id` is only the second column, so it can be checked inside the index but cannot narrow the part that is read. Postgres walks backwards through every wallet's recent entries until it finds 20 of Riya's. Real result: **6,975 pages, 31 ms**, plus an extra sort for the `id` tie-breaker.
- **The worst case is a quiet wallet.** For a wallet with no entries, the wrong order read **24,636 pages (337 ms)**, the whole index; the right order read **4 pages (0.1 ms)**.
- **PostgreSQL 18's skip scan does not rescue it**, because `created_at` has millions of distinct values; skip scan helps only when the leading column has few.

The rule: equality columns first, then the range or sort column, then a tie-breaker.
</details>

<details>
<summary><b>2. When does Postgres choose a sequential scan even though an index exists?</b></summary>

When its cost estimate says the sequential scan is cheaper, or when it cannot use the index at all:

1. **The query returns a large share of the table.** Following an index means a random page read per row; reading the table in order is cheaper past some point. `direction = 'debit'` (50% of rows) got a parallel seq scan.
2. **The table is tiny.** A 2-page table is read faster in full than through an index.
3. **The index cannot match the condition:** the column is wrapped in a function or cast (`created_at::date`, `lower(email)` against a plain index), a type mismatch, `LIKE '%term%'`, a partial index whose `WHERE` the query does not imply, or a composite index whose leading column has no condition (unless skip scan applies).
4. **Statistics are wrong or missing.** Before the first `ANALYZE`, the planner expected 17,500 rows for a wallet with 86.
5. **Cost settings.** `random_page_cost = 4` assumes random reads are expensive. On fast storage with data in memory, the planner may undervalue indexes; here it picked a bitmap scan where a plain index scan took 30% less time.

Checking it: `EXPLAIN (ANALYZE, BUFFERS)`, compare estimated with actual rows, and test with `SET enable_seqscan = off` **in a session only**, to see what the index plan would cost.
</details>

<details>
<summary><b>3. What does each extra index cost on writes?</b></summary>

Every insert writes one entry into every index, and every non-HOT update adds an entry to every index. Each of those changes is also written to the WAL.

Measured here, on a table pre-filled with 1 million rows:

| Indexes | Single-row inserts/s | Bulk rows/s | WAL per row |
|---|---|---|---|
| 0 | 5,196 | 367,379 | 148 B |
| 3 | 4,672 (−10%) | 75,741 (−79%) | 685 B |
| 6 | 4,320 (−17%) | 49,465 (−87%) | 948 B |

Plus:
- **Storage:** the six indexes were 324 MB on a 175 MB table.
- **Fewer HOT updates:** an index on a frequently changed column (`status`) made all 986,419 updates non-HOT, and grew even the primary key by 22%.
- **Replicas and backups** process the extra WAL too, so replica lag grows with index count.
- **Cache pressure:** every index competes for memory with the table.

Single-row inserts lost less because each one also waits for its commit to reach disk. When indexes stop fitting in memory, each extra index can add a random disk read per insert.
</details>

<details>
<summary><b>4. How do you find the slowest queries in production?</b></summary>

1. **Enable `pg_stat_statements`** (`shared_preload_libraries`, a restart, then `CREATE EXTENSION`). It groups queries by shape and records calls, total and mean time, rows and buffer hits.
2. **Sort by `total_exec_time`**, not mean. That is where the server's time goes. In the lab, a report with 16 calls used 35.7 s, more than the 68,830 history queries combined.
3. **Look at the cache-hit percentage** too: a query with a low hit rate is pushing everyone else's pages out of memory.
4. **Find the slow parameter values** with `log_min_duration_statement`, and slow plans with `auto_explain`.
5. **`EXPLAIN (ANALYZE, BUFFERS)` the culprit** with those parameters, on production-sized data (a replica or a restored copy).
6. **Fix, reset, measure again:** `pg_stat_statements_reset()`, then compare the next day.
7. **Connect it to the app** through request IDs and traces (P1-08, P5-01), so you know which endpoint to fix.
</details>

---

## 🏋️ Exercises

**Beginner (no code)**

1. For each query, write the index you would create and why: (a) all transfers of one wallet in a date range, newest first; (b) one merchant by `lower(contact_email)`; (c) failed payouts from the last hour; (d) audit rows whose `details` contain `{"by": "risk_bot"}`.
   *Expected outcome:* (a) composite, equality then range; (b) expression; (c) partial; (d) GIN.
   *Verify by:* checking each against the index-types table and the column-order rule.
2. Draw the B-tree lookup for `id = 4242424` from memory, with the number of pages read at each level, and say how many levels 1 billion rows would need.
   *Expected outcome:* root, inner, leaf, heap; about 4 index levels at 1 billion.
   *Verify by:* the B-tree diagram and Deep dive 1's projection.

**Intermediate (extend the lab)**

1. Add `GET /v1/transfers?status=failed&since=...` for support staff. Choose the index, write the migration as a `.concurrent.sql` file, and add a plan test for it.
   *Expected outcome:* a partial index on `(created_at) WHERE status = 'failed'`, and a green plan test.
   *Verify by:* `EXPLAIN (ANALYZE, BUFFERS)` showing an index scan with few buffers.
2. Set `autovacuum_vacuum_insert_scale_factor = 0.01` on `ledger_entries` (re-enable autovacuum on it), insert 100,000 rows, and watch `Heap Fetches` on the merchant's October statement go back to 0 without a manual `VACUUM`.
   *Expected outcome:* heap fetches climb, then drop after autovacuum runs.
   *Verify by:* `last_autovacuum` in `pg_stat_user_tables`, and the plan.
3. Run the workload of step 5, fix the daily report (a range query plus a BRIN index), reset `pg_stat_statements`, and run it again.
   *Expected outcome:* the report drops out of the top five by total time.
   *Verify by:* the two `indexReport.ts` outputs side by side.

**Advanced (failure injection and 10x)**

1. **10x data:** seed 50 million entries and repeat steps 1, 2 and 6. Record table and index sizes, B-tree levels (`pgstatindex`), and the no-index vs indexed latency.
   *Expected outcome:* no-index latency grows about 10 times; indexed latency barely moves; the tree gains at most one level.
   *Verify by:* the measurements table.
2. **Lock queue:** in one session `BEGIN; SELECT * FROM perf.ledger_entries LIMIT 1;` and leave it open. In another, run `CREATE INDEX CONCURRENTLY ...` with and without `lock_timeout = '5s'`. In a third, keep inserting.
   *Expected outcome:* without a timeout, the index build waits for the open transaction indefinitely (inserts keep working); with it, the migration fails fast and can be retried.
   *Verify by:* `pg_stat_activity` (`wait_event_type`, `wait_event`) and `pg_locks`.
3. **Cold cache:** restart Postgres (and, on Linux, drop the OS page cache) and rerun the "before" and "after" queries once.
   *Expected outcome:* the no-index scan becomes much slower (`read=` instead of `hit=`); the indexed query reads a handful of pages either way.
   *Verify by:* `Buffers: shared read=` in both plans.

---

## 📝 Quiz

1. An index on `(a, b, c)` exists. Which of these conditions use it to narrow the scan: `a = 1`; `b = 2`; `a = 1 AND c = 3`; `a = 1 AND b > 2`?
2. A plan shows `Index Only Scan ... Heap Fetches: 2055` for 2,055 rows. What is the likely cause, and the fix?
3. What does `rows=28.67 loops=3` mean in a PostgreSQL 18 plan?
4. Why is `CREATE INDEX` on `created_at::date` refused when `created_at` is a `timestamptz`?
5. When is a BRIN index a good choice, and when is it useless?
6. `CREATE INDEX CONCURRENTLY` failed half-way. What is left behind, and why is it harmful?
7. Why sort `pg_stat_statements` by `total_exec_time` rather than `mean_exec_time`?
8. A partial index `WHERE status = 'pending'` exists. Why might a query with `status = $1` not use it?
9. An index has `idx_scan = 0` for a week. Give two reasons not to drop it yet.
10. Why did an index on `transfers.status` make the primary key grow during updates?

### Answer key

1. `a = 1` (leading column); `a = 1 AND c = 3` (narrows by `a`, checks `c` inside the index); `a = 1 AND b > 2` (equality on `a`, range on `b`). `b = 2` alone does not narrow a normal B-tree scan, though PostgreSQL 18 may use a skip scan if `a` has few distinct values.
2. The heap pages are not marked all-visible in the visibility map, usually because the table has not been vacuumed since the rows were written. Run `VACUUM`, or tune autovacuum for the table.
3. The node ran 3 times (the leader and 2 parallel workers) and returned 28.67 rows per run on average: 86 rows in total.
4. Index expressions must be `IMMUTABLE`. Converting a `timestamptz` to a date depends on the session's time zone setting, so the same input can give different dates.
5. Good: a huge table where the column follows the physical row order, like `created_at` on an append-only ledger. Useless: columns with no relation to physical order, such as `status` or random IDs, and single-row lookups.
6. An `INVALID` index. Queries do not use it, but every insert and update still maintains it. Drop it `CONCURRENTLY` and build again.
7. Total time is where the server's capacity goes. A query with a small mean but millions of calls, or a rare query with a huge mean, can dominate. Mean alone hides both.
8. With a generic prepared plan, the planner does not know `$1` will be `'pending'`, so it cannot prove the query matches the index's `WHERE`. Use a literal in that query.
9. Any two of: it backs a primary key or unique constraint; it is used on a read replica (counters are per server); it is used by a monthly or yearly job; statistics were reset recently.
10. Updates that change an indexed column cannot be HOT updates, so each new row version gets a new entry in every index, including the primary key, even though `id` did not change.

---

## 📖 Glossary

| Term | Meaning |
|---|---|
| Bitmap Heap Scan | Collects matching row addresses from an index into a bitmap, then reads each heap page once, in page order. |
| Bloat | Dead or empty space in a table or index that `VACUUM` makes reusable but does not return to the OS. |
| BRIN | Block range index: stores min and max per range of pages; tiny, for physically ordered columns. |
| B-tree | Balanced tree of sorted pages; the default index type. |
| Composite index | An index on several columns, sorted by the first, then the next. |
| Covering index | An index that holds every column a query needs, often through `INCLUDE`, enabling an index-only scan. |
| ctid | A row's physical address: (page, slot). |
| Expression index | An index on the result of an expression, such as `lower(contact_email)`. |
| GIN | Generalised inverted index: maps each element (JSON key-value, word, trigram) to the rows containing it. |
| GiST | Generalised search tree: for ranges, geometry, nearest-neighbour and exclusion constraints. |
| Heap | The table's own storage, in insertion order. |
| Heap Fetches | In an index-only scan, rows that still needed a heap visit. |
| HNSW, IVFFlat | Approximate nearest-neighbour index types from pgvector. |
| HOT update | Heap-only tuple update: a new row version on the same page with no new index entries. |
| Index Searches | PostgreSQL 18 plan field: how many times an index was descended. |
| `INVALID` index | A failed concurrent build; ignored by queries, maintained by writes. |
| Leftmost-prefix rule | A composite index helps queries that constrain its leading columns. |
| `pg_stat_statements` | Extension that records time and I/O per normalised query. |
| `pg_stat_user_indexes` | View with per-index usage counters (`idx_scan`, `last_idx_scan`). |
| Partial index | An index over only the rows matching a `WHERE` condition. |
| Planner | The part of Postgres that picks the cheapest plan from cost estimates. |
| Selectivity | The fraction of rows a condition keeps. |
| Skip scan | PostgreSQL 18 B-tree feature: repeated descents when the leading column has no condition but few distinct values. |
| Visibility map | One bit per heap page saying every row on it is visible to everyone; set by `VACUUM`. |
| WAL | Write-ahead log; every change is recorded here before the data files. |

---

## 🗒️ Cheat sheet

```mermaid
mindmap
  root((Indexes and plans))
    B-tree
      sorted pages
      3 to 4 pages per lookup
      range scans along leaves
    Column order
      equality first
      then range or sort
      then tie-breaker id
    Special
      INCLUDE for index-only
      partial for rare rows
      expression for lower
    Plans
      Buffers first
      estimated vs actual rows
      loops multiply
      Rows Removed by Filter
    Costs
      every write pays
      WAL and bloat
      drop unused carefully
    Production
      CONCURRENTLY
      lock_timeout
      plan tests in CI
      pg_stat_statements total time
```

**How to read this diagram.** The centre is the card; each branch is one area, and its leaves are the rules to remember. Read it before an interview or before reviewing a migration that adds an index.

**Rules on one screen**

- One index per hot access pattern. Column order: `=` columns, then the range or sort column, then a tie-breaker.
- Never wrap an indexed column in a function or cast. Dates are half-open ranges on the bare column.
- `INCLUDE` only narrow columns hot queries read; index-only scans need `VACUUM` to keep up.
- Partial indexes for rare values queried by literal (`status = 'pending'`); expression indexes must match the query's expression exactly.
- Read plans for **Buffers**, **estimated vs actual rows**, **loops** and **Rows Removed by Filter** before time.
- Seq scans are right for big shares of a table and for tiny tables; wrong for "few rows from a huge table".
- Every index costs every write: here, 6 indexes made bulk inserts 7.4 times slower and WAL 6.4 times bigger.
- Production: `CREATE INDEX CONCURRENTLY` outside a transaction, `lock_timeout`, check for `INVALID`, plan tests in CI.
- Find work with `pg_stat_statements` sorted by total time; find waste with `pg_stat_user_indexes` (not unique, not used on replicas).

---

## ✔️ Completion checklist

**Card measures**
- [ ] Query latency before and after each index recorded on my machine (the measurements table).
- [ ] Index sizes recorded for every index I created.
- [ ] Insert throughput with 0, 3 and 6 indexes recorded, plus WAL per row.

**Lab steps**
- [ ] Step 1: 5 million entries seeded; no-index plans saved in `plans/`.
- [ ] Step 2: right and wrong column order compared, including a dormant wallet.
- [ ] Step 3: covering index, `VACUUM` and `Heap Fetches` seen; migration 008 applied with the concurrent runner; plan test green, and seen failing once.
- [ ] Step 4: partial vs full index sizes compared; migrations 007 and 009 applied.
- [ ] Step 5: `pg_stat_statements` top five listed after a load run (k6 through the API, or pgbench).
- [ ] Step 6: insert benchmark run.

**Phase 2 gate**
- [ ] I can explain the column order of `(wallet_id, created_at DESC, id DESC)` without notes.
- [ ] I can read an `EXPLAIN (ANALYZE, BUFFERS)` plan and point at the expensive node.

**Publishing**
- [ ] Lab run on my machine.
- [ ] My numbers filled in.
- [ ] One post published from the ideas below.

---

## 📣 Learn in public

Use **your own** numbers; the ones in brackets are from this guide's sandbox.

**Post 1: "Same columns, different order: [188]x slower"**
- *Problem:* "latest 20 transactions" on [5 million] ledger entries.
- *Decision:* compared `(wallet_id, created_at)` with `(created_at, wallet_id)`.
- *Result:* [0.17 ms] vs [31 ms]; for a wallet with no history, [0.1 ms] vs [337 ms].
- *Lesson:* equality columns first, then the sort column. `Index Cond` in a plan does not prove the index is used well; Buffers do.

**Post 2: "What six indexes cost my inserts"**
- *Problem:* "add an index for every filter" sounded harmless.
- *Decision:* benchmarked inserts with 0, 3 and 6 indexes.
- *Result:* bulk inserts at [100%], [21%] and [13%]; WAL per row [148 → 948] bytes; two indexes never used once.
- *Lesson:* one index per access pattern, and read `pg_stat_user_indexes` before adding more.

**Post 3: "The 16 queries that used 70% of my database"**
- *Problem:* everything looked fast in code review.
- *Decision:* enabled `pg_stat_statements` and sorted by total time.
- *Result:* a daily report wrapped `created_at` in a date cast: [16] calls, [35.7 s]; a range query brought it from [951 ms] to [2.5 ms].
- *Lesson:* sort by total time, and never wrap an indexed column.

**Hinglish video idea: "Index lagaya, phir bhi slow? EXPLAIN padhna seekho"**
Start with Riya's history screen taking 205 ms on 5 million rows and show the plan: `Rows Removed by Filter: 1666638`. Add the index in the wrong order and show that it "works" but reads 6,975 pages. Flip the order: 24 pages, 0.17 ms. End with the dormant-wallet twist (337 ms vs 0.1 ms) and one line: "pehle equality column, phir sort column."

---

## ➡️ Next cards

- **P2-05 · The data access layer: pooling, N+1, ORMs.** This card made each query cheap; P2-05 makes sure the app does not send 21 of them where one would do, and that connection pools and `statement_timeout` protect the database when a plan goes wrong.
- **P3-08 · Search basics.** GIN is an inverted index; P3-08 builds one by hand, then compares Postgres full text and `pg_trgm` with a search engine for "find this transaction".
- **P4-03 · Partitioning and consistent hashing.** When one table and one B-tree stop being enough (billions of entries, cheap deletion of old months), partitioning splits them, and every index in this card becomes a per-partition index.
- **Also linked:** P2-06 · Zero-downtime schema changes (lock queues, `lock_timeout`, `NOT VALID`); P2-08 · Postgres extras (GIN for JSONB and full text, HNSW and IVFFlat for pgvector); P2-03 (MVCC and `VACUUM`, which make index-only scans possible).

---

## 🔗 Sources and further reading

All links checked on 17 Oct 2026.

- [PostgreSQL: news and current versions](https://www.postgresql.org/) — 18.6 released 13 Aug 2026; 19 RC 1 on 15 Oct 2026.
- [PostgreSQL 18 release notes](https://www.postgresql.org/docs/18/release-18.html) — B-tree skip scan, `BUFFERS` by default in `EXPLAIN ANALYZE`, index lookups per scan node, fractional row counts, parallel GIN builds, `pg_stat_statements` changes.
- [PostgreSQL 18: Multicolumn indexes](https://www.postgresql.org/docs/18/indexes-multicolumn.html) — leading-column rule, skip scan, "use sparingly".
- [PostgreSQL 18: Index-only scans and covering indexes](https://www.postgresql.org/docs/18/indexes-index-only-scans.html) — visibility map, `INCLUDE`.
- [PostgreSQL 18: CREATE INDEX](https://www.postgresql.org/docs/18/sql-createindex.html) — `CONCURRENTLY`, `INVALID` indexes, partial and expression indexes, `IMMUTABLE` rule.
- [PostgreSQL 18: Index types](https://www.postgresql.org/docs/18/indexes-types.html) — B-tree, hash, GiST, SP-GiST, GIN, BRIN.
- [PostgreSQL 18: Using EXPLAIN](https://www.postgresql.org/docs/18/using-explain.html) — reading plans, `ANALYZE`, `BUFFERS`.
- [PostgreSQL 18: Statistics used by the planner](https://www.postgresql.org/docs/18/planner-stats.html) — `pg_stats`, extended statistics.
- [PostgreSQL 18: Query planning settings](https://www.postgresql.org/docs/18/runtime-config-query.html) — `random_page_cost`, `effective_cache_size`.
- [PostgreSQL 18: pg_stat_statements](https://www.postgresql.org/docs/18/pgstatstatements.html) — setup, columns, normalisation, overhead.
- [PostgreSQL 18: The cumulative statistics system](https://www.postgresql.org/docs/18/monitoring-stats.html) — `pg_stat_user_indexes`, `pg_stat_user_tables`.
- [PostgreSQL 18: Routine vacuuming](https://www.postgresql.org/docs/18/routine-vacuuming.html) — visibility map, autovacuum thresholds.
- [PostgreSQL 18: pageinspect](https://www.postgresql.org/docs/18/pageinspect.html) and [pgstattuple](https://www.postgresql.org/docs/18/pgstattuple.html) — used for the B-tree walk and leaf density.
- [pgvector](https://github.com/pgvector/pgvector) — v0.8.7; HNSW and IVFFlat.
- [k6 v2.0.0 release notes](https://grafana.com/docs/k6/latest/release-notes/v2.0.0/) — breaking changes (none affect the lab script); latest release v2.3.0.
- [@embedded-postgres/linux-x64 on npm](https://www.npmjs.com/package/@embedded-postgres/linux-x64) — how PostgreSQL 18.4 was run in this guide's sandbox.
