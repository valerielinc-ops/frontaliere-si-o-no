/** Work authorization is not proof of residence or a commitment to relocate. */
import { createHash } from 'node:crypto';
import { candidateAnswersForQuestions } from '../assistedApplicationCandidateEdits.js';
import { sanitizeValidation } from './answerRules.js';

const norm = value => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const SWISS = /\b(?:switzerland|swiss|svizzera|suisse|schweiz|ch)\b/;
const RESIDENCE = /\b(?:resid(?:e|es|ing|ent\w*|ence|ency|enza|er|ez|ant\w*)|risied\w*|domicil\w*|wohnsitz|wohnhaft|wohn(?:en|end\w*)|leb(?:en|t)|living|lives?|vivere|abitare|habit(?:er|e|ant\w*))\b/;
const RELOCATION = /\b(?:relocat\w*|mov(?:e|es|ing)|trasferir\w*|trasferiment\w*|demenag\w*|umzug|umzieh\w*)\b/;
const LEGAL_STATUS = /\b(?:permits?|permis|permess\w*|bewilligung\w*|visa|citizen\w*|citoyen\w*|nationalit\w*|cittadin\w*|staatsangehor\w*|staatsburger\w*|work authori\w*)\b/;
const ALTERNATIVE = /\b(?:or|o|oppure|oder|ou)\b/;
const CONJUNCTION = /\b(?:and|e|und|et)\b/;
const RESIDENCE_PERMIT = /\b(?:residence permits?|permesso di soggiorno|permis de sejour|aufenthaltsbewilligung\w*)\b/g;
const OPTIONAL = /\b(?:not required|not necessary|no residence requirement|non richiest\w*|non necessari\w*|nicht erforderlich|kein wohnsitz erforderlich|pas requis\w*|non obligatoire|optional|facoltativ\w*)\b/;
const NEGATIVE_OR_CONDITIONAL = /\b(?:no|not|never|non|nicht|kein\w*|pas|sans|if|provided|unless|qualora|se|wenn|falls)\b/;
const EMPLOYER = /\b(?:company|employer|office|headquarters|azienda|datore|arbeitgeber|entreprise|siege)\b/;
const WILLING = /\b(?:willing\w*|ready|available|disponib\w*|pr[eê]t\w*|bereit\w*)\b/;

/** Only a stated residence/mobility condition, never a permit or citizenship alternative. */
export function swissMobilityRequirement(row) {
  if (!['critical', 'high'].includes(row?.importance) || row.basis !== 'stated' || row.quoteUnverified) return null;
  const value = norm(row.quote);
  if (!SWISS.test(value) || OPTIONAL.test(value)) return null;
  // A permit noun is not a residence condition. Keep independently required
  // mobility in mixed AND clauses, but do not turn a legal OR alternative
  // into an obligation to relocate (citizenship OR Swiss residence).
  const mobilityText = value.replace(RESIDENCE_PERMIT, '');
  const hasMobility = clause => RESIDENCE.test(clause) || RELOCATION.test(clause);
  if (LEGAL_STATUS.test(value)) {
    if (mobilityText.split(ALTERNATIVE).some(part => LEGAL_STATUS.test(part) && !hasMobility(part))) return null;
    // The country must qualify the mobility component itself, not just a
    // neighboring Swiss permit while residence is required somewhere else.
    if (!mobilityText.split(CONJUNCTION).some(part => !LEGAL_STATUS.test(part) && SWISS.test(part) && hasMobility(part))) return null;
  }
  const residence = RESIDENCE.test(mobilityText); const relocation = RELOCATION.test(mobilityText);
  return residence || relocation ? { residence, relocation, alternative: ALTERNATIVE.test(value) } : null;
}

const COPY = {
  it: ['Puoi soddisfare tutte le condizioni di residenza o trasferimento riportate qui?', 'Il permesso di lavoro non conferma dove vivi o la disponibilità a trasferirti.'],
  en: ['Can you meet all the residence or relocation conditions quoted here?', 'A work permit does not confirm where you live or your willingness to relocate.'],
  de: ['Kannst du alle hier genannten Bedingungen zu Wohnsitz oder Umzug erfüllen?', 'Eine Arbeitsbewilligung bestätigt weder den Wohnsitz noch die Umzugsbereitschaft.'],
  fr: ['Pouvez-vous remplir toutes les conditions de résidence ou de déménagement citées ici ?', 'Un permis de travail ne confirme ni le domicile ni la volonté de déménager.'],
};
function questionFor(row, locale) {
  // The whole clause identifies the confirmation: a deadline, city or other
  // qualifier must never reuse an answer to a less restrictive requirement.
  const hash = createHash('sha256').update(norm(row.quote)).digest('hex').slice(0, 32);
  const [question, why] = COPY[String(locale || '').slice(0, 2)] || COPY.it;
  return { id: `mobility_requirement_${hash}`, question, why,
    applicationQuestion: String(row.quote), context: String(row.quote), type: 'yes_no', options: [], required: true,
    validation: sanitizeValidation({}, { type: 'yes_no' }), source: 'rule' };
}
function binary(value) {
  if (value === true || /^(?:yes|si|oui|ja|true|1)$/.test(norm(value))) return true;
  if (value === false || /^(?:no|non|nein|false|0)$/.test(norm(value))) return false;
  return null;
}
// Country-only clauses can use country-level CV evidence. Extra words such
// as a city, deadline or distance must be confirmed for the whole clause.
const COUNTRY_CLAUSE_WORDS = new Set(('resident residents residence residency in switzerland swiss and or willingness willing to relocate relocation ready available must required currently live lives living reside resides residing move moves moving ' +
  'residenza residente residenti svizzera o oppure disponibilita disponibile trasferimento trasferirsi al a di e richiesta richiesto ' +
  'wohnsitz wohnhaft schweiz der die ein eine oder bereitschaft bereit zum umzug umziehen erforderlich und ' +
  'domicile domicilie domiciliee en suisse ou volonte pret prete demenager demenagement et').split(' '));
