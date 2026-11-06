import { checkDraftTexts, letterText, sanitizeDocuments } from '../../../functions/src/assistedApplicationAiDraftCore.js';

// No new biographical or employer claims: when a rewrite still invents a fact,
// retain the verified paragraphs and replace only the remaining unsafe fields.
const NEUTRAL = {
  it: { salutation: 'Gentili signore e signori,', body: 'Desidero sottoporre alla vostra attenzione la mia candidatura. In allegato trovate il mio curriculum. Resto a disposizione per un colloquio.', subject: 'Candidatura', closing: 'Cordiali saluti', motivation: 'Desidero presentare la mia candidatura.' },
  de: { salutation: 'Sehr geehrte Damen und Herren', body: 'Hiermit möchte ich mich bei Ihnen bewerben. Meinen Lebenslauf finden Sie im Anhang. Für ein persönliches Gespräch stehe ich gerne zur Verfügung.', subject: 'Bewerbung', closing: 'Freundliche Grüsse', motivation: 'Ich möchte mich bei Ihnen bewerben.' },
  fr: { salutation: 'Madame, Monsieur,', body: 'Je souhaite vous soumettre ma candidature. Vous trouverez mon curriculum vitae en pièce jointe. Je reste à votre disposition pour un entretien.', subject: 'Candidature', closing: 'Meilleures salutations', motivation: 'Je souhaite vous soumettre ma candidature.' },
  en: { salutation: 'Dear Hiring Team,', body: 'I would like to submit my application. Please find my CV attached. I am available for an interview.', subject: 'Application', closing: 'Kind regards', motivation: 'I would like to submit my application.' },
};

export function repairApplicationDocuments(input, sources, { language = 'it', emailSubject } = {}) {
  const documents = sanitizeDocuments(input);
  const neutral = NEUTRAL[language] || NEUTRAL.it;
  const check = (field, text) => checkDraftTexts({ [field]: text }, sources, { language }).ok;
  const removed = [];
  for (const key of ['salutation', 'closing']) {
    if (!check('coverLetter', documents.coverLetter[key])) {
      documents.coverLetter[key] = neutral[key];
      removed.push(`coverLetter.${key}`);
    }
  }
  documents.coverLetter.paragraphs = documents.coverLetter.paragraphs.filter((text, index) => {
    if (check('coverLetter', text)) return true;
    removed.push(`coverLetter.paragraphs.${index}`);
    return false;
  });
  if (!documents.coverLetter.paragraphs.length) documents.coverLetter.paragraphs = [neutral.body];
  for (const field of ['emailBody', 'motivationShort', 'whyCompany']) {
    if (check(field, documents[field])) continue;
    removed.push(field);
    documents[field] = field === 'emailBody' ? neutral.body : field === 'motivationShort' ? neutral.motivation : '';
  }
  const subject = check('emailSubject', emailSubject || documents.emailSubject) ? emailSubject || documents.emailSubject : neutral.subject;
  if (subject !== (emailSubject || documents.emailSubject)) removed.push('emailSubject');
  const factCheck = checkDraftTexts({
    coverLetter: letterText(documents.coverLetter), emailBody: documents.emailBody,
    emailSubject: subject, motivationShort: documents.motivationShort, whyCompany: documents.whyCompany,
  }, sources, { language });
  return { documents, letterBody: letterText(documents.coverLetter), emailSubject: subject, factCheck, removed };
}
