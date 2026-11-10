const IDENTITY_EMAIL_RE = /\b(?:e[-\s]?mail|email|courriel|correo)\b/i;
const CONFIRMATION_WORDS = 're[- ]?enter|enter again|repeat|confirm(?:ation)?|again|erneut|wiederholen|bestätigen|bestaetigen|nochmals|ripeti|conferma|répéter|repeter|confirmer|à nouveau|de nouveau';
const EMAIL_CONFIRMATION_RE = new RegExp(`\\b(?:${CONFIRMATION_WORDS})\\b`, 'i');
const BARE_CONFIRMATION_LABEL_RE = new RegExp(`^(?:please |bitte )?(?:${CONFIRMATION_WORDS})$`, 'i');
const NON_CANDIDATE_RE = /\b(?:company|employer|organisation|organization|school|institution|university|azienda|datore|scuola|istituto|universit|entreprise|employeur|école|arbeitgeber|unternehmen|firma|reference|referee|emergency|contact person|supervisor|manager|recruiter|interviewer)\b/i;

/**
 * A repeated e-mail field owned by the applicant, excluding contacts/referees.
 * The label says what the field is. The section context lists every sibling
 * label (SuccessFactors: «E-Mail-Adresse wiederholen» next to «Vorname»), so it
 * only completes a label that is a bare «Repeat»/«Bestätigen»; it never turns
 * a name field into an e-mail one.
 */
export function isIdentityEmailConfirmation({ label = '', context = '' } = {}) {
  const ownLabel = String(label || '');
  const text = `${ownLabel} ${String(context || '')}`;
  if (NON_CANDIDATE_RE.test(text)) return false;
  if (IDENTITY_EMAIL_RE.test(ownLabel)) return EMAIL_CONFIRMATION_RE.test(text);
  const bareLabel = ownLabel.replace(/[*:]/g, ' ').replace(/\s+/g, ' ').trim();
  return BARE_CONFIRMATION_LABEL_RE.test(bareLabel) && IDENTITY_EMAIL_RE.test(String(context || ''));
}
