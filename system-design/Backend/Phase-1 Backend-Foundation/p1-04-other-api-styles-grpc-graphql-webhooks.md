# P1-04 · Other API styles: gRPC, GraphQL, webhooks

| | |
|---|---|
| **Phase** | 1 · Backend foundations |
| **Prerequisites** | P1-03 · REST API design |
| **Leads to** | P4-06 · Event streaming with Kafka · P4-08 · Service boundaries |
| **Suggested repo path** | `system-design/phase-1/p1-04-other-api-styles-grpc-graphql-webhooks.md` |
| **Facts checked on** | 12 October 2026 |

The card you pasted had no ID; **P1-04** comes from the Phase 1 tab of your roadmap doc.

**After this card you can:**

1. Pick REST, gRPC, GraphQL, webhooks, tRPC or SSE/WebSockets for a given consumer, and defend the choice in one sentence.
2. Write a protobuf contract, generate TypeScript types from it, call it with a deadline, and change it later without breaking old callers.
3. Find a GraphQL N+1 problem in the SQL log and fix it with DataLoader (this guide: **222 queries → 4**).
4. Send signed webhooks with retries and a delivery log, and build a receiver that rejects forgeries and ignores duplicates.
5. Explain, with your own benchmark, when gRPC is faster than REST and when it is not.

> **About the numbers in this guide.** Everything marked **Real output** was run while writing this guide: Node 22, PostgreSQL 16.15, a 2-vCPU Linux sandbox where client, server and database share the same two CPUs. Your numbers will differ; compare directions, not decimals. Versions checked on 12 Oct 2026: @grpc/grpc-js 1.14.6, @grpc/proto-loader 0.8.1, protobufjs 8.8.1, graphql 17.0.2, graphql-yoga 5.24.4, dataloader 2.2.3, @trpc/server and @trpc/client 11.19.0, Fastify 5.12.5, Zod 4.6.7.

---

## ⏱️ The concept in one minute

REST (P1-03) is the right default for a public API. But the ledger platform has other kinds of conversations too:

- The **gateway asks the ledger service** for a balance thousands of times a second. Both sides are ours.
- The **merchant dashboard** wants "account → 20 wallets → last 10 transactions → who paid" on one screen.
- A **kirana shop's billing software** wants to know the moment a transfer completes, without asking every few seconds.
- Our **internal ops dashboard** is a Next.js app in the same repo as the API, built by the same team.

Each one has a better-fitting tool:

| Conversation | Best fit | One line |
|---|---|---|
| Public API for apps and partners | **REST** | Everyone understands it; HTTP caching and tooling for free |
| Service to service, inside our network | **gRPC** | A typed contract (protobuf), binary messages, HTTP/2, deadlines, streaming |
| A screen that needs many shapes from many sources | **GraphQL** | One endpoint; the client asks for exactly the fields it needs |
| Telling a partner "something happened" | **Webhooks** | We POST a signed event to their URL; they never poll |
| Our own TypeScript client and server, one team | **tRPC** | Call server functions with full types; no schema file, no codegen |
| Live updates to a browser | **SSE or WebSockets** | Push over an open connection (card P3-06) |

**Analogy.** Think of how a busy Bengaluru restaurant talks. Waiters shout orders to the kitchen in a fixed shorthand ("2 masala, 1 plain, no onion") because speed matters and both sides know the code: that is **gRPC**. A customer at the counter gets a printed menu everyone can read: that is **REST**. A thali counter where you point at exactly which katoris you want, from many kitchens, on one plate: that is **GraphQL**. And the Swiggy partner gets a phone call when the order is ready, instead of calling every two minutes: that is a **webhook**.

**One line:** pick the API style by **who the consumer is**, **how fast and how often they call**, and **how the contract will change**.

---

## 💥 The problem it solves

Here is what happens on the ledger platform if everything is REST + JSON and nothing else.

**1. Partners poll for updates.** 2,000 kirana-shop billing systems call `GET /v1/transfers?status=completed` every 10 seconds to see if a payment landed. That is **200 requests per second, about 1.73 crore (17.28 million) requests a day**, almost all returning "nothing new", and each shop still sees a payment **5 seconds late on average**. If the platform does 2 lakh transfers a day, webhooks would send 2 lakh deliveries: **about 1.16% of the polling traffic**, delivered within a second. *(The 2,000 shops, 10-second interval and 2 lakh transfers are assumptions; the arithmetic is computed.)*

**2. The dashboard makes 21 round trips.** The merchant dashboard shows an account, its 20 wallets and each wallet's last 10 transactions. With plain REST it calls `GET /accounts/{id}/wallets` and then `GET /wallets/{id}/transactions?limit=10` twenty times. Over a 150 ms mobile round trip, that is **3,150 ms** if done one by one, **750 ms** with 6 parallel connections, and **150 ms** as one GraphQL request. *(150 ms round trip is an assumption.)* But move that to GraphQL naively and the server makes **222 SQL queries** for that one request. DataLoader brings it to **4** (Real output, lab step 2).

**3. Internal calls carry dead weight.** The gateway calls the ledger for balances. The same answer is **112 bytes as JSON and 57 bytes as protobuf** (Real output). At 5,000 calls a second that is about **23.8 GB a day** of extra bytes, plus JSON parsing on both sides, plus a hand-written client that can drift from the server.

**4. Webhooks done casually lose money.** The first version POSTs to the partner once, inside the transfer request, with no signature. The partner's server is deploying: the event is lost forever. An attacker POSTs a fake "transfer completed" event: the shop hands over goods for a payment that never happened. A retry delivers the event twice: the shop ships two orders.

This card gives you the right tool for each conversation, and the safety rules each tool needs.

---

## 🧰 Before you start

**Prerequisite card:** P1-03 · REST API design. You need resources and status codes, idempotency keys, cursor pagination and Problem Details. This card reuses the P1-03 database schema, the pool with timeouts and the Problem Details helpers.

**Key terms (each is explained again where it first matters):**

| Term | Plain meaning |
|---|---|
| RPC | Remote procedure call: calling a function that runs on another machine as if it were local. |
| gRPC | Google's RPC framework: protobuf messages over HTTP/2, with generated clients. |
| Protocol Buffers (protobuf) | A schema language plus a compact binary format. Each field has a **number**, not a name, on the wire. |
| HTTP/2 | The newer HTTP: many requests share one TCP connection at the same time (multiplexing), with binary framing. |
| Deadline | The absolute time after which the caller stops waiting. gRPC sets **none** by default. |
| Unary / streaming | One request and one response, versus a stream of messages in one or both directions. |
| GraphQL | A query language: one endpoint, the client names the exact fields it wants. |
| Resolver | The function that fetches one field's value in a GraphQL server. |
| N+1 problem | One query for a list, then one more query per item in the list. |
| DataLoader | A small library that collects many `load(id)` calls in the same tick and makes one batched query. |
| Webhook | An HTTP POST we send to a partner's URL when an event happens. |
| HMAC | A signature made with a shared secret key, so the receiver can check who sent the message and that it was not changed. |
| Replay attack | Re-sending a real, signed old message to trigger the action again. |
| tRPC | A TypeScript library: the client calls server procedures with types inferred from the server code. |
| BFF | Backend for frontend: an API layer shaped for one particular UI. |

**Lab setup:** Node 22+, Docker for Postgres 16, about 3 hours. No Python needed.

---

## 🧠 How it works

**Mental model: an API style is a contract plus a transport plus a direction.**

| | Contract (who defines the shape?) | Transport | Direction |
|---|---|---|---|
| REST | OpenAPI, resources and status codes | HTTP/1.1 or 2, JSON | Client pulls |
| gRPC | `.proto` file, field numbers | HTTP/2, protobuf binary | Client pulls, or streams both ways |
| GraphQL | GraphQL schema (types and fields) | Usually HTTP POST, JSON | Client pulls exactly the fields it names |
| Webhooks | Event types and payload docs | HTTP POST, JSON, signed | **Server pushes** to the partner |
| tRPC | The TypeScript router itself | HTTP, JSON | Client pulls |

Once you see the three columns, choosing gets easier. "The partner needs to know immediately" is a **direction** problem: push, so webhooks. "Two services, thousands of calls a second, both ours" is a **contract and transport** problem: gRPC. "Twelve screens, each wanting different fields" is a **contract** problem: GraphQL.

**Diagram: which API style talks to whom on the ledger platform**

```mermaid
flowchart TD
  subgraph Outside["Outside our network"]
    app["React Native app"]
    merchant["Merchant dashboard"]
    pos["Kirana POS partner"]
  end
  subgraph Edge
    gateway["API gateway<br/>public REST"]
    bff["GraphQL BFF"]
    ops["Ops dashboard<br/>tRPC"]
  end
  subgraph Internal["Inside our network"]
    ledger["Ledger service<br/>gRPC"]
    db[("Postgres")]
  end
  app -->|"REST + JSON"| gateway
  merchant -->|"GraphQL query"| bff
  gateway -->|"gRPC with deadline"| ledger
  ops -->|"typed calls"| ledger
  bff -->|"batched SQL"| db
  ledger --> db
  ledger -->|"signed webhook"| pos
```

**How to read this diagram.** Arrows show who starts the conversation. Phones and browsers use REST (public, cache-friendly) or GraphQL (many shapes). Inside the network, the gateway calls the ledger over gRPC with a deadline. The ops dashboard is our own TypeScript app, so it uses tRPC. The only arrow pointing **out** to a partner is the webhook: we push, they do not poll.

**A React developer's way to see it.** REST is like `fetch` to a fixed URL that returns a fixed shape. GraphQL is like asking for exactly the props your component needs, from one place. tRPC is like importing a server function and calling it, with TypeScript checking every argument. gRPC is the same idea as tRPC, but language-neutral: the contract is a `.proto` file that Go, Java and Node all generate code from. Webhooks are the server calling *your* `onEvent` handler, except over the internet.

---

## 🔬 Deep dive

Each Learn-inside item gets its own section. Every core idea has a **minimal version** (one small file you can run with `npx tsx`) and, in the lab, a **product version**.

### 1. gRPC

#### 1a. Protocol Buffers schemas

**What it is.** You describe messages and services in a `.proto` file. Each field gets a **type** and a **field number**. On the wire, protobuf sends the number, not the name. That is why it is small, and why numbers are sacred.

```proto
message GetBalanceResponse {
  string wallet_id = 1;
  int64 balance_minor = 2;   // paise; int64 because a merchant balance can pass 2^31 paise
  string currency = 3;
}
```

**Diagram: what goes on the wire for one message**

```text
TransferCompleted { transfer_id: "t_91", amount_minor: 50000, currency: "INR" }

field 1, string   field 2, varint       field 3, string
+-----------------+---------------------+---------------+
| 0A 04 t _ 9 1   | 10 D0 86 03         | 1A 03 I N R   |
+-----------------+---------------------+---------------+
  tag  len  bytes   tag  50000 in 3 bytes  tag len bytes

15 bytes in total. The same data as JSON is 60 bytes.
```

**How to read this diagram.** Each field starts with a tag byte that packs the field **number** and a wire type (string, varint and so on). Names like `amount_minor` never travel. A reader that sees "field 2, varint" looks up field 2 in **its own** copy of the schema. If someone changed what field 2 means, the reader is silently wrong. The byte counts (15 vs 60) come from the minimal script below.

**Why `int64` for money.** A 32-bit integer holds at most 2,147,483,647 paise, about ₹2.15 crore. A busy merchant wallet can pass that. With `@grpc/proto-loader`, use `longs: String` so `int64` arrives in JavaScript as a **string** and never loses precision as a float.

#### 1b. Code generation

You do not hand-write clients or request types. A generator reads the `.proto` and writes TypeScript. In this lab:

```bash
npx proto-loader-gen-types --longs=String --enums=String --defaults --oneofs \
  --grpcLib=@grpc/grpc-js --importFileExtension=.js \
  --outDir=src/generated/proto proto/ledger/v1/ledger.proto
```

It produces a typed client interface (`LedgerServiceClient`), a typed handler interface (`LedgerServiceHandlers`) and two types per message: a permissive input type and a strict `__Output` type. A slice of the generated file (**Real output**):

```ts
export interface GetBalanceResponse__Output {
  'walletId': (string);
  'balanceMinor': (string);
  'currency': (string);
  'asOfUnixMs': (string);
  'status': (_ledger_v1_WalletStatus__Output);
}
```

Two real gotchas from building this lab:

- **Field names change case.** `@grpc/proto-loader` turns `wallet_id` into `walletId` in JavaScript by default. The first version of the minimal script below sent `{ wallet_id: ... }` and got back `{ walletId: '', balanceMinor: '0' }`: **no error, just empty defaults**. Generated types catch this at compile time; untyped code does not.
- **The loader options must match the codegen flags.** If codegen says `longs=String` but the runtime loader uses numbers, the types lie.

**Alternative: Connect.** Connect (connectrpc.com, `@connectrpc/connect` 2.2.0) generates code with the Buf toolchain, and its servers speak gRPC, gRPC-Web (for browsers, without a translating proxy) and the Connect protocol, which works as plain HTTP + JSON you can call with curl. Good when browsers must call the same service. This lab uses `@grpc/grpc-js`, the classic choice the card names first.

#### 1c. HTTP/2 transport

gRPC runs only on **HTTP/2**. Three properties matter:

- **Multiplexing.** Many calls share one TCP connection at the same time. The gateway opens one connection to the ledger and sends thousands of calls over it, with no new handshakes.
- **Binary framing and header compression.** Less parsing and fewer bytes per call.
- **Streams.** A call is a stream that can carry many messages each way, which is what makes gRPC streaming possible.

**Two consequences people miss:**

- **Browsers cannot call gRPC directly.** They cannot control HTTP/2 frames and trailers the way gRPC needs. Use REST or GraphQL at the edge, or gRPC-Web/Connect through a proxy.
- **Long-lived connections confuse simple load balancers.** A layer-4 (TCP) load balancer spreads *connections*, not calls. One gateway pod with one HTTP/2 connection sends **all** its calls to **one** ledger pod. You need a layer-7 balancer that understands HTTP/2 (Envoy, a service mesh) or client-side load balancing.

#### 1d. Unary vs streaming calls

| Kind | Shape | Ledger example |
|---|---|---|
| Unary | 1 request → 1 response | `GetBalance` |
| Server streaming | 1 request → many responses | `WatchBalance`: push each balance change to the notifications service |
| Client streaming | many requests → 1 response | Upload a large reconciliation file in chunks, get one summary |
| Bidirectional | many ↔ many | A live chat between support agent and AI agent (later phases) |

**Minimal version:** `minimal/grpc-basics.ts` (with `minimal/balance.proto`)

```proto
syntax = "proto3";

package demo;

service Balances {
  rpc Get (WalletRef) returns (Balance);              // unary
  rpc Watch (WalletRef) returns (stream Balance);     // server streaming
}

message WalletRef { string wallet_id = 1; }
message Balance { string wallet_id = 1; int64 balance_minor = 2; }
```

```ts
// minimal/grpc-basics.ts — a unary call, a server stream, and a deadline, in one file.
// Run: npx tsx minimal/grpc-basics.ts
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";

// proto-loader turns wallet_id into walletId in JS (keepCase: false is the default).
const def = protoLoader.loadSync(new URL("./balance.proto", import.meta.url).pathname, { longs: String, defaults: true });
const { demo } = grpc.loadPackageDefinition(def) as any; // the lab uses generated types instead of `any`
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const server = new grpc.Server();
server.addService(demo.Balances.service, {
  async Get(call: any, callback: grpc.sendUnaryData<unknown>) {
    if (call.request.walletId === "slow") await sleep(300); // pretend the DB is stuck
    callback(null, { walletId: call.request.walletId, balanceMinor: "990000" });
  },
  async Watch(call: any) {
    for (const balance of ["990000", "985000", "1035000"]) {
      call.write({ walletId: call.request.walletId, balanceMinor: balance });
      await sleep(50);
    }
    call.end();
  },
});
const port = await new Promise<number>((ok, fail) =>
  server.bindAsync("127.0.0.1:0", grpc.ServerCredentials.createInsecure(), (e, p) => (e ? fail(e) : ok(p))));

const client = new demo.Balances(`127.0.0.1:${port}`, grpc.credentials.createInsecure());
const get = (walletId: string, deadlineMs: number) =>
  new Promise((ok, fail) =>
    client.Get({ walletId }, { deadline: Date.now() + deadlineMs }, (e: grpc.ServiceError | null, r: unknown) => (e ? fail(e) : ok(r))));

console.log("unary:", await get("w1", 200));
const t = performance.now();
await get("slow", 100).catch((e: grpc.ServiceError) =>
  console.log(`deadline: ${grpc.status[e.code]} after ${Math.round(performance.now() - t)} ms`));
for await (const update of client.Watch({ walletId: "w1" })) console.log("stream:", update);

client.close();
server.forceShutdown();
```

**Real output**

```text
unary: { walletId: 'w1', balanceMinor: '990000' }
deadline: DEADLINE_EXCEEDED after 112 ms
stream: { walletId: 'w1', balanceMinor: '990000' }
stream: { walletId: 'w1', balanceMinor: '985000' }
stream: { walletId: 'w1', balanceMinor: '1035000' }
```

**What to notice**

- `balanceMinor` arrives as a **string** (`longs: String`), so paise never become a float.
- The slow call failed with `DEADLINE_EXCEEDED` after about 100 ms instead of waiting 300 ms. The caller decided how long to wait.
- The stream is just an async iterable on the client: `for await ... of`.
- This file uses `any` to stay short. The product version uses generated types and has no `any`.

#### 1e. Deadlines

**What it is.** A deadline is the absolute time after which the caller gives up. gRPC sets **no deadline by default**, so a call to a stuck service can wait forever and hold a connection, memory and a user's request with it. When the deadline passes, the client gets `DEADLINE_EXCEEDED` and the server's call is cancelled, though the server code must still check and stop its own work.

**Deadline budgets.** A user request has a total budget, say 500 ms at p99. The gateway spends a little, then gives the ledger **what is left**, not a fresh 500 ms. gRPC sends the remaining time (not a clock timestamp) on each hop, which avoids clock-skew bugs. Some gRPC implementations pass deadlines on to downstream calls automatically (the gRPC docs name Java and Go); in Node you pass them explicitly, as the lab code does.

**Diagram: unary call with a deadline, and a stream**

```mermaid
sequenceDiagram
  participant G as Gateway
  participant L as Ledger service
  participant DB as Postgres
  G->>L: GetBalance w1, deadline now plus 300 ms
  L->>DB: SELECT balance
  DB-->>L: 990000 paise
  L-->>G: OK, balanceMinor 990000
  G->>L: GetBalance w2, deadline now plus 300 ms
  L->>DB: SELECT balance, but DB is slow
  Note over G,L: 300 ms pass
  L--xG: DEADLINE_EXCEEDED, gateway returns 504
  G->>L: WatchBalance w1
  L-->>G: BalanceChanged 985000
  L-->>G: BalanceChanged 1035000
  G->>L: cancel stream
```

**How to read this diagram.** The first call finishes inside its budget. The second hits a slow database; at 300 ms the gateway stops waiting and returns a clean 504 Problem to the app, instead of hanging. The last part is a server stream: one request, many pushed messages, until the caller cancels.

**When to use gRPC, and when not.** Use it between services you own, when calls are frequent, latency matters, you want one contract across languages, or you need streaming. Do not use it for browsers, for third-party developers who expect curl-able JSON, or when HTTP caching of responses matters.

**Trade-off.** You gain types, smaller payloads, connection reuse and streaming. You pay with binary payloads you cannot read in a log without tooling, an HTTP/2-aware load balancer, a codegen step in the build, and a team that must follow protobuf evolution rules.

#### 1f. Backward-compatible field changes

Old services and new services run **at the same time** during every deploy, and for months for some consumers. So a schema change must work in both directions: new code reads old bytes, old code reads new bytes.

**The rules (from the protobuf language guide):**

