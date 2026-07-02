/**
 * ensureLocaleFields — regression: mass needsRetranslation re-flag.
 *
 * Root cause (EOC 76% / migros-ticino 51% of jobs re-flagged every run):
 * ensureLocaleFields ran its wrong-language quality gate against a job's
 * FINAL title on every call, including titles this call left untouched. The
 * gate is a deterministic heuristic (cognate word-list matching) — once a
 * translation cascade elsewhere cleared needsRetranslation for a job whose
 * unchanged title still trips the heuristic (a false positive, e.g. shared
 * medical/technical terminology across locales), the very next crawl run
 * re-derived the same false-positive verdict and flipped the flag back to
 * true, undoing the cascade's resolution every single run.
 *
 * Fix: skip the wrong-language check for a locale whose title this call left
 * byte-identical to the input — needsRetranslation still carries over
 * correctly via the initial `out = { ...job }` spread, so genuinely-flagged
 * jobs stay flagged and newly-filled locale slots are still checked.
 */
import { describe, it, expect } from 'vitest';
import { ensureLocaleFields } from '../../scripts/lib/shared-jobs-crawler.mjs';

function baseJob(overrides = {}) {
  return {
    title: 'Tecnico specialista',
    description: 'Descrizione lunga del lavoro con dettagli tecnici e requisiti principali.',
    sourceLang: 'it',
    titleByLocale: { it: 'Tecnico specialista' },
    descriptionByLocale: { it: 'Descrizione lunga del lavoro con dettagli tecnici e requisiti principali.' },
    slugByLocale: {},
    needsRetranslation: false,
    ...overrides,
  };
}

describe('ensureLocaleFields — wrong-language quality gate', () => {
  it('does not re-flag a job whose de title is unchanged, even if it trips the cognate heuristic', () => {
    // "responsabile" + "tecnico" are IT-wordlist terms; a de-locale title
    // containing both trips _hasWrongLang('...', 'de') every time it is
    // re-evaluated — this is the exact false-positive shape from the
    // incident. A translation cascade elsewhere already accepted this title
    // and cleared the flag (needsRetranslation: false); the title text
    // itself never changed.
    const job = baseJob({
      titleByLocale: {
        it: 'Tecnico specialista',
        de: 'responsabile tecnico Buero',
      },
      needsRetranslation: false,
    });

    const result = ensureLocaleFields(job);

    expect(result.needsRetranslation).toBe(false);
  });

  it('leaves an already-flagged job flagged when its title is unchanged', () => {
    const job = baseJob({
      titleByLocale: {
        it: 'Tecnico specialista',
        de: 'responsabile tecnico Buero',
      },
      needsRetranslation: true,
    });

    const result = ensureLocaleFields(job);

    expect(result.needsRetranslation).toBe(true);
  });

  it('still fills a genuinely empty locale slot (new job path is unaffected)', () => {
    const job = baseJob({
      titleByLocale: { it: 'Tecnico specialista' },
      needsRetranslation: false,
    });

    const result = ensureLocaleFields(job);

    expect(typeof result.titleByLocale).toBe('object');
    expect(result.titleByLocale.it).toBe('Tecnico specialista');
  });
});
