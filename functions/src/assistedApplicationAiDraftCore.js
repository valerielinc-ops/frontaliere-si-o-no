/**
 * Pure helpers of the assisted-application AI draft, shared by the GitHub
 * Actions runner (scripts/assisted-application/) and the owner queue in the
 * Cloud Functions (edits of the draft re-render the letter and re-run the
 * fact gate). No I/O here.
 */

import { buildFactIndex, checkGeneratedFacts } from './assistedApplicationAiFactCheck.js';
import { sanitizeValidation } from './lib/answerRules.js';
import { letterPlaceDate, letterSubject } from './assistedApplicationAiPrompts.js';

export const LETTER_FILE_LABEL = {
  it: 'Lettera di presentazione',
  de: 'Motivationsschreiben',
  fr: 'Lettre de motivation',
  en: 'Cover letter',
};

export function clean(value, max = 500) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function cleanBlock(value, max = 4000) {
  return String(value ?? '').replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').trim().slice(0, max);
}

const list = (value, max) => (Array.isArray(value) ? value.slice(0, max) : []);

/** Lengths the schemas no longer enforce are capped here. */
export function sanitizeProfile(raw) {
  return {
    fullName: clean(raw?.fullName, 200),
    email: clean(raw?.email, 320),
    phone: clean(raw?.phone, 80),
    location: clean(raw?.location, 200),
    address: {
      street: clean(raw?.address?.street, 200),
      postalCode: clean(raw?.address?.postalCode, 20),
      city: clean(raw?.address?.city, 120),
      country: clean(raw?.address?.country, 80),
    },
    dateOfBirth: clean(raw?.dateOfBirth, 40),
    nationality: clean(raw?.nationality, 120),
    linkedin: clean(raw?.linkedin, 300),
    website: clean(raw?.website, 300),
    headline: clean(raw?.headline, 300),
    summary: cleanBlock(raw?.summary, 1500),
    workPermit: clean(raw?.workPermit, 200),
    availability: clean(raw?.availability, 200),
    languages: list(raw?.languages, 12).map((item) => ({ language: clean(item?.language, 60), level: clean(item?.level, 60) })).filter((item) => item.language),
    skills: list(raw?.skills, 40).map((item) => clean(item, 120)).filter(Boolean),
    experience: list(raw?.experience, 15).map((item) => ({
      role: clean(item?.role, 200),
      employer: clean(item?.employer, 200),
      location: clean(item?.location, 200),
      start: clean(item?.start, 40),
      end: clean(item?.end, 40),
      kind: EXPERIENCE_KINDS.has(item?.kind) ? item.kind : 'job',
      highlights: list(item?.highlights, 6).map((line) => clean(line, 400)).filter(Boolean),
    })),
    education: list(raw?.education, 10).map((item) => ({
      degree: clean(item?.degree, 200), institution: clean(item?.institution, 200), start: clean(item?.start, 40), end: clean(item?.end, 40), grade: clean(item?.grade, 80),
    })),
    certifications: list(raw?.certifications, 20).map((item) => clean(item, 200)).filter(Boolean),
    aptitudeTests: list(raw?.aptitudeTests, 6).map((item) => ({ name: clean(item?.name, 120), date: clean(item?.date, 40), results: clean(item?.results, 300) })).filter((item) => item.name),
    recognitions: list(raw?.recognitions, 6).map((item) => ({ title: clean(item?.title, 200), issuer: clean(item?.issuer, 120), date: clean(item?.date, 40) })).filter((item) => item.title),
    projects: list(raw?.projects, 8).map((item) => ({ name: clean(item?.name, 120), url: clean(item?.url, 300), description: clean(item?.description, 400) })).filter((item) => item.name || item.url),
    interests: list(raw?.interests, 10).map((item) => clean(item, 160)).filter(Boolean),
    references: list(raw?.references, 4).map((item) => ({ name: clean(item?.name, 120), role: clean(item?.role, 120), organisation: clean(item?.organisation, 160), contact: clean(item?.contact, 120) })).filter((item) => item.name),
    drivingLicence: clean(raw?.drivingLicence, 80),
    cvLanguage: clean(raw?.cvLanguage, 5).toLowerCase(),
  };
}

const EXPERIENCE_KINDS = new Set(['job', 'apprenticeship', 'internship', 'trial_apprenticeship', 'side_job', 'volunteer']);

export function sanitizeRequirements(raw) {
  const requirements = list(raw?.requirements, 12).map((item) => {
    const basis = item?.basis === 'inferred' ? 'inferred' : 'stated';
    let importance = ['critical', 'high', 'meaningful', 'preferred'].includes(item?.importance) ? item.importance : 'meaningful';
    // career-ops rule, enforced in code: an inferred row is never critical/high.
    if (basis === 'inferred' && (importance === 'critical' || importance === 'high')) importance = 'meaningful';
    return {
      requirement: clean(item?.requirement, 200),
      importance,
      basis,
      quote: basis === 'inferred' ? '' : clean(item?.quote, 400),
    };
  }).filter((item) => item.requirement);
  return {
    postingLanguage: clean(raw?.postingLanguage, 5).toLowerCase(),
    roleTitle: clean(raw?.roleTitle, 300),
    requirements,
    languageRequirements: list(raw?.languageRequirements, 6).map((item) => ({
      language: clean(item?.language, 60), level: clean(item?.level, 60), quote: clean(item?.quote, 300),
    })).filter((item) => item.language),
    workPermitQuote: clean(raw?.workPermitQuote, 400),
    salaryRequested: raw?.salaryRequested === true,
    applicationEmail: clean(raw?.applicationEmail, 254),
    contactPerson: clean(raw?.contactPerson, 200),
    applicationInstructions: clean(raw?.applicationInstructions, 400),
    requestedDocuments: list(raw?.requestedDocuments, 8).map((item) => ({
      document: clean(item?.document, 160),
      kind: clean(item?.kind, 30),
      required: item?.required !== false,
      quote: clean(item?.quote, 400),
      keywords: list(item?.keywords, 10).map((word) => clean(word, 40)).filter(Boolean),
    })).filter((item) => item.document && item.quote),
    legitimacy: {
      specificity: ['specific', 'mixed', 'vague'].includes(raw?.legitimacy?.specificity) ? raw.legitimacy.specificity : 'mixed',
      contradictions: list(raw?.legitimacy?.contradictions, 5).map((item) => clean(item, 300)).filter(Boolean),
      contractorQuote: clean(raw?.legitimacy?.contractorQuote, 300),
      aiDirectedQuote: clean(raw?.legitimacy?.aiDirectedQuote, 300),
      rolling: raw?.legitimacy?.rolling === true,
    },
  };
}

function normalizedHaystack(text) {
  return clean(text, 200_000).toLowerCase();
}

/** A quote the posting does not contain verbatim is dropped, not trusted. */
export function verifyQuotes(requirements, postingText) {
  const haystack = normalizedHaystack(postingText);
  const holds = (quote) => !quote || haystack.includes(clean(quote, 400).toLowerCase());
  for (const item of requirements.requirements) {
    if (!holds(item.quote)) {
      item.quote = '';
      item.quoteUnverified = true;
    }
  }
  if (!holds(requirements.workPermitQuote)) requirements.workPermitQuote = '';
  // A document is asked of the candidate only when the posting really asks for it.
  if (Array.isArray(requirements.requestedDocuments)) {
    requirements.requestedDocuments = requirements.requestedDocuments.filter((item) => item.quote && holds(item.quote));
  }
  // Legitimacy signals are quotes too: one the posting does not contain is dropped.
  if (requirements.legitimacy) {
    requirements.legitimacy.contradictions = requirements.legitimacy.contradictions.filter((quote) => holds(quote));
    if (!holds(requirements.legitimacy.contractorQuote)) requirements.legitimacy.contractorQuote = '';
    if (!holds(requirements.legitimacy.aiDirectedQuote)) requirements.legitimacy.aiDirectedQuote = '';
  }
  if (requirements.applicationEmail && !haystack.includes(requirements.applicationEmail.toLowerCase())) {
    requirements.applicationEmail = '';
  }
  return requirements;
}

