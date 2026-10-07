// Turn a verified tailored CV back into the candidate's own design.
//
// The verifier audits `tailored_resume` as plain text. Whatever reaches the PDF
// therefore has to be that same text, unchanged — if anything rewrites or
// reorders it on the way to the page, the check that makes this pipeline
// trustworthy no longer describes what an employer receives. So this is string
// handling, not a model call: parse the sections, drop them into the template.
//
// The structure is stable because the tailoring prompt requires it ("Preserve
// ALL section headings exactly as they appear in the original CV"), and every
// tailored CV produced so far follows the base CV's shape:
//
//   <name> / <tagline> / <contact lines>
//   PROFILE            one paragraph
//   TECHNICAL SKILLS   "Category: a, b, c" per line
//   PROJECTS           name / stack / links / description, repeated
//   WORK EXPERIENCE    title — org / dates / "- " bullets
//   EDUCATION          free lines
//   LANGUAGES          "Spanish — Native"
//
// When that shape does not hold, this throws. A CV with a blank profile is
// worse than no CV: the export step can fall back to plain text and say so,
// whereas a silently malformed PDF gets sent to an employer.

// Headings are matched in both languages because the Spanish CV is a real
// output path, not a translation of an English one.
//
// The Spanish skills pattern tolerates a missing C. The tailoring model emits
// "HABILIDADES TÉNICAS" every time despite being told to preserve headings
// exactly, and a parser that rejects the model's actual output is a parser that
// never runs. See `canonical` below for why the typo cannot reach the page.
const SECTIONS = [
  { key: 'profile',    en: 'PROFILE',          es: 'PERFIL PROFESIONAL',
    patterns: { en: [/^PROFILE$/i],                es: [/^PERFIL(\s+PROFESIONAL)?$/i] } },
  { key: 'skills',     en: 'TECHNICAL SKILLS',  es: 'HABILIDADES TÉCNICAS',
    patterns: { en: [/^TECHNICAL\s+SKILLS$/i],     es: [/^HABILIDADES\s+T[ÉE]C?NICAS$/i] } },
  { key: 'projects',   en: 'PROJECTS',          es: 'PROYECTOS',
    patterns: { en: [/^PROJECTS$/i],               es: [/^PROYECTOS$/i] } },
  { key: 'experience', en: 'WORK EXPERIENCE',   es: 'EXPERIENCIA LABORAL',
    patterns: { en: [/^WORK\s+EXPERIENCE$/i],      es: [/^EXPERIENCIA\s+LABORAL$/i] } },
  { key: 'education',  en: 'EDUCATION',         es: 'EDUCACIÓN',
    patterns: { en: [/^EDUCATION$/i],              es: [/^EDUCACI[ÓO]N$/i] } },
  { key: 'languages',  en: 'LANGUAGES',         es: 'IDIOMAS',
    patterns: { en: [/^LANGUAGES$/i],              es: [/^IDIOMAS$/i] } },
];

const REQUIRED = ['profile', 'skills', 'projects', 'experience', 'education', 'languages'];

// The model emits trailing double-spaces as soft line breaks; they are noise here.
const clean = (line) => line.replace(/\s+$/, '').trim();

const escapeHtml = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

function headingMatch(line) {
  const t = clean(line);
  if (!t || t.length > 40) return null;
  for (const section of SECTIONS) {
    for (const lang of ['en', 'es']) {
      if (section.patterns[lang].some((p) => p.test(t))) return { key: section.key, lang };
    }
  }
  return null;
}

/** Split the document into its headed sections, plus everything above the first one. */
function splitSections(text) {
  const lines = String(text ?? '').split('\n');
  const header = [];
  const sections = {};
  const votes = { en: 0, es: 0 };
  let current = null;

  for (const raw of lines) {
    const match = headingMatch(raw);
    if (match) {
      current = match.key;
      votes[match.lang]++;
      sections[match.key] = { heading: clean(raw), lang: match.lang, lines: [] };
      continue;
    }
    const line = clean(raw);
    if (current === null) {
      if (line) header.push(line);
    } else {
      sections[current].lines.push(line);
    }
  }

  // The document's own headings decide its language — a more direct signal than
  // re-deriving it from the job description, and it cannot disagree with the
  // text actually being rendered.
  const language = votes.es > votes.en ? 'es' : 'en';

  return { header, sections, language };
}

/** Drop leading/trailing blank lines, keeping the blanks that separate blocks. */
const trimBlanks = (lines) => {
  let a = 0;
  let b = lines.length;
  while (a < b && !lines[a]) a++;
  while (b > a && !lines[b - 1]) b--;
  return lines.slice(a, b);
};

