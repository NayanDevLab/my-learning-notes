# P1-05 · Authentication and authorisation

| | |
|---|---|
| **Phase** | 1 · Backend foundations |
| **Prerequisites** | P1-03 · REST API design |
| **Leads to** | P5-06 · Application security · P7-06 · Multi-tenancy and multi-region |
| **Suggested repo path** | `system-design/phase-1/p1-05-authentication-and-authorisation.md` |
| **Facts checked on** | 13 October 2026 |

**After this card you can:**

1. Explain the difference between "who are you" (authentication) and "what may you do" (authorisation), and point to where each one lives in the code.
2. Store passwords with argon2id, rate-limit logins against credential stuffing, and measure what each hash costs.
3. Issue short-lived RS256 access tokens and rotating refresh tokens, detect a stolen refresh token, and sign a user out of every device.
4. Stop BOLA/IDOR (one user reading another user's wallet by changing the ID) with a central ownership check that the app cannot start without.
5. Add "Login with Google" with OIDC and PKCE, and ask for a fresh OTP before a large transfer.

> **About the numbers in this guide.** Everything marked **Real output** was run while writing this guide: Node 22, PostgreSQL 16.15, a 2-vCPU Linux sandbox. Your numbers will differ; compare directions, not decimals. Versions checked on 13 Oct 2026: argon2 (node-argon2) 0.45.1, jose 6.2.12, openid-client 6.8.8, @fastify/cookie 11.1.3, Fastify 5.12.5, Zod 4.6.7, bcryptjs 3.0.3. The lab has **90 tests**, all passing on two full runs.

---

## ⏱️ The concept in one minute

Every request to the ledger platform must answer two questions, in this order:

1. **Authentication (authn): who is calling?** Riya proves she is Riya: a password, a Google sign-in, a token from an earlier login.
2. **Authorisation (authz): may this caller do this to this object?** Riya may read *her* wallet. She may not read Amit's, even though she is logged in and the URL looks the same.

**One line:** authentication gives you a name; authorisation checks that name against **this** action on **this** object, on **every** request.

**Analogy.** At an Indian railway station, the TTE checks your ticket (authentication: you are a valid passenger). Then he checks that your ticket is for **this coach and this berth** (authorisation). A valid ticket for S4 does not let you sleep in A1. Most API breaches are the second check missing: the system saw a valid ticket and never asked "which berth?".

**On our ledger platform:** Riya logs in and gets a 10-minute access token. She opens `/v1/wallets/{her-wallet-id}`: allowed. She edits the URL to Amit's wallet ID: the server says **404**, as if the wallet does not exist. She tries to send ₹15,000: the server asks for a one-time code sent to her phone, bound to that exact amount and payee. Someone steals her refresh token: the first time either of them uses an old copy, every session in that login is cut off.

---

## 💥 The problem it solves

In fintech, a broken access check is a breach, not a bug. Here is what happens on the ledger platform with casual auth.

**1. BOLA: "logged in" mistaken for "allowed".** The wallet route checks the token, then runs `SELECT * FROM wallets WHERE id = $1` with the ID from the URL. Any logged-in user can read any wallet by changing one path segment. Wallet IDs are UUIDs, but IDs leak all the time: in support screenshots, URLs shared on WhatsApp, browser history, logs. OWASP's 2023 API Security Top 10 lists this as **API1: Broken Object Level Authorization**, the number one risk.

**2. Passwords stored fast.** Hashing with SHA-256 takes about **0.0035 ms** per guess on one core here (**Real output**). An attacker with your users table tries a 10-million-word password list against one user in about **35 seconds**. With argon2id at OWASP's minimum settings, one guess takes about **27 ms**: the same list takes about **3.15 days per user, per core**. That is roughly 7,800 times more work for every guess (computed).

**3. No login limits.** Credential stuffing means trying passwords leaked from *other* sites, at scale. Without limits, a botnet tries millions of email-and-password pairs a day. With our two limits (5 failures per account and 20 attempts per IP, each per 15 minutes), one account can face at most **480 guesses a day**, however many bots there are (computed). And because each argon2id check costs about 27 ms of CPU, one core can only verify about **37 logins a second**; without per-IP limits, the login endpoint is also an easy way to burn your CPU.

**4. Tokens that cannot be taken back.** The first version issues a JWT valid for 30 days and stores it in `localStorage`. One XSS bug (a script injected into your page) copies it. The attacker now has 30 days of access, and "change password" or "log out" does nothing, because the server never checks anything except the signature.

**5. One password for a ₹5 lakh transfer.** A phished password is enough to drain a merchant's wallet. RBI's *Authentication Mechanisms for Digital Payment Transactions Directions, 2025* (issued 25 September 2025, effective 1 April 2026) make two-factor authentication mandatory for digital payments, with at least one factor dynamic, that is, unique to the transaction (secondary summary; read the RBI text for your exact obligations, and this is not legal advice).

This card fixes all five, layer by layer.

---

## 🧰 Before you start

**Prerequisite card:** P1-03 · REST API design. This card builds on the P1-03 lab: the same transfers API, idempotency keys and Problem Details. P1-03's lab trusted an `x-client-id` header; this card replaces it with a verified identity. P1-04's webhook HMAC signatures will also look familiar: HMAC and constant-time comparison come back here.

**Key terms (each is explained again where it first matters):**

| Term | Plain meaning |
|---|---|
| Authentication (authn) | Proving who you are. |
| Authorisation (authz) | Deciding what you may do, to which object. |
| Principal | The verified caller: user ID, role, session. |
| Hash (password) | A one-way, deliberately slow scramble of the password. You can check a guess; you cannot reverse it. |
| Salt | Random bytes mixed into each password's hash, so equal passwords get different hashes. |
| Session | Server-side record of a login, found by an ID in a cookie. |
| JWT | JSON Web Token: signed JSON the server can verify without a database lookup. |
| Access token | Short-lived proof of login sent on every API call (`Authorization: Bearer ...`). |
| Refresh token | Long-lived secret used only to get new access tokens. |
| Token family | All refresh tokens descended from one login on one device. |
| CSRF | Cross-site request forgery: another site makes the browser send a request with your cookies. |
| XSS | Cross-site scripting: an attacker's JavaScript runs inside your page. |
| OAuth 2.0 / OIDC | OAuth lets an app get access on a user's behalf; OpenID Connect adds "who the user is" on top. |
| PKCE | Proof Key for Code Exchange: proves the app that started a login is the one finishing it. |
| RBAC / ABAC / ReBAC | Access by role / by attributes / by relationships. |
| BOLA / IDOR | Broken object-level authorisation / insecure direct object reference: same bug, two names. |
| Step-up auth | Asking for an extra proof (an OTP) before a sensitive action. |
| mTLS | Mutual TLS: both sides of a connection present certificates. |

**Lab setup:** Node 22+, Docker (Postgres 16), and the P1-03 lab code. About 4 hours. No Google account needed: the tests run a fake identity provider locally.

---

## 🧠 How it works

**Mental model: a request walks through gates, cheapest first.** Each gate either stops the request with a clear status code or lets it through to the next.

**Diagram: the gates every request passes**

```mermaid
flowchart TD
  req["Request with Bearer token"] --> authn{"authenticate<br/>JWT valid?"}
  authn -->|"no"| r401["401 Unauthorized"]
  authn -->|"yes"| live{"Sensitive route:<br/>session still live?"}
  live -->|"revoked"| r401b["401 SESSION_REVOKED"]
  live -->|"live, or not sensitive"| val{"Input valid?"}
  val -->|"no"| r400["400 Bad Request"]
  val -->|"yes"| authz{"authorize<br/>role and relationship"}
  authz -->|"cannot even read it"| r404["404 Not Found"]
  authz -->|"can read, cannot do"| r403["403 Forbidden"]
  authz -->|"allowed"| step{"Large transfer:<br/>OTP verified?"}
  step -->|"no"| r401c["401 STEP_UP_REQUIRED"]
  step -->|"yes, or small"| handler["Handler runs"]
```

**How to read this diagram.** Top to bottom is the order of the code. Authentication is one signature check and needs no database. Only sensitive routes (money, roles, sessions) pay for a live session lookup. Validation comes before authorisation so the ID is well-formed. Authorisation answers 404 when the caller cannot even see the object, and 403 when they can see it but not do this. Step-up only applies to large transfers.

**Where each part lives in the lab code:**

| Gate | File | Runs as |
|---|---|---|
| authenticate | `src/auth/authenticate.ts` | `onRequest`, attached centrally to every non-public route |
| live session | `src/auth/authenticate.ts` (`requireLiveSession`) | `onRequest`, only when the route says `sensitive: true` |
| validate | `src/lib/validate.ts` (from P1-03) | `preHandler` |
| authorize | `src/authz/authorize.ts` | `preHandler`, placed by each route, **proven present** at startup |
| step-up | `src/stepUp/requireStepUp.ts` | `preHandler` on `POST /v1/transfers` |

**A React developer's way to see it.** Authentication is like your app's `<AuthProvider>`: it knows who is signed in. Authorisation is like a check inside every page about **this** record, not just a route guard on `/wallets`. Hiding a button in the UI is not authorisation: the server must check every request, because anyone can call the API with curl.

**Diagram: the tables behind identity and ownership**

```mermaid
erDiagram
  USERS ||--o{ ACCOUNT_MEMBERS : "is a member"
  ACCOUNTS ||--o{ ACCOUNT_MEMBERS : "has members"
  ACCOUNTS ||--o{ WALLETS : owns
  USERS ||--o{ USER_IDENTITIES : "signs in with Google"
  USERS ||--o{ TOKEN_FAMILIES : "one per login"
  TOKEN_FAMILIES ||--|{ REFRESH_TOKENS : rotates
  ACCOUNT_MEMBERS {
    uuid account_id
    uuid user_id
    text relation
  }
  TOKEN_FAMILIES {
    uuid id
    timestamptz auth_time
    timestamptz revoked_at
  }
  REFRESH_TOKENS {
    bytea token_hash
    timestamptz used_at
  }
```

**How to read this diagram.** A user reaches a wallet only **through** an account membership, and the membership carries the relationship (`owner` or `viewer`). That is what "this wallet belongs to the caller" means in data. On the session side, one login creates one token family, and every refresh adds a token to it. Revoking the family signs out that device in one update.

---

## 🔬 Deep dive

Each Learn-inside item gets its own section. Every core idea has a **minimal version** (one small file you can run with `npx tsx`) and, in the lab, a **product version**.

### 1. Authentication vs authorisation

| | Authentication | Authorisation |
|---|---|---|
| Question | Who are you? | May you do **this** to **this** object? |
| Input | Password, Google sign-in, OTP, token, certificate | Principal + action + object (+ context) |
| Output | A principal: `{ userId, role, sessionId }` | Allow, or deny (403 / 404) |
| Failure code | **401 Unauthorized** (the name is historic; it means "unauthenticated") | **403 Forbidden**, or **404** to hide the object |
| How often | Once per login; then a token check per request | On **every** request, for **every** object ID |
| OWASP API 2023 | API2 Broken Authentication | API1 Broken **Object** Level Authorization, API5 Broken **Function** Level Authorization |

**Two kinds of authorisation bug**, both from the OWASP 2023 list:

- **Object level (BOLA, API1):** the route is right for you, the object is not. Riya calls `GET /v1/wallets/{amit's id}`.
- **Function level (BFLA, API5):** the action itself is not for your role. Support staff call `POST /v1/transfers/{id}/refunds`.

The lab checks both in one place: the role table answers "is this action for your role?", and the relationship answers "is this object yours?".

**When to keep them separate in code:** always. Authentication runs once per request at the edge and needs no knowledge of wallets. Authorisation needs the object, so it runs after the ID is parsed. Mixing them leads to "we checked the token, so it's fine" bugs.

### 2. Password storage

**Hash, never encrypt.** Encryption is reversible by design: whoever gets the key gets every password. A password hash is one-way: the server can check a guess, but nobody can read the password back, not even you. Use a hash built to be **slow and memory-hungry**, so each guess costs an attacker real money:

| Algorithm | OWASP Password Storage Cheat Sheet minimums (checked 13 Oct 2026) |
|---|---|
| **argon2id** (first choice) | m = 19 MiB, t = 2, p = 1; or m = 46 MiB, t = 1, p = 1 (and other equal-strength options) |
| scrypt | N = 2^17 (128 MiB), r = 8, p = 1 |
| bcrypt | work factor at least 10; input limited to **72 bytes**, so cap password length |
| PBKDF2-HMAC-SHA256 | 600,000 iterations |

- **Salt:** a random value per password, stored inside the hash string. Same password, different hashes, so precomputed "rainbow tables" are useless. Libraries do this for you.
- **Pepper (optional):** one extra secret kept **outside** the database (a vault), mixed in for all passwords. A database leak alone is then not enough. OWASP calls it defence in depth; rotating it means password resets.
- **Rehash on login:** when you raise the parameters, upgrade each user's hash the next time they log in successfully.

**Minimal version:** `minimal/password-hashing.ts`

```ts
// minimal/password-hashing.ts — why passwords get a slow, salted hash, and what it costs per login.
// Run: npx tsx minimal/password-hashing.ts
import { createHash } from "node:crypto";
import argon2 from "argon2";
import bcrypt from "bcryptjs";

const password = "Riya@1234";
const time = async (label: string, fn: () => Promise<unknown>, runs = 10) => {
  await fn(); // warm up
  const t = performance.now();
  for (let i = 0; i < runs; i++) await fn();
  const ms = (performance.now() - t) / runs;
  console.log(`${label.padEnd(44)} ${ms.toFixed(ms < 1 ? 4 : 1).padStart(8)} ms per hash`);
  return ms;
};

// Same password, two hashes: the random salt makes them differ, so precomputed tables are useless.
const a = await argon2.hash(password, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
const b = await argon2.hash(password, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
console.log("hash 1:", a);
console.log("hash 2:", b);
console.log("verify correct:", await argon2.verify(a, password), "| verify wrong:", await argon2.verify(a, "riya@1234"));

await time("sha256 (never for passwords)", async () => createHash("sha256").update(password).digest(), 10_000);
const owasp = await time("argon2id m=19 MiB t=2 p=1 (OWASP minimum)", () =>
  argon2.hash(password, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 }));
await time("argon2id m=46 MiB t=1 p=1 (OWASP option)", () =>
  argon2.hash(password, { type: argon2.argon2id, memoryCost: 47104, timeCost: 1, parallelism: 1 }));
await time("argon2id m=64 MiB t=3 p=4 (library default)", () => argon2.hash(password));
await time("bcrypt cost 10 (bcryptjs, pure JS)", () => bcrypt.hash(password, 10), 5);
await time("bcrypt cost 12 (bcryptjs, pure JS)", () => bcrypt.hash(password, 12), 3);

// What the slowness means for an attacker who steals the table and has ONE core like ours.
console.log(`attacker guesses per core per second at ${owasp.toFixed(1)} ms each: ${Math.round(1000 / owasp)}`);
```

**Real output** (the two hash strings are from the first run, the timings from the second; the first run gave 26.2 ms for the OWASP setting)

```text
hash 1: $argon2id$v=19$m=19456,p=1,t=2$/xquJOe0Tw+B+guvXmN1HQ$YhPMCejvF/pK+0ttohfAWxU8qk1UF/uD+wMgzD5pjQM
hash 2: $argon2id$v=19$m=19456,p=1,t=2$ktK8TKigeWGhGdwDK4wqRQ$b6S873i/PdgaWd3t5G9bVNhIuKHr5+wOqfbns1h1qCg
verify correct: true | verify wrong: false
sha256 (never for passwords)                   0.0035 ms per hash
argon2id m=19 MiB t=2 p=1 (OWASP minimum)        27.2 ms per hash
argon2id m=46 MiB t=1 p=1 (OWASP option)         56.7 ms per hash
argon2id m=64 MiB t=3 p=4 (library default)     126.7 ms per hash
bcrypt cost 10 (bcryptjs, pure JS)               91.5 ms per hash
bcrypt cost 12 (bcryptjs, pure JS)              358.4 ms per hash
attacker guesses per core per second at 27.2 ms each: 37
```

**What to notice**

- The two hashes of the same password differ: the salt (the part after `t=2$`) is random each time. Parameters and salt live inside the string, so verification needs nothing else.
- SHA-256 is about 7,800 times faster than argon2id here. Fast is exactly what you do **not** want for passwords.
- bcryptjs is pure JavaScript, so it is slower than native bcrypt; compare algorithms on your own stack before choosing.
- An attacker with a GPU farm is much faster than one core, but argon2id's memory cost (19 MiB per guess) limits how many guesses fit in parallel on a GPU. That is why "memory-hard" matters.

**Login rate limits and credential stuffing.** People reuse passwords, and billions of leaked email-password pairs are public. Credential stuffing tries those pairs on your login page. Defences, stacked:

1. **Per-IP limit** (one bot trying many accounts): the lab allows 20 attempts per IP per 15 minutes.
2. **Per-account failure limit** (many bots trying one account): 5 failures per 15 minutes. A temporary lock, not a permanent one: permanent locks let an attacker lock out a victim on purpose.
3. **Same answer, same time** for "unknown email" and "wrong password", so the login page cannot be used to test which emails have accounts.
4. **MFA** for sensitive actions (section 10), and breached-password checks at signup (for example the k-anonymity range API of Have I Been Pwned).
5. **Watch the signals:** login failures per minute, sudden IP spread, success after many failures.

**Trade-off.** Higher hash cost = safer passwords but more CPU per login. At about 27 ms, one core handles about 37 logins a second. Size login capacity on purpose, and protect the endpoint with rate limits, or attackers can use your hash cost against you.

### 3. Sessions vs tokens

There are two families of "remember who logged in":

- **Server-side session:** the server stores `{ sessionId → userId, expiry }` (Postgres or Redis). The browser holds only a random session ID in a cookie. Every request looks the session up.
- **Bearer token (JWT):** the server signs a small JSON document (`{ sub, role, exp }`). The client sends it as `Authorization: Bearer <token>`. Any service with the public key can verify it **without** a database call.

**Sessions vs JWT (required table)**

| | Server-side session (cookie with a random ID) | Bearer JWT (stateless access token) |
|---|---|---|
| What the client holds | 43-character random ID (32 bytes, base64url) | 591-character signed JSON (this lab's token, **Real output**) |
| Check per request | Database or Redis lookup | Signature check only, in memory |
| Revocation | Instant: delete the row | Hard: valid until `exp`; needs short lifetimes, a denylist, or a live check |
| "Log out everywhere" | Delete all the user's rows | Revoke refresh tokens, then wait up to one access-token lifetime (or check live) |
| Role changes | Take effect on the next request | Take effect when the next token is issued |
| Size per request | Tiny | Bigger: at 5,000 requests a second the extra bytes are about 237 GB a day (computed) |
| Works across many services | Every service needs the session store | Any service verifies with the public key (JWKS) |
| Works for mobile apps | Needs cookie handling | Natural: a header |
| CSRF risk | Yes, the browser sends cookies automatically | No, if sent in a header the browser does not add on its own |
| XSS risk | Low with HttpOnly cookies | High if stored in `localStorage` |
| Best for | A classic web app with one backend | APIs used by mobile apps and many services |

**What real systems do (and this lab does):** both. A **short-lived JWT access token** (10 minutes) for cheap checks on every API call, plus a **long-lived refresh token stored server-side** (as a hash, in a token family) that can be revoked at any time. The refresh token is the "session"; the access token is a short-lived ticket cut from it. Sensitive routes also check the session live, which removes the 10-minute gap where it matters most (section 5).

### 4. JWT anatomy

**Diagram: the three parts of a JWT**

```text
eyJhbGciOiJSUzI1NiIs...  .  eyJyb2xlIjoidXNlciIs...  .  kq3T9x0Ab8...
\______ header ______/      \______ payload ______/      \_ signature _/

{"alg":"RS256",             {"role":"user",              RS256 over the
 "typ":"at+jwt",             "sid":"fam_7",              first two parts,
 "kid":"key-2026-10"}        "sub":"usr_riya",           made with the
                             "iss":"https://auth...",    PRIVATE key;
                             "aud":"ledger-api",         checked with the
                             "iat":1791864295,           PUBLIC key
                             "exp":1791864895}

base64url text, NOT encrypted: anyone who sees the token can read both JSON parts.
```

**How to read this diagram.** A JWT is three base64url strings joined by dots. The header says how it was signed and with which key (`kid`). The payload holds the claims: who (`sub`), issued by whom (`iss`), for whom (`aud`), until when (`exp`). The signature proves nobody changed the first two parts. Nothing is hidden: never put a PAN, phone number or balance in a JWT.

**HS256 vs RS256 vs EdDSA**

| | HS256 | RS256 | EdDSA (Ed25519) |
|---|---|---|---|
| Key type | One shared secret (HMAC) | Private key signs, public key verifies (RSA) | Private key signs, public key verifies (elliptic curve) |
| Who can verify | Only holders of the secret, who can also **sign** | Anyone with the public key | Anyone with the public key |
| Key size | 256-bit random secret | 2048-bit+ RSA | 32-byte keys |
| Use when | One service issues and verifies its own tokens | Many services verify, one issues; widest support | Same as RS256 when every library you use supports it |
| Risk | Every verifier can mint admin tokens; weak secrets can be brute-forced | Algorithm confusion if the library lets `alg` choose the key type | Fewer libraries in older stacks |

RFC 8725 (JWT Best Current Practices) adds the rules that matter most in practice: the verifier must **pin the algorithm list**, reject `alg: none`, check `iss` and `aud`, and use **explicit typing** (`typ`) so one kind of JWT cannot be accepted as another. This lab uses `typ: "at+jwt"`, the access-token type from RFC 9068, so an ID token from Google can never pass as our access token.

**Minimal version:** `minimal/jwt-pitfalls.ts`

```ts
// minimal/jwt-pitfalls.ts — a JWT is readable by anyone; the verifier must pin alg, iss, aud and exp.
// Run: npx tsx minimal/jwt-pitfalls.ts
import { exportSPKI, generateKeyPair, jwtVerify, SignJWT } from "jose";

const { privateKey, publicKey } = await generateKeyPair("RS256");
const opts = { issuer: "https://auth.ledger.example", audience: "ledger-api", algorithms: ["RS256"] };

const token = await new SignJWT({ role: "user", sid: "fam_7" })
  .setProtectedHeader({ alg: "RS256", typ: "at+jwt", kid: "key-2026-10" })
  .setSubject("usr_riya").setIssuer(opts.issuer).setAudience(opts.audience)
  .setIssuedAt().setExpirationTime("10m").sign(privateKey);

// 1. Not encrypted: the middle part is just base64url JSON.
const [header, payload] = token.split(".").map((p) => Buffer.from(p, "base64url").toString());
console.log("anyone can read the header: ", header);
console.log("anyone can read the payload:", payload);

const check = async (label: string, t: string, key: Parameters<typeof jwtVerify>[1] = publicKey) => {
  try { await jwtVerify(t, key, opts); console.log(`${label.padEnd(34)} -> accepted`); }
  catch (e) { console.log(`${label.padEnd(34)} -> rejected: ${(e as { code?: string }).code}`); }
};
await check("genuine token", token);

// 2. Edit the payload (role: admin) and keep the old signature.
const forgedPayload = Buffer.from(payload!.replace('"user"', '"admin"')).toString("base64url");
await check("payload edited to role admin", [token.split(".")[0], forgedPayload, token.split(".")[2]].join("."));

// 3. alg: none — "this token needs no signature".
const none = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
await check("alg none, no signature", `${none}.${forgedPayload}.`);

// 4. Algorithm confusion: sign HS256 using the PUBLIC key text as the HMAC secret.
const pem = new TextEncoder().encode(await exportSPKI(publicKey));
const confused = await new SignJWT({ role: "admin" }).setProtectedHeader({ alg: "HS256" })
  .setSubject("usr_attacker").setIssuer(opts.issuer).setAudience(opts.audience).setExpirationTime("10m").sign(pem);
await check("HS256 signed with the public key", confused);

// 5. Right signature, wrong audience or already expired.
const sign = (aud: string, exp: string | number) => new SignJWT({}).setProtectedHeader({ alg: "RS256" })
  .setSubject("usr_riya").setIssuer(opts.issuer).setAudience(aud).setIssuedAt().setExpirationTime(exp).sign(privateKey);
await check("token meant for another service", await sign("notifications", "10m"));
await check("expired 1 minute ago", await sign("ledger-api", Math.floor(Date.now() / 1000) - 60));

console.log(`size: JWT ${token.length} bytes vs a random session id ${Buffer.alloc(32).toString("base64url").length} bytes`);
```

**Real output**

```text
anyone can read the header:  {"alg":"RS256","typ":"at+jwt","kid":"key-2026-10"}
anyone can read the payload: {"role":"user","sid":"fam_7","sub":"usr_riya","iss":"https://auth.ledger.example","aud":"ledger-api","iat":1791864295,"exp":1791864895}
genuine token                      -> accepted
payload edited to role admin       -> rejected: ERR_JWS_SIGNATURE_VERIFICATION_FAILED
alg none, no signature             -> rejected: ERR_JOSE_ALG_NOT_ALLOWED
HS256 signed with the public key   -> rejected: ERR_JOSE_ALG_NOT_ALLOWED
token meant for another service    -> rejected: ERR_JWT_CLAIM_VALIDATION_FAILED
expired 1 minute ago               -> rejected: ERR_JWT_EXPIRED
size: JWT 591 bytes vs a random session id 43 bytes
```

**What to notice**

- Two lines of code read the whole payload. "A JWT is encrypted" is wrong: by default it is only **signed**. (Encrypted JWTs, JWE, exist, but that is a different format.)
- `alg: none` and the **algorithm confusion** attack (signing HS256 with the public key text, which every verifier has) both fail because `algorithms: ["RS256"]` is pinned. A library that trusts the token's own `alg` header would accept both.
- A real, correctly signed token for the `notifications` audience is rejected by `ledger-api`. Without the `aud` check, a token stolen from any service works against every service.

**Key rotation with JWKS.** Signing keys must be replaceable: on a schedule, and immediately if one leaks. The issuer publishes its **public** keys at `/.well-known/jwks.json` (a JSON Web Key Set). Each token's header names its key with `kid`. Rotation has three steps: publish the new key next to the old one, start signing with the new key, then remove the old key once every token it signed has expired.

**Minimal version:** `minimal/jwks-rotation.ts`

```ts
// minimal/jwks-rotation.ts — rotate signing keys without logging anyone out.
// Run: npx tsx minimal/jwks-rotation.ts
import { createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify, SignJWT, type CryptoKey, type JWK } from "jose";

async function newKey(kid: string) {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  return { kid, privateKey, publicJwk: { ...(await exportJWK(publicKey)), kid, alg: "RS256", use: "sig" } as JWK };
}
const sign = (key: { kid: string; privateKey: CryptoKey }) =>
  new SignJWT({}).setProtectedHeader({ alg: "RS256", kid: key.kid }).setSubject("usr_riya")
    .setIssuer("https://auth.ledger.example").setAudience("ledger-api").setExpirationTime("10m").sign(key.privateKey);

// The API verifies against whatever the JWKS (JSON Web Key Set) says right now, picking the key by `kid`.
let published: JWK[] = [];
const verify = async (label: string, token: string) => {
  try {
    await jwtVerify(token, createLocalJWKSet({ keys: published }), { issuer: "https://auth.ledger.example", audience: "ledger-api", algorithms: ["RS256"] });
    console.log(`${label.padEnd(46)} -> accepted`);
  } catch (e) { console.log(`${label.padEnd(46)} -> rejected: ${(e as { code?: string }).code}`); }
};

const k1 = await newKey("2026-09");
published = [k1.publicJwk];
const oldToken = await sign(k1);
await verify("day 0: token signed with 2026-09", oldToken);

const k2 = await newKey("2026-10");
published = [k2.publicJwk, k1.publicJwk]; // step 1: publish the new key next to the old one
const newToken = await sign(k2);          // step 2: start signing with the new key
await verify("rotation: old token, both keys published", oldToken);
await verify("rotation: new token, both keys published", newToken);

published = [k2.publicJwk]; // step 3: after the longest token lifetime has passed, drop the old key
await verify("later: old token, old key removed", oldToken);
await verify("later: new token", newToken);
```

**Real output**

```text
day 0: token signed with 2026-09               -> accepted
rotation: old token, both keys published       -> accepted
rotation: new token, both keys published       -> accepted
later: old token, old key removed              -> rejected: ERR_JWKS_NO_MATCHING_KEY
later: new token                               -> accepted
```

**What to notice**

- No user was logged out during the rotation: old and new tokens both verified while both keys were published.
- Services that verify our tokens use `createRemoteJWKSet(new URL(".../.well-known/jwks.json"))`, which caches the set and refetches when it sees an unknown `kid`. Publish the new key **before** signing with it, or other services see unknown `kid`s.
- For an emergency (a leaked private key), remove the old key at once and accept that its tokens die: everyone refreshes.

### 5. Access and refresh tokens

**The idea.** Make the token you send on every request **short-lived** (10 minutes), so a stolen one is worth little. Keep a second, long-lived **refresh token** that is sent only to `/v1/auth/refresh`, stored as a hash in Postgres, and revocable at any time.

**Rotation.** Every time the refresh token is used, it is marked used and a new one is issued in the same **family**. A refresh token works **once**.

**Reuse detection.** If a token that was already used comes back, someone has a copy. The server cannot tell whether the copy is with the thief or the real user, so it revokes the **whole family**: the thief is out, and the real user signs in again. RFC 9700 (OAuth 2.0 Security BCP, January 2025) requires refresh tokens for public clients to be either sender-constrained or rotated; rotation with reuse detection is the common choice.

**Minimal version:** `minimal/refresh-rotation.ts`

```ts
// minimal/refresh-rotation.ts — rotating refresh tokens, and what happens when a stolen one is used.
// Run: npx tsx minimal/refresh-rotation.ts
import { createHash, randomBytes } from "node:crypto";

type Row = { family: string; usedAt: number | null };
const rows = new Map<string, Row>(); // key = sha256(token): a database leak gives no usable tokens
const revokedFamilies = new Set<string>();
const hash = (t: string) => createHash("sha256").update(t).digest("hex");

function issue(family: string): string {
  const token = randomBytes(32).toString("base64url");
  rows.set(hash(token), { family, usedAt: null });
  return token;
}

function refresh(presented: string, who: string): string | null {
  const row = rows.get(hash(presented));
  if (!row || revokedFamilies.has(row.family)) { console.log(`${who}: rejected (unknown or revoked)`); return null; }
  if (row.usedAt !== null) {
    revokedFamilies.add(row.family); // a used token came back: someone has a copy. Kill the whole family.
    console.log(`${who}: REUSE DETECTED -> family ${row.family} revoked`);
    return null;
  }
  row.usedAt = Date.now();
  console.log(`${who}: ok, rotated`);
  return issue(row.family);
}

const r1 = issue("fam_riya_phone");      // login
const stolen = r1;                        // malware copies r1 from the device
const r2 = refresh(r1, "Riya's app ");    // Riya's app rotates first: r1 -> r2
refresh(stolen, "attacker   ");           // attacker replays r1: reuse, family revoked
refresh(r2!, "Riya's app ");              // Riya's r2 is dead too: she must log in again, the attacker is out
```

**Real output**

```text
Riya's app : ok, rotated
attacker   : REUSE DETECTED -> family fam_riya_phone revoked
Riya's app : rejected (unknown or revoked)
```

**What to notice**

- The server stores only `sha256(token)`. Refresh tokens are 32 random bytes, so a fast hash is enough (passwords need slow hashes because humans pick guessable ones).
- The attacker's replay revoked the family, and Riya's newer token died with it. That is the point: the next sign-in happens with her password, which the thief does not have.

**Diagram: lifecycle of one refresh token**

```mermaid
stateDiagram-v2
  [*] --> active: issued at login or rotation
  active --> used: presented once, a child is issued
  active --> expired: 14 days unused
  used --> family_revoked: presented again, reuse detected
  active --> family_revoked: logout or logout everywhere
  family_revoked --> [*]
  expired --> [*]
```

**How to read this diagram.** A refresh token is born `active`, and the only good path is to be used exactly once. Using it moves it to `used` and creates its child. A `used` token coming back is the alarm: the family is revoked, which kills the child too. Logout revokes the family directly. The family also has a hard cap (30 days in the lab) after which the user must sign in again, however active they are.

**"Log out everywhere"** is one statement: revoke every family of the user. Each device's next refresh fails.

**The 10-minute gap.** Revoking families stops new access tokens, but tokens already issued stay valid until they expire (up to 10.5 minutes in the lab: 600 seconds plus 30 seconds of clock tolerance). The lab closes the gap where it matters: routes marked `sensitive` (transfers, refunds, wallet updates, logout-all) look up the family on every request. Reads stay stateless. The lab test proves both halves: after reuse detection, the old access token can still `GET` a wallet but gets `401 SESSION_REVOKED` on `POST /v1/transfers`.

**The two-tab problem.** Two browser tabs refresh at the same moment with the same cookie. The second request looks exactly like theft, and the family is revoked: the user is logged out for no reason. The lab test reproduces it (`[200, 401]`). Fix it on the **client**: one refresh at a time across tabs. Some servers add a few seconds of grace instead, but that weakens detection. For your React or Next.js app:

```ts
// web/src/auth/tokenManager.ts — browser code for the React/Next.js app (type-checked, not run in this lab).
let accessToken: string | null = null; // memory only: gone on reload, never in localStorage
let expiresAt = 0;
let inFlight: Promise<unknown> | null = null;

async function refreshNow(): Promise<void> {
  const res = await fetch("https://api.ledger.example/v1/auth/refresh", {
    method: "POST",
    credentials: "include", // send the HttpOnly refresh cookie; the browser adds Origin itself
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) { accessToken = null; return; }
  const body = (await res.json()) as { accessToken: string; expiresIn: number };
  accessToken = body.accessToken;
  expiresAt = Date.now() + body.expiresIn * 1000;
}

export async function getAccessToken(): Promise<string> {
  if (!accessToken || Date.now() > expiresAt - 30_000) {
    // One refresh at a time, across ALL tabs (Web Locks API). Two parallel refreshes with the same
    // cookie look exactly like token theft to the server, and the whole session gets revoked.
    inFlight ??= navigator.locks.request("ledger-refresh", refreshNow).finally(() => { inFlight = null; });
    await inFlight;
  }
  if (!accessToken) throw new Error("signed out: show the login screen");
  return accessToken;
}
```

**What to notice**

- The access token lives in a module variable: XSS can still *use* the session while the page is open, but cannot copy a long-lived token out of storage.
- `navigator.locks` makes tabs take turns; the second tab's refresh carries the new cookie that the first tab's response set.

### 6. Cookies: HttpOnly, Secure, SameSite, and CSRF

The refresh token travels in a cookie. These attributes decide who can read or send it:

| Attribute | What it does | Lab value |
|---|---|---|
| `HttpOnly` | JavaScript (`document.cookie`) cannot read it, so XSS cannot copy it | yes |
| `Secure` | Sent only over HTTPS | yes |
| `SameSite` | `Strict`: never sent on requests another site starts. `Lax`: also sent on top-level GET navigations from other sites. `None`: always sent (needs `Secure`) | `Strict` for refresh; `Lax` for the Google login cookie |
| `Path` | Sent only to URLs under this path | `/v1/auth` |
| `Max-Age` | Lifetime | 14 days |
| `__Secure-` name prefix | Browser rejects the cookie unless it is `Secure` and set over HTTPS | refresh cookie |
| `__Host-` name prefix | Also requires `Path=/` and no `Domain`, so a subdomain cannot set or overwrite it | Google login cookie |

Two choices worth noticing. The refresh cookie uses `__Secure-`, not `__Host-`, because `__Host-` requires `Path=/` and we want the refresh token sent **only** to `/v1/auth`. The Google login cookie must be `SameSite=Lax`: the callback arrives as a top-level redirect **from Google's site**, and `Strict` would drop the cookie, breaking sign-in. Some browsers treat a cookie with no `SameSite` as `Lax`; do not rely on defaults, set it.

**Real output** (the lab's login response):

```text
set-cookie: __Secure-ledger_rt=<token>; Max-Age=1209600; Path=/v1/auth; HttpOnly; Secure; SameSite=Strict
```

**CSRF.** If a cookie authenticates a request, another site can make the browser send that request (a hidden form that POSTs to your API). Defences for cookie-authenticated endpoints, stacked:

1. `SameSite=Strict` or `Lax`: modern browsers do not attach the cookie to cross-site POSTs.
2. **Check `Origin`** against an allowlist. Browsers send `Origin` on cross-site POSTs and page JavaScript cannot fake it. The lab's `requireTrustedOrigin` does this on `/v1/auth/refresh` and `/v1/auth/logout`.
3. Require a JSON body: a plain HTML form cannot send `application/json` cross-origin without a CORS preflight.
4. For classic server-rendered forms: a CSRF token (synchronizer or double-submit).

Bearer tokens in an `Authorization` header are **not** CSRF-able, because the browser never adds that header by itself. That is a real advantage of header tokens, as long as the token is not stored where XSS can read it.

**Where should a web app keep tokens?** RFC 10017, *OAuth 2.0 for Browser-Based Applications* (BCP, August 2026), lists its patterns in decreasing order of security and puts **Backend for Frontend (BFF)** first: the Next.js server holds the tokens and the browser holds only an HttpOnly session cookie. It strongly recommends BFF for business and sensitive applications, and notes that malicious JavaScript can steal data from origin storage such as `localStorage`. This lab's API-first shape (refresh token in an HttpOnly cookie, access token in memory) is a reasonable middle ground for a separate SPA. For a Next.js app, a BFF is the stronger choice. For React Native, there is no cookie jar to lean on: keep the refresh token in the OS keystore (Keychain on iOS, Keystore on Android, for example through `expo-secure-store`) and send it in the request body.

### 7. OAuth 2.0 and OIDC: "Login with Google"

**OAuth 2.0** lets an app get an **access token** to call an API on a user's behalf ("this app may read your Google Drive"). **OpenID Connect (OIDC)** adds an **ID token**: a signed statement of **who** the user is ("this is Google user `1029...`, email verified"). "Login with Google" is OIDC.

**ID token vs access token**

| | ID token | Access token |
|---|---|---|
| Says | Who the user is, and when and how they signed in | What the holder may do at an API |
| Audience (`aud`) | **Your** app (your client ID) | The API it was issued for |
| Who reads it | Your backend, once, at login | The API, on every call |
| Use it to call your own API? | **No.** Issue your own session after login | Google's access token is for Google's APIs only |

**Scopes** say what you ask for. For login, `openid email profile` is enough. Ask for more (Drive, Gmail) only if you call those APIs, and expect stricter review from Google.

**The authorization code flow with PKCE:**

1. Our server makes a random **code verifier** and keeps it. It sends Google only the **code challenge**: `BASE64URL(SHA-256(verifier))`. It also makes a random `state` (ties the callback to this browser) and `nonce` (ties the ID token to this request).
2. The browser goes to Google, the user signs in, and Google redirects back with a one-time **authorization code** in the URL.
3. Our server sends the code **and the verifier** (plus our client secret) to Google's token endpoint. Google checks `SHA-256(verifier) == challenge`, then returns the ID token.
4. Our server verifies the ID token (signature from Google's JWKS, `iss`, `aud`, `exp`, `nonce`), maps Google's `sub` to our user, and starts **our** session.

**Why PKCE.** The authorization code travels through the browser, in a redirect URL. URLs leak: a malicious app registered for the same custom URL scheme on a phone, browser extensions, proxy and server logs. PKCE makes a stolen code useless, because exchanging it needs the verifier, which never left our server. RFC 9700 makes PKCE mandatory for public clients (mobile apps, SPAs) and recommends it for confidential clients too, because it also blocks **authorization code injection** (an attacker pasting a victim's code into their own session). It also says not to use the implicit flow (tokens in the redirect URL) or the password grant.

**Minimal version:** `minimal/pkce.ts`

```ts
// minimal/pkce.ts — why a stolen authorization code is useless without the code_verifier.
// Run: npx tsx minimal/pkce.ts
import { createHash, randomBytes } from "node:crypto";

const s256 = (v: string) => createHash("sha256").update(v).digest("base64url");

// --- a tiny authorization server ---
const codes = new Map<string, { challenge: string; used: boolean }>();
function authorize(codeChallenge: string): string {
  const code = randomBytes(16).toString("base64url");
  codes.set(code, { challenge: codeChallenge, used: false }); // remembers the challenge, never the verifier
  return code;
}
function token(code: string, codeVerifier: string | undefined): string {
  const entry = codes.get(code);
  if (!entry || entry.used) return "invalid_grant (unknown or already used code)";
  if (!codeVerifier || s256(codeVerifier) !== entry.challenge) return "invalid_grant (PKCE verification failed)";
  entry.used = true;
  return "200 OK: id_token + access_token";
}

// --- our app ---
const verifier = randomBytes(32).toString("base64url"); // secret, stays with our app
const challenge = s256(verifier);                       // safe to send through the browser
const code = authorize(challenge);                      // the code comes back in a redirect URL

// An attacker reads the code from the redirect (a malicious app on the same URL scheme, a proxy log...).
console.log("attacker, code only:          ", token(code, undefined));
console.log("attacker, code + guessed value:", token(code, randomBytes(32).toString("base64url")));
console.log("our app, code + verifier:     ", token(code, verifier));
console.log("anyone, same code again:      ", token(code, verifier));
console.log(`challenge ${challenge.length} chars sent in the URL; verifier ${verifier.length} chars never leaves our app`);
```

**Real output**

```text
attacker, code only:           invalid_grant (PKCE verification failed)
attacker, code + guessed value: invalid_grant (PKCE verification failed)
our app, code + verifier:      200 OK: id_token + access_token
anyone, same code again:       invalid_grant (unknown or already used code)
challenge 43 chars sent in the URL; verifier 43 chars never leaves our app
```

**What to notice**

- The authorization server stores the **challenge**, never the verifier. The challenge is a hash, so seeing it in the URL does not help an attacker.
- Codes are single-use: even the right party cannot exchange a code twice.
- Google's discovery document lists `S256` (and `plain`) under `code_challenge_methods_supported` (checked 13 Oct 2026). Always use `S256`; `plain` sends the verifier itself through the browser.

**Linking accounts safely.** Link a Google identity to our user by Google's stable **`sub`**, never by email: emails get reassigned and changed. If a password account with the same email already exists, do **not** link silently (that hands the account to whoever controls that address at Google). The lab answers `409 ACCOUNT_EXISTS`: sign in with your password first, then link Google from settings.

### 8. Authorisation models: RBAC, ABAC and ReBAC

**The same question three ways.** Priya is an accountant who works for Riya Traders. Should she see Riya Traders' wallet? And Amit Stores' wallet?

**Minimal version:** `minimal/authz-models.ts`

```ts
// minimal/authz-models.ts — the same question answered by RBAC, ABAC and ReBAC.
// "Can Priya (an accountant) view wallet W of Riya Traders?" Run: npx tsx minimal/authz-models.ts
type User = { id: string; role: "user" | "accountant" | "support"; city: string };
type Wallet = { id: string; accountId: string; city: string };

const priya: User = { id: "usr_priya", role: "accountant", city: "Pune" };
const riyaWallet: Wallet = { id: "w_riya", accountId: "acc_riya_traders", city: "Pune" };
const amitWallet: Wallet = { id: "w_amit", accountId: "acc_amit_stores", city: "Pune" };

// RBAC: permissions come from the role alone.
const rolePerms: Record<User["role"], string[]> = { user: [], accountant: ["wallet:read"], support: ["wallet:read"] };
const rbac = (u: User, _w: Wallet) => rolePerms[u.role].includes("wallet:read");

// ABAC: a rule over attributes of the user, the resource and the context.
const abac = (u: User, w: Wallet, ctx: { hour: number }) =>
  u.role === "accountant" && u.city === w.city && ctx.hour >= 9 && ctx.hour < 19;

// ReBAC: a relationship graph. "Priya is a viewer of acc_riya_traders, which owns w_riya."
const relations = new Set(["acc_riya_traders#viewer@usr_priya", "acc_riya_traders#owner@usr_riya"]);
const rebac = (u: User, w: Wallet) =>
  ["owner", "viewer"].some((rel) => relations.has(`${w.accountId}#${rel}@${u.id}`));

for (const w of [riyaWallet, amitWallet]) {
  console.log(`${w.id}: RBAC=${rbac(priya, w)}  ABAC=${abac(priya, w, { hour: 11 })}  ReBAC=${rebac(priya, w)}`);
}
```

**Real output**

```text
w_riya: RBAC=true  ABAC=true  ReBAC=true
w_amit: RBAC=true  ABAC=true  ReBAC=false
```

**What to notice**

- **RBAC over-grants:** "accountants can read wallets" makes Priya able to read **every** wallet, including Amit's.
- **ABAC** narrowed it with attributes (same city, office hours) but still lets her see Amit's wallet, because Amit is also in Pune. Attributes describe things; they do not say who works for whom.
- **ReBAC** answers the real question: Priya is a **viewer of Riya Traders' account**, which owns that wallet, and has no relationship to Amit Stores.

**RBAC vs ABAC vs ReBAC (required table)**

| | RBAC (role-based) | ABAC (attribute-based) | ReBAC (relationship-based) |
|---|---|---|---|
| Rule looks like | "support may read wallets" | "accountants may read wallets in their city, 9 to 7" | "viewers of an account may read its wallets" |
| Decided by | The caller's role | Attributes of caller, object, action, context (time, IP, amount) | Edges in a graph: user → account → wallet |
| Strength | Simple; easy to audit; matches job functions | Very expressive; handles context like time and risk | Matches real ownership and sharing; fine-grained |
| Weakness | Coarse: alone it cannot say "your own" | Rules get hard to reason about and test | Needs relationship data and fast graph lookups |
| Typical tools | A role column, a permission map | Policy engines: OPA (Rego), AWS Cedar | Zanzibar-style systems: OpenFGA, SpiceDB; or SQL joins at small scale |
| On the ledger | user / support / admin | "step-up OTP above ₹10,000" is an attribute rule (amount) | owner / viewer of an account |

**Real systems mix them, and so does the lab:** RBAC decides which **actions** a role can take at all (only admins refund); ReBAC decides which **objects** a user can act on (members of the owning account); an ABAC-style rule adds context (amount above a threshold needs step-up).

**Policy engines, at concept level.** As rules grow, teams move them out of application code into a policy engine, so policies are versioned, reviewed and tested on their own, and shared across services. Two common choices (illustrative policies, shapes taken from each project's docs):

```rego
# OPA (Rego): the app sends input {principal, action, resource}; OPA answers allow or not.
package ledger.authz

default allow := false

allow if {
    input.action == "wallet:read"
    input.principal.role == "support"
}
```

```cedar
// Cedar (AWS): principals, actions and resources are typed entities.
permit (
    principal,
    action == Action::"readWallet",
    resource
)
when {
   resource.owner == principal
};
```

**Trade-off.** An engine adds a network hop (or a sidecar) and another system to run. For one service, a typed policy table in code (like `src/authz/policy.ts`) plus tests is simpler and enough.

### 9. Object-level checks: BOLA/IDOR

**What it is.** The caller is authenticated, the route is right for their role, but the **object ID** they sent belongs to someone else, and the server does not check. OWASP's prevention advice: check authorisation in every function that uses a client-supplied ID to reach a record, prefer hard-to-guess IDs, and write authorisation tests that block deployment when they fail.

**Minimal version:** `minimal/bola.ts`

```ts
// minimal/bola.ts — authenticated is not authorised: the ID in the URL must belong to the caller.
// Run: npx tsx minimal/bola.ts
const wallets = new Map([
  ["w_riya", { owner: "usr_riya", balanceMinor: 1_250_000 }],
  ["w_amit", { owner: "usr_amit", balanceMinor: 98_000_000 }],
]);
type Req = { userId: string; walletId: string };

// Beginner way: "the user is logged in, so return what they asked for".
function getWalletVulnerable(req: Req) {
  const w = wallets.get(req.walletId);
  return w ? { status: 200, body: w } : { status: 404 };
}

// Product way: the lookup itself includes the owner, so another user's wallet simply does not exist.
function getWalletChecked(req: Req) {
  const w = wallets.get(req.walletId);
  if (!w || w.owner !== req.userId) return { status: 404 }; // 404, not 403: do not confirm it exists
  return { status: 200, body: w };
}

const attack: Req = { userId: "usr_riya", walletId: "w_amit" }; // Riya edits the ID in the URL
console.log("vulnerable:", JSON.stringify(getWalletVulnerable(attack)));
console.log("checked:   ", JSON.stringify(getWalletChecked(attack)));
console.log("own wallet:", JSON.stringify(getWalletChecked({ userId: "usr_riya", walletId: "w_riya" })));
```

**Real output**

```text
vulnerable: {"status":200,"body":{"owner":"usr_amit","balanceMinor":98000000}}
checked:    {"status":404}
own wallet: {"status":200,"body":{"owner":"usr_riya","balanceMinor":1250000}}
```

**What to notice**

- The vulnerable handler leaked Amit's ₹9.8 lakh balance to Riya. Nothing was "hacked": she changed one string.
- The fixed version answers **404, not 403**. "Forbidden" would confirm the wallet exists, which helps an attacker map valid IDs.
- UUIDs make guessing hard, but they are not a security control: IDs leak through screenshots, links and logs.

**Where exactly does the check belong?**

- **Not** in the frontend (anyone can call the API directly).
- **Not only** in an API gateway: the gateway knows the token, not who owns wallet `w_123`.
- **Not** scattered in each handler, where one forgotten line is a breach.
- **Yes:** in one central authorisation step that runs **after** the ID is parsed and **before** the handler touches data, on **every** route that takes an object ID, from the path **or the body** (`sourceWalletId` in a transfer is an object ID too). Make it impossible to forget: the lab's app **refuses to start** if any route lacks an access rule, or declares one without the matching `authorize()` guard. Then test every route against every kind of caller.
- **Defence in depth:** where cheap, also scope queries by the caller (`WHERE id = $1 AND EXISTS (membership)`), so a missed check returns nothing instead of someone else's data.

**Real output** (adding the deny-by-default hook before updating P1-03's routes):

```text
STARTUP FAILED: PATCH /v1/wallets/:walletId has no access rule: add config.access (deny by default)
```

### 10. MFA and step-up authentication

**MFA** (multi-factor authentication) means two different kinds of proof: something you know (password, PIN), something you have (phone, security key), something you are (fingerprint). **Step-up** means asking for an extra, fresh proof right before a sensitive action, even though the user is already logged in: a large transfer, adding a payee, changing the phone number.

**Rules for an OTP used for step-up:**

1. **Bound to the action.** The code approves *this* transfer (amount, payee), not "anything for 5 minutes". RBI's 2025 directions say at least one factor must be dynamic, that is, unique to the transaction (secondary summary). The SMS says what is being approved, so a user tricked by a caller ("just read me the code") sees the real amount and payee.
2. **Short life and few attempts:** 5 minutes and 5 attempts. A 6-digit code has a million values; 5 attempts give a guesser a 1 in 200,000 chance (computed).
3. **Stored as an HMAC with a pepper**, not plain or plain-hashed: a leaked table of 6-digit hashes is cracked instantly by trying all million values.
4. **Constant-time comparison**, and crypto-grade randomness (`crypto.randomInt`, never `Math.random`).
5. **Signal it in the API.** RFC 9470 (OAuth 2.0 Step Up Authentication Challenge Protocol, September 2023) defines `401` with `WWW-Authenticate: Bearer error="insufficient_user_authentication"` and an optional `max_age`. The lab uses that header plus a Problem Details body.

**Minimal version:** `minimal/step-up-otp.ts`

```ts
// minimal/step-up-otp.ts — a one-time code tied to ONE transfer, with a short life and few attempts.
// Run: npx tsx minimal/step-up-otp.ts
import { createHmac, randomInt, timingSafeEqual } from "node:crypto";

const PEPPER = "from-a-secrets-manager"; // without it, a leaked table of 6-digit hashes is cracked instantly
const mac = (s: string) => createHmac("sha256", PEPPER).update(s).digest();
type Challenge = { codeMac: Buffer; boundTo: string; expiresAt: number; attemptsLeft: number; verified: boolean };

function start(boundTo: string): { challenge: Challenge; smsText: string } {
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  return {
    challenge: { codeMac: mac(code), boundTo, expiresAt: Date.now() + 5 * 60_000, attemptsLeft: 5, verified: false },
    smsText: `${code} is your OTP to send Rs 15,000.00 to Lakshmi Stores. Valid 5 min. Never share it.`,
  };
}
function verify(c: Challenge, code: string): string {
  if (Date.now() > c.expiresAt || c.attemptsLeft <= 0) return "locked or expired";
  c.attemptsLeft--;
  if (!timingSafeEqual(mac(code), c.codeMac)) return `wrong code (${c.attemptsLeft} attempts left)`;
  c.verified = true;
  return "verified";
}
// The transfer is allowed only if a verified challenge was bound to exactly these details.
const allowTransfer = (c: Challenge, details: string) => c.verified && c.boundTo === details && Date.now() <= c.expiresAt;

const { challenge, smsText } = start("pay:usr_riya:w_lakshmi:1500000");
console.log("sms:", smsText);
const realCode = smsText.slice(0, 6);
console.log("guess 000000:", verify(challenge, "000000"));
console.log("real code:   ", verify(challenge, realCode));
console.log("transfer Rs 15,000 to Lakshmi:", allowTransfer(challenge, "pay:usr_riya:w_lakshmi:1500000"));
console.log("same OTP, Rs 50,000 instead:  ", allowTransfer(challenge, "pay:usr_riya:w_lakshmi:5000000"));
```

**Real output** (the code is random on each run)

```text
sms: 534921 is your OTP to send Rs 15,000.00 to Lakshmi Stores. Valid 5 min. Never share it.
guess 000000: wrong code (4 attempts left)
real code:    verified
transfer Rs 15,000 to Lakshmi: true
same OTP, Rs 50,000 instead:   false
```

**What to notice**

- The verified OTP approved exactly one set of details. Changing the amount made it worthless.
- The attempt counter drops **before** the comparison, so a wrong guess always costs an attempt.

**SMS OTP is the floor, not the ceiling.** It is still allowed under RBI's 2025 directions (per the summary cited), and it is familiar to Indian users, but SIM-swap fraud and phishing can defeat it. Stronger factors: device-bound keys (an app that holds a private key in the phone's secure hardware and signs the transfer details), and passkeys (WebAuthn), which are phishing-resistant because the browser binds them to your real domain. Plan for these as the platform grows.

### 11. Service-to-service authentication

Inside the platform, services call each other: notifications reads balances from the ledger; a partner's backend calls our API. Three tools, often combined:

| | API key | mTLS | Short-lived service token |
|---|---|---|---|
| What it is | A long random secret sent in a header | Both sides present X.509 certificates during the TLS handshake | A signed JWT (minutes long) naming the calling service and the target `aud` |
| Proves | "Someone who has this key" | "A workload holding a certificate from our CA" | "Service X, for audience Y, until time T", with scopes |
| Revocation | Delete the key | Revoke or let short certificates expire | Expires in minutes; stop issuing |
| Good for | Partners and third parties calling our public API | Every hop inside our network, often via a service mesh | Fine-grained, per-call authorisation between services |
| Main risk | Keys leak in code and logs; often long-lived | Certificate management (a mesh automates it) | Wrong `aud` checks enable a confused deputy |

**Minimal version (API keys and service tokens):** `minimal/service-auth.ts`

```ts
// minimal/service-auth.ts — API keys stored as hashes, and short-lived service tokens pinned to an audience.
// Run: npx tsx minimal/service-auth.ts
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { generateKeyPair, jwtVerify, SignJWT } from "jose";

// 1. API key for a partner: show it once, store only a hash. The prefix lets us find the row quickly.
const keyId = randomBytes(6).toString("hex");
const secret = randomBytes(24).toString("base64url");
const apiKey = `lk_live_${keyId}_${secret}`;
const stored = { keyId, secretHash: createHash("sha256").update(secret).digest() }; // what the DB keeps
function checkApiKey(presented: string): boolean {
  // Not split("_"): base64url secrets can contain "_" themselves (the first version of this demo had that bug).
  const match = /^lk_live_([0-9a-f]{12})_([A-Za-z0-9_-]+)$/.exec(presented);
  if (!match || match[1] !== stored.keyId) return false;
  return timingSafeEqual(createHash("sha256").update(match[2]!).digest(), stored.secretHash);
}
console.log("api key shown once:", apiKey.slice(0, 22) + "...");
console.log("right key:", checkApiKey(apiKey), "| wrong key:", checkApiKey(`lk_live_${keyId}_${randomBytes(24).toString("base64url")}`));

// 2. Service token: the notifications service gets a 5-minute token for ONE audience.
const sts = await generateKeyPair("EdDSA"); // an internal token service; EdDSA keys are small and fast
const mint = (aud: string) => new SignJWT({ scope: "balances:read" }).setProtectedHeader({ alg: "EdDSA", typ: "svc+jwt" })
  .setSubject("svc:notifications").setIssuer("https://sts.internal").setAudience(aud).setIssuedAt().setExpirationTime("5m").sign(sts.privateKey);
async function ledgerAccepts(token: string): Promise<string> {
  try {
    const { payload } = await jwtVerify(token, sts.publicKey, { issuer: "https://sts.internal", audience: "ledger", algorithms: ["EdDSA"], typ: "svc+jwt" });
    return `accepted for ${payload.sub}`;
  } catch (e) { return `rejected: ${(e as { code?: string }).code}`; }
}
console.log("token for ledger, sent to ledger:       ", await ledgerAccepts(await mint("ledger")));
// A token the notifications service was given for the CRM must not work against the ledger.
console.log("token for crm, replayed against ledger: ", await ledgerAccepts(await mint("crm")));
```

**Real output** (after fixing a real bug in the first version: it parsed keys with `split("_")`, but base64url secrets can contain `_`, so the right key was rejected)

```text
api key shown once: lk_live_c7fbdf61919a_W...
right key: true | wrong key: false
token for ledger, sent to ledger:        accepted for svc:notifications
token for crm, replayed against ledger:  rejected: ERR_JWT_CLAIM_VALIDATION_FAILED
```

**What to notice**

- API keys are shown once and stored as a hash, like refresh tokens. The readable prefix (`lk_live_`) lets secret scanners on GitHub spot leaked keys, and the key ID finds the row without scanning.
- A token the notifications service got for the CRM is rejected by the ledger. Pinning `aud` per service stops a compromised service from replaying its tokens everywhere (the confused-deputy problem).

**Minimal version (mTLS):** `minimal/mtls.ts`, with certificates from `minimal/certs/gen-certs.sh`

```bash
#!/usr/bin/env bash
# minimal/certs/gen-certs.sh — a private CA, a server cert for the ledger, a client cert for notifications.
set -euo pipefail
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 30 -subj "/CN=ledger-internal-ca" -keyout ca.key -out ca.crt
for name in ledger notifications; do
  openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -subj "/CN=$name" -keyout $name.key -out $name.csr
  printf "subjectAltName=DNS:%s,DNS:localhost\n" "$name" > $name.ext
  openssl x509 -req -in $name.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 30 -extfile $name.ext -out $name.crt
done
```

```ts
// minimal/mtls.ts — mutual TLS: the ledger only talks to callers holding a certificate from our CA.
// Run: (cd minimal/certs && ./gen-certs.sh) && npx tsx minimal/mtls.ts
import { readFileSync } from "node:fs";
import https from "node:https";
import type { TLSSocket } from "node:tls";

const file = (name: string) => readFileSync(new URL(`./certs/${name}`, import.meta.url));

const server = https.createServer(
  { key: file("ledger.key"), cert: file("ledger.crt"), ca: file("ca.crt"), requestCert: true, rejectUnauthorized: true },
  (req, res) => {
    // The TLS layer already proved who is calling; the app reads the identity from the certificate.
    const caller = (req.socket as TLSSocket).getPeerCertificate().subject?.CN;
    res.end(`hello ${caller}, here is the balance`);
  },
);
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as { port: number }).port;

function call(label: string, withClientCert: boolean): Promise<void> {
  return new Promise((resolve) => {
    const req = https.request({
      host: "localhost", port, path: "/v1/balance", ca: file("ca.crt"), timeout: 2_000,
      ...(withClientCert ? { key: file("notifications.key"), cert: file("notifications.crt") } : {}),
    }, (res) => { let body = ""; res.on("data", (c) => (body += c)); res.on("end", () => { console.log(`${label} -> ${res.statusCode} ${body}`); resolve(); }); });
    req.on("error", (e: NodeJS.ErrnoException) => { console.log(`${label} -> refused: ${e.code ?? e.message}`); resolve(); });
    req.end();
  });
}

await call("no client certificate     ", false);
await call("notifications certificate ", true);
server.close();
```

**Real output**

```text
no client certificate      -> refused: ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED
notifications certificate  -> 200 hello notifications, here is the balance
```

**What to notice**

- The connection without a client certificate failed **during the TLS handshake**: the request never reached application code.
- The server reads the caller's identity (`CN=notifications`) from the verified certificate and can authorise on it.
- In production, a service mesh (Istio, Linkerd) usually issues short-lived certificates and does mTLS for you; the application only reads the identity.

**Diagram: who uses which service credential**

```mermaid
flowchart TD
  partner["Partner backend"] -->|"API key over HTTPS"| gateway["API gateway"]
  gateway -->|"mTLS"| ledger["Ledger service"]
  sts["Internal token service"] -->|"5 minute token, aud ledger"| notif["Notifications service"]
  notif -->|"mTLS plus service token"| ledger
```

**How to read this diagram.** Outsiders get API keys at the edge. Inside, every hop is mTLS, so the network itself proves which workload is calling. On top, a short-lived token says what the caller may do and for which target service. Each layer limits the damage when another one fails.

---

## ⚖️ Comparisons and trade-offs

**401 vs 403 vs 404**

| Code | Means | Ledger example | Header |
|---|---|---|---|
| 401 Unauthorized | Not authenticated, or the token is bad, expired or revoked; or a fresh factor is needed | No token; tampered token; `SESSION_REVOKED`; `STEP_UP_REQUIRED` | `WWW-Authenticate: Bearer ...` |
| 403 Forbidden | Authenticated, the caller can see the object, but may not do this | Priya (viewer) tries to send money from Riya Traders; support tries a refund | none |
| 404 Not Found | The object does not exist **or the caller may not know it exists** | Riya asks for Amit's wallet | none |
| 429 Too Many Requests | Rate limit | 6th failed login in 15 minutes | `Retry-After` |

**Where a web app keeps its tokens**

| Option | XSS can steal it? | CSRF risk? | Survives reload? | Verdict |
|---|---|---|---|---|
| `localStorage` / `sessionStorage` | **Yes**: any script on the page reads it | No | Yes | Avoid for anything long-lived |
| JavaScript memory (a variable) | Not copied out after the page closes; can be *used* while XSS runs | No | No: refresh on load | Good for the short access token |
| HttpOnly + Secure + SameSite cookie | No: JavaScript cannot read it | Yes, so add Origin checks | Yes | Good for the refresh token |
| BFF: tokens only on the Next.js server | No token in the browser at all | Yes, cookie session | Yes | Strongest for web (RFC 10017 lists it first) |
| React Native: Keychain / Keystore | Not reachable from JS bundles of other apps | No | Yes | The mobile equivalent of HttpOnly |

**Password hashing choices** (OWASP minimums; time from this guide's run where measured)

| | argon2id | bcrypt | scrypt | PBKDF2-SHA256 |
|---|---|---|---|---|
| Memory-hard (slows GPUs) | Yes | A little | Yes | No |
| OWASP minimum | m = 19 MiB, t = 2, p = 1 | cost 10 | N = 2^17, r = 8, p = 1 | 600,000 iterations |
| Time here | 27.2 ms (native) | 91.5 ms at cost 10 (pure JS) | not measured | not measured |
| Gotchas | Native module | 72-byte input limit | High memory per login | Only choice under some FIPS rules |
| Verdict | **Default choice** | Fine for existing systems | Good | Use when compliance requires it |

**Second factors**

| | SMS OTP | Authenticator app (TOTP) | Device-bound key in your app | Passkey (WebAuthn) |
|---|---|---|---|---|
| Phishing-resistant | No | No | Yes, if the key signs the transfer details | Yes: bound to your real domain |
| SIM-swap risk | Yes | No | No | No |
| Can bind to transaction details | Yes, in the message text | No | Yes | Yes, with extra data in the challenge |
| Indian users' familiarity | Very high | Medium | High (bank apps do this) | Growing |
| Cost per use | SMS charge | Free | Free | Free |

**Refresh reuse: strict or with a grace window?**

| | Strict (this lab) | Grace window (a few seconds) |
|---|---|---|
| Two tabs refresh at once | Family revoked, user signs in again | Both succeed |
| Thief replays within the window | Detected | **Not detected** |
| Fix the tab problem by | Single-flight refresh on the client (Web Locks) | Server tolerance |
| Choose when | Money, admin and support tools | Low-risk consumer content |

**Access-token lifetime**

| Lifetime | Stolen token useful for | Refresh calls per active user per hour | Notes |
|---|---|---|---|
| 5 minutes | up to 5 minutes | 12 | More refresh load and more two-tab races |
| 10 minutes (lab) | up to 10.5 minutes with clock tolerance | 6 | Plus a live session check on money routes |
| 60 minutes | up to an hour | 1 | Too long for a payments API without live checks |

---

## 🚶 Walkthrough on the ledger platform: Riya sends ₹15,000 to Lakshmi Stores

Riya is logged in on her phone. She sends ₹15,000 (`amountMinor: 1500000`), which is above the ₹10,000 step-up threshold. The numbers below match the arrows in the diagram.

**Diagram: a large transfer with step-up OTP**

```mermaid
sequenceDiagram
  autonumber
  participant App as Riya's app
  participant API as Ledger API
  participant DB as Postgres
  participant SMS as SMS provider
  App->>API: POST /v1/transfers Rs 15,000, key K, Bearer token
  API->>API: JWT valid, session live, Riya owns the wallet
  API->>DB: claim K, no verified OTP, release K
  API-->>App: 401 STEP_UP_REQUIRED
  App->>API: POST /v1/auth/step-up, same body and K
  API->>DB: store HMAC of the code, bound to user, K and body
  API->>SMS: OTP to send Rs 15,000 to Lakshmi Stores
  App->>API: POST verify with the 6 digits
  API->>DB: spend one attempt, compare, mark verified
  App->>API: POST /v1/transfers again, same body and K
  API->>DB: claim K, verified OTP found, move money
  API-->>App: 201 Created
```

**How to read this diagram.** The first transfer attempt stops before any money moves, and the idempotency key is released so it can be reused. The OTP is created for **that exact body and key**, and the SMS spells out what it approves. The second attempt is byte-for-byte the same request, so the binding matches and the transfer runs once.

1. **The app sends the transfer** with an idempotency key `K` (P1-03) and the 10-minute access token.
2. **Three gates pass.** `authenticate` checks the JWT signature, `iss`, `aud`, `typ` and `exp`. Because `POST /v1/transfers` is `sensitive`, `requireLiveSession` confirms the token family is not revoked and reloads Riya's current role. `authorize("transfer:create")` confirms Riya is an **owner** of the account that owns the source wallet.
3. **Idempotency claims `K`, then step-up says no.** ₹15,000 is above the threshold and there is no verified challenge for (Riya, `K`, this body). Nothing has run, so the key is released.
4. **The API answers `401`** with `WWW-Authenticate: Bearer error="insufficient_user_authentication", max_age="300"` (RFC 9470) and a `STEP_UP_REQUIRED` Problem body.
5. **The app starts a challenge** with the same transfer body and `K`. The API checks again that Riya may make this transfer, so nobody can trigger OTP SMS for wallets they do not own.
6. **The API stores only an HMAC** of a random 6-digit code, with 5 attempts, a 5-minute expiry, and a binding hash of (user, `K`, request hash).
7. **The SMS says what is being approved:** "OTP to send Rs 15,000.00 to Lakshmi Stores. Valid 5 min. Never share it."
8. **Riya types the code.**
9. **The API spends one attempt first, then compares** in constant time, and marks the challenge verified.
10. **The app repeats the exact request** from step 1.
11. **Idempotency claims `K` again; step-up finds the verified, unexpired challenge** for this binding; the transfer runs in one transaction (P1-03).
12. **`201 Created`.** If the network drops now and the app retries, `requireIdempotency` replays the stored `201` **before** the step-up gate runs, so no second OTP is needed.

The lab's step-up tests reproduce steps 1-12 against real Postgres.

---

## 🧪 Hands-on lab

You will add authentication and authorisation to the P1-03 API: password login with rate limits, RS256 access tokens with rotating refresh tokens, a deny-by-default ownership check on every route, roles, "Login with Google" with PKCE, and step-up OTP for large transfers. All product code below was type-checked with TypeScript 5.9 in strict mode and tested against PostgreSQL 16.15: **90 tests, all passing, on two full runs**.

**Prerequisites:** Node 22+, Docker, the P1-03 lab (its `001_init.sql`, idempotency, Problem Details and routes).

**New and changed files**

```text
ledger-api/
├── src/
│   ├── auth/       types, errors, passwords, rateLimit, keyStore, accessTokens, sessions, cookies, authenticate
│   ├── authz/      policy, resources, authorize, accessRules
│   ├── oidc/       googleClient, googleLogin, googleUsers
│   ├── stepUp/     challenges, requireStepUp
│   ├── notify/     otpSender
│   ├── routes/     auth, stepUp, refunds, transferRead (new); wallets, transfers, transactions,
│   │               statementExports (P1-03, now with access rules and authorize guards)
│   ├── plugins/idempotency.ts   keys now scoped by the verified user, not x-client-id
│   ├── db/migrations/003_auth.sql
│   └── app.ts
├── web/tokenManager.ts          browser-side refresh (shown in Deep dive 5)
└── test/  login, sessions, accessControl, oidc, stepUp  (+ helpers: db seed, login helper, fake OIDC provider)
```

**Install and configure**

```bash
npm install argon2 jose openid-client @fastify/cookie   # on top of the P1-03 dependencies
export DATABASE_URL=postgres://postgres:postgres@localhost:5432/ledger
# A signing key for access tokens. In production this comes from a secrets manager or KMS.
export JWT_PRIVATE_JWKS="$(node -e 'import("jose").then(async (j) => { const { privateKey } = await j.generateKeyPair("RS256", { extractable: true }); console.log(JSON.stringify([{ ...(await j.exportJWK(privateKey)), kid: "2026-10" }])); })')"
export OTP_PEPPER="$(openssl rand -base64 32)"
export APP_ORIGIN=http://localhost:5173 PUBLIC_BASE_URL=http://localhost:3000
```

Plumbing not printed here: `src/config/env.ts` (Zod over `process.env`; the new variables are listed in the lab's tables below), `test/setup.ts` (generates a test signing key), `test/helpers/db.ts` (resets the schema and seeds Riya, Priya, Amit, Lakshmi, support and admin), `test/helpers/auth.ts` (login and refresh helpers), and `test/helpers/fakeIdentityProvider.ts` (a 59-line OIDC provider that enforces PKCE, single-use codes and exact redirect URIs, and signs ID tokens, so the Google test runs offline).

### Step 1: Signup and login with argon2id, rate-limited per IP and per account

`src/db/migrations/003_auth.sql` adds users, memberships, sessions, rate limits, OIDC attempts, OTP challenges, refunds and an audit table:

```sql
-- src/db/migrations/003_auth.sql — users, memberships, sessions, rate limits, OIDC, step-up and audit.
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email citext NOT NULL UNIQUE,                 -- citext: Riya@x.com and riya@x.com are one account
  password_hash text,                           -- NULL for users who only sign in with Google
  role text NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'support', 'admin')),
  phone_e164 text,                              -- where step-up OTPs are sent
  created_at timestamptz NOT NULL DEFAULT now()
);

-- "Login with Google": we link on Google's stable `sub`, never on the email address.
CREATE TABLE user_identities (
  provider text NOT NULL,
  subject text NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, subject)
);

