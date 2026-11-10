import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { LIST_PROMPT_RE, extractFieldsInPage } from '../scripts/assisted-application/lib/portal/fields.mjs';
import { guardPlan } from '../scripts/assisted-application/lib/portal/plan.mjs';
import { candidateForForm, successFactorsDocumentSlotKind, uploadButtonCandidatesFor } from '../scripts/assisted-application/lib/portal/portal.mjs';
import { platformCandidateFacts, platformDefaultAnswer } from '../functions/src/assistedApplicationPlatformDefaults.js';

// Two SuccessFactors tenants of 2026-11-10, rebuilt from their decrypted stop reports with synthetic values:
// Stellenportal Bund (order eHSYErA1, career74 /portalcareer) and Helsana (order s2Tbwwjd). The document slots are
// SuccessFactors' one-button tiles «<caption> <action> Öffnet ein Dialogfeld».
const JOB_TITLE = 'Application Manager/-in';
const picklist = (id: string, caption: string, options: string[], required = true) => `
  <label for="${id}">${caption}</label>
  <input id="${id}" role="combobox" aria-owns="${id}-list" ${required ? 'aria-required="true"' : ''} placeholder="Keine Auswahl">
  <div id="${id}-list" role="listbox">${['Keine Auswahl', ...options].map((option) => `<div role="option">${option}</div>`).join('')}</div>`;
const text = (id: string, caption: string, value = '', required = true) => `
  <label for="${id}">${caption}</label><input id="${id}" type="text" ${required ? 'aria-required="true"' : ''} value="${value}">`;
const radio = (name: string, caption: string) => `
  <fieldset><legend>${caption}</legend>
    <input type="radio" id="${name}-ja" name="${name}" value="ja" required><label for="${name}-ja">Ja</label>
    <input type="radio" id="${name}-nein" name="${name}" value="nein" required><label for="${name}-nein">Nein</label>
  </fieldset>`;
const slot = (caption: string, action: string) => `<button type="button"><span>${caption}</span> <span>${action}</span> <span class="sr">Öffnet ein Dialogfeld</span></button>`;
const LANGUAGES = ['Deutsch', 'Französisch', 'Italienisch', 'Rätoromanisch', 'Englisch', 'Andere'];
const BUND_PAGE = `<main>
  <div class="title"><h1>${JOB_TITLE} (20604)</h1></div>
  <form aria-label="Stellenbewerbungsformular">
    <div role="region" aria-labelledby="panel-documents">
      <button id="panel-documents" type="button">Meine Dokumente</button>
      ${slot('* Lebenslauf', 'Lebenslauf hinzufügen')}
      ${slot('Motivationsschreiben', 'Motivationsschreiben hinzufügen')}
      ${slot('Zeugnisse, Diplome und weitere Dokumente', 'Dokument hinzufügen')}
    </div>
    <div role="region" aria-labelledby="panel-profile">
      <button id="panel-profile" type="button">Meine persönlichen Informationen</button>
      ${picklist('anrede', '* Anrede', ['Frau', 'Herr'])}
      ${text('first', '* Vorname', 'Ada')}
      ${text('last', '* Nachname', 'Rossi')}
      ${text('email', '* E-Mail-Adresse', 'candidate@example.test')}
      ${text('birth', 'Geburtsdatum', '01.01.1990', false)}
      ${text('street', '* Strasse / Nr.')}
      ${text('zip', '* Postleitzahl')}
      ${text('city', '* Ort')}
      ${picklist('country', '* Land', ['Schweiz', 'Italien', 'Deutschland', 'Frankreich'])}
      ${text('phone', '* Telefon', '+39 333 0000000')}
      ${picklist('first-language', '* Erstsprache', LANGUAGES)}
      ${picklist('second-language', 'Zweitsprache (bei Mehrsprachigkeit)', LANGUAGES, false)}
      ${picklist('correspondence', '* Korrespondenzsprache', ['Deutsch', 'Französisch', 'Italienisch'])}
      ${picklist('canton', 'Herkunftskanton', ['Bern', 'Tessin', 'Zürich'], false)}
    </div>
    <div role="region" aria-labelledby="panel-job">
      <button id="panel-job" type="button">Stellenspezifische Informationen</button>
      ${picklist('referral', '* Wie haben Sie von dieser Stelle erfahren?', ['Stellenportal Bund', 'Internet/Stellenportal', 'Zeitung', 'Soziale Medien', 'Empfehlung'])}
      ${radio('rs', '* Haben Sie die Rekrutenschule (RS) der Schweizer Armee absolviert?')}
      ${radio('uo', '* Haben Sie eine Unteroffiziers- oder Offiziersschule der Schweizer Armee absolviert?')}
    </div>
    <button type="button">Speichern</button><button type="button">Bewerben</button>
  </form>
</main>`;

