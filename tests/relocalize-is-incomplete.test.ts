import { describe, expect, it } from 'vitest';
import {
  hasMissingTargetLocaleCoverage,
  isIncomplete,
  needsTranslation,
  reconcileRetranslationState,
} from '../scripts/relocalize-pending-jobs.mjs';

const MIN_DESC = 'x'.repeat(120);

function makeJob(overrides: Record<string, unknown> = {}) {
  return {
    title: 'Front Desk & Office Support',
    description: 'Italian source description that is long enough to pass the minimum check.',
    sourceLang: 'it',
    titleByLocale: {
      it: 'Front Desk & Office Support',
      en: 'Front Desk & Office Support',
      de: 'Front Desk & Office Support Übersetzt',
      fr: 'Front Desk & Office Support Traduit',
    },
    descriptionByLocale: {
      it: MIN_DESC,
      en: MIN_DESC + ' en',
      de: MIN_DESC + ' de',
      fr: MIN_DESC + ' fr',
    },
    ...overrides,
  };
}

describe('isIncomplete – per-slot title verdict (S3: no cross-locale escape hatch)', () => {
  it('flags a source-copy slot even when the other non-source locales differ', () => {
    // This test used to assert the OPPOSITE, and it encoded the defect.
    // The old rule: "the EN slot equals the source title, but DE and FR differ,
    // therefore the job was translated and this slot is an international title —
    // don't flag it." That is the cross-locale escape hatch, and it is exactly
    // what suppressed the reported bug: a DE-source job whose EN and FR slots
    // translated and whose IT slot stayed German had the IT check waved through
    // ON THE EVIDENCE OF EN AND FR.
    //
    // Whether the EN slot has been translated is a property of the EN slot. The
    // verdict is now per slot, so the neighbouring locales cannot excuse it.
    // The cost of the residual false positive (a genuinely international title
    // that no translator can improve) is bounded, not unbounded — see the
    // give-up test below.
    const job = makeJob();
    expect(isIncomplete(job)).toBe(true);
  });

  it('bounds the cost of a title no translator can improve (give-up after 3 attempts)', () => {
    // The counterpart to the test above. An international title stays
    // isIncomplete() forever, so removing the hatch would be a queue leak if
    // nothing absorbed it. MAX_RETRANSLATION_ATTEMPTS does: after three runs in
    // which the job was actually ATTEMPTED and still failed, it is suppressed
    // and leaves the work pool (needsTranslation() returns false for it), until
    // a re-crawl rewrites its source content.
    const job: Record<string, unknown> = { ...makeJob(), needsRetranslation: true };
    expect(reconcileRetranslationState(job, { attempted: true })).toBe('counted');
    expect(reconcileRetranslationState(job, { attempted: true })).toBe('counted');
    expect(reconcileRetranslationState(job, { attempted: true })).toBe('gaveup');
    expect(job.localeMismatchSuppressed).toBe(true);
    expect(job.needsRetranslation).toBeUndefined();
  });

  it('does not flag a correctly translated slot as a source copy', () => {
    // The other half of "per slot": the verdict must stay quiet on real
    // translations, with no help from the neighbours either.
    const job = makeJob({
      titleByLocale: {
        it: 'Front Desk & Office Support',
        en: 'Front Desk Assistant',
        de: 'Empfang und Bueroassistenz',
        fr: 'Assistant accueil et bureau',
      },
    });
    expect(isIncomplete(job)).toBe(false);
  });

  it('does not let give-up suppression hide missing target locale coverage', () => {
    const job = makeJob({
      localeMismatchSuppressed: true,
      descriptionByLocale: {
        it: MIN_DESC,
        en: MIN_DESC + ' en',
        de: MIN_DESC + ' de',
        fr: '',
      },
    });

    expect(hasMissingTargetLocaleCoverage(job)).toBe(true);
    expect(needsTranslation(job)).toBe(true);
  });

  it('does not reopen unchanged language-mismatch suppression for structure-only defects', () => {
    const source = [
      'Deutsche Beschreibung mit ausreichend langen Details zur Position und zum Arbeitsumfeld.',
      '- Erste Aufgabe mit Verantwortung fuer Kunden, interne Prozesse und die taegliche Koordination im Team.',
      '- Zweite Aufgabe mit sorgfaeltiger Dokumentation, Qualitaetskontrolle und selbststaendiger Priorisierung.',
      '- Dritte Aufgabe mit enger Zusammenarbeit, verlaesslicher Kommunikation und nachhaltiger Verbesserung.',
    ].join('\n');
    const flattenedTarget = [
      'Descrizione italiana con dettagli sufficienti sulla posizione e sull ambiente di lavoro.',
      '- Prima responsabilita con gestione dei clienti, dei processi interni e del coordinamento quotidiano del team.',
    ].join('\n');
    const completeTarget = [
      'English description with enough detail about the position, the working environment and the daily responsibilities.',
      '- First responsibility covering customers, internal processes and daily coordination with the team.',
      '- Second responsibility covering documentation, quality control and independent prioritisation of work.',
      '- Third responsibility covering close collaboration, reliable communication and continuous improvement.',
    ].join('\n');
    const job = makeJob({
      sourceLang: 'de',
      description: source,
      titleByLocale: {
        de: 'Deutsche Stelle',
        it: 'Posizione di lavoro',
        en: 'Job position',
        fr: 'Poste de travail',
      },
      descriptionByLocale: {
        de: source,
        it: flattenedTarget,
        en: completeTarget,
        fr: completeTarget,
      },
      localeMismatchSuppressed: true,
      localeMismatchSuppressedLen: source.length,
    });

    expect(hasMissingTargetLocaleCoverage(job)).toBe(false);
    expect(isIncomplete(job)).toBe(true);
    expect(needsTranslation(job)).toBe(false);
  });

  it('returns true when all non-IT locales have the same title as source (genuinely untranslated)', () => {
    const job = makeJob({
      titleByLocale: {
        it: 'Front Desk & Office Support',
        en: 'Front Desk & Office Support',
        de: 'Front Desk & Office Support',
        fr: 'Front Desk & Office Support',
      },
    });
    expect(isIncomplete(job)).toBe(true);
  });

  it('returns true when a locale has a too-short title', () => {
    const job = makeJob({
      titleByLocale: {
        it: 'Front Desk & Office Support',
        en: 'Front Desk & Office Support',
        de: 'X', // too short
        fr: 'Front Desk & Office Support Traduit',
      },
    });
    expect(isIncomplete(job)).toBe(true);
  });

  it('returns true when a locale has a too-short description', () => {
    const job = makeJob({
      descriptionByLocale: {
        it: MIN_DESC,
        en: MIN_DESC,
        de: 'Too short', // < 120 chars
        fr: MIN_DESC + ' fr',
      },
    });
    expect(isIncomplete(job)).toBe(true);
  });

  it('queues a long locale whose source list was flattened', () => {
    const source = [
      'Deutsche Einleitung mit ausreichend Inhalt für die Stellenbeschreibung.',
      '- Erste Aufgabe mit ausführlichen Details und Verantwortung im Team.',
      '- Zweite Aufgabe mit ausführlichen Details und Verantwortung im Team.',
    ].join('\n');
    const flattened = source.replace(/\s*\n\s*/g, ' ');
    const job = makeJob({
      description: source,
      sourceLang: 'de',
      titleByLocale: {
        de: 'Deutsche Stelle',
        it: 'Posizione tedesca',
        en: 'German position',
        fr: 'Poste allemand',
      },
      descriptionByLocale: { de: source, it: flattened, en: flattened, fr: flattened },
    });

    expect(isIncomplete(job)).toBe(true);
  });

  it('returns false for a fully translated job with normal Italian title', () => {
    const job = {
      title: 'Ingegnere Software',
      description: MIN_DESC,
      sourceLang: 'it',
      titleByLocale: {
        it: 'Ingegnere Software',
        en: 'Software Engineer',
        de: 'Software-Ingenieur',
        fr: 'Ingénieur Logiciel',
      },
      descriptionByLocale: {
        it: MIN_DESC,
        en: MIN_DESC + ' en',
        de: MIN_DESC + ' de',
        fr: MIN_DESC + ' fr',
      },
    };
    expect(isIncomplete(job)).toBe(false);
  });

  it('returns true when description matches source across all locales (genuinely untranslated)', () => {
    // All locale descriptions are identical to the source — not translated at all.
    const job = makeJob({
      description: MIN_DESC, // source matches what's in all locale slots
      descriptionByLocale: {
        it: MIN_DESC,
        en: MIN_DESC,
        de: MIN_DESC,
        fr: MIN_DESC,
      },
    });
    expect(isIncomplete(job)).toBe(true);
  });
});