-- Relationship-based access: who may do what on which account (and so on its wallets).
CREATE TABLE account_members (
  account_id uuid NOT NULL REFERENCES accounts(id),
  user_id uuid NOT NULL REFERENCES users(id),
  relation text NOT NULL CHECK (relation IN ('owner', 'viewer')),
  PRIMARY KEY (account_id, user_id)
);
CREATE INDEX account_members_user_idx ON account_members (user_id);

-- One family per login. Every refresh token descends from it; revoking it signs that device out.
CREATE TABLE token_families (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  auth_time timestamptz NOT NULL,               -- when the user actually authenticated
  amr text[] NOT NULL,                          -- how: {pwd}, {google}
  created_at timestamptz NOT NULL DEFAULT now(),
  absolute_expires_at timestamptz NOT NULL,     -- hard cap: log in again after this, whatever happens
  revoked_at timestamptz,
  revoked_reason text
);
CREATE INDEX token_families_active_user_idx ON token_families (user_id) WHERE revoked_at IS NULL;

CREATE TABLE refresh_tokens (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  family_id uuid NOT NULL REFERENCES token_families(id),
  token_hash bytea NOT NULL UNIQUE,             -- sha256 of the token; the token itself is never stored
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz                           -- set on rotation; seeing it again means theft
);

