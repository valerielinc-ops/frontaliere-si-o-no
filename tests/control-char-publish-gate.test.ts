/**
 * scripts/lib/control-char-publish-gate.mjs — the site's REFUSAL to publish a
 * rendered file that carries an XML-invalid control character (issue #5457).
 *
 * ## The three things this suite exists to prevent, in order of how they killed
 * the first attempt (PR #5488, closed unmerged)
 *
 * 1. **A false positive is worse than the bug.** #5488's detector confined its
 *    escape pass to quoted string literals, and an apostrophe inside a JS
 *    comment opened a fictitious single-quoted region that swallowed the regex
 *    literals after it — their `\b` word boundaries read as backspaces.
 *    Measured on the live home page: 10 findings, all false, `isPublishable =
 *    false`. A fail-closed gate that refuses a clean page does damage.
 *    `describe('the shapes that must NEVER be refused')` below is that page's
 *    exact construct, reduced. It failed on the closed PR's gate and passes on
 *    this one; the transcript is in the PR body.
 *
 * 2. **A gate whose verdict is discarded is decorative.** #5488's own suite
 *    stayed 20/20 green while the gate was computed and then ignored (`paths:
 *    publishable` swapped back to `paths: candidatePaths`). So the wiring guard
 *    at the bottom does not assert that the gate is CALLED — it asserts, over
 *    the TypeScript AST, that `keepPublishable` is what `shards[].paths` is
 *    built from and that the screening result flows into it.
 *
 * 3. **Refusing must cost one page, not the run.** A process-level abort would
 *    freeze the whole hub tier, which is how issue #5432 stayed invisible for
 *    days. `screenShardPaths` partitions and never throws.
 *
 * Every control character below is built with `String.fromCharCode`. The first
 * draft of the module under test was authored with the raw bytes it was meant
 * to match; see the scan in tests/sanitize-control-chars.test.ts.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import ts from 'typescript';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  inspectDocument,
  isPublishable,
  keepPublishable,
  kindForPath,
  formatRefusal,
  screenShardPaths,
} from '../scripts/lib/control-char-publish-gate.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLISHER = path.join(REPO_ROOT, 'scripts', 'publish-article-fast.mjs');
const GATE = path.join(REPO_ROOT, 'scripts', 'lib', 'control-char-publish-gate.mjs');
const SANITISER = path.join(REPO_ROOT, 'scripts', 'lib', 'sanitize-control-chars.mjs');

const BS = String.fromCharCode(0x08); // 0x08 — the byte in «martedì» and in the curly quotes
const ETB = String.fromCharCode(0x17); // 0x17 — the byte in «sarà»

/** The real mangled title, byte-for-byte as packages/articles/content holds it. */
const DIRTY_TITLE = `Il ${BS}3territorio poroso${BS}3 tra Varese e la Svizzera`;

/** A page whose only poison is INSIDE the ld+json, escaped — a byte scan is blind to it. */
function pageWithLdJson(headline: string): string {
  return (
    '<!doctype html><html lang="it"><head><title>Il territorio poroso</title>\n' +
    `<script type="application/ld+json">${JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'NewsArticle',
      headline,
      // A `<` in the prose, so the block carries the `\u003c` escape that
      // build-plugins/shared/inlineJsonScript.ts puts on every real one.
      articleBody: 'Un confine <strong>poroso</strong>',
      image: { caption: 'foto' },
    }).replace(/</g, '\\u003c')}</script>\n` +
    '</head><body><h1>Il territorio poroso</h1></body></html>\n'
  );
}

