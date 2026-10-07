// Parser tests run against the real tailored CVs in the database rather than
// fixtures. The parser's whole job is to cope with what the model actually
// emits, so a fixture written by hand would only prove the parser agrees with
// its author. Skips cleanly when the database has nothing verified yet.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { parseTailoredCv, renderCv, levelWidth } = require('./cvLayout');

const DB_PATH = path.join(__dirname, '../../data/jobs.sqlite');

// The CV templates and the personal CV text live in data/, which is gitignored
// (they carry real contact details). On a clean checkout they do not exist, so
// the tests that need them skip instead of failing.
function privateFile(t, name) {
  const file = path.join(__dirname, '../../data', name);
  if (!fs.existsSync(file)) {
    t.skip(`data/${name} is gitignored and not present`);
    return null;
  }
  return fs.readFileSync(file, 'utf8');
}

function tailoredCvs() {
  if (!fs.existsSync(DB_PATH)) return [];
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(DB_PATH);
  return db
    .prepare(
      `SELECT id, company, tailored_resume FROM jobs
       WHERE tailored_resume IS NOT NULL AND verification_passed = 1
       ORDER BY id`,
    )
    .all();
}

const rows = tailoredCvs();

test('there is something to test against', (t) => {
  if (rows.length === 0) return t.skip('no verified CVs in the database yet');
  assert.ok(rows.length > 0);
});

for (const row of rows) {
  test(`#${row.id} (${row.company}) parses into every section`, () => {
    const cv = parseTailoredCv(row.tailored_resume);

    assert.ok(cv.name, 'name');
    assert.ok(cv.tagline, 'tagline');
    assert.ok(cv.contact.length > 0, 'contact lines');
    assert.ok(cv.profile.length > 80, 'profile paragraph');
    assert.ok(cv.skills.length >= 3, 'skill groups');
    assert.ok(cv.projects.length >= 2, 'projects');
    assert.ok(cv.experience.length >= 1, 'roles');
    assert.ok(cv.education.length >= 1, 'education');
    assert.ok(cv.languages.length >= 2, 'languages');

    for (const p of cv.projects) {
      assert.ok(p.name, `project name in #${row.id}`);
      assert.ok(
        p.description || p.bullets.length,
        `project body for "${p.name}" in #${row.id}`,
      );
      // A stranded "- " means bullets were flattened into prose.
      assert.doesNotMatch(
        p.description,
        /(^|\s)[-•*]\s/,
        `project description for "${p.name}" in #${row.id} has a stray bullet mark`,
      );
    }
    for (const r of cv.experience) {
      assert.ok(r.title, `role title in #${row.id}`);
    }
    for (const g of cv.skills) {
      assert.ok(g.items.length > 0, `skill items for "${g.label}" in #${row.id}`);
    }
  });

  test(`#${row.id} renders with no markers left behind`, (t) => {
    const parsed = parseTailoredCv(row.tailored_resume);
    const template = privateFile(t, `cv-template-${parsed.language}.html`);
    if (template === null) return;
    const html = renderCv(parsed, template);

    assert.doesNotMatch(html, /\{\{[A-Z_]+\}\}/, 'no unfilled markers');
    assert.ok(html.includes(parsed.profile.slice(0, 60).replace(/&/g, '&amp;')), 'profile is present');
    assert.ok(html.startsWith('<!DOCTYPE html>'), 'is a document');
  });
}

test('a missing section throws rather than rendering a gap', () => {
  const truncated = 'Daniel Navarro\nDEVELOPER\n\nPROFILE\nSomething.\n';
  assert.throws(() => parseTailoredCv(truncated), /missing section/i);
});

test('empty input throws', () => {
  assert.throws(() => parseTailoredCv(''), /empty/i);
});

