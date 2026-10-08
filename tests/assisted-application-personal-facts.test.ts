import { describe, expect, it } from 'vitest';
import {
  SALUTATIONS,
  civilStatusCode,
  civilStatusCodes,
  civilStatusOption,
  civilStatusOptions,
  cvPersonalFacts,
  isCivilStatusField,
  isSalutation,
  personalFieldLabel,
  salutationFor,
  salutationOptions,
} from '../functions/src/lib/personalFacts.js';
import { buildFormAnswers, salutationQuestion } from '../functions/src/assistedApplicationAiDraftCore.js';
import { EDITABLE_FIELDS, candidateWithEdits, fieldView, formAnswersWithEdits, planCandidateEdits } from '../functions/src/assistedApplicationCandidateEdits.js';
import { candidateAnswerForField, guardPlan, planSystemPrompt, questionTopic } from '../scripts/assisted-application/lib/portal/plan.mjs';
import { autoAnswersForPortalQuestions, candidateForForm } from '../scripts/assisted-application/lib/portal/portal.mjs';

// Owner question of 2026-10-08: an order whose CV said «Né le …» and «Marié» was asked «Quelle civilité
// indiquer dans les formulaires de candidature ?». Every CV below is made up.
const CV_FR = ['Karim Exemple', 'Rue de l’Exemple 1, 1000 Lausanne', 'Né le 12 avril 1990', 'Nationalité : suisse', 'Marié', 'Permis de conduire : B', '', 'Vendeur, Magasin Exemple SA, 2019 - 2024', '• Accueil et conseil des clients, y compris dans les cas délicats'].join('\n');

