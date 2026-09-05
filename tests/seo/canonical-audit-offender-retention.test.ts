import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Do the canonical gates retain the page each offending canonical came from?
 *
 * Every one of them extracts the canonical as a regex capture out of the page
 * HTML — a V8 SlicedString, a header pointing INTO the parent document — and
 * then stores it in an `offenders`/`errors` array that lives for the whole
 * scan. One offender is harmless, and a healthy run has zero. The case that
 * matters is the degenerate one: a category-wide canonical regression, i.e.
 * thousands of offenders, each pinning its own document. The gate then dies of
 * the heap limit instead of printing the diagnosis — exactly when the
 * diagnosis is the reason it exists (issue #7488, class of #7419).
 *
 * The flatten is deliberately at the PUSH boundary, not at extraction: it is
 * paid per OFFENDER, not per URL scanned, so a healthy run pays nothing and
 * the Buffer round-trip never lands on the ~360k-URL hot path.
 *
 * WHY A SOURCE ASSERTION FOR THE CANONICAL GATES: the four of them expose no
 * importable seam — `DIST` is a module-level `const` resolved at load and the
 * scan runs as a top-level side effect, so there is nothing to call from a
 * probe without restructuring the gates themselves. The invariant is
 * nonetheless exact and checkable: no `push()` may carry a non-null
 * `canonical` that has not gone through `flatString`. The measured half of the
 * question is covered below by the h1/title arm, which does export a seam, and
 * by tests/seo/title-audit-offender-retention.test.ts.
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
 * The same text with the CONTENT of string literals removed, so that the word
 * "canonical" inside a message (`'No canonical tag found'`, a summary line
 * naming the gate) is not mistaken for a reference to the variable. Template
 * substitutions are kept: `${canonical}` inside a message is a real reference,
 * and a ConsString retains it exactly like a property would.
 */
function codeOnly(text: string): string {
  return text
    .replace(/`(?:[^`\\$]|\\.|\$(?!\{)|\$\{[^{}]*\})*`/g, (lit) =>
      (lit.match(/\$\{[^{}]*\}/g) ?? []).join(' '))
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

const CANONICAL_GATES = [
  'scripts/validate-sitemap-pages.mjs',
  'scripts/audit-sitemap-canonicals.mjs',
  'scripts/audit-canonical-trailing-slash.mjs',
  'scripts/validate-canonical.mjs',
] as const;

describe('canonical gates — an offender must not retain the page its canonical came from', () => {
  for (const rel of CANONICAL_GATES) {
    it(`${rel} flattens every canonical it keeps`, () => {
      const src = sourceWithoutLineComments(rel);

      // The check is only meaningful if the file really does collect
      // canonicals; a rename or a rewrite must break this, not silence it.
      const carrying = pushCallArgs(src)
        .map(codeOnly)
        .filter((args) => /\bcanonical\b/.test(args) && !/canonical:\s*null/.test(args));
      expect(
        carrying.length,
        `${rel} no longer pushes any canonical — this guard has stopped guarding anything`,
      ).toBeGreaterThan(0);

      for (const args of carrying) {
        expect(
          args.includes('flatString('),
          `${rel} keeps a raw canonical capture, which pins the whole page it was scraped from:\n${args.trim()}`,
        ).toBe(true);
      }
    });
  }
});

/**
 * The measured arm. `audit-h1-title-duplicates.mjs` exports `createAuditor`,
 * so its real offender boundary can be driven directly. Retention needs a
 * deterministic collection point and `global.gc` only exists under
 * `--expose-gc`, which vitest workers do not have — hence the child process,
 * same approach as title-audit-offender-retention.test.ts. The probe also
 * displaces V8's last-regexp-match info before collecting, since that
 * reference alone pins the last page in every arm at once.
 */
const PAGES = 300;
const FILLER_BYTES = 40_000;

function probe(body: string): number {
  const source = `
    const PAGES = ${PAGES}, FILLER = ${FILLER_BYTES};
    const settle = () => { for (let i = 0; i < 4; i++) global.gc({ type: 'major', execution: 'sync' }); };
    const pageFor = (i) => {
      const filler = '<p>' + 'contenuto di riempimento '.repeat(FILLER / 25) + '</p>';
      // No whitespace in title/h1: that is the one path normalizeText()'s
      // trailing \\s+ replace does NOT rebuild, i.e. the path the explicit
      // flatString() exists for. Identical strings so title === h1 and the
      // page counts as an offender.
      const t = 'Stipendio-medio-infermiere-professionale-diplomata-Ticino-2026-numero-' + i;
      return '<!doctype html><html lang="it"><head><title>' + t +
        '</title></head><body><h1>' + t + '</h1>' + filler + '</body></html>';
    };
    ${body}
    /x/.exec('x');
    settle();
    console.log(String((process.memoryUsage().heapUsed - before) / PAGES));
  `;
  const out = execFileSync(
    process.execPath,
    ['--expose-gc', '--input-type=module', '-e', source],
    { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  return Number(out.trim().split('\n').pop());
}

describe('audit-h1-title-duplicates — offender retention', () => {
  it('CONTROL: the probe DOES see retention when a raw capture is kept', () => {
    const perOffender = probe(`
      const TITLE_RE = /<title[^>]*>([\\s\\S]*?)<\\/title>/i;
      const kept = [];
      settle();
      const before = process.memoryUsage().heapUsed;
      for (let i = 0; i < PAGES; i++) kept.push(pageFor(i).match(TITLE_RE)[1]);
    `);
    expect(
      perOffender,
      `control read ${perOffender.toFixed(0)} B/offender — the probe can no longer detect retention, so the assertion below proves nothing`,
    ).toBeGreaterThan(FILLER_BYTES / 2);
  });

  it('keeps far less than one page per offender', () => {
    const perOffender = probe(`
      const { createAuditor } = await import(${JSON.stringify(`${REPO_ROOT}/scripts/audit-h1-title-duplicates.mjs`)});
      const auditor = createAuditor({});
      settle();
      const before = process.memoryUsage().heapUsed;
      for (let i = 0; i < PAGES; i++) auditor.collect('/tmp/dist/pagina-' + i + '/index.html', pageFor(i));
    `);
    expect(
      perOffender,
      `retained ${perOffender.toFixed(0)} B/offender — each offender is holding its ~${FILLER_BYTES} B page alive`,
    ).toBeLessThan(FILLER_BYTES / 4);
  });
});
