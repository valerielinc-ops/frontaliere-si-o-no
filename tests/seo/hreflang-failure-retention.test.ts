import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Do the hreflang gates retain the page each failing href came from?
 *
 * Issue #7488 item 3 asked the question the other way round: #7441 flattened
 * the sitemap LOADERS, so does a slice DERIVED downstream of that boundary
 * re-enter a long-lived accumulator and reintroduce the retention at a second
 * boundary? Following the consumers of `loadSoft404Urls()` answered no — the
 * values those consumers derive (`url.replace(HOST, '')`) hang off a URL that
 * the loader already flattened, so their transitive parent is an ~80 B flat
 * string, not a document. The three hreflang gates are where the answer is
 * yes: their hrefs never came from a sitemap at all, they are regex captures
 * out of the page HTML, and the message that keeps them lives for the whole
 * corpus walk.
 *
 * The failure mode is the one from #7419 and from the canonical gates
 * (tests/seo/canonical-audit-offender-retention.test.ts): a SlicedString is a
 * header pointing INTO the parent, so a 60-char href pins its whole document.
 * hreflang is emitted by ONE shared template, which makes the degenerate case
 * the normal shape of a regression here — not a handful of offenders but every
 * page at once — and the gate then dies of the heap limit instead of printing
 * the diagnosis that is its entire purpose.
 *
 * The flatten is at the PUSH boundary, not at extraction: paid per FAILURE, so
 * a healthy run pays nothing and the Buffer round-trip never lands on the
 * per-page hot path.
 *
 * WHY A SOURCE ASSERTION FOR THE GATES: none of the three exposes an
 * importable seam — `validate-hreflang.mjs` runs its scan as a top-level side
 * effect, `audit-hreflang.mjs` keeps it inside `main()`, and neither exports
 * anything. The measured half of the question is the CONTROL/TREATMENT pair
 * below, which drives the exact extraction-and-push shape those three share.
 */

const REPO_ROOT = resolve(__dirname, '..', '..');

/** Source with `//` line comments removed, so prose cannot satisfy an assertion. */
function sourceWithoutLineComments(rel: string): string {
  return readFileSync(resolve(REPO_ROOT, rel), 'utf8')
    .split('\n')
    .map((l) => l.replace(/^\s*\/\/.*$/, ''))
    .join('\n');
}

/** The argument text of every `…push(` call in `src`, parens balanced. */
function pushCallArgs(src: string): string[] {
  const out: string[] = [];
  const re = /\bpush\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (i < src.length && depth > 0) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')') depth--;
      i++;
    }
    out.push(src.slice(start, i - 1));
  }
  return out;
}

/**
 * The same text with the CONTENT of string literals removed, so the word
 * `href` inside a message is not mistaken for a reference to the binding.
 * Template substitutions are kept: `${href}` in a message IS a reference, and
 * the ConsString retains it exactly like a property would.
 */
