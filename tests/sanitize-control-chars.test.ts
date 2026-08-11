/**
 * scripts/lib/sanitize-control-chars.mjs — the SHARED DEFINITION of "which C0
 * character is illegal, and how is it spelled once escaped".
 *
 * ## Why this module is here at all, given the site does not sanitise
 *
 * The file is a byte-identical twin of nanakokyobashi-rgb/frontaliere-articles's
 * copy at the same path (sha256 61f6e2723fabdad7…, the baseline that repo's
 * scripts/ci/loop-sync-manifest.json records). The site imports its PREDICATES
 * — `isInvalidControlCode`, `findControlChars` — and builds a refusal on top of
 * them in scripts/lib/control-char-publish-gate.mjs; the corpus imports its
 * SANITISERS and strips. One definition of illegal, two policies, and the
 * asymmetry is deliberate: see the gate's header.
 *
 * Keeping the twin byte-identical is what lets the manifest police it. So the
 * suite below is a port of the corpus's own generator/tests/sanitize-control-chars.test.mjs
 * (node:test → vitest) rather than a fresh one: the two files must agree about
 * what the module does, or "byte-identical" stops meaning "same behaviour
 * expected of it".
 *
 * ## Why the assertions look like this
 *
 * The failure this module describes is silent on both sides, so the cases pin
 * the two spellings separately (raw byte, and `\u00XX` / `\b` escape) and pin
 * what must NOT change — TAB/LF/CR, accented text, a `\b` word boundary inside
 * a regex literal. A sanitiser that eats one character too many is a corpus
 * corrupter, which is a worse bug than the one it fixes.
 *
 * Every control character below is built with `String.fromCharCode`, never
 * typed as a literal byte. That is not style: the first draft of the gate this
 * module supports was authored WITH the raw bytes it was meant to match, and
 * the scan at the bottom of this file is what found them.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isInvalidControlCode,
  sanitizeText,
  sanitizeDeep,
  sanitizeXmlDocument,
  sanitizeHtmlDocument,
  sanitizeJsonText,
  findControlChars,
  assertNoControlChars,
} from '../scripts/lib/sanitize-control-chars.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The two bytes actually measured in `packages/articles/content`.
 *
 * These comments say what each byte STOOD FOR in one measured title. They are
 * not a repair mapping and nothing below repairs from them — the assertions
 * only ever check what stripping leaves (`sar0`, `marted8`), which is the same
 * whatever the lost character was. See the "Do not repair from the list above"
 * section of `scripts/lib/sanitize-control-chars.mjs`.
 */
const BS = String.fromCharCode(0x08); // 0x08, from the mangling of «ì» and of the curly quotes
const ETB = String.fromCharCode(0x17); // 0x17, from the mangling of «ò» — NOT «à»; corpus #218

/** The two real titles, byte-for-byte as the corpus holds them. */
const DIRTY_TITLE = `Trump: "Intesa o sar${ETB}0 l'inferno". Il giallo dell'ultimatum spostato a marted${BS}8`;
const DIRTY_QUOTED = `Il ${BS}3territorio poroso${BS}3 tra Varese e la Svizzera`;
const CLEAN_TITLE = `Trump: "Intesa o sar0 l'inferno". Il giallo dell'ultimatum spostato a marted8`;

/** Every character an XML 1.0 document may contain (§2.2). */
function assertXmlCharsLegal(xml: string, label: string): void {
  for (let i = 0; i < xml.length; i++) {
    const code = xml.charCodeAt(i);
    const legal =
      code === 0x09 ||
      code === 0x0a ||
      code === 0x0d ||
      (code >= 0x20 && code <= 0xd7ff) ||
      (code >= 0xe000 && code <= 0xfffd);
    expect(
      legal,
      `${label}: character 0x${code.toString(16)} at ${i} is not permitted in XML 1.0 — ` +
        'a strict parser rejects the whole document here',
    ).toBe(true);
  }
}

const xmlEsc = (s: unknown): string =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

describe('the predicate', () => {
  it('does not call the three C0 characters XML and JSON both admit "invalid"', () => {
    expect(isInvalidControlCode(0x09)).toBe(false); // TAB
    expect(isInvalidControlCode(0x0a)).toBe(false); // LF
    expect(isInvalidControlCode(0x0d)).toBe(false); // CR
    expect(isInvalidControlCode(0x20)).toBe(false); // SPACE is not C0
    expect(isInvalidControlCode(0xe0)).toBe(false); // à is not C0
  });

  it('calls every other C0 code point invalid, boundaries included', () => {
    for (let code = 0x00; code <= 0x1f; code++) {
      if (code === 0x09 || code === 0x0a || code === 0x0d) continue;
      expect(isInvalidControlCode(code), `0x${code.toString(16)}`).toBe(true);
    }
  });
});

