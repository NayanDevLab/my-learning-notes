# P1-03 · REST API design

| | |
|---|---|
| **Phase** | 1 · Backend foundations |
| **Prerequisites** | P1-01 · How a request travels |
| **Leads to** | P1-04 · Other API styles: gRPC, GraphQL, webhooks · P1-05 · Authentication and authorisation · P3-04 · Rate limiting |
| **Suggested repo path** | `system-design/phase-1/p1-03-rest-api-design.md` |
| **Facts checked on** | 12 October 2026 |

**After this card you can:**

1. Model a payments API as resources, with clean URLs and correct HTTP methods and status codes.
2. Make "create transfer" safe to retry with idempotency keys, and prove it with a 50-request concurrency test.
3. Explain, with your own benchmark numbers, why offset pagination dies on big tables and how a cursor fixes it.
4. Return one consistent error format (RFC 9457 Problem Details) from every endpoint.
5. Change an API without breaking mobile apps that will not update for months, using an OpenAPI-first workflow.

> **About the numbers in this guide.** Everything marked **Real output** was run while writing this guide: Node 22, PostgreSQL 16.15, a 2-vCPU Linux sandbox. Your laptop will give different numbers; the *direction* will be the same. Everything marked **Expected** was not run here. Tool versions were checked on 12 Oct 2026: Fastify 5.12.5, Zod 4.6.6, node-postgres 8.23.1, Vitest 5.0.4, openapi-typescript 7.13.0, openapi-fetch 0.17.0, Redocly CLI 2.62.1, Schemathesis 4.31.0.

---

## ⏱️ The concept in one minute

An API is a **contract**. Your React Native app, your Next.js dashboard and a partner's backend all write code against it. Once they ship, you cannot change the contract freely.

**Definition.** REST API design is the craft of exposing your system as **resources** (things with URLs, like `/v1/transfers/t_91`) that clients act on with standard **HTTP methods** (GET, POST, PATCH, DELETE), getting back standard **status codes** and a predictable body.

**One line:** make the API boring, consistent and safe to retry.

**Analogy.** Think of the 3-pin plug socket in every Indian home. Every appliance maker builds to that standard. If the electricity board changed the socket shape, millions of appliances would stop working overnight. Your API is that socket. Design it once, carefully, and only add to it.

**On our ledger platform:** Riya taps "Pay ₹500" on a flaky 4G connection. The app calls `POST /v1/transfers`. The money moves, but the reply never reaches her phone. The app retries. A good API design makes sure ₹500 moves **once**, the app gets the same answer both times, and errors look the same everywhere.

---

## 💥 The problem it solves

Here is what goes wrong on the ledger platform when the API is designed casually.

**1. Double debits.** The app sends `POST /transferMoney`. The server commits the transfer, then the response is lost (tunnel, lift, weak signal). The app's HTTP library retries. Without idempotency, the server happily moves the money again.

How often? Take an illustrative app doing **20 lakh (2,000,000) transfers a day**. Assume 0.5% of calls time out on the client and are retried, and in 30% of those timeouts the server had already committed. *(These are assumptions for the example, not measurements.)*

| Quantity | Value (computed with Python) |
|---|---|
| Retries per day | 10,000 |
| Double debits per day without idempotency | 3,000 |
| Double debits per month | 90,000 |
| Money wrongly debited per day at an average of ₹450 | ₹13,50,000 |

Every one of those is a support ticket, a refund and a user who stops trusting the app.

**2. A slow, buggy transaction history.** The history screen uses `?page=10000&size=50`, which becomes `OFFSET 499950`. On a merchant wallet with 10 lakh rows, the database reads and throws away almost 5 lakh rows to return 50. In this guide's benchmark that page took **54 ms at p50 with offset vs 0.40 ms with a cursor (136x)**. Worse, when new payments arrive while the user scrolls, offset pages show the same rows twice.

**3. Errors nobody can handle.** One endpoint returns `{"error": "fail"}`, another returns `200 OK` with `{"success": false}`, a third leaks `duplicate key value violates unique constraint "transfers_pkey"`. The mobile team writes three different error parsers and still shows "Something went wrong".

**4. Breaking old apps.** A backend developer renames `amount` to `amountMinor`. The web dashboard deploys the same day. Version 3.2 of the Android app, still used by 30% of users, crashes on every transfer screen.

This card fixes all four with: resource modelling, correct HTTP semantics, idempotency keys, cursor pagination, Problem Details, additive evolution and an OpenAPI-first workflow.

---

## 🧰 Before you start

**Prerequisite card:** P1-01 · How a request travels. You should be comfortable with what happens between "app calls `fetch`" and "server sends bytes back": DNS, TCP, TLS, the HTTP request line, headers and body, and timeouts at each hop.

**Key terms (each is explained again where it first matters):**

| Term | Plain meaning |
|---|---|
| Resource | A thing your API exposes with its own URL, such as a wallet or a transfer. |
| Collection | A list of resources, such as `/v1/transfers`. |
| Safe method | A method that should not change anything on the server (GET, HEAD, OPTIONS). |
| Idempotent method | Sending it once or ten times leaves the server in the same state (GET, PUT, DELETE). |
| Idempotency key | A unique ID the client sends with a POST so the server can recognise a retry. |
| Minor units | Money stored as whole paise (₹500 = `50000`), never as a float. |
| Cursor (keyset) pagination | "Give me 50 rows after this exact row", instead of "skip 5 lakh rows". |
| Problem Details | A standard JSON shape for errors, defined in RFC 9457. |
| ETag | A version tag the server returns with a resource, used to detect lost updates. |
| OpenAPI | A YAML or JSON file that describes every endpoint, field and status code of your API. |

**Lab setup you need:** Node 22+, Docker (for Postgres 16), and about 2 hours. Python 3.10+ only for the optional Schemathesis contract tests.

---

## 🧠 How it works

**Mental model: the API is a promise, not a function call.** A function call either returns or throws. An HTTP call can also end in "I don't know": a timeout, a 502 or a 504. In that case the request may or may not have run. Good API design gives the client a safe move for every outcome, including "I don't know". For reads, the safe move is to retry. For money movement, the safe move is to **retry with the same idempotency key**.

**The pieces of the contract:**

1. **URLs name things** (`/v1/transfers/t_91`), **methods say what to do** (POST creates, GET reads).
2. **Status codes say what happened**, in a way every HTTP library, proxy and developer already understands.
3. **Headers carry the protocol extras**: `Idempotency-Key`, `ETag` and `If-Match`, `Location`, `Retry-After`, `Deprecation`.
4. **Bodies have fixed shapes**: resources, list pages `{ data, page }`, and Problem Details for errors.
5. **The OpenAPI file is the single source of truth.** Types for the server and every client are generated from it.

**Diagram: the API contract between apps and the ledger**

```mermaid
flowchart TD
  spec["openapi.yaml<br/>the contract"]
  subgraph Clients
    rn["React Native app"]
    web["Next.js dashboard"]
    partner["Partner backend"]
  end
  subgraph Server["Ledger API"]
    routes["Routes<br/>validate and claim key"]
    services["Services<br/>business rules"]
    db[("Postgres")]
  end
  spec -->|"generated types"| rn
  spec -->|"generated types"| web
  spec -->|"Zod schemas checked against types"| routes
  rn -->|"HTTPS + JSON"| routes
  web -->|"HTTPS + JSON"| routes
  partner -->|"HTTPS + JSON"| routes
  routes --> services
  services --> db
```

**How to read this diagram.** The spec at the top feeds everyone. The two apps get TypeScript types generated from it, so a wrong field name fails at compile time. The server's Zod schemas are checked against the same types. Requests flow from any client into the routes, which validate the input and claim the idempotency key before the services touch Postgres.

**A React developer's way to see it:** the OpenAPI spec is like the `props` type of a component used by many teams. You can add an optional prop any time. Renaming or removing a prop breaks every caller. The difference is that API callers are deployed on phones you do not control, so you cannot "fix all the call sites" in one PR.

---

## 🔬 Deep dive

Each Learn-inside item from the card gets its own section. Every core idea has a **minimal version** (one small file you can run with `npx tsx`) and later, in the lab, a **product version**.

### 1. Resource modelling

**What it is.** You expose nouns (resources) and let HTTP methods be the verbs. The ledger platform has accounts, wallets, transfers, wallet transactions and statement exports.

**Rules that keep URLs boring:**

- **Plural nouns, always**: `/v1/wallets`, `/v1/transfers`. Never mix `/wallet/w1` and `/transfers`.
- **kebab-case paths, camelCase JSON**: `/v1/statement-exports`, `{ "amountMinor": 50000 }`. camelCase matches JavaScript clients, so no mapping layer is needed on the app side.
- **Opaque IDs**: UUIDs as strings. Clients must not parse them or guess the next one.
- **Shallow nesting**: at most `collection/{id}/sub-collection`. Address a single item at the top level.

**Sub-resource or query parameter?**

- Use a **sub-resource path** when the child only makes sense inside one parent, and access follows the parent. A wallet's transaction history belongs to exactly one wallet: `GET /v1/wallets/{walletId}/transactions`.
- Use a **query parameter** when you are filtering a top-level collection by an attribute, or when the relation is many-to-many. A transfer touches **two** wallets, so nesting it under one wallet is wrong. Use `GET /v1/transfers?walletId=w1&status=completed`.

**Actions that do not fit CRUD.** "Transfer money", "reverse a transfer" and "export a statement" sound like verbs. Turn each one into a **resource that records the action**. It gets its own ID, status, history and idempotency.

| Beginner URL (verb) | Product URL (resource) | Why it is better |
|---|---|---|
| `POST /transferMoney` | `POST /v1/transfers` | The transfer gets an ID you can GET, list and audit. |
| `GET /getWalletBalance?id=w1` | `GET /v1/wallets/w1` | Balance is a field of the wallet, not a separate thing. |
| `POST /v1/transfers/t1/reverse` | `POST /v1/transfers/t1/reversals` | A reversal has its own ID, reason, status and audit trail. |
| `POST /v1/wallets/w1/freeze` | `PATCH /v1/wallets/w1` with `{"status":"frozen"}` | Freezing is a state change. If you need reason and actor, model `POST /v1/wallets/w1/freezes`. |
| `GET /v1/accounts/a1/wallets/w1/transactions/t9` | `GET /v1/wallets/w1/transactions` and `GET /v1/transactions/t9` | Deep paths force clients to know the whole parent chain. |
| `POST /v1/exportStatement` | `POST /v1/wallets/w1/statement-exports` | The export is a long-running job with a status you can poll. |

**When not to force REST.** Real-time streams, high-throughput service-to-service calls and "client picks the exact shape" screens may fit WebSockets, gRPC or GraphQL better. That is card P1-04.

**Trade-off.** Resource-oriented design adds a few more nouns than an RPC style (`/reversals` instead of `/reverse`). In return you get IDs, auditability, caching and idempotency for free from HTTP itself.

### 2. HTTP semantics: safe vs idempotent, and the status codes that matter

**Safe** means "does not change server state" (a read). **Idempotent** means "the effect of N identical requests is the same as the effect of one" (RFC 9110, section 9.2). Idempotency is about **server state, not the response**. Deleting a wallet twice returns `204` then `404`, and that is still idempotent: the wallet is gone either way.

| Method | Safe? | Idempotent? | On the ledger platform |
|---|---|---|---|
| GET | Yes | Yes | Read a transfer, list history |
| HEAD, OPTIONS | Yes | Yes | Metadata, CORS preflight |
| PUT | No | Yes | Replace a whole resource, such as notification settings |
| DELETE | No | Yes | Close a beneficiary |
| PATCH | No | **Not guaranteed** | `{"status":"frozen"}` is idempotent; `{"op":"increment"}` is not |
| POST | No | **No** | Create a transfer. Needs an idempotency key. |

**Why this matters in practice.** HTTP clients, SDKs and proxies are allowed to retry idempotent requests automatically after a connection failure (RFC 9110 says a client can do this for idempotent methods). So a GET that has side effects (`GET /v1/transfers/t1/approve`) is a real bug: a retry or a link preview bot will approve it again.

**Status codes that matter**

| Code | Meaning on the ledger platform | Client should retry? |
|---|---|---|
| 201 Created | Transfer created. `Location: /v1/transfers/{id}` | No, done |
| 202 Accepted | Statement export started. `Location` points to the status resource | Poll the Location |
| 204 No Content | Delete or update with nothing to return | No |
| 400 Bad Request | Malformed JSON, wrong types, missing required field or header | No, fix the request |
| 401 Unauthorized | No token, or an invalid or expired token | After refreshing the token |
| 403 Forbidden | Valid user, but not allowed (someone else's wallet) | No |
| 404 Not Found | No such wallet, or you may not know it exists | No |
| 409 Conflict | Clashes with current state: idempotency key reused or still processing | 409-in-progress: yes, same key, after `Retry-After` |
| 412 Precondition Failed | `If-Match` ETag does not match (someone else changed it) | Re-read, then retry |
| 422 Unprocessable Content | Valid shape, but breaks a business rule: insufficient funds | No |
| 429 Too Many Requests | Rate limited (card P3-04) | Yes, after `Retry-After` |
| 500 Internal Server Error | A bug | Yes, **with the same idempotency key** |
| 502 Bad Gateway | The proxy got a bad response from the app server (crash, reset) | Yes, same key |
| 503 Service Unavailable | Overloaded or in maintenance | Yes, after `Retry-After`, same key |
| 504 Gateway Timeout | The proxy gave up waiting. **The transfer may have succeeded** | Yes, same key. Never assume it failed |

The key insight: **a timeout, 502 or 504 means "unknown", not "failed".** Only an idempotency key makes "unknown" safe to retry.

**Diagram: choosing a status code for an error**

```mermaid
flowchart TD
  auth{"Valid credentials?"}
  auth -->|"no"| s401["401 Unauthorized"]
  auth -->|"yes"| perm{"Allowed to do this?"}
  perm -->|"no"| s403["403 Forbidden<br/>or 404 to hide it"]
  perm -->|"yes"| parse{"Parses and matches<br/>the schema?"}
  parse -->|"no"| s400["400 Bad Request"]
  parse -->|"yes"| exists{"Resource exists?"}
  exists -->|"no"| s404["404 Not Found"]
  exists -->|"yes"| state{"Clashes with<br/>current state?"}
  state -->|"yes"| s409["409 Conflict<br/>412 if If-Match failed"]
  state -->|"no"| rule{"Breaks a<br/>business rule?"}
  rule -->|"yes"| s422["422 Unprocessable Content"]
  rule -->|"no"| ok["Success: 200, 201, 202 or 204"]
```

**How to read this diagram.** Walk from the top and stop at the first "no" (or "yes" for the two clash checks). Authentication comes first, then permission, then "can I even understand this request", then "does the thing exist", then the state and business checks. Rate limiting (429) usually happens even before the first box, at the gateway.

**400 vs 409 vs 422, the rule we use on this platform:**

- **400**: "I cannot understand this request." Bad JSON, wrong types, unknown fields, a missing required header. Fix the request.
- **422**: "I understood you, but the rules say no." Insufficient funds, same source and destination, frozen wallet.
- **409**: "Your request is fine, but it clashes with the current state of the resource." The idempotency key is in use by a different request, or the same request is still processing.

Teams disagree at the edges. Some return 400 for every validation error (Stripe-style); some return 409 for insufficient funds. **Consistency beats the "perfect" choice.** Write the rule down, put it in the OpenAPI file, and give every error a machine-readable `code` so clients never depend on the status alone.

### 3. Pagination: offset vs cursor (keyset)

**Offset pagination** says "skip N rows, give me 50": `LIMIT 50 OFFSET 499950`. **Cursor (keyset) pagination** says "give me 50 rows that come after this exact row": `WHERE (created_at, id) < ($ts, $id) ORDER BY created_at DESC, id DESC LIMIT 50`.

**Why offset gets slow.** The database cannot jump to row 499,951. It walks the index from the start, reads every row, throws 499,950 of them away, and returns 50. The cost grows with the page number. A cursor uses the index to **seek** straight to the position, so every page costs about the same.

**Diagram: what each query reads on page 10,000**

```text
OFFSET 499950 LIMIT 50          (newest first, index order)

[r1][r2][r3] ......................... [r499950][r499951 ... r500000]
 \__________ read, then thrown away __________/ \____ returned ____/
                 499,950 rows                       50 rows

WHERE (created_at, id) < cursor LIMIT 50

[r1][r2][r3] ......................... [r499950][r499951 ... r500000]
                       index seek lands here --^ \__ read + returned _/
                                                       50 rows
```

**How to read this diagram.** Both queries return the same 50 rows. The offset query pays for every row to the left of the page. The cursor query jumps to the position using the `(wallet_id, created_at, id)` index and reads only the 50 it returns.

**Why offset shows duplicates.** Offset counts positions, not rows. If two new payments arrive while Riya reads page 1, every older row shifts down by two. Page 2 then starts two rows "early", and she sees two rows again. Deletes cause the opposite: skipped rows.

**Minimal version:** `minimal/offset-vs-cursor.ts`

```ts
// minimal/offset-vs-cursor.ts — offset pages repeat rows when new rows arrive; cursor pages do not.
// Run: npx tsx minimal/offset-vs-cursor.ts
type Txn = { id: number; createdAt: number };

// Newest first, like a transaction history screen. id breaks ties when createdAt is equal.
let rows: Txn[] = Array.from({ length: 10 }, (_, i) => ({ id: i + 1, createdAt: 1000 + i }));
const sorted = () => [...rows].sort((a, b) => b.createdAt - a.createdAt || b.id - a.id);

function offsetPage(page: number, size: number): number[] {
  return sorted().slice(page * size, page * size + size).map((r) => r.id);
}

function cursorPage(after: Txn | null, size: number): Txn[] {
  const older = after
    ? sorted().filter((r) => r.createdAt < after.createdAt || (r.createdAt === after.createdAt && r.id < after.id))
    : sorted();
  return older.slice(0, size);
}

const page1Offset = offsetPage(0, 4);
const page1Cursor = cursorPage(null, 4);
console.log("page 1 (both):        ", page1Offset);

// Two new payments arrive while the user is reading page 1.
rows.push({ id: 11, createdAt: 2000 }, { id: 12, createdAt: 2001 });

console.log("page 2 with offset=4: ", offsetPage(1, 4), "<- ids 7 and 8 shown again");
const lastSeen = page1Cursor[page1Cursor.length - 1]!;
console.log("page 2 with cursor:   ", cursorPage(lastSeen, 4).map((r) => r.id), "<- continues after id", lastSeen.id);
```

**Real output**

```text
page 1 (both):         [ 10, 9, 8, 7 ]
page 2 with offset=4:  [ 8, 7, 6, 5 ] <- ids 7 and 8 shown again
page 2 with cursor:    [ 6, 5, 4, 3 ] <- continues after id 7
```

**What to notice**

- The cursor remembers **a row** (`createdAt` and `id` of id 7), not a position. New rows at the top cannot shift it.
- The comparison has two parts: older timestamp, **or** same timestamp and smaller id. That second part is the tie-breaker.
- Offset is still fine for small, rarely changing lists (an admin list of 40 currencies).

**Stable sort keys: the two bugs that break cursors.** A cursor only works if the sort order is **total**: no two rows may share the same position. Both bugs below were reproduced on real Postgres while writing this guide.

**Real output** (from `bench/pagination-bench.ts`, shown in the lab)

```text
bug 1 (non-unique sort key): page 1 = [5,4]
  next page using created_at only:  [1]  <- ids 3 and 2 never shown
  next page using (created_at, id): [3,2,1]

bug 2 (timestamp precision): page 1 = [4], DB value 2026-10-12 10:00:00.123456+00, JS Date 2026-10-12T10:00:00.123Z
  next page with JS Date cursor:     [1]  <- ids 3 and 2 skipped
  next page with full-precision text: [3,2,1]
```

- **Bug 1: sorting by `created_at` alone.** In our ledger, both history rows of a transfer get the same timestamp. Rows that share the last timestamp on a page disappear. Fix: always add the unique `id` as the last sort key.
- **Bug 2: building the cursor from a JavaScript `Date`.** Postgres stores microseconds; a JS `Date` keeps only milliseconds. `.123456` becomes `.123`, and rows between those two instants vanish. Fix: build the cursor from the database's own text value at full precision (the product code uses `to_char(... 'US')`).

**Response shape.** Use the same shape for every list:

```json
{
  "data": [{ "id": "1042", "direction": "debit", "amountMinor": 50000, "createdAt": "2026-10-12T10:00:00.123Z" }],
  "page": { "hasMore": true, "nextCursor": "eyJ2IjoxLCJ0cyI6IjIwMjYtMTAtMTJUMTA6MDA6..." }
}
```

- **Opaque cursor.** Base64url-encoded JSON with a version number. Clients must pass it back as-is and never build one.
- **Fetch `limit + 1` rows** to know if there is another page, without a `COUNT(*)`.
- **No total count by default.** `COUNT(*)` on 10 lakh rows is itself slow. If the UI needs it, return an estimate or cache it.

**Trade-offs.** Cursors cannot jump to "page 7,342". For infinite scroll and "load more", nobody needs that. For admin tables that need page numbers, keep pages shallow, cap the offset (say 10,000 rows) and push users to filters. Each cursor is tied to one sort order; changing `sort` must restart from page 1.

**At 10x scale.** Offset latency grows with depth; cursor latency stays flat (see the measurements in the lab). Index size grows, but each cursor page still touches only a handful of index pages.

### 4. Filtering, sorting and field selection

**What it is.** Clients narrow, order and trim lists with query parameters. The rule is simple: **the same names and the same style on every list endpoint**, so the app team writes one helper.

**Conventions on this platform:**

| Need | Parameter | Example |
|---|---|---|
| Page size | `limit` (1 to 100, default 50) | `?limit=20` |
| Next page | `cursor` | `?cursor=eyJ2Ijox...` |
| Exact-match filter | field name | `?status=completed&walletId=w1` |
| Range filter | `<field>From`, `<field>To` | `?createdFrom=2026-10-01T00:00:00Z&createdTo=2026-10-31T23:59:59Z` |
| Sort | `sort`, `-` prefix for descending | `?sort=-createdAt` |
| Field selection | `fields`, comma separated | `?fields=id,status,amountMinor` |

**Allowlist everything.** Sorting only on columns that have an index; filtering only on known fields; selecting only known fields. A free-form `?sort=anything` is how you get a full table scan or an SQL injection.

**Why field selection matters to you as a frontend engineer.** A transfer list on a cheap Android phone over 3G does not need `note`, `metadata` and five timestamps. `fields=id,status,amountMinor` can cut payload size a lot. It is a light version of what GraphQL gives you (P1-04).

**Minimal version:** `minimal/list-query.ts`

```ts
// minimal/list-query.ts — one parser for every list endpoint: allowlisted filters, sort and fields.
// Run: npx tsx minimal/list-query.ts
const SORTABLE = { createdAt: "created_at", amountMinor: "amount_minor" } as const; // only indexed columns
const SELECTABLE = ["id", "status", "amountMinor", "createdAt", "note"] as const;
type Field = (typeof SELECTABLE)[number];

function parseListQuery(q: Record<string, string>) {
  const sort = q.sort ?? "-createdAt";
  const key = sort.replace(/^-/, "");
  if (!(key in SORTABLE)) throw new Error(`400: sort must be one of ${Object.keys(SORTABLE).join(", ")}`);
  const dir = sort.startsWith("-") ? "DESC" : "ASC";
  const column = SORTABLE[key as keyof typeof SORTABLE];
  // Always add the unique id as a tie-breaker, in the same direction.
  const orderBy = `${column} ${dir}, id ${dir}`;

  const fields = (q.fields ?? SELECTABLE.join(",")).split(",");
  const unknown = fields.filter((f) => !(SELECTABLE as readonly string[]).includes(f));
  if (unknown.length) throw new Error(`400: unknown fields ${unknown.join(", ")}`);
  return { orderBy, fields: fields as Field[], limit: Math.min(Number(q.limit ?? 50), 100) };
}

const pick = (row: Record<string, unknown>, fields: string[]) => Object.fromEntries(fields.map((f) => [f, row[f]]));

const row = { id: "t_91", status: "completed", amountMinor: 50000, createdAt: "2026-10-12T10:00:00Z", note: "Rent" };
const parsed = parseListQuery({ sort: "-amountMinor", fields: "id,status,amountMinor" });
console.log(parsed);
console.log("response row:", pick(row, parsed.fields));
for (const bad of [{ sort: "password" }, { fields: "id,ownerPan" }]) {
  try { parseListQuery(bad); } catch (e) { console.log(JSON.stringify(bad), "->", (e as Error).message); }
}
```

**Real output**

```text
{
  orderBy: 'amount_minor DESC, id DESC',
  fields: [ 'id', 'status', 'amountMinor' ],
  limit: 50
}
response row: { id: 't_91', status: 'completed', amountMinor: 50000 }
{"sort":"password"} -> 400: sort must be one of createdAt, amountMinor
{"fields":"id,ownerPan"} -> 400: unknown fields ownerPan
```

**What to notice**

- The client's word (`amountMinor`) is mapped to a real column (`amount_minor`) through a fixed table. User input never becomes SQL text.
- `id` is appended to every sort, so cursors stay stable (section 3).
- Unknown fields get a 400, not a silent ignore. A typo like `stauts=failed` that returns unfiltered data is worse than an error.

**Trade-off.** Strict rejection of unknown parameters catches typos but can bite during rollouts: a new app sends a new filter to an old server instance and gets a 400. Roll out server support **before** the app uses a new parameter.

### 5. Idempotency keys

**What it is.** For every user action that creates something or moves money, the client generates a unique key (a UUID) **once** and sends it in the `Idempotency-Key` header on the first attempt and on every retry. The server remembers the key, a hash of the request, and the response. A retry gets the stored response instead of a second transfer.

**Analogy.** At a busy chai stall you get token number 42. If you shout "one chai!" twice, the owner checks the token: 42 already has a chai coming. He does not make a second one. And if someone else shouts "two samosas!" holding token 42, he knows something is wrong.

**Is POST idempotent?** No. POST is neither safe nor idempotent by HTTP's definition. You **make** one POST endpoint idempotent with a key.

**The server's job, step by step:**

1. **Validate the request first.** A malformed body gets a 400 and never touches the key table.
2. **Claim the key atomically.** `INSERT ... ON CONFLICT DO NOTHING` on a `UNIQUE (client_id, idem_key)` constraint. If the insert wins, this request owns the key. The database, not your code, decides the winner.
3. **If the key already exists**, compare the stored request hash with this request's hash:
   - Different hash: the client reused a key for a different operation. Reject it (409 `IDEMPOTENCY_KEY_REUSED` on our platform).
   - Same hash, status `completed`: replay the stored status, headers and body, plus `Idempotent-Replayed: true`.
   - Same hash, status `processing`: the first request is still running. Return 409 `IDEMPOTENCY_REQUEST_IN_PROGRESS` with `Retry-After: 1`.
4. **Do the work and store the response in the same database transaction.** Either the money moves and the response is saved, or neither happens. There is no gap where money moved but the key says "processing".
5. **If the work fails with no commit** (crash, timeout, bug), release the key so the client's retry can run it again.
6. **Expire keys** after a published window (24 hours here) and purge them with a background job.

**Which responses are stored?** Results of real execution, including business failures like `422 INSUFFICIENT_FUNDS`. A retry should not suddenly succeed because the user topped up in between; that would be a new operation and deserves a new key. Validation errors (400) are not stored because execution never started. Crashes (5xx) are not stored in our lab because the single transaction guarantees nothing committed, so a retry is safe. Not every API makes that choice: Stripe's docs say its v1 API saves the first result once execution has begun, **including 500s**, and prunes keys after at least 24 hours. Both rules are defensible; pick one and document it.

**Where the standard stands (checked 12 Oct 2026).** The IETF HTTPAPI working group's *The Idempotency-Key HTTP Header Field* draft is at version 07 (October 2025) and is marked expired; it is not an RFC. It is still the best shared reference, and payment APIs like Stripe already work this way. The draft recommends **400** for a missing key, **422** for a key reused with a different payload, and **409** for a retry while the original is still processing. This card asks for **409 on a reused key**; both are defensible. We follow the card and keep the machine-readable `code` different (`IDEMPOTENCY_KEY_REUSED` vs `IDEMPOTENCY_REQUEST_IN_PROGRESS`) so clients can tell them apart. The draft also formats the key as a structured-field string *with* quotes (`Idempotency-Key: "8e03978e-..."`); most APIs send it bare. Our server accepts both.

**Minimal version:** `minimal/idempotency-race.ts`

```ts
// minimal/idempotency-race.ts — why "check, then do the work, then save" is not idempotent.
// Run: npx tsx minimal/idempotency-race.ts
type Stored = { status: "processing" | "done"; requestHash: string; response?: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let transfersApplied = 0;

async function applyTransfer(): Promise<string> {
  await sleep(20); // pretend this is the database write
  transfersApplied++;
  return `transfer #${transfersApplied}`;
}