| Change | Safe? | Why |
|---|---|---|
| Add a new field with a **new** number | Safe | Old readers skip unknown fields; new readers see the default for old data |
| Delete a field and `reserved` its number and name | Safe | Nobody can ever reuse the number |
| Add an enum value | Wire-safe, but may break a `switch` with no default | Old code sees a value it does not know |
| Rename a field, keep the number | Wire-safe | Names do not travel in binary (but JSON mapping and code break) |
| Change a field's **number** | **Unsafe** | It is a delete plus an add; old data lands in the wrong field |
| **Reuse** an old number for a new field | **Unsafe** | Old data decodes as the new field: silent corruption |
| Change type, for example `int64` → `string` | **Unsafe** | Wire types differ; only a few pairs (like `int32`/`int64`) are compatible, with care |
| Make a singular numeric field `repeated` | Avoid | Numeric repeated fields are packed by default |

Field numbers 1 to 15 take one byte on the wire; 16 to 2047 take two. Give the busiest fields the small numbers.

**Minimal version (protobuf schema evolution, safe and unsafe):** `minimal/protobuf-evolution.ts`

```ts
// minimal/protobuf-evolution.ts — encode with one schema version, decode with another.
// Run: npx tsx minimal/protobuf-evolution.ts
import protobuf from "protobufjs";

const load = (fields: string) =>
  protobuf.parse(`syntax = "proto3"; message TransferCompleted { ${fields} }`).root.lookupType("TransferCompleted");

const v1 = load(`string transfer_id = 1; int64 amount_minor = 2; string currency = 3;`);
// Safe: a NEW field with a NEW number. Old readers skip it; new readers see "" for old data.
const v2Safe = load(`string transfer_id = 1; int64 amount_minor = 2; string currency = 3; string note = 4;`);
// Unsafe: number 2 now means "fee", and the amount moved to number 5. Same wire type, so no error.
const v2Unsafe = load(`string transfer_id = 1; int64 fee_minor = 2; string currency = 3; int64 amount_minor = 5;`);

const show = (type: protobuf.Type, bytes: Uint8Array) =>
  JSON.stringify(type.toObject(type.decode(bytes), { longs: String, defaults: true }));

const oldBytes = v1.encode(v1.create({ transferId: "t_91", amountMinor: 50000, currency: "INR" })).finish();
console.log("v1 writes 50000 paise:      ", oldBytes.length, "bytes");
console.log("v2-safe reads old bytes:    ", show(v2Safe, oldBytes));
console.log("v2-unsafe reads old bytes:  ", show(v2Unsafe, oldBytes), "<- amount became a fee");

const newBytes = v2Safe.encode(v2Safe.create({ transferId: "t_92", amountMinor: 1500, currency: "INR", note: "chai" })).finish();
console.log("v1 reads v2-safe bytes:     ", show(v1, newBytes), "<- note skipped, rest intact");

const json = JSON.stringify({ transferId: "t_91", amountMinor: "50000", currency: "INR" });
console.log("same message as JSON:       ", Buffer.byteLength(json), "bytes");
```

**Real output**

```text
v1 writes 50000 paise:       15 bytes
v2-safe reads old bytes:     {"transferId":"t_91","amountMinor":"50000","currency":"INR","note":""}
v2-unsafe reads old bytes:   {"transferId":"t_91","feeMinor":"50000","currency":"INR","amountMinor":"0"} <- amount became a fee
v1 reads v2-safe bytes:      {"transferId":"t_92","amountMinor":"1500","currency":"INR"} <- note skipped, rest intact
same message as JSON:        60 bytes
```

**What to notice**

- **Safe change:** adding `note = 4` works both ways. Old readers skip field 4; new readers get `""` for old messages.
- **Unsafe change:** reusing number 2 for `fee_minor` produced **no error at all**. A ₹500 transfer was read as a ₹500 *fee* and a ₹0 amount. In a ledger, that is the worst kind of bug: silent and plausible.
- The protection is one line in the schema: `reserved 2; reserved "amount_minor";` so the compiler refuses any future reuse.

**The product proto uses all of this:** a field added later with a new number (`status = 5`), an enum whose zero value is `UNSPECIFIED` (what old data decodes to), and `reserved` for a deleted field. See lab step 1.

### 2. GraphQL

#### 2a. Schemas and resolvers

**What it is.** A GraphQL server publishes a **schema**: types, their fields, and the root `Query` (reads) and `Mutation` (writes). For every field there is a **resolver**: a function `(parent, args, context) => value`. The engine walks the client's query and calls resolvers level by level.

```graphql
type Query { account(id: ID!): Account }
type Account { id: ID! displayName: String! wallets: [Wallet!]! }
type Wallet { id: ID! balanceMinor: String! transactions(last: Int = 10): [WalletTransaction!]! }
```

`Wallet.transactions` is resolved **once per wallet**: the resolver receives that wallet as `parent`. Keep that in mind; it is where N+1 comes from.

**Money in GraphQL.** The built-in `Int` is 32-bit signed. 2,147,483,647 paise is only about ₹2.15 crore, so a merchant balance can overflow it. Send money as a `String` of paise (as this lab does) or a custom scalar.

#### 2b. One endpoint serving many shapes

The mobile wallet screen asks for `{ wallet(id) { balanceMinor } }`. The merchant dashboard asks for the account, wallets, transactions and counterparties in **one request**. Same endpoint (`POST /graphql`), same schema, different shapes. No over-fetching (fields you do not need) and no under-fetching (many round trips).

This is why GraphQL is often used as a **BFF** (backend for frontend): a layer in front of several services that gives each UI exactly what it needs.

**When not to use it.** Simple CRUD for one client, file downloads, public partner APIs where you want HTTP caching and a stable resource contract, and service-to-service calls. GraphQL adds a schema, resolvers, batching, cost limits and its own error format. That cost pays off only when many clients need many shapes.

#### 2c. The resolver N+1 problem and DataLoader

**The problem.** For "account → 20 wallets → last 10 transactions each → counterparty of each transaction":

- 1 query for the account
- 1 query for its wallets
- **20** queries for transactions (one per wallet)
- **200** queries for counterparties (one per transaction)

That is **222 queries** for one GraphQL request. Each one is a network round trip to Postgres, and each one takes a connection from the pool.

**The fix: DataLoader.** Inside one request, resolvers call `loader.load(walletId)` instead of querying. DataLoader collects every `load()` made in the same tick of the event loop, then calls your **batch function once** with all the keys: one `WHERE id = ANY($1)` query. The batch function must return results **in the same order as the keys**, one per key. Loaders also cache by key, so the same counterparty is fetched once.

**Diagram: the same query without and with DataLoader**

```mermaid
flowchart TD
  subgraph With["With DataLoader: 4 queries"]
    a2["account: 1 query"] --> w2["wallets: 1 batched query"]
    w2 --> t2["transactions: 1 batched query<br/>for all 20 wallets"]
    t2 --> c2["counterparty: 1 batched query<br/>for all accounts"]
  end
  subgraph Without["Without DataLoader: 222 queries"]
    a1["account: 1 query"] --> w1["wallets: 1 query"]
    w1 --> t1["transactions: 20 queries<br/>one per wallet"]
    t1 --> c1["counterparty: 200 queries<br/>one per transaction"]
  end
```

**How to read this diagram.** Both sides run the same query and return the same JSON. On the left, each level multiplies the number of queries by the size of the level above. On the right, each level is one query no matter how many items it covers. The numbers are from this guide's lab run on real Postgres.

**Minimal version:** `minimal/graphql-n-plus-one.ts`

```ts
// minimal/graphql-n-plus-one.ts — count "SQL queries" for one GraphQL query, without and with DataLoader.
// Run: npx tsx minimal/graphql-n-plus-one.ts
import DataLoader from "dataloader";
import { graphql } from "graphql";
import { createSchema } from "graphql-yoga";

// A fake database: 1 account, 20 wallets, 10 transactions per wallet, each with a counterparty account.
let queries = 0;
const db = {
  walletsOf: async (accountId: string) => { queries++; return Array.from({ length: 20 }, (_, i) => ({ id: `w${i}`, accountId })); },
  txnsOf: async (walletId: string) => { queries++; return Array.from({ length: 10 }, (_, i) => ({ id: `${walletId}-t${i}`, counterpartyId: `acc${i}` })); },
  txnsOfMany: async (walletIds: readonly string[]) => { queries++; return walletIds.map((w) => Array.from({ length: 10 }, (_, i) => ({ id: `${w}-t${i}`, counterpartyId: `acc${i}` }))); },
  account: async (id: string) => { queries++; return { id, displayName: `Shop ${id}` }; },
  accounts: async (ids: readonly string[]) => { queries++; return ids.map((id) => ({ id, displayName: `Shop ${id}` })); },
};

type Ctx = { batched: boolean; txns: DataLoader<string, { id: string; counterpartyId: string }[]>; accounts: DataLoader<string, { id: string; displayName: string }> };
const schema = createSchema<Ctx>({
  typeDefs: /* GraphQL */ `
    type Query { account(id: ID!): Account }
    type Account { id: ID! displayName: String! wallets: [Wallet!]! }
    type Wallet { id: ID! transactions: [Txn!]! }
    type Txn { id: ID! counterparty: Account! }`,
  resolvers: {
    Query: { account: (_: unknown, a: { id: string }) => db.account(a.id) },
    Account: { wallets: (acc: { id: string }) => db.walletsOf(acc.id) },
    Wallet: { transactions: (w: { id: string }, _: unknown, ctx: Ctx) => (ctx.batched ? ctx.txns.load(w.id) : db.txnsOf(w.id)) },
    Txn: { counterparty: (t: { counterpartyId: string }, _: unknown, ctx: Ctx) => (ctx.batched ? ctx.accounts.load(t.counterpartyId) : db.account(t.counterpartyId)) },
  },
});

const source = `{ account(id: "acc_riya") { wallets { transactions { counterparty { displayName } } } } }`;
for (const batched of [false, true]) {
  queries = 0;
  // New loaders per request: the cache must never leak between users.
  const contextValue: Ctx = { batched, txns: new DataLoader(db.txnsOfMany), accounts: new DataLoader(db.accounts) };
  const result = await graphql({ schema, source, contextValue });
  if (result.errors) throw result.errors[0];
  console.log(`${batched ? "with DataLoader:   " : "without DataLoader:"} ${queries} queries`);
}
```

**Real output**

```text
without DataLoader: 222 queries
with DataLoader:    4 queries
```

**What to notice**

- The resolvers are almost identical. The only change is `ctx.txns.load(w.id)` instead of `db.txnsOf(w.id)`.
- The 200 counterparty lookups became **one** query, because they all happen in the same tick and many repeat the same 10 accounts (the cache dedupes them).
- Loaders are created **per request** inside the context. A global loader would cache one user's data and serve it to another.

**DataLoader before-and-after on real Postgres** (lab step 2, **Real output**):