/** Group lines into blocks separated by one or more blank lines. */
function blocks(lines) {
  const out = [];
  let block = [];
  for (const line of lines) {
    if (line) block.push(line);
    else if (block.length) {
      out.push(block);
      block = [];
    }
  }
  if (block.length) out.push(block);
  return out;
}

// A stack line is the technology list under a project name: short, and mostly
// separators. Matching on the separator rather than on known tool names keeps
// this from needing a vocabulary that would go stale.
const looksLikeStack = (line) => /[·|]/.test(line) && line.length < 160 && !/^https?:/i.test(line);
const looksLikeLink = (line) => /github\.com|https?:\/\/|\.com\b|\.dev\b|Live |Deployed |Desplegado /i.test(line);

/**
 * One project: a name, an optional stack line, an optional links line, and a
 * description. The order is fixed by the base CV, so position does the work.
 */
function parseProject(block) {
  const [name, ...rest] = block;
  let stack = '';
  let links = '';
  const desc = [];

  for (const line of rest) {
    if (!stack && !desc.length && looksLikeStack(line)) stack = line;
    else if (!links && !desc.length && looksLikeLink(line)) links = line;
    else desc.push(line);
  }

  // The model writes project descriptions as prose in English and as bullets in
  // Spanish. Joining bullets into a paragraph left literal "-" marks stranded
  // mid-sentence, so they are kept as bullets and rendered as a list.
  const bulleted = desc.filter((l) => /^[-•*]\s+/.test(l));
  if (bulleted.length && bulleted.length === desc.length) {
    return {
      name,
      stack,
      links,
      description: '',
      bullets: desc.map((l) => l.replace(/^[-•*]\s+/, '')),
    };
  }

  return { name, stack, links, description: desc.join(' '), bullets: [] };
}

/**
 * One role: a title line (often "Title — Employer"), an optional date line, and
 * bullets. Bullets are the lines opening with a bullet symbol; the prompt tells
 * the model to keep whichever symbol the source CV used.
 */
function parseRole(block) {
  const bulletAt = block.findIndex((l) => /^[-•*]\s+/.test(l));
  const head = bulletAt === -1 ? block : block.slice(0, bulletAt);
  const bullets = (bulletAt === -1 ? [] : block.slice(bulletAt))
    .filter((l) => /^[-•*]\s+/.test(l))
    .map((l) => l.replace(/^[-•*]\s+/, ''));

  const [titleLine, ...restHead] = head;
  const emdash = titleLine.split(/\s+—\s+|\s+–\s+|\s+-\s+/);

  // A date line is mostly digits and a range; anything else stays with the org.
  const dateIdx = restHead.findIndex((l) => /\d{4}/.test(l) && l.length < 40);

  return {
    title: emdash[0].trim(),
    org: emdash.length > 1 ? emdash.slice(1).join(' — ').trim() : (dateIdx === 0 ? '' : restHead[0] || ''),
    dates: dateIdx >= 0 ? restHead[dateIdx] : '',
    bullets,
  };
}

// A qualification line names the award and the institution, separated by an
// em dash: "B.S. Marketing — Universidad del Valle Central · Guadalajara". A date range uses an
// en dash instead ("Oct 2021 – Oct 2022"), which is what keeps the two apart.
const DATE_RANGE = /^[A-Za-zÁÉÍÓÚáéíóúñ.]*\s*\d{4}\s*[–-]\s*[A-Za-zÁÉÍÓÚáéíóúñ.]*\s*\d{4}/;
const startsQualification = (line) => / — /.test(line) && !DATE_RANGE.test(line);

/**
 * Education entries, which the model runs together without blank lines between
 * them. Splitting on blank lines alone produced one entry containing every
 * degree, so the second qualification got rendered as the first one's
 * institution. Blank lines still split when present; a qualification line
 * starts a new entry either way.
 */
function parseEducation(lines) {
  const entries = [];
  let entry = [];

  for (const block of blocks(trimBlanks(lines))) {
    for (const line of block) {
      if (entry.length && startsQualification(line)) {
        entries.push(entry);
        entry = [];
      }
      entry.push(line);
    }
    if (entry.length) {
      entries.push(entry);
      entry = [];
    }
  }
  if (entry.length) entries.push(entry);

  return entries;
}

/** "Category: a, b, c" → { label, items }. A line without a colon is its own item. */
function parseSkillGroups(lines) {
  return trimBlanks(lines)
    .filter(Boolean)
    .map((line) => {
      const idx = line.indexOf(':');
      if (idx === -1) return { label: '', items: [line.trim()] };
      return {
        label: line.slice(0, idx).trim(),
        items: line.slice(idx + 1).split(',').map((s) => s.trim()).filter(Boolean),
      };
    });
}

