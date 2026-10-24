# P1-06 · Validation, configuration and secrets

| | |
|---|---|
| **Phase** | 1 · Backend foundations |
| **Prerequisites** | P1-03 · REST API design (the lab also reuses P1-05 · Authentication and authorisation) |
| **Leads to** | P5-04 · Feature flags (previewed in Deep dive 6) · P5-06 |
| **Suggested repo path** | `system-design/phase-1/p1-06-validation-configuration-and-secrets.md` |
| **Facts checked on** | 14 October 2026 |

**After this card you can:**

1. Put one validation layer at the edge of a Fastify API: every route has a Zod schema for params, query, body and response, unknown fields are rejected, and a route without a schema cannot even start.
2. Turn raw input into typed domain values once ("parse, don't validate"), and normalise what people type: Unicode, phone numbers in E.164, emails, money as integer paise.
3. Load configuration as a typed, frozen object at boot, and make a bad deploy fail in the first second with a message that names every problem and prints no values.
4. Keep secrets out of git, logs and responses, and rotate a database password under live traffic with zero failed queries.
5. Defend the API with request limits (size, depth, time, headers) and know which layer answers with 413, 408 or 431.

> **About the numbers in this guide.** Everything marked **Real output** was run while writing this guide: Node 22.22, PostgreSQL 16.15, a 2-vCPU Linux sandbox, the same ledger codebase as P1-03 and P1-05 (now 142 passing tests in 11 files). Everything marked **Expected** was not run here. Versions checked on 14 Oct 2026: Fastify 5.12.7, Zod 4.6.7, node-postgres 8.23.1, pino 10.4.0, libphonenumber-js 1.13.15, secure-json-parse 4.1.1, Vitest 5.0.4, TypeScript 5.9.3. **gitleaks could not be downloaded in this sandbox** (its GitHub release and Go module hosts are blocked by the sandbox's network policy), so the gitleaks scan output is marked **Expected**; the config, the custom rule and the hook were still tested directly.

> **Leads to P5-06.** The card names it only by ID. Whatever its exact title in your roadmap, it builds on the fail-fast config, secret files and rotation drill from this card.

---

## ⏱️ The concept in one minute

Everything that comes from outside your code is untrusted. That includes the request body, the query string, path params and headers. It also includes **environment variables** and **secret files**, which people forget.

**Definition.**
- **Validation** turns untrusted input into trusted, typed values at the edge of the system, once.
- **Configuration** is the same job for the environment, done once at boot.
- **Secrets** are the part of configuration that must never be seen: not in git, not in logs, not in responses.

**One line:** parse at the edge, fail fast at boot, and never let a secret touch git, logs or a response.

**Analogy: the railway reservation counter.** The clerk checks your form once, at the counter: train number format, date, age, berth choice. After that, the system trusts your PNR. The TTE in the coach does not re-check your handwriting. And the station master does not flag off a train when the signal settings are wrong. They hold it at the platform. Your API should work the same way: one strict check at the counter, trust inside, and no departure on bad settings.

**On the ledger platform.** Riya's app sends `"amountMinor": "500"` (a string, from a text box). Without validation, `"500" + 10` is `"50010"`. With validation, the request stops at the edge with `400` and `pointer: "#/amountMinor"`, and the transfer code only ever sees a real integer.

---

## 💥 The problem it solves

Here are five small failures from the ledger platform. Each one was run while writing this guide.

**1. TypeScript types do not check anything at runtime.** `JSON.parse(raw) as TransferRequest` compiles, so the fee maths runs on a string:

**Real output** (`minimal/types-are-not-validation.ts`, first two lines):

```text
total with fee: 50010 <- string concatenation, not maths
currency: inr | extra field kept: true
```

**2. Money as floats.** A user types `19.99`. `parseFloat("19.99") * 100` is not 1999. And `parseFloat("1,500.50")` stops at the comma, so ₹1,500.50 becomes one rupee:

**Real output** (`minimal/parse-dont-validate.ts`, first two lines):

```text
"19.99" -> parseFloat x 100 = 1998.9999999999998 | exact = 1999
"1,500.50" -> parseFloat x 100 = 100 | exact = 150050
```

**3. Config that "works" but is wrong.** `TRUST_PROXY=false` read with a boolean coercion becomes `true`. Your per-IP login limit (P1-05) now trusts `X-Forwarded-For` from anyone. A missing `DATABASE_URL` with a "helpful" default boots happily and points at `localhost`:

**Real output** (`minimal/config-traps.ts`, selected lines):

```text
z.coerce.boolean('false') -> true
```

```text
DATABASE_URL ?? localhost -> postgres://localhost:5432/ledger
```

**4. A response that returns the database row.** `SELECT *` plus `reply.send(row)` works on day one. Next quarter someone adds `kyc_pan` and `internal_risk_score` columns, and they become public the same day, along with the password hash that was always there:

**Real output** (`minimal/response-whitelist.ts`, the beginner line):

```text
beginner: {"id":"8c1e...","email":"riya@ledger.test","role":"user","phone_e164":"+919876543210","password_hash":"$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA","created_at":"2026-10-01T10:00:00.000Z","kyc_pan":"ABCDE1234F","internal_risk_score":87}
```

**5. A small body that is still a big problem.** 60,000 bytes of `[[[[...]]]]` fits under a 64 KiB limit. `JSON.parse` handles it, but any recursive code that walks the value later (hashing, logging) crashes:

**Real output** (`minimal/json-depth.ts`, first three lines):

```text
JSON.parse of 60000 bytes, depth 30000: ok in 7.2 ms
recursive walk: RangeError Maximum call stack size exceeded
JSON.stringify: Maximum call stack size exceeded
```

None of these are exotic. Payment and fintech teams keep seeing the same few patterns behind incidents: a string where a number was expected, a float for money, a default that pointed at the wrong place, a column that leaked, a key pushed to GitHub. OWASP's API Security Top 10 (2023) lists one of them as its own risk: **API3:2023 Broken Object Property Level Authorization** (reading or writing object fields you should not see or set). This card removes these failures as whole classes, not one at a time.

---

## 🧰 Before you start

**Cards you need:**

- **P1-03 · REST API design.** Problem Details errors (RFC 9457), the OpenAPI-first workflow, idempotency keys, and the first `validate()` helper with Zod. This card replaces that helper with Fastify's own validation phase.
- **P1-05 · Authentication and authorisation.** The `onRoute` hook that refuses to register a route without an access rule. This card reuses the same "deny by default" trick for schemas.

**Key terms (each is explained again where it first matters):**

| Term | Plain meaning |
|---|---|
| **Edge** | The first place your code touches a request: the route definition, before any business logic. |
| **Schema** | A description of allowed data (types, lengths, formats), checked at runtime. Here: Zod. |
| **Validate vs parse** | Validate answers "is this OK?" and keeps the raw value. Parse answers with a **new, typed value** or an error. |
| **Normalisation** | Turning many spellings of one value into one form: `"098765 43210"` → `"+919876543210"`. |
| **E.164** | The international phone number format: `+`, country code, number, no spaces (max 15 digits). |
| **NFC / NFKC** | Unicode normal forms. Two strings that look identical can be different bytes until normalised. |
| **Brand type** | A TypeScript type like `number & { __brand: "Paise" }`: only a parser can create one. |
| **Twelve-factor config** | Store config in the environment, build once, deploy the same build everywhere. |
| **Fail fast** | Refuse to start (exit 1) on bad config, instead of running wrongly. |
| **Secret** | Config whose value gives access: DB passwords, signing keys, API keys, peppers. |
| **Secret manager** | A service that stores secrets, controls who reads them and rotates them: AWS Secrets Manager, Vault, Doppler. |
| **Rotation** | Replacing a secret with a new one, ideally without downtime. |
| **Least privilege** | Every identity gets only the permissions it needs, nothing more. |
| **DoS** | Denial of service: making the server too busy to serve real users. |
| **413 / 415 / 408 / 431** | Body too large / wrong content type / request too slow / headers too large. |
| **400 vs 422** | 400: the request is malformed (wrong shape). 422: well-formed, but breaks a business rule. |

---

## 🧠 How it works

### The mental model: three gates

Untrusted data enters a backend at three moments, and each one gets a gate.

**Diagram: three gates for untrusted data**

```mermaid
flowchart TD
  A["Code change"] --> G1{"Gate 1: gitleaks<br/>secret in the diff?"}
  G1 -- "yes" --> X1["Commit or PR blocked"]
  G1 -- "no" --> D["Deploy one build"]
  D --> G2{"Gate 2: loadConfig<br/>environment valid?"}
  G2 -- "no" --> X2["Exit 1, old version<br/>keeps serving"]
  G2 -- "yes" --> S["Server running"]
  S --> G3{"Gate 3: limits and schemas<br/>request valid?"}
  G3 -- "no" --> X3["4xx Problem Details"]
  G3 -- "yes" --> H["Handler sees typed data"]
```

**How to read this diagram.** Read top to bottom, following one change from laptop to production. Gate 1 runs on every commit and in CI, and stops secrets before they become git history. Gate 2 runs once per process start: bad config means the new version never starts, so the old one keeps serving traffic. Gate 3 runs on every request. Only data that passed all the gates reaches a handler, and the handler can trust its types.

### The request gate in detail

This is the main diagram of the card. It follows one request through every check, in the order Fastify runs them.

**Diagram: a request from bytes to response, through schema validation and a typed domain object**

```mermaid
flowchart TD
  A["1. Bytes arrive"] --> B{"2. Node limits<br/>headers, time"}
  B --> C["3. onRequest:<br/>authenticate"]
  C --> D{"4. Body parser<br/>size, type, depth"}
  D --> F{"5. Zod request schemas<br/>params, query, body"}
  F --> G["6. Typed values<br/>WalletId, AmountMinor"]
  G --> H["7. preHandler: authorize,<br/>idempotency"]
  H --> I{"8. Domain parse<br/>StatementPeriod"}
  I --> J["9. Handler and database"]
  J --> K["10. Response schema<br/>field allowlist"]
  K --> L["11. Leak guard,<br/>then client"]
  B -- "431 or 408" --> E["Problem Details"]
  D -- "413, 415 or 400" --> E
  F -- "400 with field errors" --> E
  I -- "422" --> E
```

**How to read this diagram.** Steps 1-11 are the happy path, top to bottom. The diamonds are checks that can stop the request; each stop goes to one "Problem Details" box with the status code on the arrow. Two things to notice. First, checks get **more expensive and more specific** as you go down: byte counts first, then shape, then business rules that need today's date, then the database. Cheap checks run first so junk never reaches the expensive ones. Second, the response has its own check (step 10). Validation is not only about input.

This order maps directly onto Fastify's request lifecycle (from the Fastify docs): `onRequest` → `preParsing` → parsing → `preValidation` → **validation** → `preHandler` → handler → `preSerialization` → `onSend`. Our Zod schemas run in the **validation** step, and the response schema runs during serialization.

### Which check lives where

Every check has exactly **one** owner. This table is the most useful thing to keep from this card.

| # | Check | Ledger example | Lives in | Fails with |
|---|---|---|---|---|
| 1 | Header block size | 20 KB of headers | Node HTTP server (`maxHeaderSize`) | 431 |
| 2 | Whole request must arrive in time | Client sends 1 byte of a 100-byte body | Node (`requestTimeout`, `headersTimeout`) | 408 |
| 3 | Body size | 70 KB login body | Fastify `bodyLimit` | 413 |
| 4 | Content type | `text/plain` body | Content-type parser (JSON only) | 415 |
| 5 | JSON nesting, `__proto__` keys | `[[[[...]]]]` 25 levels | `src/http/jsonBodyParser.ts` | 400 `JSON_TOO_DEEP` / `MALFORMED_JSON` |
| 6 | Who is calling | Missing or expired token | `onRequest` authenticate (P1-05) | 401 |
| 7 | Shape and format of each field | `amountMinor: 500.5`, `currency: "inr"`, unknown `fee` | Zod route schema (validation phase) | 400 `VALIDATION_FAILED` |
| 8 | Normalisation | `"098765 43210"` → `"+919876543210"` | The same Zod schema (transforms) | 400 if it cannot be normalised |
| 9 | May this caller touch this object | Amit reading Riya's wallet | `authorize()` preHandler (P1-05) | 404 / 403 |
| 10 | Protocol headers with their own codes | `Idempotency-Key`, `If-Match` | `requireIdempotency` / wallet handler (P1-03) | 400 `IDEMPOTENCY_KEY_*`, 428, 412 |
| 11 | Rules across fields, or needing "today" | Period over 366 days, `to` in the future | Domain parse (`src/domain/statementPeriod.ts`) | 422 `INVALID_PERIOD` |
| 12 | Rules needing current data | Not enough balance, wallet frozen | Service, inside the DB transaction | 422 `INSUFFICIENT_FUNDS`, `WALLET_FROZEN` |
| 13 | Last-line data integrity | `CHECK (amount_minor > 0)`, `UNIQUE` | Postgres constraints | 500 / 409 (should never be first to catch) |
| 14 | Only allowed fields leave | `passwordHash` in a returned record | Response schema (serializer) | Field silently dropped |
| 15 | Response breaks its own contract | `amountMinor: "50000"` | Response schema (serializer) | 500, fail closed |
| 16 | Known secret shapes in any response | An argon2 hash in a `debug` field | Leak guard (`onSend`) | 500, logged |
| 17 | Config | `PORT=80a`, http URL in production | `loadConfig` at boot | Exit code 1 |
| 18 | Secrets in code | A planted `lk_live_...` key | gitleaks pre-commit hook and CI | Commit / PR blocked |

Two rows look like "validating again" but are not. Row 12 needs data the edge cannot see (the balance at this moment, under a row lock). Row 13 is a backstop: if it ever fires first, a check above it is missing. That is a bug to fix, not a feature to rely on.

### Same shape, different words

| Who checks | What it is for | Can a client skip it? |
|---|---|---|
| Frontend form validation | Fast feedback for honest users | Yes: `curl`, Postman, a modified app |
| TypeScript types | Catch mistakes in **your** code at compile time | They do not exist at runtime |
| Edge schema (this card) | The one real check on untrusted input | No |
| Database constraints | Backstop for bugs in your own code | No, but errors here are 500s |

---

## 🔬 Deep dive

One subsection per "Learn inside" item on the card, in study order. Each has a minimal, runnable file first. The product version lives in the Hands-on lab.

### 1. Validate at the edge

**What it is.** Every part of a request gets a schema: path **params**, **query** string, **headers** and **body**. The schema runs before any business code. If it fails, the request stops with `400` and a list of field errors. If it passes, the handler gets the **parsed** value, not the raw one.

**Minimal version.** The same JSON, first trusted with a TypeScript cast, then parsed with Zod.

```ts
// minimal/types-are-not-validation.ts — a TypeScript type is a promise to the compiler, not a check at runtime.
// Run: npx tsx minimal/types-are-not-validation.ts
import { z } from "zod";

interface TransferRequest { amountMinor: number; currency: "INR" }
const FEE_MINOR = 10; // Rs 0.10

// What arrives over the network. The client's JavaScript built it with a text input value.
const raw = '{"amountMinor":"500","currency":"inr","isAdmin":true}';

// Beginner way: cast and trust. The compiler is happy; nothing was checked.
const trusted = JSON.parse(raw) as TransferRequest;
console.log("total with fee:", trusted.amountMinor + FEE_MINOR, "<- string concatenation, not maths");
console.log("currency:", trusted.currency, "| extra field kept:", "isAdmin" in trusted);

// Product way: a schema checks the real value at runtime, then the type is true.
const TransferRequest = z.strictObject({ amountMinor: z.int().positive(), currency: z.enum(["INR"]) });
const result = TransferRequest.safeParse(JSON.parse(raw));
if (!result.success) {
  for (const issue of result.error.issues) console.log(`rejected ${issue.path.join(".") || "(root)"}: ${issue.message}`);
}
const ok = TransferRequest.parse({ amountMinor: 500, currency: "INR" });
console.log("valid total:", ok.amountMinor + FEE_MINOR);
```

**Real output:**

```text
total with fee: 50010 <- string concatenation, not maths
currency: inr | extra field kept: true
rejected amountMinor: Invalid input: expected number, received string
rejected currency: Invalid input: expected "INR"
rejected (root): Unrecognized key: "isAdmin"
valid total: 510
```

**What to notice**
- `as TransferRequest` changes nothing at runtime. `"500" + 10` is string concatenation, and the extra `isAdmin` field rides along.
- Zod reports **every** problem in one go, each with a path. That is what becomes `errors[].pointer` in our Problem Details.
- After `parse`, the type is true, because a runtime check made it true.

**How it works in Fastify.** Fastify has a built-in validation step, between `preValidation` and `preHandler`. By default it uses JSON Schema (Ajv). We plug Zod in with `setValidatorCompiler`, so a route can write `schema: { params, querystring, body }` with Zod objects (the product file is `src/http/zodCompilers.ts` in the lab). Fastify's docs give the contract: a custom validator **returns** `{ value }` or `{ error }`; it does not throw. We return `{ value: result.data }`, and Fastify replaces `request.body` with the parsed value. The handler never sees the raw input.

Why this step and not a `preHandler` (what P1-03 did)? Three reasons:
- It runs **before** `authorize()`. Authorisation reads `request.params.walletId`, so it should read a checked UUID, not raw text.
- Fastify knows the schemas, so a startup hook can **refuse to register** a route that has none (lab step 1).
- The same schemas feed the contract test against `openapi.yaml`.

**Three ways to treat unknown fields.** Zod 4 has three object modes. Pick on purpose:

| Mode | Unknown keys | Use it for | Why |
|---|---|---|---|
| `z.strictObject` | Rejected (400, "Unknown field") | Request **body**, **params**, **query** | A client sending `role` or `status` is a bug or a probe. Tell them. |
| `z.object` | Silently **dropped** | **Responses** | An allowlist: only named fields leave the server (section 4). |
| `z.looseObject` | Kept | **Headers**, third-party callbacks | Requests carry dozens of headers; Google's OAuth callback adds its own query params. |

Rejecting unknown input fields blocks **mass assignment**: a client adding `"status": "completed"` or `"role": "admin"` to a body and hoping the server copies it to the database. It also catches typos. With a stripping schema, a client that sends `nickName` instead of `nickname` gets `200` and nothing changes. With a strict one, they get `400` and a pointer to `#/nickName`.

The trade-off: strict input means removing a request field later is a breaking change for clients still sending it. Keep accepting an old field (and ignore it) until your logs show nobody sends it.

**Query strings are text.** `?limit=20` arrives as the string `"20"`. `z.coerce.number()` turns `""` into `0` and `"1e2"` into `100`. Our `PageLimit` accepts 1-3 digits only, then checks the range:

```ts
// src/schemas/common.ts (excerpt)
export const PageLimit = z.string().regex(/^\d{1,3}$/).transform(Number).pipe(z.int().min(1).max(100)).default(50);
```

**Headers need care.** Node lowercases header names, and a request has many headers you did not ask for. So a header schema must be **loose**. A strict or stripping one would throw away (or reject) `user-agent` and everything else. On our platform the two important headers (`Idempotency-Key`, `If-Match`) keep their P1-03 owners, because they have their own error codes that clients already switch on. The contract test records that as a known difference, with the reason.

**Size limits inside the schema.** `bodyLimit` caps the whole body at 64 KiB, but it does not stop a 60,000-character `note`. Every string gets a `max` (note 140, email 254, raw phone 32). Every array gets a max length. These limits protect your database columns, your logs, and anything downstream, like a 160-character SMS.

**One surprise found while building the lab.** Fastify ships a parser for `text/plain` as well as JSON. A `text/plain` body reached our schema and got a `400`, not a `415`. That matters for security. `text/plain` is one of the content types a browser can POST cross-site **without a CORS preflight**, so a hostile page can send it with the user's cookies. A JSON-only API should remove that parser. Ours does (`removeAllContentTypeParsers()` in `jsonBodyParser.ts`), and the malformed-input test now gets `415`.

**When not to use it.** Do not validate again inside services and repositories (section 2 explains why). Do not hand-write schemas that already exist elsewhere: when the spec is the source of truth, generate types from it and tie the Zod schemas to them with `satisfies`, as the lab does.

**Trade-off.** CPU and a second description of the API (Zod next to OpenAPI). The CPU cost is tiny (section 4 measures it). The duplication is real. The lab's contract test keeps the two in step.

### 2. Parse, don't validate

**What it is.** "Parse, don't validate" is the title of a 2019 post by Alexis King. The idea: a check that returns `true` or `false` throws its knowledge away. The next function still holds a plain `number` and has to wonder. A **parser** returns a new value of a **more precise type**, or an error. Once you hold that type, the check is done forever.

In TypeScript we get "more precise types" with **brands**: a `number` that the compiler treats as different from other numbers, and that only the parser can create.

**Minimal version.** Human-typed rupees become exact integer paise, using string maths, and the result is a branded `Paise`.

```ts
// minimal/parse-dont-validate.ts — parse raw input ONCE into a type that can only hold valid values.
// Run: npx tsx minimal/parse-dont-validate.ts
import { z } from "zod";

// A brand makes `Paise` a different type from `number`: only the parser can produce one.
const Paise = z.int().positive().max(100_000_000_000).brand<"Paise">();
type Paise = z.infer<typeof Paise>;

// Human input like "1,500.50" -> exact paise, using string maths. Never parseFloat(x) * 100.
function rupeesToPaise(text: string): Paise {
  const match = /^(\d{1,3}(?:,?\d{2,3})*|\d+)(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (!match) throw new Error(`not an amount: "${text}"`);
  const rupees = match[1]!.replaceAll(",", "");
  const paise = (match[2] ?? "").padEnd(2, "0");
  return Paise.parse(Number(rupees) * 100 + Number(paise));
}

// Inside the app, functions ask for the parsed type. A raw number cannot reach them by accident.
function addFee(amount: Paise): number {
  return amount + 10;
}

for (const input of ["19.99", "1,500.50", "4.35", "0.1"]) {
  console.log(`"${input}" -> parseFloat x 100 = ${parseFloat(input) * 100} | exact = ${rupeesToPaise(input)}`);
}
console.log("fee added:", addFee(rupeesToPaise("1,500.50")));
for (const bad of ["1.505", "-20", "12abc", ""]) {
  try { rupeesToPaise(bad); } catch (e) { console.log("rejected:", (e as Error).message.split("\n")[0]); }
}
// addFee(150050);  // compile error: number is not assignable to Paise (see the README for tsc's message)
```

**Real output:**

```text
"19.99" -> parseFloat x 100 = 1998.9999999999998 | exact = 1999
"1,500.50" -> parseFloat x 100 = 100 | exact = 150050
"4.35" -> parseFloat x 100 = 434.99999999999994 | exact = 435
"0.1" -> parseFloat x 100 = 10 | exact = 10
fee added: 150060
rejected: not an amount: "1.505"
rejected: not an amount: "-20"
rejected: not an amount: "12abc"
rejected: not an amount: ""
```

Uncomment the last line and run `tsc`. **Real output** (TypeScript 5.9, strict):

```text
minimal/_brand_error.ts(30,8): error TS2345: Argument of type 'number' is not assignable to parameter of type 'number & $brand<"Paise">'.
  Type 'number' is not assignable to type '$brand<"Paise">'.
```

**What to notice**
- `parseFloat(x) * 100` is wrong for `19.99` and `4.35`, and badly wrong for `1,500.50` (it stops at the comma). Exact parsing works on the text.
- `addFee(150050)` does not compile. A raw number cannot reach code that needs a checked amount, even by accident.
- `"1.505"` (three decimal places) is rejected, not rounded. Rounding someone's money silently is a bug.

**In the product.** Two kinds of parsing happen, at two moments:
1. **Shape parsing** in the route schema: `WalletId` is `z.uuid().brand<"WalletId">()`, so `request.body.sourceWalletId` is already a `WalletId`, not a `string`. A `400` here means "your request is malformed".
2. **Domain parsing** for rules that need more than one field, or need today's date. A statement period must have `to >= from`, `to` not in the future, and at most 366 days. `parseStatementPeriod()` returns `Parsed<StatementPeriod>`: either a branded value or a `422 INVALID_PERIOD` error. The export code accepts only a `StatementPeriod`.

That split also answers **400 vs 422**: a malformed request is 400; a well-formed request that breaks a business rule is 422.

**Why inner code should not validate again.** Picture `transferService` re-checking `amountMinor > 0` "to be safe". Now there are two rules. Six months later someone raises the limit in the schema but not in the service. The API accepts a request that the service then rejects with a different error, or the reverse. In P1-03's contract tests we found exactly this: **two different regexes for the same header**. One owner per rule, and types that carry the proof, prevent it. What inner code **does** check is what the edge cannot know: the balance under a row lock, whether the wallet is frozen right now. Those are business rules, not validation.

**When not to use it.** Do not brand every string in the codebase. Brand values whose mix-ups cost money or safety: amounts, IDs that look alike (`WalletId` vs `TransferId`), checked periods, normalised phone numbers. Plain display text does not need a brand.

**Trade-off.** Brands need a parse step at every boundary where data enters (HTTP, DB reads, queue messages). That is the point, but it is more code than casting.

### 3. Normalisation

**What it is.** The same value can arrive in many spellings. Normalisation picks **one** form **before** you compare, store, hash or check length. If you skip it, duplicates sneak in ("Riya@x.com" and "riya@x.com"), lookups miss, and invisible characters break things.

**Minimal version.**

```ts
// minimal/normalisation.ts — the same value can arrive in many spellings. Pick one form before comparing or storing.
// Run: npx tsx minimal/normalisation.ts
import { parsePhoneNumberWithError } from "libphonenumber-js";

const show = (s: string) => [...s].map((c) => "U+" + c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")).join(" ");

// 1. Unicode: two spellings that look identical on screen.
const typed: string = "\u0958\u093E\u0928\u0942\u0928";         // "क़ानून" with QA as one code point (U+0958), as some keyboards produce it
const pasted: string = "\u0915\u093C\u093E\u0928\u0942\u0928"; // the same word as KA + NUKTA (U+0915 U+093C), as other keyboards produce it
console.log("same text?", typed === pasted, "| after NFC:", typed.normalize("NFC") === pasted.normalize("NFC"));
console.log("NFC form of the first letter:", show(typed.normalize("NFC").slice(0, 2)));
const cafe1: string = "Caf\u00E9", cafe2: string = "Cafe\u0301"; // é as one code point vs e + combining accent
console.log("Café vs Cafe+accent:", cafe1 === cafe2, "| NFC:", cafe1.normalize("NFC") === cafe2.normalize("NFC"));

// 2. NFKC also folds "compatibility" characters: full-width digits from some keyboards and PDFs.
console.log("full-width '１２３' NFKC ->", "１２３".normalize("NFKC"));

// 3. Invisible characters survive trim().
const name = "Lakshmi\u200B Stores "; // a zero-width space hides after "Lakshmi"
console.log("trim() keeps zero-width space:", JSON.stringify(name.trim()), "length", name.trim().length);
console.log("after removing format chars:", JSON.stringify(name.replace(/\p{Cf}/gu, "").trim()));

// 4. Phone numbers: many Indian spellings, one E.164 form.
for (const p of ["98765 43210", "+91 98765-43210", "098765 43210", "0091 9876543210", "12345"]) {
  try {
    const phone = parsePhoneNumberWithError(p, "IN");
    console.log(`${JSON.stringify(p).padEnd(20)} -> ${phone.isValid() ? phone.number : "invalid number"}`);
  } catch (e) { console.log(`${JSON.stringify(p).padEnd(20)} -> rejected (${(e as Error).message})`); }
}
```

**Real output:**

```text
same text? false | after NFC: true
NFC form of the first letter: U+0915 U+093C
Café vs Cafe+accent: false | NFC: true
full-width '１２３' NFKC -> 123
trim() keeps zero-width space: "Lakshmi​ Stores" length 15
after removing format chars: "Lakshmi Stores"
"98765 43210"        -> +919876543210
"+91 98765-43210"    -> +919876543210
"098765 43210"       -> +919876543210
"0091 9876543210"    -> +919876543210
"12345"              -> invalid number
```

(The quoted string after "trim() keeps zero-width space" contains an invisible U+200B. The length, 15, gives it away: "Lakshmi Stores" has 14 characters.)

**What to notice**
- Two Devanagari spellings of the same word are different strings until NFC. Hindi and Marathi text from different keyboards hits this all the time.
- `trim()` does not remove zero-width characters. Strip Unicode **format** characters (`\p{Cf}`) on purpose.
- Five ways of typing an Indian mobile number become one E.164 string. "12345" is rejected, not stored.

**The rules we use.**

| Field | Normalise how | Never do |
|---|---|---|
| Free text (note, nickname) | NFC, remove `\p{Cf}`, trim, then check length; reject control characters (`\p{Cc}`) | Check length before normalising (the limit means nothing) |
| Email (for lookup) | Trim, lowercase; DB column is `citext` (P1-05) | Change the address you send mail to |
| Phone | Parse with libphonenumber-js, default country `IN`, store E.164 | Store what the user typed |
| Currency | Exact ISO 4217 code: `"INR"` only | Case-fold it. `"inr"` is a client bug: reject it so they fix it |
| Amount | Integer minor units (paise); max ₹100 crore per transfer | Floats, or rounding a third decimal place |
| Dates | ISO 8601, must be a real date (`2026-02-30` is rejected) | `new Date(text)` (it "fixes" bad dates) |
| IDs, enums, tokens | Exact match, no trimming or case changes | Any normalisation: an ID is not text |
| Password | NFC only, before hashing (NIST SP 800-63B-4 says verifiers SHOULD) | Trim, truncate or case-fold it |

Rule of thumb: **normalise what humans type; be exact about what machines send.** A person typing a phone number with spaces is normal. An app sending `"inr"` has a bug, and a `400` is the fastest way to get it fixed.

**NFC vs NFKC.** NFC joins characters with their accents ("e" + "´" → "é") and keeps the text's meaning and look. NFKC also folds "compatibility" characters: full-width `１２３` becomes `123`, and the "ﬁ" ligature becomes "fi". Use NFC for text you will show back. Use NFKC for identifiers that must be unique, like usernames, where two different-looking spellings should still clash.

**Product code.** These rules live once in `src/schemas/common.ts` (`humanText`, `Email`, `PhoneInput`, `AmountMinor`, `Currency`). Every route reuses them, so "a note" means the same thing everywhere. Because the request body is parsed before the idempotency hash is taken, two retries whose notes differ only by spaces hash the same.

**Trade-off.** Normalising throws information away. If you need the original (for audit, or to show "what the user typed"), store it next to the normalised value. Do not store only the original.

### 4. Response schemas

**What it is.** A response schema is an **allowlist** for output. The handler can return a full database record. Only the fields the schema names leave the server. This protects you from today's `password_hash` and from next quarter's new column.

**Minimal version.**

```ts
// minimal/response-whitelist.ts — send the fields you chose, not whatever the database returned.
// Run: npx tsx minimal/response-whitelist.ts
import { z } from "zod";

// What `SELECT * FROM users WHERE id = $1` gives you today...
const row = {
  id: "8c1e...", email: "riya@ledger.test", role: "user", phone_e164: "+919876543210",
  password_hash: "$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA", created_at: new Date("2026-10-01T10:00:00Z"),
};
// ...and what it gives you after someone adds a column next quarter.
const rowLater = { ...row, kyc_pan: "ABCDE1234F", internal_risk_score: 87 };

// Beginner way: return the row. Every new column becomes public the day it is added.
console.log("beginner:", JSON.stringify(rowLater));

// Product way: a response schema is an allowlist. z.object() drops every key it does not name.
const MeResponse = z.object({
  id: z.string(),
  email: z.email(),
  role: z.enum(["user", "support", "admin"]),
  phone: z.string().nullable(),
});
const toMe = (r: typeof row) => ({ id: r.id, email: r.email, role: r.role, phone: r.phone_e164 });
console.log("product: ", JSON.stringify(MeResponse.parse({ ...toMe(rowLater), password_hash: rowLater.password_hash })));
```

**Real output:**

```text
beginner: {"id":"8c1e...","email":"riya@ledger.test","role":"user","phone_e164":"+919876543210","password_hash":"$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA","created_at":"2026-10-01T10:00:00.000Z","kyc_pan":"ABCDE1234F","internal_risk_score":87}
product:  {"id":"8c1e...","email":"riya@ledger.test","role":"user","phone":"+919876543210"}
```

**What to notice**
- The beginner line leaks the hash, a PAN-format field and an internal risk score. Nobody "decided" to expose them. They were added to the table.
- The product line names four fields. Even when the hash is passed in explicitly, it is dropped.

**In the product.** Each route declares `response: { 200: WalletResponse }` (and so on). Our serializer compiler runs the Zod schema on whatever the handler returns:
- Unknown keys are dropped (`z.object` strips).
- A value of the wrong type (`amountMinor: "50000"`) is a **500**. A response that breaks its own contract is a bug; sending it "half-checked" would push the bug to every client.
- A route **without** a response schema cannot be registered. The app does not start.
- Every response schema `satisfies` the TypeScript type generated from `openapi.yaml`, so drift between spec and code is a compile error.

A second, independent line of defence, the **leak guard**, runs in `onSend`. It scans every JSON response for shapes that must never leave: argon2 and bcrypt hashes, PEM private keys, private JWK fields. If a schema wrongly lists a field holding a hash, the guard turns the response into a 500 and logs the route. It is a smoke detector, not the main design.

**Cost.** Checking every response is not free. A scaled-down measurement, one process, one schema:

```ts
// minimal/serializer-cost.ts — what does checking every response with Zod cost? Scaled-down, one process.
// Run: npx tsx minimal/serializer-cost.ts
import fastJson from "fast-json-stringify";
import { z } from "zod";

const Transfer = z.object({
  id: z.uuid(), sourceWalletId: z.uuid(), destinationWalletId: z.uuid(), amountMinor: z.int().min(1),
  currency: z.enum(["INR"]), status: z.enum(["completed"]), note: z.string().optional(), createdAt: z.iso.datetime(),
});
const row = {
  id: "0b5c6a3e-8f1e-4c47-9d0a-6f1f1b6e2a10", sourceWalletId: "5e2b7c1d-3a4f-4e8b-9c6d-1a2b3c4d5e6f",
  destinationWalletId: "7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d", amountMinor: 50_000, currency: "INR", status: "completed",
  note: "Rent for Oct", createdAt: "2026-10-14T05:30:00.000Z", internal_risk_score: 12, // extra field
};
const fjs = fastJson(z.toJSONSchema(Transfer, { target: "draft-7" }) as object);

function bench(name: string, fn: () => string, n = 200_000): number {
  for (let i = 0; i < 20_000; i++) fn(); // warm-up
  const start = process.hrtime.bigint();
  for (let i = 0; i < n; i++) fn();
  const usPerOp = Number(process.hrtime.bigint() - start) / n / 1000;
  console.log(`${name.padEnd(38)} ${usPerOp.toFixed(2)} µs per response   ${fn().includes("internal_risk") ? "LEAKS extra field" : "extra field dropped"}`);
  return usPerOp;
}

bench("JSON.stringify (no schema)", () => JSON.stringify(row));
bench("fast-json-stringify (Fastify default)", () => fjs(row));
bench("Zod parse, then JSON.stringify", () => JSON.stringify(Transfer.parse(row)));
```

**Real output** (200,000 responses each, after warm-up):

```text
JSON.stringify (no schema)             0.96 µs per response   LEAKS extra field
fast-json-stringify (Fastify default)  1.20 µs per response   extra field dropped
Zod parse, then JSON.stringify         1.82 µs per response   extra field dropped
```

Zod adds about 0.86 µs per response over plain `JSON.stringify` (computed: 1.82 − 0.96). At 1,000 requests per second that is 0.086% of one CPU core; at 10,000 it is 0.86%. One Postgres query takes far longer than that. Fastify's default serializer (`fast-json-stringify`) also drops unknown fields, as the output shows, but it **coerces** wrong types instead of rejecting them. We pay the extra fraction of a microsecond for "fail closed".

**When not to use it.** Streaming downloads (a statement PDF, a large CSV) are not JSON. Validate the metadata, not the bytes. For very hot internal endpoints you can use Fastify's default JSON Schema serializer for speed. The allowlist behaviour is the part to keep.

**Trade-off.** Adding a field to a response now takes two edits (schema and spec). That small friction is the feature: every new public field becomes a conscious decision.

### 5. Twelve-factor config

**What it is.** The Twelve-Factor App is a short methodology for building deployable services. Two of its factors matter here:
- **III. Config:** keep config (anything that changes between deploys: DB address, credentials, URLs of other services) in the **environment**, not in code. Its litmus test: could you make the repo public right now without leaking a credential?
- **V. Build, release, run:** build **one** artifact. A release is that artifact plus the config for one environment. Staging and production run the **same** build.

**Why one build matters.** If staging and production are built separately, you are testing one binary and shipping another. And `if (NODE_ENV === "production") url = "https://..."` puts environment knowledge inside code. As a frontend engineer you have met the opposite case: Next.js inlines `NEXT_PUBLIC_*` variables **at build time**, so a Next.js bundle is tied to one environment. A backend should not work that way. Our API image reads everything at boot.

**Typed config, validated at startup.** Environment variables are flat strings, or missing. We parse them **once**, at boot, into one frozen, typed object. No other file reads `process.env`. Then `env.PORT` is a `number` and `env.TRUST_PROXY` is a `boolean`, everywhere.

**Minimal version: the three traps.**

```ts
// minimal/config-traps.ts — environment variables are always strings. Converting them is where bugs hide.
// Run: npx tsx minimal/config-traps.ts
import { z } from "zod";

const env = { TRUST_PROXY: "false", LOGIN_IP_LIMIT: "", DATABASE_URL: undefined as string | undefined };

// Trap 1: Boolean("false") is true. Rate limits now trust X-Forwarded-For from anyone.
console.log("z.coerce.boolean('false') ->", z.coerce.boolean().parse(env.TRUST_PROXY));
console.log("z.stringbool()('false')   ->", z.stringbool().parse(env.TRUST_PROXY));
const typo = z.stringbool().safeParse("flase");
console.log("z.stringbool()('flase')   ->", typo.success ? typo.data : `error: ${typo.error.issues[0]?.message}`);

// Trap 2: Number("") is 0. An empty variable silently becomes "no login attempts allowed" (or unlimited).
console.log("z.coerce.number('')       ->", z.coerce.number().parse(env.LOGIN_IP_LIMIT));
const strict = z.string().regex(/^\d+$/, "must be a whole number").transform(Number).safeParse(env.LOGIN_IP_LIMIT);
console.log("strict number('')         ->", strict.success ? strict.data : `error: ${strict.error.issues[0]?.message}`);

// Trap 3: a "helpful" default. Production boots, connects to nothing useful, and fails later and quieter.
const quiet = env.DATABASE_URL ?? "postgres://localhost:5432/ledger";
console.log("DATABASE_URL ?? localhost ->", quiet);
const loud = z.object({ DATABASE_URL: z.url() }).safeParse(env);
console.log("required DATABASE_URL     ->", loud.success ? "ok" : z.prettifyError(loud.error).replaceAll("\n", " "));
```

**Real output:**

```text
z.coerce.boolean('false') -> true
z.stringbool()('false')   -> false
z.stringbool()('flase')   -> error: Invalid option: expected one of "true"|"1"|"yes"|"on"|"y"|"enabled"|"false"|"0"|"no"|"off"|"n"|"disabled"
z.coerce.number('')       -> 0
strict number('')         -> error: must be a whole number
DATABASE_URL ?? localhost -> postgres://localhost:5432/ledger
required DATABASE_URL     -> ✖ Invalid input: expected string, received undefined   → at DATABASE_URL
```

**What to notice**
- `z.coerce.boolean()` uses JavaScript's `Boolean()`, and any non-empty string is `true`, including `"false"`. `z.stringbool()` knows the usual words and rejects typos like `"flase"`.
- `z.coerce.number("")` is `0`. An empty `LOGIN_IP_LIMIT` silently means zero.
- The quiet default boots. The required field gives a loud, specific error.

**Fail fast.** When config is invalid, the process should print every problem and exit with code 1 **before** it opens a port. On Kubernetes the new pods then never become Ready, so a rolling update stops and the old version keeps serving. Compare that with "start anyway and use a default": the deploy looks green, and the failure shows up hours later as wrong behaviour, in production, with no clear cause.

Our loader (lab step 2) has three more rules worth knowing now:
- **Every problem in one run.** While building the lab, the first version used a Zod `superRefine` for rules that compare variables ("no `DATABASE_URL` in production"). Zod only runs an object-level refine once every field is valid. So the first deploy showed five problems, and the production-only problems would have appeared only on the second try. Cross-variable rules now run separately, on the raw strings, in the same pass.
- **Names, never values.** A wrong value might be a secret pasted into the wrong variable. The message says `OTP_PEPPER: Too small`, never the pepper.
- **Production is stricter.** In production, `DATABASE_URL` is refused (use a secret file), every URL must be `https://`, and secrets must come from files.

**When not to use it.** Values that must change **without** a restart are not config. They are feature flags (next section) or data in a database table.

**Trade-off.** Environment variables are easy, but they are visible to every child process, to `/proc/<pid>/environ`, and to any "print the environment" debug page or crash reporter. That is fine for `PORT`. It is not fine for a signing key. Secrets go in files (section 7).

### 6. Config vs feature flags (preview of P5-04)

**What it is.** Config is read once at boot and stays fixed for the life of the process. A **feature flag** is decided **per request** (often per user) and can change while the app runs, without a deploy.

**Minimal version.**

```ts
// minimal/feature-flags.ts — config is read once at boot; a flag is decided per request, and can change live.
// Run: npx tsx minimal/feature-flags.ts
import { createHash } from "node:crypto";

// Config: fixed for the life of the process. Changing it means a restart (or a redeploy).
const config = Object.freeze({ STEP_UP_THRESHOLD_MINOR: 1_000_000 });

// Flag: rules that a flag service can change at any time. Here, "new UPI flow for 20% of users".
let flagRules: { newUpiFlow: { percent: number } } | null = { newUpiFlow: { percent: 20 } };

// The same user always lands in the same bucket, so the feature does not flicker between requests.
function bucket(userId: string, flag: string): number {
  return createHash("sha256").update(`${flag}:${userId}`).digest().readUInt32BE(0) % 100;
}
function isEnabled(flag: "newUpiFlow", userId: string, fallback: boolean): boolean {
  if (!flagRules) return fallback; // flag service down: use the safe default, never throw
  return bucket(userId, flag) < flagRules[flag].percent;
}

const users = Array.from({ length: 10_000 }, (_, i) => `usr_${i}`);
const share = () => users.filter((u) => isEnabled("newUpiFlow", u, false)).length / users.length;
console.log(`config threshold: Rs ${config.STEP_UP_THRESHOLD_MINOR / 100} (fixed)`);
console.log(`20% rollout -> ${(share() * 100).toFixed(1)}% of 10,000 users | usr_42 twice: ${isEnabled("newUpiFlow", "usr_42", false)}, ${isEnabled("newUpiFlow", "usr_42", false)}`);
flagRules = { newUpiFlow: { percent: 0 } }; // the kill switch: no deploy needed
console.log(`kill switch -> ${(share() * 100).toFixed(1)}%`);
flagRules = null; // flag service unreachable
console.log(`flag service down -> default ${isEnabled("newUpiFlow", "usr_42", false)}`);
```

**Real output:**

```text
config threshold: Rs 10000 (fixed)
20% rollout -> 19.6% of 10,000 users | usr_42 twice: false, false
kill switch -> 0.0%
flag service down -> default false
```

**What to notice**
- Bucketing is deterministic: a hash of flag name plus user ID. `usr_42` gets the same answer every time, so the feature does not flicker between screens.
- The kill switch changes behaviour live, with no deploy.
- When the flag service is down, the code uses a default written in code. It never throws.

| | Config | Feature flag | Secret |
|---|---|---|---|
| Example | `BODY_LIMIT_BYTES`, `STEP_UP_THRESHOLD_MINOR` | New UPI flow for 20% of users | DB password, JWT signing key |
| Changed by | A deploy (or restart) | Product or on-call, in a flag tool | Rotation (automatic) |
| Read | Once, at boot | Per request | At boot, then refreshed |
| Lives in | Environment, validated at boot | Flag service, with defaults in code | Secret manager, mounted as a file |
| Lifetime | As long as the service | Days to weeks, then delete it | Until the next rotation |
| Bad value means | Process refuses to start | Fall back to the default | Process refuses to start |

Rules of thumb: every flag has a default in code, an owner and an expiry date. Never put a secret in a flag tool. And do not turn config into flags just because flags are convenient: a value that changes how money is calculated deserves a review and a deploy. P5-04 goes deeper: progressive delivery, targeting and the OpenFeature standard API.

### 7. Secrets

**What it is.** A secret is config whose value **grants access**: database passwords, JWT signing keys, the OTP pepper from P1-05, third-party API keys. The rules: keep secrets out of git, out of logs and out of responses; give each one the smallest possible power; and be able to replace any of them on a normal working day.

#### Never in git, and what to do when one gets in

Git history is forever. Deleting a key in the next commit leaves it in every clone, fork and CI cache. Bots scan public repositories for keys continuously. So the order of response matters:

**Diagram: a secret reached git, now what**

```mermaid
flowchart TD
  A["Secret found in a commit"] --> B["1. Revoke or rotate it now"]
  B --> C["2. Check its access logs<br/>since the commit time"]
  C --> D{"Was it used<br/>by someone else?"}
  D -- "yes" --> E["Incident: contain, notify"]
  D -- "no" --> F["3. Remove it from history<br/>git filter-repo"]
  E --> F
  F --> G["4. Add a gitleaks rule<br/>so it cannot happen again"]
```

**How to read this diagram.** Start at the top. Step 1 is **rotate**, not "delete the commit". Assume the secret is already copied. Only after it is dead do you clean history (step 3), which is slow and needs every clone re-cloned. Step 4 turns the incident into a permanent check.

#### `.env` is for your laptop only

A `.env` file is a convenience for local development. It is in `.gitignore`. What **is** committed is `.env.example`: every variable, with safe local values or blanks, so a new teammate knows what to set. Node 22 can read it without a library: `node --env-file=.env src/server.ts` (or `tsx --env-file=.env`). Staging and production never use `.env` files.

#### Secret managers

A secret manager stores secrets encrypted, controls who may read each one, logs every read and can rotate them.

| | AWS Secrets Manager | HashiCorp Vault / OpenBao | Doppler |
|---|---|---|---|
| Model | Managed AWS service | Self-hosted server (HCP Vault is the managed option) | SaaS |
| Access control | IAM policies per secret | Vault policies, many auth methods | Projects, environments, service tokens |
| Rotation | Built in for RDS and others (Lambda-based) | **Dynamic secrets**: a fresh DB user per app instance, with a lease | Rotation for some integrations; syncs to other platforms |
| Fits when | You are on AWS | Multi-cloud, on-prem, or you want dynamic credentials | Small teams that want one place for every environment |
| Note | Price (14 Oct 2026): $0.40 per secret per month, $0.05 per 10,000 API calls | Vault moved to the source-available BSL licence in 2023; OpenBao is the open-source fork under the Linux Foundation | Check current plans |

A worked cost example, computed with code: 12 secrets × 3 environments = 36 secrets = **$14.40 per month**. Six pods that re-read every 2 minutes make 129,600 calls a month = **$0.65**. But an app that fetches the secret from the API **on every request** at 200 requests per second makes 518 million calls = **$2,592 per month**, plus a network call on every request. Cache secrets in memory and refresh them on a timer.

#### How the app receives a secret

| Method | How | Good | Bad |
|---|---|---|---|
| Environment variable | `OTP_PEPPER=...` | Simple | Visible to child processes and crash dumps; needs a restart to change |
| **File (our choice)** | `OTP_PEPPER_FILE=/run/secrets/otp_pepper` | Not in the environment; can be re-read without a restart | Needs something to write the file |
| SDK call at boot | App calls the secret manager | No files at all | App needs network and permissions to boot; one more dependency |

Files are what Docker secrets, Kubernetes Secret volumes, the Secrets Store CSI driver and Vault Agent all produce. Our loader supports `NAME_FILE` for every secret. In production it refuses the plain `NAME` form.

#### Rotation

**What it is.** Replacing a secret on a schedule (and on demand, after a leak or when someone leaves), with no downtime. The hard part is the moment of change: the database has the new password, but some app instances still hold the old one.

**Minimal version: why one user has a failure window and two users do not.**

```ts
// minimal/rotation-window.ts — why rotating ONE database password causes failed connections, and two users do not.
// Run: npx tsx minimal/rotation-window.ts
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A fake database that accepts a set of (user, password) pairs, and a secret store the app reads from.
const db = new Map<string, string>();
let secret = { user: "", password: "" };
const connect = () => (db.get(secret.user) === secret.password ? "ok" : "auth failed");

// The app opens a new connection every 10 ms for 600 ms and counts failures.
async function runApp(): Promise<number> {
  let failures = 0;
  for (let t = 0; t < 60; t++) { if (connect() !== "ok") failures++; await sleep(10); }
  return failures;
}

// Single user: change the password in the database, then the secret store catches up 200 ms later.
db.clear(); db.set("ledger_app", "pw-v1"); secret = { user: "ledger_app", password: "pw-v1" };
const single = runApp();
await sleep(200); db.set("ledger_app", "pw-v2");           // 1. database changed
await sleep(200); secret = { user: "ledger_app", password: "pw-v2" }; // 2. secret updated, too late
console.log("single user:     failed connections =", await single);

// Alternating users: prepare the idle user first, switch the secret, retire the old user afterwards.
db.clear(); db.set("ledger_app_blue", "pw-v1"); db.set("ledger_app_green", "pw-old");
secret = { user: "ledger_app_blue", password: "pw-v1" };
const alternating = runApp();
await sleep(200); db.set("ledger_app_green", "pw-v2");       // 1. new password on the IDLE user
await sleep(200); secret = { user: "ledger_app_green", password: "pw-v2" }; // 2. switch; blue still valid
await sleep(150); db.set("ledger_app_blue", "revoked");      // 3. retire blue once nobody uses it
console.log("alternating:     failed connections =", await alternating);
```

**Real output:**

```text
single user:     failed connections = 15
alternating:     failed connections = 0
```

**What to notice**
- **Single user:** between "database changed" and "secret updated", every new connection fails. AWS's own docs say the same thing about their single-user strategy: there is "a short period of time" when calls can be denied.
- **Alternating users** (AWS's name for it): there are two logins. You change the password of the **idle** one, point the secret at it, and retire the old one only after nobody uses it. For a while, **two valid credentials exist at once**. That is the whole trick.

PostgreSQL allows only one password per role, which is why we use two login roles. Both are members of one `NOLOGIN` role that holds the permissions. (MySQL 8 can keep two passwords on one account during a change; Postgres cannot.) Vault's **dynamic secrets** go one step further: each app instance gets its own short-lived user, so "rotation" becomes "expiry".

The lab runs this against real Postgres under live traffic: the single-user rotation failed 157 queries; the alternating-users rotation failed 0 out of 2,656.

#### Least privilege

- The app's database user can read and write the ledger tables. It cannot create or drop tables; a separate migration user does that.
- Permissions sit on a `NOLOGIN` group role (`ledger_app`). The blue and green login users only inherit them, so the two can never drift apart. (AWS warns about exactly this drift when it clones the user.)
- The app's IAM role can read **its own** secrets, not every secret in the account.
- Each environment has its own secrets. A staging key must not work in production.

#### Scanning with gitleaks

gitleaks scans files and git history for secrets, using a large set of built-in rules plus your own. We run it in two places:
- **Pre-commit hook:** scans only staged changes, in well under a second. It stops most leaks on the laptop, but anyone can skip it with `git commit --no-verify`.
- **CI on every push and PR:** cannot be skipped. It checks out **full** history (`fetch-depth: 0`), because a secret added and removed in two commits is still leaked.

GitHub's **push protection** is a third layer: it rejects a push that contains a known provider's token format.

Give your own keys a **prefix**, like `lk_live_` and `lk_test_` on our platform. Stripe (`sk_live_`) and GitHub (`ghp_`) do the same. A prefix makes a custom scanning rule exact, with no false alarms on random strings.

As of October 2026, the gitleaks README says the project is "feature complete" and that future releases will be security patches only. It still works well as a scanner. Re-check its status when you set up a new repo.

### 8. Request limits

**What it is.** Limits on how big, how deep and how slow a request may be. Each one blocks a cheap way to make the server do expensive work, which is the core of a **denial of service** (DoS) attack. Each limit also needs a clear status code, so honest clients know what went wrong.

**Minimal version 1: depth, not size.**

```ts
// minimal/json-depth.ts — a small body can still be a big problem: deeply nested JSON.
// Run: npx tsx minimal/json-depth.ts
const depth = 30_000;
const body = "[".repeat(depth) + "]".repeat(depth); // 60,000 bytes: under a 64 KiB body limit

let t = performance.now();
const parsed: unknown = JSON.parse(body);
console.log(`JSON.parse of ${body.length} bytes, depth ${depth}: ok in ${(performance.now() - t).toFixed(1)} ms`);

// Any recursive code that walks the value later (hashing, logging, canonicalising) can blow the stack.
const walk = (v: unknown): number => (Array.isArray(v) ? 1 + Math.max(0, ...v.map(walk)) : 0);
try { walk(parsed); } catch (e) { console.log("recursive walk:", (e as Error).name, (e as Error).message); }
try { JSON.stringify(parsed); console.log("JSON.stringify: ok"); } catch (e) { console.log("JSON.stringify:", (e as Error).message); }

// Fix: measure nesting on the RAW text before parsing. One pass, no recursion, strings skipped.
function maxDepth(text: string): number {
  let deepest = 0, current = 0, inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (inString) {
      if (c === 92) i++;                 // backslash: skip the escaped character
      else if (c === 34) inString = false; // closing quote
    } else if (c === 34) inString = true;
    else if (c === 91 || c === 123) deepest = Math.max(deepest, ++current); // [ or {
    else if (c === 93 || c === 125) current--;                              // ] or }
  }
  return deepest;
}
t = performance.now();
console.log(`maxDepth scan: ${maxDepth(body)} in ${(performance.now() - t).toFixed(2)} ms -> reject anything over 20`);
console.log("brackets inside strings are ignored:", maxDepth('{"note":"[[[[[["}'));
```

**Real output:**

```text
JSON.parse of 60000 bytes, depth 30000: ok in 7.2 ms
recursive walk: RangeError Maximum call stack size exceeded
JSON.stringify: Maximum call stack size exceeded
maxDepth scan: 30000 in 3.73 ms -> reject anything over 20
brackets inside strings are ignored: 1
```

**What to notice**
- `JSON.parse` itself coped with 30,000 levels here. The crash came **later**, in normal-looking recursive code and even in `JSON.stringify`.
- The depth scan runs on the raw text in about 4 ms for 60,000 bytes, with no recursion. It ignores brackets inside strings.

**Minimal version 2: when does a slow client get a 408?** A real surprise from building the lab.

```ts
// minimal/request-timeout.ts — a slow client promises 100 bytes, sends 1 and waits. When does the server give up?
// Run: npx tsx minimal/request-timeout.ts   (takes about 10 seconds)
import http from "node:http";
import net from "node:net";

async function slowClient(headersTimeout: number): Promise<string> {
  const server = http.createServer({ connectionsCheckingInterval: 1000 }, (req, res) => { req.resume(); req.on("end", () => res.end()); });
  server.requestTimeout = 1000; // set after creation, exactly like Fastify does
  server.headersTimeout = headersTimeout;
  await new Promise<void>((r) => server.listen(0, r));
  const { port } = server.address() as net.AddressInfo;
  const started = Date.now();
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1", () => socket.write("POST / HTTP/1.1\r\nHost: x\r\nContent-Length: 100\r\n\r\n{"));
    let reply = "";
    socket.on("data", (d) => { reply += d.toString(); });
    socket.on("close", () => {
      server.close();
      resolve(`requestTimeout=1000 headersTimeout=${headersTimeout}: "${reply.split("\r\n")[0]}" after ${Date.now() - started} ms`);
    });
  });
}

console.log(await slowClient(1000)); // what we meant
console.log(await slowClient(6000)); // stand-in for Node's default of 60000: the larger value wins
```

**Real output:**

```text
requestTimeout=1000 headersTimeout=1000: "HTTP/1.1 408 Request Timeout" after 2007 ms
requestTimeout=1000 headersTimeout=6000: "HTTP/1.1 408 Request Timeout" after 6008 ms
```

**What to notice**
- Node checks timeouts on a timer (`connectionsCheckingInterval`, 30 s by default), so a 408 arrives up to one interval **after** the limit.
- If `headersTimeout` is larger than `requestTimeout`, Node effectively uses the **larger** one for the whole request. Fastify sets `requestTimeout` **after** it creates the server, so Node's `headersTimeout` stays at its 60-second default. Result: with Fastify, `requestTimeout: 10_000` alone behaves like 60 seconds. Set `http.headersTimeout` to the same value (our `app.ts` does).

And the defaults, printed in this sandbox. **Real output:**

```text
Node v22.22.0: requestTimeout=300000 headersTimeout=60000 maxHeaderSize=16384
Fastify 5.12.7: requestTimeout=0 headersTimeout=60000 bodyLimit=1048576
```

Fastify's default `requestTimeout` is **0**, which means off, and its default body limit is 1 MiB. Neither is a safe default for a public payments API.

**Our limits.**

| Limit | Our value | Default | Answer | Layer | What it stops |
|---|---|---|---|---|---|
| Header block size | 16 KiB | Node 16 KiB | 431 | Node | Huge cookies and headers eating memory |
| Time to receive headers | 10 s | Node 60 s | 408 | Node | Slowloris: headers sent one byte at a time |
| Time to receive the whole request | 10 s | Fastify 0 (off) | 408 | Node | Slow bodies that hold sockets open |
| Body size | 64 KiB | Fastify 1 MiB | 413 | Fastify | Memory and parse time per request |
| Content type | JSON only | JSON and `text/plain` | 415 | Fastify parser | Simple cross-site POSTs (no preflight) |
| JSON nesting depth | 20 | none | 400 `JSON_TOO_DEEP` | Our parser | Stack overflows in recursive code |
| `__proto__`, `constructor.prototype` keys | refused | refused | 400 `MALFORMED_JSON` | secure-json-parse | Prototype poisoning |
| Field lengths, array sizes | per field | none | 400 | Zod | Oversized values reaching the DB and SMS |
| Query time in Postgres | 5 s | none | 500 | `statement_timeout` | One slow query holding a connection |
| Requests per client | (P3-04) | none | 429 | Rate limiter | Floods |

Why 64 KiB? Our largest legitimate JSON body is a transfer: 184 bytes for a typical one, 592 bytes at its maximum (a 140-character Devanagari note, measured with `Buffer.byteLength`). 64 KiB leaves lots of headroom and still keeps memory per request small. File uploads should not pass through the JSON API at all: the client uploads directly to object storage with a pre-signed URL.

Put the same kind of limits on the load balancer or reverse proxy too (for example nginx `client_max_body_size` and `client_body_timeout`). The app keeps its own limits because internal traffic does not always pass through the proxy.

**Trade-off.** Every limit can block a legitimate user someday: a statement note in a long script, a slow 2G connection in a lift. Pick values from real traffic (P1-08 adds the metrics), return clear codes, and treat a spike in 413 or 408 as a signal worth looking at.

---

## ⚖️ Comparisons and trade-offs

**Schema libraries for a Fastify API**

| | Zod 4 (this card) | TypeBox | Plain JSON Schema (Ajv) |
|---|---|---|---|
| TypeScript types | Inferred from the schema | Inferred from the schema | Hand-written or generated |
| Transforms (trim, E.164, brands) | Yes, built in | No, validation only | No (Ajv can coerce, not transform) |
| Fastify integration | Custom compilers (about 40 lines) or a community type-provider package | Official type provider; it **is** JSON Schema | Built in |
| Speed | Fast enough (about 1.8 µs for our response schema) | Fast (compiled by Ajv) | Fast (compiled) |
| OpenAPI | `z.toJSONSchema()` | Already JSON Schema | Already JSON Schema |
| Pick it when | You want parsing and normalisation in one place | You want JSON Schema with good types | Your schemas come from a spec generator |

**Unknown-field handling**, from Deep dive 1: strict for input, strip for output, loose for headers.

**Ways to deliver a secret**, from Deep dive 7: environment variable (simple, leaky), file (our choice), SDK call (no files, more moving parts).

**Rotation strategies**

| | Single user | Alternating users | Dynamic secrets (Vault) |
|---|---|---|---|
| Valid credentials during change | One (the window is the risk) | Two | One per app instance |
| Failed queries in our lab | **157** | **0** | not run here |
| Needs | Nothing extra | Two login roles, one permission role | A Vault server and a database secrets engine |
| Good for | Ad hoc and human users | Apps that must stay up | Large fleets; per-instance audit |

**Where secret scanning runs**

| | Pre-commit hook | CI job | GitHub push protection |
|---|---|---|---|
| When | Before a commit exists | On every push and PR | During `git push` |
| Can be skipped | Yes (`--no-verify`) | No (if the check is required) | Bypass with a stated reason, unless the org requires approval |
| Sees | Staged changes | Full history | The pushed commits |
| Custom rules | Yes | Yes | Depends on your GitHub plan |

---

## 🚶 Walkthrough on the ledger platform: Riya's ₹500 with a messy note

Riya Traders pays Amit Stores ₹500 for rent. Her app sends:

```json
{ "sourceWalletId": "…riya…", "destinationWalletId": "…amit…", "amountMinor": 50000, "currency": "INR", "note": "  Rent​ for Oct  " }
```

The note has leading and trailing spaces and an invisible zero-width space, pasted from a chat app.

1. **Bytes arrive.** Node reads the headers (under 16 KiB) and starts its clocks: headers and body must arrive within 10 s.
2. **Authenticate** (`onRequest`, P1-05): the bearer token becomes Riya's principal.
3. **Parse the body.** It is `application/json`, 184 bytes (under 64 KiB), nested 1 level deep (under 20), with no `__proto__` keys.
4. **Validate the shape** (Zod, validation phase). The body is a strict object: both wallet IDs are UUIDs and become `WalletId`s; `amountMinor` is a whole number between 1 and 100,000,000,000; `currency` is exactly `"INR"`. The note is normalised: NFC, the zero-width space removed, trimmed to `"Rent for Oct"`, then length-checked.
5. **Authorise** (`preHandler`): Riya owns the source wallet (P1-05).
6. **Claim the idempotency key** (P1-03). The request hash is taken over the **parsed** body, so a retry whose note differs only in spacing counts as the same request.
7. **Step-up check:** ₹500 is below the ₹10,000 threshold, so no OTP is needed.
8. **Handler and service.** No re-validation. The service checks only what needs current data, inside the transaction: wallets differ, neither is frozen, enough balance. It writes the ledger rows.
9. **Response schema.** The handler returns the transfer object. `TransferResponse` keeps the 8 public fields and drops anything else.
10. **Leak guard and logs.** The JSON contains no hash or key shapes, so `201 Created` goes out. The log line has the route, status and request ID. If any code ever logs the headers or a body, the `authorization` header, `idempotency-key` and fields like `password` come out as `[REDACTED]`.

**Diagram: the walkthrough, step by step**

```mermaid
sequenceDiagram
  participant App as Riya's app
  participant API as Node and Fastify
  participant Z as Zod schemas
  participant S as Transfer service
  participant DB as Postgres
  App->>API: 1. POST /v1/transfers (184 bytes)
  API->>API: 2. authenticate, 3. parse JSON
  API->>Z: 4. Validate body, normalise note
  Z-->>API: typed body, note = Rent for Oct
  API->>API: 5. authorize, 6. claim key, 7. step-up
  API->>S: 8. createTransfer(parsed body)
  S->>DB: lock, check balance, insert
  DB-->>S: committed
  S-->>API: transfer object
  API->>Z: 9. Response schema (allowlist)
  API->>API: 10. Leak guard, redacted log
  API-->>App: 201 Created
```

**How to read this diagram.** Time runs downwards. The numbers match the list above. Notice where Zod appears: once on the way in (step 4) and once on the way out (step 9). The service in the middle receives values that are already typed and normalised, so it does not check shapes again. It only checks rules that need the database.

---

## 🧪 Hands-on lab

You will harden the ledger API from P1-03 and P1-05 in the six steps the card asks for. All product code below was type-checked with TypeScript 5.9 in strict mode and tested against PostgreSQL 16.15 while writing this guide: **142 tests in 11 files, all passing**.

**Prerequisites:** the P1-05 lab (or the P1-03 lab plus P1-05's `authenticate` and `authorize`), Node 22+, Docker, Python 3.11+ (only for the gitleaks rule check), and gitleaks installed locally (`brew install gitleaks`, or a release binary from GitHub).

**What changes in the project** (new files marked `+`, changed files `~`):

```text
ledger-api/
├── .gitleaks.toml                          + custom rule for lk_live_ keys
├── .husky/pre-commit                       + gitleaks on staged changes, fails closed
├── .github/workflows/gitleaks.yml          + full-history scan on every push and PR
├── .gitignore  .env.example                + / ~
├── openapi/openapi.yaml                    ~ /v1/me, auth routes, 5 drift fixes (step 1)
├── scripts/check-gitleaks-config.py        + tests the custom rule's regex
├── src/
│   ├── app.ts                              ~ limits, compilers, parser, leak guard
│   ├── config/{loadConfig,env}.ts          + / ~ typed config, fail fast
│   ├── db/{databaseSecret,rotatingPool,pool}.ts  + / + / ~
│   ├── domain/statementPeriod.ts           + parse, don't validate
│   ├── http/{zodCompilers,routeContracts,jsonBodyParser,leakGuard}.ts  +
│   ├── lib/logger.ts                       + pino with redaction
│   ├── repositories/userRepository.ts      +
│   ├── routes/*.ts                         ~ every route: schema {...} instead of validate()
│   ├── routes/me.ts                        + GET /v1/me, PATCH /v1/me/phone
│   └── schemas/{common,responses}.ts       +
└── test/{contract,validation,responseLeak,config,limits,rotation}.test.ts  +
```

**`docker-compose.yml`** (the same as P1-03; the official image already requires a password for TCP connections, which the rotation step needs):

```yaml
services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: ledger
    ports: ["5432:5432"]
```

**Install the two new dependencies:**

```bash
npm install libphonenumber-js secure-json-parse
npm install -D husky
npx husky init        # creates .husky/; replace .husky/pre-commit with the file in step 4
```

Plumbing that is not printed: `src/lib/problem.ts` (P1-03), `src/authz/*` and `src/auth/*` (P1-05), test helpers `test/helpers/{db,auth}.ts` (reset the schema, seed Riya, Priya, Amit and Lakshmi, log in), and the parts of each route that did not change.

### Step 1 · Zod schemas for every route, checked against OpenAPI

**1a. Shared building blocks.** `src/schemas/common.ts` defines each kind of field once.

```ts
// src/schemas/common.ts — building blocks every route schema uses. One definition, one behaviour, everywhere.
import { parsePhoneNumberWithError } from "libphonenumber-js";
import { z } from "zod";

// --- machine fields: exact formats, no guessing, no case-folding ---
export const Uuid = z.uuid();
export const WalletId = z.uuid().brand<"WalletId">(); // only a parsed value can be a WalletId
export type WalletId = z.infer<typeof WalletId>;
export const AmountMinor = z.int().min(1).max(100_000_000_000); // paise: integers only, never floats
export const Currency = z.enum(["INR"]);
export const IsoDateTime = z.iso.datetime();

// --- human fields: normalise what people type, then check it ---
// One Unicode form (NFC), invisible format characters removed, outer spaces trimmed, then limits checked.
export const humanText = (max: number) =>
  z.string()
    .max(max * 2) // cheap guard before any work on huge input
    .normalize("NFC")
    .overwrite((s) => s.replace(/\p{Cf}/gu, ""))
    .trim()
    .min(1)
    .max(max)
    .regex(/^[^\p{Cc}]*$/u, "must not contain control characters");

// Normalise first, then check. A pipe's JSON Schema shows only its input side, so meta() restores "format".
export const Email = z.string().max(254).trim().toLowerCase().pipe(z.email()).meta({ format: "email" });

// Indian users type numbers many ways ("98765 43210", "098765 43210", "+91 98765-43210"). Store one: E.164.
export const PhoneInput = z.string().max(32).transform((raw, ctx) => {
  try {
    const phone = parsePhoneNumberWithError(raw, "IN");
    if (phone.isValid()) return phone.number;
  } catch {
    // fall through to the issue below
  }
  ctx.issues.push({ code: "custom", message: "must be a valid phone number", input: raw });
  return z.NEVER;
});

// --- request parts ---
// Query strings are text. Accept digits only (no "", "1e2" or " 5"), then check the range.
export const PageLimit = z.string().regex(/^\d{1,3}$/).transform(Number).pipe(z.int().min(1).max(100)).default(50);

// For POSTs that take no input: nothing, or exactly {}. Anything else is a client bug worth a 400.
export const EmptyBody = z.union([z.null(), z.strictObject({})]);

// Documentation-only response schema for redirects and 204s: there is no body to serialise.
export const NoBody = z.undefined();
```

**What to notice**
- `WalletId` is branded, so `request.body.sourceWalletId` is a `WalletId`, not a `string`.
- `humanText` normalises before it checks length, and a cheap `max(max * 2)` guard runs first so a 60 KB string is not normalised at all.
- `Email` needs `.meta({ format: "email" })`. A pipe's JSON Schema shows only its input side, so without it the contract test reported "format missing" (see 1f).
- `PhoneInput` turns any common Indian spelling into E.164, or fails with one clear message.

**1b. Plug Zod into Fastify.** `src/http/zodCompilers.ts`:

```ts
// src/http/zodCompilers.ts — teach Fastify to validate requests and serialise responses with Zod.
import type { FastifyInstance, FastifySchema } from "fastify";
import type { z } from "zod";
import { errors, type FieldError } from "../lib/problem.js";

type HttpPart = "body" | "querystring" | "params" | "headers";

function toFieldErrors(part: HttpPart, issues: z.core.$ZodIssue[]): FieldError[] {
  return issues.flatMap((issue) => {
    // An unknown key is reported on the parent object; point at each key instead.
    const paths = issue.code === "unrecognized_keys"
      ? issue.keys.map((k) => [...issue.path.map(String), k])
      : [issue.path.map(String)];
    const detail = issue.code === "unrecognized_keys" ? "Unknown field" : issue.message;
    return paths.map((path) => (part === "body"
      ? { detail, pointer: `#/${path.join("/")}` }
      : { detail, parameter: path.join(".") || part }));
  });
}

