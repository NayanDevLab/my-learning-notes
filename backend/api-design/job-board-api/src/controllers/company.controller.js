// src/controllers/company.controller.js
const companyService = require('../services/company.service');
const { ok } = require('../utils/envelope');

class CompanyController {
  create = (req, res, next) => {
    try {
      const company = companyService.create(req.user.sub, req.body);
      ok(res, 201, { company });
    } catch (e) { next(e); }
  };

  getById = (req, res, next) => {
    try {
      const company = companyService.getById(req.params.id);
      ok(res, 200, { company });
    } catch (e) { next(e); }
  };

  update = (req, res, next) => {
    try {
      const company = companyService.update(req.params.id, req.user.sub, req.body);
      ok(res, 200, { company });
    } catch (e) { next(e); }
  };

  remove = (req, res, next) => {
    try {
      companyService.delete(req.params.id, req.user.sub);
      res.status(204).send();
    } catch (e) { next(e); }
  };
}

module.exports = new CompanyController();