function extract(html: string) {
  const { window } = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { url: 'https://career74.sapsf.eu/portalcareer' });
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

/** A synthetic candidate: a CV in Italian with a town, German at B2, and the upload answers of an EU citizen. */
function candidate({ candidateFacts = { workPermit: 'permit_g', passport: 'eu_efta', nationality: 'Italia' } as any } = {}) {
  const profile = {
    location: 'Como', address: { city: 'Como' },
    education: [{ degree: 'Laurea magistrale in economia', institution: 'Università', start: '2008', end: '2013' }],
    languages: [{ language: 'Deutsch', level: 'B2' }, { language: 'English', level: 'C1' }],
    cvLanguage: 'it',
  };
  const identity = { name: 'Ada Rossi', email: 'candidate@example.test', phone: '+39 333 0000000' };
  const platformFacts = platformCandidateFacts({ order: { candidateFacts }, profile, identity, locale: 'it', seed: 'synthetic-order' });
  return candidateForForm({ identity, profile, language: 'de', job: { title: JOB_TITLE, company: 'Bundesverwaltung' }, platformFacts });
}

const byDom = (snapshot: any, domId: string) => snapshot.fields.find((field: any) => field.domId === domId);
const byName = (snapshot: any, name: string) => snapshot.fields.find((field: any) => field.name === name);

describe('Stellenportal Bund (eHSYErA1): everything filled, nothing asked', () => {
  it('fills the profile and the job questions even when the planner proposed its own address', () => {
    const snapshot = extract(BUND_PAGE);
    expect(byDom(snapshot, 'street').addressContext.owners).toEqual(['Meine persönlichen Informationen', 'Stellenbewerbungsformular']);
    const person = candidate();
    // The real run's failure: a planner value on the address made guardPlan reject the field, and the platform
    // address (which the facts held) never reached it.
    const planned = ['street', 'zip', 'city'].map((domId) => ({
      fieldId: byDom(snapshot, domId).id, action: 'fill', value: 'Bahnhofstrasse 1', document: 'none', source: 'profile', evidence: '',
    }));
    const plan = guardPlan({ actions: planned, missingRequired: [] }, snapshot.fields, person);
    expect(plan.missingRequired).toEqual([]);
    const value = (field: any) => plan.actions.find((item: any) => item.fieldId === field.id)?.value;
    expect(value(byDom(snapshot, 'street'))).toBe(person.platformFacts.address.street);
    expect(value(byDom(snapshot, 'zip'))).toBe('22100');
    expect(value(byDom(snapshot, 'city'))).toBe('Como');
    expect(value(byDom(snapshot, 'country'))).toBe('Italien');
    expect(value(byDom(snapshot, 'anrede'))).toBe('Frau');
    // The CV's own language is the mother tongue; the correspondence in it, since the list offers it.
    expect(value(byDom(snapshot, 'first-language'))).toBe('Italienisch');
    expect(value(byDom(snapshot, 'correspondence'))).toBe('Italienisch');
    // A job board that is also the internet: ours, not the employer's own portal.
    expect(value(byDom(snapshot, 'referral'))).toBe('Internet/Stellenportal');
    // Only a Swiss citizen serves in the Swiss Army: an EU citizen has attended neither school.
    expect(value(byName(snapshot, 'rs'))).toBe('Nein');
    expect(value(byName(snapshot, 'uo'))).toBe('Nein');
    // The optional fields stay as the portal has them.
    for (const domId of ['second-language', 'canton', 'birth']) expect(value(byDom(snapshot, domId))).toBeUndefined();
  });

  it('leaves the Swiss Army to the decision engine for a Swiss or an unknown nationality', () => {
    const snapshot = extract(BUND_PAGE);
    const rs = byName(snapshot, 'rs');
    for (const facts of [{ workPermit: 'swiss', passport: 'swiss', nationality: 'Svizzera' }, null]) {
      const plan = guardPlan({ actions: [], missingRequired: [] }, snapshot.fields, candidate({ candidateFacts: facts }));
      expect(plan.missingRequired.map((item: any) => item.fieldId)).toContain(rs.id);
    }
  });

  it('writes the correspondence language by the documented order', () => {
    const question = { label: '* Korrespondenzsprache', type: 'choice', required: true, options: ['Deutsch', 'Französisch', 'Italienisch'] };
    const facts = (languages: any[], applicationLanguage = 'de') => ({ ...platformCandidateFacts({ seed: 's' }), languages, applicationLanguage });
    // 1. The mother tongue, when offered.
    expect(platformDefaultAnswer(question, facts([{ code: 'it', level: 'native' }, { code: 'de', level: 'B2' }]))?.value).toBe('Italienisch');
    // 2. Else the posting's language, when the CV lists it.
    expect(platformDefaultAnswer(question, facts([{ code: 'en', level: 'native' }, { code: 'fr', level: 'C2' }, { code: 'de', level: 'A2' }]))?.value).toBe('Deutsch');
    // 3. Else the CV's strongest language among those offered.
    expect(platformDefaultAnswer(question, facts([{ code: 'en', level: 'native' }, { code: 'it', level: 'C2' }, { code: 'fr', level: 'B2' }]))?.value).toBe('Italienisch');
    // 4. Else the posting's language.
    expect(platformDefaultAnswer(question, facts([{ code: 'es', level: 'native' }]))?.value).toBe('Deutsch');
  });

  it('names a mother tongue the list lacks «Andere», never another language', () => {
    const question = { label: '* Erstsprache', type: 'choice', required: true, options: LANGUAGES };
    const facts = { ...platformCandidateFacts({ seed: 's' }), languages: [{ code: 'es', level: 'native' }, { code: 'de', level: 'C1' }] };
    expect(platformDefaultAnswer(question, facts)?.value).toBe('Andere');
    expect(platformDefaultAnswer({ ...question, options: ['Deutsch', 'Französisch', 'Italienisch'] }, facts)).toBeNull();
  });
});