const QUESTION_TYPES = new Set(['text', 'yes_no', 'choice', 'number', 'date']);

function sanitizeQuestions(raw) {
  const seen = new Set();
  return list(raw, 8).map((item) => ({
    id: clean(item?.id, 60).toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^_+|_+$/g, ''),
    question: clean(item?.question, 300),
    why: clean(item?.why, 300),
    type: QUESTION_TYPES.has(item?.type) ? item.type : 'text',
    options: list(item?.options, 12).map((option) => clean(option, 80)).filter(Boolean),
    required: item?.required === true,
    // Only a safe, self-consistent rule is kept (functions/src/lib/answerRules.js).
    validation: sanitizeValidation(item?.validation, { type: QUESTION_TYPES.has(item?.type) ? item.type : 'text' }),
    source: 'match',
  })).filter((item) => item.id && item.question && !seen.has(item.id) && seen.add(item.id)).slice(0, 6);
}

export const SALARY_RULE_MESSAGES = {
  it: 'Indica un importo, per esempio CHF 80’000 all’anno.',
  de: 'Gib einen Betrag an, zum Beispiel CHF 80’000 pro Jahr.',
  fr: 'Indiquez un montant, par exemple CHF 80’000 par an.',
  en: 'Give an amount, for example CHF 80’000 a year.',
};

const FALLBACK_QUESTIONS = {
  work_permit: {
    it: ['Hai un permesso di lavoro svizzero? Quale?', 'L’annuncio chiede il permesso di lavoro e il CV non lo indica.'],
    de: ['Hast du eine Schweizer Arbeitsbewilligung? Welche?', 'Das Inserat fragt nach der Bewilligung und der Lebenslauf nennt sie nicht.'],
    fr: ['Avez-vous un permis de travail suisse ? Lequel ?', 'L’annonce demande le permis de travail et le CV ne l’indique pas.'],
    en: ['Do you have a Swiss work permit? Which one?', 'The ad asks for the work permit and the CV does not state it.'],
    options: ['G', 'B', 'C', 'CH', 'none'],
  },
  salary_expectation: {
    it: ['Qual è la tua pretesa salariale annua lorda (CHF)?', 'L’annuncio chiede di indicarla.'],
    de: ['Welche Lohnvorstellung hast du (brutto pro Jahr, CHF)?', 'Das Inserat verlangt sie.'],
    fr: ['Quelles sont vos prétentions salariales annuelles brutes (CHF) ?', 'L’annonce les demande.'],
    en: ['What is your expected gross annual salary (CHF)?', 'The ad asks for it.'],
  },
};

/**
 * Deterministic backstop for the two questions the model must never skip:
 * a posting that asks for the permit or the salary gets the question even if
 * the model forgot it, unless the profile or the answers already cover it.
 */
export function ensureRequiredQuestions(questions, { requirements, profile, answers = {}, locale = 'it' }) {
  const result = [...questions];
  const has = (id) => result.some((question) => question.id === id) || String(answers[id] ?? '').trim();
  const text = (id) => FALLBACK_QUESTIONS[id][locale] || FALLBACK_QUESTIONS[id].it;
  if (requirements?.workPermitQuote && !profile?.workPermit && !has('work_permit')) {
    const [question, why] = text('work_permit');
    result.push({ id: 'work_permit', question, why, type: 'choice', options: FALLBACK_QUESTIONS.work_permit.options, required: true, validation: sanitizeValidation({}, { type: 'choice' }), source: 'rule' });
  }
  if (requirements?.salaryRequested && !has('salary_expectation')) {
    const [question, why] = text('salary_expectation');
    // An amount, whatever the format: "CHF 80'000", "80k", "85 000 - 90 000".
    const validation = sanitizeValidation({ pattern: '.*\\d.*', maxLength: 120, example: "CHF 80'000", message: SALARY_RULE_MESSAGES[locale] || SALARY_RULE_MESSAGES.it }, { type: 'text' });
    result.push({ id: 'salary_expectation', question, why, type: 'text', options: [], required: true, validation, source: 'rule' });
  }
  return result.slice(0, 8);
}

const SALUTATION_QUESTION = {
  it: { question: 'Come vuoi essere indicato nei moduli di candidatura?', why: 'Molti portali lo chiedono come campo obbligatorio (Signor / Signora).', options: ['Signor', 'Signora', 'Altro'] },
  de: { question: 'Welche Anrede sollen wir in Bewerbungsformularen angeben?', why: 'Viele Portale verlangen sie als Pflichtfeld (Herr / Frau).', options: ['Herr', 'Frau', 'Andere'] },
  fr: { question: 'Quelle civilité indiquer dans les formulaires de candidature ?', why: 'Beaucoup de portails la demandent comme champ obligatoire (Monsieur / Madame).', options: ['Monsieur', 'Madame', 'Autre'] },
  en: { question: 'Which form of address should we give in application forms?', why: 'Many portals ask for it as a required field (Mr / Ms).', options: ['Mr', 'Ms', 'Other'] },
};
// A question that already asks the form of address (the portal's own, read ahead): by a word that
// names it, or by its options. Never the bare word "title"/"titolo": «What is your job title?» asks
// something else (review of #11028).
const SALUTATION_RE = /(\banrede\b|appellativo|\bsalutation\b|civilit[ée]|form of address)/i;
const ADDRESS_OPTION_RE = /^(mr|mrs|ms|miss|herr|frau|signor|signore|signora|sig|sig\.ra|monsieur|madame|mme|m)\.?$/i;
const asksSalutation = (question) => SALUTATION_RE.test(`${question?.question || ''} ${question?.label || ''}`)
  || (Array.isArray(question?.options) ? question.options : []).filter((option) => ADDRESS_OPTION_RE.test(String(option).trim())).length >= 2;

/**
 * The form of address, asked on the first review when the application leaves
 * through a portal's form. umantis (2026-10-03) requires «Title: Ms / Mr /
 * Other», as most Swiss portals require «Anrede»; nothing in a CV says it and
 * it is never guessed from the first name, so it used to come back as a second
 * round at submit time. Optional: a candidate who does not answer is not held,
 * and the portal's own question then comes at submit time as before. Never for
 * an e-mail application, nor when a question already asks it.
 * @returns {object|null} the question for the review page
 */
export function salutationQuestion({ channel, questions = [], answers = {}, locale = 'it' }) {
  const type = String(channel?.type || '').trim().toLowerCase();
  if (!type || type === 'email' || type === 'unknown') return null;
  if (String(answers?.salutation ?? '').trim()) return null;
  if (questions.some((question) => question?.id === 'salutation' || asksSalutation(question))) return null;
  // "de-CH", "fr-CH": the language of the locale.
  const copy = SALUTATION_QUESTION[String(locale || '').slice(0, 2).toLowerCase()] || SALUTATION_QUESTION.it;
  return { id: 'salutation', question: copy.question, why: copy.why, type: 'choice', options: copy.options, required: false, validation: sanitizeValidation({}, { type: 'choice' }), source: 'rule' };
}

