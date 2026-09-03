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

  // The load-bearing case for issue 13. missingSlots() queues a title that is
  // PRESENT, long enough, not a source copy, and still lexically German — the
  // titleLooksUntranslated entry gate (#6354). For exactly that shape the write
  // chain's existing-good guard then refuses EVERY candidate, however good,
  // because `existingIsBad` looks only at length and source-copy and so is
  // false. Queued by one gate, discarded unconditionally by another. Measured
  // on the corpus this accounts for the whole existing-good bucket. If this
  // ever stops holding, the audit's headline number is stale.
  it('discards every candidate for a title queued only by titleLooksUntranslated', () => {
    const job = {
      sourceLang: 'de',
      title: 'Metzger 60-100%',
      titleByLocale: { de: 'Metzger 60-100%', it: 'Aiuto Metzger 60-100%' },
      descriptionByLocale: {},
    };
    expect(missingSlots(job)).toContainEqual({ locale: 'it', field: 'title' });
    const out = classifyMopupWrite({ job, locale: 'it', field: 'title', rawText: 'Macellaio 60-100%' });
    expect(out.decision).toBe('skip:existing-good');
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
