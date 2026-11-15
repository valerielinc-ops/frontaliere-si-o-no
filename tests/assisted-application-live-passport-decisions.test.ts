import { describe, expect, it } from 'vitest';
import { platformCandidateFacts } from '../functions/src/assistedApplicationPlatformDefaults.js';
import { operationalDefaultAnswer } from '../functions/src/assistedApplicationOperationalAnswers.js';
import {
  decideLiveQuestions,
  platformFactsAfterLiveDecisions,
} from '../scripts/assisted-application/lib/decision-answers.mjs';

const cvText = 'Cloud engineer with experience operating customer databases and container platforms.';
const combinedPassport = {
  id: 'passport_binary_live',
  source: 'portal',
  question: 'Do you hold a Swiss/EU/EFTA passport?',
  type: 'yes_no',
  options: [],
};
const passportType = {
  id: 'passport_type_live',
  source: 'portal',
  question: 'Type of valid passport',
  type: 'choice',
  options: ['Swiss', 'EU/EFTA', 'Other'],
};
const yesDecision = (id: string) => ({
  id,
  decision: 'answer',
  value: 'yes',
  principle: 'plausible_deduction',
  category: '',
  reason: 'Supported by the verified application context.',
});

describe('live passport decisions use the shared passport fact', () => {
  it('combines a verified yes with a foreign permit and never asks the model for passport type', async () => {
    const facts = platformCandidateFacts({
      order: { candidateFacts: { workPermit: 'permit_g' } },
      locale: 'en',
    });
    const prompts: string[] = [];
    const codex = async ({ prompt }: { prompt: string }) => {
      prompts.push(prompt);
      return { decisions: [yesDecision(combinedPassport.id)] };
    };

    const engine = await decideLiveQuestions({
      questions: [combinedPassport, passportType], candidate: { platformFacts: facts }, codex, cvText,
    });

    expect(engine.ids).toEqual([combinedPassport.id]);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain(combinedPassport.id);
    expect(prompts[0]).not.toContain(passportType.id);
    const resolved = platformFactsAfterLiveDecisions(facts, [combinedPassport, passportType], engine.decided);
    expect(resolved).toMatchObject({ passport: 'eu_efta', passportSource: 'deduced' });
    expect(operationalDefaultAnswer(passportType, { facts: resolved })?.value).toBe('EU/EFTA');
  });

  it('keeps passport type unknown when a live yes has no foreign-permit basis', async () => {
    const facts = platformCandidateFacts({ locale: 'en' });
    const codex = async () => ({ decisions: [yesDecision(combinedPassport.id)] });

    const engine = await decideLiveQuestions({
      questions: [combinedPassport, passportType], candidate: { platformFacts: facts }, codex, cvText,
    });

    expect(engine.ids).toEqual([combinedPassport.id]);
    const resolved = platformFactsAfterLiveDecisions(facts, [combinedPassport, passportType], engine.decided);
    expect(resolved).toMatchObject({ passport: '', passportSource: '' });
    expect(operationalDefaultAnswer(passportType, { facts: resolved })).toBeNull();
  });
});