export function sanitizeMatch(raw, requirementCount, profileText) {
  const haystack = normalizedHaystack(profileText);
  const matches = list(raw?.matches, 12)
    .filter((item) => Number.isInteger(item?.index) && item.index >= 0 && item.index < requirementCount)
    .map((item) => {
      const evidence = clean(item?.evidence, 400);
      const verified = !evidence || haystack.includes(evidence.toLowerCase());
      return {
        index: item.index,
        status: ['met', 'partial', 'missing'].includes(item?.status) ? item.status : 'missing',
        evidence: verified ? evidence : '',
        evidenceUnverified: !verified,
      };
    });
  return {
    matches,
    verdict: ['strong', 'good', 'weak', 'poor'].includes(raw?.verdict) ? raw.verdict : 'weak',
    summaryIt: clean(raw?.summaryIt, 800),
    checksIt: list(raw?.checksIt, 8).map((item) => clean(item, 300)).filter(Boolean),
    questions: sanitizeQuestions(raw?.questions),
  };
}

export function sanitizeDocuments(raw) {
  const letter = raw?.coverLetter || {};
  return {
    coverLetter: {
      salutation: clean(letter.salutation, 200),
      paragraphs: list(letter.paragraphs, 5).map((item) => cleanBlock(item, 2000)).filter(Boolean),
      closing: clean(letter.closing, 200),
    },
    emailSubject: clean(raw?.emailSubject, 250),
    emailBody: cleanBlock(raw?.emailBody, 3000),
    motivationShort: clean(raw?.motivationShort, 600),
    whyCompany: clean(raw?.whyCompany, 400),
  };
}

/**
 * Who the employer sees. The e-mail is the order's alias when its routing
 * rule is active (owner decision 2026-09-30: alias everywhere), else the
 * candidate's own address.
 */
export function candidateIdentity(order, profile) {
  const name = clean(order?.applicantName, 200) || clean(profile?.fullName, 200);
  const alias = order?.candidateAlias?.active ? clean(order.candidateAlias.address, 320) : '';
  const email = alias || clean(order?.applicantEmail, 320) || clean(profile?.email, 320) || clean(order?.customerEmail, 320);
  const phone = clean(order?.applicantPhone, 80) || clean(profile?.phone, 80);
  return { name, email, phone };
}

export function splitName(fullName) {
  const parts = clean(fullName, 200).split(' ').filter(Boolean);
  if (parts.length < 2) return { firstName: parts[0] || '', lastName: '' };
  return { firstName: parts.slice(0, -1).join(' '), lastName: parts[parts.length - 1] };
}

export function letterText(letter) {
  return [letter?.salutation, ...(letter?.paragraphs || []), letter?.closing].map((part) => cleanBlock(part, 3000)).filter(Boolean).join('\n\n');
}

/** Parse an edited letter back into salutation / paragraphs / closing. */
export function parseLetterText(text) {
  const blocks = cleanBlock(text, 8000).split(/\n\s*\n/).map((block) => block.trim()).filter(Boolean);
  if (blocks.length <= 2) return { salutation: '', paragraphs: blocks, closing: '' };
  return { salutation: blocks[0], paragraphs: blocks.slice(1, -1), closing: blocks[blocks.length - 1] };
}

function field(key, label, value, { needsConfirmation = false, note = '' } = {}) {
  return { key, label, value: clean(value, 2000), needsConfirmation, note };
}

/**
 * Standard portal fields, in the order most forms ask them. Legal, salary and
 * availability answers come from the profile or the candidate's answers only.
 */
export function buildFormAnswers({ identity, profile, documents, answers = {} }) {
  // The split the candidate chose on the review page, else the last word is the surname.
  const { firstName, lastName } = typeof identity.firstName === 'string' ? identity : splitName(identity.name);
  const languages = (profile?.languages || []).map((item) => [item.language, item.level].filter(Boolean).join(' ')).filter(Boolean).join(', ');
  const permit = clean(answers.work_permit, 200) || profile?.workPermit || '';
  const availability = clean(answers.availability, 200) || profile?.availability || '';
  const salary = clean(answers.salary_expectation, 200);
  return [
    field('firstName', 'Nome', firstName),
    field('lastName', 'Cognome', lastName),
    field('email', 'Email', identity.email),
    field('phone', 'Telefono', identity.phone),
    field('location', 'Località', profile?.location || ''),
    field('linkedin', 'LinkedIn', profile?.linkedin || ''),
    field('workPermit', 'Permesso di lavoro', permit, { needsConfirmation: !permit, note: permit ? '' : 'Da chiedere al candidato.' }),
    field('availability', 'Disponibilità / preavviso', availability, { needsConfirmation: !availability }),
    field('salary', 'Pretese salariali', salary, { needsConfirmation: !salary, note: salary ? '' : 'Mai inventate.' }),
    field('languages', 'Lingue', languages),
    field('motivationShort', 'Motivazione (campo breve)', documents?.motivationShort || ''),
    field('whyCompany', 'Perché questa azienda', documents?.whyCompany || ''),
  ];
}

// ── Swiss letter conventions (study 2026-10-02, report-cv-lettera §5) ─────
// Official templates of the cantonal career services (SDBB/CSFO, Città di
// Lugano, Canton Ticino) and the Federal Chancellery's guides, verified on
// 2026-10-03: German without a comma after the salutation and the closing,
// French "Madame, Monsieur," and a closing sentence that repeats it, Italian
// "Gentile signora …," then a lowercase start, and "Cordiali saluti", English
// without a comma ("Dear Ms Muster", English Style Guide, 3rd edition 2024).
// The salutation and the closing are written here, never by the model.

export const LETTER_CLOSING = {
  it: 'Cordiali saluti',
  de: 'Freundliche Grüsse',
  en: 'Kind regards',
};

/**
 * The closing for the salutation printed. French closes with a sentence that
 * repeats it (CSFO template and examples, Vaud, Neuchâtel): «Je vous prie de
 * recevoir, Madame, Monsieur, mes meilleures salutations.»
 */
export function letterClosing(language, salutation = '') {
  if (language === 'fr') return `Je vous prie de recevoir, ${clean(salutation, 200) || 'Madame, Monsieur,'} mes meilleures salutations.`;
  return LETTER_CLOSING[language] || LETTER_CLOSING.it;
}

// The enclosure line's label with its colon: the singular for one document in
// Italian and French (Città di Lugano, Consiglio di Stato; SECO), French with a
// no-break space before the colon (CSFO). German and English keep the plural
// their sources print.
const ENCLOSURES_LABEL = {
  it: ['Allegato:', 'Allegati:'],
  de: ['Beilagen:', 'Beilagen:'],
  fr: ['Annexe :', 'Annexes :'],
  en: ['Enclosures:', 'Enclosures:'],
};
export const CV_ENCLOSURE = { it: 'Curriculum vitae', de: 'Lebenslauf', fr: 'CV', en: 'CV' };

export function enclosuresLabel(language, count) {
  const [one, several] = ENCLOSURES_LABEL[language] || ENCLOSURES_LABEL.it;
  return count === 1 ? one : several;
}

