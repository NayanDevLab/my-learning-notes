# Databases

> Covers DBMS theory, SQL fundamentals, PostgreSQL deep dives, and MongoDB.
> Read in the phase order below — each topic builds on the previous one.

---

## Folder Structure

```
databases/
├── dbms-fundamentals/           ← Phase 1A: Theory
├── sql-fundamentals/            ← Phase 1B: Write queries
│   └── Pratice/                 ← Phase 1C: Practice
├── postgresql/                  ← Phase 2: Go deeper
├── mongodb/                     ← Phase 3: NoSQL side
└── pratice/                     ← Database practice projects
```

---

## Phase 1A : DBMS Theory

> Start here. Understand what a database really does before writing any SQL.

| # | Topic | Link |
|---|-------|------|
| 1 | What is a DBMS & why it matters | [DBMS-Fundamentals-Notes](dbms-fundamentals/DBMS-Fundamentals-Notes.md) |
| 2 | ACID Properties | [ACID-Properties-Notes](dbms-fundamentals/ACID-Properties-Notes.md) |
| 3 | Transactions basics | [Transactions-Basics-Notes](dbms-fundamentals/Transactions-Basics-Notes.md) |
| 4 | SQL vs NoSQL — when to pick what | [SQL-vs-NoSQL-Notes](dbms-fundamentals/SQL-vs-NoSQL-Notes.md) |

---

## Phase 1B : SQL — Write Queries

> Theory done. Now get your hands on real SQL — from basic SELECT to JOINs
> to indexing.

| # | Topic | Link |
|---|-------|------|
| 1 | Relational database basics (tables, rows, keys) | [Relational-Database-Basics-Notes](sql-fundamentals/Relational-Database-Basics-Notes.md) |
| 2 | CRUD operations (SELECT, INSERT, UPDATE, DELETE) | [CRUD-Operations-Notes](sql-fundamentals/CRUD-Operations-Notes.md) |
| 3 | WHERE clauses & filtering | [WHERE-Clauses-Filtering-Notes](sql-fundamentals/WHERE-Clauses-Filtering-Notes.md) |
| 4 | Sorting & limiting results | [Sorting-and-Limiting-Notes](sql-fundamentals/Sorting-and-Limiting-Notes.md) |
| 5 | JOINs (INNER, LEFT, RIGHT, FULL) | [SQL-Joins-Notes](sql-fundamentals/SQL-Joins-Notes.md) |
| 6 | Database relationships (1:1, 1:N, M:N) | [Database-Relationships-Notes](sql-fundamentals/Database-Relationships-Notes.md) |
| 7 | Constraints (PK, FK, UNIQUE, CHECK, NOT NULL) | [Database-Constraints-Notes](sql-fundamentals/Database-Constraints-Notes.md) |
| 8 | Database design & normalisation (1NF - 3NF) | [Database-Design-Normalisation-Notes](sql-fundamentals/Database-Design-Normalisation-Notes.md) |
| 9 | Indexes basics — why queries get fast | [Indexes-Basics-Notes](sql-fundamentals/Indexes-Basics-Notes.md) |

---

## Phase 1C : SQL Practice

> Reinforce what you learned by building real queries.

| # | Topic | Link |
|---|-------|------|
| 1 | INSERT, SELECT, UPDATE practice | [Insert-Select-Update-From-Notes](sql-fundamentals/Pratice/Insert-Select-Update-From-Notes.md) |
| 2 | Building real queries step by step | [Practical-SQL-Building-Queries-Notes](sql-fundamentals/Pratice/Practical-SQL-Building-Queries-Notes.md) |
| 3 | Subqueries basics | [Subqueries-Basics-Notes](sql-fundamentals/Pratice/Subqueries-Basics-Notes.md) |

---

## Phase 2 : PostgreSQL — Go Deeper

> You know SQL basics. Now learn the production database that powers most
> startups — advanced queries, indexes, query plans, isolation.

| # | Topic | Link |
|---|-------|------|
| 1 | Advanced queries (CTEs, window functions, etc.) | [Advanced-PostgreSQL-Queries-Notes](postgresql/Advanced-PostgreSQL-Queries-Notes.md) |
| 2 | PostgreSQL indexes (B-Tree, GIN, partial, etc.) | [PostgreSQL-Indexes-Notes](postgresql/PostgreSQL-Indexes-Notes.md) |
| 3 | EXPLAIN ANALYZE — read query plans | [EXPLAIN-ANALYZE-Deep-Notes](postgresql/EXPLAIN-ANALYZE-Deep-Notes.md) |
| 4 | Isolation levels deep dive | [Isolation-Levels-Deep-Notes](postgresql/Isolation-Levels-Deep-Notes.md) |

---

## Phase 3 : MongoDB — The NoSQL Side

> Now learn the document database. Contrast it with everything you just
> learned in SQL/PostgreSQL.

| # | Topic | Link |
|---|-------|------|
| 1 | MongoDB fundamentals (documents, collections) | [MongoDB-Fundamentals-Notes](mongodb/MongoDB-Fundamentals-Notes.md) |
| 2 | CRUD operations in MongoDB | [MongoDB-CRUD-Notes](mongodb/MongoDB-CRUD-Notes.md) |
| 3 | Query operators ($gt, $in, $regex, etc.) | [MongoDB-Query-Operators-Notes](mongodb/MongoDB-Query-Operators-Notes.md) |
| 4 | Projection — select specific fields | [MongoDB-Projection-Notes](mongodb/MongoDB-Projection-Notes.md) |
| 5 | Update operations ($set, $push, $inc, etc.) | [MongoDB-Updates-Notes](mongodb/MongoDB-Updates-Notes.md) |
| 6 | Schema design patterns | [MongoDB-Schema-Design-Notes](mongodb/MongoDB-Schema-Design-Notes.md) |
| 7 | Relationships & $lookup (joins in Mongo) | [MongoDB-Relationships-Lookup-Notes](mongodb/MongoDB-Relationships-Lookup-Notes.md) |
| 8 | Aggregation pipeline | [MongoDB-Aggregation-Pipeline-Notes](mongodb/MongoDB-Aggregation-Pipeline-Notes.md) |
| 9 | Indexes in MongoDB | [MongoDB-Indexes-Basics-Notes](mongodb/MongoDB-Indexes-Basics-Notes.md) |
| 10 | N+1 problem & how to avoid it | [N-Plus-1-Problem-Notes](mongodb/N-Plus-1-Problem-Notes.md) |
| 11 | Extended reference pattern | [MongoDB-Extended-Reference-Notes](mongodb/MongoDB-Extended-Reference-Notes.md) |

---

## Database Practice Project

| # | Topic | Link |
|---|-------|------|
| 1 | Weekend build: SQL vs MongoDB side by side | [Weekend-Build-SQL-vs-MongoDB-Notes](pratice/Weekend-Build-SQL-vs-MongoDB-Notes.md) |

---

[Back to root](../README.md)
