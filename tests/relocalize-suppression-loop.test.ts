import { describe, it, expect } from 'vitest';
import {
  reconcileRetranslationState,
  isIncomplete,
  snapshotCompanySignatures,
  changedSlugsSince,
  // @ts-expect-error — plain .mjs script, no type declarations
} from '../scripts/relocalize-pending-jobs.mjs';

/**
 * Regression gate for the needsRetranslation give-up loop.
 *
 * Before the fix, `mark-locale-mismatched-jobs.mjs` re-flagged the same jobs
 * every run while the per-company give-up only ran for companies the throughput
 * budget actually processed — so stuck jobs (LibreTranslate can't satisfy the
 * locale detectors) bounced between flagged and cleared forever, keeping the
 * backlog pinned at ~2000–5700.
 *
 * The give-up counter must ONLY advance when a translation was actually attempted
 * on a job (`attempted: true`) — never for mere queue presence (`attempted:
 * false`), or the un-reached backlog (relocalize runs --max-jobs 100 against
 * thousands of flagged jobs) would be mass-suppressed, freezing source-language
 * text on IT/EN/FR pages. These tests pin both halves.
 */

// A job that is permanently incomplete: the EN locale is missing entirely, so
// isIncomplete() always returns true no matter how many times we "translate".
function stuckJob() {
  return {
    slug: 'stuck-job',
    sourceLang: 'de',
    description: 'Allgemeine Informationen über diese Stelle bei einem Schweizer Unternehmen. '.repeat(3),
    title: 'Pflegefachfrau',
    needsRetranslation: true,
    titleByLocale: { de: 'Pflegefachfrau', it: '', en: '', fr: '' },
    descriptionByLocale: { de: 'x'.repeat(200), it: '', en: '', fr: '' },
  };
}

describe('reconcileRetranslationState — give-up convergence', () => {
  it('an ATTEMPTED, permanently-incomplete job is suppressed after MAX attempts, then stops looping', () => {
    const job = stuckJob();
    expect(isIncomplete(job)).toBe(true);

    // Runs 1 and 2: a real translation was attempted and failed → counter bumps.
    expect(reconcileRetranslationState(job, { attempted: true })).toBe('counted');
    expect(job.needsRetranslation).toBe(true);
    expect(reconcileRetranslationState(job, { attempted: true })).toBe('counted');
    expect(job.needsRetranslation).toBe(true);

    // Run 3: give up — flag dropped, suppression marker set.
    expect(reconcileRetranslationState(job, { attempted: true })).toBe('gaveup');
    expect(job.needsRetranslation).toBeUndefined();
    expect(job.localeMismatchSuppressed).toBe(true);
    expect(typeof job.localeMismatchSuppressedLen).toBe('number');

    // Subsequent runs: no flag, source unchanged → no work, no re-flag loop.
    expect(reconcileRetranslationState(job, { attempted: true })).toBe('noop');
    expect(job.localeMismatchSuppressed).toBe(true);
  });

  it('an UN-ATTEMPTED incomplete job is NEVER suppressed — it stays queued (no mass-suppression of the backlog)', () => {
    const job = stuckJob();
    // Simulate many runs where the throughput budget never reaches this job.
    for (let i = 0; i < 10; i++) {
      expect(reconcileRetranslationState(job, { attempted: false })).toBe('waiting');
    }
    // Still flagged, never counted, never suppressed → drains later via throughput.
    expect(job.needsRetranslation).toBe(true);
    expect(job.localeMismatchSuppressed).toBeUndefined();
    expect(job.retranslationAttempts).toBeUndefined();
  });

  it('a re-crawl (source length drift >15%) lifts the give-up so the job retries', () => {
    const job = stuckJob();
    reconcileRetranslationState(job, { attempted: true });
    reconcileRetranslationState(job, { attempted: true });
    reconcileRetranslationState(job, { attempted: true }); // suppressed
    expect(job.localeMismatchSuppressed).toBe(true);

    // Re-crawl rewrites the source description (much shorter now).
    job.description = 'Kurzbeschreibung.';
    expect(reconcileRetranslationState(job, { attempted: false })).toBe('reset');
    expect(job.localeMismatchSuppressed).toBeUndefined();
    expect(job.retranslationAttempts).toBeUndefined();
  });

  it('a flagged job that is now complete is cleared (not suppressed), regardless of attempted', () => {
    const job = {
      slug: 'recovered',
      sourceLang: 'it',
      description: 'Descrizione completa della posizione lavorativa presso un ospedale ticinese con molte responsabilità cliniche e gestionali quotidiane.',
      title: 'Infermiere',
      needsRetranslation: true,
      retranslationAttempts: 2,
      titleByLocale: {
        it: 'Infermiere diplomato',
        en: 'Registered nurse specialist',
        de: 'Diplomierte Pflegefachperson',
        fr: 'Infirmier diplômé spécialisé',
      },
      descriptionByLocale: {
        it: 'Descrizione completa della posizione lavorativa presso un ospedale ticinese con responsabilità cliniche e organizzative quotidiane molto importanti.',
        en: 'Full description of the clinical nursing position at a hospital with substantial daily clinical and organisational responsibilities for the whole ward.',
        de: 'Vollständige Beschreibung der pflegerischen Stelle in einem Krankenhaus mit erheblicher täglicher klinischer und organisatorischer Verantwortung im Team.',
        fr: 'Description complète du poste de soins infirmiers dans un hôpital avec des responsabilités cliniques et organisationnelles quotidiennes très importantes ici.',
      },
    };
    // The fixture must be genuinely complete by the production detector — assert
    // it so a detector change can't turn the test below into a vacuous no-op.
    expect(isIncomplete(job)).toBe(false);

    expect(reconcileRetranslationState(job, { attempted: false })).toBe('cleared');
    expect(job.needsRetranslation).toBeUndefined();
    expect(job.retranslationAttempts).toBeUndefined();
    expect(job.localeMismatchSuppressed).toBeUndefined();
  });
});

