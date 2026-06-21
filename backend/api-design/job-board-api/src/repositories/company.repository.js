// src/repositories/company.repository.js
const crypto = require('crypto');
const db = require('../lib/db');

class CompanyRepository {
  findById(id) {
    return db.companies.find((c) => c.id === id) || null;
  }

  findByOwner(ownerId) {
    return db.companies.filter((c) => c.owner_id === ownerId);
  }

  create({ ownerId, name, description }) {
    const company = {
      id: crypto.randomUUID(),
      owner_id: ownerId,
      name,
      description: description || '',
      created_at: new Date().toISOString(),
    };
    db.companies.push(company);
    return company;
  }

  update(id, fields) {
    const company = this.findById(id);
    if (!company) return null;
    Object.assign(company, fields);
    return company;
  }

  delete(id) {
    const idx = db.companies.findIndex((c) => c.id === id);
    if (idx === -1) return false;
    db.companies.splice(idx, 1);
    return true;
  }
}

module.exports = new CompanyRepository();
