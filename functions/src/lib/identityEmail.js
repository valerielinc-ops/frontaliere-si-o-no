const IDENTITY_EMAIL_RE = /\b(?:e[-\s]?mail|email|courriel|correo)\b/i;
// The words a form uses to ask the same e-mail a second time, read without
// accents: SuccessFactors' «Retype Email Address» (Damiani, 2026-11-10),
// «E-Mail-Adresse wiederholen», «Conferma e-mail», «Ressaisissez votre e-mail».
const CONFIRMATION_WORDS = [
  're[- ]?enter', 'enter again', 're[- ]?type', 'type again', 'repeat', 'confirm(?:ation)?', 'reconfirm', 'verify', 'verification', 'again',
  'erneut', 'nochmals', 'wiederholen', 'wiederholung', 'bestatigen', 'bestaetigen', 'bestatigung', 'bestaetigung',
  'ripeti', 'ripetere', 'conferma', 'confermare', 'reinserisci', 'reinserire', 'ridigita', 'ridigitare', 'di nuovo', 'verifica',
  'repeter', 'repetez', 'confirmer', 'confirmez', 'ressaisir', 'ressaisissez', 'a nouveau', 'de nouveau', 'verifier', 'verifiez',
  'confirmar', 'repetir',
].join('|');
const EMAIL_CONFIRMATION_RE = new RegExp(`\\b(?:${CONFIRMATION_WORDS})\\b`, 'i');
const BARE_CONFIRMATION_LABEL_RE = new RegExp(`^(?:please |bitte )?(?:${CONFIRMATION_WORDS})$`, 'i');
// «E-Mail-Bestätigungscode», «Email verification code»: what the portal sends
// to the address, never the address itself.
const CODE_RE = /(?:code\b|codice|\btoken|\botp\b|\bpin\b|passcode)/i;
const NON_CANDIDATE_RE = /\b(?:company|employer|organisation|organization|school|institution|university|azienda|datore|scuola|istituto|universit|entreprise|employeur|ecole|arbeitgeber|unternehmen|firma|reference|referee|emergency|contact person|supervisor|manager|recruiter|interviewer)\b/i;
// Accents off before any word test: `\b` does not see a boundary before «à».
const fold = (value) => String(value || '').normalize('NFD').replace(/[̀-ͯ]/g, '');

/**
 * A repeated e-mail field owned by the applicant, excluding contacts/referees.
 * The label says what the field is. The section context lists every sibling
 * label (SuccessFactors: «E-Mail-Adresse wiederholen» next to «Vorname»), so it
 * only completes a label that is a bare «Repeat»/«Bestätigen»; it never turns
 * a name field into an e-mail one.
 */
export function isIdentityEmailConfirmation({ label = '', context = '' } = {}) {
  const ownLabel = fold(label);
  const ownContext = fold(context);
  if (NON_CANDIDATE_RE.test(`${ownLabel} ${ownContext}`) || CODE_RE.test(ownLabel)) return false;
  if (IDENTITY_EMAIL_RE.test(ownLabel)) return EMAIL_CONFIRMATION_RE.test(ownLabel);
  const bareLabel = ownLabel.replace(/[*:]/g, ' ').replace(/\s+/g, ' ').trim();
  return BARE_CONFIRMATION_LABEL_RE.test(bareLabel) && IDENTITY_EMAIL_RE.test(ownContext);
}
