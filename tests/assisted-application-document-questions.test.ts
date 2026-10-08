// functions/src/lib/documentQuestions.js: a question that only asks whether the candidate holds a document the
// same application has them upload. Owner decision of 2026-10-08, on an order held twice for one requirement:
// the question is not asked, and where a portal's form asks it the attached document says «yes».
// Every example here is invented.
import { describe, expect, it } from 'vitest';
import { documentsHeldAsked, yesOption } from '../functions/src/lib/documentQuestions.js';
import { matchSystemPrompt, matchUserText } from '../functions/src/assistedApplicationAiPrompts.js';
import { attachedDocumentYes, candidateRules, guardPlan } from '../scripts/assisted-application/lib/portal/plan.mjs';
import { candidateForForm } from '../scripts/assisted-application/lib/portal/portal.mjs';

const card = { id: 'card', label: 'carte de qualification de conducteur (OACP)', keywords: ['OACP', 'carta di qualificazione del conducente', 'Fahrerqualifizierungsnachweis', 'driver qualification card'] };
const licence = { id: 'licence', label: 'permis de conduire', keywords: ['patente di guida', 'Führerausweis', 'driving licence'] };
const reports = { id: 'reports', label: 'Bulletins scolaires', keywords: ['pagelle', 'Schulzeugnisse', 'school reports'] };
const documents = [card, licence, reports];
const held = (question: string, type = 'yes_no', options: string[] = []) => documentsHeldAsked({ question, type, options }, documents).map((document: any) => document.id);

describe('a question that only asks whether the candidate holds a document they upload', () => {
  it('is recognised in the four languages, by the document\'s label or one of its keywords', () => {
    expect(held('Possédez-vous une carte de qualification de conducteur (OACP) à jour ?')).toEqual(['card']);
    expect(held('Possiedi una carta di qualificazione del conducente aggiornata?')).toEqual(['card']);
    expect(held('Verfügen Sie über einen gültigen Fahrerqualifizierungsnachweis?')).toEqual(['card']);
    expect(held('Sei in possesso della patente di guida?')).toEqual(['licence']);
    // A choice whose options are yes and no is the same question.
    expect(held('Do you hold a valid driver qualification card?', 'choice', ['Yes', 'No'])).toEqual(['card']);
    // Two documents joined by «and»: both named, both uploaded.
    expect(held('Sei in possesso della patente di guida e della carta di qualificazione del conducente?')).toEqual(['card', 'licence']);
  });

  it('is not one that asks more than the document shows, nor one about another document', () => {
    // A category, a grade: only the candidate can say.
    expect(held('Hai una patente di guida valida per la categoria D?')).toEqual([]);
    expect(held('Avez-vous obtenu une moyenne supérieure à 5 dans vos bulletins scolaires ?')).toEqual([]);
    // «or» is not answered by one upload; a negation is not «do you hold».
    expect(held('Hai le pagelle o un attestato equivalente?')).toEqual([]);
    expect(held('Non hai la patente di guida?')).toEqual([]);
    // No document of this application.
    expect(held('Do you have a forklift licence?')).toEqual([]);
    // Not a yes/no question: an open text, a list of categories.
    expect(held('Possiedi una carta di qualificazione del conducente aggiornata?', 'text')).toEqual([]);
    expect(held('Quale categoria di patente di guida hai?', 'choice', ['B', 'C', 'D'])).toEqual([]);
    expect(documentsHeldAsked({ question: 'Possiedi la patente di guida?', type: 'yes_no' }, [])).toEqual([]);
    expect(documentsHeldAsked(null, documents)).toEqual([]);
  });

  it('reads the «yes» of a yes/no choice, and of nothing else', () => {
    expect(yesOption(['Oui', 'Non'])).toBe('Oui');
    expect(yesOption([{ label: 'Ja' }, { label: 'Nein' }, { label: 'Bitte wählen' }])).toBe('Ja');
    expect(yesOption(['Sì', 'No', 'Forse', 'Altro'])).toBe('');
    expect(yesOption(['B', 'C'])).toBe('');
    expect(yesOption(undefined)).toBe('');
  });

  it('tells the model which documents the candidate uploads, and not to ask about them', () => {
    const text = matchUserText({
      profile: {}, answers: {}, postingExcerpt: 'x',
      requirements: { requirements: [], requestedDocuments: [{ document: 'Permis de conduire', kind: 'other', required: true, quote: 'q', keywords: ['patente'] }, { document: 'Portfolio', required: false }] },
    });
    expect(JSON.parse(text.split('\n\n<<<POSTING EXCERPT')[0]).requestedDocuments).toEqual([{ document: 'Permis de conduire', required: true }, { document: 'Portfolio', required: false }]);
    expect(matchSystemPrompt('it')).toContain('never ask whether the candidate holds, has or can provide a document listed in requestedDocuments');
    expect(candidateRules('it')).toContain('only asks whether the candidate holds a document listed in documents.extra');
  });
});

