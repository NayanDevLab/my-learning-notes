// src/lib/queue.js
// ---------------------------------------------------------------------------
// A tiny IN-PROCESS job queue that mimics BullMQ — see your "BullMQ Background
// Jobs" notes. It demonstrates the SAME concepts without needing Redis:
//   - producer adds jobs   (queue.add)
//   - a worker consumes them asynchronously   (queue.process)
//   - failed jobs RETRY with exponential backoff
//   - jobs that fail all attempts go to a "dead letter" list
//
// 🎓 LEARNING NOTE: In production you'd use real BullMQ + Redis so jobs survive
// restarts and workers can scale across servers. The KEY idea is identical:
// the API responds immediately and the slow work (emails) happens in the
// background, off the request path.
// ---------------------------------------------------------------------------
const { log } = require('./logger');

class SimpleQueue {
  constructor(name) {
    this.name = name;
    this.handlers = {}; // jobName -> async function
    this.deadLetter = []; // jobs that failed all retries
  }

  // Register how to process a given job name (this is the "worker").
  process(jobName, handler) {
    this.handlers[jobName] = handler;
  }

  // Add a job to the queue (the "producer"). Returns immediately — the work
  // runs on the next tick, so it never blocks the HTTP response.
  add(jobName, data, opts = {}) {
    const attempts = opts.attempts || 3;
    const baseDelay = opts.backoff || 200; // ms
    const job = { id: Math.random().toString(36).slice(2, 9), name: jobName, data };

    // setImmediate => runs AFTER the current request finishes responding.
    setImmediate(() => this._run(job, attempts, baseDelay, 1));
    return job;
  }

  async _run(job, attempts, baseDelay, tryNumber) {
    const handler = this.handlers[job.name];
    if (!handler) {
      log('warn', `No handler for job "${job.name}"`);
      return;
    }
    try {
      await handler(job);
      log('info', `job done: ${job.name}#${job.id} (attempt ${tryNumber})`);
    } catch (err) {
      if (tryNumber < attempts) {
        // Exponential backoff: wait longer each retry (1x, 2x, 4x...).
        const delay = baseDelay * Math.pow(2, tryNumber - 1);
        log('warn', `job failed: ${job.name}#${job.id} (attempt ${tryNumber}) — retrying in ${delay}ms`);
        setTimeout(() => this._run(job, attempts, baseDelay, tryNumber + 1), delay);
      } else {
        // All retries exhausted => dead letter (kept for inspection).
        log('error', `job DEAD: ${job.name}#${job.id} failed all ${attempts} attempts — ${err.message}`);
        this.deadLetter.push({ job, error: err.message });
      }
    }
  }
}

// One shared queue for emails (like a single Redis-backed queue).
const emailQueue = new SimpleQueue('emails');

module.exports = { emailQueue };
