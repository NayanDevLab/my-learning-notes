# P2-01 · Relational data modelling

| | |
|---|---|
| **Phase** | 2 |
| **Prerequisites** | P1-03 · REST API design (the lab also reuses ideas from P1-05 and P1-06) |
| **Leads to** | P2-02 · Indexes and query plans · P2-09 (the double-entry journal) · P7-03 |
| **Suggested repo path** | `system-design/phase-2/p2-01-relational-data-modelling.md` |
| **Facts checked on** | 14 October 2026 |

**After this card you can:**

1. Turn a product (wallets, transfers, members, history) into tables with clear one-to-one, one-to-many and many-to-many relationships, and draw them as an ER diagram.
2. Choose between bigint, UUIDv4 and UUIDv7 keys with your own benchmark numbers, and explain what each one does to indexes and URLs.
3. Put business rules into the database as constraints, so scripts, migrations, other services and bugs cannot break them.
4. Pick the right types for money, time and text, and add lifecycle columns, history tables and tenant keys on purpose.
5. Design from the queries the product must serve, not only from the nouns in the requirements.

> **About the numbers in this guide.** Everything marked **Real output** was run while writing this guide, on **PostgreSQL 18.4** (the newest build available in this sandbox; 18.6 is the current minor release) on a 2-vCPU Linux machine with Node 22. Everything marked **Expected** was not run here. All the SQL and TypeScript in the lab was applied and tested: 5 migrations, 47 bad-data cases through `psql`, a 10 lakh (1 million) row benchmark per ID type, and 5 Vitest tests. Versions checked on 14 Oct 2026: PostgreSQL 18.6 (current), node-postgres 8.23.1, Vitest 5.0.4, TypeScript 5.9.3.

> **One interpretation, stated up front.** The card asks for `UNIQUE (wallet_id, currency)`. In this guide that is the `wallet_balances` table: a wallet holds one balance row per currency, and the pair `(wallet_id, currency)` is its primary key.

> **Leads to P7-03.** The card names it only by ID. The schema habits from this card (constraints, history, tenant keys) are what it builds on.

---

## ⏱️ The concept in one minute

Your API, your workers, your admin scripts and next year's new service all read and write the same tables. The code around them will be rewritten many times. The schema usually stays.

**Definition.** Relational data modelling is deciding which **tables** you have, which **columns** each one holds, how the tables **relate**, and which **rules** (constraints) the database itself enforces.

**One line:** make wrong data impossible to store, and make the important questions cheap to ask.

**Analogy: a bank branch's locker register.** Each locker has a number painted on it (a key). The register lists who holds which locker (a relationship). The rules are printed on the form: one holder per locker, the deposit must be more than zero, a locker cannot be given to someone without a KYC file (constraints). The register is never rubbed out; a change of holder is a new line with a date (history). It does not matter which clerk is on duty. The register itself refuses a bad entry.

**On the ledger platform.** "Every transfer is more than zero paise" can be a line in the API, which a script can skip. Or it can be `CHECK (amount_minor > 0)` on the `transfers` table, which nothing can skip. This card is about the second kind.

---

## 💥 The problem it solves

Here is the ledger platform without careful modelling. Every result below was run on PostgreSQL 18 while writing this guide.

**1. A "quick fix" script and no constraints.** The API rejects a transfer of zero, but a support script does not use the API. With constraints, the database answered every bad write. **Real output** (a bad insert typed straight into `psql`, first two lines):

```text
ERROR:  new row for relation "transfers" violates check constraint "transfers_amount_minor_check"
DETAIL:  Failing row contains (aaaaaaaa-0000-7000-8000-000000000000, 01a139ca-cf14-78bb-9a56-e39b48efc7eb, aaaaaaaa-0000-7000-8000-0000000000d1, aaaaaaaa-0000-7000-8000-0000000000d2, INR, 0, completed, null, 2, 2026-10-14 09:42:35.027615+00).
```

Without that `CHECK`, the row would simply be stored, and every report would include a zero-rupee "payment".

**2. Floats for money.** Ten lakh cashbacks of ₹0.10 should add up to exactly ₹1,00,000. **Real output** (`sql/money-types.sql`, first query):

```text
-- ten lakh additions of Rs 0.10
   float8_rupees    | numeric_rupees | bigint_paise 
--------------------+----------------+--------------
 100000.00000133288 |       100000.0 |     10000000
```

The `float8` total is off. Off by very little, but a ledger that does not balance to the paisa fails reconciliation, and an auditor will ask why.

**3. `timestamp` without a time zone.** Two app servers write the **same moment**, one set to IST and one to UTC. **Real output** (`sql/timestamps.sql`):

```text
      written_by       |        plain        |           aware           
-----------------------+---------------------+---------------------------
 app server set to IST | 2026-10-14 15:00:00 | 2026-10-14 15:00:00+05:30
 app server set to UTC | 2026-10-14 09:30:00 | 2026-10-14 15:00:00+05:30
```

The plain `timestamp` column now shows two different times, 5½ hours apart, for one event. Nobody can tell which is right.

**4. One fact stored in many rows.** An account's name is copied into every membership row, and the rename screen updates only one of them. **Real output** (`sql/update-anomaly.sql`):

```text
 account_id |     account_name     | rows_saying_this 
------------+----------------------+------------------
          1 | Riya Traders         |                2
          1 | Riya Traders Pvt Ltd |                1
```

One business, two names. Which one goes on the GST invoice?

**5. Random primary keys on a busy table.** With UUIDv4 keys and an index that no longer fits in memory, inserts got slower and the database read **2,35,735** index pages from outside its cache. UUIDv7 and bigint keys read **1**. (Full numbers in lab step 4.)

Each failure has the same root cause: the rule lived only in people's heads or in one code path. This card moves the rules into the schema.

---

## 🧰 Before you start

**Cards you need:**
- **P1-03 · REST API design.** The resources (wallets, transfers, idempotency keys) whose tables we now design properly. Its contract tests checked the API; this card's tests check the data.
- **P1-05 · Authentication and authorisation** (recommended). The users, accounts and members tables come from there.
- **P1-06 · Validation, configuration and secrets** (recommended). It validates at the edge. This card adds the last line of defence behind it.

**Key terms**

| Term | Plain meaning |
|---|---|
| **Entity** | A "thing" the business cares about: user, wallet, transfer. Usually one table. |
| **Relationship / cardinality** | How rows connect, and how many: one-to-one, one-to-many, many-to-many. |
| **Primary key (PK)** | The column(s) that identify a row. Unique and never NULL. |
| **Surrogate key** | An ID with no business meaning (`bigint` or UUID), made just to identify rows. |
| **Natural key** | A key from the real world: an email, a PAN, an ISO currency code. |
| **Foreign key (FK)** | A column that must match a row in another table. |
| **Constraint** | A rule the database checks on every write: NOT NULL, UNIQUE, CHECK, FK, EXCLUDE. |
| **Normal form (1NF-3NF)** | Rules that keep each fact in exactly one place. |
| **Denormalisation** | Storing a copy or a summary of data on purpose, to make reads fast. |
| **B-tree index** | The default index: a sorted tree of pages. Lookups and range scans are fast. |
| **Index locality** | Whether new keys go to the same few pages (good) or to pages all over the index (bad). |
| **Page split** | When an index page is full and must split in two. More splits mean more I/O and half-empty pages. |
| **WAL** | Write-ahead log: every change is written here first. More WAL means more disk and replication traffic. |
| **Append-only** | Rows are only inserted, never updated or deleted. Corrections are new rows. |
| **Soft delete** | Marking a row deleted (`deleted_at`) instead of removing it. |
| **Tenant** | A customer organisation whose data must stay separate from others'. |
| **Access pattern** | A query the product runs, with how often and how fast it must be. |

---

## 🧠 How it works

### The mental model: the schema is the contract that outlives the code

Think of the schema as the API of your data. Your HTTP API is a contract with clients (P1-03). The schema is a contract with **every** program that touches the data, including ones you have not written yet. Like any API, it should make the right thing easy and the wrong thing impossible.

A good model answers three questions:
1. **What exists?** Entities and their relationships.
2. **What is always true?** Constraints: amounts are positive, a key is used once, history is never edited.
3. **What will we ask?** Access patterns: "Riya's last 50 transactions", "the balance now", "the status on 5 October".

### The ledger schema at a glance

**Diagram: the ledger schema, tables and relationships**

```mermaid
erDiagram
  tenants ||--o{ users : has
  tenants ||--o{ accounts : has
  users ||--o| kyc_profiles : has
  users ||--o{ account_members : joins
  accounts ||--o{ account_members : has
  accounts ||--o{ wallets : owns
  wallets ||--o{ wallet_balances : holds
  currencies ||--o{ wallet_balances : prices
  wallet_balances ||--o{ transfers : sends
  wallet_balances ||--o{ ledger_entries : records
  transfers ||--|{ ledger_entries : posts
  idempotency_keys ||--o| transfers : guards
  users ||--o{ idempotency_keys : sends
  wallets ||--o{ wallet_status_history : changes
  wallets ||--o{ wallet_limits : limits
  tenants ||--o{ audit_log : logs
```

**How to read this diagram.** Each box is a table; each line is a foreign key. The symbols at the ends give the cardinality: `||` means "exactly one", `o|` means "zero or one", `o{` means "zero or many", and `|{` means "one or many". So "accounts `||--o{` wallets" reads: one account owns zero or many wallets, and each wallet belongs to exactly one account. "users `||--o|` kyc_profiles" is a one-to-one: a user has at most one KYC profile. Users and accounts are many-to-many, through the `account_members` join table. The detailed diagrams, with columns, are in Deep dive 1.

### How a modelling decision gets made

**Diagram: from a requirement to a table**

```mermaid
flowchart TD
  A["1. Requirement:<br/>Riya freezes a wallet"] --> B["2. Nouns: wallet, status,<br/>reason, who, when"]
  B --> C["3. Questions it must answer:<br/>status now, status on a date"]
  C --> D{"4. Can a fact be<br/>stored twice?"}
  D -- "yes" --> E["Split tables until<br/>each fact lives once"]
  E --> D
  D -- "no" --> F["5. Write the rules<br/>as constraints"]
  F --> G["6. Index for the questions<br/>from step 3"]
  G --> H["7. Test: bad rows rejected,<br/>questions fast"]
```

**How to read this diagram.** Start from a real requirement, not from a list of nouns. Step 3 is where access-pattern thinking happens: list the questions before you draw tables. Steps 4 and 5 are normalisation and constraints. Step 6 makes the step-3 questions cheap. Step 7 closes the loop with tests, like the lab's 47 bad-data cases.

### Where the rules live

| Rule | API (P1-06) | Database (this card) | Why both, or why only one |
|---|---|---|---|
| `amountMinor` is a positive whole number | Zod schema → 400 with a pointer | `CHECK (amount_minor > 0)`, `bigint` | API for a good error message; DB because scripts skip the API |
| Same email only once | Normalise to lowercase | `citext` + partial `UNIQUE` index | Two requests can race; only a unique index wins every race |
| Transfer has an idempotency key | `requireIdempotency` | `idempotency_key_id NOT NULL UNIQUE` | The DB makes "one transfer per key" true under concurrency |
| Wallet belongs to the same tenant | Authorisation check | Composite foreign key with `tenant_id` | The DB stops cross-tenant rows from any code path |
| Balance never below zero | Service checks balance under a row lock | `CHECK (balance_minor >= 0)` | The lock gives a clear 422; the CHECK catches the bug you did not write a test for |
| Statement period at most 366 days | Domain parser → 422 | not in the DB | A rule about a request, not about stored data |

The pattern: **the API gives good errors; the database gives guarantees.** If a rule is about what may be **stored**, put it in the database. If it is about what a **request** may ask for, it lives at the edge.

---

## 🔬 Deep dive

One subsection per "Learn inside" item on the card, in study order. Each has a small runnable example. The full migrations are in the lab.

### 1. Entities and relationships

