/**
 * PR C — removal of the wrong-language-title suppressions.
 *
 * Three behaviours are pinned here, because each one is a rule that was written
 * down on purpose and is now deliberately gone:
 *
 *  S3  the `othersDiffer` "international title" escape hatch — "if any OTHER
 *      non-source locale differs from the source, assume the job was translated
 *      and skip the check for THIS locale". For a DE-source job whose EN and FR
 *      slots translated and whose IT slot did not, it suppressed the IT check on
 *      the evidence of EN and FR. That is the reported bug, written down.
 *
 *  D5  ensureLocaleFields' quality gate never looked at a stored title again
 *      once the crawl left it byte-identical, so a wrong-language title was
 *      frozen in place forever. It is swept now — but under a per-process cap,
 *      because 30.14% of non-source title slots are flagged (24,054 of 79,796,
 *      2026-08-10) and the repair queue drains ~100 jobs per run.
 *
 *  S10 validateDedicatedLocaleCoverage suppressed its `untranslated_title`
 *      report whenever the locale's SLUG differed from the source slug — and the
 *      slug is re-derived from company/location by a different code path, so a
 *      correctly-localized slug was hiding an untranslated title.
 *
 * The counterpart to every un-suppression is the bound that keeps it from
 * flooding the queue; those bounds are tested here too, not just asserted in a
 * comment.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ensureLocaleFields,
  _resetTitleRequeueBudget,
  _titleRequeueBudgetState,
} from '../scripts/lib/shared-jobs-crawler.mjs';
import {
  hardenJobLocaleFields,
  validateDedicatedLocaleCoverage,
} from '../scripts/lib/dedicated-crawler-common.mjs';

const ORIGINAL_ENV = { ...process.env };

const SOURCE_TITLE_DE = 'Projektleiter Lüftung 80 - 100%';

/**
 * The reported failure shape: German source, EN and FR translated, IT a PARTIAL
 * translation (one German noun survived). All four slots are supplied, so every
 * slot counts as "unchanged by this call" — i.e. the frozen-backlog path (D5),
 * which is the only path the budget governs.
 *
 * Titles chosen so that `hasConcatenatedWords` (the unconditional check that
 * precedes the language verdict in the same loop) is FALSE for every slot in
 * both the broken and the clean variant. Otherwise the assertions below would
 * pass without exercising the code under test at all.
 */
function reportedShapeJob(overrides: Record<string, unknown> = {}) {
  const titleByLocale = {
    de: SOURCE_TITLE_DE,
    it: 'Responsabile di progetto Lüftung 80 - 100%',
    en: 'Project manager ventilation 80 - 100%',
    fr: 'Responsable de projet ventilation 80 - 100%',
  };
  return {
    title: titleByLocale.de,
    description:
      'Wir suchen eine engagierte Persoenlichkeit fuer unser Team in der Haustechnik. ' +
      'Die Stelle umfasst die Planung und Koordination von Projekten im Tagesgeschaeft.',
    sourceLang: 'de',
    company: 'Demo AG',
    location: 'Chur',
    titleByLocale: { ...titleByLocale },
    descriptionByLocale: { de: 'Wir suchen eine engagierte Persoenlichkeit fuer unser Team.' },
    slugByLocale: {},
    ...overrides,
  };
}

describe('ensureLocaleFields — S3: the cross-locale escape hatch is gone', () => {
  beforeEach(() => {
    _resetTitleRequeueBudget();
    delete process.env.JOBS_TITLE_LANG_REQUEUE_BUDGET;
  });
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    _resetTitleRequeueBudget();
  });

  it('queues the untranslated IT slot even though EN and FR are translated', () => {
    // The hatch made this exact job pass: EN and FR differ from the source, so
    // the IT check was skipped. Per slot, IT is plainly still German.
    const result = ensureLocaleFields(reportedShapeJob()) as { needsRetranslation?: boolean };
    expect(result.needsRetranslation).toBe(true);
  });

  it('leaves a job whose non-source slots are all genuinely translated alone', () => {
    // The other side of the verdict: no flag, and no rollout budget consumed.
    const job = reportedShapeJob({
      titleByLocale: {
        de: SOURCE_TITLE_DE,
        it: 'Responsabile di progetto ventilazione 80 - 100%',
        en: 'Project manager ventilation 80 - 100%',
        fr: 'Responsable de projet ventilation 80 - 100%',
      },
    });
    const result = ensureLocaleFields(job) as { needsRetranslation?: boolean };
    expect(result.needsRetranslation).toBeFalsy();
    expect(_titleRequeueBudgetState().spent).toBe(0);
  });
});

