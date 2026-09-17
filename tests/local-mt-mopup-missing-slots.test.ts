import { describe, it, expect } from 'vitest';
import {
  buildMopupRequest,
  classifyMopupWrite,
  missingSlots,
  opusMtRescueEnabled,
  rescueMopupRejects,
} from '../scripts/local-mt-mopup.mjs';

describe('local-mt-mopup missingSlots()', () => {
  it('flags a title slot that is present but still lexically German (compound-residue) — issue #6354', () => {
    const job = {
      sourceLang: 'de',
      titleByLocale: {
        de: 'Metzger 60-100%',
        it: 'Aiuto Metzger 60-100%',
        en: 'Assistant Butcher 60-100%',
        fr: 'Aide boucher 60-100%',
      },
      descriptionByLocale: {},
    };

    const slots = missingSlots(job);
    expect(slots).toContainEqual({ locale: 'it', field: 'title' });
    // The already-clean en/fr slots must not be touched.
    expect(slots).not.toContainEqual({ locale: 'en', field: 'title' });
    expect(slots).not.toContainEqual({ locale: 'fr', field: 'title' });
  });

  it('still flags an exact source-copy title (pre-existing behaviour, unchanged)', () => {
    const job = {
      sourceLang: 'de',
      titleByLocale: {
        de: 'Metzger 60-100%',
        it: 'Metzger 60-100%',
      },
      descriptionByLocale: {},
    };

    expect(missingSlots(job)).toContainEqual({ locale: 'it', field: 'title' });
  });

  it('flags a lexically-untranslated title even when the SOURCE title is shorter than MIN_TITLE_CHARS — issue #6539', () => {
    const job = {
      sourceLang: 'de',
      titleByLocale: {
        de: 'KV', // 2 chars, below the MIN_TITLE_CHARS=3 floor
        it: 'Aiuto Metzger', // still lexically German (compound-residue)
        en: 'Assistant',
        fr: 'Aide',
      },
      descriptionByLocale: {},
    };

    expect(missingSlots(job)).toContainEqual({ locale: 'it', field: 'title' });
  });

  it('does not flag a clean, fully-translated title', () => {
    const job = {
      sourceLang: 'de',
      titleByLocale: {
        de: 'Metzger 60-100%',
        it: 'Macellaio 60-100%',
        en: 'Butcher 60-100%',
        fr: 'Boucher 60-100%',
      },
      descriptionByLocale: {},
    };

    expect(missingSlots(job)).toEqual([]);
  });
});

function auditTitleTarget({ id, sourceLang, locale, sourceText, existing, company }) {
  const job = {
    sourceLang,
    company,
    titleByLocale: {
      [sourceLang]: sourceText,
      [locale]: existing,
    },
    descriptionByLocale: {},
  };
  const { request, protectedTokens } = buildMopupRequest({
    id,
    text: sourceText,
    from: sourceLang,
    to: locale,
    field: 'title',
  });
  return { job, locale, field: 'title', request, protectedTokens };
}

