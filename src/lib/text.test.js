const test = require('node:test');
const assert = require('node:assert/strict');

const { repairEncoding, decodeEntities, stripHtml, cleanText } = require('./text');

test('repairEncoding fixes UTF-8 that was decoded as Latin-1', () => {
  assert.equal(repairEncoding('CoordenaÃ§Ã£o'), 'Coordenação');
  assert.equal(repairEncoding('Appel Ã  candidature'), 'Appel à candidature');
});

test('repairEncoding leaves correctly encoded text alone', () => {
  for (const text of ['Coordenação', 'México', 'plain ascii', '']) {
    assert.equal(repairEncoding(text), text);
  }
});

test('repairEncoding is idempotent', () => {
  const once = repairEncoding('CoordenaÃ§Ã£o');
  assert.equal(repairEncoding(once), once);
});

test('repairEncoding keeps the original when the repair would not be valid UTF-8', () => {
  // Matches the mojibake pattern, but the trailing 0xFF byte cannot be UTF-8.
  const broken = 'Ã\u0080ÿ';
  assert.equal(repairEncoding(broken), broken);
});

test('repairEncoding passes non-strings through', () => {
  assert.equal(repairEncoding(null), null);
  assert.equal(repairEncoding(undefined), undefined);
  assert.equal(repairEncoding(42), 42);
});

test('decodeEntities handles named, hex and decimal entities', () => {
  assert.equal(decodeEntities('R&amp;D &lt;team&gt; &quot;hi&quot;'), 'R&D <team> "hi"');
  assert.equal(decodeEntities('it&#x27;s &#39;fine&#39; a&#x2F;b a&#47;b'), "it's 'fine' a/b a/b");
  assert.equal(decodeEntities('a&nbsp;b'), 'a b');
  assert.equal(decodeEntities('&#x41;&#66;&#x1F600;'), 'AB\u{1F600}');
});

test('decodeEntities leaves unknown entities and plain text alone', () => {
  assert.equal(decodeEntities('&bogus; & done'), '&bogus; & done');
  assert.equal(decodeEntities('nothing to do'), 'nothing to do');
});

test('decodeEntities does not decode twice', () => {
  assert.equal(decodeEntities('&amp;lt;'), '&lt;');
});

test('decodeEntities passes non-strings through', () => {
  assert.equal(decodeEntities(null), null);
  assert.equal(decodeEntities(undefined), undefined);
});

test('stripHtml turns block-level tags into newlines and drops other tags', () => {
  // The opening tag of the next block becomes a space, so a line may start
  // with one; only the line break itself is guaranteed.
  assert.match(stripHtml('<p>One</p><p>Two</p>'), /^One\n ?Two$/);
  assert.equal(stripHtml('Line<br>Next<br/>Last'), 'Line\nNext\nLast');
  assert.match(stripHtml('<ul><li>a</li><li>b</li></ul>'), /^a\n ?b$/);
  assert.equal(stripHtml('<h2>Title</h2>Body'), 'Title\nBody');
  assert.equal(stripHtml('<b>bold</b> and <a href="x">link</a>'), 'bold and link');
});

test('stripHtml collapses runs of spaces and excess blank lines', () => {
  assert.equal(stripHtml('a   \t  b'), 'a b');
  assert.equal(stripHtml('a\n\n\n\n\nb'), 'a\n\nb');
  assert.equal(stripHtml('  <p>  padded  </p>  '), 'padded');
});

test('stripHtml passes non-strings through', () => {
  assert.equal(stripHtml(null), null);
  assert.equal(stripHtml(undefined), undefined);
});

test('cleanText returns an empty string for null and undefined', () => {
  assert.equal(cleanText(null), '');
  assert.equal(cleanText(undefined), '');
});

test('cleanText strips HTML, decodes entities and repairs encoding, in that order', () => {
  // RemoteOK style: markup plus entities plus double-encoded UTF-8.
  assert.equal(cleanText('<p>CoordenaÃ§Ã£o &amp; equipe</p>'), 'Coordenação & equipe');
});

test('cleanText leaves mixed text alone: a correctly encoded accent blocks the repair', () => {
  // "ã" decoded from an entity is a real Latin-1 character, so re-reading the
  // whole string as UTF-8 fails and the original is kept. All or nothing.
  assert.equal(cleanText('CoordenaÃ§Ã£o Gest&#227;o'), 'CoordenaÃ§Ã£o Gestão');
});

test('cleanText does not turn an escaped tag into markup that gets stripped', () => {
  // Entities are decoded after tags are stripped, so "&lt;b&gt;" survives as text.
  assert.equal(cleanText('Use &lt;b&gt; for bold'), 'Use <b> for bold');
});

test('cleanText is stable on already clean text', () => {
  const text = 'Senior Engineer\n\nRemote, Mexico';
  assert.equal(cleanText(text), text);
  assert.equal(cleanText(cleanText(text)), text);
});
