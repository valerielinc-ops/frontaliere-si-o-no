import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  classifyMopupStructure,
  isOverwriteSlot,
  missingSlots,
  orderMopupRequestsTitleFirst,
  overwriteQueueBudget,
  readOverwriteRollback,
  recordOverwriteRollback,
  shouldQueueArgosSlot,
  writeReserveMs,
} from '../scripts/local-mt-mopup.mjs';

/**
 * The Argos mop-up queues overwrite titles only up to what the pass can write.
 *
 * On the corpus run 37272320066 (2026-10-05) Phase 2a translated 4166 requests
 * and wrote 1227: 2847 were overwrite candidates (a stored, well-formed title
 * in the wrong language), the semantic rollout writes at most 100 of those per
 * process and its run rollback tripped after 116, so 2731 translations were
 * thrown away; Phase 2c queued the same titles again and wrote 0 of 3015.
 */

const job = (titleByLocale: Record<string, string>) => ({
  sourceLang: 'de',
  title: 'Lagermitarbeiter Logistik 100%',
  titleByLocale: { de: 'Lagermitarbeiter Logistik 100%', ...titleByLocale },
  description: '',
  descriptionByLocale: {},
});

describe('isOverwriteSlot()', () => {
  it('is false for an empty, short or source-copy title: those writes are fills and repairs', () => {
    expect(isOverwriteSlot(job({}), { locale: 'it', field: 'title' })).toBe(false);
    expect(isOverwriteSlot(job({ it: 'La' }), { locale: 'it', field: 'title' })).toBe(false);
    expect(isOverwriteSlot(job({ it: 'Lagermitarbeiter Logistik 100%' }), { locale: 'it', field: 'title' })).toBe(false);
  });

  it('is true for a stored, well-formed title in another language', () => {
    expect(isOverwriteSlot(job({ it: 'Warehouse logistics worker 100%' }), { locale: 'it', field: 'title' })).toBe(true);
  });

  it('is false for descriptions and for the source locale', () => {
    expect(isOverwriteSlot(job({ it: 'Warehouse logistics worker 100%' }), { locale: 'it', field: 'description' })).toBe(false);
    expect(isOverwriteSlot(job({}), { locale: 'de', field: 'title' })).toBe(false);
  });

  it('agrees with the write guard: a language-driven write is always an overwrite slot', () => {
    const cases = [
      job({}),
      job({ it: 'La' }),
      job({ it: 'Lagermitarbeiter Logistik 100%' }),
      job({ it: 'Warehouse logistics worker 100%' }),
      job({ it: 'Lagermitarbeiter im Bereich Logistik' }),
    ];
    for (const candidate of cases) {
      const structural = classifyMopupStructure({
        job: candidate, locale: 'it', field: 'title', rawText: 'Magazziniere logistica 100%',
      });
      const overwrite = isOverwriteSlot(candidate, { locale: 'it', field: 'title' });
      if (structural.languageDriven) expect(overwrite).toBe(true);
      if (!overwrite) expect(structural.languageDriven).not.toBe(true);
    }
  });
});

describe('Argos overwrite queue handoff', () => {
  const eligibleTitle = job({
    it: 'System Ingegnere con Projekterfahrung 80–100 %',
  });

  // A well-formed overwrite slot the detector does not flag: no Codex
  // handoff, it stays with the Argos guards.
  const nonEligibleTitle = {
    sourceLang: 'de',
    title: 'Zimmermann/Zimmerin für Montage und Renovationen',
    titleByLocale: {
      de: 'Zimmermann/Zimmerin für Montage und Renovationen',
      it: 'Carpentiere per montaggio e ristrutturazioni',
    },
    description: '',
    descriptionByLocale: {},
  };

  // `source-overlap` only (the residue that tripped the Argos rollback every
  // run): handed to the Codex lane.
  const overlapOnlyTitle = {
    sourceLang: 'de',
    title: 'Zimmermann/Zimmerin für Montage und Renovationen',
    titleByLocale: {
      de: 'Zimmermann/Zimmerin für Montage und Renovationen',
      it: 'Zimmermann/Zimmerin per Montage e Renovationen',
    },
    description: '',
    descriptionByLocale: {},
  };

  it('hands an overlap-only title overwrite to the Codex lane', () => {
    expect(isOverwriteSlot(overlapOnlyTitle, { locale: 'it', field: 'title' })).toBe(true);
    expect(shouldQueueArgosSlot(overlapOnlyTitle, { locale: 'it', field: 'title' })).toBe(false);
  });

  it('excludes an eligible title overwrite and the queued count reflects the handoff', () => {
    const slots = [
      { job: eligibleTitle, locale: 'it', field: 'title' as const },
      { job: nonEligibleTitle, locale: 'it', field: 'title' as const },
    ];

    expect(slots.every((slot) => isOverwriteSlot(slot.job, slot))).toBe(true);
    expect(shouldQueueArgosSlot(eligibleTitle, { locale: 'it', field: 'title' })).toBe(false);
    expect(shouldQueueArgosSlot(nonEligibleTitle, { locale: 'it', field: 'title' })).toBe(true);

    const queuedOverwriteSlots = slots.filter((slot) =>
      isOverwriteSlot(slot.job, slot) && shouldQueueArgosSlot(slot.job, slot));
    expect(queuedOverwriteSlots).toHaveLength(1);
    expect(`Overwrite slots: ${queuedOverwriteSlots.length} queued`).toBe('Overwrite slots: 1 queued');
  });

  it('keeps a description slot in the Argos queue', () => {
    const sourceDescription = 'Ihre Aufgaben und Anforderungen fuer die Stelle. '.repeat(5);
    const descriptionJob = {
      ...eligibleTitle,
      description: sourceDescription,
      descriptionByLocale: {
        de: sourceDescription,
        it: sourceDescription,
      },
    };

    expect(missingSlots(descriptionJob)).toContainEqual({ locale: 'it', field: 'description' });
    expect(isOverwriteSlot(descriptionJob, { locale: 'it', field: 'description' })).toBe(false);
    expect(shouldQueueArgosSlot(descriptionJob, { locale: 'it', field: 'description' })).toBe(true);
  });
});

