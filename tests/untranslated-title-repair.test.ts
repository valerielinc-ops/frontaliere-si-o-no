import { describe, expect, it } from 'vitest';
import { titleLooksUntranslated } from '../scripts/lib/job-locale-utils.mjs';
import {
  isTitleRepairQueueVerdict,
  TITLE_REPAIR_QUEUE_REASONS,
} from '../scripts/lib/untranslated-title-repair.mjs';

describe('title repair queue admission', () => {
  it('admits marker-backed real partial German residues from the language-arm queue', () => {
    const cases = [
      {
        title: 'System Ingegnere con Projekterfahrung 80–100 %',
        sourceTitle: 'System Engineer mit Projekterfahrung 80–100 %',
        targetLocale: 'it',
        reason: 'compound-residue',
      },
      {
        title: 'Technical:r Operational employee Hydropower plant Gösgen',
        sourceTitle: 'Technische:r Betriebsmitarbeiter:in Wasserkraftwerk Gösgen',
        targetLocale: 'en',
        reason: 'source-orthography',
      },
      {
        title: 'Technique:r Employés opérationnels Centrale hydroélectrique Gösgen',
        sourceTitle: 'Technische:r Betriebsmitarbeiter:in Wasserkraftwerk Gösgen',
        targetLocale: 'fr',
        reason: 'source-orthography',
      },
      {
        title: 'Software Architect: in the tax area 80-100%',
        sourceTitle: 'Software Architekt:in im Steuerbereich 80–100 %',
        targetLocale: 'en',
        reason: 'binnen-i',
      },
      {
        title: 'System Ingénieur mit Projekterfahrung 80–100 %',
        sourceTitle: 'System Engineer mit Projekterfahrung 80–100 %',
        targetLocale: 'fr',
        reason: 'source-function-word',
      },
    ] as const;

    for (const { title, sourceTitle, targetLocale, reason } of cases) {
      const verdict = titleLooksUntranslated({
        title,
        sourceTitle,
        sourceLang: 'de',
        targetLocale,
      });
      expect(verdict, title).toMatchObject({ untranslated: true, reason });
      expect(isTitleRepairQueueVerdict(verdict), title).toBe(true);
    }
  });

  it('keeps overlap-only and gender-code signals out of the repair queue', () => {
    const overlap = titleLooksUntranslated({
      title: '2nd Level Support Ingénieur',
      sourceTitle: '2nd Level Support Ingenieur',
      sourceLang: 'de',
      targetLocale: 'fr',
    });
    expect(overlap.untranslated).toBe(false);
    expect(isTitleRepairQueueVerdict({
      untranslated: true,
      reason: 'source-overlap',
    })).toBe(false);

    const gender = titleLooksUntranslated({
      title: 'Responsabile IT Division Hydroenergie e Biomasse (w/m/d)',
      sourceLang: 'de',
      targetLocale: 'it',
    });
    expect(gender.untranslated).toBe(false);
    expect(gender.genderCode).toBe(true);
    expect(isTitleRepairQueueVerdict({
      untranslated: true,
      reason: 'gender-code',
    })).toBe(false);
  });

  it('keeps the queue allowlist explicit', () => {
    expect(TITLE_REPAIR_QUEUE_REASONS).toEqual([
      'source-copy',
      'llm-reasoning',
      'source-function-word',
      'source-orthography',
      'binnen-i',
      'compound-residue',
    ]);
  });
});

describe('fix-untranslated-titles.mjs imports what it calls', () => {
  it('binds every job-locale-utils helper used in the script', async () => {
    // The script runs its main on import, so the binding is checked on the
    // source: a helper called but dropped from the import is a ReferenceError
    // on the first cascade result (review of PR 11898).
    const fs = await import('node:fs');
    const path = await import('node:path');
    const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'fix-untranslated-titles.mjs'), 'utf8');
    const imported = /import \{([^}]+)\} from '\.\/lib\/job-locale-utils\.mjs';/.exec(source)?.[1]
      .split(',').map((name) => name.trim()) ?? [];
    for (const helper of ['isTitleSourceCopy', 'titleContainsLlmReasoning', 'titleLooksUntranslated']) {
      const used = new RegExp(`\\b${helper}\\(`).test(source);
      if (used) expect(imported, helper).toContain(helper);
    }
    expect(source).toMatch(/titleContainsLlmReasoning\(translated\)/);
  });
});
