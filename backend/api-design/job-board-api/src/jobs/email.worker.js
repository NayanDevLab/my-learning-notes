// src/jobs/email.worker.js
// ---------------------------------------------------------------------------
// The "worker" half of the background-jobs system — see your "BullMQ Background
// Jobs" notes. It registers handlers for each job name on the shared queue.
//
// In real BullMQ this would be a SEPARATE process (`node worker.js`) connected
// to Redis, so it scales independently of the API. Here it runs in-process for
// zero-setup learning, but the pattern is identical: the API queues a job and
// responds immediately; these handlers do the slow work (sending email) later,
// off the request path.
//
// For the demo, "sending an email" just logs a line. Swap in Nodemailer (or
// SES/Resend/etc.) for the real thing — nothing else changes.
// ---------------------------------------------------------------------------
const { emailQueue } = require('../lib/queue');
const { log } = require('../lib/logger');

// Pretend to send an email (replace with Nodemailer in production).
function sendEmail(to, subject, body) {
  log('info', '📧 email sent (mock)', { to, subject, body });
}

function registerEmailHandlers() {
  // Sent to the applicant right after they apply.
  emailQueue.process('application-confirm', async (job) => {
    const { to, jobTitle } = job.data;
    sendEmail(to, 'Application received ✅', `Your application for "${jobTitle}" was received.`);
  });

  // Sent to the employer when someone applies to their job.
  emailQueue.process('new-application', async (job) => {
    const { to, jobTitle, applicantName } = job.data;
    sendEmail(to, 'New applicant 🎉', `${applicantName} applied to your job "${jobTitle}".`);
  });

  // A scheduled digest of new jobs (in real BullMQ this is a repeatable cron
  // job: { repeat: { pattern: '0 9 * * *' } }). Wired here for completeness.
  emailQueue.process('daily-digest', async (job) => {
    const { to, count } = job.data;
    sendEmail(to, 'Your daily job digest 📰', `${count} new jobs match your saved searches.`);
  });

  log('info', 'email worker ready (handlers registered)');
}

module.exports = { registerEmailHandlers };
