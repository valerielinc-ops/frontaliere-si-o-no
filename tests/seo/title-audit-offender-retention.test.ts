import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

/**
 * Do the bundled title audits retain the page each offending <title> came from?
 *
 * The question is live because `scripts/cathedral-seo-gates-check.mjs` now runs
 * four audits inside ONE `audit-all` spawn over the whole corpus instead of
 * four processes with 8192 MB each. Retentions that were survivable in
 * isolation add up in a shared heap, and both of these audits push a `title`
 * that ORIGINATES as `html.match(TITLE_RE)[1]` — a V8 SlicedString into the
 * whole document, the mechanism #7441 measured at 40,359 B/entry for paths.
 *
 * MEASURED ANSWER: no, they do not, and the reason is incidental rather than
 * designed. `normalizeText()` ends with `s.replace(/\s+/g, ' ').trim()`, and a
 * global `replace` that matches anything REBUILDS the string; every real title
 * contains whitespace, so what reaches `offenders.push` is already a fresh
 * flat string. Probed on 40 KB pages, with and without an explicit flatten:
 * 953 vs 1001 B/offender — no difference. `hash: m[0]` is safe for a second
 * reason: `HASH_RE` matches exactly 11 characters, below V8's
 * `SlicedString::kMinLength` of 13, so it is copied by construction.
 *
 * The explicit `flatString()` calls stay anyway. They cost a ~90-byte copy per
 * offender, they close the one path the incidental flatten does not cover (a
 * >66-char title containing no whitespace at all, where every `replace` is a
 * no-op and the slice survives), and they make the boundary say what it means
 * instead of depending on a `\s+` in a helper three functions away.
 *
 * So this file is a REGRESSION guard, not a bug reproduction — which is
 * exactly the kind of test that silently stops testing anything. Hence the
 * control below: a probe that deliberately retains a raw capture and MUST come
 * out high. If the control ever goes quiet, the instrument is broken and the
 * two real assertions are worthless, whatever they say.
 *
 * Measuring retention needs a deterministic collection point; `global.gc` only
 * exists under `--expose-gc` and vitest runs workers without it, so — same
 * approach as `bfs-audit-path-retention.test.ts` — each probe runs in a child
 * process that has the flag. It also displaces V8's last-regexp-match info
 * before collecting: that reference pins the last regexp SUBJECT, i.e. the
 * whole page, in every arm at once, and without displacing it a retention
 * probe reads the same number whether or not anything is retained.
 */

const REPO_ROOT = resolve(__dirname, '..', '..');
const PAGES = 300;
const FILLER_BYTES = 40_000;

function probe(body: string): number {
  const source = `
    const PAGES = ${PAGES}, FILLER = ${FILLER_BYTES};
    const settle = () => { for (let i = 0; i < 4; i++) global.gc({ type: 'major', execution: 'sync' }); };
    const pageFor = (i) => {
      // Built per iteration, never shared: a hoisted filler would be one live
      // string for every page and would mask exactly what we are measuring.
      const filler = '<p>' + 'contenuto di riempimento '.repeat(FILLER / 25) + '</p>';
      const title = 'Stipendio medio infermiere professionale diplomata in Ticino nel 2026 (#a1b2c3) numero ' + i;
      return '<!doctype html><html lang="it"><head><title>' + title +
        '</title></head><body>' + filler + '</body></html>';
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

describe('title audits — an offender must not retain the page its title came from', () => {
  it('CONTROL: the probe DOES see retention when a raw capture is kept', () => {
    // Without this the two assertions below could pass because the harness
    // measures nothing. Keep a raw regex capture and the page must follow it.
    const perOffender = probe(`
      const TITLE_RE = /<title[^>]*>([\\s\\S]*?)<\\/title>/i;
      const kept = [];
      settle();
      const before = process.memoryUsage().heapUsed;
      for (let i = 0; i < PAGES; i++) kept.push(pageFor(i).match(TITLE_RE)[1]);
    `);
    expect(
      perOffender,
      `control read ${perOffender.toFixed(0)} B/offender — the probe can no longer detect retention, so the assertions below prove nothing`,
    ).toBeGreaterThan(FILLER_BYTES / 2);
  });

  for (const [name, path, opts] of [
    ['audit-title-length', 'scripts/audit-title-length.mjs', '{ threshold: 66 }'],
    ['audit-title-no-disambig-hash', 'scripts/audit-title-no-disambig-hash.mjs', '{}'],
  ] as const) {
    it(`${name} keeps far less than one page per offender`, () => {
      const perOffender = probe(`
        const { createAuditor } = await import(${JSON.stringify(`${REPO_ROOT}/${path}`)});
        const auditor = createAuditor(${opts});
        settle();
        const before = process.memoryUsage().heapUsed;
        for (let i = 0; i < PAGES; i++) auditor.collect('/tmp/dist/pagina-' + i + '/index.html', pageFor(i));
      `);
      expect(
        perOffender,
        `retained ${perOffender.toFixed(0)} B/offender — each offender is holding its ~${FILLER_BYTES} B page alive`,
      ).toBeLessThan(FILLER_BYTES / 4);
    });
  }
});