describe('SuccessFactors document slots take the CV (Helsana s2Tbwwjd, Bund eHSYErA1)', () => {
  const buttons = (texts: string[]) => ({ buttons: texts.map((text, index) => ({ id: `b${index}`, text, frame: 0 })), fields: [] });

  it('finds the CV slot whatever its action says', () => {
    const helsana = buttons([
      'Meine Dokumente',
      '* Lebenslauf - Zeugnisse - Diplome Lebenslauf Öffnet ein Dialogfeld',
      'Zusätzliche Dokumente Dokument hinzufügen Öffnet ein Dialogfeld',
      'Profilinformationen',
    ]);
    expect(uploadButtonCandidatesFor(helsana, 'cv').map((button: any) => button.text))
      .toEqual(['* Lebenslauf - Zeugnisse - Diplome Lebenslauf Öffnet ein Dialogfeld']);
    const bund = buttons([
      '* Lebenslauf Lebenslauf hinzufügen Öffnet ein Dialogfeld',
      'Motivationsschreiben Motivationsschreiben hinzufügen Öffnet ein Dialogfeld',
      'Zeugnisse, Diplome und weitere Dokumente Dokument hinzufügen Öffnet ein Dialogfeld',
    ]);
    expect(uploadButtonCandidatesFor(bund, 'cv').map((button: any) => button.text)).toEqual(['* Lebenslauf Lebenslauf hinzufügen Öffnet ein Dialogfeld']);
    expect(uploadButtonCandidatesFor(bund, 'cover_letter').map((button: any) => button.text))
      .toEqual(['Motivationsschreiben Motivationsschreiben hinzufügen Öffnet ein Dialogfeld']);
  });

  it('reads the slot from the extracted page, and never a slot that already holds a document', () => {
    const snapshot = extract(BUND_PAGE);
    expect(uploadButtonCandidatesFor(snapshot, 'cv').map((button: any) => button.text.replace(/\s+/g, ' ').trim()))
      .toEqual(['* Lebenslauf Lebenslauf hinzufügen Öffnet ein Dialogfeld']);
    expect(successFactorsDocumentSlotKind({ text: '* Curriculum Vitae Edit document cv.pdf (11/10/2026) Opens a dialog' })).toBe('');
    expect(successFactorsDocumentSlotKind({ text: 'Other attachments Add a Document Opens a dialog' })).toBe('');
    expect(successFactorsDocumentSlotKind({ text: 'Lebenslauf und Motivationsschreiben Öffnet ein Dialogfeld' })).toBe('');
    expect(successFactorsDocumentSlotKind({ text: 'Lebenslauf hinzufügen' })).toBe('');
  });
});