// Honorifics before the contact's name: [pattern, gender, English title].
const HONORIFICS = [
  [/^(?:frau|madame|mme\.?|mademoiselle|mlle\.?|signora|signorina|sig\.ra|sig\.na|dott\.ssa|dottoressa|prof\.ssa|professoressa|ms\.?)$/i, 'f', 'Ms'],
  [/^mrs\.?$/i, 'f', 'Mrs'],
  [/^miss$/i, 'f', 'Miss'],
  [/^(?:herrn?|monsieur|signore?|sig\.|mr\.?)$/i, 'm', 'Mr'],
  [/^mx\.?$/i, '', 'Mx'],
];
// Abbreviations that are something else in another language count only in their
// own, with the case and the full stop as written: «M.» is an initial outside
// French; «Hr.» and «Fr.» are a team («HR»), a currency and «Frère» outside German.
const LANGUAGE_HONORIFICS = {
  fr: [[/^M\.$/, 'm', 'Mr']],
  de: [[/^Hrn?\.$/, 'm', 'Mr'], [/^Fr\.$/, 'f', 'Ms']],
};
// Academic and professional titles, dropped whole and never a gender: «Dr. med.»,
// «Prof. Dr.», «Dipl. Ing.», «lic. iur.», «Dott.» (the Federal Chancellery does not
// print them in German, n. 360). The second pattern is their lowercase parts.
const TITLE = /^(?:dr|prof|dott|dottor|dottore|ing|dipl|lic|mag|avv|arch|geom|rag|dipl\.?-ing|dr\.?-ing)\.?$/i;
const TITLE_PART = /^\p{Ll}[\p{L}.]*\.$/u;
// Degrees after the name («Anna Muster PhD»).
const DEGREE = /^(?:phd|ph\.d\.|mba|msc|m\.sc\.|bsc|b\.sc\.|llm|ll\.m\.)$/i;
const SURNAME_PARTICLES = new Set(['de', 'di', 'da', 'del', 'della', 'dal', 'dalla', 'von', 'van', 'der', 'den', 'du', 'des', 'le', 'la', 'lo', 'dos', 'das']);
// A department or a function where a person is expected.
const DEPARTMENT = /(?<![\p{L}])(?:hr|rh|team|abteilung|personal\p{L}*|personale|personnel|ressources|risorse|human|recruit\p{L}*|rekrut\p{L}*|recrutement|reclutamento|talent\p{L}*|ufficio|service|servizio|dienst|d[ée]partement|department|dipartimento|direzione|direction|sekretariat|secr[ée]tariat|segreteria|gesch[äa]ftsleitung|leitung|administration|amministrazione|verwaltung|bewerbung\p{L}*|candidature|karriere|careers?|hiring)(?![\p{L}])/iu;
// A function next to a name («Leiter Logistik», «Geschäftsführer», «Responsabile vendite», «Head Finance»);
// German compounds end in it. It only tells a function from a name, never a gender.
const ROLE_STEM = String.raw`leiter|chef|direktor|f(?:ü|ue)hrer|inhaber|spezialist|bearbeiter|assistent|berater|manager|koordinator|partner`;
const ROLE = new RegExp(String.raw`(?:${ROLE_STEM})(?:in)?$|verantwortliche[rn]?$|^(?:head|director|officer|lead|recruiter|owner|founder|ceo|cfo|coo|cto|responsabile|direttore|direttrice|capo|titolare|coordinatore|coordinatrice|responsable|directeur|directrice|cheffe|coordinateur|chargée?|gérante?)$`, 'iu');
// The function words that are also surnames («Leiter», «Kleiter», «Head»): a name may end in them.
const SURNAME_ROLE = new RegExp(String.raw`^\p{L}{0,2}(?:${ROLE_STEM})$|^(?:head|lead|owner|capo)$`, 'iu');
// Two people («Frau Muster / Herr Meier», «… und …», «… e …», «… et …», «&»).
const TWO_PEOPLE = /[/&+]|\s(?:und|e|et|and)\s/iu;
const NAME_WORD = /^(?:\p{Lu}[\p{L}\p{M}'’-]*|\p{Lu}\.)$/u;

function honorificOf(word, language) {
  for (const [pattern, gender, english] of [...HONORIFICS, ...(LANGUAGE_HONORIFICS[language] || [])]) {
    if (pattern.test(word)) return { gender, english };
  }
  return null;
}

/**
 * Whether a part of the contact line names a person: an honorific, or a full name
 * (two capitalised words or more, no department, no function).
 */
function namesPerson(part, language) {
  const words = part.split(' ').filter(Boolean);
  if (words.some((word) => honorificOf(word, language))) return true;
  const name = words.filter((word) => !TITLE.test(word) && !TITLE_PART.test(word));
  return name.filter((word) => NAME_WORD.test(word)).length >= 2
    && name.every((word) => NAME_WORD.test(word) || SURNAME_PARTICLES.has(word.toLowerCase()))
    && !DEPARTMENT.test(part) && !name.some((word) => ROLE.test(word));
}

/**
 * The one person the posting names as contact: the honorific it wrote, the
 * given names and the surname with its particles. null for a department, an
 * e-mail address or two people: never one of them, never a mix.
 */
function contactOf(raw, language) {
  const text = clean(raw, 200).replace(/\s*(?:\([^)]*\)|\[[^\]]*\])/g, ' ').trim();
  if (!text || /@|https?:|www\./i.test(text)) return null;
  // What follows a comma is the function («Herr Peter von Arx, Leiter HR»), unless only it names a person;
  // two parts that each name one are two people («Anna Muster, Peter Meier», «Anna Muster, Herr Peter Meier»).
  const parts = text.split(/\s*[,;]\s*/).filter(Boolean);
  const people = parts.filter((part) => namesPerson(part, language));
  if (people.length > 1 || TWO_PEOPLE.test(people[0] || parts[0])) return null;
  let words = (people[0] || parts[0]).split(' ').filter(Boolean);
  // A role before the honorific («Teamleiterin Frau Muster»).
  const at = words.findIndex((word) => honorificOf(word, language));
  if (at > 0) words = words.slice(at);
  let honorific = null;
  let doctor = false;
  while (words.length) {
    const found = honorificOf(words[0], language);
    if (!found && !TITLE.test(words[0]) && !TITLE_PART.test(words[0])) break;
    if (found) honorific ||= found;
    else doctor ||= /^dr(?![a-z])/i.test(words[0]);
    words.shift();
  }
  // Another honorific further on is a second person («Frau Muster Herr Meier», two lines run together).
  if (words.some((word) => honorificOf(word, language))) return null;
  // A function after two name words ends the name: the lines of a contact block run together («Frau Anna
  // Muster Leiterin Logistik»). Anywhere else, or last and also a surname, which words are the name is
  // unknown («Geschäftsführer Peter Muster», «Frau Anna Leiter», «Herr Hans Peter Leiter»); the honorific's
  // gender is not, and French greets by it alone.
  const role = words.findIndex((word) => ROLE.test(word));
  if (role >= 0) {
    if (words.slice(0, role).filter((word) => !SURNAME_PARTICLES.has(word.toLowerCase())).length !== 2
      || (role === words.length - 1 && SURNAME_ROLE.test(words[role]))) {
      return honorific ? { gender: honorific.gender, english: '', doctor: false, surname: '', name: '' } : null;
    }
    words = words.slice(0, role);
  }
  while (words.length > 1 && DEGREE.test(words[words.length - 1])) words.pop();
  if (!words.length || DEPARTMENT.test(words.join(' '))) return null;
  if (!words.every((word) => NAME_WORD.test(word) || SURNAME_PARTICLES.has(word.toLowerCase()))) return null;
  // The surname with its particles («von Arx», «De Luca», «van der Berg»): all of it after an honorific alone.
  let start = words.length - 1;
  while (start > 0 && SURNAME_PARTICLES.has(words[start - 1].toLowerCase())) start -= 1;
  return { gender: honorific?.gender || '', english: honorific?.english || '', doctor, surname: words.slice(start).join(' '), name: start > 0 ? words.join(' ') : '' };
}

