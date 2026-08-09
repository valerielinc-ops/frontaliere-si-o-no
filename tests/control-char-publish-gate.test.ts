import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  inspectDocument,
  isPublishable,
  kindForPath,
  screenShardPaths,
} from '../scripts/lib/control-char-publish-gate.mjs';

/**
 * Control-character publish gate — issue #5457.
 *
 * The site renders article and hub pages onto the locale shards and, before
 * this gate, had NO control-character handling of any kind: `scripts/lib/
 * sanitize-control-chars.mjs` existed only in the corpus repo, whose own
 * `scripts/publish-article-fast.mjs` — a separate copy of this repo's, pushing
 * the SAME shards, and saying so in its header ("If either copy is touched,
 * touch both") — sanitises at the very write sites this repo's copy left bare.
 *
 * The suite is built around one asymmetry that is easy to get backwards: the
 * corpus STRIPS the offending byte, and this repo must REFUSE the document.
 * Stripping is not a milder version of refusing, it is a different and
 * irreversible operation — the C0 byte sits at the exact offset of the
 * character that was lost, so it is the anchor the corpus's
 * `repair-mangled-chars.mjs` reconstructs from. Remove it and an entry that
 * could be repaired («compétences») becomes a digit no one can tell from a typo
 * (`comp9tences`). Hence `doesNotStrip`, below: the bytes on disk must survive a
 * screening untouched.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');

/** A raw control byte, built from its code so this source file stays ASCII-clean. */
const ch = (code: number) => String.fromCharCode(code);

/** The mangled spelling of «sarà» measured in content/seo/seo-blog-4.ts. */
const MANGLED_SARA = `sar${ch(0x17)}0`;

describe('control-char publish gate — detection', () => {
  it('passes a clean page untouched', () => {
    const html = '<html><head><title>Il territorio poroso</title></head><body><p>ok</p></body></html>';
    expect(isPublishable(html, 'html')).toBe(true);
    expect(inspectDocument(html, 'html')).toEqual([]);
  });

  it('refuses a raw C0 in <title>, and locates it', () => {
    const html = `<html><head><title>Trump: "Intesa o ${MANGLED_SARA} l'inferno"</title></head></html>`;
    expect(isPublishable(html, 'html')).toBe(false);

    const findings = inspectDocument(html, 'html');
    expect(findings).toHaveLength(1);
    expect(findings[0].form).toBe('raw');
    expect(findings[0].code).toBe(0x17);
    // The report has to make the defect FINDABLE — a refusal nobody can read is
    // how a stripped byte became an invisible `3` in the corpus's keywords.
    expect(findings[0].context).toContain('<0x17>');
    expect(findings[0].context).toContain('Intesa o sar');
  });

  it('refuses a C0 that only exists as a JSON escape inside ld+json', () => {
    // The case that kept CI green while the crawler was served a poisoned
    // headline: a byte scan of this document finds NOTHING.
    const html =
      '<html><script type="application/ld+json">' +
      '{"@type":"NewsArticle","headline":"Trump: Intesa o sar\\u00170 l\'inferno"}' +
      '</script></html>';
    expect(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(html)).toBe(false);
    expect(isPublishable(html, 'html')).toBe(false);
    expect(inspectDocument(html, 'html')[0]).toMatchObject({ form: 'escaped', code: 0x17 });
  });

  it('refuses a `\\b` escape inside an inline script string', () => {
    const html = '<html><script>window.__ARTICLE_TITLE__="Il \\b3territorio poroso";</script></html>';
    expect(isPublishable(html, 'html')).toBe(false);
    expect(inspectDocument(html, 'html')[0]).toMatchObject({ form: 'escaped', code: 0x08 });
  });

  it('does NOT flag `\\b` as a regex word boundary (false positive would cost a page its refresh)', () => {
    const html = '<html><script>var re = /\\bfrontaliere\\b/g; if (re.test(x)) go();</script></html>';
    expect(isPublishable(html, 'html')).toBe(true);
  });

  it('does NOT flag an escaped backslash followed by b', () => {
    const html = '<html><script>var p = "C:\\\\bin\\\\node";</script></html>';
    expect(isPublishable(html, 'html')).toBe(true);
  });

  it('ignores the body of an external <script src=…>', () => {
    const html = '<html><script src="/assets/app.js">\\u0008</script></html>';
    expect(isPublishable(html, 'html')).toBe(true);
  });

  it('refuses an XML numeric character reference, but not a legitimate one', () => {
    const poisoned = '<url><image:title>Trump: Intesa o sar&#23;0</image:title></url>';
    expect(isPublishable(poisoned, 'xml')).toBe(false);
    expect(inspectDocument(poisoned, 'xml')[0]).toMatchObject({ form: 'reference', code: 0x17 });

    // `&#233;` is é. Removing it would corrupt the very text this gate protects.
    expect(isPublishable('<url><loc>caf&#233;</loc></url>', 'xml')).toBe(true);
    expect(isPublishable('<url><loc>caf&#xE9;</loc></url>', 'xml')).toBe(true);
  });

  it('refuses an escape anywhere in a JSON document', () => {
    expect(isPublishable('{"title":"comp\\u00179tences"}', 'json')).toBe(false);
    expect(isPublishable('{"title":"compétences"}', 'json')).toBe(true);
  });

  it('keeps TAB, LF and CR legal', () => {
    expect(isPublishable('a\tb\nc\rd', 'html')).toBe(true);
    expect(inspectDocument('a\tb\nc\rd', 'html')).toEqual([]);
  });

  it('maps extensions to the right detector set', () => {
    expect(kindForPath('articoli/x/index.html')).toBe('html');
    expect(kindForPath('sitemap-topics-frontaliere.xml')).toBe('xml');
    expect(kindForPath('meta-it.json')).toBe('json');
    expect(kindForPath('robots.txt')).toBe('text');
  });
});

