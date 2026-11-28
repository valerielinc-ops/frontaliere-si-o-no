import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { LIST_PROMPT_RE, extractFieldsInPage } from '../scripts/assisted-application/lib/portal/fields.mjs';
import { candidateAnswerForField, guardPlan, planPage } from '../scripts/assisted-application/lib/portal/plan.mjs';
import { candidateForForm, emptyRequiredAsQuestions, portalRequirementsFromMissingRequired } from '../scripts/assisted-application/lib/portal/portal.mjs';
import {
  educationLevelRank,
  platformCandidateFacts,
  platformDateOfBirth,
  platformDefaultAnswer,
  platformStudyField,
  platformEducationLevel,
  platformQuestionTopic,
} from '../functions/src/assistedApplicationPlatformDefaults.js';

// The SuccessFactors profile page of order rg82P9MP (Damiani, career55.sapsf.eu /portalcareer, 2026-11-10),
// rebuilt from its decrypted stop report with synthetic values only: the posting's title as the page heading,
// the sections as collapsible panels whose header is a button (no h1-h4), a form named «Job Application
// Form», SAPUI5 picklists as comboboxes owning their listbox. City, State, Zip Code and Major are prefilled by
// the portal as on the real page; Address, Date of Birth and the four picklists are empty.
const JOB_TITLE = 'IT Support & Junior System Administrator';
const picklist = (id: string, caption: string, options: string[], required = true) => `
  <label for="${id}">${caption}</label>
  <input id="${id}" role="combobox" aria-owns="${id}-list" ${required ? 'aria-required="true"' : ''} placeholder="No Selection">
  <div id="${id}-list" role="listbox">${options.map((option) => `<div role="option">${option}</div>`).join('')}</div>`;
const text = (id: string, caption: string, value = '', extra = '') => `
  <label for="${id}">${caption}</label><input id="${id}" type="text" aria-required="true" value="${value}" ${extra}>`;
const SUCCESSFACTORS_PROFILE_PAGE = `<main>
  <div class="header">${picklist('ui-language', 'Language', ['English US (English US)', 'Italiano (Italian)', 'Deutsch (German)'], false)}</div>
  <div class="title"><h1>${JOB_TITLE} (1745)</h1></div>
  <form aria-label="Job Application Form">
    <div role="region" aria-labelledby="panel-profile">
      <button id="panel-profile" type="button">Profile Information</button>
      <p>Please complete your personal information.</p>
      ${text('first', '* First Name', 'Ada')}
      ${text('last', '* Last Name', 'Rossi')}
      ${text('birth', 'Date of Birth', '', 'placeholder="MM/DD/YYYY"')}
      ${text('phone', '* Cell Phone', '+39 333 0000000')}
      ${text('email', '* Email', 'candidate@example.test')}
      ${text('address', '* Address')}
      ${text('city', '* City', 'Como')}
      ${text('state', '* State', 'Lombardia')}
      ${text('zip', '* Zip Code', '22100')}
      ${picklist('country', '* Country', ['No Selection', 'Italy', 'Switzerland', 'Germany', 'France'])}
    </div>
    <div role="region" aria-labelledby="panel-education">
      <button id="panel-education" type="button">Education</button>
      ${picklist('education', '* Education Level', ['No Selection', 'Compulsory School', 'High School Diploma', 'Bachelor Degree', 'Master Degree', 'Doctorate'])}
      ${text('major', '* Major', 'Information technology')}
    </div>
    <div role="region" aria-labelledby="panel-languages">
      <button id="panel-languages" type="button">Language Competencies</button>
      ${picklist('language', '* Language', ['No Selection', 'English', 'French', 'German', 'Italian', 'Spanish'])}
      ${picklist('level', '* Level', ['No Selection', 'Basic', 'Intermediate', 'Fluent', 'Native'])}
    </div>
    <button type="button">Save</button><button type="button">Apply</button>
  </form>
</main>`;

