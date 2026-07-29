// Turn an approved job into an application you can actually send.
//
//   npm run export -- 404          one job
//   npm run export -- --all        every approved job not yet exported
//
// Writes data/applications/<company>-<id>/ containing the CV as a PDF in your
// own design, the same text in a paste-able form, the cover letter, and the
// posting details you need while filling in the form.
//
// Two things this deliberately does not do. It does not submit anything — the
// boundary in docs/AGENTS.md holds, and the last click stays yours. And it does
// not change `status`, so exporting is repeatable: re-tailor a job, export it
// again, no state to unwind.

const fs = require('fs');
const path = require('path');
const db = require('../db');
const { parseTailoredCv, renderCv } = require('../lib/cvLayout');

const ROOT = path.join(__dirname, '../..');
const DATA = path.join(ROOT, 'data');
const OUT_ROOT = path.join(DATA, 'applications');

const selectOne = db.prepare(`SELECT * FROM jobs WHERE id = ? AND status = 'approved'`);
const selectAll = db.prepare(`SELECT * FROM jobs WHERE status = 'approved' ORDER BY fit_score DESC, id`);

/** A directory name that is stable, readable, and safe on Windows. */
function slug(company, id) {
  const base = String(company || 'unknown')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'unknown';
  return `${base}-${id}`;
}

/**
 * Render the CV to PDF through the same path that produced the source design:
 * a real browser, the page size from the stylesheet, and backgrounds enabled.
 *
 * printBackground is not optional here — the sidebar gradient and every skill
 * pill are backgrounds, so without it the CV prints as text on white.
 */
async function renderPdf(html, outPath) {
  const { chromium } = require('@playwright/test');
  // Written next to the fonts so the stylesheet's relative href resolves.
  const tmpHtml = path.join(DATA, `.export-${process.pid}.html`);
  fs.writeFileSync(tmpHtml, html, 'utf8');

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto('file:///' + tmpHtml.replace(/\\/g, '/'), { waitUntil: 'networkidle' });
    // Fonts change metrics, and metrics decide where text wraps.
    await page.evaluate(() => document.fonts.ready);
    await page.pdf({ path: outPath, preferCSSPageSize: true, printBackground: true });
  } finally {
    await browser.close();
    fs.rmSync(tmpHtml, { force: true });
  }
}

function postingMarkdown(job) {
  const fit = JSON.parse(job.fit_reasoning || '{}');
  const check = JSON.parse(job.verification_report || '{}');
  const claims = check.unsupported_claims || [];

  const lines = [
    `# ${job.title}`,
    '',
    `**${job.company}**${job.location ? ` — ${job.location}` : ''}  `,
    `Source: ${job.source}  `,
    `Posted: ${job.posted_at || 'not stated'}  `,
    `Approved: ${job.approved_at}`,
    '',
    `<${job.url}>`,
    '',
    '## Fit',
    '',
    `Score **${job.fit_score}**`,
    '',
    fit.reasoning || '_no reasoning recorded_',
  ];

  if ((fit.gaps || []).length) {
    lines.push('', '### Gaps to expect questions about', '');
    for (const g of fit.gaps) lines.push(`- ${g}`);
  }

  lines.push('', '## Verification', '');
  lines.push(check.summary || '_no summary recorded_');
  if (claims.length) {
    lines.push('', 'Flagged but not blocking:', '');
    for (const c of claims) lines.push(`- **[${c.severity}]** "${c.quote}" — ${c.problem}`);
  } else {
    lines.push('', 'No unsupported claims found.');
  }

  if (job.flagged_injection) {
    lines.push(
      '',
      '## ⚠ This posting contains text aimed at AI readers',
      '',
      'Read it yourself before answering any free-text question.',
    );
  }

  lines.push('', '## Applying', '', '- [ ] Uploaded CV', '- [ ] Pasted cover letter', '- [ ] Submitted');
  lines.push('', `Then record it: \`npm run applied -- ${job.id}\``, '');

  return lines.join('\n');
}

