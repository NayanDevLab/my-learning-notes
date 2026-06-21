// src/services/application.service.js
// ---------------------------------------------------------------------------
// Application service — ties together MANY of your notes:
//   - file validation by magic bytes + UUID filename (S3 notes)
//   - UNIQUE(job_id,user_id) double-apply guard → 409 (constraints notes)
//   - background emails off the request path (BullMQ notes)
//   - ownership check so only the employer sees their job's applicants (RBAC)
// ---------------------------------------------------------------------------
const appRepo = require('../repositories/application.repository');
const jobRepo = require('../repositories/job.repository');
const companyRepo = require('../repositories/company.repository');
const userRepo = require('../repositories/user.repository');
const storage = require('../lib/storage');
const { emailQueue } = require('../lib/queue');
const {
  NotFoundError, ForbiddenError, ConflictError, ValidationError,
} = require('../utils/errors');

class ApplicationService {
  apply(userId, jobId, { resumeBuffer, coverLetter }) {
    const job = jobRepo.findById(jobId);
    if (!job) throw new NotFoundError('Job not found');

    // Business rule: one application per user per job.
    if (appRepo.findByJobAndUser(jobId, userId)) {
      throw new ConflictError('You have already applied to this job');
    }

    // Validate the resume by MAGIC BYTES, not the filename/extension.
    if (!resumeBuffer || !storage.isPdf(resumeBuffer)) {
      throw new ValidationError('Resume must be a PDF file');
    }

    // Upload to "S3" (local mock) with a UUID filename.
    const resumeUrl = storage.uploadResume(resumeBuffer);

    const application = appRepo.create({ jobId, userId, resumeUrl, coverLetter });

    // --- Background work: queue emails, DON'T block the response ---
    const applicant = userRepo.findById(userId);
    const company = companyRepo.findById(job.company_id);
    const employer = company ? userRepo.findById(company.owner_id) : null;

    // Email the applicant a confirmation.
    emailQueue.add('application-confirm', {
      to: applicant.email,
      jobTitle: job.title,
    });
    // Email the employer that someone applied.
    if (employer) {
      emailQueue.add('new-application', {
        to: employer.email,
        jobTitle: job.title,
        applicantName: applicant.name,
      });
    }

    return application;
  }

  // Employer views applicants for ONE of their jobs (ownership enforced).
  listForJob(jobId, userId) {
    const job = jobRepo.findById(jobId);
    if (!job) throw new NotFoundError('Job not found');
    const company = companyRepo.findById(job.company_id);
    if (!company || company.owner_id !== userId) {
      throw new ForbiddenError('You can only view applications for your own jobs');
    }
    return appRepo.findByJob(jobId);
  }

  // Seeker views their own applications.
  listForUser(userId) {
    return appRepo.findByUser(userId);
  }
}

module.exports = new ApplicationService();
