import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  AGENT_SCHEMA,
  advanceName,
  agentSystemPrompt,
  agentUserText,
  compactSnapshot,
  completeWithAgent,
  guardAgentStep,
  refusal,
  runAction,
  withoutSecrets,
} from '../scripts/assisted-application/lib/portal/agent.mjs';
import { isoDates, knownAnswer, knownValuesOf, planSystemPrompt } from '../scripts/assisted-application/lib/portal/plan.mjs';
import { candidateForForm, machineLabel } from '../scripts/assisted-application/lib/portal/portal.mjs';

const act = (action: Record<string, string>) => ({ ref: 'e5', action: 'click', value: '', document: 'none', question: '', answer: '', source: 'widget', ...action });
const turn = (status: string, actions: any[] = [], questions: any[] = []) => ({ status, reason: '', advanceRef: '', actions, questions });

describe('portal agentic fallback (career-ops: snapshot with refs)', () => {
  it('hands off a non-multipart Workday HTTP 500 even when the selected filename is visible', async () => {
    let clock = 0;
    const now = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const listeners = new Map<string, Set<(event: any) => void>>();
    const input: any = {
      tagName: 'INPUT',
      type: 'file',
      files: [],
      closest: () => null,
      getAttribute: () => null,
      matches: () => false,
    };
    const locator = {
      evaluate: async (read: (element: any) => unknown) => read(input),
      setInputFiles: async (files: string | string[]) => {
        const selected = Array.isArray(files) ? files : [files];
        input.files = selected.map((file) => ({ name: file.split('/').at(-1) }));
        const request = { method: () => 'POST', headers: () => ({ 'content-type': 'application/json' }) };
        for (const listener of listeners.get('request') || []) listener(request);
        for (const listener of listeners.get('response') || []) listener({ request: () => request, status: () => 500 });
        for (const listener of listeners.get('requestfinished') || []) listener(request);
      },
    };
    const page = {
      locator: (selector: string) => selector === '[role="alert"]:visible' ? { allInnerTexts: async () => [] } : locator,
      url: () => 'https://acme.wd1.myworkdayjobs.com/apply',
      on: (event: string, listener: (event: any) => void) => {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event)?.add(listener);
      },
      off: (event: string, listener: (event: any) => void) => { listeners.get(event)?.delete(listener); },
      getByText: () => ({ first: () => ({ isVisible: async () => true }) }),
      waitForTimeout: async (ms: number) => { clock += ms; },
    };
    try {
      const result = await runAction(page as any, act({ action: 'upload', document: 'cv' }), { cv: '/tmp/CV.pdf' });
      expect(result).toEqual({ ok: false, error: 'upload_not_confirmed' });
    } finally {
      now.mockRestore();
    }
  });

  // Giro di prova 2026-10-01 on JOIN: "Quando sei nato?" is a calendar of day buttons.
  it('never lets the model invent a birth date: the question goes to the candidate, with every move on it', () => {
    const empty = { answers: {}, profile: {}, portalQuestionsAnswered: [] };
    const guarded = guardAgentStep(turn('act', [
      act({ ref: 'e45', action: 'select', value: '1985', question: 'Quando sei nato?', answer: '1985-01-01', source: 'rule' }),
      act({ ref: 'e46', action: 'click', question: 'Quando sei nato?', source: 'widget' }),
      act({ ref: 'e60', action: 'click', question: 'Accetto l’informativa privacy', source: 'consent' }),
    ]), empty);
    expect(guarded.status).toBe('needs_candidate');
    expect(guarded.questions).toEqual([expect.objectContaining({ question: 'Quando sei nato?', type: 'date' })]);
    expect(guarded.actions.map((action: any) => action.ref)).toEqual(['e60']);

    // The candidate's answer, in another format, is used on the next run.
    const answered = { answers: { portal_quando_sei_nato: '12.05.1990' }, profile: {}, portalQuestionsAnswered: [{ question: 'Quando sei nato?', answer: '12.05.1990' }] };
    const run = guardAgentStep(turn('act', [act({ ref: 'e238', question: 'Quando sei nato?', answer: '1990-05-12', source: 'answers' })]), answered);
    expect(run).toMatchObject({ status: 'act', questions: [] });
    expect(run.actions).toHaveLength(1);
  });

  it('requires the candidate’s own answer for a language-intent question in a custom widget', async () => {
    const question = 'Would you be willing to learn German?';
    const candidate = {
      answers: {},
      profile: { languagesExplicitList: true, languages: [{ language: 'Italian', level: 'C1' }] },
      portalQuestionsAnswered: [],
    };
    const inferredFromProfile = guardAgentStep(turn('act', [act({
      ref: 'e7', action: 'select', value: 'No', question, answer: 'No', source: 'profile', evidence: 'Italian C1',
    })]), candidate);
    expect(inferredFromProfile).toMatchObject({
      status: 'needs_candidate',
      actions: [],
      questions: [expect.objectContaining({ question })],
    });

    const answered = {
      ...candidate,
      portalQuestionsAnswered: [{ question, answer: 'Yes' }],
    };
    const reused = guardAgentStep(turn('act', [act({
      ref: 'e7', action: 'select', value: 'Yes', question, answer: 'Yes', source: 'answers',
    })]), answered);
    expect(reused).toMatchObject({ status: 'act', questions: [] });
    expect(reused.actions).toHaveLength(1);

    const contextual = guardAgentStep(turn('act', [act({
      ref: 'e8', action: 'click', value: 'No', question: 'German', context: question, answer: 'No', source: 'profile', evidence: 'Italian C1',
    })]), answered);
    expect(contextual).toMatchObject({ status: 'act', questions: [] });
    expect(contextual.actions).toEqual([expect.objectContaining({ value: 'Yes', answer: 'Yes', source: 'answers' })]);

    let clicked = false;
    const locator = {
      evaluate: async () => ({ name: 'No', button: true, tag: 'button', inputType: '', editable: false, inList: false, submits: false, leaves: false }),
      click: async () => { clicked = true; },
    };
    const result = await runAction({ locator: () => locator } as any, contextual.actions[0]);
    expect(result).toEqual({ ok: false, error: 'answer_option_mismatch' });
    expect(clicked).toBe(false);

    const keyPress = guardAgentStep(turn('act', [act({
      ref: 'e9', action: 'press', value: 'Enter', question: 'German', context: question, answer: 'No', source: 'profile', evidence: 'Italian C1',
    })]), answered);
    expect(keyPress.actions).toEqual([expect.objectContaining({ value: 'Enter', answer: 'Yes', source: 'answers' })]);

    let pressed = false;
    const keyboardLocator = {
      evaluate: async () => ({ name: 'Yes', button: false, tag: 'div', inputType: '', editable: false, inList: true, submits: false, leaves: false }),
      press: async () => { pressed = true; },
    };
    const unsafeKeyPress = await runAction({ locator: () => keyboardLocator } as any, keyPress.actions[0]);
    expect(unsafeKeyPress).toEqual({ ok: false, error: 'language_choice_keyboard_selection_unsupported' });
    expect(pressed).toBe(false);
  });

  it('uses an explicit CV language list to answer a current-ability question in a custom widget', () => {
    const candidate = {
      answers: {},
      profile: { languagesExplicitList: true, languages: [{ language: 'Italian', level: 'C1' }] },
      portalQuestionsAnswered: [],
    };
    const question = 'Do you speak German?';
    const guarded = guardAgentStep(turn('act', [act({
      ref: 'e10', action: 'select', value: 'Yes', question: 'German', context: question,
      answer: 'Yes', source: 'profile', evidence: 'Italian C1',
    })]), candidate);

    expect(guarded).toMatchObject({ status: 'act', questions: [] });
    expect(guarded.actions).toEqual([expect.objectContaining({
      value: 'No', answer: 'No', source: 'profile',
    })]);

    const alreadyKnown = guardAgentStep(turn('needs_candidate', [], [{ question, type: 'yes_no' }]), candidate);
    expect(alreadyKnown).toMatchObject({ status: 'stuck', questions: [] });
  });

  it('requires candidate support for ordinary language-ability widgets', () => {
    const question = 'Do you speak German?';
    const ambiguous = {
      answers: {},
      profile: { languagesExplicitList: false, languages: [{ language: 'Italian', level: 'C1' }] },
      portalQuestionsAnswered: [],
    };
    const refused = guardAgentStep(turn('act', [act({
      ref: 'e11', action: 'click', value: 'Yes', question, answer: 'Yes', source: 'widget', evidence: 'Italian C1',
    })]), ambiguous);
    expect(refused).toMatchObject({
      status: 'needs_candidate',
      actions: [],
      questions: [expect.objectContaining({ question })],
    });

    const unrelatedEvidence = guardAgentStep(turn('act', [act({
      ref: 'e21', action: 'click', value: 'Yes', question, answer: 'Yes', source: 'profile', evidence: 'Berlin',
    })]), {
      answers: {}, profile: { residenceCity: 'Berlin' }, portalQuestionsAnswered: [],
    });
    expect(unrelatedEvidence).toMatchObject({
      status: 'needs_candidate',
      actions: [],
      questions: [expect.objectContaining({ question })],
    });

    const contextOnlyLanguage = guardAgentStep(turn('act', [act({
      ref: 'e22', action: 'click', value: 'Yes', question: 'Do you speak?', context: 'German',
      answer: 'Yes', source: 'profile', evidence: 'Berlin',
    })]), {
      answers: {}, profile: { residenceCity: 'Berlin' }, portalQuestionsAnswered: [],
    });
    expect(contextOnlyLanguage).toMatchObject({
      status: 'needs_candidate',
      actions: [],
      questions: [expect.objectContaining({ question: 'Do you speak?' })],
    });

    const wrongLanguageLevelEvidence = guardAgentStep(turn('act', [act({
      ref: 'e23', action: 'select', value: 'C1', question: 'German C1?', answer: 'C1',
      source: 'profile', evidence: 'English C1',
    })]), {
      answers: {}, profile: { cvText: 'English C1' }, portalQuestionsAnswered: [],
    });
    expect(wrongLanguageLevelEvidence).toMatchObject({
      status: 'needs_candidate',
      actions: [],
      questions: [expect.objectContaining({ question: 'German C1?' })],
    });

    const mixedLanguageEvidence = guardAgentStep(turn('act', [act({
      ref: 'e24', action: 'select', value: 'Yes', question: 'German C2?', answer: 'Yes',
      source: 'profile', evidence: 'German C1 / English C2',
    })]), {
      answers: {}, profile: { cvText: 'German C1 / English C2' }, portalQuestionsAnswered: [],
    });
    expect(mixedLanguageEvidence).toMatchObject({
      status: 'needs_candidate',
      actions: [],
      questions: [expect.objectContaining({ question: 'German C2?' })],
    });

    const connectors = ['and', 'or', 'nor', 'und', 'oder', 'et', 'ou', 'e', 'o', 'y', 'en', 'of', 'och', 'og', 'si', 'și', 's\u0326i', 'sau', 'sowie', 'samt', 'plus', 'ni', 'né', 'noch', 'nem', '&', ';', ',', '/', '+', '-', '–', '—', 'as well as', 'along with', 'together with', 'in addition to', 'ainsi que', 'de même que', 'oltre a', 'così come', 'insieme a', 'así como', 'bem como'];
    for (const connector of connectors) {
      for (const language of ['Xhosa', 'xhosa']) {
        const questionWithUnknownLanguage = `Do you speak German ${connector} ${language} at C2?`;
        const unrecognizedLanguageEvidence = guardAgentStep(turn('act', [act({
          ref: 'e25', action: 'select', value: 'Yes', question: questionWithUnknownLanguage,
          answer: 'Yes', source: 'profile', evidence: 'German C2',
        })]), {
          answers: {}, profile: { cvText: 'German C2' }, portalQuestionsAnswered: [],
        });
        expect(unrecognizedLanguageEvidence).toMatchObject({
          status: 'needs_candidate',
          actions: [],
          questions: [expect.objectContaining({ question: questionWithUnknownLanguage })],
        });
      }
    }

    const pairedGerman = 'Sprichst du sowohl Deutsch als auch xhosa auf C2?';
    const partialPairedEvidence = guardAgentStep(turn('act', [act({
      ref: 'e26', action: 'select', value: 'Yes', question: pairedGerman, answer: 'Yes',
      source: 'profile', evidence: 'Deutsch C2',
    })]), {
      answers: {}, profile: { cvText: 'Deutsch C2' }, portalQuestionsAnswered: [],
    });
    expect(partialPairedEvidence).toMatchObject({
      status: 'needs_candidate',
      actions: [],
      questions: [expect.objectContaining({ question: pairedGerman })],
    });

    const neitherNor = 'Do you speak neither German nor xhosa at C2?';
    const partialNeitherNorEvidence = guardAgentStep(turn('act', [act({
      ref: 'e29', action: 'select', value: 'Yes', question: neitherNor, answer: 'Yes',
      source: 'profile', evidence: 'German C2',
    })]), {
      answers: {}, profile: { cvText: 'German C2' }, portalQuestionsAnswered: [],
    });
    expect(partialNeitherNorEvidence).toMatchObject({
      status: 'needs_candidate', actions: [], questions: [expect.objectContaining({ question: neitherNor })],
    });

    const pairedEnglish = 'Do you speak not only German but also xhosa at C2?';
    const partialEnglishPair = guardAgentStep(turn('act', [act({
      ref: 'e28', action: 'select', value: 'Yes', question: pairedEnglish, answer: 'Yes',
      source: 'profile', evidence: 'German C2',
    })]), {
      answers: {}, profile: { cvText: 'German C2' }, portalQuestionsAnswered: [],
    });
    expect(partialEnglishPair).toMatchObject({
      status: 'needs_candidate', actions: [], questions: [expect.objectContaining({ question: pairedEnglish })],
    });

    const reversedLanguageOrder = 'Parlez-vous xhosa et allemand au niveau C2 ?';
    const reversedPartialEvidence = guardAgentStep(turn('act', [act({
      ref: 'e27', action: 'select', value: 'Yes', question: reversedLanguageOrder, answer: 'Yes',
      source: 'profile', evidence: 'allemand C2',
    })]), {
      answers: {}, profile: { cvText: 'allemand C2' }, portalQuestionsAnswered: [],
    });
    expect(reversedPartialEvidence).toMatchObject({
      status: 'needs_candidate',
      actions: [],
      questions: [expect.objectContaining({ question: reversedLanguageOrder })],
    });

    const emDashReverseOrder = 'Parlez-vous xhosa — allemand au niveau C2 ?';
    const partialEmDashEvidence = guardAgentStep(turn('act', [act({
      ref: 'e30', action: 'select', value: 'Yes', question: emDashReverseOrder, answer: 'Yes',
      source: 'profile', evidence: 'allemand C2',
    })]), {
      answers: {}, profile: { cvText: 'allemand C2' }, portalQuestionsAnswered: [],
    });
    expect(partialEmDashEvidence).toMatchObject({
      status: 'needs_candidate', actions: [], questions: [expect.objectContaining({ question: emDashReverseOrder })],
    });

    const spokenOrWrittenItalian = 'Qual è il livello di italiano parlato o scritto?';
    const supportedModeEvidence = guardAgentStep(turn('act', [act({
      ref: 'e31', action: 'select', value: 'C2', question: spokenOrWrittenItalian, answer: 'C2',
      source: 'profile', evidence: 'Italian C2',
    })]), {
      answers: {}, profile: { cvText: 'Italian C2' }, portalQuestionsAnswered: [],
    });
    expect(supportedModeEvidence).toMatchObject({
      status: 'act', actions: [expect.objectContaining({ value: 'C2' })], questions: [],
    });

    const advancedUnknownLanguage = 'Do you speak German and advanced xhosa at C2?';
    const partialAdvancedEvidence = guardAgentStep(turn('act', [act({
      ref: 'e32', action: 'select', value: 'Yes', question: advancedUnknownLanguage, answer: 'Yes',
      source: 'profile', evidence: 'German C2',
    })]), {
      answers: {}, profile: { cvText: 'German C2' }, portalQuestionsAnswered: [],
    });
    expect(partialAdvancedEvidence).toMatchObject({
      status: 'needs_candidate', actions: [], questions: [expect.objectContaining({ question: advancedUnknownLanguage })],
    });

    const alsoUnknownLanguage = 'Do you speak German and also Xhosa at C2?';
    const partialAlsoEvidence = guardAgentStep(turn('act', [act({
      ref: 'e34', action: 'select', value: 'Yes', question: alsoUnknownLanguage, answer: 'Yes',
      source: 'profile', evidence: 'German C2',
    })]), {
      answers: {}, profile: { cvText: 'German C2' }, portalQuestionsAnswered: [],
    });
    expect(partialAlsoEvidence).toMatchObject({
      status: 'needs_candidate', actions: [], questions: [expect.objectContaining({ question: alsoUnknownLanguage })],
    });

    const proficiencyWithContext = 'What is your German level and your proficiency in Xhosa?';
    const partialProficiencyContext = guardAgentStep(turn('act', [act({
      ref: 'e35', action: 'select', value: 'C2', question: proficiencyWithContext, answer: 'C2',
      source: 'profile', evidence: 'German C2',
    })]), {
      answers: {}, profile: { cvText: 'German C2' }, portalQuestionsAnswered: [],
    });
    expect(partialProficiencyContext).toMatchObject({
      status: 'needs_candidate', actions: [], questions: [expect.objectContaining({ question: proficiencyWithContext })],
    });

    const shortLanguageCode = 'Do you speak German and zh at C2?';
    const partialShortLanguageCode = guardAgentStep(turn('act', [act({
      ref: 'e36', action: 'select', value: 'Yes', question: shortLanguageCode, answer: 'Yes',
      source: 'profile', evidence: 'German C2',
    })]), {
      answers: {}, profile: { cvText: 'German C2' }, portalQuestionsAnswered: [],
    });
    expect(partialShortLanguageCode).toMatchObject({
      status: 'needs_candidate', actions: [], questions: [expect.objectContaining({ question: shortLanguageCode })],
    });

    const ambiguousLanguageCode = 'Do you speak English and de at C2?';
    const partialAmbiguousLanguageCode = guardAgentStep(turn('act', [act({
      ref: 'e39', action: 'select', value: 'Yes', question: ambiguousLanguageCode, answer: 'Yes',
      source: 'profile', evidence: 'English C2',
    })]), {
      answers: {}, profile: { cvText: 'English C2' }, portalQuestionsAnswered: [],
    });
    expect(partialAmbiguousLanguageCode).toMatchObject({
      status: 'needs_candidate', actions: [], questions: [expect.objectContaining({ question: ambiguousLanguageCode })],
    });

    const atLeastUnknownLanguage = 'What is your German level and at least Xhosa?';
    const partialAtLeastUnknownLanguage = guardAgentStep(turn('act', [act({
      ref: 'e37', action: 'select', value: 'C2', question: atLeastUnknownLanguage, answer: 'C2',
      source: 'profile', evidence: 'German C2',
    })]), {
      answers: {}, profile: { cvText: 'German C2' }, portalQuestionsAnswered: [],
    });
    expect(partialAtLeastUnknownLanguage).toMatchObject({
      status: 'needs_candidate', actions: [], questions: [expect.objectContaining({ question: atLeastUnknownLanguage })],
    });

    const singleLanguageModifiers = 'What is your German level: conversational or professional?';
    const supportedModifierEvidence = guardAgentStep(turn('act', [act({
      ref: 'e33', action: 'select', value: 'C2', question: singleLanguageModifiers, answer: 'C2',
      source: 'profile', evidence: 'German C2',
    })]), {
      answers: {}, profile: { cvText: 'German C2' }, portalQuestionsAnswered: [],
    });
    expect(supportedModifierEvidence).toMatchObject({
      status: 'act', actions: [expect.objectContaining({ value: 'C2' })], questions: [],
    });

    const atLeastSingleLanguage = 'What is your German level: C2 or at least B2?';
    const supportedAtLeastEvidence = guardAgentStep(turn('act', [act({
      ref: 'e38', action: 'select', value: 'C2', question: atLeastSingleLanguage, answer: 'C2',
      source: 'profile', evidence: 'German C2',
    })]), {
      answers: {}, profile: { cvText: 'German C2' }, portalQuestionsAnswered: [],
    });
    expect(supportedAtLeastEvidence).toMatchObject({
      status: 'act', actions: [expect.objectContaining({ value: 'C2' })], questions: [],
    });

    const listed = {
      answers: {},
      profile: { languagesExplicitList: true, languages: [{ language: 'German', level: 'C1' }] },
      portalQuestionsAnswered: [],
    };
    const corrected = guardAgentStep(turn('act', [act({
      ref: 'e11', action: 'click', value: 'No', question, answer: 'No', source: 'widget', evidence: 'Italian C1',
    })]), listed);
    expect(corrected).toMatchObject({ status: 'act', questions: [] });
    expect(corrected.actions).toEqual([expect.objectContaining({ value: 'Yes', answer: 'Yes', source: 'profile' })]);
  });

  it('allows localized widget navigation and asks before a questionless language answer click', async () => {
    const candidate = { answers: {}, profile: {}, portalQuestionsAnswered: [] };
    const navigation = guardAgentStep(turn('act', [act({
      ref: 'e12', action: 'click', value: 'Afficher plus', question: '', context: 'German', answer: '', source: 'widget',
    })]), candidate);
    expect(navigation).toMatchObject({ status: 'act', questions: [] });
    const abilityNavigation = guardAgentStep(turn('act', [act({
      ref: 'e16', action: 'click', value: 'Open options', question: '', context: 'German proficiency', answer: '', source: 'widget',
    })]), candidate);
    expect(abilityNavigation).toMatchObject({ status: 'act', questions: [] });
    expect(refusal(abilityNavigation.actions[0], { name: 'Open options', button: true, tag: 'button', inputType: '', editable: false, inList: false, submits: false, leaves: false })).toBe('');
    expect(refusal(act({
      action: 'click', value: 'Yes', context: 'Language answers', answer: 'Yes',
    }), { name: 'No', button: true, tag: 'button', inputType: '', editable: false, inList: false, submits: false, leaves: false }))
      .toBe('answer_option_mismatch');

    let navigationClicks = 0;
    const navigationLocator = {
      evaluate: async () => ({ name: 'Afficher plus', button: true, tag: 'button', inputType: '', editable: false, inList: false, submits: false, leaves: false }),
      click: async () => { navigationClicks += 1; },
    };
    await expect(runAction({ locator: () => navigationLocator } as any, navigation.actions[0])).resolves.toEqual({ ok: true });
    expect(navigationClicks).toBe(1);

    for (const value of ['Add another language', 'Ajouter une langue', 'Sprache hinzufügen', 'Aggiungi un\'altra lingua']) {
      const addLanguage = guardAgentStep(turn('act', [act({
        ref: 'e17', action: 'click', value, question: '', context: 'Languages', answer: '', source: 'widget',
      })]), candidate);
      expect(addLanguage).toMatchObject({ status: 'act', questions: [] });
      expect(refusal(addLanguage.actions[0], { name: value, button: true, tag: 'button', inputType: '', editable: false, inList: false, submits: false, leaves: false })).toBe('');
    }
    const consentRequiredAdd = act({
      ref: 'e18', action: 'click', value: 'Add another language',
      question: 'Would you like to add another language?', context: 'Languages', answer: '', source: 'widget',
    });
    expect(guardAgentStep(turn('act', [consentRequiredAdd]), candidate)).toMatchObject({
      status: 'needs_candidate', actions: [],
      questions: [expect.objectContaining({ question: 'Would you like to add another language?' })],
    });
    expect(refusal(consentRequiredAdd, { name: 'Add another language', button: true, tag: 'button', inputType: '', editable: false, inList: false, submits: false, leaves: false }))
      .toBe('language_answer_requires_candidate');
    const contextualIntentAdd = act({
      ref: 'e19', action: 'click', value: 'Add another language',
      question: '', context: 'Would you like to add another language?', answer: '', source: 'widget',
    });
    expect(guardAgentStep(turn('act', [contextualIntentAdd]), candidate)).toMatchObject({
      status: 'needs_candidate', actions: [],
      questions: [expect.objectContaining({ question: 'Would you like to add another language?' })],
    });
    expect(refusal(contextualIntentAdd, { name: 'Add another language', button: true, tag: 'button', inputType: '', editable: false, inList: false, submits: false, leaves: false }))
      .toBe('language_answer_requires_candidate');
    const unrecognizedContextIntentAdd = act({
      ref: 'e20', action: 'click', value: 'Add another language',
      question: '', context: 'Can you add another language?', answer: '', source: 'widget',
    });
    expect(guardAgentStep(turn('act', [unrecognizedContextIntentAdd]), candidate)).toMatchObject({
      status: 'needs_candidate', actions: [],
      questions: [expect.objectContaining({ question: 'Can you add another language?' })],
    });
    expect(refusal(unrecognizedContextIntentAdd, { name: 'Add another language', button: true, tag: 'button', inputType: '', editable: false, inList: false, submits: false, leaves: false }))
      .toBe('language_answer_requires_candidate');

    const durationQuestion = 'How long have you spoken German?';
    const durationAnswer = guardAgentStep(turn('act', [act({
      ref: 'e14', action: 'click', value: 'More than 3 years', question: durationQuestion,
      context: 'German proficiency', answer: 'More than 3 years', source: 'widget',
    })]), candidate);
    expect(durationAnswer).toMatchObject({ status: 'needs_candidate', actions: [] });
    expect(refusal(act({
      action: 'click', value: 'More than 3 years', context: 'German language',
    }), { name: 'More than 3 years', button: true, tag: 'button', inputType: '', editable: false, inList: false, submits: false, leaves: false }))
      .toBe('language_answer_requires_candidate');
    expect(refusal(act({
      action: 'click', value: 'Yes', answer: 'Yes',
      question: 'What does the form ask about German, and how should it be answered?', context: 'German',
    }), { name: 'No', button: true, tag: 'button', inputType: '', editable: false, inList: false, submits: false, leaves: false }))
      .toBe('answer_option_mismatch');

    const fallbackQuestion = 'What does the form ask about German language, and how should it be answered?';
    const answeredCandidate = {
      answers: {}, profile: {},
      portalQuestionsAnswered: [{ question: fallbackQuestion, context: 'German language', answer: 'No' }],
    };
    const alreadyAnswered = guardAgentStep(turn('act', [act({
      ref: 'e15', action: 'click', value: 'Yes', question: fallbackQuestion,
      context: 'German language', answer: 'No', source: 'widget',
    })]), answeredCandidate);
    expect(alreadyAnswered).toMatchObject({ status: 'act', questions: [] });
    let mismatchedAnswerClicks = 0;
    const mismatchedAnswerLocator = {
      evaluate: async () => ({ name: 'Yes', button: true, tag: 'button', inputType: '', editable: false, inList: false, submits: false, leaves: false }),
      click: async () => { mismatchedAnswerClicks += 1; },
    };
    await expect(runAction({ locator: () => mismatchedAnswerLocator } as any, alreadyAnswered.actions[0]))
      .resolves.toEqual({ ok: false, error: 'answer_option_mismatch' });
    expect(mismatchedAnswerClicks).toBe(0);

    let answerClicks = 0;
    const answerLocator = {
      evaluate: async () => ({ name: 'Yes', button: true, tag: 'button', inputType: '', editable: false, inList: false, submits: false, leaves: false }),
      click: async () => { answerClicks += 1; },
    };
    const page = {
      url: () => 'https://jobs.example/apply',
      title: async () => 'Apply',
      ariaSnapshot: async () => '- button "Yes" [ref=e13]',
      locator: () => answerLocator,
      waitForTimeout: async () => {},
    };
    const result = await completeWithAgent({
      page: page as any,
      hint: 'no_form_controls',
      candidate,
      candidateLocale: 'en',
      codex: async () => turn('act', [act({
        action: 'click', ref: 'e13', value: 'Yes', question: '', context: 'German language', answer: '', source: 'widget',
      })]),
    });
    expect(result).toMatchObject({
      status: 'needs_candidate',
      questions: [expect.objectContaining({
        question: 'What does the form ask about German language, and how should it be answered?',
        context: 'German language',
      })],
    });
    expect(answerClicks).toBe(0);

    for (const context of ['Languages', 'German and English languages']) {
      const genericLanguageLabel = guardAgentStep(turn('act', [act({
        ref: 'e16', action: 'click', value: 'Yes', question: '', context, answer: '', source: 'widget',
      })]), candidate);
      expect(genericLanguageLabel).toMatchObject({
        status: 'needs_candidate',
        questions: [expect.objectContaining({ context })],
        actions: [],
      });
    }
  });

  // Review of #10707: calling the answer a widget move must not get past the guard.
  it('runs a widget move on a sensitive question only when the page grounded it in the candidate data', () => {
    const empty = { answers: {}, profile: {}, portalQuestionsAnswered: [] };
    const sneaky = guardAgentStep(turn('act', [act({ ref: 'e1', question: 'Geburtsdatum', answer: '', value: '', source: 'widget' })]), empty);
    expect(sneaky).toMatchObject({ status: 'needs_candidate', actions: [] });

    // Grounded in an earlier turn of the same page: the day click on the next snapshot runs.
    const known = { answers: {}, profile: { dateOfBirth: '1990-05-12' }, portalQuestionsAnswered: [] };
    const grounded = new Set<string>();
    guardAgentStep(turn('act', [act({ ref: 'e45', action: 'select', value: '1990', question: 'Geburtsdatum', answer: '1990-05-12', source: 'profile' })]), known, grounded);
    const day = guardAgentStep(turn('act', [act({ ref: 'e238', question: 'Geburtsdatum', source: 'widget' })]), known, grounded);
    expect(day).toMatchObject({ status: 'act', questions: [] });
    expect(day.actions).toHaveLength(1);
  });

  it('grounds an age-threshold answer in the explicit date of birth', () => {
    const candidate = { answers: {}, profile: { dateOfBirth: '13.11.2001' }, portalQuestionsAnswered: [] };
    const question = 'Hai meno di 26 anni?';
    const grounded = guardAgentStep(turn('act', [act({ action: 'select', value: 'Sì', answer: 'Sì', question, source: 'profile' })]), candidate);
    expect(grounded).toMatchObject({ status: 'act', questions: [] });
    expect(grounded.actions).toHaveLength(1);

    const wrong = guardAgentStep(turn('act', [act({ action: 'select', value: 'No', answer: 'No', question, source: 'profile' })]), candidate);
    expect(wrong).toMatchObject({ status: 'needs_candidate', actions: [], questions: [expect.objectContaining({ question })] });
    const absent = guardAgentStep(turn('act', [act({ action: 'select', value: 'Sì', answer: 'Sì', question, source: 'profile' })]), { answers: {}, profile: {}, portalQuestionsAnswered: [] });
    expect(absent).toMatchObject({ status: 'needs_candidate', questions: [expect.objectContaining({ question })] });
  });

  it('grounds a native-language choice from the CV language and contrasting language levels', () => {
    const candidate = {
      answers: {},
      profile: {
        cvLanguage: 'it',
        languages: [{ language: 'Inglese', level: 'Buona conoscenza' }, { language: 'Francese', level: 'Buona conoscenza' }],
      },
      portalQuestionsAnswered: [],
    };
    const question = 'Qual è il livello di italiano scritto?';
    const native = guardAgentStep(turn('act', [act({ action: 'select', value: 'Lingua madre', answer: 'Lingua madre', question, source: 'profile' })]), candidate);
    expect(native).toMatchObject({ status: 'act', questions: [] });
    expect(native.actions).toHaveLength(1);

    const invented = guardAgentStep(turn('act', [act({ action: 'select', value: 'Fluente', answer: 'Fluente', question, source: 'profile' })]), candidate);
    // A wrong non-native level is dropped rather than sent or turned into a
    // new candidate question: the CV-derived native fact is already known.
    expect(invented).toMatchObject({ status: 'done', actions: [], questions: [] });
  });

  it('presses an unusual step button only when its name says next step', () => {
    expect(advanceName('Salva e prosegui')).toBe(true);
    expect(advanceName('Vai al passo successivo')).toBe(true);
    expect(advanceName('Nächste Seite')).toBe(true);
    // Review of #10707: a Cancel, a Back, a sign-in or a final action never.
    for (const name of ['Cancel', 'Indietro', 'Zurück', 'Accedi e continua', 'Invia e continua', 'Weiter zur Bewerbung absenden', 'OK', '']) {
      expect(advanceName(name)).toBe(false);
    }
  });

  it('ends the fallback, not the run, when Codex fails', async () => {
    const page = {
      url: () => 'https://jobs.example/apply',
      title: async () => 'Apply',
      ariaSnapshot: async () => '- button "Choose 12 May 1990" [ref=e1]',
      waitForTimeout: async () => {},
    };
    const result = await completeWithAgent({ page, hint: 'next_disabled', candidate: null, candidateLocale: 'it', codex: async () => { throw new Error('timeout'); } });
    expect(result).toMatchObject({ status: 'stuck', calls: 1 });
    expect(result.reason).toContain('timeout');
  });

  it('never asks again what the candidate answered, even in other words', () => {
    const answered = { answers: {}, profile: {}, portalQuestionsAnswered: [{ question: 'Quando sei nato?', answer: '1990-05-12' }] };
    const asked = guardAgentStep(turn('needs_candidate', [], [{ question: 'Qual è la tua data di nascita?', why: '', type: 'date', options: [] }]), answered);
    // Nothing new to ask: the owner looks instead of a loop of questions.
    expect(asked).toMatchObject({ status: 'stuck', questions: [] });
  });

  it('does not reopen an address question whose wording and id changed', () => {
    const answered = {
      answers: {},
      profile: {},
      portalQuestionsAnswered: [{ question: 'Qual è la tua via e il numero civico?', answer: 'Via Test 1' }],
    };
    const asked = guardAgentStep(turn('needs_candidate', [], [{ question: 'Qual è la via e il numero civico?', why: '', type: 'text', options: [] }]), answered);
    expect(asked).toMatchObject({ status: 'stuck', questions: [] });
  });

  it('does not reopen a late address alias when only its saved portal answer key remains', () => {
    const answered = { answers: { portal_qual_e_la_tua_via_e_il_tuo_numero_civico: 'Via Test 1' }, profile: {}, portalQuestionsAnswered: [] };
    const asked = guardAgentStep(turn('needs_candidate', [], [{ question: 'Qual è la via e il tuo numero civico?', why: '', type: 'text', options: [] }]), answered);
    expect(asked).toMatchObject({ status: 'stuck', questions: [] });
  });

  it('uses deterministic residence facts instead of asking for a CAP or country again', () => {
    const candidate = candidateForForm({
      identity: { name: 'Test Candidate', email: 'test@example.com', phone: '' },
      profile: {
        location: 'Salsomaggiore T. (PR)',
        address: { street: 'Via Test 12', postalCode: '', city: 'Salsomaggiore T. (PR)', country: '' },
      },
      language: 'it',
    });
    const guarded = guardAgentStep(turn('act', [
      act({ ref: 'e1', action: 'fill', value: '00000', question: 'Qual è il tuo CAP di residenza?', answer: '00000', source: 'rule' }),
      act({ ref: 'e2', action: 'select', value: 'Svizzera', question: 'Qual è la tua nazione di residenza?', answer: 'Svizzera', source: 'rule' }),
      act({ ref: 'e3', action: 'fill', value: '99', question: 'House number', answer: '99', source: 'model' }),
    ]), candidate);
    expect(guarded).toMatchObject({ status: 'act', questions: [] });
    expect(guarded.actions.map((action: any) => [action.value, action.source])).toEqual([
      ['43039', 'identity'],
      ['Italia', 'identity'],
      ['12', 'identity'],
    ]);

    const asked = guardAgentStep(turn('needs_candidate', [], [{ question: 'Qual è il tuo CAP di residenza?', why: '', type: 'text', options: [] }]), candidate);
    expect(asked).toMatchObject({ status: 'stuck', questions: [] });
  });

  it('carries the fieldset context into the fallback guard for a bare CAP', () => {
    const candidate = candidateForForm({
      identity: { name: 'Test Candidate', email: 'test@example.com', phone: '' },
      profile: {
        location: 'Salsomaggiore T. (PR)',
        address: { street: 'Via Test 12', postalCode: '', city: 'Salsomaggiore T. (PR)', country: '' },
      },
      language: 'it',
    });
    const context = 'Dati anagrafici · Indirizzo · CAP · Nazione (di residenza)';
    const guarded = guardAgentStep(turn('act', [
      act({ ref: 'e1', action: 'fill', value: '00000', question: 'CAP', context, answer: '00000', source: 'model' }),
    ]), candidate);
    expect(guarded).toMatchObject({ status: 'act', questions: [] });
    expect(guarded.actions).toEqual([expect.objectContaining({ value: '43039', source: 'identity', context })]);
  });

  it('does not reuse the candidate CAP for a bare employer address', () => {
    const candidate = candidateForForm({
      identity: { name: 'Test Candidate', email: 'test@example.com', phone: '' },
      profile: { address: { street: 'Via Test 12', postalCode: '', city: 'Salsomaggiore T. (PR)', country: '' } },
      language: 'it',
    });
    const context = 'Esperienza professionale · Datore di lavoro · Indirizzo · CAP';
    const guarded = guardAgentStep(turn('act', [
      act({ ref: 'e1', action: 'fill', value: '43039', question: 'CAP', context, answer: '43039', source: 'model' }),
    ]), candidate);
    expect(guarded).toMatchObject({ status: 'needs_candidate', actions: [], questions: [expect.objectContaining({ question: 'CAP', context })] });
  });

  it('does not let a saved employer CAP answer a residence question', () => {
    const candidate = { answers: {}, profile: {}, portalQuestionsAnswered: [{ question: 'CAP', context: 'Datore di lavoro · Indirizzo', answer: '9999' }] };
    const context = 'Dati anagrafici · Indirizzo · CAP · Nazione (di residenza)';
    const guarded = guardAgentStep(turn('needs_candidate', [], [{ question: 'CAP', context, why: '', type: 'text', options: [] }]), candidate);
    expect(guarded).toMatchObject({ status: 'needs_candidate', questions: [expect.objectContaining({ question: 'CAP', context })] });
  });

  it('does not let a legacy contextless CAP answer suppress a contextual question', () => {
    const candidate = { answers: {}, profile: {}, portalQuestionsAnswered: [{ question: 'CAP', answer: '9999' }] };
    const context = 'Dati anagrafici · Indirizzo · CAP · Nazione (di residenza)';
    const guarded = guardAgentStep(turn('needs_candidate', [], [{ question: 'CAP', context, why: '', type: 'text', options: [] }]), candidate);
    expect(guarded).toMatchObject({ status: 'needs_candidate', questions: [expect.objectContaining({ question: 'CAP', context })] });
  });

  it('keeps same-topic questions independent when their fieldset contexts differ', () => {
    const firstContext = 'Dati anagrafici · Persona';
    const secondContext = 'Dati anagrafici · Esperienza professionale';
    const candidate = { answers: {}, profile: {}, portalQuestionsAnswered: [{ question: 'Data di nascita', context: firstContext, answer: '12.05.1990' }] };
    const guarded = guardAgentStep(turn('needs_candidate', [], [{ question: 'Data di nascita', context: secondContext, why: '', type: 'date', options: [] }]), candidate);
    expect(guarded).toMatchObject({ status: 'needs_candidate', questions: [expect.objectContaining({ question: 'Data di nascita', context: secondContext })] });
  });

  it('does not carry sensitive grounding from one same-label context to another', () => {
    const firstContext = 'Dati anagrafici · Persona';
    const secondContext = 'Dati anagrafici · Esperienza professionale';
    const candidate = { answers: {}, profile: { dateOfBirth: '1990-05-12' }, portalQuestionsAnswered: [] };
    const guarded = guardAgentStep(turn('act', [
      act({ ref: 'e1', action: 'fill', question: 'Data di nascita', context: firstContext, value: '1990-05-12', answer: '1990-05-12', source: 'profile' }),
      act({ ref: 'e2', action: 'fill', question: 'Data di nascita', context: secondContext, value: '1900-01-01', answer: '1900-01-01', source: 'model' }),
    ]), candidate);
    expect(guarded).toMatchObject({ status: 'needs_candidate', questions: [expect.objectContaining({ question: 'Data di nascita', context: secondContext })] });
    expect(guarded.actions).toEqual([expect.objectContaining({ ref: 'e1', context: firstContext })]);
  });

  it('uses one bounded context key across a refused long-context transition', () => {
    const candidate = { answers: {}, profile: {}, portalQuestionsAnswered: [] };
    const longContext = `Dati anagrafici · ${'x'.repeat(240)}`;
    const first = guardAgentStep(turn('act', [
      act({ ref: 'e1', question: 'Data di nascita', context: longContext, value: '1900-01-01', answer: '1900-01-01', source: 'model' }),
    ]), candidate);
    expect(first.actions).toEqual([]);
    expect(first.questions).toEqual([expect.objectContaining({ context: longContext.slice(0, 240) })]);

    const second = guardAgentStep(turn('act', [
      act({ ref: 'e2', question: 'Data di nascita', context: first.questions[0].context, source: 'widget' }),
    ]), candidate);
    expect(second.actions).toEqual([]);
    expect(second.questions).toEqual([expect.objectContaining({ context: first.questions[0].context })]);
  });

  it('turns an empty act into done and drops malformed refs', () => {
    expect(guardAgentStep(turn('act', [act({ ref: 'button#send' })]), null)).toMatchObject({ status: 'done', actions: [] });
    expect(guardAgentStep({ ...turn('done'), advanceRef: 'e9' }, null).advanceRef).toBe('e9');
    expect(guardAgentStep({ ...turn('done'), advanceRef: '>> css=button' }, null).advanceRef).toBe('');
  });

  it('keeps the final submit, Next, links, passwords and stray keys away from the model', () => {
    const button = { button: true, name: '', submits: false, leaves: false, inList: false, editable: false, tag: 'button', inputType: '' };
    expect(refusal({ action: 'click' }, { ...button, name: 'Invia candidatura' })).toBe('final_submit_reserved');
    expect(refusal({ action: 'click' }, { ...button, name: 'Bewerbung abschließen' })).toBe('final_submit_reserved');
    expect(refusal({ action: 'click' }, { ...button, name: 'Avanti', submits: true })).toBe('final_submit_reserved');
    expect(refusal({ action: 'click' }, { ...button, name: 'Continua' })).toBe('navigation_reserved');
    expect(refusal({ action: 'click' }, { ...button, name: 'Informativa', leaves: true })).toBe('link_reserved');
    expect(refusal({ action: 'click' }, { ...button, name: 'Choose sabato 12 maggio 1990' })).toBe('');
    // A consent box that says "confirm" is ticked like any other: the names are checked on buttons only.
    expect(refusal({ action: 'click' }, { ...button, button: false, tag: 'input', inputType: 'checkbox', name: 'I confirm my data is complete' })).toBe('');
    expect(refusal({ action: 'fill' }, { ...button, button: false, tag: 'input', inputType: 'password', editable: true })).toBe('password_reserved');
    // Enter submits a form from a text box: only inside a list or a combobox.
    expect(refusal({ action: 'press', value: 'Enter' }, { ...button, button: false, tag: 'input', editable: true })).toBe('key_refused');
    expect(refusal({ action: 'press', value: 'Enter' }, { ...button, button: false, tag: 'input', editable: true, inList: true })).toBe('');
    expect(refusal({ action: 'press', value: ' ' }, { ...button, button: false, tag: 'div', inList: true })).toBe('key_refused');
    expect(refusal({ action: 'fill' }, { ...button, button: false, tag: 'div' })).toBe('not_editable');
  });

  it('reads dates in the usual formats and matches them to the candidate data', () => {
    expect([...isoDates('nato il 12.5.1990, o 1990-05-12, o 12/05/1990')]).toEqual(['1990-05-12']);
    const known = knownValuesOf({ answers: { dob: '12.05.1990' }, profile: {}, portalQuestionsAnswered: [] });
    expect(knownAnswer(known, '1990-05-12')).toBe(true);
    expect(knownAnswer(known, '1990-05-13')).toBe(false);
    expect(knownAnswer(known, '')).toBe(false);
    expect(knownAnswer(null, 'anything')).toBe(true);
  });

  it('shares the planner rules, asks in the candidate’s language and uses a strict schema', () => {
    const prompt = agentSystemPrompt('de');
    expect(prompt).toContain('Never press the button that sends the application');
    expect(prompt).toContain('date of birth');
    expect(prompt).toContain('in German');
    expect(planSystemPrompt('it')).toContain('date of birth');
    const strict = (schema: any): boolean => schema.type !== 'object'
      || (schema.additionalProperties === false && Object.keys(schema.properties).every((key) => (schema.required.includes(key) || key === 'context') && strict(schema.properties[key]))
        && Object.values(schema.properties).every((value: any) => value.type !== 'array' || strict(value.items)));
    expect(strict(AGENT_SCHEMA)).toBe(true);
    expect(AGENT_SCHEMA.properties.actions.items.required).not.toContain('context');
    expect(AGENT_SCHEMA.properties.questions.items.required).not.toContain('context');
    const legacy = guardAgentStep(turn('act', [act({ question: 'Data di nascita', source: 'model', answer: '1900-01-01', value: '1900-01-01' })]), { answers: {}, profile: {}, portalQuestionsAnswered: [] });
    expect(legacy.questions).toEqual([expect.objectContaining({ question: 'Data di nascita', context: '' })]);
    const text = agentUserText({ url: 'https://x', title: '', snapshot: '- button "OK" [ref=e1]', candidate: { identity: {} }, hint: 'next_disabled' });
    expect(JSON.parse(text.slice(0, text.indexOf('\n\nPage snapshot:'))).agentPage.hint).toMatch(/disabled/);
  });

  it('compacts the snapshot: no link targets, no bare images, a bounded size', () => {
    const snapshot = ['- link "Home" [ref=e2]:', '  - /url: https://x', '  - img [ref=e3]', '- img "Logo" [ref=e4]', '- button "OK" [ref=e5]'].join('\n');
    expect(compactSnapshot(snapshot)).toBe(['- link "Home" [ref=e2]:', '- img "Logo" [ref=e4]', '- button "OK" [ref=e5]'].join('\n'));
    expect(compactSnapshot('x'.repeat(50), 10)).toBe(`${'x'.repeat(10)}\n… (snapshot truncated)`);
    // Cut at a line end: never an element without its ref.
    expect(compactSnapshot('- button "A" [ref=e1]\n- button "B" [ref=e2]', 30)).toBe('- button "A" [ref=e1]\n… (snapshot truncated)');
  });

  it('strikes a password the runner typed out of the snapshot the model gets', () => {
    const snapshot = '- textbox "Password" [ref=e7]: Xy12abcdefghAa7!\n- button "Submit final application" [ref=e9]';
    expect(withoutSecrets(snapshot, ['Xy12abcdefghAa7!', ''])).toBe('- textbox "Password" [ref=e7]: [password]\n- button "Submit final application" [ref=e9]');
    expect(withoutSecrets(snapshot)).toBe(snapshot);
  });

  it('tells generated names from questions', () => {
    expect(machineLabel('select-input-_r_p_')).toBe(true);
    expect(machineLabel('file:_r_3_:input')).toBe(true);
    expect(machineLabel('')).toBe(true);
    expect(machineLabel('Quando sei nato?')).toBe(false);
    expect(machineLabel('email-address')).toBe(false);
  });

  // The fallback reads the page through Playwright's own snapshot for models (as Playwright MCP does):
  // an upgrade that renames it must fail here, not silently turn the fallback off (dry run 36822777464:
  // 1.63 dropped the private call the first version used).
  it('finds the AI snapshot in the installed Playwright', () => {
    const require = createRequire(import.meta.url);
    // Not among the package's exports: the files themselves, by their path.
    const root = path.dirname(require.resolve('playwright-core/package.json'));
    const types = readFileSync(path.join(root, 'types/types.d.ts'), 'utf8');
    const legacy = path.join(root, 'lib/client/page.js');
    const publicMode = /ariaSnapshot\(options\?: \{[^}]*mode\?: "ai"/.test(types);
    const privateCall = existsSync(legacy) && readFileSync(legacy, 'utf8').includes('async _snapshotForAI(');
    expect(publicMode || privateCall).toBe(true);
  });
});