describe('control-char publish gate — screening a push list', () => {
  function fixture() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccpg-'));
    fs.mkdirSync(path.join(dir, 'a'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'b'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'a', 'index.html'), '<html><title>pulita</title></html>');
    fs.writeFileSync(
      path.join(dir, 'b', 'index.html'),
      `<html><title>${MANGLED_SARA}</title></html>`,
    );
    return dir;
  }

  it('partitions the list and keeps the poisoned page out of the push', () => {
    const dir = fixture();
    const { publishable, refused } = screenShardPaths({
      baseDir: dir,
      relPaths: ['a/index.html', 'b/index.html'],
      logPrefix: '[test]',
    });
    expect(publishable).toEqual(['a/index.html']);
    expect(refused).toHaveLength(1);
    expect(refused[0].relPath).toBe('b/index.html');
    expect(refused[0].findings[0].code).toBe(0x17);
  });

  it('does NOT strip: the refused file is byte-identical after screening', () => {
    // The whole point of the gate. A sanitising gate would rewrite this file to
    // `sar0` — plausible, wrong, and no longer repairable.
    const dir = fixture();
    const target = path.join(dir, 'b', 'index.html');
    const before = fs.readFileSync(target);
    screenShardPaths({ baseDir: dir, relPaths: ['a/index.html', 'b/index.html'], logPrefix: '[test]' });
    expect(fs.readFileSync(target).equals(before)).toBe(true);
    expect(fs.readFileSync(target, 'utf-8')).toContain(MANGLED_SARA);
  });

  it('leaves an unreadable path in the list, so the push script reports its own error', () => {
    const dir = fixture();
    const { publishable, refused } = screenShardPaths({
      baseDir: dir,
      relPaths: ['a/index.html', 'does/not/exist.html'],
      logPrefix: '[test]',
    });
    expect(publishable).toEqual(['a/index.html', 'does/not/exist.html']);
    expect(refused).toHaveLength(0);
  });

  it('returns an empty publishable list when every path is refused', () => {
    const dir = fixture();
    const { publishable, refused } = screenShardPaths({
      baseDir: dir,
      relPaths: ['b/index.html'],
      logPrefix: '[test]',
    });
    expect(publishable).toEqual([]);
    expect(refused).toHaveLength(1);
  });
});

/**
 * The structural half. A gate nobody calls is the same defect with an extra
 * file in the tree — which is exactly how this divergence survived: the corpus
 * had the module AND the call sites, this repo had neither, and nothing
 * compared the two because `scripts/publish-article-fast.mjs` was not in the
 * loop-sync manifest.
 */
describe('control-char publish gate — the emitters actually use it', () => {
  const SHARD_EMITTERS = [
    'scripts/publish-article-fast.mjs',
    'scripts/rerender-article-corpus.mjs',
    'scripts/rerender-article-hubs.mjs',
  ];

  it.each(SHARD_EMITTERS)('%s imports and calls the gate', (rel) => {
    const src = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf-8');
    expect(src).toMatch(/import\s*\{[^}]*screenShardPaths[^}]*\}\s*from\s*['"]\.\/lib\/control-char-publish-gate\.mjs['"]/);
    expect(src).toMatch(/screenShardPaths\s*\(/);
  });

  /**
   * The #65 guard, and the reason the shared module is copied here whole rather
   * than trimmed: `sanitize-control-chars.mjs` also exports the STRIPPING half,
   * which is correct for the corpus and wrong here. Importing it in this repo
   * would silently reintroduce `comp9tences` on the served pages, with a green
   * CI — so the import itself is what fails.
   */
  it('no script in this repo imports the stripping half of sanitize-control-chars', () => {
    const STRIPPERS = ['sanitizeText', 'sanitizeDeep', 'sanitizeHtmlDocument', 'sanitizeXmlDocument', 'sanitizeJsonText'];
    const offenders: string[] = [];

    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(abs);
        else if (/\.(mjs|js|ts)$/.test(entry.name)) {
          const src = fs.readFileSync(abs, 'utf-8');
          for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"][^'"]*sanitize-control-chars\.mjs['"]/g)) {
            const named = m[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0].trim());
            for (const name of named) {
              if (STRIPPERS.includes(name)) offenders.push(`${path.relative(REPO_ROOT, abs)}: ${name}`);
            }
          }
        }
      }
    };
    walk(path.join(REPO_ROOT, 'scripts'));

    expect(offenders).toEqual([]);
  });

  it('the shared module is present and exposes the detection primitives the gate builds on', async () => {
    const modPath = path.join(REPO_ROOT, 'scripts/lib/sanitize-control-chars.mjs');
    expect(fs.existsSync(modPath)).toBe(true);
    const mod = await import(modPath);
    expect(typeof mod.findControlChars).toBe('function');
    expect(typeof mod.isInvalidControlCode).toBe('function');
    // The definition the gate derives its character class from.
    expect(mod.isInvalidControlCode(0x17)).toBe(true);
    expect(mod.isInvalidControlCode(0x09)).toBe(false);
    expect(mod.isInvalidControlCode(0x0a)).toBe(false);
    expect(mod.isInvalidControlCode(0x0d)).toBe(false);
  });
});