describe('attempted-detection — only crawler-touched jobs count as attempted', () => {
  // Pins the call-site wiring: relocalize runs --max-jobs N against a company
  // slice with more flagged jobs than the budget reaches. Only the jobs whose
  // locale content actually changed must be marked attempted; the un-reached
  // tail must NOT be (else it gets mass-suppressed).
  it('changedSlugsSince returns only the jobs whose locale content changed', () => {
    const before = [
      { slug: 'reached', companyKey: 'acme', titleByLocale: { it: 'A' }, descriptionByLocale: { it: 'x' } },
      { slug: 'untouched', companyKey: 'acme', titleByLocale: { it: 'B' }, descriptionByLocale: { it: 'y' } },
      { slug: 'other-co', companyKey: 'globex', titleByLocale: { it: 'C' }, descriptionByLocale: { it: 'z' } },
    ];
    const snap = snapshotCompanySignatures(before, 'acme');

    // Crawler translated only 'reached'; 'untouched' (budget-unreached) is unchanged.
    const after = [
      { slug: 'reached', companyKey: 'acme', titleByLocale: { it: 'A', en: 'A-en' }, descriptionByLocale: { it: 'x', en: 'x-en' } },
      { slug: 'untouched', companyKey: 'acme', titleByLocale: { it: 'B' }, descriptionByLocale: { it: 'y' } },
      { slug: 'other-co', companyKey: 'globex', titleByLocale: { it: 'C', en: 'C-en' }, descriptionByLocale: { it: 'z' } },
    ];
    const attempted = changedSlugsSince(snap, after, 'acme');

    expect(attempted.has('reached')).toBe(true);
    expect(attempted.has('untouched')).toBe(false); // un-reached tail → never suppressed
    expect(attempted.has('other-co')).toBe(false);  // different company, ignored
  });
});
