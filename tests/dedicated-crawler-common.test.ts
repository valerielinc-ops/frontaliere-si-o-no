import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { hardenJobLocaleFields } from '../scripts/lib/dedicated-crawler-common.mjs';

describe('dedicated-crawler-common locale hardening', () => {
  it('removes wrong-language copied locales before real localization runs', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-locale-hardening-'));
    const jobsPath = path.join(tempDir, 'jobs.json');
    const jobs = [{
      slug: 'demo-job',
      title: 'Impiegato/a del commercio',
      description: 'Ti piace scoprire il mondo e ami il contatto con le persone. Questa descrizione è chiaramente italiana e abbastanza lunga da attivare il detector.',
      titleByLocale: {
        it: 'Impiegato/a del commercio',
        en: 'Impiegato/a del commercio',
        de: 'Impiegato/a del commercio',
        fr: 'Impiegato/a del commercio',
      },
      descriptionByLocale: {
        it: 'Ti piace scoprire il mondo e ami il contatto con le persone. Questa descrizione è chiaramente italiana e abbastanza lunga da attivare il detector.',
        en: 'Ti piace scoprire il mondo e ami il contatto con le persone. Questa descrizione è chiaramente italiana e abbastanza lunga da attivare il detector.',
        de: 'Ti piace scoprire il mondo e ami il contatto con le persone. Questa descrizione è chiaramente italiana e abbastanza lunga da attivare il detector.',
        fr: 'Ti piace scoprire il mondo e ami il contatto con le persone. Questa descrizione è chiaramente italiana e abbastanza lunga da attivare il detector.',
      },
      slugByLocale: {
        it: 'demo-job',
        en: 'demo-job',
        de: 'demo-job',
        fr: 'demo-job',
      },
    }];
    fs.writeFileSync(jobsPath, `${JSON.stringify(jobs, null, 2)}\n`, 'utf-8');

    const result = hardenJobLocaleFields({ dataJobsPath: jobsPath });
    const after = JSON.parse(fs.readFileSync(jobsPath, 'utf-8'));

    expect(result.changed).toBe(true);
    expect(after[0].sourceLang).toBe('it');
    expect(after[0].descriptionByLocale.it).toContain('Ti piace scoprire il mondo');
    expect(after[0].descriptionByLocale.en).toBeUndefined();
    expect(after[0].descriptionByLocale.de).toBeUndefined();
    expect(after[0].descriptionByLocale.fr).toBeUndefined();
  });

  it('rehomes real titles stored under the wrong locale instead of keeping fake copies', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-locale-hardening-'));
    const jobsPath = path.join(tempDir, 'jobs.json');
    const jobs = [{
      slug: 'quality-technician',
      title: 'Quality Technician (80-100%)',
      description: 'Posizione tecnica con responsabilita di qualita e supporto operativo. Questa descrizione e italiana e sufficientemente lunga da identificare la lingua sorgente in modo affidabile per il test.',
      titleByLocale: {
        it: 'Technicien Qualité (80-100%)',
      },
      descriptionByLocale: {
        it: 'Posizione tecnica con responsabilita di qualita e supporto operativo. Questa descrizione e italiana e sufficientemente lunga da identificare la lingua sorgente in modo affidabile per il test.',
      },
      slugByLocale: {
        it: 'quality-technician',
      },
    }];
    fs.writeFileSync(jobsPath, `${JSON.stringify(jobs, null, 2)}\n`, 'utf-8');

    hardenJobLocaleFields({ dataJobsPath: jobsPath });
    const after = JSON.parse(fs.readFileSync(jobsPath, 'utf-8'));

    expect(after[0].titleByLocale.en).toBe('Quality Technician (80-100%)');
    expect(after[0].titleByLocale.fr).toBe('Technicien Qualité (80-100%)');
    expect(after[0].titleByLocale.it).toBe('Quality Technician (80-100%)');
  });
});