describe('what a CV says of the person in its own words', () => {
  it('reads the gender from the grammar of a birth or of a civil status, and the status itself', () => {
    expect(cvPersonalFacts(CV_FR)).toEqual({ gender: 'm', civilStatus: 'married', civilStatusText: 'Marié' });
    expect(cvPersonalFacts('Née le 3 mars 1988 à Lausanne\nMariée, 2 enfants')).toEqual({ gender: 'f', civilStatus: 'married', civilStatusText: 'Mariée' });
    expect(cvPersonalFacts('Nata a Como il 12.03.1990 | Nubile | Patente B')).toEqual({ gender: 'f', civilStatus: 'single', civilStatusText: 'Nubile' });
    expect(cvPersonalFacts('Dati personali\nNato il 02/05/1985\nStato civile: coniugato')).toEqual({ gender: 'm', civilStatus: 'married', civilStatusText: 'coniugato' });
    expect(cvPersonalFacts('Sposato con due figli')).toMatchObject({ gender: 'm', civilStatus: 'married' });
    expect(cvPersonalFacts('Situation familiale : divorcée, 1 enfant')).toMatchObject({ gender: 'f', civilStatus: 'divorced' });
    expect(cvPersonalFacts('État civil - Veuve')).toMatchObject({ gender: 'f', civilStatus: 'widowed' });
    // Text read from a PDF may hold its accents as combining marks.
    expect(cvPersonalFacts('Né le 12 avril 1990\nMarié')).toMatchObject({ gender: 'm', civilStatus: 'married' });
    // German and English state the status and no gender; an explicit field states the gender.
    expect(cvPersonalFacts('Geboren am 12.03.1990 in Bern\nZivilstand: verheiratet, 2 Kinder')).toEqual({ gender: '', civilStatus: 'married', civilStatusText: 'verheiratet' });
    expect(cvPersonalFacts('Marital status: Single\nDate of birth: 12 March 1990')).toEqual({ gender: '', civilStatus: 'single', civilStatusText: 'Single' });
    expect(cvPersonalFacts('Married with two children')).toMatchObject({ gender: '', civilStatus: 'married' });
    expect(cvPersonalFacts('Ledig')).toMatchObject({ civilStatus: 'single' });
    expect(cvPersonalFacts('Geschlecht: weiblich\nZivilstand: ledig')).toMatchObject({ gender: 'f', civilStatus: 'single' });
    expect(cvPersonalFacts('Sesso: M | Stato civile: Celibe')).toMatchObject({ gender: 'm', civilStatus: 'single' });
    expect(cvPersonalFacts('Gender: Female')).toMatchObject({ gender: 'f', civilStatus: '' });
  });

  it('never guesses: no first name, no trade, no prose, no inclusive form, no two entries that disagree', () => {
    const nothing = { gender: '', civilStatus: '', civilStatusText: '' };
    // A first name, a trade, the posting's own wording, a date of birth with no grammar.
    expect(cvPersonalFacts('Maria Rossi\nInfermiera diplomata\nData di nascita: 12.03.1990\nNazionalità: italiana')).toEqual(nothing);
    expect(cvPersonalFacts('Vendeuse/Vendeur 80-100 %\nInfirmier diplômé\nVendeuse')).toEqual(nothing);
    // «Marie» without its accent is a first name; after the label it is the status.
    expect(cvPersonalFacts('Marie\nDupont')).toEqual(nothing);
    expect(cvPersonalFacts('Etat civil: Marie')).toMatchObject({ gender: 'm', civilStatus: 'married' });
    // Prose is not a personal-data entry.
    expect(cvPersonalFacts('Single point of contact for 40 customers\nAccueil des clients mariés ou célibataires\nHo sposato la causa del cliente')).toEqual(nothing);
    expect(cvPersonalFacts('Projet né de la volonté de moderniser le dépôt\nNée Dupont')).toEqual(nothing);
    // The alliance, in a CV not written in capitals; a personal-data block all in capitals is read.
    expect(cvPersonalFacts('Stage, NATO a Bruxelles, 2019')).toEqual(nothing);
    expect(cvPersonalFacts('NATO A MILANO IL 12/03/1990')).toMatchObject({ gender: 'm' });
    // A form's own inclusive wording gives the status and no gender.
    expect(cvPersonalFacts('Né(e) le 12.03.1990\nMarié(e)')).toEqual({ gender: '', civilStatus: 'married', civilStatusText: 'Marié(e)' });
    expect(cvPersonalFacts('Nato/a il 12.03.1990\nStato civile: Coniugato/a')).toMatchObject({ gender: '', civilStatus: 'married' });
    expect(cvPersonalFacts('Celibe/Nubile')).toMatchObject({ gender: '', civilStatus: 'single' });
    // Two entries that disagree say nothing of what they disagree on.
    expect(cvPersonalFacts('Né le 12.03.1990\nMariée')).toMatchObject({ gender: '', civilStatus: 'married' });
    expect(cvPersonalFacts('Marié\nÉtat civil : divorcé')).toMatchObject({ gender: 'm', civilStatus: '' });
    for (const empty of ['', null, undefined]) expect(cvPersonalFacts(empty as any)).toEqual(nothing);
  });

  it('knows one civil status under its names in four languages, as a portal’s list offers them', () => {
    // Workday's list (Rituals, 2026-10-07).
    const workday = ['Divorced (Switzerland)', 'Married (Switzerland)', 'Partnership Dissolved (Switzerland)', 'Registered Partner (Switzerland)', 'Single (Switzerland)', 'Widowed (Switzerland)'];
    expect(workday.map(civilStatusCode)).toEqual(['divorced', 'married', 'partnership_dissolved', 'partnership', 'single', 'widowed']);
    expect(civilStatusOption(workday, 'Marié')).toBe('Married (Switzerland)');
    expect(civilStatusOption(workday, 'nubile')).toBe('Single (Switzerland)');
    expect(civilStatusOption(workday, 'Séparé')).toBe('');
    expect(civilStatusOption(workday, 'Maria')).toBe('');
    // An option that offers two statuses holds either; two options that hold it are no choice.
    const swiss = ['ledig', 'verheiratet / eingetragene Partnerschaft', 'geschieden / aufgelöste Partnerschaft', 'verwitwet'];
    expect(civilStatusOption(swiss, 'Coniugata')).toBe('verheiratet / eingetragene Partnerschaft');
    expect(civilStatusOption(swiss, 'Divorcé')).toBe('geschieden / aufgelöste Partnerschaft');
    expect(civilStatusOption(['Married', 'Married (civil)'], 'Marié')).toBe('');
    // «Not married» is single; «unverheiratet» holds no «verheiratet».
    for (const label of ['Not married', 'Nicht verheiratet', 'Unverheiratet', 'Non sposato', 'Unmarried', 'Célibataire']) expect(civilStatusCode(label)).toBe('single');
    expect([...civilStatusCodes('Dissolved civil partnership')]).toEqual(['partnership_dissolved']);
    // The lists the review page offers say what they mean, in every language.
    for (const locale of ['it', 'de', 'fr', 'en', 'fr-CH', 'xx']) {
      expect(civilStatusOptions(locale).map(civilStatusCode)).toEqual(['single', 'married', 'divorced', 'widowed', 'separated', 'partnership', 'partnership_dissolved']);
    }
    for (const label of ['What is your Marital Status?', 'Zivilstand', 'Stato civile*', 'État civil', 'Situation familiale', 'Familienstand']) expect(isCivilStatusField(label)).toBe(true);
    for (const label of ['Stato/Provincia', 'State', 'Civilité', 'Status of your work permit', 'Employment status']) expect(isCivilStatusField(label)).toBe(false);
  });

  it('gives a gender its form of address in the candidate’s language', () => {
    expect(['it', 'de', 'fr', 'en'].map((locale) => salutationFor('m', locale))).toEqual(['Signor', 'Herr', 'Monsieur', 'Mr']);
    expect(['it', 'de', 'fr-CH', 'en'].map((locale) => salutationFor('f', locale))).toEqual(['Signora', 'Frau', 'Madame', 'Ms']);
    expect(salutationFor('', 'fr')).toBe('');
    expect(salutationOptions('xx')).toEqual(SALUTATIONS.it);
    for (const text of ['Monsieur', 'Frau', 'Altro', 'Ms']) expect(isSalutation(text)).toBe(true);
    for (const text of ['', 'Dr', 'monsieur le directeur']) expect(isSalutation(text)).toBe(false);
  });
});