export function registerZodCompilers(app: FastifyInstance): void {
  // Runs in Fastify's validation phase: after authentication (onRequest), before authorisation (preHandler).
  app.setValidatorCompiler<z.ZodType>(({ schema, httpPart }) => (data) => {
    const result = schema.safeParse(data);
    if (result.success) return { value: result.data }; // handlers receive the PARSED value, not the raw one
    return { error: errors.validation(toFieldErrors(httpPart as HttpPart, result.error.issues)) };
  });

  // Responses: parse the handler's value with the route's schema. z.object() drops every key it does not
  // name, so a field nobody listed (password_hash, kyc_pan...) can never reach the client.
  app.setSerializerCompiler<z.ZodType>(({ schema, url, method }) => (data) => {
    const result = schema.safeParse(data);
    if (!result.success) {
      // Fail closed: a response that breaks its own contract is a bug, not something to send half-checked.
      throw new Error(`response for ${method} ${url} does not match its schema: ${result.error.issues[0]?.message}`);
    }
    return JSON.stringify(result.data);
  });
}

export type RouteSchema = FastifySchema & {
  body?: z.ZodType; querystring?: z.ZodType; params?: z.ZodType; headers?: z.ZodType;
  response?: Record<number, z.ZodType>;
};
```

**What to notice**
- The validator **returns** `{ value }` or `{ error }` (Fastify's contract). Returning `value` is what makes handlers receive parsed data.
- Unknown keys become one error per key (`#/fee: Unknown field`), so a client sees exactly what to remove.
- The serializer **throws** when a response breaks its schema. The error handler turns that into a generic 500, and the details go only to the log.