test('a section present but empty is rejected', () => {
  const hollow = [
    'Daniel Navarro', 'DEVELOPER', '',
    'PROFILE', '', 'TECHNICAL SKILLS', '', 'PROJECTS', '',
    'WORK EXPERIENCE', '', 'EDUCATION', '', 'LANGUAGES', '',
  ].join('\n');
  assert.throws(() => parseTailoredCv(hollow), /empty|missing/i);
});

test('Spanish headings are recognised', () => {
  const es = [
    'Daniel Navarro González', 'DESARROLLADOR', 'correo@example.com', '',
    'PERFIL PROFESIONAL',
    'Desarrollador full-stack con dos años de experiencia práctica construyendo aplicaciones web con React y TypeScript en todo el stack.', '',
    'HABILIDADES TÉCNICAS', 'Lenguajes: JavaScript, TypeScript', 'Pruebas: Vitest', 'Bases de Datos: PostgreSQL', '',
    'PROYECTOS', 'Larsen Italiana', 'React · TypeScript', 'Sitio full-stack de marketing.', '',
    'E-commerce API', 'Node.js · Express', 'Plataforma e-commerce full-stack.', '',
    'EXPERIENCIA LABORAL', 'Intérprete Médico — Brightwater Interpreting Services', 'Abr 2019 – Jul 2026', '- Interpretación inglés–español remota.', '',
    'EDUCACIÓN', 'Lic. en Mercadotecnia — Universidad del Valle Central · Guadalajara', '',
    'IDIOMAS', 'Español — Nativo', 'Inglés — C2 · Casi Nativo',
  ].join('\n');

  const cv = parseTailoredCv(es);
  assert.equal(cv.language, 'es');
  assert.equal(cv.headings.profile, 'PERFIL PROFESIONAL');
  assert.equal(cv.languages[0].name, 'Español');
  assert.equal(cv.languages[0].level, 'Nativo');
  assert.equal(cv.experience[0].title, 'Intérprete Médico');
  assert.equal(cv.projects.length, 2);
});

test('the model\'s misspelled Spanish skills heading is accepted and corrected', (t) => {
  // The tailoring model emits "HABILIDADES TÉNICAS" on every Spanish run. It has
  // to parse, and it must not reach the rendered page.
  const es = [
    'Daniel Navarro González', 'DESARROLLADOR', 'correo@example.com', '',
    'PERFIL PROFESIONAL', 'Desarrollador full-stack con dos años de experiencia práctica construyendo aplicaciones web en todo el stack.', '',
    'HABILIDADES TÉNICAS', 'Lenguajes: JavaScript, TypeScript', '',
    'PROYECTOS', 'Larsen', 'React · TypeScript', 'Sitio de marketing.', '',
    'EXPERIENCIA LABORAL', 'Intérprete — LSA', 'Abr 2019 – Jul 2026', '- Interpretación remota.', '',
    'EDUCACIÓN', 'Lic. en Mercadotecnia — Universidad del Valle Central', '',
    'IDIOMAS', 'Español — Nativo', 'Inglés — C2',
  ].join('\n');

  const cv = parseTailoredCv(es);
  assert.equal(cv.headings.skills, 'HABILIDADES TÉCNICAS', 'renders the correct spelling');
  assert.ok(
    cv.headingCorrections.some((c) => c.includes('TÉNICAS')),
    'and reports the correction rather than making it silently',
  );

  const template = privateFile(t, 'cv-template-es.html');
  if (template === null) return;
  const html = renderCv(cv, template);
  assert.ok(!html.includes('TÉNICAS'), 'the typo must not reach the page');
  assert.ok(html.includes('HABILIDADES TÉCNICAS'));
});