// Beginner way: look up the key, do the work, save the key at the end.
const naiveStore = new Map<string, string>();
async function naiveCreate(key: string): Promise<string> {
  const saved = naiveStore.get(key);
  if (saved) return saved;
  const result = await applyTransfer(); // other requests run while we wait here
  naiveStore.set(key, result);
  return result;
}

// Product idea: CLAIM the key atomically before any await, then do the work.
const store = new Map<string, Stored>();
async function safeCreate(key: string, requestHash: string): Promise<string> {
  const existing = store.get(key);
  if (existing) {
    if (existing.requestHash !== requestHash) return "409 key reused with a different body";
    if (existing.status === "processing") return "409 still processing, retry later";
    return `replayed: ${existing.response}`;
  }
  store.set(key, { status: "processing", requestHash }); // claim: no await before this line
  const response = await applyTransfer();
  store.set(key, { status: "done", requestHash, response });
  return response;
}

const tally = (xs: string[]) =>
  Object.entries(xs.reduce<Record<string, number>>((m, x) => ({ ...m, [x]: (m[x] ?? 0) + 1 }), {}));

transfersApplied = 0;
await Promise.all(Array.from({ length: 50 }, () => naiveCreate("key-1")));
console.log(`naive: 50 concurrent duplicates -> ${transfersApplied} transfers applied`);

transfersApplied = 0;
const results = await Promise.all(Array.from({ length: 50 }, () => safeCreate("key-1", "hash-A")));
console.log(`safe:  50 concurrent duplicates -> ${transfersApplied} transfer applied`);
console.log("safe responses:", tally(results));
console.log("late retry:", await safeCreate("key-1", "hash-A"));
console.log("same key, new body:", await safeCreate("key-1", "hash-B"));
```

**Real output**

```text
naive: 50 concurrent duplicates -> 50 transfers applied
safe:  50 concurrent duplicates -> 1 transfer applied
safe responses: [ [ 'transfer #1', 1 ], [ '409 still processing, retry later', 49 ] ]
late retry: replayed: transfer #1
same key, new body: 409 key reused with a different body
```

**What to notice**

- The naive version checks the key, then `await`s. All 50 requests pass the check before any of them saves the key. **50 transfers.** This is the classic check-then-act race.
- The safe version claims the key **before** the first `await`. In one Node process that is atomic. Across many server instances it is not, which is why the product version claims the key with a database unique constraint.
- The request hash is what turns "same key, different body" into an error instead of a wrong, silent replay.

**Diagram: two concurrent requests with the same key**

```mermaid
sequenceDiagram
  participant A as Request A
  participant B as Request B with same key
  participant DB as Postgres
  A->>DB: INSERT key k1 as processing
  B->>DB: INSERT key k1 as processing
  Note over DB: B waits on the unique index<br/>until the INSERT from A commits
  DB-->>A: inserted, A owns k1
  DB-->>B: conflict, do nothing
  B->>DB: SELECT k1
  DB-->>B: processing, lock not expired
  B-->>B: 409 request in progress<br/>Retry-After 1
  A->>DB: move money and store response, COMMIT
  B->>DB: after 1 second, retry and SELECT k1
  DB-->>B: completed, same hash
  B-->>B: replay the stored 201
```

**How to read this diagram.** Time flows downward. Both requests try to insert the same key. Postgres makes B wait on the unique index until A's insert commits; then B's `ON CONFLICT DO NOTHING` inserts nothing. B reads the row, sees "processing", and tells its client to retry after a second. By then A has committed both the transfer and its response, so B's retry gets a replay.

**Diagram: lifecycle of one idempotency key**

```mermaid
stateDiagram-v2
  [*] --> processing: first request claims the key
  processing --> completed: effect and response commit together
  processing --> [*]: rollback, key released for a retry
  processing --> processing: lock expired, a retry takes over
  completed --> completed: retry with same hash, replay
  completed --> [*]: expires after 24h, purged
```

**How to read this diagram.** A key starts in `processing` when one request claims it. The happy path goes to `completed` in the same transaction as the money movement. If that transaction rolls back, the key is deleted so a retry can run. If the owner crashes and never finishes, its lock expires and a retry takes over. A completed key only replays until it expires.

**Crashes and lock takeover.** What if the server dies after claiming the key but before committing? The row stays `processing` forever and every retry gets 409. So each claim has a `locked_until` time (30 seconds here). After that, a retry may take over by swapping in its own `lock_token`. The business transaction starts with `SELECT ... FOR UPDATE` on the key row **with our token**. A takeover therefore waits for a slow-but-alive owner, and a stale owner that lost its token cannot commit. The test suite includes this crash case.

**Expiry window.** Keys live 24 hours here. The window must be longer than any client's retry schedule (a mobile app that retries for up to an hour is fine) and short enough to keep the table small. At 20 lakh transfers a day with roughly 1.2 KB per row, a 24-hour window holds about **2.4 GB** (computed). Index `expires_at` and delete in batches, or partition by day and drop old partitions at larger scale.

**Scope.** Keys are unique per client (`client_id` from authentication, P1-05), not globally. Two merchants who happen to generate the same string must not see each other's responses. UUIDv4 collisions are not a practical worry: even 730 crore keys (10 years at 20 lakh a day) give a collision probability around 5 × 10⁻¹⁸ (computed).

**Defence in depth.** The `transfers` table also has `idempotency_key_id UNIQUE`. If a future bug ever let two workers through, the database would still refuse the second transfer row.

**The client's half of the deal.** The key is generated **once per user intent** and reused on every retry. Generating a new UUID inside the retry loop silently disables the whole mechanism.

**Minimal version:** `minimal/client-retry.ts`

```ts
// minimal/client-retry.ts — the client side: one key per user action, reused on every retry.
// Run: npx tsx minimal/client-retry.ts
import { randomUUID } from "node:crypto";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let applied = 0;
const seen = new Map<string, string>();

// A fake server whose first two responses get lost on a flaky network AFTER the work is done.
let calls = 0;
async function fakeServer(key: string): Promise<string> {
  calls++;
  if (!seen.has(key)) { applied++; seen.set(key, `transfer_${applied}`); }
  if (calls <= 2) throw new Error("ETIMEDOUT"); // the money moved, the reply did not arrive
  return seen.get(key)!;
}

async function sendWithRetry(makeKey: () => string, keyOncePerAction: boolean): Promise<string> {
  const actionKey = makeKey();
  for (let attempt = 1; attempt <= 5; attempt++) {
    const key = keyOncePerAction ? actionKey : makeKey(); // beginner bug: new key per attempt
    try {
      return await fakeServer(key);
    } catch {
      const backoff = Math.min(1000, 50 * 2 ** attempt) * (0.5 + Math.random()); // exponential + jitter
      await sleep(backoff / 20); // scaled down for the demo
    }
  }
  throw new Error("gave up");
}

calls = 0; applied = 0; seen.clear();
await sendWithRetry(() => randomUUID(), false);
console.log(`new key on every retry -> ${applied} transfers applied`);

calls = 0; applied = 0; seen.clear();
await sendWithRetry(() => randomUUID(), true);
console.log(`same key on every retry -> ${applied} transfer applied`);
```

**Real output**

```text
new key on every retry -> 3 transfers applied
same key on every retry -> 1 transfer applied
```

**What to notice**

- The only difference is **where** the key is created: outside the loop (correct) or inside it (bug).
- Retries use exponential backoff with jitter, so a thousand phones that lost signal together do not hammer the server in sync.
- In a React Native app, save the pending transfer and its key to storage (MMKV or AsyncStorage) **before** the first call. If the app is killed mid-request, the retry after restart still uses the same key.

### 6. Error format: RFC 9457 Problem Details

**What it is.** RFC 9457 (July 2023, replacing RFC 7807) defines one JSON shape for HTTP errors, sent with `Content-Type: application/problem+json`. Its standard members:

| Member | Meaning | On our platform |
|---|---|---|
| `type` | A URI that identifies the **kind** of problem. Defaults to `about:blank` | `https://docs.ledger.example/problems/insufficient-funds`, a docs page |
| `title` | Short, human-readable summary of the kind. Same for every occurrence | "Insufficient funds" |
| `status` | The HTTP status code, repeated for convenience | `422` |
| `detail` | Human-readable explanation of **this** occurrence | "The source wallet balance is lower than the amount." |
| `instance` | A URI reference for this specific occurrence | the request path |

RFC 9457 allows **extension members**. We add three:

- `code`: a stable, SCREAMING_SNAKE machine code (`INSUFFICIENT_FUNDS`). Clients switch on this, never on `title` or `detail`, which may be reworded or translated.
- `requestId`: the same ID as the `x-request-id` header and our logs. Support can find the exact log line from a user's screenshot.
- `errors`: field-level problems, each with `detail` and either a JSON Pointer (`pointer`, for body fields) or a `parameter` name (for query and path parameters). RFC 9457's own example uses an `errors` array with `pointer`.

**Sample Problem Details response.** This is the exact body the lab server returned for `{"amountMinor": -5, "extra": true, ...}`. **Real output:**

```json
{
  "type": "https://docs.ledger.example/problems/validation-failed",
  "title": "Request validation failed",
  "status": 400,
  "detail": "One or more fields are invalid.",
  "instance": "/v1/transfers",
  "code": "VALIDATION_FAILED",
  "requestId": "e991baa6-fb2c-41e1-8a2d-a91d66da106a",
  "errors": [
    { "detail": "Too small: expected number to be >=1", "pointer": "#/amountMinor" },
    { "detail": "Unknown field", "pointer": "#/extra" }
  ]
}
```

And a business failure, as the app sees it (format from the lab; IDs will differ):

```http
HTTP/1.1 422 Unprocessable Content
Content-Type: application/problem+json
x-request-id: 3c1f...

{
  "type": "https://docs.ledger.example/problems/insufficient-funds",
  "title": "Insufficient funds",
  "status": 422,
  "detail": "The source wallet balance is lower than the amount.",
  "instance": "/v1/transfers",
  "code": "INSUFFICIENT_FUNDS",
  "requestId": "3c1f..."
}
```

**Rules for the error contract:**

1. **Every** error uses this shape: validation, business rules, 404 for unknown routes, rate limits and 500s.
2. **Never put internals in the body**: no stack traces, SQL, table names, file paths or library error text. Log them with the `requestId`; send a generic 500.
3. **`detail` must be safe to show a user.** Do not leak other users' data ("wallet w2 belongs to Amit").
4. **Do not return `200` with `{"success": false}`.** Proxies, monitoring, retries and every HTTP library rely on the status code.

**Minimal version.** The whole idea fits in one function:

```ts
// The core of Problem Details: a stable code, a documented type URL, and nothing internal.
function problem(status: number, code: string, title: string, detail: string, instance: string) {
  return {
    status,
    headers: { "content-type": "application/problem+json" },
    body: { type: `https://docs.ledger.example/problems/${code.toLowerCase().replaceAll("_", "-")}`, title, status, detail, instance, code },
  };
}
// problem(422, "INSUFFICIENT_FUNDS", "Insufficient funds", "The source wallet balance is lower than the amount.", "/v1/transfers")
```

The product version (`src/lib/problem.ts` and `src/plugins/errorHandler.ts` in the lab) adds the error catalogue, field errors and the global handler.

**Trade-off.** A strict error contract takes discipline: every new error needs a code, a docs page and a status decision. The pay-off is that the app team writes one error handler and maps `code` to friendly, translated messages (Hindi and Gujarati included).

### 7. Versioning and evolution

**Additive vs breaking.** Most API changes should be **additive**: they add something old clients can ignore. A **breaking** change makes an existing, correct client fail or behave wrongly.

| Change | Additive or breaking? | Why |
|---|---|---|
| Add an optional request field | Additive | Old clients do not send it |
| Add a response field | Additive, **if** clients ignore unknown fields | Make your clients tolerant |
| Add a new endpoint | Additive | Nobody calls it yet |
| Add a new error `code` | Additive, **if** clients have a default branch | Map unknown codes to a generic message |
| Add a new enum value in a response (`status: "on_hold"`) | **Often breaking** for strict clients | A `switch` with no default crashes or shows nothing |
| Remove or rename a field, path or enum value | Breaking | Old clients still use it |
| Make an optional request field required | Breaking | Old clients do not send it |
| Tighten validation (max 140 chars becomes 100) | Breaking | Old clients' valid requests now fail |
| Change type or meaning (`amount` in rupees becomes paise) | Breaking, and dangerous | Old clients send wrong values silently |

**Diagram: is this change breaking?**

```mermaid
flowchart TD
  change["A change to the API"] --> q1{"Removes or renames a<br/>field, path or enum value?"}
  q1 -->|"yes"| breaking["Breaking change"]
  q1 -->|"no"| q2{"Makes an optional input required<br/>or tightens validation?"}
  q2 -->|"yes"| breaking
  q2 -->|"no"| q3{"Changes the type, meaning<br/>or default of a field?"}
  q3 -->|"yes"| breaking
  q3 -->|"no"| additive["Additive: ship it in v1"]
  breaking --> plan["Add a new field or v2 path,<br/>send Deprecation and Sunset,<br/>watch old-app traffic"]
```

**How to read this diagram.** Ask the three questions in order. Any "yes" makes it breaking, and breaking changes never happen in place. You add the new thing next to the old, announce the old one's end with headers, and remove it only when traffic from old app versions is close to zero.

**URL version vs header version**

| | URL version (`/v1/transfers`) | Header version (`Api-Version: 2026-10-01`) |
|---|---|---|
| How it looks | Visible in every URL, log line and curl | Hidden in a header |
| Routing and caching | Easy: gateways and CDNs route by path | Gateway must read the header; caches must `Vary` on it |
| Granularity | Coarse: a whole new v2 | Fine: date-based versions per change |
| Who uses it | Most public APIs | For example, GitHub (`X-GitHub-Api-Version`) and Stripe (dated versions) |
| Our choice | **Yes**, for the rare big break | Optional later, for fine-grained changes |

**Deprecation headers.** When an endpoint is on its way out, say so in every response so client developers and their logs see it:

- `Deprecation: @1793491200`: RFC 9745 (March 2025). The value is a structured-field date: `@` plus Unix seconds.
- `Sunset: Sat, 01 May 2027 00:00:00 GMT`: RFC 8594. The date after which it may stop working. It must not be earlier than the deprecation date.
- `Link: <https://docs.ledger.example/migrations/v2-transfers>; rel="deprecation"`: where to read more.

```ts
// src/plugins/deprecation.ts — attach to any route that is going away.
import type { FastifyReply } from "fastify";

const DEPRECATED_AT = Math.floor(Date.parse("2026-11-01T00:00:00Z") / 1000); // Unix seconds
const SUNSET_AT = new Date("2027-05-01T00:00:00Z").toUTCString(); // HTTP-date

export function markDeprecated(reply: FastifyReply, migrationGuideUrl: string): void {
  reply.header("deprecation", `@${DEPRECATED_AT}`); // RFC 9745
  reply.header("sunset", SUNSET_AT); // RFC 8594
  reply.header("link", `<${migrationGuideUrl}>; rel="deprecation"`);
}
```

**What to notice**

- `toUTCString()` produces the IMF-fixdate format HTTP expects (`Sat, 01 May 2027 00:00:00 GMT`).
- The Sunset date is after the Deprecation date, as RFC 9745 requires.

**How do you change an API without breaking mobile apps that will not update for months?**

1. **Only additive changes in place.** Add `amountMinor`; keep `amount` until it is unused.
2. **Make clients tolerant readers.** Ignore unknown fields; map unknown enum values and error codes to a safe default. Ship this in the app **before** you need it.
3. **Know who is calling.** The app sends `X-App-Version` and platform; the server logs and counts requests per version.
4. **Run old and new side by side** (`/v1` and `/v2`, or old and new fields) for as long as old versions have real traffic.
5. **Announce the end** with Deprecation, Sunset and Link headers, release notes and partner emails.
6. **Remove only when the data says so**, for example under 0.5% of transfer calls for 30 days.
7. **Force-update is the last resort.** A `minimumSupportedVersion` check at app start shows an "Update to continue" screen. Over-the-air JavaScript updates (for example Expo EAS Update) shrink the long tail but do not remove it.

### 8. Optimistic updates over HTTP: ETags with If-Match

**The problem: the lost update.** Two support agents open the same wallet. Agent A freezes it for fraud. Agent B, looking at an old copy, renames it and sends the whole object back. B's save silently un-freezes the wallet.

**The fix.** The server gives every version of a resource a tag (**ETag**). The client sends the tag back in `If-Match` when it writes. The server applies the write only if the tag still matches; otherwise it returns **412 Precondition Failed**. A write without `If-Match` gets **428 Precondition Required** (RFC 6585). This is optimistic concurrency control: no locks are held while a human is looking at a screen. The database side of it is card P2-04 · Concurrency control.

**Minimal version:** `minimal/etag-if-match.ts`