**1c. No schema, no start.** The same trick as P1-05's access rules: an `onRoute` hook checks every route as it is registered.

```ts
// src/http/routeContracts.ts — every route must declare what it accepts and what it returns, or the app won't start.
import type { FastifyInstance, RouteOptions } from "fastify";
import type { RouteSchema } from "./zodCompilers.js";

export interface RegisteredRoute { method: string; url: string; schema: RouteSchema }

// The contract test reads this table and compares it with openapi.yaml.
export const routeTable: RegisteredRoute[] = [];

const BODY_METHODS = new Set(["POST", "PUT", "PATCH"]);

export function enforceRouteContracts(app: FastifyInstance): void {
  app.addHook("onRoute", (route: RouteOptions) => {
    const methods = (Array.isArray(route.method) ? route.method : [route.method]).filter((m) => m !== "HEAD");
    const schema = (route.schema ?? {}) as RouteSchema;
    for (const method of methods) {
      const name = `${method} ${route.url}`;
      const missing: string[] = [];
      if (route.url.includes(":") && !schema.params) missing.push("params");
      if (BODY_METHODS.has(method) && !schema.body) missing.push("body (use EmptyBody when there is none)");
      if (!schema.response || Object.keys(schema.response).length === 0) missing.push("response");
      if (missing.length) throw new Error(`${name} has no schema for: ${missing.join(", ")}`);
      routeTable.push({ method, url: route.url, schema });
    }
  });
}
```

**What to notice**
- It runs at **startup**, not per request. A forgotten schema is found before the first deploy, not by a customer.
- `routeTable` is the input for the contract test in 1f.

**1d. A route after the change.** `src/routes/transfers.ts` in full:

```ts
// src/routes/transfers.ts — POST /v1/transfers: every input part has a schema, and so does the response.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authorize, fromBody } from "../authz/authorize.js";
import type { components } from "../generated/api.js";
import { requireIdempotency } from "../plugins/idempotency.js";
import { AmountMinor, Currency, humanText, WalletId } from "../schemas/common.js";
import { TransferResponse } from "../schemas/responses.js";
import { createTransfer } from "../services/transferService.js";
import { requireStepUpForLargeTransfers } from "../stepUp/requireStepUp.js";

type CreateTransferRequest = components["schemas"]["CreateTransferRequest"];

// strictObject: an unknown field is a client bug (or a probe), so it is a 400, never silently ignored.
export const createTransferBody = z.strictObject({
  sourceWalletId: WalletId,
  destinationWalletId: WalletId,
  amountMinor: AmountMinor,
  currency: Currency,
  note: humanText(140).optional(),
}) satisfies z.ZodType<CreateTransferRequest>;

export async function transferRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: z.infer<typeof createTransferBody> }>("/v1/transfers", {
    config: { access: { kind: "resource", action: "transfer:create", sensitive: true } },
    schema: { body: createTransferBody, response: { 201: TransferResponse } },
    // Fastify validated the body before these run: authorize() and the rest see parsed, typed values.
    preHandler: [authorize("transfer:create", fromBody("wallet", "sourceWalletId")), requireIdempotency, requireStepUpForLargeTransfers],
  }, async (request, reply) => {
    const claim = request.idempotencyClaim;
    if (!claim) throw new Error("route is missing the requireIdempotency preHandler");
    const path = request.url.split("?")[0] ?? request.url;
    const response = await createTransfer(request.body, claim, { path, requestId: request.id, log: request.log });
    return reply.code(response.status).headers(response.headers).send(response.body);
  });
}
```

The list route's query schema (`src/routes/transactions.ts`, excerpt):

```ts
const params = z.strictObject({ walletId: Uuid });
const query = z.strictObject({
  limit: PageLimit, // same name and bounds on every list
  cursor: z.string().max(512).optional(),
  direction: z.enum(["debit", "credit"]).optional(),
});

export async function transactionRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: z.infer<typeof params>; Querystring: z.infer<typeof query> }>(
    "/v1/wallets/:walletId/transactions",
    {
      config: { access: { kind: "resource", action: "wallet:read" } },
      schema: { params, querystring: query, response: { 200: TransactionPageSchema } },
      preHandler: [authorize("wallet:read", fromParam("wallet", "walletId"))],
    },
```

The statement export, where shape parsing (schema) and domain parsing (period rules) meet (`src/routes/statementExports.ts`, excerpt):