**What it is.** An **entity** is a thing the business talks about. A **relationship** says how rows of two entities connect, and how many on each side. There are three shapes, and the ledger has all three. (The snippets in this section are simplified; the lab's migrations add `tenant_id`, timestamps and more rules.)

**One-to-one: a user and their KYC profile.** The child's primary key **is** the foreign key, so there can never be two profiles for one user.

```sql
CREATE TABLE kyc_profiles (
  user_id uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,  -- PK = FK: at most one per user
  kyc_level text NOT NULL CHECK (kyc_level IN ('minimum', 'full'))
);
```

Why not just put KYC columns in `users`? Because they are read rarely, they are more sensitive, they may need different retention and access rules, and many users never have them. **When not to split:** if the columns are always present and always read together, a second table only adds a join.

**One-to-many: an account and its wallets.** The foreign key goes on the "many" side.

```sql
CREATE TABLE wallets (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  account_id uuid NOT NULL REFERENCES accounts (id) ON DELETE RESTRICT
);
CREATE INDEX wallets_by_account ON wallets (account_id);  -- Postgres does NOT index foreign keys for you
```

That last line matters. Postgres automatically indexes primary keys and unique constraints, not foreign key columns. Without the index, "list Riya Traders' wallets" scans the whole table, and deleting an account scans `wallets` once per account to check the rule.

**Many-to-many: users and accounts.** Priya is a viewer on Riya Traders and the owner of her own account. Riya Traders has several members. Neither table can hold the other's id, so a **join table** sits in between. It often carries its own data (the `relation`).

```sql
CREATE TABLE account_members (
  account_id uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  relation   text NOT NULL CHECK (relation IN ('owner', 'viewer')),
  PRIMARY KEY (account_id, user_id)          -- a person joins an account once
);
CREATE INDEX account_members_by_user ON account_members (user_id);  -- the PK serves "members of an account"; this serves "accounts of a user"
```

**The full schema, with columns.** (These match the lab's migrations. `PK` primary key, `FK` foreign key, `UK` unique.)

**Diagram: identity and ownership tables**

```mermaid
erDiagram
  tenants ||--o{ users : has
  tenants ||--o{ accounts : has
  users ||--o| kyc_profiles : has
  users ||--o{ account_members : joins
  accounts ||--o{ account_members : has
  accounts ||--o{ wallets : owns
  tenants {
    uuid id PK
    text slug UK
    text name
  }
  users {
    uuid id PK
    uuid tenant_id FK
    citext email "unique while not deleted"
    text phone_e164
    text role
    timestamptz deleted_at
  }
  kyc_profiles {
    uuid user_id PK, FK
    text kyc_level
    timestamptz verified_at
  }
  accounts {
    uuid id PK
    uuid tenant_id FK
    text kind
    text display_name
  }
  account_members {
    uuid account_id PK, FK
    uuid user_id PK, FK
    text relation
  }
  wallets {
    uuid id PK
    uuid account_id FK
    text status
    integer version
    timestamptz closed_at
  }
```

**How to read this diagram.** The top part repeats the relationships from the overview. Each box then lists the table's columns: type, name, and whether it is part of a key. `account_members` has **two** `PK, FK` columns: its key is the pair, and each half points at another table. `kyc_profiles.user_id` is both the key and the foreign key, which is what makes the relationship one-to-one.

**Diagram: money movement tables**

```mermaid
erDiagram
  wallets ||--o{ wallet_balances : holds
  currencies ||--o{ wallet_balances : prices
  wallet_balances ||--o{ transfers : sends
  wallet_balances ||--o{ ledger_entries : records
  transfers ||--|{ ledger_entries : posts
  idempotency_keys ||--o| transfers : guards
  wallet_balances {
    uuid wallet_id PK, FK
    text currency PK, FK
    bigint balance_minor "CHECK >= 0"
    integer version
  }
  currencies {
    text code PK "ISO 4217"
    smallint minor_unit
  }
  transfers {
    uuid id PK
    uuid source_wallet_id FK
    uuid destination_wallet_id FK
    text currency FK
    bigint amount_minor "CHECK > 0"
    bigint idempotency_key_id FK, UK
  }
  ledger_entries {
    bigint id PK
    uuid transfer_id FK
    uuid wallet_id FK
    text direction
    bigint amount_minor "CHECK > 0"
  }
  idempotency_keys {
    bigint id PK
    uuid client_id FK
    text key "UK with tenant and client"
    text status
  }
```

**How to read this diagram.** Money flows between **balances**, not wallets: a transfer's `(source_wallet_id, currency)` must match a row in `wallet_balances`, so a wallet can only send a currency it actually holds. `transfers ||--|{ ledger_entries` says each transfer posts one or more entries (exactly one debit and one credit here; P2-09 generalises this). `idempotency_keys ||--o| transfers` is a one-to-one in disguise: `idempotency_key_id` is `UNIQUE` on transfers, so one key can produce at most one transfer.

**Diagram: history and audit tables**

```mermaid
erDiagram
  wallets ||--o{ wallet_status_history : changes
  wallets ||--o{ wallet_limits : limits
  tenants ||--o{ audit_log : logs
  wallet_status_history {
    bigint id PK
    uuid wallet_id FK
    text status
    text reason
    timestamptz changed_at
  }
  wallet_limits {
    bigint id PK
    uuid wallet_id FK
    bigint daily_limit_minor
    tstzrange valid_during "no overlaps"
  }
  audit_log {
    bigint id PK
    uuid tenant_id FK
    text action
    text entity_type
    uuid entity_id "no FK on purpose"
    jsonb details
  }
```

**How to read this diagram.** These three tables only grow. `wallet_status_history` and `audit_log` are append-only; `wallet_limits` uses time ranges that can never overlap for one wallet. `audit_log.entity_id` has no foreign key on purpose: an audit trail must survive the deletion or archiving of the thing it describes (Deep dive 7).

**Trade-off.** More tables mean more joins. That is usually fine: joins on indexed keys are cheap. What is expensive is the opposite mistake, one wide table holding several entities, where every fact is stored many times (Deep dive 3).

### 2. Keys: surrogate vs natural, and bigint vs UUIDv4 vs UUIDv7

**Natural or surrogate?** A **natural key** comes from the real world. A **surrogate key** is made up just to identify the row.

| Candidate | Natural key? | Verdict |
|---|---|---|
| ISO currency code (`INR`) | Yes | **Use it.** Short, stable, standard, readable in every row. Our `currencies` table uses it as the PK. |
| Email | Yes | No. People change emails, and it is personal data you do not want copied into every child table. Keep it `UNIQUE`, not the PK. |
| PAN / Aadhaar | Yes | Never. Sensitive, rarely needed, must not appear in URLs or logs. |
| Phone number | Yes | No. Numbers get recycled to new people. |
| User, wallet, transfer | No natural key | Surrogate. |

The rule: use a natural key only when it is **stable, short, not sensitive, and truly unique**. Everything else gets a surrogate key, plus `UNIQUE` constraints on the natural attributes.

**Three kinds of surrogate key.**
- **`bigint` identity:** `id bigint GENERATED ALWAYS AS IDENTITY`. 8 bytes, always increasing. (Use identity columns, not the old `serial`: the PostgreSQL wiki's "Don't Do This" page says identity columns should be used in new applications.)
- **UUIDv4:** 16 bytes, 122 random bits. `gen_random_uuid()`, or `uuidv4()` in PostgreSQL 18.
- **UUIDv7:** 16 bytes. Defined in RFC 9562 (May 2024). The first 48 bits are the Unix time in milliseconds, and the rest is mostly random. PostgreSQL 18 has `uuidv7()` built in.

**Minimal version: what is inside a UUIDv7.**

```ts
// minimal/uuid-versions.ts — what is inside a UUIDv7, and why its order matters. Run: npx tsx minimal/uuid-versions.ts
import { randomBytes, randomUUID } from "node:crypto";

// RFC 9562 UUIDv7: 48-bit Unix time in ms | version 7 | 12 random bits | variant | 62 random bits.
function uuidv7(ms = Date.now()): string {
  const b = randomBytes(16);
  b.writeUIntBE(ms, 0, 6);            // bytes 0-5: milliseconds since 1970, big-endian, so text order = time order
  b[6] = (b[6]! & 0x0f) | 0x70;       // version 7
  b[8] = (b[8]! & 0x3f) | 0x80;       // RFC variant (10xx)
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
const timeOf = (id: string) => new Date(parseInt(id.replaceAll("-", "").slice(0, 12), 16)).toISOString();

const start = Date.parse("2026-10-14T09:30:00.000Z");
const v7 = Array.from({ length: 5 }, (_, i) => uuidv7(start + i * 1000)); // one per second
const v4 = Array.from({ length: 5 }, () => randomUUID());

const isSorted = (xs: string[]) => xs.every((x, i) => i === 0 || xs[i - 1]! < x);
console.log("v7, made one second apart:"); v7.forEach((id) => console.log("  ", id, "->", timeOf(id)));
console.log("v7 already in sorted order?", isSorted(v7));
console.log("v4, made one after another:"); v4.forEach((id) => console.log("  ", id));
console.log("v4 in sorted order?", isSorted(v4), "(random: each new key lands anywhere in the index)");

// The catch: anyone holding a v7 id can read when the row was created.
console.log("creation time hidden in a v7 id from a URL:", timeOf("019e2a4c-1b40-7a3d-9f12-3c4d5e6f7a8b"));
```

**Real output:**

```text
v7, made one second apart:
   01a139bf-49c0-748f-ae29-446808ec95d4 -> 2026-10-14T09:30:00.000Z
   01a139bf-4da8-7c4e-9a17-68ebc6bfa4ad -> 2026-10-14T09:30:01.000Z
   01a139bf-5190-77ef-8c1f-3af9f18d5787 -> 2026-10-14T09:30:02.000Z
   01a139bf-5578-7bce-9533-276d6676a399 -> 2026-10-14T09:30:03.000Z
   01a139bf-5960-729c-a2df-93ac1aa3f64f -> 2026-10-14T09:30:04.000Z
v7 already in sorted order? true
v4, made one after another:
   d4135d63-839d-497e-8a5d-5b4551d9a286
   19eda8d8-c568-4601-9983-0b00998a672e
   c2036374-2f97-47ee-9f77-4795f02a12c6
   72a011ab-ec89-4082-a92e-3a1101f566c5
   d9bed965-7236-4531-85f0-a953f3323c97
v4 in sorted order? false (random: each new key lands anywhere in the index)
creation time hidden in a v7 id from a URL: 2026-05-15T06:21:31.328Z
```

**What to notice**
- v7 ids made later sort later, because the time is in the first bytes. v4 ids land anywhere.
- Anyone can read the creation time out of a v7 id. The last line decodes an id that could have come from a URL.
- This hand-written version is for learning. In production, use `uuidv7()` in PostgreSQL 18, or the `uuid` package's `v7()` in Node.

**Why random keys hurt an index.** A B-tree index keeps keys in order, in pages of about 8 KB. An increasing key always goes into the right-most page, so writes touch one hot page that stays in memory, and full pages are left full. A random key goes into a random page: the database must find that page (maybe from disk), and when it is full, split it into two half-full pages. A toy model shows the effect without any database:

```ts
// minimal/btree-locality.ts — a toy B-tree leaf level: random keys (UUIDv4) vs increasing keys (UUIDv7, bigint).
// Run: npx tsx minimal/btree-locality.ts
const CAPACITY = 100; // keys per leaf page
const N = 200_000;

function insertAll(keys: number[]): { pages: number; splits: number; fill: number; touchedPerThousand: number } {
  const pages: number[][] = [[]];
  let splits = 0;
  const touched = new Set<number[]>();
  keys.forEach((key, i) => {
    // find the page whose range holds the key (binary search on each page's first key)
    let lo = 0, hi = pages.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (pages[mid]![0]! <= key) lo = mid; else hi = mid - 1; }
    const page = pages[lo]!;
    page.splice(page.findIndex((k) => k > key) === -1 ? page.length : page.findIndex((k) => k > key), 0, key);
    if (i >= N - 1000) touched.add(page); // how many different pages did the LAST 1,000 inserts touch?
    if (page.length > CAPACITY) {
      splits++;
      // Rightmost page and an increasing key: keep the old page full, start a fresh one (Postgres does the same).
      const atEnd = lo === pages.length - 1 && key === page[page.length - 1];
      const cut = atEnd ? CAPACITY : CAPACITY / 2;
      pages.splice(lo + 1, 0, page.splice(cut));
    }
  });
  return { pages: pages.length, splits, fill: (100 * N) / (pages.length * CAPACITY), touchedPerThousand: touched.size };
}

const increasing = Array.from({ length: N }, (_, i) => i);
const random = Array.from({ length: N }, () => Math.random());
for (const [name, keys] of [["increasing (v7/bigint)", increasing], ["random (v4)", random]] as const) {
  const r = insertAll([...keys]);
  console.log(`${name.padEnd(24)} pages=${r.pages}  splits=${r.splits}  fill=${r.fill.toFixed(1)}%  pages touched by last 1,000 inserts=${r.touchedPerThousand}`);
}
```

**Real output:**

```text
increasing (v7/bigint)   pages=2000  splits=1999  fill=100.0%  pages touched by last 1,000 inserts=11
random (v4)              pages=2880  splits=2879  fill=69.4%  pages touched by last 1,000 inserts=833
```

The random-key index ends up 69.4% full, which matches the textbook result for random inserts into B-trees (about ln 2, or 69%). Worse, the last 1,000 random inserts touched 833 different pages; the increasing keys touched 11. When the index is bigger than memory, each of those 833 pages can be a disk read.

**Diagram: where new keys land in the index's leaf pages**

```text
increasing keys (bigint, UUIDv7)            random keys (UUIDv4)
+------+------+------+------+------+       +------+------+------+------+------+
| full | full | full | full | new> |       | ~70% | new  | ~70% | new  | ~70% |
+------+------+------+------+------+       +------+------+------+------+------+
  old pages stay full and cold:              every page stays "warm"; splits
  only the right-most page is written        leave pages about 70% full
```

**How to read this diagram.** Each box is one leaf page of the primary-key index. On the left, all new keys go to the right-most page; older pages are full and never touched again, so they can leave memory. On the right, new keys go to random pages, so every page must stay in memory for inserts to be fast, and splits leave them only partly full.

PostgreSQL measured this for real in lab step 4: at 10 lakh rows the UUIDv4 primary-key index was **37.7 MiB** with 71.9% leaf density, against **30.1 MiB** (90%) for UUIDv7 and **21.4 MiB** (90%) for bigint.

**What changes for URLs.**

| | bigint | UUIDv4 | UUIDv7 |
|---|---|---|---|
| Guessable? | Yes. `/transfers/104233` invites trying `104234` | No (122 random bits) | No (62 or more random bits) |
| Leaks business volume? | Yes: ids reveal roughly how many transfers you have done | No | No |
| Leaks creation time? | Roughly, by comparing ids | No | **Yes, to the millisecond** |
| Safe to create on the client or offline? | No, needs the database | Yes | Yes |
| Index size and insert speed (lab) | Best | Worst | Close to bigint |

Guessable ids are not a security hole by themselves; missing authorisation is (P1-05 returns 404 for other people's wallets). But they make that hole easy to find, and they tell competitors your volume. UUIDv7's leak is the creation time. For a transfer, `createdAt` is already in the API response, so nothing new leaks. For something whose creation time is sensitive, use UUIDv4 for the public id.

**Our choice for the ledger.**
- **UUIDv7** primary keys for things that appear in URLs and APIs: tenants, users, accounts, wallets, transfers.
- **bigint identity** for internal, high-volume, append-only tables that are never addressed alone in a URL: `ledger_entries`, `wallet_status_history`, `wallet_limits`, `idempotency_keys`, `audit_log`.

A common alternative is a bigint primary key **plus** a separate `public_id uuid UNIQUE` for the API. It gives the smallest joins, at the cost of two ids per row and a translation step in every API call.

**On PostgreSQL 16 or 17.** `uuidv7()` is new in 18. On older versions, generate the id in the app (`import { v7 } from "uuid"`) or with a small SQL function, and pass it in. The index behaviour is the same.

**Trade-off.** UUIDs cost 8 more bytes per key than bigint, in the table **and** in every index and foreign key that copies them. For one table that is small. Across `ledger_entries` (with two UUID foreign keys) at 10 crore rows, it adds up; lab step 4 projects the numbers.

### 3. Normal forms: 1NF to 3NF, and when to break them

**What it is.** Normal forms are rules that make each fact live in **exactly one place**. When a fact is stored twice, the copies drift apart. Here is each rule in plain words, with a ledger example.

| Form | Plain rule | Breaks it on the ledger | Fix | Problem it prevents |
|---|---|---|---|---|
| **1NF** | One value per cell; no lists or repeating column groups | `wallets.member_emails = 'riya@…,priya@…'`, or columns `member1`, `member2`, `member3` | A row per member in `account_members` | Cannot index, constrain or join a list; "remove Priya" means string surgery |
| **2NF** | Every non-key column depends on the **whole** key (matters when the key has two or more columns) | `account_members (account_id, user_id, relation, account_name)`: `account_name` depends only on `account_id` | Keep `display_name` in `accounts` | **Update anomaly**: rename in one row, the others keep the old name (demo below) |
| **3NF** | Non-key columns depend on the key, not on **other non-key columns** | `transfers (…, currency, currency_minor_unit)`: the minor unit depends on the currency, not the transfer | `currencies (code PK, minor_unit)`, and transfers keep only `currency` | One wrong row says INR has 3 decimals; a new currency cannot exist until a transfer uses it (**insert anomaly**) |
| **Beyond 3NF** (Optional advanced understanding) | BCNF and higher handle rarer overlapping keys | Rare in OLTP schemas like this one | Usually 3NF is the practical target | — |

**Minimal version: the update anomaly, live.**

```sql
-- sql/update-anomaly.sql — the same fact stored in three rows (a 2NF break), then changed in one.
\pset footer off
CREATE TEMP TABLE members_flat (account_id int, member_email text, relation text, account_name text,
                                PRIMARY KEY (account_id, member_email));
INSERT INTO members_flat VALUES
  (1, 'riya@ledger.test',  'owner',  'Riya Traders'),
  (1, 'priya@ledger.test', 'viewer', 'Riya Traders'),
  (1, 'ca@ledger.test',    'viewer', 'Riya Traders');
-- Riya renames her business from her own profile screen. That code updates "her" row.
UPDATE members_flat SET account_name = 'Riya Traders Pvt Ltd' WHERE member_email = 'riya@ledger.test';
SELECT account_id, account_name, count(*) AS rows_saying_this FROM members_flat GROUP BY 1, 2 ORDER BY 2;
```

**Real output:**

```text
 account_id |     account_name     | rows_saying_this 
------------+----------------------+------------------
          1 | Riya Traders         |                2
          1 | Riya Traders Pvt Ltd |                1
```

**What to notice**
- Nothing failed. The database did exactly what it was told. The design allowed two truths.
- The fix is not "remember to update all rows". It is a schema where the name exists once.

**When to denormalise.** Breaking 3NF on purpose is fine when a read is hot and computing it every time is expensive. The usual cases:
- **Running balances and counters:** `wallet_balances.balance_minor` is a copy of the sum of a wallet's ledger entries.
- **Read models:** a "transactions screen" table, or a materialised view, shaped exactly for one screen.
- **Search and analytics copies:** Elasticsearch, a warehouse. Usually filled by events (Phase 4).

**What it costs, measured.** The copy makes reads fast and writes harder. **Real output** (`sql/denormalised-balance.sql`, which keeps a balance copy next to 10 lakh entries):

```sql
-- sql/denormalised-balance.sql — a stored balance is a copy of SUM(entries). Same transaction, then reconcile.
\pset footer off
CREATE TEMP TABLE entries (id bigint GENERATED ALWAYS AS IDENTITY, wallet text NOT NULL, amount_minor bigint NOT NULL); -- truth (+credit, -debit)
CREATE TEMP TABLE balances (wallet text PRIMARY KEY, balance_minor bigint NOT NULL CHECK (balance_minor >= 0));       -- copy
CREATE INDEX ON entries (wallet);
INSERT INTO balances VALUES ('riya', 0), ('amit', 0);

-- Every movement writes BOTH, in ONE transaction: either both change or neither does.
BEGIN;
INSERT INTO entries (wallet, amount_minor) VALUES ('riya', 100000);
UPDATE balances SET balance_minor = balance_minor + 100000 WHERE wallet = 'riya';
COMMIT;
BEGIN;
INSERT INTO entries (wallet, amount_minor) VALUES ('riya', -50000), ('amit', 50000);
UPDATE balances SET balance_minor = balance_minor - 50000 WHERE wallet = 'riya';
UPDATE balances SET balance_minor = balance_minor + 50000 WHERE wallet = 'amit';
COMMIT;

\echo '-- reconciliation: wallets whose stored balance disagrees with their entries'
SELECT b.wallet, b.balance_minor AS stored, coalesce(sum(e.amount_minor), 0) AS from_entries
FROM balances b LEFT JOIN entries e USING (wallet) GROUP BY b.wallet, b.balance_minor
HAVING b.balance_minor <> coalesce(sum(e.amount_minor), 0);

\echo '-- a "quick fix" script updates only one side'
UPDATE balances SET balance_minor = balance_minor + 1000 WHERE wallet = 'amit';
SELECT b.wallet, b.balance_minor AS stored, coalesce(sum(e.amount_minor), 0) AS from_entries
FROM balances b LEFT JOIN entries e USING (wallet) GROUP BY b.wallet, b.balance_minor
HAVING b.balance_minor <> coalesce(sum(e.amount_minor), 0);

\echo '-- why keep a copy at all: read the balance vs add up 10 lakh entries'
INSERT INTO entries (wallet, amount_minor) SELECT 'riya', 1 FROM generate_series(1, 1000000);
UPDATE balances SET balance_minor = balance_minor + 1000000 WHERE wallet = 'riya';
VACUUM ANALYZE entries;
\timing on
SELECT balance_minor FROM balances WHERE wallet = 'riya';
SELECT sum(amount_minor) FROM entries WHERE wallet = 'riya';
SELECT balance_minor FROM balances WHERE wallet = 'riya';
SELECT sum(amount_minor) FROM entries WHERE wallet = 'riya';
```

```text
-- reconciliation: wallets whose stored balance disagrees with their entries
 wallet | stored | from_entries 
--------+--------+--------------

-- a "quick fix" script updates only one side
 wallet | stored | from_entries 
--------+--------+--------------
 amit   |  51000 |        50000

-- why keep a copy at all: read the balance vs add up 10 lakh entries
 balance_minor 
---------------
       1050000

Time: 0.492 ms
   sum   
---------
 1050000

Time: 132.781 ms
 balance_minor 
---------------
       1050000

Time: 0.469 ms
   sum   
---------
 1050000

Time: 131.986 ms
```

**What to notice**
- Reading the stored balance took about 0.48 ms; adding up 10 lakh entries took about 132 ms. That is roughly **275 times** slower, and it grows with every transfer.
- The copy stayed right as long as **every** write changed both, in one transaction.
- A one-sided "quick fix" made them disagree, and only the reconciliation query noticed.

**What keeps the copies consistent** (this is question 1 from the card):
1. **The same transaction** writes the source of truth and the copy. Either both commit or neither does.
2. **One code path** does that write (the transfer service), not every caller.
3. **A reconciliation query** runs on a schedule and alerts when copy and source disagree.
4. **The copy can be rebuilt** from the source at any time. The source of truth is never the copy.
5. For copies in other systems (search, cache), **events** carry the change, and the copy is allowed to lag (Phase 4).

**When not to denormalise.** When the "slow" query is slow only because an index is missing (P2-02). When the copy has no clear owner. Or when nobody will build the reconciliation job.

### 4. Constraints as business rules

**What it is.** A constraint is a rule the database checks on **every** write, from every program, inside the same transaction. Here are the kinds, each with a ledger rule:

| Constraint | Ledger rule it enforces | Example |
|---|---|---|
| `NOT NULL` | A transfer always has an amount, a currency and an idempotency key | `amount_minor bigint NOT NULL` |
| `UNIQUE` | One idempotency key gives at most one transfer | `idempotency_key_id ... UNIQUE` |
| Partial unique index | One **live** account per email; a deleted user's email can be reused | `CREATE UNIQUE INDEX ... (tenant_id, email) WHERE deleted_at IS NULL` |
| `CHECK` (one column) | Money moves in positive amounts | `CHECK (amount_minor > 0)` |
| `CHECK` (several columns) | A closed wallet records when it closed | `CHECK ((status = 'closed') = (closed_at IS NOT NULL))` |
| `FOREIGN KEY` | A transfer's wallets exist, in the same tenant, and hold that currency | `FOREIGN KEY (source_wallet_id, currency) REFERENCES wallet_balances` |
| `EXCLUDE` | Two limit periods for one wallet never overlap | `EXCLUDE USING gist (wallet_id WITH =, valid_during WITH &&)` |
| Trigger (for what constraints cannot say) | Ledger entries and history are never edited | `BEFORE UPDATE OR DELETE ... forbid_update_delete()` |

**Minimal version: what a rejected write looks like.** Three bad writes typed into `psql`. **Real output** (`sql/psql-by-hand.sql`):

```text
ERROR:  new row for relation "transfers" violates check constraint "transfers_amount_minor_check"
DETAIL:  Failing row contains (aaaaaaaa-0000-7000-8000-000000000000, 01a139ca-cf14-78bb-9a56-e39b48efc7eb, aaaaaaaa-0000-7000-8000-0000000000d1, aaaaaaaa-0000-7000-8000-0000000000d2, INR, 0, completed, null, 2, 2026-10-14 09:42:35.027615+00).
ERROR:  insert or update on table "transfers" violates foreign key constraint "transfers_tenant_id_destination_wallet_id_fkey"
DETAIL:  Key (tenant_id, destination_wallet_id)=(aaaaaaaa-0000-7000-8000-000000000000, bbbbbbbb-0000-7000-8000-0000000000d3) is not present in table "wallets".
ERROR:  ledger_entries is append-only: UPDATE is not allowed
CONTEXT:  PL/pgSQL function forbid_update_delete() line 3 at RAISE
```

**What to notice**
- Each error names the exact constraint. That is why we name important constraints (`transfers_not_to_self`, `wallet_limits_no_overlap`): the app can map a constraint name to a clear Problem Details `code` (P1-03).
- The `DETAIL` line of a CHECK error prints the **whole row**. If that row holds personal data, it ends up in your logs. Log the constraint name and the SQLSTATE code, not the raw message (P1-06).

**Foreign keys: choose `ON DELETE` on purpose.** The default (`NO ACTION`) is rarely a decision anyone made.

| `ON DELETE` | Meaning | Use it for | Ledger example |
|---|---|---|---|
| `RESTRICT` | Refuse to delete the parent while children exist; checked immediately | Parents whose children are money or history | `wallets → accounts`, `transfers → wallets`, `ledger_entries → transfers` |
| `NO ACTION` (default) | Like RESTRICT, but checked at the end of the statement (or at commit, if deferred) | When a transaction may fix things before it ends | rarely, on purpose |
| `CASCADE` | Delete the children too | Children that mean nothing without the parent | `kyc_profiles → users`, `account_members → accounts` |
| `SET NULL` | Keep the child, forget the parent | Optional links | an "assigned support agent" column |

In the lab, deleting an account that still has wallets failed with SQLSTATE `23001` (restrict_violation), while plain foreign-key failures give `23503`. Your error mapper can treat them differently.

**Why constraints, not only application code?** (Question 2 from the card.) Because the app is not the only writer. Migrations, backfill scripts, a second service, a support engineer in `psql`, and the app itself with a bug all write to the same tables. Two concurrent requests can also both pass an "is it unique?" check in code; only a unique index decides that race correctly. And a constraint is documentation that cannot go out of date: it is checked on every write.

**Adding constraints to big, existing tables** (Optional advanced understanding). `ALTER TABLE ... ADD CONSTRAINT ... CHECK (...) NOT VALID` adds the rule for new rows without scanning old ones; `VALIDATE CONSTRAINT` checks the old rows later with a lighter lock. That is how teams add rules to tables with crores of rows without downtime (P2-09 and the migrations cards go deeper).

**Trade-off.** Every constraint costs a little on each write (a foreign key is an index lookup in the parent). That cost is tiny next to cleaning up bad data later. The real cost is flexibility: changing a rule now needs a migration, which is exactly the review step a business rule deserves.

### 5. Data types: money, time, text and statuses

**Money: `bigint` minor units, not floats.**

```ts
// minimal/float-money.ts — why money is never a float. Run: npx tsx minimal/float-money.ts
const chaiPrice = 0.1; // Rs 0.10 as a float... except 0.1 has no exact binary form

console.log("0.1 + 0.2 =", 0.1 + 0.2);
console.log("0.1 + 0.2 === 0.3 ?", 0.1 + 0.2 === 0.3);

// Ten lakh UPI cashbacks of Rs 0.10 each. The right answer is exactly Rs 1,00,000.
let asFloat = 0;
let asPaise = 0; // integer minor units
for (let i = 0; i < 1_000_000; i++) {
  asFloat += chaiPrice;
  asPaise += 10;
}
console.log("float total:", asFloat, "| paise total:", asPaise, "=", `Rs ${(asPaise / 100).toLocaleString("en-IN")}`);
console.log("float total === 100000 ?", asFloat === 100_000);

// Floats also round in surprising places when you convert for display or storage.
console.log("(1.005).toFixed(2) =", (1.005).toFixed(2), "  <- expected 1.01");
console.log("(2.675).toFixed(2) =", (2.675).toFixed(2), "  <- expected 2.68");

// Integers are exact up to Number.MAX_SAFE_INTEGER. In paise that is a very large amount of money.
console.log("largest exact paise value:", Number.MAX_SAFE_INTEGER.toLocaleString("en-IN"),
  `= Rs ${(Number.MAX_SAFE_INTEGER / 100 / 1e7).toLocaleString("en-IN", { maximumFractionDigits: 0 })} crore`);
```

**Real output:**

```text
0.1 + 0.2 = 0.30000000000000004
0.1 + 0.2 === 0.3 ? false
float total: 100000.00000133288 | paise total: 10000000 = Rs 1,00,000
float total === 100000 ? false
(1.005).toFixed(2) = 1.00   <- expected 1.01
(2.675).toFixed(2) = 2.67   <- expected 2.68
largest exact paise value: 9,00,71,99,25,47,40,991 = Rs 90,07,199 crore
```

And inside Postgres. **Real output** (`sql/money-types.sql`):

```text
-- ten lakh additions of Rs 0.10
   float8_rupees    | numeric_rupees | bigint_paise 
--------------------+----------------+--------------
 100000.00000133288 |       100000.0 |     10000000

-- bytes per value
 bigint_bytes | numeric_bytes | longer_numeric_bytes | float8_bytes 
--------------+---------------+----------------------+--------------
            8 |             8 |                   14 |            8

-- the trap: a numeric literal is ROUNDED into a bigint column before any CHECK runs
 10.5 becomes | 10.4 becomes 
--------------+--------------
           11 |           10
```

**What to notice**
- Floats are wrong for money in JavaScript **and** in SQL. `toFixed` rounding is wrong too.
- `bigint` paise are exact up to about ₹90 lakh crore (computed above), far beyond any wallet.
- The last query is a real trap: a numeric literal like `10.5` is **rounded** into a `bigint` column before any CHECK runs. The lab's harness shows the safer path: node-postgres sends parameters as text, and `'10.5'` is rejected with `22P02`. So keep amounts as integers all the way from the API (P1-06) to the database.

**bigint or numeric?** Summing 20 lakh amounts, measured three times each (**Real output**, `sql/money-speed.sql`, times in ms):

```text
Time: 134.155 ms
Time: 200.465 ms
Time: 105.050 ms
Time: 216.286 ms
Time: 181.420 ms
Time: 250.858 ms
```

Alternate lines are `bigint` and `numeric(14,2)`. The medians are 134 ms for `bigint` and 216 ms for `numeric`, about 1.6 times slower. `numeric` is exact and fine for money too; it is just bigger for long values (14 bytes for `123456789012.34` above) and slower. Use:
- **`bigint` minor units** for balances and amounts that move. Store the currency next to it, because the minor unit differs: INR and USD have 2 decimals, JPY has 0, BHD has 3. Our `currencies.minor_unit` column holds that.
- **`numeric`** for values that are not whole paise: FX rates, interest rates, a 0.18% fee before rounding. Round to minor units with a written rule (half-up, or banker's rounding) at the moment the money is posted.
- **Never** `real`/`float8`, and never Postgres's `money` type (it has no currency, as the PostgreSQL wiki notes).

**Time: `timestamptz`, almost always.** Despite the name, `timestamptz` does not store a time zone. It stores an exact **moment** (in UTC) and shows it in the session's zone. `timestamp` stores a wall-clock reading with no zone at all. Both take 8 bytes (shown in the problem section).

| Type | Stores | Use for |
|---|---|---|
| `timestamptz` | An exact moment | Everything that happened: `created_at`, `changed_at`, `occurred_at` |
| `timestamp` | A wall-clock reading, no zone | Rare: "the shop opens at 09:00 local time", every day |
| `date` | A calendar date | Date of birth, statement period boundaries |
| `tstzrange` | A period between two moments | Validity ranges (Deep dive 7) |

One more detail: `now()` returns the **start time of the transaction**, the same value for every row in it. That is usually what you want (one transfer, one time). Use `clock_timestamp()` when you need the real current time inside a long transaction.

**Text: `text` plus a named CHECK, not `varchar(n)`.** In Postgres, `text` and `varchar(n)` are stored the same way. The length limit is a business rule, so write it as one: `note text CHECK (char_length(note) BETWEEN 1 AND 140)`. Changing a limit is then a constraint change with a clear name, and the CHECK can also enforce a minimum (no empty notes) and a pattern (`slug ~ '^[a-z0-9-]{3,40}$'`). Avoid `char(n)`: it pads with spaces.

**Statuses: enum, lookup table or CHECK?** Postgres enums are fast and compact, but awkward to change. **Real output** (`sql/enum-vs-lookup.sql`):

```text
psql:sql/enum-vs-lookup.sql:7: ERROR:  unsafe use of new value "closed" of enum type wallet_status_enum at character 8
psql:sql/enum-vs-lookup.sql:8: ERROR:  dropping an enum value is not implemented at character 31
```

| | `CREATE TYPE ... AS ENUM` | Lookup table + FK | `text` + `CHECK (... IN ...)` |
|---|---|---|---|
| Add a value | `ALTER TYPE ADD VALUE`; not usable inside the same transaction | `INSERT` a row | Replace the CHECK in a migration |
| Remove a value | Not supported; recreate the type | `UPDATE ... SET is_active = false` | Replace the CHECK |
| Extra data per value | No | Yes (`minor_unit`, display name) | No |
| Good for | Small sets that never shrink | Reference data with attributes: currencies, countries | Small internal state sets: wallet status |

Our schema uses a **lookup table** for currencies (they carry a minor unit and can be retired) and **CHECK** lists for internal statuses.

**Also:** store UUIDs as `uuid` (16 bytes), not `text` (37 bytes, and no format check). Use `jsonb` only for data you will not constrain or query by field often, like `audit_log.details`.

### 6. Lifecycle columns: created_at, updated_at, version, and soft vs hard delete

**What they are.** Columns that describe a row's life, not the business data:
- **`created_at timestamptz NOT NULL DEFAULT now()`**: when the row was born. Set by the database, so no code path can forget it or lie about it.
- **`updated_at`**: when it last changed. A `BEFORE UPDATE` trigger sets it (`touch_updated_at()` in migration 001). Relying on every `UPDATE` statement to remember it does not work.
- **`version integer`**: a counter for optimistic concurrency (P1-03's `ETag` / `If-Match`). A trigger bumps it on every update, and writers still compare it: `UPDATE wallets SET ... WHERE id = $1 AND version = $2`. Zero rows updated means someone else changed it first.
- **`deleted_at timestamptz`**: set instead of deleting the row (soft delete).

**Soft vs hard delete.**

| | Soft delete (`deleted_at`) | Hard delete (`DELETE`) |
|---|---|---|
| Undo | Easy: clear `deleted_at` | Only from backups |
| History and audit | Rows other tables point to still exist | Foreign keys block it, or cascade away history |
| Every query | Must remember `WHERE deleted_at IS NULL` | Nothing to remember |
| Uniqueness | Needs **partial** unique indexes | Plain `UNIQUE` works |
| Personal data | Still stored, which may break privacy promises | Gone |

**On a ledger, the honest answer is "it depends on the table":**
- **Money rows** (`transfers`, `ledger_entries`) are never deleted, soft or hard. Corrections are new rows (a reversal). Indian anti-money-laundering rules (PMLA) and RBI's KYC directions require regulated entities to keep transaction and identification records for at least five years; many banks keep them longer.
- **People** (`users`) are soft-deleted, and their personal fields can be erased or anonymised when the law requires it (the Digital Personal Data Protection Act, 2023 gives people erasure rights, within legal retention duties). The row and its id stay, so history still makes sense.
- **Pure join rows** (`account_members`) can be hard-deleted: removing Priya's viewer access is not a fact we must keep in the row itself. The audit log records that it happened.

The partial unique index is what makes soft delete work with uniqueness. Case 5 of the lab's harness proves it: after Riya's user row is soft-deleted, a new user with `riya@ledger.test` is accepted, while case 2 shows that a second **live** user with that email (in any letter case) is rejected.

**Trade-off.** Soft delete means every query must filter out deleted rows. Put that filter in one place, a view such as `live_users` (or row-level security, P7-06), instead of trusting every query to remember it.

### 7. Modelling history: append-only tables, status history and validity ranges

**What it is.** Money systems must answer "what was true then?", not only "what is true now?". Three patterns do this.

**Pattern 1: append-only tables.** `ledger_entries` and `audit_log` only get `INSERT`s. Mistakes are fixed by adding a new row (a reversal entry, a correcting audit event), never by editing. We enforce this with a trigger that raises an error on `UPDATE` or `DELETE` (cases 34, 35, 41 and 44 in the lab). In production, also `REVOKE UPDATE, DELETE` on these tables from the app's database role (P1-06's least privilege), so even a bypassed trigger does not help.

**Pattern 2: a status-history table.** Every status change is a new row with the new status, a reason, who made it and when. The current status is the latest row. Nothing is ever overwritten, so nothing is lost.

**Diagram: a wallet's status lifecycle**

```mermaid
stateDiagram-v2
  [*] --> active: wallet opened
  active --> frozen: risk or support action
  frozen --> active: issue resolved
  active --> closed: customer closes it
  frozen --> closed: closed after review
  closed --> [*]
```

**How to read this diagram.** Each arrow is one row in `wallet_status_history`. A wallet can go between `active` and `frozen` many times; each trip adds rows. `closed` is final: there is no arrow out of it except the end. The lab's repository refuses to reopen a closed wallet, and its test proves it.

**"What was the status on 6 October?"** is the latest row at or before that moment. **Real output** (`sql/status-history.sql`, a wallet with four back-dated changes):

```text
-- status as of a past moment: the latest change at or before it
           as_of           | status |                 reason                 
---------------------------+--------+----------------------------------------
 2026-08-15 12:00:00+05:30 |        | 
 2026-10-06 12:00:00+05:30 | frozen | login from a new device, 3 failed OTPs
 2026-10-10 12:00:00+05:30 | active | KYC re-verified at branch
 2026-10-13 12:00:00+05:30 | frozen | chargeback dispute opened
```

On 15 August the wallet did not exist yet, so there is no row, and the query honestly returns nothing.

**Pattern 3: validity ranges.** Some facts are true **for a period**: a daily limit, a fee plan, a KYC level. Store the period as a range, `[valid_from, valid_to)`, and forbid overlaps.

```text
wallet_limits for Riya's wallet (half-open ranges: start included, end excluded)
  Oct 01 00:00 ───────── Rs 1,00,000/day ─────────▶ Nov 01 00:00
                                                    Nov 01 00:00 ── Rs 50,000/day ──▶ Dec 01 00:00
  A new row for Oct 15 → Nov 15 would overlap both  ✗ rejected (EXCLUDE constraint)
```

**How to read this diagram.** Time runs left to right. The first period ends exactly where the second begins. Because ranges are half-open (`[start, end)`), midnight on 1 November belongs only to the second period: no gap, no overlap. Lab cases 42 and 43 prove both halves: the overlapping row is rejected with `23P01`, and the adjacent one is accepted.

The rule "no two periods for one wallet overlap" is one line, an **exclusion constraint**:

```sql
CONSTRAINT wallet_limits_no_overlap EXCLUDE USING gist (wallet_id WITH =, valid_during WITH &&)
```

It reads: "no two rows may have equal `wallet_id` **and** overlapping (`&&`) `valid_during`". The `btree_gist` extension lets one GiST index handle the `=` on a uuid.

**PostgreSQL 18 shortcut** (Optional advanced understanding). PostgreSQL 18 added **temporal constraints**: `PRIMARY KEY (wallet_id, valid_during WITHOUT OVERLAPS)` says the same thing, and foreign keys can use `PERIOD` to require that a referenced row covers the whole period. **Real output** (`sql/temporal-pg18.sql`):

```sql
-- sql/temporal-pg18.sql — PostgreSQL 18: the same "no overlapping periods" rule, declared as a primary key.
\set ON_ERROR_ROLLBACK on
\set VERBOSITY terse
\pset footer off
BEGIN;
CREATE TABLE fee_plans (
  wallet_id    uuid NOT NULL REFERENCES wallets (id),
  fee_bps      integer NOT NULL CHECK (fee_bps BETWEEN 0 AND 1000),   -- basis points: 25 = 0.25%
  valid_during tstzrange NOT NULL,
  PRIMARY KEY (wallet_id, valid_during WITHOUT OVERLAPS));
INSERT INTO fee_plans VALUES ('aaaaaaaa-0000-7000-8000-0000000000d1', 25, '[2026-10-01 00:00+05:30, 2026-11-01 00:00+05:30)');
INSERT INTO fee_plans VALUES ('aaaaaaaa-0000-7000-8000-0000000000d1', 20, '[2026-10-20 00:00+05:30, 2026-12-01 00:00+05:30)');
INSERT INTO fee_plans VALUES ('aaaaaaaa-0000-7000-8000-0000000000d1', 20, '[2026-11-01 00:00+05:30, 2026-12-01 00:00+05:30)');
SELECT fee_bps FROM fee_plans WHERE wallet_id = 'aaaaaaaa-0000-7000-8000-0000000000d1' AND valid_during @> timestamptz '2026-11-15 12:00+05:30';
ROLLBACK;
```

```text
psql:sql/temporal-pg18.sql:12: ERROR:  conflicting key value violates exclusion constraint "fee_plans_pkey"
 fee_bps 
---------
      20
```

The overlapping fee plan was rejected; the as-of lookup with `@>` ("range contains this moment") found the November plan.

**Which pattern?** Events (pattern 2) are simplest to write and never conflict. Ranges (pattern 3) make "true during" questions easy. You can have both: we store status **events** and derive **periods** with a view (`wallet_status_periods`, using the `lead()` window function), so the data is stored once:

```text
-- the same history as periods (the wallet_status_periods view)
 status |        valid_from         |         valid_to          |                 reason                 
--------+---------------------------+---------------------------+----------------------------------------
 active | 2026-09-01 10:00:00+05:30 | 2026-10-05 18:30:00+05:30 | wallet opened
 frozen | 2026-10-05 18:30:00+05:30 | 2026-10-07 11:00:00+05:30 | login from a new device, 3 failed OTPs
 active | 2026-10-07 11:00:00+05:30 | 2026-10-12 09:15:00+05:30 | KYC re-verified at branch
 frozen | 2026-10-12 09:15:00+05:30 |                           | chargeback dispute opened
```

**When not to use history tables.** For data nobody will ask about historically, like a user's UI theme. History costs storage forever, so keep it for facts with money, legal or support value.

### 8. Tenant keys: `tenant_id` on every row

**What it is.** A **tenant** is one customer organisation. Today the ledger serves one company; tomorrow it may run white-label wallets for several (P7-06). Adding `tenant_id` later means rewriting every table, every index and every query. Adding it now is cheap.

**The trick: composite foreign keys.** A `tenant_id` column alone does not stop a wallet in tenant A from pointing at an account in tenant B. Including `tenant_id` **in the foreign key** does:

```sql
-- parent: offer (tenant_id, id) as a target
CREATE TABLE accounts (tenant_id uuid NOT NULL, id uuid PRIMARY KEY, UNIQUE (tenant_id, id) /* ... */);
-- child: the pair must match, so the account must be in the SAME tenant
CREATE TABLE wallets (
  tenant_id uuid NOT NULL, id uuid PRIMARY KEY, account_id uuid NOT NULL,
  FOREIGN KEY (tenant_id, account_id) REFERENCES accounts (tenant_id, id) ON DELETE RESTRICT /* ... */
);
```

Lab cases 7, 12, 19 and 26 try four different cross-tenant writes: a KYC profile, a membership, a wallet and a transfer. The database rejected all four.

**Rules for tenant keys:**
- Every tenant-owned table gets `tenant_id NOT NULL`, and every reference between tenant-owned tables includes it.
- Global reference data (`currencies`) has no `tenant_id`. Say so in a comment, so nobody "fixes" it.
- Unique rules are usually per tenant: `UNIQUE (tenant_id, email)`, not `UNIQUE (email)`.
- Later (P7-06): row-level security policies on `tenant_id`, and maybe sharding by it. Both are much easier when the column is already everywhere.

**Trade-off.** Wider foreign keys and indexes (one more UUID), and one more column in every query. That is the price of making cross-tenant leaks impossible to store.

### 9. Access-pattern thinking: design from the queries

**What it is.** Nouns give you tables. **Queries** tell you whether those tables work. Before writing a migration, list the questions the product must answer, how often, and how fast.

| # | Query the product must serve | How often | Shape that serves it |
|---|---|---|---|
| Q1 | Riya's balance right now | Every app open; lakhs a day | Stored balance in `wallet_balances` (one row by PK), not a SUM |
| Q2 | Last 50 transactions of a wallet, newest first | Very often | `ledger_entries_by_wallet (wallet_id, created_at DESC, id DESC)`: keyset pagination from P1-03 |
| Q3 | Find the transfer for an idempotency key | Every POST | `UNIQUE (tenant_id, client_id, key)` |
| Q4 | Which accounts can this user see? | Every request (authorisation, P1-05) | `account_members_by_user (user_id)` |
| Q5 | Wallet status on a past date | Disputes, support | `wallet_status_history_as_of (wallet_id, changed_at DESC, id DESC)` |
| Q6 | Which wallets were frozen during a given week? | Risk reports | `wallet_status_periods` view; range overlap `&&` |
| Q7 | Everything that happened to one transfer | Support, audits | `audit_log_by_entity (entity_type, entity_id, occurred_at DESC)` |
| Q8 | Month-end totals per tenant | Once a month | Not on the hot path: a read replica or warehouse (P2-02, Phase 4) |

Every index in the schema exists because of a row in this table. The as-of lookup (Q5) really uses its index. **Real output** (from `sql/status-history.sql`):

```text
-- the plan for the as-of lookup uses the (wallet_id, changed_at DESC, id DESC) index
                                                 QUERY PLAN                                                 
------------------------------------------------------------------------------------------------------------
 Limit
   ->  Index Scan using wallet_status_history_as_of on wallet_status_history
         Index Cond: ((wallet_id = 'aaaaaaaa-0000-7000-8000-0000000000d9'::uuid) AND (changed_at <= now()))
```

**When it matters most.** When two designs look equally clean. "Store the balance or compute it?" has no answer from nouns. Q1's frequency answers it.

**Trade-off.** Designing only from today's queries can over-fit. Keep the normalised source of truth, and add read-shaped copies (indexes, balances, views) on top. Those are cheap to change; the source of truth is not.

---

## ⚖️ Comparisons and trade-offs

**ID types (from lab step 4, PostgreSQL 18.4, 10 lakh rows, median of 3 runs)**

| | bigint identity | UUIDv4 | UUIDv7 |
|---|---|---|---|
| Size of one key | 8 bytes | 16 bytes | 16 bytes |
| Insert rate, shared_buffers 256 MB | **2,75,269 rows/s** | 1,17,295 rows/s | 2,00,109 rows/s |
| Insert rate, shared_buffers 16 MB (index bigger than cache) | 2,68,241 rows/s | **95,378 rows/s** | 1,94,404 rows/s |
| Primary-key index size | **21.4 MiB** | 37.7 MiB | 30.1 MiB |
| Index leaf pages full (`avg_leaf_density`) | 90.0% | 71.9% | 90.0% |
| Index pages read from outside the cache (16 MB run) | 1 | **2,35,735** | 1 |
| WAL written | 158 MiB | 185 MiB | 172 MiB |
| Safe in URLs | No (guessable, leaks volume) | Yes | Yes (leaks creation time) |
| Can be created in the app before insert | No | Yes | Yes |

Computed from those numbers: UUIDv7 inserted 1.71 times as fast as UUIDv4 with a big cache and 2.04 times with a small one; UUIDv4's index was 1.25 times UUIDv7's; UUIDv7's was 1.41 times bigint's. The 90% leaf density for increasing keys is Postgres's default B-tree fillfactor.

**Money types**

| | `bigint` minor units | `numeric(p,s)` | `float8` / `real` | `money` |
|---|---|---|---|---|
| Exact | Yes | Yes | **No** | Yes, but one fixed currency setting |
| Size | 8 bytes | Variable (8-14+ bytes) | 8 bytes | 8 bytes |
| SUM of 20 lakh rows (lab) | 134 ms | 216 ms | — | — |
| Use for | Balances, amounts | Rates, fractional calculations | Never for money | Never |

**Time types:** `timestamptz` for moments (both rows in the problem section are one instant); `timestamp` only for wall-clock rules; `date` for calendar dates.

**History patterns**

| | Append-only events | Validity ranges | Audit log | PG18 temporal keys |
|---|---|---|---|---|
| Answers | "What changed, when, why" | "What was true during X" | "Who did what" | Same as ranges, declared as a key |
| Writes | Insert only | Close the old period, open a new one | Insert only | Same as ranges |
| Enforced by | Trigger + REVOKE | `EXCLUDE` constraint | Trigger + REVOKE | `WITHOUT OVERLAPS` |
| Lab table | `wallet_status_history` | `wallet_limits` | `audit_log` | `fee_plans` demo |

**Deleting things:** money rows never; people soft-deleted and anonymised; join rows hard-deleted with an audit event (Deep dive 6).

**Status values:** lookup table for reference data with attributes; `CHECK` lists for internal states; enums only for sets that never shrink (Deep dive 5).

---

## 🚶 Walkthrough on the ledger platform: freezing a wallet, and the dispute a week later

On 5 October at 6:30 pm, the risk team freezes one of Amit Stores' wallets after three failed OTPs from a new phone. On 7 October it is unfrozen after KYC re-verification. On 14 October, a customer disputes a payment from 6 October and asks: was that wallet frozen at the time?

1. **A support agent clicks "Freeze"** with the reason "login from a new device, 3 failed OTPs". The API validates the request at the edge (P1-06) and calls `changeWalletStatus`.
2. **One transaction begins.** `SELECT ... FROM wallets WHERE id = $1 FOR UPDATE` locks the wallet row, so a second agent's click waits instead of racing.
3. **Rules are checked.** The wallet exists and is not closed (a closed wallet cannot be reopened). If it is already frozen, nothing is written: no fake history.
4. **The current status changes.** `UPDATE wallets SET status = 'frozen'`. The triggers set `updated_at` and bump `version`, and `wallets_closed_has_closed_at` still holds.
5. **A history row is added.** `INSERT INTO wallet_status_history (wallet_id, status, reason, changed_by)`. `changed_at` defaults to `now()`. The status `CHECK` rejects anything outside `active`, `frozen` or `closed`.
6. **An audit row is added** with the old and new status in `details`. Then `COMMIT`: all three writes become visible together, or none of them do.
7. **Two days later** the wallet is unfrozen the same way: one more history row and one more audit row. Nothing is overwritten.
8. **The dispute.** Support asks for the status as of 6 October, 12:00. The as-of query reads the latest history row at or before that moment, using the `(wallet_id, changed_at DESC, id DESC)` index.
9. **The answer** is `frozen`, with the reason and who froze it. Even if someone tries to "clean up" the history in `psql`, the append-only trigger refuses.

**Diagram: the walkthrough, step by step**

```mermaid
sequenceDiagram
  participant Agent as Support agent
  participant API as Wallet API
  participant DB as Postgres
  participant Ops as Dispute team
  Agent->>API: 1. Freeze, reason given
  API->>DB: 2. BEGIN, lock wallet row
  API->>DB: 3. Check exists and not closed
  API->>DB: 4. UPDATE wallets status frozen
  API->>DB: 5. INSERT status history row
  API->>DB: 6. INSERT audit row, COMMIT
  Agent->>API: 7. Unfreeze two days later
  API->>DB: same steps, more rows
  Ops->>DB: 8. Status as of 6 Oct noon?
  DB-->>Ops: 9. frozen, with reason and agent
```

**How to read this diagram.** Time runs downwards, and the numbers match the list. Steps 2-6 are one transaction: the current status, the history and the audit trail can never disagree. Step 7 repeats the pattern. Steps 8-9 are a read that only works because steps 5 and 7 added rows instead of overwriting one.

---

## 🧪 Hands-on lab

You will build the ledger schema as migrations, attack it with bad data through `psql`, benchmark three ID types on 10 lakh rows, and query a wallet's status history. Everything below was applied to PostgreSQL 18.4 and tested while writing this guide.

**Prerequisites:** Docker, Node 22+, and a `psql` client (or use the one inside the container). This lab is a fresh database, not the P1 codebase, so it runs on its own; the tables match what the P1 cards built.

**Project layout**

```text
ledger-schema/
├── db/migrations/
│   ├── 001_foundation.sql        # extensions, trigger functions, tenants, currencies
│   ├── 002_identity.sql          # users, kyc_profiles, accounts, account_members
│   ├── 003_wallets.sql           # wallets, wallet_balances, status history, limits, periods view
│   ├── 004_money_movement.sql    # idempotency_keys, transfers, ledger_entries
│   └── 005_audit.sql             # audit_log
├── run-migrations.sh             # drop, recreate, migrate
├── test/sql/{fixtures,bad-data,cases}.sql   # step 3
├── bench/idTypes.ts              # step 4
├── sql/*.sql                     # the small demos used in the Deep dive
├── src/repositories/walletStatusRepository.ts   # step 5
└── test/walletStatus.test.ts     # step 5
```

**`docker-compose.yml`** (PostgreSQL 18, for the built-in `uuidv7()`; the lab's data is throwaway, so there is no volume):

```yaml
services:
  postgres:
    image: postgres:18
    environment:
      POSTGRES_PASSWORD: postgres
    ports: ["5432:5432"]
    command: ["postgres", "-c", "shared_buffers=256MB"]
```

**Set up**

```bash
docker compose up -d
export PGHOST=localhost PGPORT=5432 PGUSER=postgres PGPASSWORD=postgres
export DATABASE_URL=postgres://postgres:postgres@localhost:5432/ledger
npm init -y && npm pkg set type=module
npm install pg
npm install -D typescript@5 tsx vitest @types/pg @types/node
```

`btree_gist`, `citext` and `pgstattuple` ship with the official image; the migrations create the first two and the runner creates the third.

### Step 1 · Draw the ER diagram

Draw it on paper **before** reading the migrations: users, wallets, transfers, ledger entries, idempotency keys and the audit log, with a line for every foreign key and the cardinality at each end. Then compare with the three diagrams in Deep dive 1 (identity and ownership, money movement, history and audit).

Check your drawing against these questions:
- Where does `tenant_id` appear, and which table has none? (Answer: `currencies`.)
- Which relationship is one-to-one, and what makes it one-to-one? (`kyc_profiles.user_id` is both PK and FK; also `transfers.idempotency_key_id` is UNIQUE.)
- Which table's id never appears in a URL, and so uses a bigint key?

### Step 2 · Migrations with every constraint

The runner (plumbing, but short): it drops and recreates the database, then applies the files in order.

```bash
#!/bin/sh
# run-migrations.sh — recreate the lab database and apply every migration in order.
# Uses the usual PG* variables: PGHOST, PGPORT, PGUSER, PGPASSWORD.
set -e
psql -X -q -d postgres -c "DROP DATABASE IF EXISTS ledger" -c "CREATE DATABASE ledger"
for f in db/migrations/*.sql; do psql -X -q -d ledger -v ON_ERROR_STOP=1 -f "$f"; done
psql -X -q -d ledger -c "CREATE EXTENSION IF NOT EXISTS pgstattuple"   # used by the benchmark
```

**`db/migrations/001_foundation.sql`**: extensions, three shared trigger functions, tenants, and the currency lookup table.

```sql
-- db/migrations/001_foundation.sql — extensions, shared trigger functions, tenants and the currency lookup table.
CREATE EXTENSION IF NOT EXISTS citext;     -- case-insensitive text for emails
CREATE EXTENSION IF NOT EXISTS btree_gist; -- lets one GiST index mix "=" on uuid with "&&" on ranges

-- updated_at is set by the database, so no code path can forget it.
CREATE FUNCTION touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- Every UPDATE bumps version. Writers still compare it: UPDATE ... WHERE id = $1 AND version = $2 (P1-03).
CREATE FUNCTION bump_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.version := OLD.version + 1;
  RETURN NEW;
END $$;

-- Append-only tables: history is added to, never edited. Corrections are new rows.
CREATE FUNCTION forbid_update_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation', CONSTRAINT = TG_TABLE_NAME || '_append_only';
END $$;

CREATE TABLE tenants (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  slug       text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9-]{3,40}$'),
  name       text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- A lookup table, not an enum: rows can be added, retired and carry data (the minor unit).
-- Global reference data, so no tenant_id.
CREATE TABLE currencies (
  code       text PRIMARY KEY CHECK (code ~ '^[A-Z]{3}$'),           -- ISO 4217: exactly three capitals
  minor_unit smallint NOT NULL CHECK (minor_unit BETWEEN 0 AND 4),     -- INR 2 (paise), JPY 0, BHD 3
  name       text NOT NULL,
  is_active  boolean NOT NULL DEFAULT true
);
INSERT INTO currencies (code, minor_unit, name) VALUES
  ('INR', 2, 'Indian rupee'), ('USD', 2, 'US dollar'), ('JPY', 0, 'Japanese yen'), ('BHD', 3, 'Bahraini dinar');
```

**What to notice**
- `forbid_update_delete()` raises with SQLSTATE `restrict_violation` and a **constraint name**, so an append-only violation looks like any other constraint error to the app.
- `currencies` has a natural key (`INR`), a `CHECK` on its shape, and data per value (`minor_unit`). That is why it is a lookup table, not an enum.

**`db/migrations/002_identity.sql`**: users with soft delete, the one-to-one KYC profile, accounts and the many-to-many members table.

```sql
-- db/migrations/002_identity.sql — who: users (soft delete), their KYC profile (1:1), accounts and members (M:N).
CREATE TABLE users (
  tenant_id     uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  email         citext NOT NULL CHECK (char_length(email) <= 254),
  password_hash text,                                                  -- NULL for Google-only users (P1-05)
  phone_e164    text CHECK (phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),      -- E.164, the same rule as the API (P1-06)
  role          text NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'support', 'admin')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz,                                           -- soft delete: the row stays for history
  UNIQUE (tenant_id, id)                                               -- target for same-tenant foreign keys
);
-- One LIVE account per email per tenant. A deleted user's email can be used again.
CREATE UNIQUE INDEX users_email_live ON users (tenant_id, email) WHERE deleted_at IS NULL;
CREATE TRIGGER users_touch BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- One-to-one: the primary key IS the foreign key, so a user can have at most one profile.
CREATE TABLE kyc_profiles (
  tenant_id   uuid NOT NULL,
  user_id     uuid PRIMARY KEY,
  kyc_level   text NOT NULL CHECK (kyc_level IN ('minimum', 'full')),
  legal_name  text NOT NULL CHECK (char_length(legal_name) BETWEEN 1 AND 200),
  verified_at timestamptz,
  CONSTRAINT kyc_full_needs_verified_at CHECK ((kyc_level = 'full') = (verified_at IS NOT NULL)),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id) ON DELETE CASCADE
);

-- An account is the "party" that owns money: a person or a business like Riya Traders.
CREATE TABLE accounts (
  tenant_id    uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  kind         text NOT NULL CHECK (kind IN ('personal', 'business')),
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 100),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE TRIGGER accounts_touch BEFORE UPDATE ON accounts FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Many-to-many: a join table with its own data (the relation). Priya is Riya Traders' viewer (P1-05).
CREATE TABLE account_members (
  tenant_id  uuid NOT NULL,
  account_id uuid NOT NULL,
  user_id    uuid NOT NULL,
  relation   text NOT NULL CHECK (relation IN ('owner', 'viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, user_id),                                   -- a person joins an account once
  FOREIGN KEY (tenant_id, account_id) REFERENCES accounts (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX account_members_by_user ON account_members (user_id);     -- "which accounts can this user see?"
```

**What to notice**
- `UNIQUE (tenant_id, id)` looks redundant next to `PRIMARY KEY (id)`. It exists so that child tables can point at the **pair**, which keeps references inside one tenant.
- The email rule is a **partial** unique index on `citext`, so `Riya@Ledger.TEST` clashes with `riya@ledger.test`, and only live users count.
- `ON DELETE CASCADE` on `kyc_profiles` and `account_members`, because those rows mean nothing without their parent.

**`db/migrations/003_wallets.sql`**: wallets, balances (the card's `UNIQUE (wallet_id, currency)`), status history, limits and the periods view.

```sql
-- db/migrations/003_wallets.sql — wallets, their per-currency balances, status history and limits over time.
CREATE TABLE wallets (
  tenant_id  uuid NOT NULL,
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  account_id uuid NOT NULL,
  status     text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'frozen', 'closed')),
  nickname   text CHECK (char_length(nickname) BETWEEN 1 AND 60),
  version    integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  closed_at  timestamptz,
  CONSTRAINT wallets_closed_has_closed_at CHECK ((status = 'closed') = (closed_at IS NOT NULL)),
  UNIQUE (tenant_id, id),
  -- An account holding money must not vanish: delete its wallets first (which needs a zero balance).
  FOREIGN KEY (tenant_id, account_id) REFERENCES accounts (tenant_id, id) ON DELETE RESTRICT
);
CREATE INDEX wallets_by_account ON wallets (account_id);
CREATE TRIGGER wallets_touch BEFORE UPDATE ON wallets FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER wallets_version BEFORE UPDATE ON wallets FOR EACH ROW EXECUTE FUNCTION bump_version();

-- One balance row per wallet per currency. A DENORMALISED copy of SUM(ledger_entries), kept in step by the
-- transfer transaction and checked by a reconciliation query.
CREATE TABLE wallet_balances (
  wallet_id     uuid NOT NULL REFERENCES wallets (id) ON DELETE CASCADE,
  currency      text NOT NULL REFERENCES currencies (code),
  balance_minor bigint NOT NULL DEFAULT 0 CHECK (balance_minor >= 0),   -- no overdrafts on this product
  version       integer NOT NULL DEFAULT 1,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (wallet_id, currency)                                    -- the card's UNIQUE (wallet_id, currency)
);
CREATE TRIGGER wallet_balances_touch BEFORE UPDATE ON wallet_balances FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER wallet_balances_version BEFORE UPDATE ON wallet_balances FOR EACH ROW EXECUTE FUNCTION bump_version();

-- Status history as an append-only event log: every change is a new row; nothing is updated or deleted.
CREATE TABLE wallet_status_history (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  wallet_id  uuid NOT NULL REFERENCES wallets (id) ON DELETE RESTRICT,
  status     text NOT NULL CHECK (status IN ('active', 'frozen', 'closed')),
  reason     text NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 200),
  changed_by uuid,                                                      -- user or NULL for "system"; history keeps ids, not FKs
  changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX wallet_status_history_as_of ON wallet_status_history (wallet_id, changed_at DESC, id DESC);
CREATE TRIGGER wallet_status_history_append_only BEFORE UPDATE OR DELETE ON wallet_status_history
  FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();

-- Validity ranges: a daily limit that applies for a period. Overlapping periods for one wallet are impossible.
CREATE TABLE wallet_limits (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  wallet_id         uuid NOT NULL REFERENCES wallets (id) ON DELETE CASCADE,
  daily_limit_minor bigint NOT NULL CHECK (daily_limit_minor > 0),
  valid_during      tstzrange NOT NULL CHECK (NOT isempty(valid_during)), -- [valid_from, valid_to)
  CONSTRAINT wallet_limits_no_overlap EXCLUDE USING gist (wallet_id WITH =, valid_during WITH &&)
);

-- The same history as periods, derived (never stored twice): each status lasts until the next change.
CREATE VIEW wallet_status_periods AS
SELECT wallet_id, status, reason, changed_at AS valid_from,
       lead(changed_at) OVER (PARTITION BY wallet_id ORDER BY changed_at, id) AS valid_to   -- NULL = still current
FROM wallet_status_history;
```

**What to notice**
- `wallet_balances` is the one deliberate denormalisation: a copy of the entries' sum, with `CHECK (balance_minor >= 0)` as the last guard against overdrafts.
- `wallet_status_history` keeps `changed_by` as a plain id, with no foreign key: history must not block, or be deleted with, the user who made a change.
- The view stores nothing. Periods are computed from the events, so the two can never disagree.

**`db/migrations/004_money_movement.sql`**: idempotency keys, transfers and ledger entries.

```sql
-- db/migrations/004_money_movement.sql — idempotency keys (P1-03), transfers and ledger entries.
CREATE TABLE idempotency_keys (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id       uuid NOT NULL,
  client_id       uuid NOT NULL,                                        -- the user who sent the key (P1-05)
  key             text NOT NULL CHECK (key ~ '^[A-Za-z0-9_-]{16,255}$'),
  request_hash    bytea NOT NULL CHECK (octet_length(request_hash) = 32), -- SHA-256
  status          text NOT NULL CHECK (status IN ('processing', 'completed')),
  response_status smallint CHECK (response_status BETWEEN 100 AND 599),
  response_body   jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  CONSTRAINT idem_completed_has_response CHECK ((status = 'completed') = (response_status IS NOT NULL)),
  CONSTRAINT idem_expires_after_created CHECK (expires_at > created_at),
  UNIQUE (tenant_id, client_id, key),                                  -- the whole idempotency trick
  FOREIGN KEY (tenant_id, client_id) REFERENCES users (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE transfers (
  tenant_id             uuid NOT NULL,
  id                    uuid PRIMARY KEY DEFAULT uuidv7(),
  source_wallet_id      uuid NOT NULL,
  destination_wallet_id uuid NOT NULL,
  currency              text NOT NULL,
  amount_minor          bigint NOT NULL CHECK (amount_minor > 0),      -- the card's CHECK (amount > 0), in paise
  status                text NOT NULL CHECK (status IN ('completed', 'reversed')),
  note                  text CHECK (char_length(note) BETWEEN 1 AND 140),
  idempotency_key_id    bigint NOT NULL UNIQUE REFERENCES idempotency_keys (id) ON DELETE RESTRICT,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT transfers_not_to_self CHECK (source_wallet_id <> destination_wallet_id),
  UNIQUE (tenant_id, id),
  -- Same tenant on both sides, and both wallets must hold this currency (composite keys do both jobs).
  FOREIGN KEY (tenant_id, source_wallet_id) REFERENCES wallets (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, destination_wallet_id) REFERENCES wallets (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (source_wallet_id, currency) REFERENCES wallet_balances (wallet_id, currency) ON DELETE RESTRICT,
  FOREIGN KEY (destination_wallet_id, currency) REFERENCES wallet_balances (wallet_id, currency) ON DELETE RESTRICT
);
CREATE INDEX transfers_by_source ON transfers (source_wallet_id, created_at DESC, id DESC);
CREATE INDEX transfers_by_destination ON transfers (destination_wallet_id, created_at DESC, id DESC);

-- The money history. bigint keys: internal, the biggest table, never in a URL by itself.
CREATE TABLE ledger_entries (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id    uuid NOT NULL,
  transfer_id  uuid NOT NULL,
  wallet_id    uuid NOT NULL,
  currency     text NOT NULL,
  direction    text NOT NULL CHECK (direction IN ('debit', 'credit')),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (transfer_id, direction),                                     -- one debit and one credit per transfer (P2-09 generalises)
  FOREIGN KEY (tenant_id, transfer_id) REFERENCES transfers (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (wallet_id, currency) REFERENCES wallet_balances (wallet_id, currency) ON DELETE RESTRICT
);
CREATE INDEX ledger_entries_by_wallet ON ledger_entries (wallet_id, created_at DESC, id DESC);
CREATE TRIGGER ledger_entries_append_only BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();
```

**What to notice**
- `transfers` has four foreign keys for two wallets: one pair keeps both wallets in the transfer's tenant, the other pair makes sure both wallets **hold the currency**.
- `idempotency_key_id ... NOT NULL UNIQUE` turns P1-03's "one transfer per key" into a database fact.
- `ledger_entries` uses a bigint identity key. It is the largest table and is never fetched by its own id from a URL.

**`db/migrations/005_audit.sql`**: the audit log.

```sql
-- db/migrations/005_audit.sql — who did what, when. Append-only, and deliberately without foreign keys.
CREATE TABLE audit_log (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  actor_user_id uuid,                                                   -- NULL = the system (a job, a migration)
  action        text NOT NULL CHECK (action ~ '^[a-z_]+\.[a-z_]+$'),    -- e.g. wallet.freeze, transfer.create
  -- The one honest "polymorphic" reference: history points at things that may later be erased or archived.
  entity_type   text NOT NULL CHECK (entity_type IN ('user', 'account', 'wallet', 'transfer')),
  entity_id     uuid NOT NULL,
  details       jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(details) = 'object'),
  occurred_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_by_entity ON audit_log (entity_type, entity_id, occurred_at DESC);
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();
```

**What to notice**
- `entity_type` plus `entity_id` is a polymorphic reference: the pattern this card warns against for **relationships**. Here it is deliberate. An audit trail records facts about things that may later be archived or erased, so a foreign key would be wrong. The `CHECK` still limits `entity_type` to known values.

**Apply them:**

```bash
sh run-migrations.sh
psql -d ledger -c "SELECT contype, count(*) FROM pg_constraint WHERE connamespace = 'public'::regnamespace GROUP BY 1 ORDER BY 1"
```

**Real output** (constraint types: `c` CHECK, `f` foreign key, `n` NOT NULL, `p` primary key, `u` unique, `x` exclusion):

```text
 contype | count 
---------+-------
 c       |    36
 f       |    19
 n       |    82
 p       |    14
 u       |     8
 x       |     1
```

That is 160 constraints across 14 tables, plus the partial unique index on emails and three append-only triggers. PostgreSQL 18 now records `NOT NULL` constraints in `pg_constraint` too, which is why they show up as `n`.

**Every constraint and the business rule it enforces**

Each line below is a rule a product manager or compliance officer would recognise. The names are the ones you will see in error messages. (Plain primary keys and the `UNIQUE (tenant_id, id)` targets are listed once per table.)

| Table | Constraint | Business rule |
|---|---|---|
| tenants | `tenants_slug_check`, `tenants_slug_key` | A tenant's short name is lowercase, URL-safe and unique |
| tenants | `tenants_name_check` | A tenant has a real name, at most 100 characters |
| currencies | `currencies_code_check` | Currency codes look like ISO 4217: exactly three capital letters |
| currencies | `currencies_minor_unit_check` | A currency has 0 to 4 decimal places (JPY 0, INR 2, BHD 3) |
| users | `users_tenant_id_fkey` | Every user belongs to a real tenant; a tenant with users cannot be deleted |
| users | `users_email_live` (partial unique index) | One live account per email per tenant, ignoring letter case |
| users | `users_email_check` | Emails are at most 254 characters |
| users | `users_phone_e164_check` | Phone numbers are stored in E.164 (`+919876543210`) |
| users | `users_role_check` | A user is `user`, `support` or `admin`, nothing else |
| kyc_profiles | `kyc_profiles_pkey` | A user has at most one KYC profile |
| kyc_profiles | `kyc_profiles_tenant_id_user_id_fkey` | The profile belongs to a user in the same tenant; it is removed with the user |
| kyc_profiles | `kyc_profiles_kyc_level_check` | KYC is `minimum` or `full` |
| kyc_profiles | `kyc_full_needs_verified_at` | "Full KYC" always records when it was verified, and only then |
| kyc_profiles | `kyc_profiles_legal_name_check` | The legal name is present and at most 200 characters |
| accounts | `accounts_kind_check` | An account is `personal` or `business` |
| accounts | `accounts_display_name_check` | An account has a display name, at most 100 characters |
| account_members | `account_members_pkey` | A person is a member of an account at most once |
| account_members | `account_members_relation_check` | A member is an `owner` or a `viewer` |
| account_members | both `..._fkey` | Members and accounts are real and in the same tenant |
| wallets | `wallets_tenant_id_account_id_fkey` (RESTRICT) | A wallet belongs to an account in its own tenant; an account with wallets cannot be deleted |
| wallets | `wallets_status_check` | A wallet is `active`, `frozen` or `closed` |
| wallets | `wallets_closed_has_closed_at` | A closed wallet records when it closed, and only a closed one does |
| wallets | `wallets_nickname_check` | A nickname, if set, is 1 to 60 characters |
| wallet_balances | `wallet_balances_pkey` | One balance per wallet per currency (the card's `UNIQUE (wallet_id, currency)`) |
| wallet_balances | `wallet_balances_balance_minor_check` | A balance never goes below zero |
| wallet_balances | `wallet_balances_currency_fkey` | A balance is in a known currency |
| wallet_status_history | `wallet_status_history_status_check` | History only records real statuses |
| wallet_status_history | `wallet_status_history_reason_check` | Every status change has a reason of 3 to 200 characters |
| wallet_status_history | `..._wallet_id_fkey` (RESTRICT) | History belongs to a real wallet, and keeps it from being deleted |
| wallet_status_history | `wallet_status_history_append_only` (trigger) | Status history is never edited or deleted |
| wallet_limits | `wallet_limits_no_overlap` (EXCLUDE) | A wallet has at most one daily limit at any moment |
| wallet_limits | `..._daily_limit_minor_check`, `..._valid_during_check` | A limit is positive and covers a real, non-empty period |
| idempotency_keys | `idempotency_keys_tenant_id_client_id_key_key` | A client uses a key once (P1-03's idempotency rule) |
| idempotency_keys | `idempotency_keys_key_check` | Keys are 16 to 255 safe characters |
| idempotency_keys | `idempotency_keys_request_hash_check` | The stored request hash is a SHA-256 (32 bytes) |
| idempotency_keys | `idempotency_keys_status_check` | A key is `processing` or `completed` |
| idempotency_keys | `idem_completed_has_response` | A completed key always has the stored answer to replay |
| idempotency_keys | `idempotency_keys_response_status_check` | The stored status is a real HTTP status (100 to 599) |
| idempotency_keys | `idem_expires_after_created` | A key expires after it was created |
| idempotency_keys | `..._tenant_id_client_id_fkey` | Keys belong to a real user in the same tenant |
| transfers | `transfers_amount_minor_check` | Money moves in positive amounts (the card's `CHECK (amount > 0)`) |
| transfers | `transfers_not_to_self` | A wallet cannot pay itself |
| transfers | `transfers_status_check` | A transfer is `completed` or `reversed` |
| transfers | `transfers_note_check` | A note, if given, is 1 to 140 characters |
| transfers | `transfers_idempotency_key_id_key`, `..._fkey` | Every transfer came from exactly one idempotency key, and each key made at most one transfer |
| transfers | `transfers_tenant_id_source_wallet_id_fkey`, `..._destination_...` | Both wallets exist and are in the transfer's tenant |
| transfers | `transfers_source_wallet_id_currency_fkey`, `..._destination_...` | Both wallets hold the transfer's currency |
| ledger_entries | `ledger_entries_amount_minor_check` | Every entry moves a positive amount; the direction gives the sign |
| ledger_entries | `ledger_entries_direction_check` | An entry is a `debit` or a `credit` |
| ledger_entries | `ledger_entries_transfer_id_direction_key` | A transfer posts one debit and one credit (P2-09 generalises this) |
| ledger_entries | `..._tenant_id_transfer_id_fkey` | Entries belong to a real transfer in the same tenant |
| ledger_entries | `ledger_entries_wallet_id_currency_fkey` | Entries go to a balance that exists, in its currency |
| ledger_entries | `ledger_entries_append_only` (trigger) | Ledger entries are never edited or deleted |
| audit_log | `audit_log_action_check` | Actions are named `noun.verb` (`wallet.freeze`) |
| audit_log | `audit_log_entity_type_check` | Audit rows describe known kinds of things |
| audit_log | `audit_log_details_check` | Details are a JSON object, not a bare string or list |
| audit_log | `audit_log_append_only` (trigger) | The audit log is never edited or deleted |

### Step 3 · Insert bad rows with `psql`, and count what the database rejects

First, a small valid world: two tenants, Riya and Amit, their accounts, wallets and balances, and one transfer.

<details>
<summary><code>test/sql/fixtures.sql</code> (test data)</summary>

```sql
-- test/sql/fixtures.sql — a small valid world: two tenants, Riya and Amit, their wallets and one transfer.
-- Readable fixed ids (all valid UUIDs) so the bad-data cases below can point at them.
INSERT INTO tenants (id, slug, name) VALUES
  ('aaaaaaaa-0000-7000-8000-000000000000', 'ledger-in', 'Ledger India'),
  ('bbbbbbbb-0000-7000-8000-000000000000', 'other-co', 'Another tenant');
INSERT INTO users (tenant_id, id, email, role) VALUES
  ('aaaaaaaa-0000-7000-8000-000000000000', 'aaaaaaaa-0000-7000-8000-0000000000a1', 'riya@ledger.test', 'user'),
  ('aaaaaaaa-0000-7000-8000-000000000000', 'aaaaaaaa-0000-7000-8000-0000000000a2', 'amit@ledger.test', 'user'),
  ('bbbbbbbb-0000-7000-8000-000000000000', 'bbbbbbbb-0000-7000-8000-0000000000b1', 'zoya@other.test', 'user');
INSERT INTO kyc_profiles (tenant_id, user_id, kyc_level, legal_name) VALUES
  ('aaaaaaaa-0000-7000-8000-000000000000', 'aaaaaaaa-0000-7000-8000-0000000000a1', 'minimum', 'Riya Sharma');
INSERT INTO accounts (tenant_id, id, kind, display_name) VALUES
  ('aaaaaaaa-0000-7000-8000-000000000000', 'aaaaaaaa-0000-7000-8000-0000000000c1', 'business', 'Riya Traders'),
  ('aaaaaaaa-0000-7000-8000-000000000000', 'aaaaaaaa-0000-7000-8000-0000000000c2', 'business', 'Amit Stores'),
  ('bbbbbbbb-0000-7000-8000-000000000000', 'bbbbbbbb-0000-7000-8000-0000000000c3', 'business', 'Zoya Exports');
INSERT INTO account_members (tenant_id, account_id, user_id, relation) VALUES
  ('aaaaaaaa-0000-7000-8000-000000000000', 'aaaaaaaa-0000-7000-8000-0000000000c1', 'aaaaaaaa-0000-7000-8000-0000000000a1', 'owner');
INSERT INTO wallets (tenant_id, id, account_id) VALUES
  ('aaaaaaaa-0000-7000-8000-000000000000', 'aaaaaaaa-0000-7000-8000-0000000000d1', 'aaaaaaaa-0000-7000-8000-0000000000c1'),
  ('aaaaaaaa-0000-7000-8000-000000000000', 'aaaaaaaa-0000-7000-8000-0000000000d2', 'aaaaaaaa-0000-7000-8000-0000000000c2'),
  ('bbbbbbbb-0000-7000-8000-000000000000', 'bbbbbbbb-0000-7000-8000-0000000000d3', 'bbbbbbbb-0000-7000-8000-0000000000c3');
INSERT INTO wallet_balances (wallet_id, currency, balance_minor) VALUES
  ('aaaaaaaa-0000-7000-8000-0000000000d1', 'INR', 49950000),   -- Rs 4,99,500 after the transfer below
  ('aaaaaaaa-0000-7000-8000-0000000000d2', 'INR', 50000),
  ('bbbbbbbb-0000-7000-8000-0000000000d3', 'INR', 0);
INSERT INTO idempotency_keys (id, tenant_id, client_id, key, request_hash, status, response_status, expires_at)
  OVERRIDING SYSTEM VALUE VALUES
  (1, 'aaaaaaaa-0000-7000-8000-000000000000', 'aaaaaaaa-0000-7000-8000-0000000000a1', 'key-0000000000000001',
   sha256('t1'), 'completed', 201, now() + interval '24 hours'),
  (2, 'aaaaaaaa-0000-7000-8000-000000000000', 'aaaaaaaa-0000-7000-8000-0000000000a1', 'key-0000000000000002',
   sha256('t2'), 'processing', NULL, now() + interval '24 hours'),
  (3, 'aaaaaaaa-0000-7000-8000-000000000000', 'aaaaaaaa-0000-7000-8000-0000000000a2', 'key-0000000000000003',
   sha256('t3'), 'processing', NULL, now() + interval '24 hours');
SELECT setval(pg_get_serial_sequence('idempotency_keys', 'id'), 3);  -- ids above were set by hand
INSERT INTO transfers (tenant_id, id, source_wallet_id, destination_wallet_id, currency, amount_minor, status, idempotency_key_id)
  VALUES ('aaaaaaaa-0000-7000-8000-000000000000', 'aaaaaaaa-0000-7000-8000-0000000000e1',
          'aaaaaaaa-0000-7000-8000-0000000000d1', 'aaaaaaaa-0000-7000-8000-0000000000d2', 'INR', 50000, 'completed', 1),
         ('aaaaaaaa-0000-7000-8000-000000000000', 'aaaaaaaa-0000-7000-8000-0000000000e2',   -- no entries yet
          'aaaaaaaa-0000-7000-8000-0000000000d2', 'aaaaaaaa-0000-7000-8000-0000000000d1', 'INR', 100, 'completed', 3);
INSERT INTO ledger_entries (tenant_id, transfer_id, wallet_id, currency, direction, amount_minor) VALUES
  ('aaaaaaaa-0000-7000-8000-000000000000', 'aaaaaaaa-0000-7000-8000-0000000000e1', 'aaaaaaaa-0000-7000-8000-0000000000d1', 'INR', 'debit', 50000),
  ('aaaaaaaa-0000-7000-8000-000000000000', 'aaaaaaaa-0000-7000-8000-0000000000e1', 'aaaaaaaa-0000-7000-8000-0000000000d2', 'INR', 'credit', 50000);
INSERT INTO wallet_status_history (wallet_id, status, reason) VALUES
  ('aaaaaaaa-0000-7000-8000-0000000000d1', 'active', 'wallet opened');
INSERT INTO wallet_limits (wallet_id, daily_limit_minor, valid_during) VALUES
  ('aaaaaaaa-0000-7000-8000-0000000000d1', 10000000, tstzrange('2026-10-01 00:00+05:30', '2026-11-01 00:00+05:30'));
INSERT INTO audit_log (tenant_id, actor_user_id, action, entity_type, entity_id) VALUES
  ('aaaaaaaa-0000-7000-8000-000000000000', 'aaaaaaaa-0000-7000-8000-0000000000a1', 'transfer.create', 'transfer', 'aaaaaaaa-0000-7000-8000-0000000000e1');
```

</details>

The harness, `test/sql/bad-data.sql`. It runs each case in its own sub-transaction, records the SQLSTATE and the constraint that fired, and rolls everything back at the end.

```sql
-- test/sql/bad-data.sql — insert bad rows straight into the database, the way a script or a buggy service would.
-- Run: psql -X -q -d ledger -f test/sql/fixtures.sql -f test/sql/bad-data.sql   (everything rolls back)
BEGIN;
CREATE TEMP TABLE results (n int, name text, outcome text, sqlstate text, caught_by text);

-- Run one statement; record whether the database rejected it, with the error code and the rule that fired.
CREATE FUNCTION pg_temp.check_case(n int, name text, stmt text, want text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE state text := '-'; rule text; col text; msg text; accepted boolean := false;
BEGIN
  BEGIN
    EXECUTE stmt;
    accepted := true;
    RAISE EXCEPTION USING ERRCODE = 'P0099';           -- roll the case back, so every case starts from the same data
  EXCEPTION
    WHEN SQLSTATE 'P0099' THEN NULL;
    WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS state = RETURNED_SQLSTATE, rule = CONSTRAINT_NAME, col = COLUMN_NAME, msg = MESSAGE_TEXT;
  END;
  INSERT INTO results VALUES (n, name,
    CASE WHEN accepted = (want = 'accept') THEN (CASE WHEN accepted THEN 'accepted (ok)' ELSE 'rejected (ok)' END)
         ELSE (CASE WHEN accepted THEN 'ACCEPTED (bug)' ELSE 'REJECTED (bug)' END) END,
    state,
    CASE WHEN accepted THEN '-' WHEN rule <> '' THEN rule WHEN col <> '' THEN 'NOT NULL ' || col ELSE left(msg, 46) END);
END $$;
\o /dev/null
\i test/sql/cases.sql
\o

SELECT n, name, outcome, sqlstate, caught_by FROM results ORDER BY n;
SELECT count(*) FILTER (WHERE outcome = 'rejected (ok)') AS bad_rows_rejected,
       count(*) FILTER (WHERE outcome = 'accepted (ok)') AS valid_controls_accepted,
       count(*) FILTER (WHERE outcome LIKE '%(bug)')     AS bugs
FROM results;
ROLLBACK;
```

The cases, `test/sql/cases.sql`. One line per rule; `'reject'` cases must fail and `'accept'` cases (controls) must succeed.

```sql
-- test/sql/cases.sql — one line per business rule. fx('riya') returns a fixture id from fixtures.sql.
CREATE FUNCTION pg_temp.fx(name text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
  SELECT ('{"tenant_a":"aaaaaaaa-0000-7000-8000-000000000000","tenant_b":"bbbbbbbb-0000-7000-8000-000000000000",
    "riya":"aaaaaaaa-0000-7000-8000-0000000000a1","amit":"aaaaaaaa-0000-7000-8000-0000000000a2",
    "zoya":"bbbbbbbb-0000-7000-8000-0000000000b1","riya_traders":"aaaaaaaa-0000-7000-8000-0000000000c1",
    "zoya_exports":"bbbbbbbb-0000-7000-8000-0000000000c3","w_riya":"aaaaaaaa-0000-7000-8000-0000000000d1",
    "w_amit":"aaaaaaaa-0000-7000-8000-0000000000d2","w_zoya":"bbbbbbbb-0000-7000-8000-0000000000d3",
    "t1":"aaaaaaaa-0000-7000-8000-0000000000e1","t2":"aaaaaaaa-0000-7000-8000-0000000000e2"}'::jsonb ->> name)::uuid $$;

-- Users
SELECT pg_temp.check_case(1, 'user without email', $$INSERT INTO users (tenant_id, email) VALUES (pg_temp.fx('tenant_a'), NULL)$$, 'reject');
SELECT pg_temp.check_case(2, 'same email, different case', $$INSERT INTO users (tenant_id, email) VALUES (pg_temp.fx('tenant_a'), 'Riya@Ledger.TEST')$$, 'reject');
SELECT pg_temp.check_case(3, 'phone not in E.164', $$UPDATE users SET phone_e164 = '9876543210' WHERE id = pg_temp.fx('riya')$$, 'reject');
SELECT pg_temp.check_case(4, 'unknown role', $$UPDATE users SET role = 'superadmin' WHERE id = pg_temp.fx('amit')$$, 'reject');
SELECT pg_temp.check_case(5, 'control: reuse email after soft delete', $$UPDATE users SET deleted_at = now() WHERE id = pg_temp.fx('riya');
  INSERT INTO users (tenant_id, email) VALUES (pg_temp.fx('tenant_a'), 'riya@ledger.test')$$, 'accept');
-- KYC (one-to-one)
SELECT pg_temp.check_case(6, 'second KYC profile for one user', $$INSERT INTO kyc_profiles (tenant_id, user_id, kyc_level, legal_name) VALUES (pg_temp.fx('tenant_a'), pg_temp.fx('riya'), 'minimum', 'Riya S')$$, 'reject');
SELECT pg_temp.check_case(7, 'KYC row in the wrong tenant', $$INSERT INTO kyc_profiles (tenant_id, user_id, kyc_level, legal_name) VALUES (pg_temp.fx('tenant_b'), pg_temp.fx('amit'), 'minimum', 'Amit K')$$, 'reject');
SELECT pg_temp.check_case(8, 'full KYC with no verified_at', $$UPDATE kyc_profiles SET kyc_level = 'full' WHERE user_id = pg_temp.fx('riya')$$, 'reject');
-- Accounts and members (many-to-many)
SELECT pg_temp.check_case(9, 'unknown member relation', $$INSERT INTO account_members (tenant_id, account_id, user_id, relation) VALUES (pg_temp.fx('tenant_a'), pg_temp.fx('riya_traders'), pg_temp.fx('amit'), 'admin')$$, 'reject');
SELECT pg_temp.check_case(10, 'same member twice', $$INSERT INTO account_members (tenant_id, account_id, user_id, relation) VALUES (pg_temp.fx('tenant_a'), pg_temp.fx('riya_traders'), pg_temp.fx('riya'), 'viewer')$$, 'reject');
SELECT pg_temp.check_case(11, 'member who does not exist', $$INSERT INTO account_members (tenant_id, account_id, user_id, relation) VALUES (pg_temp.fx('tenant_a'), pg_temp.fx('riya_traders'), uuidv7(), 'viewer')$$, 'reject');
SELECT pg_temp.check_case(12, 'member from another tenant', $$INSERT INTO account_members (tenant_id, account_id, user_id, relation) VALUES (pg_temp.fx('tenant_a'), pg_temp.fx('riya_traders'), pg_temp.fx('zoya'), 'viewer')$$, 'reject');
-- Wallets and balances
SELECT pg_temp.check_case(13, 'second INR balance for one wallet', $$INSERT INTO wallet_balances (wallet_id, currency) VALUES (pg_temp.fx('w_riya'), 'INR')$$, 'reject');
SELECT pg_temp.check_case(14, 'negative balance', $$UPDATE wallet_balances SET balance_minor = -1 WHERE wallet_id = pg_temp.fx('w_amit')$$, 'reject');
SELECT pg_temp.check_case(15, 'currency that does not exist', $$INSERT INTO wallet_balances (wallet_id, currency) VALUES (pg_temp.fx('w_amit'), 'XYZ')$$, 'reject');
SELECT pg_temp.check_case(16, 'currency in lower case', $$INSERT INTO wallet_balances (wallet_id, currency) VALUES (pg_temp.fx('w_amit'), 'inr')$$, 'reject');
SELECT pg_temp.check_case(17, 'unknown wallet status', $$UPDATE wallets SET status = 'blocked' WHERE id = pg_temp.fx('w_amit')$$, 'reject');
SELECT pg_temp.check_case(18, 'closed wallet with no closed_at', $$UPDATE wallets SET status = 'closed' WHERE id = pg_temp.fx('w_amit')$$, 'reject');
SELECT pg_temp.check_case(19, 'wallet on another tenant''s account', $$INSERT INTO wallets (tenant_id, account_id) VALUES (pg_temp.fx('tenant_a'), pg_temp.fx('zoya_exports'))$$, 'reject');
SELECT pg_temp.check_case(20, 'delete an account that has wallets', $$DELETE FROM accounts WHERE id = pg_temp.fx('riya_traders')$$, 'reject');
-- Transfers
SELECT pg_temp.check_case(21, 'transfer of zero', $$INSERT INTO transfers (tenant_id, source_wallet_id, destination_wallet_id, currency, amount_minor, status, idempotency_key_id) VALUES (pg_temp.fx('tenant_a'), pg_temp.fx('w_riya'), pg_temp.fx('w_amit'), 'INR', 0, 'completed', 2)$$, 'reject');
SELECT pg_temp.check_case(22, 'negative transfer', $$INSERT INTO transfers (tenant_id, source_wallet_id, destination_wallet_id, currency, amount_minor, status, idempotency_key_id) VALUES (pg_temp.fx('tenant_a'), pg_temp.fx('w_riya'), pg_temp.fx('w_amit'), 'INR', -500, 'completed', 2)$$, 'reject');
SELECT pg_temp.check_case(23, 'fractional paise sent as text', $$INSERT INTO transfers (tenant_id, source_wallet_id, destination_wallet_id, currency, amount_minor, status, idempotency_key_id) VALUES (pg_temp.fx('tenant_a'), pg_temp.fx('w_riya'), pg_temp.fx('w_amit'), 'INR', '10.5', 'completed', 2)$$, 'reject');
SELECT pg_temp.check_case(24, 'transfer to the same wallet', $$INSERT INTO transfers (tenant_id, source_wallet_id, destination_wallet_id, currency, amount_minor, status, idempotency_key_id) VALUES (pg_temp.fx('tenant_a'), pg_temp.fx('w_riya'), pg_temp.fx('w_riya'), 'INR', 100, 'completed', 2)$$, 'reject');
SELECT pg_temp.check_case(25, 'currency the wallets do not hold', $$INSERT INTO transfers (tenant_id, source_wallet_id, destination_wallet_id, currency, amount_minor, status, idempotency_key_id) VALUES (pg_temp.fx('tenant_a'), pg_temp.fx('w_riya'), pg_temp.fx('w_amit'), 'USD', 100, 'completed', 2)$$, 'reject');
SELECT pg_temp.check_case(26, 'pay a wallet in another tenant', $$INSERT INTO transfers (tenant_id, source_wallet_id, destination_wallet_id, currency, amount_minor, status, idempotency_key_id) VALUES (pg_temp.fx('tenant_a'), pg_temp.fx('w_riya'), pg_temp.fx('w_zoya'), 'INR', 100, 'completed', 2)$$, 'reject');
SELECT pg_temp.check_case(27, 'transfer without idempotency key', $$INSERT INTO transfers (tenant_id, source_wallet_id, destination_wallet_id, currency, amount_minor, status) VALUES (pg_temp.fx('tenant_a'), pg_temp.fx('w_riya'), pg_temp.fx('w_amit'), 'INR', 100, 'completed')$$, 'reject');
SELECT pg_temp.check_case(28, 'two transfers for one key', $$INSERT INTO transfers (tenant_id, source_wallet_id, destination_wallet_id, currency, amount_minor, status, idempotency_key_id) VALUES (pg_temp.fx('tenant_a'), pg_temp.fx('w_riya'), pg_temp.fx('w_amit'), 'INR', 100, 'completed', 1)$$, 'reject');
SELECT pg_temp.check_case(29, 'empty note', $$INSERT INTO transfers (tenant_id, source_wallet_id, destination_wallet_id, currency, amount_minor, status, note, idempotency_key_id) VALUES (pg_temp.fx('tenant_a'), pg_temp.fx('w_riya'), pg_temp.fx('w_amit'), 'INR', 100, 'completed', '', 2)$$, 'reject');
SELECT pg_temp.check_case(30, 'control: a valid transfer', $$INSERT INTO transfers (tenant_id, source_wallet_id, destination_wallet_id, currency, amount_minor, status, note, idempotency_key_id) VALUES (pg_temp.fx('tenant_a'), pg_temp.fx('w_riya'), pg_temp.fx('w_amit'), 'INR', 100, 'completed', 'Chai', 2)$$, 'accept');
-- Ledger entries (append-only)
SELECT pg_temp.check_case(31, 'unknown entry direction', $$INSERT INTO ledger_entries (tenant_id, transfer_id, wallet_id, currency, direction, amount_minor) VALUES (pg_temp.fx('tenant_a'), pg_temp.fx('t1'), pg_temp.fx('w_amit'), 'INR', 'refund', 100)$$, 'reject');
SELECT pg_temp.check_case(32, 'second debit for one transfer', $$INSERT INTO ledger_entries (tenant_id, transfer_id, wallet_id, currency, direction, amount_minor) VALUES (pg_temp.fx('tenant_a'), pg_temp.fx('t1'), pg_temp.fx('w_riya'), 'INR', 'debit', 50000)$$, 'reject');
SELECT pg_temp.check_case(33, 'entry in a currency the wallet lacks', $$INSERT INTO ledger_entries (tenant_id, transfer_id, wallet_id, currency, direction, amount_minor) VALUES (pg_temp.fx('tenant_a'), pg_temp.fx('t2'), pg_temp.fx('w_riya'), 'USD', 'credit', 100)$$, 'reject');
SELECT pg_temp.check_case(34, 'edit a ledger entry', $$UPDATE ledger_entries SET amount_minor = 1 WHERE transfer_id = pg_temp.fx('t1')$$, 'reject');
SELECT pg_temp.check_case(35, 'delete a ledger entry', $$DELETE FROM ledger_entries WHERE transfer_id = pg_temp.fx('t1')$$, 'reject');
-- Idempotency keys
SELECT pg_temp.check_case(36, 'completed key without a stored answer', $$UPDATE idempotency_keys SET status = 'completed' WHERE id = 2$$, 'reject');
SELECT pg_temp.check_case(37, 'key too short', $$INSERT INTO idempotency_keys (tenant_id, client_id, key, request_hash, status, expires_at) VALUES (pg_temp.fx('tenant_a'), pg_temp.fx('amit'), 'short', sha256('x'), 'processing', now() + interval '1 day')$$, 'reject');
SELECT pg_temp.check_case(38, 'same key twice for one client', $$INSERT INTO idempotency_keys (tenant_id, client_id, key, request_hash, status, expires_at) VALUES (pg_temp.fx('tenant_a'), pg_temp.fx('riya'), 'key-0000000000000001', sha256('x'), 'processing', now() + interval '1 day')$$, 'reject');
SELECT pg_temp.check_case(39, 'key that expires before it is made', $$INSERT INTO idempotency_keys (tenant_id, client_id, key, request_hash, status, expires_at) VALUES (pg_temp.fx('tenant_a'), pg_temp.fx('amit'), 'key-0000000000000009', sha256('x'), 'processing', now() - interval '1 day')$$, 'reject');
-- History and validity ranges
SELECT pg_temp.check_case(40, 'unknown status in history', $$INSERT INTO wallet_status_history (wallet_id, status, reason) VALUES (pg_temp.fx('w_riya'), 'paused', 'support ticket')$$, 'reject');
SELECT pg_temp.check_case(41, 'rewrite status history', $$UPDATE wallet_status_history SET status = 'frozen' WHERE wallet_id = pg_temp.fx('w_riya')$$, 'reject');
SELECT pg_temp.check_case(42, 'overlapping limit periods', $$INSERT INTO wallet_limits (wallet_id, daily_limit_minor, valid_during) VALUES (pg_temp.fx('w_riya'), 5000000, tstzrange('2026-10-15 00:00+05:30', '2026-11-15 00:00+05:30'))$$, 'reject');
SELECT pg_temp.check_case(43, 'control: next period starts where the last ends', $$INSERT INTO wallet_limits (wallet_id, daily_limit_minor, valid_during) VALUES (pg_temp.fx('w_riya'), 5000000, tstzrange('2026-11-01 00:00+05:30', '2026-12-01 00:00+05:30'))$$, 'accept');
-- Audit, tenants, reference data
SELECT pg_temp.check_case(44, 'delete from the audit log', $$DELETE FROM audit_log$$, 'reject');
SELECT pg_temp.check_case(45, 'badly formed audit action', $$INSERT INTO audit_log (tenant_id, action, entity_type, entity_id) VALUES (pg_temp.fx('tenant_a'), 'Freeze Wallet', 'wallet', pg_temp.fx('w_riya'))$$, 'reject');
SELECT pg_temp.check_case(46, 'tenant slug with spaces', $$INSERT INTO tenants (slug, name) VALUES ('Ledger India', 'Dup')$$, 'reject');
SELECT pg_temp.check_case(47, 'currency code that is not ISO-shaped', $$INSERT INTO currencies (code, minor_unit, name) VALUES ('RUPEE', 2, 'Rupee')$$, 'reject');
```

**What to notice**
- Every case writes **directly** with SQL. No app, no Zod, no service: this is what a script or a buggy service can do.
- The three **controls** matter as much as the rejects. They prove the constraints are not so strict that valid data fails.
- Each case is rolled back on its own (the `P0099` trick), so cases do not depend on each other's leftovers.

**Run it:**

```bash
psql -d ledger -f test/sql/fixtures.sql
psql -X -q -d ledger -f test/sql/bad-data.sql
```

**Real output:**

```text
 n  |                      name                       |    outcome    | sqlstate |                   caught_by                    
----+-------------------------------------------------+---------------+----------+------------------------------------------------
  1 | user without email                              | rejected (ok) | 23502    | NOT NULL email
  2 | same email, different case                      | rejected (ok) | 23505    | users_email_live
  3 | phone not in E.164                              | rejected (ok) | 23514    | users_phone_e164_check
  4 | unknown role                                    | rejected (ok) | 23514    | users_role_check
  5 | control: reuse email after soft delete          | accepted (ok) | -        | -
  6 | second KYC profile for one user                 | rejected (ok) | 23505    | kyc_profiles_pkey
  7 | KYC row in the wrong tenant                     | rejected (ok) | 23503    | kyc_profiles_tenant_id_user_id_fkey
  8 | full KYC with no verified_at                    | rejected (ok) | 23514    | kyc_full_needs_verified_at
  9 | unknown member relation                         | rejected (ok) | 23514    | account_members_relation_check
 10 | same member twice                               | rejected (ok) | 23505    | account_members_pkey
 11 | member who does not exist                       | rejected (ok) | 23503    | account_members_tenant_id_user_id_fkey
 12 | member from another tenant                      | rejected (ok) | 23503    | account_members_tenant_id_user_id_fkey
 13 | second INR balance for one wallet               | rejected (ok) | 23505    | wallet_balances_pkey
 14 | negative balance                                | rejected (ok) | 23514    | wallet_balances_balance_minor_check
 15 | currency that does not exist                    | rejected (ok) | 23503    | wallet_balances_currency_fkey
 16 | currency in lower case                          | rejected (ok) | 23503    | wallet_balances_currency_fkey
 17 | unknown wallet status                           | rejected (ok) | 23514    | wallets_status_check
 18 | closed wallet with no closed_at                 | rejected (ok) | 23514    | wallets_closed_has_closed_at
 19 | wallet on another tenant's account              | rejected (ok) | 23503    | wallets_tenant_id_account_id_fkey
 20 | delete an account that has wallets              | rejected (ok) | 23001    | wallets_tenant_id_account_id_fkey
 21 | transfer of zero                                | rejected (ok) | 23514    | transfers_amount_minor_check
 22 | negative transfer                               | rejected (ok) | 23514    | transfers_amount_minor_check
 23 | fractional paise sent as text                   | rejected (ok) | 22P02    | invalid input syntax for type bigint: "10.5"
 24 | transfer to the same wallet                     | rejected (ok) | 23514    | transfers_not_to_self
 25 | currency the wallets do not hold                | rejected (ok) | 23503    | transfers_source_wallet_id_currency_fkey
 26 | pay a wallet in another tenant                  | rejected (ok) | 23503    | transfers_tenant_id_destination_wallet_id_fkey
 27 | transfer without idempotency key                | rejected (ok) | 23502    | NOT NULL idempotency_key_id
 28 | two transfers for one key                       | rejected (ok) | 23505    | transfers_idempotency_key_id_key
 29 | empty note                                      | rejected (ok) | 23514    | transfers_note_check
 30 | control: a valid transfer                       | accepted (ok) | -        | -
 31 | unknown entry direction                         | rejected (ok) | 23514    | ledger_entries_direction_check
 32 | second debit for one transfer                   | rejected (ok) | 23505    | ledger_entries_transfer_id_direction_key
 33 | entry in a currency the wallet lacks            | rejected (ok) | 23503    | ledger_entries_wallet_id_currency_fkey
 34 | edit a ledger entry                             | rejected (ok) | 23001    | ledger_entries_append_only
 35 | delete a ledger entry                           | rejected (ok) | 23001    | ledger_entries_append_only
 36 | completed key without a stored answer           | rejected (ok) | 23514    | idem_completed_has_response
 37 | key too short                                   | rejected (ok) | 23514    | idempotency_keys_key_check
 38 | same key twice for one client                   | rejected (ok) | 23505    | idempotency_keys_tenant_id_client_id_key_key
 39 | key that expires before it is made              | rejected (ok) | 23514    | idem_expires_after_created
 40 | unknown status in history                       | rejected (ok) | 23514    | wallet_status_history_status_check
 41 | rewrite status history                          | rejected (ok) | 23001    | wallet_status_history_append_only
 42 | overlapping limit periods                       | rejected (ok) | 23P01    | wallet_limits_no_overlap
 43 | control: next period starts where the last ends | accepted (ok) | -        | -
 44 | delete from the audit log                       | rejected (ok) | 23001    | audit_log_append_only
 45 | badly formed audit action                       | rejected (ok) | 23514    | audit_log_action_check
 46 | tenant slug with spaces                         | rejected (ok) | 23514    | tenants_slug_check
 47 | currency code that is not ISO-shaped            | rejected (ok) | 23514    | currencies_code_check
(47 rows)

 bad_rows_rejected | valid_controls_accepted | bugs 
-------------------+-------------------------+------
                44 |                       3 |    0
(1 row)
```

**44 of 44 bad rows rejected by the database itself, 3 of 3 valid controls accepted, 0 bugs.** The error codes tell you which kind of rule fired: `23502` NOT NULL, `23505` unique, `23514` CHECK, `23503` foreign key, `23001` restrict (the RESTRICT delete and our append-only triggers), `23P01` exclusion, and `22P02` for text that is not a valid number.

Two cases were caught by the **wrong** rule on the first run, and both taught something:
- "same key twice for one client" first failed on the **primary key**, not the unique rule. The fixtures had inserted ids by hand, so the identity sequence produced an id that already existed. Fixed with `setval`; in real code, never insert identity values by hand.
- "entry in a currency the wallet lacks" first failed on `UNIQUE (transfer_id, direction)`, because the test transfer already had a credit. Unique checks happen while the row is inserted, foreign keys at the end of the statement. A second fixture transfer with no entries isolates the foreign key.

### Step 4 · 10 lakh rows per ID type: insert rate and index size

`bench/idTypes.ts` creates the same table three times, with a different primary key each time. It inserts 10 lakh rows in 1,000 transactions of 1,000 rows (like an app, not one giant `INSERT`), then measures time, index size, leaf density, WAL and index pages read from outside the cache. It runs three rounds in rotating order and reports the median.

```ts
// bench/idTypes.ts — insert 1,000,000 rows with bigint, UUIDv4 and UUIDv7 keys; compare speed, index size and WAL.
// Run: DATABASE_URL=postgres://postgres:postgres@localhost:5432/ledger npx tsx bench/idTypes.ts [rows] [rounds]
// Needs PostgreSQL 18 (uuidv7() is built in) and the pgstattuple extension (CREATE EXTENSION pgstattuple).
import pg from "pg";

type Kind = "bigint" | "uuidv4" | "uuidv7";
const KEY: Record<Kind, string> = {
  bigint: "bigint GENERATED ALWAYS AS IDENTITY",
  uuidv4: "uuid DEFAULT uuidv4()",
  uuidv7: "uuid DEFAULT uuidv7()",
};
const ROWS = Number(process.argv[2] ?? 1_000_000);
const ROUNDS = Number(process.argv[3] ?? 3);
const BATCH = 1_000; // like an app: many small transactions, not one giant INSERT

interface Result { kind: Kind; seconds: number; indexMiB: number; tableMiB: number; walMiB: number; leafDensity: number; indexBlocksRead: number }

const client = new pg.Client({ connectionString: process.env.DATABASE_URL, statement_timeout: 120_000 });
const mib = (bytes: string | number) => Number(bytes) / 1024 / 1024;

async function runOne(kind: Kind): Promise<Result> {
  const table = `bench_${kind}`;
  await client.query(`DROP TABLE IF EXISTS ${table}`);
  await client.query(`CREATE TABLE ${table} (id ${KEY[kind]} PRIMARY KEY, wallet_id uuid NOT NULL,
    amount_minor bigint NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`);
  await client.query("CHECKPOINT"); // same starting point for every run: the first change to a page after a checkpoint logs the whole page
  const { rows: [before] } = await client.query<{ lsn: string }>("SELECT pg_current_wal_lsn() AS lsn");

  const started = performance.now();
  for (let done = 0; done < ROWS; done += BATCH) {
    await client.query(`INSERT INTO ${table} (wallet_id, amount_minor)
      SELECT 'aaaaaaaa-0000-7000-8000-0000000000d1', 100 + g FROM generate_series(1, $1) AS g`, [BATCH]);
  }
  const seconds = (performance.now() - started) / 1000;

  await client.query("SELECT pg_stat_force_next_flush()");
  const { rows: [m] } = await client.query<{ wal: string; idx: string; tbl: string; density: number; reads: string }>(`
    SELECT pg_wal_lsn_diff(pg_current_wal_lsn(), $1) AS wal,
           pg_relation_size('${table}_pkey') AS idx, pg_relation_size('${table}') AS tbl,
           (pgstatindex('${table}_pkey')).avg_leaf_density AS density,
           (SELECT idx_blks_read FROM pg_statio_user_indexes WHERE indexrelname = '${table}_pkey') AS reads`, [before!.lsn]);
  return { kind, seconds, indexMiB: mib(m!.idx), tableMiB: mib(m!.tbl), walMiB: mib(m!.wal), leafDensity: m!.density, indexBlocksRead: Number(m!.reads) };
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

await client.connect();
const { rows: [info] } = await client.query<{ version: string; buffers: string }>(
  "SELECT current_setting('server_version') AS version, current_setting('shared_buffers') AS buffers");
console.log(`PostgreSQL ${info!.version}, shared_buffers ${info!.buffers}, ${ROWS.toLocaleString("en-IN")} rows in batches of ${BATCH}, ${ROUNDS} rounds`);

const all: Result[] = [];
const kinds: Kind[] = ["bigint", "uuidv4", "uuidv7"];
for (let round = 0; round < ROUNDS; round++) {
  for (const kind of [...kinds.slice(round % 3), ...kinds.slice(0, round % 3)]) all.push(await runOne(kind)); // rotate the order
}
console.log("| key | rows/s (median) | seconds | PK index MiB | table MiB | WAL MiB | leaf density % | index blocks read |");
console.log("|---|---|---|---|---|---|---|---|");
for (const kind of kinds) {
  const r = all.filter((x) => x.kind === kind);
  const s = median(r.map((x) => x.seconds));
  console.log(`| ${kind} | ${Math.round(ROWS / s).toLocaleString("en-IN")} | ${s.toFixed(2)} | ${median(r.map((x) => x.indexMiB)).toFixed(1)} | ` +
    `${median(r.map((x) => x.tableMiB)).toFixed(1)} | ${median(r.map((x) => x.walMiB)).toFixed(0)} | ${median(r.map((x) => x.leafDensity)).toFixed(1)} | ` +
    `${median(r.map((x) => x.indexBlocksRead)).toLocaleString("en-IN")} |`);
}
for (const kind of kinds) await client.query(`DROP TABLE IF EXISTS bench_${kind}`);
await client.end();
```

**What to notice**
- `CHECKPOINT` before each run gives every key type the same start. After a checkpoint, the first change to each page writes the whole page to WAL, which penalises keys that touch many pages.
- `pgstatindex(...).avg_leaf_density` shows how full the index pages are; `idx_blks_read` counts index pages that had to come from outside Postgres's cache.
- The rows and generation are identical; only the key type changes.

**Run it:**

```bash
npx tsx bench/idTypes.ts 1000000 3
```

**Real output** (`shared_buffers` 256 MB, the indexes fit in memory):

```text
PostgreSQL 18.4, shared_buffers 256MB, 10,00,000 rows in batches of 1000, 3 rounds
| key | rows/s (median) | seconds | PK index MiB | table MiB | WAL MiB | leaf density % | index blocks read |
|---|---|---|---|---|---|---|---|
| bigint | 2,75,269 | 3.63 | 21.4 | 65.1 | 158 | 90.0 | 1 |
| uuidv4 | 1,17,295 | 8.53 | 37.7 | 73.0 | 185 | 71.9 | 1 |
| uuidv7 | 2,00,109 | 5.00 | 30.1 | 73.0 | 172 | 90.0 | 1 |
```

**Real output** (the same benchmark after restarting Postgres with `shared_buffers=16MB`, so the indexes no longer fit):

```text
PostgreSQL 18.4, shared_buffers 16MB, 10,00,000 rows in batches of 1000, 3 rounds
| key | rows/s (median) | seconds | PK index MiB | table MiB | WAL MiB | leaf density % | index blocks read |
|---|---|---|---|---|---|---|---|
| bigint | 2,68,241 | 3.73 | 21.4 | 65.1 | 158 | 90.0 | 1 |
| uuidv4 | 95,378 | 10.48 | 38.2 | 73.0 | 185 | 71.0 | 2,35,735 |
| uuidv7 | 1,94,404 | 5.14 | 30.1 | 73.0 | 172 | 90.0 | 1 |
```

**What the numbers say** (ratios computed from the tables):
- **UUIDv4 is the outlier.** It inserted at 0.59 times UUIDv7's rate with a big cache and 0.49 times with a small one. Its index was 25% bigger and only about 72% full.
- **The cache test shows locality directly.** With 16 MB of cache, UUIDv4 read **2,35,735** index pages from outside Postgres's cache during the run; UUIDv7 and bigint read **1**. Here those reads came from the operating system's memory. On a real server with a cold disk, each one can be a disk read, and the gap grows.
- **UUIDv7 costs about a third more than bigint** (1.41 times the index size, 0.73 times the insert rate), because each key is twice as wide. That is the price of ids that are safe in URLs and can be made outside the database.
- **WAL:** UUIDv4 wrote 17.1% more than bigint, UUIDv7 8.9% more.

**Projected to the ledger's biggest table** (linear from the 10 lakh run): a primary-key index on 10 crore rows would be about **2.09 GiB** with bigint, **2.94 GiB** with UUIDv7 and **3.68 GiB** with UUIDv4.

One limit of this benchmark: UUIDv7 helps the **primary-key** index and anything ordered by time. An index that starts with `wallet_id` (like `ledger_entries_by_wallet`) spreads inserts across all wallets whatever the key type, because it is ordered by wallet first. Measure that index separately on your machine (an exercise below).

### Step 5 · `wallet_status_history`, and a wallet's status as of a past date

The SQL first. `sql/status-history.sql` adds a wallet with four back-dated changes, then asks four questions:

```sql
-- sql/status-history.sql — a wallet's status on any past date, from an append-only history.
\pset footer off
BEGIN;
INSERT INTO wallets (tenant_id, id, account_id, created_at) VALUES
  ('aaaaaaaa-0000-7000-8000-000000000000', 'aaaaaaaa-0000-7000-8000-0000000000d9', 'aaaaaaaa-0000-7000-8000-0000000000c2', '2026-09-01 10:00+05:30');
-- Back-dated events for the demo. In the app, changed_at is always now() (see walletStatusRepository.ts).
INSERT INTO wallet_status_history (wallet_id, status, reason, changed_at) VALUES
  ('aaaaaaaa-0000-7000-8000-0000000000d9', 'active', 'wallet opened',                     '2026-09-01 10:00+05:30'),
  ('aaaaaaaa-0000-7000-8000-0000000000d9', 'frozen', 'login from a new device, 3 failed OTPs', '2026-10-05 18:30+05:30'),
  ('aaaaaaaa-0000-7000-8000-0000000000d9', 'active', 'KYC re-verified at branch',         '2026-10-07 11:00+05:30'),
  ('aaaaaaaa-0000-7000-8000-0000000000d9', 'frozen', 'chargeback dispute opened',         '2026-10-12 09:15+05:30');
SET TIME ZONE 'Asia/Kolkata';

\echo '-- status as of a past moment: the latest change at or before it'
SELECT d.at AS as_of, h.status, h.reason
FROM (VALUES (timestamptz '2026-08-15 12:00+05:30'), ('2026-10-06 12:00+05:30'), ('2026-10-10 12:00+05:30'), ('2026-10-13 12:00+05:30')) AS d(at)
LEFT JOIN LATERAL (
  SELECT status, reason FROM wallet_status_history
  WHERE wallet_id = 'aaaaaaaa-0000-7000-8000-0000000000d9' AND changed_at <= d.at
  ORDER BY changed_at DESC, id DESC LIMIT 1) h ON true;

\echo '-- the same history as periods (the wallet_status_periods view)'
SELECT status, valid_from, valid_to, reason FROM wallet_status_periods
WHERE wallet_id = 'aaaaaaaa-0000-7000-8000-0000000000d9' ORDER BY valid_from;

\echo '-- which wallets were frozen at any time between 5 and 11 October?'
SELECT wallet_id, valid_from, valid_to FROM wallet_status_periods
WHERE status = 'frozen'
  AND tstzrange(valid_from, valid_to) && tstzrange('2026-10-05 00:00+05:30', '2026-10-12 00:00+05:30');

\echo '-- the plan for the as-of lookup uses the (wallet_id, changed_at DESC, id DESC) index'
EXPLAIN (COSTS OFF) SELECT status FROM wallet_status_history
WHERE wallet_id = 'aaaaaaaa-0000-7000-8000-0000000000d9' AND changed_at <= now() ORDER BY changed_at DESC, id DESC LIMIT 1;
ROLLBACK;
```

**Real output:**

```text
-- status as of a past moment: the latest change at or before it
           as_of           | status |                 reason                 
---------------------------+--------+----------------------------------------
 2026-08-15 12:00:00+05:30 |        | 
 2026-10-06 12:00:00+05:30 | frozen | login from a new device, 3 failed OTPs
 2026-10-10 12:00:00+05:30 | active | KYC re-verified at branch
 2026-10-13 12:00:00+05:30 | frozen | chargeback dispute opened

-- the same history as periods (the wallet_status_periods view)
 status |        valid_from         |         valid_to          |                 reason                 
--------+---------------------------+---------------------------+----------------------------------------
 active | 2026-09-01 10:00:00+05:30 | 2026-10-05 18:30:00+05:30 | wallet opened
 frozen | 2026-10-05 18:30:00+05:30 | 2026-10-07 11:00:00+05:30 | login from a new device, 3 failed OTPs
 active | 2026-10-07 11:00:00+05:30 | 2026-10-12 09:15:00+05:30 | KYC re-verified at branch
 frozen | 2026-10-12 09:15:00+05:30 |                           | chargeback dispute opened

-- which wallets were frozen at any time between 5 and 11 October?
              wallet_id               |        valid_from         |         valid_to          
--------------------------------------+---------------------------+---------------------------
 aaaaaaaa-0000-7000-8000-0000000000d9 | 2026-10-05 18:30:00+05:30 | 2026-10-07 11:00:00+05:30

-- the plan for the as-of lookup uses the (wallet_id, changed_at DESC, id DESC) index
                                                 QUERY PLAN                                                 
------------------------------------------------------------------------------------------------------------
 Limit
   ->  Index Scan using wallet_status_history_as_of on wallet_status_history
         Index Cond: ((wallet_id = 'aaaaaaaa-0000-7000-8000-0000000000d9'::uuid) AND (changed_at <= now()))
```

**What to notice**
- The as-of query is "latest change at or before T". On 15 August the wallet did not exist yet, so the answer is empty, not a guess.
- The periods come from the view; the same events answer both "when" and "during" questions.
- `EXPLAIN` shows an index scan on `wallet_status_history_as_of` with a `Limit`: one index probe, however long the history grows.

Now the product code. The repository changes the current status, appends the history row and the audit row in **one** transaction, and reads the status as of any moment.

**`src/repositories/walletStatusRepository.ts`**

```ts
// src/repositories/walletStatusRepository.ts — change a wallet's status, and read its status at any past moment.
import type pg from "pg";

export type WalletStatus = "active" | "frozen" | "closed";
export interface StatusChange { walletId: string; status: WalletStatus; reason: string; changedBy: string | null }
export interface StatusAt { status: WalletStatus; reason: string; changedAt: Date }

export class WalletStatusError extends Error {
  constructor(readonly code: "WALLET_NOT_FOUND" | "WALLET_CLOSED", walletId: string) {
    super(`${code}: ${walletId}`);
    this.name = "WalletStatusError";
  }
}

// One transaction: the current status, the history row and the audit row change together, or not at all.
export async function changeWalletStatus(pool: pg.Pool, change: StatusChange): Promise<"changed" | "unchanged"> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // FOR UPDATE: two support agents freezing and unfreezing at once are applied one after the other.
    const { rows: [wallet] } = await client.query<{ tenant_id: string; status: WalletStatus }>(
      "SELECT tenant_id, status FROM wallets WHERE id = $1 FOR UPDATE", [change.walletId]);
    if (!wallet) throw new WalletStatusError("WALLET_NOT_FOUND", change.walletId);
    if (wallet.status === "closed") throw new WalletStatusError("WALLET_CLOSED", change.walletId);
    if (wallet.status === change.status) {
      await client.query("ROLLBACK");
      return "unchanged"; // no history row for a non-change
    }
    await client.query(
      "UPDATE wallets SET status = $2, closed_at = CASE WHEN $2 = 'closed' THEN now() END WHERE id = $1",
      [change.walletId, change.status]);
    await client.query(
      "INSERT INTO wallet_status_history (wallet_id, status, reason, changed_by) VALUES ($1, $2, $3, $4)",
      [change.walletId, change.status, change.reason, change.changedBy]);
    await client.query(
      `INSERT INTO audit_log (tenant_id, actor_user_id, action, entity_type, entity_id, details)
       VALUES ($1, $2, 'wallet.status_change', 'wallet', $3, $4)`,
      [wallet.tenant_id, change.changedBy, change.walletId, { from: wallet.status, to: change.status, reason: change.reason }]);
    await client.query("COMMIT");
    return "changed";
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// "What was this wallet's status at 6 pm on 5 October?" The latest change at or before that moment.
export async function walletStatusAsOf(pool: pg.Pool, walletId: string, at: Date): Promise<StatusAt | null> {
  const { rows: [row] } = await pool.query<{ status: WalletStatus; reason: string; changed_at: Date }>(
    `SELECT status, reason, changed_at FROM wallet_status_history
     WHERE wallet_id = $1 AND changed_at <= $2
     ORDER BY changed_at DESC, id DESC LIMIT 1`, [walletId, at]);
  return row ? { status: row.status, reason: row.reason, changedAt: row.changed_at } : null;
}
```

**What to notice**
- `FOR UPDATE` serialises two agents clicking at once, so the history has a clean order.
- A non-change returns `"unchanged"` and writes nothing. History should hold events, not clicks.
- `ROLLBACK` in `catch` and `release()` in `finally`: a failed write never leaves a half-done status change or a leaked connection.
- The domain error has a stable `code`, which the API layer maps to a Problem Details response (P1-03).

**`test/walletStatus.test.ts`** runs against the real database:

```ts
// test/walletStatus.test.ts — status history against a real PostgreSQL 18 (run the migrations and fixtures first).
import pg from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { changeWalletStatus, walletStatusAsOf } from "../src/repositories/walletStatusRepository.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const TENANT = "aaaaaaaa-0000-7000-8000-000000000000";
const AMIT_STORES = "aaaaaaaa-0000-7000-8000-0000000000c2";
const SUPPORT = "aaaaaaaa-0000-7000-8000-0000000000a2";
let walletId: string;
const dbNow = async () => (await pool.query<{ t: Date }>("SELECT clock_timestamp() AS t")).rows[0]!.t; // the DB's clock, not Node's

beforeAll(async () => {
  // A new wallet starts with its first history row, in the same transaction as the wallet.
  const client = await pool.connect();
  await client.query("BEGIN");
  walletId = (await client.query<{ id: string }>(
    "INSERT INTO wallets (tenant_id, account_id) VALUES ($1, $2) RETURNING id", [TENANT, AMIT_STORES])).rows[0]!.id;
  await client.query("INSERT INTO wallet_status_history (wallet_id, status, reason) VALUES ($1, 'active', 'wallet opened')", [walletId]);
  await client.query("COMMIT");
  client.release();
});
afterAll(async () => { await pool.end(); });

it("answers 'what was the status at time T' for every point in the history", async () => {
  const beforeFreeze = await dbNow();
  await changeWalletStatus(pool, { walletId, status: "frozen", reason: "3 failed OTPs from a new device", changedBy: SUPPORT });
  const whileFrozen = await dbNow();
  await changeWalletStatus(pool, { walletId, status: "active", reason: "KYC re-verified", changedBy: SUPPORT });

  expect((await walletStatusAsOf(pool, walletId, beforeFreeze))?.status).toBe("active");
  expect((await walletStatusAsOf(pool, walletId, whileFrozen))?.status).toBe("frozen");
  expect((await walletStatusAsOf(pool, walletId, await dbNow()))?.status).toBe("active");
  expect(await walletStatusAsOf(pool, walletId, new Date("2020-01-01"))).toBeNull(); // before the wallet existed
});

it("keeps every change: history, current status and audit agree", async () => {
  const { rows: [r] } = await pool.query<{ history: string; audit: string; current: string }>(
    `SELECT (SELECT count(*) FROM wallet_status_history WHERE wallet_id = $1) AS history,
            (SELECT count(*) FROM audit_log WHERE entity_id = $1) AS audit,
            (SELECT status FROM wallets WHERE id = $1) AS current`, [walletId]);
  expect(r).toEqual({ history: "3", audit: "2", current: "active" });
});

it("does not write history for a non-change", async () => {
  expect(await changeWalletStatus(pool, { walletId, status: "active", reason: "double click", changedBy: SUPPORT })).toBe("unchanged");
});

it("refuses to rewrite history, even from SQL", async () => {
  await expect(pool.query("UPDATE wallet_status_history SET status = 'active' WHERE wallet_id = $1", [walletId]))
    .rejects.toMatchObject({ code: "23001", constraint: "wallet_status_history_append_only" });
});

it("never reopens a closed wallet", async () => {
  await changeWalletStatus(pool, { walletId, status: "closed", reason: "customer asked to close", changedBy: SUPPORT });
  await expect(changeWalletStatus(pool, { walletId, status: "active", reason: "oops", changedBy: SUPPORT }))
    .rejects.toMatchObject({ code: "WALLET_CLOSED" });
});
```

**Run it:**

```bash
npx vitest run
```

**Real output:**

```text
✓ test/walletStatus.test.ts > answers 'what was the status at time T' for every point in the history
✓ test/walletStatus.test.ts > keeps every change: history, current status and audit agree
✓ test/walletStatus.test.ts > does not write history for a non-change
✓ test/walletStatus.test.ts > refuses to rewrite history, even from SQL
✓ test/walletStatus.test.ts > never reopens a closed wallet
Test Files  1 passed (1)
Tests  5 passed (5)
```

**What to notice**
- The test takes timestamps from the **database's** clock (`clock_timestamp()`), not Node's, so "before the freeze" really is before it, even if the two clocks differ.
- "Refuses to rewrite history, even from SQL" goes around the repository on purpose, straight to the table, and still fails with `23001`.

---

## 🔨 Break it and measure it

Do these on your machine. After each change, rerun `sh run-migrations.sh`, the fixtures and `test/sql/bad-data.sql`, and watch which rows turn into `(bug)`.

1. **Delete `CHECK (amount_minor > 0)`** from `transfers`. *Expected:* cases 21 and 22 become `ACCEPTED (bug)`. A zero-rupee and a negative transfer are now "valid".
2. **Drop `tenant_id` from the wallets foreign key** (make it `FOREIGN KEY (account_id) REFERENCES accounts (id)`). *Expected:* case 19 is accepted: a wallet in one tenant now points at another tenant's account.
3. **Make the email index a plain `UNIQUE (tenant_id, email)`** without `WHERE deleted_at IS NULL`. *Expected:* control 5 becomes `REJECTED (bug)`: a deleted user's email can never be used again.
4. **Drop the `ledger_entries_append_only` trigger.** *Expected:* cases 34 and 35 are accepted. Anyone with `UPDATE` rights can now rewrite money history.
5. **Point `ledger_entries.currency` at `currencies` instead of `wallet_balances`.** *Expected:* case 33 is accepted: an entry in USD for a wallet that holds only INR.
6. **Insert `10.5` as a numeric literal** into `transfers.amount_minor` in `psql`. *Seen while writing this guide:* it is stored as `11` (`sql/money-types.sql`). No constraint can catch a value that was already rounded.
7. **Run the benchmark one row per transaction** (`BATCH = 1`). *Expected:* everything gets much slower, because commit cost dominates, and the gap between key types shrinks. Batch size is part of any benchmark's result.
8. **Make the index bigger than your RAM.** Insert 5 crore rows per key type on a laptop with 8 GB. *Expected:* UUIDv4's insert rate falls far more than in this guide's 16 MB run, because the misses now go to disk.

**Measurements**

| Measure (from the card) | This guide's run (**Real output**, PostgreSQL 18.4) | Your machine |
|---|---|---|
| Insert rate, bigint / UUIDv4 / UUIDv7 (256 MB cache) | 2,75,269 / 1,17,295 / 2,00,109 rows/s | fill after running the lab on your machine |
| Insert rate, bigint / UUIDv4 / UUIDv7 (16 MB cache) | 2,68,241 / 95,378 / 1,94,404 rows/s | fill after running the lab on your machine |
| Primary-key index size, bigint / UUIDv4 / UUIDv7 | 21.4 / 37.7 / 30.1 MiB (leaf density 90.0 / 71.9 / 90.0%) | fill after running the lab on your machine |
| Index pages read from outside the cache (16 MB) | 1 / 2,35,735 / 1 | fill after running the lab on your machine |
| Bad-data tests the database itself rejects | **44 of 44**, plus 3 of 3 valid controls accepted | fill after running the lab on your machine |
| Constraints in the schema | 160 (36 CHECK, 19 FK, 82 NOT NULL, 14 PK, 8 UNIQUE, 1 EXCLUDE), plus 1 partial unique index and 3 append-only triggers | fill after running the lab on your machine |
| Reading a stored balance vs summing 10 lakh entries | 0.48 ms vs 132 ms | fill after running the lab on your machine |

---

## 🚫 Common mistakes and wrong mental models

### Wrong mental model: "the app validates, so the database does not need constraints"

The app is one writer among many. Migrations, backfill scripts, a second service, a support engineer in `psql`, a data fix at 2 am, and the app itself with a bug all write to the same tables. And two concurrent requests can both pass an "is it unique?" check in code before either inserts.

**Beginner way**

```sql
CREATE TABLE transfers (id uuid PRIMARY KEY, source_wallet_id uuid, destination_wallet_id uuid, amount numeric);
-- "the TransferService checks amount > 0 and that the wallets exist"
```

**Product way**

```sql
CREATE TABLE transfers (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  source_wallet_id uuid NOT NULL REFERENCES wallets (id) ON DELETE RESTRICT,
  destination_wallet_id uuid NOT NULL REFERENCES wallets (id) ON DELETE RESTRICT,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  CONSTRAINT transfers_not_to_self CHECK (source_wallet_id <> destination_wallet_id)
);
```

What breaks in the beginner way: the first script that skips the service stores a negative amount, an orphan wallet id or a self-transfer, and every report built on the table is now wrong.

**Correct model:** the app gives good errors; the database gives guarantees. Keep both (P1-06 for the edge, this card for the data).

### Floats for money

**Beginner way:** `amount float8` or `amount real`, and `amount * 0.18` for a fee.
**Product way:** `amount_minor bigint` plus a `currency` column; `numeric` for rates; one written rounding rule when posting.

What breaks: ten lakh additions of ₹0.10 summed to `100000.00000133288` in `float8` (Deep dive 5). Reconciliation fails by a fraction of a paisa, and nobody can say where it went.

### `timestamp` without a time zone

**Beginner way:** `created_at timestamp DEFAULT now()`.
**Product way:** `created_at timestamptz NOT NULL DEFAULT now()`.

What breaks: one moment, written by servers set to IST and to UTC, became two different values 5½ hours apart (the problem section). Every "today's transfers" report is now wrong for someone.

### Polymorphic foreign keys

**Beginner way and product way, both real.** **Real output** (`sql/polymorphic.sql`):

```sql
-- sql/polymorphic.sql — "owner_type + owner_id" vs an exclusive arc the database can enforce.
\set ON_ERROR_ROLLBACK on
\set VERBOSITY terse
\pset footer off
BEGIN;
-- Beginner way: one id column that can mean "a user" or "a wallet". No foreign key is possible.
CREATE TABLE notes_polymorphic (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_type text NOT NULL CHECK (owner_type IN ('user', 'wallet')),
  owner_id uuid NOT NULL,
  body text NOT NULL);
INSERT INTO notes_polymorphic (owner_type, owner_id, body) VALUES
  ('wallet', uuidv7(), 'points at a wallet that does not exist'),
  ('user', 'aaaaaaaa-0000-7000-8000-0000000000d1', 'says user, but this id is a WALLET');
SELECT count(*) AS orphan_notes FROM notes_polymorphic n
WHERE NOT EXISTS (SELECT 1 FROM users u WHERE n.owner_type = 'user' AND u.id = n.owner_id)
  AND NOT EXISTS (SELECT 1 FROM wallets w WHERE n.owner_type = 'wallet' AND w.id = n.owner_id);

-- Product way: one nullable FK per kind of owner, and a CHECK that exactly one is set.
CREATE TABLE notes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid REFERENCES users (id),
  wallet_id uuid REFERENCES wallets (id),
  body text NOT NULL,
  CONSTRAINT notes_exactly_one_owner CHECK (num_nonnulls(user_id, wallet_id) = 1));
INSERT INTO notes (wallet_id, body) VALUES (uuidv7(), 'points at a wallet that does not exist');
INSERT INTO notes (user_id, body) VALUES ('aaaaaaaa-0000-7000-8000-0000000000d1', 'a wallet id in the user column');
INSERT INTO notes (body) VALUES ('belongs to nobody');
INSERT INTO notes (user_id, wallet_id, body) VALUES ('aaaaaaaa-0000-7000-8000-0000000000a2', 'aaaaaaaa-0000-7000-8000-0000000000d2', 'belongs to both');
INSERT INTO notes (wallet_id, body) VALUES ('aaaaaaaa-0000-7000-8000-0000000000d2', 'a real wallet: accepted');
SELECT count(*) AS notes_stored FROM notes;
ROLLBACK;
```

```text
 orphan_notes 
--------------
            2

psql:sql/polymorphic.sql:26: ERROR:  insert or update on table "notes" violates foreign key constraint "notes_wallet_id_fkey"
psql:sql/polymorphic.sql:27: ERROR:  insert or update on table "notes" violates foreign key constraint "notes_user_id_fkey"
psql:sql/polymorphic.sql:28: ERROR:  new row for relation "notes" violates check constraint "notes_exactly_one_owner"
psql:sql/polymorphic.sql:29: ERROR:  new row for relation "notes" violates check constraint "notes_exactly_one_owner"
 notes_stored 
--------------
            1
```

What breaks in the beginner way: both bad notes were accepted, including one whose `owner_type` says "user" but whose id is a wallet. The database cannot help, because there is no single table a foreign key could point to. The **exclusive arc** (one nullable FK per owner type, plus `num_nonnulls(...) = 1`) rejected all four bad rows and kept the good one.

Other fixes, depending on the case:
- A **supertype table**: our `accounts` table is the "party" that owns wallets, whether personal or business, so wallets need only one foreign key.
- **Separate tables per owner** (`user_notes`, `wallet_notes`) when the owners have little in common.
- The audit log is the honest exception (Deep dive 7): it records history, not a relationship.

### More mistakes seen in real schemas

- **UUIDv4 as the primary key of a huge, insert-heavy table.** Measured above: 0.49 times UUIDv7's insert rate once the index left the cache.
- **`serial` for new tables.** Use `GENERATED ALWAYS AS IDENTITY`.
- **`varchar(255)` everywhere.** The 255 is a habit, not a rule. Use `text` with a named CHECK for the real limit.
- **No index on foreign key columns.** Joins and parent deletes scan the child table.
- **`ON DELETE CASCADE` on money.** Deleting a wallet must never silently delete its transfers. Use RESTRICT.
- **Soft delete with a plain `UNIQUE`.** Deleted users block their own email forever.
- **A stored balance with no reconciliation job.** The copy will drift one day; only a check will tell you.
- **Entity-attribute-value tables** (`attribute_name`, `attribute_value`). No types, no constraints, no indexes that help. Use real columns, or `jsonb` for truly free-form data.
- **Natural keys that are not stable**: email or phone number as a primary key.

---

## ✅ Production checklist

**Model**
- [ ] I started from the access patterns (a table like Deep dive 9), not only from nouns.
- [ ] Every fact lives in one place (3NF), and every deliberate copy is listed with its owner and its reconciliation query.
- [ ] One-to-one, one-to-many and many-to-many are explicit; join tables have their own primary key.

**Keys and types**
- [ ] Surrogate keys everywhere except stable, short, non-sensitive codes (currencies).
- [ ] UUIDv7 for ids in URLs; bigint identity for internal high-volume tables (or a deliberate, written alternative).
- [ ] Money is `bigint` minor units with a currency; rates are `numeric`; no floats; no `money` type.
- [ ] Every moment is `timestamptz`; calendar dates are `date`.
- [ ] Text limits are named CHECKs; statuses are CHECK lists or lookup tables, chosen on purpose.

**Constraints**
- [ ] NOT NULL on every column that is always required.
- [ ] Every business rule about stored data is a constraint, and important ones have readable names.
- [ ] Every foreign key has a deliberate `ON DELETE`, and an index on the referencing columns.
- [ ] Time periods use ranges with an exclusion constraint (or PG18 `WITHOUT OVERLAPS`).
- [ ] A bad-data test suite (like `test/sql/bad-data.sql`) runs in CI, with valid controls.

**Lifecycle and history**
- [ ] `created_at` and `updated_at` are set by the database; `version` is checked by writers.
- [ ] Money and history tables are append-only (trigger and `REVOKE UPDATE, DELETE`).
- [ ] Status changes write history in the same transaction as the current status.
- [ ] Soft delete uses partial unique indexes and one filtered view; personal data can be erased without losing money records.

**Tenancy and operations**
- [ ] `tenant_id` on every tenant-owned row, inside composite foreign keys; global tables are marked as such.
- [ ] The app's database role cannot change the schema (P1-06).
- [ ] Constraint errors are mapped to Problem Details codes by constraint name, and their row details are not logged.

---

## 🤖 Engineering with AI

**Where AI tools help with this concept**
- Turning a feature description into a first ER diagram and table list, fast.
- Listing constraints you forgot, if you ask for "every rule about stored data".
- Writing the repetitive parts: migration boilerplate, bad-data test cases, fixtures.
- Explaining a constraint error or an `EXPLAIN` plan.

**Where they commonly go wrong**
- They write `id uuid PRIMARY KEY DEFAULT gen_random_uuid()` (UUIDv4) on every table, including the biggest ones.
- They use `amount DECIMAL(10,2)` or `float` and do maths in JavaScript numbers.
- They write `created_at TIMESTAMP` (no time zone), copied from MySQL-flavoured examples.
- They add foreign keys without indexes, and `ON DELETE CASCADE` everywhere "to keep it clean".
- They generate polymorphic `owner_type` / `owner_id` columns, or a `metadata jsonb` column that slowly holds half the schema.
- They put rules in the service and none in the schema ("validation happens in the API").
- They forget `tenant_id` in foreign keys, or make uniqueness global instead of per tenant.
- They hard-delete rows that history depends on.

**Review checklist for AI-generated schema changes**
- [ ] Key type is chosen per table (URL-facing vs internal), not one default everywhere.
- [ ] Money is integer minor units; time is `timestamptz`.
- [ ] Every rule in the ticket appears as a constraint, with a test case that tries to break it.
- [ ] Every foreign key: deliberate `ON DELETE`, an index, and `tenant_id` inside it.
- [ ] No polymorphic references outside the audit log; no EAV.
- [ ] History tables are append-only; soft deletes have partial unique indexes.
- [ ] The migration is safe on a big table (`NOT VALID` + `VALIDATE` for new constraints, no long locks).

**Prompts that work**

1. *"Here are our access patterns (paste the Q1-Q8 table) and our current schema. Propose changes so each query is served by a key or an index. For each change, say which query it serves and what it costs on writes. Do not add indexes that no query needs."*
   **Verify by:** running `EXPLAIN` for each query on realistic data; every new index must appear in at least one plan.
2. *"List every business rule about stored data in this feature description, then write a CHECK, UNIQUE, FOREIGN KEY or EXCLUDE constraint for each one, with a readable name. Then write one bad-data case per constraint for our `check_case` harness, plus one valid control per table."*
   **Verify by:** running the harness. Every case must be `rejected (ok)` or `accepted (ok)`, and the `caught_by` column must name the constraint you expected (two of this guide's cases first fired the wrong rule).
3. *"Review this migration for: UUIDv4 keys on high-volume tables, floats for money, timestamp without time zone, foreign keys without indexes or tenant_id, cascades on money tables, polymorphic references, and locks that would block a table with 10 crore rows."*
   **Verify by:** applying the migration to a copy with production-like row counts and timing it, and by running the bad-data suite.

---

## 🎤 Interview script

**How it shows up**
- **System design rounds:** after requirements and APIs, "design the data model" is a fixed step. Interviewers listen for constraints, keys and access patterns, not just table names.
- **LLD and machine-coding rounds:** "model a wallet with transfers", "design the schema for a splitwise-style app". They expect clean relationships and correct types.
- **Follow-ups** go to money types, IDs, history and multi-tenancy.

**A 2-minute spoken answer: "Design the data model for a wallet and payments product."**

1. "I start from the access patterns: show the balance, list recent transactions, make a transfer exactly once, check a wallet's status at the time of a dispute, and month-end reports."
2. "Entities: tenants, users, accounts as the party that owns money, members as the many-to-many between users and accounts, wallets, a balance per wallet per currency, transfers, ledger entries, idempotency keys, status history and an audit log."
3. "Keys: UUIDv7 for anything in a URL, because it is opaque but time-ordered, so inserts stay local in the index. bigint identity for internal high-volume tables like ledger entries. Natural key only for currency codes."
4. "Types: money as bigint minor units plus a currency, numeric for rates, timestamptz for every moment."
5. "Rules in the database: amounts positive, no self-transfer, one transfer per idempotency key, balance never negative, both wallets in the same tenant and holding that currency, no overlapping limit periods. Each one is a named constraint, and a test tries to break each one."
6. "History: ledger entries and audit are append-only. Status changes go into a history table in the same transaction as the current status, so 'what was it on the 6th' is one indexed query."
7. "The balance is a deliberate copy of the entries, updated in the same transaction and reconciled daily. And tenant_id sits in every composite foreign key, so cross-tenant data cannot even be stored."

**Likely follow-ups, with strong answers**

1. **"UUID or bigint?"**
   It depends on the table. bigint is smallest and fastest, but guessable and leaks volume in URLs. UUIDv4 is opaque but random, which hurts index locality: in my benchmark on 10 lakh rows its index was 25% bigger than UUIDv7's and its inserts about half as fast once the index left the cache. UUIDv7 is opaque and time-ordered, and costs about a third more than bigint. It does leak creation time, which is fine for transfers.
2. **"How do you keep the stored balance correct?"**
   Same transaction as the ledger entries, through one code path, with row locks in a fixed order (P2-04). A CHECK stops it going negative. A reconciliation job compares it with the sum of entries and alerts on any difference, and the balance can always be rebuilt from the entries.
3. **"A user asks to delete their account. What happens to their transfers?"**
   Transfers and ledger entries are never deleted: PMLA and RBI rules require keeping transaction records for years. The user row is soft-deleted and its personal fields are erased or anonymised under the DPDP Act. The ids remain, so the money history still balances.
4. **"How do you model status history so nothing is lost?"**
   An append-only history table, one row per change with status, reason, who and when, written in the same transaction as the current status. "Status at time T" is the latest row at or before T, served by an index on `(wallet_id, changed_at DESC)`. A trigger and revoked privileges stop edits. Periods, if needed, come from a view with `lead()`.
5. **"How would you support multiple currencies?"**
   A currencies lookup table with the minor unit, a balance row per wallet per currency (`PRIMARY KEY (wallet_id, currency)`), and a currency column on transfers and entries, enforced by a composite foreign key to the balance. FX is a separate pair of transfers through a conversion account, with the rate stored as numeric.
6. **"How do you prepare for multi-tenancy?"**
   `tenant_id NOT NULL` on every tenant-owned row, unique rules scoped per tenant, and composite foreign keys that include `tenant_id`, so a row can only reference rows in its own tenant. That makes row-level security or sharding by tenant later much simpler.

**Red flags interviewers notice**
- Floats or `DECIMAL` maths in application code for money.
- "We validate in the service" as the answer to data integrity.
- Every table with `id uuid DEFAULT gen_random_uuid()` and no reasoning.
- Status overwritten in place, with no history.
- `ON DELETE CASCADE` from users to transfers.
- Table names only, with no constraints and no access patterns.

**A small LLD sketch**

```ts
// The shapes the schema guarantees, as TypeScript types the repositories return.
type Paise = number & { readonly __brand: "Paise" };          // whole minor units, from bigint (P1-06)
type WalletStatus = "active" | "frozen" | "closed";             // mirrors wallets_status_check

interface Wallet { id: string; tenantId: string; accountId: string; status: WalletStatus; version: number }
interface Balance { walletId: string; currency: string; balanceMinor: Paise; version: number }
interface StatusEvent { walletId: string; status: WalletStatus; reason: string; changedBy: string | null; changedAt: Date }

interface WalletRepository {
  findById(tenantId: string, walletId: string): Promise<Wallet | null>;
  balances(walletId: string): Promise<Balance[]>;
  changeStatus(event: Omit<StatusEvent, "changedAt">): Promise<"changed" | "unchanged">; // history + audit, one transaction
  statusAsOf(walletId: string, at: Date): Promise<StatusEvent | null>;
}
```

---

## ❓ Questions from the card, answered

Try to answer each one aloud first, then open it.

<details>
<summary><b>1. When is denormalising worth it, and what keeps the copies consistent?</b></summary>

It is worth it when a read is **hot** and computing it from the normalised data is **expensive**, and when you can name an owner for the copy. On the ledger, the wallet balance is read on every app open; summing 10 lakh entries took about 132 ms against 0.48 ms for the stored balance (this guide's run). Counters, per-screen read models and search copies are the other common cases. It is not worth it when an index would fix the slow query, or when nobody will build the reconciliation.

What keeps the copies consistent:
1. Write the source and the copy in **one transaction**, through **one code path**.
2. Guard the copy with constraints (`CHECK (balance_minor >= 0)`).
3. **Reconcile** on a schedule: a query that lists every row where the copy and the source disagree, with an alert. In the demo, a one-sided "quick fix" was caught immediately.
4. Make the copy **rebuildable** from the source; never the other way round.
5. For copies in other systems, use events and accept a lag (Phase 4).

</details>

<details>
<summary><b>2. Why put rules in constraints instead of only in application code?</b></summary>

Because the application is not the only writer, and not always correct:
- **Other writers:** migrations, backfills, admin scripts, a second service, a support engineer in `psql`. None of them run your service's checks.
- **Races:** two requests can both pass a "does this exist?" check before either inserts. A unique index decides the race correctly every time.
- **Bugs:** the code path you forgot to test. The constraint still holds.
- **Documentation that cannot go stale:** the schema states the rule, and every write checks it.

In this guide's lab, 44 bad rows written straight into the database were all rejected, each with the constraint name, while 3 valid control rows were accepted. Keep the app's validation too: it gives users clear errors (P1-06). The two layers do different jobs.

</details>

<details>
<summary><b>3. UUIDv4 vs UUIDv7 vs bigint IDs: what changes for indexes and for URLs?</b></summary>

**Indexes.** A B-tree keeps keys in order. bigint and UUIDv7 keys increase over time, so new keys go to the right-most page: few pages are touched, they stay in memory, and pages are left about 90% full. UUIDv4 keys are random, so each insert hits a random page, causing page splits (pages end about 70% full) and cache misses once the index is bigger than memory. This guide's benchmark, 10 lakh rows on PostgreSQL 18.4:

| | Insert rate (256 MB / 16 MB cache) | Index size | Leaf density | Index pages read, 16 MB |
|---|---|---|---|---|
| bigint | 2,75,269 / 2,68,241 rows/s | 21.4 MiB | 90.0% | 1 |
| UUIDv4 | 1,17,295 / 95,378 rows/s | 37.7 MiB | 71.9% | 2,35,735 |
| UUIDv7 | 2,00,109 / 1,94,404 rows/s | 30.1 MiB | 90.0% | 1 |

UUIDs are also twice as wide as bigint in every index and foreign key that copies them.

**URLs.** bigint ids are guessable and reveal volume. UUIDv4 reveals nothing. UUIDv7 reveals the creation time to the millisecond (anyone can decode it), but is otherwise unguessable. UUIDs can also be made by the client or offline before insert; bigint needs the database.

**Practical choice:** UUIDv7 for ids in URLs, bigint identity for internal high-volume tables, UUIDv4 only where even the creation time must stay secret.

</details>

<details>
<summary><b>4. How do you model a wallet's status history so nothing is ever lost?</b></summary>

1. A `wallet_status_history` table: one row per change, with `status`, `reason`, `changed_by` and `changed_at`. CHECKs on status and reason.
2. **Append-only**: a trigger refuses `UPDATE` and `DELETE`, and the app's role has those privileges revoked. Corrections are new rows.
3. **Same transaction** as the change to `wallets.status` and the audit row, under a row lock, so current status and history never disagree. The wallet's first row is written when the wallet is created.
4. **"Status at time T"** = the latest row with `changed_at <= T`, using an index on `(wallet_id, changed_at DESC, id DESC)`. In the lab it answered four dates correctly, including "did not exist yet".
5. **Periods** (`valid_from`, `valid_to`) come from a view with `lead()`, so they are never stored twice. For facts that are naturally periods (limits, fee plans), store a `tstzrange` with an exclusion constraint, or `WITHOUT OVERLAPS` on PostgreSQL 18.

</details>

---

## 🏋️ Exercises

**Beginner (no code)**

1. A spreadsheet export has the columns `transfer_id, date, from_name, from_phone, to_name, to_phone, amount_rupees, currency, currency_decimals`. Normalise it to 3NF on paper. *Expected outcome:* separate users (or accounts), wallets, currencies and transfers tables; amounts in paise; `currency_decimals` in the currencies table. *Verify by:* checking that every non-key column depends on its table's key and nothing else.
2. For every foreign key in the lab schema, say why its `ON DELETE` is RESTRICT or CASCADE in one sentence. *Expected outcome:* money and history use RESTRICT; dependent detail rows use CASCADE. *Verify by:* the constraint list in step 2.

**Intermediate (extend the lab)**

1. Add `beneficiaries` (saved payees): an owner account, a destination wallet, a nickname, soft delete. Rules: one live entry per owner and wallet; a nickname of 1-40 characters; same tenant on both sides. *Expected outcome:* a migration plus at least 5 bad-data cases and 1 control, all `(ok)`. *Verify by:* the harness.
2. Measure the **secondary** index too: add `CREATE INDEX ON bench_<kind> (wallet_id, id)` with 1,000 different wallet ids and rerun the benchmark. *Expected outcome:* this index is spread across wallets for all three key types, so the gap between them is smaller than for the primary key. *Verify by:* index sizes and `avg_leaf_density` from `pgstatindex`.

**Advanced (failure injection or 10x scale)**

1. Add a new rule to a table with 1 crore rows without blocking writes: `ALTER TABLE transfers ADD CONSTRAINT transfers_max_amount CHECK (amount_minor <= 100000000000) NOT VALID`, then `VALIDATE CONSTRAINT`. Run inserts in a loop meanwhile. *Expected outcome:* inserts continue during `VALIDATE`; adding the constraint without `NOT VALID` blocks them for the whole scan. *Verify by:* the insert loop's timings, and `pg_locks` during each step.
2. At 10x scale the ledger has 50 crore entries. Compute (with code) the primary-key index size for bigint, UUIDv7 and UUIDv4 from this guide's bytes-per-entry numbers, and the extra size of two UUID foreign keys per entry vs bigint. *Expected outcome:* tens of GiB of difference, which changes how much fits in RAM. *Verify by:* building a 1 crore row version and extrapolating from real sizes, not from estimates.

---

## 📝 Quiz

1. Which relationship needs a join table, and why can't either side hold the other's id?
2. Why is `currencies.code` a good natural key, but `users.email` is not?
3. In this guide's benchmark, which key type had the smallest index, and which had the most index pages read from outside the cache?
4. What does UUIDv7 leak that UUIDv4 does not?
5. A table stores `account_name` in every membership row. Which normal form does it break, and what anomaly did the demo show?
6. What does a `RESTRICT` foreign-key violation return as SQLSTATE in the lab, compared with a normal foreign-key violation?
7. Why is `10.5` dangerous as a SQL literal for a `bigint` amount, but safe when node-postgres sends `'10.5'` as a parameter?
8. What does `timestamptz` actually store?
9. Why does the email uniqueness rule use a **partial** unique index?
10. What does `EXCLUDE USING gist (wallet_id WITH =, valid_during WITH &&)` guarantee, and why are the ranges half-open?

---

## 🔑 Quiz answer key

1. **Many-to-many** (users and accounts). Each side can have many of the other, so one column cannot hold "the" other id; the join table holds one row per pair, plus data about the pair (`relation`).
2. Currency codes are short, stable, standard and not sensitive. Emails change, are personal data, and would be copied into every child table and URL.
3. **bigint** had the smallest index (21.4 MiB). **UUIDv4** had the most index pages read from outside the cache (2,35,735 in the 16 MB run; the others read 1).
4. The **creation time**, to the millisecond, in its first 48 bits.
5. **2NF**: `account_name` depends on only part of the key (`account_id`). The demo showed an **update anomaly**: after renaming one row, the same account had two names.
6. **`23001`** (restrict_violation) for the RESTRICT delete, against **`23503`** (foreign_key_violation) for a normal FK failure.
7. A numeric literal is cast to `bigint` by **rounding** (`10.5` → `11`) before any CHECK runs. A text parameter `'10.5'` is parsed as a bigint and **rejected** with `22P02`.
8. An exact **moment** (in UTC). It is shown in the session's time zone; no zone is stored.
9. So the rule applies only to **live** users (`WHERE deleted_at IS NULL`): a soft-deleted user does not block their email from being used again.
10. No two rows for the **same wallet** have **overlapping** periods. Half-open ranges (`[start, end)`) let one period end exactly where the next begins with no gap and no overlap.

---

## 📖 Glossary

| Term | Meaning |
|---|---|
| Access pattern | A query the product runs, with its frequency and speed target |
| Append-only table | A table that only receives inserts; corrections are new rows |
| B-tree | Postgres's default index: sorted pages forming a tree |
| Cardinality | How many rows on each side of a relationship: one or many |
| Composite foreign key | A foreign key over several columns, like `(tenant_id, account_id)` |
| Denormalisation | Storing a copy or summary on purpose for faster reads |
| Exclusion constraint | A rule that no two rows match on given operators, like "same wallet and overlapping period" |
| Exclusive arc | One nullable FK per possible parent, plus a CHECK that exactly one is set |
| Fillfactor | How full Postgres fills index pages when building in order (90% by default for B-trees) |
| Identity column | `GENERATED ALWAYS AS IDENTITY`: the modern replacement for `serial` |
| Join table | A table that links two others in a many-to-many relationship |
| Leaf density | How full an index's leaf pages are, from `pgstatindex` |
| Lookup table | A small table of allowed values with their data, referenced by FK |
| Minor unit | The smallest unit of a currency (paise for INR); money stored as integers of it |
| Natural key | A key taken from the real world |
| Normal form | A rule that keeps each fact in one place (1NF, 2NF, 3NF) |
| Page split | Splitting a full index page into two, leaving both partly empty |
| Partial index | An index (or unique rule) over only the rows matching a WHERE clause |
| Polymorphic reference | A column that may point to rows in different tables; no FK can enforce it |
| Reconciliation | A regular check that a copy agrees with its source |
| Soft delete | Marking a row as deleted instead of removing it |
| Surrogate key | A made-up id with no business meaning |
| Tenant | A customer organisation whose data is kept separate |
| `tstzrange` | A Postgres range of `timestamptz` values, for periods |
| UUIDv7 | A time-ordered UUID (RFC 9562): 48-bit milliseconds, then random bits |
| WAL | Write-ahead log: every change is recorded here first |

---

## 📌 Cheat sheet

**Diagram: the card on one screen**

```mermaid
mindmap
  root((P2-01))
    Relationships
      PK equals FK for 1 to 1
      FK on the many side
      Join table for M to N
      Index every FK
    Keys
      UUIDv7 in URLs
      bigint for internal
      v4 hurts locality
      Natural only if stable
    Rules
      CHECK and UNIQUE
      Deliberate ON DELETE
      EXCLUDE for periods
      Test with bad rows
    Types
      bigint paise
      timestamptz
      text plus CHECK
      lookup over enum
    History
      Append-only
      Status events
      As-of query
      tenant_id everywhere
```

**How to read this diagram.** Each branch is one part of the card and each leaf is one rule. Pick a branch and explain each leaf with a ledger example. If one leaf has no example in your head, reread that Deep dive section.

**Key rules**

- Design from the queries (Q1-Q8), then normalise to 3NF, then denormalise on purpose with a reconciliation job.
- 1:1 = PK is the FK. 1:N = FK on the many side, with an index. M:N = join table with its own PK.
- UUIDv7 for URL-facing ids; bigint identity for internal high-volume tables; avoid UUIDv4 on big insert-heavy tables.
- Every rule about stored data is a named constraint; every FK has a chosen `ON DELETE` and an index; test with bad rows **and** valid controls.
- Money: `bigint` minor units plus currency. Time: `timestamptz`. Text: `text` plus CHECK. Status: CHECK list or lookup table.
- `created_at`/`updated_at` from the database; `version` compared by writers; soft delete with partial unique indexes.
- Money and history are append-only; status history is written in the same transaction; "as of T" is the latest row at or before T.
- `tenant_id` in every tenant-owned row and every composite FK.
- Measured here: UUIDv4 index 37.7 MiB vs UUIDv7 30.1 vs bigint 21.4; 2,35,735 vs 1 index pages read with a small cache; 44 of 44 bad rows rejected.

---

## 🏁 Completion checklist

- [ ] I drew the ER diagram on paper before reading the migrations, and it matched (or I understand every difference).
- [ ] My migrations include every constraint from the step 2 list, and I can name the business rule behind each.
- [ ] Measure: my bad-data harness shows every bad row rejected and every control accepted, with the expected constraint in `caught_by`.
- [ ] Measure: I ran the ID benchmark and filled in insert rate and index size for bigint, UUIDv4 and UUIDv7.
- [ ] I ran the benchmark a second time with a small `shared_buffers` and saw the cache-miss difference.
- [ ] My `wallet_status_history` answers "status as of" for past dates, including "did not exist yet", and refuses edits.
- [ ] I can explain when I would denormalise, and I wrote the reconciliation query for the copy.
- [ ] Phase 2 gate: I can design and defend a data model in an interview, with constraints, keys, types, history and access patterns, without being asked for them.
- [ ] Lab run on my machine.
- [ ] Numbers filled in the measurements table.
- [ ] Post published.

---

## 📣 Learn in public

Use **your own** measured numbers in place of the ones from this guide.

**Post 1: "UUIDv4 vs UUIDv7 vs bigint, on 10 lakh rows"**
- *Problem:* Our tables used random UUIDv4 primary keys. I wanted to know what that costs.
- *Decision:* Benchmarked all three key types on PostgreSQL 18, with `uuidv7()` now built in, in 1,000-row transactions.
- *Result:* UUIDv4's index was 37.7 MiB vs 30.1 (v7) and 21.4 (bigint). With a small cache, v4 read 2,35,735 index pages from outside the cache; v7 and bigint read 1. v7 inserted about twice as fast as v4.
- *Lesson:* Random keys are not free. UUIDv7 keeps ids opaque in URLs and keeps inserts local in the index.

**Post 2: "44 bad rows, 0 got in"**
- *Problem:* "The API validates" is not data integrity. Scripts and other services skip the API.
- *Decision:* Wrote every rule as a named constraint and built a `psql` harness that writes bad rows straight into the tables.
- *Result:* 44 of 44 bad rows rejected (CHECK, UNIQUE, FK, EXCLUDE, append-only triggers), 3 of 3 valid controls accepted. Two cases first fired the wrong rule, which taught me how Postgres orders its checks.
- *Lesson:* Test constraints like code, with valid controls, and check *which* rule fired, not just that something failed.

**Post 3: "What was the status on 6 October?"**
- *Problem:* A dispute needed a wallet's status at a past moment, but `wallets.status` only knew "now".
- *Decision:* An append-only status history written in the same transaction as the status change, plus an as-of query and a periods view.
- *Result:* One indexed query answers any date, including "did not exist yet", and history cannot be edited even from `psql`.
- *Lesson:* If someone will ever ask "what was true then", overwrite nothing.

**Hinglish video idea: "Database ko chowkidar banao: constraints, UUIDv7 aur history 12 minute mein"**
Open with a support script that puts ₹0 transfers into the ledger: "API ne roka, script ne nahi." Use the bank locker-register analogy. Then three live demos: the 44-row bad-data harness turning green, the UUIDv4 vs v7 benchmark table (2,35,735 vs 1), and the as-of query answering the dispute. End with: "Rule code mein bhi likho, par guarantee database se lo."

---

## ➡️ Next cards

- **P2-02 · Indexes and query plans.** Deep dive 9's access-pattern table becomes real work there: reading `EXPLAIN (ANALYZE, BUFFERS)`, composite and partial indexes, and why the `(wallet_id, created_at DESC, id DESC)` index serves Q2. The `idx_blks_read` numbers from this benchmark are your first taste of buffer analysis.
- **P2-09 (the double-entry journal).** Our `ledger_entries` table posts one debit and one credit per transfer, and `wallet_balances` is a copy. P2-09 generalises that: balanced journals with many lines, opening balances, system accounts, and a database rule that every journal sums to zero.
- **P7-03.** The card lists it by ID only. Your constraints list, history tables and tenant keys are the foundation it builds on.
- **Also linked:** the row locks in the walkthrough are **P2-04 · Concurrency control**; `tenant_id` in every composite key prepares **P7-06** (multi-tenancy with row-level security); the `version` column is P1-03's `ETag` seen from the database.

---

## 📚 Sources and further reading

All links checked on 14 October 2026.

- [PostgreSQL 18: UUID functions](https://www.postgresql.org/docs/18/functions-uuid.html) — `uuidv7()`, `uuidv4()`, `uuid_extract_timestamp()`, `uuid_extract_version()`.
- [PostgreSQL 18 released (25 September 2025)](https://www.postgresql.org/about/news/postgresql-18-released-3142/) — `uuidv7()`, temporal constraints (`WITHOUT OVERLAPS`, `PERIOD`).
- [PostgreSQL versioning policy](https://www.postgresql.org/support/versioning/) — 18.6 is the current minor release of 18.
- [PostgreSQL 18: CREATE TABLE](https://www.postgresql.org/docs/18/sql-createtable.html) — constraints, `ON DELETE` actions (RESTRICT vs NO ACTION), `WITHOUT OVERLAPS`, identity columns.
- [PostgreSQL 18: Constraints](https://www.postgresql.org/docs/18/ddl-constraints.html) — CHECK, NOT NULL, UNIQUE, foreign keys, exclusion constraints.
- [PostgreSQL 18: ALTER TYPE](https://www.postgresql.org/docs/18/sql-altertype.html) — enum `ADD VALUE` and its transaction limits; no way to drop a value.
- [PostgreSQL 18: Date/time types](https://www.postgresql.org/docs/18/datatype-datetime.html), [Numeric types](https://www.postgresql.org/docs/18/datatype-numeric.html) and [Character types](https://www.postgresql.org/docs/18/datatype-character.html).
- [PostgreSQL 18: Range types](https://www.postgresql.org/docs/18/rangetypes.html) — `tstzrange`, `&&`, `@>`, exclusion constraints on ranges.
- [PostgreSQL 18: btree_gist](https://www.postgresql.org/docs/18/btree-gist.html) and [pgstattuple](https://www.postgresql.org/docs/18/pgstattuple.html) — used by the exclusion constraint and the benchmark.
- [PostgreSQL 18: CREATE INDEX (fillfactor)](https://www.postgresql.org/docs/18/sql-createindex.html) — B-tree default fillfactor of 90.
- [PostgreSQL 18: Error codes](https://www.postgresql.org/docs/18/errcodes-appendix.html) — 23502, 23503, 23505, 23514, 23001, 23P01, 22P02.
- [PostgreSQL wiki: Don't Do This](https://wiki.postgresql.org/wiki/Don%27t_Do_This) — `timestamp` without time zone, `money`, `varchar(n)` by default, `char(n)`, `serial`.
- [RFC 9562: Universally Unique IDentifiers (UUIDs)](https://www.rfc-editor.org/rfc/rfc9562.html) — May 2024; UUIDv7 layout and monotonicity methods.
- [uuid (npm)](https://www.npmjs.com/package/uuid) — `v7()` for PostgreSQL 16 and 17.
- [node-postgres](https://node-postgres.com/) — the `pg` client used in the lab.
- [Mermaid: entity relationship diagrams](https://mermaid.js.org/syntax/entityRelationshipDiagram.html) — the `erDiagram` syntax used here.
- [Docker official image: postgres](https://hub.docker.com/_/postgres).
- [The Digital Personal Data Protection Act, 2023 (India Code)](https://www.indiacode.nic.in/bitstream/123456789/22037/2/a2023-22.pdf) — rights of correction and erasure.
- [Example: a bank's record retention policy citing PMLA and RBI KYC rules](https://slice.bank.in/documents/Policies/record-retention-policy.pdf) — at least five years for transaction and KYC records.