describe('ensureLocaleFields — D5: the backlog sweep is bounded and idempotent', () => {
  beforeEach(() => {
    _resetTitleRequeueBudget();
    delete process.env.JOBS_TITLE_LANG_REQUEUE_BUDGET;
  });
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    _resetTitleRequeueBudget();
  });

  it('spends no budget on a job the repair queue already holds', () => {
    // Idempotence: an already-flagged job must not be rewritten, and must not
    // consume one of the run's scarce flagging slots. Without this the sweep
    // would spend its whole budget re-deciding jobs that are already queued.
    const result = ensureLocaleFields(
      reportedShapeJob({ needsRetranslation: true }),
    ) as { needsRetranslation?: boolean };
    expect(result.needsRetranslation).toBe(true);
    expect(_titleRequeueBudgetState().spent).toBe(0);
  });

  it('never re-queues a job the pipeline already gave up on', () => {
    // relocalize-pending-jobs.mjs sets `localeMismatchSuppressed` after
    // MAX_RETRANSLATION_ATTEMPTS failed attempts and DELETES needsRetranslation.
    // Re-raising the flag here would defeat the give-up: needsTranslation()
    // checks needsRetranslation BEFORE the suppression, so the job would re-enter
    // the pool and burn one attempt every single run, forever. That is the same
    // flapping shape as the EOC/migros mass re-flag incident.
    const result = ensureLocaleFields(
      reportedShapeJob({ localeMismatchSuppressed: true, localeMismatchSuppressedLen: 128 }),
    ) as { needsRetranslation?: boolean };
    expect(result.needsRetranslation).toBeFalsy();
    expect(_titleRequeueBudgetState().spent).toBe(0);
  });

  it('stops flagging stored titles once the per-process budget is exhausted', () => {
    process.env.JOBS_TITLE_LANG_REQUEUE_BUDGET = '1';
    const first = ensureLocaleFields(reportedShapeJob()) as { needsRetranslation?: boolean };
    const second = ensureLocaleFields(reportedShapeJob()) as { needsRetranslation?: boolean };
    expect(first.needsRetranslation).toBe(true);
    expect(second.needsRetranslation).toBeFalsy();
    expect(_titleRequeueBudgetState()).toEqual({ spent: 1, limit: 1 });
  });

  it('disables the stored-title sweep entirely at budget 0', () => {
    // The kill switch: an ops-side rollback that needs no deploy of new code.
    process.env.JOBS_TITLE_LANG_REQUEUE_BUDGET = '0';
    const result = ensureLocaleFields(reportedShapeJob()) as { needsRetranslation?: boolean };
    expect(result.needsRetranslation).toBeFalsy();
  });
});

describe('validateDedicatedLocaleCoverage — S10: untranslated_title is no longer self-suppressing', () => {
  let tempDir: string;
  let jobsPath: string;
  const STRICT_ENV = 'JOBS_S10_TEST_STRICT';

  const longDe =
    'Wir suchen eine engagierte Persoenlichkeit fuer unser Team in der Logistik. ' +
    'Die Stelle umfasst die Betreuung der Lagerprozesse und die Koordination der Lieferungen im Tagesgeschaeft.';
  const longIt =
    'Cerchiamo una persona motivata per unirsi al nostro team di logistica in Ticino. ' +
    'Il ruolo comprende la gestione dei processi di magazzino e il coordinamento delle consegne quotidiane.';

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-s10-'));
    jobsPath = path.join(tempDir, 'jobs.json');
    process.env[STRICT_ENV] = '1';
    process.env.GROQ_API_KEY = 'test-fake-key-not-a-real-secret';
  });
  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
  });

  function runGuard() {
    return validateDedicatedLocaleCoverage({
      strictEnvVar: STRICT_ENV,
      label: 'S10Test',
      dataJobsPath: jobsPath,
      isTargetJob: () => true,
      locales: ['de', 'it'],
      minDescriptionChars: 120,
      minSourceDescriptionCharsForHardValidation: 120,
      checkSlug: true,
      untranslatedCheck: true,
      isTrustedDomain: () => true,
      getCascadeStatsFn: () => ({ calls: 0, successes: 0, byFieldType: {} }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
  }

  it('reports a German title sitting in the IT slot even when the IT slug is localized', async () => {
    // A LOCALIZED SLUG WAS THE SUPPRESSION. The slug is re-derived from
    // company/location by the hardening loops, so it can be perfectly Italian
    // while the title next to it is still German — which is precisely the shape
    // of the four reported pages.
    fs.writeFileSync(jobsPath, JSON.stringify([{
      slug: 'lagermitarbeiter-demo-ag-chur',
      url: 'https://example.com/job/1',
      company: 'Demo AG',
      location: 'Chur',
      title: 'Lagermitarbeiter mit Fachverantwortung',
      description: longDe,
      sourceLang: 'de',
      titleByLocale: {
        de: 'Lagermitarbeiter mit Fachverantwortung',
        it: 'Lagermitarbeiter mit Fachverantwortung',
      },
      descriptionByLocale: { de: longDe, it: longIt },
      slugByLocale: {
        de: 'lagermitarbeiter-demo-ag-chur',
        it: 'addetto-al-magazzino-demo-ag-coira',
      },
    }]), 'utf-8');

    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.join(' ')); });

    await runGuard();

    expect(logs.join('\n')).toMatch(/locale quality issues \(\d+\)/);
    expect(logs.join('\n')).toContain('untranslated_title');
  });

  it('stays quiet on a correctly translated title', async () => {
    fs.writeFileSync(jobsPath, JSON.stringify([{
      slug: 'lagermitarbeiter-demo-ag-chur',
      url: 'https://example.com/job/1',
      company: 'Demo AG',
      location: 'Chur',
      title: 'Lagermitarbeiter mit Fachverantwortung',
      description: longDe,
      sourceLang: 'de',
      titleByLocale: {
        de: 'Lagermitarbeiter mit Fachverantwortung',
        it: 'Addetto al magazzino con responsabilità tecnica',
      },
      descriptionByLocale: { de: longDe, it: longIt },
      slugByLocale: {
        de: 'lagermitarbeiter-demo-ag-chur',
        it: 'addetto-al-magazzino-demo-ag-coira',
      },
    }]), 'utf-8');

    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.join(' ')); });

    await runGuard();

    expect(logs.join('\n')).not.toContain('untranslated_title');
  });
});

