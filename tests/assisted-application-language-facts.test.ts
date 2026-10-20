import { describe, expect, it } from 'vitest';
import { ensureRequiredQuestions } from '../functions/src/assistedApplicationAiDraftCore.js';
import { isLanguageAbilityQuestion, isLanguageIntentQuestion, isLanguageNameOnly, languageCodeOf, languageExplicitlyAbsent } from '../functions/src/lib/languageFacts.js';
import { candidateAnswerForField, guardPlan } from '../scripts/assisted-application/lib/portal/plan.mjs';

describe('language facts stay conservative when a CV entry or question is ambiguous', () => {
  it('recognizes only exact language names and codes as language-only labels', () => {
    expect(isLanguageNameOnly('German')).toBe(true);
    expect(isLanguageNameOnly('de-CH')).toBe(true);
    expect(isLanguageNameOnly('German proficiency')).toBe(false);
    expect(isLanguageNameOnly('Are you German?')).toBe(false);
  });

  it('does not infer absence from a multi-language or unrecognized CV entry', () => {
    const mixed = {
      languagesExplicitList: true,
      languages: [{ language: 'German / English', level: 'C1' }],
    };
    const englishField = { kind: 'select', label: 'Do you speak English?', options: ['Yes', 'No'] };
    const germanField = { kind: 'select', label: 'Do you speak German?', options: ['Yes', 'No'] };

    expect(languageCodeOf('German / English')).toBe('');
    expect(languageExplicitlyAbsent(mixed, englishField.label)).toBe(false);
    expect(languageExplicitlyAbsent(mixed, germanField.label)).toBe(false);
    expect(candidateAnswerForField({ profile: mixed }, englishField)).toBeNull();
    expect(candidateAnswerForField({ profile: mixed }, germanField)).toBeNull();

    const dialect = { languagesExplicitList: true, languages: [{ language: 'Schweizerdeutsch', level: 'C1' }] };
    expect(languageCodeOf('Schweizerdeutsch')).toBe('');
    expect(languageExplicitlyAbsent(dialect, germanField.label)).toBe(false);
    expect(candidateAnswerForField({ profile: dialect }, germanField)).toBeNull();

    const partlyUnknown = { languagesExplicitList: true, languages: [{ language: 'German / Xhosa', level: 'C1' }] };
    expect(languageExplicitlyAbsent(partlyUnknown, englishField.label)).toBe(false);
    expect(candidateAnswerForField({ profile: partlyUnknown }, englishField)).toBeNull();

    const coded = { languagesExplicitList: true, languages: [{ language: 'de-CH', level: 'C1' }] };
    expect(languageCodeOf('de-CH')).toBe('de');
    expect(languageExplicitlyAbsent(coded, englishField.label)).toBe(true);
  });

  it('infers absence for a single, explicit current-ability question', () => {
    const profile = { languagesExplicitList: true, languages: [{ language: 'Italian', level: 'C1' }] };
    const question = 'Do you speak German?';

    expect(isLanguageAbilityQuestion(question)).toBe(true);
    expect(languageExplicitlyAbsent(profile, question)).toBe(true);
    expect(candidateAnswerForField({ profile }, { kind: 'select', label: question, options: ['Yes', 'No'] }))
      .toEqual({ value: 'No', source: 'profile' });
    expect(candidateAnswerForField({ profile }, {
      kind: 'select', label: 'German', context: question, options: ['Yes', 'No'],
    })).toEqual({ value: 'No', source: 'profile' });
    expect(candidateAnswerForField({ profile }, {
      kind: 'text', label: 'German', context: 'German proficiency level', options: [],
    })).toEqual({ value: 'No knowledge', source: 'profile' });

    const understand = 'Can you understand German?';
    expect(isLanguageAbilityQuestion(understand)).toBe(true);
    expect(languageExplicitlyAbsent(profile, understand)).toBe(true);
    expect(isLanguageAbilityQuestion('Do you use Excel?')).toBe(false);
    expect(isLanguageAbilityQuestion('Do you use English?')).toBe(true);
    expect(isLanguageAbilityQuestion('Do you speak klingon?')).toBe(true);

    const french = 'Parlez-vous allemand ?';
    expect(isLanguageAbilityQuestion(french)).toBe(true);
    expect(isLanguageIntentQuestion(french)).toBe(false);
    expect(languageExplicitlyAbsent(profile, french)).toBe(true);

    const capacity = 'Would you be able to speak German?';
    expect(isLanguageAbilityQuestion(capacity)).toBe(true);
    expect(isLanguageIntentQuestion(capacity)).toBe(false);
    expect(languageExplicitlyAbsent(profile, capacity)).toBe(true);

    const unknownLanguageIntent = 'Would you be willing to learn Xhosa?';
    expect(isLanguageAbilityQuestion(unknownLanguageIntent)).toBe(false);
    expect(isLanguageIntentQuestion(unknownLanguageIntent)).toBe(true);
    expect(languageExplicitlyAbsent(profile, unknownLanguageIntent)).toBe(false);
    const lowercaseLanguageIntent = 'Espérez-vous apprendre le klingon ?';
    expect(isLanguageIntentQuestion(lowercaseLanguageIntent)).toBe(true);
    expect(languageExplicitlyAbsent(profile, lowercaseLanguageIntent)).toBe(false);
    expect(isLanguageIntentQuestion('Are you interested in learning new skills?')).toBe(false);
    expect(isLanguageIntentQuestion('Do you plan to speak with customers?')).toBe(false);
  });

  it('does not accept an ungrounded language answer when candidate data is unavailable', () => {
    const field = { id: 'english', kind: 'select', label: 'Do you speak English?', required: true, options: ['Yes', 'No'] };
    const guarded = guardPlan({
      actions: [{ fieldId: 'english', action: 'select', value: 'Yes', document: 'none', source: 'rule', evidence: '' }],
      missingRequired: [],
    }, [field], null);

    expect(guarded.actions).toEqual([]);
    expect(guarded.missingRequired).toEqual([expect.objectContaining({ fieldId: 'english' })]);
  });

  it('keeps willingness-to-learn questions unknown in both draft and portal flows', () => {
    const question = 'Would you be willing to learn the German language?';
    const willingnessQuestions = [
      question,
      'Möchten Sie Deutsch sprechen?',
      'Vuoi parlare tedesco?',
      'Voulez-vous parler allemand?',
      'Do you enjoy speaking German?',
      'Do you like to speak German?',
      'Ti piace parlare tedesco?',
      'Aimez-vous parler allemand?',
      'Möchten Sie Deutsch sprechen können?',
      'Voudriez-vous pouvoir parler allemand ?',
    ];
    const willingProfile = {
      languagesExplicitList: true,
      cvLanguage: 'de',
      languages: [{ language: 'German', level: '' }, { language: 'English', level: 'C1' }],
    };
    const willingField = { kind: 'select', label: question, options: [{ label: 'Yes' }, { label: 'No' }] };

    expect(candidateAnswerForField({ profile: willingProfile }, willingField)).toBeNull();
    for (const wording of willingnessQuestions) {
      expect(isLanguageAbilityQuestion(wording)).toBe(false);
      expect(isLanguageIntentQuestion(wording)).toBe(true);
      expect(languageExplicitlyAbsent(willingProfile, wording)).toBe(false);
      expect(candidateAnswerForField({ profile: willingProfile }, {
        kind: 'select', label: wording, options: ['Yes', 'No'],
      })).toBeNull();
    }

    const absentProfile = { languagesExplicitList: true, languages: [{ language: 'Italian', level: 'C1' }] };
    const draftQuestion = { id: 'language_german', question, required: true, type: 'yes_no', options: ['Yes', 'No'] };
    expect(languageExplicitlyAbsent(absentProfile, question)).toBe(false);
    expect(ensureRequiredQuestions([draftQuestion], {
      requirements: {}, profile: absentProfile, answers: {}, locale: 'en',
    })).toContainEqual(draftQuestion);

    const inferredNo = { actions: [{ fieldId: 'language-german', action: 'select', value: 'No', document: 'none', source: 'rule', evidence: '' }], missingRequired: [] };
    const requiredField = { id: 'language-german', ...willingField, required: true };
    const guarded = guardPlan(inferredNo, [requiredField], { profile: willingProfile, answers: {}, portalQuestionsAnswered: [] });
    expect(guarded.actions).toEqual([]);
    expect(guarded.missingRequired).toEqual([expect.objectContaining({ fieldId: 'language-german' })]);

    const optionalField = { ...requiredField, required: false };
    const optional = guardPlan(inferredNo, [optionalField], { profile: willingProfile, answers: {}, portalQuestionsAnswered: [] });
    expect(optional.actions).toEqual([]);
    expect(optional.missingRequired).toEqual([]);

    const answered = { profile: willingProfile, answers: {}, portalQuestionsAnswered: [{ question, answer: 'Yes' }] };
    const reused = guardPlan(inferredNo, [requiredField], answered);
    expect(reused.actions).toEqual([expect.objectContaining({ fieldId: 'language-german', value: 'Yes', source: 'answers' })]);
    expect(reused.missingRequired).toEqual([]);

    const broadQuestion = 'What languages would you be willing to learn?';
    const broadField = { id: 'languages-to-learn', kind: 'text', label: broadQuestion, required: true, options: [] };
    expect(isLanguageIntentQuestion(broadQuestion)).toBe(true);
    const broadGuard = guardPlan({ actions: [{ fieldId: broadField.id, action: 'fill', value: 'German', document: 'none', source: 'rule', evidence: '' }], missingRequired: [] }, [broadField], { profile: absentProfile, answers: {}, portalQuestionsAnswered: [] });
    expect(broadGuard.actions).toEqual([]);
    expect(broadGuard.missingRequired).toEqual([expect.objectContaining({ fieldId: broadField.id })]);

    const contextualField = { id: 'language-context', kind: 'select', label: 'German', context: question, options: [{ label: 'Yes' }, { label: 'No' }], required: true };
    const contextualGuard = guardPlan({ actions: [{ fieldId: contextualField.id, action: 'select', value: 'No', document: 'none', source: 'rule', evidence: '' }], missingRequired: [] }, [contextualField], { profile: willingProfile, answers: {}, portalQuestionsAnswered: [] });
    expect(contextualGuard.actions).toEqual([]);
    expect(contextualGuard.missingRequired).toEqual([expect.objectContaining({ fieldId: contextualField.id, context: question })]);
    const contextualAnswer = guardPlan({ actions: [{ fieldId: contextualField.id, action: 'select', value: 'No', document: 'none', source: 'rule', evidence: '' }], missingRequired: [] }, [contextualField], { profile: willingProfile, answers: {}, portalQuestionsAnswered: [{ question, answer: 'Yes' }] });
    expect(contextualAnswer.actions).toEqual([expect.objectContaining({ fieldId: contextualField.id, value: 'Yes', source: 'answers' })]);
    expect(contextualAnswer.missingRequired).toEqual([]);

    const languagesField = { kind: 'textarea', label: 'What languages would you be willing to learn?', options: [] };
    expect(candidateAnswerForField({ profile: absentProfile }, languagesField)).toBeNull();
    expect(candidateAnswerForField({ profile: absentProfile }, {
      ...languagesField, label: 'What languages do you speak?',
    })).toEqual({ value: 'Italian C1', source: 'profile' });
  });
});