```ts
// minimal/etag-if-match.ts — lost update without If-Match, and how an ETag check stops it.
// Run: npx tsx minimal/etag-if-match.ts
type Wallet = { nickname: string; status: "active" | "frozen"; version: number };
const db = new Map<string, Wallet>([["w1", { nickname: "Main", status: "active", version: 1 }]]);
const etagOf = (w: Wallet) => `"v${w.version}"`;

function get(id: string) {
  const w = db.get(id)!;
  return { body: { ...w }, etag: etagOf(w) };
}

// Beginner way: last write wins. The client sends the whole object it read earlier.
function blindPut(id: string, body: Wallet): string {
  db.set(id, { ...body, version: db.get(id)!.version + 1 });
  return "200 OK";
}

// Product way: update only if the version the client read is still the current one.
function patch(id: string, ifMatch: string | undefined, change: Partial<Wallet>): string {
  const w = db.get(id)!;
  if (!ifMatch) return "428 Precondition Required";
  if (ifMatch !== etagOf(w)) return `412 Precondition Failed (current ETag is ${etagOf(w)})`;
  db.set(id, { ...w, ...change, version: w.version + 1 });
  return `200 OK, new ETag ${etagOf(db.get(id)!)}`;
}

// Two support agents open the same wallet. Agent A freezes it (fraud), agent B renames it.
let a = get("w1"), b = get("w1");
blindPut("w1", { ...a.body, status: "frozen" });
blindPut("w1", { ...b.body, nickname: "Shop till" });
console.log("without If-Match:", db.get("w1"), "<- the freeze is lost");

db.set("w1", { nickname: "Main", status: "active", version: 1 });
a = get("w1"); b = get("w1");
console.log("A freezes:", patch("w1", a.etag, { status: "frozen" }));
console.log("B renames:", patch("w1", b.etag, { nickname: "Shop till" }));
console.log("B re-reads and retries:", patch("w1", get("w1").etag, { nickname: "Shop till" }));
console.log("final:", db.get("w1"));
```

**Real output**

```text
without If-Match: { nickname: 'Shop till', status: 'active', version: 3 } <- the freeze is lost
A freezes: 200 OK, new ETag "v2"
B renames: 412 Precondition Failed (current ETag is "v2")
B re-reads and retries: 200 OK, new ETag "v3"
final: { nickname: 'Shop till', status: 'frozen', version: 3 }
```

**What to notice**

- Without `If-Match`, the fraud freeze is silently overwritten. Nobody gets an error.
- With `If-Match`, B is told the truth (412), re-reads, and applies only the rename. Both changes survive.
- In SQL this is one statement: `UPDATE wallets SET ... WHERE id = $1 AND version = $2`. Zero rows updated means 412 (or 404). The lab has the product version.

**Strong vs weak ETags.** `"v7"` is a strong ETag (byte-for-byte identity). `W/"v7"` is weak (semantically the same). `If-Match` needs strong comparison, so use strong ETags for writes. `If-None-Match` on GET with a `304 Not Modified` reply is the caching use of ETags; that is a different job.

**Trade-off.** In our ledger, every transfer bumps the wallet `version`, because the balance is part of the wallet's representation. On a busy merchant wallet, an admin's rename may hit 412 often. If that hurts, split rarely edited settings into their own sub-resource (`/v1/wallets/w1/settings`) with its own version.

### 9. Long-running operations: 202 Accepted plus a status resource

**The problem.** A 12-month statement export builds a 40-page PDF. It may take 30 seconds or more. Holding an HTTP request open that long ties up connections, hits proxy timeouts (often 30 to 60 seconds) and fails badly on mobile networks.

**The pattern.** Create a **job resource**. Return `202 Accepted` immediately with `Location` pointing to it and a `Retry-After` hint. The client polls the status resource until it reaches a final state.

- States: `pending` → `running` → `succeeded` (with `downloadUrl`) or `failed` (with `failureReason`).
- Creating the job is a POST, so it takes an `Idempotency-Key` like any other.
- The status endpoint is a plain GET. It returns `200` with the current state, plus `Retry-After` while unfinished.
- The download URL is a short-lived signed link to object storage (card P3-07), not a file streamed through the API.

**Diagram: statement export with 202 and polling**

```mermaid
sequenceDiagram
  participant App as App
  participant API as Ledger API
  participant DB as Postgres
  participant W as Export worker
  App->>API: POST /v1/wallets/w1/statement-exports
  API->>DB: insert export e1 as pending
  API-->>App: 202 Accepted, Location /v1/statement-exports/e1
  App->>API: GET /v1/statement-exports/e1
  API-->>App: 200 pending, Retry-After 5
  W->>DB: pick up e1, mark running
  W->>W: build PDF, upload to storage
  W->>DB: mark e1 succeeded with downloadUrl
  App->>API: GET /v1/statement-exports/e1
  API-->>App: 200 succeeded, downloadUrl
```

**How to read this diagram.** The API answers in milliseconds and never builds the PDF itself. The worker does the slow part in the background (via a queue, card P3-05). The app keeps asking the status URL, slowly, until it sees `succeeded`.

**Minimal version:** `minimal/accepted-and-poll.ts`

```ts
// minimal/accepted-and-poll.ts — 202 Accepted plus a status resource the client polls.
// Run: npx tsx minimal/accepted-and-poll.ts
type Status = "pending" | "running" | "succeeded" | "failed";
type ExportJob = { id: string; status: Status; downloadUrl?: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const jobs = new Map<string, ExportJob>();

// Server: answer fast, do the slow work in the background.
function postStatementExport() {
  const job: ExportJob = { id: `exp_${jobs.size + 1}`, status: "pending" };
  jobs.set(job.id, job);
  void runWorker(job); // in production: put a message on a queue (P3-05)
  return { status: 202, location: `/v1/statement-exports/${job.id}`, retryAfter: 1 };
}

async function runWorker(job: ExportJob): Promise<void> {
  await sleep(120);
  job.status = "running";
  await sleep(300); // building a 40-page PDF
  job.status = "succeeded";
  job.downloadUrl = `https://files.ledger.example/${job.id}.pdf?expires=900`;
}

function getStatementExport(location: string) {
  const job = jobs.get(location.split("/").pop()!)!;
  const done = job.status === "succeeded" || job.status === "failed";
  return { status: 200, retryAfter: done ? undefined : 1, body: { ...job } };
}

// Client: poll the Location until a final state. Real clients honour Retry-After (seconds).
const accepted = postStatementExport();
console.log(`POST -> ${accepted.status} Accepted, Location: ${accepted.location}`);
for (let attempt = 1; ; attempt++) {
  const res = getStatementExport(accepted.location);
  console.log(`poll ${attempt} -> ${res.body.status}${res.retryAfter ? `, Retry-After: ${res.retryAfter}` : ""}`);
  if (res.retryAfter === undefined) {
    console.log("download:", res.body.downloadUrl);
    break;
  }
  await sleep(150); // scaled down from Retry-After so the demo is quick
}
```

**Real output**

```text
POST -> 202 Accepted, Location: /v1/statement-exports/exp_1
poll 1 -> pending, Retry-After: 1
poll 2 -> running, Retry-After: 1
poll 3 -> running, Retry-After: 1
poll 4 -> succeeded
download: https://files.ledger.example/exp_1.pdf?expires=900
```

**What to notice**

- The POST returns before any slow work starts. The job's state lives on the server, not in the HTTP connection.
- The client stops when `Retry-After` disappears, meaning a final state.
- If the app is killed, it can resume polling later from the saved `Location`.

**Polling vs push.** Polling is simple and works through every firewall. For many clients or near-instant updates, add webhooks (P1-04) or Server-Sent Events (P3-06) on top. Keep the status resource anyway: it is the source of truth when a push is missed.

### 10. OpenAPI-first

**What it is.** You write the API description (`openapi.yaml`) **before** any handler code. Reviews happen on the spec. Types, validators, client SDKs and docs are generated from it. Contract tests check the running server against it.

**Diagram: the OpenAPI-first workflow**

```mermaid
flowchart TD
  write["Write openapi.yaml<br/>and review it in a PR"] --> lint["Lint<br/>redocly lint"]
  lint --> gen["Generate TypeScript types<br/>openapi-typescript"]
  gen --> server["Server<br/>Zod schemas satisfy the types"]
  gen --> client["Clients<br/>typed calls with openapi-fetch"]
  server --> contract["Contract tests<br/>schemathesis against the server"]
  contract --> diff["CI gate<br/>oasdiff breaking vs main"]
  diff --> ship["Merge and deploy"]
```

**How to read this diagram.** The spec is written and reviewed first. Linting catches spec mistakes. One generation step feeds both the server and every client. Contract tests catch the places where the running server and the spec disagree, and a diff check in CI blocks breaking changes from merging.

**Why spec-first and not code-first?** Code-first (generate the spec from handlers) is faster on day one, but the API shape then follows whatever the code happened to do. Spec-first makes the contract a design artefact that the app team, partners and backend agree on **before** anyone is invested in an implementation.

**Version note (checked 12 Oct 2026).** OpenAPI 3.2.0 is published, but tool support is still catching up. The lab uses **OpenAPI 3.1.1**, which Redocly, openapi-typescript and Schemathesis all handle.

**Real gotcha found while building this lab.** `openapi-typescript` 7.13.0 declares `typescript: ^5.x` as a peer dependency. With TypeScript 7.0.2 (the current `latest` on npm) installed, it crashed with `Cannot read properties of undefined (reading 'createKeywordTypeNode')`. Pinning `typescript@5` fixed it. Check peer dependencies when a code generator fails in a strange way.

**How the server stays honest.** The Zod schema is checked against the generated type with `satisfies`:

```ts
export const createTransferBody = z.strictObject({ /* ... */ }) satisfies z.ZodType<CreateTransferRequest>;
```

When the `currency` field was deleted from the Zod schema as an experiment, `tsc` failed. **Real output (trimmed):**

```text
src/routes/transfers.ts(17,4): error TS1360: Type 'ZodObject<{ sourceWalletId: ZodUUID; ... }>' does not satisfy the expected type 'ZodType<{ so...
    Property 'currency' is missing in type '{ sourceWalletId: string; ... }' but required in type '{ ... }'
```

`satisfies` only checks one direction: Zod must produce at least what the spec requires. An **extra** Zod field, or a stricter rule in Zod than in the spec, will not fail `tsc`. That is what contract tests are for.

**How clients stay honest.** The app uses the same generated `paths` type with `openapi-fetch`:

```ts
// client/transferClient.ts — typed client from the same spec (React Native / Next.js side).
import createClient from "openapi-fetch";
import type { paths } from "../src/generated/api.js";

const api = createClient<paths>({ baseUrl: "https://api.ledger.example" });

export async function sendMoney(idempotencyKey: string, from: string, to: string, amountMinor: number) {
  const { data, error, response } = await api.POST("/v1/transfers", {
    params: { header: { "Idempotency-Key": idempotencyKey } },
    body: { sourceWalletId: from, destinationWalletId: to, amountMinor, currency: "INR" },
  });
  if (error) return { ok: false as const, status: response.status, code: error.code };
  return { ok: true as const, transferId: data.id, replayed: response.headers.get("idempotent-replayed") === "true" };
}
```

**What to notice**

- The path, header name, body fields and the error's `code` are all typed from the spec. Changing `"INR"` to `"USD"` gave **Real output:** `error TS2322: Type '"USD"' is not assignable to type '"INR"'.`
- The idempotency key is a parameter, created by the caller once per user action (section 5).

**Contract tests found 10 real bugs in 6 seconds.** Schemathesis generates hundreds of requests from the spec, sends them to the running server and checks the responses against the spec. The first run against this lab's code, written carefully by hand, reported this. **Real output (summary):**

```text
Failures:
  ❌ Response violates schema: 2
  ❌ API rejected schema-compliant request: 2
  ❌ Missing header not rejected: 3
  ❌ Undocumented HTTP status code: 2
  ❌ Unsupported methods: 1

Test cases:
  295 generated, 9 found 10 unique failures
```

What they were, and what we did:

| Finding | Root cause | Fix |
|---|---|---|
| Response violates schema | Spec said every field error has a `pointer`; the code sends `parameter` for query and path errors | Spec: `pointer` optional, add `parameter` |
| API rejected schema-compliant request | Spec allowed any 16 to 255 character key; code allows only letters, digits, `-` and `_` (optionally in quotes) | Spec: add the same regex as the code |
| Undocumented 400 | GET by ID returns 400 for a non-UUID; spec listed only 200 and 404 | Spec: document 400 |
| Undocumented 409 | Statement export can return 409 (key reused or in progress); not in spec | Spec: document 409 |
| Missing header not rejected (3) | The spec requires a bearer token, but authentication is not built yet | Expected. Card P1-05 adds it |
| Unsupported method | `QUERY` on a known path got 400; HTTP says 405 Method Not Allowed | Known gap; exercise below |

After the spec fixes, the same seed gave **5 failures** (the 3 auth findings and 2 unsupported-method findings). The first regex fix itself was wrong (it allowed a lone `"`), and the second run caught that too. The lesson: **hand-written spec and hand-written code drift, even in a small, careful codebase.** Contract tests are cheap; run them in CI.

---

## ⚖️ Comparisons and trade-offs

