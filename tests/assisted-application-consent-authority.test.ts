import { afterEach, describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { extractFieldsInPage } from '../scripts/assisted-application/lib/portal/fields.mjs';
import { ownConsent, guardPlan, candidateAnswerForField } from '../scripts/assisted-application/lib/portal/plan.mjs';
import { isConsentOnly, readOwnConsentMetadata } from '../functions/src/lib/applicationConsent.js';
import { renderConsentControls, renderConsentMetadataInFields } from '../scripts/assisted-application/extension/build-consent-controls.mjs';
import { portalRequirementsFromMissingRequired, localizePortalQuestions, candidateForForm } from '../scripts/assisted-application/lib/portal/portal.mjs';

const open: JSDOM[] = [];
afterEach(() => { for (const dom of open.splice(0)) dom.window.close(); });
function readers(html: string) {
  const dom = new JSDOM(/<form\b/i.test(html) ? html : `<form>${html}</form>`, { url: 'https://jobs.example/apply', runScripts: 'outside-only' });
  open.push(dom);
  const w = dom.window;
  Object.defineProperty(w.HTMLElement.prototype, 'innerText', { get() { return this.textContent || ''; } });
  w.Element.prototype.getBoundingClientRect = () => ({ width: 20, height: 20, top: 0, left: 0, right: 20, bottom: 20, x: 0, y: 0, toJSON() {} });
  (w as any).CSS = { escape: (value: string) => value };
  const source = w.eval(`(${extractFieldsInPage.toString()})()`).fields;
  for (const file of ['apply-control.js', 'runner-fields.js', 'filler.js']) w.eval(readFileSync(new URL(`../scripts/assisted-application/extension/${file}`, import.meta.url), 'utf8'));
  const F = (w as any).CompilaCandidatura;
  expect(JSON.parse(JSON.stringify((w as any).CompilaRunnerFields().fields))).toEqual(JSON.parse(JSON.stringify(source)));
  return { dom, F, source, entries: F.collect(w.document) };
}
const box = (label: string, attrs = '', extra = '') => `<label for="consent">${label}</label><input id="consent" type="checkbox" required ${attrs}>${extra}`;
const positives = [
  'I have read and accept the Privacy Policy.',
  'I accept the Privacy Policy (required)',
  'Ho letto l’informativa privacy e acconsento al trattamento dei dati.',
  'Ich habe die Datenschutzerklärung gelesen und akzeptiere sie.',
  'J’ai lu et j’accepte la politique de confidentialité.',
  'Accetto la memorizzazione elettronica dei miei dati ai sensi delle disposizioni in materia di protezione dei dati.',
  'By clicking I agree you are confirming that you have read the Privacy Policy',
];
describe('native consent authority shared by planner and browser', () => {
  it.each(positives)('keeps pure application privacy and commits its current native checkbox: %s', async label => {
    const { F, source, entries } = readers(box(label));
    expect(ownConsent(source[0])).toBe(true);
    const answer = F.answerFor(entries[0], { answers: [], identity: {} });
    expect(answer).toEqual({ check: true });
    expect(await F.fillEntry(entries[0], answer, {})).toBe(true);
    expect(entries[0].element.checked).toBe(true);
  });
  it.each([
    'I decline the privacy policy', 'I do not agree to the privacy policy',
    'Ich stimme der Datenschutzerklärung nicht zu', 'Je ne consens pas au traitement de mes données',
    'Non accetto l’informativa privacy',
    'I agree to the privacy policy and that I speak fluent German',
    'I agree to the privacy policy and that I can relocate worldwide',
    'I hold a valid work permit and accept the privacy policy',
    'Ho una laurea e accetto l’informativa privacy',
    'Ich habe zehn Jahre Berufserfahrung und akzeptiere die Datenschutzerklärung',
    'Je possède un diplôme et j’accepte la politique de confidentialité',
    'I confirm that all information is accurate and accept the privacy policy',
    'Confermo che le informazioni sono corrette e accetto l’informativa privacy',
    'Ich bestätige die Richtigkeit meiner Angaben und akzeptiere den Datenschutz',
    'Je confirme que les renseignements sont exacts et j’accepte la confidentialité',
    'I agree to the terms and conditions', 'I accept the agency terms and privacy policy',
    'I agree to receive newsletters in accordance with the privacy policy',
  ])('never grants an automatic consent exemption to another assertion: %s', label => {
    const { F, source, entries } = readers(box(label));
    expect(ownConsent(source[0])).toBe(false);
    expect(F.answerFor(entries[0], { answers: [], identity: {} })).toBeNull();
    expect(guardPlan({ actions: [{ fieldId: source[0].id, action: 'check', source: 'consent' }], missingRequired: [] }, source).actions).toEqual([]);
  });
  it.each(['aria-label', 'aria-description', 'title', 'placeholder'])('checks every own %s before default', attribute => {
    const { F, source, entries } = readers(box('I agree to the Privacy Policy', `${attribute}="Newsletter"`));
    expect(ownConsent(source[0])).toBe(false);
    expect(F.answerFor(entries[0], { answers: [] })).toBeNull();
  });
  it.each(['aria-describedby', 'aria-details'])('does not inherit another control through a %s container', attribute => {
    const { F, source, entries } = readers(box('I agree', `${attribute}="shared"`, '<div id="shared"><label for="other">Privacy policy</label></div><input id="other" type="checkbox">'));
    expect(source[0]).toMatchObject({ ownConsentMetadataComplete: false, consentOwnershipUnknown: true, ownConsentText: [] });
    expect(ownConsent(source[0])).toBe(false);
    expect(F.answerFor(entries[0], { answers: [] })).toBeNull();
    expect(portalRequirementsFromMissingRequired(source, [{ fieldId: source[0].id, question: 'I agree' }])).toMatchObject({ questions: [], unreadableFields: [source[0].id] });
  });
  it.each([
    ['missing', 'aria-describedby="missing"', ''],
    ['duplicate', 'aria-describedby="description"', '<p id="description">Privacy</p><p id="description">Newsletter</p>'],
    ['oversize', 'aria-describedby="description"', `<p id="description">${'x'.repeat(8001)}</p>`],
    ['cycle', 'aria-details="description"', '<p id="description" aria-details="description">Privacy</p>'],
  ])('rejects an incomplete whole description: %s', (_name, attrs, html) => {
    const { source, F, entries } = readers(box('I accept the Privacy Policy', attrs, html));
    expect(source[0].ownConsentMetadataComplete).toBe(false);
    expect(source[0].ownConsentText).toEqual([]);
    expect(F.answerFor(entries[0], { answers: [] })).toBeNull();
  });
  it.each(['/marketing-consent', '/work-permit', '/agency-terms', '/unidentified-purpose', '/privacy-employee-monitoring', '/privacy-unidentified-purpose'])('does not authorize a different owned destination: %s', href => {
    const { source, F, entries } = readers(box(`I agree to the <a href="${href}">Privacy Policy</a>`));
    expect(ownConsent(source[0])).toBe(false);
    expect(F.answerFor(entries[0], { answers: [] })).toBeNull();
  });
  it('preserves the real AMAG privacy route without treating career route words as a candidate assertion', () => {
    const { source } = readers(box('Accetto la memorizzazione elettronica dei miei dati ai sensi delle disposizioni in materia di <a href="https://www.example.test/it/Lavoro-e-carriera/domande-sulla-candidatura/informativa-sulla-protezione-dei-dati.html">protezione dei dati</a>.'));
    expect(ownConsent(source[0])).toBe(true);
  });
  it('keeps a privacy link and ignores sibling birth/employer text as consent authority', () => {
    const { source } = readers(box('I agree to the <a href="/privacy-policy">Privacy Policy</a>', '', '<label for="birth">Date of birth</label><input id="birth"><fieldset aria-label="Employer"><input name="employer"></fieldset>'));
    expect(ownConsent(source[0])).toBe(true);
  });
  it.each(['No', false, 0, 'Nein', 'Non'])('preserves a scoped explicit refusal for action and omitted-action paths: %s', answer => {
    const { source, F, entries } = readers(box('I agree to the Privacy Policy'));
    const candidate = { portalQuestionsAnswered: [{ question: source[0].label, answer, source: 'answers' }] };
    for (const actions of [[], [{ fieldId: source[0].id, action: 'check', source: 'consent' }]]) {
      expect(() => guardPlan({ actions, missingRequired: [] }, source, candidate)).toThrowError('native_attested_refusal');
    }
    expect(F.answerFor(entries[0], { answers: [{ question: source[0].label, answer, source: 'answers' }] })).toBeNull();
  });
  it.each(['detached', 'question', 'description', 'owner', 'link'])('rechecks the native owner and entire contract before a click: %s', async change => {
    const { dom, F, entries } = readers(box('I agree to the <a href="/privacy-policy">Privacy Policy</a>'));
    const entry = entries[0], answer = F.answerFor(entry, { answers: [] });
    expect(answer).toEqual({ check: true });
    if (change === 'detached') entry.element.replaceWith(entry.element.cloneNode(true));
    if (change === 'question') dom.window.document.querySelector('label')!.textContent = 'I have a work permit and agree to Privacy';
    if (change === 'description') entry.element.setAttribute('aria-description', 'Newsletter');
    if (change === 'owner') entry.element.name = 'changed-purpose';
    if (change === 'link') dom.window.document.querySelector('a')!.setAttribute('href', '/marketing-consent');
    expect(await F.fillEntry(entry, answer, {})).toBe(false);
    expect(dom.window.document.querySelector('input')!.checked).toBe(false);
  });
  it('stops when a checkbox change handler redraws its assertion during the click, including optional consent', async () => {
    const { F, entries, dom } = readers(box('I agree to the Privacy Policy').replace('required', ''));
    entries[0].element.addEventListener('change', () => { dom.window.document.querySelector('label')!.textContent = 'I hold a work permit and agree to Privacy'; });
    const result = await F.fillPage(dom.window.document, { answers: [] }, { attempts: new WeakMap() });
    expect(result.missing).toEqual([expect.objectContaining({ reason: 'consent_contract_unverified' })]);
    expect(result.filled).toEqual([]);
  });
  it('does not advance on an already checked unknown contract or override a current explicit No', async () => {
    for (const label of ['I hold a work permit and accept privacy', 'I accept the Privacy Policy']) {
      const { F, entries, dom } = readers(box(label, 'checked'));
      const result = await F.fillPage(dom.window.document, { answers: [{ question: label, answer: 'No' }] }, { attempts: new WeakMap() });
      expect(result.missing).toEqual([expect.objectContaining({ reason: 'consent_contract_unverified' })]);
      expect(entries[0].element.checked).toBe(true);
    }
  });
  it('does not let a conflicting legacy Yes suppress a scoped No veto', () => {
    const { source, F, entries } = readers(box('I accept the Privacy Policy'));
    const records = ['Yes', 'No'].map(answer => ({ question: source[0].label, answer, source: 'answers' }));
    expect(() => guardPlan({ actions: [], missingRequired: [] }, source, { portalQuestionsAnswered: records })).toThrowError('native_attested_refusal');
    expect(F.answerFor(entries[0], { answers: records })).toBeNull();
  });
  it('classifies optional pure permission separately without granting a default or hard-fact exemption', () => {
    const { source, F, entries } = readers(box('I agree to receive newsletters'));
    expect(isConsentOnly(source[0])).toBe(true);
    expect(ownConsent(source[0])).toBe(false);
    expect(F.answerFor(entries[0], { answers: [] })).toBeNull();
  });
  it('does not derive authority from a technical name or caller-provided complete=false metadata', () => {
    expect(ownConsent({ kind: 'checkbox', name: 'agbs_check', required: true })).toBe(false);
    const { source } = readers(box('I agree to the Privacy Policy'));
    expect(ownConsent({ ...source[0], consentOwnershipUnknown: true })).toBe(false);
    expect(ownConsent({ ...source[0], ownConsentMetadataComplete: false })).toBe(false);
  });
  it('preserves the opaque original native contract and ownership through candidate localization', async () => {
    const { source } = readers(box('I hold a valid work permit and accept the privacy policy'));
    source[0].originalNativeContract = { kind: 'checkbox', nativeValidation: { required: true }, ownConsentOwnerKey: source[0].ownConsentOwnerKey };
    const dto = portalRequirementsFromMissingRequired(source, [{ fieldId: source[0].id, question: source[0].label }]).questions;
    const localized = await localizePortalQuestions(dto, { candidateLocale: 'it', applicationLocale: 'en' });
    expect(localized[0].originalNativeContract).toEqual(source[0].originalNativeContract);
    expect(localized[0].ownConsentText).toEqual(source[0].ownConsentText);
  });
  it('keeps same-label native assertions independently answerable and stable under DTO input ordering', () => {
    const markup = (id: string, assertion: string) => `<div class="field"><label for="${id}">I agree</label><input id="${id}" type="checkbox" required aria-describedby="${id}-details"><p id="${id}-details">${assertion}</p></div>`;
    const { source } = readers(markup('permit', 'I hold a work permit') + markup('degree', 'I hold a degree'));
    const questions = portalRequirementsFromMissingRequired(source, source.map((field: any) => ({ fieldId: field.id, question: field.label }))).questions;
    expect(questions).toHaveLength(2);
    expect(new Set(questions.map((question: any) => question.id)).size).toBe(2);
    expect(questions.map((question: any) => question.id).every((id: string) => /^portal_native_[a-f0-9]{64}$/.test(id))).toBe(true);
    // Reorder the DTO inputs, without rewriting owners: each assertion keeps its own identity.
    const reordered = portalRequirementsFromMissingRequired([...source].reverse(), [...source].reverse().map((field: any) => ({ fieldId: field.id, question: field.label }))).questions;
    expect(reordered.map((question: any) => question.id)).toEqual(questions.map((question: any) => question.id).reverse());
  });
  it('keeps answers and a No veto attached to their own same-label native question', () => {
    const html = '<div class="field"><label for="a">I agree</label><input id="a" type="checkbox" required aria-describedby="a-description"><p id="a-description">I hold a work permit</p></div>'
      + '<div class="field"><label for="b">I agree</label><input id="b" type="checkbox" required aria-describedby="b-description"><p id="b-description">I hold a degree</p></div>';
    const { source } = readers(html);
    const questions = portalRequirementsFromMissingRequired(source, source.map((field: any) => ({ fieldId: field.id, question: field.label }))).questions;
    const candidate = candidateForForm({ identity: { name: 'Test Candidate' }, portalQuestions: questions,
      answers: { [questions[0].id]: 'Yes', [questions[1].id]: 'No' } });
    expect(candidate.portalQuestionsAnswered).toHaveLength(2);
    expect(candidate.portalQuestionsAnswered.map((item: any) => item.ownConsentOwnerKey)).toEqual(source.map((field: any) => field.ownConsentOwnerKey));
    expect(candidateAnswerForField(candidate, source[0])?.value).toBe('Yes');
    expect(candidateAnswerForField(candidate, source[1])?.value).toBe('No');
    expect(() => guardPlan({ actions: [], missingRequired: [] }, [source[0]], candidate)).not.toThrow();
    expect(() => guardPlan({ actions: [], missingRequired: [] }, [source[1]], candidate)).toThrowError('native_attested_refusal');
  });
  it('takes the native select form owner instead of the styled proxy form and rejects duplicate bindings', () => {
    const markup = '<form id="native-form"><label for="country">Country</label><select id="country" style="display:none"><option value="IT">Italy</option></select></form>'
      + '<form id="proxy-form"><span id="country-button" class="ui-selectmenu-button" role="combobox" aria-owns="country-menu">Please select</span></form>';
    const { source } = readers(markup);
    const field = source.find((item: any) => item.nativeSelectId === 'country');
    expect(field).toBeTruthy();
    expect(field.formId).toBe('native-form');
    const duplicate = readers(markup.replace('</select>', '</select><select id="country" style="display:none"><option>Other</option></select>')).source;
    expect(duplicate.some((item: any) => item.nativeSelectId === 'country')).toBe(false);
    expect(duplicate.some((item: any) => item.nativeContractUnavailable === true)).toBe(true);
  });
  it.each([['Work preferences', 'Personal information', false], ['Personal information', 'Employer', true]])('uses the native provider semantic owner %s instead of proxy %s', (nativeHeading, proxyHeading, expected) => {
    const markup = `<form id="native-form"><h2>${nativeHeading}</h2><label for="city">City</label><select id="city" name="native-city" autocomplete="address-level2" style="display:none"><option value="">---</option><option value="Como">Como</option></select></form>`
      + `<form id="proxy-form"><h2>${proxyHeading}</h2><span id="city-button" class="ui-selectmenu-button" role="combobox" aria-owns="city-menu">Please select</span></form>`;
    const { source, F, entries } = readers(markup);
    const field = source.find((item: any) => item.nativeSelectId === 'city');
    expect(field).toMatchObject({ formId: 'native-form', inputType: 'select', name: 'native-city', autocomplete: 'address-level2', section: nativeHeading });
    expect(field.context).not.toContain(proxyHeading);
    const candidate = candidateForForm({ identity: { name: 'Test Candidate' }, profile: { location: 'Como, Italia', address: { city: 'Como', country: 'Italia' } } });
    expect(Boolean(candidateAnswerForField(candidate, field)?.value)).toBe(expected);
    const entry = entries.find((item: any) => item.nativeSelect);
    expect(Boolean(F.answerFor(entry, { identity: { address: { city: 'Como', country: 'Italia' } }, answers: [] })?.value)).toBe(expected);
  });
  it('distinguishes anonymous controls in the same form without using input values', () => {
    const markup = '<label>I agree to the Privacy Policy<input type="checkbox" required></label>';
    const { source } = readers(markup + markup);
    expect(source).toHaveLength(2);
    expect(source[0].ownConsentOwnerKey).not.toBe(source[1].ownConsentOwnerKey);
    expect(source.every((field: any) => ownConsent(field))).toBe(true);
  });
  it('preserves a full native question beyond300characters and holds oversize text technically', () => {
    const label = 'I agree to the Privacy Policy. '.repeat(12) + 'I hold a degree.';
    const { source } = readers(box(label));
    const question = portalRequirementsFromMissingRequired(source, [{ fieldId: source[0].id, question: label }]).questions[0];
    expect(question.applicationQuestion).toBe(label);
    expect(question.applicationQuestion).toContain('I hold a degree.');
    const unknown = portalRequirementsFromMissingRequired([{ ...source[0], label: 'x'.repeat(8001) }], [{ fieldId: source[0].id, question: label }]);
    expect(unknown).toMatchObject({ questions: [], unreadableFields: [source[0].id] });
  });
  it('reads the native option label property before internal option text, including empty-label fallback', () => {
    const { source } = readers('<label for="source">How did you hear about us?</label><select id="source" required><option value="" label="Please select">internal placeholder</option><option value="web" label="Visible website">Internal code</option><option value="blank" label="">Fallback text</option></select>');
    expect(source[0].options.map((option: any) => option.label)).toEqual(['Please select', 'Visible website', 'Fallback text']);
    expect(source[0].options[0].placeholder).toBe(true);
    const dto = portalRequirementsFromMissingRequired(source, [{ fieldId: source[0].id, question: source[0].label }]).questions[0];
    expect(dto.applicationOptions).toEqual(['Visible website', 'Fallback text']);
  });
  it('generates the same policy and reader into both browser runtimes', () => {
    const apply = readFileSync(new URL('../scripts/assisted-application/extension/apply-control.js', import.meta.url), 'utf8');
    const fields = readFileSync(new URL('../scripts/assisted-application/lib/portal/fields.mjs', import.meta.url), 'utf8');
    expect(renderConsentControls(apply)).toBe(apply);
    expect(renderConsentMetadataInFields(fields)).toBe(fields);
    expect(typeof readOwnConsentMetadata).toBe('function');
  });
});