| Query | Before (naive resolvers) | After (DataLoader) |
|---|---|---|
| One wallet with its last 10 transactions and counterparties (the card's query) | **12** SQL queries | **3** SQL queries |
| An account with 20 wallets, each with its last 10 transactions and counterparties | **222** SQL queries | **4** SQL queries |

The test also checks that both versions return identical JSON.

#### 2d. Query cost limits

**The problem.** One endpoint that serves any shape will also serve a **dangerous** shape. Our schema has a cycle: `Wallet → transactions → counterparty (Account) → wallets → transactions → ...`. A client can nest it a few levels and ask the server for millions of objects in one request. Batching does not save you from that; it only makes each level one query.

**The fix: reject expensive queries before running them.** A validation rule walks the query and estimates its cost: each field costs 1, multiplied by how many times its parent list repeats it (`wallets` up to 20, `transactions` up to its `last` argument, capped at 50). Over the limit (1,000 here) → error, **zero SQL**.

**Real output** (lab test against the product server):

```text
evil query -> Query cost 3022021 exceeds the limit of 1000 | SQL queries: 0
```

For scale, the card's normal queries cost **53** (one wallet, last 10 transactions) and **842** (account with 20 wallets) under the same rule (computed with the rule itself).

Other limits to stack on top: maximum depth, maximum aliases (aliases let one query call the same field many times), server-side caps on page sizes, a request timeout, and rate limiting by cost (card P3-04). Libraries like GraphQL Armor package several of these; the lab writes the cost rule by hand so you can see how it works.

**Persisted operations.** For your own apps, the strongest protection is to only accept queries you have shipped: the client sends a hash, the server looks up the stored query. Arbitrary queries from outside are rejected. GraphQL Yoga and Apollo both support this; check their docs for the current plugin names.

#### 2e. Why HTTP caching gets harder

With REST, the URL `GET /v1/wallets/w1` is a free cache key. Browsers, CDNs and proxies all cache by URL. With GraphQL:

- Most requests are `POST /graphql` with the query in the body. **Shared HTTP caches do not cache POST.**
- Two different queries can return overlapping data about the same wallet. There is no single URL that identifies "wallet w1".
- Errors usually come back as `200 OK` with an `errors` array, so status-based monitoring and caching rules see "success".

**What people do instead:**

- **Client-side normalized caches** (Apollo Client, urql): store objects by `__typename` + `id`, so give every type a stable, globally unique `id` (graphql.org's caching guide recommends this).
- **GET for queries with persisted operations**, so the URL becomes a stable, cacheable key. The GraphQL over HTTP spec (still a working draft) allows GET for queries and forbids it for mutations, and recommends the `application/graphql-response+json` media type.
- **Server-side response or field caching** in the BFF, with explicit cache hints.

**Trade-off summary for GraphQL.** You gain flexible shapes, fewer round trips and one typed schema for many UIs. You pay with N+1 risk, cost limits, harder caching, `200 OK` errors and more server work per request.

### 3. Webhooks

#### 3a. Pushing events to other systems

**What it is.** When something happens (a transfer completes), we send an HTTP `POST` with a JSON event to a URL the partner registered. The partner returns `2xx` to say "got it".

**The safe architecture has four parts:**

1. **Outbox.** In the **same database transaction** as the transfer, insert the event and one "delivery" row per subscribed endpoint. If the transfer rolls back, no webhook exists. If it commits, the webhook is guaranteed to be attempted. (Calling the partner from inside the transfer request gives neither guarantee and makes your transfer as slow as their server. The outbox pattern gets a full card later: P4-07.)
2. **Delivery worker.** A background process claims due deliveries, signs and sends them, and schedules retries.
3. **Delivery log.** One row per HTTP attempt: time, status, error, duration, a snippet of the response. Support answers "did you send it?" from this table, and partners can see it in a dashboard.
4. **Receiver rules** (the partner's side): verify the signature, check the timestamp, dedupe by event ID, return `2xx` fast and do the real work later.

**Diagram: lifecycle of one delivery**

```mermaid
stateDiagram-v2
  [*] --> pending: transfer commits with its event
  pending --> pending: non-2xx or timeout, schedule next attempt
  pending --> succeeded: partner returns 2xx
  pending --> dead: schedule used up, or 410 Gone
  dead --> pending: support or partner replays it
  succeeded --> [*]
```

**How to read this diagram.** Every delivery starts `pending` when the transfer commits. Failures keep it `pending` with a later `next_attempt_at`. A `2xx` ends it. When the retry schedule runs out (or the partner returns `410 Gone`, meaning "this URL is gone for good"), it becomes `dead`, which must alert someone. A dead delivery can be replayed by hand.

#### 3b. HMAC signatures

**The problem.** The partner's URL is public. Anyone can POST `{"type":"transfer.completed","amountMinor":5000000}` to it.

**The fix.** We share a secret with each endpoint once (shown in our dashboard, never sent with webhooks). For every delivery we compute `HMAC-SHA256(secret, id + "." + timestamp + "." + body)` and send it in a header. The receiver recomputes it with its copy of the secret. A forger without the secret cannot produce a valid signature; changing even one byte of the body breaks it.

This lab follows the **Standard Webhooks** spec's format:

| Header | Value |
|---|---|
| `webhook-id` | The event ID. Same on every retry. |
| `webhook-timestamp` | Unix seconds of **this attempt**. |
| `webhook-signature` | `v1,` + base64 HMAC-SHA256 of `id.timestamp.body`. Several space-separated signatures are allowed during secret rotation. |

Other providers use the same idea with different headers. Stripe sends `Stripe-Signature: t=<timestamp>,v1=<hex HMAC of "timestamp.body">`. GitHub sends `X-Hub-Signature-256: sha256=<hex HMAC of the body>` with **no** timestamp, so its receivers rely on the delivery ID against replays.

**Compare signatures in constant time.** `a === b` stops at the first different character, so an attacker measuring response times can, in principle, learn the correct signature byte by byte. `crypto.timingSafeEqual` always compares every byte. Both Stripe and GitHub tell you to use a constant-time comparison. Note that `timingSafeEqual` **throws** if the two buffers differ in length, so check lengths first.

**Verify the raw body.** The signature covers the exact bytes sent. If your framework parses JSON and you re-stringify it, spacing or key order can change and verification fails. Keep the raw body for the signature check.

#### 3c. Timestamps against replay

A signature proves who sent a message, not **when**. An attacker who captures one real, signed "transfer completed" can send it again tomorrow. Because the timestamp is **inside** the signed string, it cannot be edited without breaking the signature. The receiver rejects anything older than a tolerance; 5 minutes is the common choice (it is Stripe's library default). Senders re-sign each retry with a fresh timestamp, so slow retries still pass.

**Minimal version:** `minimal/webhook-signature.ts`

```ts
// minimal/webhook-signature.ts — sign a webhook, then verify it the right way and the wrong way.
// Run: npx tsx minimal/webhook-signature.ts
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const secret = randomBytes(32); // shared once with the partner, never sent with the webhook

function sign(id: string, timestamp: number, body: string): string {
  // Standard Webhooks style: sign "id.timestamp.body" so none of the three can be swapped.
  return "v1," + createHmac("sha256", secret).update(`${id}.${timestamp}.${body}`).digest("base64");
}

function verify(id: string, timestamp: number, body: string, header: string, now = Date.now() / 1000): string {
  if (Math.abs(now - timestamp) > 300) return "rejected: timestamp outside 5 minutes (replay?)";
  const expected = Buffer.from(sign(id, timestamp, body));
  const received = Buffer.from(header);
  // timingSafeEqual throws on different lengths, so check length first.
  const ok = received.length === expected.length && timingSafeEqual(received, expected);
  return ok ? "accepted" : "rejected: bad signature";
}

const id = "evt_01JA9X";
const ts = Math.floor(Date.now() / 1000);
const body = JSON.stringify({ type: "transfer.completed", data: { transferId: "t_91", amountMinor: 50000 } });
const header = sign(id, ts, body);

console.log("genuine:            ", verify(id, ts, body, header));
console.log("amount changed:     ", verify(id, ts, body.replace("50000", "5000000"), header));
console.log("replayed 1 hour on: ", verify(id, ts, body, header, ts + 3600));
console.log("other event's id:   ", verify("evt_OTHER", ts, body, header));
try {
  timingSafeEqual(Buffer.from("v1,short"), Buffer.from(header));
} catch (e) {
  console.log("timingSafeEqual on different lengths throws:", (e as Error).message.slice(0, 60));
}
```

**Real output**

```text
genuine:             accepted
amount changed:      rejected: bad signature
replayed 1 hour on:  rejected: timestamp outside 5 minutes (replay?)
other event's id:    rejected: bad signature
timingSafeEqual on different lengths throws: Input buffers must have the same byte length
```

**What to notice**

- Changing ₹500 to ₹50,000 in the body broke the signature.
- The replayed message had a **valid signature** and was still rejected, because of the timestamp.
- The event ID is signed too, so an attacker cannot attach a good signature to a different event.

#### 3d. Retries with backoff

Partners' servers go down, deploy, time out and rate-limit. A webhook system without retries silently drops events. Retries follow an **exponential backoff with jitter**: wait longer after each failure, with some randomness so that after an outage, thousands of retries do not arrive in one wave.

The Standard Webhooks spec suggests attempts at: immediately, 5 seconds, 5 minutes, 30 minutes, 2 hours, 5 hours, 10 hours, 14 hours, 20 hours and 24 hours after the first attempt (10 attempts over a day). For comparison, Stripe's docs say it retries for up to three days in live mode, while GitHub does **not** retry automatically (you redeliver by hand, up to 3 days back).

How to treat responses (from the Standard Webhooks spec):

- Any `2xx` is success.
- `3xx` is a failure; do not follow redirects with a signed payload.
- `410 Gone` means disable the endpoint.
- `429`, `502`, `504`: slow down; respect a `Retry-After` header if present.
- Everything else, timeouts and refused connections: retry on schedule.

#### 3e. Idempotent receivers

**At-least-once is the deal.** If the receiver processes an event but its `200` is lost (timeout, network drop), the sender must retry: from the sender's side, "no answer" looks exactly like "not delivered". So **every webhook receiver will see duplicates**. Stripe's docs say so plainly and tell you to log processed event IDs.

**The fix.** The event ID is stable across retries (`webhook-id`). The receiver stores it with a unique constraint. First insert wins; a duplicate is acknowledged with `200` and skipped. Ordering is not guaranteed either: design receivers so an older event arriving late cannot overwrite newer state (include a version or timestamp, or fetch the latest state from the API).

**Minimal version:** `minimal/webhook-retry-dedupe.ts`

```ts
// minimal/webhook-retry-dedupe.ts — a sender that retries with backoff, a receiver that ignores duplicates.
// Run: npx tsx minimal/webhook-retry-dedupe.ts
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SCHEDULE_MS = [0, 5_000, 300_000, 1_800_000]; // immediately, 5 s, 5 min, 30 min (scaled down below)
const SCALE = 1 / 1000; // run the demo in milliseconds instead of minutes

// Receiver: down for the first 2 attempts; on attempt 3 it processes but the 200 is lost in transit.
const processed = new Set<string>();
let duplicatesIgnored = 0;
let calls = 0;
async function receiver(eventId: string): Promise<number> {
  calls++;
  if (calls <= 2) return 503; // deploying
  if (processed.has(eventId)) { duplicatesIgnored++; return 200; } // seen it: acknowledge, do nothing
  processed.add(eventId); // in production: INSERT ... ON CONFLICT DO NOTHING on the event id
  if (calls === 3) throw new Error("ETIMEDOUT"); // our 200 never reached the sender
  return 200;
}

// Sender: same event id on every attempt, backoff with jitter, a log line per attempt.
async function deliver(eventId: string): Promise<void> {
  for (let attempt = 1; attempt <= SCHEDULE_MS.length; attempt++) {
    const wait = SCHEDULE_MS[attempt - 1]! * (0.9 + Math.random() * 0.2); // ±10% jitter
    await sleep(wait * SCALE);
    const status = await receiver(eventId).catch((e: Error) => e.message);
    console.log(`attempt ${attempt} after ~${Math.round(wait / 1000)} s -> ${status}`);
    if (status === 200) return;
  }
  console.log("gave up: mark the delivery dead and alert the partner");
}

await deliver("evt_01JA9X");
console.log(`attempts: ${calls}, processed: ${processed.size}, duplicates safely ignored: ${duplicatesIgnored}`);
```

**Real output** (jitter makes the waits differ slightly on each run)

```text
attempt 1 after ~0 s -> 503
attempt 2 after ~5 s -> 503
attempt 3 after ~290 s -> ETIMEDOUT
attempt 4 after ~1929 s -> 200
attempts: 4, processed: 1, duplicates safely ignored: 1
```

**What to notice**

- Four attempts, **one** processing. Attempt 3 actually succeeded on the receiver; only the reply was lost. Without the event-ID check, the shop would have shipped the order twice.
- The waits grow (0 s, 5 s, about 5 min, about 30 min) and are not exact, because of jitter.
- The sender cannot know attempt 3 worked. That is why the receiver, not the sender, owns deduplication.

#### 3f. Delivery logs

The delivery log is not optional decoration. Without it:

- A partner says "we never got the payment event for order 4417". You cannot prove anything.
- An endpoint has been returning `500` for two days and nobody noticed, because errors went only to a log stream that rotates.
- A dead delivery is never replayed.

The lab's `webhook_delivery_attempts` table records every attempt. Production adds: a dashboard (or API) for partners to see attempts and replay, an alert when deliveries go `dead` or an endpoint's success rate drops, and retention (for example 30 days).

**Two more sender-side rules people forget:**

- **SSRF protection.** Partners register URLs, and your worker makes requests to them from inside your network. Block private and link-local addresses (10.x, 172.16-31.x, 192.168.x, 127.x, 169.254.169.254 cloud metadata) and re-check after DNS resolution, or an attacker registers `http://169.254.169.254/...` as their "webhook URL".
- **HTTPS only** in production, short timeouts (a few seconds), and a maximum response size you read.

### 4. tRPC: TypeScript-only, when you own both sides

**What it is.** You write procedures on the server (`walletBalance`, `freezeWallet`) with Zod input validation. The client imports only the router's **type** and calls procedures like functions. Inputs and outputs are type-checked end to end, with no schema file and no code generation. tRPC v11 accepts Zod and any Standard Schema validator for inputs.

**When to use it.** One team, TypeScript on both sides, ideally one monorepo: an internal ops dashboard, an admin panel, a Next.js app with its own backend.

**When not to use it.** Public APIs, mobile apps released through app stores (old app versions keep calling old procedure shapes; tRPC has no versioning story beyond your own discipline), other languages, or anything a partner will call.

**Minimal version:** `minimal/trpc-basics.ts`

```ts
// minimal/trpc-basics.ts — server procedures and a fully typed caller, no schema file, no codegen.
// Run: npx tsx minimal/trpc-basics.ts
import { initTRPC, TRPCError } from "@trpc/server";
import { z } from "zod";

const t = initTRPC.create();
const balances = new Map([["w1", 990000]]);

const appRouter = t.router({
  walletBalance: t.procedure
    .input(z.object({ walletId: z.string() }))
    .query(({ input }) => {
      const balanceMinor = balances.get(input.walletId);
      if (balanceMinor === undefined) throw new TRPCError({ code: "NOT_FOUND", message: "Wallet not found" });
      return { walletId: input.walletId, balanceMinor };
    }),
});
export type AppRouter = typeof appRouter; // the ONLY thing the client imports (as a type)

// createCaller runs procedures in-process. Over HTTP you would use createTRPCClient<AppRouter>.
const caller = t.createCallerFactory(appRouter)({});
const res = await caller.walletBalance({ walletId: "w1" });
console.log("typed result:", res, "-> balanceMinor is a", typeof res.balanceMinor);
await caller.walletBalance({ walletId: "nope" }).catch((e: TRPCError) => console.log("error:", e.code, e.message));
// @ts-expect-error -- typo in the input key is caught at compile time, before any request is sent
await caller.walletBalance({ walletID: "w1" }).catch((e: TRPCError) => console.log("runtime too:", e.code));
```

**Real output**

```text
typed result: { walletId: 'w1', balanceMinor: 990000 } -> balanceMinor is a number
error: NOT_FOUND Wallet not found
runtime too: BAD_REQUEST
```

And without the `@ts-expect-error` line, `tsc` refuses the typo. **Real output:**

```text
minimal/trpc-typo.ts(26,30): error TS2561: Object literal may only specify known properties, but 'walletID' does not exist in type '{ walletId: string; }'. Did you mean to write 'walletId'?
```

**What to notice**

- The client knows `balanceMinor` is a `number` without any generated file: TypeScript infers it from the server code.
- Zod still validates at runtime (`BAD_REQUEST`), because a type check does not protect you from a hand-crafted HTTP request.
- The router type is the contract. Renaming a procedure breaks the dashboard's build immediately, which is great inside one repo and terrible for an app on someone's phone.

### 5. Choosing a style

**The decision table** (the card asks for REST vs gRPC vs GraphQL vs webhooks; tRPC and SSE/WebSockets are added for completeness):

| Question | REST | gRPC | GraphQL | Webhooks | tRPC | SSE / WebSockets |
|---|---|---|---|---|---|---|
| Who is the consumer? | Anyone: apps, partners, public | Our own services | Our UIs, a BFF | Partner systems | Our own TS frontend | Browsers and apps that need live updates |
| Who starts the conversation? | Client pulls | Client pulls, or streams | Client pulls | **We push** | Client pulls | Server pushes over an open connection |
| Contract | OpenAPI | `.proto` + field numbers | GraphQL schema | Event types + payload docs | The TS router type | Message format you define |
| Typical payload | JSON | Binary protobuf | JSON | JSON, signed | JSON | Text or binary frames |
| Latency and throughput | Good | Best for frequent internal calls; streaming | Fewer round trips; more server work | Near real time, at-least-once | Good | Lowest for live updates |
| HTTP caching | Easy (URLs) | No | Hard (POST, one URL) | Not applicable | Possible for GET queries | No |
| Browser support | Yes | Not directly (needs gRPC-Web/Connect) | Yes | Not applicable | Yes | Yes |
| Evolution | Additive + versions, Deprecation headers | Field-number rules, `reserved` | Add fields, `@deprecated` | Version the event types; additive payloads | Same repo, change together | Version your messages |
| Biggest risk | Over/under-fetching, chatty clients | Load balancing, binary debugging | N+1, cost, caching | Lost or duplicated events, forgery | Tight coupling | Connection scale, reconnects |
| On the ledger platform | Public mobile and partner API | Gateway → ledger, notifications → ledger | Merchant dashboard BFF | "Transfer completed" to kirana POS | Ops dashboard | Live balance on the web dashboard (P3-06) |

**Diagram: choosing an API style**

```mermaid
flowchart TD
  start{"Who is the consumer?"}
  start -->|"Partner or public developer"| push{"Do they need to be<br/>told when things happen?"}
  push -->|"yes"| webhooks["Webhooks<br/>plus REST to fetch details"]
  push -->|"no"| rest["REST"]
  start -->|"Another of our services"| grpc["gRPC"]
  start -->|"Our own UI"| ts{"Same team, TypeScript<br/>on both sides?"}
  ts -->|"yes, internal tool"| trpc["tRPC"]
  ts -->|"no, or many UIs"| shapes{"Many screens needing<br/>different shapes?"}
  shapes -->|"yes"| gql["GraphQL BFF"]
  shapes -->|"no"| rest
  start -->|"A browser needing live updates"| live["SSE or WebSockets"]
```

**How to read this diagram.** Start from the consumer, not from the technology you like. Partners get REST, plus webhooks if they must react to events. Our services talk gRPC. Our own UIs get tRPC (one team, internal), a GraphQL BFF (many shapes), or plain REST. Live updates to a browser are their own category (P3-06).

**Real systems mix styles.** The ledger platform in this guide uses REST, gRPC, GraphQL, webhooks and tRPC at the same time, each where it fits. The interview signal is not "I like GraphQL"; it is "this consumer, this latency, this evolution story, therefore this style".

---

## ⚖️ Comparisons and trade-offs

**gRPC vs REST for the same internal call** (this guide's benchmark, lab step 1, **Real output**, 2 shared vCPUs)

| Measure | gRPC | REST (Fastify + fetch) | Who wins |
|---|---|---|---|
| p50, one call at a time | 1.230 ms | 0.864 ms | REST, 1.42x |
| p95, one call at a time | 2.507 ms | 1.925 ms | REST, 1.30x |
| p50, 32 calls in flight | 7.128 ms | 8.876 ms | gRPC |
| p95, 32 calls in flight | 18.154 ms | 21.930 ms | gRPC, 1.21x |
| Throughput, 32 in flight | 3,671 req/s | 3,123 req/s | gRPC, +17.5% |
| Response payload | 57 bytes | 112 bytes | gRPC, 49% smaller |

Three runs gave the same direction each time. The honest reading: for one small call on loopback, gRPC's extra layers (HTTP/2 framing, protobuf encoding, grpc-js) cost more than they save, and REST is faster. Under concurrency, one multiplexed HTTP/2 connection and smaller messages win. The bigger, unmeasured wins are the typed contract, deadlines and streaming. Over a real network, with bigger messages or many hops, the payload difference matters more.

**REST vs GraphQL for the merchant dashboard**

| | REST (one call per wallet) | GraphQL without batching | GraphQL with DataLoader |
|---|---|---|---|
| HTTP round trips from the browser | 21 | 1 | 1 |
| SQL queries on the server (20 wallets) | 1-2 per request, across 21 requests | 222 in one request | 4 in one request |
| Over-fetching | Each endpoint returns its full shape | None | None |
| HTTP caching | Easy per URL | Hard | Hard |
| Server CPU per request | Low | High | Medium |

**Webhooks vs polling for partners**

| | Polling (`GET` every 10 s) | Webhooks |
|---|---|---|
| Requests a day (2,000 shops, 2 lakh transfers) | 1.73 crore | 2 lakh (about 1.16%) |
| Delay | 5 s average, 10 s worst | Usually under a second |
| Partner work | Simple client | Public HTTPS endpoint, signature check, dedupe |
| Our work | Serve a lot of empty reads | Outbox, worker, retries, delivery log, signing |
| Missed events | Impossible if they poll forever | Possible without retries and a log |
| Best practice | Offer it as a **backup** ("list events since X") | Primary channel |

**gRPC vs tRPC (both "call a function on the server")**

| | gRPC | tRPC |
|---|---|---|
| Contract | `.proto` file, language-neutral | TypeScript router type |
| Languages | Go, Java, Node, Python and many more | TypeScript only |
| Code generation | Yes | No |
| Wire format | Binary protobuf over HTTP/2 | JSON over HTTP |
| Browser | Needs gRPC-Web or Connect | Native |
| Evolution | Field-number rules let old and new run together | Change both sides in one commit |
| Fits | Polyglot services, high volume, streaming | One TS team, one repo, internal UIs |

**Webhook signature schemes**

| | Standard Webhooks (this lab) | Stripe | GitHub |
|---|---|---|---|
| Header | `webhook-signature` (+ `webhook-id`, `webhook-timestamp`) | `Stripe-Signature: t=...,v1=...` | `X-Hub-Signature-256: sha256=...` |
| Signed content | `id.timestamp.body` | `timestamp.body` | body |
| Encoding | base64 | hex | hex |
| Timestamp against replay | Yes | Yes (library default tolerance 5 min) | No (use the delivery ID) |
| Automatic retries | Recommended, over about a day | Up to 3 days in live mode | No, manual redelivery |

---

## 🚶 Walkthrough on the ledger platform: "transfer completed" reaches a kirana shop

Riya pays ₹500 to Lakshmi Stores. Lakshmi's billing software (a partner) has registered a webhook URL for `transfer.completed`. Their server is mid-deploy for the first two attempts, and on the third attempt their `200` is lost on the way back. The numbers below match the arrows in the diagram.

**Diagram: webhook delivery with signature check and retry**

```mermaid
sequenceDiagram
  autonumber
  participant L as Ledger
  participant DB as Ledger DB
  participant W as Worker
  participant R as Partner
  L->>DB: COMMIT transfer, event, delivery row
  W->>DB: claim due delivery, SKIP LOCKED
  W->>R: POST signed, webhook-id evt_1
  R-->>W: 503, deploying
  W->>DB: log attempt 1, retry in about 5 s
  W->>R: POST again, same id, new signature
  R->>R: verify HMAC and timestamp
  R->>R: inbox INSERT evt_1, inserted
  R--xW: 200 lost, worker times out
  W->>R: POST third time, same id
  R->>R: inbox INSERT evt_1, conflict
  R-->>W: 200, duplicate true
  W->>DB: mark succeeded, attempts logged
```

**How to read this diagram.** Time flows down. "Partner" is Lakshmi Stores' receiver plus its inbox table. Steps 1-2 happen inside our system; steps 3-12 cross the internet. The cross on arrow 9 means the response never arrived. Arrow 11 is the important one: the receiver recognises the event ID and does nothing, so Lakshmi Stores records the payment once.

1. **The ledger commits the transfer, the event and a delivery row in one transaction** (the outbox). If the transfer had failed, there would be no event.
2. **The delivery worker claims the due delivery.** `FOR UPDATE SKIP LOCKED` lets several workers run without sending the same delivery twice at the same moment. Claiming also pushes `next_attempt_at` forward by a lease, so a crashed worker's delivery becomes due again.
3. **First POST.** Headers: `webhook-id: evt_1`, `webhook-timestamp: <now>`, `webhook-signature: v1,<HMAC of id.timestamp.body>`. The body is the exact stored JSON.
4. **The partner returns `503`** because it is deploying.
5. **The worker logs attempt 1** (status 503, duration) and schedules the next attempt at about 5 seconds, with jitter.
6. **Second POST.** Same event ID, same body, **new** timestamp and signature.
7. **The receiver verifies.** It recomputes the HMAC over the raw body and compares with `timingSafeEqual`. It checks the timestamp is within 5 minutes.
8. **It inserts `evt_1` into its inbox** with `ON CONFLICT DO NOTHING`. The insert succeeds: this is the first time. A partner worker will process the inbox later.
9. **Its `200` is lost.** The network drops, or the receiver was too slow. The worker's 5-second timeout fires. From the worker's view, this attempt failed.
10. **Third POST**, same event ID.
11. **The inbox insert hits the primary key.** The receiver knows it already has this event.
12. **It returns `200` with `duplicate: true`.** No second "payment received" entry in Lakshmi's books.
13. **The worker marks the delivery succeeded.** The delivery log shows three attempts: 503, timeout, 200.

The lab's webhook tests reproduce steps 3-13 against a real HTTP receiver and real Postgres.

---

## 🧪 Hands-on lab

You will add three things to the ledger platform: a gRPC `GetBalance` called from the gateway with a deadline, a GraphQL BFF query fixed with DataLoader, and signed webhooks with retries and an idempotent receiver. All product code below was type-checked with TypeScript 5.9 in strict mode and tested against PostgreSQL 16.15 while writing this guide: **12 tests, all passing**.

**Prerequisites:** Node 22+, Docker. The P1-03 lab's database schema (`001_init.sql`), pool and Problem Details helpers.

**Project layout (new files for this card)**

```text
ledger-api/
├── proto/ledger/v1/ledger.proto           # the gRPC contract (step 1)
├── src/
│   ├── generated/proto/                   # generated by proto-loader-gen-types; never edited
│   ├── grpc/{ledgerProto,ledgerGrpcServer}.ts
│   ├── gateway/{ledgerClient,balanceRoute}.ts
│   ├── ledger/main.ts                     # ledger process: gRPC + a REST twin for the benchmark
│   ├── events/balanceEvents.ts            # stand-in for Kafka (P4-06)
│   ├── repositories/walletRepository.ts
│   ├── graphql/{typeDefs,rows,requestDb,loaders,resolvers,naiveResolvers,costLimit,server}.ts
│   ├── webhooks/{signature,enqueue,retryPolicy,deliveryLog,deliveryWorker}.ts
│   ├── partner/receiver.ts                # what a partner runs (to test both ends)
│   ├── trpc/{opsRouter,mount,dashboardClient}.ts
│   └── db/migrations/002_webhooks.sql
├── bench/grpc-vs-rest.ts
└── test/{grpc,graphql,webhooks}.test.ts   # helpers/db.ts resets and seeds (P1-07)
```

**`docker-compose.yml`** (same as P1-03)

```yaml
services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: ledger
    ports: ["5432:5432"]
```

**Install**

```bash
npm install @grpc/grpc-js @grpc/proto-loader protobufjs graphql graphql-yoga dataloader \
  @trpc/server @trpc/client fastify zod pg pino
npm install -D typescript@5 tsx vitest @types/pg @types/node
export DATABASE_URL=postgres://postgres:postgres@localhost:5432/ledger
```

`tsconfig.json` uses `"strict": true`, `"noUncheckedIndexedAccess": true`, `"module": "NodeNext"`. Plumbing not printed here: `src/config/env.ts` (Zod over `process.env`, P1-06), `src/db/pool.ts` and `src/lib/problem.ts` and `src/plugins/errorHandler.ts` (from P1-03), and `test/helpers/db.ts` (reset schema, seed one account with 20 wallets and 15 transfers each to 10 merchants).

### Step 1: `GetBalance` over gRPC, called from the gateway with a deadline

**1.1 The contract.** `proto/ledger/v1/ledger.proto`:

```proto
// proto/ledger/v1/ledger.proto — the internal contract of the ledger service.
syntax = "proto3";

package ledger.v1;

// Called by other services (gateway, notifications). Mobile apps use the public REST API (P1-03).
service LedgerService {
  // Unary: one request, one response.
  rpc GetBalance(GetBalanceRequest) returns (GetBalanceResponse);
  // Server streaming: the caller gets a message each time the balance changes, until it cancels.
  rpc WatchBalance(WatchBalanceRequest) returns (stream BalanceChanged);
}

message GetBalanceRequest {
  string wallet_id = 1;
}

message GetBalanceResponse {
  string wallet_id = 1;
  int64 balance_minor = 2; // paise; int64 because a merchant balance can pass 2^31 paise
  string currency = 3;
  int64 as_of_unix_ms = 4;
  // Added in a later release. Old callers skip it; it never reuses a number.
  WalletStatus status = 5;

  // Numbers and names of deleted fields can never come back.
  reserved 6;
  reserved "hold_minor";
}

enum WalletStatus {
  WALLET_STATUS_UNSPECIFIED = 0; // proto3 enums must start at 0; old data decodes to this
  WALLET_STATUS_ACTIVE = 1;
  WALLET_STATUS_FROZEN = 2;
}

message WatchBalanceRequest {
  string wallet_id = 1;
}

message BalanceChanged {
  string wallet_id = 1;
  int64 balance_minor = 2;
  string transfer_id = 3;
}
```

**What to notice**

- The package has a version (`ledger.v1`). A truly breaking redesign becomes `ledger.v2`, running next to v1.
- `status = 5` is the "safe change" from Deep dive 1f, done right: new number, and an `UNSPECIFIED` zero value that old messages decode to.
- `reserved 6` and `reserved "hold_minor"` record a deleted field so nobody can reuse its number or name.

**1.2 Generate types**

```bash
npx proto-loader-gen-types --longs=String --enums=String --defaults --oneofs \
  --grpcLib=@grpc/grpc-js --importFileExtension=.js \
  --outDir=src/generated/proto proto/ledger/v1/ledger.proto
```

`--importFileExtension=.js` matters with `"module": "NodeNext"`: without it, the generated files import `'../../ledger/v1/BalanceChanged'` without an extension, which NodeNext rejects.

**1.3 Load the proto once.** `src/grpc/ledgerProto.ts`:

```ts
// src/grpc/ledgerProto.ts — load the .proto once; server and client share it.
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import type { ProtoGrpcType } from "../generated/proto/ledger.js";

const PROTO_PATH = fileURLToPath(new URL("../../proto/ledger/v1/ledger.proto", import.meta.url));

// These options MUST match the proto-loader-gen-types flags, or the generated types lie.
// longs: String keeps int64 paise exact; enums: String gives readable enum names.
const definition = protoLoader.loadSync(PROTO_PATH, { longs: String, enums: String, defaults: true, oneofs: true });

export const ledgerProto = (grpc.loadPackageDefinition(definition) as unknown as ProtoGrpcType).ledger.v1;
```

**1.4 The server.** `src/repositories/walletRepository.ts` is the single query both gRPC and REST use:

```ts
// src/repositories/walletRepository.ts — the one query both GetBalance (gRPC) and the REST route use.
import { pool } from "../db/pool.js";

export interface WalletBalance {
  walletId: string;
  balanceMinor: string; // bigint stays a string end to end: no float, no precision loss
  currency: string;
  status: "active" | "frozen";
}

export async function findBalance(walletId: string): Promise<WalletBalance | null> {
  const { rows } = await pool.query<{ id: string; balance_minor: string; currency: string; status: WalletBalance["status"] }>(
    "SELECT id, balance_minor, currency, status FROM wallets WHERE id = $1",
    [walletId],
  );
  const row = rows[0];
  return row ? { walletId: row.id, balanceMinor: row.balance_minor, currency: row.currency.trim(), status: row.status } : null;
}
```

`src/events/balanceEvents.ts` stands in for the event stream that `WatchBalance` listens to (Kafka in P4-06):

```ts
// src/events/balanceEvents.ts — in-process stand-in for the balance-changed event stream (Kafka in P4-06).
import { EventEmitter } from "node:events";

export interface BalanceChangedEvent { walletId: string; balanceMinor: string; transferId: string }

class BalanceEvents extends EventEmitter<{ changed: [BalanceChangedEvent] }> {}

export const balanceEvents = new BalanceEvents();
balanceEvents.setMaxListeners(1_000); // one listener per open WatchBalance stream
```

`src/grpc/ledgerGrpcServer.ts`:

```ts
// src/grpc/ledgerGrpcServer.ts — the ledger service's gRPC side: GetBalance (unary) and WatchBalance (stream).
import * as grpc from "@grpc/grpc-js";
import type { Logger } from "pino";
import type { LedgerServiceHandlers } from "../generated/proto/ledger/v1/LedgerService.js";
import { balanceEvents, type BalanceChangedEvent } from "../events/balanceEvents.js";
import { findBalance } from "../repositories/walletRepository.js";
import { ledgerProto } from "./ledgerProto.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createLedgerHandlers(log: Logger): LedgerServiceHandlers {
  return {
    async GetBalance(call, callback) {
      const requestId = String(call.metadata.get("x-request-id")[0] ?? "none");
      const { walletId } = call.request;
      if (!UUID.test(walletId)) return callback({ code: grpc.status.INVALID_ARGUMENT, details: "wallet_id must be a UUID" });
      try {
        const balance = await findBalance(walletId);
        if (call.cancelled) return; // the caller's deadline passed while we waited; nobody is listening
        if (!balance) return callback({ code: grpc.status.NOT_FOUND, details: "wallet not found" });
        callback(null, {
          walletId,
          balanceMinor: balance.balanceMinor,
          currency: balance.currency,
          asOfUnixMs: String(Date.now()),
          status: balance.status === "frozen" ? "WALLET_STATUS_FROZEN" : "WALLET_STATUS_ACTIVE",
        });
      } catch (err) {
        log.error({ err, requestId, walletId }, "GetBalance failed");
        callback({ code: grpc.status.INTERNAL, details: "internal error" }); // never send SQL to callers
      }
    },

    WatchBalance(call) {
      const { walletId } = call.request;
      const onChange = (e: BalanceChangedEvent) => {
        if (e.walletId === walletId) call.write({ walletId, balanceMinor: e.balanceMinor, transferId: e.transferId });
      };
      balanceEvents.on("changed", onChange);
      // Without this, every closed stream leaves a listener behind: a slow memory leak.
      call.on("cancelled", () => balanceEvents.off("changed", onChange));
    },
  };
}

export async function startGrpcServer(port: number, log: Logger): Promise<grpc.Server> {
  const server = new grpc.Server({ "grpc.keepalive_time_ms": 30_000, "grpc.max_receive_message_length": 1024 * 1024 });
  server.addService(ledgerProto.LedgerService.service, createLedgerHandlers(log));
  // Insecure is for the lab only. In production: mTLS between services, often via a service mesh.
  await new Promise<number>((resolve, reject) =>
    server.bindAsync(`0.0.0.0:${port}`, grpc.ServerCredentials.createInsecure(), (err, p) => (err ? reject(err) : resolve(p))));
  log.info({ port }, "ledger gRPC server listening");
  return server;
}

// Finish in-flight calls, but never hang a deploy: force after 10 seconds.
export function stopGrpcServer(server: grpc.Server): Promise<void> {
  return new Promise((resolve) => {
    const force = setTimeout(() => { server.forceShutdown(); resolve(); }, 10_000);
    server.tryShutdown(() => { clearTimeout(force); resolve(); });
  });
}
```

**What to notice**

- `LedgerServiceHandlers` is generated. Forget a method, misspell a field or return a number where the proto says string, and `tsc` fails.
- gRPC has its own status codes (`INVALID_ARGUMENT`, `NOT_FOUND`, `INTERNAL`, `DEADLINE_EXCEEDED`, `UNAVAILABLE`). Think of them as the gRPC version of HTTP status codes.
- `call.cancelled` lets the server skip work nobody is waiting for. The stream handler removes its listener on cancel; the test checks the listener count goes back to 0.

**1.5 The gateway's client.** `src/gateway/ledgerClient.ts`:

```ts
// src/gateway/ledgerClient.ts — how the gateway calls the ledger service over gRPC.
import * as grpc from "@grpc/grpc-js";
import { env } from "../config/env.js";
import type { GetBalanceResponse__Output } from "../generated/proto/ledger/v1/GetBalanceResponse.js";
import { ledgerProto } from "../grpc/ledgerProto.js";

export class LedgerCallError extends Error {
  constructor(readonly code: grpc.status, details: string) {
    super(`ledger ${grpc.status[code]}: ${details}`);
    this.name = "LedgerCallError";
  }
}

// One client = one HTTP/2 connection, reused and multiplexed for every call from this process.
const client = new ledgerProto.LedgerService(env.LEDGER_GRPC_ADDR, grpc.credentials.createInsecure(), {
  "grpc.keepalive_time_ms": 30_000,
});

function callOnce(walletId: string, deadline: Date, requestId: string): Promise<GetBalanceResponse__Output> {
  const metadata = new grpc.Metadata();
  metadata.set("x-request-id", requestId); // carries the trace across the hop
  return new Promise((resolve, reject) => {
    client.getBalance({ walletId }, metadata, { deadline }, (err, res) => {
      if (err) return reject(new LedgerCallError(err.code, err.details));
      if (!res) return reject(new LedgerCallError(grpc.status.INTERNAL, "empty response"));
      resolve(res);
    });
  });
}

// GetBalance is a read, so retrying UNAVAILABLE (connection refused, server restarting) is safe.
// Never retry after the deadline: the caller has already given up.
export async function getBalance(walletId: string, opts: { deadline: Date; requestId: string }): Promise<GetBalanceResponse__Output> {
  try {
    return await callOnce(walletId, opts.deadline, opts.requestId);
  } catch (err) {
    const retryable = err instanceof LedgerCallError && err.code === grpc.status.UNAVAILABLE;
    if (!retryable || opts.deadline.getTime() - Date.now() < 20) throw err;
    return callOnce(walletId, opts.deadline, opts.requestId);
  }
}

export function closeLedgerClient(): void {
  client.close();
}
```

**What to notice**

- One client per process, created once. Creating a client per request throws away HTTP/2's whole advantage.
- Every call has a deadline. There is no code path without one.
- Only `UNAVAILABLE` is retried, only for a read, and only inside the same deadline. A money-moving RPC would need an idempotency key, exactly like P1-03.

**1.6 The public route.** `src/gateway/balanceRoute.ts` turns gRPC codes into Problem Details:

```ts
// src/gateway/balanceRoute.ts — public REST on the outside, gRPC on the inside, with a deadline.
import * as grpc from "@grpc/grpc-js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ApiError, errors } from "../lib/problem.js";
import { getBalance, LedgerCallError } from "./ledgerClient.js";

const LEDGER_BUDGET_MS = 300; // this route's p99 target is 500 ms; the ledger gets at most 300 of it
const params = z.object({ walletId: z.uuid() });

function toApiError(err: LedgerCallError): ApiError {
  switch (err.code) {
    case grpc.status.NOT_FOUND: return errors.walletNotFound();
    case grpc.status.INVALID_ARGUMENT: return errors.malformed("walletId must be a UUID");
    case grpc.status.DEADLINE_EXCEEDED: return new ApiError(504, "UPSTREAM_TIMEOUT", "Ledger did not answer in time");
    case grpc.status.UNAVAILABLE:
      return new ApiError(503, "UPSTREAM_UNAVAILABLE", "Ledger is unavailable", undefined, { headers: { "retry-after": "1" } });
    default: return new ApiError(502, "UPSTREAM_ERROR", "Ledger call failed");
  }
}

export async function balanceRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { walletId: string } }>("/v1/wallets/:walletId/balance", async (request) => {
    const parsed = params.safeParse(request.params);
    if (!parsed.success) throw errors.malformed("walletId must be a UUID");
    try {
      const balance = await getBalance(parsed.data.walletId, {
        deadline: new Date(Date.now() + LEDGER_BUDGET_MS),
        requestId: request.id,
      });
      return { walletId: balance.walletId, balanceMinor: balance.balanceMinor, currency: balance.currency };
    } catch (err) {
      if (err instanceof LedgerCallError) throw toApiError(err); // gRPC codes never leak to app clients
      throw err;
    }
  });
}
```

**What to notice**

- Outside is REST and Problem Details (P1-03); inside is gRPC. The app never sees `DEADLINE_EXCEEDED`, only a clean `504 UPSTREAM_TIMEOUT`.
- The budget is part of the code, with a comment saying where the number comes from.

**1.7 The ledger process.** `src/ledger/main.ts` runs the gRPC server, plus a REST twin of the same read so the benchmark compares like with like:

```ts
// src/ledger/main.ts — the ledger process: gRPC for services, plus the same read over REST for comparison.
import Fastify from "fastify";
import pino from "pino";
import { env } from "../config/env.js";
import { pool } from "../db/pool.js";
import { startGrpcServer, stopGrpcServer } from "../grpc/ledgerGrpcServer.js";
import { findBalance } from "../repositories/walletRepository.js";

const log = pino({ level: env.LOG_LEVEL });
const grpcServer = await startGrpcServer(env.LEDGER_GRPC_PORT, log);

const http = Fastify({ loggerInstance: log });
http.get<{ Params: { walletId: string } }>("/internal/v1/wallets/:walletId/balance", async (request, reply) => {
  const balance = await findBalance(request.params.walletId);
  if (!balance) return reply.code(404).send({ code: "WALLET_NOT_FOUND" });
  return balance;
});
await http.listen({ port: env.LEDGER_HTTP_PORT, host: "0.0.0.0" });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    log.info({ signal }, "shutting down");
    Promise.all([stopGrpcServer(grpcServer), http.close()])
      .then(() => pool.end())
      .then(() => process.exit(0))
      .catch((err: unknown) => { log.error({ err }, "shutdown failed"); process.exit(1); });
  });
}
```

**1.8 Tests.** `test/grpc.test.ts` checks success, the 404 mapping, the deadline and stream cleanup. **Real output:**

```text
deadline 1 ms -> DEADLINE_EXCEEDED after 3 ms
stream received [ '9990000', '9980000' ] | listeners after cancel: 0
 ✓ test/grpc.test.ts > ledger GetBalance over gRPC > returns the balance with int64 kept as a string 31ms
 ✓ test/grpc.test.ts > ledger GetBalance over gRPC > maps gRPC status codes to Problem Details at the gateway 20ms
 ✓ test/grpc.test.ts > ledger GetBalance over gRPC > fails fast with DEADLINE_EXCEEDED instead of waiting forever 4ms
 ✓ test/grpc.test.ts > ledger GetBalance over gRPC > streams balance changes and cleans up when the caller cancels 206ms
```

**1.9 Compare latency with REST.** `bench/grpc-vs-rest.ts` seeds 200 wallets, starts `src/ledger/main.ts` as a separate process, and times the same balance read both ways: 3,000 calls one at a time, then 10,000 calls with 32 in flight, after a warm-up.

```ts
// bench/grpc-vs-rest.ts — the same GetBalance read over gRPC and over REST, from a separate process.
// Run: DATABASE_URL=... npx tsx bench/grpc-vs-rest.ts   (seeds wallets, starts src/ledger/main.ts as a child)
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import protobuf from "protobufjs";
import { pool } from "../src/db/pool.js";
import { ledgerProto } from "../src/grpc/ledgerProto.js";
import { resetDatabase, seedLedger } from "../test/helpers/db.js";

const HTTP_PORT = 3101, GRPC_PORT = 50151;
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.ceil((p / 100) * xs.length) - 1]!;

await resetDatabase();
const { walletIds } = await seedLedger(200, 0);
await pool.end();

// node --import tsx (not npx): SIGTERM must reach the ledger process itself, not a wrapper.
const ledger = spawn(process.execPath, ["--import", "tsx", "src/ledger/main.ts"], {
  env: { ...process.env, LEDGER_HTTP_PORT: String(HTTP_PORT), LEDGER_GRPC_PORT: String(GRPC_PORT), LOG_LEVEL: "silent" },
  stdio: "inherit",
});
const restUrl = (id: string) => `http://127.0.0.1:${HTTP_PORT}/internal/v1/wallets/${id}/balance`;
for (let i = 0; i < 100; i++) { // wait for the child to listen
  if (await fetch(restUrl(walletIds[0]!)).then((r) => r.ok).catch(() => false)) break;
  await new Promise((r) => setTimeout(r, 200));
}

const client = new ledgerProto.LedgerService(`127.0.0.1:${GRPC_PORT}`, grpc.credentials.createInsecure());
const viaGrpc = (id: string) => new Promise<unknown>((ok, fail) =>
  client.getBalance({ walletId: id }, { deadline: new Date(Date.now() + 1_000) }, (e, r) => (e ? fail(e) : ok(r))));
const viaRest = (id: string) => fetch(restUrl(id), { signal: AbortSignal.timeout(1_000) }).then((r) => r.json());

async function measure(call: (id: string) => Promise<unknown>, total: number, concurrency: number) {
  const samples: number[] = [];
  let next = 0;
  const started = performance.now();
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < total) {
      const id = walletIds[next++ % walletIds.length]!;
      const t = performance.now();
      await call(id);
      samples.push(performance.now() - t);
    }
  }));
  const seconds = (performance.now() - started) / 1000;
  return { p50: pct(samples, 50), p95: pct(samples, 95), p99: pct(samples, 99), rps: total / seconds };
}

await measure(viaGrpc, 500, 8); await measure(viaRest, 500, 8); // warm up JIT, pools and connections
console.log("mode              | proto | p50 ms | p95 ms | p99 ms | req/s");
for (const [label, concurrency, total] of [["sequential (1)", 1, 3000], ["concurrent (32)", 32, 10000]] as const) {
  for (const [proto, call] of [["gRPC", viaGrpc], ["REST", viaRest]] as const) {
    const r = await measure(call, total, concurrency);
    console.log(`${label.padEnd(17)} | ${proto.padEnd(5)} | ${r.p50.toFixed(3).padStart(6)} | ${r.p95.toFixed(3).padStart(6)} | ${r.p99.toFixed(3).padStart(6)} | ${Math.round(r.rps)}`);
  }
}

// Payload size of the same answer in each encoding.
const sample = await viaRest(walletIds[0]!) as Record<string, string>;
const root = protobuf.loadSync(fileURLToPath(new URL("../proto/ledger/v1/ledger.proto", import.meta.url)));
const Response = root.lookupType("ledger.v1.GetBalanceResponse");
const protoBytes = Response.encode(Response.fromObject({ ...sample, asOfUnixMs: String(Date.now()), status: 1 })).finish().length;
console.log(`payload: protobuf ${protoBytes} bytes vs JSON ${Buffer.byteLength(JSON.stringify(sample))} bytes`);

client.close();
ledger.kill("SIGTERM");
```

**Real output** (third run; the first two runs gave the same winners)

```text
mode              | proto | p50 ms | p95 ms | p99 ms | req/s
sequential (1)    | gRPC  |  1.230 |  2.507 |  5.841 | 723
sequential (1)    | REST  |  0.864 |  1.925 |  6.032 | 953
concurrent (32)   | gRPC  |  7.128 | 18.154 | 35.874 | 3671
concurrent (32)   | REST  |  8.876 | 21.930 | 31.005 | 3123
payload: protobuf 57 bytes vs JSON 112 bytes
```

**What to notice**

- One at a time, REST was faster: 1.925 ms vs 2.507 ms at p95. Under 32-way concurrency, gRPC had the better p95 (18.154 vs 21.930 ms) and 17.5% more throughput.
- Everything shares two CPUs here, so the client, both servers and Postgres compete. On separate machines, network time grows and the payload difference starts to matter more.
- A real bug from building this benchmark: the first version started the ledger with `spawn("npx", ["tsx", ...])`. `ledger.kill()` killed `npx` but **not** the Node process under it, which kept the port bound and the pipe open, so the next run failed with `EADDRINUSE`. Spawning `node --import tsx` directly fixed it. Graceful shutdown only works if the signal reaches the right process.

### Step 2: GraphQL "wallet with its last 10 transactions", N+1, then DataLoader

**2.1 Schema.** `src/graphql/typeDefs.ts`:

```ts
// src/graphql/typeDefs.ts — the schema the dashboard BFF exposes.
export const typeDefs = /* GraphQL */ `
  type Query {
    account(id: ID!): Account
    wallet(id: ID!): Wallet
  }

  type Account {
    id: ID!
    displayName: String!
    wallets: [Wallet!]!
  }

  "Money is a string of paise. GraphQL Int is 32-bit: 2,147,483,647 paise is only about 2.15 crore rupees."
  type Wallet {
    id: ID!
    currency: String!
    balanceMinor: String!
    owner: Account!
    transactions(last: Int = 10): [WalletTransaction!]!
  }

  enum Direction {
    DEBIT
    CREDIT
  }

  type WalletTransaction {
    id: ID!
    direction: Direction!
    amountMinor: String!
    createdAt: String!
    counterparty: Account!
  }
`;
```

`src/graphql/rows.ts` holds the row types and the shared "last N transactions" SQL:

```ts
// src/graphql/rows.ts — database row shapes the resolvers receive as `parent`.
export interface AccountRow { id: string; display_name: string }
export interface WalletRow { id: string; account_id: string; currency: string; balance_minor: string }
export interface TxnRow {
  id: string; wallet_id: string; direction: "debit" | "credit"; amount_minor: string;
  created_at: Date; counterparty_wallet_id: string;
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Last N transactions of ONE wallet, with the other side of each transfer.
export const LAST_TXNS_SQL = `
  SELECT wt.id, wt.wallet_id, wt.direction, wt.amount_minor, wt.created_at,
         CASE WHEN tr.source_wallet_id = wt.wallet_id THEN tr.destination_wallet_id
              ELSE tr.source_wallet_id END AS counterparty_wallet_id
  FROM wallet_transactions wt JOIN transfers tr ON tr.id = wt.transfer_id`;
```

**2.2 Log the SQL.** `src/graphql/requestDb.ts` counts every query per request:

```ts
// src/graphql/requestDb.ts — a per-request query wrapper that counts and logs every SQL statement.
import type { FastifyBaseLogger } from "fastify";
import type { QueryResultRow } from "pg";
import { pool } from "../db/pool.js";

export interface RequestDb {
  query<R extends QueryResultRow>(sql: string, params: unknown[]): Promise<R[]>;
  readonly stats: { queries: number };
}

// Each GraphQL request gets its own counter, so N+1 shows up in logs, headers and tests.
export function createRequestDb(log: FastifyBaseLogger): RequestDb {
  const stats = { queries: 0 };
  return {
    stats,
    async query<R extends QueryResultRow>(sql: string, params: unknown[]): Promise<R[]> {
      stats.queries++;
      log.debug({ n: stats.queries, sql: sql.replace(/\s+/g, " ").slice(0, 120) }, "sql");
      return (await pool.query<R>(sql, params)).rows;
    },
  };
}
```

**2.3 Before: naive resolvers.** `src/graphql/naiveResolvers.ts` (kept in the lab only to measure the "before"):

```ts
// src/graphql/naiveResolvers.ts — the BEFORE version: every resolver runs its own query (N+1).
import type { RequestDb } from "./requestDb.js";
import { type AccountRow, LAST_TXNS_SQL, type TxnRow, UUID, type WalletRow } from "./rows.js";

type Ctx = { db: RequestDb };

export const naiveResolvers = {
  Query: {
    account: async (_: unknown, a: { id: string }, { db }: Ctx) =>
      UUID.test(a.id) ? (await db.query<AccountRow>("SELECT id, display_name FROM accounts WHERE id = $1", [a.id]))[0] ?? null : null,
    wallet: async (_: unknown, a: { id: string }, { db }: Ctx) =>
      UUID.test(a.id) ? (await db.query<WalletRow>("SELECT id, account_id, currency, balance_minor FROM wallets WHERE id = $1", [a.id]))[0] ?? null : null,
  },
  Account: {
    displayName: (acc: AccountRow) => acc.display_name,
    wallets: (acc: AccountRow, _: unknown, { db }: Ctx) =>
      db.query<WalletRow>("SELECT id, account_id, currency, balance_minor FROM wallets WHERE account_id = $1 ORDER BY created_at, id", [acc.id]),
  },
  Wallet: {
    currency: (w: WalletRow) => w.currency.trim(),
    balanceMinor: (w: WalletRow) => w.balance_minor,
    owner: async (w: WalletRow, _: unknown, { db }: Ctx) =>
      (await db.query<AccountRow>("SELECT id, display_name FROM accounts WHERE id = $1", [w.account_id]))[0],
    // Runs once PER WALLET: 20 wallets means 20 queries.
    transactions: (w: WalletRow, a: { last: number }, { db }: Ctx) =>
      db.query<TxnRow>(`${LAST_TXNS_SQL} WHERE wt.wallet_id = $1 ORDER BY wt.created_at DESC, wt.id DESC LIMIT $2`, [w.id, a.last]),
  },
  WalletTransaction: {
    direction: (t: TxnRow) => t.direction.toUpperCase(),
    amountMinor: (t: TxnRow) => t.amount_minor,
    createdAt: (t: TxnRow) => t.created_at.toISOString(),
    // Runs once PER TRANSACTION: 20 wallets x 10 transactions means 200 queries.
    counterparty: async (t: TxnRow, _: unknown, { db }: Ctx) =>
      (await db.query<AccountRow>(
        "SELECT a.id, a.display_name FROM wallets w JOIN accounts a ON a.id = w.account_id WHERE w.id = $1",
        [t.counterparty_wallet_id]))[0],
  },
};
```

**2.4 After: loaders.** `src/graphql/loaders.ts`:

```ts
// src/graphql/loaders.ts — the AFTER version: one batched query per kind of data, per request.
import DataLoader from "dataloader";
import type { RequestDb } from "./requestDb.js";
import { type AccountRow, LAST_TXNS_SQL, type TxnRow, type WalletRow } from "./rows.js";

// A batch function MUST return one result per key, in the same order as the keys.
function inKeyOrder<K, R>(keys: readonly K[], rows: R[], keyOf: (row: R) => K): (R | null)[] {
  const byKey = new Map(rows.map((r) => [keyOf(r), r]));
  return keys.map((k) => byKey.get(k) ?? null);
}

function groupedInKeyOrder<K, R>(keys: readonly K[], rows: R[], keyOf: (row: R) => K): R[][] {
  const groups = new Map<K, R[]>(keys.map((k) => [k, []]));
  for (const r of rows) groups.get(keyOf(r))?.push(r);
  return keys.map((k) => groups.get(k) ?? []);
}

export function createLoaders(db: RequestDb) {
  const accountById = new DataLoader<string, AccountRow | null>(async (ids) =>
    inKeyOrder(ids, await db.query<AccountRow>("SELECT id, display_name FROM accounts WHERE id = ANY($1::uuid[])", [ids]), (r) => r.id));

  const accountByWalletId = new DataLoader<string, AccountRow | null>(async (walletIds) => {
    const rows = await db.query<AccountRow & { wallet_id: string }>(
      "SELECT w.id AS wallet_id, a.id, a.display_name FROM wallets w JOIN accounts a ON a.id = w.account_id WHERE w.id = ANY($1::uuid[])",
      [walletIds]);
    return inKeyOrder(walletIds, rows, (r) => r.wallet_id);
  });

  const walletById = new DataLoader<string, WalletRow | null>(async (ids) =>
    inKeyOrder(ids, await db.query<WalletRow>("SELECT id, account_id, currency, balance_minor FROM wallets WHERE id = ANY($1::uuid[])", [ids]), (r) => r.id));

  const walletsByAccountId = new DataLoader<string, WalletRow[]>(async (accountIds) =>
    groupedInKeyOrder(accountIds, await db.query<WalletRow>(
      "SELECT id, account_id, currency, balance_minor FROM wallets WHERE account_id = ANY($1::uuid[]) ORDER BY created_at, id",
      [accountIds]), (r) => r.account_id));

  // "Last N per wallet" for many wallets in ONE query: LATERAL runs the per-wallet LIMIT on the index.
  const lastTxnLoaders = new Map<number, DataLoader<string, TxnRow[]>>();
  const lastTransactions = (last: number): DataLoader<string, TxnRow[]> => {
    let loader = lastTxnLoaders.get(last);
    if (!loader) {
      loader = new DataLoader<string, TxnRow[]>(async (walletIds) =>
        groupedInKeyOrder(walletIds, await db.query<TxnRow>(
          `SELECT t.* FROM unnest($1::uuid[]) AS w(id)
           CROSS JOIN LATERAL (${LAST_TXNS_SQL} WHERE wt.wallet_id = w.id
                               ORDER BY wt.created_at DESC, wt.id DESC LIMIT $2) t`,
          [walletIds, last]), (r) => r.wallet_id));
      lastTxnLoaders.set(last, loader);
    }
    return loader;
  };

  return { accountById, accountByWalletId, walletById, walletsByAccountId, lastTransactions };
}

export type Loaders = ReturnType<typeof createLoaders>;
```

**What to notice**

- `WHERE id = ANY($1::uuid[])` is the batched query. Postgres returns rows in any order, so `inKeyOrder` puts them back in key order. Skipping this step is the most common DataLoader bug: wallet 3 gets wallet 7's data.
- "Last 10 per wallet" cannot be one `LIMIT 10` across all wallets. `CROSS JOIN LATERAL` runs a small per-wallet `LIMIT` for each key, using the `(wallet_id, created_at, id)` index from P1-03.
- One loader per `last` value, so wallets that ask for the same page size share one query.

`src/graphql/resolvers.ts` is the naive file with every lookup replaced by a loader:

```ts
// src/graphql/resolvers.ts — same fields as the naive version, but every lookup goes through a loader.
import type { Loaders } from "./loaders.js";
import type { RequestDb } from "./requestDb.js";
import { type AccountRow, type TxnRow, UUID, type WalletRow } from "./rows.js";

export interface GraphQLContext { db: RequestDb; loaders: Loaders }
type Ctx = GraphQLContext;

const MAX_LAST = 50; // never trust a client-chosen page size

export const resolvers = {
  Query: {
    account: (_: unknown, a: { id: string }, ctx: Ctx) => (UUID.test(a.id) ? ctx.loaders.accountById.load(a.id) : null),
    wallet: (_: unknown, a: { id: string }, ctx: Ctx) => (UUID.test(a.id) ? ctx.loaders.walletById.load(a.id) : null),
  },
  Account: {
    displayName: (acc: AccountRow) => acc.display_name,
    wallets: (acc: AccountRow, _: unknown, ctx: Ctx) => ctx.loaders.walletsByAccountId.load(acc.id),
  },
  Wallet: {
    currency: (w: WalletRow) => w.currency.trim(),
    balanceMinor: (w: WalletRow) => w.balance_minor,
    owner: (w: WalletRow, _: unknown, ctx: Ctx) => ctx.loaders.accountById.load(w.account_id),
    transactions: (w: WalletRow, a: { last: number }, ctx: Ctx) =>
      ctx.loaders.lastTransactions(Math.min(Math.max(a.last, 1), MAX_LAST)).load(w.id),
  },
  WalletTransaction: {
    direction: (t: TxnRow) => t.direction.toUpperCase(),
    amountMinor: (t: TxnRow) => t.amount_minor,
    createdAt: (t: TxnRow) => t.created_at.toISOString(),
    counterparty: (t: TxnRow, _: unknown, ctx: Ctx) => ctx.loaders.accountByWalletId.load(t.counterparty_wallet_id),
  },
};
```

**2.5 Cost limit.** `src/graphql/costLimit.ts`:

```ts
// src/graphql/costLimit.ts — reject expensive queries BEFORE running them.
import { GraphQLError, Kind, type FieldNode, type SelectionSetNode, type ValidationContext, type ValidationRule } from "graphql";

// Worst-case list sizes the server allows. Unknown fields count as 1.
const LIST_SIZE: Record<string, number> = { wallets: 20 };
const DEFAULT_LAST = 10;
const MAX_LAST = 50;

function multiplier(field: FieldNode): number {
  if (field.name.value !== "transactions") return LIST_SIZE[field.name.value] ?? 1;
  const last = field.arguments?.find((a) => a.name.value === "last")?.value;
  if (!last) return DEFAULT_LAST;
  // A variable's value is unknown during validation, so assume the maximum the resolver allows.
  return last.kind === Kind.INT ? Math.min(Number(last.value), MAX_LAST) : MAX_LAST;
}

// Cost = every field resolved, multiplied by how many times its parent list repeats it.
function costOf(set: SelectionSetNode | undefined, ctx: ValidationContext, seenFragments: Set<string>): number {
  if (!set) return 0;
  let total = 0;
  for (const sel of set.selections) {
    if (sel.kind === Kind.FIELD) total += multiplier(sel) * (1 + costOf(sel.selectionSet, ctx, seenFragments));
    else if (sel.kind === Kind.INLINE_FRAGMENT) total += costOf(sel.selectionSet, ctx, seenFragments);
    else if (!seenFragments.has(sel.name.value)) {
      // Cyclic fragments are rejected by another rule; this guard just stops infinite recursion here.
      total += costOf(ctx.getFragment(sel.name.value)?.selectionSet, ctx, new Set(seenFragments).add(sel.name.value));
    }
  }
  return total;
}

export function maxCostRule(maxCost: number): ValidationRule {
  return (ctx) => ({
    OperationDefinition(node) {
      const cost = costOf(node.selectionSet, ctx, new Set());
      if (cost > maxCost) {
        ctx.reportError(new GraphQLError(`Query cost ${cost} exceeds the limit of ${maxCost}`, {
          nodes: [node],
          extensions: { code: "QUERY_TOO_EXPENSIVE", cost, maxCost },
        }));
      }
    },
  });
}
```

**What to notice**

- It runs during **validation**, before any resolver. A rejected query costs a parse and a walk, not a database.
- Variables are unknown at validation time, so `last: $n` is costed at the maximum the resolver allows (50).
- The fragment guard stops infinite recursion on a malicious cyclic fragment.

**2.6 Serve it.** `src/graphql/server.ts` mounts GraphQL Yoga on Fastify:

```ts
// src/graphql/server.ts — GraphQL Yoga on Fastify: fresh loaders per request, a cost limit, SQL counts.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createSchema, createYoga, type Plugin } from "graphql-yoga";
import { maxCostRule } from "./costLimit.js";
import { createLoaders } from "./loaders.js";
import { createRequestDb, type RequestDb } from "./requestDb.js";
import { type GraphQLContext, resolvers } from "./resolvers.js";
import { typeDefs } from "./typeDefs.js";

const MAX_QUERY_COST = 1_000;

type ServerContext = { req: FastifyRequest; reply: FastifyReply; db: RequestDb };
type SchemaResolvers = NonNullable<Parameters<typeof createSchema<ServerContext & GraphQLContext>>[0]["resolvers"]>;

const costLimit: Plugin = {
  onValidate: ({ addValidationRule }) => addValidationRule(maxCostRule(MAX_QUERY_COST)),
};

export async function graphqlRoutes(app: FastifyInstance, opts: { resolvers?: SchemaResolvers } = {}): Promise<void> {
  const yoga = createYoga<ServerContext, GraphQLContext>({
    schema: createSchema<ServerContext & GraphQLContext>({ typeDefs, resolvers: opts.resolvers ?? resolvers }),
    // New loaders for EVERY request: a shared DataLoader cache would leak one user's data to another.
    context: ({ db }) => ({ db, loaders: createLoaders(db) }),
    plugins: [costLimit],
    graphiql: process.env.NODE_ENV !== "production",
    logging: false, // we log through Fastify's pino below
  });

  app.route({
    url: yoga.graphqlEndpoint, // "/graphql"
    method: ["GET", "POST", "OPTIONS"],
    handler: async (req, reply) => {
      const db = createRequestDb(req.log);
      const response = await yoga.handleNodeRequestAndResponse(req, reply, { req, reply, db });
      req.log.info({ sqlQueries: db.stats.queries }, "graphql request");
      response.headers.forEach((value, key) => reply.header(key, value));
      reply.header("x-sql-queries", String(db.stats.queries)); // lab and staging only
      return reply.status(response.status).send(response.body);
    },
  });
}
```

**What to notice**

- `context` builds loaders per request. This one line is what makes DataLoader both fast and safe.
- The `resolvers` option exists only so the lab can mount the naive version for the "before" number.
- The SQL count goes to the log for every request and into a header in the lab, so you can watch it with `curl -i`.

**2.7 Measure.** `test/graphql.test.ts` runs the same queries against both servers and compares results:

```ts
// test/graphql.test.ts — SQL query counts before and after DataLoader, and the cost limit.
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../src/db/pool.js";
import { naiveResolvers } from "../src/graphql/naiveResolvers.js";
import { graphqlRoutes } from "../src/graphql/server.js";
import { resetDatabase, seedLedger } from "./helpers/db.js";

let naive: FastifyInstance, batched: FastifyInstance, seed: { accountId: string; walletIds: string[] };

const run = async (app: FastifyInstance, query: string) => {
  const res = await app.inject({ method: "POST", url: "/graphql", payload: { query } });
  return { body: res.json(), queries: Number(res.headers["x-sql-queries"]) };
};

beforeAll(async () => {
  await resetDatabase();
  seed = await seedLedger(20, 15);
  naive = Fastify();
  await naive.register(graphqlRoutes, { resolvers: naiveResolvers });
  batched = Fastify();
  await batched.register(graphqlRoutes);
});
afterAll(async () => { await naive.close(); await batched.close(); await pool.end(); });

describe("GraphQL N+1", () => {
  it("one wallet with its last 10 transactions", async () => {
    const q = `{ wallet(id: "${seed.walletIds[0]}") { id balanceMinor
      transactions(last: 10) { amountMinor direction counterparty { displayName } } } }`;
    const before = await run(naive, q), after = await run(batched, q);
    console.log(`wallet + last 10 txns: before ${before.queries} queries, after ${after.queries} queries`);
    expect(after.body).toEqual(before.body);
    expect(after.queries).toBe(3);
  });

  it("an account with 20 wallets, each with its last 10 transactions", async () => {
    const q = `{ account(id: "${seed.accountId}") { displayName
      wallets { id transactions(last: 10) { amountMinor counterparty { displayName } } } } }`;
    const before = await run(naive, q), after = await run(batched, q);
    console.log(`account + 20 wallets x 10 txns: before ${before.queries} queries, after ${after.queries} queries`);
    expect(after.body).toEqual(before.body);
    expect(after.queries).toBe(4);
  });
});

describe("query cost limit", () => {
  it("rejects a deeply nested query before touching the database", async () => {
    const evil = `{ account(id: "${seed.accountId}") { wallets { transactions(last: 50) { counterparty {
      wallets { transactions(last: 50) { counterparty { displayName } } } } } } } }`;
    const res = await run(batched, evil);
    console.log("evil query ->", res.body.errors[0].message, "| SQL queries:", res.queries);
    expect(res.body.errors[0].extensions.code).toBe("QUERY_TOO_EXPENSIVE");
    expect(res.queries).toBe(0);
  });
});
```

**Real output**

```text
wallet + last 10 txns: before 12 queries, after 3 queries
account + 20 wallets x 10 txns: before 222 queries, after 4 queries
evil query -> Query cost 3022021 exceeds the limit of 1000 | SQL queries: 0
 ✓ test/graphql.test.ts > GraphQL N+1 > one wallet with its last 10 transactions 89ms
 ✓ test/graphql.test.ts > GraphQL N+1 > an account with 20 wallets, each with its last 10 transactions 91ms
 ✓ test/graphql.test.ts > query cost limit > rejects a deeply nested query before touching the database 5ms
```

**What to notice**

- The card's query (one wallet, last 10 transactions, counterparties): **12 → 3**. 1 wallet + 1 transactions + 10 counterparty lookups became 1 + 1 + 1.
- The dashboard query: **222 → 4**, with byte-for-byte identical JSON.
- The nested attack was stopped at a computed cost of 3,022,021 with zero SQL.

### Step 3: Signed "transfer completed" webhooks with retries and an idempotent receiver

**3.1 Tables.** `src/db/migrations/002_webhooks.sql`:

```sql
-- src/db/migrations/002_webhooks.sql — outbound webhooks: endpoints, events, deliveries and the delivery log.
CREATE TABLE webhook_endpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id text NOT NULL,
  url text NOT NULL,
  secret text NOT NULL,                        -- whsec_...; encrypt at rest (KMS) in production
  event_types text[] NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE webhook_events (
  id text PRIMARY KEY,                         -- evt_<uuid>; the receiver's idempotency key
  type text NOT NULL,
  body text NOT NULL,                          -- the exact bytes we sign and send, never re-serialised
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE webhook_deliveries (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id text NOT NULL REFERENCES webhook_events(id),
  endpoint_id uuid NOT NULL REFERENCES webhook_endpoints(id),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'succeeded', 'dead')),
  attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),  -- the retry schedule is measured from here
  delivered_at timestamptz,
  UNIQUE (event_id, endpoint_id)
);
CREATE INDEX webhook_deliveries_due_idx ON webhook_deliveries (next_attempt_at) WHERE status = 'pending';