**Offset vs cursor pagination** (numbers from this guide's run on 10 lakh rows, page size 50)

| | Offset (`LIMIT 50 OFFSET n`) | Cursor (`WHERE (created_at, id) < cursor`) |
|---|---|---|
| Page 100, p50 | 1.59 ms | 0.52 ms |
| Page 10,000, p50 | 54.32 ms | 0.40 ms (136x faster) |
| Page 19,999, p50 | 112.75 ms | 0.30 ms (376x faster) |
| Cost grows with | Page depth | Nothing (flat) |
| New rows while scrolling | Duplicates on the next page | No duplicates |
| Deleted rows while scrolling | Skipped rows | No skips |
| Jump to page 7,342 | Yes | No |
| Total pages / count | Easy but slow (`COUNT(*)`) | Not by default |
| Needs | Nothing special | A unique, indexed sort key |
| Use for | Small admin tables, shallow pages | Feeds, histories, any big or changing list |

**Ways to stop duplicate transfers**

| Approach | Stops double tap? | Stops network retry? | Stops concurrent duplicates? | Notes |
|---|---|---|---|---|
| Nothing | No | No | No | 3,000 double debits a day in our example |
| Disable the button after tap | Yes | No | No | Good UX, zero safety |
| Natural unique key (`UNIQUE (merchant_order_id)`) | Yes | Partly | Yes | Second attempt gets a raw conflict, not the original response |
| **Idempotency key table (this card)** | Yes | Yes | Yes | Replays the original response; works for any POST |

**When a duplicate arrives while the first is still processing**

| | Return 409 + `Retry-After` (our choice) | Block and wait, then replay |
|---|---|---|
| Client experience | Must retry once more | Gets the real answer in one call |
| Server cost | Frees the connection immediately | Holds a connection and a DB wait per duplicate |
| Under a retry storm | Stays healthy | Can exhaust the pool |
| Used by | The IETF draft, Stripe-style APIs | Some internal APIs with low traffic |

**400 vs 409 vs 412 vs 422**

| Code | The question it answers | Ledger example |
|---|---|---|
| 400 | Can I understand the request? | `amountMinor: "five hundred"`, unknown field, missing `Idempotency-Key` |
| 409 | Does it clash with the resource's current state? | Idempotency key reused with a different body, or still processing |
| 412 | Did the version you read change? | `If-Match: "v1"` but the wallet is at `"v2"` |
| 422 | Does it break a business rule? | Insufficient funds, frozen wallet, same source and destination |

**PUT vs PATCH**

| | PUT | PATCH |
|---|---|---|
| Meaning | Replace the whole resource | Change some fields |
| Idempotent | Yes, by definition | Only if designed that way |
| Risk | Client sends stale fields and overwrites others' changes | Smaller blast radius |
| Use for | Small, client-owned documents (notification settings) | Most updates; combine with `If-Match` |

**Finishing long-running work: poll vs push**

| | Poll the status resource | Webhook (P1-04) | Server-Sent Events (P3-06) |
|---|---|---|---|
| Works through firewalls and on mobile | Yes | Needs a public endpoint on the client side | Yes, needs an open connection |
| Delay | Up to one poll interval | Near instant | Near instant |
| Missed update | Impossible, just poll again | Needs retries and signatures | Needs reconnect logic |
| Our use | Default for the app | For partners' backends | For a live dashboard |

**Spec-first vs code-first**

| | Spec-first (this card) | Code-first |
|---|---|---|
| Day-one speed | Slower | Faster |
| Who shapes the API | Reviewers of the contract | Whatever the handler happened to do |
| Parallel work | App and backend start together from the spec | App waits for the backend |
| Drift risk | Spec and code drift unless contract-tested | Spec always matches code, including its mistakes |

---

## 🚶 Walkthrough on the ledger platform: Riya's ₹500 on flaky 4G

Riya pays ₹500 (`amountMinor: 50000`) to her kirana shop's wallet from the React Native app. She is in a lift, so the connection drops halfway. The numbers below match the numbers in the diagram.

**Diagram: a retried request with an idempotency key**

```mermaid
sequenceDiagram
  autonumber
  participant App as Riya's app
  participant API as Ledger API
  participant DB as Postgres
  App->>API: POST /v1/transfers, Idempotency-Key k1
  API->>DB: INSERT key k1 as processing
  DB-->>API: inserted, this request owns k1
  API->>DB: BEGIN, lock wallets, move money,<br/>store the 201 for k1, COMMIT
  API--xApp: 201 Created is lost<br/>the app times out
  App->>API: retry with the same body and key k1
  API->>DB: INSERT key k1
  DB-->>API: conflict, row exists
  API->>DB: SELECT k1
  DB-->>API: completed, same hash, stored 201
  API-->>App: 201 Created, Idempotent-Replayed true
```

**How to read this diagram.** The numbers on the arrows are the steps below. The cross at the end of arrow 5 means the response never arrived. Everything after that is the retry, which costs two small queries and moves no money.

1. **The app sends the transfer.** Before calling, it generates `k1` (a UUID) and saves `{k1, body}` to local storage, so even an app restart retries with the same key.
2. **The server claims the key.** It inserts `k1` with status `processing`, a hash of `POST /v1/transfers` plus the canonical body, and a 30-second lock.
3. **Postgres confirms the insert.** No other request has `k1`, so this one owns it.
4. **One transaction does everything that matters.** Lock both wallets in ID order, check the balance, debit Riya, credit the shop, insert the transfer and two history rows, and save the `201` response (status, headers, body) into the key row. Then commit. Money and the stored response become visible together.
5. **The response is lost.** The lift cuts the signal. The app's request times out. From the app's view the result is **unknown**, not failed.
6. **The app retries** with backoff, the same body and the **same key**.
7. **The server tries to claim `k1` again.**
8. **The unique constraint refuses.** `ON CONFLICT DO NOTHING` returns no row.
9. **The server reads the existing row.**
10. **The row says `completed`, and the hash matches.** This is a true retry of the same operation.
11. **The server replays the stored `201`**, with the same transfer ID and `Location`, and adds `Idempotent-Replayed: true`. The app shows "₹500 sent". Riya's balance moved once.

If step 4 had crashed before commit, the key would be released (or its lock would expire), and step 6 would simply run the transfer for the first time.

---

## 🧪 Hands-on lab

You will build the transfers API on the ledger platform: spec first, then idempotency, then cursor pagination, then Problem Details and a long-running export. All product code in this section was type-checked with TypeScript 5.9 in strict mode and tested against PostgreSQL 16.15 while writing this guide.

**Prerequisites:** Node 22+, Docker, `npm`. Optional: Python 3.10+ for Schemathesis.

**Project layout**

```text
ledger-api/
├── openapi/openapi.yaml                    # the contract (step 1)
├── src/
│   ├── generated/api.d.ts                  # generated, never edited by hand
│   ├── config/env.ts                       # env vars validated at startup (P1-06)
│   ├── db/pool.ts
│   ├── db/migrations/001_init.sql
│   ├── lib/{problem,requestHash,validate,cursor}.ts
│   ├── repositories/{idempotency,ledger,transaction}Repository.ts
│   ├── services/{idempotentExecution,transferService}.ts
│   ├── plugins/{idempotency,errorHandler}.ts
│   ├── routes/{transfers,transactions,wallets,statementExports}.ts
│   ├── jobs/queue.ts                       # stub here; BullMQ in P3-05
│   ├── app.ts
│   └── server.ts
├── bench/pagination-bench.ts
└── test/{idempotency,contract}.test.ts     # helpers/db.ts resets the schema (P1-07)
```

**`docker-compose.yml`**

```yaml
services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: ledger
    ports: ["5432:5432"]
    command: ["postgres", "-c", "shared_buffers=256MB", "-c", "max_connections=200"]
```

**Install**

```bash
docker compose up -d
npm init -y && npm pkg set type=module
npm install fastify pg zod openapi-fetch
npm install -D typescript@5 tsx vitest @types/pg @types/node openapi-typescript @redocly/cli
export DATABASE_URL=postgres://postgres:postgres@localhost:5432/ledger
```

`typescript@5` is pinned on purpose: `openapi-typescript` 7.13 needs TypeScript 5's compiler API (see the gotcha in Deep dive section 10). `tsconfig.json` uses `"strict": true`, `"noUncheckedIndexedAccess": true` and `"module": "NodeNext"`.

Plumbing you already know or will meet in later cards is not printed here: `src/config/env.ts` (a Zod schema over `process.env`, P1-06), `test/helpers/db.ts` (drops and recreates the schema per test, P1-07) and logger setup (Fastify's built-in pino, P1-08).

### Step 1: Write the OpenAPI spec first, then generate types

Write the spec for accounts, wallets and transfers before any handler. Review it like code. The full spec used in this lab is below (it already includes the fixes the contract tests found).

<details>
<summary><b>openapi/openapi.yaml</b> (full spec, click to expand)</summary>

```yaml
openapi: 3.1.1
info:
  title: Ledger Platform API
  version: 1.0.0
  description: >
    Accounts, wallets and transfers. Money is always an integer in minor units
    (paise for INR). Every POST that creates something requires an Idempotency-Key.
  contact: { name: Ledger platform team }
  license: { name: Proprietary, identifier: LicenseRef-Proprietary }
servers:
  - url: https://api.ledger.example
security:
  - bearerAuth: []
paths:
  /v1/accounts:
    post:
      operationId: createAccount
      summary: Create an account
      parameters: [{ $ref: "#/components/parameters/IdempotencyKey" }]
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: "#/components/schemas/CreateAccountRequest" }
      responses:
        "201":
          description: Account created
          headers: { Location: { $ref: "#/components/headers/Location" } }
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Account" }
        "400": { $ref: "#/components/responses/BadRequest" }
        "409": { $ref: "#/components/responses/Conflict" }
  /v1/accounts/{accountId}:
    get:
      operationId: getAccount
      summary: Get one account
      parameters: [{ $ref: "#/components/parameters/AccountId" }]
      responses:
        "200":
          description: The account
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Account" }
        "400": { $ref: "#/components/responses/BadRequest" }
        "404": { $ref: "#/components/responses/NotFound" }
  /v1/accounts/{accountId}/wallets:
    post:
      operationId: createWallet
      summary: Open a wallet under an account
      parameters:
        - { $ref: "#/components/parameters/AccountId" }
        - { $ref: "#/components/parameters/IdempotencyKey" }
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: "#/components/schemas/CreateWalletRequest" }
      responses:
        "201":
          description: Wallet created
          headers: { Location: { $ref: "#/components/headers/Location" } }
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Wallet" }
        "400": { $ref: "#/components/responses/BadRequest" }
        "404": { $ref: "#/components/responses/NotFound" }
        "409": { $ref: "#/components/responses/Conflict" }
  /v1/wallets/{walletId}:
    get:
      operationId: getWallet
      summary: Get one wallet (returns an ETag)
      parameters: [{ $ref: "#/components/parameters/WalletId" }]
      responses:
        "200":
          description: The wallet
          headers: { ETag: { $ref: "#/components/headers/ETag" } }
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Wallet" }
        "400": { $ref: "#/components/responses/BadRequest" }
        "404": { $ref: "#/components/responses/NotFound" }
    patch:
      operationId: updateWallet
      summary: Rename or freeze a wallet (optimistic concurrency with If-Match)
      parameters:
        - { $ref: "#/components/parameters/WalletId" }
        - { $ref: "#/components/parameters/IfMatch" }
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: "#/components/schemas/UpdateWalletRequest" }
      responses:
        "200":
          description: Updated wallet
          headers: { ETag: { $ref: "#/components/headers/ETag" } }
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Wallet" }
        "400": { $ref: "#/components/responses/BadRequest" }
        "404": { $ref: "#/components/responses/NotFound" }
        "412": { $ref: "#/components/responses/PreconditionFailed" }
        "428": { $ref: "#/components/responses/PreconditionRequired" }
  /v1/wallets/{walletId}/transactions:
    get:
      operationId: listWalletTransactions
      summary: Transaction history, newest first, cursor paginated
      parameters:
        - { $ref: "#/components/parameters/WalletId" }
        - { $ref: "#/components/parameters/Limit" }
        - { $ref: "#/components/parameters/Cursor" }
        - name: direction
          in: query
          schema: { type: string, enum: [debit, credit] }
      responses:
        "200":
          description: One page of transactions
          content:
            application/json:
              schema: { $ref: "#/components/schemas/TransactionPage" }
        "400": { $ref: "#/components/responses/BadRequest" }
        "404": { $ref: "#/components/responses/NotFound" }
  /v1/wallets/{walletId}/statement-exports:
    post:
      operationId: createStatementExport
      summary: Start a statement export (long-running)
      parameters:
        - { $ref: "#/components/parameters/WalletId" }
        - { $ref: "#/components/parameters/IdempotencyKey" }
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: "#/components/schemas/CreateStatementExportRequest" }
      responses:
        "202":
          description: Accepted. Poll the Location URL for status.
          headers:
            Location: { $ref: "#/components/headers/Location" }
            Retry-After: { $ref: "#/components/headers/RetryAfter" }
          content:
            application/json:
              schema: { $ref: "#/components/schemas/StatementExport" }
        "400": { $ref: "#/components/responses/BadRequest" }
        "404": { $ref: "#/components/responses/NotFound" }
        "409": { $ref: "#/components/responses/Conflict" }
  /v1/statement-exports/{exportId}:
    get:
      operationId: getStatementExport
      summary: Poll the status of a statement export
      parameters:
        - name: exportId
          in: path
          required: true
          schema: { type: string, format: uuid }
      responses:
        "200":
          description: Current status
          headers: { Retry-After: { $ref: "#/components/headers/RetryAfter" } }
          content:
            application/json:
              schema: { $ref: "#/components/schemas/StatementExport" }
        "400": { $ref: "#/components/responses/BadRequest" }
        "404": { $ref: "#/components/responses/NotFound" }
  /v1/transfers:
    post:
      operationId: createTransfer
      summary: Move money between two wallets
      parameters: [{ $ref: "#/components/parameters/IdempotencyKey" }]
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: "#/components/schemas/CreateTransferRequest" }
      responses:
        "201":
          description: Transfer completed. Replays carry Idempotent-Replayed true.
          headers:
            Location: { $ref: "#/components/headers/Location" }
            Idempotent-Replayed:
              description: Present with value "true" when this is a stored response.
              schema: { type: string, enum: ["true"] }
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Transfer" }
        "400": { $ref: "#/components/responses/BadRequest" }
        "404": { $ref: "#/components/responses/NotFound" }
        "409": { $ref: "#/components/responses/Conflict" }
        "422": { $ref: "#/components/responses/UnprocessableContent" }
        "429": { $ref: "#/components/responses/TooManyRequests" }
    get:
      operationId: listTransfers
      summary: List transfers with filters, sorting and field selection
      parameters:
        - { name: walletId, in: query, schema: { type: string, format: uuid } }
        - { name: status, in: query, schema: { $ref: "#/components/schemas/TransferStatus" } }
        - { name: createdFrom, in: query, schema: { type: string, format: date-time } }
        - { name: createdTo, in: query, schema: { type: string, format: date-time } }
        - name: sort
          in: query
          schema: { type: string, enum: [createdAt, -createdAt], default: -createdAt }
        - name: fields
          in: query
          description: Comma-separated top-level fields to return, for example id,status,amountMinor
          schema: { type: string, pattern: "^[a-zA-Z]+(,[a-zA-Z]+)*$" }
        - { $ref: "#/components/parameters/Limit" }
        - { $ref: "#/components/parameters/Cursor" }
      responses:
        "200":
          description: One page of transfers
          content:
            application/json:
              schema: { $ref: "#/components/schemas/TransferPage" }
        "400": { $ref: "#/components/responses/BadRequest" }
  /v1/transfers/{transferId}:
    get:
      operationId: getTransfer
      summary: Get one transfer
      parameters:
        - name: transferId
          in: path
          required: true
          schema: { type: string, format: uuid }
      responses:
        "200":
          description: The transfer
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Transfer" }
        "400": { $ref: "#/components/responses/BadRequest" }
        "404": { $ref: "#/components/responses/NotFound" }
components:
  securitySchemes:
    bearerAuth: { type: http, scheme: bearer }
  parameters:
    IdempotencyKey:
      name: Idempotency-Key
      in: header
      required: true
      description: A UUID you generate once per operation and reuse on every retry. Kept for 24 hours.
      schema: { type: string, pattern: '^([A-Za-z0-9_-]{16,255}|"[A-Za-z0-9_-]{16,255}")$' }
    IfMatch:
      name: If-Match
      in: header
      required: true
      description: The ETag you got from GET. The update fails with 412 if the wallet changed since.
      schema: { type: string }
    AccountId:
      { name: accountId, in: path, required: true, schema: { type: string, format: uuid } }
    WalletId:
      { name: walletId, in: path, required: true, schema: { type: string, format: uuid } }
    Limit:
      { name: limit, in: query, schema: { type: integer, minimum: 1, maximum: 100, default: 50 } }
    Cursor:
      name: cursor
      in: query
      description: Opaque value from page.nextCursor. Do not build or parse it yourself.
      schema: { type: string, maxLength: 512 }
  headers:
    Location: { description: URL of the created resource, schema: { type: string } }
    ETag: { description: Version tag for If-Match, schema: { type: string } }
    RetryAfter: { description: Seconds to wait before polling again, schema: { type: integer } }
  responses:
    BadRequest:
      description: The request is malformed or fails schema validation
      content: { application/problem+json: { schema: { $ref: "#/components/schemas/Problem" } } }
    NotFound:
      description: The resource does not exist or you cannot see it
      content: { application/problem+json: { schema: { $ref: "#/components/schemas/Problem" } } }
    Conflict:
      description: Clashes with current state (idempotency key reused or still processing)
      content: { application/problem+json: { schema: { $ref: "#/components/schemas/Problem" } } }
    PreconditionFailed:
      description: If-Match did not match the current ETag
      content: { application/problem+json: { schema: { $ref: "#/components/schemas/Problem" } } }
    PreconditionRequired:
      description: If-Match header is required for this update
      content: { application/problem+json: { schema: { $ref: "#/components/schemas/Problem" } } }
    UnprocessableContent:
      description: Valid shape, but breaks a business rule (for example insufficient funds)
      content: { application/problem+json: { schema: { $ref: "#/components/schemas/Problem" } } }
    TooManyRequests:
      description: Rate limit hit. Wait for Retry-After seconds.
      headers: { Retry-After: { $ref: "#/components/headers/RetryAfter" } }
      content: { application/problem+json: { schema: { $ref: "#/components/schemas/Problem" } } }
  schemas:
    Currency: { type: string, enum: [INR] }
    AmountMinor: { type: integer, minimum: 1, maximum: 100000000000, description: Amount in paise }
    CreateAccountRequest:
      type: object
      additionalProperties: false
      required: [displayName]
      properties: { displayName: { type: string, minLength: 1, maxLength: 120 } }
    Account:
      type: object
      required: [id, displayName, createdAt]
      properties:
        id: { type: string, format: uuid }
        displayName: { type: string }
        createdAt: { type: string, format: date-time }
    CreateWalletRequest:
      type: object
      additionalProperties: false
      required: [currency]
      properties:
        currency: { $ref: "#/components/schemas/Currency" }
        nickname: { type: string, maxLength: 60 }
    UpdateWalletRequest:
      type: object
      additionalProperties: false
      minProperties: 1
      properties:
        nickname: { type: string, maxLength: 60 }
        status: { type: string, enum: [active, frozen] }
    Wallet:
      type: object
      required: [id, accountId, currency, balanceMinor, status, createdAt]
      properties:
        id: { type: string, format: uuid }
        accountId: { type: string, format: uuid }
        currency: { $ref: "#/components/schemas/Currency" }
        balanceMinor: { type: integer }
        nickname: { type: string }
        status: { type: string, enum: [active, frozen] }
        createdAt: { type: string, format: date-time }
    CreateTransferRequest:
      type: object
      additionalProperties: false
      required: [sourceWalletId, destinationWalletId, amountMinor, currency]
      properties:
        sourceWalletId: { type: string, format: uuid }
        destinationWalletId: { type: string, format: uuid }
        amountMinor: { $ref: "#/components/schemas/AmountMinor" }
        currency: { $ref: "#/components/schemas/Currency" }
        note: { type: string, maxLength: 140 }
    TransferStatus: { type: string, enum: [completed] }
    Transfer:
      type: object
      required: [id, sourceWalletId, destinationWalletId, amountMinor, currency, status, createdAt]
      properties:
        id: { type: string, format: uuid }
        sourceWalletId: { type: string, format: uuid }
        destinationWalletId: { type: string, format: uuid }
        amountMinor: { $ref: "#/components/schemas/AmountMinor" }
        currency: { $ref: "#/components/schemas/Currency" }
        status: { $ref: "#/components/schemas/TransferStatus" }
        note: { type: string }
        createdAt: { type: string, format: date-time }
    WalletTransaction:
      type: object
      required: [id, transferId, direction, amountMinor, createdAt]
      properties:
        id: { type: string }
        transferId: { type: string, format: uuid }
        direction: { type: string, enum: [debit, credit] }
        amountMinor: { $ref: "#/components/schemas/AmountMinor" }
        createdAt: { type: string, format: date-time }
    PageInfo:
      type: object
      required: [hasMore, nextCursor]
      properties:
        hasMore: { type: boolean }
        nextCursor: { type: [string, "null"] }
    TransactionPage:
      type: object
      required: [data, page]
      properties:
        data: { type: array, items: { $ref: "#/components/schemas/WalletTransaction" } }
        page: { $ref: "#/components/schemas/PageInfo" }
    TransferPage:
      type: object
      required: [data, page]
      properties:
        data: { type: array, items: { $ref: "#/components/schemas/Transfer" } }
        page: { $ref: "#/components/schemas/PageInfo" }
    CreateStatementExportRequest:
      type: object
      additionalProperties: false
      required: [from, to, format]
      properties:
        from: { type: string, format: date }
        to: { type: string, format: date }
        format: { type: string, enum: [pdf, csv] }
    StatementExport:
      type: object
      required: [id, walletId, status, createdAt]
      properties:
        id: { type: string, format: uuid }
        walletId: { type: string, format: uuid }
        status: { type: string, enum: [pending, running, succeeded, failed] }
        downloadUrl: { type: [string, "null"], format: uri }
        failureReason: { type: [string, "null"] }
        createdAt: { type: string, format: date-time }
    Problem:
      type: object
      description: RFC 9457 Problem Details plus our machine-readable code
      required: [type, title, status, code]
      properties:
        type: { type: string, format: uri-reference }
        title: { type: string }
        status: { type: integer }
        detail: { type: string }
        instance: { type: string, format: uri-reference }
        code: { type: string, description: Stable error code clients can switch on }
        requestId: { type: string }
        errors:
          type: array
          items:
            type: object
            required: [detail]
            properties:
              detail: { type: string }
              pointer: { type: string, description: JSON Pointer to the bad body field }
              parameter: { type: string, description: Name of the bad query or path parameter }
```

</details>

**What to notice**

- Every `POST` that creates something takes the shared `IdempotencyKey` parameter. Its `pattern` is the same regex the server enforces (the contract tests caught when they differed).
- Every error response is `application/problem+json` with one shared `Problem` schema.
- `Limit` and `Cursor` are shared parameters, so every list endpoint uses the same names and bounds.
- Money is `AmountMinor`: an integer in paise with explicit bounds. No floats anywhere.
- Some operations here (accounts, `GET /v1/transfers`) are specified but not built in this lab. Spec-first means the app team can start on them already.

**Lint and generate types**

```bash
npx redocly lint openapi/openapi.yaml
npx openapi-typescript openapi/openapi.yaml -o src/generated/api.d.ts
```

**Real output**

```text
validating openapi/openapi.yaml...
openapi/openapi.yaml: validated in 62ms

Woohoo! Your API description is valid. 🎉

✨ openapi-typescript 7.13.0
🚀 openapi/openapi.yaml → src/generated/api.d.ts [113.5ms]
```

A slice of the generated file (**Real output**):

```ts
        CreateTransferRequest: {
            /** Format: uuid */
            sourceWalletId: string;
            /** Format: uuid */
            destinationWalletId: string;
            amountMinor: components["schemas"]["AmountMinor"];
            currency: components["schemas"]["Currency"];
            note?: string;
        };
```

Commit the generated file, or generate it in CI and fail the build if it changes. Never edit it by hand.

### Step 2: Idempotency middleware on Postgres

**Diagram: tables involved in an idempotent transfer**

```mermaid
erDiagram
  WALLETS ||--o{ TRANSFERS : "source or destination"
  WALLETS ||--o{ WALLET_TRANSACTIONS : "history"
  TRANSFERS ||--|{ WALLET_TRANSACTIONS : "debit and credit rows"
  IDEMPOTENCY_KEYS ||--o| TRANSFERS : "produced"
  IDEMPOTENCY_KEYS {
    bigint id PK
    text client_id
    text idem_key
    text request_hash
    text status
    uuid lock_token
    timestamptz locked_until
    jsonb response_body
    timestamptz expires_at
  }
  TRANSFERS {
    uuid id PK
    bigint amount_minor
    bigint idempotency_key_id UK
  }
  WALLET_TRANSACTIONS {
    bigint id PK
    uuid wallet_id
    timestamptz created_at
  }
```

**How to read this diagram.** One idempotency key produces at most one transfer, enforced by the unique `idempotency_key_id` on `transfers`. Each transfer writes two history rows, one per wallet. The key row carries everything needed to replay: the request hash, the status and the stored response.

`src/db/migrations/001_init.sql` creates the tables. The key parts are the unique constraint on `(client_id, idem_key)` and the history index that cursor pagination needs.

```sql
-- src/db/migrations/001_init.sql
CREATE TABLE accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE wallets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id),
  currency char(3) NOT NULL,
  balance_minor bigint NOT NULL DEFAULT 0 CHECK (balance_minor >= 0),
  nickname text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'frozen')),
  version integer NOT NULL DEFAULT 1,              -- becomes the ETag
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_wallet_id uuid NOT NULL REFERENCES wallets(id),
  destination_wallet_id uuid NOT NULL REFERENCES wallets(id),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency char(3) NOT NULL,
  status text NOT NULL,
  note text,
  idempotency_key_id bigint NOT NULL UNIQUE,       -- defence in depth: one transfer per key row
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (source_wallet_id <> destination_wallet_id)
);

CREATE TABLE wallet_transactions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  wallet_id uuid NOT NULL REFERENCES wallets(id),
  transfer_id uuid NOT NULL REFERENCES transfers(id),
  direction text NOT NULL CHECK (direction IN ('debit', 'credit')),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  created_at timestamptz NOT NULL
);
-- Matches ORDER BY created_at DESC, id DESC for one wallet, so a cursor page reads ~limit rows.
CREATE INDEX wallet_transactions_history_idx
  ON wallet_transactions (wallet_id, created_at DESC, id DESC);

CREATE TABLE idempotency_keys (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  client_id text NOT NULL,                         -- keys are unique per client, not globally
  idem_key text NOT NULL,
  request_method text NOT NULL,
  request_path text NOT NULL,
  request_hash text NOT NULL,                      -- sha256 of method + path + canonical body
  status text NOT NULL CHECK (status IN ('processing', 'completed')),
  lock_token uuid,                                 -- which request is working on it now
  locked_until timestamptz,                        -- after this, a retry may take over
  response_status integer,
  response_headers jsonb,
  response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CONSTRAINT idempotency_keys_client_key_uniq UNIQUE (client_id, idem_key)
);
CREATE INDEX idempotency_keys_expires_idx ON idempotency_keys (expires_at);

CREATE TABLE statement_exports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id uuid NOT NULL REFERENCES wallets(id),
  period_from date NOT NULL,
  period_to date NOT NULL,
  format text NOT NULL CHECK (format IN ('pdf', 'csv')),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
  download_url text,
  failure_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
```

**What to notice**

- `UNIQUE (client_id, idem_key)` is what makes the claim atomic across any number of server instances.
- `balance_minor bigint` with `CHECK (balance_minor >= 0)`: money in paise, and the database itself refuses a negative balance.
- `version` on wallets is the ETag source (Step 4).

`src/db/pool.ts` puts a timeout on every kind of wait:

```ts
// src/db/pool.ts — one pool for the process, with timeouts on every wait.
import pg from "pg";
import { env } from "../config/env.js";

export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: 10,
  connectionTimeoutMillis: 2_000, // waiting for a free connection from the pool
  statement_timeout: 5_000, // Postgres cancels a query that runs longer
  query_timeout: 6_000, // the driver gives up even if Postgres is unreachable
  idle_in_transaction_session_timeout: 10_000, // a forgotten BEGIN cannot hold locks forever
});
```

`src/lib/requestHash.ts` fingerprints the request:

```ts
// src/lib/requestHash.ts — a fingerprint of "what was asked", stored next to the idempotency key.
import { createHash } from "node:crypto";

// {"a":1,"b":2} and {"b":2,"a":1} are the same request, so sort keys before hashing.
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => [k, canonicalize(v)] as const);
    return Object.fromEntries(entries);
  }
  return value;
}

// Method and path are part of the hash: the same key sent to a different endpoint is a mismatch.
export function hashRequest(method: string, path: string, body: unknown): string {
  const canonical = JSON.stringify(canonicalize(body ?? null));
  return createHash("sha256").update(`${method.toUpperCase()} ${path}\n${canonical}`).digest("hex");
}
```

**What to notice**

- Key order is normalised, so a client that builds the same JSON in a different order is not wrongly rejected.
- The hash is taken over the **validated** body (the strict Zod schema has already rejected unknown keys), so it reflects exactly what the server will act on.

`src/repositories/idempotencyRepository.ts` is the heart of the lab:

```ts
// src/repositories/idempotencyRepository.ts — claim, replay, complete and release idempotency keys.
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { pool } from "../db/pool.js";

export interface StoredResponse { status: number; headers: Record<string, string>; body: unknown }
export interface IdempotencyClaim { id: string; lockToken: string }
export type ClaimResult =
  | { kind: "claimed"; claim: IdempotencyClaim }
  | { kind: "replay"; response: StoredResponse }
  | { kind: "mismatch" }
  | { kind: "in_progress" };

export interface ClaimInput {
  clientId: string; key: string; method: string; path: string;
  requestHash: string; ttlHours: number; lockSeconds: number;
}

interface ExistingRow {
  id: string; request_hash: string; status: "processing" | "completed";
  response_status: number | null; response_headers: Record<string, string> | null;
  response_body: unknown; lock_expired: boolean; expired: boolean;
}

export class LostIdempotencyLockError extends Error {
  override name = "LostIdempotencyLockError";
}

export async function claimKey(input: ClaimInput): Promise<ClaimResult> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const lockToken = randomUUID();
    // 1. Try to be first. UNIQUE (client_id, idem_key) is the real guard: a concurrent
    //    duplicate waits for our INSERT to commit, then its ON CONFLICT does nothing.
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO idempotency_keys (client_id, idem_key, request_method, request_path, request_hash,
                                     status, lock_token, locked_until, expires_at)
       VALUES ($1, $2, $3, $4, $5, 'processing', $6,
               now() + make_interval(secs => $7), now() + make_interval(hours => $8))
       ON CONFLICT (client_id, idem_key) DO NOTHING
       RETURNING id`,
      [input.clientId, input.key, input.method, input.path, input.requestHash, lockToken, input.lockSeconds, input.ttlHours],
    );
    const fresh = inserted.rows[0];
    if (fresh) return { kind: "claimed", claim: { id: fresh.id, lockToken } };

    // 2. The key exists. Decide what this request should see.
    const { rows: [row] } = await pool.query<ExistingRow>(
      `SELECT id, request_hash, status, response_status, response_headers, response_body,
              locked_until < now() AS lock_expired, expires_at < now() AS expired
       FROM idempotency_keys WHERE client_id = $1 AND idem_key = $2`,
      [input.clientId, input.key],
    );
    if (!row) continue; // released between our INSERT and SELECT: try again
    if (row.expired) {
      await pool.query("DELETE FROM idempotency_keys WHERE id = $1 AND expires_at < now()", [row.id]);
      continue;
    }
    if (row.request_hash !== input.requestHash) return { kind: "mismatch" };
    if (row.status === "completed" && row.response_status !== null) {
      return { kind: "replay", response: { status: row.response_status, headers: row.response_headers ?? {}, body: row.response_body } };
    }
    if (!row.lock_expired) return { kind: "in_progress" };

    // 3. Still 'processing' but the lock expired: the first worker probably died. Take over.
    const takeover = await pool.query<{ id: string }>(
      `UPDATE idempotency_keys SET lock_token = $2, locked_until = now() + make_interval(secs => $3)
       WHERE id = $1 AND status = 'processing' AND locked_until < now() RETURNING id`,
      [row.id, lockToken, input.lockSeconds],
    );
    const taken = takeover.rows[0];
    if (taken) return { kind: "claimed", claim: { id: taken.id, lockToken } };
  }
  return { kind: "in_progress" };
}

// Call inside the business transaction. Holding this row lock makes a takeover wait for us,
// and refusing to continue without our token stops two workers applying the same operation.
export async function lockForExecution(client: PoolClient, claim: IdempotencyClaim): Promise<void> {
  const { rowCount } = await client.query(
    `SELECT 1 FROM idempotency_keys
     WHERE id = $1 AND lock_token = $2 AND status = 'processing' FOR UPDATE`,
    [claim.id, claim.lockToken],
  );
  if (rowCount !== 1) throw new LostIdempotencyLockError();
}