```ts
const params = z.strictObject({ walletId: Uuid });
const body = z.strictObject({ from: z.iso.date(), to: z.iso.date(), format: z.enum(["pdf", "csv"]) });
const toApi = (r: ExportRow): StatementExport => ({
  id: r.id, walletId: r.wallet_id, status: r.status, downloadUrl: r.download_url,
  failureReason: r.failure_reason, createdAt: r.created_at.toISOString(),
});

export async function statementExportRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: z.infer<typeof params>; Body: z.infer<typeof body> }>(
    "/v1/wallets/:walletId/statement-exports",
    {
      config: { access: { kind: "resource", action: "export:create" } },
      schema: { params, body, response: { 202: StatementExportResponse } },
      preHandler: [authorize("export:create", fromParam("wallet", "walletId")), requireIdempotency],
    },
    async (request, reply) => {
      const claim = request.idempotencyClaim;
      if (!claim) throw new Error("route is missing the requireIdempotency preHandler");
      const path = request.url.split("?")[0] ?? request.url;
      const response = await runIdempotent(claim, request.log, async (client) => {
        const wallet = await client.query("SELECT 1 FROM wallets WHERE id = $1", [request.params.walletId]);
        if (wallet.rowCount !== 1) return problemResponse(errors.walletNotFound(), path, request.id);
        // Parse once into a domain value. Rules that need both dates (and today) live here, not in the schema.
        const period = parseStatementPeriod(request.body, new Date());
        if (!period.ok) return problemResponse(period.error, path, request.id); // stored, so a retry gets the same 422
        const { rows: [row] } = await client.query<ExportRow>(
          `INSERT INTO statement_exports (wallet_id, period_from, period_to, format)
           VALUES ($1, $2, $3, $4) RETURNING id, wallet_id, status, download_url, failure_reason, created_at`,
          [request.params.walletId, period.value.from, period.value.to, request.body.format],
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
```

And the domain parser it calls, `src/domain/statementPeriod.ts`:

```ts
// src/domain/statementPeriod.ts — parse, don't validate: once you hold a StatementPeriod, it is a valid one.
import { ApiError } from "../lib/problem.js";

declare const valid: unique symbol;
// Only parseStatementPeriod can create this type: the brand cannot be written by hand.
export type StatementPeriod = { readonly from: string; readonly to: string; readonly days: number } & { readonly [valid]: true };
export type Parsed<T> = { ok: true; value: T } | { ok: false; error: ApiError };

const MAX_DAYS = 366;
const DAY_MS = 86_400_000;

// The schema already proved both are real calendar dates. These rules need BOTH fields, and today's date.
export function parseStatementPeriod(input: { from: string; to: string }, today: Date): Parsed<StatementPeriod> {
  const from = Date.parse(`${input.from}T00:00:00Z`);
  const to = Date.parse(`${input.to}T00:00:00Z`);
  const days = (to - from) / DAY_MS + 1;
  const reject = (detail: string): Parsed<StatementPeriod> =>
    ({ ok: false, error: new ApiError(422, "INVALID_PERIOD", "Statement period is not allowed", detail) });

  if (to < from) return reject("`to` must be on or after `from`.");
  if (to > today.getTime()) return reject("`to` cannot be in the future.");
  if (days > MAX_DAYS) return reject(`A statement covers at most ${MAX_DAYS} days.`);
  return { ok: true, value: { from: input.from, to: input.to, days } as StatementPeriod };
}
```

**What to notice**
- `validate()` preHandlers are gone. `schema: {...}` declares everything, and `preHandler` keeps only authorisation and idempotency.
- The schema proves both dates are real calendar dates (400 if not). The domain parser checks the rules that need **both** dates and **today** (422). Neither checks the other's job.
- The 422 is returned **inside** `runIdempotent`, so it is stored under the idempotency key. A retry gets the same 422 (P1-03's rule: store business-rule failures, not just successes).

**1e. Wiring, in order.** `src/app.ts`:

```ts
// src/app.ts — builds the Fastify app. Access rules are enforced before any route is registered.
import { randomUUID } from "node:crypto";
import cookie from "@fastify/cookie";
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import "./auth/types.js";
import { enforceAccessRules } from "./authz/accessRules.js";
import { env } from "./config/env.js";
import { registerJsonBodyParser } from "./http/jsonBodyParser.js";
import { registerLeakGuard } from "./http/leakGuard.js";
import { enforceRouteContracts } from "./http/routeContracts.js";
import { registerZodCompilers } from "./http/zodCompilers.js";
import { logger } from "./lib/logger.js";
import { logOtpSender, type OtpSender } from "./notify/otpSender.js";
import { googleLoginRoutes } from "./oidc/googleLogin.js";
import { registerErrorHandler } from "./plugins/errorHandler.js";
import { authRoutes } from "./routes/auth.js";
import { meRoutes } from "./routes/me.js";
import { refundRoutes } from "./routes/refunds.js";
import { statementExportRoutes } from "./routes/statementExports.js";
import { stepUpRoutes } from "./routes/stepUp.js";
import { transactionRoutes } from "./routes/transactions.js";
import { transferReadRoutes } from "./routes/transferRead.js";
import { transferRoutes } from "./routes/transfers.js";
import { walletRoutes } from "./routes/wallets.js";

export interface AppDeps { otpSender?: OtpSender; extraRoutes?: (app: FastifyInstance) => Promise<void> }

// pino's Logger is a FastifyBaseLogger; widening here keeps every plugin's FastifyInstance type the same.
const appLogger: FastifyBaseLogger = logger;

export async function buildApp(deps: AppDeps = {}): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: appLogger, // pino with redaction of secrets and PII (src/lib/logger.ts)
    genReqId: () => randomUUID(),
    // Request limits are DoS defences, so they are config, not magic numbers.
    bodyLimit: env.BODY_LIMIT_BYTES, // larger bodies get 413 while streaming, before parsing
    requestTimeout: env.REQUEST_TIMEOUT_MS, // whole request must arrive in this time, else 408 (slow-body attack)
    // Not connectionTimeout: that idle-socket timer drops the socket with no response at all, no 408.
    http: {
      // Fastify sets requestTimeout AFTER creating the server, so Node's headersTimeout stays at 60 s.
      // When headersTimeout > requestTimeout, Node uses the larger one: our 10 s would really be 60 s.
      headersTimeout: env.REQUEST_TIMEOUT_MS,
      maxHeaderSize: 16 * 1024, // Node's default, written down: bigger header blocks get 431
      connectionsCheckingInterval: 2_000, // how often Node checks those timeouts (default 30 s is too loose)
    },
    // Behind a load balancer set TRUST_PROXY, or request.ip is the LB for everyone
    // (and per-IP login limits lock out the whole country at once).
    trustProxy: env.TRUST_PROXY,
  });

  app.decorateRequest("principal", null);
  app.decorateRequest("idempotencyClaim", null);
  app.decorate("otpSender", deps.otpSender ?? logOtpSender(app.log));
  app.addHook("onRequest", async (request, reply) => { reply.header("x-request-id", request.id); });

  registerErrorHandler(app);
  registerZodCompilers(app); // request validation + response whitelisting with Zod
  registerJsonBodyParser(app, { maxDepth: env.JSON_MAX_DEPTH });
  registerLeakGuard(app, env.LEAK_GUARD);
  await app.register(cookie);
  enforceAccessRules(app); // must come BEFORE every route below
  enforceRouteContracts(app); // ...and so must this: no schema, no start

  await app.register(authRoutes);
  await app.register(googleLoginRoutes);
  await app.register(stepUpRoutes);
  await app.register(walletRoutes);
  await app.register(transactionRoutes);
  await app.register(transferRoutes);
  await app.register(transferReadRoutes);
  await app.register(refundRoutes);
  await app.register(statementExportRoutes);
  await app.register(meRoutes);
  if (deps.extraRoutes) await app.register(deps.extraRoutes); // tests only
  return app;
}
```

**What to notice**
- `enforceAccessRules` and `enforceRouteContracts` are added **before** any route plugin. `onRoute` hooks only see routes registered after them.
- Every limit comes from typed config. The comments record the two timeout surprises from Deep dive 8.

**1f. The contract test.** It reads `openapi.yaml`, resolves `$ref`s, converts each route's Zod schemas with `z.toJSONSchema()`, and compares field by field: types, required fields, enums, lengths, formats, and whether unknown fields are rejected. Request bodies are compared on the **input** side (what clients send). Responses and parameters are compared on the **output** side (what the server produces).

```ts
// test/contract.test.ts — the Zod schemas in code and openapi.yaml must describe the same API.
import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { parse } from "yaml";
import { afterAll, beforeAll, expect, it } from "vitest";
import { z } from "zod";
import { buildApp } from "../src/app.js";
import { pool } from "../src/db/pool.js";
import { routeTable } from "../src/http/routeContracts.js";
import { EmptyBody } from "../src/schemas/common.js";
import { diffSchemas, resolveRefs } from "./helpers/schemaDiff.js";

type Json = Record<string, unknown>;
interface Param { name: string; in: string; required?: boolean; schema: Json }
interface Operation { parameters?: Param[]; requestBody?: { content: Record<string, { schema: Json }> }; responses: Record<string, { content?: Record<string, { schema: Json }> }> }

// Differences we accept on purpose. Each one needs a reason a reviewer agrees with.
const KNOWN_DIFFERENCES: Record<string, string> = {
  "POST /v1/transfers header": "Idempotency-Key is owned by requireIdempotency (P1-03): its own 400 codes, which clients switch on",
  "POST /v1/wallets/{walletId}/statement-exports header": "Idempotency-Key: same as above",
  "PATCH /v1/wallets/{walletId} header": "If-Match is owned by the handler: missing gives 428, stale gives 412 (P1-03)",
  "POST /v1/accounts:": "in the spec since P1-03, not built in this lab yet",
  "GET /v1/accounts/{accountId}:": "in the spec since P1-03, not built in this lab yet",
  "POST /v1/accounts/{accountId}/wallets:": "in the spec since P1-03, not built in this lab yet",
  "GET /v1/transfers:": "in the spec since P1-03, not built in this lab yet",
};

const raw = parse(readFileSync(new URL("../openapi/openapi.yaml", import.meta.url), "utf8")) as Json;
const spec = resolveRefs(raw, raw) as { paths: Record<string, Record<string, Operation>> };
const asJson = (s: z.ZodType, io: "input" | "output") => z.toJSONSchema(s, { io, unrepresentable: "any" }) as Json;
// Parameters: compare the parsed types (output), but "required" from the input side: a default makes it optional.
const asParamJson = (s: z.ZodType): Json => ({ ...asJson(s, "output"), required: asJson(s, "input").required ?? [] });
const toObject = (params: Param[]): Json => ({
  type: "object",
  properties: Object.fromEntries(params.map((p) => [p.in === "header" ? p.name.toLowerCase() : p.name, p.schema])),
  required: params.filter((p) => p.required).map((p) => (p.in === "header" ? p.name.toLowerCase() : p.name)),
});

let app: FastifyInstance;
beforeAll(async () => { app = await buildApp(); await app.ready(); });
afterAll(async () => { await app.close(); await pool.end(); });

function compareRoute(method: string, specPath: string, op: Operation, schema: (typeof routeTable)[number]["schema"]): string[] {
  const name = `${method} ${specPath}`;
  const out: string[] = [];
  const params = op.parameters ?? [];
  for (const part of ["path", "query", "header"] as const) {
    const specParams = params.filter((p) => p.in === part);
    const codeSchema = { path: schema.params, query: schema.querystring, header: schema.headers }[part];
    if (!specParams.length && !codeSchema) continue;
    out.push(...diffSchemas(`${name} ${part}`, toObject(specParams), codeSchema ? asParamJson(codeSchema) : { type: "object" }, { strictObjects: false }));
  }
  const specBody = op.requestBody?.content["application/json"]?.schema;
  if (specBody && schema.body) out.push(...diffSchemas(`${name} body`, specBody, asJson(schema.body, "input"), { strictObjects: true }));
  else if (specBody) out.push(`${name} body: in spec, missing from code`);
  else if (schema.body && schema.body !== EmptyBody) out.push(`${name} body: in code, missing from spec`);

  const codeOk = Object.keys(schema.response ?? {}).filter((s) => s.startsWith("2") || s.startsWith("3"));
  const specOk = Object.keys(op.responses).filter((s) => s.startsWith("2") || s.startsWith("3"));
  for (const status of new Set([...codeOk, ...specOk])) {
    const specSchema = op.responses[status]?.content?.["application/json"]?.schema;
    const codeSchema = schema.response?.[Number(status)];
    if (!op.responses[status]) out.push(`${name} ${status}: in code, missing from spec`);
    else if (!codeSchema) out.push(`${name} ${status}: in spec, missing from code`);
    else if (specSchema) out.push(...diffSchemas(`${name} ${status}`, specSchema, asJson(codeSchema, "output"), { strictObjects: false }));
  }
  return out;
}

it("every route matches openapi.yaml, and every operation in openapi.yaml has a route", () => {
  const drift: string[] = [];
  const seen = new Set<string>();
  for (const route of routeTable) {
    const specPath = route.url.replace(/:(\w+)/g, "{$1}");
    const op = spec.paths[specPath]?.[route.method.toLowerCase()];
    seen.add(`${route.method} ${specPath}`);
    if (!op) { drift.push(`${route.method} ${specPath}: route exists, operation missing from spec`); continue; }
    drift.push(...compareRoute(route.method, specPath, op, route.schema));
  }
  for (const [path, ops] of Object.entries(spec.paths)) {
    for (const method of Object.keys(ops)) {
      if (!seen.has(`${method.toUpperCase()} ${path}`)) drift.push(`${method.toUpperCase()} ${path}: in spec, no route`);
    }
  }
  const unexpected = drift.filter((d) => !Object.keys(KNOWN_DIFFERENCES).some((k) => d.startsWith(k)));
  console.log(`${routeTable.length} routes compared, ${drift.length} differences, ${unexpected.length} unexpected\n${unexpected.join("\n")}`);
  expect(unexpected).toEqual([]);
  // An exception that no longer matches anything is stale: delete it, or it will hide the next real drift.
  expect(Object.keys(KNOWN_DIFFERENCES).filter((k) => !drift.some((d) => d.startsWith(k)))).toEqual([]);
});
```

**What to notice**
- It reads `routeTable`, so a new route is compared automatically. Nobody has to remember to add it.
- Bodies are compared on the **input** side; parameters and responses on the **output** side, with "required" taken from the input side so a `.default()` does not count as required.
- Every `KNOWN_DIFFERENCES` entry needs a written reason, and an entry that stops matching fails the test.

<details>
<summary>The comparison helper, <code>test/helpers/schemaDiff.ts</code> (plumbing, but short)</summary>

```ts
// test/helpers/schemaDiff.ts — compare two JSON Schemas field by field and describe every difference (plumbing).
type Json = Record<string, unknown>;

// Zod writes nullable as anyOf [X, {type:null}]; OpenAPI 3.1 usually writes type: [X, "null"]. Same meaning.
// const: x is enum: [x]. z.int() adds +-2^53 bounds that only mean "safe integer", not a business limit.
function normalise(s: Json): Json {
  if (s.const !== undefined) {
    const { const: c, ...rest } = s;
    return normalise({ ...rest, enum: [c] });
  }
  if (Math.abs(Number(s.maximum)) === Number.MAX_SAFE_INTEGER || Math.abs(Number(s.minimum)) === Number.MAX_SAFE_INTEGER) {
    const copy = { ...s };
    if (Math.abs(Number(copy.maximum)) === Number.MAX_SAFE_INTEGER) delete copy.maximum;
    if (Math.abs(Number(copy.minimum)) === Number.MAX_SAFE_INTEGER) delete copy.minimum;
    return normalise(copy);
  }
  const anyOf = s.anyOf as Json[] | undefined;
  if (anyOf?.length === 2 && anyOf.some((x) => x.type === "null")) {
    const other = normalise(anyOf.find((x) => x.type !== "null")!);
    return { ...other, type: [other.type, "null"].flat() };
  }
  return s;
}
const typeOf = (s: Json) => JSON.stringify([s.type ?? "any"].flat().sort());
const KEYWORDS = ["enum", "minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems"] as const;

export function diffSchemas(where: string, specIn: Json, codeIn: Json, opts: { strictObjects: boolean }): string[] {
  const spec = normalise(specIn), code = normalise(codeIn), out: string[] = [];
  if (typeOf(spec) !== typeOf(code)) out.push(`${where}: type spec=${typeOf(spec)} code=${typeOf(code)}`);
  for (const k of KEYWORDS) {
    const a = JSON.stringify(spec[k]), b = JSON.stringify(code[k]);
    if (a !== b) out.push(`${where}: ${k} spec=${a ?? "-"} code=${b ?? "-"}`);
  }
  // Zod adds a regex for every format; only compare a pattern the spec itself states.
  if (spec.pattern !== undefined && spec.pattern !== code.pattern) out.push(`${where}: pattern spec=${String(spec.pattern)} code=${String(code.pattern ?? "-")}`);
  if (spec.format !== undefined && spec.format !== code.format) out.push(`${where}: format spec=${String(spec.format)} code=${String(code.format ?? "-")}`);

  const sp = (spec.properties ?? {}) as Record<string, Json>, cp = (code.properties ?? {}) as Record<string, Json>;
  for (const key of new Set([...Object.keys(sp), ...Object.keys(cp)])) {
    if (!sp[key]) out.push(`${where}.${key}: in code, missing from spec`);
    else if (!cp[key]) out.push(`${where}.${key}: in spec, missing from code`);
    else out.push(...diffSchemas(`${where}.${key}`, sp[key], cp[key], opts));
  }
  if (spec.type === "object" || code.type === "object") {
    const rs = JSON.stringify([...((spec.required as string[]) ?? [])].sort()), rc = JSON.stringify([...((code.required as string[]) ?? [])].sort());
    if (rs !== rc) out.push(`${where}: required spec=${rs} code=${rc}`);
    if (opts.strictObjects && (spec.additionalProperties === false) !== (code.additionalProperties === false)) {
      out.push(`${where}: unknown fields spec=${spec.additionalProperties === false ? "rejected" : "allowed"} code=${code.additionalProperties === false ? "rejected" : "allowed"}`);
    }
  }
  if (spec.items || code.items) out.push(...diffSchemas(`${where}[]`, (spec.items ?? {}) as Json, (code.items ?? {}) as Json, opts));
  return out;
}

// Inline every local $ref so the comparison sees plain schemas.
export function resolveRefs(node: unknown, root: Json): unknown {
  if (Array.isArray(node)) return node.map((n) => resolveRefs(n, root));
  if (!node || typeof node !== "object") return node;
  const ref = (node as Json).$ref;
  if (typeof ref === "string") {
    const target = ref.replace(/^#\//, "").split("/").reduce<unknown>((o, k) => (o as Json)[k], root);
    return resolveRefs(target, root);
  }
  return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, resolveRefs(v, root)]));
}
```

</details>

**First run. Real output** (before any fixes; the comparator did not yet treat `const` as a one-value `enum`):

```text
20 routes compared, 39 differences, 39 unexpected
POST /v1/auth/signup body.email: format spec=email code=-
POST /v1/auth/signup 202.status: enum spec=["check_your_email"] code=-
POST /v1/auth/signup 202.status: const spec=- code="check_your_email"
POST /v1/auth/login body.email: format spec=email code=-
POST /v1/auth/login 200.tokenType: enum spec=["Bearer"] code=-
POST /v1/auth/login 200.tokenType: const spec=- code="Bearer"
POST /v1/auth/login 200.expiresIn: maximum spec=- code=9007199254740991
POST /v1/auth/refresh 200.tokenType: enum spec=["Bearer"] code=-
POST /v1/auth/refresh 200.tokenType: const spec=- code="Bearer"
POST /v1/auth/refresh 200.expiresIn: maximum spec=- code=9007199254740991
POST /v1/auth/logout-all 200.revokedSessions: maximum spec=- code=9007199254740991
GET /.well-known/jwks.json 200.keys[].kty: enum spec=["RSA"] code=-
GET /.well-known/jwks.json 200.keys[].kty: const spec=- code="RSA"
GET /.well-known/jwks.json 200.keys[].alg: enum spec=["RS256"] code=-
GET /.well-known/jwks.json 200.keys[].alg: const spec=- code="RS256"
GET /.well-known/jwks.json 200.keys[].use: enum spec=["sig"] code=-
GET /.well-known/jwks.json 200.keys[].use: const spec=- code="sig"
POST /v1/auth/step-up body.note: minLength spec=- code=1
POST /v1/auth/step-up 201.channel: enum spec=["sms"] code=-
POST /v1/auth/step-up 201.channel: const spec=- code="sms"
GET /v1/wallets/{walletId} 200.balanceMinor: minimum spec=- code=-9007199254740991
GET /v1/wallets/{walletId} 200.balanceMinor: maximum spec=- code=9007199254740991
PATCH /v1/wallets/{walletId} header.if-match: in spec, missing from code
PATCH /v1/wallets/{walletId} header: required spec=["if-match"] code=[]
PATCH /v1/wallets/{walletId} body.nickname: minLength spec=- code=1
PATCH /v1/wallets/{walletId} 200.balanceMinor: minimum spec=- code=-9007199254740991
PATCH /v1/wallets/{walletId} 200.balanceMinor: maximum spec=- code=9007199254740991
GET /v1/wallets/{walletId}/transactions query: required spec=[] code=["limit"]
POST /v1/transfers header.idempotency-key: in spec, missing from code
POST /v1/transfers header: required spec=["idempotency-key"] code=[]
POST /v1/transfers body.note: minLength spec=- code=1
POST /v1/wallets/{walletId}/statement-exports header.idempotency-key: in spec, missing from code
POST /v1/wallets/{walletId}/statement-exports header: required spec=["idempotency-key"] code=[]
POST /v1/wallets/{walletId}/statement-exports 202: required spec=["createdAt","id","status","walletId"] code=["createdAt","downloadUrl","failureReason","id","status","walletId"]
GET /v1/statement-exports/{exportId} 200: required spec=["createdAt","id","status","walletId"] code=["createdAt","downloadUrl","failureReason","id","status","walletId"]
POST /v1/accounts: in spec, no route
GET /v1/accounts/{accountId}: in spec, no route
POST /v1/accounts/{accountId}/wallets: in spec, no route
GET /v1/transfers: in spec, no route
```

39 differences. Here they are sorted by cause (counted with a script over the output above):

| Cause | Count | Fix |
|---|---|---|
| Comparator noise: `const: "Bearer"` vs `enum: ["Bearer"]`, Zod's ±2^53 "safe integer" bounds, a `.default()` making `limit` look required | 22 | Taught the comparator these are the same thing |
| Code side: `Email`'s pipe hid `format: email` from JSON Schema | 2 | `.meta({ format: "email" })` |
| **Real spec bugs**: code rejects empty `note`/`nickname` but the spec allowed `""` (3); `downloadUrl` and `failureReason` are always sent (maybe `null`) but the spec did not list them as required (2) | 5 | Fixed `openapi.yaml`, regenerated types |
| Accepted on purpose: `Idempotency-Key` and `If-Match` owned by their P1-03 code (6); 4 operations in the spec since P1-03 that this lab never built | 10 | `KNOWN_DIFFERENCES`, each with a reason |

**After the fixes. Real output:**

```text
20 routes compared, 10 differences, 0 unexpected
Tests  1 passed (1)
```

The 5 real bugs matter. A client generated from the old spec would happily send `"note": ""` and get a 400 it could not explain, and would treat `downloadUrl` as maybe-missing when it is always there. The last line of the test also fails if a `KNOWN_DIFFERENCES` entry stops matching anything, so stale exceptions cannot quietly hide the next real drift.

**1g. The malformed-input table.** One row per bad input; each must get the right status, `code` and field pointer.

```ts
// test/validation.test.ts — a table of bad inputs. Each must be rejected with the right status, code and field.
import { randomUUID } from "node:crypto";
import type { FastifyInstance, InjectOptions } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { pool } from "../src/db/pool.js";
import { bearer, login } from "./helpers/auth.js";
import { resetDatabase, seedWorld, type World } from "./helpers/db.js";

let app: FastifyInstance, w: World, token: string;
beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  await resetDatabase();
  w = await seedWorld();
  token = (await login(app, w.users.riya.email)).accessToken;
});
afterAll(async () => { await app.close(); await pool.end(); });

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const auth = () => ({ ...bearer(token), "idempotency-key": randomUUID() });
const good = () => ({ sourceWalletId: w.wallets.riya, destinationWalletId: w.wallets.amit, amountMinor: 50_000, currency: "INR" });
const transfer = (payload: unknown): InjectOptions => ({ method: "POST", url: "/v1/transfers", headers: auth(), payload: payload as object });
const rawTransfer = (body: string, type = "application/json"): InjectOptions =>
  ({ method: "POST", url: "/v1/transfers", headers: { ...auth(), "content-type": type }, payload: body });
const list = (qs: string): InjectOptions => ({ method: "GET", url: `/v1/wallets/${w.wallets.riya}/transactions?${qs}`, headers: auth() });
const exportFor = (from: string, to: string): InjectOptions =>
  ({ method: "POST", url: `/v1/wallets/${w.wallets.riya}/statement-exports`, headers: auth(), payload: { from, to, format: "pdf" } });
const nested = (depth: number) => "[".repeat(depth) + "]".repeat(depth);

type Case = [name: string, req: () => InjectOptions, status: number, code: string, where?: string];
const CASES: Case[] = [
  ["amount with paise fraction", () => transfer({ ...good(), amountMinor: 500.5 }), 400, "VALIDATION_FAILED", "#/amountMinor"],
  ["amount as a string", () => transfer({ ...good(), amountMinor: "50000" }), 400, "VALIDATION_FAILED", "#/amountMinor"],
  ["amount zero", () => transfer({ ...good(), amountMinor: 0 }), 400, "VALIDATION_FAILED", "#/amountMinor"],
  ["amount above the limit", () => transfer({ ...good(), amountMinor: 100_000_000_001 }), 400, "VALIDATION_FAILED", "#/amountMinor"],
  ["currency in lower case", () => transfer({ ...good(), currency: "inr" }), 400, "VALIDATION_FAILED", "#/currency"],
  ["unknown field", () => transfer({ ...good(), fee: 0 }), 400, "VALIDATION_FAILED", "#/fee"],
  ["wallet id not a UUID", () => transfer({ ...good(), sourceWalletId: "riya-wallet" }), 400, "VALIDATION_FAILED", "#/sourceWalletId"],
  ["missing required field", () => transfer({ ...good(), destinationWalletId: undefined }), 400, "VALIDATION_FAILED", "#/destinationWalletId"],
  ["note of only spaces", () => transfer({ ...good(), note: "   " }), 400, "VALIDATION_FAILED", "#/note"],
  ["note of only zero-width spaces", () => transfer({ ...good(), note: "​​" }), 400, "VALIDATION_FAILED", "#/note"],
  ["note with a control character", () => transfer({ ...good(), note: "Rent\u0007" }), 400, "VALIDATION_FAILED", "#/note"],
  ["note longer than 140", () => transfer({ ...good(), note: "x".repeat(141) }), 400, "VALIDATION_FAILED", "#/note"],
  ["body is an array", () => transfer([]), 400, "VALIDATION_FAILED", "#/"],
  ["broken JSON", () => rawTransfer('{"amountMinor":'), 400, "MALFORMED_JSON"],
  ["__proto__ key", () => rawTransfer('{"__proto__":{"isAdmin":true}}'), 400, "MALFORMED_JSON"],
  ["JSON nested 25 levels", () => rawTransfer(nested(25)), 400, "JSON_TOO_DEEP"],
  ["body sent as text/plain", () => rawTransfer(JSON.stringify(good()), "text/plain"), 415, "UNSUPPORTED_MEDIA_TYPE"],
  ["limit=abc", () => list("limit=abc"), 400, "VALIDATION_FAILED", "limit"],
  ["limit=0", () => list("limit=0"), 400, "VALIDATION_FAILED", "limit"],
  ["limit=101", () => list("limit=101"), 400, "VALIDATION_FAILED", "limit"],
  ["limit=1e2", () => list("limit=1e2"), 400, "VALIDATION_FAILED", "limit"],
  ["unknown query parameter", () => list("sort=amount"), 400, "VALIDATION_FAILED", "sort"],
  ["path id not a UUID", () => ({ method: "GET", url: "/v1/wallets/123", headers: auth() }), 400, "VALIDATION_FAILED", "walletId"],
  ["date that does not exist", () => exportFor("2026-02-30", "2026-03-01"), 400, "VALIDATION_FAILED", "#/from"],
  ["period ends before it starts", () => exportFor(day(-10), day(-20)), 422, "INVALID_PERIOD"],
  ["period ends in the future", () => exportFor(day(-10), day(2)), 422, "INVALID_PERIOD"],
  ["period longer than 366 days", () => exportFor(day(-400), day(-1)), 422, "INVALID_PERIOD"],
  ["phone number too short", () => ({ method: "PATCH", url: "/v1/me/phone", headers: auth(), payload: { phone: "12345" } }), 400, "VALIDATION_FAILED", "#/phone"],
  ["wallet update with no fields", () => ({ method: "PATCH", url: `/v1/wallets/${w.wallets.riya}`, headers: { ...auth(), "if-match": '"v1"' }, payload: {} }), 400, "VALIDATION_FAILED", "#/"],
  ["signup with a bad email", () => ({ method: "POST", url: "/v1/auth/signup", payload: { email: "riya@", password: "long enough password" } }), 400, "VALIDATION_FAILED", "#/email"],
  ["OTP that is not 6 digits", () => ({ method: "POST", url: `/v1/auth/step-up/${randomUUID()}/verify`, headers: auth(), payload: { code: "12345" } }), 400, "VALIDATION_FAILED", "#/code"],
];

describe("malformed input is rejected at the edge", () => {
  const results: string[] = [];
  afterAll(() => {
    console.log(`${results.length} malformed inputs, ${results.filter((r) => r.startsWith("ok")).length} rejected as expected\n${results.join("\n")}`);
  });

  it.each(CASES)("%s", async (name, req, status, code, where) => {
    const res = await app.inject(req());
    const body = res.json<{ code: string; errors?: { pointer?: string; parameter?: string }[] }>();
    const fields = (body.errors ?? []).map((e) => e.pointer ?? e.parameter);
    results.push(`${res.statusCode === status && body.code === code ? "ok " : "BAD"} ${res.statusCode} ${body.code.padEnd(22)} ${(fields.join(",") || "-").padEnd(22)} ${name}`);
    expect(res.statusCode).toBe(status);
    expect(res.headers["content-type"]).toContain("application/problem+json");
    expect(body.code).toBe(code);
    if (where) expect(fields).toContain(where);
  });
});

describe("valid but messy input is normalised once, at the edge", () => {
  it("stores a phone typed the Indian way as E.164", async () => {
    const res = await app.inject({ method: "PATCH", url: "/v1/me/phone", headers: auth(), payload: { phone: "098765 43210" } });
    expect(res.statusCode).toBe(200);
    expect(res.json().phone).toBe("+919876543210");
  });

  it("trims the note and drops invisible characters before storing it", async () => {
    const res = await app.inject(transfer({ ...good(), note: "  Rent​ for Oct  " }));
    expect(res.statusCode).toBe(201);
    expect(res.json().note).toBe("Rent for Oct");
  });

  it("treats Riya@Ledger.TEST and riya@ledger.test as one email", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { email: "  Riya@Ledger.TEST ", password: "correct horse battery staple" } });
    expect(res.statusCode).toBe(200);
  });
});
```

**Real output:**

```text
31 malformed inputs, 31 rejected as expected
ok  400 VALIDATION_FAILED      #/amountMinor          amount with paise fraction
ok  400 VALIDATION_FAILED      #/amountMinor          amount as a string
ok  400 VALIDATION_FAILED      #/amountMinor          amount zero
ok  400 VALIDATION_FAILED      #/amountMinor          amount above the limit
ok  400 VALIDATION_FAILED      #/currency             currency in lower case
ok  400 VALIDATION_FAILED      #/fee                  unknown field
ok  400 VALIDATION_FAILED      #/sourceWalletId       wallet id not a UUID
ok  400 VALIDATION_FAILED      #/destinationWalletId  missing required field
ok  400 VALIDATION_FAILED      #/note                 note of only spaces
ok  400 VALIDATION_FAILED      #/note                 note of only zero-width spaces
ok  400 VALIDATION_FAILED      #/note                 note with a control character
ok  400 VALIDATION_FAILED      #/note                 note longer than 140
ok  400 VALIDATION_FAILED      #/                     body is an array
ok  400 MALFORMED_JSON         -                      broken JSON
ok  400 MALFORMED_JSON         -                      __proto__ key
ok  400 JSON_TOO_DEEP          -                      JSON nested 25 levels
ok  415 UNSUPPORTED_MEDIA_TYPE -                      body sent as text/plain
ok  400 VALIDATION_FAILED      limit                  limit=abc
ok  400 VALIDATION_FAILED      limit                  limit=0
ok  400 VALIDATION_FAILED      limit                  limit=101
ok  400 VALIDATION_FAILED      limit                  limit=1e2
ok  400 VALIDATION_FAILED      sort                   unknown query parameter
ok  400 VALIDATION_FAILED      walletId               path id not a UUID
ok  400 VALIDATION_FAILED      #/from                 date that does not exist
ok  422 INVALID_PERIOD         -                      period ends before it starts
ok  422 INVALID_PERIOD         -                      period ends in the future
ok  422 INVALID_PERIOD         -                      period longer than 366 days
ok  400 VALIDATION_FAILED      #/phone                phone number too short
ok  400 VALIDATION_FAILED      #/                     wallet update with no fields
ok  400 VALIDATION_FAILED      #/email                signup with a bad email
ok  400 VALIDATION_FAILED      #/code                 OTP that is not 6 digits
```

31 malformed inputs, 31 rejected as expected: 27 with 400, 3 with 422, 1 with 415 (counted from the output with a script). The last three tests in the file check the happy side of normalisation: `"098765 43210"` is stored as `+919876543210`, the note comes back as `"Rent for Oct"`, and `"  Riya@Ledger.TEST "` logs in as `riya@ledger.test`.

### Step 2 · Typed config that fails fast

`src/config/loadConfig.ts` is a pure function: environment in, typed config or a list of problems out. That makes it easy to test.

```ts
// src/config/loadConfig.ts — turn the raw environment (all strings, maybe missing) into one typed, checked object.
import { readFileSync } from "node:fs";
import { z } from "zod";

// Env vars are text. Convert strictly: "" and "1e2" are mistakes, not numbers. "false" must mean false.
const wholeNumber = z.string().regex(/^\d+$/, "must be a whole number").transform(Number);
const positiveInt = wholeNumber.pipe(z.int().positive());
const port = wholeNumber.pipe(z.int().min(1).max(65535));

// Secrets may come from NAME_FILE (a mounted file: Docker/Kubernetes secrets) or, outside production, NAME.
const SECRET_NAMES = ["JWT_PRIVATE_JWKS", "OTP_PEPPER", "GOOGLE_CLIENT_SECRET"] as const;

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]), // required: no guessing which world we are in
  PORT: port.default(3000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  TRUST_PROXY: z.stringbool().default(false), // z.coerce.boolean() would turn "false" into true
  // Database: a secret file in real environments; a URL only for local work.
  DATABASE_SECRET_FILE: z.string().min(1).optional(),
  DATABASE_URL: z.url().optional(),
  DATABASE_SECRET_REFRESH_SECONDS: positiveInt.default(30),
  // Request limits
  BODY_LIMIT_BYTES: positiveInt.default(64 * 1024),
  JSON_MAX_DEPTH: positiveInt.default(20),
  REQUEST_TIMEOUT_MS: positiveInt.default(10_000),
  LEAK_GUARD: z.enum(["block", "log"]).default("block"),
  // From P1-03 and P1-05
  IDEMPOTENCY_TTL_HOURS: positiveInt.default(24),
  IDEMPOTENCY_LOCK_SECONDS: positiveInt.default(30),
  AUTH_ISSUER: z.url(),
  AUTH_AUDIENCE: z.string().min(1).default("ledger-api"),
  JWT_PRIVATE_JWKS: z.string().min(1),
  ACCESS_TOKEN_TTL_SECONDS: positiveInt.default(600),
  REFRESH_TOKEN_IDLE_DAYS: positiveInt.default(14),
  SESSION_MAX_DAYS: positiveInt.default(30),
  APP_ORIGIN: z.url(),
  PUBLIC_BASE_URL: z.url(),
  LOGIN_IP_LIMIT: positiveInt.default(20),
  LOGIN_ACCOUNT_FAILURE_LIMIT: positiveInt.default(5),
  LOGIN_WINDOW_SECONDS: positiveInt.default(900),
  OTP_PEPPER: z.string().min(32),
  STEP_UP_THRESHOLD_MINOR: positiveInt.default(1_000_000),
  GOOGLE_ISSUER: z.url().default("https://accounts.google.com"),
  GOOGLE_CLIENT_ID: z.string().default(""),
  GOOGLE_CLIENT_SECRET: z.string().default(""),
});

// Rules that look at several variables together. They run on the raw strings so they are reported in the
// SAME run as field errors. (A Zod refine on the whole object only runs once every field is valid, so
// the operator would fix five problems, redeploy, and only then meet two more.)
function crossChecks(env: Record<string, string | undefined>): string[] {
  const problems: string[] = [];
  if (!env.DATABASE_SECRET_FILE && !env.DATABASE_URL) problems.push("DATABASE_SECRET_FILE: required (or DATABASE_URL for local work)");
  if (env.NODE_ENV !== "production") return problems;
  if (env.DATABASE_URL) problems.push("DATABASE_URL: not allowed in production: use DATABASE_SECRET_FILE");
  for (const key of ["AUTH_ISSUER", "APP_ORIGIN", "PUBLIC_BASE_URL", "GOOGLE_ISSUER"]) {
    const value = env[key];
    if (value !== undefined && !value.startsWith("https://")) problems.push(`${key}: must be an https:// URL in production`);
  }
  return problems;
}

