// smoke-test.js
// ---------------------------------------------------------------------------
// End-to-end smoke test. Boots the real app on a test port and drives the
// whole flow with HTTP requests (using Node's built-in fetch), asserting the
// right status codes at each step. This is how you VERIFY the API actually
// works end-to-end — register → login → company → job → list → apply → view,
// plus a few error cases (403, 409, 401).
//
// Run with: npm run smoke
// ---------------------------------------------------------------------------
const app = require('./src/app');

const PORT = 4100;
const BASE = `http://localhost:${PORT}`;

// A minimal valid "PDF": the magic-bytes check only needs the %PDF header.
const RESUME_B64 = Buffer.from('%PDF-1.4\n% fake resume for testing\n').toString('base64');

let passed = 0;
let failed = 0;

function check(name, cond, detail = '') {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name} ${detail ? '→ ' + detail : ''}`);
  }
}

// Tiny fetch wrapper. Returns { status, json, cookie }.
async function api(method, path, { token, body, cookie } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* 204 no content */ }
  return { status: res.status, json, cookie: res.headers.get('set-cookie') };
}

async function run() {
  console.log('\n🧪 Running smoke test...\n');

  // 1. Register an employer
  const empEmail = `emp_${Date.now()}@test.com`;
  let r = await api('POST', '/v1/auth/register', {
    body: { email: empEmail, password: 'password123', name: 'Test Employer', role: 'employer' },
  });
  check('register employer → 201', r.status === 201, `got ${r.status}`);

  // 2. Login as employer (captures the refresh cookie + access token)
  r = await api('POST', '/v1/auth/login', { body: { email: empEmail, password: 'password123' } });
  check('login employer → 200', r.status === 200, `got ${r.status}`);
  const empToken = r.json?.data?.accessToken;
  const empCookie = r.cookie;
  check('login returns access token', !!empToken);
  check('login sets refresh cookie', !!empCookie);

  // 3. /me with the access token
  r = await api('GET', '/v1/auth/me', { token: empToken });
  check('GET /me → 200', r.status === 200, `got ${r.status}`);
  check('/me returns correct email', r.json?.data?.user?.email === empEmail);

  // 4. /me WITHOUT a token → 401
  r = await api('GET', '/v1/auth/me');
  check('GET /me without token → 401', r.status === 401, `got ${r.status}`);

  // 5. Create a company (as employer)
  r = await api('POST', '/v1/companies', {
    token: empToken,
    body: { name: 'Test Co', description: 'testing' },
  });
  check('create company → 201', r.status === 201, `got ${r.status}`);
  const companyId = r.json?.data?.company?.id;

  // 6. Create a job (as employer, owns the company)
  r = await api('POST', '/v1/jobs', {
    token: empToken,
    body: { companyId, title: 'Smoke Test Engineer', location: 'Remote', type: 'remote', minSalary: 30, description: 'A job created by the smoke test.' },
  });
  check('create job → 201', r.status === 201, `got ${r.status}`);
  const jobId = r.json?.data?.job?.id;

  // 7. List jobs (public) — cursor pagination + meta
  r = await api('GET', '/v1/jobs?limit=3');
  check('list jobs → 200', r.status === 200, `got ${r.status}`);
  check('list returns jobs array', Array.isArray(r.json?.data?.jobs));
  check('list has nextCursor in meta', 'nextCursor' in (r.json?.meta || {}));

  // 8. Filter jobs by type=remote
  r = await api('GET', '/v1/jobs?type=remote&limit=50');
  check('filter type=remote → 200', r.status === 200, `got ${r.status}`);
  check('all filtered jobs are remote', (r.json?.data?.jobs || []).every((j) => j.type === 'remote'));

  // 9. Register + login a seeker
  const seekEmail = `seek_${Date.now()}@test.com`;
  await api('POST', '/v1/auth/register', {
    body: { email: seekEmail, password: 'password123', name: 'Test Seeker', role: 'seeker' },
  });
  r = await api('POST', '/v1/auth/login', { body: { email: seekEmail, password: 'password123' } });
  const seekToken = r.json?.data?.accessToken;
  check('login seeker → 200', r.status === 200, `got ${r.status}`);

  // 10. Seeker tries to create a job → 403 (RBAC: employers only)
  r = await api('POST', '/v1/jobs', {
    token: seekToken,
    body: { companyId, title: 'Nope', description: 'should be forbidden' },
  });
  check('seeker create job → 403', r.status === 403, `got ${r.status}`);

  // 11. Seeker applies to the job → 201
  r = await api('POST', `/v1/jobs/${jobId}/apply`, {
    token: seekToken,
    body: { resumeBase64: RESUME_B64, coverLetter: 'Please hire me!' },
  });
  check('seeker applies → 201', r.status === 201, `got ${r.status}`);

  // 12. Seeker applies AGAIN → 409 (double-apply guard)
  r = await api('POST', `/v1/jobs/${jobId}/apply`, {
    token: seekToken,
    body: { resumeBase64: RESUME_B64 },
  });
  check('double apply → 409', r.status === 409, `got ${r.status}`);

  // 13. Apply with a NON-pdf resume → 422 (magic-byte validation)
  const seek2 = `seek2_${Date.now()}@test.com`;
  await api('POST', '/v1/auth/register', { body: { email: seek2, password: 'password123', name: 'S2', role: 'seeker' } });
  const s2 = (await api('POST', '/v1/auth/login', { body: { email: seek2, password: 'password123' } })).json?.data?.accessToken;
  r = await api('POST', `/v1/jobs/${jobId}/apply`, {
    token: s2,
    body: { resumeBase64: Buffer.from('not a pdf').toString('base64') },
  });
  check('non-PDF resume → 422', r.status === 422, `got ${r.status}`);

  // 14. Employer views applications for their job → 200
  r = await api('GET', `/v1/jobs/${jobId}/applications`, { token: empToken });
  check('employer views applicants → 200', r.status === 200, `got ${r.status}`);
  check('one applicant present', (r.json?.data?.applications || []).length === 1);

  // 15. Seeker views their own applications → 200
  r = await api('GET', '/v1/applications/me', { token: seekToken });
  check('seeker views own applications → 200', r.status === 200, `got ${r.status}`);

  // 16. Refresh token rotation
  r = await api('POST', '/v1/auth/refresh', { cookie: empCookie });
  check('refresh → 200', r.status === 200, `got ${r.status}`);
  check('refresh returns new access token', !!r.json?.data?.accessToken);

  // 17. Logout → 204
  r = await api('POST', '/v1/auth/logout', { cookie: empCookie });
  check('logout → 204', r.status === 204, `got ${r.status}`);

  // 18. Login validation: bad email → 422
  r = await api('POST', '/v1/auth/login', { body: { email: 'not-an-email', password: 'x' } });
  check('invalid email → 422', r.status === 422, `got ${r.status}`);

  // 19. Wrong password → 401
  r = await api('POST', '/v1/auth/login', { body: { email: empEmail, password: 'wrongpass' } });
  check('wrong password → 401', r.status === 401, `got ${r.status}`);

  // 20. Unknown route → 404
  r = await api('GET', '/v1/nonexistent');
  check('unknown route → 404', r.status === 404, `got ${r.status}`);

  // Give the queued background emails a moment to "send" (logs).
  await new Promise((res) => setTimeout(res, 300));

  console.log(`\n${failed === 0 ? '🎉' : '⚠️ '} Smoke test complete: ${passed} passed, ${failed} failed.\n`);
  return failed === 0;
}

const server = app.listen(PORT, async () => {
  let ok = false;
  try {
    ok = await run();
  } catch (err) {
    console.error('\n💥 Smoke test crashed:', err);
    ok = false;
  } finally {
    server.close();
    process.exit(ok ? 0 : 1);
  }
});