/**
 * The salutation for the contact person the posting names. The gender comes
 * only from an honorific the posting wrote ("Frau", "Monsieur", "signora"),
 * never from the first name; without one the form stays neutral, and without a
 * single person to address (a department, two people, a surname alone) it is
 * the unnamed form. `language` is the letter's, which is the posting's own
 * (resolveLetterLanguage): it decides which abbreviations are honorifics.
 */
export function letterSalutation(language, contactPerson = '') {
  const contact = contactOf(contactPerson, language);
  const gender = contact?.gender || '';
  const surname = contact?.surname || '';
  const name = contact?.name || '';
  switch (language) {
    case 'de':
      if (surname && gender) return gender === 'f' ? `Sehr geehrte Frau ${surname}` : `Sehr geehrter Herr ${surname}`;
      return name ? `Guten Tag ${name}` : 'Sehr geehrte Damen und Herren';
    case 'fr':
      if (gender) return gender === 'f' ? 'Madame,' : 'Monsieur,';
      return 'Madame, Monsieur,';
    case 'en':
      // «Dr» needs no gender and has no full stop; a posting's «Mrs» stays «Mrs».
      if (surname && contact.doctor) return `Dear Dr ${surname}`;
      if (surname && contact.english) return `Dear ${contact.english} ${surname}`;
      return name ? `Dear ${name}` : 'Dear Sir or Madam';
    default:
      if (surname && gender) return gender === 'f' ? `Gentile signora ${surname},` : `Gentile signor ${surname},`;
      // Canton Ticino (2025) and Graubünden (2026): one adjective for both, as the Ticino directive asks.
      return name ? `Gentile ${name},` : 'Gentili signore e signori,';
  }
}

// Italian words a letter's first paragraph often starts with; after "Gentile …," they take a lowercase letter.
const IT_LOWERCASE_START = new Set('sono ho mi vi le la lo con in da dopo durante lavoro sviluppo attualmente grazie desidero vorrei da dal dalla nel nella seguo ricopro mi chiamo come'.split(' '));
// …but a courtesy pronoun before one of these verbs keeps its capital («Le scrivo», «La ringrazio»,
// «Vi invio»: Federal Chancellery, SDBB model letter).
const IT_COURTESY_PRONOUNS = new Set(['le', 'la', 'vi']);
const IT_COURTESY_VERBS = new Set('scrivo ringrazio contatto invio propongo sottopongo presento chiedo porgo trasmetto'.split(' '));

function italianStart(text) {
  const [, word = '', next = ''] = /^(\p{L}+)(?:\s+(\p{L}+))?/u.exec(text) || [];
  const lower = word.toLowerCase();
  if (!IT_LOWERCASE_START.has(lower) || (IT_COURTESY_PRONOUNS.has(lower) && IT_COURTESY_VERBS.has(next.toLowerCase()))) return text;
  return text[0].toLowerCase() + text.slice(1);
}

/**
 * Swiss typography: no "ß" in German, no line break inside "81 %" or "CHF 80'000".
 * The protected space before "%" is the Federal Chancellery's in German (n. 554),
 * French and Italian, never inside a compound: «80%-Pensum» (n. 555).
 */
export function swissTypography(text, language) {
  let out = String(text ?? '');
  if (language === 'de') out = out.replace(/ß/g, 'ss');
  if (language === 'de' || language === 'fr' || language === 'it') {
    out = out.replace(/(\d)[  ]?%(?=-\p{L})/gu, '$1%').replace(/(\d)[  ]?%(?!-\p{L})/gu, '$1 %');
  } else out = out.replace(/(\d) %/g, '$1 %');
  return out.replace(/\b(CHF|EUR|Fr\.)\s+(?=\d)/g, '$1 ');
}