export type Config = Readonly<z.infer<typeof schema>>;
export type LoadResult = { ok: true; config: Config } | { ok: false; problems: string[] };
type ReadFile = (path: string) => string;

export function loadConfig(source: Record<string, string | undefined>, readFile: ReadFile = (p) => readFileSync(p, "utf8")): LoadResult {
  const raw: Record<string, string | undefined> = { ...source };
  const problems: string[] = [];

  for (const name of SECRET_NAMES) {
    const file = source[`${name}_FILE`];
    if (file) {
      if (source[name] !== undefined) problems.push(`${name}: set either ${name} or ${name}_FILE, not both`);
      try {
        raw[name] = readFile(file).trim();
      } catch (err) {
        problems.push(`${name}_FILE: cannot read ${file} (${(err as NodeJS.ErrnoException).code ?? "error"})`);
      }
    } else if (source.NODE_ENV === "production" && source[name] !== undefined) {
      // Env vars leak: child processes inherit them, crash reporters and "print env" debug pages show them.
      problems.push(`${name}: in production, provide ${name}_FILE instead of the value itself`);
    }
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    // Messages name the variable and the rule. They never include the value: it may be a secret.
    problems.push(...parsed.error.issues.map((i) => {
      const name = i.path.join(".");
      return raw[name] === undefined ? `${name}: is required` : `${name}: ${i.message}`;
    }));
  }
  problems.push(...crossChecks(raw));
  if (problems.length || !parsed.success) return { ok: false, problems };
  return { ok: true, config: Object.freeze(parsed.data) };
}
```

`src/config/env.ts` is the only file that touches `process.env`:

```ts
// src/config/env.ts — load config once, at boot. Invalid config means the process never starts.
import { loadConfig } from "./loadConfig.js";

const loaded = loadConfig(process.env);

if (!loaded.ok) {
  // stderr, not the logger: logging itself may depend on the config that just failed.
  process.stderr.write(
    "\nConfiguration is invalid. The ledger API did not start.\n\n" +
      loaded.problems.map((p) => `  ✖ ${p}`).join("\n") +
      "\n\nFix the variables above (see .env.example). Values are never printed here.\n\n",
  );
  process.exit(1); // fail fast: better a failed deploy than a running app with the wrong settings
}

export const env = loaded.config;
```

**What to notice**
- `wholeNumber` accepts digits only. `""`, `"80a"` and `"1e3"` are mistakes, not numbers.
- Secrets can come from `NAME_FILE`. In production, the plain `NAME` form is itself a problem.
- `crossChecks` runs on the raw strings, so cross-variable problems appear in the **same** run as field problems (Deep dive 5).
- A missing variable says `is required`. Problem lines never contain values.
- `Object.freeze`: nothing can change config at runtime by accident.

**Break the config on purpose.** Production mode, a typo in `PORT`, a plain-text pepper, an `http://` origin and a database URL:

```bash
env -i PATH="$PATH" HOME="$HOME" NODE_ENV=production PORT=80a \
  DATABASE_URL="postgres://ledger@db.internal:5432/ledger" \
  APP_ORIGIN="http://app.ledger.example" PUBLIC_BASE_URL="https://api.ledger.example" \
  OTP_PEPPER="changeme" npx tsx src/server.ts
echo "exit code: $?"
```

**Real output** (stderr, then the exit code):

```text

Configuration is invalid. The ledger API did not start.

  ✖ OTP_PEPPER: in production, provide OTP_PEPPER_FILE instead of the value itself
  ✖ PORT: must be a whole number
  ✖ AUTH_ISSUER: is required
  ✖ JWT_PRIVATE_JWKS: is required
  ✖ OTP_PEPPER: Too small: expected string to have >=32 characters
  ✖ DATABASE_URL: not allowed in production: use DATABASE_SECRET_FILE
  ✖ APP_ORIGIN: must be an https:// URL in production

Fix the variables above (see .env.example). Values are never printed here.
```

```text
exit code: 1
```

Seven problems, one run, exit code 1, and the process never opened a port. `changeme` and the database URL appear nowhere in the output.

The unit tests for the loader, `test/config.test.ts`:

```ts
// test/config.test.ts — config is parsed like any other untrusted input. Bad config must stop the boot.
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/loadConfig.js";

// A fake "secret store" on disk: path -> content. No real files, no real secrets.
const files: Record<string, string> = { "/run/secrets/otp_pepper": "file-pepper-file-pepper-file-pepper-01\n" };
const readFile = (path: string) => {
  if (!(path in files)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
  return files[path]!;
};

const local = {
  NODE_ENV: "development", DATABASE_URL: "postgres://localhost/ledger_dev",
  AUTH_ISSUER: "http://localhost:3000", APP_ORIGIN: "http://localhost:5173", PUBLIC_BASE_URL: "http://localhost:3000",
  JWT_PRIVATE_JWKS: "[]", OTP_PEPPER: "dev-pepper-dev-pepper-dev-pepper-0001",
};
const problemsOf = (source: Record<string, string | undefined>) => {
  const r = loadConfig(source, readFile);
  return r.ok ? [] : r.problems;
};

describe("loadConfig", () => {
  it("returns a typed, frozen config for a good environment", () => {
    const r = loadConfig({ ...local, PORT: "8080", TRUST_PROXY: "false" }, readFile);
    if (!r.ok) throw new Error(r.problems.join("; "));
    expect(r.config.PORT).toBe(8080); // a number, not "8080"
    expect(r.config.TRUST_PROXY).toBe(false); // "false" means false
    expect(r.config.BODY_LIMIT_BYTES).toBe(65_536); // documented default
    expect(Object.isFrozen(r.config)).toBe(true);
  });

  it("lists every problem at once, not just the first", () => {
    const problems = problemsOf({ ...local, NODE_ENV: undefined, PORT: "80a", TRUST_PROXY: "nope", JSON_MAX_DEPTH: "0" });
    expect(problems.map((p) => p.split(":")[0])).toEqual(["NODE_ENV", "PORT", "TRUST_PROXY", "JSON_MAX_DEPTH"]);
  });

  it("never falls back to a default database", () => {
    expect(problemsOf({ ...local, DATABASE_URL: undefined })).toEqual(["DATABASE_SECRET_FILE: required (or DATABASE_URL for local work)"]);
  });

  it("applies production-only rules", () => {
    const problems = problemsOf({ ...local, NODE_ENV: "production", PORT: "80a" });
    expect(problems).toEqual(expect.arrayContaining([
      "PORT: must be a whole number", // field errors and cross-variable rules arrive in the same run
      "JWT_PRIVATE_JWKS: in production, provide JWT_PRIVATE_JWKS_FILE instead of the value itself",
      "DATABASE_URL: not allowed in production: use DATABASE_SECRET_FILE",
      "APP_ORIGIN: must be an https:// URL in production",
    ]));
  });

  it("reads secrets from files and reports a missing file by path, not by value", () => {
    const { OTP_PEPPER: _unused, ...rest } = local;
    const r = loadConfig({ ...rest, OTP_PEPPER_FILE: "/run/secrets/otp_pepper" }, readFile);
    expect(r.ok && r.config.OTP_PEPPER).toBe("file-pepper-file-pepper-file-pepper-01"); // trailing newline trimmed
    expect(problemsOf({ ...rest, OTP_PEPPER_FILE: "/run/secrets/nope" })).toContain("OTP_PEPPER_FILE: cannot read /run/secrets/nope (ENOENT)");
  });

  it("never prints a value, even a wrong one", () => {
    const tooShort = "short-pepper-value";
    const problems = problemsOf({ ...local, OTP_PEPPER: tooShort, DATABASE_URL: "not a url" });
    expect(problems.join("\n")).not.toContain(tooShort);
    expect(problems.join("\n")).not.toContain("not a url");
    expect(problems.length).toBe(2);
  });
});
```

**What to notice**
- `loadConfig` takes the environment **and** a `readFile` function, so tests need no real files and no real secrets.
- "Never prints a value" is a test, not a hope: a wrong pepper and a broken URL must not appear in the problem list.
- "Never falls back to a default database" pins the exact message, so a future "helpful" default breaks the build.

### Step 3 · Response schemas, and a test that the password hash never leaves

`src/schemas/responses.ts`: one allowlist per response, each tied to the OpenAPI type.

```ts
// src/schemas/responses.ts — exactly what each response may contain. Anything not listed here is dropped.
import { z } from "zod";
import type { components } from "../generated/api.js";
import { AmountMinor, Currency, IsoDateTime, Uuid } from "./common.js";

type Api = components["schemas"];

// `satisfies` ties each response schema to the OpenAPI type: drift becomes a compile error.
export const TransferResponse = z.object({
  id: Uuid, sourceWalletId: Uuid, destinationWalletId: Uuid, amountMinor: AmountMinor, currency: Currency,
  status: z.enum(["completed"]), note: z.string().optional(), createdAt: IsoDateTime,
}) satisfies z.ZodType<Api["Transfer"]>;

export const WalletResponse = z.object({
  id: Uuid, accountId: Uuid, currency: Currency, balanceMinor: z.int(),
  nickname: z.string().optional(), status: z.enum(["active", "frozen"]), createdAt: IsoDateTime,
}) satisfies z.ZodType<Api["Wallet"]>; // no `version`: it travels as the ETag header, not in the body

export const TransactionPage = z.object({
  data: z.array(z.object({
    id: z.string(), transferId: Uuid, direction: z.enum(["debit", "credit"]), amountMinor: AmountMinor, createdAt: IsoDateTime,
  })),
  page: z.object({ hasMore: z.boolean(), nextCursor: z.string().nullable() }),
}) satisfies z.ZodType<Api["TransactionPage"]>;

export const StatementExportResponse = z.object({
  id: Uuid, walletId: Uuid, status: z.enum(["pending", "running", "succeeded", "failed"]),
  downloadUrl: z.url().nullable(), failureReason: z.string().nullable(), createdAt: IsoDateTime,
}) satisfies z.ZodType<Api["StatementExport"]>;

export const MeResponse = z.object({
  id: Uuid, email: z.email(), role: z.enum(["user", "support", "admin"]), phone: z.e164().nullable(), createdAt: IsoDateTime,
}) satisfies z.ZodType<Api["Me"]>;

export const TokenResponse = z.object({
  accessToken: z.string(), tokenType: z.literal("Bearer"), expiresIn: z.int().positive(),
}) satisfies z.ZodType<Api["TokenResponse"]>;

// Public keys only. Even if a private field ("d", "p", "q"...) reached this object, it would be dropped here.
export const JwksResponse = z.object({
  keys: z.array(z.object({ kty: z.literal("RSA"), kid: z.string(), alg: z.literal("RS256"), use: z.literal("sig"), n: z.string(), e: z.string() })),
}) satisfies z.ZodType<Api["Jwks"]>;

export const SignupAccepted = z.object({ status: z.literal("check_your_email") }) satisfies z.ZodType<Api["SignupAccepted"]>;
export const LogoutAllResponse = z.object({ revokedSessions: z.int().min(0) }) satisfies z.ZodType<Api["LogoutAllResponse"]>;
export const RefundAccepted = z.object({ refundId: Uuid, status: z.string() }) satisfies z.ZodType<Api["RefundAccepted"]>;
export const StepUpStarted = z.object({ challengeId: Uuid, expiresAt: IsoDateTime, channel: z.literal("sms") }) satisfies z.ZodType<Api["StepUpStarted"]>;
```

`src/routes/me.ts` returns the **whole** user record on purpose, to prove the schema is enough:

```ts
// src/routes/me.ts — the signed-in user's own profile. The response schema decides what leaves the server.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requirePrincipal } from "../auth/authenticate.js";
import { ApiError } from "../lib/problem.js";
import { findUserById, updateUserPhone, type UserRecord } from "../repositories/userRepository.js";
import { PhoneInput } from "../schemas/common.js";
import { MeResponse } from "../schemas/responses.js";

const updatePhoneBody = z.strictObject({ phone: PhoneInput }); // "098765 43210" arrives, "+919876543210" leaves

const userGone = () => new ApiError(404, "USER_NOT_FOUND", "User not found");

export async function meRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/me", {
    config: { access: { kind: "self" } },
    schema: { response: { 200: MeResponse } },
  }, async (request): Promise<UserRecord> => {
    const user = await findUserById(requirePrincipal(request).userId);
    if (!user) throw userGone();
    // We return the whole record on purpose: MeResponse names five fields, so passwordHash is dropped.
    return user;
  });

  // Changing where OTPs go is how SIM-swap fraud starts, so this is a sensitive route (live session required).
  app.patch<{ Body: z.infer<typeof updatePhoneBody> }>("/v1/me/phone", {
    config: { access: { kind: "self", sensitive: true } },
    schema: { body: updatePhoneBody, response: { 200: MeResponse } },
  }, async (request): Promise<UserRecord> => {
    const user = await updateUserPhone(requirePrincipal(request).userId, request.body.phone);
    if (!user) throw userGone();
    return user;
  });
}
```

The second line of defence, `src/http/leakGuard.ts`:

