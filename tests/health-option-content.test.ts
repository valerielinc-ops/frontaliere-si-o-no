import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import itComparator from '../services/locales/it-comparatori';
import enComparator from '../services/locales/en-comparatori';
import deComparator from '../services/locales/de-comparatori';
import frComparator from '../services/locales/fr-comparatori';
import itCore from '../services/locales/it-core';
import enCore from '../services/locales/en-core';
import deCore from '../services/locales/de-core';
import frCore from '../services/locales/fr-core';
import { SECTION_EDITORIAL } from '../build-plugins/editorialContent';
import { FAQ_TRANSLATIONS } from '../services/seo/faq-translations';

// UFSP: formal exemption within three months; its Italy-family guidance permits
// a new option after childbirth for previously LAMal-insured workers, with conditions.
const cases = [
  ['it', itComparator, itCore, /tre mesi/, /Cantone/, /nascita/, /Italia/],
  ['en', enComparator, enCore, /three months/, /canton/, /birth/, /Italy/],
  ['de', deComparator, deCore, /drei Monaten/, /Arbeitskanton/, /Geburt/, /Italien/],
  ['fr', frComparator, frCore, /trois mois/, /canton/, /naissance/, /Italie/],
] as const;

describe('health option guidance', () => {
  it.each(cases)('keeps %s warnings and FAQ consistent with the conditional right', (_locale, comparator, core, deadline, authority, childbirth, residence) => {
    const warning = comparator['health.warningText'];
    const exception = `${comparator['health.attentionText']} ${core['faq.questions.health.a7']}`;
    expect(warning).toMatch(deadline);
    expect(warning).toMatch(authority);
    expect(warning).toMatch(residence);
    expect(exception).toMatch(childbirth);
    expect(exception).toMatch(/LAMal|KVG/);
    expect(exception).toMatch(/ASL/);
    for (const text of [warning, exception, core['faq.questions.health.a1']]) {
      expect(text).not.toMatch(/90 (?:giorni|days|Tage|jours)|3 (?:anni|years|Jahre|ans)|irrevoc|irrévoc|unwiderruf/i);
    }
  });

  it('does not promise a fresh option merely on a change of employer or canton', () => {
    const translated = FAQ_TRANSLATIONS['Il diritto di opzione LAMal/SSN è irreversibile?'];
    for (const locale of ['en', 'de', 'fr'] as const) {
      expect(translated[locale].a).not.toMatch(/same employer|Kantonswechsel|changement de canton/);
      expect(translated[locale].a).toContain('bag.admin.ch');
    }
  });

  it('keeps the guide procedure aligned with the cantonal exemption authority', () => {
    const guide = SECTION_EDITORIAL['/guida-frontaliere/lamal-frontalieri'].it.join(' ');
    expect(guide).toContain('domanda formale di esenzione');
    expect(guide).toContain('autorità competente del Cantone di lavoro');
    expect(guide).not.toMatch(/scelta è definitiva|nuova assunzione|Istituto Comune/);
    for (const [locale, procedure] of [['en', /formally request exemption/], ['de', /formell die Befreiung/], ['fr', /demander formellement une exemption/]] as const) {
      expect(SECTION_EDITORIAL['/guida-frontaliere/lamal-frontalieri'][locale].join(' ')).toMatch(procedure);
    }
  });

  it('removes unconditional finality from generated content surfaces', () => {
    for (const file of ['build-plugins/editorialContent.ts', 'build-plugins/frontalierePillarCopy.ts', 'build-plugins/shared/salaryLandingShell.ts', 'build-plugins/staticPagesPlugin.ts', 'services/pdfReport.ts', 'services/seo/seo-pages.ts']) {
      expect(readFileSync(file, 'utf8')).not.toMatch(/irrevoc|irrévoc|unwiderruf|non si può tornare al SSN/i);
    }
    const salaryLanding = readFileSync('build-plugins/shared/salaryLandingShell.ts', 'utf8');
    expect(salaryLanding).toContain('domanda formale di esenzione');
    expect(salaryLanding).toContain('formally request exemption');
    expect(salaryLanding).toContain('formell die Befreiung');
    expect(salaryLanding).toContain('demander formellement une exemption');
    const component = readFileSync('components/comparators/HealthInsurance.tsx', 'utf8');
    expect(component).toContain("t('health.warningText')");
    expect(component).not.toContain('<strong>irrevocabile</strong>');
    const leadMagnet = readFileSync('components/shared/LeadMagnetCTA.tsx', 'utf8');
    expect(leadMagnet).toContain('chiedi formalmente l’esenzione dalla LAMal');
    expect(leadMagnet).toContain('all’autorità del Cantone di lavoro entro 3 mesi');
    expect(leadMagnet).not.toMatch(/scelta irreversibile/i);
  });
});