// A greeting or a closing the model wrote anyway in a text the code frames with
// its own (it is asked not to): removed, so nothing prints twice. Short closed
// lists per language.
const GREETING_OPENER = {
  it: /^(?:gentil[ei]|egregi[oa]?|egr\.|spettabil[ei]|spett\.(?:le)?|buongiorno|buonasera|salve)(?![\p{L}])/iu,
  de: /^(?:sehr\s+geehrte[rs]?|geehrte[rs]?|liebe[rs]?|guten\s+(?:tag|morgen|abend)|gr(?:ü|ue)e?zi|hallo)(?![\p{L}])/iu,
  fr: /^(?:madame|monsieur|mesdames|messieurs|mademoiselle|ch(?:er|ère)s?|bonjour|bonsoir)(?![\p{L}])/iu,
  en: /^(?:dear|hello|hi|good\s+(?:morning|afternoon|evening)|to\s+whom\s+it\s+may\s+concern)(?![\p{L}])/iu,
};
// The words of a greeting after its opener, on the same line: names and honorifics («Sir/Madam», «sig.ra»), then its punctuation.
const GREETING_TAIL = /^((?:[ \t/]+(?:\p{Lu}[\p{L}\p{M}.'’-]*|(?:sig\.ra|sig\.na|sig\.|dott\.ssa|dott\.|dottoressa|dottore|azienda|ditta|signora|signor|signore|signori|signorina|e|et|und|and|or|hiring|recruiting|team|manager|sir|madam|responsabile|responsable|zusammen)(?![\p{L}])))*)[ \t]*([,:!]?)/u;
// A greeting with words the tail does not know («Gentile responsabile delle risorse umane,», «Dear Hiring
// Team at Esempio SA,»): a short line of its own, one comma at its end, or a colon after the English «Dear»
// (US business style); «Liebe zum Detail und Teamgeist:» is the message.
const GREETING_LINE = /^[^\n,]{0,80},[ \t]*(?=\n|$)/;
const DEAR_LINE = /^dear(?![\p{L}])[^\n,]{0,76}:[ \t]*(?=\n|$)/iu;
// «Liebe» is also a noun («Liebe zum Detail»): a greeting only before an honorific or a capitalised name
// (checked without the case-insensitive flag).
const LIEBE = /^lieb/iu;
const NAME_NEXT = /^[ \t]+(?:\p{Lu}|(?:frau|herr)(?![\p{L}]))/u;
// French opens a sentence about someone the way it greets them («Madame Keller, que j’ai rencontrée…, m’a
// parlé de…»): with a name, a greeting on the message's own line is one only before the message's start.
const FR_COURTESY = new Set(['madame', 'monsieur', 'mesdames', 'messieurs', 'mademoiselle', 'et']);
const FR_MESSAGE_START = /^(?:j['’]|(?:je|vous|suite\s+à|par\s+la\s+présente|c['’]est\s+avec)(?![\p{L}]))/iu;
const BARE_CLOSINGS = {
  it: String.raw`(?:con\s+)?(?:i\s+)?(?:miei\s+)?(?:più\s+)?(?:cordiali|distinti|migliori)\s+saluti|saluti(?:\s+cordiali)?|cordialmente|un\s+cordiale\s+saluto`,
  de: String.raw`(?:mit\s+)?(?:freundliche[nm]?|beste[nm]?|herzliche[nm]?|liebe[nm]?|viele[nm]?)\s+gr(?:ü|ue)(?:ss|ß)(?:e|en)?|(?:mit\s+)?freundliche[mn]?\s+gru(?:ss|ß)|hochachtungsvoll`,
  fr: String.raw`(?:avec\s+)?(?:mes\s+)?(?:meilleures|sincères|cordiales)\s+salutations|salutations(?:\s+distinguées)?|(?:bien\s+)?cordialement|bien\s+à\s+vous`,
  en: String.raw`(?:(?:many\s+thanks|thanks|thank\s+you)\s+and\s+)?(?:with\s+)?(?:(?:kind|kindest|best|warm|warmest)\s+)?regards|yours\s+(?:sincerely|faithfully|truly)|sincerely(?:\s+yours)?|best(?:\s+wishes)?`,
};
// The closing sentences of Italian, French and German letters: «In attesa di un Suo riscontro, porgo cordiali
// saluti.», «Ringrazio per l’attenzione e porgo cordiali saluti.», «Je vous prie d'agréer, Madame, Monsieur,
// mes salutations distinguées.», «Je vous remercie de votre attention et vous prie d'agréer…», «Ich freue mich
// auf Ihre Rückmeldung und grüsse Sie freundlich.», «In Erwartung Ihrer Antwort grüsse ich Sie freundlich.».
// Before «porgo» only courtesies of a closed list, joined by «e», each without a comma or another «e» inside;
// after the first, a courtesy or a second object of it («e per la disponibilità») holds no verb of its own, but
// the wish to meet of a closed list («e sperando di poterLa incontrare»). A line that says more («Grazie per
// l’attenzione, sono disponibile da gennaio, porgo…», «… e sperando di discutere del mio progetto, porgo…», «Ich
// freue mich auf ein persönliches Gespräch und grüsse…») is the candidate's text. In French the formula's own
// verb follows its opener and only words of its noun follow «salutations»: «Je vous prie de bien vouloir
// m’accorder un entretien et de recevoir…» is a request. «Considération» is a closing only in «l'assurance de ma
// considération», never in a request («Veuillez prendre ma candidature en considération»).
const IT_COURTESY_WORD = String.raw`(?:(?:in|nell['’])\s*attesa|nella\s+speranza|(?:(?:la|vi)\s+)?ringrazi\p{L}*|restando|rimanendo|sperando|fiducios[oa]|cert[oa]|con\s+l['’]occasione|cogliendo|grazie)\b`;
// A verb of its own: an infinitive or a gerund, a pronoun attached («discutere», «poterLa», «sperando»);
// «ricevere» is the reply the courtesy waits for («in attesa di ricevere un Suo riscontro»).
const IT_VERB = String.raw`(?<![\p{L}])(?!ricevere(?![\p{L}]))\p{L}*(?:(?:are|ere|ire|ando|endo)(?:mi|ti|ci|vi|si|la|le|lo|li|gli|ne)?|(?:ar|er|ir)(?:mi|ti|ci|vi|si|la|le|lo|li|gli|ne))(?![\p{L}])`;
const itWords = (max, verbs) => String.raw`(?:(?!\s+e\s)${verbs ? '' : `(?!${IT_VERB})`}[^\n,]){0,${max}}?`;
const IT_WISH = String.raw`(?:sperando|nella\s+speranza)\s+di\s+poter(?:la|vi)\s+incontrare(?:\s+(?:(?:al\s+più\s+)?presto|di\s+persona|per\s+un\s+colloquio|in\s+un\s+colloquio)){0,2}`;
const IT_SECOND = String.raw`${IT_WISH}|${IT_COURTESY_WORD}${itWords(120, false)}|(?:per\s+)?(?:(?:il|lo|la|i|gli|le|un|uno|una)(?=\s)|l['’]|un['’])${itWords(40, false)}`;
const IT_COURTESY = String.raw`${IT_COURTESY_WORD}${itWords(120, true)}(?:\s+e\s+(?:${IT_SECOND}))*(?:,\s*|\s+e\s+)`;
const FR_PRIE = String.raw`prie\s+(?:d['’]agréer|de\s+recevoir|de\s+croire|d['’]accepter)`;
const DE_REPLY = String.raw`(?:baldige[n]?\s+|positive[n]?\s+)?(?:r(?:ü|ue)ckmeldung|antwort|nachricht)`;
const DE_GREET = String.raw`gr(?:ü|ue)(?:ss|ß)e`;
const CLOSING_SENTENCES = {
  it: String.raw`(?:${IT_COURTESY})?(?:(?:le|vi)\s+)?porgo\b[^\n]{0,80}?\bsalut[io]|colgo\s+l['’]occasione\s+per\s+porger(?:e|le|vi)\b[^\n]{0,80}?\bsalut[io]`,
  fr: String.raw`(?:(?:(?:dans\s+l['’]attente|en\s+vous\s+remerciant|en\s+attendant)\b[^\n,]{0,160}?,\s*)?(?:je\s+vous\s+${FR_PRIE}|veuillez\s+(?:agréer|recevoir|croire|accepter)|recevez|agréez|je\s+vous\s+adresse)|je\s+vous\s+remercie\b(?:(?!\s+et\s)[^\n,]){0,120}?\s+et\s+vous\s+(?:${FR_PRIE}|adresse))\b[^\n]{0,200}?(?:\b(?:salutations|sentiments)\b|l['’](?:assurance|expression)\s+de\s+ma\s+(?:haute\s+)?considération)(?:\s+(?!et(?![\p{L}]))\p{L}+){0,3}`,
  de: String.raw`(?:(?:ich\s+freue\s+mich\s+(?:sehr\s+)?auf\s+ihre\s+${DE_REPLY}\s+und\s+|ich\s+)?${DE_GREET}|(?:in\s+erwartung\s+ihrer|mit\s+vorfreude\s+auf\s+ihre)\s+${DE_REPLY}\s+${DE_GREET}\s+ich)\s+sie\s+(?:freundlich|herzlich|bestens)`,
};
const closingLine = (language) => {
  const bare = BARE_CLOSINGS[language] || BARE_CLOSINGS.it;
  return new RegExp(String.raw`^(?:${bare}${CLOSING_SENTENCES[language] ? `|${CLOSING_SENTENCES[language]}` : ''})[.,!]?$`, 'iu');
};
const ANY_BARE_CLOSING = new RegExp(String.raw`^(?:${Object.values(BARE_CLOSINGS).join('|')})[.,!]?$`, 'iu');

/** A closing printed on its own above the signature («Cordiali saluti», «Kind regards»), not a sentence. */
export function isBareClosing(text) {
  return ANY_BARE_CLOSING.test(clean(text, 300));
}

/** The text without the greeting it starts with: on its own line, or before a comma («Buongiorno, le scrivo…»). */
function withoutGreeting(text, language) {
  const opener = GREETING_OPENER[language] || GREETING_OPENER.it;
  let rest = String(text || '').replace(/^\s+/, '');
  let found = false;
  // «Madame, Monsieur,», «Gentili signore, egregi signori,»: one opener after the other.
  for (let match = opener.exec(rest); match; match = opener.exec(rest)) {
    if (LIEBE.test(match[0]) && !NAME_NEXT.test(rest.slice(match[0].length))) break;
    const tail = GREETING_TAIL.exec(rest.slice(match[0].length));
    const after = rest.slice(match[0].length + tail[0].length);
    const alone = /^[ \t]*(?:\n|$)/.test(after);
    if (!alone && !tail[2]) {
      const line = GREETING_LINE.exec(rest) || (language === 'en' ? DEAR_LINE.exec(rest) : null);
      if (!line) break;
      rest = rest.slice(line[0].length).replace(/^\s+/, '');
      found = true;
      continue;
    }
    const named = tail[1].split(/[\s/]+/).some((word) => word && !FR_COURTESY.has(word.toLowerCase()));
    if (!alone && language === 'fr' && named && !FR_MESSAGE_START.test(after.replace(/^\s+/, ''))) break;
    rest = after.replace(/^\s+/, '');
    found = true;
  }
  // A text after a greeting starts with a capital, but in Italian (italianStart).
  return found && language !== 'it' && rest ? rest[0].toUpperCase() + rest.slice(1) : rest;
}

const phoneKey = (text) => (/^[+\d\s/().-]{9,}$/.test(text) ? text.replace(/\D/g, '').slice(-9) : '');

/**
 * A line of the signature the code adds below, as the model may have written it: the line itself, the
 * candidate's name words or their initials («Maria», «M. Rossi»), the phone in another format.
 */
function signedBy(line, signature) {
  const own = signature.map((value) => clean(value, 320)).filter(Boolean);
  const lower = line.toLowerCase();
  if (own.some((value) => value.toLowerCase() === lower)) return true;
  if (phoneKey(line) && own.some((value) => phoneKey(value) === phoneKey(line))) return true;
  const names = own.filter((value) => !/[@\d]/.test(value)).flatMap((value) => value.toLowerCase().split(' '));
  return names.length > 0 && lower.replace(/,$/, '').split(' ')
    .every((word) => names.includes(word) || (/^\p{L}\.$/u.test(word) && names.some((name) => name.startsWith(word[0]))));
}

/** The text without the closing lines it ends with, nor the signature the code adds below. */
function withoutClosing(text, language, signature = []) {
  const closing = closingLine(language);
  const lines = String(text || '').split('\n');
  while (lines.length) {
    const line = clean(lines[lines.length - 1], 400);
    if (line && !closing.test(line) && !signedBy(line, signature)) break;
    lines.pop();
  }
  return lines.join('\n').trim();
}

/** The model's letter with the conventions applied: salutation and closing in code, typography fixed. */
export function applyLetterConventions(letter, { language, contactPerson } = {}) {
  const salutation = letterSalutation(language, contactPerson);
  const paragraphs = (letter?.paragraphs || []).map((paragraph) => swissTypography(paragraph, language));
  if (paragraphs.length) paragraphs[0] = withoutGreeting(paragraphs[0], language);
  if (paragraphs.length) paragraphs[paragraphs.length - 1] = withoutClosing(paragraphs[paragraphs.length - 1], language);
  const body = paragraphs.filter(Boolean);
  if (language === 'it' && salutation.endsWith(',') && body.length) body[0] = italianStart(body[0]);
  return { ...letter, salutation, paragraphs: body, closing: letterClosing(language, salutation) };
}

/**
 * The application e-mail before the signature, framed like the letter: its
 * salutation, the model's message, its closing. Composed once, when the draft
 * is written; '' when no message is left. `signature`: the lines the runner
 * adds below, removed if the model wrote them.
 * @param {string} body
 * @param {{language?: string, contactPerson?: string, signature?: string[]}} [options]
 */
export function applicationEmailText(body, { language, contactPerson, signature = [] } = {}) {
  const salutation = letterSalutation(language, contactPerson);
  let message = swissTypography(withoutClosing(withoutGreeting(cleanBlock(body, 3000), language), language, signature), language);
  if (!message) return '';
  if (language === 'it' && salutation.endsWith(',')) message = italianStart(message);
  return [salutation, message, letterClosing(language, salutation)].join('\n\n');
}

// Phrases the Swiss career services and the job portals list as filler (BIZ Bern, SECO, jobs.ch).
// Not «je serais ravi(e) de»: the CSFO's own model letter writes it.
const FILLER_PHRASES = {
  de: [/hiermit bewerbe ich mich/i, /mit (?:(?:sehr )?(?:grossem|großem) )?interesse (?:habe|bin) ich/i, /würde(?: ich)? mich (?:sehr )?(?:über [^.!?\n]{1,80}? )?freuen/i, /neue[nr]? herausforderung/i, /teamplayer/i],
  fr: [/par la présente/i, /je me permets de/i, /nouveau défi/i],
  it: [/con la presente/i, /mi pregio/i, /nuova sfida/i, /team player/i],
  en: [/i am writing to/i, /team player/i, /perfect fit/i, /new challenge/i],
};
const PLACEHOLDER_RE = /\[[^\]\n]{1,40}\]|\{[^}\n]{1,40}\}|<[^>\n]{1,30}>|\bX{3,}\b|\.\.\.\s*$|…\s*$/m;

/**
 * Quality checks of the letter body in code, three outcomes: pass, advisory
 * (filler phrase, length out of 150-380 words) or block (a placeholder left in).
 * @returns {Array<{field:string, kind:string, token:string, context:string, severity:'advisory'|'block'}>}
 */
export function letterQualityIssues(letterBody, language) {
  const text = String(letterBody || '');
  const issues = [];
  const add = (kind, token, severity) => issues.push({ field: 'coverLetter', kind, token, context: '', severity });
  for (const pattern of FILLER_PHRASES[language] || []) {
    const match = pattern.exec(text);
    if (match) add('filler_phrase', match[0], 'advisory');
  }
  const words = text.split(/\s+/).filter(Boolean).length;
  if (words && words < 150) add('too_short', String(words), 'advisory');
  if (words > 380) add('too_long', String(words), 'advisory');
  const placeholder = PLACEHOLDER_RE.exec(text);
  if (placeholder) add('placeholder', placeholder[0].trim(), 'block');
  return issues;
}

/** The letter's recipient as the posting gives it, kept on the draft so every rebuild prints the same address. */
export function letterAddressOf(posting = {}, contactPerson = '') {
  return {
    contactPerson: clean(contactPerson || posting.contactPerson, 200),
    streetAddress: clean(posting.streetAddress, 200),
    postalCode: clean(posting.postalCode, 20),
    location: clean(posting.location, 120),
  };
}

/** What the letter lists under Beilagen/Annexes/Allegati: the CV, then each other document. */
export function letterEnclosures(language, documentLabels = []) {
  return [CV_ENCLOSURE[language] || CV_ENCLOSURE.it, ...documentLabels.map((label) => clean(label, 120)).filter(Boolean)];
}

// What a place line never prints (verification of 2026-10-03: «Viale Varese 5, 3 ottobre 2026»):
// a street, a postal code, a province or canton code, a country.
const STREET_START = /^(?:via|viale|vicolo|piazza|piazzale|corso|largo|strada|contrada|salita|rue|avenue|av\.|chemin|ch\.|route|rte|boulevard|bd|place|impasse|allée|quai|sentier|ruelle|street|road)(?![\p{L}])/iu;
const STREET_END = /(?:strasse|straße|str\.|gasse|weg|platz|ring|allee)$/iu;
const COUNTRIES = new Set(['italia', 'italy', 'italien', 'italie', 'svizzera', 'schweiz', 'suisse', 'switzerland', 'svizra', 'germania', 'deutschland', 'germany', 'allemagne', 'francia', 'frankreich', 'france', 'austria', 'österreich', 'autriche', 'liechtenstein']);
// A province, a canton or a region of the border is no locality («Provincia di Como», «Canton Ticino»,
// «Lombardia», «Aargau»); the cantons named like their town (Zürich, Bern, Luzern…) stay.
const REGION_START = /^(?:provincia|province|provinz|canton|cantone|kanton|regione|région|region)(?![\p{L}])/iu;
const REGIONS = new Set(['lombardia', 'lombardy', 'lombardei', 'lombardie', 'piemonte', 'piedmont', 'piemont', 'piémont', 'ticino', 'tessin', 'grigioni', 'graubünden', 'grisons', 'vallese', 'wallis', 'valais', 'vaud', 'waadt',
  'aargau', 'argovia', 'argovie', 'thurgau', 'turgovia', 'thurgovie', 'jura', 'giura', 'uri', 'obwalden', 'obvaldo', 'obwald', 'nidwalden', 'nidvaldo', 'nidwald',
  'basel-landschaft', 'baselland', 'basel-land', 'basilea campagna', 'bâle-campagne']);

/** The locality a place names: «Viale Varese 5, Como», «22100 Como (CO)» and «Como – Lombardia» are «Como»; «Italia» is ''. */
export function localityOf(text) {
  for (const raw of String(text || '').replace(/\([^)]*\)|\[[^\]]*\]/g, ' ').split(/[,;\n]|\s+[–—-]\s+/)) {
    let part = raw.replace(/\s+/g, ' ').trim()
      .replace(/^(?:[A-Z]{1,2}\s?-\s?)?\d{4,5}\s+/, '')
      .replace(/\s+(?:[A-Z]{1,2}\s?-\s?)?\d{4,5}$/, '');
    // «Via Roma 3 Como», «Via Roma, 3 - Como»: the words after the house number, without the dash.
    if (/\d/.test(part)) part = /\d[\p{L}\d/-]*\s+(\D+)$/u.exec(part)?.[1].replace(/^[\s–—-]+/u, '').trim() || '';
    // «Lugano TI», «Varese VA»: the canton's or the province's code is no part of the locality.
    part = part.replace(/\s+\p{Lu}{2}$/u, '');
    if (part.length < 2 || STREET_START.test(part) || STREET_END.test(part) || COUNTRIES.has(part.toLowerCase()) || /^\p{Lu}{2}$/u.test(part)
      || REGION_START.test(part) || REGIONS.has(part.toLowerCase())) continue;
    return part;
  }
  return '';
}

