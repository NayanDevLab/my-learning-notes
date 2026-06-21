# Learning Notes

> A full-stack engineer's 25-week deep dive into backend, databases, DSA, system
> design, and DevOps. Everything organised by concept in a **learn-in-order**
> sequence so each topic builds on the previous one.

**Started:** May 27, 2026 | **Target:** November 8, 2026

---

## How to use this guide

Read **top to bottom, phase by phase**. Each phase assumes you finished the
previous one. Inside each phase the notes are numbered — follow that order.
Check the box as you complete each topic.

---

## Phase 1 : Database Fundamentals

> Start here. Every backend app talks to a database — understand the theory
> first, then write SQL.

### 1A. DBMS Theory

| # | Topic | Notes |
|---|-------|-------|
| 1 | What is a DBMS & why it matters | [DBMS-Fundamentals-Notes](databases/dbms-fundamentals/DBMS-Fundamentals-Notes.md) |
| 2 | Relational database basics (tables, rows, keys) | [Relational-Database-Basics-Notes](databases/sql-fundamentals/Relational-Database-Basics-Notes.md) |
| 3 | ACID Properties | [ACID-Properties-Notes](databases/dbms-fundamentals/ACID-Properties-Notes.md) |
| 4 | Transactions basics | [Transactions-Basics-Notes](databases/dbms-fundamentals/Transactions-Basics-Notes.md) |
| 5 | SQL vs NoSQL — when to pick what | [SQL-vs-NoSQL-Notes](databases/dbms-fundamentals/SQL-vs-NoSQL-Notes.md) |

### 1B. SQL — Write Queries

| # | Topic | Notes |
|---|-------|-------|
| 1 | CRUD operations (SELECT, INSERT, UPDATE, DELETE) | [CRUD-Operations-Notes](databases/sql-fundamentals/CRUD-Operations-Notes.md) |
| 2 | WHERE clauses & filtering | [WHERE-Clauses-Filtering-Notes](databases/sql-fundamentals/WHERE-Clauses-Filtering-Notes.md) |
| 3 | Sorting & limiting results | [Sorting-and-Limiting-Notes](databases/sql-fundamentals/Sorting-and-Limiting-Notes.md) |
| 4 | JOINs (INNER, LEFT, RIGHT, FULL) | [SQL-Joins-Notes](databases/sql-fundamentals/SQL-Joins-Notes.md) |
| 5 | Database relationships (1:1, 1:N, M:N) | [Database-Relationships-Notes](databases/sql-fundamentals/Database-Relationships-Notes.md) |
| 6 | Constraints (PK, FK, UNIQUE, CHECK, NOT NULL) | [Database-Constraints-Notes](databases/sql-fundamentals/Database-Constraints-Notes.md) |
| 7 | Database design & normalisation (1NF → 3NF) | [Database-Design-Normalisation-Notes](databases/sql-fundamentals/Database-Design-Normalisation-Notes.md) |
| 8 | Indexes basics — why queries get fast | [Indexes-Basics-Notes](databases/sql-fundamentals/Indexes-Basics-Notes.md) |

### 1C. SQL Practice

| # | Topic | Notes |
|---|-------|-------|
| 1 | INSERT, SELECT, UPDATE practice | [Insert-Select-Update-From-Notes](databases/sql-fundamentals/Pratice/Insert-Select-Update-From-Notes.md) |
| 2 | Building real queries step by step | [Practical-SQL-Building-Queries-Notes](databases/sql-fundamentals/Pratice/Practical-SQL-Building-Queries-Notes.md) |
| 3 | Subqueries basics | [Subqueries-Basics-Notes](databases/sql-fundamentals/Pratice/Subqueries-Basics-Notes.md) |

---

## Phase 2 : PostgreSQL — Go Deeper

> You know SQL basics. Now learn the production database that powers most
> startups.