function extract(html: string) {
  const { window } = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { url: 'https://career55.sapsf.eu/portalcareer' });
  Object.defineProperty(window.HTMLElement.prototype, 'innerText', { configurable: true, get() { return this.textContent || ''; } });
  window.Element.prototype.getBoundingClientRect = function rect() {
    return { width: 20, height: 20, top: 0, left: 0, right: 20, bottom: 20, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  };
  vi.stubGlobal('window', window);
  vi.stubGlobal('document', window.document);
  vi.stubGlobal('location', window.location);
  vi.stubGlobal('CSS', { escape: (value: string) => String(value).replace(/["\\\]]/g, '\\$&') });
  const snapshot = extractFieldsInPage({});
  // What extractFields does before planning (readOwnedListOptions): each picklist opened, its options read.
  for (const field of snapshot.fields.filter((item: any) => item.selectLike && item.ownedList)) {
    field.options = [...window.document.querySelectorAll(`[id="${field.ownedList}"] [role="option"]`)]
      .map((option) => String(option.textContent || '').trim()).filter((label) => label && !LIST_PROMPT_RE.test(label))
      .map((label) => ({ value: label, label }));
  }
  return snapshot;
}

afterEach(() => { vi.unstubAllGlobals(); });

import { candidateAnswerForQuestion } from '../scripts/assisted-application/lib/portal/plan.mjs';
import { portalQuestionId } from '../scripts/assisted-application/lib/portal/question-key.mjs';

const byDom = (snapshot: any, domId: string) => snapshot.fields.find((field: any) => field.domId === domId);

// A required field the profile answers is never asked: «Address» from the street, «Major» from the CV's title,
// a free-text language row from the CV's language (order of 2026-11-27: the same question four rounds in a row).
const SOURCE_EDUCATION = [{ degree: 'Laurea in Economia aziendale', institution: 'Universita di esempio', start: '2008', end: '2013' }];
function person({ address, education = SOURCE_EDUCATION, answers = {} }: { address: any; education?: any[]; answers?: any }) {
  const profile = { location: 'Como', address, education, languages: [{ language: 'Italiano', level: 'madrelingua' }, { language: 'Inglese', level: 'B2' }], cvLanguage: 'it' };
  const identity = { name: 'Ada Rossi', email: 'candidate@example.test', phone: '+39 333 0000000', address };
  const platformFacts = platformCandidateFacts({ profile, identity, locale: 'it', seed: 'synthetic-order' });
  return candidateForForm({ identity, profile, answers, language: 'en', job: { title: JOB_TITLE, company: 'Example Group' }, platformFacts });
}
const asked = (snapshot: any, who: any) => {
  const plan = guardPlan({ actions: [], missingRequired: [] }, snapshot.fields, who);
  const requirements: any = portalRequirementsFromMissingRequired(snapshot.fields, plan.missingRequired, { candidate: who });
  return { plan, ids: (requirements.questions || requirements).map((question: any) => question.id) };
};
const base = { postalCode: '22100', city: 'Como', country: 'Italia' };

describe('the address of the profile is never asked (SuccessFactors «* Address», 2026-11-27)', () => {
  for (const street of ['Via Roma 12', 'Via Roma, 12', 'Via Roma', 'Via Roma 12 22100 Como']) {
    it(`fills the single Address field from the street «${street}» and asks nothing`, () => {
      const snapshot = extract(SUCCESSFACTORS_PROFILE_PAGE);
      const who = person({ address: { ...base, street } });
      const { plan, ids } = asked(snapshot, who);
      expect(ids).not.toContain('portal_residence_address');
      expect(plan.actions.find((item: any) => item.fieldId === byDom(snapshot, 'address').id)).toMatchObject({ action: 'fill' });
    });
  }

  it('fills the profile street as stated, never another one', () => {
    const snapshot = extract(SUCCESSFACTORS_PROFILE_PAGE);
    const { plan } = asked(snapshot, person({ address: { ...base, street: 'Via Roma 12' } }));
    expect(plan.actions.find((item: any) => item.fieldId === byDom(snapshot, 'address').id)).toMatchObject({ value: 'Via Roma 12' });
  });

  it('a street of the profile satisfies the requirement builder, separate CAP and town fields keep their own values', () => {
    const snapshot = extract(SUCCESSFACTORS_PROFILE_PAGE);
    const { plan } = asked(snapshot, person({ address: { ...base, street: 'Via Roma 12' } }));
    // City, State and Zip are prefilled by the portal here: nothing of them is planned, nothing asked.
    for (const domId of ['city', 'zip']) expect(plan.actions.find((item: any) => item.fieldId === byDom(snapshot, domId).id)).toBeUndefined();
  });

  it('a profile without an address asks once, and the answer is reused', () => {
    const snapshot = extract(SUCCESSFACTORS_PROFILE_PAGE.replace('value="Como"', 'value=""'));
    const fields = snapshot.fields.filter((field: any) => field.domId === 'address').map((field: any) => ({ ...field, required: true }));
    const who: any = { identity: { name: 'Ada Rossi', address: { city: 'Como' }, location: 'Como' }, profile: { location: 'Como', address: { city: 'Como' } }, answers: {} };
    const requirements: any = portalRequirementsFromMissingRequired(fields, [], { candidate: who });
    expect((requirements.questions || requirements).map((question: any) => question.id)).toEqual(['portal_residence_address']);
    const answered = { ...who, answers: { portal_residence_address: 'Via Roma 12' } };
    const again: any = portalRequirementsFromMissingRequired(fields, [], { candidate: answered });
    expect((again.questions || again).map((question: any) => question.id)).toEqual([]);
  });

  it('a street-and-number pair accepts the candidate\'s own answer without a civic number', () => {
    const pair = { id: 'p1', kind: 'text', label: 'Street and house number', required: true, value: '',
      addressContext: { section: 'Residence', owners: ['Residence'], unknown: false } };
    const who: any = { identity: { name: 'Ada Rossi', address: { city: 'Como', postalCode: '22100', country: 'Italia' } }, profile: { address: { city: 'Como' } }, answers: {} };
    const answered = { ...who, portalQuestionsAnswered: [{ answerId: portalQuestionId(pair), question: pair.label, answer: 'Strada Vicinale del Lago',
      source: 'answers', current: true, context: '', addressContext: pair.addressContext }] };
    expect(candidateAnswerForField(answered, pair)?.value).toBe('Strada Vicinale del Lago');
  });
});

describe('a recorded answer equal to the profile street stays the candidate\'s own answer', () => {
  it('returns «Via Roma» for a street-and-number pair when the profile holds the same street', () => {
    const addressContext = { section: 'Residence', owners: ['Residence'], unknown: false };
    const who: any = { identity: { name: 'Ada Rossi', address: { street: 'Via Roma', city: 'Como', postalCode: '22100', country: 'Italia' } },
      profile: { address: { street: 'Via Roma', city: 'Como' } }, answers: {},
      portalQuestionsAnswered: [{ question: 'Street and house number', answer: 'Via Roma', source: 'answers', current: true, context: '', addressContext }] };
    expect(candidateAnswerForQuestion(who, 'Street and house number', '', { addressContext })).toBe('Via Roma');
  });
});

describe('Major and a free-text language row come from the CV', () => {
  const emptyMajor = (html: string) => html.replace('value="Information technology"', 'value=""');
  it('fills Major with the field of the highest title', () => {
    const snapshot = extract(emptyMajor(SUCCESSFACTORS_PROFILE_PAGE));
    const { plan, ids } = asked(snapshot, person({ address: { ...base, street: 'Via Roma 12' } }));
    expect(plan.actions.find((item: any) => item.fieldId === byDom(snapshot, 'major').id)).toMatchObject({ action: 'fill', value: 'Economia aziendale', source: 'policy_default' });
    expect(ids.some((id: string) => id.startsWith('portal_major'))).toBe(false);
  });

  it('asks Major exactly once when no title states a field, and not again once answered', () => {
    const snapshot = extract(emptyMajor(SUCCESSFACTORS_PROFILE_PAGE));
    const education = [{ degree: 'Diploma di Maturità', institution: 'Istituto tecnico', start: '2008', end: '2013' }];
    const { ids, plan } = asked(snapshot, person({ address: { ...base, street: 'Via Roma 12' }, education }));
    expect(ids.filter((id: string) => id.startsWith('portal_major'))).toHaveLength(1);
    const once = ids.find((id: string) => id.startsWith('portal_major'));
    const major = byDom(snapshot, 'major');
    const recorded = { answerId: once, question: major.label, answer: 'Informatica', source: 'answers', current: true,
      context: major.context || '', section: major.section || '', autocomplete: major.autocomplete || '', addressContext: major.addressContext };
    const withAnswer: any = { ...person({ address: { ...base, street: 'Via Roma 12' }, education }), portalQuestionsAnswered: [recorded] };
    const answered = asked(snapshot, withAnswer);
    expect(answered.ids.some((id: string) => id.startsWith('portal_major'))).toBe(false);
    expect(answered.plan.actions.find((item: any) => item.fieldId === byDom(snapshot, 'major').id)).toMatchObject({ action: 'fill', value: 'Informatica' });
  });

  it('reads the field from the title wording and never guesses between two different fields', () => {
    expect(platformStudyField({ education: [{ degree: 'Bachelor of Science in Computer Engineering' }] })).toBe('Computer Engineering');
    expect(platformStudyField({ education: [{ degree: 'Laurea magistrale in Ingegneria gestionale, Politecnico' }] })).toBe('Ingegneria gestionale');
    expect(platformStudyField({ education: [{ degree: 'Laurea', field: 'Lettere moderne' }] })).toBe('Lettere moderne');
    expect(platformStudyField({ education: [{ degree: 'Laurea in Fisica' }, { degree: 'Laurea in Chimica' }] })).toBe('');
    expect(platformStudyField({ education: [{ degree: 'Laurea in Fisica' }, { degree: 'Laurea' }] })).toBe('');
    expect(platformStudyField({ education: [{ degree: 'Maturita scientifica' }, { degree: 'Laurea in Fisica' }] })).toBe('Fisica');
    // A school diploma that writes its course gives the course; a typographic apostrophe stands for the accent.
    const diploma = (degree: string) => platformStudyField({ education: [{ degree }] });
    expect(diploma('Diploma di Maturita’ analista contabile finanziario')).toBe('analista contabile finanziario');
    expect(diploma("Diploma di Maturità analista contabile finanziario, ITC Esempio, 2013")).toBe('analista contabile finanziario');
    expect(diploma('Diploma di perito informatico')).toBe('informatico');
    expect(diploma('Maturità scientifica')).toBe('scientifica');
    expect(diploma('Diplôme d’ingénieur en génie civil')).toBe('génie civil');
    expect(diploma('Matura (Kanton Zürich), Schwerpunkt Wirtschaft und Recht')).toBe('Wirtschaft und Recht');
    expect(diploma('Bachelor of Arts in Storia')).toBe('Storia');
    // «Maturità» alone, or with only the place and the year, names no field.
    for (const bare of ['Maturità', 'Diploma di maturita’', 'Diploma di Maturità, 2013', 'Maturità conseguita nel 2013']) expect(diploma(bare)).toBe('');
    // «Diploma di …» names a title, not a field.
    expect(platformStudyField({ education: [{ degree: 'Diploma di perito informatico' }, { degree: 'Diploma di maturita' }] })).toBe('');
    expect(platformStudyField({ education: [] })).toBe('');
  });

  it('answers a free-text language row with the CV\'s own language, in the caption\'s language', () => {
    const facts = platformCandidateFacts({ profile: { languages: [{ language: 'Italiano', level: 'madrelingua' }] }, identity: {}, locale: 'it', seed: 's' });
    const row = (label: string) => ({ label, type: 'text', required: true, options: [], context: 'Language Competencies', addressContext: { section: 'Form', owners: ['Language Competencies'], unknown: false } });
    expect(platformDefaultAnswer(row('* Language'), facts)?.value).toBe('Italian');
    expect(platformDefaultAnswer(row('Lingua'), facts)?.value).toBe('Italiano');
    // Outside a competency section a bare text «Language» is not provably a row.
    expect(platformDefaultAnswer({ ...row('Language'), context: 'Contact', addressContext: { section: 'Contact', owners: ['Contact'], unknown: false } }, facts)).toBeNull();
  });
});

describe('Damiani «Major is required» (2026-11-28): a diploma with its course, nothing left silent', () => {
  const emptyMajor = (html: string) => html.replace('value="Information technology"', 'value=""');
  const education = [{ degree: 'Diploma di Maturita’ analista contabile finanziario', institution: '', start: '2008', end: '2013' }];

  it('fills Major from the course written in the diploma and the level from the diploma', () => {
    const snapshot = extract(emptyMajor(SUCCESSFACTORS_PROFILE_PAGE));
    const { plan, ids } = asked(snapshot, person({ address: { ...base, street: 'Via Roma 12' }, education }));
    const action = (domId: string) => plan.actions.find((item: any) => item.fieldId === byDom(snapshot, domId).id);
    expect(action('major')).toMatchObject({ action: 'fill', value: 'analista contabile finanziario', source: 'policy_default' });
    expect(action('education')).toMatchObject({ action: 'select', value: 'High School Diploma' });
    expect(ids.some((id: string) => id.startsWith('portal_major') || id.startsWith('portal_education'))).toBe(false);
  });

  it('with only «Maturità» the empty Major becomes one question, never a missing action', () => {
    const snapshot = extract(emptyMajor(SUCCESSFACTORS_PROFILE_PAGE));
    const { plan, ids } = asked(snapshot, person({ address: { ...base, street: 'Via Roma 12' }, education: [{ degree: 'Diploma di Maturita’' }] }));
    expect(plan.actions.find((item: any) => item.fieldId === byDom(snapshot, 'major').id)).toBeUndefined();
    expect(ids.filter((id: string) => id.startsWith('portal_major'))).toHaveLength(1);
  });

  it('a required field still empty after the fill is turned into a candidate question by the runner recovery', () => {
    const snapshot = extract(emptyMajor(SUCCESSFACTORS_PROFILE_PAGE));
    const major = byDom(snapshot, 'major');
    const items = emptyRequiredAsQuestions([major, { id: 'f9', kind: 'file', label: 'CV' }, { id: 'f10', inputType: 'password', label: 'Password' }]);
    expect(items.map((item: any) => item.fieldId)).toEqual([major.id]);
    const who = person({ address: { ...base, street: 'Via Roma 12' }, education: [{ degree: 'Diploma di Maturita’' }] });
    const requirements: any = portalRequirementsFromMissingRequired(snapshot.fields, items, { candidate: who });
    expect((requirements.questions || requirements).map((question: any) => question.applicationQuestion).filter((label: string) => /major/i.test(label))).toEqual(['* Major']);
  });
});
