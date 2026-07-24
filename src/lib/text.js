// Text cleanup shared by the job sources. Every source delivers dirty text in
// its own way: RemoteOK double-encodes it, Remotive sends HTML, Hacker News
// sends HTML entities. Normalizing here keeps the source adapters small and
// means the agents downstream only ever see plain text.

// UTF-8 lead byte (U+00C2–U+00C3) followed by a continuation byte
// (U+0080–U+00BF). Written with escapes because as literals these bytes are
// invisible or ambiguous in an editor — an earlier version used literals and
// silently missed the non-breaking-space case ("Appel Ã  candidature").
const MOJIBAKE = /[Â-Ã][-¿]/;

/**
 * Repair text that was UTF-8 encoded and then re-encoded as Latin-1, so
 * "Coordenação" arrives as "CoordenaÃ§Ã£o".
 *
 * Only applied when the byte pattern is present, and only kept if the result
 * is valid UTF-8 — so correctly-encoded text is never touched and running this
 * twice is safe.
 */
function repairEncoding(text) {
  if (typeof text !== 'string' || !MOJIBAKE.test(text)) return text;
  const repaired = Buffer.from(text, 'latin1').toString('utf8');
  return repaired.includes('�') ? text : repaired;
}

const ENTITIES = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#x27;': "'",
  '&#39;': "'",
  '&#x2F;': '/',
  '&#47;': '/',
  '&nbsp;': ' ',
};

function decodeEntities(text) {
  if (typeof text !== 'string') return text;
  return text
    .replace(/&(amp|lt|gt|quot|nbsp|#x27|#39|#x2F|#47);/g, (m) => ENTITIES[m] ?? m)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)));
}

/**
 * Strip HTML to plain text. Block-level tags become newlines so the structure
 * of a job description survives; everything else collapses to spaces.
 */
function stripHtml(html) {
  if (typeof html !== 'string') return html;
  return html
    .replace(/<\s*(br|\/p|\/div|\/li|\/h[1-6])\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

/** Everything a job source should run its text through, in the right order. */
function cleanText(text) {
  return repairEncoding(decodeEntities(stripHtml(text ?? '')));
}

module.exports = { repairEncoding, decodeEntities, stripHtml, cleanText, MOJIBAKE };