export async function completeKey(client: PoolClient, claim: IdempotencyClaim, response: StoredResponse): Promise<void> {
  await client.query(
    `UPDATE idempotency_keys
     SET status = 'completed', response_status = $3, response_headers = $4, response_body = $5,
         lock_token = NULL, locked_until = NULL
     WHERE id = $1 AND lock_token = $2`,
    // stringify explicitly: node-postgres turns JS arrays into Postgres arrays, not JSON
    [claim.id, claim.lockToken, response.status, JSON.stringify(response.headers), JSON.stringify(response.body)],
  );
}

// Only when nothing was committed (crash, timeout, bug): lets the client's retry run again.
export async function releaseKey(claim: IdempotencyClaim): Promise<void> {
  await pool.query(
    "DELETE FROM idempotency_keys WHERE id = $1 AND lock_token = $2 AND status = 'processing'",
    [claim.id, claim.lockToken],
  );
}
```

**What to notice**

- `ON CONFLICT ... DO NOTHING RETURNING id` returns a row **only** to the winner. No "check first, then insert" race is possible.
- The order of checks matters: expired keys are treated as new, then the hash is compared, then status. A reused key never gets someone else's stored response.
- `lock_token` makes every write conditional on "I still own this key". A takeover changes the token, so a slow, stale owner cannot complete it.
- The result is a discriminated union (`kind`), so TypeScript forces the caller to handle all four cases.

`src/services/idempotentExecution.ts` runs any operation so that its effect and its stored response commit together:

```ts
// src/services/idempotentExecution.ts — run one operation so that its effect and its stored
// response commit together, or not at all.
import type { FastifyBaseLogger } from "fastify";
import type { PoolClient } from "pg";
import { pool } from "../db/pool.js";
import { errors } from "../lib/problem.js";
import {
  completeKey, lockForExecution, LostIdempotencyLockError, releaseKey,
  type IdempotencyClaim, type StoredResponse,
} from "../repositories/idempotencyRepository.js";

export async function runIdempotent(
  claim: IdempotencyClaim,
  log: FastifyBaseLogger,
  work: (client: PoolClient) => Promise<StoredResponse>,
): Promise<StoredResponse> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lockForExecution(client, claim);
    const response = await work(client);
    await completeKey(client, claim, response); // same transaction as the money movement
    await client.query("COMMIT");
    return response;
  } catch (err) {
    await client.query("ROLLBACK").catch((rollbackErr: unknown) => log.error({ err: rollbackErr }, "rollback failed"));
    if (err instanceof LostIdempotencyLockError) throw errors.idempotencyInProgress();
    // Nothing committed, so free the key: the client's retry with the same key runs it again.
    await releaseKey(claim).catch((releaseErr: unknown) => log.error({ err: releaseErr }, "releasing idempotency key failed"));
    throw err;
  } finally {
    client.release();
  }
}
```

**What to notice**

- `completeKey` runs **inside** the same transaction as `work`. This is the single most important line of the lab.
- On any failure, the transaction rolls back and the key is released, so "unknown" on the client becomes "safe to retry".
- This only works because all effects are in one Postgres database. If the work called an external bank API, you would need recovery points (see the Optional advanced note below).

`src/plugins/idempotency.ts` is the Fastify `preHandler` that routes use:

```ts
// src/plugins/idempotency.ts — preHandler for any route that creates something or moves money.
import type { FastifyReply, FastifyRequest } from "fastify";
import { env } from "../config/env.js";
import { errors } from "../lib/problem.js";
import { hashRequest } from "../lib/requestHash.js";
import { claimKey, type IdempotencyClaim } from "../repositories/idempotencyRepository.js";

declare module "fastify" {
  interface FastifyRequest {
    clientId: string;
    idempotencyClaim: IdempotencyClaim | null;
  }
}

// The IETF draft sends the key as a structured-field string: "8e03...24" with quotes.
// Most APIs (Stripe-style) send it bare. Accept both.
const KEY_PATTERN = /^[A-Za-z0-9_-]{16,255}$/;

function parseKey(raw: string | string[] | undefined): string {
  if (raw === undefined) throw errors.idempotencyKeyMissing();
  const key = (Array.isArray(raw) ? "" : raw).trim().replace(/^"(.*)"$/, "$1");
  if (!KEY_PATTERN.test(key)) throw errors.idempotencyKeyInvalid("Send one key: a UUID, or 16-255 letters, digits, - or _.");
  return key;
}

