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
 * So this test measures the retention rather than reading the code: it holds
 * the auditor's collected state alive and checks the heap did not grow by
 * anything like one parent document per entry.
 */
import { describe, it, expect } from 'vitest';
import { createAuditor } from '../../scripts/audit-duplicate-meta-description.mjs';

const PAGES = 3_000;
const FILLER_BYTES = 40_000;

/** One large page per call, each with its own distinct meta description. */
function bigPage(i: number): string {
  const filler = `<p>${'contenuto di riempimento '.repeat(FILLER_BYTES / 25)}</p>`;
  return (
    `<!doctype html><html lang="it"><head>` +
    `<meta name="description" content="Descrizione unica numero ${i} — abbastanza lunga da somigliare a una meta description reale del sito, con parecchie parole di contorno per superare i cento caratteri del campione.">` +
    `</head><body>${filler}</body></html>`
  );
}

describe('duplicate-meta-description — the sample must not retain its page', () => {
  it(`keeps far less than one page per entry across ${PAGES} distinct descriptions`, () => {
    const auditor = createAuditor();

    const gc = (globalThis as { gc?: () => void }).gc;
    gc?.();
    const before = process.memoryUsage().heapUsed;

    for (let i = 0; i < PAGES; i++) {
      auditor.collect(`/dist/sezione/pagina-${i}/index.html`, bigPage(i));
    }

    gc?.();
    const after = process.memoryUsage().heapUsed;
    const perEntry = (after - before) / PAGES;

    // Retaining the parent costs ≥ FILLER_BYTES per entry. A flattened sample
    // costs a few hundred bytes. The gap is ~two orders of magnitude, so this
    // bound is far outside GC noise in either direction — it only fires if the
    // SlicedString comes back.
    expect(
      perEntry,
      `retained ${perEntry.toFixed(0)} B/entry — the 100-char sample is holding its ~${FILLER_BYTES} B page alive again`,
    ).toBeLessThan(FILLER_BYTES / 8);

    // And the audit still has to WORK: keep a reference so nothing above can be
    // optimised away, and confirm distinct descriptions produce no offenders.
    const result = auditor.report();
    expect(result.passed).toBe(true);
    expect(result.offendersTotal).toBe(0);
  });

  it('still detects duplicates, and reports the sample text intact', () => {
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