function codeOnly(text: string): string {
  return text
    .replace(/`(?:[^`\\$]|\\.|\$(?!\{)|\$\{[^{}]*\})*`/g, (lit) =>
      (lit.match(/\$\{[^{}]*\}/g) ?? []).join(' '))
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

/**
 * The bindings that hold a capture out of the page HTML. `error` is included
 * because `validateLocalePair()` returns a message that embeds `href` and
 * slices of it — a slice of a slice, still pointing at the document.
 */
const PAGE_DERIVED = /\b(?:href|itHref|xDefault|error)\b/;

const HREFLANG_GATES = [
  'scripts/validate-hreflang.mjs',
  'scripts/audit-hreflang.mjs',
  'scripts/audit-dist-multi.mjs',
] as const;

describe('hreflang gates — a failure must not retain the page its href came from', () => {
  for (const rel of HREFLANG_GATES) {
    it(`${rel} flattens every failure message carrying a page-derived href`, () => {
      const src = sourceWithoutLineComments(rel);

      const carrying = pushCallArgs(src)
        .map(codeOnly)
        .filter((args) => PAGE_DERIVED.test(args));

      // Anti-vacuity: the boundary must still exist. A rename or a rewrite of
      // the accumulator has to break this test, not quietly empty it.
      expect(
        carrying.length,
        `${rel} no longer pushes any page-derived href — this guard has stopped guarding anything`,
      ).toBeGreaterThan(0);

      for (const args of carrying) {
        expect(
          args.includes('flatString('),
          `${rel} keeps a raw href capture in a scan-long accumulator, which pins the whole page it was scraped from:\n${args.trim()}`,
        ).toBe(true);
      }
    });
  }
});

/**
 * The measured arm: the extraction-and-push shape the three gates share,
 * driven with and without the flatten.
 *
 * Retention needs a deterministic collection point and `global.gc` only exists
 * under `--expose-gc`, which vitest workers do not have (vitest.config.ts runs
 * `pool: 'threads'` with no `execArgv`), so `globalThis.gc` is ALWAYS undefined
 * inside the runner and a `gc?.()` here would be a silent no-op. Hence the
 * child process — same approach as bfs-audit-path-retention.test.ts. The probe
 * also displaces V8's last-regexp-match info before collecting, since that
 * reference alone pins the last page.
 */
const PAGES = 300;
const FILLER_BYTES = 40_000;

function probe(flatten: boolean): number {
  const source = `
    const PAGES = ${PAGES}, FILLER = ${FILLER_BYTES};
    const { flatString } = await import(${JSON.stringify(`${REPO_ROOT}/scripts/lib/flat-string.mjs`)});
    const keep = ${flatten ? '(s) => flatString(s)' : '(s) => s'};
    const settle = () => { for (let i = 0; i < 4; i++) global.gc({ type: 'major', execution: 'sync' }); };
    const pageFor = (i) => {
      const filler = '<p>' + 'contenuto di riempimento '.repeat(FILLER / 25) + '</p>';
      const href = 'https://frontaliereticino.ch/en/stipendio-medio-infermiere-ticino-' + i + '/';
      return '<!doctype html><html lang="it"><head><link rel="alternate" hreflang="en" href="' +
        href + '"></head><body>' + filler + '</body></html>';
    };
    // Verbatim shape of extractAlternates() in the three gates.
    const RE = /<link\\s+rel=["']?alternate["']?[^>]*hreflang=["']?([^"'\\s>]+)["']?[^>]*href=["']?([^"'\\s>]+)["']?/gi;
    const failures = [];
    settle();
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < PAGES; i++) {
      const html = pageFor(i);
      const alternates = new Map();
      let m;
      RE.lastIndex = 0;
      while ((m = RE.exec(html)) !== null) alternates.set(m[1], m[2]);
      const rel = 'pagina-' + i + '/index.html';
      for (const [hreflang, href] of alternates) {
        failures.push(keep(\`\${rel}: hreflang="\${hreflang}" target not found in dist/ (\${href})\`));
      }
    }
    /x/.exec('x');
    settle();
    const after = process.memoryUsage().heapUsed;
    if (failures.length !== PAGES) throw new Error('probe collected ' + failures.length + ' failures, expected ' + PAGES);
    console.log(String((after - before) / PAGES));
  `;
  const out = execFileSync(
    process.execPath,
    ['--expose-gc', '--input-type=module', '-e', source],
    { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  return Number(out.trim().split('\n').pop());
}

describe('hreflang failure message — measured retention at the push boundary', () => {
  it('CONTROL: the raw message DOES hold one page per failure', () => {
    const perFailure = probe(false);
    expect(
      perFailure,
      `control read ${perFailure.toFixed(0)} B/failure — the probe can no longer detect retention, so the assertion below proves nothing`,
    ).toBeGreaterThan(FILLER_BYTES / 2);
  });

  it('the flattened message keeps far less than one page per failure', () => {
    const perFailure = probe(true);
    expect(
      perFailure,
      `retained ${perFailure.toFixed(0)} B/failure — each failure is still holding its ~${FILLER_BYTES} B page alive`,
    ).toBeLessThan(FILLER_BYTES / 8);
  });
});