CREATE TABLE rate_limit_buckets (
  key text NOT NULL,
  window_start timestamptz NOT NULL,
  hits integer NOT NULL,
  PRIMARY KEY (key, window_start)
);

CREATE TABLE oidc_login_attempts (
  id text PRIMARY KEY,                          -- also the value of the browser's short-lived cookie
  state text NOT NULL,
  code_verifier text NOT NULL,
  nonce text NOT NULL,
  expires_at timestamptz NOT NULL
);

CREATE TABLE otp_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  purpose text NOT NULL,
  binding_hash bytea NOT NULL,                  -- ties the OTP to one exact transfer
  code_mac bytea NOT NULL,                      -- HMAC(pepper, code); the code is never stored
  attempts_left integer NOT NULL,
  expires_at timestamptz NOT NULL,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX otp_challenges_binding_idx ON otp_challenges (user_id, binding_hash);

CREATE TABLE refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_id uuid NOT NULL UNIQUE REFERENCES transfers(id),
  requested_by uuid NOT NULL REFERENCES users(id),
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Append-only audit trail: logins, reuse detections, privileged reads, revocations.
CREATE TABLE security_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid,
  type text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
```

**What to notice**

- `password_hash` is nullable: a Google-only user has no password, and the login code still runs a dummy verification for them.
- `account_members.relation` is the whole relationship model: `owner` or `viewer`.
- Nothing secret is stored in plain form: refresh tokens as SHA-256, OTPs as HMAC with a pepper, passwords as argon2id.

`src/auth/passwords.ts`:

```ts
// src/auth/passwords.ts — argon2id with OWASP's minimum parameters, and constant work for unknown emails.
import argon2 from "argon2";

// OWASP minimum for argon2id: 19 MiB memory, 2 iterations, 1 lane. Raise it when your servers allow.
const PARAMS = { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

// Verifying against a real-looking hash when the email is unknown keeps the response time the same,
// so timing cannot reveal which emails have accounts.
const dummyHash = argon2.hash("not-a-real-password-just-for-timing", PARAMS);

export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, PARAMS); // salt is random per call and stored inside the encoded hash
}

export async function verifyPassword(storedHash: string | null, password: string): Promise<boolean> {
  if (!storedHash) {
    await argon2.verify(await dummyHash, password);
    return false;
  }
  return argon2.verify(storedHash, password);
}

// After raising PARAMS, old hashes are upgraded the next time each user logs in successfully.
export function needsRehash(storedHash: string): boolean {
  return argon2.needsRehash(storedHash, PARAMS);
}
```

`src/auth/rateLimit.ts`:

```ts
// src/auth/rateLimit.ts — fixed-window counters in Postgres, shared by every API instance.
// (P3-04 covers better algorithms and Redis; this is enough to stop credential stuffing at the door.)
import { pool } from "../db/pool.js";

export interface WindowState { hits: number; retryAfterSeconds: number }

const windowStartSql = "to_timestamp(floor(extract(epoch FROM now()) / $2) * $2)";