describe('what must be refused', () => {
  it('raw C0 anywhere in the document', () => {
    const html = `<!doctype html><title>${DIRTY_TITLE}</title>`;
    expect(isPublishable(html, 'html')).toBe(false);
    const findings = inspectDocument(html, 'html');
    expect(findings).toHaveLength(2);
    expect(findings[0].form).toBe('raw');
    expect(findings[0].code).toBe(0x08);
    // The context renders the byte AND the digit next to it: that pair is the
    // anchor a repair needs, and printing only the byte would throw half of it
    // away (corpus issue #94 recovered 303 of 582 occurrences from this pair).
    expect(findings[0].context).toContain('<0x08>3territorio');
  });

  it('the escaped spelling inside a ld+json block, which no byte scan sees', () => {
    const html = pageWithLdJson(DIRTY_TITLE);
    expect(html).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/); // nothing raw in the file
    expect(isPublishable(html, 'html')).toBe(false);
    const findings = inspectDocument(html, 'html');
    expect(findings).toHaveLength(2);
    expect(findings[0].form).toBe('json-string');
    expect(findings[0].pointer).toBe('/headline');
    expect(findings[0].code).toBe(0x08);
  });

  it('a control character in a ld+json KEY, not only in a value', () => {
    const html =
      '<script type="application/ld+json">' +
      JSON.stringify({ [`head${BS}line`]: 'pulito' }) +
      '</script>';
    const findings = inspectDocument(html, 'html');
    expect(findings).toHaveLength(1);
    expect(findings[0].form).toBe('json-key');
  });

  it('a \\uXXXX escape denoting a C0, in a plain inline script', () => {
    const html = '<script>window.__ARTICLE_TITLE__="sar\\u00170 l\'inferno"</script>';
    expect(isPublishable(html, 'html')).toBe(false);
    const findings = inspectDocument(html, 'html');
    expect(findings).toHaveLength(1);
    expect(findings[0].form).toBe('escaped');
    expect(findings[0].code).toBe(0x17);
  });

  it('a numeric character reference in XML — another spelling of the same character', () => {
    const xml = '<urlset><url><image:title>a&#8;b</image:title></url></urlset>';
    expect(isPublishable(xml, 'xml')).toBe(false);
    expect(inspectDocument(xml, 'xml')[0].form).toBe('reference');
  });

  it('an escaped C0 in a .json document, read by parsing rather than matching', () => {
    const json = JSON.stringify({ ranking: [{ name: `Chi${BS}asso` }] });
    expect(json).not.toMatch(/[\u0000-\u0008]/); // escaped, so byte-clean
    expect(isPublishable(json, 'json')).toBe(false);
    expect(inspectDocument(json, 'json')[0].pointer).toBe('/ranking/0/name');
  });
});

describe('the shapes that must NEVER be refused', () => {
  // ── The disqualifying false positive of PR #5488 ──────────────────────────
  //
  // Reduced from the live home page at the exact offsets the closed PR's gate
  // reported (@99195, @100936, …): a `'` inside a comment, then regex literals
  // whose `\b` is a word boundary. Ten findings there, all false.
  const HOME_PAGE_CONSTRUCT =
    '<script>\n' +
    "      // a literal leading space instead of a `\\b` word boundary (e.g. `/ is not a function/`\n" +
    "      // vs resilientImport's own `/\\bis not a function\\b/`)\n" +
    '      if (e && e.name === \'TypeError\' && (\n' +
    '        /\\bis not a function\\b/.test(m) ||\n' +
    '        /\\bis not a constructor\\b/.test(m) ||\n' +
    '        /\\bcannot read propert(?:y|ies) of undefined\\b/.test(m)\n' +
    '      )) { return; }\n' +
    '</script>';

  it('regex word boundaries after an apostrophe in a comment (the #5488 killer)', () => {
    expect(inspectDocument(HOME_PAGE_CONSTRUCT, 'html')).toEqual([]);
    expect(isPublishable(HOME_PAGE_CONSTRUCT, 'html')).toBe(true);
  });

  it('a doubled backslash before u0008 — a literal backslash, not an escape', () => {
    const html = String.raw`<script>var s="C:\\u0008backup"</script>`;
    expect(inspectDocument(html, 'html')).toEqual([]);
  });

  it('\\u003c, which every ld+json block on the site carries by construction', () => {
    // build-plugins/shared/inlineJsonScript.ts escapes `<` this way on EVERY
    // inline JSON block. A gate that read `\u00XX` as "suspicious" rather than
    // decoding it would refuse every article page on the site.
    const html = pageWithLdJson('Il territorio poroso');
    expect(html).toContain('\\u003c');
    expect(inspectDocument(html, 'html')).toEqual([]);
  });

  it('TAB, LF and CR, the three C0 characters XML and JSON both admit', () => {
    expect(inspectDocument('<p>a\tb\r\nc</p>', 'html')).toEqual([]);
  });

  it('accented text and typographic quotes', () => {
    expect(inspectDocument('<h1>Perché «martedì» — più</h1>', 'html')).toEqual([]);
  });

  it('an external script, which has no body of ours to judge', () => {
    expect(inspectDocument('<script src="/a.js"></script>', 'html')).toEqual([]);
  });

  it('DELIBERATE GAP: a bare \\b in a NON-JSON inline script is not flagged', () => {
    // Pinned, not fixed. `\b` is the spelling a regex word boundary shares, and
    // telling the two apart needs the quote tracking that disqualified #5488.
    // The gap is on paper only: the same title reaches <title> raw (caught) and
    // the NewsArticle `headline` of the ld+json next to it (caught by parsing).
    // If this ever has to be widened, it must be widened BY PARSING.
    const html = '<script>window.__ARTICLE_TITLE__="marted\\b8"</script>';
    expect(inspectDocument(html, 'html')).toEqual([]);
    // …and the same title, on the same page, is still refused through the
    // other two doors:
    expect(isPublishable(`<title>marted${BS}8</title>${html}`, 'html')).toBe(false);
    expect(isPublishable(pageWithLdJson(`marted${BS}8`), 'html')).toBe(false);
  });
});