// Owner decisions of 2026-10-03 (P4, decision 9): on a permit or nationality question the agent's answer must name
// the candidate's own status or nationality as the catalogue words it.
describe('portal agentic fallback: the candidate’s Swiss status and nationality', () => {
  const candidate = (profile: Record<string, any>) => candidateForForm({ identity: { name: 'Giulia Verdi', email: 'c-abc@candidature.frontaliereticino.ch', phone: '' }, profile, language: 'de' });

  it('grounds a permit answer that names the status the candidate chose, asks any other', () => {
    const question = 'Haben Sie eine Arbeitserlaubnis?';
    const grounded = guardAgentStep(turn('act', [act({ ref: 'e7', action: 'select', value: 'Ausweis G', question, answer: 'Ausweis G', source: 'profile' })]), candidate({ permitStatus: 'permit_g' }));
    expect(grounded).toMatchObject({ status: 'act', questions: [] });
    expect(grounded.actions).toHaveLength(1);
    const asked = guardAgentStep(turn('act', [act({ ref: 'e7', action: 'select', value: 'B', question, answer: 'B', source: 'profile' })]), candidate({ permitStatus: 'none' }));
    expect(asked).toMatchObject({ status: 'needs_candidate', actions: [], questions: [expect.objectContaining({ question })] });
  });

  it('grounds a nationality the candidate gave, in the form’s language', () => {
    const question = 'Welche Staatsangehörigkeit haben Sie?';
    const grounded = guardAgentStep(turn('act', [act({ ref: 'e8', action: 'select', value: 'Italien', question, answer: 'Italien', source: 'profile' })]), candidate({ nationality: 'italiana' }));
    expect(grounded).toMatchObject({ status: 'act', questions: [] });
    const other = guardAgentStep(turn('act', [act({ ref: 'e8', action: 'select', value: 'Deutschland', question, answer: 'Deutschland', source: 'profile' })]), candidate({ nationality: 'italiana' }));
    expect(other.status).toBe('needs_candidate');
  });
});