/** "Spanish — Native" → { name, level }. */
function parseLanguages(lines) {
  return trimBlanks(lines)
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(/\s+—\s+|\s+–\s+|\s+-\s+/);
      return { name: parts[0].trim(), level: parts.slice(1).join(' — ').trim() };
    });
}

/**
 * Parse a tailored CV into the pieces the template needs.
 * Throws when a required section is missing or empty.
 */
function parseTailoredCv(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new Error('Tailored CV is empty.');
  }

  const { header, sections, language } = splitSections(text);

  const missing = REQUIRED.filter((k) => !sections[k]);
  if (missing.length) {
    throw new Error(
      `Tailored CV is missing section(s): ${missing.join(', ')}. ` +
        `Found: ${Object.keys(sections).join(', ') || 'none'}.`,
    );
  }

  if (header.length < 2) {
    throw new Error('Tailored CV has no name/tagline header.');
  }

  // Headings are rendered from the canonical list, not from what the model
  // wrote. They are the CV's own furniture rather than a claim about the
  // candidate, so nothing about fidelity is lost — and the model reliably
  // misspells the Spanish skills heading, which would otherwise be printed on
  // a document sent to a Spanish-speaking employer.
  const byKey = Object.fromEntries(SECTIONS.map((s) => [s.key, s]));
  const headings = Object.fromEntries(REQUIRED.map((k) => [k, byKey[k][language]]));
  const renamed = REQUIRED
    .filter((k) => clean(sections[k].heading).toUpperCase() !== headings[k].toUpperCase())
    .map((k) => `"${clean(sections[k].heading)}" -> "${headings[k]}"`);

  const parsed = {
    language,
    name: header[0],
    tagline: header[1],
    contact: header.slice(2),
    headings,
    // Surfaced rather than silently applied, so a correction is something the
    // exporter can report instead of something that quietly happens.
    headingCorrections: renamed,
    profile: trimBlanks(sections.profile.lines).join(' ').trim(),
    skills: parseSkillGroups(sections.skills.lines),
    projects: blocks(trimBlanks(sections.projects.lines)).map(parseProject),
    experience: blocks(trimBlanks(sections.experience.lines)).map(parseRole),
    education: parseEducation(sections.education.lines),
    languages: parseLanguages(sections.languages.lines),
  };

  const empty = ['profile', 'skills', 'projects', 'experience', 'education', 'languages']
    .filter((k) => !parsed[k] || parsed[k].length === 0);
  if (empty.length) {
    throw new Error(`Tailored CV parsed but these sections are empty: ${empty.join(', ')}.`);
  }

  return parsed;
}

// The first skills group is the AI one in both CVs, and it is the visual accent
// of the design — the only pills rendered in the brand colour.
const pillClass = (groupIndex) => (groupIndex === 0 ? 'pill ai' : 'pill');

function skillsHtml(groups) {
  return groups
    .map((g, i) => {
      const pills = g.items.map((s) => `<span class="${pillClass(i)}">${escapeHtml(s)}</span>`).join('');
      const label = g.label ? `<p class="subhead">${escapeHtml(g.label)}</p>` : '';
      return `${label}\n        <div class="pills">${pills}</div>`;
    })
    .join('\n\n        ');
}

function projectsHtml(projects) {
  return projects
    .map((p) => {
      const stack = p.stack ? `<span class="proj-stack">${escapeHtml(p.stack)}</span>` : '';
      const links = p.links
        ? `<div class="proj-links-row"><span>${escapeHtml(p.links)}</span></div>`
        : '';
      const desc = (p.bullets || []).length
        ? `<ul class="job-list proj-bullets">${p.bullets.map((b) => `<li>${escapeHtml(b)}</li>`).join('')}</ul>`
        : p.description
          ? `<p class="proj-desc">${escapeHtml(p.description)}</p>`
          : '';
      return `<div class="proj">
          <div class="proj-head">
            <span class="proj-name">${escapeHtml(p.name)}</span>
            ${stack}
          </div>
          ${links}
          ${desc}
        </div>`;
    })
    .join('\n\n        ');
}

function experienceHtml(roles) {
  return roles
    .map((r) => {
      const bullets = r.bullets.length
        ? `<ul class="job-list">${r.bullets.map((b) => `<li>${escapeHtml(b)}</li>`).join('')}</ul>`
        : '';
      const org = r.org ? `<p class="job-org">${escapeHtml(r.org)}</p>` : '';
      return `<div class="job">
        <div class="job-head">
          <span class="job-title">${escapeHtml(r.title)}</span>
          <span class="job-date">${escapeHtml(r.dates)}</span>
        </div>
        ${org}
        ${bullets}
      </div>`;
    })
    .join('\n\n      ');
}