describe('what the CV says is not asked again', () => {
  const order = { locale: 'fr', fullName: 'Karim Exemple', email: 'karim.exemple@example.com', phone: '+41 79 000 00 00' };
  const draftOf = (text: string, questions: any[] = []) => ({ profile: { fullName: 'Karim Exemple', nationality: 'suisse' }, factSources: { text }, questions, formAnswers: [] });
  const channel = { type: 'employer_site', applyUrl: 'https://jobs.example/apply/1' };

  it('holds the form of address the CV states as the candidate’s answer, and asks nothing', () => {
    const edited = candidateWithEdits({ order, draft: draftOf(CV_FR), flow: {} });
    expect(edited.personal).toEqual({ salutation: 'Monsieur', civilStatus: 'Marié' });
    expect(edited.answers.salutation).toBe('Monsieur');
    // The civil status stays out of what the letter and the CV are written from.
    expect(JSON.stringify([edited.profile, edited.answers])).not.toContain('Marié');
    expect(salutationQuestion({ channel, questions: [], answers: edited.answers, locale: 'fr' })).toBeNull();
    // A CV that says nothing is asked as before.
    const silent = candidateWithEdits({ order, draft: draftOf('Karim Exemple\nVendeur'), flow: {} });
    expect(silent.personal).toEqual({ salutation: '', civilStatus: '' });
    expect(silent.answers).toEqual({});
    expect(salutationQuestion({ channel, questions: [], answers: silent.answers, locale: 'fr' })).toMatchObject({ id: 'salutation', required: false, options: ['Monsieur', 'Madame', 'Autre'] });
    // In the candidate's language, whatever language the CV is in.
    expect(candidateWithEdits({ order: { ...order, locale: 'it' }, draft: draftOf(CV_FR), flow: {} }).personal.salutation).toBe('Signor');
  });

  it('lets the candidate’s own word win over the CV, and an emptied field stay empty', () => {
    const draft = draftOf(CV_FR);
    expect(candidateWithEdits({ order, draft, flow: { answers: { salutation: 'Madame' } } }).personal.salutation).toBe('Madame');
    expect(candidateWithEdits({ order, draft, flow: { formOverrides: { salutation: 'Autre', civilStatus: 'Divorcé(e)' } } }).personal).toEqual({ salutation: 'Autre', civilStatus: 'Divorcé(e)' });
    const emptied = candidateWithEdits({ order, draft, flow: { formOverrides: { salutation: '', civilStatus: '' } } });
    expect(emptied.personal).toEqual({ salutation: '', civilStatus: '' });
    expect(emptied.answers.salutation || '').toBe('');
  });

  // Review of #12348, its acceptance to the letter: a CV that says «Nata a Roma», both fields sent empty.
  it('accepts an emptied field, saves it empty and reads it empty afterwards, whatever the CV or an older answer says', () => {
    for (const text of ['Giulia Esempio\nNata a Roma il 12.03.1990', 'Giulia Esempio\nNata a Roma il 12.03.1990\nConiugata']) {
      const giulia = { locale: 'it', fullName: 'Giulia Esempio', email: 'giulia.esempio@example.com' };
      const draft = draftOf(text);
      expect(candidateWithEdits({ order: giulia, draft, flow: {} }).personal.salutation).toBe('Signora');
      const plan = planCandidateEdits({ fields: { salutation: '', civilStatus: '' } }, { order: giulia, draft, flow: {}, locale: 'it' });
      expect(plan.errors).toEqual({});
      expect(plan.overrides.salutation).toBe('');
      for (const answers of [{}, { salutation: 'Signora' }]) {
        const next = candidateWithEdits({ order: giulia, draft, flow: { answers, formOverrides: plan.overrides } });
        expect(next.personal).toEqual({ salutation: '', civilStatus: '' });
        expect(next.answers.salutation || '').toBe('');
        expect(formAnswersWithEdits({ order: giulia, draft, flow: { answers, formOverrides: plan.overrides } }).some((field: any) => ['salutation', 'civilStatus'].includes(field.key))).toBe(false);
      }
    }
  });

  it('shows both among the form fields, to be corrected from a list, and only when known', () => {
    const fields = formAnswersWithEdits({ order, draft: draftOf(CV_FR), flow: {} });
    expect(fields.map((field: any) => field.key).slice(0, 2)).toEqual(['salutation', 'firstName']);
    expect(fields.find((field: any) => field.key === 'salutation').value).toBe('Monsieur');
    expect(fields.find((field: any) => field.key === 'civilStatus').value).toBe('Marié');
    const silent = formAnswersWithEdits({ order, draft: draftOf('Karim Exemple'), flow: {} });
    expect(silent.some((field: any) => ['salutation', 'civilStatus'].includes(field.key))).toBe(false);
    expect(buildFormAnswers({ identity: { name: 'Karim Exemple' }, profile: {}, documents: {} }).some((field: any) => ['salutation', 'civilStatus'].includes(field.key))).toBe(false);
    // A closed list in the candidate's language; the CV's own word stays shown and selected.
    const view = (key: string, draft = draftOf(CV_FR)) => fieldView(fields.find((field: any) => field.key === key), { draft, locale: 'fr' });
    expect(view('salutation')).toMatchObject({ editable: true, options: ['Monsieur', 'Madame', 'Autre'] });
    expect(view('civilStatus')).toMatchObject({ editable: true, options: ['Marié', 'Célibataire', 'Marié(e)', 'Divorcé(e)', 'Veuf/Veuve', 'Séparé(e)', 'Partenariat enregistré', 'Partenariat dissous'] });
    // A draft that still asks the question (written before this rule): the answer is changed there.
    const asking = draftOf(CV_FR, [{ id: 'salutation', question: 'Quelle civilité indiquer dans les formulaires de candidature ?', required: false }]);
    expect(view('salutation', asking)).toMatchObject({ editable: false, locked: 'question' });
    expect(Object.keys(EDITABLE_FIELDS)).toEqual(expect.arrayContaining(['salutation', 'civilStatus']));
    // The server names both fields in the candidate's language (the page shows the server's label for a field
    // it has no name of its own for); every other field keeps the label it had.
    const named = (locale: string) => fields.map((field: any) => fieldView(field, { draft: draftOf(CV_FR), locale })).filter((field: any) => ['salutation', 'civilStatus', 'firstName'].includes(field.key)).map((field: any) => field.label);
    expect(named('it')).toEqual(['Appellativo', 'Nome', 'Stato civile']);
    expect(named('de-CH')).toEqual(['Anrede', 'Nome', 'Zivilstand']);
    expect(named('fr')).toEqual(['Civilité', 'Nome', 'État civil']);
    expect(named('en')).toEqual(['Form of address', 'Nome', 'Marital status']);
    expect(personalFieldLabel('toString', 'it')).toBe('');
  });

  it('takes a correction from the list, and nothing else', () => {
    const draft = draftOf(CV_FR);
    const plan = (fields: Record<string, string>) => planCandidateEdits({ fields }, { order, draft, flow: {}, locale: 'fr' });
    expect(plan({ salutation: 'Madame', civilStatus: 'Divorcé(e)' })).toMatchObject({ errors: {}, overrides: { salutation: 'Madame', civilStatus: 'Divorcé(e)' } });
    expect(plan({ salutation: '', civilStatus: '' })).toMatchObject({ errors: {}, overrides: { salutation: '', civilStatus: '' } });
    expect(Object.keys(plan({ salutation: 'Docteur', civilStatus: 'Heureux' }).errors).sort()).toEqual(['civilStatus', 'salutation']);
  });
});