describe('overwriteQueueBudget()', () => {
  it('queues no overwrite once the run rollback has tripped', () => {
    expect(overwriteQueueBudget({ overwritesEnabled: true, maxOverwrites: 100, rollbackTripped: true })).toBe(0);
  });

  it('queues the shadow sample (the cap) with the kill-switch off', () => {
    expect(overwriteQueueBudget({ overwritesEnabled: false, maxOverwrites: 100 })).toBe(100);
  });

  it('queues the cap times the factor when enforcing, never a negative or fractional budget', () => {
    expect(overwriteQueueBudget({ overwritesEnabled: true, maxOverwrites: 100, factor: 4 })).toBe(400);
    expect(overwriteQueueBudget({ overwritesEnabled: true, maxOverwrites: 100, factor: '3' })).toBe(300);
    expect(overwriteQueueBudget({ overwritesEnabled: true, maxOverwrites: 100, factor: 'x' })).toBe(100);
    expect(overwriteQueueBudget({ overwritesEnabled: true, maxOverwrites: -5 })).toBe(0);
  });
});

describe('orderMopupRequestsTitleFirst() with overwrite titles', () => {
  it('puts fill and repair titles first, overwrite titles next, descriptions last', () => {
    const requests = [
      { id: 'd1', field: 'description' },
      { id: 'o1', field: 'title', overwrite: true },
      { id: 't1', field: 'title' },
      { id: 'o2', field: 'title', overwrite: true },
      { id: 't2', field: 'title' },
    ];
    const ordered = orderMopupRequestsTitleFirst(
      requests,
      (r: { field: string }) => r.field,
      (r: { overwrite?: boolean }) => r.overwrite === true,
    );
    expect(ordered.map((r: { id: string }) => r.id)).toEqual(['t1', 't2', 'o1', 'o2', 'd1']);
  });
});

describe('run-scoped overwrite rollback marker', () => {
  const marker = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mopup-rollback-')), 'marker.json');

  it('remembers a tripped rollback for the same run only', () => {
    const file = marker();
    recordOverwriteRollback(1000, { tripped: true, reason: 'regression-limit', observed: 116, regressions: 6 }, file);
    expect(readOverwriteRollback(1000, file)).toMatchObject({ tripped: true, reason: 'regression-limit' });
    expect(readOverwriteRollback(2000, file)).toBeNull();
  });

  it('writes nothing for an armed guard and reads nothing from a missing file', () => {
    const file = marker();
    recordOverwriteRollback(1000, { tripped: false, reason: 'within-policy' }, file);
    expect(fs.existsSync(file)).toBe(false);
    expect(readOverwriteRollback(1000, file)).toBeNull();
  });
});

describe('writeReserveMs()', () => {
  const MIN = 60 * 1000;

  it('keeps a quarter of the phase budget for the write loop, between 5 and 15 minutes', () => {
    expect(writeReserveMs(75 * MIN)).toBe(15 * MIN); // Phase 2a
    expect(writeReserveMs(35 * MIN)).toBe(8.75 * MIN); // a late Phase 2c
    expect(writeReserveMs(12 * MIN)).toBe(5 * MIN);
    expect(writeReserveMs(0)).toBe(5 * MIN);
  });

  it('honours a positive override and ignores an invalid one', () => {
    expect(writeReserveMs(75 * MIN, String(7 * MIN))).toBe(7 * MIN);
    expect(writeReserveMs(75 * MIN, '0')).toBe(15 * MIN);
    expect(writeReserveMs(75 * MIN, 'abc')).toBe(15 * MIN);
  });
});