-- The delivery log: one row per HTTP attempt. Support and partners debug from this table.
CREATE TABLE webhook_delivery_attempts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  delivery_id bigint NOT NULL REFERENCES webhook_deliveries(id),
  attempt_no integer NOT NULL,
  started_at timestamptz NOT NULL,
  duration_ms integer NOT NULL,
  status_code integer,                         -- NULL when there was no response (timeout, refused)
  error text,
  response_snippet text
);

-- Partner side, shown for the lab: the receiver's inbox, keyed by event id. Lives in THEIR database.
CREATE TABLE received_webhooks (
  event_id text PRIMARY KEY,
  payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);
```

**What to notice**

- The event `body` is stored as **text**, exactly as signed. Re-serialising JSON on each retry could change bytes and break signatures.
- A partial index (`WHERE status = 'pending'`) keeps the "what is due?" query fast even after millions of delivered rows.
- One delivery per event per endpoint (`UNIQUE (event_id, endpoint_id)`), so the same event cannot be queued twice for one partner.

**3.2 Signing and verifying.** `src/webhooks/signature.ts`:

```ts
// src/webhooks/signature.ts — Standard Webhooks style signing (sender) and verification (receiver).
import { createHmac, timingSafeEqual } from "node:crypto";

const TOLERANCE_SECONDS = 5 * 60;