describe('kindForPath', () => {
  it('routes each serialisation to its detector, and anything else to the raw pass', () => {
    expect(kindForPath('articoli-frontaliere/x/index.html')).toBe('html');
    expect(kindForPath('sitemap-topics-frontaliere.xml')).toBe('xml');
    expect(kindForPath('meta-it.json')).toBe('json');
    expect(kindForPath('llms.txt')).toBe('text');
    expect(kindForPath(undefined)).toBe('text');
  });
});

describe('screenShardPaths — per file, never per process', () => {
  let dir: string;
  let errors: string[];
  let warns: string[];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctrlchar-gate-'));
    errors = [];
    warns = [];
    vi.spyOn(console, 'error').mockImplementation((line: unknown) => void errors.push(String(line)));
    vi.spyOn(console, 'warn').mockImplementation((line: unknown) => void warns.push(String(line)));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const write = (rel: string, body: string): string => {
    fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body, 'utf-8');
    return rel;
  };

  it('publishes the clean pages and withholds only the poisoned one', () => {
    const clean1 = write('a/index.html', '<title>pulito</title>');
    const dirty = write('b/index.html', `<title>${DIRTY_TITLE}</title>`);
    const clean2 = write('c/index.html', pageWithLdJson('pulito'));

    const screening = screenShardPaths({ baseDir: dir, relPaths: [clean1, dirty, clean2] });

    expect(screening.publishable).toEqual([clean1, clean2]);
    expect(screening.refused.map((r: { relPath: string }) => r.relPath)).toEqual([dirty]);
    expect(screening.checked).toBe(3);
  });

  it('never throws, whatever it finds', () => {
    const dirty = write('b/index.html', `<title>${DIRTY_TITLE}</title>`);
    expect(() => screenShardPaths({ baseDir: dir, relPaths: [dirty] })).not.toThrow();
  });

  it('prints a located ::error:: naming the byte and its neighbourhood', () => {
    const dirty = write('b/index.html', `<title>${DIRTY_TITLE}</title>`);
    screenShardPaths({ baseDir: dir, relPaths: [dirty], logPrefix: '[x]' });
    expect(errors[0]).toContain('::error::[x] REFUSING to publish b/index.html');
    expect(errors[0]).toContain('do NOT');
    expect(errors[1]).toContain('0x08 (raw)');
    expect(errors[1]).toContain('<0x08>3territorio');
  });

  it('leaves an unreadable path in the push list rather than swallowing its own error', () => {
    // A listed-but-absent relpath is push-article-shard-incremental.sh's error
    // to report, and it reports it more accurately.
    const screening = screenShardPaths({ baseDir: dir, relPaths: ['nope/index.html'] });
    expect(screening.publishable).toEqual(['nope/index.html']);
    expect(screening.refused).toEqual([]);
    expect(warns[0]).toContain('could not read nope/index.html');
  });

  it('reads a repeated path once and answers about it once', () => {
    const clean = write('a/index.html', '<title>pulito</title>');
    const screening = screenShardPaths({ baseDir: dir, relPaths: [clean, clean] });
    expect(screening.publishable).toEqual([clean]);
    expect(screening.checked).toBe(1);
  });
});