| # | Topic | Notes |
|---|-------|-------|
| 1 | Advanced queries (CTEs, window functions, etc.) | [Advanced-PostgreSQL-Queries-Notes](databases/postgresql/Advanced-PostgreSQL-Queries-Notes.md) |
| 2 | PostgreSQL indexes (B-Tree, GIN, partial, etc.) | [PostgreSQL-Indexes-Notes](databases/postgresql/PostgreSQL-Indexes-Notes.md) |
| 3 | EXPLAIN ANALYZE — read query plans | [EXPLAIN-ANALYZE-Deep-Notes](databases/postgresql/EXPLAIN-ANALYZE-Deep-Notes.md) |
| 4 | Isolation levels deep dive | [Isolation-Levels-Deep-Notes](databases/postgresql/Isolation-Levels-Deep-Notes.md) |

---

## Phase 3 : MongoDB — The NoSQL Side

> Now learn the document database. Contrast it with everything you just learned
> in SQL/PostgreSQL.

| # | Topic | Notes |
|---|-------|-------|
| 1 | MongoDB fundamentals (documents, collections) | [MongoDB-Fundamentals-Notes](databases/mongodb/MongoDB-Fundamentals-Notes.md) |
| 2 | CRUD operations in MongoDB | [MongoDB-CRUD-Notes](databases/mongodb/MongoDB-CRUD-Notes.md) |
| 3 | Query operators ($gt, $in, $regex, etc.) | [MongoDB-Query-Operators-Notes](databases/mongodb/MongoDB-Query-Operators-Notes.md) |
| 4 | Projection — select specific fields | [MongoDB-Projection-Notes](databases/mongodb/MongoDB-Projection-Notes.md) |
| 5 | Update operations ($set, $push, $inc, etc.) | [MongoDB-Updates-Notes](databases/mongodb/MongoDB-Updates-Notes.md) |
| 6 | Schema design patterns | [MongoDB-Schema-Design-Notes](databases/mongodb/MongoDB-Schema-Design-Notes.md) |
| 7 | Relationships & $lookup (joins in Mongo) | [MongoDB-Relationships-Lookup-Notes](databases/mongodb/MongoDB-Relationships-Lookup-Notes.md) |
| 8 | Aggregation pipeline | [MongoDB-Aggregation-Pipeline-Notes](databases/mongodb/MongoDB-Aggregation-Pipeline-Notes.md) |
| 9 | Indexes in MongoDB | [MongoDB-Indexes-Basics-Notes](databases/mongodb/MongoDB-Indexes-Basics-Notes.md) |
| 10 | N+1 problem & how to avoid it | [N-Plus-1-Problem-Notes](databases/mongodb/N-Plus-1-Problem-Notes.md) |
| 11 | Extended reference pattern | [MongoDB-Extended-Reference-Notes](databases/mongodb/MongoDB-Extended-Reference-Notes.md) |

### Database Practice Project

| # | Topic | Notes |
|---|-------|-------|
| 1 | Weekend build: SQL vs MongoDB side by side | [Weekend-Build-SQL-vs-MongoDB-Notes](databases/pratice/Weekend-Build-SQL-vs-MongoDB-Notes.md) |

---

## Phase 4 : Node.js & Express — The Runtime

> Databases are ready. Now build the server that talks to them.

| # | Topic | Notes |
|---|-------|-------|
| 1 | Node.js event loop (how async really works) | [event-loop-notes](backend/express/event-loop-notes.md) |
| 2 | Streams & buffers (handling large data) | [streams-and-buffers-notes](backend/express/streams-and-buffers-notes.md) |
| 3 | Express architecture (middleware, routing) | [express-architecture-notes](backend/express/express-architecture-notes.md) |
| 4 | Production Express patterns (error handling, logging) | [production-express-patterns-notes](backend/express/production-express-patterns-notes.md) |
| 5 | Express + TypeScript boilerplate (reference project) | [express-ts-boilerplate](backend/express/express-ts-boilerplate/express-ts-boilerplate/README.md) |

---

## Phase 5 : Authentication & Security

> Your server runs. Now protect it — passwords, tokens, roles.

