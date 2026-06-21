// seed.js
// ---------------------------------------------------------------------------
// Seeds the in-memory database with sample data so you have something to play
// with the instant the server boots (no manual setup). server.js calls
// seedDatabase() on startup.
//
// Because the store is in-memory, this runs in the SAME process as the server.
// It creates one employer, one seeker, a company, and a few jobs, and prints
// the login credentials so you can immediately try the API.
// ---------------------------------------------------------------------------
const bcrypt = require('bcryptjs');
const db = require('./src/lib/db');
const userRepo = require('./src/repositories/user.repository');
const companyRepo = require('./src/repositories/company.repository');
const jobRepo = require('./src/repositories/job.repository');
const config = require('./src/config');
const { log } = require('./src/lib/logger');

const SAMPLE_PASSWORD = 'password123';

function seedDatabase() {
  // Avoid double-seeding if called twice.
  if (db.users.length > 0) return;

  const hash = bcrypt.hashSync(SAMPLE_PASSWORD, config.bcryptCost);

  // --- Users ---
  const employer = userRepo.create({
    email: 'employer@demo.com', passwordHash: hash, role: 'employer', name: 'Priya Sharma',
  });
  const seeker = userRepo.create({
    email: 'seeker@demo.com', passwordHash: hash, role: 'seeker', name: 'Nayan Patel',
  });

  // --- Company (owned by the employer) ---
  const company = companyRepo.create({
    ownerId: employer.id,
    name: 'TechCorp India',
    description: 'A fast-growing product company building developer tools.',
  });

  // --- Jobs (varied so filters + pagination are visible) ---
  const jobSeeds = [
    { title: 'Senior Frontend Engineer', location: 'Bangalore', type: 'hybrid', minSalary: 35, description: 'React, TypeScript, Next.js. Build our core dashboard.' },
    { title: 'Backend Engineer (Node.js)', location: 'Remote', type: 'remote', minSalary: 30, description: 'Node, Postgres, Redis. Own our API platform.' },
    { title: 'Full Stack Developer', location: 'Mumbai', type: 'onsite', minSalary: 25, description: 'End-to-end features across our web app.' },
    { title: 'React Native Engineer', location: 'Bangalore', type: 'remote', minSalary: 28, description: 'Ship our mobile app with Expo + React Native.' },
    { title: 'Platform Engineer', location: 'Remote', type: 'remote', minSalary: 40, description: 'Kubernetes, CI/CD, observability. Keep us scaling.' },
  ];

  jobSeeds.forEach((j, i) => {
    const job = jobRepo.create({ companyId: company.id, ...j });
    // Space out created_at by a minute each (newest last in this loop) so the
    // newest-first ordering + cursor pagination is clear and deterministic.
    const t = new Date(Date.now() - (jobSeeds.length - i) * 60_000);
    job.created_at = t.toISOString();
  });

  log('info', 'database seeded', {
    users: db.users.length, companies: db.companies.length, jobs: db.jobs.length,
  });
}

module.exports = { seedDatabase, SAMPLE_PASSWORD };

// If run directly (`npm run seed`), seed and print the credentials. Note: this
// only populates THIS process's memory; normally seeding happens on server boot.
if (require.main === module) {
  seedDatabase();
  console.log('\nSample data seeded (in-memory). Login credentials:');
  console.log('  Employer →  employer@demo.com  /  password123');
  console.log('  Seeker   →  seeker@demo.com    /  password123');
  console.log('\n(Run `npm start` to launch the API — it seeds automatically on boot.)\n');
}