describe('keepPublishable — the half that makes the verdict load-bearing', () => {
  it('drops exactly what was refused and preserves order', () => {
    const screening = {
      verdict: new Map([
        ['a.html', true],
        ['b.html', false],
        ['c.html', true],
      ]),
    };
    expect(keepPublishable(['a.html', 'b.html', 'c.html'], screening)).toEqual(['a.html', 'c.html']);
  });

  it('keeps a path the screen never saw — it removes refusals, it does not require approval', () => {
    const screening = { verdict: new Map([['a.html', true]]) };
    expect(keepPublishable(['a.html', 'unseen.html'], screening)).toEqual(['a.html', 'unseen.html']);
  });

  it('can empty a locale completely, which is a valid outcome', () => {
    const screening = { verdict: new Map([['only.html', false]]) };
    expect(keepPublishable(['only.html'], screening)).toEqual([]);
  });
});

describe('formatRefusal', () => {
  it('says what happens to the page and forbids the strip in the same breath', () => {
    const [head] = formatRefusal('x/index.html', inspectDocument(`<p>${DIRTY_TITLE}</p>`, 'html'));
    expect(head).toContain('left at its previously');
    expect(head).toContain('do NOT');
    expect(head).toContain('#5457');
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * The wiring guard.
 *
 * Not "is the gate called" — #5488 was called. "Is its ANSWER what the push
 * list is built from", read off the AST rather than off a regex, plus the
 * inverse: that no sanitiser from the twin module has been wired into the
 * publish path, because on this side stripping is the wrong policy and the
 * only thing standing between the two is a decision nobody has written down
 * anywhere the code can check.
 * ──────────────────────────────────────────────────────────────────────── */

/** Parse a .mjs file into a TS AST — the same route tests/packages-articles-confinement.test.ts takes. */
function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    fs.readFileSync(file, 'utf-8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
}

/** Every `export function <name>` in a module, read from the module itself. */
function exportedFunctionNames(file: string): string[] {
  const names: string[] = [];
  parse(file).forEachChild((node) => {
    if (
      ts.isFunctionDeclaration(node) &&
      node.name &&
      node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      names.push(node.name.text);
    }
  });
  return names;
}

/** Names imported from `specifier` by `sourceFile`. */
function importedFrom(sourceFile: ts.SourceFile, specifier: string): string[] {
  const names: string[] = [];
  sourceFile.forEachChild((node) => {
    if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) return;
    if (node.moduleSpecifier.text !== specifier) return;
    const bindings = node.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const el of bindings.elements) names.push(el.name.text);
    }
  });
  return names;
}

/** Every identifier called as a function anywhere under `node`. */
function calledNames(node: ts.Node): Set<string> {
  const out = new Set<string>();
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) out.add(n.expression.text);
    ts.forEachChild(n, visit);
  };
  visit(node);
  return out;
}

/** The initializer of `const <name> = …`, wherever it is declared. */
function initializerOf(sourceFile: ts.SourceFile, name: string): ts.Expression | undefined {
  let found: ts.Expression | undefined;
  const visit = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name) {
      found = n.initializer;
    }
    ts.forEachChild(n, visit);
  };
  visit(sourceFile);
  return found;
}