// Count one more hit and return the new total for the current window. Atomic under concurrency.
export async function hit(key: string, windowSeconds: number): Promise<WindowState> {
  const { rows: [row] } = await pool.query<{ hits: number; retry_after: number }>(
    `INSERT INTO rate_limit_buckets (key, window_start, hits) VALUES ($1, ${windowStartSql}, 1)
     ON CONFLICT (key, window_start) DO UPDATE SET hits = rate_limit_buckets.hits + 1
     RETURNING hits, ceil(extract(epoch FROM window_start + make_interval(secs => $2) - now()))::int AS retry_after`,
    [key, windowSeconds],
  );
  return { hits: row?.hits ?? 0, retryAfterSeconds: Math.max(1, row?.retry_after ?? windowSeconds) };
}

// Read without counting: used for "how many FAILED logins has this account had?"
export async function peek(key: string, windowSeconds: number): Promise<WindowState> {
  const { rows: [row] } = await pool.query<{ hits: number; retry_after: number }>(
    `SELECT hits, ceil(extract(epoch FROM window_start + make_interval(secs => $2) - now()))::int AS retry_after
     FROM rate_limit_buckets WHERE key = $1 AND window_start = ${windowStartSql}`,
    [key, windowSeconds],
  );
  return { hits: row?.hits ?? 0, retryAfterSeconds: Math.max(1, row?.retry_after ?? windowSeconds) };
}

export async function reset(key: string): Promise<void> {
  await pool.query("DELETE FROM rate_limit_buckets WHERE key = $1", [key]);
}
```

**What to notice**

- `INSERT ... ON CONFLICT DO UPDATE ... RETURNING hits` counts atomically across every API instance. An in-memory counter would give each instance its own limit.
- `peek` reads without counting: the per-account bucket counts **failures**, so a user who logs in successfully all day is never locked.

`src/auth/errors.ts`:

```ts
// src/auth/errors.ts — auth failures as Problem Details, with the WWW-Authenticate header RFC 6750 asks for.
import { ApiError } from "../lib/problem.js";

const bearer = (error?: string, extra = "") => ({
  "www-authenticate": error ? `Bearer error="${error}"${extra}` : "Bearer",
});

export const authErrors = {
  unauthenticated: () => new ApiError(401, "UNAUTHENTICATED", "Authentication required", undefined, { headers: bearer() }),
  invalidToken: () =>
    new ApiError(401, "INVALID_TOKEN", "Access token is invalid or expired", undefined, { headers: bearer("invalid_token") }),
  // One message for "no such email" and "wrong password": never tell an attacker which one it was.
  invalidCredentials: () => new ApiError(401, "INVALID_CREDENTIALS", "Email or password is incorrect"),
  tooManyAttempts: (retryAfterSeconds: number) =>
    new ApiError(429, "TOO_MANY_ATTEMPTS", "Too many attempts", "Wait before trying again.", {
      headers: { "retry-after": String(retryAfterSeconds) },
    }),
  sessionRevoked: () =>
    new ApiError(401, "SESSION_REVOKED", "This session has been signed out", undefined, { headers: bearer("invalid_token") }),
  refreshRejected: () => new ApiError(401, "REFRESH_TOKEN_INVALID", "Please sign in again"),
  forbidden: () => new ApiError(403, "FORBIDDEN", "You do not have permission for this action"),
  untrustedOrigin: () => new ApiError(403, "UNTRUSTED_ORIGIN", "Request origin is not allowed"),
  googleAccountConflict: () =>
    new ApiError(409, "ACCOUNT_EXISTS", "An account with this email already exists", "Sign in with your password, then link Google in settings."),
  loginAttemptInvalid: () => new ApiError(400, "LOGIN_ATTEMPT_INVALID", "Sign-in expired or was started in another browser"),
  stepUpRequired: (maxAgeSeconds: number) =>
    new ApiError(401, "STEP_UP_REQUIRED", "Confirm this transfer with a one-time code", "Start a challenge at POST /v1/auth/step-up.", {
      headers: bearer("insufficient_user_authentication", `, max_age="${maxAgeSeconds}"`), // RFC 9470
    }),
  challengeClosed: () => new ApiError(400, "CHALLENGE_CLOSED", "This code has expired or has no attempts left"),
  wrongCode: () => new ApiError(400, "WRONG_CODE", "The code is incorrect"),
};
```

`src/routes/auth.ts` (login here; refresh and logout are explained in Step 2):

```ts
// src/routes/auth.ts — signup, login (rate-limited), refresh rotation, logout, logout everywhere, JWKS.
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { issueAccessToken } from "../auth/accessTokens.js";
import { requirePrincipal } from "../auth/authenticate.js";
import { clearRefreshCookie, readRefreshCookie, requireTrustedOrigin, setRefreshCookie } from "../auth/cookies.js";
import { authErrors } from "../auth/errors.js";
import { publicJwks } from "../auth/keyStore.js";
import { hashPassword, needsRehash, verifyPassword } from "../auth/passwords.js";
import * as limits from "../auth/rateLimit.js";
import { type IssuedSession, revokeAllSessions, revokeFamilyByToken, rotateRefreshToken, startSession } from "../auth/sessions.js";
import type { Role } from "../auth/types.js";
import { env } from "../config/env.js";
import { pool } from "../db/pool.js";
import { validate } from "../lib/validate.js";

const credentials = z.strictObject({ email: z.email().max(254), password: z.string().min(10).max(128) });
type Credentials = z.infer<typeof credentials>;

async function sendSession(reply: FastifyReply, session: IssuedSession): Promise<FastifyReply> {
  setRefreshCookie(reply, session.refreshToken);
  const accessToken = await issueAccessToken(session.principal);
  // The SPA keeps this in memory only (a variable), never in localStorage.
  return reply.header("cache-control", "no-store").send({ accessToken, tokenType: "Bearer", expiresIn: env.ACCESS_TOKEN_TTL_SECONDS });
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: Credentials }>("/v1/auth/signup",
    { config: { access: { kind: "public", why: "creates the identity" } }, preHandler: [validate("body", credentials)] },
    async (request, reply) => {
      const ip = await limits.hit(`signup:ip:${request.ip}`, 3600);
      if (ip.hits > 10) throw authErrors.tooManyAttempts(ip.retryAfterSeconds);
      const passwordHash = await hashPassword(request.body.password);
      await pool.query("INSERT INTO users (email, password_hash) VALUES ($1, $2) ON CONFLICT (email) DO NOTHING",
        [request.body.email, passwordHash]);
      // Same answer whether or not the email existed: signup must not become an "is this email registered?" API.
      // (Production sends a verification email here and activates the account only after it is clicked.)
      return reply.code(202).send({ status: "check_your_email" });
    });

  app.post<{ Body: Credentials }>("/v1/auth/login",
    { config: { access: { kind: "public", why: "establishes the identity" } }, preHandler: [validate("body", credentials)] },
    async (request, reply) => {
      const email = request.body.email.toLowerCase();
      // Two walls against credential stuffing: per IP (one bot, many emails) and per account (many bots, one email).
      const ip = await limits.hit(`login:ip:${request.ip}`, env.LOGIN_WINDOW_SECONDS);
      if (ip.hits > env.LOGIN_IP_LIMIT) throw authErrors.tooManyAttempts(ip.retryAfterSeconds);
      const failures = await limits.peek(`login:fail:${email}`, env.LOGIN_WINDOW_SECONDS);
      if (failures.hits >= env.LOGIN_ACCOUNT_FAILURE_LIMIT) throw authErrors.tooManyAttempts(failures.retryAfterSeconds);

      const { rows: [user] } = await pool.query<{ id: string; password_hash: string | null; role: Role }>(
        "SELECT id, password_hash, role FROM users WHERE email = $1", [email]);
      const ok = await verifyPassword(user?.password_hash ?? null, request.body.password);
      if (!user || !ok) {
        await limits.hit(`login:fail:${email}`, env.LOGIN_WINDOW_SECONDS); // counted for unknown emails too
        request.log.info({ emailDomain: email.split("@")[1] }, "login failed"); // never log the password or full email
        throw authErrors.invalidCredentials();
      }
      await limits.reset(`login:fail:${email}`);
      if (user.password_hash && needsRehash(user.password_hash)) {
        await pool.query("UPDATE users SET password_hash = $2 WHERE id = $1", [user.id, await hashPassword(request.body.password)]);
      }
      return sendSession(reply, await startSession(user.id, user.role, ["pwd"]));
    });

  app.post("/v1/auth/refresh",
    { config: { access: { kind: "public", why: "authenticated by the refresh cookie" } }, preHandler: [requireTrustedOrigin] },
    async (request, reply) => {
      const presented = readRefreshCookie(request);
      if (!presented) throw authErrors.refreshRejected();
      const result = await rotateRefreshToken(presented);
      if (result.kind !== "rotated") {
        if (result.kind === "reuse_detected") request.log.warn({ userId: result.userId }, "refresh token reuse: family revoked");
        clearRefreshCookie(reply);
        throw authErrors.refreshRejected(); // same answer for both: do not coach an attacker
      }
      return sendSession(reply, result.session);
    });

  app.post("/v1/auth/logout",
    { config: { access: { kind: "public", why: "authenticated by the refresh cookie" } }, preHandler: [requireTrustedOrigin] },
    async (request, reply) => {
      const presented = readRefreshCookie(request);
      if (presented) await revokeFamilyByToken(presented, "logout");
      clearRefreshCookie(reply);
      return reply.code(204).send();
    });

  app.post("/v1/auth/logout-all", { config: { access: { kind: "self", sensitive: true } } }, async (request, reply) => {
    const revoked = await revokeAllSessions(requirePrincipal(request).userId, "logout_all");
    clearRefreshCookie(reply);
    return reply.send({ revokedSessions: revoked });
  });

  app.get("/.well-known/jwks.json", { config: { access: { kind: "public", why: "public keys only" } } },
    async (_request, reply) => reply.header("cache-control", "public, max-age=300").send(publicJwks));
}
```

**What to notice**

- Signup hashes the password **even when the email exists**, then answers `202` either way: same time, same body, no account enumeration.
- Login checks the per-IP limit first (cheap), then the per-account failure count, and only then pays for argon2id.
- A failed login counts against the email **even when the account does not exist**, so the limit itself does not reveal which emails are real.
- `needsRehash` upgrades old hashes on the next successful login after you raise the parameters.
- **Behind a load balancer**, `request.ip` is the balancer's address unless Fastify's `trustProxy` is set correctly. Get this wrong and one per-IP limit is shared by every user in the country, or attackers spoof `X-Forwarded-For` to skip it.

`test/login.test.ts`:

```ts
// test/login.test.ts — argon2id signup and login, generic errors, and both rate limits.
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { pool } from "../src/db/pool.js";
import { login } from "./helpers/auth.js";
import { PASSWORD, resetDatabase, seedWorld, type World } from "./helpers/db.js";

let app: FastifyInstance, world: World;
beforeAll(async () => { app = await buildApp(); await app.ready(); });
beforeEach(async () => { await resetDatabase(); world = await seedWorld(); });
afterAll(async () => { await app.close(); await pool.end(); });

describe("signup", () => {
  it("answers the same for a new and an existing email (no account enumeration)", async () => {
    const signup = (email: string) => app.inject({ method: "POST", url: "/v1/auth/signup", payload: { email, password: "a long passphrase" } });
    const fresh = await signup("new@ledger.test"), existing = await signup(world.users.riya.email);
    expect([fresh.statusCode, existing.statusCode]).toEqual([202, 202]);
    expect(fresh.body).toBe(existing.body);
    const { rows: [u] } = await pool.query<{ password_hash: string }>("SELECT password_hash FROM users WHERE email = 'new@ledger.test'");
    console.log("stored hash:", u?.password_hash.slice(0, 40) + "...");
    expect(u?.password_hash).toMatch(/^\$argon2id\$v=19\$m=19456,p=1,t=2\$/);
  });
});

describe("login", () => {
  it("returns an access token and sets the refresh cookie", async () => {
    const { res, accessToken, refreshToken } = await login(app, world.users.riya.email);
    expect(res.statusCode).toBe(200);
    expect(accessToken.split(".")).toHaveLength(3);
    expect(refreshToken).toBeTruthy();
    console.log("set-cookie:", String(res.headers["set-cookie"]).replace(/=[^;]+;/, "=<token>;"));
  });

  it("gives one answer for a wrong password and an unknown email, in similar time", async () => {
    const time = async (email: string, password: string) => {
      const t = performance.now(); const { res } = await login(app, email, password);
      const { requestId: _differsPerRequest, ...problem } = res.json(); // everything else must be identical
      return { ms: performance.now() - t, body: JSON.stringify(problem) };
    };
    const wrong = [], unknown = [];
    for (let i = 0; i < 4; i++) {
      wrong.push(await time(world.users.amit.email, `wrong password ${i}`));
      unknown.push(await time(`ghost${i}@ledger.test`, `wrong password ${i}`));
    }
    const avg = (xs: { ms: number }[]) => (xs.reduce((s, x) => s + x.ms, 0) / xs.length).toFixed(1);
    console.log(`wrong password: ${avg(wrong)} ms avg | unknown email: ${avg(unknown)} ms avg`);
    expect(wrong[0]!.body).toBe(unknown[0]!.body);
  });

  it("locks an account after 5 failures, even for the right password, without blocking other accounts", async () => {
    for (let i = 0; i < 5; i++) expect((await login(app, world.users.riya.email, "not the password")).res.statusCode).toBe(401);
    const locked = await login(app, world.users.riya.email, PASSWORD);
    console.log("6th try with the RIGHT password ->", locked.res.statusCode, locked.res.json().code, "retry-after", locked.res.headers["retry-after"]);
    expect(locked.res.statusCode).toBe(429);
    expect((await login(app, world.users.amit.email)).res.statusCode).toBe(200);
  });

  it("limits one IP spraying many accounts (credential stuffing)", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 21; i++) statuses.push((await login(app, `victim${i}@ledger.test`, "Password123!", "203.0.113.7")).res.statusCode);
    const otherIp = await login(app, world.users.riya.email, PASSWORD, "198.51.100.9");
    console.log(`from 203.0.113.7: ${statuses.filter((s) => s === 401).length} x 401 then ${statuses.filter((s) => s === 429).length} x 429 | other IP: ${otherIp.res.statusCode}`);
    expect(statuses.at(-1)).toBe(429);
    expect(otherIp.res.statusCode).toBe(200);
  });
});
```

**Real output**

```text
stored hash: $argon2id$v=19$m=19456,p=1,t=2$K6mKnc2QB...
 ✓ test/login.test.ts > signup > answers the same for a new and an existing email (no account enumeration)
set-cookie: __Secure-ledger_rt=<token>; Max-Age=1209600; Path=/v1/auth; HttpOnly; Secure; SameSite=Strict
 ✓ test/login.test.ts > login > returns an access token and sets the refresh cookie
wrong password: 37.0 ms avg | unknown email: 36.9 ms avg
 ✓ test/login.test.ts > login > gives one answer for a wrong password and an unknown email, in similar time
6th try with the RIGHT password -> 429 TOO_MANY_ATTEMPTS retry-after 886
 ✓ test/login.test.ts > login > locks an account after 5 failures, even for the right password, without blocking other accounts
 ✓ test/login.test.ts > login > limits one IP spraying many accounts (credential stuffing)
```

**What to notice**

- "Wrong password" and "unknown email" took the same time (37.0 vs 36.9 ms) thanks to the dummy hash. Without it, unknown emails would answer in about 1 ms (expected; try Break it step 4) and an attacker could list your users by timing.
- Even the right password is refused while the account is locked; `Retry-After` says when to try again (886 seconds left in that window).
- The first version of the "same answer" test failed: the Problem bodies differed by `requestId`. Comparing everything except `requestId` is the honest check.

### Step 2: RS256 access tokens and rotating refresh tokens with reuse detection

**Diagram: login, then refresh rotation, then a stolen token is replayed**

```mermaid
sequenceDiagram
  participant B as Riya's browser
  participant T as Thief
  participant A as Ledger API
  participant DB as Postgres
  B->>A: POST /v1/auth/login, email and password
  A->>DB: rate limits, argon2id verify
  A->>DB: INSERT family F and refresh token R1 as a hash
  A-->>B: access token AT1 in body, R1 in HttpOnly cookie
  B->>A: GET /v1/wallets/w1, Bearer AT1
  A-->>B: 200, signature check only
  Note over B: 10 minutes later AT1 expires
  B->>A: POST /v1/auth/refresh, cookie R1, Origin header
  A->>DB: R1 unused, mark used, INSERT R2 in family F
  A-->>B: AT2 in body, R2 in cookie
  T->>A: POST /v1/auth/refresh with a stolen copy of R1
  A->>DB: R1 already used, revoke family F
  A-->>T: 401 REFRESH_TOKEN_INVALID
  B->>A: POST /v1/auth/refresh, cookie R2
  A-->>B: 401, family revoked, sign in again
```

**How to read this diagram.** The top half is the normal life of a session: login creates a family, the access token is checked by signature alone, and each refresh swaps the cookie for a new one. The bottom half is theft: the old R1 comes back, the server sees it was already used, and the whole family dies. The thief is out, and Riya signs in again with a password the thief does not have.

`src/auth/types.ts`:

```ts
// src/auth/types.ts — who is calling, as proven by a verified access token.
import type { AccessRule } from "../authz/accessRules.js";

export type Role = "user" | "support" | "admin";

export interface Principal {
  userId: string;
  role: Role;
  sessionId: string; // the token family: lets money routes check "is this login still alive?"
  authTime: number;  // unix seconds of the real authentication, not of the last refresh
  amr: string[];     // authentication methods: ["pwd"], ["google"]
}

declare module "fastify" {
  interface FastifyRequest {
    principal: Principal | null;
  }
  interface FastifyContextConfig {
    access?: AccessRule;
  }
}
```

`src/auth/keyStore.ts`:

```ts
// src/auth/keyStore.ts — signing keys for access tokens, and the public JWKS other services verify with.
import { createLocalJWKSet, importJWK, type CryptoKey, type JWK } from "jose";
import { env } from "../config/env.js";

interface SigningKey { kid: string; privateKey: CryptoKey }

const PRIVATE_FIELDS = ["d", "p", "q", "dp", "dq", "qi"] as const;

// JWT_PRIVATE_JWKS comes from a secrets manager. The first key signs; the others only verify
// (they were the signing key before the last rotation and may still have live tokens).
const privateJwks = JSON.parse(env.JWT_PRIVATE_JWKS) as JWK[];
if (!privateJwks.length || privateJwks.some((k) => !k.kid || k.kty !== "RSA")) {
  throw new Error("JWT_PRIVATE_JWKS must be a non-empty array of RSA JWKs, each with a kid");
}

export const publicJwks: { keys: JWK[] } = {
  keys: privateJwks.map((k) => {
    const pub: JWK = { ...k, alg: "RS256", use: "sig" };
    for (const field of PRIVATE_FIELDS) delete pub[field]; // never publish private parts
    return pub;
  }),
};

let active: Promise<SigningKey> | undefined;
export function activeSigningKey(): Promise<SigningKey> {
  const first = privateJwks[0]!;
  active ??= importJWK(first, "RS256").then((key) => ({ kid: first.kid!, privateKey: key as CryptoKey }));
  return active;
}

// Inside this service we verify locally. Other services use createRemoteJWKSet(<issuer>/.well-known/jwks.json).
export const localJwks = createLocalJWKSet(publicJwks);
```

`src/auth/accessTokens.ts`:

```ts
// src/auth/accessTokens.ts — short-lived RS256 access tokens: issue and verify.
import { randomUUID } from "node:crypto";
import { jwtVerify, SignJWT } from "jose";
import { env } from "../config/env.js";
import { activeSigningKey, localJwks } from "./keyStore.js";
import type { Principal, Role } from "./types.js";

const ROLES: readonly Role[] = ["user", "support", "admin"];

export async function issueAccessToken(p: Principal): Promise<string> {
  const { kid, privateKey } = await activeSigningKey();
  return new SignJWT({ role: p.role, sid: p.sessionId, auth_time: p.authTime, amr: p.amr })
    .setProtectedHeader({ alg: "RS256", typ: "at+jwt", kid }) // typ: an ID token can never pass as an access token
    .setIssuer(env.AUTH_ISSUER)
    .setAudience(env.AUTH_AUDIENCE)
    .setSubject(p.userId)
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime(`${env.ACCESS_TOKEN_TTL_SECONDS}s`)
    .sign(privateKey);
}

// Everything is pinned: algorithm, type, issuer, audience, expiry (jose checks exp and nbf by default).
export async function verifyAccessToken(token: string): Promise<Principal | null> {
  try {
    const { payload } = await jwtVerify(token, localJwks, {
      algorithms: ["RS256"],
      typ: "at+jwt",
      issuer: env.AUTH_ISSUER,
      audience: env.AUTH_AUDIENCE,
      clockTolerance: 30, // seconds of clock drift between servers
    });
    const role = payload.role as Role;
    if (!payload.sub || typeof payload.sid !== "string" || !ROLES.includes(role)) return null;
    return {
      userId: payload.sub,
      role,
      sessionId: payload.sid,
      authTime: Number(payload.auth_time),
      amr: Array.isArray(payload.amr) ? payload.amr.map(String) : [],
    };
  } catch {
    return null; // expired, bad signature, wrong audience...: the caller answers 401 either way
  }
}
```

**What to notice**

- `typ: "at+jwt"` is set when signing and **required** when verifying: an ID token or a service token cannot be used as an access token here.
- `algorithms: ["RS256"]`, `issuer` and `audience` are pinned. jose checks `exp` and `nbf` by default.
- Every failure becomes `null` and then one generic 401: the client gets no hints about which check failed.
- The private key never leaves `keyStore.ts`; `/.well-known/jwks.json` publishes only the public fields (a test checks that `d` and the other private parts are absent).

`src/auth/sessions.ts`:

```ts
// src/auth/sessions.ts — token families and rotating refresh tokens, stored as hashes in Postgres.
import { createHash, randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import { env } from "../config/env.js";
import { pool } from "../db/pool.js";
import type { Principal, Role } from "./types.js";

const sha256 = (token: string) => createHash("sha256").update(token).digest();
// 32 random bytes: too much entropy to brute-force, so a fast hash is enough here (unlike passwords).
const newRefreshToken = () => randomBytes(32).toString("base64url");

export interface IssuedSession { principal: Principal; refreshToken: string }
export type RotateResult = { kind: "rotated"; session: IssuedSession } | { kind: "rejected" } | { kind: "reuse_detected"; userId: string };

async function insertRefreshToken(db: PoolClient | typeof pool, familyId: string): Promise<string> {
  const token = newRefreshToken();
  await db.query(
    "INSERT INTO refresh_tokens (family_id, token_hash, expires_at) VALUES ($1, $2, now() + make_interval(days => $3))",
    [familyId, sha256(token), env.REFRESH_TOKEN_IDLE_DAYS]);
  return token;
}

// Called after a successful login (password or Google): one new family per device sign-in.
export async function startSession(userId: string, role: Role, amr: string[]): Promise<IssuedSession> {
  const { rows: [family] } = await pool.query<{ id: string; auth_time: Date }>(
    `INSERT INTO token_families (user_id, auth_time, amr, absolute_expires_at)
     VALUES ($1, now(), $2, now() + make_interval(days => $3)) RETURNING id, auth_time`,
    [userId, amr, env.SESSION_MAX_DAYS]);
  if (!family) throw new Error("INSERT ... RETURNING returned no row");
  const refreshToken = await insertRefreshToken(pool, family.id);
  const authTime = Math.floor(family.auth_time.getTime() / 1000);
  return { refreshToken, principal: { userId, role, sessionId: family.id, authTime, amr } };
}

interface TokenRow {
  id: string; family_id: string; used_at: Date | null; token_expired: boolean; family_revoked: boolean;
  family_expired: boolean; user_id: string; role: Role; auth_time: Date; amr: string[];
}

export async function rotateRefreshToken(presented: string): Promise<RotateResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // FOR UPDATE: two requests with the same token cannot both see "unused".
    const { rows: [t] } = await client.query<TokenRow>(
      `SELECT rt.id, rt.family_id, rt.used_at, rt.expires_at < now() AS token_expired,
              f.revoked_at IS NOT NULL AS family_revoked, f.absolute_expires_at < now() AS family_expired,
              f.user_id, u.role, f.auth_time, f.amr
       FROM refresh_tokens rt JOIN token_families f ON f.id = rt.family_id JOIN users u ON u.id = f.user_id
       WHERE rt.token_hash = $1 FOR UPDATE OF rt`, [sha256(presented)]);

    if (!t || t.family_revoked || t.token_expired || t.family_expired) { await client.query("ROLLBACK"); return { kind: "rejected" }; }
    if (t.used_at) {
      // A token we already rotated came back. Either the thief or the real user holds a copy:
      // we cannot tell which, so the whole family dies and the real user signs in again.
      await client.query("UPDATE token_families SET revoked_at = now(), revoked_reason = 'refresh_token_reuse' WHERE id = $1", [t.family_id]);
      await client.query("INSERT INTO security_events (user_id, type, detail) VALUES ($1, 'refresh_token_reuse', $2)",
        [t.user_id, JSON.stringify({ familyId: t.family_id })]);
      await client.query("COMMIT");
      return { kind: "reuse_detected", userId: t.user_id };
    }
    await client.query("UPDATE refresh_tokens SET used_at = now() WHERE id = $1", [t.id]);
    const refreshToken = await insertRefreshToken(client, t.family_id);
    await client.query("COMMIT");
    const principal: Principal = {
      userId: t.user_id, role: t.role, sessionId: t.family_id, authTime: Math.floor(t.auth_time.getTime() / 1000), amr: t.amr,
    };
    return { kind: "rotated", session: { principal, refreshToken } };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function revokeFamilyByToken(presented: string, reason: string): Promise<void> {
  await pool.query(
    `UPDATE token_families SET revoked_at = now(), revoked_reason = $2
     WHERE id = (SELECT family_id FROM refresh_tokens WHERE token_hash = $1) AND revoked_at IS NULL`,
    [sha256(presented), reason]);
}

// "Log out everywhere": every device's family, in one statement.
export async function revokeAllSessions(userId: string, reason: string): Promise<number> {
  const { rowCount } = await pool.query(
    "UPDATE token_families SET revoked_at = now(), revoked_reason = $2 WHERE user_id = $1 AND revoked_at IS NULL", [userId, reason]);
  return rowCount ?? 0;
}

// For money routes: is this login still alive, and what is the user's role RIGHT NOW?
export async function liveSession(sessionId: string): Promise<{ role: Role } | null> {
  const { rows: [row] } = await pool.query<{ role: Role }>(
    `SELECT u.role FROM token_families f JOIN users u ON u.id = f.user_id
     WHERE f.id = $1 AND f.revoked_at IS NULL AND f.absolute_expires_at > now()`, [sessionId]);
  return row ?? null;
}
```

**What to notice**

- `FOR UPDATE OF rt` locks the presented token's row. Two requests with the same token cannot both see "unused": the second waits, then sees `used_at` and triggers reuse detection.
- On reuse, the family is revoked **and** a `security_events` row is written in the same transaction. Alert on this event: it means a token was copied.
- `liveSession` returns the user's **current** role. A demoted admin loses admin powers on sensitive routes immediately, not when their token expires.

`src/auth/cookies.ts`:

```ts
// src/auth/cookies.ts — the refresh token lives in a cookie JavaScript cannot read.
import type { FastifyReply, FastifyRequest } from "fastify";
import { env } from "../config/env.js";
import { authErrors } from "./errors.js";

// __Secure- : the browser refuses this cookie unless it is Secure and set over HTTPS.
// (Not __Host-, because that prefix requires Path=/ and we want the cookie sent ONLY to /v1/auth.)
export const REFRESH_COOKIE = "__Secure-ledger_rt";
const REFRESH_PATH = "/v1/auth";

export function setRefreshCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(REFRESH_COOKIE, token, {
    httpOnly: true,        // invisible to document.cookie, so an XSS bug cannot read it
    secure: true,          // HTTPS only (browsers treat http://localhost as secure for development)
    sameSite: "strict",    // never sent on requests started by another site
    path: REFRESH_PATH,    // not sent to /v1/wallets and friends: less exposure in logs and proxies
    maxAge: env.REFRESH_TOKEN_IDLE_DAYS * 24 * 3600,
  });
}

