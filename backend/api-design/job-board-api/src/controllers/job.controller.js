// src/controllers/job.controller.js
const jobService = require('../services/job.service');
const { ok } = require('../utils/envelope');

class JobController {
  create = (req, res, next) => {
    try {
      const job = jobService.create(req.user.sub, req.body);
      ok(res, 201, { job });
    } catch (e) { next(e); }
  };

  getById = (req, res, next) => {
    try {
      const job = jobService.getById(req.params.id);
      ok(res, 200, { job });
    } catch (e) { next(e); }
  };

  // List with cursor pagination — nextCursor goes in `meta`.
  list = (req, res, next) => {
    try {
      const { jobs, nextCursor } = jobService.list(req.query);
      ok(res, 200, { jobs }, { nextCursor, count: jobs.length });
    } catch (e) { next(e); }
  };

  update = (req, res, next) => {
    try {
      const job = jobService.update(req.params.id, req.user.sub, req.body);
      ok(res, 200, { job });
    } catch (e) { next(e); }
  };

  remove = (req, res, next) => {
    try {
      jobService.delete(req.params.id, req.user.sub);
      res.status(204).send();
    } catch (e) { next(e); }
  };
}

module.exports = new JobController();
