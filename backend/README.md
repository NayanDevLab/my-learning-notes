# Backend

> Covers Node.js internals, Express framework, authentication, API design,
> and a capstone project. Read in the phase order below.

---

## Folder Structure

```
backend/
├── express/                     ← Phase 4: Runtime & framework
│   └── express-ts-boilerplate/  ← Reference project
├── authentication/              ← Phase 5: Security
├── api-design/                  ← Phase 6: Design patterns
│   └── job-board-api/           ← Phase 7: Runnable capstone project
└── pratice/                     ← Phase 7: Capstone blueprint
```

---

## Phase 4 : Node.js & Express — The Runtime

> Databases are ready. Now build the server that talks to them.

| # | Topic | Link |
|---|-------|------|
| 1 | Node.js event loop (how async really works) | [event-loop-notes](express/event-loop-notes.md) |
| 2 | Streams & buffers (handling large data) | [streams-and-buffers-notes](express/streams-and-buffers-notes.md) |
| 3 | Express architecture (middleware, routing) | [express-architecture-notes](express/express-architecture-notes.md) |
| 4 | Production Express patterns (error handling, logging) | [production-express-patterns-notes](express/production-express-patterns-notes.md) |
| 5 | Express + TypeScript boilerplate (reference project) | [express-ts-boilerplate](express/express-ts-boilerplate/express-ts-boilerplate/README.md) |

---

## Phase 5 : Authentication & Security

> Your server runs. Now protect it — passwords, tokens, roles.

| # | Topic | Link |
|---|-------|------|
| 1 | Password security (hashing, bcrypt, salt) | [Password-Security-Notes](authentication/Password-Security-Notes.md) |
| 2 | JWT internals (header, payload, signature) | [JWT-Internals-Notes](authentication/JWT-Internals-Notes.md) |
| 3 | Access & refresh tokens (flow, rotation) | [Access-Refresh-Token-Notes](authentication/Access-Refresh-Token-Notes.md) |
| 4 | RBAC — role-based access control | [RBAC-Notes](authentication/RBAC-Notes.md) |
| 5 | Security audit & OAuth (Google, GitHub login) | [Security-Audit-OAuth-Notes](authentication/Security-Audit-OAuth-Notes.md) |

---

## Phase 6 : API Design & Architecture

> You can build and secure a server. Now design APIs the right way.

| # | Topic | Link |
|---|-------|------|
| 1 | REST API design (naming, status codes, versioning) | [REST-API-Design-Notes](api-design/REST-API-Design-Notes.md) |
| 2 | Pagination patterns (offset, cursor, keyset) | [Pagination-Patterns-Notes](api-design/Pagination-Patterns-Notes.md) |
| 3 | Architecture patterns (MVC, service layer, clean arch) | [Architecture-Patterns-Notes](api-design/Architecture-Patterns-Notes.md) |
| 4 | File uploads & S3 (multipart, presigned URLs) | [File-Uploads-S3-Notes](api-design/File-Uploads-S3-Notes.md) |
| 5 | BullMQ & background jobs (queues, workers, retries) | [BullMQ-Background-Jobs-Notes](api-design/BullMQ-Background-Jobs-Notes.md) |

---

## Phase 7 : Build a Real Project

> Combine everything — database + backend + auth + API design — into one
> capstone project. Read the blueprint first, then run the actual API.

| # | Topic | Link |
|---|-------|------|
| 1 | Job Board API — capstone blueprint (design & plan) | [Job-Board-API-Capstone-Blueprint](pratice/Job-Board-API-Capstone-Blueprint.md) |
| 2 | Job Board API — runnable practice project (code) | [job-board-api](api-design/job-board-api/README.md) |

---

[Back to root](../README.md)
