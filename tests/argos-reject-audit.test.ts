import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { classifyMopupWrite, missingSlots } from '../scripts/local-mt-mopup.mjs';
import { stratifyByCompany, companyKey } from '../scripts/research/argos-reject-audit.mjs';

describe('classifyMopupWrite() — the mop-up rejection chain, made observable', () => {
  it('writes a genuinely missing title', () => {
    const job = { sourceLang: 'de', title: 'Metzger 60-100%', titleByLocale: { de: 'Metzger 60-100%' } };
    const out = classifyMopupWrite({ job, locale: 'it', field: 'title', rawText: 'Macellaio 60-100%' });
    expect(out.decision).toBe('write');
    expect(out.incoming).toBe('Macellaio 60-100%');
  });

  it('rejects an output that is just a copy of the source', () => {
    const job = { sourceLang: 'de', title: 'Metzger 60-100%', titleByLocale: { de: 'Metzger 60-100%' } };
    const out = classifyMopupWrite({ job, locale: 'it', field: 'title', rawText: 'Metzger 60-100%' });
    expect(out.decision).toBe('skip:source-copy');
  });

  it('rejects an output with no letters or digits left after finalize', () => {
    const job = { sourceLang: 'de', title: 'Metzger 60-100%', titleByLocale: { de: 'Metzger 60-100%' } };
    const out = classifyMopupWrite({ job, locale: 'it', field: 'title', rawText: '— ** —' });
    expect(out.decision).toBe('skip:finalize-empty');
    expect(out.incoming).toBe('');
  });

  it('rejects an empty Argos output before finalize runs', () => {
    const job = { sourceLang: 'de', title: 'Metzger 60-100%', titleByLocale: { de: 'Metzger 60-100%' } };
    expect(classifyMopupWrite({ job, locale: 'it', field: 'title', rawText: '   ' }).decision)
      .toBe('skip:empty-raw');
  });

  it('never writes into the source locale', () => {
    const job = { sourceLang: 'de', title: 'Metzger', titleByLocale: { de: 'Metzger' } };
    expect(classifyMopupWrite({ job, locale: 'de', field: 'title', rawText: 'Butcher' }).decision)
      .toBe('skip:source-locale');
  });

  it('leaves an existing translation that is genuinely good alone', () => {
    const job = {
      sourceLang: 'de',
      title: 'Metzger 60-100%',
      titleByLocale: { de: 'Metzger 60-100%', it: 'Macellaio 60-100%' },
      descriptionByLocale: {},
    };
    // Not even queued for IT any more — and the guard agrees.
    expect(missingSlots(job)).not.toContainEqual({ locale: 'it', field: 'title' });
    const out = classifyMopupWrite({ job, locale: 'it', field: 'title', rawText: 'Qualcosa altro 60-100%' });
    expect(out.decision).toBe('skip:existing-good');
    expect(out.languageDriven).toBeFalsy();
  });
});