describe('hardenJobLocaleFields — the repair loop no longer manufactures the bug', () => {
  let tempDir: string;
  let jobsPath: string;

  const longDe =
    'Wir suchen eine engagierte Persoenlichkeit fuer unser Team in der Logistik. ' +
    'Die Stelle umfasst die Betreuung der Lagerprozesse und die Koordination der Lieferungen im Tagesgeschaeft.';
  const longIt =
    'Cerchiamo una persona motivata per unirsi al nostro team di logistica in Ticino. ' +
    'Il ruolo comprende la gestione dei processi di magazzino e il coordinamento delle consegne quotidiane.';

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-harden-'));
    jobsPath = path.join(tempDir, 'jobs.json');
  });
  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    process.env = { ...ORIGINAL_ENV };
  });

  function write(titleByLocale: Record<string, string>) {
    fs.writeFileSync(jobsPath, JSON.stringify([{
      slug: 'lagermitarbeiter-demo-ag-chur',
      url: 'https://example.com/job/1',
      company: 'Demo AG',
      location: 'Chur',
      title: 'Lagermitarbeiter mit Fachverantwortung',
      description: longDe,
      sourceLang: 'de',
      titleByLocale,
      descriptionByLocale: { de: longDe, it: longIt },
      slugByLocale: { de: 'lagermitarbeiter-demo-ag-chur', it: 'addetto-al-magazzino-demo-ag-coira' },
    }]), 'utf-8');
    hardenJobLocaleFields({ dataJobsPath: jobsPath });
    return JSON.parse(fs.readFileSync(jobsPath, 'utf-8'))[0];
  }

  it('does not overwrite a correct Italian title with a half-translated German one', () => {
    // Measured, not hypothetical: with the old trigger
    // (`detectJobTitleLocaleDetails(currentTitle, …).lang !== locale`) the
    // correct "Addetto al magazzino con responsabilità tecnica" detects as
    // fr @ 0.45, the repair loop fires, heuristicTranslateJobTitle turns the
    // GERMAN source into "Lagermitarbeiter con Fachverantwortung", and that is
    // what shipped to the IT page. One function word translated, both nouns
    // German — byte-for-byte the shape of the four reported URLs.
    const job = write({
      de: 'Lagermitarbeiter mit Fachverantwortung',
      it: 'Addetto al magazzino con responsabilità tecnica',
    });
    expect(job.titleByLocale.it).toBe('Addetto al magazzino con responsabilità tecnica');
  });

  it('still repairs an IT slot that is a verbatim copy of the German source', () => {
    const job = write({
      de: 'Lagermitarbeiter mit Fachverantwortung',
      it: 'Lagermitarbeiter mit Fachverantwortung',
    });
    expect(job.titleByLocale.it).not.toBe('Lagermitarbeiter mit Fachverantwortung');
    expect(job.needsRetranslation).toBe(true);
  });

  it('S9: the de slot of a non-German-source job is no longer exempt from the leftover-source gate', () => {
    // `locale === 'de'` used to skip the leftover-source-title gate outright.
    // Here the source is Italian and the de slot still holds Italian, which the
    // exemption made structurally invisible.
    fs.writeFileSync(jobsPath, JSON.stringify([{
      slug: 'responsabile-della-logistica-demo-sa-lugano',
      url: 'https://example.com/job/2',
      company: 'Demo SA',
      location: 'Lugano',
      title: 'Responsabile della logistica',
      description: longIt,
      sourceLang: 'it',
      titleByLocale: {
        it: 'Responsabile della logistica',
        de: 'Responsabile della logistica',
        en: 'Logistics manager',
        fr: 'Responsable de la logistique',
      },
      descriptionByLocale: { it: longIt, de: longDe },
      slugByLocale: { it: 'responsabile-della-logistica-demo-sa-lugano' },
    }]), 'utf-8');
    hardenJobLocaleFields({ dataJobsPath: jobsPath });
    const job = JSON.parse(fs.readFileSync(jobsPath, 'utf-8'))[0];
    expect(job.needsRetranslation).toBe(true);
  });
});