// Runs AFTER body validation, so malformed requests never touch the key table.
export async function requireIdempotency(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined> {
  const key = parseKey(request.headers["idempotency-key"]);
  const path = request.url.split("?")[0] ?? request.url;
  const result = await claimKey({
    clientId: request.clientId,
    key,
    method: request.method,
    path,
    requestHash: hashRequest(request.method, path, request.body),
    ttlHours: env.IDEMPOTENCY_TTL_HOURS,
    lockSeconds: env.IDEMPOTENCY_LOCK_SECONDS,
  });

  switch (result.kind) {
    case "claimed":
      request.idempotencyClaim = result.claim;
      return;
    case "mismatch":
      throw errors.idempotencyKeyReused();
    case "in_progress":
      throw errors.idempotencyInProgress();
    case "replay":
      request.log.info({ idempotencyKey: key }, "replaying stored response");
      // Returning the reply tells Fastify the response is sent: the handler never runs.
      return reply
        .code(result.response.status)
        .headers({ ...result.response.headers, "idempotent-replayed": "true" })
        .send(result.response.body);
  }
}
```

**What to notice**

- It is a per-route `preHandler`, not a global hook. GETs never pay for it.
- On replay it returns the `reply`; in an async Fastify hook that means "response sent, skip the handler".
- The key is scoped by `request.clientId`, which comes from authentication (a lab stand-in until P1-05).

`src/lib/validate.ts` turns Zod failures into Problem Details field errors:

```ts
// src/lib/validate.ts — Zod at the edge; every failure becomes a 400 Problem with field errors.
import type { FastifyRequest } from "fastify";
import type { z } from "zod";
import { errors, type FieldError } from "./problem.js";

type Part = "body" | "query" | "params";

function toFieldErrors(part: Part, issues: z.ZodError["issues"]): FieldError[] {
  return issues.flatMap((issue) => {
    // An unknown key is reported on the parent object; point at each key instead.
    const paths = issue.code === "unrecognized_keys"
      ? issue.keys.map((k) => [...issue.path.map(String), k])
      : [issue.path.map(String)];
    const detail = issue.code === "unrecognized_keys" ? "Unknown field" : issue.message;
    return paths.map((path) => part === "body"
      ? { detail, pointer: `#/${path.join("/")}` }
      : { detail, parameter: path.join(".") });
  });
}

export function parseOrThrow<S extends z.ZodType>(part: Part, schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw errors.validation(toFieldErrors(part, result.error.issues));
  return result.data;
}

// Use as a preHandler. It replaces the raw input with the parsed, typed value.
export function validate(part: Part, schema: z.ZodType) {
  return async (request: FastifyRequest): Promise<void> => {
    const parsed = parseOrThrow(part, schema, request[part]);
    if (part === "body") request.body = parsed;
    else if (part === "query") request.query = parsed;
    else request.params = parsed;
  };
}
```

**What to notice**

- Body errors point at the field with a JSON Pointer (`#/amountMinor`); query and path errors name the `parameter`. The spec documents both shapes.
- Unknown keys get one error per key instead of one vague error on the whole object.
- After validation, handlers only ever see parsed, typed values, never the raw input.

`src/repositories/ledgerRepository.ts` holds the SQL that moves money:

```ts
// src/repositories/ledgerRepository.ts — SQL for moving money between two wallets.
import type { PoolClient } from "pg";

export interface LockedWallet { id: string; currency: string; status: "active" | "frozen"; balanceMinor: number }

export interface TransferRow {
  id: string; source_wallet_id: string; destination_wallet_id: string; amount_minor: string;
  currency: string; status: "completed"; note: string | null; created_at: Date;
}

// Lock both wallets in id order: A→B and B→A at the same time then queue instead of deadlocking.
export async function lockWallets(client: PoolClient, ids: string[]): Promise<Map<string, LockedWallet>> {
  const { rows } = await client.query<{ id: string; currency: string; status: LockedWallet["status"]; balance_minor: string }>(
    "SELECT id, currency, status, balance_minor FROM wallets WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE",
    [ids],
  );
  // node-postgres returns bigint as a string. Paise fit in a JS number up to ~90 trillion rupees.
  return new Map(rows.map((r) => [r.id, { id: r.id, currency: r.currency, status: r.status, balanceMinor: Number(r.balance_minor) }]));
}

export interface ApplyTransferInput {
  sourceWalletId: string; destinationWalletId: string; amountMinor: number;
  currency: string; note?: string; idempotencyKeyId: string;
}

export async function applyTransfer(client: PoolClient, t: ApplyTransferInput): Promise<TransferRow> {
  await client.query(
    "UPDATE wallets SET balance_minor = balance_minor - $2, version = version + 1 WHERE id = $1",
    [t.sourceWalletId, t.amountMinor],
  );
  await client.query(
    "UPDATE wallets SET balance_minor = balance_minor + $2, version = version + 1 WHERE id = $1",
    [t.destinationWalletId, t.amountMinor],
  );
  const { rows: [transfer] } = await client.query<TransferRow>(
    `INSERT INTO transfers (source_wallet_id, destination_wallet_id, amount_minor, currency, status, note, idempotency_key_id)
     VALUES ($1, $2, $3, $4, 'completed', $5, $6)
     RETURNING id, source_wallet_id, destination_wallet_id, amount_minor, currency, status, note, created_at`,
    [t.sourceWalletId, t.destinationWalletId, t.amountMinor, t.currency, t.note ?? null, t.idempotencyKeyId],
  );
  if (!transfer) throw new Error("INSERT ... RETURNING returned no row");
  // Both history rows share the transfer timestamp, so pagination needs id as a tie-breaker.
  await client.query(
    `INSERT INTO wallet_transactions (wallet_id, transfer_id, direction, amount_minor, created_at)
     VALUES ($1, $3, 'debit', $4, $5), ($2, $3, 'credit', $4, $5)`,
    [t.sourceWalletId, t.destinationWalletId, transfer.id, t.amountMinor, transfer.created_at],
  );
  return transfer;
}
```

**What to notice**

- `ORDER BY id FOR UPDATE` locks the two wallets in a fixed order. Two opposite transfers wait for each other instead of deadlocking (P2-03 and P2-04 go deeper).
- The double-entry details (a proper journal with balanced entries) are card P2-09; here we keep a simple balance plus two history rows.

`src/services/transferService.ts` holds the business rules:

```ts
// src/services/transferService.ts — business rules for a transfer, run under an idempotency claim.
import type { FastifyBaseLogger } from "fastify";
import type { PoolClient } from "pg";
import type { components } from "../generated/api.js";
import { type ApiError, errors, problemResponse } from "../lib/problem.js";
import type { IdempotencyClaim, StoredResponse } from "../repositories/idempotencyRepository.js";
import { applyTransfer, lockWallets, type TransferRow } from "../repositories/ledgerRepository.js";
import { runIdempotent } from "./idempotentExecution.js";

type CreateTransferRequest = components["schemas"]["CreateTransferRequest"];
type Transfer = components["schemas"]["Transfer"];

export interface RequestContext { path: string; requestId: string; log: FastifyBaseLogger }

export function createTransfer(input: CreateTransferRequest, claim: IdempotencyClaim, ctx: RequestContext): Promise<StoredResponse> {
  return runIdempotent(claim, ctx.log, (client) => executeTransfer(client, input, claim, ctx));
}

async function executeTransfer(
  client: PoolClient, input: CreateTransferRequest, claim: IdempotencyClaim, ctx: RequestContext,
): Promise<StoredResponse> {
  // A business-rule failure is a real outcome. We store it so a retry gets the same answer.
  const fail = (err: ApiError): StoredResponse => problemResponse(err, ctx.path, ctx.requestId);

  if (input.sourceWalletId === input.destinationWalletId) return fail(errors.sameWallet());
  const wallets = await lockWallets(client, [input.sourceWalletId, input.destinationWalletId]);
  const source = wallets.get(input.sourceWalletId);
  const destination = wallets.get(input.destinationWalletId);
  if (!source || !destination) return fail(errors.walletNotFound());
  if (source.status !== "active" || destination.status !== "active") return fail(errors.walletFrozen());
  if (source.currency !== input.currency || destination.currency !== input.currency) return fail(errors.currencyMismatch());
  if (source.balanceMinor < input.amountMinor) return fail(errors.insufficientFunds());

  const row = await applyTransfer(client, { ...input, idempotencyKeyId: claim.id });
  const transfer = toTransfer(row);
  return {
    status: 201,
    headers: { "content-type": "application/json; charset=utf-8", location: `/v1/transfers/${transfer.id}` },
    body: transfer,
  };
}

function toTransfer(row: TransferRow): Transfer {
  return {
    id: row.id,
    sourceWalletId: row.source_wallet_id,
    destinationWalletId: row.destination_wallet_id,
    amountMinor: Number(row.amount_minor),
    currency: "INR",
    status: row.status,
    ...(row.note ? { note: row.note } : {}),
    createdAt: row.created_at.toISOString(),
  };
}
```

**What to notice**

- Business failures are **returned** as stored responses (not thrown), so `runIdempotent` commits them with the key. A retry replays the same 422.
- The `Transfer` type comes from the spec. If the spec adds a required field, this file stops compiling until it is filled in.
- Balances are checked **after** the wallets are locked. Checking before locking is a race (two transfers could both see enough money).

`src/routes/transfers.ts` wires it together:

```ts
// src/routes/transfers.ts — POST /v1/transfers: validate, claim the key, run the transfer.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { components } from "../generated/api.js";
import { validate } from "../lib/validate.js";
import { requireIdempotency } from "../plugins/idempotency.js";
import { createTransfer } from "../services/transferService.js";

type CreateTransferRequest = components["schemas"]["CreateTransferRequest"];

// Mirrors the OpenAPI schema. `satisfies` makes tsc fail if a required spec field is missing here.
export const createTransferBody = z.strictObject({
  sourceWalletId: z.uuid(),
  destinationWalletId: z.uuid(),
  amountMinor: z.int().min(1).max(100_000_000_000),
  currency: z.enum(["INR"]),
  note: z.string().max(140).optional(),
}) satisfies z.ZodType<CreateTransferRequest>;

export async function transferRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: CreateTransferRequest }>(
    "/v1/transfers",
    // Order matters: shape check first, then the idempotency claim.
    { preHandler: [validate("body", createTransferBody), requireIdempotency] },
    async (request, reply) => {
      const claim = request.idempotencyClaim;
      if (!claim) throw new Error("route is missing the requireIdempotency preHandler");
      const path = request.url.split("?")[0] ?? request.url;
      const response = await createTransfer(request.body, claim, { path, requestId: request.id, log: request.log });
      return reply.code(response.status).headers(response.headers).send(response.body);
    },
  );
}
```

**What to notice**

- `z.strictObject` rejects unknown fields, matching `additionalProperties: false` in the spec.
- Zod 4 style: `z.uuid()` and `z.int()` are top-level helpers.
- The preHandler order is the rule from section 5: validate, then claim.

**The concurrency test.** `test/idempotency.test.ts` fires 50 identical requests at once with `Promise.all`, through the full Fastify stack, against real Postgres:

```ts
// test/idempotency.test.ts — the money-safety tests for POST /v1/transfers.
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { pool } from "../src/db/pool.js";
import { hashRequest } from "../src/lib/requestHash.js";
import { resetDatabase, seedWallets } from "./helpers/db.js";

const SOURCE = "11111111-1111-4111-8111-111111111111";
const DEST = "22222222-2222-4222-8222-222222222222";
let app: FastifyInstance;

const body = (amountMinor = 10_000) => ({ sourceWalletId: SOURCE, destinationWalletId: DEST, amountMinor, currency: "INR" });
const transfer = (key: string | undefined, payload: object = body()) =>
  app.inject({
    method: "POST",
    url: "/v1/transfers",
    headers: { "x-client-id": "merchant-app", ...(key ? { "idempotency-key": key } : {}) },
    payload,
  });
const count = async (sql: string) => Number((await pool.query<{ n: string }>(sql)).rows[0]?.n);

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});
beforeEach(async () => {
  await resetDatabase();
  await seedWallets({ [SOURCE]: 1_000_000, [DEST]: 0 });
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

describe("POST /v1/transfers with Idempotency-Key", () => {
  it("applies exactly one transfer when 50 identical requests arrive at once", async () => {
    const key = randomUUID();
    const responses = await Promise.all(Array.from({ length: 50 }, () => transfer(key)));

    const statuses: Record<number, number> = {};
    for (const r of responses) statuses[r.statusCode] = (statuses[r.statusCode] ?? 0) + 1;
    console.log("50 concurrent duplicates ->", statuses);

    expect(await count("SELECT count(*) AS n FROM transfers")).toBe(1);
    expect(await count(`SELECT balance_minor AS n FROM wallets WHERE id = '${SOURCE}'`)).toBe(990_000);
    expect(responses.every((r) => r.statusCode === 201 || r.statusCode === 409)).toBe(true);
    const createdIds = new Set(responses.filter((r) => r.statusCode === 201).map((r) => r.json().id));
    expect(createdIds.size).toBe(1); // originals and replays all point at the same transfer
  });

  it("replays the stored response on a later retry", async () => {
    const key = randomUUID();
    const first = await transfer(key);
    const retry = await transfer(key);
    expect(first.statusCode).toBe(201);
    expect(retry.statusCode).toBe(201);
    expect(retry.headers["idempotent-replayed"]).toBe("true");
    expect(retry.json()).toEqual(first.json());
    expect(retry.headers.location).toBe(first.headers.location);
  });

  it("rejects the same key with a different body", async () => {
    const key = randomUUID();
    await transfer(key, body(10_000));
    const reused = await transfer(key, body(99_000));
    expect(reused.statusCode).toBe(409);
    expect(reused.headers["content-type"]).toContain("application/problem+json");
    expect(reused.json().code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(await count("SELECT count(*) AS n FROM transfers")).toBe(1);
  });

  it("rejects a missing key with 400 and touches nothing", async () => {
    const res = await transfer(undefined);
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("IDEMPOTENCY_KEY_MISSING");
    expect(await count("SELECT count(*) AS n FROM idempotency_keys")).toBe(0);
  });

  it("stores a business failure and replays it (insufficient funds)", async () => {
    const key = randomUUID();
    const first = await transfer(key, body(5_000_000));
    const retry = await transfer(key, body(5_000_000));
    expect(first.statusCode).toBe(422);
    expect(first.json().code).toBe("INSUFFICIENT_FUNDS");
    expect(retry.statusCode).toBe(422);
    expect(retry.headers["idempotent-replayed"]).toBe("true");
  });

  it("takes over a key whose first worker crashed mid-request", async () => {
    const key = randomUUID();
    // Simulate a crash: the key was claimed, the lock expired, nothing was committed.
    await pool.query(
      `INSERT INTO idempotency_keys (client_id, idem_key, request_method, request_path, request_hash,
                                     status, lock_token, locked_until, expires_at)
       VALUES ('merchant-app', $1, 'POST', '/v1/transfers', $2, 'processing', $3, now() - interval '1 second', now() + interval '1 day')`,
      [key, hashRequest("POST", "/v1/transfers", body()), randomUUID()],
    );
    const retry = await transfer(key);
    expect(retry.statusCode).toBe(201);
    expect(await count("SELECT count(*) AS n FROM transfers")).toBe(1);
  });

  it("returns field errors as Problem Details for a bad body", async () => {
    const res = await transfer(randomUUID(), { ...body(), amountMinor: -5, extra: true });
    expect(res.statusCode).toBe(400);
    console.log("validation problem ->", JSON.stringify(res.json(), null, 2));
    expect(await count("SELECT count(*) AS n FROM idempotency_keys")).toBe(0);
  });
});
```

**Run it**

```bash
LOG_LEVEL=silent npx vitest run --no-file-parallelism --reporter=verbose --silent=false
```

**Real output** (trimmed; the 50-duplicates line was identical on three consecutive runs)

```text
50 concurrent duplicates -> { '201': 1, '409': 49 }
 ✓ test/idempotency.test.ts > POST /v1/transfers with Idempotency-Key > applies exactly one transfer when 50 identical requests arrive at once 143ms
 ✓ test/idempotency.test.ts > POST /v1/transfers with Idempotency-Key > replays the stored response on a later retry 48ms
 ✓ test/idempotency.test.ts > POST /v1/transfers with Idempotency-Key > rejects the same key with a different body 34ms
 ✓ test/idempotency.test.ts > POST /v1/transfers with Idempotency-Key > rejects a missing key with 400 and touches nothing 31ms
 ✓ test/idempotency.test.ts > POST /v1/transfers with Idempotency-Key > stores a business failure and replays it (insufficient funds) 32ms
 ✓ test/idempotency.test.ts > POST /v1/transfers with Idempotency-Key > takes over a key whose first worker crashed mid-request 37ms
 ✓ test/idempotency.test.ts > POST /v1/transfers with Idempotency-Key > returns field errors as Problem Details for a bad body 30ms
```

**What to notice**

- **One** transfer for 50 concurrent duplicates, and the source balance moved exactly once (10,00,000 → 9,90,000 paise).
- The 49 others got `409 IDEMPOTENCY_REQUEST_IN_PROGRESS`. In a real app each of them would retry after `Retry-After: 1` and receive the replayed `201`.
- The crash test proves the takeover path: a stale `processing` row does not block the user forever.

> **Optional advanced understanding: external side effects.** Our transfer only touches Postgres, so "effect + stored response in one transaction" is enough. If the operation also calls a bank or UPI switch, that call cannot join your transaction. The usual fix splits the work into **recovery points** stored on the key row (`started`, `bank_called`, `finished`), passes your idempotency key **on to** the downstream API, and resumes from the last recorded point on retry. Workflow engines like Temporal (later in the roadmap) are built for exactly this.

### Step 3: Cursor pagination on transaction history, and the 1M-row benchmark

`src/lib/cursor.ts` makes the cursor opaque and versioned:

```ts
// src/lib/cursor.ts — the client sees an opaque string; inside is the sort key of the last row.
import { z } from "zod";
import { errors } from "./problem.js";

const cursorSchema = z.object({
  v: z.literal(1), // lets us change the format later without breaking old cursors silently
  ts: z.string().min(1), // created_at at full microsecond precision, as text
  id: z.string().regex(/^\d+$/), // tie-breaker: unique, so no two rows share a position
});
export type Cursor = z.infer<typeof cursorSchema>;

export function encodeCursor(position: Omit<Cursor, "v">): string {
  return Buffer.from(JSON.stringify({ v: 1, ...position })).toString("base64url");
}

export function decodeCursor(raw: string): Cursor {
  const parsed = cursorSchema.safeParse(safeJson(Buffer.from(raw, "base64url").toString("utf8")));
  if (!parsed.success) throw errors.invalidCursor();
  return parsed.data;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined; // not JSON: the schema check above turns this into INVALID_CURSOR
  }
}
```

**What to notice**

- `base64url` keeps the cursor safe in a query string without extra escaping.
- The version field `v` lets you change the cursor format later and reject (or translate) old cursors on purpose.
- A tampered or garbage cursor becomes a clean `400 INVALID_CURSOR`, never a 500 or an SQL error.

`src/repositories/transactionRepository.ts` is the keyset query:

```ts
// src/repositories/transactionRepository.ts — keyset (cursor) query for wallet history.
import { pool } from "../db/pool.js";
import type { Cursor } from "../lib/cursor.js";

export interface TransactionRow {
  id: string; transfer_id: string; direction: "debit" | "credit";
  amount_minor: string; created_at: Date; cursor_ts: string;
}

export interface ListOptions { limit: number; after: Cursor | null; direction: "debit" | "credit" | undefined }

export async function listWalletTransactions(walletId: string, opts: ListOptions): Promise<TransactionRow[]> {
  const where = ["wallet_id = $1"];
  const params: unknown[] = [walletId];
  if (opts.direction) {
    params.push(opts.direction);
    where.push(`direction = $${params.length}`);
  }
  if (opts.after) {
    // Row comparison: "older than the last row I showed". Uses the (wallet_id, created_at, id) index.
    params.push(opts.after.ts, opts.after.id);
    where.push(`(created_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::bigint)`);
  }
  params.push(opts.limit + 1); // one extra row tells us if another page exists
  const { rows } = await pool.query<TransactionRow>(
    `SELECT id, transfer_id, direction, amount_minor, created_at,
            to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_ts
     FROM wallet_transactions
     WHERE ${where.join(" AND ")}
     ORDER BY created_at DESC, id DESC
     LIMIT $${params.length}`,
    params,
  );
  return rows;
}

export async function walletExists(walletId: string): Promise<boolean> {
  const { rowCount } = await pool.query("SELECT 1 FROM wallets WHERE id = $1", [walletId]);
  return rowCount === 1;
}
```

`src/routes/transactions.ts` builds the page:

```ts
// src/routes/transactions.ts — GET /v1/wallets/:walletId/transactions with cursor pagination.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { components } from "../generated/api.js";
import { decodeCursor, encodeCursor } from "../lib/cursor.js";
import { errors } from "../lib/problem.js";
import { validate } from "../lib/validate.js";
import { listWalletTransactions, walletExists } from "../repositories/transactionRepository.js";

type TransactionPage = components["schemas"]["TransactionPage"];

const params = z.strictObject({ walletId: z.uuid() });
const query = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(50), // same name and bounds on every list
  cursor: z.string().max(512).optional(),
  direction: z.enum(["debit", "credit"]).optional(),
});

export async function transactionRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: z.infer<typeof params>; Querystring: z.infer<typeof query> }>(
    "/v1/wallets/:walletId/transactions",
    { preHandler: [validate("params", params), validate("query", query)] },
    async (request): Promise<TransactionPage> => {
      const { walletId } = request.params;
      const { limit, cursor, direction } = request.query;
      if (!(await walletExists(walletId))) throw errors.walletNotFound();

      const rows = await listWalletTransactions(walletId, {
        limit, direction, after: cursor ? decodeCursor(cursor) : null,
      });
      const hasMore = rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;
      const last = pageRows.at(-1);

      return {
        data: pageRows.map((r) => ({
          id: r.id,
          transferId: r.transfer_id,
          direction: r.direction,
          amountMinor: Number(r.amount_minor),
          createdAt: r.created_at.toISOString(),
        })),
        page: {
          hasMore,
          // Build the cursor from the DB text value, not the JS Date: Date drops microseconds.
          nextCursor: hasMore && last ? encodeCursor({ ts: last.cursor_ts, id: last.id }) : null,
        },
      };
    },
  );
}
```

**What to notice**

- The WHERE clause is built from fixed fragments with numbered parameters. No user input becomes SQL text.
- `cursor_ts` keeps microseconds; the JSON `createdAt` (milliseconds) is for display only.
- `limit + 1` gives `hasMore` without a count query.

**Proof that it works while data changes.** `test/contract.test.ts` inserts 230 history rows (many sharing one timestamp), walks the pages with `limit=50`, and inserts 20 newer rows after page 1. **Real output:**

```text
walked 5 pages, saw 230 rows, 0 duplicates
 ✓ test/contract.test.ts > cursor pagination > returns every row exactly once even when new rows arrive mid-walk 89ms
 ✓ test/contract.test.ts > cursor pagination > rejects a tampered cursor with 400 INVALID_CURSOR 35ms
```

**The benchmark.** `bench/pagination-bench.ts` seeds 10 lakh rows for one busy merchant wallet, then times the same pages both ways (3 warm-up runs, then 30 timed runs each) and checks that both return identical rows. It also reproduces the two cursor bugs from Deep dive section 3. The full file (shown because it is the measuring tool for this card):

```ts
// bench/pagination-bench.ts — seed 1M rows, compare offset vs cursor latency, plus two cursor bugs.
// Run: DATABASE_URL=postgres://postgres@localhost:5432/postgres npx tsx bench/pagination-bench.ts
import pg from "pg";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const WALLET = "11111111-1111-4111-8111-111111111111";
const PAGE_SIZE = 50;
const RUNS = 30;

const ms = (start: number) => performance.now() - start;
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.ceil((p / 100) * xs.length) - 1]!;

async function seed(): Promise<void> {
  await pool.query("DROP TABLE IF EXISTS bench_txn");
  await pool.query(`CREATE TABLE bench_txn (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    wallet_id uuid NOT NULL, amount_minor bigint NOT NULL, direction text NOT NULL,
    created_at timestamptz NOT NULL)`);
  const t = performance.now();
  await pool.query(
    `INSERT INTO bench_txn (wallet_id, amount_minor, direction, created_at)
     SELECT $1, 100 + (random() * 500000)::bigint, CASE WHEN g % 3 = 0 THEN 'debit' ELSE 'credit' END,
            timestamptz '2025-10-01 00:00:00+00' + g * interval '31 seconds'
     FROM generate_series(1, 1000000) AS g`, [WALLET]);
  await pool.query("CREATE INDEX bench_txn_history_idx ON bench_txn (wallet_id, created_at DESC, id DESC)");
  await pool.query("VACUUM ANALYZE bench_txn");
  console.log(`seeded 1,000,000 rows + index in ${(ms(t) / 1000).toFixed(1)} s`);
}

const OFFSET_SQL = `SELECT id, amount_minor, direction, created_at FROM bench_txn
  WHERE wallet_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3`;
const CURSOR_SQL = `SELECT id, amount_minor, direction, created_at FROM bench_txn
  WHERE wallet_id = $1 AND (created_at, id) < ($2::timestamptz, $3::bigint)
  ORDER BY created_at DESC, id DESC LIMIT $4`;

async function time(sql: string, params: unknown[]): Promise<{ p50: number; p95: number; ids: string[] }> {
  let ids: string[] = [];
  for (let i = 0; i < 3; i++) ids = (await pool.query(sql, params)).rows.map((r) => String(r.id)); // warm up
  const samples: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const t = performance.now();
    await pool.query(sql, params);
    samples.push(ms(t));
  }
  return { p50: pct(samples, 50), p95: pct(samples, 95), ids };
}

async function benchmark(): Promise<void> {
  console.log("page   | offset rows skipped | offset p50 / p95 (ms) | cursor p50 / p95 (ms) | same rows?");
  for (const page of [1, 100, 1000, 10000, 19999]) {
    const offset = (page - 1) * PAGE_SIZE;
    const off = await time(OFFSET_SQL, [WALLET, PAGE_SIZE, offset]);
    let cur = off;
    if (page > 1) {
      // The cursor is the last row of the previous page: (created_at, id) at position offset - 1.
      const { rows: [b] } = await pool.query(
        `SELECT created_at::text AS ts, id FROM bench_txn WHERE wallet_id = $1
         ORDER BY created_at DESC, id DESC LIMIT 1 OFFSET $2`, [WALLET, offset - 1]);
      cur = await time(CURSOR_SQL, [WALLET, b.ts, b.id, PAGE_SIZE]);
    }
    const same = off.ids.join() === cur.ids.join();
    console.log(`${String(page).padEnd(6)} | ${String(offset).padStart(19)} | ${off.p50.toFixed(2).padStart(8)} / ${off.p95.toFixed(2).padEnd(10)} | ${cur.p50.toFixed(2).padStart(8)} / ${cur.p95.toFixed(2).padEnd(10)} | ${same}`);
  }
}

async function explainPage10000(): Promise<void> {
  const offset = 9999 * PAGE_SIZE;
  const { rows: [b] } = await pool.query(
    `SELECT created_at::text AS ts, id FROM bench_txn WHERE wallet_id = $1
     ORDER BY created_at DESC, id DESC LIMIT 1 OFFSET $2`, [WALLET, offset - 1]);
  for (const [label, sql] of [
    ["OFFSET", `EXPLAIN (ANALYZE, BUFFERS) ${OFFSET_SQL.replace("$1", `'${WALLET}'`).replace("$2", "50").replace("$3", String(offset))}`],
    ["CURSOR", `EXPLAIN (ANALYZE, BUFFERS) ${CURSOR_SQL.replace("$1", `'${WALLET}'`).replace("$2", `'${b.ts}'`).replace("$3", String(b.id)).replace("$4", "50")}`],
  ] as const) {
    const { rows } = await pool.query(sql);
    console.log(`\n-- EXPLAIN ${label} (page 10,000)`);
    for (const r of rows) {
      const line: string = r["QUERY PLAN"];
      if (/Limit|Index|Buffers|Execution Time|Index Cond/.test(line)) console.log(line.slice(0, 130));
    }
  }
}

async function cursorBugs(): Promise<void> {
  await pool.query("DROP TABLE IF EXISTS bug_txn");
  await pool.query("CREATE TABLE bug_txn (id bigint PRIMARY KEY, created_at timestamptz NOT NULL)");
  // Bug 1: sort key not unique. Ids 2, 3 and 4 share the same timestamp.
  await pool.query(`INSERT INTO bug_txn VALUES
    (1, '2026-10-12 10:00:00+00'), (2, '2026-10-12 10:00:05+00'), (3, '2026-10-12 10:00:05+00'),
    (4, '2026-10-12 10:00:05+00'), (5, '2026-10-12 10:00:09+00')`);
  const p1 = (await pool.query("SELECT id, created_at::text AS ts FROM bug_txn ORDER BY created_at DESC, id DESC LIMIT 2")).rows;
  const last = p1[p1.length - 1];
  const tsOnly = (await pool.query("SELECT id FROM bug_txn WHERE created_at < $1 ORDER BY created_at DESC LIMIT 10", [last.ts])).rows;
  const withId = (await pool.query("SELECT id FROM bug_txn WHERE (created_at, id) < ($1, $2) ORDER BY created_at DESC, id DESC LIMIT 10", [last.ts, last.id])).rows;
  console.log(`\nbug 1 (non-unique sort key): page 1 = [${p1.map((r) => r.id)}]`);
  console.log(`  next page using created_at only:  [${tsOnly.map((r) => r.id)}]  <- ids 3 and 2 never shown`);
  console.log(`  next page using (created_at, id): [${withId.map((r) => r.id)}]`);

  // Bug 2: Postgres keeps microseconds, a JS Date keeps milliseconds.
  await pool.query("TRUNCATE bug_txn");
  await pool.query(`INSERT INTO bug_txn VALUES
    (1, '2026-10-12 10:00:00.122000+00'), (2, '2026-10-12 10:00:00.123100+00'),
    (3, '2026-10-12 10:00:00.123300+00'), (4, '2026-10-12 10:00:00.123456+00')`);
  const { rows: [top] } = await pool.query("SELECT id, created_at, created_at::text AS ts FROM bug_txn ORDER BY created_at DESC, id DESC LIMIT 1");
  const viaDate = (await pool.query("SELECT id FROM bug_txn WHERE (created_at, id) < ($1, $2) ORDER BY created_at DESC, id DESC", [(top.created_at as Date).toISOString(), top.id])).rows;
  const viaText = (await pool.query("SELECT id FROM bug_txn WHERE (created_at, id) < ($1, $2) ORDER BY created_at DESC, id DESC", [top.ts, top.id])).rows;
  console.log(`\nbug 2 (timestamp precision): page 1 = [${top.id}], DB value ${top.ts}, JS Date ${(top.created_at as Date).toISOString()}`);
  console.log(`  next page with JS Date cursor:     [${viaDate.map((r) => r.id)}]  <- ids 3 and 2 skipped`);
  console.log(`  next page with full-precision text: [${viaText.map((r) => r.id)}]`);
}

await seed();
await benchmark();
await explainPage10000();
await cursorBugs();
await pool.end();
```

**Real output** (2 vCPU, Postgres 16.15, everything cached in memory)

```text
seeded 1,000,000 rows + index in 3.4 s
page   | offset rows skipped | offset p50 / p95 (ms) | cursor p50 / p95 (ms) | same rows?
1      |                   0 |     0.81 / 4.14       |     0.81 / 4.14       | true
100    |                4950 |     1.59 / 3.69       |     0.52 / 0.96       | true
1000   |               49950 |     5.81 / 7.43       |     0.60 / 2.41       | true
10000  |              499950 |    54.32 / 82.36      |     0.40 / 0.56       | true
19999  |              999900 |   112.75 / 168.66     |     0.30 / 0.66       | true

-- EXPLAIN OFFSET (page 10,000)
Limit  (cost=31686.41..31689.58 rows=50 width=30) (actual time=97.109..97.123 rows=50 loops=1)
  Buffers: shared hit=7689
  ->  Index Scan using bench_txn_history_idx on bench_txn  (cost=0.42..63378.74 rows=1000000 width=30) (actual time=0.018..76.265 
        Index Cond: (wallet_id = '11111111-1111-4111-8111-111111111111'::uuid)
        Buffers: shared hit=7689
Execution Time: 97.147 ms

-- EXPLAIN CURSOR (page 10,000)
Limit  (cost=0.42..4.55 rows=50 width=30) (actual time=0.022..0.048 rows=50 loops=1)
  Buffers: shared hit=6
  ->  Index Scan using bench_txn_history_idx on bench_txn  (cost=0.42..40921.30 rows=495997 width=30) (actual time=0.021..0.042 ro
        Index Cond: ((wallet_id = '11111111-1111-4111-8111-111111111111'::uuid) AND (ROW(created_at, id) < ROW('2026-03-29 09:59:4
        Buffers: shared hit=6
Execution Time: 0.066 ms
```

**What to notice**

- On page 1 both queries are the same query, so the numbers match. From page 100 on, offset grows roughly in line with depth; cursor stays flat or even gets faster.
- `same rows? true` on every line: the cursor is not "faster because it returns something else".
- In EXPLAIN, both use **the same index**. The difference is the `Index Cond`: the cursor's `ROW(created_at, id) < ROW(...)` lets Postgres seek. Offset touched **7,689 buffers** (8 KB pages) vs **6** for the cursor, about 1,282x more work.
- Everything here was in memory (`shared hit`). On a cold cache, or with many users paging at once, the offset numbers get much worse, not better.
- Note how `EXPLAIN ANALYZE` (97 ms) is slower than the timed query (54 ms): it adds timing overhead per row, and the offset query has 5 lakh rows to time. Use EXPLAIN to see *why*, and plain timings to see *how much*. Card P2-02 · Indexes and query plans goes deeper.

### Step 4: Problem Details for every error, 202 for statement export, ETag for updates

`src/lib/problem.ts` defines the error type, the wire format and the catalogue:

```ts
// src/lib/problem.ts — one error type, one wire format (RFC 9457) and a catalogue of codes.
export interface FieldError {
  detail: string;
  pointer?: string; // JSON Pointer into the body, e.g. "#/amountMinor"
  parameter?: string; // name of a bad query or path parameter
}

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  code: string;
  requestId?: string;
  errors?: FieldError[];
}

export const PROBLEM_CONTENT_TYPE = "application/problem+json";
const DOCS_BASE = "https://docs.ledger.example/problems/";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string, // stable; clients switch on this, never on title or detail
    readonly title: string, // same text for every occurrence of this code
    readonly detail?: string, // about this occurrence; must be safe to show a user
    readonly extra: { errors?: FieldError[]; headers?: Record<string, string> } = {},
  ) {
    super(detail ?? title);
    this.name = "ApiError";
  }
}

export function toProblem(err: ApiError, instance: string, requestId: string): ProblemDetails {
  return {
    type: DOCS_BASE + err.code.toLowerCase().replaceAll("_", "-"),
    title: err.title,
    status: err.status,
    ...(err.detail ? { detail: err.detail } : {}),
    instance,
    code: err.code,
    requestId,
    ...(err.extra.errors ? { errors: err.extra.errors } : {}),
  };
}

// A business-rule failure stored as an idempotent response (so a retry sees the same answer).
export function problemResponse(err: ApiError, instance: string, requestId: string) {
  return { status: err.status, headers: { "content-type": PROBLEM_CONTENT_TYPE }, body: toProblem(err, instance, requestId) };
}

const e = (status: number, code: string, title: string) => (detail?: string, extra?: ApiError["extra"]) =>
  new ApiError(status, code, title, detail, extra);

export const errors = {
  validation: (fieldErrors: FieldError[]) =>
    e(400, "VALIDATION_FAILED", "Request validation failed")("One or more fields are invalid.", { errors: fieldErrors }),
  malformed: e(400, "MALFORMED_REQUEST", "Malformed request"),
  invalidCursor: () => e(400, "INVALID_CURSOR", "Invalid cursor")("Use page.nextCursor exactly as you received it."),
  idempotencyKeyMissing: () =>
    e(400, "IDEMPOTENCY_KEY_MISSING", "Idempotency-Key header is required")("Send a new UUID per operation and reuse it on retries."),
  idempotencyKeyInvalid: e(400, "IDEMPOTENCY_KEY_INVALID", "Idempotency-Key header is invalid"),
  idempotencyKeyReused: () =>
    e(409, "IDEMPOTENCY_KEY_REUSED", "Idempotency-Key was already used for a different request")(
      "Generate a new key for a new operation."),
  idempotencyInProgress: () =>
    e(409, "IDEMPOTENCY_REQUEST_IN_PROGRESS", "A request with this Idempotency-Key is still processing")(
      "Retry after a moment to get the stored result.", { headers: { "retry-after": "1" } }),
  walletNotFound: () => e(404, "WALLET_NOT_FOUND", "Wallet not found")(),
  exportNotFound: () => e(404, "EXPORT_NOT_FOUND", "Statement export not found")(),
  routeNotFound: () => e(404, "ROUTE_NOT_FOUND", "No such endpoint")(),
  preconditionFailed: () =>
    e(412, "PRECONDITION_FAILED", "The resource changed since you read it")("GET it again and retry with the new ETag."),
  preconditionRequired: () => e(428, "PRECONDITION_REQUIRED", "If-Match header is required")(),
  sameWallet: () => e(422, "SAME_WALLET", "Source and destination must differ")(),
  walletFrozen: () => e(422, "WALLET_FROZEN", "Wallet is frozen")(),
  currencyMismatch: () => e(422, "CURRENCY_MISMATCH", "Currency does not match the wallets")(),
  insufficientFunds: () =>
    e(422, "INSUFFICIENT_FUNDS", "Insufficient funds")("The source wallet balance is lower than the amount."),
  internal: () => e(500, "INTERNAL_ERROR", "Something went wrong on our side")("Retry with the same Idempotency-Key."),
};
```

**What to notice**

- The whole error vocabulary of the API is in one file. Reviewing a PR that adds an error means reviewing one line here plus the spec.
- The 500 message tells the client the one safe thing to do: retry with the same key.
- `extra.headers` lets an error carry `Retry-After` without the error handler knowing about idempotency.

`src/plugins/errorHandler.ts` makes every error, including unknown routes and crashes, a Problem:

```ts
// src/plugins/errorHandler.ts — every error leaves the server as application/problem+json.
import type { FastifyError, FastifyInstance } from "fastify";
import { ApiError, errors, PROBLEM_CONTENT_TYPE, toProblem } from "../lib/problem.js";

function toApiError(error: FastifyError | ApiError): ApiError {
  if (error instanceof ApiError) return error;
  // Fastify's own 4xx: invalid JSON, body too large, unsupported content type. Safe to describe.
  const status = "statusCode" in error ? error.statusCode : undefined;
  if (status && status >= 400 && status < 500) return errors.malformed(error.message);
  // Anything else is a bug or an outage. The client gets a generic message; the logs get the truth.
  return errors.internal();
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler<FastifyError | ApiError>(async (error, request, reply) => {
    const apiError = toApiError(error);
    if (apiError.status >= 500) request.log.error({ err: error }, "request failed");
    else request.log.info({ code: apiError.code, status: apiError.status }, "request rejected");

    const path = request.url.split("?")[0] ?? request.url;
    return reply
      .code(apiError.status)
      .headers(apiError.extra.headers ?? {})
      .type(PROBLEM_CONTENT_TYPE)
      .send(toProblem(apiError, path, request.id));
  });

  app.setNotFoundHandler(async (request, reply) => {
    const path = request.url.split("?")[0] ?? request.url;
    return reply.code(404).type(PROBLEM_CONTENT_TYPE).send(toProblem(errors.routeNotFound(), path, request.id));
  });
}
```

**Real output** (`curl -i` against the running lab server, some headers trimmed):

```text
HTTP/1.1 404 Not Found
x-request-id: 42aefa88-7d49-4410-9edb-5fdb345eb99f
content-type: application/problem+json; charset=utf-8

{"type":"https://docs.ledger.example/problems/route-not-found","title":"No such endpoint","status":404,"instance":"/v1/nope","code":"ROUTE_NOT_FOUND","requestId":"42aefa88-7d49-4410-9edb-5fdb345eb99f"}
```

`src/routes/statementExports.ts` is the 202 plus status endpoint:

```ts
// src/routes/statementExports.ts — long-running work: 202 Accepted now, a status resource to poll.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { components } from "../generated/api.js";
import { pool } from "../db/pool.js";
import { enqueueStatementExport } from "../jobs/queue.js";
import { errors, problemResponse } from "../lib/problem.js";
import { validate } from "../lib/validate.js";
import { requireIdempotency } from "../plugins/idempotency.js";
import { runIdempotent } from "../services/idempotentExecution.js";

type StatementExport = components["schemas"]["StatementExport"];
interface ExportRow { id: string; wallet_id: string; status: StatementExport["status"]; download_url: string | null; failure_reason: string | null; created_at: Date }

const params = z.strictObject({ walletId: z.uuid() });
const body = z.strictObject({ from: z.iso.date(), to: z.iso.date(), format: z.enum(["pdf", "csv"]) });
const toApi = (r: ExportRow): StatementExport => ({
  id: r.id, walletId: r.wallet_id, status: r.status, downloadUrl: r.download_url,
  failureReason: r.failure_reason, createdAt: r.created_at.toISOString(),
});

export async function statementExportRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: z.infer<typeof params>; Body: z.infer<typeof body> }>(
    "/v1/wallets/:walletId/statement-exports",
    { preHandler: [validate("params", params), validate("body", body), requireIdempotency] },
    async (request, reply) => {
      const claim = request.idempotencyClaim;
      if (!claim) throw new Error("route is missing the requireIdempotency preHandler");
      const path = request.url.split("?")[0] ?? request.url;
      const response = await runIdempotent(claim, request.log, async (client) => {
        const wallet = await client.query("SELECT 1 FROM wallets WHERE id = $1", [request.params.walletId]);
        if (wallet.rowCount !== 1) return problemResponse(errors.walletNotFound(), path, request.id);
        const { rows: [row] } = await client.query<ExportRow>(
          `INSERT INTO statement_exports (wallet_id, period_from, period_to, format)
           VALUES ($1, $2, $3, $4) RETURNING id, wallet_id, status, download_url, failure_reason, created_at`,
          [request.params.walletId, request.body.from, request.body.to, request.body.format],
        );
        if (!row) throw new Error("INSERT ... RETURNING returned no row");
        const location = `/v1/statement-exports/${row.id}`;
        return { status: 202, headers: { "content-type": "application/json; charset=utf-8", location, "retry-after": "5" }, body: toApi(row) };
      });
      // After commit. If this enqueue fails, a sweeper re-queues 'pending' rows (an outbox does it better).
      const created = response.body as StatementExport;
      if (response.status === 202) await enqueueStatementExport(created.id);
      return reply.code(response.status).headers(response.headers).send(response.body);
    },
  );

  app.get<{ Params: { exportId: string } }>(
    "/v1/statement-exports/:exportId",
    { preHandler: [validate("params", z.strictObject({ exportId: z.uuid() }))] },
    async (request, reply): Promise<StatementExport> => {
      const { rows: [row] } = await pool.query<ExportRow>(
        "SELECT id, wallet_id, status, download_url, failure_reason, created_at FROM statement_exports WHERE id = $1",
        [request.params.exportId],
      );
      if (!row) throw errors.exportNotFound();
      if (row.status === "pending" || row.status === "running") reply.header("retry-after", "5");
      return toApi(row);
    },
  );
}
```

**What to notice**

- Creating the export reuses `requireIdempotency` and `runIdempotent`. A double tap on "Export" makes one export, not two PDFs.
- Enqueueing happens **after** commit. If the process dies in between, the row stays `pending` and a sweeper (or the outbox pattern, later in the roadmap) picks it up. Enqueueing before commit could start a job for a row that never existed.
- The worker that builds the PDF is card P3-05; the signed download URL is P3-07.

`src/routes/wallets.ts` is the ETag + If-Match update:

```ts
// src/routes/wallets.ts — PATCH with If-Match: "update only if nobody changed it since I read it".
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { components } from "../generated/api.js";
import { pool } from "../db/pool.js";
import { errors } from "../lib/problem.js";
import { validate } from "../lib/validate.js";

type Wallet = components["schemas"]["Wallet"];
interface WalletRow { id: string; account_id: string; balance_minor: string; nickname: string | null; status: Wallet["status"]; version: number; created_at: Date }

const params = z.strictObject({ walletId: z.uuid() });
const body = z.strictObject({ nickname: z.string().max(60).optional(), status: z.enum(["active", "frozen"]).optional() })
  .refine((b) => Object.keys(b).length > 0, { message: "Send at least one field" });

const etagOf = (version: number) => `"v${version}"`;
const versionFromEtag = (etag: string) => Number(/^"v(\d+)"$/.exec(etag.trim())?.[1] ?? Number.NaN);
const toApi = (r: WalletRow): Wallet => ({
  id: r.id, accountId: r.account_id, currency: "INR", balanceMinor: Number(r.balance_minor),
  status: r.status, createdAt: r.created_at.toISOString(), ...(r.nickname ? { nickname: r.nickname } : {}),
});

export async function walletRoutes(app: FastifyInstance): Promise<void> {
  app.patch<{ Params: z.infer<typeof params>; Body: z.infer<typeof body> }>(
    "/v1/wallets/:walletId",
    { preHandler: [validate("params", params), validate("body", body)] },
    async (request, reply): Promise<Wallet> => {
      const ifMatch = request.headers["if-match"];
      if (typeof ifMatch !== "string") throw errors.preconditionRequired();
      const expectedVersion = versionFromEtag(ifMatch);

      // Compare-and-set in one statement: the WHERE on version is the whole trick.
      const { rows: [row] } = await pool.query<WalletRow>(
        `UPDATE wallets SET nickname = COALESCE($3, nickname), status = COALESCE($4, status), version = version + 1
         WHERE id = $1 AND version = $2
         RETURNING id, account_id, balance_minor, nickname, status, version, created_at`,
        [request.params.walletId, Number.isNaN(expectedVersion) ? -1 : expectedVersion, request.body.nickname ?? null, request.body.status ?? null],
      );
      if (!row) {
        const { rowCount } = await pool.query("SELECT 1 FROM wallets WHERE id = $1", [request.params.walletId]);
        throw rowCount === 1 ? errors.preconditionFailed() : errors.walletNotFound();
      }
      reply.header("etag", etagOf(row.version));
      return toApi(row);
    },
  );
}
```

**What to notice**

- One `UPDATE ... WHERE version = $2` is the compare-and-set. No read-then-write race.
- Zero rows updated has two meanings, so a second query tells 412 (changed) from 404 (gone).
- A malformed ETag maps to version `-1`, which never matches, so it becomes a clean 412.

`src/app.ts` and `src/server.ts` wire everything up, with graceful shutdown:

```ts
// src/app.ts — builds the Fastify app. server.ts listens; tests call buildApp() and inject().
import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { env } from "./config/env.js";
import { registerErrorHandler } from "./plugins/errorHandler.js";
import { statementExportRoutes } from "./routes/statementExports.js";
import { transactionRoutes } from "./routes/transactions.js";
import { transferRoutes } from "./routes/transfers.js";
import { walletRoutes } from "./routes/wallets.js";

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: env.LOG_LEVEL },
    genReqId: () => randomUUID(),
    bodyLimit: 64 * 1024, // transfers are tiny; reject huge bodies before parsing
    requestTimeout: 15_000,
  });

  app.decorateRequest("clientId", "");
  app.decorateRequest("idempotencyClaim", null);
  app.addHook("onRequest", async (request, reply) => {
    reply.header("x-request-id", request.id);
    // Lab stand-in for real authentication (a later card). Never trust a client-sent id in production.
    const clientId = request.headers["x-client-id"];
    request.clientId = typeof clientId === "string" ? clientId : "anonymous";
  });

  registerErrorHandler(app);
  await app.register(transferRoutes);
  await app.register(transactionRoutes);
  await app.register(walletRoutes);
  await app.register(statementExportRoutes);
  return app;
}
```

```ts
// src/server.ts — listen, and shut down cleanly so in-flight transfers finish.
import { buildApp } from "./app.js";
import { env } from "./config/env.js";
import { pool } from "./db/pool.js";

const app = await buildApp();
await app.listen({ port: env.PORT, host: "0.0.0.0" });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, "shutting down");
    // close() stops accepting connections and waits for in-flight requests.
    app.close()
      .then(() => pool.end())
      .then(() => process.exit(0))
      .catch((err: unknown) => {
        app.log.error({ err }, "shutdown failed");
        process.exit(1);
      });
  });
}
```

**What to notice**

- Every request gets a UUID request ID, echoed in `x-request-id` and in every Problem body.
- `x-client-id` is a **lab stand-in**. Card P1-05 replaces it with the identity from a verified token.
- On SIGTERM (a deploy), in-flight transfers finish before the pool closes. A killed in-flight transfer is still safe because of idempotency, but clean shutdown avoids needless retries.

**Real output** for the rest of `test/contract.test.ts` (202 flow and If-Match):

```text
 ✓ test/contract.test.ts > long-running statement export > returns 202 with Location, then a pollable status 40ms
 ✓ test/contract.test.ts > PATCH with If-Match > updates once, then rejects the stale ETag 34ms
      Tests  11 passed (11)
```

### Step 5 (optional): Contract tests with Schemathesis

```bash
python3 -m venv .venv && .venv/bin/pip install schemathesis   # 4.31.0 when this was written
DATABASE_URL=... PORT=3111 npx tsx src/server.ts &
.venv/bin/st run openapi/openapi.yaml --url http://localhost:3111 -H "Authorization: Bearer test" -n 25 \
  --include-operation-id createTransfer --include-operation-id listWalletTransactions \
  --include-operation-id updateWallet --include-operation-id createStatementExport \
  --include-operation-id getStatementExport
```

The first run found 10 issues; after three spec fixes, 5 expected ones remained (see Deep dive section 10 for the full table). Add this to CI next to `oasdiff breaking --fail-on ERR base.yaml openapi/openapi.yaml`, which fails the build when a PR introduces a breaking change to the spec.

---

## 🔨 Break it and measure it

Do these on your machine. Each one turns a "rule" from this card into something you have seen fail.

1. **Remove the request hash check.** In `claimKey`, delete the `row.request_hash !== input.requestHash` line. Run the tests. *Expected:* "rejects the same key with a different body" fails: the ₹990 request silently gets the ₹100 response.
2. **Use check-then-insert instead of an atomic claim.** Replace the `INSERT ... ON CONFLICT` with "SELECT the key; if missing, run the transfer, then INSERT the key" (the beginner order). Run the 50-duplicates test. *Expected:* more than one transfer, or unique-constraint 500s, depending on timing.
3. **Kill the server mid-transfer.** Add `await new Promise((r) => setTimeout(r, 20_000))` before `completeKey`, start the server, send a transfer, and `kill -9` it during the wait. Restart and retry with the same key. *Expected:* 409 for up to 30 seconds (the lock), then the retry takes over and applies the transfer once. Check `SELECT count(*) FROM transfers`.
4. **Build the cursor from `created_at.toISOString()`** instead of `cursor_ts`. Rerun `contract.test.ts`. *Expected:* the "every row exactly once" test fails with missing rows.
5. **Drop the tie-breaker.** Change the ORDER BY and the cursor condition to `created_at` only. *Expected:* rows that share a timestamp vanish between pages.
6. **Throw a raw error.** Make a route `throw new Error("relation \"wallets\" does not exist")`. *Expected:* the client still gets a generic `INTERNAL_ERROR` Problem; the real message appears only in the server log with the same `requestId`.
7. **Measure offset vs cursor on your machine.** Run `bench/pagination-bench.ts`. Then run it again after restarting Postgres (cold cache) and note how offset changes.

**Measurements**

| Measure (from the card) | This guide's run (**Real output**) | Your machine |
|---|---|---|
| Latency of a deep offset page (page 10,000, offset 499,950), p50 / p95 | 54.32 ms / 82.36 ms | fill after running the lab on your machine |
| Latency of the cursor page with the same rows, p50 / p95 | 0.40 ms / 0.56 ms | fill after running the lab on your machine |
| Offset vs cursor at page 10,000 | 136x (p50), 147x (p95) | fill after running the lab on your machine |
| Buffers touched at page 10,000 (offset vs cursor) | 7,689 vs 6 | fill after running the lab on your machine |
| Transfers applied when 50 concurrent duplicates arrive | **1** (1 × 201, 49 × 409; three runs) | fill after running the lab on your machine (must be 1) |
| Source balance after the 50 duplicates | 10,00,000 → 9,90,000 paise (moved once) | fill after running the lab on your machine |
| Rows seen when paging 230 rows with inserts mid-walk | 230, 0 duplicates | fill after running the lab on your machine |

---

## 🚫 Common mistakes and wrong mental models

### Wrong mental model: "retries are rare, so idempotency is optional"

Retries are normal, not rare. Mobile networks drop mid-request. Load balancers and service meshes retry on connection resets. Many HTTP SDKs retry by default. Users double-tap, press back and resubmit, or kill and reopen the app. Every one of those is a duplicate POST. On a payment API, "rare" times "lakhs of requests a day" is thousands of double debits (see the problem section).

**Correct model:** every POST that moves money **will** arrive more than once. Design so that is boring.

### Mistake 1: a new key on every retry (client side)

```ts
// Beginner way: the key is created inside the retry loop, so every retry looks like a new transfer.
for (let attempt = 1; attempt <= 5; attempt++) {
  const res = await sendTransfer({ ...body }, { idempotencyKey: crypto.randomUUID() });
  if (res.ok) break;
}
```

```ts
// Product way: one key per user action, saved before the first attempt and reused on every retry.
const idempotencyKey = crypto.randomUUID();
await pendingTransfers.save({ idempotencyKey, body }); // survives an app kill (MMKV / AsyncStorage)
for (let attempt = 1; attempt <= 5; attempt++) {
  const res = await sendTransfer(body, { idempotencyKey });
  if (res.ok || !isRetryable(res.status)) break;
  await sleep(backoffWithJitter(attempt));
}
```

**What breaks in the beginner way:** in the minimal demo, 3 transfers were applied instead of 1. The server cannot tell retries apart if the client keeps changing the key.

### Mistake 2: storing the key without a request hash

```ts
// Beginner way: same key means "same request", no questions asked.
const stored = await findKey(clientId, key);
if (stored) return replay(stored.response);
```

```ts
// Product way: same key AND same fingerprint, or it is a client bug.
const stored = await findKey(clientId, key);
if (stored && stored.requestHash !== hashRequest(method, path, body)) throw errors.idempotencyKeyReused();
if (stored?.status === "completed") return replay(stored.response);
```

**What breaks in the beginner way:** a buggy client reuses a key for a new ₹990 transfer and silently gets the old ₹100 response. The user thinks ₹990 moved. Nothing did. Nobody gets an error.

### Mistake 3: check-then-insert instead of an atomic claim

```sql
-- Beginner way: two queries with a gap between them. 50 concurrent requests all see "not found".
SELECT 1 FROM idempotency_keys WHERE client_id = $1 AND idem_key = $2;
-- ... no row, so do the transfer ...
INSERT INTO idempotency_keys (client_id, idem_key, ...) VALUES ($1, $2, ...);
```

```sql
-- Product way: one statement; the unique constraint picks exactly one winner.
INSERT INTO idempotency_keys (client_id, idem_key, ...) VALUES ($1, $2, ...)
ON CONFLICT (client_id, idem_key) DO NOTHING
RETURNING id;
```

**What breaks in the beginner way:** the minimal demo applied **50** transfers for 50 duplicates.

### Mistake 4: verbs in URLs and inconsistent singular/plural names

```ts
// Beginner way
app.post("/createTransfer", handler);
app.get("/wallet/:id/getBalance", handler);
app.post("/transfers/:id/doReverse", handler);
```

```ts
// Product way
app.post("/v1/transfers", handler);                    // create
app.get("/v1/wallets/:walletId", handler);             // balance is a field of the wallet
app.post("/v1/transfers/:transferId/reversals", handler); // the reversal is a resource
```

**What breaks in the beginner way:** every endpoint is a special case. Clients cannot guess URLs, generic tooling (caching, retries, logging by resource) does not work, and `/wallet` vs `/wallets` bugs show up in every app release.

### Mistake 5: leaking stack traces and SQL errors in 500 responses

```ts
// Beginner way
app.setErrorHandler((err, _req, reply) => {
  reply.code(500).send({ error: err.message, stack: err.stack });
});
```

```ts
// Product way (src/plugins/errorHandler.ts): log the truth, send a safe Problem.
if (apiError.status >= 500) request.log.error({ err: error }, "request failed");
return reply.code(apiError.status).type("application/problem+json").send(toProblem(apiError, path, request.id));
```

**What breaks in the beginner way:** `duplicate key value violates unique constraint "transfers_idempotency_key_id_key"` tells an attacker your table and column names; a stack trace shows file paths and library versions. It also gives the app nothing stable to switch on.

### Mistake 6: `200 OK` with `{"success": false}`

```ts
// Beginner way
return reply.code(200).send({ success: false, message: "Insufficient balance" });
```

```ts
// Product way
throw errors.insufficientFunds(); // 422, application/problem+json, code INSUFFICIENT_FUNDS
```

**What breaks in the beginner way:** monitoring shows a 100% success rate during an outage, CDNs may cache the "error", retry logic never triggers, and every client must parse the body to learn if anything worked.

### Mistake 7: offset pagination for an infinite-scroll history

```ts
// Beginner way
const rows = await pool.query("SELECT ... ORDER BY created_at DESC LIMIT $1 OFFSET $2", [50, page * 50]);
```

```ts
// Product way: keyset with a unique tie-breaker, cursor built from the DB's full-precision value.
const rows = await pool.query(
  "SELECT ... WHERE wallet_id = $1 AND (created_at, id) < ($2::timestamptz, $3::bigint) ORDER BY created_at DESC, id DESC LIMIT $4",
  [walletId, cursor.ts, cursor.id, limit + 1],
);
```

**What breaks in the beginner way:** page 10,000 took 136x longer in this guide's benchmark, and rows repeat when new payments arrive.

### Mistake 8: money as a floating-point number

`0.1 + 0.2` is `0.30000000000000004` in JavaScript. Send and store **integer paise** (`amountMinor: 50000`), with explicit bounds in the spec. Format for display only at the edge (`₹500.00`).

---

## ✅ Production checklist

Before shipping an endpoint on the ledger platform, a senior engineer checks:

**Contract**
- [ ] The endpoint is in `openapi.yaml`, reviewed, linted, and types are regenerated.
- [ ] URLs are plural nouns, kebab-case, at most one level of nesting; JSON is camelCase.
- [ ] Every status code the endpoint can return is documented, with a Problem schema for errors.
- [ ] `oasdiff breaking` passes against `main`, or the breaking change has a v2 plan.
- [ ] Contract tests (Schemathesis or equivalent) run in CI.

**Safety**
- [ ] Every POST that creates something or moves money requires `Idempotency-Key`.
- [ ] Keys are scoped per client, hashed with method + path + canonical body, and expire on a documented window.
- [ ] The effect and the stored response commit in the same transaction (or recovery points exist for external calls).
- [ ] A 50-concurrent-duplicates test proves exactly one effect.
- [ ] GET handlers have no side effects.
- [ ] Updates to shared resources use `If-Match` (412/428).

**Lists**
- [ ] Lists use cursor pagination with a unique, indexed sort key; `limit` has a max.
- [ ] Filters, sort keys and fields are allowlisted; sorting only on indexed columns.
- [ ] Cursors are opaque, versioned and built from full-precision values.

**Errors and operations**
- [ ] Every error, including 404 route-not-found and 500, is `application/problem+json` with a stable `code` and `requestId`.
- [ ] No stack traces, SQL or internal names in responses.
- [ ] Timeouts on DB pool, statements and outbound calls; `Retry-After` on 409-in-progress, 429 and 503.
- [ ] Long-running work returns 202 with a pollable status resource.
- [ ] Graceful shutdown drains in-flight requests.
- [ ] Requests log `requestId`, `clientId`, route, status and latency (P1-08), and the idempotency table has a purge job.

---

## 🤖 Engineering with AI

**Where AI tools genuinely help with this concept**

- Drafting an OpenAPI spec from a plain-English description of resources, then you review it.
- Generating Zod schemas, test matrices (every status code per endpoint) and Problem Details catalogues from the spec.
- Explaining an `EXPLAIN (ANALYZE, BUFFERS)` plan line by line.
- Reviewing a spec for consistency: plural names, shared parameters, undocumented status codes.

**Where they commonly go wrong for this concept**

- **Check-then-insert idempotency**: a `SELECT` then `INSERT` with an `await` in between, and no unique constraint. Looks right, races under load.
- **No request hash**, so key reuse returns a wrong replay.
- **Saving the key after the work**, or in Redis with a TTL lock that is not tied to the database commit.
- **New UUID inside the client's retry loop.**
- **Offset pagination by default** for every list, and cursors sorted by `created_at` only, or built from a JS `Date`.
- **`res.status(500).json({ error: err.message })`**, leaking internals.
- **Verb URLs** (`/createTransfer`) and `200 OK` with `success: false`.
- **Floats for money** and amounts in rupees in one place, paise in another.
- **Outdated library syntax**: Zod 3 patterns in a Zod 4 project, or Fastify 4 hook signatures. Check versions.

**Review checklist for AI-generated code touching this concept**

- [ ] Is the idempotency claim a single atomic statement backed by a unique constraint?
- [ ] Is the request hash stored and compared? Does it include method and path?
- [ ] Do the effect and the stored response commit in one transaction?
- [ ] On failure with no commit, is the key released? Is there a lock expiry for crashes?
- [ ] Does the client create the key once per user action, outside the retry loop?
- [ ] Is every list sorted by a unique key, with a matching index, and cursor-paginated?
- [ ] Are all errors Problem Details with a stable `code`, and is nothing internal leaked?
- [ ] Does every network call (DB, HTTP) have a timeout?
- [ ] Do the Zod schemas `satisfies` the generated types, and do contract tests pass?

**Useful prompts**

1. *"Here is my OpenAPI spec. List every inconsistency: singular vs plural paths, parameter names that differ between list endpoints, error responses not using the Problem schema, POST operations without the Idempotency-Key parameter, and status codes the handlers can return but the spec does not document."*
   **Verify by:** running Redocly lint and Schemathesis yourself; the model's list is a starting point, not the answer.
2. *"Write a Vitest test that sends 50 concurrent identical POST /v1/transfers requests with the same Idempotency-Key using Fastify inject, then asserts exactly one row in transfers and the source balance debited once. Use the real Postgres pool, not mocks."*
   **Verify by:** temporarily breaking the claim (check-then-insert) and confirming the test **fails**. A test that cannot fail proves nothing.
3. *"Explain this EXPLAIN (ANALYZE, BUFFERS) output for an OFFSET query and a keyset query on the same index. Which line shows rows being read and thrown away?"*
   **Verify by:** matching the explanation to the actual `Buffers` and `actual rows` numbers in your output.

---

## 🎤 Interview script

**How this shows up.** "Define the API" is a fixed step in every system design round: wallets, payments, UPI-style P2P, ride booking, food ordering. Payment prompts always ask "how do you prevent double charges?". LLD rounds may ask you to design an idempotency middleware or a paginated feed. Strong candidates bring up idempotency keys, cursor pagination and a clear error contract **before** being asked.

**2-minute spoken answer outline: "Define the API for a wallet-to-wallet transfer system"**

1. **Resources (20 s):** "Accounts own wallets. Transfers move money between two wallets. I'll expose `POST /v1/transfers`, `GET /v1/transfers/{id}`, `GET /v1/transfers?walletId=&status=` and `GET /v1/wallets/{id}/transactions` for history."
2. **Money format (10 s):** "Amounts are integers in minor units with a currency code. No floats."
3. **Idempotency (40 s):** "The client sends an Idempotency-Key, a UUID per user action, reused on retries. The server claims it with a unique constraint, stores a hash of the request, and saves the response in the same transaction as the ledger write. A retry replays; a reused key with a different body gets a 409 or 422; a duplicate while the first is running gets 409 with Retry-After."
4. **Lists (20 s):** "History uses cursor pagination on `(created_at, id)` with a matching index, because offset is O(depth) and shows duplicates when new transactions arrive."
5. **Errors (15 s):** "All errors are RFC 9457 Problem Details with a stable code and request ID: 400 for malformed, 422 for business rules like insufficient funds, 409 for conflicts, 429 for rate limits."
6. **Evolution (15 s):** "Spec-first with OpenAPI; only additive changes in v1; Deprecation and Sunset headers before removal; watch traffic per app version."

**Mini design**

```text
POST /v1/transfers                 Idempotency-Key: <uuid>
  body: { sourceWalletId, destinationWalletId, amountMinor, currency, note? }
  201 Transfer | 400 | 404 | 409 | 422 | 429          (errors: application/problem+json)
GET  /v1/transfers/{id}            200 Transfer | 404
GET  /v1/transfers?walletId=&status=&limit=&cursor=   200 { data: Transfer[], page: { nextCursor, hasMore } }
GET  /v1/wallets/{id}/transactions?limit=&cursor=     200 { data: WalletTransaction[], page }
POST /v1/wallets/{id}/statement-exports               202 + Location: /v1/statement-exports/{exportId}
GET  /v1/statement-exports/{exportId}                 200 { status, downloadUrl? } + Retry-After
```

**LLD sketch: the idempotency store interface**

```ts
interface IdempotencyStore {
  claim(input: { clientId: string; key: string; requestHash: string; ttl: number; lock: number }): Promise<
    | { kind: "claimed"; claim: { id: string; lockToken: string } }
    | { kind: "replay"; response: StoredResponse }
    | { kind: "mismatch" }
    | { kind: "in_progress" }
  >;
  // Must run inside the same transaction as the business effect.
  complete(tx: Transaction, claim: Claim, response: StoredResponse): Promise<void>;
  release(claim: Claim): Promise<void>;
}
```

**Five likely follow-ups, with strong answers**

1. **"What if the server crashes after debiting but before saving the response?"** — "In my design that cannot happen as two separate steps: the debit and the stored response are one database transaction. If the crash is before commit, nothing happened; the key is released or its lock expires, and the retry runs it. If the operation calls an external bank, I store recovery points on the key row and pass my key downstream, so a retry resumes instead of repeating."
2. **"How long do you keep keys, and how big does that table get?"** — "Longer than any client retry schedule; 24 hours is common. At 20 lakh transfers a day and about 1.2 KB per row, that is roughly 2.4 GB live. I index `expires_at` and delete in batches, or partition by day and drop old partitions at higher scale."
3. **"Two duplicates hit two different servers at the same time?"** — "The guarantee comes from the database's unique constraint, not from app memory, so any number of app servers is fine. Across regions, I route a client's writes to one home region or use a store with a globally consistent unique check; otherwise two regions could both claim the key."
4. **"How do you paginate when the user sorts by amount?"** — "Keyset on `(amount_minor, id)`, with an index on `(wallet_id, amount_minor, id)`. The cursor encodes the sort key, the id and the sort direction; changing the sort restarts from page 1."
5. **"The bank takes 30 seconds to confirm. What does the API return?"** — "`202 Accepted` with a transfer in `pending` state and a `Location` to poll, plus a webhook for partners. The client never holds a 30-second request open."

**Red flags interviewers notice**

- "POST is idempotent if I check whether it exists first."
- The server generates the idempotency key (then it cannot recognise a retry).
- Offset pagination for an infinite feed, or sorting by a non-unique column.
- `200 OK` for errors, or one generic 500 for everything.
- Amounts as floats or in mixed units.
- No mention of timeouts, or treating a timeout as "failed".
- "We'll just version to v2" for every small change.

---

## ❓ Questions from the card, answered

Try to answer each one aloud first, then open it.

<details>
<summary><b>1. Is POST idempotent? How do you make "create transfer" safe to retry?</b></summary>

No. By HTTP's definition (RFC 9110), POST is neither safe nor idempotent: sending it twice may create two resources.

You make one POST endpoint safe to retry with an **idempotency key**:

1. The client generates a UUID once per user action and sends it as `Idempotency-Key` on every attempt.
2. The server validates the request, then atomically claims `(client_id, key)` with `INSERT ... ON CONFLICT DO NOTHING` on a unique constraint, storing a hash of method, path and canonical body.
3. The transfer and its response are written in **one** database transaction.
4. A retry with the same key and hash gets the stored response (`Idempotent-Replayed: true`). Same key with a different hash is rejected (409 on our platform; the IETF draft suggests 422). A retry while the first is still running gets 409 with `Retry-After`.
5. Keys expire after a documented window (24 hours here).

In this guide's lab, 50 concurrent duplicates produced exactly **1** transfer (1 × 201, 49 × 409).
</details>

<details>
<summary><b>2. Why does offset pagination get slow and show duplicates, and how does a cursor fix it?</b></summary>

**Slow:** `OFFSET n` makes the database read and discard n rows before returning the page, so cost grows with page depth. In this guide's benchmark on 10 lakh rows, page 10,000 took 54.32 ms (p50) with offset and touched 7,689 buffers, vs 0.40 ms and 6 buffers with a cursor.

**Duplicates:** offset counts positions, not rows. When new rows are inserted at the top while a user pages, every row shifts down and the next page repeats rows. Deletes make it skip rows.

**Cursor fix:** the cursor encodes the sort key of the last row seen, for example `(created_at, id)`. The next query is `WHERE (created_at, id) < (cursor) ORDER BY created_at DESC, id DESC LIMIT 50`. With a matching index, Postgres seeks straight to that position, so every page costs about the same, and new rows at the top cannot shift it. The sort key must be unique (add `id` as a tie-breaker) and the cursor must keep full precision (microseconds, not a JS `Date`).
</details>

<details>
<summary><b>3. When do you return 400 vs 409 vs 422?</b></summary>

- **400 Bad Request:** the server cannot understand the request. Malformed JSON, wrong types, unknown fields, missing required header such as `Idempotency-Key`. The client must fix the request.
- **422 Unprocessable Content:** the request is well-formed and valid against the schema, but breaks a business rule. Insufficient funds, frozen wallet, same source and destination.
- **409 Conflict:** the request is valid but clashes with the **current state** of the resource. Idempotency key reused for a different request, a request with this key still processing, or a state transition that is no longer allowed (cancelling a completed transfer).

Related: **412** when an `If-Match` ETag no longer matches. Teams draw the 409/422 line differently; what matters is one written rule, documented in the spec, plus a stable machine-readable `code` in every Problem Details body.
</details>

<details>
<summary><b>4. How do you change an API without breaking mobile apps that will not update for months?</b></summary>

1. **Only additive changes in place:** new optional request fields, new response fields, new endpoints. Never remove, rename, retype or change the meaning of a field.
2. **Tolerant clients:** apps ignore unknown fields and map unknown enum values and error codes to a safe default. Ship this before you need it.
3. **Know your traffic:** apps send an app version header; the server counts calls per version.
4. **Side by side:** for a real break, add the new field or a `/v2` path next to the old one and run both.
5. **Announce:** `Deprecation` (RFC 9745), `Sunset` (RFC 8594) and `Link rel="deprecation"` headers, plus release notes.
6. **Remove only on data:** when old-version traffic is near zero for a set period.
7. **Gate in CI:** `oasdiff breaking --fail-on ERR` blocks accidental breaking changes to the spec.
8. **Last resort:** a minimum-supported-version check that asks users to update.
</details>

---

## 🏋️ Exercises

**Beginner (no code)**

1. **Draw the crash case.** Draw a sequence diagram where the server claims key `k1`, then crashes before COMMIT. Show what retries see at 5 seconds and at 35 seconds.
   *Expected outcome:* 409 in-progress at 5 seconds (lock still valid); at 35 seconds the retry takes over and the transfer applies once.
   *Verify by:* "Break it" step 3 on your machine.
2. **Classify these changes** as additive or breaking: (a) add optional `note` to the transfer request; (b) rename `amountMinor` to `amount`; (c) add `"reversed"` to the transfer `status` enum; (d) reduce `note` max length from 140 to 100; (e) add `GET /v1/transfers/{id}/receipt`; (f) make `currency` optional with default `INR`; (g) change `createdAt` from ISO string to Unix seconds; (h) add a new error code `DAILY_LIMIT_EXCEEDED`.
   *Expected outcome:* additive: a, e, f (for requests), h (if clients have a default branch). Breaking: b, d, g. Usually breaking: c (strict clients).
   *Verify by:* the table in Deep dive section 7, and by running `oasdiff breaking` on before/after specs.

**Intermediate (extend the lab)**

1. **Build `GET /v1/transfers`** from the spec, with `walletId` and `status` filters, `sort=createdAt|-createdAt` and cursor pagination. The cursor must encode the sort direction and be rejected if used with a different sort.
   *Expected outcome:* walking all pages returns each transfer exactly once in both directions.
   *Verify by:* a test like `contract.test.ts` that inserts rows between pages.
2. **Return 405 with an `Allow` header** when a known path is called with an unsupported method.
   *Expected outcome:* Schemathesis's "Unsupported methods" findings disappear.
   *Verify by:* rerunning Schemathesis with the same `--seed`.
3. **Add `fields` selection** to `GET /v1/transfers` using an allowlist.
   *Expected outcome:* `?fields=id,status` returns only those keys; an unknown field returns 400 with a `parameter` field error.
   *Verify by:* tests, and by comparing response size in bytes with and without `fields`.

**Advanced (failure injection or 10x scale)**

1. **Many servers, one key.** Start three server processes on three ports. Fire 200 concurrent duplicates spread across all three.
   *Expected outcome:* exactly one transfer, because the guarantee lives in Postgres, not in any one process.
   *Verify by:* `SELECT count(*) FROM transfers` and the source balance.
2. **10x the key volume.** Simulate 2 crore keys a day: seed `idempotency_keys` with 2 crore rows and measure claim latency, then switch to daily partitions and purge by `DROP TABLE` on old partitions. Note that a unique constraint on a partitioned table must include the partition key, so you must decide how to keep `(client_id, idem_key)` unique across days.
   *Expected outcome:* purge time drops from minutes of `DELETE` to milliseconds; you can explain the uniqueness trade-off.
   *Verify by:* timing the purge both ways and writing down the design decision.
3. **Backwards pagination.** Add `prevCursor` so a user can scroll up after jumping into the middle of history.
   *Expected outcome:* forward then backward returns the same rows in reverse order.
   *Verify by:* a property-style test over random data.

---

## 📝 Quiz

1. Which of these methods is idempotent but **not** safe? (a) GET (b) PUT (c) POST (d) OPTIONS
2. A request times out after the server committed a transfer. What should the client do?
3. Two requests arrive with the same `Idempotency-Key` and different bodies. What does the server do on our platform, and why does it need a request hash to know?
4. Why must the stored response be written in the same transaction as the ledger rows?
5. A cursor sorts by `created_at` only. What goes wrong?
6. Why did building the cursor from a JavaScript `Date` lose rows?
7. Which status code tells a client "the version you edited is stale"? Which one says "you forgot to send the version"?
8. Name two Problem Details members defined by RFC 9457 and one extension member this card adds, with its purpose.
9. Is adding a new value to a response enum always safe? Why or why not?
10. A statement export takes 40 seconds. What status code does `POST /statement-exports` return, and what headers does it include?

---

## 🔑 Quiz answer key

1. **(b) PUT.** It changes state (not safe), but sending the same PUT twice leaves the same state (idempotent).
2. Treat the result as **unknown**, not failed. Retry with backoff using the **same** idempotency key; the server replays the stored 201.
3. It returns **409 `IDEMPOTENCY_KEY_REUSED`** (the IETF draft suggests 422). Without a stored hash of method, path and body, the server could not tell a true retry from a different request reusing the key, and would replay a wrong response.
4. So there is no moment where money moved but the key still says "processing" (or says "completed" while the money did not move). Either both commit or neither does, which makes every crash safe to retry.
5. Rows that share the last row's timestamp are skipped (or repeated, with `<=`). The order must be total: add the unique `id` as a tie-breaker.
6. Postgres stores microseconds; a JS `Date` keeps milliseconds. `.123456` became `.123`, so rows between those instants were excluded by the `<` comparison.
7. **412 Precondition Failed** for a stale `If-Match`; **428 Precondition Required** for a missing `If-Match`.
8. Any two of `type`, `title`, `status`, `detail`, `instance`. Extensions: `code` (stable machine-readable code for clients), `requestId` (correlate with logs), or `errors` (field-level problems with `pointer` or `parameter`).
9. No. A strict client with a `switch` over known values may crash or render nothing for the new value. It is safe only if all clients map unknown values to a default, which you must ship first.
10. **202 Accepted**, with `Location` pointing to the status resource and `Retry-After` suggesting when to poll. It also requires an `Idempotency-Key` like any create.

---

## 📖 Glossary

| Term | Meaning |
|---|---|
| 202 Accepted | "I have started the work; poll the Location for the result." |
| Additive change | An API change old clients can safely ignore. |
| Breaking change | An API change that makes a correct, existing client fail or misbehave. |
| Canonical JSON | JSON with keys in a fixed order, so equal objects produce equal text and hashes. |
| Contract test | A test that checks the running server against the API spec. |
| Cursor (keyset) pagination | Fetching the next page relative to the last row seen, using an index seek. |
| Deprecation header | RFC 9745 response header saying a resource is or will be deprecated. |
| ETag | A version tag for a resource; strong ETags compare byte-for-byte. |
| Idempotency key | A client-generated ID that lets the server recognise retries of one operation. |
| Idempotent | Repeating the request leaves the server in the same state as doing it once. |
| If-Match | Request header: "apply this only if the current ETag is this one". |
| Lost update | One writer silently overwrites another's change because neither checked the version. |
| Minor units | Money in the smallest unit (paise), stored as an integer. |
| OpenAPI | A machine-readable description of an HTTP API: paths, parameters, schemas, responses. |
| Optimistic concurrency | No locks while reading; the write checks the version and fails if it changed. |
| p50 / p95 | The latency that 50% / 95% of requests are faster than. |
| Problem Details | RFC 9457 JSON error format: `type`, `title`, `status`, `detail`, `instance`, plus extensions. |
| Request hash (fingerprint) | A hash of method, path and body stored with the key to detect key reuse. |
| Resource | A thing with its own URL that clients act on with HTTP methods. |
| Retry-After | Header telling the client how many seconds to wait before trying again. |
| Safe method | A method that should not change server state (GET, HEAD, OPTIONS). |
| Sunset header | RFC 8594 header giving the date after which a resource may stop working. |
| Tie-breaker | A unique column added to a sort so no two rows share a position. |
| Tolerant reader | A client that ignores unknown fields and handles unknown values gracefully. |

---

## 📌 Cheat sheet

**Diagram: the whole card on one screen**

```mermaid
mindmap
  root((REST API design))
    Resources
      Plural nouns
      Shallow nesting
      Actions as resources
    HTTP semantics
      Safe vs idempotent
      Timeout means unknown
      Status codes by meaning
    Lists
      Cursor not offset
      Unique sort key
      Same param names
    Money safety
      Idempotency key per action
      Request hash
      Effect and response in one tx
    Errors
      Problem Details
      Stable code field
      No internals leaked
    Evolution
      Additive only in place
      Deprecation and Sunset
      OpenAPI first and contract tests
```

**How to read this diagram.** Six branches, six habits. If you remember only the leaves, you can rebuild the whole card in an interview.

**Key rules on one screen**

- Nouns in URLs, methods as verbs. Actions become resources (`/transfers`, `/reversals`, `/statement-exports`).
- POST is not idempotent. Money-moving POSTs require `Idempotency-Key`: atomic claim, request hash, effect + response in one transaction, 24-hour expiry.
- Timeout, 502, 504 = **unknown**. Retry with the same key and backoff with jitter.
- 400 can't understand · 422 breaks a rule · 409 clashes with state · 412 stale ETag · 428 missing If-Match · 429 slow down.
- Lists: `limit` + opaque `cursor`, sort by a unique indexed key, full-precision values. Offset only for small, shallow lists.
- Errors: `application/problem+json`, stable `code`, `requestId`, no stack traces, never `200` with `success:false`.
- Evolve additively; tolerant clients; Deprecation + Sunset; remove on data.
- Spec first; generate types; `satisfies` in Zod; contract tests and `oasdiff` in CI.
- Measured here: offset page 10,000 = 54.32 ms vs cursor 0.40 ms (136x); 50 concurrent duplicates = 1 transfer.

---

## 🏁 Completion checklist

- [ ] I can explain safe vs idempotent and why a timeout means "unknown".
- [ ] I wrote (or adapted) the OpenAPI spec before code, linted it and generated types.
- [ ] Measure: my 50-concurrent-duplicates test applies exactly **1** transfer, and I wrote down the status code split.
- [ ] Measure: I benchmarked offset vs cursor at page 10,000 on 10 lakh rows and filled in my numbers.
- [ ] I reproduced at least one cursor bug (non-unique sort key or timestamp precision) and its fix.
- [ ] Every error from my server is Problem Details with a stable `code`, including 404 and 500.
- [ ] My statement export returns 202 with a pollable status resource.
- [ ] My wallet PATCH returns 412 on a stale ETag and 428 without one.
- [ ] I ran contract tests (Schemathesis) at least once and fixed what they found.
- [ ] Phase 1 gate: I can design and defend the API for a payments flow in an interview, unprompted on idempotency, pagination and errors.
- [ ] Lab run on my machine.
- [ ] Numbers filled in the measurements table.
- [ ] Post published.

---

## 📣 Learn in public

Use **your own** measured numbers in place of the ones from this guide.

**Post 1: "Offset pagination cost me 136x"**
- *Problem:* Transaction history pages got slower the deeper users scrolled, and showed repeated rows when new payments came in.
- *Decision:* Switched to keyset pagination on `(created_at, id)` with a matching index and an opaque cursor.
- *Result:* On 10 lakh rows, page 10,000 went from 54 ms to 0.40 ms (p50); buffers touched went from 7,689 to 6.
- *Lesson:* `OFFSET` reads and throws away every row before your page. And a cursor needs a unique sort key and full timestamp precision, or it silently skips rows.

**Post 2: "50 identical payment requests, 1 transfer"**
- *Problem:* On flaky mobile networks, a timeout does not mean the payment failed. Retries were a double-debit risk.
- *Decision:* Idempotency keys: one UUID per user action, atomic claim on a Postgres unique constraint, request hash, and the response stored in the same transaction as the money movement.
- *Result:* 50 concurrent duplicates → 1 transfer, 49 × `409 Retry-After`, and every later retry gets the original `201`.
- *Lesson:* The client half matters too: a new key per retry turned 1 transfer into 3 in my demo.

**Post 3: "Contract tests found 10 bugs in 6 seconds"**
- *Problem:* I wrote an OpenAPI spec and the code carefully by hand. I assumed they matched.
- *Decision:* Ran Schemathesis against the running server.
- *Result:* 10 mismatches: undocumented status codes, an error schema that disagreed with the code, two different regexes for the same header. Three spec fixes cut it to 5 known gaps.
- *Lesson:* Spec and code drift even in a tiny codebase. Make contract tests a CI step, not a one-time check.

**Hinglish video idea: "Payment double ho gaya? Idempotency key samjho 10 minute mein"**
Open with a phone in a lift: "₹500 bheja, network gaya, app ne retry kiya... paisa do baar kata?" Show the chai-stall token analogy, then live-run the 50-duplicates test (1 transfer), then show the client bug where a new key per retry gives 3 transfers. End with the one-line rule: "Key ek baar banao, har retry pe wahi bhejo."

---

## ➡️ Next cards

- **P1-04 · Other API styles: gRPC, GraphQL, webhooks.** You now know what REST does well (resources, HTTP semantics, caching, idempotency headers). That card compares it with gRPC for service-to-service calls, GraphQL for client-shaped queries (your `fields` parameter is a small step towards it), and webhooks for pushing results like a finished statement export.
- **P1-05 · Authentication and authorisation.** Our lab trusts an `x-client-id` header and the contract tests flagged three "missing auth" failures. That card replaces the stand-in with real identity, which also scopes idempotency keys correctly and decides 401 vs 403 vs 404.
- **P3-04 · Rate limiting.** You already return 429 with `Retry-After` in the contract. That card builds the limiter (token bucket, sliding window, per client and per route) and shows how it interacts with clients that retry.
- **Also linked:** ETags and `If-Match` here are the HTTP face of **P2-04 · Concurrency control**; the EXPLAIN reading continues in **P2-02 · Indexes and query plans**; the export worker is **P3-05 · Queues and background jobs**.

---

## 📚 Sources and further reading

All links checked on 12 October 2026.

- [RFC 9110: HTTP Semantics](https://www.rfc-editor.org/rfc/rfc9110) — safe and idempotent methods (section 9.2), status codes.
- [RFC 9457: Problem Details for HTTP APIs](https://www.rfc-editor.org/rfc/rfc9457) — July 2023, obsoletes RFC 7807; includes the `errors`/`pointer` example.
- [The Idempotency-Key HTTP Header Field (IETF draft)](https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/) — draft-07, October 2025, marked expired; 400 / 422 / 409 recommendations.
- [RFC 9745: The Deprecation HTTP Response Header Field](https://www.rfc-editor.org/rfc/rfc9745) — March 2025.
- [RFC 8594: The Sunset HTTP Header Field](https://www.rfc-editor.org/rfc/rfc8594).
- [RFC 6585: Additional HTTP Status Codes](https://www.rfc-editor.org/rfc/rfc6585) — defines 428 Precondition Required and 429.
- [Stripe API: Idempotent requests](https://docs.stripe.com/api/idempotent_requests) — how a large payments API stores results, compares parameters and prunes keys.
- [Implementing Stripe-like Idempotency Keys in Postgres (Brandur Leach)](https://brandur.org/idempotency-keys) — atomic phases and recovery points for external side effects.
- [Use The Index, Luke: No Offset](https://use-the-index-luke.com/no-offset) — keyset pagination explained.
- [PostgreSQL 16: Row constructor comparison](https://www.postgresql.org/docs/16/functions-comparisons.html#ROW-WISE-COMPARISON) — how `(a, b) < (c, d)` works.
- [OpenAPI Specification 3.1.1](https://spec.openapis.org/oas/v3.1.1) and [3.2.0](https://spec.openapis.org/oas/v3.2).
- [openapi-typescript and openapi-fetch](https://openapi-ts.dev/) — type generation and the typed client used in the lab.
- [Redocly CLI lint](https://redocly.com/docs/cli/commands/lint).
- [Schemathesis documentation](https://schemathesis.readthedocs.io/en/stable/).
- [oasdiff](https://github.com/oasdiff/oasdiff) and its [breaking-changes docs](https://github.com/oasdiff/oasdiff/blob/main/docs/BREAKING-CHANGES.md) — `oasdiff breaking --fail-on ERR`.
- [Fastify hooks reference](https://fastify.dev/docs/latest/Reference/Hooks/) — returning `reply` from an async hook.
- [Zod 4 documentation](https://zod.dev/).


