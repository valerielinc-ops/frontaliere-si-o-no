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
      highlights: list(item?.highlights, 6).map((line) => clean(line, 400)).filter(Boolean),
    })),
    education: list(raw?.education, 10).map((item) => ({
      degree: clean(item?.degree, 200), institution: clean(item?.institution, 200), start: clean(item?.start, 40), end: clean(item?.end, 40),
    })),
    certifications: list(raw?.certifications, 20).map((item) => clean(item, 200)).filter(Boolean),
    cvLanguage: clean(raw?.cvLanguage, 5).toLowerCase(),
  };
}

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

/** Swiss business-letter blocks for buildCoverLetterPdf. */
export function letterPdfBlocks({ identity, profile, posting = {}, companyName, language, letter, title, now }) {
  const location = clean(profile?.location, 200);
  const city = location.split(/[,(]/)[0].replace(/^via\s.*$/i, '').trim();
  const date = formatLetterDate(language, now);
  return {
    senderLines: [identity.name, location, identity.email, identity.phone],
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

// The texts where a tool reads as the candidate's claim. Not `whyCompany`
// (it talks about the employer), nor the interview pack or the follow-up,
// which go through this gate with their own fields.
const CLAIM_FIELDS = ['coverLetter', 'emailSubject', 'emailBody', 'motivationShort'];

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
  const index = buildFactIndex([sources?.text, sources?.posting, sources?.order, sources?.answers, sources?.candidate], {
    claimSources: [sources?.text, sources?.order, sources?.answers, sources?.candidate, employerInitials(sources?.order)],
  });
  return checkGeneratedFacts(texts, index, { toolFields: CLAIM_FIELDS });
}