```ts
// src/http/leakGuard.ts — last line of defence: refuse to send a response that contains a known secret shape.
import type { FastifyInstance } from "fastify";
import { ApiError, PROBLEM_CONTENT_TYPE, toProblem } from "../lib/problem.js";

// Shapes that must never leave the server, whichever handler, error path or log message produced them.
const NEVER_SEND: { name: string; pattern: RegExp }[] = [
  { name: "argon2 password hash", pattern: /\$argon2(id|i|d)\$v=\d+\$/ },
  { name: "bcrypt password hash", pattern: /\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}/ },
  { name: "PEM private key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "private JWK", pattern: /"d"\s*:\s*"[A-Za-z0-9_-]{40,}"/ },
];

export function registerLeakGuard(app: FastifyInstance, mode: "block" | "log"): void {
  app.addHook("onSend", async (request, reply, payload) => {
    if (typeof payload !== "string") return payload; // streams and buffers are files, not our JSON
    const hit = NEVER_SEND.find((s) => s.pattern.test(payload));
    if (!hit) return payload;
    request.log.error({ leak: hit.name, route: request.routeOptions.url, status: reply.statusCode }, "blocked a response containing a secret");
    if (mode === "log") return payload;
    reply.code(500).type(PROBLEM_CONTENT_TYPE);
    const problem = toProblem(new ApiError(500, "INTERNAL_ERROR", "Something went wrong on our side"), request.url.split("?")[0] ?? "", request.id);
    return JSON.stringify(problem);
  });
}
```

And the logger, so secrets do not leak through logs either (`src/lib/logger.ts`):

```ts
// src/lib/logger.ts — one logger for the process, with secrets redacted before anything is written.
import pino from "pino";
import { env } from "../config/env.js";

export const logger = pino({
  level: env.LOG_LEVEL,
  redact: {
    // Fastify logs req/res objects; our own code logs plain objects. Cover both shapes.
    paths: [
      "req.headers.authorization", "req.headers.cookie", 'req.headers["idempotency-key"]',
      "res.headers['set-cookie']", "*.password", "*.otp", "*.code", "*.secret", "*.token", "*.refreshToken",
    ],
    censor: "[REDACTED]",
  },
});
```

**What to notice**
- `UserRecord` carries `passwordHash` because login needs it. The record is not the problem; sending it without an allowlist is.
- The leak guard knows **shapes**, not values: it needs no list of secrets, and it covers error paths and future routes too.
- The guard works on string payloads. Streams (file downloads) pass through untouched.

The test, `test/responseLeak.test.ts`. It crawls every GET route as Riya and adds three "careless" test-only routes:

```ts
// test/responseLeak.test.ts — the password hash must never leave the server, whatever a handler returns.
import type { FastifyInstance, InjectOptions } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { buildApp } from "../src/app.js";
import { pool } from "../src/db/pool.js";
import { routeTable } from "../src/http/routeContracts.js";
import { findUserById } from "../src/repositories/userRepository.js";
import { Uuid } from "../src/schemas/common.js";
import { MeResponse } from "../src/schemas/responses.js";
import { bearer, login } from "./helpers/auth.js";
import { resetDatabase, seedWorld, type World } from "./helpers/db.js";

// Test-only routes that behave like a careless handler would.
async function carelessRoutes(app: FastifyInstance): Promise<void> {
  const self = { config: { access: { kind: "self" } } } as const;
  // Returns the whole DB record, password hash included. Its response schema is the only thing in the way.
  app.get("/test/whole-record", { ...self, schema: { response: { 200: MeResponse } } },
    async (request) => findUserById(request.principal!.userId));
  // A schema that (wrongly) lists a field holding the hash: the leak guard is the second line of defence.
  app.get("/test/debug-field", { ...self, schema: { response: { 200: z.object({ id: Uuid, debug: z.string() }) } } },
    async (request) => { const u = await findUserById(request.principal!.userId); return { id: u!.id, debug: u!.passwordHash }; });
  // A handler that breaks its own contract (amount as text): fail closed, do not send it.
  app.get("/test/wrong-shape", { ...self, schema: { response: { 200: z.object({ amountMinor: z.int() }) } } },
    async () => ({ amountMinor: "50000" }));
}

let app: FastifyInstance, w: World, token: string, hash: string;
beforeAll(async () => {
  app = await buildApp({ extraRoutes: carelessRoutes });
  await app.ready();
  await resetDatabase();
  w = await seedWorld();
  token = (await login(app, w.users.riya.email)).accessToken;
  hash = (await findUserById(w.users.riya.id))!.passwordHash!;
});
afterAll(async () => { await app.close(); await pool.end(); });

describe("response schemas are a whitelist", () => {
  it("no response from any GET route contains the password hash", async () => {
    const ids: Record<string, string> = { walletId: w.wallets.riya, transferId: w.transfers.riyaToAmit, exportId: w.exports.riya };
    const gets = routeTable.filter((r) => r.method === "GET" && !r.url.includes("google"));
    const requests: InjectOptions[] = gets.map((r) => ({
      method: "GET", url: r.url.replace(/:(\w+)/g, (_, name: string) => ids[name] ?? "missing"), headers: bearer(token),
    }));
    requests.push({ method: "POST", url: "/v1/auth/login", payload: { email: w.users.riya.email, password: "correct horse battery staple" } });
    requests.push({ method: "PATCH", url: "/v1/me/phone", headers: bearer(token), payload: { phone: "+91 98765 43210" } });

    const checked: string[] = [];
    for (const req of requests) {
      const res = await app.inject(req);
      expect(res.body).not.toContain(hash);
      expect(res.body).not.toMatch(/\$argon2|password/i);
      checked.push(`${res.statusCode} ${req.method} ${req.url}`);
    }
    console.log(`checked ${checked.length} responses, none contained the hash:\n${checked.join("\n")}`);
  });

  it("drops fields the schema does not name, even when the handler returns the whole record", async () => {
    const res = await app.inject({ method: "GET", url: "/test/whole-record", headers: bearer(token) });
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.json()).sort()).toEqual(["createdAt", "email", "id", "phone", "role"]);
    console.log("whole record in, response out:", res.body);
  });

  it("blocks a response that still carries a hash (the leak guard)", async () => {
    const res = await app.inject({ method: "GET", url: "/test/debug-field", headers: bearer(token) });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain(hash);
    console.log("leak guard:", res.statusCode, res.json().code);
  });

  it("fails closed when a handler breaks its own response contract", async () => {
    const res = await app.inject({ method: "GET", url: "/test/wrong-shape", headers: bearer(token) });
    expect(res.statusCode).toBe(500);
    expect(res.json().code).toBe("INTERNAL_ERROR");
  });
});

describe("routes without a response schema", () => {
  it("stop the app from starting", async () => {
    const noSchema = async (a: FastifyInstance) => {
      a.get("/test/no-schema", { config: { access: { kind: "self" } } }, async () => ({ ok: true }));
    };
    const error = await buildApp({ extraRoutes: noSchema }).then(() => null, (e: Error) => e);
    expect(error?.message).toBe("GET /test/no-schema has no schema for: response");
    console.log("startup error:", error?.message);
  });
});
```

**Real output:**

```text
checked 11 responses, none contained the hash:
200 GET /.well-known/jwks.json
200 GET /v1/wallets/624298f5-56e7-4512-ac6f-34305797c849
200 GET /v1/wallets/624298f5-56e7-4512-ac6f-34305797c849/transactions
200 GET /v1/transfers/3e1b797b-97a5-40a7-b73f-7ef6ce584408
200 GET /v1/statement-exports/6fceb3c1-b59c-4981-9c11-9aa1c5d215d4
200 GET /v1/me
200 GET /test/whole-record
500 GET /test/debug-field
500 GET /test/wrong-shape
200 POST /v1/auth/login
200 PATCH /v1/me/phone
stdout | test/responseLeak.test.ts > response schemas are a whitelist > drops fields the schema does not name, even when the handler returns the whole record
whole record in, response out: {"id":"38757597-a7af-40b5-8d9b-dde71884e300","email":"riya@ledger.test","role":"user","phone":"+919876543210","createdAt":"2026-10-14T04:18:08.362Z"}
stdout | test/responseLeak.test.ts > response schemas are a whitelist > blocks a response that still carries a hash (the leak guard)
leak guard: 500 INTERNAL_ERROR
stdout | test/responseLeak.test.ts > routes without a response schema > stop the app from starting
startup error: GET /test/no-schema has no schema for: response
```

Every response was checked against Riya's real argon2 hash from the database. The whole record went in and five fields came out. The leak guard and the fail-closed serializer each returned a 500. And a route with no response schema stopped the app from starting.

The log side, as one more minimal snippet (`minimal/log-redaction.ts`):

```ts
// minimal/log-redaction.ts — logs are read by many people and kept for months. Keep secrets out.
// Run: npx tsx minimal/log-redaction.ts
import pino from "pino";

const request = {
  headers: { authorization: "Bearer eyJhbGciOi...", cookie: "__Secure-ledger_rt=9fJx...", "user-agent": "LedgerApp/3.2" },
  body: { email: "riya@ledger.test", password: "correct horse battery staple", phone: "+919876543210" },
};

// Beginner way: log the whole request "for debugging".
pino({ base: null, timestamp: false }).info({ req: request }, "login attempt");

// Product way: redact known secret paths, and log a summary instead of the body.
const log = pino({
  base: null, timestamp: false,
  redact: { paths: ["req.headers.authorization", "req.headers.cookie", "req.body.password", "*.otp", "*.secret"], censor: "[REDACTED]" },
});
log.info({ req: { headers: request.headers } }, "login attempt");
log.info({ emailDomain: request.body.email.split("@")[1], hasPhone: Boolean(request.body.phone) }, "login attempt summary");
```

**Real output:**

```text
{"level":30,"req":{"headers":{"authorization":"Bearer eyJhbGciOi...","cookie":"__Secure-ledger_rt=9fJx...","user-agent":"LedgerApp/3.2"},"body":{"email":"riya@ledger.test","password":"correct horse battery staple","phone":"+919876543210"}},"msg":"login attempt"}
{"level":30,"req":{"headers":{"authorization":"[REDACTED]","cookie":"[REDACTED]","user-agent":"LedgerApp/3.2"}},"msg":"login attempt"}
{"level":30,"emailDomain":"ledger.test","hasPhone":true,"msg":"login attempt summary"}
```

The first line is the beginner way: the password and tokens are now in your log storage, readable by everyone with log access, for as long as logs are kept. The second redacts known paths. The third logs a **summary** instead of the body, which is the safest habit.

### Step 4 · gitleaks in pre-commit and CI, with a planted secret

The config, `.gitleaks.toml`:

```toml
# .gitleaks.toml — gitleaks' ~200 built-in rules, plus one for our own API key format.
title = "ledger platform"

[extend]
useDefault = true

[[rules]]
id = "ledger-api-key"
description = "Ledger platform API key"
regex = '''\blk_(live|test)_[A-Za-z0-9]{32}\b'''
keywords = ["lk_live_", "lk_test_"]
tags = ["key", "ledger"]

# Generated files and recorded test fixtures may hold look-alike strings. Keep this list short.
[[allowlists]]
description = "generated code"
paths = ['''^src/generated/''']
```

The hook, `.husky/pre-commit`. If gitleaks is missing, the commit is blocked (fail closed), not silently allowed:

```bash
# .husky/pre-commit — scan only what is staged, before it becomes history. Fails closed.
if ! command -v gitleaks >/dev/null 2>&1; then
  echo "pre-commit: gitleaks is not installed, so this commit is blocked." >&2
  echo "Install it (brew install gitleaks, or a release binary), then commit again." >&2
  exit 1
fi
gitleaks git --pre-commit --staged --redact --verbose
```

The CI job, `.github/workflows/gitleaks.yml`:

```yaml
# .github/workflows/gitleaks.yml — the hook can be skipped (git commit --no-verify). CI cannot.
name: gitleaks
on:
  pull_request:
  push:
    branches: [main]
  schedule:
    - cron: "30 3 * * *" # daily: new built-in rules also scan old history
jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0 # full history: a secret deleted in a later commit is still leaked
      - uses: gitleaks/gitleaks-action@v3
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          GITLEAKS_LICENSE: ${{ secrets.GITLEAKS_LICENSE }} # free key; needed for organisation repos only
```

**What to notice**
- `useDefault = true` keeps gitleaks' built-in rules; our rule only adds the `lk_` key format. `keywords` let gitleaks skip files that cannot match, which keeps the hook fast.
- The allowlist uses `[[allowlists]]` (plural, the form since gitleaks v8.25). Keep it short: every allowlisted path is a place nobody scans.
- The hook scans only staged changes, and `--redact` keeps the secret out of your terminal and CI logs.
- CI fetches full history and also runs daily, so new built-in rules are applied to old commits.

`.gitignore` and `.env.example`:

```gitignore
node_modules/
dist/
# Real values never enter git. .env is for your laptop only; .env.example documents every variable.
.env
.env.*
!.env.example
secrets/
*.pem
```

```bash
# .env.example — every variable the API reads. Copy to .env for local work; never commit .env.
NODE_ENV=development
PORT=3000
LOG_LEVEL=info
TRUST_PROXY=false

# Local only. In staging and production use DATABASE_SECRET_FILE (a mounted secret, AWS RDS JSON shape).
DATABASE_URL=postgres://ledger:ledger@localhost:5432/ledger_dev
# DATABASE_SECRET_FILE=/run/secrets/database.json
DATABASE_SECRET_REFRESH_SECONDS=30

BODY_LIMIT_BYTES=65536
JSON_MAX_DEPTH=20
REQUEST_TIMEOUT_MS=10000
LEAK_GUARD=block

AUTH_ISSUER=http://localhost:3000
APP_ORIGIN=http://localhost:5173
PUBLIC_BASE_URL=http://localhost:3000

# Secrets: give a file path (NAME_FILE). Locally you may set NAME directly in .env instead.
JWT_PRIVATE_JWKS_FILE=./secrets/jwks.json
OTP_PEPPER_FILE=./secrets/otp_pepper
# GOOGLE_CLIENT_ID=
# GOOGLE_CLIENT_SECRET_FILE=./secrets/google_client_secret
```

**Plant a fake secret.** Generate it at runtime, so no real-looking key is ever typed into a file by hand:

```bash
KEY="lk_live_$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 32)"
printf 'export const LEDGER_KEY = "%s";\n' "$KEY" > src/config/plantedKey.ts
git add src/config/plantedKey.ts
git commit -m "test: planted fake key"                 # 1. the hook should block this
git commit --no-verify -m "test: planted fake key"     # 2. skip the hook on purpose
git push origin HEAD:test/planted-secret               # 3. CI must fail on the push
```

**Expected** output of step 1 (gitleaks 8.x prints one block per finding; your entropy, line and fingerprint values will differ, and `--redact` hides the secret):

```text
Finding:     export const LEDGER_KEY = "REDACTED";
Secret:      REDACTED
RuleID:      ledger-api-key
Entropy:     (a number around 5)
File:        src/config/plantedKey.ts
Line:        1
Fingerprint: src/config/plantedKey.ts:ledger-api-key:1

WRN leaks found: 1
```

The commit does not happen (exit code 1). After step 3, the **Expected** result is a red "gitleaks" check on the branch and a job summary naming `ledger-api-key`. Then clean up: delete the branch and the file, and treat the key as leaked even though it is fake. Practising "rotate first" on a fake key is cheap.

**What was run here.** The gitleaks binary could not be downloaded in this sandbox, so two parts were checked directly.

The custom rule, with a key generated at runtime (`scripts/check-gitleaks-config.py`):

```python
# scripts/check-gitleaks-config.py — parse .gitleaks.toml and test our custom rule against a key made at runtime.
# (The gitleaks binary could not be downloaded here, so the rule's regex is checked directly.)
import re, secrets, string, sys, tomllib
cfg = tomllib.load(open(sys.argv[1], "rb"))
rule = next(r for r in cfg["rules"] if r["id"] == "ledger-api-key")
pattern = re.compile(rule["regex"])
alphabet = string.ascii_letters + string.digits
fake = "lk_live_" + "".join(secrets.choice(alphabet) for _ in range(32))  # planted, never stored
redact = lambda s: s[:8] + "*" * (len(s) - 8)
cases = {
    f'const LEDGER_KEY = "{fake}";': True,
    f"Authorization: Bearer {fake}": True,
    "lk_live_tooShort123": False,
    "docs say keys look like lk_live_ followed by 32 letters or digits": False,
    f'id = "{fake}x"': False,  # 33 chars: not our format
}
print(f"config parsed: extend.useDefault={cfg['extend']['useDefault']}, rules={len(cfg['rules'])}, allowlists={len(cfg['allowlists'])}")
ok = True
for line, expected in cases.items():
    hit = bool(pattern.search(line))
    ok &= hit == expected
    print(f"{'ok ' if hit == expected else 'BAD'} {'flagged' if hit else 'clean  '}  {line.replace(fake, redact(fake))[:70]}")
sys.exit(0 if ok else 1)
```

**Real output:**

```text
config parsed: extend.useDefault=True, rules=1, allowlists=1
ok  flagged  const LEDGER_KEY = "lk_live_********************************";
ok  flagged  Authorization: Bearer lk_live_********************************
ok  clean    lk_live_tooShort123
ok  clean    docs say keys look like lk_live_ followed by 32 letters or digits
ok  clean    id = "lk_live_********************************x"
```

The hook's fail-closed path, in a fresh git repo with one staged file and no gitleaks on the `PATH`. **Real output:**

```text
pre-commit: gitleaks is not installed, so this commit is blocked.
Install it (brew install gitleaks, or a release binary), then commit again.
exit code: 1
```

### Step 5 · Body-size limit (and friends), tested with an oversized payload

`src/http/jsonBodyParser.ts`: JSON only, a depth check on the raw text, prototype-poisoning protection.

```ts
// src/http/jsonBodyParser.ts — Fastify's JSON parser plus a nesting-depth limit, checked before parsing.
import type { FastifyInstance } from "fastify";
import secureJson from "secure-json-parse";
import { ApiError } from "../lib/problem.js";

// One pass over the raw text. No recursion, so a hostile body cannot overflow our stack while we measure it.
export function jsonDepth(text: string): number {
  let deepest = 0, current = 0, inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (inString) {
      if (c === 92) i++; // backslash: skip the escaped character
      else if (c === 34) inString = false;
    } else if (c === 34) inString = true;
    else if (c === 91 || c === 123) deepest = Math.max(deepest, ++current);
    else if (c === 93 || c === 125) current--;
  }
  return deepest;
}

export function registerJsonBodyParser(app: FastifyInstance, opts: { maxDepth: number }): void {
  // JSON only. Fastify also accepts text/plain by default, and text/plain is a CORS "simple" content type:
  // a hostile page can POST it cross-site without a preflight. Anything that is not JSON now gets 415.
  app.removeAllContentTypeParsers();
  // parseAs "string" still enforces bodyLimit while the bytes stream in (413 before we see them).
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_request, body, done) => {
    const text = String(body);
    if (text.trim() === "") return done(null, undefined); // body-less POSTs; EmptyBody decides if that is ok
    if (jsonDepth(text) > opts.maxDepth) {
      return done(new ApiError(400, "JSON_TOO_DEEP", "Request body is nested too deeply", `Maximum depth is ${opts.maxDepth}.`));
    }
    try {
      // Same protections as Fastify's default parser: refuse __proto__ and constructor.prototype keys.
      done(null, secureJson.parse(text, undefined, { protoAction: "error", constructorAction: "error" }));
    } catch {
      done(new ApiError(400, "MALFORMED_JSON", "Request body is not valid JSON"));
    }
  });
}
```

The error handler keeps Fastify's 413 and 415 as real status codes (`src/plugins/errorHandler.ts`, excerpt). In P1-03 every framework 4xx became a 400, and building this lab exposed that bug:

```ts
// Fastify's own 4xx errors keep their status; only the shape changes to a Problem.
const FASTIFY_4XX: Record<number, () => ApiError> = {
  413: () => new ApiError(413, "PAYLOAD_TOO_LARGE", "Request body is too large"),
  415: () => new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "Send the body as application/json"),
};

function toApiError(error: FastifyError | ApiError): ApiError {
  if (error instanceof ApiError) return error;
  const status = "statusCode" in error ? error.statusCode : undefined;
  if (status && FASTIFY_4XX[status]) return FASTIFY_4XX[status]();
  // Other framework 4xx (bad content-length, empty JSON...). Safe to describe.
  if (status && status >= 400 && status < 500) return errors.malformed(error.message);
  // Anything else is a bug or an outage. The client gets a generic message; the logs get the truth.
  return errors.internal();
}
```

The test runs a **real listening server**, because 408 and 431 come from Node's HTTP layer and never reach `app.inject()`:

```ts
// test/limits.test.ts — request limits on a real listening server: 413, 408 and 431 come from different layers.
import { connect } from "node:net";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";

process.env.REQUEST_TIMEOUT_MS = "1000"; // short, so the slow-client test is quick
const { buildApp } = await import("../src/app.js");
const { pool } = await import("../src/db/pool.js");

let app: FastifyInstance, port: number;
beforeAll(async () => {
  app = await buildApp();
  await app.listen({ port: 0, host: "127.0.0.1" });
  port = (app.server.address() as { port: number }).port;
});
afterAll(async () => { await app.close(); await pool.end(); });

// Send raw bytes, return the status line and how long the server took to answer.
function raw(chunks: string[], gapMs = 0): Promise<{ status: string; ms: number }> {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const socket = connect(port, "127.0.0.1", async () => {
      for (const c of chunks) {
        if (socket.destroyed) break;
        socket.write(c);
        if (gapMs) await new Promise((r) => setTimeout(r, gapMs));
      }
    });
    let data = "";
    socket.on("data", (d) => { data += d.toString(); socket.destroy(); });
    socket.on("close", () => resolve({ status: data.split("\r\n")[0] ?? "(no response)", ms: Math.round(performance.now() - started) }));
    socket.on("error", reject);
  });
}

const results: string[] = [];
afterAll(() => console.log(results.join("\n")));

it("rejects a body over BODY_LIMIT_BYTES with 413, before parsing it", async () => {
  const body = JSON.stringify({ email: "riya@ledger.test", password: "x".repeat(70_000) });
  const res = await fetch(`http://127.0.0.1:${port}/v1/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body });
  const problem = (await res.json()) as { code: string };
  results.push(`${res.status} ${problem.code} — ${body.length} byte body, limit 65536`);
  expect(res.status).toBe(413);
  expect(problem.code).toBe("PAYLOAD_TOO_LARGE");
});

it("also stops a chunked body (no Content-Length) once it crosses the limit", async () => {
  const head = "POST /v1/auth/login HTTP/1.1\r\nHost: t\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n";
  const chunk = `4000\r\n${"a".repeat(0x4000)}\r\n`; // 16 KiB per chunk
  const r = await raw([head, ...Array<string>(10).fill(chunk)], 20);
  results.push(`${r.status} after ${r.ms} ms — chunked body, 16 KiB chunks`);
  expect(r.status).toBe("HTTP/1.1 413 Payload Too Large");
});

it("gives up on a client that sends its body too slowly (408)", async () => {
  const head = "POST /v1/auth/login HTTP/1.1\r\nHost: t\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{";
  const r = await raw([head]); // promises 100 bytes, sends 1, then waits
  results.push(`${r.status} after ${r.ms} ms — REQUEST_TIMEOUT_MS=1000, checked every 2000 ms`);
  expect(r.status).toBe("HTTP/1.1 408 Request Timeout");
  expect(r.ms).toBeLessThan(4_000);
});

it("refuses a header block larger than 16 KiB (431)", async () => {
  const r = await raw([`GET /v1/me HTTP/1.1\r\nHost: t\r\nX-Pad: ${"a".repeat(20_000)}\r\n\r\n`]);
  results.push(`${r.status} after ${r.ms} ms — 20000 byte header`);
  expect(r.status).toBe("HTTP/1.1 431 Request Header Fields Too Large");
});
```

**Real output:**

```text
413 PAYLOAD_TOO_LARGE — 70042 byte body, limit 65536
HTTP/1.1 413 Payload Too Large after 108 ms — chunked body, 16 KiB chunks
HTTP/1.1 408 Request Timeout after 1820 ms — REQUEST_TIMEOUT_MS=1000, checked every 2000 ms
HTTP/1.1 431 Request Header Fields Too Large after 3 ms — 20000 byte header
      Tests  4 passed (4)
```

**What to notice**
- The 413 for a body with a `Content-Length` came without reading the body. The chunked one stopped once the running total crossed 64 KiB.
- The 408 came after 1.8 s with a 1 s limit: the limit plus up to one checking interval (2 s).
- 408 and 431 are written by Node and Fastify's client-error handler, not by our error handler, so their bodies are not Problem Details. That is fine: the client is often gone by then.
- Building this test found two configuration traps: `connectionTimeout` equal to the request timeout silently **dropped** the slow client (no 408 at all, socket closed at 1,003 ms), and `requestTimeout` alone was ineffective because of `headersTimeout` (Deep dive 8).

Manual check with curl. **Expected:** `413`, and a Problem body with `"code":"PAYLOAD_TOO_LARGE"`.

```bash
head -c 70000 /dev/zero | tr '\0' 'x' | sed 's/^/{"email":"riya@ledger.test","password":"/; s/$/"}/' \
  | curl -s -o /dev/null -w "%{http_code}\n" -H 'content-type: application/json' --data-binary @- \
    http://localhost:3000/v1/auth/login
```

### Step 6 · The database password from a secret file, and rotation with two valid credentials

The secret file uses the same JSON keys as an AWS Secrets Manager RDS secret, so the file can be written by AWS's rotation (through the Secrets Store CSI driver), by Vault Agent, or by hand. `src/db/databaseSecret.ts`:

```ts
// src/db/databaseSecret.ts — read database credentials from a mounted secret file (AWS Secrets Manager's RDS shape).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type pg from "pg";
import { z } from "zod";