describe('local-mt-mopup OpusMT rescue', () => {
  it('rescues the report case Argos rejected as candidate-untranslated and reuses the masked guard path', async () => {
    const id = 'r49';
    const target = auditTitleTarget({
      id,
      sourceLang: 'en',
      locale: 'de',
      company: 'lonza',
      sourceText: 'Global MSAT Drug Product Qualification and Validation Lead 80-100% (m/f/d)',
      existing: 'Global MSAT Drug Product Qualification and Validation Lead 80-100% (m/w/d)',
    });
    const argosRaw = 'Global MSAT Drug Product Qualification and Validation Lead 80-100% ZQX0XQZ';
    const opusRaw = 'Globale MSAT-Drogenproduktqualifizierung und Validierungsblei 80-100% ZQX0XQZ';

    expect(target.request.text).toContain('ZQX0XQZ');
    expect(classifyMopupWrite({ ...target, rawText: argosRaw }).decision)
      .toBe('skip:candidate-untranslated');

    const calls = [];
    const rescue = await rescueMopupRejects({
      targets: new Map([[id, target]]),
      results: new Map([[id, argosRaw]]),
      enabled: true,
      translate: async (...args) => {
        calls.push(args);
        return opusRaw;
      },
    });

    expect(calls).toEqual([[target.request.text, 'en', 'de']]);
    expect(rescue.decisionTally.write).toBe(1);
    expect(rescue.recovered).toBe(1);
    expect(rescue.writes.get(id).rawText).toBe(opusRaw);

    const final = classifyMopupWrite({ ...target, rawText: opusRaw });
    expect(final.decision).toBe('write');
    expect(final.incoming).toBe('Globale MSAT-Drogenproduktqualifizierung und Validierungsblei 80-100% (m/w/d)');
  });

  it('rescues the report source-copy case with the same classifier', async () => {
    const id = 'r46';
    const target = auditTitleTarget({
      id,
      sourceLang: 'en',
      locale: 'it',
      company: 'six group',
      sourceText: 'Business Continuity Manager',
      existing: 'Business Continuity Manager',
    });
    const argosRaw = 'Business Continuity Manager';
    const opusRaw = 'Gestore della continuità aziendale';

    expect(classifyMopupWrite({ ...target, rawText: argosRaw }).decision).toBe('skip:source-copy');
    const rescue = await rescueMopupRejects({
      targets: new Map([[id, target]]),
      results: new Map([[id, argosRaw]]),
      enabled: true,
      translate: async () => opusRaw,
    });

    expect(rescue.recovered).toBe(1);
    expect(rescue.writes.get(id).rawText).toBe(opusRaw);
    expect(classifyMopupWrite({ ...target, rawText: opusRaw })).toMatchObject({ decision: 'write' });
  });

  it('keeps a report case rejected when both Argos and OpusMT fail the candidate guard', async () => {
    const id = 'r1';
    const target = auditTitleTarget({
      id,
      sourceLang: 'de',
      locale: 'it',
      company: 'coop',
      sourceText: 'Detailhandelsfachfrau:mann EFZ "Gestalten von Einkaufserlebnissen"',
      existing: 'Detailhandelsfachfrau:mann CFC "Gestalten von Einkaufserlebnissen"',
    });
    const argosRaw = 'Dettaglio manopolafrau:mann EFZ "Scopri di esperienze di shopping"';
    const opusRaw = 'Specialista del commercio al dettaglio:mann EFZ "Progettare esperienze di shopping"';

    expect(classifyMopupWrite({ ...target, rawText: argosRaw }).decision)
      .toBe('skip:candidate-untranslated');
    const rescue = await rescueMopupRejects({
      targets: new Map([[id, target]]),
      results: new Map([[id, argosRaw]]),
      enabled: true,
      translate: async () => opusRaw,
    });

    expect(rescue.decisionTally['skip:candidate-untranslated']).toBe(1);
    expect(rescue.recovered).toBe(0);
    expect(rescue.writes.size).toBe(0);
  });

  it('does not call OpusMT, mutate the job, or change the result when the rescue flag is off', async () => {
    const id = 'r46';
    const target = auditTitleTarget({
      id,
      sourceLang: 'en',
      locale: 'it',
      company: 'six group',
      sourceText: 'Business Continuity Manager',
      existing: 'Business Continuity Manager',
    });
    const argosRaw = 'Business Continuity Manager';
    const before = structuredClone(target.job);
    let calls = 0;

    const rescue = await rescueMopupRejects({
      targets: new Map([[id, target]]),
      results: new Map([[id, argosRaw]]),
      enabled: opusMtRescueEnabled('0'),
      translate: async () => {
        calls++;
        return 'Gestore della continuità aziendale';
      },
    });

    expect(opusMtRescueEnabled(undefined)).toBe(false);
    expect(opusMtRescueEnabled('true')).toBe(false);
    expect(opusMtRescueEnabled('1')).toBe(true);
    expect(calls).toBe(0);
    expect(target.job).toEqual(before);
    expect(rescue).toMatchObject({ attempted: 0, recovered: 0, deferred: 0 });
    expect(rescue.writes.size).toBe(0);
    expect(classifyMopupWrite({ ...target, rawText: argosRaw }).decision).toBe('skip:source-copy');
  });

  it('defers every eligible slot when the elapsed-aware budget is exhausted', async () => {
    const id = 'r46';
    const target = auditTitleTarget({
      id,
      sourceLang: 'en',
      locale: 'it',
      company: 'six group',
      sourceText: 'Business Continuity Manager',
      existing: 'Business Continuity Manager',
    });

    const rescue = await rescueMopupRejects({
      targets: new Map([[id, target]]),
      results: new Map([[id, 'Business Continuity Manager']]),
      enabled: true,
      budgetOk: () => false,
      translate: async () => 'Gestore della continuità aziendale',
    });

    expect(rescue).toMatchObject({ attempted: 0, recovered: 0, deferred: 1 });
    expect(rescue.writes.size).toBe(0);
  });
});
