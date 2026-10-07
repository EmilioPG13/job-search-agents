// Prefilter rules, exercised through classify() with an inline profile.
// No model, no network, no personal data.
//
// prefilter.js opens a SQLite database when it is imported (via ../db) and
// prepares statements against the `jobs` table. To keep the test hermetic it
// points DB_PATH at a throwaway file with the real schema applied, instead of
// touching data/jobs.sqlite (which does not exist in CI).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prefilter-test-'));
process.env.DB_PATH = path.join(tmpDir, 'jobs.sqlite');

const setup = new DatabaseSync(process.env.DB_PATH);
setup.exec(fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8'));
setup.close();

const { classify } = require('./prefilter');
const db = require('../db');

test.after(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const junior = {
  targeting: { seniority: 'junior', work_regions_eligible: ['Mexico', 'LATAM', 'United States'] },
};
const anySeniority = {
  targeting: { seniority: 'senior', work_regions_eligible: [] },
};

const job = (overrides) => ({
  title: 'Software Engineer',
  location: 'Remote',
  raw_description: 'Build things.',
  ...overrides,
});

test('keeps a plainly technical title', () => {
  assert.deepEqual(classify(job({ title: 'Backend Developer' }), junior), {
    keep: true,
    reason: null,
  });
});

test('rejects empty and placeholder titles', () => {
  for (const title of ['', '   ', 'Job Title', 'Heading', 'Join us', 'Job Post #123', 'The best team']) {
    const result = classify(job({ title }), junior);
    assert.equal(result.keep, false, `title ${JSON.stringify(title)} should be rejected`);
    assert.equal(result.reason, 'placeholder or non-job listing');
  }
});

test('rejects a non-software role with no technology in the body', () => {
  const result = classify(
    job({ title: 'Marketing Coordinator', raw_description: 'Plan campaigns in the cloud and digital space.' }),
    junior,
  );
  assert.deepEqual(result, { keep: false, reason: 'not a software role' });
});

test('a single passing technology mention does not make a software role', () => {
  const result = classify(
    job({ title: 'Social Media Manager', raw_description: 'We use git to version our brand guidelines.' }),
    anySeniority,
  );
  assert.equal(result.keep, false);
  assert.equal(result.reason, 'not a software role');
});

test('two distinct technologies in the body keep a non-tech title', () => {
  const result = classify(
    job({ title: 'Product Specialist', raw_description: 'You will work with Python and Docker daily.' }),
    anySeniority,
  );
  assert.equal(result.keep, true);
});

test('the same technology repeated does not count as two', () => {
  const result = classify(
    job({ title: 'Product Specialist', raw_description: 'Python, python and PYTHON everywhere.' }),
    anySeniority,
  );
  assert.equal(result.keep, false);
});

test('rejects senior titles when the profile wants junior work', () => {
  for (const title of [
    'Senior Software Engineer',
    'Staff Backend Developer',
    'Engineering Manager (Software)',
    'Head of Engineering',
  ]) {
    const result = classify(job({ title }), junior);
    assert.equal(result.keep, false, title);
    assert.equal(result.reason, 'seniority above target level');
  }
});

test('seniority is ignored when the profile does not want junior work', () => {
  assert.equal(classify(job({ title: 'Senior Software Engineer' }), anySeniority).keep, true);
});

test('a junior signal in the title or description overrides the senior reject', () => {
  assert.equal(classify(job({ title: 'Senior & Junior Software Engineers' }), junior).keep, true);
  assert.equal(
    classify(
      job({ title: 'Senior Software Engineer', raw_description: 'Open to entry-level applicants.' }),
      junior,
    ).keep,
    true,
  );
});

test('rejects a location the candidate cannot work from', () => {
  const result = classify(job({ location: 'Remote, India' }), junior);
  assert.equal(result.keep, false);
  assert.equal(result.reason, 'location not workable: Remote, India');
});

test('keeps bare arrangements and missing locations', () => {
  for (const location of ['Remote', 'Anywhere in the World', 'Worldwide', 'Hybrid', '', '   ', null, undefined]) {
    assert.equal(classify(job({ location }), junior).keep, true, `location ${JSON.stringify(location)}`);
  }
});

test('one eligible place among several is enough', () => {
  assert.equal(classify(job({ location: 'Remote, Brazil; Remote, Germany' }), junior).keep, false);
  assert.equal(
    classify(job({ location: 'Remote, Brazil; Remote, Mexico; Remote, United States' }), junior).keep,
    true,
  );
});

test('location matching ignores accents and case', () => {
  const profile = { targeting: { seniority: 'senior', work_regions_eligible: ['México'] } };
  assert.equal(classify(job({ location: 'MEXICO' }), profile).keep, true);
  assert.equal(classify(job({ location: 'Ciudad de México' }), profile).keep, true);
});

test('an empty or missing eligible-region list disables the location rule', () => {
  assert.equal(classify(job({ location: 'Remote, India' }), anySeniority).keep, true);
  assert.equal(
    classify(job({ location: 'Remote, India' }), { targeting: { seniority: 'senior' } }).keep,
    true,
  );
});

test('rules apply in order: placeholder, then location, then role, then seniority', () => {
  const nonTechSeniorInIndia = job({ title: 'Senior Chef', location: 'India', raw_description: 'Cook.' });
  assert.match(classify(nonTechSeniorInIndia, junior).reason, /^location not workable/);
  assert.equal(
    classify({ ...nonTechSeniorInIndia, location: 'Remote' }, junior).reason,
    'not a software role',
  );
});