function secretBytes(secret: string): Buffer {
  if (!secret.startsWith("whsec_")) throw new Error("webhook secret must start with whsec_");
  return Buffer.from(secret.slice("whsec_".length), "base64");
}

// Sign "id.timestamp.body": changing any one of the three breaks the signature.
export function signWebhook(secret: string, id: string, timestamp: number, body: string): string {
  return "v1," + createHmac("sha256", secretBytes(secret)).update(`${id}.${timestamp}.${body}`).digest("base64");
}

export interface WebhookHeaders { id: string | undefined; timestamp: string | undefined; signature: string | undefined }
export type VerifyResult = { ok: true; id: string } | { ok: false; reason: "missing_headers" | "stale_timestamp" | "bad_signature" };

// `secrets` holds the current secret and, during rotation, the previous one.
export function verifyWebhook(secrets: string[], h: WebhookHeaders, rawBody: string, nowSeconds = Math.floor(Date.now() / 1000)): VerifyResult {
  if (!h.id || !h.timestamp || !h.signature) return { ok: false, reason: "missing_headers" };
  const ts = Number(h.timestamp);
  // A valid signature on an old message is a replay. The timestamp is inside the signature, so it cannot be edited.
  if (!Number.isInteger(ts) || Math.abs(nowSeconds - ts) > TOLERANCE_SECONDS) return { ok: false, reason: "stale_timestamp" };

  const received = h.signature.split(" ").map((s) => Buffer.from(s)); // several signatures during secret rotation
  for (const secret of secrets) {
    const expected = Buffer.from(signWebhook(secret, h.id, ts, rawBody));
    // timingSafeEqual takes the same time however many bytes match; it throws on unequal lengths.
    if (received.some((r) => r.length === expected.length && timingSafeEqual(r, expected))) return { ok: true, id: h.id };
  }
  return { ok: false, reason: "bad_signature" };
}
```

**3.3 Enqueue in the transfer's transaction.** `src/webhooks/enqueue.ts`:

```ts
// src/webhooks/enqueue.ts — record a webhook in the SAME transaction as the business change (outbox).
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";