describe('sanitizeText', () => {
  it('strips the two bytes measured in the corpus, 0x08 and 0x17', () => {
    expect(sanitizeText(DIRTY_TITLE)).toBe(CLEAN_TITLE);
    expect(sanitizeText(DIRTY_QUOTED)).toBe('Il 3territorio poroso3 tra Varese e la Svizzera');
    expect(findControlChars(sanitizeText(DIRTY_TITLE))).toHaveLength(0);
  });

  it('preserves TAB, LF and CR', () => {
    expect(sanitizeText('a\tb\nc\r\nd')).toBe('a\tb\nc\r\nd');
  });

  it('leaves a clean string byte-identical, accents and typographic quotes included', () => {
    const clean = 'Perché «martedì» costa 1,20 CHF — e più: \u2019 \u201C \u201D';
    expect(sanitizeText(clean)).toBe(clean);
  });

  it('passes non-strings through untouched', () => {
    expect(sanitizeText(null)).toBe(null);
    expect(sanitizeText(undefined)).toBe(undefined);
    expect(sanitizeText(42)).toBe(42);
  });
});

describe('sanitizeDeep', () => {
  it('sanitises nested values and object keys', () => {
    const dirty = {
      [`blog.article.x.ti${BS}tle`]: DIRTY_TITLE,
      nested: { list: ['ok', DIRTY_QUOTED, 7, null] },
    };
    const clean = sanitizeDeep(dirty);
    expect(Object.keys(clean)).toEqual(['blog.article.x.title', 'nested']);
    expect(clean['blog.article.x.title']).toBe(CLEAN_TITLE);
    expect(clean.nested.list[1]).toBe('Il 3territorio poroso3 tra Varese e la Svizzera');
    expect(clean.nested.list[2]).toBe(7);
    expect(clean.nested.list[3]).toBe(null);
  });

  it('a control character survives JSON.stringify as an escape — sanitising the VALUE is the only fix', () => {
    // This is the reason meta-it.json shipped poisoned for weeks with every
    // gate green: the serialised bytes are valid JSON, so nothing raised.
    const serialisedDirty = JSON.stringify({ title: DIRTY_TITLE });
    expect(serialisedDirty).toMatch(/\\b|\\u00/); // stringify escapes rather than rejects
    expect(findControlChars(serialisedDirty)).toHaveLength(0); // a byte scan of the artifact sees nothing
    expect(JSON.parse(serialisedDirty).title).toBe(DIRTY_TITLE); // but the consumer gets it back

    const serialisedClean = JSON.stringify(sanitizeDeep({ title: DIRTY_TITLE }));
    expect(JSON.parse(serialisedClean).title).toBe(CLEAN_TITLE);
    expect(serialisedClean).not.toMatch(/\\u00[01]|\\b|\\f/);
  });

  it('refuses two keys that collapse onto the same key, in either order', () => {
    // Stripping a key is the one way this module can LOSE data: the poisoned
    // key and the clean one become the same string, and whichever arrives
    // second wins. A wrong article's title under the right key raises nothing
    // anywhere, so it stops here rather than being resolved by iteration order.
    const DIRTY_KEY = `blog.article.x.ti${BS}tle`;
    const CLEAN_KEY = 'blog.article.x.title';
    const dirtyFirst = { [DIRTY_KEY]: 'sbagliato', [CLEAN_KEY]: 'giusto' };
    const cleanFirst = { [CLEAN_KEY]: 'giusto', [DIRTY_KEY]: 'sbagliato' };
    expect(Object.keys(dirtyFirst)).toHaveLength(2); // the two keys really are distinct
    for (const [label, obj] of [
      ['dirty first', dirtyFirst],
      ['clean first', cleanFirst],
    ] as const) {
      expect(() => sanitizeDeep(obj), label).toThrow(/both become .*blog\.article\.x\.title/s);
    }
  });

  it('a key that only needs sanitising, with no twin, still goes through', () => {
    expect(sanitizeDeep({ [`a${BS}b`]: 1, c: 2 })).toEqual({ ab: 1, c: 2 });
  });

  it('does not rebuild a non-plain object into a bare one', () => {
    const when = new Date('2026-08-08T00:00:00.000Z');
    const out = sanitizeDeep({ when });
    expect(out.when).toBe(when);
    expect(JSON.stringify(out)).toBe('{"when":"2026-08-08T00:00:00.000Z"}');
  });
});