describe('a portal\'s own «do you hold…?» field, with that document attached', () => {
  const yesNo = (id: string, label: string, extra: object = {}) => ({ id, kind: 'radio', label, required: true, options: [{ label: 'Oui' }, { label: 'Non' }], ...extra });
  const candidate = candidateForForm({
    identity: { name: 'Maria Rossi', email: 'maria.rossi@example.com', phone: '+41 79 123 45 67' },
    extraDocuments: [{ slot: 'extra_1', ...licence, kind: 'other', files: [] }, { slot: 'extra_2', ...card, kind: 'certificate', files: [] }],
  });
  const none = candidateForForm({ identity: { name: 'Maria Rossi', email: 'maria.rossi@example.com', phone: '+41 79 123 45 67' } });

  it('hands the planner each attached document with the names it goes by', () => {
    expect(candidate.documents.extra).toEqual([
      { slot: 'extra_1', label: 'permis de conduire', kind: 'other', keywords: licence.keywords },
      { slot: 'extra_2', label: card.label, kind: 'certificate', keywords: card.keywords },
    ]);
    expect(none.documents.extra).toEqual([]);
  });

  it('answers its «yes», whatever the plan says: skipped, asked of the candidate, or answered «no»', () => {
    const field = yesNo('f1', 'Possédez-vous une carte de qualification de conducteur à jour ? *');
    expect(attachedDocumentYes(candidate, field)).toBe('Oui');
    const yes = { fieldId: 'f1', action: 'select', value: 'Oui', document: 'none', source: 'documents', evidence: '' };
    const skipped = guardPlan({ actions: [{ fieldId: 'f1', action: 'skip', value: '', document: 'none', source: 'rule', evidence: '' }], missingRequired: [] }, [field], candidate);
    expect(skipped).toEqual({ actions: [yes], missingRequired: [] });
    const asked = guardPlan({ actions: [], missingRequired: [{ fieldId: 'f1', question: 'Carte de qualification ?', why: '', type: 'yes_no', options: ['Oui', 'Non'] }] }, [field], candidate);
    expect(asked).toEqual({ actions: [yes], missingRequired: [] });
    const denied = guardPlan({ actions: [{ fieldId: 'f1', action: 'select', value: 'Non', document: 'none', source: 'rule', evidence: '' }], missingRequired: [] }, [field], candidate);
    expect(denied).toEqual({ actions: [yes], missingRequired: [] });
    // A licence is a knock-out question («permis de conduire»): the upload answers it all the same.
    const licenceField = yesNo('f2', 'Avez-vous un permis de conduire ?');
    expect(guardPlan({ actions: [], missingRequired: [] }, [licenceField], candidate).actions).toEqual([{ ...yes, fieldId: 'f2' }]);
  });

  it('leaves every other field to the usual gates: no document attached, more asked, no yes/no', () => {
    const field = yesNo('f1', 'Possédez-vous une carte de qualification de conducteur à jour ?');
    // Nothing attached (the pre-read of a portal, before the candidate gave anything): a question for them.
    expect(attachedDocumentYes(none, field)).toBe('');
    expect(guardPlan({ actions: [], missingRequired: [] }, [field], none).missingRequired.map((item: any) => item.fieldId)).toEqual(['f1']);
    // More than «do you hold»: the category is the candidate's to state.
    const category = yesNo('f3', 'Votre permis de conduire couvre-t-il la catégorie D ?');
    expect(attachedDocumentYes(candidate, category)).toBe('');
    expect(guardPlan({ actions: [], missingRequired: [] }, [category], candidate).missingRequired.map((item: any) => item.fieldId)).toEqual(['f3']);
    // A list that is no yes/no.
    const list = { id: 'f4', kind: 'select', label: 'Permis de conduire', required: true, options: [{ label: 'B' }, { label: 'C' }, { label: 'D' }] };
    expect(attachedDocumentYes(candidate, list)).toBe('');
  });
});