/**
 * The job title as the letter and the e-mail print it, for the order line the
 * fact gate reads names from: with the typography's protected space («80-100 %»)
 * and, for an apprenticeship, the subject that names the trade («Bewerbung um die
 * Lehrstelle als Informatiker/in EFZ»). Quoted whole each is a name, not a claim;
 * the trade alone is not one, or «Ich bin bereits Informatiker/in EFZ» would pass.
 */
export function printedTitles(language, title, type = '') {
  const subject = type === 'apprentice' ? letterSubject(language, title, type) : '';
  return [...new Set([title, subject].filter(Boolean).flatMap((text) => [text, swissTypography(text, language)]))];
}

/** Swiss business-letter blocks for buildCoverLetterPdf. `type`: the candidate type, for an apprenticeship's subject. */
export function letterPdfBlocks({ identity, profile, posting = {}, companyName, language, letter, title, now, enclosures = [], type = '' }) {
  const location = clean(profile?.location, 200);
  const address = profile?.address || {};
  const addressCity = clean(address.city, 120);
  // The address prints only while the place is still the address's city: a place the
  // candidate corrected on the review page wins over the CV's street.
  const addressCurrent = Boolean(addressCity) && (!location || location.toLowerCase().includes(addressCity.toLowerCase()));
  const street = addressCurrent ? clean(address.street, 200) : '';
  const cityLine = street ? [clean(address.postalCode, 20), addressCity].filter(Boolean).join(' ') : location;
  // The place of the date line is a locality: the address's city while it is current, else the one the place names.
  const place = (addressCurrent && localityOf(addressCity)) || localityOf(location) || localityOf(addressCity);
  // A closing that is a sentence (the French one, or the last paragraph of a letter whose closing the
  // candidate deleted) ends the body; only a bare closing stands above the signature.
  const bare = !letter.closing || isBareClosing(letter.closing);
  return {
    language: language || 'it',
    senderLines: [identity.name, street, cityLine, identity.phone, identity.email],
    recipientLines: [
      clean(companyName, 200),
      posting.contactPerson || '',
      posting.streetAddress || '',
      [posting.postalCode, posting.location].filter(Boolean).join(' '),
    ],
    placeDate: letterPlaceDate(language, place, now),
    subject: swissTypography(letterSubject(language, title, type), language),
    salutation: letter.salutation,
    paragraphs: bare ? letter.paragraphs : [...(letter.paragraphs || []), letter.closing],
    closing: bare ? letter.closing : '',
    signature: identity.name,
    enclosuresLabel: enclosuresLabel(language, enclosures.length),
    enclosures,
    title: `${LETTER_FILE_LABEL[language] || LETTER_FILE_LABEL.it} – ${identity.name}`,
  };
}

