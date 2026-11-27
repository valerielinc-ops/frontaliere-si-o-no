import { describe, expect, it } from 'vitest';
import { operationalDefaultAnswer, operationalQuestionTopic } from '../functions/src/assistedApplicationOperationalAnswers.js';
import { candidateAnswerForField, guardPlan, ownConsent } from '../scripts/assisted-application/lib/portal/plan.mjs';
import { portalRequirementsFromMissingRequired } from '../scripts/assisted-application/lib/portal/portal.mjs';

// Synthetic. A notice acknowledgement plus the consent to process the data FOR THIS APPLICATION is covered by the
// mandate and answered by the platform, whether the portal shows it as a box or as a Sì/No control; an optional
// purpose (talent pool, marketing, newsletter, retention beyond the application) never is.
const CAPTION = 'Dichiaro di aver letto l’informativa sulla privacy e acconsento al trattamento dei miei dati. *';
const candidate = { profile: {}, answers: {}, identity: {}, portalQuestionsAnswered: [] };
const control = (kind: string, extra = {}) => ({ id: 'f13', kind, label: CAPTION, required: true, section: 'Lavora con noi', ...extra });
const asked = (field: any) => portalRequirementsFromMissingRequired([field], [], { candidate }).questions.map((q: any) => q.id);

describe('mandate-covered privacy acknowledgement is never put to the candidate', () => {
  it.each([
    ['radio', { options: ['Sì', 'No'] }],
    ['select', { options: ['Seleziona', 'Sì', 'No'] }],
    ['select', { options: ['Please select', 'Yes', 'No'] }],
  ])('answers the %s yes/no form of the notice with Sì and applies it to the control', (kind, extra) => {
    const field = control(kind, extra);
    expect(asked(field)).toEqual([]);
    expect(candidateAnswerForField(candidate, field)).toMatchObject({ topic: 'application_privacy_notice', source: 'policy_default' });
    const plan = guardPlan({ actions: [], missingRequired: [] }, [field], candidate);
    expect(plan.actions).toEqual([expect.objectContaining({ fieldId: 'f13', action: 'select', source: 'policy_default' })]);
    expect(plan.missingRequired).toEqual([]);
  });

  it('keeps the box form ticked by the consent path and never asked', () => {
    const field = control('checkbox');
    expect(ownConsent(field)).toBe(true);
    expect(operationalQuestionTopic({ ...field, question: CAPTION })).toBe('application_privacy_notice');
    expect(asked(field)).toEqual([]);
  });

  it('answers the consent «per la candidatura» also when the caption names the personal data', () => {
    const caption = 'Dichiaro di aver letto l’informativa sulla privacy e acconsento al trattamento dei miei dati personali ai fini della candidatura.';
    expect(operationalDefaultAnswer({ id: 'p', type: 'yes_no', question: caption, applicationQuestion: caption, options: ['Sì', 'No'] })?.value).toBe('Sì');
  });
});

describe('optional purposes stay unanswered and never block', () => {
  it.each([
    'Acconsento al trattamento dei miei dati per essere inserito nel talent pool e contattato per future offerte, informativa sulla privacy',
    'Acconsento a ricevere newsletter e offerte; accetto il trattamento dei dati personali per il marketing',
  ])('does not answer «%s»', (label) => {
    const field = { id: 'g', kind: 'radio', label, required: true, options: ['Sì', 'No'] };
    expect(candidateAnswerForField(candidate, field)).toBeNull();
    expect(operationalDefaultAnswer({ ...field, question: label, applicationQuestion: label })).toBeNull();
    // Optional (not required) is never asked at all.
    expect(asked({ ...field, required: false })).toEqual([]);
  });

  it('keeps asking the required consent that goes beyond the application', () => {
    const field = { id: 'g', kind: 'radio', required: true, options: ['Sì', 'No'],
      label: 'Acconsento al trattamento dei miei dati per essere inserito nel talent pool, informativa sulla privacy' };
    expect(asked(field)).toEqual(['portal_privacy_consent']);
  });
});