describe('the gate is wired into the publish path, and its answer is used', () => {
  const publisher = parse(PUBLISHER);

  it('scripts/publish-article-fast.mjs imports the gate', () => {
    const imported = importedFrom(publisher, './lib/control-char-publish-gate.mjs');
    expect(imported).toContain('screenShardPaths');
    expect(imported).toContain('keepPublishable');
  });

  it('the screening result is what `shards` is built from — not the raw candidate list', () => {
    // The assertion #5488 lacked. Swapping `keepPublishable(candidates, screening)`
    // back to `candidates` leaves the gate called, its log lines printed and
    // every other test in this file green — and every poisoned page pushed.
    const shards = initializerOf(publisher, 'shards');
    expect(shards, 'scripts/publish-article-fast.mjs no longer declares `shards`').toBeDefined();

    const inShards = calledNames(shards!);
    expect(
      inShards.has('keepPublishable'),
      'the `shards` initializer no longer calls keepPublishable — the gate has been made decorative',
    ).toBe(true);

    // …and it is called WITH the screening, not with an empty verdict.
    let passesScreening = false;
    const visit = (n: ts.Node): void => {
      if (
        ts.isCallExpression(n) &&
        ts.isIdentifier(n.expression) &&
        n.expression.text === 'keepPublishable' &&
        n.arguments.some((a) => ts.isIdentifier(a) && a.text === 'screening')
      ) {
        passesScreening = true;
      }
      ts.forEachChild(n, visit);
    };
    visit(shards!);
    expect(passesScreening, 'keepPublishable is called without the screening result').toBe(true);
  });

  it('`screening` itself comes from screenShardPaths', () => {
    const screening = initializerOf(publisher, 'screening');
    expect(screening).toBeDefined();
    expect(ts.isCallExpression(screening!) && ts.isIdentifier(screening!.expression)).toBe(true);
    expect((screening as ts.CallExpression).expression.getText()).toBe('screenShardPaths');
  });

  it('a shard never advertises a `url` unconditionally', () => {
    // scripts/wait-for-live-article-shards.mjs polls `shards[].url` and digests
    // the first index.html in that shard's `paths` to compare against it. When
    // the ARTICLE page is the refused one, a NEW article's URL 404s because it
    // was never pushed and the digest comes from a hub page — so an
    // unconditional `url` turns a correct refusal into a failed publish and a
    // Bug issue claiming the article never went out. The property must stay
    // behind a condition.
    const shards = initializerOf(publisher, 'shards');
    const unguarded: string[] = [];
    const visit = (n: ts.Node, insideConditional: boolean): void => {
      const nowInside =
        insideConditional || ts.isConditionalExpression(n) || ts.isIfStatement(n);
      if (
        ts.isPropertyAssignment(n) &&
        ts.isIdentifier(n.name) &&
        n.name.text === 'url' &&
        !nowInside
      ) {
        unguarded.push(n.getText());
      }
      ts.forEachChild(n, (c) => visit(c, nowInside));
    };
    visit(shards!, false);
    expect(unguarded).toEqual([]);
  });

  it('the apex sitemap goes through the gate as well as the shard pages', () => {
    const edgeFiles = initializerOf(publisher, 'edgeFiles');
    expect(edgeFiles).toBeDefined();
    // `edgeFiles` is declared empty and filled by the `if` below it, so the
    // check is on the whole file: the sitemap path must be named in a
    // keepPublishable call somewhere.
    let sitemapScreened = false;
    const visit = (n: ts.Node): void => {
      if (
        ts.isCallExpression(n) &&
        ts.isIdentifier(n.expression) &&
        n.expression.text === 'keepPublishable' &&
        /sitemapPath/.test(n.getText())
      ) {
        sitemapScreened = true;
      }
      ts.forEachChild(n, visit);
    };
    visit(publisher);
    expect(
      sitemapScreened,
      'topicHubResult.sitemapPath is published without passing the control-character gate',
    ).toBe(true);
  });

  it('no sanitiser is wired into the publish path — on this side the policy is refusal', () => {
    // Read from the twin module rather than listed here, so a `sanitizeAnything`
    // added to it tomorrow is covered without anyone remembering this line.
    // The corpus's own guard learned this the hard way (its issue #133): a
    // hand-written list of names can only find the shapes its author already
    // knew, and four emitters had a different one.
    const sanitisers = exportedFunctionNames(SANITISER).filter((n) => n.startsWith('sanitize'));
    expect(sanitisers.length, 'the twin module exports no sanitizer* — has it been replaced?')
      .toBeGreaterThanOrEqual(4);

    const called = calledNames(publisher);
    const wired = sanitisers.filter((name) => called.has(name));
    expect(
      wired,
      'scripts/publish-article-fast.mjs calls a sanitiser. On the SITE that is the wrong\n' +
        'policy: stripping the byte leaves the mangled tail behind and overwrites a page that\n' +
        'is currently served CORRECTLY with a half-repaired one (measured on\n' +
        'lavena-ponte-tresa-territorio-poroso, 2026-08-09). The corpus strips because it emits\n' +
        'a 3120-URL sitemap where one byte can cost the whole document; here a refusal costs\n' +
        'exactly the page it refuses. See scripts/lib/control-char-publish-gate.mjs.',
    ).toEqual([]);
  });

  it('the gate itself imports the shared predicate instead of redefining it', () => {
    const fromTwin = importedFrom(parse(GATE), './sanitize-control-chars.mjs');
    expect(fromTwin).toContain('isInvalidControlCode');
    expect(fromTwin).toContain('findControlChars');
  });
});
