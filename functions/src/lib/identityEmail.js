const IDENTITY_EMAIL_RE = /\b(?:e[-\s]?mail|email|courriel|correo)\b/i;
const EMAIL_CONFIRMATION_RE = /\b(?:re[- ]?enter|enter again|repeat|confirm(?:ation)?|again|erneut|wiederholen|bestätigen|bestaetigen|nochmals|ripeti|conferma|répéter|repeter|confirmer|à nouveau|de nouveau)\b/i;
const NON_CANDIDATE_RE = /\b(?:company|employer|organisation|organization|school|institution|university|azienda|datore|scuola|istituto|universit|entreprise|employeur|école|arbeitgeber|unternehmen|firma|reference|referee|emergency|contact person|supervisor|manager|recruiter|interviewer)\b/i;

/** A repeated e-mail field owned by the applicant, excluding contacts/referees. */
export function isIdentityEmailConfirmation({ label = '', context = '' } = {}) {
  const text = `${String(label || '')} ${String(context || '')}`;
  return IDENTITY_EMAIL_RE.test(text)
    && EMAIL_CONFIRMATION_RE.test(text)
    && !NON_CANDIDATE_RE.test(text);
}
