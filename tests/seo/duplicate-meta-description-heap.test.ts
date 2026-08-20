/**
 * The duplicate-meta-description auditor keeps one entry per DISTINCT meta
 * description — on the production corpus, ~1M of them. Each entry stores a
 * 100-char sample, and that sample is `desc.slice(0, 100)`.
 *
 * In V8 a slice is a SlicedString: a pointer into the parent plus an offset.
 * Keeping the sample therefore keeps the whole page it was extracted from
 * alive, and 1M resident pages is how `audit:all` hit
 * `--max-old-space-size=4096` on post-deploy run 32261742920:
 *
 *     FATAL ERROR: Ineffective mark-compacts near heap limit
 *
 * which reached the failure classifier as the unclassifiable bundle name
 * `audit:all` and, fail-closed, sequestered `publish`.
 *
 * The code already tried to defend against exactly this, with
 * `` sample: `${desc.slice(0, 100)}` `` and a comment asserting that "the
 * template literal forces a flat copy". Measured, it does not — V8 optimises a
 * single-substitution template away, along with `.normalize()`, `.repeat(1)`
 * and `.padEnd(len)`. A wrong defence is worse than none, because it stops
 * anyone from looking again.
 *
 * WHY A CHILD PROCESS. Measuring retention needs a deterministic collection
 * point, and `global.gc` only exists under `--expose-gc`. vitest.config.ts
 * runs `pool: 'threads'` with no `execArgv`, and tests.yml passes no such flag,
 * so inside the test runner `globalThis.gc` is ALWAYS undefined — a
 * `gc?.()` here would be a silent no-op and the assertion would rest on
 * whatever incidental collection happened to occur. That is how a guard
 * becomes decorative. Spawning one short-lived `node --expose-gc` gives the
 * measurement a real collection point without imposing a flag on the whole
 * suite; it costs well under a second.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const AUDITOR = resolve(REPO_ROOT, 'scripts/audit-duplicate-meta-description.mjs');

const PAGES = 3_000;
const FILLER_BYTES = 40_000;

/**
 * Feed the auditor large pages with distinct descriptions, hold its state, and
 * report bytes retained per entry across a forced major GC.
 */
const PROBE = `
import { createAuditor } from ${JSON.stringify(AUDITOR)};

const PAGES = ${PAGES};
const FILLER_BYTES = ${FILLER_BYTES};

function bigPage(i) {
  const filler = '<p>' + 'contenuto di riempimento '.repeat(FILLER_BYTES / 25) + '</p>';
  return '<!doctype html><html lang="it"><head>'
    + '<meta name="description" content="Descrizione unica numero ' + i
    + ' — abbastanza lunga da somigliare a una meta description reale del sito, con parecchie parole di contorno per superare i cento caratteri del campione.">'
    + '</head><body>' + filler + '</body></html>';
}

const settle = () => { for (let i = 0; i < 4; i++) global.gc({ type: 'major', execution: 'sync' }); };

const auditor = createAuditor();
settle();
const before = process.memoryUsage().heapUsed;
for (let i = 0; i < PAGES; i++) auditor.collect('/dist/sezione/pagina-' + i + '/index.html', bigPage(i));
settle();
const after = process.memoryUsage().heapUsed;

const result = auditor.report();
process.stdout.write(JSON.stringify({
  perEntry: (after - before) / PAGES,
  passed: result.passed,
  offendersTotal: result.offendersTotal,
}));
`;

describe('duplicate-meta-description — the sample must not retain its page', () => {
  it(`keeps far less than one page per entry across ${PAGES} distinct descriptions`, () => {
    const out = execFileSync(process.execPath, ['--expose-gc', '--input-type=module', '-e', PROBE], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    });
    const { perEntry, passed, offendersTotal } = JSON.parse(out) as {
      perEntry: number;
      passed: boolean;
      offendersTotal: number;
    };

    // Retaining the parent costs >= FILLER_BYTES per entry; a flattened sample
    // costs a few hundred bytes. Two orders of magnitude apart, so this bound
    // fires only if the SlicedString comes back.
    expect(
      perEntry,
      `retained ${perEntry.toFixed(0)} B/entry — the 100-char sample is holding its ~${FILLER_BYTES} B page alive again`,
    ).toBeLessThan(FILLER_BYTES / 8);

    // And the audit still has to WORK: distinct descriptions, no offenders.
    expect(passed).toBe(true);
    expect(offendersTotal).toBe(0);
  });

  it('still detects duplicates, and reports the sample text intact', async () => {
    const { createAuditor } = await import('../../scripts/audit-duplicate-meta-description.mjs');
    const auditor = createAuditor();
    const shared =
      'Una descrizione condivisa da troppe pagine, lunga a sufficienza da non finire nella allowlist e da essere troncata nel campione.';
    for (let i = 0; i < 6; i++) {
      auditor.collect(
        `/dist/sezione/dup-${i}/index.html`,
        `<html><head><meta name="description" content="${shared}"></head><body>x</body></html>`,
      );
    }
    const result = auditor.report();
    expect(result.passed).toBe(false);
    expect(result.offenders[0].metric).toBe(6);
    // The flattening must be content-exact, accents included.
    expect(shared.startsWith(String(result.offenders[0].description))).toBe(true);
  });
});
