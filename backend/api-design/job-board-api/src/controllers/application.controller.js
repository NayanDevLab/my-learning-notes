// src/controllers/application.controller.js
const applicationService = require('../services/application.service');
const { ok } = require('../utils/envelope');

class ApplicationController {
  // POST /v1/jobs/:id/apply
  apply = (req, res, next) => {
    try {
      // Decode the base64 resume into a Buffer (in production: multer file).
      const resumeBuffer = Buffer.from(req.body.resumeBase64, 'base64');
      const application = applicationService.apply(req.user.sub, req.params.id, {
        resumeBuffer,
        coverLetter: req.body.coverLetter,
      });
      ok(res, 201, { application });
    } catch (e) { next(e); }
  };

  // GET /v1/jobs/:id/applications  (employer, owns job)
  listForJob = (req, res, next) => {
    try {
      const applications = applicationService.listForJob(req.params.id, req.user.sub);
      ok(res, 200, { applications }, { count: applications.length });
    } catch (e) { next(e); }
  };

  // GET /v1/applications/me  (seeker)
  listMine = (req, res, next) => {
    try {
      const applications = applicationService.listForUser(req.user.sub);
      ok(res, 200, { applications }, { count: applications.length });
    } catch (e) { next(e); }
  };
}

module.exports = new ApplicationController();
