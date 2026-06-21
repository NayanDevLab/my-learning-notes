// src/services/job.service.js
const jobRepo = require('../repositories/job.repository');
const companyRepo = require('../repositories/company.repository');
const { encodeCursor, decodeCursor } = require('../utils/cursor');
const { NotFoundError, ForbiddenError } = require('../utils/errors');

class JobService {
  // Create a job — must belong to a company the employer OWNS.
  create(userId, { companyId, title, location, type, minSalary, description }) {
    const company = companyRepo.findById(companyId);
    if (!company) throw new NotFoundError('Company not found');
    if (company.owner_id !== userId) {
      throw new ForbiddenError('You can only post jobs for your own company');
    }
    return jobRepo.create({ companyId, title, location, type, minSalary, description });
  }

  getById(id) {
    const job = jobRepo.findById(id);
    if (!job) throw new NotFoundError('Job not found');
    return job;
  }

  // List jobs with filters + cursor pagination. Returns { jobs, nextCursor }.
  list({ location, type, minSalary, q, cursor, limit = 10 }) {
    const decodedCursor = cursor ? decodeCursor(cursor) : null;
    const rows = jobRepo.list({
      location, type, minSalary, q, cursor: decodedCursor, limit,
    });

    // We asked for limit + 1. If we got more than `limit`, there's a next page.
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? encodeCursor(page[page.length - 1]) : null;

    return { jobs: page, nextCursor };
  }

  // Ownership check spans two tables: job -> company -> owner.
  _assertOwnsJob(jobId, userId) {
    const job = this.getById(jobId);
    const company = companyRepo.findById(job.company_id);
    if (!company || company.owner_id !== userId) {
      throw new ForbiddenError('You do not own this job');
    }
    return job;
  }

  update(id, userId, fields) {
    this._assertOwnsJob(id, userId);
    return jobRepo.update(id, fields);
  }

  delete(id, userId) {
    this._assertOwnsJob(id, userId);
    jobRepo.delete(id);
  }
}

module.exports = new JobService();
