// Which CV to use for a given posting.
//
// The candidate is Spanish-native and English C2, and keeps both CVs. A Spanish
// posting from Get on Board should be answered with the Spanish CV, an English
// Hacker News posting with the English one.
//
// This matters twice over. Tailoring in the wrong language is obviously wrong,
// but verification is the subtler failure: audit a Spanish CV against the
// English ground truth and every line reads as unsupported, because the words
// don't match. Both steps have to agree on which CV is the source.

const fs = require('fs');
const path = require('path');

const PROFILE_PATH = path.join(__dirname, '../profile/profile.json');
const ROOT = path.join(__dirname, '../..');

// Function words, not vocabulary. A Spanish posting for a JavaScript role is
// full of English technical terms — "React", "backend", "deploy" — so counting
// those would call it English. Articles and prepositions give the real answer.
const SPANISH_MARKERS =
  /\b(de|la|el|los|las|un|una|para|con|del|que|en|por|como|más|nuestro|nuestra|experiencia|conocimientos|desarrollo|empresa|trabajo|puesto|buscamos|requisitos|habilidades|deseable|ofrecemos)\b/gi;

const ENGLISH_MARKERS =
  /\b(the|and|for|with|you|we|our|are|will|have|this|that|your|about|role|team|work|experience|requirements|skills|looking|join)\b/gi;

/**
 * Detect a posting's language.
 *
 * Deliberately crude — a ratio of function words, not a language model. Job
 * postings are long enough for the signal to be unambiguous, and this costs
 * nothing and cannot fail at runtime.
 */
function detectLanguage(text) {
  if (!text || text.length < 40) return 'en'; // too short to judge; default

  const es = (text.match(SPANISH_MARKERS) || []).length;
  const en = (text.match(ENGLISH_MARKERS) || []).length;

  if (es === 0 && en === 0) return 'en';
  // Requires a clear majority rather than a bare win: mixed postings (a
  // Spanish company writing in English, or vice versa) should fall to English,
  // which is the safer default for an international search.
  return es > en * 1.3 ? 'es' : 'en';
}

function loadProfile() {
  if (!fs.existsSync(PROFILE_PATH)) {
    throw new Error('src/profile/profile.json not found.');
  }
  return JSON.parse(fs.readFileSync(PROFILE_PATH, 'utf8'));
}

/**
 * The CV text to use for a posting, plus which language was chosen.
 * Falls back to the other language rather than failing, so a missing Spanish
 * CV degrades to "tailored in English" instead of stopping the run.
 */
function cvForPosting(description, { profile = loadProfile() } = {}) {
  const language = detectLanguage(description);
  const paths = profile.cv_paths || {};

  const tryLoad = (lang) => {
    const rel = paths[lang];
    if (!rel) return null;
    const abs = path.resolve(ROOT, rel);
    if (!fs.existsSync(abs)) return null;
    const text = fs.readFileSync(abs, 'utf8').trim();
    return text.length >= 100 ? { text, language: lang, path: abs } : null;
  };

  const chosen = tryLoad(language);
  if (chosen) return chosen;

  const other = language === 'es' ? 'en' : 'es';
  const fallback = tryLoad(other);
  if (fallback) {
    return { ...fallback, fellBackFrom: language };
  }

  throw new Error(
    'No CV found. Expected the files named in profile.json cv_paths:\n' +
      `  ${Object.values(paths).join('\n  ')}`,
  );
}

module.exports = { detectLanguage, cvForPosting, loadProfile };
