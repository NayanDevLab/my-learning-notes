// src/repositories/job.repository.js
// ---------------------------------------------------------------------------
// Job repository — includes the cursor-pagination + filtering "query".
// In real Postgres this would be a WHERE + ORDER BY + LIMIT query using the
// idx_jobs_filters and idx_jobs_created indexes. Here we filter the array, but
// the LOGIC (keyset pagination on created_at + id) is exactly the same.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const db = require('../lib/db');

class JobRepository {
  findById(id) {
    return db.jobs.find((j) => j.id === id) || null;
  }

  create({ companyId, title, location, type, minSalary, description }) {
    const job = {
      id: crypto.randomUUID(),
      company_id: companyId,
      title,
      location: location || null,
      type: type || null,
      min_salary: minSalary ?? null,
      description: description || '',
      created_at: new Date().toISOString(),
    };
    db.jobs.push(job);
    return job;
  }

  update(id, fields) {
    const job = this.findById(id);
    if (!job) return null;
    Object.assign(job, fields);
    return job;
  }

  delete(id) {
    const idx = db.jobs.findIndex((j) => j.id === id);
    if (idx === -1) return false;
    db.jobs.splice(idx, 1);
    return true;
  }

  // Cursor pagination + filters + search.
  // `cursor` = { createdAt, id } or null. Returns `limit + 1` to detect "hasMore".
  list({ location, type, minSalary, q, cursor, limit }) {
    let rows = [...db.jobs];

    // --- filters (the ?location=&type=&minSalary= query params) ---
    if (location) rows = rows.filter((j) => j.location === location);
    if (type) rows = rows.filter((j) => j.type === type);
    if (minSalary != null) rows = rows.filter((j) => (j.min_salary ?? 0) >= minSalary);
    // --- search (the ?q= param) — case-insensitive title match ---
    if (q) {
      const needle = q.toLowerCase();
      rows = rows.filter((j) => j.title.toLowerCase().includes(needle));
    }

    // --- sort newest first, with id as a TIEBREAKER (stable ordering) ---
    rows.sort((a, b) => {
      if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1;
      return a.id < b.id ? 1 : -1;
    });

    // --- keyset pagination: keep only rows AFTER the cursor ---
    if (cursor) {
      rows = rows.filter((j) => {
        if (j.created_at < cursor.createdAt) return true;
        if (j.created_at === cursor.createdAt && j.id < cursor.id) return true;
        return false;
      });
    }

    // Fetch limit + 1 so the service can tell if there's a next page.
    return rows.slice(0, limit + 1);
  }
}

module.exports = new JobRepository();
