/**
 * Pure helpers of the assisted-application AI draft, shared by the GitHub
 * Actions runner (scripts/assisted-application/) and the owner queue in the
 * Cloud Functions (edits of the draft re-render the letter and re-run the
 * fact gate). No I/O here.
 */

import { buildFactIndex, checkGeneratedFacts } from './assistedApplicationAiFactCheck.js';
import { sanitizeValidation } from './lib/answerRules.js';
import { formatLetterDate, letterSubject } from './assistedApplicationAiPrompts.js';

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
// Lugano): German without a comma after the salutation and the closing,
// French "Madame, Monsieur," and "Meilleures salutations", Italian "Gentile
// signora …," then a lowercase start, and "Cordiali saluti". The salutation and
// the closing are written here, never by the model.

export const LETTER_CLOSING = {
  it: 'Cordiali saluti',
  de: 'Freundliche Grüsse',
  fr: 'Meilleures salutations',
  en: 'Kind regards',
};

export const ENCLOSURES_LABEL = { it: 'Allegati', de: 'Beilagen', fr: 'Annexes', en: 'Enclosures' };
export const CV_ENCLOSURE = { it: 'Curriculum vitae', de: 'Lebenslauf', fr: 'CV', en: 'CV' };

const HONORIFIC_FEMALE = /^(?:frau|madame|mme\.?|signora|sig\.ra|dott\.ssa|ms\.?|mrs\.?)\s+/i;
const HONORIFIC_MALE = /^(?:herr|monsieur|m\.|signor|signore|sig\.|dott\.|mr\.?)\s+/i;
const ACADEMIC = /^(?:dr\.?|prof\.?|dott\.?)\s+/i;
const SURNAME_PARTICLES = new Set(['de', 'di', 'da', 'del', 'della', 'dal', 'dalla', 'von', 'van', 'der', 'den', 'du', 'des', 'le', 'la', 'lo', 'dos', 'das']);

/**
 * The salutation for the contact person the posting names. The gender comes
 * only from an honorific the posting wrote ("Frau", "Monsieur", "signora"),
 * never from the first name; without one the form stays neutral.
 */
export function letterSalutation(language, contactPerson = '') {
  let rest = clean(contactPerson, 200).replace(/[,;].*$/, '');
  let gender = '';
  if (HONORIFIC_FEMALE.test(rest)) { gender = 'f'; rest = rest.replace(HONORIFIC_FEMALE, ''); }
  else if (HONORIFIC_MALE.test(rest)) { gender = 'm'; rest = rest.replace(HONORIFIC_MALE, ''); }
  rest = rest.replace(ACADEMIC, '').trim();
  // The last name with its particles ("de Luca", "von Arx", "van der Berg").
  const words = rest.split(' ').filter(Boolean);
  let first = words.length - 1;
  while (first > 1 && SURNAME_PARTICLES.has(words[first - 1].toLowerCase())) first -= 1;
  const surname = words.slice(Math.max(first, 0)).join(' ');
  const named = Boolean(surname) && /\p{L}/u.test(surname);
  switch (language) {
    case 'de':
      if (named && gender) return gender === 'f' ? `Sehr geehrte Frau ${surname}` : `Sehr geehrter Herr ${surname}`;
      return named ? `Guten Tag ${rest}` : 'Sehr geehrte Damen und Herren';
    case 'fr':
      if (gender) return gender === 'f' ? 'Madame,' : 'Monsieur,';
      return 'Madame, Monsieur,';
    case 'en':
      if (named && gender) return gender === 'f' ? `Dear Ms ${surname},` : `Dear Mr ${surname},`;
      return named ? `Dear ${rest},` : 'Dear Sir or Madam,';
    default:
      if (named && gender) return gender === 'f' ? `Gentile signora ${surname},` : `Gentile signor ${surname},`;
      return named ? `Gentile ${rest},` : 'Gentili signore, egregi signori,';
  }
}

// Italian words a letter's first paragraph often starts with; after "Gentile …," they take a lowercase letter.
const IT_LOWERCASE_START = new Set('sono ho mi vi le la lo con in da dopo durante lavoro sviluppo attualmente grazie desidero vorrei da dal dalla nel nella seguo ricopro mi chiamo come'.split(' '));

/** Swiss typography: no "ß" in German, no line break inside "81 %" or "CHF 80'000". */
export function swissTypography(text, language) {
  let out = String(text ?? '');
  if (language === 'de') out = out.replace(/ß/g, 'ss');
  if (language === 'de' || language === 'fr') out = out.replace(/(\d)[  ]?%/g, '$1 %');
  else out = out.replace(/(\d) %/g, '$1 %');
  return out.replace(/\b(CHF|EUR|Fr\.)\s+(?=\d)/g, '$1 ');
}

/** The model's letter with the conventions applied: salutation and closing in code, typography fixed. */
export function applyLetterConventions(letter, { language, contactPerson } = {}) {
  const paragraphs = (letter?.paragraphs || []).map((paragraph) => swissTypography(paragraph, language));
  const salutation = letterSalutation(language, contactPerson);
  if (language === 'it' && salutation.endsWith(',') && paragraphs.length) {
    const first = paragraphs[0];
    const word = (first.match(/^\p{L}+/u) || [''])[0];
    if (IT_LOWERCASE_START.has(word.toLowerCase())) paragraphs[0] = first[0].toLowerCase() + first.slice(1);
  }
  return { ...letter, salutation, paragraphs, closing: LETTER_CLOSING[language] || LETTER_CLOSING.it };
}

// Phrases the Swiss career services and the job portals list as filler (BIZ Bern, SECO, jobs.ch).
const FILLER_PHRASES = {
  de: [/hiermit bewerbe ich mich/i, /mit (?:grossem|großem) interesse habe ich/i, /ich würde mich (?:sehr )?freuen/i, /neue herausforderung/i, /teamplayer/i],
  fr: [/par la présente/i, /je me permets de/i, /nouveau défi/i, /je serais (?:ravie?|heureux|heureuse) de/i],
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

/** Swiss business-letter blocks for buildCoverLetterPdf. */
export function letterPdfBlocks({ identity, profile, posting = {}, companyName, language, letter, title, now, enclosures = [] }) {
  const location = clean(profile?.location, 200);
  const address = profile?.address || {};
  const addressCity = clean(address.city, 120);
  // The street prints only while the place is still the address's city: a place the
  // candidate corrected on the review page wins over the CV's street.
  const street = addressCity && (!location || location.toLowerCase().includes(addressCity.toLowerCase())) ? clean(address.street, 200) : '';
  const cityLine = street ? [clean(address.postalCode, 20), addressCity].filter(Boolean).join(' ') : location;
  const city = (location.split(/[,(]/)[0].replace(/^via\s.*$/i, '').trim()) || addressCity;
  const date = formatLetterDate(language, now);
  return {
    language: language || 'it',
    senderLines: [identity.name, street, cityLine, identity.phone, identity.email],
    recipientLines: [
      clean(companyName, 200),
      posting.contactPerson || '',
      posting.streetAddress || '',
      [posting.postalCode, posting.location].filter(Boolean).join(' '),
    ],
    placeDate: city ? `${city}, ${date}` : date,
    subject: letterSubject(language, title),
    salutation: letter.salutation,
    paragraphs: letter.paragraphs,
    closing: letter.closing,
    signature: identity.name,
    enclosuresLabel: ENCLOSURES_LABEL[language] || ENCLOSURES_LABEL.it,
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
