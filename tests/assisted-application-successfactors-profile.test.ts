import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { LIST_PROMPT_RE, extractFieldsInPage } from '../scripts/assisted-application/lib/portal/fields.mjs';
import { candidateAnswerForField, guardPlan, planPage } from '../scripts/assisted-application/lib/portal/plan.mjs';
import { candidateForForm } from '../scripts/assisted-application/lib/portal/portal.mjs';
import {
  educationLevelRank,
  platformCandidateFacts,
  platformDateOfBirth,
  platformDefaultAnswer,
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

/** A synthetic candidate: a CV with a town, a technical school diploma and Italian as its own language. */
function candidate({ education = [{ degree: 'Diploma di perito informatico', institution: 'Istituto tecnico', start: '2008', end: '2013' }] } = {}) {
  const profile = {
    location: 'Como',
    address: { city: 'Como' },
    education,
    experience: [{ role: 'IT support', employer: 'Example SA', start: '2014', end: 'present' }],
    languages: [{ language: 'Inglese', level: 'B2' }],
    cvLanguage: 'it',
  };
  const identity = { name: 'Ada Rossi', email: 'candidate@example.test', phone: '+39 333 0000000' };
  const platformFacts = platformCandidateFacts({ profile, identity, locale: 'it', seed: 'synthetic-order' });
  return candidateForForm({ identity, profile, language: 'en', job: { title: JOB_TITLE, company: 'Example Group' }, platformFacts });
}

const byDom = (snapshot: any, domId: string) => snapshot.fields.find((field: any) => field.domId === domId);

describe('SuccessFactors profile page (Damiani rg82P9MP): everything filled, nothing asked', () => {
  it('reads the page as the stop report did: the posting title above, the candidate\'s profile as owner', () => {
    const snapshot = extract(SUCCESSFACTORS_PROFILE_PAGE);
    expect(byDom(snapshot, 'address')).toMatchObject({
      label: '* Address',
      addressContext: { section: `${JOB_TITLE} (1745)`, owners: ['Profile Information', 'Job Application Form'], unknown: false },
    });
    expect(byDom(snapshot, 'education').addressContext.owners).toEqual(['Education', 'Job Application Form']);
    expect(byDom(snapshot, 'level').addressContext.owners).toEqual(['Language Competencies', 'Job Application Form']);
  });

  it('fills Address, Date of Birth, Country, Education Level, Language and Level from the platform and the CV', () => {
    const snapshot = extract(SUCCESSFACTORS_PROFILE_PAGE);
    const person = candidate();
    const plan = guardPlan({ actions: [], missingRequired: [] }, snapshot.fields, person);
    expect(plan.missingRequired).toEqual([]);
    const action = (domId: string) => plan.actions.find((item: any) => item.fieldId === byDom(snapshot, domId).id);
    // The street of the owner list with a number 1-101, the same for every run of this order.
    expect(action('address')).toMatchObject({ action: 'fill', value: person.platformFacts.address.street });
    expect(action('address').value).toMatch(/^Via [\p{L} IVX]+ (?:[1-9]\d?|10[01])$/u);
    // Born in the year the candidate was 18 at the end of the diploma, in the format the field shows.
    expect(action('birth')).toMatchObject({ action: 'fill', value: '01/01/1995' });
    // The country of the CV's town, as the picklist names it.
    expect(action('country')).toMatchObject({ action: 'select', value: 'Italy' });
    // The CV's highest title of study.
    expect(action('education')).toMatchObject({ action: 'select', value: 'High School Diploma', source: 'policy_default' });
    // One required language row: the CV's own language, the mother tongue.
    expect(action('language')).toMatchObject({ action: 'select', value: 'Italian', source: 'policy_default' });
    expect(action('level')).toMatchObject({ action: 'select', value: 'Native', source: 'policy_default' });
    // The portal's prefilled values stay, and the site's own language selector is never touched.
    for (const domId of ['city', 'state', 'zip', 'major', 'ui-language']) expect(action(domId)).toBeUndefined();
  });

  it('never needs a translation: the page is planned once and nothing reaches the candidate', async () => {
    const snapshot = extract(SUCCESSFACTORS_PROFILE_PAGE);
    const prompts: string[] = [];
    const codex = async ({ prompt }: { prompt: string }) => {
      prompts.push(String(prompt));
      if (String(prompt).includes('You localize questions')) throw new Error('provider unavailable');
      // The planner leaves every empty field to the code, as the real run's planner did.
      return { actions: [], missingRequired: [] };
    };
    const plan = await planPage({ snapshot, candidate: candidate(), candidateLocale: 'it', codex });
    expect(plan.missingRequired).toEqual([]);
    expect(prompts).toHaveLength(1);
    expect(prompts.some((prompt) => prompt.includes('You localize questions'))).toBe(false);
  });

  it('overrides a planner that asks the candidate or picks another title of study', () => {
    const snapshot = extract(SUCCESSFACTORS_PROFILE_PAGE);
    const id = (domId: string) => byDom(snapshot, domId).id;
    const plan = guardPlan({
      actions: [{ fieldId: id('education'), action: 'select', value: 'Master Degree', document: 'none', source: 'profile', evidence: '' }],
      missingRequired: ['address', 'birth', 'country', 'language', 'level'].map((domId) => ({ fieldId: id(domId), question: domId, why: '', type: 'text', options: [] })),
    }, snapshot.fields, candidate());
    expect(plan.missingRequired).toEqual([]);
    expect(plan.actions.find((item: any) => item.fieldId === id('education'))).toMatchObject({ value: 'High School Diploma' });
  });

  it('leaves the education level to the decision engine when the CV names no level', () => {
    const snapshot = extract(SUCCESSFACTORS_PROFILE_PAGE);
    const person = candidate({ education: [{ degree: 'Maintenance and Technical Support', institution: '', start: '2008', end: '2013' }] });
    // The date of birth still comes from the education the CV lists.
    expect(person.platformFacts.dateOfBirth).toBe('1995-01-01');
    const plan = guardPlan({ actions: [], missingRequired: [] }, snapshot.fields, person);
    expect(plan.missingRequired.map((item: any) => item.fieldId)).toEqual([byDom(snapshot, 'education').id]);
  });
});

describe('who owns the address on the profile page', () => {
  it('the candidate\'s profile does, another party never does', () => {
    const person = candidate();
    const address = (section: string, owners: string[]) => ({
      id: 'a', kind: 'text', label: '* Address', required: true, value: '', addressContext: { section, owners, unknown: false },
    });
    // The posting's title above the sections names nobody; «Profile Information» and the application form are the candidate's.
    expect(candidateAnswerForField(person, address(`${JOB_TITLE} (1745)`, ['Profile Information', 'Job Application Form']))?.value)
      .toBe(person.platformFacts.address.street);
    // Another party's section, or an unreadable owner, still keeps the platform street out.
    expect(candidateAnswerForField(person, address('Emergency contact', ['Profile Information']))).toBeNull();
    expect(candidateAnswerForField(person, address(`${JOB_TITLE} (1745)`, ['Employer', 'Job Application Form']))).toBeNull();
    expect(candidateAnswerForField(person, { ...address('', []), addressContext: { section: '', owners: [], unknown: true } })).toBeNull();
  });
});

describe('platform rules of the profile page', () => {
  it('ranks titles of study and portal options alike', () => {
    expect(educationLevelRank('Dottorato di ricerca')).toBe(6);
    expect(educationLevelRank("Master's Degree")).toBe(5);
    expect(educationLevelRank('Laurea magistrale in ingegneria')).toBe(5);
    expect(educationLevelRank('Bachelor Degree')).toBe(4);
    expect(educationLevelRank('Diploma di laurea')).toBe(4);
    expect(educationLevelRank('Associate degree')).toBe(3);
    expect(educationLevelRank('High School Diploma')).toBe(2);
    expect(educationLevelRank('Lower secondary school')).toBe(1);
    expect(educationLevelRank('Maintenance and Technical Support')).toBeNull();
    // The highest of the CV, whatever its order.
    expect(platformEducationLevel({ education: [{ degree: 'Diploma di maturità' }, { degree: 'Bachelor in informatica' }] })).toBe(4);
  });

  it('chooses the candidate\'s level, else the highest below it, never above', () => {
    const facts = platformCandidateFacts({ profile: { education: [{ degree: 'Master in economia', start: '2010', end: '2015' }] }, seed: 's' });
    const field = (options: string[]) => ({ label: 'Highest level of education', type: 'choice', required: true, options });
    expect(platformDefaultAnswer(field(['High School', 'Bachelor', 'Master', 'PhD']), facts)?.value).toBe('Master');
    expect(platformDefaultAnswer(field(['High School', 'Bachelor', 'PhD']), facts)?.value).toBe('Bachelor');
    expect(platformDefaultAnswer(field(['PhD', 'Postdoc doctorate']), facts)).toBeNull();
    // A list of schools is no level.
    expect(platformQuestionTopic(field(['Liceo Volta', 'Liceo Manzoni']))).toBeNull();
  });

  it('answers a language row only when the application requires it', () => {
    const facts = platformCandidateFacts({ profile: { languages: [{ language: 'Deutsch', level: 'C1' }, { language: 'English', level: 'B2' }] }, seed: 's' });
    const scope = { context: 'Language Competencies · * Language · * Level' };
    const name = { ...scope, label: '* Language', type: 'choice', required: true, options: ['English', 'German', 'Italian'] };
    const level = { ...scope, label: '* Level', type: 'choice', required: true, options: ['Basic', 'Intermediate', 'Fluent', 'Native'] };
    expect(platformDefaultAnswer(name, facts)?.value).toBe('German');
    expect(platformDefaultAnswer(level, facts)?.value).toBe('Fluent');
    expect(platformDefaultAnswer({ ...name, required: false }, facts)).toBeNull();
    expect(platformDefaultAnswer({ ...name, context: 'Website language' }, facts)).toBeNull();
    expect(platformDefaultAnswer({ ...level, context: 'Seniority' }, facts)).toBeNull();
  });

  it('estimates the date of birth from the education the CV lists, and writes it as the field shows', () => {
    expect(platformDateOfBirth({ education: [{ degree: 'Maintenance and Technical Support', end: '2013' }] })).toEqual({ value: '1995-01-01', estimated: true });
    expect(platformDateOfBirth({ education: [{ degree: 'Diploma di perito', institution: 'ITIS Fermi', end: '2012' }, { degree: 'Corso serale', end: '2020' }] }))
      .toEqual({ value: '1994-01-01', estimated: true });
    expect(platformDateOfBirth({ education: [] })).toBeNull();
    const facts = { ...platformCandidateFacts({ seed: 's' }), dateOfBirth: '1990-07-04' };
    expect(platformDefaultAnswer({ label: 'Date of Birth', type: 'text', placeholder: 'MM/DD/YYYY' }, facts, { locale: 'en' })?.value).toBe('07/04/1990');
    expect(platformDefaultAnswer({ label: 'Date of Birth', type: 'text' }, facts, { locale: 'en' })?.value).toBe('04/07/1990');
  });
});