// Same keys AWS uses for an RDS secret, so the file can be written by its rotation Lambda or by Vault.
const DatabaseSecret = z.object({
  engine: z.literal("postgres").optional(),
  host: z.string().min(1),
  port: z.int().min(1).max(65535).default(5432),
  dbname: z.string().min(1).default("postgres"),
  username: z.string().min(1),
  password: z.string().min(1),
});

export interface Connection { identity: string; config: pg.ClientConfig }

export function readDatabaseSecret(path: string): Connection {
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`database secret ${path}: ${(err as NodeJS.ErrnoException).code ?? "not valid JSON"}`);
  }
  const parsed = DatabaseSecret.safeParse(json);
  // Report which keys are wrong, never their values.
  if (!parsed.success) throw new Error(`database secret ${path}: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")} invalid`);
  const s = parsed.data;
  return {
    // A hash, so "did the credentials change?" can be answered (and logged) without exposing them.
    identity: createHash("sha256").update(JSON.stringify(s)).digest("hex"),
    config: { host: s.host, port: s.port, database: s.dbname, user: s.username, password: s.password },
  };
}
```

The pool that picks up a new secret without a restart, `src/db/rotatingPool.ts`:

```ts
// src/db/rotatingPool.ts — a pg pool that picks up rotated credentials without a restart or a dropped request.
import pg from "pg";
import type { Logger } from "pino";
import type { Connection } from "./databaseSecret.js";

// What repositories need: "something I can run a query on". A PoolClient (inside a transaction) fits too.
export interface Queryable {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<R>>;
}

export class RotatingPool implements Queryable {
  #pool: pg.Pool;
  #identity: string;
  #timer: NodeJS.Timeout | undefined;
  #refreshing: Promise<boolean> | undefined;

  constructor(
    private readonly loadConnection: () => Connection, // re-read on every refresh
    private readonly base: pg.PoolConfig,              // timeouts and sizes, shared by every pool we build
    private readonly log: Logger,
  ) {
    const first = loadConnection();
    this.#identity = first.identity;
    this.#pool = this.#build(first);
  }

  #build(c: Connection): pg.Pool {
    const pool = new pg.Pool({ ...this.base, ...c.config });
    pool.on("error", (err) => this.log.error({ err }, "idle database client error"));
    return pool;
  }

  async connect(): Promise<pg.PoolClient> {
    try {
      return await this.#pool.connect();
    } catch (err) {
      // 28P01 = invalid_password: the credentials changed under us. Re-read the secret once, then retry.
      if ((err as { code?: string }).code !== "28P01" || !(await this.refresh())) throw err;
      return this.#pool.connect();
    }
  }

  async query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<R>> {
    const client = await this.connect();
    try {
      const result = await client.query<R>(text, values);
      client.release();
      return result;
    } catch (err) {
      client.release(err as Error); // like pg's own pool.query: a client that errored is not reused
      throw err;
    }
  }

  // Re-read the secret. If it changed: build a new pool, PROVE it works, swap, then drain the old one.
  refresh(): Promise<boolean> {
    this.#refreshing ??= this.#swapIfChanged().finally(() => { this.#refreshing = undefined; });
    return this.#refreshing;
  }

  async #swapIfChanged(): Promise<boolean> {
    const next = this.loadConnection();
    if (next.identity === this.#identity) return false;
    const candidate = this.#build(next);
    try {
      await candidate.query("SELECT 1");
    } catch (err) {
      await candidate.end();
      this.log.error({ err }, "new database credentials do not work; keeping the current ones");
      return false;
    }
    const old = this.#pool;
    this.#pool = candidate;
    this.#identity = next.identity;
    this.log.info({ user: next.config.user }, "database credentials rotated");
    // end() lets checked-out clients finish their queries, then closes them: in-flight work is not cut off.
    old.end().catch((err: unknown) => this.log.error({ err }, "closing the old database pool failed"));
    return true;
  }

  startAutoRefresh(everySeconds: number): void {
    this.#timer = setInterval(() => {
      this.refresh().catch((err: unknown) => this.log.error({ err }, "database secret refresh failed"));
    }, everySeconds * 1000);
    this.#timer.unref(); // never keep the process alive just for this
  }

  async end(): Promise<void> {
    clearInterval(this.#timer);
    await this.#refreshing?.catch(() => undefined);
    await this.#pool.end();
  }
}
```

And the process-wide pool, `src/db/pool.ts`:

```ts
// src/db/pool.ts — the process-wide database handle: secret file in real environments, URL for local work.
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { type Connection, readDatabaseSecret } from "./databaseSecret.js";
import { RotatingPool } from "./rotatingPool.js";

const secretFile = env.DATABASE_SECRET_FILE;
const localUrl = env.DATABASE_URL;
const loadConnection = (): Connection =>
  secretFile ? readDatabaseSecret(secretFile) : { identity: "url", config: { connectionString: localUrl } };

export const pool = new RotatingPool(loadConnection, {
  max: 10,
  connectionTimeoutMillis: 2_000,
  statement_timeout: 5_000,
  query_timeout: 6_000,
  idle_in_transaction_session_timeout: 10_000,
}, logger);

if (secretFile) pool.startAutoRefresh(env.DATABASE_SECRET_REFRESH_SECONDS);
```

**What to notice**
- `refresh()` is single-flight: ten requests failing at once trigger **one** re-read.
- A new pool must answer `SELECT 1` **before** it replaces the old one. A broken new secret keeps the old, working pool.
- `old.end()` lets in-flight queries finish. Nothing is cut off mid-transaction.
- On `28P01` (invalid password), `connect()` re-reads the secret once and retries. That covers a pod whose timer has not fired yet.
- The identity is a SHA-256 of the secret, so "did it change?" can be logged without logging the secret.

**Roles in Postgres**, the same statements the test runs (passwords are generated at runtime in the test; in real life the rotation job sets them):

```sql
CREATE ROLE ledger_app NOLOGIN;                       -- holds the permissions
GRANT USAGE ON SCHEMA public TO ledger_app;           -- needed when the schema was made with CREATE SCHEMA
GRANT SELECT ON wallets TO ledger_app;                -- the test only reads; the real app gets its DML grants here
CREATE ROLE ledger_app_blue  LOGIN IN ROLE ledger_app PASSWORD '...';
CREATE ROLE ledger_app_green LOGIN IN ROLE ledger_app PASSWORD '...';
```

The first test run failed with `42P01` ("relation does not exist") on every query. The test drops and recreates the `public` schema, and a freshly created schema has no `USAGE` grant for other roles. That is least privilege doing its job, and the `GRANT USAGE` line fixed it.

**Diagram: rotating the database password with alternating users**

```mermaid
sequenceDiagram
  participant R as Rotation job
  participant SM as Secret manager
  participant DB as Postgres
  participant App as App pool
  Note over App,DB: App connects as blue. Green exists, idle.
  R->>DB: 1. ALTER ROLE green PASSWORD new
  R->>SM: 2. Save green and new password as current
  SM-->>App: 3. Secret file rewritten on every pod
  App->>App: 4. Refresh timer re-reads the file
  App->>DB: 5. New pool as green, SELECT 1
  DB-->>App: ok
  App->>App: 6. Swap pools, drain the blue pool
  Note over App,DB: Blue and green both valid, no failed queries
  R->>DB: 7. Later: change blue password, old secret dies
```

**How to read this diagram.** Time runs downwards. Steps 1-2 happen in the secret manager's rotation job; steps 3-6 happen on every app pod, at its own pace. The two notes mark the key states: before rotation one user is in use and one is idle, and during the switch both are valid, so it does not matter which pods have switched yet. Step 7 retires the old credentials only after every pod has moved, and it prepares blue as the idle user for the next rotation.

The test, `test/rotation.test.ts`: 4 workers query non-stop for 4 seconds while the password changes. `maxLifetimeSeconds: 1` recycles connections every second, standing in for pods scaling up or a pool growing. (Without it, open connections stay logged in and hide the problem: a password change does not end existing sessions.)

```ts
// test/rotation.test.ts — rotate the database password under live traffic. Needs Postgres with password auth
// for members of ledger_app over TCP (Docker's postgres image does this by default).
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { pino } from "pino";
import { afterAll, beforeAll, expect, it } from "vitest";
import { readDatabaseSecret } from "../src/db/databaseSecret.js";
import { RotatingPool } from "../src/db/rotatingPool.js";
import { resetDatabase } from "./helpers/db.js";

const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL }); // a superuser connection
const database = new URL(process.env.DATABASE_URL!).pathname.slice(1); // same database, different users
const dir = mkdtempSync(join(tmpdir(), "ledger-secret-"));
const secretFile = join(dir, "database.json");
const newPassword = () => randomBytes(24).toString("base64url"); // made at runtime, never written in code
const writeSecret = (username: string, password: string) =>
  writeFileSync(secretFile, JSON.stringify({ engine: "postgres", host: "127.0.0.1", port: 5432, dbname: database, username, password }), { mode: 0o600 });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  await resetDatabase();
  await admin.query(`DROP ROLE IF EXISTS ledger_app_solo; DROP ROLE IF EXISTS ledger_app_blue; DROP ROLE IF EXISTS ledger_app_green;
    DROP ROLE IF EXISTS ledger_app; CREATE ROLE ledger_app NOLOGIN;
    GRANT USAGE ON SCHEMA public TO ledger_app; GRANT SELECT ON wallets TO ledger_app;`);
  // Least privilege: the LOGIN users own nothing and can do only what ledger_app can do.
  for (const user of ["ledger_app_solo", "ledger_app_blue", "ledger_app_green"]) {
    await admin.query(`CREATE ROLE ${user} LOGIN IN ROLE ledger_app PASSWORD '${newPassword()}'`);
  }
});
afterAll(async () => { await admin.end(); });

const setPassword = (user: string, password: string) => admin.query(`ALTER ROLE ${user} PASSWORD '${password}'`);

// 4 workers query non-stop. maxLifetimeSeconds: 1 recycles connections, like pods scaling or a pool growing.
async function underTraffic(rotate: (log: (s: string) => void) => Promise<void>) {
  const events: string[] = [];
  const started = Date.now();
  const log = (s: string) => events.push(`${String(Date.now() - started).padStart(5)} ms  ${s}`);
  const logger = pino({ level: "info" }, { write: (line: string) => log(JSON.parse(line).msg as string) });
  const pool = new RotatingPool(() => readDatabaseSecret(secretFile), { max: 4, maxLifetimeSeconds: 1 }, logger);
  pool.startAutoRefresh(1);
  let ok = 0, failed = 0, firstFailure = "";
  const stopAt = Date.now() + 4000;
  const worker = async () => {
    while (Date.now() < stopAt) {
      try { await pool.query("SELECT count(*) FROM wallets"); ok++; }
      catch (err) { failed++; firstFailure ||= `${(err as { code?: string }).code}`; }
      await sleep(5);
    }
  };
  await Promise.all([worker(), worker(), worker(), worker(), rotate(log)]);
  await pool.end();
  return { ok, failed, firstFailure, events };
}

it("single user: changing the password breaks new connections until every app has the new secret", async () => {
  const p1 = newPassword(), p2 = newPassword();
  await setPassword("ledger_app_solo", p1);
  writeSecret("ledger_app_solo", p1);
  const r = await underTraffic(async (log) => {
    await sleep(1000); await setPassword("ledger_app_solo", p2); log("ALTER ROLE solo: new password in the database");
    await sleep(1000); writeSecret("ledger_app_solo", p2); log("secret file updated");
  });
  console.log(`single user: ${r.ok} ok, ${r.failed} failed (first: ${r.firstFailure})\n${r.events.join("\n")}`);
  expect(r.failed).toBeGreaterThan(0);
});

it("alternating users: two valid credentials at once, zero failed queries", async () => {
  const blue = newPassword();
  await setPassword("ledger_app_blue", blue);
  writeSecret("ledger_app_blue", blue);
  const r = await underTraffic(async (log) => {
    await sleep(1000);
    const green = newPassword();
    await setPassword("ledger_app_green", green); log("1. new password set on the idle user (green)");
    writeSecret("ledger_app_green", green); log("2. secret file now points at green");
    await sleep(2000);
    await setPassword("ledger_app_blue", newPassword()); log("3. old user (blue) password changed: old secret is dead");
  });
  console.log(`alternating users: ${r.ok} ok, ${r.failed} failed\n${r.events.join("\n")}`);
  expect(r.failed).toBe(0);

  // The old credentials really are dead now.
  const old = new pg.Client({ host: "127.0.0.1", port: 5432, database, user: "ledger_app_blue", password: blue });
  const error = await old.connect().then(() => null, (e: { code?: string }) => e.code);
  await old.end().catch(() => undefined);
  console.log("connect with the old blue password:", error);
  expect(error).toBe("28P01");
});
```

**Real output:**

```text
single user: 1966 ok, 157 failed (first: 28P01)
 1023 ms  ALTER ROLE solo: new password in the database
 2024 ms  secret file updated
 2046 ms  database credentials rotated
stdout | test/rotation.test.ts > alternating users: two valid credentials at once, zero failed queries
alternating users: 2656 ok, 0 failed
 1012 ms  1. new password set on the idle user (green)
 1013 ms  2. secret file now points at green
 2015 ms  database credentials rotated
 3027 ms  3. old user (blue) password changed: old secret is dead
stdout | test/rotation.test.ts > alternating users: two valid credentials at once, zero failed queries
connect with the old blue password: 28P01
```

**What to notice**
- **Single user:** 157 failed queries (the first was `28P01`, invalid password), in the second between `ALTER ROLE` and the file update. In production that second is however long your secret takes to reach every pod.
- **Alternating users:** 0 failures in 2,656 queries. The pool switched to green about 1 s after the file changed (the refresh timer), and blue stayed valid the whole time.
- After step 3, the old blue password really is dead (`28P01`).

**Run everything:**

```bash
export DATABASE_URL=postgres://postgres:postgres@localhost:5432/ledger
npx tsc -p .                 # strict, no errors
npx vitest run               # all 11 files
```

**Real output** (summary lines):

```text
Test Files  11 passed (11)
Tests  142 passed (142)
```

---

## 🔨 Break it and measure it

Do these on your machine. Each turns a rule from this card into a failure you have seen.

1. **Make the transfer body a stripping object.** In `transfers.ts`, change `z.strictObject` to `z.object`. Run `test/validation.test.ts`. *Expected:* "unknown field" fails: the request with `fee: 0` is accepted and a transfer is created.
2. **Go back to coercion.** Replace `PageLimit` with `z.coerce.number().int().min(1).max(100).default(50)`. *Expected:* `limit=1e2` is accepted as 100, and its row in the table fails.
3. **Remove `.meta({ format: "email" })` from `Email`.** Run the contract test. *Seen while writing this guide:* two `format spec=email code=-` differences.
4. **Delete `response` from `/v1/me`.** Start the server. *Expected:* the app refuses to start with `GET /v1/me has no schema for: response` (the leak test saw exactly this message for a test route).
5. **Put `passwordHash: z.string().nullable()` into `MeResponse`.** Run `test/responseLeak.test.ts`. *Expected:* the crawl fails. With `LEAK_GUARD=block`, `/v1/me` returns 500 and the log names the route. Switch to `LEAK_GUARD=log` and see the hash go out, which is why `block` is the default.
6. **Use `z.coerce.boolean()` for `TRUST_PROXY`.** Run `test/config.test.ts`. *Expected:* "returns a typed, frozen config" fails: `"false"` became `true`.
7. **Remove `http.headersTimeout` from `app.ts`.** Run `test/limits.test.ts`. *Seen while writing this guide:* the 408 test hangs until Vitest's 20 s timeout. No 408 within the limit you set.
8. **Add `connectionTimeout: env.REQUEST_TIMEOUT_MS` back.** *Seen while writing this guide:* the slow client's socket closes at about 1,000 ms with **no** response at all.
9. **Hide the rotation problem.** In `rotation.test.ts`, remove `maxLifetimeSeconds: 1`. *Expected:* the single-user test may see 0 failures, because open connections stay logged in. The problem is still there; it shows up when a pod restarts or the pool grows.
10. **Fetch the secret on every query.** Change `loadConnection` to call a fake "secret manager" that sleeps 20 ms. *Expected:* every query gets 20 ms slower. Compare with the $2,592 per month from Deep dive 7.

**Measurements**

| Measure (from the card) | This guide's run (**Real output**) | Your machine |
|---|---|---|
| Malformed-input cases rejected with 400 or 422 | **31 of 31**: 27 × 400, 3 × 422, plus 1 × 415 for `text/plain` | fill after running the lab on your machine |
| Startup failure on invalid config | Exit code **1**, 7 problems in one run, 0 values printed, no port opened | fill after running the lab on your machine |
| CI catching the planted secret | Not run here (gitleaks download blocked). Rule check: 5 of 5 cases right; hook blocks the commit when gitleaks is missing | fill after running the lab on your machine |
| Spec vs code differences (contract test) | 39 on the first run → 0 unexpected (10 documented) | fill after running the lab on your machine |
| Password hash in any response | 0 of 11 responses (3 test routes: stripped, blocked, fail-closed) | fill after running the lab on your machine |
| Failed queries during DB password rotation, 4 s of traffic | Single user **157**; alternating users **0** of 2,656 | fill after running the lab on your machine |
| Slow-body 408 with a 1 s limit | 1,820 ms (limit + checking interval) | fill after running the lab on your machine |
| Cost of a Zod response check | 1.82 µs vs 0.96 µs for plain `JSON.stringify` | fill after running the lab on your machine |

---

## 🚫 Common mistakes and wrong mental models

### Wrong mental model: "TypeScript types validate my input"

Types are erased when TypeScript compiles to JavaScript. At runtime, `request.body as CreateTransferRequest` is just `request.body`. The compiler trusted you; nobody checked the data.

**Beginner way**

```ts
app.post("/v1/transfers", async (request) => {
  const body = request.body as CreateTransferRequest; // a promise to the compiler, not a check
  return createTransfer(body);                         // "500" + 10 === "50010"
});
```

**Product way**

```ts
app.post("/v1/transfers", {
  schema: { body: createTransferBody, response: { 201: TransferResponse } }, // checked at runtime
}, async (request) => createTransfer(request.body)); // request.body is the PARSED value
```

What breaks in the beginner way: wrong types, extra fields and missing fields all reach the service. The first symptom is usually wrong data in the database, not an error.

**Correct model:** types describe data **after** a runtime check. At the edge, the schema is the check, and the type is inferred from it.

### Validating only in the frontend

React Hook Form plus Zod in the app gives users quick feedback. It protects nothing. Anyone can call your API with `curl`, Postman or a modified APK.

**Beginner way**

```ts
// web/TransferForm.tsx: the only check
const schema = z.object({ amount: z.number().positive() });
// server: trusts whatever arrives
```

**Product way**

```ts
// packages/contracts/transfer.ts: one schema, imported by the app AND the API
export const createTransferBody = z.strictObject({ /* ... */ });
// web: createTransferBody for instant feedback. api: the same schema at the edge, always.
```

Sharing the schema is good. Skipping it on the server is the mistake.

### Silently defaulting missing config

**Beginner way**

```ts
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL }); // undefined? no error yet
const port = Number(process.env.PORT) || 3000;
```

What that does at runtime, as a minimal file:

```ts
// minimal/missing-env.ts — what a missing DATABASE_URL does when nobody checks it at boot.
// Run: env -u DATABASE_URL npx tsx minimal/missing-env.ts
import pg from "pg";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL }); // undefined, and no error yet
console.log("pool created; DATABASE_URL is", JSON.stringify(process.env.DATABASE_URL));
try {
  await pool.query("SELECT 1"); // the first query is where it finally fails, or worse, succeeds somewhere else
  console.log("connected... to some database on localhost");
} catch (err) {
  console.log("first query failed:", (err as Error).message);
  console.log(`pg quietly tried: host=localhost port=5432 user=${process.env.USER ?? "(OS user)"}`);
} finally {
  await pool.end();
}
```

**Real output** (run with `DATABASE_URL` unset):

```text
pool created; DATABASE_URL is undefined
first query failed: role "root" does not exist
pg quietly tried: host=localhost port=5432 user=root
```

The pool was created without complaint. node-postgres fell back to `localhost:5432` as the operating-system user. Here that failed at the first query. On a machine where that database exists, it would **connect**, to the wrong database.

**Product way:** `DATABASE_SECRET_FILE` or `DATABASE_URL` is required, checked at boot; production refuses `DATABASE_URL` entirely; and `PORT=80a` is an error, not 3000.

### Logging full request bodies with secrets and PII

**Beginner way**

```ts
app.addHook("preHandler", async (request) => { request.log.info({ body: request.body }, "request"); });
```

This writes passwords, OTPs, phone numbers and PAN numbers into log storage. That storage is read by many people, copied to other tools and kept for months. In India, the Digital Personal Data Protection Act, 2023 applies to personal data wherever you keep it, logs included, so this is a legal risk as well as a security one.

**Product way:** pino `redact` for known paths (step 3), and log a **summary** (`emailDomain`, `hasPhone`, IDs), never the body.

### More mistakes seen in real code

- **Validating again inside services.** Two copies of a rule drift apart. Validate shape once at the edge; check only business rules inside.
- **`z.object` (strip) for request bodies.** Client mistakes vanish silently. Use `z.strictObject`.
- **`z.coerce` for env vars and query strings.** `"false"` → `true`, `""` → `0`, `"1e2"` → `100`.
- **`parseFloat` for money.** Use integer paise, and parse human input as text.
- **Returning database rows.** Next quarter's column becomes public. Use a response schema.
- **Echoing input in error messages.** `"Invalid value: <the value>"` copies secrets into logs and can carry script into an admin dashboard. Name the field and the rule, never the value.
- **One DB user for the app and for migrations.** The app can then drop tables. Use a separate migration user.
- **Deleting a leaked secret's commit instead of rotating it.** The clones still have it. Rotate first.
- **Fetching secrets on every request.** Slow and expensive. Cache in memory, refresh on a timer.

---

## ✅ Production checklist

**Validation**
- [ ] Every route declares `params` (if any), `querystring` (if any), `body` (for POST, PUT, PATCH) and `response`. The app refuses to start otherwise.
- [ ] Request objects are strict; response objects strip; header schemas are loose.
- [ ] Every string has a max length; every array has a max size; every number has a range.
- [ ] Money is integer minor units; currency is an exact enum; dates are real dates.
- [ ] Human text is normalised (NFC, format characters removed, trimmed) before its length is checked.
- [ ] Phone numbers are stored in E.164; emails are compared case-insensitively.
- [ ] Rules across fields live in domain parsers and return 422; shape errors return 400 with field pointers.
- [ ] The contract test (code vs OpenAPI) runs in CI, and every known difference has a written reason.

**Responses and logs**
- [ ] Every response schema `satisfies` the generated OpenAPI type.
- [ ] A test proves the password hash (and other secrets) never appears in any response.
- [ ] The leak guard is in `block` mode in production.
- [ ] Logs redact auth headers, cookies, idempotency keys, passwords, OTPs and tokens; bodies are never logged whole.

**Config**
- [ ] One build artifact for every environment; no environment names in code.
- [ ] Config is parsed once at boot into a frozen, typed object; nothing else reads `process.env`.
- [ ] Invalid config prints every problem (no values) and exits 1 before opening a port.
- [ ] No silent defaults for anything environment-specific (DB, URLs, keys).

**Secrets**
- [ ] No secrets in git; `.env` is ignored and `.env.example` is complete.
- [ ] gitleaks runs as a pre-commit hook (failing closed) and as a required CI check on full history.
- [ ] Production secrets come from files (or a secret manager SDK), never plain env vars.
- [ ] The DB password rotates with alternating users (or dynamic credentials), and a rotation drill has been run under traffic.
- [ ] The app's DB user cannot change the schema; the app's IAM role can read only its own secrets.
- [ ] There is a written "secret leaked" runbook: rotate, check access logs, clean history, add a rule.

**Limits**
- [ ] `bodyLimit`, `requestTimeout` **and** `http.headersTimeout`, `maxHeaderSize` and JSON depth are set from config, with tests on a real listening server.
- [ ] JSON-only content types (415 for anything else).
- [ ] The load balancer or proxy has matching limits.

---

## 🤖 Engineering with AI

**Where AI tools help with this concept**
- Turning an OpenAPI schema into Zod schemas (and the reverse) quickly.
- Listing edge cases for a field: empty, whitespace, Unicode, huge, negative, wrong type, extra fields. Then turning them into a table test like `validation.test.ts`.
- Writing the boring parts of a config loader: every variable, its type, its default.
- Reviewing a diff for secrets, PII in logs and missing response schemas.

**Where they commonly go wrong**
- They write `z.object()` for request bodies (unknown fields silently dropped) and `.passthrough()` "to be flexible".
- They reach for `z.coerce.number()` and `z.coerce.boolean()` for env vars and query strings.
- They add `process.env.X || "default"` and `?? "localhost"` everywhere.
- They validate in the route **and** in the service "to be safe".
- They log `request.body` for debugging and leave it in.
- They return `SELECT *` rows from handlers.
- They put realistic-looking sample keys in tests and docs, which secret scanners then flag (or worse, they paste a real one from your context).
- They use `parseFloat(amount) * 100`.

**Review checklist for AI-generated code touching validation, config or secrets**
- [ ] Every new route has `schema` with strict input and a response schema.
- [ ] No `z.coerce`, `.passthrough()` or `as SomeType` on external data.
- [ ] No `process.env` outside `src/config/`.
- [ ] No default values for environment-specific config.
- [ ] No request bodies, headers or tokens in log calls.
- [ ] No floats for money.
- [ ] No key-like strings in code, tests or docs (run gitleaks on the diff).
- [ ] Business rules are not mixed into schemas, and shape checks are not repeated in services.

**Prompts that work**

1. *"Here is `openapi.yaml` and `src/schemas/common.ts`. Write Zod schemas for every request body and response in the spec, reusing the building blocks from common.ts. Request bodies must be `z.strictObject`; responses `z.object`. Add `satisfies z.ZodType<components['schemas'][...]>` to each."*
   **Verify by:** running the contract test. Zero unexpected differences, and `tsc` passes.
2. *"List 30 malformed inputs for `POST /v1/transfers` given this schema, as a table of (name, payload, expected status, expected pointer). Include Unicode, size, type, extra-field and JSON-structure cases."*
   **Verify by:** pasting the rows into `validation.test.ts` and running it. Check by hand any row where the AI's expected status disagrees with the result: one of them is wrong.
3. *"Review this diff for secrets, personal data in logs, missing response schemas and silent config defaults. For each finding, give the file, line and the fix. Do not rewrite unrelated code."*
   **Verify by:** running gitleaks on the branch and the leak test. Treat the AI's review as a first pass, not proof.

---

## 🎤 Interview script

**How it shows up**
- **Machine-coding rounds:** "Build a transfer endpoint" or "Build a signup API". Interviewers watch where you validate, how you report errors, and whether money is an integer.
- **Security follow-ups:** "What if the client sends extra fields?", "How do you keep the password hash out of responses?", "Where do your secrets live?", "How do you rotate the DB password?"
- **System design:** in the "API" and "deployment" parts, strong candidates bring up fail-fast config and secret rotation without being asked.

**A 2-minute spoken answer: "How would you design the validation and config layer for a payments API?"**

1. "Everything from outside is untrusted: body, query, params, headers, and also env vars and secret files."
2. "I validate once, at the edge. Each route has a schema for every input part, and for the response. Inputs are strict, so unknown fields get a 400 with a pointer. I parse into typed values: amounts as integer paise, branded IDs, E.164 phones. Inner code never re-validates shape; it only checks business rules that need the database."
3. "Cross-field rules, like a statement period of at most a year, live in a domain parser and return 422. Shape errors are 400."
4. "Responses are allowlists, so a password hash or a new column cannot leak. I add a test that crawls every route for the hash."
5. "Config is parsed once at boot into a frozen, typed object. If anything is wrong, the process prints every problem without values and exits 1, so a bad deploy never takes traffic. One build goes to every environment."
6. "Secrets come from a secret manager, mounted as files, never committed. gitleaks runs pre-commit and in CI. The DB password rotates with two alternating users, so there are always valid credentials during the switch."
7. "Finally, limits: body size, JSON depth, request and header timeouts, all from config, each with a clear status code."

**Likely follow-ups, with strong answers**

1. **"Why not validate in the service too, to be safe?"**
   Because two copies of a rule drift, and then the API and the service disagree. One owner per rule, and types that prove the check happened. The service checks what only it can see: balances under a lock, frozen wallets. The database constraints stay as a backstop for bugs.
2. **"400 or 422 for 'end date before start date'?"**
   422. The request is well-formed JSON with real dates; it breaks a business rule. I keep 400 for shape problems. Both use Problem Details with a stable `code`.
3. **"The app starts with `DATABASE_URL` missing. What happens?"**
   Without a check, node-postgres falls back to `localhost:5432` as the OS user, and the failure (or a wrong connection) appears at the first query. With fail-fast config, the process exits 1 at boot with "DATABASE_SECRET_FILE: required", the new pods never become ready, and the old version keeps serving.
4. **"How do you rotate the database password with zero downtime?"**
   Alternating users. Two login roles share one permission role. Change the password of the idle one, update the secret, let each app instance build a new pool, test it with `SELECT 1`, swap, and drain the old pool. Retire the old user later. In my lab that gave 0 failed queries out of 2,656, against 157 failures for the single-user approach.
5. **"Someone pushed an AWS key to GitHub ten minutes ago. What do you do?"**
   Revoke or rotate it first, before anything else. Then check CloudTrail for its use since the push, contain if needed, then clean history with `git filter-repo`, and add a scanning rule plus push protection so it cannot happen again.
6. **"How do you stop a small request from hurting the server?"**
   Limits at each layer: header size (431), request and header timeouts (408), body size (413), JSON-only content type (415), nesting depth and prototype keys (400), field lengths in the schema, a DB statement timeout, and rate limits (429).

**Red flags interviewers notice**
- "TypeScript checks the types" as the answer to validation.
- Money as floats, or `toFixed(2)` for rounding.
- `process.env.X || "default"` for a database URL.
- Secrets in `.env` files committed "just for staging".
- "We'd delete the commit" as the response to a leaked key.
- No mention of response filtering when asked about data leaks.

**A small LLD sketch**

```ts
// The contracts behind this card's design, as interfaces.
type FieldError = { pointer?: string; parameter?: string; detail: string };
type Parsed<T> = { ok: true; value: T } | { ok: false; errors: FieldError[] };