test('education splits per qualification even without blank lines between them', () => {
  // The model runs the entries together. Splitting on blank lines alone put
  // every degree in one entry, and the bootcamp got rendered as the degree's
  // institution.
  const cv = parseTailoredCv(
    [
      'A B', 'DEV', 'a@b.com', '',
      'PROFILE', 'A full-stack developer with two years of hands-on experience building things.', '',
      'TECHNICAL SKILLS', 'Languages: JavaScript', '',
      'PROJECTS', 'P', 'React · Vite', 'Did a thing.', '',
      'WORK EXPERIENCE', 'Role — Employer', '2019 – 2026', '- Did work.', '',
      'EDUCATION',
      'B.S. Marketing — Universidad del Valle Central · Guadalajara · Graduating 2026',
      'Specialization: Digital Marketing & Market Research',
      'Web Development Bootcamp — Northgate Web Bootcamp · Mexico City',
      'Oct 2021 – Oct 2022',
      'Full-stack curriculum: JavaScript, Node.js',
      '',
      'LANGUAGES', 'Spanish — Native', 'English — C2',
    ].join('\n'),
  );

  assert.equal(cv.education.length, 2, 'two qualifications');
  assert.match(cv.education[0][0], /^B\.S\. Marketing/);
  assert.match(cv.education[1][0], /^Web Development Bootcamp/);

  // A date range must not be mistaken for a new qualification.
  assert.ok(cv.education[1].includes('Oct 2021 – Oct 2022'));
});

test('contact items each get their own line', (t) => {
  // Two packed lines from the model became a crowded block that wrapped the
  // LinkedIn URL mid-word and pushed the tagline onto a second line.
  const parsed = {
    name: 'A B', tagline: 'T',
    contact: [
      'daniel@example.com (555) 010-4477 · Guadalajara, México',
      'github.com/danielnavarro linkedin.com/in/daniel-navarro',
    ],
    headings: { profile: 'PROFILE', skills: 'S', projects: 'P', experience: 'W', education: 'E', languages: 'L' },
    profile: 'x', skills: [{ label: 'L', items: ['JS'] }],
    projects: [{ name: 'P', stack: '', links: '', description: 'd' }],
    experience: [{ title: 'T', org: '', dates: '', bullets: [] }],
    education: [['School']], languages: [{ name: 'Spanish', level: 'Native' }],
  };
  const template = privateFile(t, 'cv-template-en.html');
  if (template === null) return;
  const html = renderCv(parsed, template);
  const block = html.split('<div class="contact">')[1].split('</div>')[0];

  assert.equal((block.match(/<br>/g) || []).length, 3, 'four lines, so three breaks');
  assert.ok(block.includes('daniel@example.com'));
  assert.ok(block.includes('href="https://github.com/danielnavarro"'), 'URLs become links');
  assert.ok(block.includes('(555) 010-4477 · Guadalajara, México'), 'phone and location stay together');
});

test('language bar widths follow the stated level', () => {
  assert.equal(levelWidth('Native'), 100);
  assert.equal(levelWidth('Nativo'), 100);
  assert.equal(levelWidth('C2 · Near Native'), 100); // "Native" wins, as it should
  assert.equal(levelWidth('C1'), 82);
  assert.equal(levelWidth('B1'), 55);
});

test('CV text containing HTML is escaped, not injected', (t) => {
  const parsed = {
    name: 'A B', tagline: 'T', contact: ['x@y.com'],
    headings: { profile: 'PROFILE', skills: 'SKILLS', projects: 'PROJECTS', experience: 'WORK', education: 'EDU', languages: 'LANG' },
    profile: 'Built <script>alert(1)</script> tooling & more',
    skills: [{ label: 'Languages', items: ['C++'] }],
    projects: [{ name: 'P', stack: '', links: '', description: 'A & B' }],
    experience: [{ title: 'T', org: '', dates: '', bullets: ['did <b>things</b>'] }],
    education: [['School']],
    languages: [{ name: 'Spanish', level: 'Native' }],
  };
  const template = privateFile(t, 'cv-template-en.html');
  if (template === null) return;
  const html = renderCv(parsed, template);

  assert.ok(!html.includes('<script>alert(1)</script>'), 'script tag must not survive');
  assert.ok(html.includes('&lt;script&gt;'), 'it should appear escaped instead');
  assert.ok(html.includes('A &amp; B'));
});