export function clearRefreshCookie(reply: FastifyReply): void {
  reply.clearCookie(REFRESH_COOKIE, { path: REFRESH_PATH, secure: true, httpOnly: true, sameSite: "strict" });
}

export function readRefreshCookie(request: FastifyRequest): string | undefined {
  return request.cookies[REFRESH_COOKIE];
}

// CSRF defence for cookie-authenticated endpoints: SameSite is the first wall, Origin is the second.
// Browsers always send Origin on cross-site POSTs, and JavaScript cannot fake it.
export async function requireTrustedOrigin(request: FastifyRequest): Promise<void> {
  if (request.headers.origin !== new URL(env.APP_ORIGIN).origin) throw authErrors.untrustedOrigin();
}
```

`src/auth/authenticate.ts`:

```ts
// src/auth/authenticate.ts — who is calling? (Authentication only. What they may do is src/authz.)
import type { FastifyRequest } from "fastify";
import { verifyAccessToken } from "./accessTokens.js";
import { authErrors } from "./errors.js";
import { liveSession } from "./sessions.js";
import type { Principal } from "./types.js";

// onRequest hook for every non-public route. Stateless: one signature check, no database.
export async function authenticate(request: FastifyRequest): Promise<void> {
  const header = request.headers.authorization;
  if (!header) throw authErrors.unauthenticated();
  const [scheme, token] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) throw authErrors.unauthenticated();
  const principal = await verifyAccessToken(token);
  if (!principal) throw authErrors.invalidToken();
  request.principal = principal;
}

// Added for sensitive routes (money, roles, sessions). One indexed query buys two things a pure JWT cannot:
// "log out everywhere" takes effect now, and a demoted admin loses admin now, not in 10 minutes.
export async function requireLiveSession(request: FastifyRequest): Promise<void> {
  const principal = requirePrincipal(request);
  const live = await liveSession(principal.sessionId);
  if (!live) throw authErrors.sessionRevoked();
  request.principal = { ...principal, role: live.role };
}

export function requirePrincipal(request: FastifyRequest): Principal {
  if (!request.principal) throw new Error("route reached without authentication: check its access rule");
  return request.principal;
}
```

`test/sessions.test.ts`:

```ts
// test/sessions.test.ts — refresh rotation, reuse detection, logout everywhere, CSRF and token checks.
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { pool } from "../src/db/pool.js";
import { bearer, login, refresh, refreshCookieFrom } from "./helpers/auth.js";
import { resetDatabase, seedWorld, type World } from "./helpers/db.js";

let app: FastifyInstance, world: World;
beforeAll(async () => { app = await buildApp(); await app.ready(); });
beforeEach(async () => { await resetDatabase(); world = await seedWorld(); });
afterAll(async () => { await app.close(); await pool.end(); });

const smallTransfer = (token: string) => app.inject({
  method: "POST", url: "/v1/transfers", headers: { ...bearer(token), "idempotency-key": randomUUID() },
  payload: { sourceWalletId: world.wallets.riya, destinationWalletId: world.wallets.lakshmi, amountMinor: 100, currency: "INR" },
});

describe("refresh token rotation", () => {
  it("rotates: each refresh returns a new token and retires the old one", async () => {
    const { refreshToken: r1 } = await login(app, world.users.riya.email);
    const res = await refresh(app, r1!);
    const r2 = refreshCookieFrom(res);
    expect(res.statusCode).toBe(200);
    expect(r2).toBeTruthy();
    expect(r2).not.toBe(r1);
  });

  it("detects reuse of a rotated token and revokes the whole family", async () => {
    const { accessToken, refreshToken: r1 } = await login(app, world.users.riya.email);
    const r2 = refreshCookieFrom(await refresh(app, r1!));    // the real app rotates
    const replay = await refresh(app, r1!);                     // a thief replays the old token
    const victim = await refresh(app, r2!);                     // the newest token is dead too
    const { rows } = await pool.query("SELECT type FROM security_events WHERE type = 'refresh_token_reuse'");
    console.log(`replay of r1 -> ${replay.statusCode} ${replay.json().code} | r2 afterwards -> ${victim.statusCode} | security events: ${rows.length}`);
    expect([replay.statusCode, victim.statusCode]).toEqual([401, 401]);
    expect(rows).toHaveLength(1);

    // The access token is a JWT: reads still pass until it expires. Money routes check the session live.
    const read = await app.inject({ url: `/v1/wallets/${world.wallets.riya}`, headers: bearer(accessToken) });
    const money = await smallTransfer(accessToken);
    console.log(`same access token after revocation: GET wallet -> ${read.statusCode}, POST transfer -> ${money.statusCode} ${money.json().code}`);
    expect(read.statusCode).toBe(200);
    expect(money.statusCode).toBe(401);
  });

  it("two tabs refreshing with the same token at once: one wins, the family is revoked", async () => {
    const { refreshToken } = await login(app, world.users.riya.email);
    const both = await Promise.all([refresh(app, refreshToken!), refresh(app, refreshToken!)]);
    console.log("two parallel refreshes ->", both.map((r) => r.statusCode).sort());
    expect(both.map((r) => r.statusCode).sort()).toEqual([200, 401]);
  });

  it("log out everywhere kills every device", async () => {
    const phone = await login(app, world.users.riya.email);
    const laptop = await login(app, world.users.riya.email);
    const out = await app.inject({ method: "POST", url: "/v1/auth/logout-all", headers: bearer(laptop.accessToken) });
    const phoneRefresh = await refresh(app, phone.refreshToken!);
    console.log(`logout-all -> ${out.statusCode} ${out.body} | phone refresh -> ${phoneRefresh.statusCode}`);
    expect(out.json().revokedSessions).toBe(2);
    expect(phoneRefresh.statusCode).toBe(401);
  });
});

describe("CSRF and token validation", () => {
  it("rejects refresh from a missing or foreign Origin", async () => {
    const { refreshToken } = await login(app, world.users.riya.email);
    const cookies = { "__Secure-ledger_rt": refreshToken! };
    const none = await app.inject({ method: "POST", url: "/v1/auth/refresh", cookies });
    const evil = await app.inject({ method: "POST", url: "/v1/auth/refresh", cookies, headers: { origin: "https://evil.example" } });
    console.log("no Origin ->", none.statusCode, none.json().code, "| evil Origin ->", evil.statusCode);
    expect([none.statusCode, evil.statusCode]).toEqual([403, 403]);
  });

  it("rejects tampered and alg:none tokens, and publishes only public keys", async () => {
    const { accessToken } = await login(app, world.users.riya.email);
    const [h, p] = accessToken.split(".");
    const admin = Buffer.from(Buffer.from(p!, "base64url").toString().replace('"role":"user"', '"role":"admin"')).toString("base64url");
    const none = Buffer.from(JSON.stringify({ alg: "none", typ: "at+jwt" })).toString("base64url");
    for (const [label, token] of [["edited payload", `${h}.${admin}.${accessToken.split(".")[2]}`], ["alg none", `${none}.${admin}.`]] as const) {
      const res = await app.inject({ url: `/v1/wallets/${world.wallets.riya}`, headers: bearer(token) });
      console.log(`${label} -> ${res.statusCode} ${res.headers["www-authenticate"]}`);
      expect(res.statusCode).toBe(401);
    }
    const jwks = (await app.inject({ url: "/.well-known/jwks.json" })).json();
    expect(Object.keys(jwks.keys[0]).sort()).toEqual(["alg", "e", "kid", "kty", "n", "use"]);
  });
});
```

**Real output**

```text
 ✓ test/sessions.test.ts > refresh token rotation > rotates: each refresh returns a new token and retires the old one
replay of r1 -> 401 REFRESH_TOKEN_INVALID | r2 afterwards -> 401 | security events: 1
same access token after revocation: GET wallet -> 200, POST transfer -> 401 SESSION_REVOKED
 ✓ test/sessions.test.ts > refresh token rotation > detects reuse of a rotated token and revokes the whole family
two parallel refreshes -> [ 200, 401 ]
 ✓ test/sessions.test.ts > refresh token rotation > two tabs refreshing with the same token at once: one wins, the family is revoked
logout-all -> 200 {"revokedSessions":2} | phone refresh -> 401
 ✓ test/sessions.test.ts > refresh token rotation > log out everywhere kills every device
no Origin -> 403 UNTRUSTED_ORIGIN | evil Origin -> 403
 ✓ test/sessions.test.ts > CSRF and token validation > rejects refresh from a missing or foreign Origin
edited payload -> 401 Bearer error="invalid_token"
alg none -> 401 Bearer error="invalid_token"
 ✓ test/sessions.test.ts > CSRF and token validation > rejects tampered and alg:none tokens, and publishes only public keys
```

**What to notice**

- **The reuse test (the card's Measure item):** replaying R1 revoked the family, R2 died with it, and exactly one security event was written.
- **The JWT trade-off, measured:** after revocation, the old access token still read a wallet (stateless, until it expires) but could not move money (live check). That is the design working as intended.
- The two-tab race really happens: `[200, 401]`. Fix it in the client with the single-flight refresher from Deep dive 5.

### Step 3: Ownership middleware on every wallet and transfer route

`src/authz/policy.ts` (the roles of Step 4 live here too):

```ts
// src/authz/policy.ts — the whole permission model in one table, readable in a code review.
import type { Role } from "../auth/types.js";

export type Action =
  | "wallet:read" | "wallet:update" | "transfer:create" | "transfer:read"
  | "refund:create" | "export:create" | "export:read";
export type Relation = "owner" | "viewer";
export type ResourceType = "wallet" | "transfer" | "statementExport";

interface Rule {
  anyRoles: Role[];          // RBAC: these roles may act on ANY such object (staff)
  ownRoles: Role[];          // these roles may act on objects THEY are related to...
  relations: Relation[];     // ...through one of these relationships (ReBAC)
}

const READ: Relation[] = ["owner", "viewer"];
const WRITE: Relation[] = ["owner"];

export const POLICY: Record<Action, Rule> = {
  "wallet:read":     { anyRoles: ["support", "admin"], ownRoles: ["user"], relations: READ },
  "wallet:update":   { anyRoles: ["admin"],            ownRoles: ["user"], relations: WRITE },
  "transfer:create": { anyRoles: [],                   ownRoles: ["user"], relations: WRITE }, // staff never move customer money
  "transfer:read":   { anyRoles: ["support", "admin"], ownRoles: ["user"], relations: READ },
  "refund:create":   { anyRoles: ["admin"],            ownRoles: [],       relations: [] },    // support can see, not refund
  "export:create":   { anyRoles: [],                   ownRoles: ["user"], relations: READ },
  "export:read":     { anyRoles: ["support", "admin"], ownRoles: ["user"], relations: READ },
};

export const READ_ACTION: Record<ResourceType, Action> = {
  wallet: "wallet:read", transfer: "transfer:read", statementExport: "export:read",
};

export type Decision = "allow" | "allow_privileged" | "deny";

// `relation` is the caller's best relationship to the object (null when there is none).
export function decide(role: Role, action: Action, relation: Relation | null): Decision {
  const rule = POLICY[action];
  if (rule.ownRoles.includes(role) && relation && rule.relations.includes(relation)) return "allow";
  if (rule.anyRoles.includes(role)) return "allow_privileged"; // allowed, but audited: staff reading customer data
  return "deny";
}
```

`src/authz/resources.ts`:

```ts
// src/authz/resources.ts — for an object ID: does it exist, and how is THIS user related to it?
import { pool } from "../db/pool.js";
import type { Relation, ResourceType } from "./policy.js";

export interface ResourceFacts { exists: boolean; relation: Relation | null }

// Pick the strongest relationship when the user reaches the object more than one way.
const BEST_RELATION = "ORDER BY (m.relation = 'owner') DESC LIMIT 1";

// One query per check. Each joins through account_members, so "belongs to the caller" is data, not code.
const SQL: Record<ResourceType, string> = {
  wallet: `
    SELECT true AS exists, (SELECT m.relation FROM account_members m
                            WHERE m.account_id = w.account_id AND m.user_id = $2) AS relation
    FROM wallets w WHERE w.id = $1`,
  // A transfer is visible from BOTH sides: payer and payee.
  transfer: `
    SELECT true AS exists, (SELECT m.relation FROM wallets w JOIN account_members m ON m.account_id = w.account_id
                            WHERE w.id IN (t.source_wallet_id, t.destination_wallet_id) AND m.user_id = $2 ${BEST_RELATION}) AS relation
    FROM transfers t WHERE t.id = $1`,
  statementExport: `
    SELECT true AS exists, (SELECT m.relation FROM wallets w JOIN account_members m ON m.account_id = w.account_id
                            WHERE w.id = e.wallet_id AND m.user_id = $2) AS relation
    FROM statement_exports e WHERE e.id = $1`,
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function resourceFacts(type: ResourceType, id: string, userId: string): Promise<ResourceFacts> {
  if (!UUID.test(id)) return { exists: false, relation: null }; // a malformed ID matches nothing
  const { rows: [row] } = await pool.query<{ exists: boolean; relation: Relation | null }>(SQL[type], [id, userId]);
  return row ? { exists: true, relation: row.relation } : { exists: false, relation: null };
}
```

`src/authz/authorize.ts`, **the ownership middleware**:

```ts
// src/authz/authorize.ts — the ownership middleware: role AND relationship, on every object ID, every request.
import type { FastifyRequest } from "fastify";
import { requirePrincipal } from "../auth/authenticate.js";
import { authErrors } from "../auth/errors.js";
import { pool } from "../db/pool.js";
import { errors } from "../lib/problem.js";
import { type Action, decide, READ_ACTION, type ResourceType } from "./policy.js";
import { resourceFacts } from "./resources.js";

export const AUTHZ_GUARD = Symbol("authzGuard"); // lets the route registry prove every route has a guard

export interface Locator { type: ResourceType; from: "params" | "body"; field: string }
export const fromParam = (type: ResourceType, field: string): Locator => ({ type, from: "params", field });
export const fromBody = (type: ResourceType, field: string): Locator => ({ type, from: "body", field });

const notFound = { wallet: errors.walletNotFound, transfer: errors.transferNotFound, statementExport: errors.exportNotFound };

export function authorize(action: Action, locator: Locator) {
  const guard = async (request: FastifyRequest): Promise<void> => {
    const principal = requirePrincipal(request);
    const source = (locator.from === "params" ? request.params : request.body) as Record<string, unknown> | undefined;
    const id = String(source?.[locator.field] ?? "");
    const facts = await resourceFacts(locator.type, id, principal.userId);
    if (!facts.exists) throw notFound[locator.type]();

    const decision = decide(principal.role, action, facts.relation);
    if (decision === "allow") return;
    if (decision === "allow_privileged") {
      await pool.query("INSERT INTO security_events (user_id, type, detail) VALUES ($1, 'privileged_access', $2)",
        [principal.userId, JSON.stringify({ action, type: locator.type, id, role: principal.role })]);
      return;
    }

    // Denied. Never confirm that an object exists to someone who could not even read it (BOLA hygiene).
    const canRead = decide(principal.role, READ_ACTION[locator.type], facts.relation) !== "deny";
    throw canRead ? authErrors.forbidden() : notFound[locator.type]();
  };
  return Object.assign(guard, { [AUTHZ_GUARD]: action });
}
```

**What to notice**

- One query answers both "does it exist?" and "how is this user related to it?". A transfer is related through **either** side, so Amit (the payee) can see a transfer Riya sent him.
- The decision combines **RBAC** (`anyRoles`, `ownRoles`) with **ReBAC** (`relations`). Staff access is allowed but **audited**.
- The deny branch is the BOLA rule: 404 if the caller could not even read the object, 403 only if they could.
- The returned guard is tagged with `AUTHZ_GUARD`, so the route registry can prove it is present.

`src/authz/accessRules.ts`, **deny by default**:

```ts
// src/authz/accessRules.ts — deny by default: a route without an access rule stops the app from starting.
import type { FastifyInstance, RouteOptions } from "fastify";
import { authenticate, requireLiveSession } from "../auth/authenticate.js";
import { AUTHZ_GUARD } from "./authorize.js";
import type { Action } from "./policy.js";

export type AccessRule =
  | { kind: "public"; why: string }                              // login, JWKS, OAuth callback...
  | { kind: "self"; sensitive?: boolean }                        // acts only on the caller's own identity
  | { kind: "resource"; action: Action; sensitive?: boolean };   // acts on an object someone owns

const toArray = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

export function enforceAccessRules(app: FastifyInstance): void {
  app.addHook("onRoute", (route: RouteOptions) => {
    const name = `${String(route.method)} ${route.url}`;
    const rule = route.config?.access;
    if (!rule) throw new Error(`${name} has no access rule: add config.access (deny by default)`);
    if (rule.kind === "public") return;

    // Authentication is attached here, centrally, so no route can forget it.
    const sensitive = rule.sensitive === true;
    route.onRequest = [authenticate, ...(sensitive ? [requireLiveSession] : []), ...toArray(route.onRequest)];

    // Authorisation needs the object ID, so each route places authorize() itself. Here we only PROVE it did.
    if (rule.kind === "resource") {
      const hasGuard = toArray(route.preHandler).some(
        (h) => (h as unknown as Record<symbol, unknown>)[AUTHZ_GUARD] === rule.action);
      if (!hasGuard) throw new Error(`${name} declares ${rule.action} but has no authorize("${rule.action}", ...) preHandler`);
    }
  });
}
```

**What to notice**

- `onRoute` runs as each route is registered. A route with no `config.access` throws, and the app does not start.
- `authenticate` (and `requireLiveSession` for sensitive routes) is attached **here**, centrally, so a route cannot forget it.
- `authorize()` stays in each route, because only the route knows where the object ID is (path or body). The hook only proves it is there and matches the declared action.

`src/app.ts`:

```ts
// src/app.ts — builds the Fastify app. Access rules are enforced before any route is registered.
import { randomUUID } from "node:crypto";
import cookie from "@fastify/cookie";
import Fastify, { type FastifyInstance } from "fastify";
import "./auth/types.js";
import { enforceAccessRules } from "./authz/accessRules.js";
import { env } from "./config/env.js";
import { logOtpSender, type OtpSender } from "./notify/otpSender.js";
import { googleLoginRoutes } from "./oidc/googleLogin.js";
import { registerErrorHandler } from "./plugins/errorHandler.js";
import { authRoutes } from "./routes/auth.js";
import { refundRoutes } from "./routes/refunds.js";
import { statementExportRoutes } from "./routes/statementExports.js";
import { stepUpRoutes } from "./routes/stepUp.js";
import { transactionRoutes } from "./routes/transactions.js";
import { transferReadRoutes } from "./routes/transferRead.js";
import { transferRoutes } from "./routes/transfers.js";
import { walletRoutes } from "./routes/wallets.js";

export interface AppDeps { otpSender?: OtpSender }

export async function buildApp(deps: AppDeps = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: env.LOG_LEVEL, redact: ["req.headers.authorization", "req.headers.cookie"] },
    genReqId: () => randomUUID(),
    bodyLimit: 64 * 1024,
    requestTimeout: 15_000,
    // Behind a load balancer set trustProxy to its address or hop count, or request.ip is the LB for everyone
    // (and per-IP login limits lock out the whole country at once).
  });

  app.decorateRequest("principal", null);
  app.decorateRequest("idempotencyClaim", null);
  app.decorate("otpSender", deps.otpSender ?? logOtpSender(app.log));
  app.addHook("onRequest", async (request, reply) => { reply.header("x-request-id", request.id); });

  registerErrorHandler(app);
  await app.register(cookie);
  enforceAccessRules(app); // must come BEFORE every route below

  await app.register(authRoutes);
  await app.register(googleLoginRoutes);
  await app.register(stepUpRoutes);
  await app.register(walletRoutes);
  await app.register(transactionRoutes);
  await app.register(transferRoutes);
  await app.register(transferReadRoutes);
  await app.register(refundRoutes);
  await app.register(statementExportRoutes);
  return app;
}
```

How a P1-03 route looks now, `src/routes/transfers.ts`:

```ts
// src/routes/transfers.ts — POST /v1/transfers: validate, claim the key, run the transfer.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { components } from "../generated/api.js";
import { authorize, fromBody } from "../authz/authorize.js";
import { validate } from "../lib/validate.js";
import { requireIdempotency } from "../plugins/idempotency.js";
import { createTransfer } from "../services/transferService.js";
import { requireStepUpForLargeTransfers } from "../stepUp/requireStepUp.js";

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
    {
      config: { access: { kind: "resource", action: "transfer:create", sensitive: true } },
      // Order matters: shape -> may this user spend from this wallet? -> claim the key -> OTP for big amounts.
      preHandler: [
        validate("body", createTransferBody),
        authorize("transfer:create", fromBody("wallet", "sourceWalletId")),
        requireIdempotency,
        requireStepUpForLargeTransfers,
      ],
    },
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

- `sourceWalletId` comes from the **body**, and it is an object ID like any other. Forgetting body IDs is a classic BOLA: the path has no ID, so nobody thinks to check.
- The destination is not checked: anyone may receive money, just as anyone can be paid by UPI.
- The order of preHandlers is the order of the gates diagram in "How it works".

`src/routes/wallets.ts` (GET added, PATCH from P1-03 now guarded):

```ts
// src/routes/wallets.ts — PATCH with If-Match: "update only if nobody changed it since I read it".
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { components } from "../generated/api.js";
import { pool } from "../db/pool.js";
import { errors } from "../lib/problem.js";
import { authorize, fromParam } from "../authz/authorize.js";
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
  app.get<{ Params: z.infer<typeof params> }>(
    "/v1/wallets/:walletId",
    {
      config: { access: { kind: "resource", action: "wallet:read" } },
      preHandler: [validate("params", params), authorize("wallet:read", fromParam("wallet", "walletId"))],
    },
    async (request, reply): Promise<Wallet> => {
      const { rows: [row] } = await pool.query<WalletRow>(
        "SELECT id, account_id, balance_minor, nickname, status, version, created_at FROM wallets WHERE id = $1",
        [request.params.walletId]);
      reply.header("etag", etagOf(row!.version));
      return toApi(row!);
    },
  );

  app.patch<{ Params: z.infer<typeof params>; Body: z.infer<typeof body> }>(
    "/v1/wallets/:walletId",
    {
      config: { access: { kind: "resource", action: "wallet:update", sensitive: true } },
      preHandler: [validate("params", params), validate("body", body), authorize("wallet:update", fromParam("wallet", "walletId"))],
    },
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

`test/accessControl.test.ts`, **the cross-user test and the full matrix**:

```ts
// test/accessControl.test.ts — every route x every kind of caller. Cross-user reads must fail.
import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance, type InjectOptions } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { authorize, fromParam } from "../src/authz/authorize.js";
import { enforceAccessRules } from "../src/authz/accessRules.js";
import { pool } from "../src/db/pool.js";
import { bearer, login } from "./helpers/auth.js";
import { resetDatabase, seedWorld, type World } from "./helpers/db.js";