describe('sanitizeXmlDocument, and the sitemap entry that broke', () => {
  it('makes a <url> block built from a dirty title XML-legal', () => {
    const doc =
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"\n' +
      '        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">\n' +
      '  <url>\n' +
      '    <loc>https://frontaliereticino.ch/articoli-frontaliere/trump-intesa-o-inferno/</loc>\n' +
      '    <image:image>\n' +
      `      <image:title>${xmlEsc(DIRTY_TITLE)}</image:title>\n` +
      '    </image:image>\n' +
      '  </url>\n' +
      '</urlset>\n';

    // Escaping alone does not save it: xmlEsc handles markup characters and
    // has nothing to say about a control byte.
    expect(findControlChars(doc).length).toBeGreaterThan(0);
    expect(() => assertXmlCharsLegal(doc, 'unsanitised')).toThrow();

    const clean = sanitizeXmlDocument(doc);
    assertXmlCharsLegal(clean, 'sanitised');
    expect(clean).toContain('spostato a marted8</image:title>');
    expect(clean.match(/<url>/g) ?? []).toHaveLength(1); // the entry survives, only the bytes go
  });

  it('removes a numeric character reference to a forbidden character too', () => {
    // `&#8;` is another spelling of 0x08 and equally fatal; `&#233;` and
    // `&#x2019;` are ordinary text and must survive.
    const xml = '<t>a&#8;b&#x17;c&#233;d&#x2019;e&amp;f</t>';
    expect(sanitizeXmlDocument(xml)).toBe('<t>abc&#233;d&#x2019;e&amp;f</t>');
  });

  it('returns a clean XML document byte-identical', () => {
    const xml = '<?xml version="1.0"?>\n<a>Perché\tsì\r\n</a>\n';
    expect(sanitizeXmlDocument(xml)).toBe(xml);
  });
});

