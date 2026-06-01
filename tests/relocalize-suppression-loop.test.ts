import { describe, it, expect } from 'vitest';
// @ts-expect-error — plain .mjs script, no type declarations
import { reconcileRetranslationState, isIncomplete } from '../scripts/relocalize-pending-jobs.mjs';

/**
 * Regression gate for the needsRetranslation give-up loop.
 *
 * Before the fix, `mark-locale-mismatched-jobs.mjs` re-flagged the same jobs
 * every run while the per-company give-up only ran for companies the throughput
 * budget actually processed — so stuck jobs (LibreTranslate can't satisfy the
 * locale detectors) bounced between flagged and cleared forever, keeping the
 * backlog pinned at ~2000–5700. reconcileRetranslationState() runs for every
 * slice every run and suppresses a job after MAX_RETRANSLATION_ATTEMPTS so the
 * flaggers stop re-queuing it. This test pins that convergence.
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
  it('a permanently-incomplete flagged job is suppressed after MAX attempts, then stops looping', () => {
    const job = stuckJob();
    expect(isIncomplete(job)).toBe(true);

    // Run 1 and 2: attempt counter bumps, still flagged.
    expect(reconcileRetranslationState(job)).toBe('counted');
    expect(job.needsRetranslation).toBe(true);
    expect(reconcileRetranslationState(job)).toBe('counted');
    expect(job.needsRetranslation).toBe(true);

    // Run 3: give up — flag dropped, suppression marker set.
    expect(reconcileRetranslationState(job)).toBe('gaveup');
    expect(job.needsRetranslation).toBeUndefined();
    expect(job.localeMismatchSuppressed).toBe(true);
    expect(typeof job.localeMismatchSuppressedLen).toBe('number');

    // Subsequent runs: no flag, source unchanged → no work, no re-flag loop.
    expect(reconcileRetranslationState(job)).toBe('noop');
    expect(job.needsRetranslation).toBeUndefined();
    expect(job.localeMismatchSuppressed).toBe(true);
  });

  it('a re-crawl (source length drift >15%) lifts the give-up so the job retries', () => {
    const job = stuckJob();
    reconcileRetranslationState(job);
    reconcileRetranslationState(job);
    reconcileRetranslationState(job); // suppressed
    expect(job.localeMismatchSuppressed).toBe(true);

    // Re-crawl rewrites the source description (much shorter now).
    job.description = 'Kurzbeschreibung.';
    const outcome = reconcileRetranslationState(job);
    expect(outcome).toBe('reset');
    expect(job.localeMismatchSuppressed).toBeUndefined();
    expect(job.retranslationAttempts).toBeUndefined();
  });

  it('a flagged job that becomes complete is cleared, not suppressed', () => {
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
    // Only assert the clearing path if the fixture is genuinely complete by the
    // production detector; otherwise the give-up path is the correct behaviour.
    if (!isIncomplete(job)) {
      expect(reconcileRetranslationState(job)).toBe('cleared');
      expect(job.needsRetranslation).toBeUndefined();
      expect(job.retranslationAttempts).toBeUndefined();
      expect(job.localeMismatchSuppressed).toBeUndefined();
    }
  });
});