type Actor = "anonymous" | "riya" | "priya" | "amit" | "support" | "admin";
const ACTORS: Actor[] = ["anonymous", "riya", "priya", "amit", "support", "admin"];
let app: FastifyInstance, w: World;
const tokens: Partial<Record<Actor, string>> = {};

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  await resetDatabase();
  w = await seedWorld();
  for (const a of ACTORS) if (a !== "anonymous") tokens[a] = (await login(app, w.users[a].email)).accessToken;
});
afterAll(async () => { await app.close(); await pool.end(); });

// riya = owner of Riya Traders, priya = viewer (accountant) of Riya Traders, amit = owner of another shop.
type Case = { name: string; req: () => InjectOptions; expect: Record<Actor, number> };
const key = () => ({ "idempotency-key": randomUUID() });
const CASES: Case[] = [
  { name: "GET riya's wallet", req: () => ({ url: `/v1/wallets/${w.wallets.riya}` }),
    expect: { anonymous: 401, riya: 200, priya: 200, amit: 404, support: 200, admin: 200 } },
  { name: "GET riya's wallet transactions", req: () => ({ url: `/v1/wallets/${w.wallets.riya}/transactions` }),
    expect: { anonymous: 401, riya: 200, priya: 200, amit: 404, support: 200, admin: 200 } },
  { name: "PATCH riya's wallet (412 = allowed, stale ETag)", req: () => ({ method: "PATCH", url: `/v1/wallets/${w.wallets.riya}`, headers: { "if-match": '"v999"' }, payload: { nickname: "Main till" } }),
    expect: { anonymous: 401, riya: 412, priya: 403, amit: 404, support: 403, admin: 412 } },
  { name: "POST transfer from riya's wallet", req: () => ({ method: "POST", url: "/v1/transfers", headers: key(), payload: { sourceWalletId: w.wallets.riya, destinationWalletId: w.wallets.lakshmi, amountMinor: 100, currency: "INR" } }),
    expect: { anonymous: 401, riya: 201, priya: 403, amit: 404, support: 403, admin: 403 } },
  { name: "GET transfer riya -> amit", req: () => ({ url: `/v1/transfers/${w.transfers.riyaToAmit}` }),
    expect: { anonymous: 401, riya: 200, priya: 200, amit: 200, support: 200, admin: 200 } },
  { name: "GET transfer amit -> lakshmi", req: () => ({ url: `/v1/transfers/${w.transfers.amitToLakshmi}` }),
    expect: { anonymous: 401, riya: 404, priya: 404, amit: 200, support: 200, admin: 200 } },
  { name: "POST refund on riya -> amit", req: () => ({ method: "POST", url: `/v1/transfers/${w.transfers.riyaToAmit}/refunds`, payload: { reason: "duplicate payment" } }),
    expect: { anonymous: 401, riya: 403, priya: 403, amit: 403, support: 403, admin: 202 } },
  { name: "POST refund on amit -> lakshmi", req: () => ({ method: "POST", url: `/v1/transfers/${w.transfers.amitToLakshmi}/refunds`, payload: { reason: "duplicate payment" } }),
    expect: { anonymous: 401, riya: 404, priya: 404, amit: 403, support: 403, admin: 202 } },
  { name: "POST statement export for riya's wallet", req: () => ({ method: "POST", url: `/v1/wallets/${w.wallets.riya}/statement-exports`, headers: key(), payload: { from: "2026-09-01", to: "2026-09-30", format: "pdf" } }),
    expect: { anonymous: 401, riya: 202, priya: 202, amit: 404, support: 403, admin: 403 } },
  { name: "GET riya's statement export", req: () => ({ url: `/v1/statement-exports/${w.exports.riya}` }),
    expect: { anonymous: 401, riya: 200, priya: 200, amit: 404, support: 200, admin: 200 } },
  { name: "GET a wallet that does not exist", req: () => ({ url: `/v1/wallets/${randomUUID()}` }),
    expect: { anonymous: 401, riya: 404, priya: 404, amit: 404, support: 404, admin: 404 } },
];

describe("access-control matrix", () => {
  const rows = CASES.flatMap((c) => ACTORS.map((actor) => ({ ...c, actor, status: c.expect[actor] })));
  it.each(rows)("$name as $actor -> $status", async ({ req, actor, status }) => {
    const options = req();
    const headers = { ...(options.headers ?? {}), ...(actor === "anonymous" ? {} : bearer(tokens[actor]!)) };
    const res = await app.inject({ ...options, headers });
    expect(res.statusCode, res.body).toBe(status);
  });

  it("user A cannot read user B's wallet, and the answer does not reveal it exists", async () => {
    const amitsWallet = await app.inject({ url: `/v1/wallets/${w.wallets.amit}`, headers: bearer(tokens.riya!) });
    const noSuchWallet = await app.inject({ url: `/v1/wallets/${randomUUID()}`, headers: bearer(tokens.riya!) });
    expect(amitsWallet.statusCode).toBe(404);
    expect(amitsWallet.json().code).toBe(noSuchWallet.json().code);
  });

  it("records every privileged (staff) access in the audit log", async () => {
    const { rows: events } = await pool.query("SELECT detail->>'role' AS role, count(*)::int AS n FROM security_events WHERE type = 'privileged_access' GROUP BY 1 ORDER BY 1");
    console.log("privileged access events:", JSON.stringify(events));
    expect(events.length).toBe(2);
  });
});

describe("deny by default", () => {
  it("refuses to start with a route that has no access rule", async () => {
    const bare = Fastify();
    enforceAccessRules(bare);
    await expect(bare.register(async (a) => { a.get("/v1/oops", async () => "leak"); })).rejects.toThrow("has no access rule");
  });

  it("refuses to start with a resource rule but no matching authorize() guard", async () => {
    const bare = Fastify();
    enforceAccessRules(bare);
    await expect(bare.register(async (a) => {
      a.get("/v1/wallets/:walletId", { config: { access: { kind: "resource", action: "wallet:read" } },
        preHandler: [authorize("transfer:read", fromParam("transfer", "walletId"))] }, async () => "wrong guard");
    })).rejects.toThrow("has no authorize");
  });
});
```

**Real output** (summary; every one of the 70 tests is listed in the verbose output)

```text
privileged access events: [{"role":"admin","n":8},{"role":"support","n":5}]
 ✓ test/accessControl.test.ts > access-control matrix > records every privileged (staff) access in the audit log
      Tests  70 passed (70)
```

**What to notice**

- **66 matrix tests** (11 route cases × 6 kinds of caller) plus the cross-user test, the audit test and two deny-by-default tests: **70 access-control tests, all passing**.
- **The cross-user test:** Riya asking for Amit's wallet gets the same `404 WALLET_NOT_FOUND` as for a wallet that does not exist.
- `PATCH` expects `412` for allowed callers: authorisation passed, then the stale `If-Match` (P1-03) stopped the write. A test that only checks "not 403" would miss bugs.
- Adding a new route without updating this table is the risk. Treat "add a matrix row" as part of every new endpoint's definition of done.

### Step 4: Roles: user, support and admin

The roles live in the `POLICY` table above. What each role can do on the ledger platform:

| Action | user (own objects, by relationship) | support (any object) | admin (any object) |
|---|---|---|---|
| View a wallet, its transactions, a transfer, a statement export | owner or viewer | yes, audited | yes, audited |
| Update a wallet | owner | no | yes, audited |
| Create a transfer | owner | **no** | **no** |
| Create a statement export | owner or viewer | no | no |
| Request a refund | no | **no** (can view, cannot refund) | yes, audited |

Staff cannot create transfers from customer wallets at all: **separation of duties**. Admins who need to move money do it through a reviewed back-office workflow, not the customer API.

`src/routes/refunds.ts`:

```ts
// src/routes/refunds.ts — only admins may request a refund. Support can see the transfer, nothing more.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requirePrincipal } from "../auth/authenticate.js";
import { authorize, fromParam } from "../authz/authorize.js";
import { pool } from "../db/pool.js";
import { ApiError } from "../lib/problem.js";
import { validate } from "../lib/validate.js";

const params = z.strictObject({ transferId: z.uuid() });
const body = z.strictObject({ reason: z.string().min(3).max(200) });

export async function refundRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: z.infer<typeof params>; Body: z.infer<typeof body> }>("/v1/transfers/:transferId/refunds", {
    config: { access: { kind: "resource", action: "refund:create", sensitive: true } }, // live role check, not the token's
    preHandler: [validate("params", params), validate("body", body), authorize("refund:create", fromParam("transfer", "transferId"))],
  }, async (request, reply) => {
    // The money movement itself runs later as a workflow; here we record who asked and why.
    const { rows: [refund] } = await pool.query<{ id: string; status: string }>(
      `INSERT INTO refunds (transfer_id, requested_by, reason) VALUES ($1, $2, $3)
       ON CONFLICT (transfer_id) DO NOTHING RETURNING id, status`,
      [request.params.transferId, requirePrincipal(request).userId, request.body.reason]);
    if (!refund) throw new ApiError(409, "REFUND_EXISTS", "A refund was already requested for this transfer");
    return reply.code(202).send({ refundId: refund.id, status: refund.status });
  });
}
```

**What to notice**

- `sensitive: true` means the role is re-read from the database on every refund request. A support agent who was briefly made admin and then demoted cannot keep refunding for the rest of their token's life.
- From the matrix: support gets `403` on refunds for transfers it can see; Riya gets `404` on a refund for a transfer she is not part of. That is BFLA and BOLA handled by the same guard.

### Step 5: "Login with Google" through OIDC with PKCE

**Diagram: the authorization code flow with PKCE**

```mermaid
sequenceDiagram
  autonumber
  participant U as Browser
  participant L as Ledger API
  participant G as Google
  U->>L: GET /v1/auth/google/start
  L->>L: make verifier, state, nonce and store them
  L-->>U: 302 to Google with code_challenge S256, state, nonce
  U->>G: sign in and consent
  G-->>U: 302 to our callback with code and state
  U->>L: GET callback with code, state and login cookie
  L->>L: load attempt by cookie, delete it, check state
  L->>G: POST token with code, code_verifier, client secret
  G->>G: SHA-256 of verifier equals challenge?
  G-->>L: ID token and Google access token
  L->>L: verify ID token signature, iss, aud, exp, nonce
  L-->>U: 303 to the app with OUR refresh cookie
```

**How to read this diagram.** Only the **challenge** (a hash) travels through the browser in step 3. The verifier stays on our server until step 8, and goes straight to Google over a back channel. So whoever reads the code from the redirect in step 5 still cannot complete step 9. In step 12 Google's tokens are dropped: the user now holds our session.

**Set up the real Google client (expected, not run here).** In the Google Cloud console, create an OAuth client ID of type "Web application", add the exact redirect URI (`https://api.your-domain/v1/auth/google/callback`; Google matches it exactly), and set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. `GOOGLE_ISSUER` defaults to `https://accounts.google.com`, whose discovery document (checked 13 Oct 2026) lists the authorization endpoint `https://accounts.google.com/o/oauth2/v2/auth`, the token endpoint `https://oauth2.googleapis.com/token` and `RS256` ID tokens.

`src/oidc/googleClient.ts`:

```ts
// src/oidc/googleClient.ts — OIDC discovery for Google, done once and cached.
import * as oidc from "openid-client";
import { env } from "../config/env.js";

let configPromise: Promise<oidc.Configuration> | undefined;

export function googleConfig(): Promise<oidc.Configuration> {
  configPromise ??= oidc
    .discovery(new URL(env.GOOGLE_ISSUER), env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, undefined, {
      timeout: 5, // seconds; also applies to the later token request
      // Only the test identity provider runs on plain http. Real issuers are https, and that is enforced.
      ...(env.GOOGLE_ISSUER.startsWith("http://") ? { execute: [oidc.allowInsecureRequests] } : {}),
    })
    .catch((err: unknown) => {
      configPromise = undefined; // do not cache a failure: try discovery again on the next login
      throw err;
    });
  return configPromise;
}

export const googleCallbackUrl = () => new URL("/v1/auth/google/callback", env.PUBLIC_BASE_URL);
```

`src/oidc/googleLogin.ts`:

```ts
// src/oidc/googleLogin.ts — "Login with Google": authorization code flow with PKCE, state and nonce.
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import * as oidc from "openid-client";
import { setRefreshCookie } from "../auth/cookies.js";
import { authErrors } from "../auth/errors.js";
import { startSession } from "../auth/sessions.js";
import { env } from "../config/env.js";
import { pool } from "../db/pool.js";
import { googleCallbackUrl, googleConfig } from "./googleClient.js";
import { findOrCreateGoogleUser } from "./googleUsers.js";

// __Host-: Secure, Path=/, no Domain, so no subdomain can plant or overwrite it.
// SameSite=Lax, NOT Strict: the callback is a cross-site redirect from Google, and Strict would drop the cookie.
const LOGIN_COOKIE = "__Host-ledger_oidc";

export async function googleLoginRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/auth/google/start", { config: { access: { kind: "public", why: "starts sign-in" } } }, async (_request, reply) => {
    const config = await googleConfig();
    const attempt = {
      id: randomBytes(24).toString("base64url"),
      codeVerifier: oidc.randomPKCECodeVerifier(), // stays on our server; only its hash goes to Google
      state: oidc.randomState(),                   // ties the callback to THIS browser (login CSRF)
      nonce: oidc.randomNonce(),                   // ties the ID token to THIS request (replay)
    };
    await pool.query(
      "INSERT INTO oidc_login_attempts (id, state, code_verifier, nonce, expires_at) VALUES ($1, $2, $3, $4, now() + interval '10 minutes')",
      [attempt.id, attempt.state, attempt.codeVerifier, attempt.nonce]);
    reply.setCookie(LOGIN_COOKIE, attempt.id, { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 600 });

    const url = oidc.buildAuthorizationUrl(config, {
      redirect_uri: googleCallbackUrl().href,
      scope: "openid email profile",
      code_challenge: await oidc.calculatePKCECodeChallenge(attempt.codeVerifier),
      code_challenge_method: "S256",
      state: attempt.state,
      nonce: attempt.nonce,
    });
    return reply.redirect(url.href, 302);
  });

  app.get("/v1/auth/google/callback", { config: { access: { kind: "public", why: "finishes sign-in" } } }, async (request, reply) => {
    const attemptId = request.cookies[LOGIN_COOKIE];
    reply.clearCookie(LOGIN_COOKIE, { path: "/", secure: true, httpOnly: true, sameSite: "lax" });
    // Single use: DELETE ... RETURNING means a replayed callback finds nothing.
    const { rows: [attempt] } = await pool.query<{ state: string; code_verifier: string; nonce: string }>(
      "DELETE FROM oidc_login_attempts WHERE id = $1 AND expires_at > now() RETURNING state, code_verifier, nonce",
      [attemptId ?? ""]);
    if (!attempt) throw authErrors.loginAttemptInvalid();

    let claims: oidc.IDToken | undefined;
    try {
      // The library checks state, exchanges the code WITH the verifier, then validates the ID token:
      // signature (Google's JWKS), iss, aud = our client_id, exp, and nonce.
      const tokens = await oidc.authorizationCodeGrant(await googleConfig(), new URL(request.url, env.PUBLIC_BASE_URL), {
        pkceCodeVerifier: attempt.code_verifier,
        expectedState: attempt.state,
        expectedNonce: attempt.nonce,
        idTokenExpected: true,
      });
      claims = tokens.claims();
    } catch (err) {
      request.log.warn({ err }, "google sign-in failed");
      throw authErrors.loginAttemptInvalid();
    }
    if (!claims?.sub || claims.email_verified !== true || typeof claims.email !== "string") throw authErrors.loginAttemptInvalid();

    // Google's tokens are thrown away here. From now on the user holds OUR session, not Google's.
    const user = await findOrCreateGoogleUser(claims.sub, claims.email);
    const session = await startSession(user.id, user.role, ["google"]);
    setRefreshCookie(reply, session.refreshToken);
    return reply.redirect(new URL("/", env.APP_ORIGIN).href, 303); // the SPA then calls /v1/auth/refresh
  });
}
```

`src/oidc/googleUsers.ts`:

```ts
// src/oidc/googleUsers.ts — map a verified Google identity to OUR user, by Google's stable `sub`.
import { authErrors } from "../auth/errors.js";
import type { Role } from "../auth/types.js";
import { pool } from "../db/pool.js";

export async function findOrCreateGoogleUser(subject: string, email: string): Promise<{ id: string; role: Role }> {
  const { rows: [linked] } = await pool.query<{ id: string; role: Role }>(
    `SELECT u.id, u.role FROM user_identities i JOIN users u ON u.id = i.user_id
     WHERE i.provider = 'google' AND i.subject = $1`, [subject]);
  if (linked) return linked;

  // An existing password account with this email is NOT silently linked: that would let anyone who
  // controls that address at Google take over the account. The owner links it after signing in.
  const { rowCount } = await pool.query("SELECT 1 FROM users WHERE email = $1", [email]);
  if (rowCount) throw authErrors.googleAccountConflict();

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: [user] } = await client.query<{ id: string; role: Role }>(
      "INSERT INTO users (email, password_hash) VALUES ($1, NULL) RETURNING id, role", [email]);
    await client.query("INSERT INTO user_identities (provider, subject, user_id) VALUES ('google', $1, $2)", [subject, user!.id]);
    await client.query("COMMIT");
    return user!;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
```

**What to notice**

- The verifier, `state` and `nonce` are stored server-side, keyed by a random ID in a `__Host-` cookie. The cookie ties the callback to the browser that started the sign-in (that is what stops login CSRF).
- `DELETE ... RETURNING` makes each attempt single-use: replaying a callback URL finds nothing.
- openid-client does the security-critical parts: state check, code exchange with the verifier, and ID token validation (signature from the provider's JWKS, `iss`, `aud`, `exp`, `nonce`). Do not hand-roll these.
- We require `email_verified === true` and link by `sub`.

`test/oidc.test.ts`:

```ts
// test/oidc.test.ts — "Login with Google" end to end with openid-client against a fake provider.
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startFakeIdp } from "./helpers/fakeIdentityProvider.js";

const CLIENT_ID = "ledger-web", CLIENT_SECRET = "test-client-secret";
const user = { sub: "google-sub-1029384756", email: "meera@ledger.test", email_verified: true };
let idp: Awaited<ReturnType<typeof startFakeIdp>>, app: FastifyInstance;
let db: typeof import("./helpers/db.js"), pool: (typeof import("../src/db/pool.js"))["pool"];

beforeAll(async () => {
  idp = await startFakeIdp(CLIENT_ID, CLIENT_SECRET, user);
  // env is read once at import, so point it at the fake provider BEFORE loading the app.
  Object.assign(process.env, { GOOGLE_ISSUER: idp.issuer, GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: CLIENT_SECRET });
  const { buildApp } = await import("../src/app.js");
  db = await import("./helpers/db.js");
  pool = (await import("../src/db/pool.js")).pool;
  app = await buildApp();
  await app.ready();
});
beforeEach(async () => { await db.resetDatabase(); });
afterAll(async () => { await app.close(); await idp.close(); await pool.end(); });

const cookieValue = (res: LightMyRequestResponse, name: string) => res.cookies.find((c) => c.name === name)?.value;

// Plays the browser: our /start -> provider /authorize -> back to our /callback with code and state.
async function signInThroughBrowser() {
  const start = await app.inject({ url: "/v1/auth/google/start" });
  const loginCookie = cookieValue(start, "__Host-ledger_oidc")!;
  const atProvider = await fetch(String(start.headers.location), { redirect: "manual", signal: AbortSignal.timeout(2_000) });
  const callbackUrl = new URL(atProvider.headers.get("location")!);
  return { start, loginCookie, callbackUrl };
}

describe("Login with Google (authorization code + PKCE)", () => {
  it("sends PKCE, state and nonce, then signs the user in with OUR session", async () => {
    const { start, loginCookie, callbackUrl } = await signInThroughBrowser();
    const authUrl = new URL(String(start.headers.location));
    console.log("authorize params:", [...authUrl.searchParams.keys()].sort().join(", "));
    expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");

    const done = await app.inject({ url: callbackUrl.pathname + callbackUrl.search, cookies: { "__Host-ledger_oidc": loginCookie } });
    console.log(`callback -> ${done.statusCode} to ${done.headers.location} | refresh cookie set: ${Boolean(cookieValue(done, "__Secure-ledger_rt"))}`);
    expect(done.statusCode).toBe(303);
    const { rows } = await pool.query("SELECT i.subject, u.email, u.password_hash FROM user_identities i JOIN users u ON u.id = i.user_id");
    expect(rows).toEqual([{ subject: user.sub, email: user.email, password_hash: null }]);
  });

  it("rejects the callback in a browser that did not start the sign-in (login CSRF)", async () => {
    const { callbackUrl } = await signInThroughBrowser();
    const res = await app.inject({ url: callbackUrl.pathname + callbackUrl.search }); // no login cookie
    expect(res.statusCode).toBe(400);
  });

  it("a stolen code is useless: no verifier at the provider, wrong state at our callback", async () => {
    const victim = await signInThroughBrowser();
    const code = victim.callbackUrl.searchParams.get("code")!;
    // 1) The attacker posts the code straight to the token endpoint. It has the client secret too, in the worst case.
    const direct = await fetch(`${idp.issuer}/token`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, signal: AbortSignal.timeout(2_000),
      body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: "https://api.ledger.test/v1/auth/google/callback", client_id: CLIENT_ID, client_secret: CLIENT_SECRET }),
    });
    // 2) The attacker starts its OWN sign-in, then pastes the victim's code into its callback.
    const attacker = await signInThroughBrowser();
    const injected = await app.inject({
      url: `/v1/auth/google/callback?code=${code}&state=${victim.callbackUrl.searchParams.get("state")}`,
      cookies: { "__Host-ledger_oidc": attacker.loginCookie },
    });
    console.log(`code without verifier -> ${direct.status} ${JSON.stringify(await direct.json())} | code injected into attacker's session -> ${injected.statusCode} ${injected.json().code}`);
    expect(direct.status).toBe(400);
    expect(injected.statusCode).toBe(400);
  });

  it("does not silently link Google to an existing password account with the same email", async () => {
    await pool.query("INSERT INTO users (email, password_hash) VALUES ($1, 'argon2-hash-here')", [user.email]);
    const { loginCookie, callbackUrl } = await signInThroughBrowser();
    const res = await app.inject({ url: callbackUrl.pathname + callbackUrl.search, cookies: { "__Host-ledger_oidc": loginCookie } });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("ACCOUNT_EXISTS");
  });
});
```

**Real output**

```text
authorize params: client_id, code_challenge, code_challenge_method, nonce, redirect_uri, response_type, scope, state
callback -> 303 to https://app.ledger.test/ | refresh cookie set: true
 ✓ test/oidc.test.ts > Login with Google (authorization code + PKCE) > sends PKCE, state and nonce, then signs the user in with OUR session
 ✓ test/oidc.test.ts > Login with Google (authorization code + PKCE) > rejects the callback in a browser that did not start the sign-in (login CSRF)
code without verifier -> 400 {"error":"invalid_grant","error_description":"PKCE verification failed"} | code injected into attacker's session -> 400 LOGIN_ATTEMPT_INVALID
 ✓ test/oidc.test.ts > Login with Google (authorization code + PKCE) > a stolen code is useless: no verifier at the provider, wrong state at our callback
 ✓ test/oidc.test.ts > Login with Google (authorization code + PKCE) > does not silently link Google to an existing password account with the same email
```

**What to notice**

- The full flow ran through the real openid-client library: discovery, authorization URL, code exchange with the verifier, ID token validation.
- A stolen code failed twice: without the verifier at the provider, and when pasted into the attacker's own session (its `state` and verifier belong to the victim's attempt).

### Step 6: A fresh OTP for transfers above a threshold

`src/stepUp/challenges.ts`:

```ts
// src/stepUp/challenges.ts — OTP challenges bound to ONE exact transfer (amount, payee, idempotency key).
import { createHash, createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { env } from "../config/env.js";
import { pool } from "../db/pool.js";
import { hashRequest } from "../lib/requestHash.js";

const OTP_TTL_SECONDS = 300;
const MAX_ATTEMPTS = 5;
export const STEP_UP_MAX_AGE_SECONDS = OTP_TTL_SECONDS;

// A 6-digit code has only 10^6 values: a plain hash is cracked instantly if the table leaks. The pepper
// (a secret outside the database) makes the stored MAC useless on its own.
const mac = (code: string) => createHmac("sha256", env.OTP_PEPPER).update(code).digest();

// The binding is what the user actually approved: this user, this idempotency key, this exact body.
// It reuses P1-03's request hash, so "the transfer we run" and "the transfer they approved" cannot differ.
export function transferBinding(userId: string, idempotencyKey: string, transferBody: unknown): Buffer {
  const requestHash = hashRequest("POST", "/v1/transfers", transferBody);
  return createHash("sha256").update(`${userId}\n${idempotencyKey}\n${requestHash}`).digest();
}

export async function createChallenge(userId: string, binding: Buffer): Promise<{ id: string; code: string; expiresAt: Date }> {
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0"); // crypto-grade randomness, not Math.random
  const { rows: [row] } = await pool.query<{ id: string; expires_at: Date }>(
    `INSERT INTO otp_challenges (user_id, purpose, binding_hash, code_mac, attempts_left, expires_at)
     VALUES ($1, 'transfer', $2, $3, $4, now() + make_interval(secs => $5)) RETURNING id, expires_at`,
    [userId, binding, mac(code), MAX_ATTEMPTS, OTP_TTL_SECONDS]);
  if (!row) throw new Error("INSERT ... RETURNING returned no row");
  return { id: row.id, code, expiresAt: row.expires_at };
}

export type VerifyOutcome = "verified" | "wrong_code" | "closed" | "not_found";

export async function verifyChallenge(id: string, userId: string, code: string): Promise<VerifyOutcome> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return "not_found";
  // Spend an attempt FIRST, atomically: parallel guesses cannot exceed MAX_ATTEMPTS.
  const { rows: [row] } = await pool.query<{ code_mac: Buffer }>(
    `UPDATE otp_challenges SET attempts_left = attempts_left - 1
     WHERE id = $1 AND user_id = $2 AND verified_at IS NULL AND attempts_left > 0 AND expires_at > now()
     RETURNING code_mac`, [id, userId]);
  if (!row) {
    // Someone else's challenge is "not found", exactly like someone else's wallet.
    const { rowCount } = await pool.query("SELECT 1 FROM otp_challenges WHERE id = $1 AND user_id = $2", [id, userId]);
    return rowCount ? "closed" : "not_found";
  }
  if (!timingSafeEqual(mac(code), row.code_mac)) return "wrong_code";
  await pool.query("UPDATE otp_challenges SET verified_at = now() WHERE id = $1", [id]);
  return "verified";
}

