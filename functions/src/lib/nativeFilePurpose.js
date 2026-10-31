/** Closed upload purposes shared by Node, Functions and generated browser code.
 * These describe what the native file control requests, never what a file proves.
 */
import { nativeQuestionText } from './nativeQuestionText.js';
import { nativeFieldFromContract, nativeScopeAllows } from './nativeFormContract.js';

export const NATIVE_FILE_PURPOSE_VERSION = 'native-file-purpose-v2';
export const NATIVE_DOCUMENT_TRANSPORT_VERSION = 'server-native-document-transport-v1';

/** Closed native purposes only; extra qualifications or instructions are not transport. */
export function nativeApprovedDocumentPurpose(value) {
  const text = nativeQuestionText(value).replace(/[＊*]+/gu, '').trim();
  if (/^(?:(?:please |bitte |carica |inserisci |veuillez )?(?:your |ihr(?:e|en)? |la (?:tua|vostra) |votre )?)?(?:cover(?:ing)? letter|letter of motivation|motivation(?:al)? letter|motivation|motivationsschreiben|bewerbungsschreiben|anschreiben|motivazione|lettera (?:di motivazione|motivazionale|di presentazione)|lettre (?:de motivation|de présentation))[:?!.]?$/iu.test(text)) return 'motivation';
  if (/^(?:why (?:do you (?:want to work|wish to work)|would you like to work) (?:for|at|with) (?:us|our company)|why (?:our company|this company)|warum (?:möchten|wollen) sie (?:bei uns|für uns|in unserem unternehmen) arbeiten|perché (?:vuoi|desideri|vorresti|vuole|desidera) lavorare (?:con noi|per noi|nella nostra azienda)|pourquoi (?:souhaitez-vous|voulez-vous) travailler (?:chez nous|pour notre entreprise))[:?!.]?$/iu.test(text)) return 'whyCompany';
  return '';
}

/** One complete caption, with every recognised educational qualifier retained. */
export function nativeFilePurposeCaption(value) {
  if (typeof value !== 'string' || value.length > 8000) return null;
  const text = nativeQuestionText(value).replace(/[＊*]+/gu, '').trim();
  const caption = text.replace(/^(?:(?:upload|attach|please upload|please attach|carica|allega|inserisci|hochladen|bitte hochladen|veuillez joindre|joindre|téléverser)\s+)?(?:(?:your|my|il tuo|la tua|vostro|vostra|ihr(?:e|en)?|votre)\s+)?/iu, '')
    .replace(/[:?!.]$/u, '').trim();
  if (/^(?:cv|résumé|resume|curriculum(?: vitae)?|lebenslauf)$/iu.test(caption)) return { family: 'cv', constraints: {} };
  if (nativeApprovedDocumentPurpose(text) === 'motivation') return { family: 'cover_letter', constraints: {} };
  if (/^(?:diplomas?|diplomi|diplom[ae]?|abschlusszeugnis|diplômes?)$/iu.test(caption)) return { family: 'diploma', constraints: {} };
  if (/^(?:degree certificates?|university diplomas?|academic diplomas?|diplom[ai] di laurea|certificat[oi] di laurea|hochschuldiplom|universitätsdiplom|hochschulabschlusszeugnis|diplômes? universitaires?)$/iu.test(caption)) return { family: 'diploma', constraints: { educationalScope: 'university' } };
  return null;
}

export const nativeApprovedFilePurpose = value => nativeFilePurposeCaption(value)?.family || '';

/** A whole document instruction is a set of transport requests, never a
 * candidate assertion. Every item and every remaining word must be recognised.
 */
export function nativeDocumentInstruction(value) {
  if (typeof value !== 'string' || !value || value.length >= 8000 || /(?:\.{2,}|…)/u.test(value)) return null;
  let text = nativeQuestionText(value);
  let framed = false;
  const instruction = /^(?:please )?(?:(?:click(?: on)?|select) (?:"apply(?: now)?"|'apply(?: now)?'|“apply(?: now)?”|‘apply(?: now)?’|«apply(?: now)?») to )?(?:submit|send|provide|upload) (?:a |your )?(?:complete )?application,? (?:including|with|containing) (.+)$/iu.exec(text);
  const heading = /^(?:application documents|required documents|supporting documents|documents(?: required| to submit| to upload)?|documenti(?: di candidatura| richiesti| da allegare)?|bewerbungsunterlagen|erforderliche unterlagen|benötigte dokumente|dokumente|documents de candidature|documents requis|documents à fournir)\s*:\s*(.+)$/iu.exec(text);
  if (instruction || heading) { text = (instruction || heading)[1]; framed = true; }
  text = text.replace(/\.$/u, '').trim();
  const parts = text.split(/\s*,\s*(?:(?:and|und|et|e)\s+)?|\s+(?:and|und|et|e)\s+/iu);
  if ((!framed && parts.length < 2) || parts.length > 16 || parts.some(part => !part.trim())) return null;
  const purposes = [];
  const families = new Set();
  for (const part of parts) {
    const purpose = nativeFilePurposeCaption(part)
      || (/^(?:(?:work )?references?|(?:work )?reference letters?|referenze(?: di lavoro)?|referenzen|arbeitszeugnis(?:se)?|références|certificats? de travail)$/iu.test(part)
        ? { family: 'reference_document', constraints: {} } : null);
    if (!purpose || families.has(purpose.family)) return null;
    families.add(purpose.family);
    purposes.push(purpose);
  }
  return { purposes };
}

/** Requires a complete, validated native contract. Unknown or competing owned
 * scopes cannot be discarded merely because the control's own label is clear.
 */
export function nativeFilePurposeContract(native) {
  const field = nativeFieldFromContract(native);
  if (!field || native.kind !== 'file' || native.controlType !== 'file') return null;
  const purpose = nativeFilePurposeCaption(native.question);
  if (!purpose) return null;
  const constraints = { ...purpose.constraints };
  try {
    if (!nativeScopeAllows(field, text => {
      const caption = nativeFilePurposeCaption(text);
      const contexts = caption ? [caption] : nativeDocumentInstruction(text)?.purposes || [];
      const matching = contexts.filter(contextual => contextual.family === purpose.family);
      if (matching.length !== 1) return false;
      const contextual = matching[0];
      for (const [key, value] of Object.entries(contextual.constraints)) {
        if (constraints[key] != null && constraints[key] !== value) return false;
        constraints[key] = value;
      }
      return true;
    })) return null;
  } catch { return null; }
  return { family: purpose.family, constraints };
}
