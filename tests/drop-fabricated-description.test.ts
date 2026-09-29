import { describe, it, expect, vi } from 'vitest';
import {
  dropFabricatedDescription,
  dropFabricatedDescriptions,
} from '../scripts/lib/drop-fabricated-description.mjs';

const WRAPPER_RE = /Die Thurklinik in Niederuzwil \(SG\) ist eine Belegspital-Tagesklinik/;

function storedJob() {
  const wrapped = 'Die Thurklinik in Niederuzwil (SG) ist eine Belegspital-Tagesklinik mit Schwerpunkten Gynäkologie.\n\nStelle: Technischer Allrounder 80-100%.\n\nThurklinik AG - Ihre Gesundheit in besten Händen.';
  return {
    sourceLang: 'de',
    description: wrapped,
    descriptionByLocale: {
      de: wrapped,
      it: 'La Thurklinik di Niederuzwil (SG) è una clinica diurna con reparti di ginecologia.',
      en: 'The Thurklinik in Niederuzwil (SG) is a day clinic specialising in gynaecology.',
    },
    titleByLocale: { de: 'Technischer Allrounder 80-100%', it: 'Tecnico tuttofare 80-100%' },
  };
}

describe('dropFabricatedDescription', () => {
  it('drops the wrapped source slot, the translations made from it and the flat description', () => {
    const job: any = storedJob();
    expect(dropFabricatedDescription(job, WRAPPER_RE)).toBe(true);
    expect(job.descriptionByLocale).toEqual({});
    expect(job.description).toBe('');
    expect(job.needsRetranslation).toBe(true);
    // Titles are not the crawler's text: they stay.
    expect(job.titleByLocale.it).toBe('Tecnico tuttofare 80-100%');
  });

  it('drops a non-source slot that still carries the crawler text', () => {
    const job: any = {
      sourceLang: 'de',
      description: 'Ihre Aufgaben: Unterhalt der Anlagen.',
      descriptionByLocale: {
        de: 'Ihre Aufgaben: Unterhalt der Anlagen.',
        it: 'Die Thurklinik in Niederuzwil (SG) ist eine Belegspital-Tagesklinik (copia non tradotta).',
      },
    };
    expect(dropFabricatedDescription(job, WRAPPER_RE)).toBe(true);
    expect(job.descriptionByLocale).toEqual({ de: 'Ihre Aufgaben: Unterhalt der Anlagen.' });
    expect(job.description).toBe('Ihre Aufgaben: Unterhalt der Anlagen.');
  });

  it('leaves a job with the source text alone', () => {
    const job: any = {
      sourceLang: 'de',
      description: 'Ihre Aufgaben: Unterhalt der Anlagen.',
      descriptionByLocale: { de: 'Ihre Aufgaben: Unterhalt der Anlagen.', it: 'I suoi compiti: manutenzione degli impianti.' },
    };
    expect(dropFabricatedDescription(job, WRAPPER_RE)).toBe(false);
    expect(job.descriptionByLocale.it).toBe('I suoi compiti: manutenzione degli impianti.');
    expect(job.needsRetranslation).toBeUndefined();
  });

  it('tolerates missing jobs and locale maps', () => {
    expect(dropFabricatedDescription(null, WRAPPER_RE)).toBe(false);
    expect(dropFabricatedDescription({ description: '' }, WRAPPER_RE)).toBe(false);
  });
});

describe('dropFabricatedDescriptions', () => {
  it('repairs every stored job, returns the same array and logs the count', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const clean: any = { sourceLang: 'de', description: 'Ihre Aufgaben.', descriptionByLocale: { de: 'Ihre Aufgaben.' } };
    const jobs = [storedJob(), clean];
    const out = dropFabricatedDescriptions(jobs, WRAPPER_RE, 'Thurklinik');
    expect(out).toBe(jobs);
    expect(jobs[0].descriptionByLocale).toEqual({});
    expect(clean.descriptionByLocale).toEqual({ de: 'Ihre Aufgaben.' });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Thurklinik: removed the crawler-written description from 1 stored job(s)'));
    log.mockRestore();
  });

  it('returns an empty array for a missing input', () => {
    expect(dropFabricatedDescriptions(undefined as any, WRAPPER_RE, 'x')).toEqual([]);
  });
});