async function exportOne(job) {
  const dir = path.join(OUT_ROOT, slug(job.company, job.id));
  fs.mkdirSync(dir, { recursive: true });

  const written = [];
  const write = (name, content) => {
    fs.writeFileSync(path.join(dir, name), content, 'utf8');
    written.push(name);
  };

  // The text files are written first and unconditionally. If the PDF step
  // fails, you still have everything needed to apply by hand rather than an
  // empty folder.
  write('cv.txt', (job.tailored_resume || '').trim() + '\n');
  if (job.cover_letter) write('cover-letter.txt', job.cover_letter.trim() + '\n');
  write('posting.md', postingMarkdown(job));

  let pdf = null;
  let parsed = null;
  let warning = null;

  try {
    parsed = parseTailoredCv(job.tailored_resume);
    const template = fs.readFileSync(
      path.join(DATA, `cv-template-${parsed.language}.html`),
      'utf8',
    );
    const html = renderCv(parsed, template);
    pdf = `${parsed.name} - CV.pdf`;
    await renderPdf(html, path.join(dir, pdf));
    written.push(pdf);
  } catch (err) {
    // Loudly, and without a PDF — a malformed CV that looks fine is the one
    // failure this whole pipeline exists to avoid.
    warning = err.message;
    pdf = null;
  }

  write(
    'application.json',
    JSON.stringify(
      {
        id: job.id,
        title: job.title,
        company: job.company,
        url: job.url,
        source: job.source,
        location: job.location,
        fit_score: job.fit_score,
        language: parsed?.language ?? null,
        approved_at: job.approved_at,
        applied_at: job.applied_at,
        exported_at: new Date().toISOString(),
        cv_pdf: pdf,
        heading_corrections: parsed?.headingCorrections ?? [],
      },
      null,
      2,
    ) + '\n',
  );

  return { dir, written, warning, corrections: parsed?.headingCorrections ?? [] };
}

async function run({ ids = [], all = false } = {}) {
  const jobs = all ? selectAll.all() : ids.map((id) => selectOne.get(id)).filter(Boolean);

  if (jobs.length === 0) {
    console.log('\n  Nothing to export.');
    console.log('  Export works on approved jobs — approve some first: npm run review\n');
    return { exported: 0, failed: 0 };
  }

  const results = { exported: 0, failed: 0 };

  for (const job of jobs) {
    process.stdout.write(`  #${job.id} ${String(job.company).slice(0, 28)} … `);
    try {
      const { dir, warning, corrections } = await exportOne(job);
      if (warning) {
        results.failed++;
        console.log('text only');
        console.log(`      no PDF: ${warning}`);
        console.log(`      ${path.relative(ROOT, dir)}`);
      } else {
        results.exported++;
        console.log('done');
        console.log(`      ${path.relative(ROOT, dir)}`);
        for (const c of corrections) console.log(`      heading corrected: ${c}`);
      }
    } catch (err) {
      results.failed++;
      console.log(`FAILED\n      ${err.message}`);
    }
  }

  return results;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const all = args.includes('--all');
  const ids = args.filter((a) => /^\d+$/.test(a)).map(Number);

  if (!all && ids.length === 0) {
    console.log('\n  Usage: npm run export -- <job id> [more ids]');
    console.log('         npm run export -- --all\n');
    process.exitCode = 1;
  } else {
    run({ ids, all })
      .then(({ exported, failed }) => {
        console.log(`\n  Exported ${exported}, ${failed} without a PDF.`);
        if (exported > 0) console.log('  Apply, then record it: npm run applied -- <id>\n');
        if (failed > 0) process.exitCode = 1;
      })
      .catch((err) => {
        console.error(`\n  ${err.message}\n`);
        process.exitCode = 1;
      });
  }
}

module.exports = { run, exportOne, slug };
