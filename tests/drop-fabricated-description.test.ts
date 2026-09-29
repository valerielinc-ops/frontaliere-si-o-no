import { describe, it, expect, vi } from 'vitest';
import {
  dropFabricatedDescription,
  dropFabricatedDescriptions,
} from '../scripts/lib/drop-fabricated-description.mjs';
import { mergePreserveLocaleData } from '../scripts/lib/dedicated-crawler-common.mjs';

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

describe('before the locale-preserving merge (prepareExistingJobs)', () => {
  // The merge keeps the stored source slot when the fresh text is under 30
  // characters, and keeps the translations of a source that did not drift:
  // text the crawler once wrote survives every later crawl unless it is
  // removed from the stored jobs first.
  const INVENTED_RE = /bei Stadler Rail in Altenrhein\. Stadler ist ein weltweit tätiger Hersteller/;
  const stored = () => [{
    id: 'stadler-1',
    url: 'https://www.stadlerrail.com/de/karriere/job/12345',
    slug: 'lehrstelle-anlagen-apparatebauer-in-efz-stadler',
    sourceLang: 'de',
    title: 'Lehrstelle Anlagen- und Apparatebauer:in EFZ',
    titleByLocale: { de: 'Lehrstelle Anlagen- und Apparatebauer:in EFZ' },
    description: 'Lehrstelle Anlagen- und Apparatebauer:in EFZ bei Stadler Rail in Altenrhein. Stadler ist ein weltweit tätiger Hersteller von Schienenfahrzeugen.',
    descriptionByLocale: {
      de: 'Lehrstelle Anlagen- und Apparatebauer:in EFZ bei Stadler Rail in Altenrhein. Stadler ist ein weltweit tätiger Hersteller von Schienenfahrzeugen.',
      it: 'Apprendistato presso Stadler Rail ad Altenrhein. Stadler è un produttore mondiale di veicoli ferroviari.',
    },
  }];
  const fresh = () => [{
    id: 'stadler-1',
    url: 'https://www.stadlerrail.com/de/karriere/job/12345',
    slug: 'lehrstelle-anlagen-apparatebauer-in-efz-stadler',
    sourceLang: 'de',
    title: 'Lehrstelle Anlagen- und Apparatebauer:in EFZ',
    titleByLocale: { de: 'Lehrstelle Anlagen- und Apparatebauer:in EFZ' },
    description: 'Lehrstelle EFZ Altenrhein',
    descriptionByLocale: { de: 'Lehrstelle EFZ Altenrhein' },
  }];

  it('without the cleanup the merge keeps the stored invented text and its translation', () => {
    const [job] = mergePreserveLocaleData(stored(), fresh());
    expect(INVENTED_RE.test(job.descriptionByLocale.de)).toBe(true);
    expect(job.descriptionByLocale.it).toContain('Stadler Rail');
  });

  it('with the cleanup the invented text and its translation are gone after the merge', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const [job] = mergePreserveLocaleData(dropFabricatedDescriptions(stored(), INVENTED_RE, 'Stadler'), fresh());
    log.mockRestore();
    expect(job.descriptionByLocale).toEqual({});
    expect(job.description).toBe('Lehrstelle EFZ Altenrhein');
    expect(job.needsRetranslation).toBe(true);
  });
});
