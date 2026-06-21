// src/services/company.service.js
const companyRepo = require('../repositories/company.repository');
const { NotFoundError, ForbiddenError } = require('../utils/errors');

class CompanyService {
  create(ownerId, { name, description }) {
    return companyRepo.create({ ownerId, name, description });
  }

  getById(id) {
    const company = companyRepo.findById(id);
    if (!company) throw new NotFoundError('Company not found');
    return company;
  }

  // Ownership check lives in the service: only the owner can change it.
  update(id, userId, fields) {
    const company = this.getById(id);
    if (company.owner_id !== userId) {
      throw new ForbiddenError('You do not own this company');
    }
    return companyRepo.update(id, fields);
  }

  delete(id, userId) {
    const company = this.getById(id);
    if (company.owner_id !== userId) {
      throw new ForbiddenError('You do not own this company');
    }
    companyRepo.delete(id);
  }
}

module.exports = new CompanyService();