interface Parser<T> { parse(input: unknown): Parsed<T> }                    // edge: shape, normalisation
interface DomainParser<I, T> { parse(input: I, now: Date): Parsed<T> }     // rules across fields -> 422

interface ConfigLoader<C> {
  load(env: Record<string, string | undefined>): { ok: true; config: Readonly<C> } | { ok: false; problems: string[] };
}

interface SecretSource<S> {
  current(): S;                          // cached in memory, never fetched per request
  refresh(): Promise<boolean>;           // true if it changed; single-flight
}
```

---

## ❓ Questions from the card, answered

Try to answer each one aloud first, then open it.

<details>
<summary><b>1. Where should validation happen, and why should inner code not validate again?</b></summary>

**At the edge:** in the route's schema, in the framework's validation phase, before authorisation and business logic. Every input part (params, query, headers, body) gets a schema. The result is a **parsed, typed** value (branded IDs, integer paise, E.164 phones), and that is all the handler ever sees.

Inner code should not validate shape again because:
- **Two copies drift.** Someone changes the limit in one place and not the other. Now the API and the service disagree, with different errors for the same input.
- **The types already prove it.** A `WalletId` or a `StatementPeriod` can only come from a parser. Re-checking says you do not trust your own types.
- **It hides the real owner.** When a rule changes, you should know the one file to edit.

What inner code **does** check is different in kind: business rules that need current data (balance, frozen wallet) inside the transaction, and the database's own constraints as a backstop. If a DB constraint is the first thing to catch bad input, a check above it is missing.

</details>

<details>
<summary><b>2. What happens when the app starts with a missing env var, and what should happen?</b></summary>

**What happens without a check:** nothing, at first. `process.env.DATABASE_URL` is `undefined` and code carries on. node-postgres then falls back to `localhost:5432` as the operating-system user (this guide ran it: `role "root" does not exist` at the first query). Other variables fail in other quiet ways: `Number(undefined)` is `NaN`, `"" || 3000` picks a default, `Boolean("false")` is `true`. The app "starts", the deploy looks green, and the failure surfaces later, under traffic.

**What should happen:** config is parsed once at boot. If anything is missing or invalid, the process prints **every** problem (names and rules, never values) and exits with code 1 **before** opening a port. In this guide's run: 7 problems, exit code 1. On Kubernetes, the new pods never become ready, the rollout stops, and the old version keeps serving. Fix the config and redeploy.

</details>

<details>
<summary><b>3. How do you rotate a database password without downtime?</b></summary>

Use **two valid credentials at once**. PostgreSQL allows only one password per role, so use two login roles (blue and green) that inherit permissions from one `NOLOGIN` role.

1. The app uses blue. Green is idle.
2. The rotation job sets a new password on **green**, then stores green's credentials as the current secret.
3. Each app instance notices the new secret (our pool re-reads the file every 30 s, and immediately after a `28P01` error), builds a new pool as green, proves it with `SELECT 1`, swaps it in, and lets the blue pool finish its in-flight queries.
4. After every instance has moved, the next rotation changes blue's password, which kills the old secret and makes blue the idle user.

Single-user rotation has a window between "database changed" and "every app has the new secret" in which new connections fail. In this guide's lab, under 4 workers of continuous traffic: **157 failed queries for single user, 0 of 2,656 for alternating users.** Vault's dynamic secrets are the next step: a fresh, short-lived user per app instance.

</details>

<details>
<summary><b>4. How do response schemas prevent data leaks?</b></summary>

A response schema is an **allowlist**. The serializer parses whatever the handler returns, and `z.object` drops every key the schema does not name. So:
- A handler that returns a full record (with `passwordHash`) sends only the named fields. The lab test returns the whole record on purpose and gets back exactly five fields.
- A column added to the table next quarter (`kyc_pan`, `internal_risk_score`) does not become public by accident. Exposing it takes a deliberate schema and spec change.
- A value of the wrong type is a 500, not a half-checked response.

This is OWASP's API3:2023 (Broken Object Property Level Authorization) covered by design. Add a test that crawls every route for known secrets, and a leak guard that blocks known secret shapes, in case someone lists the wrong field in a schema.

</details>

---

## 🏋️ Exercises

**Beginner (no code)**

1. Draw the "which check lives where" table for `POST /v1/transfers/{transferId}/refunds`. *Expected outcome:* at least 10 rows, each with one owner and one status code. *Verify by:* comparing with `refunds.ts` and the table in "How it works".
2. Sort these into config, flag or secret: `BODY_LIMIT_BYTES`, `NEW_UPI_FLOW`, `OTP_PEPPER`, `LOG_LEVEL`, `GOOGLE_CLIENT_SECRET`, `STEP_UP_THRESHOLD_MINOR`, `SHOW_DIWALI_BANNER`, `JWT_PRIVATE_JWKS`. *Expected outcome:* 3 config, 2 flags, 3 secrets, with one sentence on why `STEP_UP_THRESHOLD_MINOR` is config and not a flag. *Verify by:* the table in Deep dive 6.

**Intermediate (extend the lab)**

1. Add `GET /v1/me/sessions` (list your active token families from P1-05). Give it a response schema, add it to `openapi.yaml`, and make sure the contract and leak tests cover it without edits to the tests. *Expected outcome:* both tests pass; a session's refresh-token hash never appears. *Verify by:* temporarily returning the hash and watching the leak test fail.
2. NIST SP 800-63B-4 asks for at least 15 characters for passwords used as a single factor. Our P1-05 minimum is 10. Raise it for **new** passwords only, without locking out existing users. *Expected outcome:* signup rejects 14 characters; login still accepts old shorter passwords; a "please update your password" flag is set on login. *Verify by:* tests for all three.

**Advanced (failure injection or 10x scale)**

1. Run the rotation drill with 3 app processes behind a load balancer and k6 at 200 requests per second, for both strategies. *Expected outcome:* single user shows errors for as long as the slowest instance takes to refresh; alternating users shows none. *Verify by:* k6's `http_req_failed` rate and the app logs' "database credentials rotated" times per instance.
2. At 10x scale (600 pods), every pod refreshing its secret on the same 30 s timer hits the secret manager in bursts. Add jitter to `startAutoRefresh` and compute the API cost per month with and without per-request fetching. *Expected outcome:* calls spread across the interval; cost in cents per month with caching vs thousands of dollars without. *Verify by:* a fake secret manager that counts calls per second.

---

## 📝 Quiz

1. A handler does `const body = request.body as Transfer`. What does the cast check at runtime?
2. Which Zod object mode should a request body use, and which a response? Why are they different?
3. Why does `z.coerce.boolean()` turn `"false"` into `true`?
4. A statement export asks for 400 days. 400 or 422? And a request with `"from": "2026-02-30"`?
5. Why does our loader report cross-variable problems with a separate function instead of a Zod `superRefine`?
6. Name two reasons to deliver secrets as files rather than environment variables.
7. In the single-user rotation strategy, when exactly do connections fail?
8. A 60,000-byte JSON body passes a 64 KiB `bodyLimit`. How can it still crash the server, and what stops it?
9. With Fastify 5, `requestTimeout: 10000` alone did not give a 10 s limit. Why?
10. Someone pushed a key and then deleted it in the next commit. Is it safe? What is step one?

---

## 🔑 Quiz answer key

1. **Nothing.** Type assertions are erased at compile time. The value is whatever arrived.
2. Request body: **strict** (unknown keys rejected), so client mistakes and mass-assignment attempts get a 400. Response: **strip** (`z.object`), so only named fields leave: an allowlist. Input rejects, output filters.
3. It uses JavaScript's `Boolean()`, and every non-empty string is truthy. Use `z.stringbool()`.
4. 400 days: **422** (well-formed, breaks a business rule; returned by the domain parser). `2026-02-30`: **400** (not a real date; caught by the schema).
5. Zod runs an object-level refine only when every field is valid. The operator would fix five problems, redeploy, and only then see the production-only ones. Running cross-checks on the raw strings reports everything in one run.
6. Any two: env vars are inherited by child processes; they show up in `/proc/<pid>/environ`, crash reports and "print env" debug pages; files can be re-read without a restart (rotation); file permissions limit who can read them.
7. Between the moment the database gets the new password and the moment each app instance has the new secret. Only **new** connections fail; open sessions stay logged in.
8. Deep nesting (`[[[[...]]]]`). `JSON.parse` may survive, but recursive code that walks the value later (and `JSON.stringify`) overflows the stack. A depth check on the raw text before parsing stops it: 400 `JSON_TOO_DEEP`.
9. Fastify sets `requestTimeout` after creating the server, so Node's `headersTimeout` stays at 60 s. When `headersTimeout` is larger, Node effectively uses it for the whole request. Set `http.headersTimeout` too.
10. **No.** History, clones, forks and CI caches still have it. Step one: revoke or rotate the key. Then check its use, then clean history, then add a scanning rule.

---

## 📖 Glossary

| Term | Meaning |
|---|---|
| Allowlist | A list of what is permitted; everything else is refused or dropped. |
| Brand (branded type) | A TypeScript type marked so only a parser can create it, e.g. `WalletId`. |
| Contract test | A test that compares code against the API spec. |
| Defence in depth | Several independent layers, so one mistake is not enough to cause harm. |
| Domain parser | Code that turns checked input into a domain value using business rules (e.g. `StatementPeriod`). |
| Dynamic secret | A credential created on demand for one client, with a short lease (Vault). |
| E.164 | International phone format: `+` country code and number, no spaces. |
| Edge | The first code that handles a request: the route definition. |
| Fail closed | When unsure, refuse (block the commit, return 500) rather than allow. |
| Fail fast | Stop at the first sign of invalid state (exit at boot) rather than run wrongly. |
| Feature flag | A runtime switch, decided per request, changeable without a deploy. |
| gitleaks | An open-source scanner for secrets in files and git history. |
| Leak guard | Our `onSend` hook that blocks responses containing known secret shapes. |
| Least privilege | Each identity gets only the access it needs. |
| Mass assignment | A client setting fields it should not (like `role`) by adding them to a body. |
| NFC / NFKC | Unicode normal forms: canonical composition / compatibility composition. |
| Normalisation | Converting different spellings of a value to one form. |
| Paise / minor units | The smallest currency unit; money stored as integers of it. |
| Prototype poisoning | Sending `__proto__` keys to change object behaviour in JavaScript. |
| Rotation | Replacing a secret with a new one on a schedule or after a leak. |
| Secret manager | A service that stores, controls, audits and rotates secrets. |
| Slowloris | An attack that holds connections open by sending data very slowly. |
| Twelve-factor app | A methodology: config in the environment, one build for every deploy, and more. |
| `28P01` | PostgreSQL error code: invalid password. |

---

## 📌 Cheat sheet

**Diagram: the card on one screen**

```mermaid
mindmap
  root((P1-06))
    Validation
      Edge only, once
      Strict input
      Parse to types
      Normalise human text
    Responses
      Schema is an allowlist
      Fail closed
      Leak guard
    Config
      Env plus files
      Typed at boot
      Exit 1, list every problem
      One build everywhere
    Secrets
      Never in git
      Files, not env
      Rotate with two users
      gitleaks hook and CI
    Limits
      413 body size
      408 time
      431 headers
      Depth 20, JSON only
```

**How to read this diagram.** Each branch is one part of the card; each leaf is one rule to remember. Pick a branch and say each of its leaves aloud as a full sentence. If you cannot, reread that section.

**Key rules**

- Validate **once**, at the edge, with schemas for params, query, headers, body **and** response.
- Strict in, strip out, loose headers. Unknown input fields are a 400.
- Parse into precise types (brands). 400 for shape, 422 for business rules.
- Normalise what humans type (NFC, `\p{Cf}`, trim, E.164, lowercase email). Be exact with machine fields.
- Money is integer paise. Never `parseFloat`.
- Config: parsed once, frozen, typed. Every problem listed, no values printed, exit 1.
- No `z.coerce` for env vars or query strings; no silent defaults for environment-specific values.
- Secrets: files in production, never git, never logs, never responses. Prefix your own keys.
- Rotation: two valid credentials at once. Rotate first when anything leaks.
- Limits from config: body 64 KiB, depth 20, request **and** header timeout, 16 KiB headers, JSON only.
- Measured here: 31 of 31 bad inputs rejected; 7 config problems in one run; 157 vs 0 failed queries during rotation.

---

## 🏁 Completion checklist

- [ ] I can explain why TypeScript types are not validation, and show it with a 5-line example.
- [ ] Every route in my lab has request and response schemas; a route without one stops the app from starting.
- [ ] Measure: my malformed-input table rejects every case with 400 or 422 (or a more specific 4xx), with the right field pointer.
- [ ] My contract test compares Zod with `openapi.yaml`, and I fixed at least one real drift it found.
- [ ] Measure: I started the app with broken config and got exit code 1, every problem listed, and no values printed.
- [ ] My leak test proves the password hash never appears in any response.
- [ ] Measure: gitleaks blocked my planted fake key in the pre-commit hook, and the CI job failed when I bypassed the hook.
- [ ] My body-limit test gets 413 for an oversized payload, and my slow-client test gets 408 within the limit plus the checking interval.
- [ ] I loaded the DB password from a secret file and ran both rotation strategies under traffic.
- [ ] Phase 1 gate: I can design and defend the validation, config and secrets layer of a payments API in an interview, unprompted on fail-fast config and rotation.
- [ ] Lab run on my machine.
- [ ] Numbers filled in the measurements table.
- [ ] Post published.

---

## 📣 Learn in public

Use **your own** measured numbers in place of the ones from this guide.

**Post 1: "Our config failed twice, by design"**
- *Problem:* A bad deploy should fail before it takes traffic, and show **every** problem at once.
- *Decision:* Parse env and secret files once at boot with Zod; print names and rules, never values; exit 1.
- *Result:* A broken production config showed 7 problems in one run and never opened a port. But the first version hid 2 of them: Zod's object-level refine only runs when every field is already valid.
- *Lesson:* Test your failure output too. "Fail fast" is only useful if it fails **completely**.

**Post 2: "157 failed queries vs 0: rotating a Postgres password under traffic"**
- *Problem:* Rotating a database password makes new connections fail until every app has the new secret.
- *Decision:* Two login roles with shared permissions (alternating users), and a pool that re-reads a secret file, tests the new credentials and swaps.
- *Result:* Under continuous traffic, single-user rotation failed 157 queries; alternating users failed 0 of 2,656.
- *Lesson:* Zero-downtime rotation is not about speed. It is about having two valid credentials at the moment of change.

**Post 3: "My request timeout was 60 seconds and I didn't know"**
- *Problem:* I set Fastify's `requestTimeout` to 10 s to stop slow-body attacks.
- *Decision:* I tested it with a raw socket that promises 100 bytes and sends 1.
- *Result:* No 408 within the limit. Fastify sets `requestTimeout` after creating the server, Node's `headersTimeout` stays at 60 s, and Node uses the larger of the two. After setting both: 408 in 1.8 s with a 1 s limit.
- *Lesson:* A limit you have not tested on a real socket is a wish, not a limit.

**Hinglish video idea: "TypeScript types aapko bachayenge nahi: validation, config aur secrets 12 minute mein"**
Open with `"500" + 10 = "50010"` on screen: "Paisa jodna tha, string jud gayi." Show the railway-counter analogy (form ek baar counter pe check, andar PNR pe trust). Then three quick demos: the 31-row bad-input table going green, the app refusing to start with 7 config problems, and the rotation test with 157 vs 0. End with: "Edge pe ek baar check karo, boot pe fail karo, aur secret kabhi git mein nahi."

---

## ➡️ Next cards

- **P5-04 · Feature flags.** Deep dive 6 drew the line: config is fixed at boot, flags change per request. That card builds the flag side properly: targeting, progressive rollouts, kill switches and the OpenFeature API, with the "default in code when the flag service is down" rule you already have.
- **P5-06.** The card lists it by ID only. Your typed config loader, secret files, least-privilege roles and rotation drill are the base it builds on; bring your measured rotation numbers.
- **Also linked:** the logs you now redact become the structured logs and traces of **P1-08**; the contract and table tests here feed **P1-07**'s testing strategy; rate limits (429), the last row of the limits table, are **P3-04**.

---

## 📚 Sources and further reading

All links checked on 14 October 2026.

- [Fastify: Validation and Serialization](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/) — custom validator compilers return `{ value }` or `{ error }`; "treat schema definitions as application code".
- [Fastify: Lifecycle](https://fastify.dev/docs/latest/Reference/Lifecycle/) — the order of `onRequest`, parsing, validation, `preHandler`, serialization and `onSend`.
- [Fastify: Server options](https://fastify.dev/docs/latest/Reference/Server/) — `bodyLimit`, `requestTimeout`, `connectionTimeout`, `http`.
- [Node.js 22: HTTP](https://nodejs.org/docs/latest-v22.x/api/http.html) — `requestTimeout`, `headersTimeout`, `connectionsCheckingInterval`, `maxHeaderSize`.
- [Node.js 22: `--env-file`](https://nodejs.org/docs/latest-v22.x/api/cli.html) — loading a local `.env` without a library.
- [Zod 4 documentation](https://zod.dev/) and [JSON Schema conversion](https://zod.dev/json-schema) — object modes, `stringbool`, brands, `toJSONSchema` with `io`.
- [Alexis King: Parse, don't validate (2019)](https://lexi-lambda.github.io/blog/2019/11/05/parse-don-t-validate/).
- [The Twelve-Factor App: III. Config](https://12factor.net/config) and [V. Build, release, run](https://12factor.net/build-release-run).
- [OWASP Input Validation Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Input_Validation_Cheat_Sheet.html).
- [OWASP Mass Assignment Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Mass_Assignment_Cheat_Sheet.html).
- [OWASP Secrets Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html).
- [OWASP API Security Top 10 (2023): API3 Broken Object Property Level Authorization](https://owasp.org/API-Security/editions/2023/en/0xa3-broken-object-property-level-authorization/).
- [NIST SP 800-63B-4](https://pages.nist.gov/800-63-4/sp800-63b.html) — section 3.1.1.2: NFC normalisation of Unicode passwords, no truncation, 15-character minimum for single-factor passwords.
- [Unicode UAX #15: Normalization Forms](https://unicode.org/reports/tr15/).
- [ITU-T E.164](https://www.itu.int/rec/T-REC-E.164/) and [libphonenumber-js](https://www.npmjs.com/package/libphonenumber-js).
- [secure-json-parse](https://github.com/fastify/secure-json-parse) — `protoAction` and `constructorAction`.
- [pino: Redaction](https://getpino.io/#/docs/redaction).
- [MDN: CORS simple requests](https://developer.mozilla.org/en-US/docs/Web/HTTP/CORS) — why `text/plain` POSTs skip the preflight.
- [AWS Secrets Manager: rotation strategies](https://docs.aws.amazon.com/secretsmanager/latest/userguide/rotation-strategy.html) — single user vs alternating users.
- [AWS Secrets Manager pricing](https://aws.amazon.com/secrets-manager/pricing/) — $0.40 per secret per month and $0.05 per 10,000 API calls on 14 Oct 2026.
- [HashiCorp Vault: database secrets engine](https://developer.hashicorp.com/vault/docs/secrets/databases) and [OpenBao](https://openbao.org/); background on the fork: [TechTarget: IBM engineers hatch Linux Foundation HashiCorp Vault fork](https://techtarget.com/searchitoperations/news/366563095/IBM-engineers-hatch-Linux-Foundation-HashiCorp-Vault-fork).
- [Doppler documentation](https://docs.doppler.com/).
- [Kubernetes Secrets Store CSI Driver](https://secrets-store-csi-driver.sigs.k8s.io/).
- [PostgreSQL 16: ALTER ROLE](https://www.postgresql.org/docs/16/sql-alterrole.html) and [MySQL 8: dual password support](https://dev.mysql.com/doc/refman/8.0/en/password-management.html).
- [node-postgres: Pool](https://node-postgres.com/apis/pool) — pool options including `maxLifetimeSeconds`.
- [gitleaks](https://github.com/gitleaks/gitleaks) (config format, `[[allowlists]]` since v8.25, "feature complete" notice), its [pre-commit hook definition](https://github.com/gitleaks/gitleaks/blob/master/.pre-commit-hooks.yaml), and [gitleaks-action](https://github.com/gitleaks/gitleaks-action) (`@v3`, licence needed for organisation repos only, free).
- [GitHub: About push protection](https://docs.github.com/en/code-security/secret-scanning/introduction/about-push-protection).
- [OpenFeature](https://openfeature.dev/) — the vendor-neutral feature flag API (for P5-04).
- [RFC 9457: Problem Details for HTTP APIs](https://www.rfc-editor.org/rfc/rfc9457).