export interface WebhookEvent<T> { type: string; data: T }

// Transfer rolls back -> no webhook exists. Transfer commits -> the webhook is guaranteed to be sent.
// Calling the partner's URL directly inside the transfer would give neither guarantee.
export async function enqueueWebhookEvent<T>(client: PoolClient, event: WebhookEvent<T>): Promise<string> {
  const id = `evt_${randomUUID()}`;
  const body = JSON.stringify({ id, type: event.type, createdAt: new Date().toISOString(), data: event.data });
  await client.query("INSERT INTO webhook_events (id, type, body) VALUES ($1, $2, $3)", [id, event.type, body]);
  await client.query(
    `INSERT INTO webhook_deliveries (event_id, endpoint_id)
     SELECT $1, id FROM webhook_endpoints WHERE status = 'active' AND $2 = ANY(event_types)`,
    [id, event.type],
  );
  return id;
}
```

In P1-03's `transferService`, one line inside `executeTransfer`, after `applyTransfer`, wires it in: `await enqueueWebhookEvent(client, { type: "transfer.completed", data: transfer })`. Because it uses the same `client`, it is in the same transaction as the money movement and the idempotency key.

**3.4 Retry policy.** `src/webhooks/retryPolicy.ts`:

```ts
// src/webhooks/retryPolicy.ts — what a response means, and when to try again.

// Standard Webhooks' suggested schedule, as offsets from the FIRST attempt:
// now, 5 s, 5 min, 30 min, 2 h, 5 h, 10 h, 14 h, 20 h, 24 h.
export const DEFAULT_SCHEDULE_MS = [
  0, 5_000, 300_000, 1_800_000, 7_200_000, 18_000_000, 36_000_000, 50_400_000, 72_000_000, 86_400_000,
];

export type Outcome =
  | { kind: "success" }
  | { kind: "retry"; retryAfterMs?: number }
  | { kind: "disable_endpoint" };

export function classify(statusCode: number | null, retryAfterHeader: string | null): Outcome {
  if (statusCode !== null && statusCode >= 200 && statusCode < 300) return { kind: "success" };
  if (statusCode === 410) return { kind: "disable_endpoint" }; // the partner says this URL is gone for good
  // Everything else (3xx, 4xx, 5xx, timeout, connection refused) is a failure worth retrying.
  const seconds = Number(retryAfterHeader);
  return Number.isFinite(seconds) && seconds > 0 ? { kind: "retry", retryAfterMs: seconds * 1000 } : { kind: "retry" };
}

// Returns null when the schedule is used up: the delivery is dead and a human must look.
export function nextAttemptAt(firstAttemptAt: Date, attemptsDone: number, schedule: number[], retryAfterMs?: number): Date | null {
  const offset = schedule[attemptsDone];
  if (offset === undefined) return null;
  const jitter = offset * (Math.random() * 0.2 - 0.1); // ±10%: after an outage, retries do not arrive in one wave
  const planned = firstAttemptAt.getTime() + offset + jitter;
  return new Date(Math.max(planned, Date.now() + (retryAfterMs ?? 0)));
}
```

**3.5 The delivery log.** `src/webhooks/deliveryLog.ts`:

```ts
// src/webhooks/deliveryLog.ts — write the attempt row and the delivery's new state in one transaction.
import type { Logger } from "pino";
import { pool } from "../db/pool.js";
import { nextAttemptAt, type Outcome } from "./retryPolicy.js";

export interface AttemptRecord {
  deliveryId: string; endpointId: string; eventId: string; attemptNo: number; firstAttemptAt: Date;
  startedAt: Date; durationMs: number; statusCode: number | null; error: string | null; snippet: string | null;
}

export async function recordAttempt(a: AttemptRecord, outcome: Outcome, schedule: number[], maxAttempts: number, log: Logger): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO webhook_delivery_attempts (delivery_id, attempt_no, started_at, duration_ms, status_code, error, response_snippet)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [a.deliveryId, a.attemptNo, a.startedAt, a.durationMs, a.statusCode, a.error, a.snippet]);

    const next = outcome.kind === "retry" && a.attemptNo < maxAttempts
      ? nextAttemptAt(a.firstAttemptAt, a.attemptNo, schedule, outcome.retryAfterMs)
      : null;
    if (outcome.kind === "success") {
      await client.query("UPDATE webhook_deliveries SET status = 'succeeded', attempt_count = $2, delivered_at = now() WHERE id = $1", [a.deliveryId, a.attemptNo]);
    } else if (next) {
      await client.query("UPDATE webhook_deliveries SET attempt_count = $2, next_attempt_at = $3 WHERE id = $1", [a.deliveryId, a.attemptNo, next]);
    } else {
      await client.query("UPDATE webhook_deliveries SET status = 'dead', attempt_count = $2 WHERE id = $1", [a.deliveryId, a.attemptNo]);
      if (outcome.kind === "disable_endpoint") await client.query("UPDATE webhook_endpoints SET status = 'disabled' WHERE id = $1", [a.endpointId]);
      // Dead deliveries are an alert, not a log line nobody reads: the partner must be told.
      log.warn({ eventId: a.eventId, endpointId: a.endpointId, attempts: a.attemptNo }, "webhook delivery dead");
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch((e: unknown) => log.error({ err: e }, "rollback failed"));
    throw err;
  } finally {
    client.release();
  }
}
```

**3.6 The worker.** `src/webhooks/deliveryWorker.ts`:

```ts
// src/webhooks/deliveryWorker.ts — claims due deliveries, POSTs signed webhooks, logs every attempt.
import { setTimeout as sleep } from "node:timers/promises";
import type { Logger } from "pino";
import { env } from "../config/env.js";
import { pool } from "../db/pool.js";
import { recordAttempt } from "./deliveryLog.js";
import { classify, DEFAULT_SCHEDULE_MS } from "./retryPolicy.js";
import { signWebhook } from "./signature.js";

interface DueDelivery {
  id: string; event_id: string; endpoint_id: string; attempt_count: number;
  created_at: Date; body: string; url: string; secret: string;
}

export interface WorkerOptions { batchSize?: number; leaseSeconds?: number; scheduleMs?: number[]; timeoutMs?: number; maxAttempts?: number }

export class WebhookDeliveryWorker {
  private stopped = false;
  constructor(private readonly log: Logger, private readonly opts: WorkerOptions = {}) {}

  // Claiming pushes next_attempt_at forward by a lease. If this worker dies mid-send, the delivery
  // simply becomes due again. SKIP LOCKED lets many workers share the table without double-sending.
  private async claim(): Promise<DueDelivery[]> {
    const { rows } = await pool.query<DueDelivery>(
      `WITH due AS (
         SELECT id FROM webhook_deliveries
         WHERE status = 'pending' AND next_attempt_at <= now()
         ORDER BY next_attempt_at LIMIT $1
         FOR UPDATE SKIP LOCKED)
       UPDATE webhook_deliveries d SET next_attempt_at = now() + make_interval(secs => $2)
       FROM due, webhook_events e, webhook_endpoints ep
       WHERE d.id = due.id AND e.id = d.event_id AND ep.id = d.endpoint_id AND ep.status = 'active'
       RETURNING d.id, d.event_id, d.endpoint_id, d.attempt_count, d.created_at, e.body, ep.url, ep.secret`,
      [this.opts.batchSize ?? 20, this.opts.leaseSeconds ?? 60]);
    return rows;
  }

  private async send(d: DueDelivery): Promise<void> {
    const timestamp = Math.floor(Date.now() / 1000); // fresh per attempt, and covered by the signature
    const startedAt = new Date();
    let statusCode: number | null = null, retryAfter: string | null = null, error: string | null = null, snippet: string | null = null;
    try {
      const res = await fetch(d.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "webhook-id": d.event_id, // identical on every retry: the receiver dedupes on it
          "webhook-timestamp": String(timestamp),
          "webhook-signature": signWebhook(d.secret, d.event_id, timestamp, d.body),
        },
        body: d.body,
        redirect: "manual", // a 3xx counts as a failure; never follow a redirect with a signed payload
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? env.WEBHOOK_TIMEOUT_MS),
      });
      statusCode = res.status;
      retryAfter = res.headers.get("retry-after");
      snippet = (await res.text()).slice(0, 500);
    } catch (err) {
      error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    }
    const attempt = {
      deliveryId: d.id, endpointId: d.endpoint_id, eventId: d.event_id, attemptNo: d.attempt_count + 1,
      firstAttemptAt: d.created_at, startedAt, durationMs: Date.now() - startedAt.getTime(), statusCode, error, snippet,
    };
    await recordAttempt(attempt, classify(statusCode, retryAfter), this.opts.scheduleMs ?? DEFAULT_SCHEDULE_MS,
      this.opts.maxAttempts ?? env.WEBHOOK_MAX_ATTEMPTS, this.log);
    this.log.info({ eventId: d.event_id, attemptNo: attempt.attemptNo, statusCode, error, durationMs: attempt.durationMs }, "webhook attempt");
  }

  async runOnce(): Promise<number> {
    const due = await this.claim();
    await Promise.all(due.map((d) => this.send(d)));
    return due.length;
  }

  async start(pollMs = 1_000): Promise<void> {
    while (!this.stopped) {
      const sent = await this.runOnce().catch((err: unknown) => { this.log.error({ err }, "webhook worker tick failed"); return 0; });
      if (sent === 0) await sleep(pollMs);
    }
  }

  stop(): void { this.stopped = true; } // the current tick finishes; graceful shutdown awaits start()
}
```

**What to notice**

- **Claim with a lease.** The `UPDATE ... FROM due` pushes `next_attempt_at` 60 seconds ahead while sending. No separate "sending" status, no sweeper: a crashed worker's delivery is simply due again later.
- **Same ID, fresh timestamp.** `webhook-id` never changes across retries (dedupe); the timestamp and signature are new each time (replay window).
- **Timeout on every call** (`AbortSignal.timeout`), `redirect: "manual"`, and only the first 500 characters of the response kept.
- **Every attempt is logged** in the same transaction that schedules the next one.

**3.7 The partner's receiver.** `src/partner/receiver.ts`:

```ts
// src/partner/receiver.ts — what a partner runs to receive our webhooks (shown so you can test both ends).
import Fastify, { type FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { verifyWebhook } from "../webhooks/signature.js";

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export function buildReceiver(opts: { secrets: string[]; db: Pool }): FastifyInstance {
  const app = Fastify({ bodyLimit: 256 * 1024 });
  // Keep the RAW body: the signature covers exact bytes; JSON.parse then stringify can change them.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => done(null, body));

  app.post("/webhooks/ledger", async (request, reply) => {
    const raw = typeof request.body === "string" ? request.body : "";
    const result = verifyWebhook(opts.secrets, {
      id: one(request.headers["webhook-id"]),
      timestamp: one(request.headers["webhook-timestamp"]),
      signature: one(request.headers["webhook-signature"]),
    }, raw);
    if (!result.ok) return reply.code(400).send({ error: result.reason });

    // Dedupe and enqueue in ONE statement: the event id is the primary key of the inbox.
    // A worker processes the inbox later; the HTTP handler stays fast so the sender never times out.
    const { rowCount } = await opts.db.query(
      "INSERT INTO received_webhooks (event_id, payload) VALUES ($1, $2) ON CONFLICT (event_id) DO NOTHING",
      [result.id, raw]);
    return reply.code(200).send({ received: true, duplicate: rowCount === 0 });
  });
  return app;
}
```

**What to notice**

- The raw-body parser is the line people forget. Without it, verification fails on perfectly valid webhooks.
- Dedupe and "enqueue for processing" are **one** insert. There is no gap where the event is marked seen but the work is lost.
- The handler does no business work. It answers in milliseconds, so the sender's timeout is never hit by slow processing.

**3.8 Tests with fault injection.** `test/webhooks.test.ts` starts a real HTTP receiver, injects faults on the partner side, and runs the worker with the real schedule scaled from hours to milliseconds. The key tests (excerpt; setup helpers omitted):

```ts
// test/webhooks.test.ts (excerpt) — the setup starts buildReceiver() on a random port with fault hooks.
it("retries a receiver that is down, then delivers once", async () => {
  faults.failFirst = 2;
  await sendOneEvent();
  const r = await deliverUntilDone(new WebhookDeliveryWorker(log, { scheduleMs: fastSchedule, timeoutMs: 500 }));
  expect(r.status).toBe("succeeded");
  expect(r.attempts.map((a) => a.status_code)).toEqual([503, 503, 200]);
  expect(await inbox()).toBe(1);
});

it("a lost 200 causes a retry, and the receiver ignores the duplicate", async () => {
  faults.slowFirstSuccessMs = 600; // the receiver processes, then answers after the worker's 300 ms timeout
  await sendOneEvent();
  const r = await deliverUntilDone(new WebhookDeliveryWorker(log, { scheduleMs: fastSchedule, timeoutMs: 300 }));
  expect(r.attempts).toHaveLength(2);
  expect(r.attempts[1]?.response_snippet).toContain('"duplicate":true');
  expect(await inbox()).toBe(1);
});
// ... plus: dead after max attempts, endpoint disabled on 410, tampered body and replayed timestamp rejected
```

**Real output**

```text
receiver down twice -> succeeded [ 503, 503, 200 ]
lost 200 -> [ 'TimeoutError', 200 ] | 2nd reply: {"received":true,"duplicate":true}
always 500 -> dead after 4 attempts
tampered -> 400 {"error":"bad_signature"} | replayed -> 400 {"error":"stale_timestamp"}
 ✓ test/webhooks.test.ts > webhook delivery > retries a receiver that is down, then delivers once 309ms
 ✓ test/webhooks.test.ts > webhook delivery > a lost 200 causes a retry, and the receiver ignores the duplicate 385ms
 ✓ test/webhooks.test.ts > webhook delivery > marks the delivery dead after the last attempt 220ms
 ✓ test/webhooks.test.ts > webhook delivery > disables the endpoint on 410 Gone 62ms
 ✓ test/webhooks.test.ts > webhook delivery > rejects a tampered body and a replayed timestamp 63ms
```

**What to notice**

- **Attempts per event:** 3 when the receiver was down twice; 2 when the first `200` was lost. **Duplicates safely ignored:** 1, proven by `"duplicate":true` and exactly one inbox row.
- `always 500` ended `dead` after 4 attempts (the test caps attempts at 4), which in production triggers an alert.
- Forged and replayed requests never reach the inbox.

### Step 4 (bonus): tRPC for the ops dashboard

The card lists tRPC as a Learn-inside item but not as a lab step, so this is short and only type-checked.

`src/trpc/opsRouter.ts`:

```ts
// src/trpc/opsRouter.ts — tRPC for the internal ops dashboard (our Next.js app, our team, one repo).
import { initTRPC, TRPCError } from "@trpc/server";
import { z } from "zod";
import { findBalance } from "../repositories/walletRepository.js";

export interface OpsContext { staffId: string | null; requestId: string }

const t = initTRPC.context<OpsContext>().create();

// Every ops procedure needs a signed-in staff member (session checks come in P1-05).
const staffProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.staffId) throw new TRPCError({ code: "UNAUTHORIZED" });
  return next({ ctx: { ...ctx, staffId: ctx.staffId } });
});

export const opsRouter = t.router({
  walletBalance: staffProcedure
    .input(z.object({ walletId: z.uuid() }))
    .query(async ({ input }) => {
      const balance = await findBalance(input.walletId);
      if (!balance) throw new TRPCError({ code: "NOT_FOUND", message: "Wallet not found" });
      return balance;
    }),
});

// The dashboard imports this TYPE only. No schema file, no codegen, no runtime code shared.
export type OpsRouter = typeof opsRouter;
export const createOpsCaller = t.createCallerFactory(opsRouter);
```

`src/trpc/mount.ts`:

```ts
// src/trpc/mount.ts — serve the ops router from the same Fastify app, under /trpc.
import { fastifyTRPCPlugin, type FastifyTRPCPluginOptions } from "@trpc/server/adapters/fastify";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { type OpsContext, type OpsRouter, opsRouter } from "./opsRouter.js";