// Not single-use on purpose: the binding includes the idempotency key, and P1-03 guarantees one key
// produces at most one transfer. So a retry of the SAME approved transfer still passes.
export async function hasVerifiedChallenge(userId: string, binding: Buffer): Promise<boolean> {
  const { rowCount } = await pool.query(
    `SELECT 1 FROM otp_challenges WHERE user_id = $1 AND binding_hash = $2
     AND verified_at IS NOT NULL AND expires_at > now() LIMIT 1`, [userId, binding]);
  return rowCount === 1;
}
```

`src/stepUp/requireStepUp.ts`:

```ts
// src/stepUp/requireStepUp.ts — transfers at or above the threshold need a fresh OTP for THIS transfer.
import type { FastifyReply, FastifyRequest } from "fastify";
import { requirePrincipal } from "../auth/authenticate.js";
import { authErrors } from "../auth/errors.js";
import { env } from "../config/env.js";
import { parseKey } from "../plugins/idempotency.js";
import { releaseKey } from "../repositories/idempotencyRepository.js";
import { hasVerifiedChallenge, STEP_UP_MAX_AGE_SECONDS, transferBinding } from "./challenges.js";

// Runs AFTER requireIdempotency: a replay of an already-completed transfer is answered before this,
// so a stored response never needs a second OTP.
export async function requireStepUpForLargeTransfers(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (reply.sent) return;
  const body = request.body as { amountMinor: number };
  if (body.amountMinor < env.STEP_UP_THRESHOLD_MINOR) return;

  const principal = requirePrincipal(request);
  const key = parseKey(request.headers["idempotency-key"]);
  if (await hasVerifiedChallenge(principal.userId, transferBinding(principal.userId, key, request.body))) return;

  // Nothing ran, so free the idempotency key: the client retries with the same key after the OTP.
  if (request.idempotencyClaim) await releaseKey(request.idempotencyClaim);
  throw authErrors.stepUpRequired(STEP_UP_MAX_AGE_SECONDS);
}
```

`src/routes/stepUp.ts`:

```ts
// src/routes/stepUp.ts — start an OTP challenge for one transfer, then verify the code.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requirePrincipal } from "../auth/authenticate.js";
import { authErrors } from "../auth/errors.js";
import * as limits from "../auth/rateLimit.js";
import { authorize, fromBody } from "../authz/authorize.js";
import { pool } from "../db/pool.js";
import { ApiError } from "../lib/problem.js";
import { validate } from "../lib/validate.js";
import { createChallenge, transferBinding, verifyChallenge } from "../stepUp/challenges.js";
import { createTransferBody } from "./transfers.js";

const startBody = createTransferBody.extend({ idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{16,255}$/) });
type StartBody = z.infer<typeof startBody>;
const verifyBody = z.strictObject({ code: z.string().regex(/^\d{6}$/) });
const rupees = (paise: number) => (paise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2 });

export async function stepUpRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: StartBody }>("/v1/auth/step-up", {
    config: { access: { kind: "resource", action: "transfer:create", sensitive: true } },
    // Only send an OTP for a transfer this user is actually allowed to make.
    preHandler: [validate("body", startBody), authorize("transfer:create", fromBody("wallet", "sourceWalletId"))],
  }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const sent = await limits.hit(`otp:user:${principal.userId}`, 900);
    if (sent.hits > 5) throw authErrors.tooManyAttempts(sent.retryAfterSeconds);

    const { idempotencyKey, ...transfer } = request.body;
    const challenge = await createChallenge(principal.userId, transferBinding(principal.userId, idempotencyKey, transfer));
    const { rows: [payee] } = await pool.query<{ display_name: string }>(
      "SELECT a.display_name FROM wallets w JOIN accounts a ON a.id = w.account_id WHERE w.id = $1", [transfer.destinationWalletId]);
    const { rows: [user] } = await pool.query<{ phone_e164: string | null }>("SELECT phone_e164 FROM users WHERE id = $1", [principal.userId]);
    // Say WHAT is being approved, so a tricked user sees the real amount and payee before sharing the code.
    await app.otpSender.send({
      userId: principal.userId, phone: user?.phone_e164 ?? null,
      text: `${challenge.code} is your OTP to send Rs ${rupees(transfer.amountMinor)} to ${payee?.display_name ?? "a wallet"}. Valid 5 min. Never share it.`,
    });
    return reply.code(201).send({ challengeId: challenge.id, expiresAt: challenge.expiresAt.toISOString(), channel: "sms" });
  });

  app.post<{ Params: { challengeId: string }; Body: z.infer<typeof verifyBody> }>("/v1/auth/step-up/:challengeId/verify", {
    config: { access: { kind: "self", sensitive: true } },
    preHandler: [validate("body", verifyBody)],
  }, async (request, reply) => {
    const outcome = await verifyChallenge(request.params.challengeId, requirePrincipal(request).userId, request.body.code);
    if (outcome === "not_found") throw new ApiError(404, "CHALLENGE_NOT_FOUND", "Challenge not found");
    if (outcome === "closed") throw authErrors.challengeClosed();
    if (outcome === "wrong_code") throw authErrors.wrongCode();
    return reply.code(204).send();
  });
}
```

`src/notify/otpSender.ts`:

```ts
// src/notify/otpSender.ts — where step-up codes go. SMS in production; tests capture them.
import type { FastifyBaseLogger } from "fastify";

export interface OtpMessage { userId: string; phone: string | null; text: string }
export interface OtpSender { send(message: OtpMessage): Promise<void> }

declare module "fastify" {
  interface FastifyInstance { otpSender: OtpSender }
}

// Development only: logs that a code was sent, never the code itself.
export function logOtpSender(log: FastifyBaseLogger): OtpSender {
  return { async send(m) { log.info({ userId: m.userId, phoneSet: m.phone !== null }, "otp sent (dev sender)"); } };
}
```

**What to notice**

- The binding reuses P1-03's request hash. "The transfer the user approved" and "the transfer we run" are compared byte for byte, not field by field.
- The challenge is not single-use, on purpose: the idempotency key inside the binding already guarantees at most one transfer, and this way a network retry of the approved transfer still works.
- Starting a challenge runs the same `authorize("transfer:create")` guard, and is rate-limited per user, so OTP SMS cannot be used to spam or to probe wallets.

`test/stepUp.test.ts`:

```ts
// test/stepUp.test.ts — transfers of Rs 10,000 or more need a fresh OTP bound to that exact transfer.
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { pool } from "../src/db/pool.js";
import type { OtpMessage } from "../src/notify/otpSender.js";
import { bearer, login } from "./helpers/auth.js";
import { resetDatabase, seedWorld, type World } from "./helpers/db.js";

const outbox: OtpMessage[] = [];
let app: FastifyInstance, w: World, riya: string;
beforeAll(async () => { app = await buildApp({ otpSender: { send: async (m) => { outbox.push(m); } } }); await app.ready(); });
beforeEach(async () => { await resetDatabase(); w = await seedWorld(); riya = (await login(app, w.users.riya.email)).accessToken; });
afterAll(async () => { await app.close(); await pool.end(); });

const body = (amountMinor: number) => ({ sourceWalletId: w.wallets.riya, destinationWalletId: w.wallets.lakshmi, amountMinor, currency: "INR" });
const transfer = (token: string, key: string, amountMinor: number) =>
  app.inject({ method: "POST", url: "/v1/transfers", headers: { ...bearer(token), "idempotency-key": key }, payload: body(amountMinor) });
const startStepUp = (token: string, key: string, amountMinor: number) =>
  app.inject({ method: "POST", url: "/v1/auth/step-up", headers: bearer(token), payload: { ...body(amountMinor), idempotencyKey: key } });
const verify = (token: string, id: string, code: string) =>
  app.inject({ method: "POST", url: `/v1/auth/step-up/${id}/verify`, headers: bearer(token), payload: { code } });
const lastCode = () => outbox.at(-1)!.text.slice(0, 6);

describe("step-up OTP for large transfers", () => {
  it("small transfers go straight through", async () => {
    expect((await transfer(riya, randomUUID(), 50_000)).statusCode).toBe(201); // Rs 500
  });

  it("challenge -> OTP -> verify -> the same request succeeds; a replay needs no new OTP", async () => {
    const key = randomUUID();
    const first = await transfer(riya, key, 1_500_000); // Rs 15,000
    console.log(`1. transfer -> ${first.statusCode} ${first.json().code} | ${first.headers["www-authenticate"]}`);
    expect(first.statusCode).toBe(401);
    const { rowCount } = await pool.query("SELECT 1 FROM idempotency_keys");
    expect(rowCount).toBe(0); // the key was released, so the retry can use it

    const started = await startStepUp(riya, key, 1_500_000);
    console.log(`2. step-up -> ${started.statusCode} | sms: "${outbox.at(-1)!.text.replace(/^\d{6}/, "######")}"`);
    const wrong = await verify(riya, started.json().challengeId, lastCode() === "000000" ? "111111" : "000000");
    const right = await verify(riya, started.json().challengeId, lastCode());
    const retry = await transfer(riya, key, 1_500_000);
    const replay = await transfer(riya, key, 1_500_000);
    console.log(`3. wrong code -> ${wrong.statusCode} | right code -> ${right.statusCode} | 4. same transfer -> ${retry.statusCode} | replay -> ${replay.statusCode} replayed=${replay.headers["idempotent-replayed"]}`);
    expect([wrong.statusCode, right.statusCode, retry.statusCode, replay.statusCode]).toEqual([400, 204, 201, 201]);
  });

  it("an OTP approved for Rs 15,000 does not authorise Rs 50,000", async () => {
    const key = randomUUID();
    const started = await startStepUp(riya, key, 1_500_000);
    await verify(riya, started.json().challengeId, lastCode());
    const bigger = await transfer(riya, randomUUID(), 5_000_000);
    expect(bigger.statusCode).toBe(401);
  });

  it("locks the challenge after 5 wrong codes, even if the 6th is right", async () => {
    const started = await startStepUp(riya, randomUUID(), 1_500_000);
    const real = lastCode();
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await verify(riya, started.json().challengeId, real === "999999" ? "000000" : "999999")).statusCode);
    const sixth = await verify(riya, started.json().challengeId, real);
    console.log(`5 wrong -> ${statuses.join(",")} | 6th with the real code -> ${sixth.statusCode} ${sixth.json().code}`);
    expect(sixth.json().code).toBe("CHALLENGE_CLOSED");
  });

  it("a viewer cannot even ask for an OTP, and nobody can verify someone else's challenge", async () => {
    const priya = (await login(app, w.users.priya.email)).accessToken;
    const amit = (await login(app, w.users.amit.email)).accessToken;
    expect((await startStepUp(priya, randomUUID(), 1_500_000)).statusCode).toBe(403);
    const started = await startStepUp(riya, randomUUID(), 1_500_000);
    expect((await verify(amit, started.json().challengeId, lastCode())).statusCode).toBe(404);
  });
});
```

**Real output**

```text
 ✓ test/stepUp.test.ts > step-up OTP for large transfers > small transfers go straight through
1. transfer -> 401 STEP_UP_REQUIRED | Bearer error="insufficient_user_authentication", max_age="300"
2. step-up -> 201 | sms: "###### is your OTP to send Rs 15,000.00 to Lakshmi Stores. Valid 5 min. Never share it."
3. wrong code -> 400 | right code -> 204 | 4. same transfer -> 201 | replay -> 201 replayed=true
 ✓ test/stepUp.test.ts > step-up OTP for large transfers > challenge -> OTP -> verify -> the same request succeeds; a replay needs no new OTP
 ✓ test/stepUp.test.ts > step-up OTP for large transfers > an OTP approved for Rs 15,000 does not authorise Rs 50,000
5 wrong -> 400,400,400,400,400 | 6th with the real code -> 400 CHALLENGE_CLOSED
 ✓ test/stepUp.test.ts > step-up OTP for large transfers > locks the challenge after 5 wrong codes, even if the 6th is right
 ✓ test/stepUp.test.ts > step-up OTP for large transfers > a viewer cannot even ask for an OTP, and nobody can verify someone else's challenge
```

**Run everything**

```bash
LOG_LEVEL=silent npx vitest run
```

**Real output** (both runs)

```text
 Test Files  5 passed (5)
      Tests  90 passed (90)
```

---

## 🔨 Break it and measure it

Do these on your machine. Each one turns a rule from this card into a failure you have seen.

1. **Forget the guard.** Remove `authorize("wallet:read", ...)` from `GET /v1/wallets/:walletId`. *Expected:* the app refuses to start (`declares wallet:read but has no authorize`). Now also change its rule to `{ kind: "self" }` to "get around" the check. *Expected:* it starts, and the matrix fails with Amit getting `200` for Riya's wallet. That is BOLA, caught by the test, not by the type checker.
2. **Drop the audience check.** Remove `audience` from `verifyAccessToken`, then sign a token with `aud: "notifications"` using the same key. *Expected:* it is accepted. Put it back.
3. **Remove `FOR UPDATE OF rt`** in `rotateRefreshToken` and run the two-tab test 20 times. *Expected:* sometimes both refreshes succeed and two live children exist: rotation is broken under concurrency.
4. **Remove the dummy hash** in `verifyPassword`. *Expected:* "unknown email" drops to about 1 ms while "wrong password" stays near 27 ms. That difference is a user-enumeration API.
5. **Change the refresh cookie to `SameSite=None`** and remove `requireTrustedOrigin`. *Expected:* a form on another site can now POST to `/v1/auth/logout` with Riya's cookie and sign her out: a working CSRF. CORS still stops that site from *reading* a refresh response, but anything that changes state is exposed.
6. **Make support an owner-free refunder.** Add `"support"` to `refund:create.anyRoles`. *Expected:* the two refund rows of the matrix fail. Good: the table is the review surface.
7. **Weaken the OTP binding.** Bind the challenge to the user only (not the key and body). *Expected:* "an OTP approved for Rs 15,000 does not authorise Rs 50,000" fails.
8. **Measure your hash cost.** Run `minimal/password-hashing.ts`, then raise `memoryCost` until one hash takes about 50-100 ms on your production hardware.

**Measurements**

| Measure (from the card) | This guide's run (**Real output**) | Your machine |
|---|---|---|
| Time per password hash, argon2id m = 19 MiB, t = 2, p = 1 | 26.2 ms and 27.2 ms (two runs) | fill after running the lab on your machine |
| Time per login, wrong password vs unknown email | 37.0 ms vs 36.9 ms | fill after running the lab on your machine |
| Access-control tests | **70**, all passing (66 matrix + 4) | fill after running the lab on your machine |
| All tests in the lab | **90**, all passing, two runs | fill after running the lab on your machine |
| Refresh-token reuse revokes the family | passes: replay `401`, newest token `401`, 1 security event | fill after running the lab on your machine |
| Old access token after revocation | read `200`, transfer `401 SESSION_REVOKED` | fill after running the lab on your machine |

---

## 🚫 Common mistakes and wrong mental models

### Wrong mental model: "a JWT is encrypted"

A JWT is **signed**, not encrypted. The header and payload are base64url, which anyone can decode: the minimal script printed the whole payload in two lines. The signature only proves nobody changed it. So never put secrets or personal data (PAN, phone, balance, Aadhaar details) in a JWT, and do not treat "it's inside the token" as private.

**Correct model:** a JWT is a signed postcard. Everyone who handles it can read it; only the issuer could have written it.

### Wrong mental model: "logged in means allowed"

Authentication tells you **who**; it says nothing about **which objects**. The BOLA demo leaked a ₹9.8 lakh balance to a properly logged-in user who changed one ID.

**Correct model:** every request that names an object needs an object-level check, decided by the server, every time.

### Mistake 1: accepting `alg: none`, or skipping `aud`, `iss` and `exp`

```ts
// Beginner way: decode and trust, or verify with whatever algorithm the token asks for.
const payload = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString()); // no signature check at all
// or: jwt.verify(token, key) with no algorithms list, no audience, no issuer
```

```ts
// Product way (src/auth/accessTokens.ts): everything pinned.
await jwtVerify(token, localJwks, {
  algorithms: ["RS256"], typ: "at+jwt", issuer: env.AUTH_ISSUER, audience: env.AUTH_AUDIENCE, clockTolerance: 30,
});
```

**What breaks in the beginner way:** anyone can mint `{"role":"admin"}`; a token for another service works here; an expired token works forever.

### Mistake 2: checking roles but not ownership

```ts
// Beginner way: role check only.
if (principal.role !== "user") throw forbidden();
const wallet = await db.query("SELECT * FROM wallets WHERE id = $1", [request.params.walletId]);
```

```ts
// Product way: role AND relationship, through one guard on the route.
preHandler: [validate("params", params), authorize("wallet:read", fromParam("wallet", "walletId"))],
```

**What breaks in the beginner way:** every user is a "user", so every user can read every wallet by changing the ID.

### Mistake 3: tokens in `localStorage`

```ts
// Beginner way
localStorage.setItem("refreshToken", body.refreshToken); // any injected script can read and send this anywhere
```

```ts
// Product way: refresh token in an HttpOnly cookie set by the server; access token only in memory.
reply.setCookie(REFRESH_COOKIE, token, { httpOnly: true, secure: true, sameSite: "strict", path: "/v1/auth" });
let accessToken: string | null = null; // web/tokenManager.ts
```

**What breaks in the beginner way:** one XSS bug (a vulnerable npm package, an unescaped merchant name) copies a 30-day credential off the device.

### Mistake 4: fast hashes, or encryption, for passwords

```ts
// Beginner way
const stored = createHash("sha256").update(password).digest("hex"); // ~285,000 guesses per second per core here
// or: encrypt(password, KEY) — whoever gets KEY gets every password
```

```ts
// Product way (src/auth/passwords.ts)
argon2.hash(password, { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 });
```

**What breaks in the beginner way:** a leaked table is cracked in minutes for common passwords; with encryption, in one step.

### Mistake 5: different answers for "no such user" and "wrong password"

```ts
// Beginner way
if (!user) throw new ApiError(404, "USER_NOT_FOUND", "No account with this email");
if (!(await argon2.verify(user.password_hash, password))) throw new ApiError(401, "WRONG_PASSWORD", "Wrong password");
```

```ts
// Product way: one error, and the same work in both cases (dummy hash for unknown emails).
const ok = await verifyPassword(user?.password_hash ?? null, request.body.password);
if (!user || !ok) throw authErrors.invalidCredentials();
```

**What breaks in the beginner way:** the login page becomes a free "is this email a customer?" service for phishers, by message and by timing.

### Mistake 6: refresh tokens that never rotate, stored in plain text

```sql
-- Beginner way
CREATE TABLE refresh_tokens (token text PRIMARY KEY, user_id uuid, expires_at timestamptz); -- valid for 1 year, reusable
```

```sql
-- Product way (003_auth.sql): hashed, one-time, in a revocable family with a hard cap.
CREATE TABLE refresh_tokens (family_id uuid, token_hash bytea UNIQUE, expires_at timestamptz, used_at timestamptz, ...);
```

**What breaks in the beginner way:** a database read leaks live credentials, and a stolen token works for a year with no way to notice.

### Mistake 7: comparing secrets with `===` (again)

Same rule as P1-04's webhook signatures: OTP codes, API key hashes and HMACs are compared with `crypto.timingSafeEqual`, after a length check.

---

## ✅ Production checklist

**Authentication**
- [ ] Passwords: argon2id at or above OWASP's minimum, tuned to about 50-100 ms on production hardware; rehash on login after raising parameters.
- [ ] Login and signup: per-IP and per-account limits shared across instances; same error and similar time for unknown email and wrong password; `trustProxy` set correctly.
- [ ] No account enumeration at signup, login, or password reset ("if this email exists, we sent a link").
- [ ] Breached-password check at signup and password change.
- [ ] MFA available, and required for staff accounts.

**Tokens and sessions**
- [ ] Access tokens: 5-15 minutes, RS256 or EdDSA, `typ` set and required, `iss`, `aud`, `exp` checked, algorithm list pinned.
- [ ] Signing keys in a secrets manager or KMS, with `kid`, published via JWKS, rotated on a schedule; a written emergency rotation runbook.
- [ ] Refresh tokens: random, stored hashed, rotated on every use, reuse revokes the family, idle and absolute expiry, "log out everywhere".
- [ ] Sensitive routes check the session live (revocation and current role).
- [ ] Password change, MFA change and suspicious events revoke other sessions.
- [ ] Web: refresh token in an HttpOnly, Secure, SameSite cookie with a prefix; access token in memory; or a BFF. Never `localStorage`.
- [ ] Mobile: refresh token in Keychain/Keystore.
- [ ] Cookie-authenticated endpoints check `Origin` (CSRF); CORS allows only your app origins, with credentials.
- [ ] Logs redact `Authorization` and `Cookie` headers.

**Authorisation**
- [ ] Deny by default: a route without an access rule cannot ship.
- [ ] Every object ID, from path, query **or body**, goes through one central guard with role + relationship.
- [ ] 404 for objects the caller cannot read; 403 only when they can.
- [ ] An access-control matrix test for every route and every kind of caller, blocking deploys on failure.
- [ ] Staff access is allowed only where needed and written to an append-only audit log; separation of duties for money movement.

**OAuth / OIDC**
- [ ] Authorization code flow with PKCE (S256), `state` and `nonce`; exact redirect URIs; a maintained library.
- [ ] Link identities by provider `sub`; require `email_verified`; never auto-link to existing accounts.
- [ ] Provider tokens are not used as your own sessions.

**Step-up and service auth**
- [ ] Step-up for large transfers, payee changes and contact-detail changes; OTP bound to the transaction, 5 minutes, 5 attempts, HMAC with a pepper.
- [ ] RFC 9470-style `401 insufficient_user_authentication` so clients know what to do.
- [ ] Services: mTLS inside the network (often via a mesh), plus short-lived tokens with a strict `aud`; partner API keys hashed, scoped, rotatable and prefixed for secret scanning.

---

## 🤖 Engineering with AI

**Where AI tools genuinely help with this concept**

- Generating the access-control matrix: every route × every role × own/other/missing object, with expected codes.
- Reviewing a diff for routes that take an object ID without an `authorize()` guard, including IDs in request bodies.
- Explaining a library's verify options and which checks are on by default (for example jose's `exp` handling).
- Drafting threat models for a flow ("what can go wrong in our Google login?") as a checklist you then verify.

**Where they commonly go wrong for this concept**

- **Role checks without ownership checks** (BOLA), and handlers that load objects by ID with no relationship filter.
- **`jwt.decode` instead of `verify`**, no `algorithms` list, no `aud`/`iss`, or accepting tokens from any issuer.
- **Long-lived JWTs in `localStorage`**, often 7-30 days, with "logout" that only deletes the client copy.
- **HS256 with a short, hard-coded secret** shared by every service.
- **Refresh tokens that are reusable and stored in plain text.**
- **bcrypt or SHA-256 with outdated parameters**, or "encrypting" passwords.
- **Different errors for unknown user vs wrong password.**
- **Implicit flow or no PKCE** in OAuth examples copied from old tutorials; linking Google accounts by email.
- **OTP with `Math.random()`**, no attempt limit, not bound to the transaction.
- **Outdated library APIs**: openid-client v5 (`Issuer.discover`, `client.callback`) in a v6 project, older jose APIs.

**Review checklist for AI-generated code touching this concept**

- [ ] Does every route that reads an object ID (path, query, body) pass a role-and-relationship guard before the handler?
- [ ] Does the app fail closed when a route has no access rule?
- [ ] JWT verify pins `algorithms`, `issuer`, `audience`, and `typ`; lifetimes are minutes, not days?
- [ ] Refresh tokens: hashed, rotated, reuse detection, family revocation, absolute expiry?
- [ ] Cookies: HttpOnly, Secure, SameSite, path/prefix, and an Origin check on cookie-authenticated POSTs?
- [ ] Passwords: argon2id with real parameters; same error and similar time for unknown users; rate limits shared across instances?
- [ ] OAuth: code flow, PKCE S256, state, nonce, exact redirect URI, maintained library, link by `sub`?
- [ ] OTPs: `crypto.randomInt`, HMAC with pepper, attempt limit, expiry, bound to the action, constant-time compare?
- [ ] Secrets only from the environment or a secrets manager; nothing sensitive logged?

**Useful prompts**

1. *"List every route in this Fastify app that takes an object identifier from the path, query string or body. For each, show the line where the server checks that the caller is related to that object, or say MISSING. Do not count role checks as ownership checks."*
   **Verify by:** adding the access-control matrix rows for each route and running them; a MISSING the model overlooked shows up as a 200 for the wrong user.
2. *"Write a Vitest matrix test: for each of these routes and each of these callers (anonymous, owner, viewer, other user, support, admin), assert the exact status code. Use it.each and build the requests from a table."*
   **Verify by:** deliberately removing one guard and confirming several rows fail.
3. *"Review this refresh-token implementation for: hashing at rest, single use, reuse detection that revokes the whole family, a race between two concurrent refreshes, idle and absolute expiry. Point to the lines."*
   **Verify by:** running a reuse test and a two-parallel-refresh test against the real database.

---

## 🎤 Interview script

**How this shows up.** After almost every design answer comes "how would you secure this API?". Fintech loops dig into session revocation ("the user's phone is stolen, what happens?"), step-up auth for large payments, and staff access to customer data. Strong answers separate **authentication** from **authorisation**, name **object-level checks** without being asked, and know why JWT revocation is hard.

**2-minute spoken answer outline: "How would you secure the wallet and transfer API?"**

1. **Authentication (25 s):** "Users sign in with a password hashed with argon2id, or with Google via OIDC and PKCE. Login is rate-limited per IP and per account, and gives the same answer for unknown emails. A login creates a token family: a 10-minute RS256 access token and a rotating refresh token in an HttpOnly cookie, stored hashed. Reusing an old refresh token revokes the family."
2. **Authorisation (35 s):** "Every route declares an access rule, and the service refuses to start without one. One guard checks role plus relationship for every object ID, from the path or the body: you can only spend from a wallet whose account you own. If you cannot see an object, the answer is 404, not 403. Staff can view but not move money, and every staff access is audited. A matrix test covers every route against every kind of caller."
3. **Revocation (20 s):** "Access tokens are stateless, so reads trust them for up to 10 minutes. Money routes also check that the session is alive and re-read the role, so logout-everywhere and demotions take effect immediately where it matters."
4. **Step-up (20 s):** "Transfers above a threshold need an OTP bound to the exact amount, payee and idempotency key, valid 5 minutes, 5 attempts, stored as an HMAC. That is the kind of transaction-specific factor RBI's 2025 directions ask for, though compliance should confirm the exact rules."
5. **Services (15 s):** "Inside the network, mTLS plus short-lived service tokens with a strict audience; partners get hashed, scoped API keys."

**Mini design: phone stolen while logged in**

```text
User reports theft (or support does it after KYC checks)
  → POST /v1/auth/logout-all (or admin tool) → UPDATE token_families SET revoked_at = now() WHERE user_id = $1
