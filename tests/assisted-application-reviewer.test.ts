import { describe, expect, it } from 'vitest';
import {
  applyStructuredEdits,
  countOccurrences,
  summarizeStructuredEdits,
} from '../functions/src/lib/applyStructuredEdits.js';
import {
  applyReviewerRefinement,
  buildReviewerPrompt,
  REVIEWER_OUTPUT_SCHEMA,
} from '../functions/src/assistedApplicationAiReviewer.js';

describe('applyStructuredEdits', () => {
  it('correctly counts substring occurrences', () => {
    const text = 'Sviluppatore React a Lugano. Cercasi sviluppatore React con esperienza.';
    expect(countOccurrences(text, 'React')).toBe(2);
    expect(countOccurrences(text, 'Lugano')).toBe(1);
    expect(countOccurrences(text, 'Zurigo')).toBe(0);
  });

  it('applies exact single-match structured replacements', () => {
    const original = `
Gentile Responsabile delle Risorse Umane di UBS,
Desidero sottoporre la mia candidatura per la posizione di Sviluppatore Full-Stack.
Ho maturato esperienza generica su varie tecnologie web.
Cordiali saluti,
Mario Rossi
    `.trim();

    const edits = [
      {
        file: 'letter',
        old_string: 'Ho maturato esperienza generica su varie tecnologie web.',
        new_string: 'Ho maturato 5 anni di comprovata esperienza su architetture cloud in TypeScript e React.',
        reason: 'keyword_match',
      },
    ];

    const { updatedText, applied, rejected } = applyStructuredEdits(original, edits);
    expect(applied).toHaveLength(1);
    expect(rejected).toHaveLength(0);
    expect(updatedText).toContain('Ho maturato 5 anni di comprovata esperienza su architetture cloud in TypeScript e React.');
    expect(updatedText).not.toContain('esperienza generica');
  });

  it('rejects ambiguous edits matching multiple times', () => {
    const text = 'React è ottimo. Usiamo React ogni giorno.';
    const edits = [
      {
        file: 'letter',
        old_string: 'React',
        new_string: 'React.js',
        reason: 'style_fix',
      },
    ];

    const { updatedText, applied, rejected } = applyStructuredEdits(text, edits);
    expect(applied).toHaveLength(0);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toContain('ambiguous_match');
    expect(updatedText).toBe(text); // Unaltered
  });

  it('rejects edits when old_string is missing', () => {
    const text = 'Esperienza con database PostgreSQL e MySQL.';
    const edits = [
      {
        file: 'letter',
        old_string: 'Oracle DB',
        new_string: 'PostgreSQL',
        reason: 'keyword_match',
      },
    ];

    const { applied, rejected } = applyStructuredEdits(text, edits);
    expect(applied).toHaveLength(0);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBe('old_string_not_found');
  });

  it('summarizes applied and rejected edits cleanly', () => {
    const applied = [{ old_string: 'old', new_string: 'new', reason: 'keyword_match' }];
    const rejected = [{ edit: { old_string: 'missing' }, reason: 'old_string_not_found' }];
    const summary = summarizeStructuredEdits(applied, rejected);
    expect(summary).toContain('1 applied, 1 rejected');
    expect(summary).toContain('keyword_match');
    expect(summary).toContain('old_string_not_found');
  });
});

describe('assistedApplicationAiReviewer', () => {
  it('builds prompt containing candidate profile and company research', () => {
    const profile = {
      headline: 'Software Engineer',
      skills: ['TypeScript', 'Node.js', 'React'],
      experience: [{ role: 'Developer', employer: 'Tech SA', start: '2020', end: '2024', highlights: ['Led API redesign'] }],
    };
    const companyResearch = {
      legalName: 'UBS Switzerland AG',
      industry: 'Banking',
      mission: 'Eccellenza finanziaria globale.',
    };

    const { systemPrompt, userText } = buildReviewerPrompt({
      profile,
      postingText: 'Cercasi Senior Full-Stack Engineer a Lugano.',
      letterDraft: 'Gentile UBS, mi candido per il ruolo.',
      companyResearch,
    });

    expect(systemPrompt).toContain('Swiss hiring manager proxy');
    expect(systemPrompt).toContain('Grounding Rule');
    expect(userText).toContain('UBS Switzerland AG');
    expect(userText).toContain('TypeScript');
    expect(userText).toContain('Eccellenza finanziaria');
  });

  it('applies reviewer refinement across letter and cv drafts', () => {
    const letterDraft = 'Gentile Team, propongo la mia candidatura come frontend dev.';
    const cvDraft = 'Competenze: JavaScript, HTML, CSS.';

    const reviewerOutput = {
      fitScore: 88,
      structuredEdits: [
        {
          file: 'letter',
          old_string: 'come frontend dev.',
          new_string: 'come Senior Frontend Engineer per i sistemi core di Lugano.',
          reason: 'action_reframing',
        },
        {
          file: 'cv',
          old_string: 'Competenze: JavaScript, HTML, CSS.',
          new_string: 'Competenze: TypeScript, React, Next.js, JavaScript, HTML, CSS.',
          reason: 'keyword_match',
        },
      ],
      narrativeSuggestions: {
        missedKeywords: ['CI/CD'],
        companyAngles: 'Focus sull\'affidabilità dei sistemi bancari ticinesi.',
        actionReframing: 'Ottimo l\'uso di metriche concrete.',
        toneAndStyle: 'Tono formale e sicuro, consono al mercato svizzero.',
      },
      groundingAuditWarnings: [],
    };

    const result = applyReviewerRefinement({
      letterDraft,
      cvDraft,
      reviewerOutput,
    });

    expect(result.appliedCount).toBe(2);
    expect(result.rejectedCount).toBe(0);
    expect(result.revisedLetter).toContain('come Senior Frontend Engineer per i sistemi core di Lugano.');
    expect(result.revisedCv).toContain('TypeScript, React, Next.js');
    expect(result.reviewSummary.fitScore).toBe(88);
  });
});