| # | Topic | Notes |
|---|-------|-------|
| 1 | Password security (hashing, bcrypt, salt) | [Password-Security-Notes](backend/authentication/Password-Security-Notes.md) |
| 2 | JWT internals (header, payload, signature) | [JWT-Internals-Notes](backend/authentication/JWT-Internals-Notes.md) |
| 3 | Access & refresh tokens (flow, rotation) | [Access-Refresh-Token-Notes](backend/authentication/Access-Refresh-Token-Notes.md) |
| 4 | RBAC — role-based access control | [RBAC-Notes](backend/authentication/RBAC-Notes.md) |
| 5 | Security audit & OAuth (Google, GitHub login) | [Security-Audit-OAuth-Notes](backend/authentication/Security-Audit-OAuth-Notes.md) |

---

## Phase 6 : API Design & Architecture

> You can build and secure a server. Now design APIs the right way.

| # | Topic | Notes |
|---|-------|-------|
| 1 | REST API design (naming, status codes, versioning) | [REST-API-Design-Notes](backend/api-design/REST-API-Design-Notes.md) |
| 2 | Pagination patterns (offset, cursor, keyset) | [Pagination-Patterns-Notes](backend/api-design/Pagination-Patterns-Notes.md) |
| 3 | Architecture patterns (MVC, service layer, clean arch) | [Architecture-Patterns-Notes](backend/api-design/Architecture-Patterns-Notes.md) |
| 4 | File uploads & S3 (multipart, presigned URLs) | [File-Uploads-S3-Notes](backend/api-design/File-Uploads-S3-Notes.md) |
| 5 | BullMQ & background jobs (queues, workers, retries) | [BullMQ-Background-Jobs-Notes](backend/api-design/BullMQ-Background-Jobs-Notes.md) |

---

## Phase 7 : Build a Real Project

> Combine everything — database + backend + auth + API design — into one
> capstone project. Read the blueprint first, then run the actual API.

| # | Topic | Notes |
|---|-------|-------|
| 1 | Job Board API — capstone blueprint (design & plan) | [Job-Board-API-Capstone-Blueprint](backend/pratice/Job-Board-API-Capstone-Blueprint.md) |
| 2 | Job Board API — runnable practice project (code) | [job-board-api](backend/api-design/job-board-api/README.md) |

---

## Phase 8 : DSA — Data Structures & Algorithms

> Start this in parallel with backend phases. One pattern a day keeps
> rejections away. Learn the cheatsheet overview first, then dive into
> each pattern with detailed notes and problems.

### 8A. Overview

| # | Topic | Notes |
|---|-------|-------|
| 1 | Patterns cheatsheet (all common patterns in one place) | [patterns-cheatsheet](dsa/patterns-cheatsheet.md) |

### 8B. Arrays & Strings

| # | Topic | Notes |
|---|-------|-------|
| 1 | Two pointers (converging, same-direction, fast-slow) | [Two-Pointers-Notes](dsa/arrays/Two-Pointers-Notes.md) |
| 2 | Sliding window (fixed & variable size) | [Sliding-Window-Notes](dsa/arrays/Sliding-Window-Notes.md) |

### 8C. Hash Maps & Sets

| # | Topic | Notes |
|---|-------|-------|
| 1 | Hash maps (O(1) lookups, frequency counting, grouping) | [Hash-Maps-Notes](dsa/hash-map/Hash-Maps-Notes.md) |

---

## Upcoming Sections (not yet started)

| Section | Folder | What it will cover |
|---------|--------|--------------------|
| System Design | `system-design/` | Building blocks, HLD, LLD |
| DevOps | `devops/` | Docker, CI/CD, AWS, production |
| Frontend | `frontend/` | Modern React/Next.js patterns |
| Interview Prep | `interview-prep/` | STAR stories, company research |

---

## Quick Revision Order

When you have **limited time before an interview**, revise in this priority:

1. DBMS theory + ACID + Transactions
2. SQL JOINs + Indexes + Normalisation
3. Event loop + Express architecture
4. JWT + Access/Refresh tokens + RBAC
5. REST API design + Pagination
6. MongoDB schema design + Aggregation
7. PostgreSQL EXPLAIN ANALYZE + Isolation levels
8. DSA — Two pointers, Sliding window, Hash maps
9. DSA patterns cheatsheet

---

## Connect

- GitHub: [nayanrdeveloper](https://github.com/nayanrdeveloper)
- Email: nayanrdeveloper@gmail.com

---

Started: May 27, 2026 | Target: November 8, 2026 (Diwali)