function cvProof(row, evidence, profile, sourceText) {
  if (!norm(row.quote).split(' ').every(word => COUNTRY_CLAUSE_WORDS.has(word))) return null;
  const kind = swissMobilityRequirement(row);
  const value = norm(evidence); const source = norm(sourceText);
  const quoted = value && source.includes(value) && !NEGATIVE_OR_CONDITIONAL.test(value) && !EMPLOYER.test(value);
  const location = norm(profile?.location);
  // Only the candidate's explicitly extracted current location, also present
  // in the actual CV. Never nationality, permit status or an employer address.
  const contact = location && /(?:^ch \d{4}\b|\b(?:switzerland|svizzera|suisse|schweiz|ch)$)/.test(location)
    && source.includes(location) && !LEGAL_STATUS.test(location) && !EMPLOYER.test(location);
  const residence = Boolean(contact || (quoted && SWISS.test(value) && RESIDENCE.test(value)
    && !LEGAL_STATUS.test(value) && !/\b(?:previous|formerly|former|past|lived|used to)\b/.test(value)));
  const relocationQuote = [evidence, profile?.availability].map(v => String(v || '')).find(v => {
    const t = norm(v);
    return t && source.includes(t) && SWISS.test(t) && RELOCATION.test(t) && WILLING.test(t)
      && !NEGATIVE_OR_CONDITIONAL.test(t) && !LEGAL_STATUS.test(t) && !EMPLOYER.test(t);
  });
  const relocation = Boolean(relocationQuote);
  const met = kind.residence && kind.relocation ? kind.alternative ? residence || relocation : residence && relocation
    : kind.residence ? residence : relocation;
  return met ? (contact && kind.residence && (!kind.relocation || kind.alternative) ? String(profile.location)
    : relocationQuote || String(evidence)) : null;
}

/** Shared by proposal qualification and draft preparation before review/dispatch. */
export function guardMobilityMatch(requirements, match, { profile = {}, sourceText = '', answers = {}, memory = {}, locale = 'it' } = {}) {
  const rows = requirements?.requirements || [];
  const targets = rows.map((row, index) => swissMobilityRequirement(row) ? { row, index, question: questionFor(row, locale) } : null).filter(Boolean);
  if (!targets.length) return match;
  const confirmed = candidateAnswersForQuestions(targets.map(t => t.question), answers, memory);
  const result = { ...match, matches: [...(match.matches || [])], questions: [...(match.questions || [])] };
  for (const { row, index, question } of targets) {
    const at = result.matches.findIndex(m => m.index === index);
    const previous = result.matches[at];
    const answer = binary(confirmed[question.id]);
    const proof = answer === null ? cvProof(row, previous?.evidence, profile, sourceText) : null;
    const status = answer === true || proof ? 'met' : answer === false ? 'missing' : 'partial';
    const record = { index, status, evidence: answer !== null ? String(confirmed[question.id]) : proof || '', evidenceUnverified: false };
    if (at < 0) result.matches.push(record); else result.matches[at] = record;
    result.questions = result.questions.filter(q => q.id !== question.id);
    if (status === 'partial') result.questions.push(question);
    if (status === 'missing') result.verdict = 'poor';
    else if (status === 'partial' && ['strong', 'good'].includes(result.verdict)) result.verdict = 'weak';
  }
  // The model's verdict preceded this verified answer. Resolve only a weak
  // verdict when every fixed requirement now has positive, grounded evidence;
  // keep explicit knock-outs and any remaining gap unchanged.
  if (result.verdict === 'weak' && rows.length && rows.every((_, index) => {
    const m = result.matches.find(item => item.index === index);
    return m?.status === 'met' && !m.evidenceUnverified && String(m.evidence || '').trim();
  })) result.verdict = 'good';
  return result;
}
