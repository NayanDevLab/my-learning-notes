// src/repositories/application.repository.js
const crypto = require('crypto');
const db = require('../lib/db');

class ApplicationRepository {
  // Enforces the "can't apply twice" rule at the data layer (like a UNIQUE
  // constraint on (job_id, user_id) in SQL).
  findByJobAndUser(jobId, userId) {
    return db.applications.find((a) => a.job_id === jobId && a.user_id === userId) || null;
  }

  findByJob(jobId) {
    return db.applications.filter((a) => a.job_id === jobId);
  }

  findByUser(userId) {
    return db.applications.filter((a) => a.user_id === userId);
  }

  create({ jobId, userId, resumeUrl, coverLetter }) {
    const app = {
      id: crypto.randomUUID(),
      job_id: jobId,
      user_id: userId,
      resume_url: resumeUrl,
      cover_letter: coverLetter || '',
      status: 'applied',
      created_at: new Date().toISOString(),
    };
    db.applications.push(app);
    return app;
  }
}

module.exports = new ApplicationRepository();