// Stand-in until P1-05: a real app verifies a session cookie or token here.
function staffIdFrom(req: FastifyRequest): string | null {
  const header = req.headers["x-staff-id"];
  return typeof header === "string" ? header : null;
}

export async function mountOpsTrpc(app: FastifyInstance): Promise<void> {
  const trpcOptions: FastifyTRPCPluginOptions<OpsRouter>["trpcOptions"] = {
    router: opsRouter,
    createContext: ({ req }): OpsContext => ({ staffId: staffIdFrom(req), requestId: req.id }),
    onError: ({ error, path }) => app.log.error({ err: error, path }, "trpc error"),
  };
  await app.register(fastifyTRPCPlugin, { prefix: "/trpc", trpcOptions });
}
```

`src/trpc/dashboardClient.ts` (what the Next.js dashboard writes):

```ts
// src/trpc/dashboardClient.ts — what the Next.js ops dashboard writes. Types flow from the router.
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import type { OpsRouter } from "./opsRouter.js";

export const ops = createTRPCClient<OpsRouter>({
  links: [httpBatchLink({ url: "http://localhost:3000/trpc", headers: () => ({ "x-staff-id": "staff_42" }) })],
});

export async function showBalance(walletId: string): Promise<string> {
  const balance = await ops.walletBalance.query({ walletId }); // input and output fully typed
  return `${balance.currency} ${(Number(balance.balanceMinor) / 100).toFixed(2)}`;
}
```

**What to notice**

- `import type { OpsRouter }` brings no server code into the browser bundle; only types.
- `httpBatchLink` batches several procedure calls made together into one HTTP request.
- The middleware (`staffProcedure`) is where auth goes for every ops procedure. P1-05 replaces the header stand-in.

---

## 🔨 Break it and measure it

Do these on your machine. Each one turns a rule from this card into a failure you have seen.

1. **Reuse a protobuf field number.** In `ledger.proto`, delete `currency = 3` and add `string branch_code = 3;`. Regenerate, deploy only the server, and call it from an old client. *Expected:* the old client shows the branch code as the currency. No error.
2. **Remove the deadline.** Call `getBalance` with `deadline: new Date(Date.now() + 3_600_000)` and add `await new Promise((r) => setTimeout(r, 10_000))` in the server handler. *Expected:* the gateway request hangs 10 seconds instead of returning 504 at 300 ms.
3. **Create a gRPC client per request.** Move `new ledgerProto.LedgerService(...)` inside `getBalance` and rerun the benchmark. *Expected:* latency and throughput get much worse (a new HTTP/2 connection per call).
4. **Share one DataLoader across requests.** Create loaders once at module level instead of in `context`. Query wallet A as user 1, change its balance in SQL, query again as user 2. *Expected:* user 2 sees the old cached balance. That is a correctness bug, and with real auth, a data leak.
5. **Forget key order in a batch function.** Return rows straight from SQL without `inKeyOrder`. *Expected:* some wallets show another wallet's transactions; the before/after equality test fails.
6. **Compare signatures with `===`.** Replace `timingSafeEqual` and confirm tests still pass. *Lesson:* tests do not catch timing leaks; code review must.
7. **Parse the body before verifying.** Remove the raw-body content-type parser in `receiver.ts`. *Expected:* valid webhooks fail with `bad_signature` whenever Fastify's re-serialisation differs from the sent bytes.
8. **Drop the receiver's dedupe.** Replace `ON CONFLICT DO NOTHING` with a plain `INSERT` and rerun the lost-200 test. *Expected:* every retry hits a primary-key error and gets a 500, the sender retries until its schedule runs out, and the delivery ends `dead` even though the event was processed on the first try.

**Measurements**

| Measure (from the card) | This guide's run (**Real output**) | Your machine |
|---|---|---|
| p95 latency, gRPC vs REST, same call, one at a time | gRPC 2.507 ms vs REST 1.925 ms | fill after running the lab on your machine |
| p95 latency, gRPC vs REST, 32 in flight | gRPC 18.154 ms vs REST 21.930 ms | fill after running the lab on your machine |
| Throughput, 32 in flight | gRPC 3,671 req/s vs REST 3,123 req/s | fill after running the lab on your machine |
| Payload of the same balance response | protobuf 57 bytes vs JSON 112 bytes | fill after running the lab on your machine |
| SQL queries, one wallet + last 10 transactions, before → after DataLoader | 12 → 3 | fill after running the lab on your machine |
| SQL queries, account + 20 wallets x 10 transactions, before → after | 222 → 4 | fill after running the lab on your machine |
| Webhook attempts per event, receiver down twice | 3 (503, 503, 200) | fill after running the lab on your machine |
| Webhook attempts per event, first 200 lost | 2 (timeout, 200) | fill after running the lab on your machine |
| Duplicates safely ignored | 1 duplicate, 1 inbox row | fill after running the lab on your machine |

---

## 🚫 Common mistakes and wrong mental models

### Wrong mental model: "GraphQL is faster than REST"

GraphQL does not make data arrive faster. It **moves work to the server**: the server now plans, resolves and stitches every shape a client asks for. It saves round trips for the client, but without batching it multiplies database queries (222 for one request in this guide), and without cost limits one request can ask for millions of objects (3,022,021 by our cost rule). It also loses easy HTTP caching.

**Correct model:** GraphQL is a **flexibility** tool. It is faster for the *client* when it replaces many round trips, and only if the *server* batches (DataLoader), limits cost and caches deliberately.

### Wrong mental model: "gRPC is always faster than REST"

Not for a single small call on a fast network: in this guide's benchmark REST had the lower p95 for one-at-a-time calls (1.925 vs 2.507 ms). gRPC won under concurrency and on payload size. Choose gRPC for the contract, streaming, deadlines and connection reuse, then measure.

### Mistake 1: comparing HMAC signatures with `===`

```ts
// Beginner way: string equality stops at the first wrong character.
const expected = sign(id, timestamp, rawBody);
if (expected === request.headers["webhook-signature"]) acceptEvent();
```

```ts
// Product way: constant-time comparison, after a length check (timingSafeEqual throws on unequal lengths).
const expected = Buffer.from(sign(id, timestamp, rawBody));
const received = Buffer.from(String(request.headers["webhook-signature"] ?? ""));
if (received.length === expected.length && timingSafeEqual(received, expected)) acceptEvent();
```

**What breaks in the beginner way:** the time to reject depends on how many leading characters match. Over many attempts, an attacker can learn a valid signature byte by byte. Tests still pass, which is why it survives code review unless someone knows to look.

### Mistake 2: reusing or renumbering protobuf field numbers

```proto
// Beginner way: "amount_minor is now cents of fee; we moved amount to 5". Field 2 is reused.
message TransferCompleted {
  string transfer_id = 1;
  int64 fee_minor = 2;
  string currency = 3;
  int64 amount_minor = 5;
}
```

```proto
// Product way: keep existing numbers forever; add new fields with new numbers; reserve deleted ones.
message TransferCompleted {
  string transfer_id = 1;
  int64 amount_minor = 2;
  string currency = 3;
  int64 fee_minor = 4;
  reserved 5;
  reserved "legacy_amount";
}
```

**What breaks in the beginner way:** old messages decode with their amount in `fee_minor` and `amount_minor = 0`. The minimal script showed it with no error at all.

### Mistake 3: webhooks without retries or a delivery log

```ts
// Beginner way: fire and forget, inside the transfer request.
await applyTransfer(client, input);
await fetch(partner.url, { method: "POST", body: JSON.stringify(event) }); // no signature, no retry, no log
```

```ts
// Product way: write the event in the same transaction; a worker delivers, retries and logs every attempt.
await applyTransfer(client, input);
await enqueueWebhookEvent(client, { type: "transfer.completed", data: transfer });
// ... COMMIT. WebhookDeliveryWorker signs, sends with a timeout, retries on schedule, records each attempt.
```

**What breaks in the beginner way:** if the partner is deploying, the event is gone forever and nobody knows. If the partner is slow, our transfer API is slow. If the transfer rolls back after the `fetch`, the partner was told about money that never moved.

### Mistake 4: verifying a webhook after parsing the JSON

```ts
// Beginner way: verify against a re-stringified body.
app.post("/webhooks/ledger", async (req) => {
  const ok = verify(JSON.stringify(req.body), req.headers["webhook-signature"]); // bytes may differ
});
```

```ts
// Product way: keep the raw string for this route and verify that.
app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => done(null, body));
```

**What breaks in the beginner way:** spacing, key order or number formatting can change, so genuine webhooks fail verification at random. Teams then "fix" it by turning verification off.

### Mistake 5: a receiver that does the work before answering, and has no dedupe

```ts
// Beginner way
app.post("/webhooks/ledger", async (req) => {
  await markOrderPaid(req.body.data.orderId);   // slow; may run twice on retries
  await sendSmsToShopkeeper(req.body.data);      // the sender times out and retries meanwhile
  return { ok: true };
});
```

```ts
// Product way: verify, record the event id once, answer fast; a worker does the business work.
const { rowCount } = await db.query(
  "INSERT INTO received_webhooks (event_id, payload) VALUES ($1, $2) ON CONFLICT (event_id) DO NOTHING", [id, raw]);
return reply.code(200).send({ received: true, duplicate: rowCount === 0 });
```

**What breaks in the beginner way:** the shopkeeper gets two SMSes and the order is marked paid twice (the lost-200 test shows this exact retry happening).

### Mistake 6: N+1 resolvers, or DataLoader done wrong

```ts
// Beginner way: one query per parent.
Wallet: { transactions: (w, _, { db }) => db.query("... WHERE wallet_id = $1 LIMIT 10", [w.id]) }
// Also wrong: a module-level `new DataLoader(...)` shared by every request.
```

```ts
// Product way: loaders created per request in context; batch functions return results in key order.
context: ({ db }) => ({ db, loaders: createLoaders(db) }),
Wallet: { transactions: (w, a, ctx) => ctx.loaders.lastTransactions(Math.min(a.last, 50)).load(w.id) },
```

**What breaks in the beginner way:** 222 queries for one dashboard load. With a shared loader, users see each other's cached data.

### Mistake 7: gRPC calls without a deadline

```ts
// Beginner way: no deadline. gRPC's default is to wait forever.
client.getBalance({ walletId }, (err, res) => { /* ... */ });
```

```ts
// Product way: every call has a deadline taken from the caller's remaining budget.
client.getBalance({ walletId }, metadata, { deadline: new Date(Date.now() + LEDGER_BUDGET_MS) }, callback);
```

**What breaks in the beginner way:** when the ledger's database stalls, every gateway request waits with it. Connections, memory and the app's spinner all pile up until something else times out.

---

## ✅ Production checklist

**Choosing**
- [ ] For each consumer, the style is justified by who calls, how often, how fast, and how the contract will evolve.
- [ ] Public and partner surfaces are REST (plus webhooks); internal hot paths are gRPC; GraphQL only where many UI shapes justify it; tRPC only inside one TypeScript team.

**gRPC**
- [ ] `.proto` files live in one place, are versioned by package (`ledger.v1`), and reviewed like API changes.
- [ ] Generated code is never hand-edited; loader options match codegen flags.
- [ ] Every call has a deadline from the caller's budget; servers check cancellation.
- [ ] `int64` money arrives as strings; enums have an `UNSPECIFIED = 0`.
- [ ] Removed fields are `reserved` (number and name); a breaking-change check runs in CI (for example `buf breaking` if you use Buf).
- [ ] One client (channel) per target per process; an HTTP/2-aware load balancer or client-side balancing.
- [ ] mTLS between services; gRPC status codes mapped to Problem Details at the public edge.
- [ ] Graceful shutdown with `tryShutdown` and a forced timeout.

**GraphQL**
- [ ] DataLoader for every relation, created per request; batch functions return results in key order.
- [ ] SQL query count per request is logged and alerted on.
- [ ] Cost limit, depth limit, alias limit, page-size caps and a request timeout.
- [ ] Persisted operations for first-party apps; introspection off in production if the API is not public.
- [ ] Money is never `Int`; every type has a stable `id` for client caches.
- [ ] Errors are masked (no internals); monitoring looks at the `errors` array, not only HTTP status.

**Webhooks**
- [ ] Events are written in the same transaction as the business change (outbox).
- [ ] Signed with HMAC over `id.timestamp.body`; secrets are per endpoint, stored encrypted, and rotatable with overlapping signatures.
- [ ] Retries with exponential backoff and jitter over about a day; `Retry-After` respected; `410` disables; `3xx` is failure.
- [ ] Every attempt is in a delivery log; dead deliveries alert; partners can see and replay deliveries.
- [ ] Timeouts on every send, small response reads, HTTPS only, SSRF protection on registered URLs.
- [ ] Event IDs are stable across retries; payloads are additive and typed by `type`; ordering is not promised.
- [ ] A "list events since X" API exists as a backup for partners who missed deliveries.
- [ ] Our docs tell receivers to verify raw bodies in constant time, check timestamps, dedupe by ID and answer fast.

**tRPC**
- [ ] Used only where client and server ship together; every procedure validates input with Zod; auth in middleware.

---

## 🤖 Engineering with AI

**Where AI tools genuinely help with this concept**

- Drafting a `.proto` from a plain description, and reviewing a proto diff for unsafe changes (renumbering, type changes, missing `reserved`).
- Writing DataLoader batch functions and the SQL behind them (`ANY($1)`, `LATERAL`).
- Generating test matrices: every gRPC status code to every Problem Details code; every webhook response class (2xx, 3xx, 410, 429, 5xx, timeout) to the expected retry decision.
- Explaining an unfamiliar provider's webhook signature scheme from its docs.

**Where they commonly go wrong for this concept**

- **`===` for signatures**, or `timingSafeEqual` without a length check (it throws).
- **Verifying a re-stringified body** instead of the raw body.
- **Webhook receivers that do the business work inline**, with no dedupe on the event ID.
- **Senders without a delivery log or retries**, or that `fetch` the partner inside the transfer request.
- **Resolvers that query per parent** (N+1), or one DataLoader shared across requests, or batch functions that return rows in SQL order instead of key order.
- **No query cost or depth limits** on a GraphQL server.
- **gRPC calls without deadlines**, a new client per request, or `int64` mapped to `number`.
- **Protobuf "refactors"** that renumber fields to look tidy.
- **Outdated APIs**: older Apollo Server or grpc-js patterns, tRPC v10 syntax in a v11 project, Zod 3 calls in a Zod 4 codebase.

**Review checklist for AI-generated code touching this concept**

- [ ] Every gRPC call has a deadline; clients are reused; `int64` is a string or bigint.
- [ ] No field number in a `.proto` diff changed or was reused; deleted fields are `reserved`.
- [ ] Every resolver that fetches related data goes through a per-request DataLoader; batch results are in key order.
- [ ] The GraphQL server has a cost (or depth) limit and capped page sizes.
- [ ] Webhook signatures cover id, timestamp and body; comparison is constant-time with a length check; raw body is used.
- [ ] Receivers dedupe on the event ID in the same statement that records the event, and answer fast.
- [ ] Senders write events transactionally, retry with jitter, log every attempt, and alert on dead deliveries.
- [ ] Tests exist for: duplicate delivery, tampered body, stale timestamp, deadline exceeded, N+1 query count.

**Useful prompts**

1. *"Here is a diff of our .proto file. For each change, say whether it is wire-safe for old clients reading new messages AND new clients reading old messages, citing the protobuf rule. Flag any renumbered or reused field numbers and any deleted field that is not reserved."*
   **Verify by:** encoding a message with the old schema and decoding it with the new one (and the reverse), like `minimal/protobuf-evolution.ts`.
2. *"Rewrite these GraphQL resolvers to use DataLoader. Loaders must be created per request in the context. Each batch function must return results in the same order as the keys, with null for missing keys. Use WHERE id = ANY($1) for Postgres."*
   **Verify by:** counting SQL queries per request before and after (the `x-sql-queries` header) and asserting identical JSON results.
3. *"Write a webhook receiver for this signature scheme: [paste the provider's docs]. Use the raw request body, constant-time comparison with a length check, a 5-minute timestamp tolerance, and dedupe by event ID with INSERT ... ON CONFLICT DO NOTHING before returning 200."*
   **Verify by:** tests that send a tampered body, a stale timestamp, a duplicate event ID and a signature of the wrong length.

---

## 🎤 Interview script

**How this shows up.** "How do these services talk to each other?" is a standard step after you draw boxes in a design round. Payment-gateway prompts (design Razorpay/Stripe/a UPI PSP) always reach "how does the merchant learn the payment succeeded?", which is webhooks plus a status API. Dashboard or feed prompts invite "would you use GraphQL here?". Strong answers justify each choice by **consumer, latency and contract evolution**, and name the safety rules without being asked.

**2-minute spoken answer outline: "How do the services and clients in your payments design communicate?"**

1. **Edge (20 s):** "Mobile apps and partners use REST with idempotency keys and Problem Details. It is cacheable, debuggable with curl, and everyone can integrate."
2. **Internal (30 s):** "Service to service, for example the gateway calling the ledger for balances, I use gRPC: a versioned protobuf contract, generated clients, HTTP/2 connection reuse, and a deadline on every call taken from the user request's budget. Protobuf changes are additive only; deleted fields are reserved."
3. **Notifications to merchants (40 s):** "Merchants get webhooks. The event is written in the same transaction as the payment, an outbox. A worker signs each delivery with HMAC over id, timestamp and body, retries with exponential backoff and jitter for about a day, logs every attempt, and alerts on dead deliveries. Receivers verify in constant time, reject old timestamps, dedupe on the event ID, and answer 200 fast. Delivery is at-least-once, so dedupe is mandatory. Merchants can also call a status API as a backup."
4. **Dashboard (20 s):** "If the merchant dashboard needs many shapes, a GraphQL BFF with DataLoader and query cost limits. Otherwise a few purpose-built REST endpoints."
5. **Close (10 s):** "Each choice follows the consumer: public means REST, internal and hot means gRPC, push to partners means webhooks."

**Mini design: payment-success notification for merchants**

```text
Payment service ── BEGIN; UPDATE payment; INSERT webhook_events; INSERT webhook_deliveries; COMMIT
Delivery workers (N) ── SELECT due ... FOR UPDATE SKIP LOCKED ── POST merchant URL (5 s timeout)
   headers: webhook-id (stable), webhook-timestamp (per attempt), webhook-signature v1,HMAC(id.ts.body)
   2xx → succeeded | 410 → disable endpoint | else → retry at 5 s, 5 min, 30 min, 2 h ... 24 h (±10%)
   every attempt → webhook_delivery_attempts; dead → alert + merchant dashboard "Replay"