export function safeFileStem(value) {
  return clean(value, 80)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'Candidato';
}

/**
 * The initials of each line of the order that has two capitalised words or
 * more: "Ente Ospedaliero Cantonale" is also "EOC", the employer's short name
 * in its own posting, not a tool the letter claims.
 */
export function employerInitials(orderLine) {
  return String(orderLine || '').split('\n')
    .map((line) => line.split(/\s+/).filter((word) => /^\p{Lu}/u.test(word)).map((word) => word[0]).join(''))
    .filter((initials) => initials.length >= 2)
    .join(' ');
}

// The texts where a tool, a figure, an employer or a job title reads as the
// candidate's claim: everything that leaves in the candidate's name, the
// follow-up included (it is written to the employer too; its date and day
// count are in the order line it is checked against). Not `whyCompany` (it
// talks about the employer), nor the interview pack, which stays with the
// candidate and may quote the posting.
const CLAIM_FIELDS = ['coverLetter', 'emailSubject', 'emailBody', 'motivationShort', 'followup'];

/**
 * Fact gate over every text that may leave in the candidate's name.
 *
 * Numbers, e-mails, URLs and phones may come from any source, the posting
 * included. A tool, a certificate or a standard (SAP, ISO 9001, PowerPoint) in
 * the letter or the e-mail is a claim about the candidate, backed only by the
 * candidate's own texts (CV, answers, edits) and by the order line, which
 * holds the company name and the job title exactly as the letter is given them.
 * The posting text backs none: a tool only the posting names, claimed in the
 * letter, is the invention this catches, and nothing in a posting tells an
 * employer's short name from a required tool, so an employer acronym written
 * only there ("EOC" for an order that says "Ente Ospedaliero Cantonale") is
 * flagged for the owner to confirm. The place reaches the letter as the
 * posting's structured location, which is not among the sources; its only
 * tool-shaped part, a canton code, is never a claim (NOT_A_CLAIM).
 */
export function checkDraftFacts(texts, sources) {
  // `candidate`: what the candidate wrote on the review page vouches for itself.
  const candidate = [sources?.text, sources?.answers, sources?.candidate];
  const index = buildFactIndex([sources?.text, sources?.posting, sources?.order, sources?.answers, sources?.candidate], {
    // Only the candidate's own texts back a tool. The order line (company, job title) and the
    // posting's place are names: quoted whole they are not claims, and they never back one
    // ("Kubernetes Engineer" in the title does not make "uso Kubernetes" the candidate's).
    claimSources: [...candidate, employerInitials(sources?.order)],
    nameSources: [sources?.order, sources?.place],
    // A figure in the candidate's own texts comes from the candidate or the order line (the job
    // title with its workload), never from the posting alone (study 2026-10-02: "un team di 5").
    numberSources: [...candidate, sources?.order],
    echoSources: [sources?.posting],
    entitySources: [...candidate, sources?.order, sources?.place, sources?.posting],
  });
  return checkGeneratedFacts(texts, index, { toolFields: CLAIM_FIELDS });
}

/**
 * The fact gate plus the letter's quality checks in code: a placeholder left in
 * blocks like an unsupported fact, filler phrases and the length are advisories.
 */
export function checkDraftTexts(texts, sources, { language } = {}) {
  const facts = checkDraftFacts(texts, sources);
  const issues = letterQualityIssues(texts?.coverLetter, language);
  const unsupported = [...facts.unsupported, ...issues.filter((issue) => issue.severity === 'block').map(({ severity, ...issue }) => issue)];
  const advisories = [...(facts.advisories || []), ...issues.filter((issue) => issue.severity === 'advisory').map(({ severity, ...issue }) => issue)];
  return { ok: unsupported.length === 0, unsupported, advisories };
}