describe('sanitizeHtmlDocument, and the JSON-LD block that shipped poisoned', () => {
  /** The live page's shape, reduced to the tags that carried the bytes. */
  const DIRTY_PAGE =
    '<!doctype html><html lang="it"><head>\n' +
    `<title>${xmlEsc(DIRTY_TITLE)}</title>\n` +
    `<meta property="og:title" content="${xmlEsc(DIRTY_TITLE)}">\n` +
    `<script type="application/ld+json">${JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'NewsArticle',
      headline: DIRTY_TITLE,
      image: { caption: DIRTY_TITLE },
    })}</script>\n` +
    `<script type="application/ld+json">${JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [{ '@type': 'ListItem', position: 3, name: DIRTY_TITLE }],
    })}</script>\n` +
    `<script>window.__ARTICLE_TITLE__=${JSON.stringify(DIRTY_TITLE)}</script>\n` +
    '<script defer src="https://cdn.frontaliereticino.ch/assets/adsense-loader.js"></script>\n' +
    `</head><body><h1>${xmlEsc(DIRTY_TITLE)}</h1>` +
    `<img src="/x.webp" alt="${xmlEsc(DIRTY_TITLE)}"></body></html>\n`;

  it('strips the raw bytes from title, og:*, h1 and alt', () => {
    expect(findControlChars(DIRTY_PAGE).length).toBeGreaterThan(0);
    const clean = sanitizeHtmlDocument(DIRTY_PAGE);
    expect(findControlChars(clean)).toHaveLength(0);
    expect(clean).toContain('<title>Trump: &quot;Intesa o sar0');
    expect(clean).toContain('<h1>Trump: &quot;Intesa o sar0');
    expect(clean).toContain('alt="Trump: &quot;Intesa o sar0');
  });

  it('leaves every ld+json block parsable, and parsing CLEAN', () => {
    const clean = sanitizeHtmlDocument(DIRTY_PAGE);
    const blocks = [...clean.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
    expect(blocks).toHaveLength(2);
    for (const [, body] of blocks) {
      const parsed = JSON.parse(body); // throws if the sanitiser broke the JSON
      expect(findControlChars(JSON.stringify(parsed))).toHaveLength(0);
      expect(JSON.stringify(parsed)).not.toMatch(/\\u00[01]|\\b|\\f/);
    }
    expect(JSON.parse(blocks[0][1]).headline).toBe(CLEAN_TITLE);
    expect(JSON.parse(blocks[1][1]).itemListElement[0].name).toBe(CLEAN_TITLE);
  });

  it('catches the escaped spelling inside an inline script too', () => {
    // The raw-byte scan is blind here: JSON.stringify already turned 0x08 into
    // `\b` and 0x17 into `\u0017`, both of which are plain ASCII in the file.
    const withEscapes = '<script>window.__ARTICLE_TITLE__="marted\\b8 sar\\u00170"</script>';
    expect(findControlChars(withEscapes)).toHaveLength(0);
    expect(sanitizeHtmlDocument(withEscapes)).toBe(
      '<script>window.__ARTICLE_TITLE__="marted8 sar0"</script>',
    );
  });

  it('does not mistake an escaped backslash for an escape opener', () => {
    const html = String.raw`<script>var s="C:\\backup\bfile"</script>`;
    // `\\` is a literal backslash; the `\b` right after it IS a backspace escape.
    expect(sanitizeHtmlDocument(html)).toBe(String.raw`<script>var s="C:\\backupfile"</script>`);
  });

  it('leaves a \\b word boundary in a regex literal alone', () => {
    // The whole reason the sanitiser's escape pass is confined to quoted spans
    // inside inline scripts: deleting this `\b` would change what the program
    // matches. That confinement is safe for a REWRITE and is exactly what the
    // publish gate must not reuse for a VERDICT — see #5488 in the gate's test.
    const html = '<script>if(/\\bdark\\b/.test(document.documentElement.className)){}</script>';
    expect(sanitizeHtmlDocument(html)).toBe(html);
  });

  it('leaves an external script and a clean page untouched', () => {
    const html =
      '<script defer src="https://cdn.frontaliereticino.ch/a.js"></script>' +
      '<p>Perché\tmartedì</p>\n';
    expect(sanitizeHtmlDocument(html)).toBe(html);
  });
});

describe('sanitizeJsonText, the verbatim republishes', () => {
  it('republishes a clean JSON document byte-identical, formatting included', () => {
    const raw = '{\n  "ranking": [ { "name": "Chiasso" } ]\n}\n';
    expect(sanitizeJsonText(raw)).toBe(raw);
  });

  it('re-serialises a document carrying an escaped control character', () => {
    const raw = JSON.stringify({ ranking: [{ name: `Chi${BS}asso` }] });
    const out = sanitizeJsonText(raw);
    expect(out).not.toBe(raw);
    expect(JSON.parse(out).ranking[0].name).toBe('Chiasso');
  });

  it('hands an unparsable document back for the caller to refuse', () => {
    expect(sanitizeJsonText('{not json')).toBe('{not json');
  });
});

describe('assertNoControlChars', () => {
  it('is silent on clean text and names the offenders otherwise', () => {
    expect(() => assertNoControlChars('tutto\tbene\n', 'x.xml')).not.toThrow();
    expect(() => assertNoControlChars(DIRTY_TITLE, 'sitemap-blog.xml')).toThrow(
      /sitemap-blog\.xml: 2 XML-invalid control character\(s\).*0x17@.*0x08@/s,
    );
  });
});

describe('the publish path carries no control character of its own', () => {
  it('scans scripts/lib and the fast publisher', () => {
    // Cheap, and it is how BOTH attempts at this pair broke: the corpus's
    // first sanitiser was authored with the raw bytes it was meant to match,
    // and so was the first draft of scripts/lib/control-char-publish-gate.mjs
    // in this PR — six of them, in its own doc comment and in the regex of its
    // context renderer. This scan is what found them.
    //
    // Scoped to the publish path rather than all of `scripts/` on purpose:
    // scripts/relocalize-pending-jobs.mjs uses a raw NUL as a field separator
    // inside a fingerprint template literal (line 228), which is legitimate —
    // that string is never serialised to XML or published. A repo-wide version
    // of this scan needs an allowlist and a decision per entry, and that is a
    // different change from this one.
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(mjs|cjs|js)$/.test(e.name)) files.push(p);
      }
    };
    walk(path.join(REPO_ROOT, 'scripts', 'lib'));
    files.push(path.join(REPO_ROOT, 'scripts', 'publish-article-fast.mjs'));

    const offenders: string[] = [];
    for (const file of files) {
      const found = findControlChars(fs.readFileSync(file, 'utf-8'));
      if (found.length > 0) {
        offenders.push(
          `${path.relative(REPO_ROOT, file)} (${found.length}: ` +
            `${found
              .slice(0, 3)
              .map((f: { code: number }) => `0x${f.code.toString(16)}`)
              .join(', ')})`,
        );
      }
    }
    expect(offenders).toEqual([]);
  });
});