Merchant receiver ── verify raw body (constant time) → |now − ts| ≤ 5 min → INSERT event_id ON CONFLICT DO NOTHING → 200
Backup ── GET /v1/events?createdAfter=... and GET /v1/payments/{id} for reconciliation
```

**Five likely follow-ups, with strong answers**

1. **"When would you pick gRPC over REST between two internal services?"** — "When both sides are ours and the call is frequent or latency-sensitive, when I want one typed contract across languages, when I need streaming, and when deadlines and cancellation should flow between hops. I would not use it where browsers or third parties call, or where HTTP caching matters. I would also measure: in my benchmark a single small call was actually faster over REST; gRPC won under concurrency and on payload size."
2. **"The merchant's server was down for 6 hours. What happens?"** — "Deliveries stay pending and retry on schedule with jitter, so they do not stampede when the merchant recovers. Every attempt is logged. If the merchant comes back within the window (about a day), they get every event, possibly out of order and possibly duplicated, which their receiver handles by event ID. After the window, deliveries go dead, we alert them, and they can replay from the dashboard or pull from the events API."
3. **"How does the receiver know the webhook is really from you, and not a replay?"** — "HMAC-SHA256 over id.timestamp.body with a per-endpoint secret, compared in constant time on the raw body. The timestamp is inside the signature, so it cannot be edited; the receiver rejects anything older than about 5 minutes. And it dedupes on the event ID, so even a replay inside the window is processed once."
4. **"Your GraphQL dashboard is slow. How do you debug it?"** — "Count SQL queries per request first. If it scales with list sizes, it is N+1: add per-request DataLoaders with batched `ANY($1)` queries and a LATERAL for per-parent limits. In my lab that took one query from 222 to 4. Then check query cost: a cycle in the schema can let a client request millions of objects, so add a cost limit."
5. **"How do you change a protobuf message without breaking old clients?"** — "Only additive changes: new fields with new numbers, new enum values with an UNSPECIFIED zero. Never renumber or reuse a number; when I delete a field I reserve its number and name. Type changes only between documented compatible types, and preferably not at all. I run a breaking-change check in CI and roll out readers before writers when a new field matters."

**Red flags interviewers notice**

- "We'll use GraphQL because it's faster" or "gRPC everywhere, including the mobile app".
- Webhooks with no signature, no retries, or "the partner will poll if they miss it" with no events API.
- Receivers that trust webhooks without dedupe, or verify with `===`.
- No deadlines or timeouts on internal calls.
- Renumbering protobuf fields "to keep them tidy".
- Not knowing that webhook delivery is at-least-once and unordered.

---

## ❓ Questions from the card, answered

Try to answer each one aloud first, then open it.

<details>
<summary><b>1. When would you pick gRPC over REST between two internal services?</b></summary>

When the consumer is another service you own, and one or more of these is true:

- **The call is frequent or latency-sensitive.** One multiplexed HTTP/2 connection, binary protobuf (57 bytes vs 112 for our balance response) and no per-call handshakes. In this guide's benchmark, gRPC had a lower p95 (18.154 vs 21.930 ms) and 17.5% more throughput with 32 calls in flight.
- **You want one strict contract across languages**, with generated clients and servers, so a field typo fails at compile time.
- **You need streaming** (for example `WatchBalance` pushing every balance change).
- **You want deadlines and cancellation** to flow across hops as a built-in feature.

Prefer REST when browsers or third parties call, when HTTP caching matters, when humans need to read traffic easily, or for a low-volume call where the simplicity wins. And measure: for a single small call on a fast network, REST was faster in this benchmark (p95 1.925 vs 2.507 ms).
</details>

<details>
<summary><b>2. What is the N+1 problem in GraphQL, and how does DataLoader solve it?</b></summary>

GraphQL resolves each field with a separate function, called once **per parent object**. A query for an account's wallets and each wallet's transactions runs 1 query for the wallets, then 1 query **per wallet** for transactions (N), and the same again one level deeper. In this guide: 1 + 1 + 20 + 200 = **222 queries** for one request.

DataLoader is a per-request batching and caching layer. Resolvers call `loader.load(key)`. DataLoader collects every key requested in the same tick of the event loop and calls one batch function with all of them, which runs one `WHERE id = ANY($1)` query and returns results in the same order as the keys. It also caches by key within the request, so repeated counterparties are fetched once. Result here: **222 → 4** queries, and **12 → 3** for one wallet with its last 10 transactions, with identical responses. Loaders must be created per request so one user's cached data never reaches another.
</details>

<details>
<summary><b>3. How does a webhook receiver prove a request really came from the sender, and survive duplicates?</b></summary>

**Authenticity:** the sender and receiver share a per-endpoint secret. The sender sends `HMAC-SHA256(secret, id + "." + timestamp + "." + body)` in a header. The receiver recomputes it over the **raw** request body and compares with a **constant-time** comparison (`crypto.timingSafeEqual`, after a length check). Without the secret, nobody can forge a valid signature, and changing any byte breaks it.

**Freshness:** the timestamp is inside the signature, so it cannot be edited. The receiver rejects messages older than a tolerance (5 minutes is common), which blocks replays of captured messages.

**Duplicates:** delivery is at-least-once. If the receiver's `200` is lost, the sender retries the same event. The event ID is stable across retries, so the receiver records it with a unique key (`INSERT ... ON CONFLICT DO NOTHING`) in the same step that queues the work, and returns `200` either way. In this guide's test, the first `200` was lost, the retry came back, and the receiver answered `{"duplicate":true}` with exactly one inbox row.
</details>

<details>
<summary><b>4. How do you evolve a protobuf schema without breaking old clients?</b></summary>

- **Add** fields with **new** numbers. Old readers skip unknown fields; new readers get defaults for old data.
- **Never change or reuse a field number.** On the wire only numbers travel, so reuse makes old data decode into the wrong field silently (this guide's demo turned a ₹500 amount into a ₹500 fee with no error).
- **Delete** a field by removing it and adding `reserved <number>;` and `reserved "<name>";`.
- **Add enum values** carefully: start enums with an `UNSPECIFIED = 0` value, and make clients handle unknown values.
- **Change types** only between documented wire-compatible pairs, and only if you control all readers; usually add a new field instead.
- **Version the package** (`ledger.v1` → `ledger.v2`) for a true redesign and run both.
- **Gate in CI** with a breaking-change checker, and deploy readers before writers when a new field matters.
</details>

---

## 🏋️ Exercises

**Beginner (no code)**

1. **Classify these proto changes** as safe or unsafe: (a) add `string note = 6;` (b) change `int64 amount_minor = 2` to `string amount_minor = 2` (c) delete `currency = 3` and add `reserved 3;` (d) delete `currency = 3` and later add `string branch = 3;` (e) rename `wallet_id` to `walletId` keeping number 1 (f) add `WALLET_STATUS_CLOSED = 3`.
   *Expected outcome:* safe: a, c, e (wire-safe; JSON names change), f (wire-safe; clients need a default branch). Unsafe: b, d.
   *Verify by:* the rules table in Deep dive 1f, and encoding/decoding with protobufjs.
2. **Pick a style for each consumer** and justify in one sentence: the Android app's balance screen; the fraud service checking every transfer; an accounting partner that needs every settled payment; the internal ops dashboard; a web page showing live balance changes.
   *Expected outcome:* REST; gRPC; webhooks plus an events API; tRPC (or REST); SSE.
   *Verify by:* the decision table and diagram in Deep dive 5.

**Intermediate (extend the lab)**

1. **Propagate the deadline.** Make the gateway's `LEDGER_BUDGET_MS` come from the remaining budget of the incoming request (for example 500 ms minus time already spent) and pass the remaining time in gRPC metadata to a second hop.
   *Expected outcome:* with a slow second hop, the whole chain fails at the original budget, not budget × hops.
   *Verify by:* a test with an artificial delay in the second hop.
2. **Add `Wallet.owner` to the dashboard query** and confirm the query count stays at 5 or less with DataLoader (the `accountById` loader is already there).
   *Expected outcome:* one extra batched query, not 20.
   *Verify by:* the `x-sql-queries` header.
3. **Secret rotation.** Let an endpoint have two active secrets; the worker sends two space-separated signatures; the receiver accepts either.
   *Expected outcome:* zero failed deliveries while rotating.
   *Verify by:* a test that rotates mid-run.

**Advanced (failure injection or 10x scale)**

1. **Two workers, one table.** Run two `WebhookDeliveryWorker` instances against the same database with 1,000 pending deliveries and a receiver that counts requests per event ID.
   *Expected outcome:* every event delivered, and (receiver duplicates aside) no event sent by both workers at the same time, thanks to `SKIP LOCKED`.
   *Verify by:* the receiver's per-ID counts and the attempts table.
2. **10x GraphQL load.** Load-test the dashboard query with autocannon at 50 concurrent requests, once with naive resolvers and once with DataLoader, with `pool.max = 10`.
   *Expected outcome:* naive resolvers exhaust the connection pool and latency explodes; DataLoader stays flat.
   *Verify by:* p95 latency and Postgres `pg_stat_activity` during the run.
3. **A recipient who is down for 2 days.** Use the real schedule with a fake clock and confirm the delivery goes `dead` after the 24-hour attempt, an alert fires, and a manual replay succeeds.
   *Expected outcome:* 10 attempts, then dead, then one successful replay.
   *Verify by:* the attempts table.

---

## 📝 Quiz

1. Why does protobuf put field **numbers**, not names, on the wire, and what rule follows from that?
2. gRPC's default deadline is what? What status does a caller get when its deadline passes?
3. A layer-4 load balancer sits in front of three ledger pods. One gateway pod sends all its gRPC calls to only one ledger pod. Why?
4. In the N+1 example, why did 200 counterparty lookups become one query and not ten?
5. Why must DataLoaders be created per request?
6. Give two reasons HTTP caching is harder for GraphQL than for REST.
7. What three things does the Standard Webhooks signature cover, and why include the timestamp?
8. A receiver's `200` is lost. What does the sender do, and what must the receiver do?
9. Why should the webhook event be written in the same transaction as the transfer?
10. When is tRPC a poor choice?

---

## 🔑 Quiz answer key

1. Numbers are much smaller than names, so messages are compact. It means **numbers are the contract**: never change or reuse a field number, and `reserve` the numbers (and names) of deleted fields.
2. **No deadline** (wait forever). The caller gets **`DEADLINE_EXCEEDED`**; the server's call is cancelled, but server code must still stop its own work.
3. gRPC keeps **one long-lived HTTP/2 connection** and multiplexes every call over it. A layer-4 balancer balances connections, not calls. You need an HTTP/2-aware (layer-7) balancer or client-side load balancing.
4. DataLoader collects all keys requested in the same tick into one batch, **and** caches by key: the 200 lookups were for only 10 distinct accounts, all fetched in one `ANY($1)` query.
5. Its cache would otherwise keep data across requests: users could see stale data, or another user's data.
6. Any two: most requests are POST to one URL, so shared caches do not cache them; there is no URL per object; different queries return overlapping data; errors often return `200 OK`.
7. The **event ID, the timestamp and the body** (`id.timestamp.body`). The timestamp is inside the signature so it cannot be edited, which lets the receiver reject old (replayed) messages.
8. The sender treats it as a failure and **retries the same event ID** later. The receiver must **dedupe on the event ID** and answer `200` again without reprocessing.
9. So that a rolled-back transfer never produces a webhook, and a committed transfer always does. Calling the partner directly cannot give both guarantees and couples our latency to theirs.
10. Public or partner APIs, mobile apps whose old versions keep running, non-TypeScript consumers, or anything that needs a stable, versioned, language-neutral contract.

---

## 📖 Glossary

| Term | Meaning |
|---|---|
| At-least-once delivery | Every event arrives one or more times; never zero, sometimes twice. |
| BFF (backend for frontend) | An API layer shaped for one particular UI. |
| Codegen | Generating code (types, clients, server stubs) from a schema file. |
| Constant-time comparison | Comparing secrets in a way that takes the same time however many bytes match. |
| DataLoader | Per-request batching and caching of `load(key)` calls into one batch function call. |
| Dead delivery | A webhook delivery that used up its retry schedule; needs an alert and a replay. |
| Deadline | The absolute time after which a gRPC caller stops waiting. |
| Delivery log | One row per webhook attempt: time, status, error, duration, response snippet. |
| Field number | The number that identifies a protobuf field on the wire. |
| GraphQL resolver | The function that produces one field's value. |
| HMAC | A message signature made with a shared secret and a hash function (SHA-256 here). |
| HTTP/2 multiplexing | Many requests in flight at once over one TCP connection. |
| Idempotent receiver | A receiver that processes each event ID once, however many times it arrives. |
| Jitter | Random variation added to retry delays so many clients do not retry at the same instant. |
| N+1 problem | One query for a list, plus one query for each item in it. |
| Outbox | Writing an event to a table in the same transaction as the business change, for a worker to send later. |
| Persisted operations | Only accepting known, pre-registered GraphQL queries, referenced by hash. |
| Protocol Buffers | A schema language and compact binary encoding for structured data. |
| Query cost | An estimate of how much work a GraphQL query will cause, used to reject expensive queries. |
| `reserved` | A protobuf keyword that stops a field number or name from ever being reused. |
| Replay attack | Re-sending a captured, genuine message to repeat its effect. |
| Server streaming | One request, a stream of responses. |
| SSRF | Server-side request forgery: tricking our server into calling an internal address. |
| tRPC | TypeScript RPC with types inferred from the server router; no schema file. |
| Unary call | One request, one response. |

---

## 📌 Cheat sheet

**Diagram: the whole card on one screen**

```mermaid
mindmap
  root((API styles))
    REST
      Public and partners
      Cacheable URLs
    gRPC
      Proto field numbers are forever
      Deadline on every call
      One client per process
      HTTP/2 aware load balancing
    GraphQL
      Many UI shapes
      DataLoader per request
      Cost and depth limits
      Caching is harder
    Webhooks
      Outbox in same transaction
      HMAC over id timestamp body
      Retries with jitter and a log
      Receiver dedupes by event id
    tRPC
      One TS team one repo
    Live updates
      SSE or WebSockets
```

**How to read this diagram.** One branch per style, with the two or three rules that matter most for each. If you can explain every leaf, you can handle the "how do services talk?" part of a design round.

**Key rules on one screen**

- Choose by **consumer, latency, evolution**: public → REST; internal hot path → gRPC; many UI shapes → GraphQL BFF; push to partners → webhooks; one TS team → tRPC; live browser updates → SSE/WebSockets.
- gRPC: deadline on every call (default is none), one client per process, `int64` as string, add fields with new numbers, `reserved` deleted ones, never renumber.
- GraphQL: DataLoader per request, batch results in key order, cost limit before execution, money is not `Int` (32-bit tops out near ₹2.15 crore in paise).
- Webhooks: outbox → worker → signed POST (`id.timestamp.body`, HMAC-SHA256) → retries with jitter for about a day → delivery log → alert on dead.
- Receivers: raw body, constant-time compare with length check, 5-minute timestamp window, dedupe by event ID, answer 2xx fast.
- Measured here: gRPC p95 18.154 vs REST 21.930 ms at 32 in flight (REST faster one at a time); payload 57 vs 112 bytes; GraphQL 222 → 4 queries; webhooks 3 attempts, 1 duplicate safely ignored.

---

## 🏁 Completion checklist

- [ ] I can explain each row of the decision table and pick a style for a new consumer in one sentence.
- [ ] I wrote `ledger.proto`, generated types, and called `GetBalance` from the gateway with a deadline.
- [ ] Measure: I benchmarked gRPC vs REST p95 (one at a time and 32 in flight) and filled in my numbers.
- [ ] I ran the protobuf evolution demo and can show a safe and an unsafe change.
- [ ] Measure: I logged SQL per GraphQL request and saw the count drop with DataLoader (mine: __ → __).
- [ ] My GraphQL server rejects an expensive nested query before any SQL runs.
- [ ] Measure: my webhook test shows attempts per event and at least one duplicate safely ignored.
- [ ] My receiver rejects a tampered body and a stale timestamp.
- [ ] Phase 1 gate: I can answer "how do these services talk to each other?" in a design round, justifying each choice by consumer, latency and evolution.
- [ ] Lab run on my machine.
- [ ] Numbers filled in the measurements table.
- [ ] Post published.

---

## 📣 Learn in public

Use **your own** measured numbers in place of the ones from this guide.

**Post 1: "222 SQL queries for one GraphQL request"**
- *Problem:* A merchant dashboard query (account → 20 wallets → last 10 transactions → counterparty) was slow.
- *Decision:* Logged SQL per request, found N+1 in the resolvers, added per-request DataLoaders with `ANY($1)` and a `LATERAL` for "last 10 per wallet".
- *Result:* 222 queries → 4, identical JSON. A nested attack query was rejected at cost 3,022,021 with zero SQL.
- *Lesson:* GraphQL is not faster than REST by itself; it moves work to the server. Batching and cost limits are part of the design, not optimisations.

**Post 2: "I expected gRPC to win. It didn't, at first."**
- *Problem:* Gateway → ledger balance calls; I assumed gRPC would be faster everywhere.
- *Decision:* Benchmarked the same read over gRPC and REST, one at a time and 32 in flight.
- *Result:* One at a time, REST p95 was lower (1.925 vs 2.507 ms). At 32 in flight, gRPC p95 was lower (18.154 vs 21.930 ms) with 17.5% more throughput, and its payload was 49% smaller.
- *Lesson:* Choose gRPC for the contract, deadlines, streaming and connection reuse, then measure. "Faster" depends on the workload.

**Post 3: "Our partner's server returned 200. We still sent the webhook again."**
- *Problem:* Webhooks are at-least-once; a lost `200` looks exactly like a failure to the sender.
- *Decision:* Signed deliveries (HMAC over id.timestamp.body), retries with jitter and a delivery log on our side; raw-body verification, a 5-minute replay window and event-ID dedupe on the receiver.
- *Result:* In fault-injection tests: 3 attempts when the receiver was down twice; 2 attempts and 1 duplicate safely ignored when the first `200` was lost; forged and replayed requests rejected.
- *Lesson:* The receiver, not the sender, owns deduplication. Design for duplicates from day one.

**Hinglish video idea: "Webhook aaya do baar? Payment double mat karo"**
Open with a kirana-shop owner's billing app showing "Payment received" twice for one ₹500 UPI payment. Explain the lost-200 retry with the chai-stall token analogy, then show the receiver's three checks live: HMAC with `timingSafeEqual`, the 5-minute timestamp, and `ON CONFLICT DO NOTHING` on the event ID. End with: "Sender retry karega hi. Dedupe receiver ki zimmedaari hai."

---

## ➡️ Next cards

- **P4-06 · Event streaming with Kafka.** The `balanceEvents` emitter behind `WatchBalance` and the webhook outbox are both small versions of an event stream. That card replaces them with Kafka topics, consumer groups and replayable logs, and the same at-least-once and dedupe rules you used for webhooks apply to consumers.
- **P4-08 · Service boundaries.** Choosing gRPC between the gateway and the ledger assumed they are separate services. That card asks when they should be, where the boundaries go, and how contracts (protos, events, webhooks) keep teams independent.
- **Also linked:** the webhook outbox is formalised in **P4-07 · Consistency across services: outbox, CDC, sagas, CQRS**; live browser updates are **P3-06 · Real-time delivery: WebSockets, SSE, pub/sub**; query-cost-based limits connect to **P3-04 · Rate limiting**; real auth for tRPC and webhooks endpoints is **P1-05 · Authentication and authorisation**.

---

## 📚 Sources and further reading

All links checked on 12 October 2026.

- [gRPC: Deadlines guide](https://grpc.io/docs/guides/deadlines/) — no default deadline, `DEADLINE_EXCEEDED`, propagation.
- [Protocol Buffers: proto3 language guide](https://protobuf.dev/programming-guides/proto3/) — updating message types, reserved fields, field number sizes.
- [@grpc/grpc-js and @grpc/proto-loader on GitHub](https://github.com/grpc/grpc-node) — the Node.js gRPC implementation used in the lab.
- [GraphQL: Caching](https://graphql.org/learn/caching/) — globally unique IDs for client caches.
- [GraphQL over HTTP (working draft)](https://http-spec.graphql.org/draft/) — GET for queries, not mutations; `application/graphql-response+json`.
- [DataLoader](https://github.com/graphql/dataloader) — batching per tick, key-order contract, per-request instances.
- [GraphQL Yoga documentation](https://the-guild.dev/graphql/yoga-server/docs).
- [Standard Webhooks specification](https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md) — headers, `id.timestamp.body` signing, retry schedule, status-code handling.
- [Stripe: Receive events in your webhook endpoint](https://docs.stripe.com/webhooks) — `Stripe-Signature`, 5-minute default tolerance, retries for up to three days, duplicates and ordering.
- [GitHub: Validating webhook deliveries](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries) and [Redelivering webhooks](https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/redelivering-webhooks) — `X-Hub-Signature-256`, constant-time comparison, no automatic redelivery.
- [Node.js crypto.timingSafeEqual](https://nodejs.org/api/crypto.html#cryptotimingsafeequala-b).
- [tRPC: Routers](https://trpc.io/docs/server/routers), [Validators](https://trpc.io/docs/server/validators) and [Vanilla client setup](https://trpc.io/docs/client/vanilla/setup).
- [Connect RPC](https://connectrpc.com/) — the alternative gRPC-compatible stack mentioned in Deep dive 1b.