describe('a portal that asks the civil status', () => {
  const identity = { name: 'Karim Exemple', email: 'c-abc@candidature.example', phone: '+41 79 000 00 00' };
  const candidateOf = (personal: any, extra: any = {}) => candidateForForm({ identity, profile: { nationality: 'suisse' }, answers: {}, personal, ...extra });
  const field = { id: 'f1', kind: 'listbox', label: 'What is your Marital Status?*', required: true, options: ['Select One', 'Divorced (Switzerland)', 'Married (Switzerland)', 'Partnership Dissolved (Switzerland)', 'Registered Partner (Switzerland)', 'Single (Switzerland)', 'Widowed (Switzerland)'].map((label) => ({ label })) };
  const select = (value: string, source = 'rule') => ({ actions: [{ fieldId: 'f1', action: 'select', value, document: 'none', source, evidence: '' }], missingRequired: [] });

  it('is one topic under its wordings, and the planner is told where the answer comes from', () => {
    for (const label of ['What is your Marital Status?', 'Qual è il tuo stato civile?', 'Zivilstand*', 'État civil']) expect(questionTopic(label)).toBe('civil_status');
    expect(questionTopic('Stato/Provincia')).not.toBe('civil_status');
    expect(planSystemPrompt('it')).toContain('profile.civilStatus');
    expect(candidateOf({ civilStatus: 'Marié' }).profile.civilStatus).toBe('Marié');
    expect(candidateOf({}).profile.civilStatus).toBe('');
  });

  it('is answered with the option that says what the CV says, whatever the planner chose', () => {
    const married = candidateOf({ civilStatus: 'Marié' });
    expect(candidateAnswerForField(married, field)).toEqual({ value: 'Married (Switzerland)', source: 'profile' });
    // The planner left it to the candidate, chose another status, or chose well: the CV's status goes in.
    for (const plan of [{ actions: [], missingRequired: [{ fieldId: 'f1', question: 'What is your Marital Status?', why: '', type: 'choice', options: [] }] }, select('Single (Switzerland)'), select('Married (Switzerland)', 'profile')]) {
      const guarded = guardPlan(plan, [field], married);
      expect(guarded.missingRequired).toEqual([]);
      expect(guarded.actions).toEqual([expect.objectContaining({ fieldId: 'f1', action: 'select', value: 'Married (Switzerland)' })]);
    }
    // A text field takes the CV's own words: with no list at all, or an empty one (review of #12348, its
    // acceptance to the letter).
    expect(candidateAnswerForField(married, { id: 'f2', kind: 'text', label: 'État civil', required: true })).toEqual({ value: 'Marié', source: 'profile' });
    expect(candidateAnswerForField({ profile: { civilStatus: 'Marié' } }, { label: 'Marital status', type: 'text' })).toEqual({ value: 'Marié', source: 'profile' });
    expect(candidateAnswerForField({ profile: { civilStatus: 'Marié' } }, { id: 'f3', kind: 'text', label: 'Marital status', required: true, options: [] })).toEqual({ value: 'Marié', source: 'profile' });
    expect(guardPlan({ actions: [], missingRequired: [] }, [{ id: 'f3', kind: 'text', label: 'Marital status', required: true }], married).actions).toEqual([expect.objectContaining({ fieldId: 'f3', action: 'fill', value: 'Marié' })]);
  });

  it('is a question for the candidate when the CV does not say, never a planner’s guess', () => {
    const silent = candidateOf({});
    expect(candidateAnswerForField(silent, field)).toBeNull();
    const guarded = guardPlan(select('Single (Switzerland)'), [field], silent);
    expect(guarded.actions).toEqual([]);
    expect(guarded.missingRequired).toEqual([expect.objectContaining({ fieldId: 'f1' })]);
    // An optional one is left alone.
    const optional = guardPlan(select('Single (Switzerland)'), [{ ...field, required: false }], silent);
    expect(optional).toMatchObject({ actions: [], missingRequired: [] });
    // Declining invents nothing, and the candidate's own answer to the question is theirs.
    const declining = { ...field, options: [...field.options, { label: 'Prefer not to say' }] };
    expect(guardPlan(select('Prefer not to say'), [declining], silent).actions).toHaveLength(1);
    const question = { id: 'portal_qual_e_il_tuo_stato_civile', question: 'Qual è il tuo stato civile?', required: true, source: 'portal', options: field.options.slice(1).map((option) => option.label) };
    const answered = candidateForForm({ identity, profile: {}, answers: { [question.id]: 'Single (Switzerland)' }, portalQuestions: [question], personal: {} });
    expect(guardPlan(select('Single (Switzerland)', 'answers'), [field], answered).actions).toEqual([expect.objectContaining({ value: 'Single (Switzerland)' })]);
    // The candidate's answer wins over what the CV says.
    const both = candidateForForm({ identity, profile: {}, answers: { [question.id]: 'Divorced (Switzerland)' }, portalQuestions: [question], personal: { civilStatus: 'Marié' } });
    expect(candidateAnswerForField(both, field)).toEqual({ value: 'Divorced (Switzerland)', source: 'answers' });
    // A question already in the draft is answered from the CV before the send, not held for the candidate.
    expect(autoAnswersForPortalQuestions({ questions: [question], candidate: candidateOf({ civilStatus: 'Marié' }), answers: {} })).toEqual({ [question.id]: 'Married (Switzerland)' });
    expect(autoAnswersForPortalQuestions({ questions: [question], candidate: silent, answers: {} })).toEqual({});
  });
});