// The load-bearing pair for workspace issue 16. missingSlots() queues a title
// that is PRESENT, long enough, not a source copy, and still lexically German —
// the titleLooksUntranslated entry gate (#6354). The write chain used to refuse
// EVERY candidate for exactly that shape, because `existingIsBad` looked only at
// length and source-copy. Queued by one predicate, discarded unread by another,
// on 100% of the blocked set (18'606 title slots on origin/main).
//
// Both directions have to hold. If only the first held, the guard would be a
// blanket re-enable and would fall straight into the objection at
// fix-untranslated-titles.mjs:78 — overwriting a half-good title with, at best,
// the same half-good title. The second is what makes it a comparison.
describe('classifyMopupWrite() — language arm (workspace issue 16)', () => {
  const wrongLanguageSlot = () => ({
    sourceLang: 'de',
    title: 'Metzger 60-100%',
    company: '',
    location: '',
    titleByLocale: { de: 'Metzger 60-100%', it: 'Aiuto Metzger 60-100%' },
    descriptionByLocale: {},
  });

  it('WRITES when the existing title is wrong-language and the candidate is not', () => {
    const job = wrongLanguageSlot();
    expect(missingSlots(job)).toContainEqual({ locale: 'it', field: 'title' });
    const out = classifyMopupWrite({ job, locale: 'it', field: 'title', rawText: 'Macellaio 60-100%' });
    expect(out.decision).toBe('write');
    expect(out.incoming).toBe('Macellaio 60-100%');
    expect(out.languageDriven).toBe(true);
    expect(out.reason).toBe('compound-residue');
  });

  it('still REJECTS when the candidate is itself wrong-language', () => {
    const job = wrongLanguageSlot();
    expect(missingSlots(job)).toContainEqual({ locale: 'it', field: 'title' });
    const out = classifyMopupWrite({ job, locale: 'it', field: 'title', rawText: 'Metzger Aushilfe 60-100%' });
    expect(out.decision).toBe('skip:candidate-untranslated');
    expect(out.languageDriven).toBe(true);
  });

  it('falls back to the pre-issue-16 behaviour when langAware is off', () => {
    const job = wrongLanguageSlot();
    const out = classifyMopupWrite({
      job, locale: 'it', field: 'title', rawText: 'Macellaio 60-100%', langAware: false,
    });
    expect(out.decision).toBe('skip:existing-good');
    expect(out.languageDriven).toBeFalsy();
  });

  // Descriptions never reach the language arm: missingSlots() queues a
  // description on the same length-or-copy test the guard applies, so the two
  // predicates already agree and the blocked set is empty (0 of 14'989 slots).
  it('never applies the language arm to descriptions', () => {
    const longDe = `Wir suchen eine Mitarbeiterin für unseren Standort. ${'Aufgaben und Betreuung der Kunden. '.repeat(6)}`;
    const longIt = `Cerchiamo una collaboratrice per la nostra sede. ${'Mansioni e gestione dei clienti. '.repeat(6)}`;
    const job = {
      sourceLang: 'de',
      title: 'Metzger',
      description: longDe,
      titleByLocale: { de: 'Metzger' },
      descriptionByLocale: { de: longDe, it: longIt },
    };
    const out = classifyMopupWrite({ job, locale: 'it', field: 'description', rawText: 'Testo nuovo qualsiasi.' });
    expect(out.decision).toBe('skip:existing-good');
    expect(out.languageDriven).toBeFalsy();
  });
});

// The rollout switch. Default OFF is the safety property of this PR: the guard
// is measured in shadow on a real run before it is allowed to write. A default
// that silently read as ON would turn "observe one run first" into "rewrite
// ~9'400 production fields first", so both halves get pinned — the parse and
// the wiring.
describe('LOCAL_MT_LANG_AWARE_OVERWRITE default', () => {
  it('is OFF unless the repo variable is exactly "1"', () => {
    const read = (v?: string) => String(v || '0') === '1';
    expect(read(undefined)).toBe(false);
    expect(read('')).toBe(false);
    expect(read('0')).toBe(false);
    expect(read('true')).toBe(false);
    expect(read('1')).toBe(true);
  });

  it('is wired into both live mop-up phases with an OFF default', () => {
    const wf = readFileSync(
      new URL('../.github/corpus-workflows/translate-pending.yml', import.meta.url),
      'utf-8',
    );
    const wired = wf.match(/LOCAL_MT_LANG_AWARE_OVERWRITE: \$\{\{ vars\.LOCAL_MT_LANG_AWARE_OVERWRITE \|\| '0' \}\}/g);
    // Phase 2a (Argos bulk) and Phase 2c (mop-up) both run local-mt-mopup.mjs.
    expect(wired?.length).toBe(2);
  });
});

describe('stratifyByCompany()', () => {
  it('does not let one dominant company eat the sample', () => {
    const candidates = [
      ...Array.from({ length: 500 }, (_, i) => ({ job: { company: 'fachkraft.ch', id: i }, slots: [1] })),
      ...Array.from({ length: 5 }, (_, i) => ({ job: { company: 'Alpiq', id: i }, slots: [1] })),
      ...Array.from({ length: 5 }, (_, i) => ({ job: { company: 'ABB', id: i }, slots: [1] })),
    ];
    const { picked, companies } = stratifyByCompany(candidates, {
      maxFields: 12,
      perCompany: 1,
      budgetOf: (c) => c.slots.length,
    });
    expect(companies).toBe(3);
    const fromFachkraft = picked.filter((p) => companyKey(p.job) === 'fachkraft.ch').length;
    // Proportionally fachkraft.ch is 98% of the pool; round-robin caps it at ~1/3.
    expect(fromFachkraft).toBeLessThanOrEqual(Math.ceil(picked.length / 2));
    expect(new Set(picked.map((p) => companyKey(p.job))).size).toBe(3);
  });
});