function educationHtml(items) {
  return items
    .map((block) => {
      const [head, ...rest] = block;
      // The award and the institution arrive on one line; the design shows them
      // as two, the institution in the accent colour.
      const dash = head.indexOf(' — ');
      const title = dash === -1 ? head : head.slice(0, dash).trim();
      const org = dash === -1 ? '' : head.slice(dash + 3).trim();

      const meta = rest.find((l) => DATE_RANGE.test(l)) || '';
      const detail = rest.filter((l) => l !== meta);

      return `<div class="edu-item">
          <p class="edu-title">${escapeHtml(title)}</p>
          ${org ? `<p class="edu-org">${escapeHtml(org)}</p>` : ''}
          ${meta ? `<p class="edu-meta">${escapeHtml(meta)}</p>` : ''}
          ${detail.map((d) => `<p class="edu-detail">${escapeHtml(d)}</p>`).join('\n          ')}
        </div>`;
    })
    .join('\n        ');
}

// Native is a full bar; everything else steps down by CEFR level. Cosmetic, and
// derived rather than stored so it cannot drift from the text beside it.
function levelWidth(level) {
  const l = level.toLowerCase();
  if (/native|nativ/.test(l)) return 100;
  if (/c2/.test(l)) return 92;
  if (/c1/.test(l)) return 82;
  if (/b2/.test(l)) return 70;
  if (/b1/.test(l)) return 55;
  return 45;
}

function languagesHtml(langs) {
  return langs
    .map(
      (l) => `<div class="lang-item">
          <div class="langname"><span>${escapeHtml(l.name)}</span><span class="lvl">${escapeHtml(l.level)}</span></div>
          <div class="bar-bg"><div class="bar-fill" style="width:${levelWidth(l.level)}%"></div></div>
        </div>`,
    )
    .join('\n        ');
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PROFILE_URL = /^(?:https?:\/\/)?(?:www\.)?[a-z0-9-]+\.[a-z]{2,}\/\S+$/i;

/**
 * The contact block, one item per line.
 *
 * The model packs these onto two long lines. Rendered as-is against a
 * right-aligned column that is a third of the page, the LinkedIn URL wrapped
 * mid-word and shoved the tagline onto a second line. Splitting on the items
 * themselves restores the design's four short lines regardless of how the
 * model grouped them.
 */
function contactHtml(lines) {
  const out = [];
  let plain = [];

  const flush = () => {
    if (plain.length) {
      out.push(escapeHtml(plain.join(' ')));
      plain = [];
    }
  };

  for (const line of lines) {
    for (const token of line.split(/\s+/)) {
      const t = token.trim();
      if (!t) continue;
      if (EMAIL.test(t)) {
        flush();
        out.push(escapeHtml(t));
      } else if (PROFILE_URL.test(t)) {
        flush();
        const href = /^https?:\/\//i.test(t) ? t : `https://${t}`;
        out.push(`<a href="${escapeHtml(href)}">${escapeHtml(t)}</a>`);
      } else {
        plain.push(t);
      }
    }
    flush();
  }

  return out.join('<br>\n        ');
}

/**
 * Fill the template. Only the marked regions change; the stylesheet and the
 * page structure are the author's and are left exactly as written.
 */
function renderCv(parsed, templateHtml) {
  // The design sets the surname on its own line; the text CV has it on one.
  const nameHtml = escapeHtml(parsed.name).replace(/\s+(\S+)$/, '<br>$1');

  const values = {
    NAME: nameHtml,
    TAGLINE: escapeHtml(parsed.tagline),
    CONTACT: contactHtml(parsed.contact),
    PROFILE_HEADING: escapeHtml(parsed.headings.profile),
    PROFILE: escapeHtml(parsed.profile),
    SKILLS_HEADING: escapeHtml(parsed.headings.skills),
    SKILLS: skillsHtml(parsed.skills),
    PROJECTS_HEADING: escapeHtml(parsed.headings.projects),
    PROJECTS: projectsHtml(parsed.projects),
    EXPERIENCE_HEADING: escapeHtml(parsed.headings.experience),
    EXPERIENCE: experienceHtml(parsed.experience),
    EDUCATION_HEADING: escapeHtml(parsed.headings.education),
    EDUCATION: educationHtml(parsed.education),
    LANGUAGES_HEADING: escapeHtml(parsed.headings.languages),
    LANGUAGES: languagesHtml(parsed.languages),
  };

  let html = templateHtml;
  for (const [key, value] of Object.entries(values)) {
    // A function replacer, so a `$&` inside CV text is not read as a backreference.
    html = html.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), () => value);
  }

  const leftover = html.match(/\{\{[A-Z_]+\}\}/g);
  if (leftover) {
    throw new Error(`Template has unfilled markers: ${[...new Set(leftover)].join(', ')}`);
  }

  return html;
}

module.exports = { parseTailoredCv, renderCv, escapeHtml, levelWidth };
