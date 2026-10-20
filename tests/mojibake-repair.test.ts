import { describe, expect, it } from 'vitest';
import {
  hasMojibake,
  repairJobMojibakeInPlace,
  repairMojibakeText,
} from '../scripts/lib/repair-mojibake.mjs';
import { isIncomplete } from '../scripts/lib/translation-incomplete.mjs';
import { isAcceptableTranslation } from '../scripts/lib/translation-quality.mjs';

const MIN_DESC = 'x'.repeat(120);

describe('job mojibake repair', () => {
  it('repairs complete double-encoding and the malformed locale fragments found in fachkraft', () => {
    expect(repairMojibakeText('ActivitÃ©s et dÃ©ploiements', 'fr'))
      .toBe('Activités et déploiements');
    expect(repairMojibakeText('AttivitÃ  - piÃ1 e puÃ2; Ã ̈ disponibile', 'it'))
      .toBe('Attività - più e può; è disponibile');
    expect(repairMojibakeText('ActivitÃ', 'fr')).toBe('ActivitÃ');
  });

  it('does not classify valid French Âge as mojibake', () => {
    expect(hasMojibake('Âge idéal')).toBe(false);
    expect(repairMojibakeText('Âge idéal', 'fr')).toBe('Âge idéal');
  });

  it('rejects malformed provider output and queues an existing bad locale', () => {
    const source = 'A German source description with enough detail. '.repeat(8);
    const broken = `AttivitÃ ${MIN_DESC}`;
    expect(isAcceptableTranslation(source, broken)).toBe(false);

    const job = {
      title: 'German position',
      description: source,
      sourceLang: 'de',
      titleByLocale: {
        de: 'Deutsche Stelle',
        it: 'Posizione italiana',
        en: 'English position',
        fr: 'Poste français',
      },
      descriptionByLocale: {
        de: source,
        it: broken,
        en: `English description ${MIN_DESC}`,
        fr: `Description française ${MIN_DESC}`,
      },
    };

    expect(isIncomplete(job)).toBe(true);
  });

  it('repairs a synthetic job before assembly and is idempotent', () => {
    const job = {
      sourceLang: 'de',
      title: 'German position',
      description: 'Deutsche Beschreibung',
      requirements: 'Deutsche Anforderungen',
      titleByLocale: {
        de: 'Deutsche Stelle',
        it: 'AttivitÃ ',
        en: 'English position',
        fr: 'Poste français',
      },
      descriptionByLocale: {
        de: 'Deutsche Beschreibung',
        it: 'AttivitÃ  - piÃ1 e puÃ2; Ã ̈ disponibile',
        en: 'English description',
        fr: 'ActivitÃ©s et dÃ©ploiements',
      },
      requirementsByLocale: {
        it: 'QualitÃ  e disponibilitÃ ',
      },
    };

    expect(repairJobMojibakeInPlace(job)).toBe(4);
    expect(job.titleByLocale.it).toBe('Attività');
    expect(job.descriptionByLocale.it).toBe('Attività - più e può; è disponibile');
    expect(job.descriptionByLocale.fr).toBe('Activités et déploiements');
    expect(job.requirementsByLocale.it).toBe('Qualità e disponibilità');
    expect(hasMojibake(job.titleByLocale.it)).toBe(false);
    expect(hasMojibake(job.descriptionByLocale.it)).toBe(false);
    expect(repairJobMojibakeInPlace(job)).toBe(0);
  });

  it('queues ambiguous and replacement-character values and drops them only from assembly', () => {
    const job = {
      sourceLang: 'it',
      title: 'Titolo valido',
      description: 'Descrizione valida',
      titleByLocale: { it: 'Titolo valido' },
      descriptionByLocale: {
        it: 'Descrizione valida',
        fr: 'ActivitÃ',
        de: 'Chef�fe',
      },
      requirementsByLocale: {
        fr: ['ActivitÃ©s', 'Chef�fe'],
      },
    };

    expect(repairJobMojibakeInPlace(job)).toBe(1);
    expect(job.needsRetranslation).toBe(true);
    expect(job.descriptionByLocale.fr).toBe('ActivitÃ');
    expect(job.requirementsByLocale.fr).toEqual(['Activités', 'Chef�fe']);

    expect(repairJobMojibakeInPlace(job, { dropUnrecoverable: true })).toBe(1);
    expect(job.needsRetranslation).toBe(true);
    expect(job.descriptionByLocale.fr).toBeUndefined();
    expect(job.descriptionByLocale.de).toBeUndefined();
    expect(job.requirementsByLocale.fr).toEqual(['Activités']);
    expect(JSON.stringify(job)).not.toMatch(/Ã|Â|�/u);
  });

  it('queues mojibake in requirement arrays even when title and description pass', () => {
    expect(isIncomplete({
      titleByLocale: {
        it: 'Titolo italiano',
        en: 'English title',
        de: 'Deutscher Titel',
        fr: 'Titre français',
      },
      descriptionByLocale: {
        it: MIN_DESC,
        en: MIN_DESC,
        de: MIN_DESC,
        fr: MIN_DESC,
      },
      requirementsByLocale: {
        fr: ['ActivitÃ'],
      },
    })).toBe(true);
  });
});