Thief's app holds: access token (≤ 10 min) + refresh token (now revoked)
  reads:   still OK until the access token expires (stateless)        ← accepted risk, ≤ 10.5 min
  money:   requireLiveSession → 401 SESSION_REVOKED immediately       ← the part that matters
  refresh: rejected; cookie cleared
Large transfer would also have needed an OTP to the user's SIM        ← and the SIM can be blocked
Audit: security_events (logout_all, who, when); alert on refresh_token_reuse
```

**LLD sketch: the authorisation interface**

```ts
interface Authorizer {
  // One call per object access. Never throws for "allowed"; maps deny to 403 or 404.
  check(principal: Principal, action: Action, resource: { type: ResourceType; id: string }): Promise<"allow" | "allow_privileged" | "deny_hidden" | "deny_visible">;
}
// Route registry rejects any route without an access rule; tests enumerate routes × principals.
```

**Five likely follow-ups, with strong answers**

1. **"Why are JWTs hard to revoke?"** — "Because verifying one needs only the public key, no lookup, so the server has nowhere to mark it dead. Options: keep them short (10 minutes), revoke the refresh token so no new ones are issued, and for sensitive routes add a live check of the session or a denylist of revoked session IDs. That trades a little statelessness for instant revocation where money moves."
2. **"Session cookies or bearer tokens for our web app?"** — "For a browser, a cookie the server controls is safer against XSS, and with SameSite plus Origin checks CSRF is handled. The strongest pattern is a BFF: the Next.js server holds tokens and the browser holds only an HttpOnly session cookie. Bearer tokens fit mobile apps and service calls. If the SPA must call the API directly, keep the access token in memory and the refresh token in an HttpOnly cookie, never localStorage."
3. **"Where exactly does the BOLA check go?"** — "In one central guard on the server, after the ID is validated and before the handler touches data, on every route that takes an object ID, including body fields like sourceWalletId. Not in the UI and not only in the gateway. I make it impossible to skip with deny-by-default route registration, and I prove it with a matrix test per route. Defence in depth: scope queries by the caller too."
4. **"How does PKCE stop a stolen code?"** — "The client sends only a SHA-256 challenge in the authorization request. To exchange the code it must present the original verifier, which never went through the browser. A thief with the code but not the verifier gets invalid_grant. It also blocks code injection into another session. RFC 9700 makes it mandatory for public clients and recommends it for confidential ones."
5. **"A support agent needs to see a customer's wallet. How do you allow that safely?"** — "A support role with read-only actions, no money movement, and every privileged read written to an append-only audit log with who, what and when. Ideally tied to a ticket and time-limited (just-in-time access), and reviewed. Refunds need a separate admin role and go through a reviewed workflow."

**Red flags interviewers notice**

- "We use JWT, so it's secure."
- Role checks only; no mention of object-level checks.
- 30-day tokens in `localStorage`; "logout" that only deletes the client copy.
- Encrypting passwords, or SHA-256 with a salt.
- Implicit flow, or no PKCE; linking OAuth accounts by email.
- No answer for "the phone was stolen" or "an admin was fired".
- OTP that approves "anything for 5 minutes" instead of one transaction.

---

## ❓ Questions from the card, answered

Try to answer each one aloud first, then open it.

<details>
<summary><b>1. Why are JWTs hard to revoke, and how do short access tokens plus refresh rotation help?</b></summary>

A JWT is verified with only the issuer's public key and the clock: no database. That is its benefit (fast, works in every service) and its problem: the server has no record to delete, so a stolen or "logged out" token keeps working until `exp`.

Short access tokens shrink that window (10 minutes in the lab, 10.5 with clock tolerance). The long-lived credential becomes the **refresh token**, which is stored server-side (as a hash, in a token family), so it **can** be revoked at once. Rotation makes each refresh token single-use; if a used one comes back, someone copied it, and the whole family is revoked, which also kills the thief's copy. Logout and "log out everywhere" revoke families, so no new access tokens are issued.

For the remaining window, sensitive routes check the session live. In this guide's test, after reuse detection the old access token could still read a wallet (`200`) but could not create a transfer (`401 SESSION_REVOKED`).
</details>

<details>
<summary><b>2. What is BOLA/IDOR, and where exactly does the check belong in your code?</b></summary>

BOLA (broken object level authorization, OWASP API1:2023), also called IDOR, is when an authenticated caller reaches an object that is not theirs by changing an identifier: `GET /v1/wallets/{someone-else's-id}`, or `sourceWalletId` in a transfer body. Authentication passed; the object check was missing.

The check belongs **on the server, in one central guard that runs after the ID is parsed and before the handler reads or changes data, on every route that takes an object ID** (path, query or body). It combines the role (may this kind of user do this action?) with the relationship (is this user a member of the account that owns this wallet?). It must not live only in the UI or the API gateway. Make it impossible to forget (the lab refuses to start if a route lacks an access rule or its guard), answer 404 when the caller may not know the object exists, and prove it with a route × caller matrix test (70 tests in this lab).
</details>

<details>
<summary><b>3. Session cookies or bearer tokens for a web app: what are the trade-offs?</b></summary>

**Session cookie (HttpOnly, Secure, SameSite):** JavaScript cannot read it, so XSS cannot steal it; revocation is instant; small. But the browser sends it automatically, so you need CSRF defences (SameSite, Origin checks, CSRF tokens for forms), and every request needs a session lookup.

**Bearer token in a header:** not sent automatically, so no CSRF; verifiable without a lookup, across many services; natural for mobile. But it must be stored somewhere JavaScript can reach, so XSS can steal it from `localStorage`, and it is hard to revoke before expiry.

For a web app: prefer a **BFF** (RFC 10017 lists it first, as the most secure pattern): the server keeps tokens, the browser holds only an HttpOnly cookie. If the SPA talks to the API directly, use this lab's split: a short access token in memory and the refresh token in an HttpOnly, SameSite=Strict cookie on a narrow path, with an Origin check on the refresh endpoint.
</details>

<details>
<summary><b>4. How does PKCE stop a stolen authorization code from being used?</b></summary>

Before redirecting, the client makes a random `code_verifier` and keeps it. It sends only `code_challenge = BASE64URL(SHA-256(code_verifier))` with `code_challenge_method=S256`. The authorization server stores the challenge with the code it issues.

The code comes back through the browser, where it can leak (a malicious app on the same custom URL scheme, logs, extensions). To exchange it, the token request must include the original `code_verifier`; the server hashes it and compares with the stored challenge. An attacker who has the code but not the verifier gets `invalid_grant`, and cannot work the verifier out from the challenge. In this guide's test: `code without verifier -> 400 invalid_grant (PKCE verification failed)`. Pasting the stolen code into the attacker's own session also fails, because that session's state and verifier do not match the code.
</details>

---

## 🏋️ Exercises

**Beginner (no code)**

1. **Classify each status.** For each case, say 401, 403 or 404, and why: (a) no Authorization header; (b) Priya (viewer) tries to update Riya Traders' wallet nickname; (c) Riya asks for Amit's statement export; (d) Riya's family was revoked and she tries a transfer; (e) support requests a refund; (f) Riya sends ₹20,000 without an OTP.
   *Expected outcome:* 401; 403; 404; 401 (SESSION_REVOKED); 403; 401 (STEP_UP_REQUIRED).
   *Verify by:* the access-control matrix and the step-up tests.
2. **Draw the theft timeline.** A thief copies Riya's refresh token at 10:00. Riya's app refreshes at 10:05; the thief tries at 10:20. Draw what each side holds and what each request returns. Then draw it with the thief going first.
   *Expected outcome:* whoever goes second triggers reuse; the family dies either way, and only Riya can sign back in.
   *Verify by:* the reuse test.

**Intermediate (extend the lab)**

1. **Password reset.** Add `POST /v1/auth/password-reset` (always `202`, rate-limited) that emails a single-use, 30-minute token stored as a hash; completing the reset revokes **all** families.
   *Expected outcome:* old sessions die after a reset; the endpoint never reveals whether an email exists.
   *Verify by:* tests for both, plus a timing comparison like the login test.
2. **Matrix rows for new routes.** Add `GET /v1/wallets/:walletId/members` (owners only) to the matrix before writing the route. Watch the app refuse to start until it has a rule and guard.
   *Expected outcome:* 6 new rows, all green after the route exists.
   *Verify by:* `npx vitest run test/accessControl.test.ts`.
3. **Key rotation for real.** Support two keys in `JWT_PRIVATE_JWKS`, sign with the first, and write a test that a token signed with the second (old) key still verifies until it is removed.
   *Expected outcome:* zero logouts during rotation.
   *Verify by:* the test, plus the `/.well-known/jwks.json` output.

**Advanced (failure injection or 10x scale)**

1. **Distributed credential stuffing.** Simulate 500 IPs each trying 3 passwords on 1,000 accounts. Your per-IP limit never fires. Design and implement a defence (for example a global failure-rate alarm that enables CAPTCHA or delays, or per-account backoff that grows).
   *Expected outcome:* attack success limited by the per-account cap; an alert fires.
   *Verify by:* counting successful logins and alerts in the simulation.
2. **10x token volume.** At 50,000 requests a second, the live session check on money routes becomes a hot query. Cache "family revoked" in Redis with a short TTL and publish revocations, so the check stays under 1 ms.
   *Expected outcome:* revocation still takes effect within your stated bound (say 2 seconds).
   *Verify by:* a test that revokes and then measures how long a transfer is still accepted.
3. **Sender-constrained tokens.** Read about DPoP (RFC 9449) and design how it would bind refresh tokens to a key held by the React Native app, so a copied token is useless without the device's private key.
   *Expected outcome:* a written design and a threat comparison with rotation alone.
   *Verify by:* review against the RFC.

---

## 📝 Quiz

1. What is the difference between a 401 and a 403?
2. Why must a password hash be slow, and why is a refresh token fine with SHA-256?
3. Name three claims a JWT verifier must check, and one header field the lab also pins.
4. A used refresh token is presented again. What does the server do, and why can it not just reject that one request?
5. Why does the lab answer 404, not 403, when Riya asks for Amit's wallet?
6. Why is the Google login cookie `SameSite=Lax` while the refresh cookie is `SameSite=Strict`?
7. What does the `code_challenge` contain, and why is it safe to send through the browser?
8. What is the difference between an ID token and an access token?
9. Why is the step-up OTP bound to the idempotency key and request body?
10. Why should a token for audience `notifications` be rejected by the ledger service?

---

## 🔑 Quiz answer key

1. **401**: we do not know who you are (no token, bad or expired token, revoked session, or a fresh factor is needed). **403**: we know who you are, you may see this object, but you may not do this action.
2. Humans choose guessable passwords, so the hash must make each guess expensive (argon2id: about 27 ms and 19 MiB here). A refresh token is 32 random bytes: nobody can guess it, so a fast hash only needs to stop a database leak from exposing usable tokens.
3. Any three of `exp`, `iss`, `aud` (plus `nbf`); the lab also pins `alg` (an allowlist) and `typ` (`at+jwt`).
4. It revokes the **whole token family**. It cannot tell whether the presenter is the thief or the real user, and the other party holds a live descendant; killing the family stops both, and only the real user can sign in again.
5. 403 would confirm the wallet exists. 404 gives an attacker no information about which IDs are real.
6. The Google callback arrives as a cross-site top-level navigation from Google; `Strict` would not send the cookie on it and sign-in would fail. The refresh endpoint is only ever called from our own app, so `Strict` costs nothing there.
7. `BASE64URL(SHA-256(code_verifier))`. It is a one-way hash: seeing it does not reveal the verifier needed to exchange the code.
8. An ID token tells **our app** who the user is (audience = our client ID). An access token lets its holder call **an API** (audience = that API). We never use Google's tokens as our session.
9. So the OTP approves exactly one transfer: that amount, that payee, that key. A different amount fails the binding, and the idempotency key guarantees the approved transfer runs at most once even if it is retried.
10. Audience pinning stops a confused deputy: a token issued for one service (or stolen from it) cannot be replayed against another.

---

## 📖 Glossary

| Term | Meaning |
|---|---|
| ABAC | Attribute-based access control: rules over attributes of user, object and context. |
| Access token | Short-lived proof of login sent with each API call. |
| Account enumeration | Learning which emails have accounts from different answers or timings. |
| amr / auth_time | JWT claims saying how and when the user actually authenticated. |
| argon2id | A memory-hard password hashing algorithm; OWASP's first choice. |
| BFF | Backend for frontend: a server-side layer that holds tokens for a browser app. |
| BOLA / IDOR | Reaching another user's object by changing its ID; OWASP API1:2023. |
| BFLA | Broken function level authorisation: calling an action your role should not have; OWASP API5:2023. |
| Credential stuffing | Trying leaked email-password pairs from other sites at scale. |
| CSRF | Another site makes the browser send a request with your cookies. |
| Deny by default | Anything not explicitly allowed is refused; here, routes without rules cannot exist. |
| HMAC | A keyed hash; used here for OTP storage, as in P1-04's webhook signatures. |
| ID token | OIDC token that tells the app who signed in. |
| JWKS | JSON Web Key Set: the published public keys used to verify JWTs, chosen by `kid`. |
| mTLS | Both client and server present certificates in the TLS handshake. |
| Nonce | Random value that ties an ID token to one sign-in request. |
| OIDC | OpenID Connect: identity on top of OAuth 2.0. |
| Pepper | A secret mixed into hashes and kept outside the database. |
| PKCE | Verifier and hashed challenge that make a stolen authorization code useless. |
| Principal | The verified caller (user ID, role, session). |
| RBAC | Role-based access control. |
| ReBAC | Relationship-based access control: access follows edges like "viewer of account". |
| Refresh token | Long-lived, revocable secret used only to obtain new access tokens. |
| Reuse detection | Treating a second use of a one-time refresh token as theft and revoking its family. |
| Salt | Random per-password value stored with the hash. |
| SameSite | Cookie attribute that limits sending cookies on cross-site requests. |
| State | Random value that ties an OAuth callback to the browser that started it. |
| Step-up | A fresh extra factor before a sensitive action. |
| Token family | All refresh tokens from one login; revoked as a unit. |
| XSS | An attacker's script running in your page. |

---

## 📌 Cheat sheet

**Diagram: the whole card on one screen**

```mermaid
mindmap
  root((Auth))
    Authentication
      argon2id, OWASP minimum
      Limits per IP and per account
      Same answer for unknown email
    Tokens
      Access 10 min RS256 typ at+jwt
      Pin alg iss aud exp
      Refresh rotated, hashed, family
      Reuse revokes the family
      Money routes check session live
    Browser
      HttpOnly Secure SameSite
      Origin check against CSRF
      Never localStorage
      BFF is strongest
    OIDC
      Code flow with PKCE S256
      State and nonce
      Link by sub not email
    Authorisation
      Role plus relationship
      Every object ID, path or body
      404 if you cannot read it
      Deny by default, matrix tests
    Step-up and services
      OTP bound to one transfer
      mTLS plus short service tokens
```

**How to read this diagram.** Six branches, six habits. Each leaf is a rule you can say in one sentence in an interview, and each one is backed by a test in the lab.

**Key rules on one screen**

- Authentication = who; authorisation = may this caller do this to **this** object. Check both, on every request.
- Passwords: argon2id (m = 19 MiB, t = 2, p = 1 minimum; ~27 ms here); per-IP and per-account limits; one generic error; dummy hash for unknown emails.
- JWT: signed, not encrypted. Pin `algorithms`, `iss`, `aud`, `exp`, `typ`. Rotate keys via JWKS and `kid`.
- Access 10 minutes; refresh rotated, hashed, single-use; reuse kills the family; "log out everywhere" = revoke all families; money routes check the session live.
- Web: refresh in an HttpOnly, Secure, SameSite=Strict cookie on `/v1/auth`; access token in memory; Origin check; or a BFF.
- OIDC: code flow + PKCE S256 + state + nonce; verify the ID token; link by `sub`; never reuse provider tokens as your session.
- Ownership: one guard with role + relationship for every object ID; 404 if hidden, 403 if visible; app refuses to start without a rule; 70 matrix tests.
- Step-up: OTP bound to amount, payee and idempotency key; 5 minutes; 5 attempts; HMAC with a pepper; RFC 9470 `401`.
- Services: mTLS + short-lived tokens with strict `aud`; partner API keys hashed and prefixed.

---

## 🏁 Completion checklist

- [ ] I can explain authn vs authz, and 401 vs 403 vs 404, with ledger examples.
- [ ] Measure: I timed argon2id with my chosen parameters on my machine (mine: __ ms).
- [ ] Signup and login work, with per-IP and per-account limits, and the same answer for unknown emails.
- [ ] RS256 access tokens verify with pinned `alg`, `iss`, `aud`, `typ`; refresh tokens rotate and are stored hashed.
- [ ] Measure: my test proves refresh-token reuse revokes the family.
- [ ] Every wallet and transfer route has an access rule and an ownership guard; the app refuses to start without them.
- [ ] Measure: my access-control tests all pass (mine: __ tests), including the cross-user test.
- [ ] Support can view but not refund; staff access is audited.
- [ ] "Login with Google" works with PKCE against the fake provider (and, optionally, real Google).
- [ ] Transfers above my threshold need an OTP bound to that transfer.
- [ ] Phase 1 gate: I can answer "how would you secure this API?" covering authn, authz with object checks, revocation and step-up, without notes.
- [ ] Lab run on my machine.
- [ ] Numbers filled in the measurements table.
- [ ] Post published.

---

## 📣 Learn in public

Use **your own** measured numbers in place of the ones from this guide.

**Post 1: "My app refused to start, and that was the point"**
- *Problem:* Any logged-in user could read any wallet by changing the ID in the URL (BOLA, OWASP's number one API risk).
- *Decision:* One central guard checks role plus relationship for every object ID, and routes without an access rule make the app refuse to start.
- *Result:* The first boot failed on an old route I had forgotten. 70 access-control tests now pass, including "Riya cannot read Amit's wallet" (404, indistinguishable from a wallet that doesn't exist).
- *Lesson:* "Logged in" is not "allowed". Make the safe path the only path, then test every route against every kind of caller.

**Post 2: "A stolen refresh token should kill the whole session"**
- *Problem:* JWT access tokens cannot be revoked, and a stolen long-lived refresh token is a silent backdoor.
- *Decision:* 10-minute access tokens; refresh tokens stored hashed, single-use, in a family; reuse revokes the family; money routes check the session live.
- *Result:* In my test, replaying an old refresh token revoked the family; the old access token could still read a wallet but got `401 SESSION_REVOKED` on a transfer.
- *Lesson:* Stateless where it is cheap, stateful where money moves. And fix the two-tab race in the client, not with a weaker server.

**Post 3: "27 ms per password is a feature"**
- *Problem:* SHA-256 lets an attacker try about 285,000 passwords a second per core on a leaked table.
- *Decision:* argon2id at OWASP's minimum (19 MiB, t = 2), plus per-IP and per-account login limits and a dummy hash for unknown emails.
- *Result:* 27.2 ms per hash here (37 guesses a second per core, and memory-hard against GPUs); unknown-email and wrong-password logins took the same time (36.9 vs 37.0 ms).
- *Lesson:* Make every guess expensive, every account rate-limited, and every failure look the same.

**Hinglish video idea: "Login hai matlab allowed nahi hai"**
Open with the TTE analogy: valid ticket, wrong coach. Live-demo BOLA: Riya logs in, changes the wallet ID in the URL, and the vulnerable version shows Amit's ₹9.8 lakh balance. Then switch on the guard and show 404. Then show the app refusing to start without access rules. End with: "Authentication batata hai kaun ho. Authorisation har request pe poochta hai: ye wallet tumhara hai?"

---

## ➡️ Next cards

- **P5-06 · Application security.** This card covers identity and access; that one widens to the rest of the attack surface you met here in passing: XSS (why tokens leave `localStorage`), CSRF, SSRF (P1-04's webhook URLs), secrets management for signing keys and peppers, dependency risk, and threat modelling.
- **P7-06 · Multi-tenancy and multi-region.** The `account_members` relationship is a small version of tenant isolation. That card asks how to keep every tenant's data separate at scale (row-level security, per-tenant keys, noisy neighbours) and how sessions, key rotation and revocation work when users are served from several regions.
- **Also linked:** login limits grow into proper algorithms in **P3-04 · Rate limiting**; the audit log and security alerts connect to **P5-01 · Observability with OpenTelemetry** and **P5-08 · Incident response and postmortems**; service tokens and mTLS reappear in **P4-08 · Service boundaries**.

---

## 📚 Sources and further reading

All links checked on 13 October 2026.

- [OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html) — argon2id, scrypt, bcrypt and PBKDF2 parameters; salts and peppers.
- [OWASP API Security Top 10 2023: API1 Broken Object Level Authorization](https://api-security.owasp.org/editions/2023/en/0xa1-broken-object-level-authorization/).
- [RFC 9700: OAuth 2.0 Security Best Current Practice](https://www.rfc-editor.org/rfc/rfc9700.html) — January 2025; PKCE, implicit and password grants, refresh token protection, exact redirect URIs.
- [RFC 7636: Proof Key for Code Exchange (PKCE)](https://www.rfc-editor.org/rfc/rfc7636).
- [RFC 8725: JSON Web Token Best Current Practices](https://www.rfc-editor.org/rfc/rfc8725.html) — algorithm pinning, `none`, audience, explicit typing.
- [RFC 9068: JWT Profile for OAuth 2.0 Access Tokens](https://www.rfc-editor.org/rfc/rfc9068) — the `at+jwt` type.
- [RFC 9470: OAuth 2.0 Step Up Authentication Challenge Protocol](https://www.rfc-editor.org/rfc/rfc9470.html) — `insufficient_user_authentication`, `max_age`.
- [RFC 10017: OAuth 2.0 for Browser-Based Applications](https://www.rfc-editor.org/rfc/rfc10017.html) — August 2026; BFF first, token storage risks.
- [MDN: Set-Cookie](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie) — `__Secure-` and `__Host-` prefixes, SameSite.
- [Google's OpenID Connect discovery document](https://accounts.google.com/.well-known/openid-configuration).
- [openid-client (panva)](https://github.com/panva/openid-client) — v6 API used in the lab.
- [jose (panva)](https://github.com/panva/jose) — JWT signing, verification and JWKS.
- [node-argon2](https://github.com/ranisalt/node-argon2).
- [Cedar policy syntax](https://docs.cedarpolicy.com/policies/syntax-policy.html) and [OPA policy language](https://www.openpolicyagent.org/docs/policy-language).
- [RBI: Authentication Mechanisms for Digital Payment Transactions Directions, 2025](https://www.rbi.org.in/Scripts/BS_CircularIndexDisplay.aspx?Id=12898) and a [summary by Mondaq](https://www.mondaq.com/india/new-technology/1728730/understanding-rbi-authentication-mechanisms-for-digital-payment-transactions-directions-2025-obligations-for-banks-nbfcs-and-payment-providers) — issued 25 September 2025, effective 1 April 2026.


