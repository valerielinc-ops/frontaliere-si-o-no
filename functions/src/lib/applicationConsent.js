import { NATIONALITY_FIELD_RE, WORK_AUTHORISATION_RE } from './permitStatus.js';

// The one reading of what an application's own notice asks: a required box
// (plan.mjs, ownConsent) and a control or dialog of a notice (portal.mjs) both
// ask here. What this language does not cover stays unknown.

// A soft hyphen or a zero-width mark splits a word only for a reader of code points.
const plain = value => String(value || '').replace(/\p{Cf}/gu, '').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/['’`]/g, ' ').replace(/\s+/g, ' ').trim();
const PRIVACY = /privacy|datenschutz|datenverarbeitung|data protection|data processing|processing (?:of )?(?:(?:my|your|the|personal) )*data|protezione (?:dei )?dati|trattamento (?:(?:dei|di|miei|tuoi|propri) )*dati|informativa|protection des donnees|traitement (?:(?:de|des|mes|vos) )*donnees|confidentialite/;
const APPLICATION_TERMS = /(?:application|bewerbung|candidatur[ae]).{0,100}(?:terms|conditions|bedingungen|agb|termini|condizioni)|(?:terms|conditions|bedingungen|agb|termini|condizioni).{0,100}(?:application|bewerbung|candidatur[ae])/;
const NEGATED = /\b(?:do(?:es)? not|don t|doesn t|cannot|can t|can not|unable to|not able to|will not|won t|shall not|shan t) (?:accept|agree|consent)|\b(?:non|nein|nicht) (?:accett|acconsent|accept|agree|consent|akzept|stimm)|\bn accepte pas|\b(?:accepte|akzeptiere|stimme) (?:pas|nicht)|\b(?:refus\w*|rifiut[oa]|verweiger\w*)\b/;

const OTHER_TERMS = /vermittlungsburo|personalvermittl|placement agency|recruit(?:ment|ing) agency|staffing agency|agenzia (?:per il lavoro|di collocamento|interinale)|agence (?:de placement|de recrutement)|erfolgsbasis|success fee|membership|subscription|abonnement|abbonamento|purchase|purchasing|agency terms|commercial terms|conditions de vente|condizioni di vendita|verkaufsbedingungen|credit check|background check|medical examination|drug test/;
const factSource = String.raw`permit|bewilligung|permesso di (?:lavoro|soggiorno|domicilio)|\bvisa\b|passport|passaport|passeport|reisepass|ausweis|patente|f[üu]hrerschein|fahrausweis|driving licen[cs]e|permis de (?:conduire|travail|séjour)|\b[abc][12]\b|years? of|berufserfahrung|anni di esperienza|ann[ée]es d.exp[ée]rience|strafregister|casellario|criminal|\bdiplom|\bdegree\b|abschluss|\blaurea\b|certificat|attestat|zeugnis|\bexperience\b|\berfahrung\b|\besperienza\b|qualification|requirements|voraussetzungen|requisiti|maggiorenn|volljahr|\bmajeur\b|\bover\s+18\b`;
// Do not reuse the broad field-role regex here: bare «naissance» also occurs
// inside the harmless French «connaissance» acknowledgement wording.
const BIRTH_FACT_SOURCE = String.raw`\bbirth(?:day|date|place)?\b|\bgeburts?(?:datum|tag|ort|land)?\b|\bnascita\b|\bnat[oa]\b|\bnaissance\b`;
const FACTS = new RegExp([factSource, BIRTH_FACT_SOURCE, NATIONALITY_FIELD_RE.source, WORK_AUTHORISATION_RE.source].join('|'), 'i');
const ACCURACY = /(?:information|details|answers|angaben|informationen|dati|informazioni|renseignements).{0,80}(?:true|accurate|correct|complete|truthful|wahr|richtig|vollstandig|veritier|corrett|veriti|esatt|sincere|exact|complet)/;
const GENERIC_TERMS = /\bterms\b|nutzungsbedingungen|teilnahmebedingungen|\bagb\b|termini|condizioni|conditions generales|conditions d utilisation/;

// A privacy word is not authority for the rest of a sentence. Every word
// must stay in the closed language of reading/accepting this notice.
// New declarations, qualifications or other purposes remain unknown.
const PRIVACY_WORDS = new Set(`i me my myself you your yours we our the a an and or to of for in on by with under as per that this these have has having am are is been be it its here hereby do yes please kindly read reading review reviewed understood understand acknowledge acknowledged acknowledgment consent consenting accept accepts accepted accepting agree agreed agreement clicking click confirming confirm accordance pursuant subject comply complies provided provide provision provisions required mandatory erforderlich pflichtfeld obbligatorio obbligatoria obligatoire obligatorisch terms conditions application applications candidate candidates applicant applicants applying privacy policy policies statement statements notice notices protection processing process processed collection collected collecting storage storing stored electronic electronically personal data information handling use using accordance
  io ho do permesso me mia mie miei mio tu tuo tua tuoi tue noi nostri nostri il lo la le gli l dei degli delle della dello dell di del al alla allo all ai agli alle a da dal dalla sul sulla in con su per e ed o secondo sensi disposizioni materia si prega ti vi preghiamo favore accetto accetta accetti accettate accettare accettazione acconsento consenso consento autorizzo autorizzazione letto letta leggere leggi legga leggete leggo lettura prendi prenda prendere compreso compresa comprendo preso visione informativa dichiarazione trattamento trattati trattare protezione dati personali memorizzazione elettronica elettronico conservazione candidatura candidature candidato candidati condizioni termini sensi
  ich mir mich mein meine meiner meinen meines du dir dich dein deine ihrer ihre ihren ihrem sie wir uns unser unsere der die das des den dem ein eine einer eines einem einen und oder zu zur zum von im in am an fur mit nach gemaess gemass laut dass diese dieser dieses diesen hiermit bitte habe haben gelesen lesen lese lies verstanden verstehe akzeptiere akzeptieren akzeptiert stimme stimmen zustimmen zustimmung einwillige einwilligung einverstanden erklarung erklarungen datenschutz datenschutzerklarung datenschutzerklaerung datenschutzhinweis datenschutzhinweise datenschutzbestimmungen datenschutzrichtlinie datenschutzrichtlinien datenschutzinformation datenschutzinformationen datenschutzmitteilung daten personenbezogenen personenbezogener personlichen verarbeitung verarbeiten speicherung elektronischen elektronischer elektronische bewerbung bewerbungen bewerber bewerberin nutzungsbedingungen bewerbungsbedingungen hinweise bestimmungen
  je moi mon ma mes me vous votre vos nous nos le la les l de des du d au aux a par pour en avec sur et ou que cette ce ces j ai lu lire lis lisez veuillez merci prenez prendre pris prise connaissance compris comprends accepte acceptez accepter acceptation consens consentement autorise autorisation conformement dispositions matiere politique declaration confidentialite protection traitement donnees personnelles conservation electronique candidature candidatures candidat candidats conditions generales utilisation`.split(/\s+/));
const positiveLanguage = value => plain(value).replace(/&/g, ' and ').split(/[^a-z0-9]+/).filter(Boolean).every(word => PRIVACY_WORDS.has(word));

export const isConsentPurpose = value => {
  const text = plain(value);
  const privacyShape = privacyReviewAcknowledgmentShape(value);
  return Boolean(isPrivacyReviewAcknowledgment(value)
    || (!privacyShape.shape && text && positiveLanguage(text) && !NEGATED.test(text) && !FACTS.test(text)
      && !OTHER_TERMS.test(text) && !ACCURACY.test(text)
      && (PRIVACY.test(text) || APPLICATION_TERMS.test(text))
      && !isOptionalPurpose(text)));
};
const applicationPurpose = text => isConsentPurpose(text) && (!GENERIC_TERMS.test(text) || APPLICATION_TERMS.test(text));

// A control that asks to read and accept, in the tenant's words: both verbs of
// one language, in order, in one clause, the notice before, after or between
// them. What is accepted is judged by the purpose above, as for a required box.
const NOTICE_REQUEST = new RegExp([
  ['lies|lese|lesen', 'und', 'akzeptiere|akzeptieren|stimme|stimmen|zustimmen'],
  ['leggi|legga|leggete|leggere|leggo|prendi visione|prenda visione|prendere visione', 'e|ed', 'accetta|accetti|accettate|accettare|accetto'],
  ['lis|lisez|lire|prenez connaissance|prendre connaissance', 'et', 'accepte|acceptez|accepter|j accepte'],
  ['read|review', 'and', 'accept|agree'],
].map(([read, join, accept]) => `(?<![a-z0-9])(?:${read})(?: [^.!?;:]{0,80}?)??(?: (?:${join}) | ?[&+] ?)(?:${accept})(?![a-z0-9])`).join('|'));
export const isNoticeRequest = value => NOTICE_REQUEST.test(plain(value));
// Self-contained so the extension serializes this exact guard, without a second vocabulary.
export function isOptionalPurpose(...values) {
  const text = values.join(' ').replace(/\p{Cf}/gu, '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/['’`]/g, ' ').replace(/\s+/g, ' ').trim();
  return /newsletter|marketing|\bwerbung\b|pubblicit|promozion|promotion|offerte|angebote|job.?alert|job.?abo|talent.?pool|future (?:openings|opportunities|positions|vacancies)|other (?:companies|vacancies|positions)|weitere stellen|andere stellen|altre (?:posizioni|offerte|societa)|autres (?:postes|offres|societes)|third part|dritte|\bterzi\b|\btiers\b|whatsapp|cookie|(?:shar(?:e|ed|ing)|disclos(?:e|ed|ing|ure)|transfer(?:red|ring)?)(?: [^.!?;:\r\n]{0,60})? (?:with|to) (?:(?:a|our|selected|trusted|commercial|third party|other) )*partners?\b|(?:weitergabe|weitergeben|teilen|ubermittlung|ubermitteln)(?: [^.!?;:\r\n]{0,60})? (?:an|mit) (?:(?:die|den|unsere|unseren|ausgewahlte|ausgewahlten) )*partner(?:firmen|unternehmen|n)?\b|(?:condivisione|condividere|condivido|condividi|condividiamo|trasmissione|trasmettere)(?: [^.!?;:\r\n]{0,60})? (?:con|ai|a) (?:(?:i|le|nostri|nostre|selezionati|selezionate) )*partner\b|(?:partage|partager|transmission|transmettre)(?: [^.!?;:\r\n]{0,60})? (?:avec|aux|a) (?:(?:nos|les|des|leurs) )*partenaires?\b/.test(text);
}
/** The notice this application needs. A bare «Lesen und akzeptieren» takes its object only from a name bound to the control. */
export const isRequiredNotice = control => {
  const text = plain(control?.text);
  if (!NOTICE_REQUEST.test(text) || isOptionalPurpose(control.ownLabel, control.label, control.title, control.ariaLabel)) return false;
  const named = PRIVACY.test(text) || APPLICATION_TERMS.test(text);
  return applicationPurpose(named ? text : plain(`${text} ${control.ownLabel || ''} ${control.label || ''}`));
};
/** A dialog names itself, by its own title or its own review box: never by the page around it. */
export const isNoticeDialog = (title, review = '') => {
  if (isOptionalPurpose(title, review)) return false;
  // A known review cannot overrule an unrelated title; an unnamed dialog may name itself by its review.
  return (!plain(title) || isConsentPurpose(title)) && (isConsentPurpose(title) || isConsentPurpose(review));
};
/** A review box says only that the notice was read and accepted: no fact, no refusal, no other purpose. */
// Native identifiers may contradict a privacy-looking label. Their technical words
// never provide consent authority, but explicit factual roles must not be ignored.
export const consentContradictionPatterns = Object.freeze({ negated: NEGATED, facts: FACTS, otherTerms: OTHER_TERMS, accuracy: ACCURACY });
/**
 * The closed identifier contract shared by native questions and the injected
 * consumer. Only scalar metadata is admitted; unknown objects are ignored so
 * a contract can never become the literal string "[object Object]".
 * Nested native contracts are read because legacy descriptors preserve their
 * evidence there rather than at the question's top level.
 */
export const privacySemanticIdentifierFields = Object.freeze([
    'name', 'id', 'fieldId', 'controlId', 'nativeControlId', 'nativeSelectId',
    'semanticId', 'autocomplete', 'domId', 'dataAutomationId', 'dataControlId',
    'dataSemanticId', 'elementId', 'nativeFieldId',
]);
export function privacySemanticIdentifiers(...sources) {
  const keys = privacySemanticIdentifierFields;
  const nestedKeys = ['portalNativeContract', 'originalNativeContract', 'nativeContract'];
  const values = [];
  const seen = new Set();
  const add = value => {
    if (!['string', 'number'].includes(typeof value)) return;
    const normalized = String(value).normalize('NFKC').replace(/\p{Cf}/gu, '').trim();
    if (!normalized) return;
    // A bare CEFR token is ambiguous in an opaque DOM identifier such as `c1`.
    if (/^[abc][12]$/i.test(normalized)) return;
    const key = normalized.toLocaleLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    values.push(normalized);
  };
  const visit = source => {
    if (source == null) return;
    if (['string', 'number'].includes(typeof source)) { add(source); return; }
    if (typeof source !== 'object' || Array.isArray(source)) return;
    for (const key of keys) add(source[key]);
    for (const key of nestedKeys) visit(source[key]);
  };
  sources.forEach(visit);
  return values;
}
export function hasConsentContradiction(value, ...semanticIds) {
  const context = [];
  let incompleteMetadata = false;
  const visitContext = source => {
    if (!source || typeof source !== 'object' || Array.isArray(source)) return;
    if (source.privacyMetadataIncomplete === true) incompleteMetadata = true;
    for (const key of ['ariaLabel', 'ariaDescription', 'title', 'placeholder', 'description']) {
      const item = source[key];
      if (typeof item === 'string' || typeof item === 'number') context.push(item);
    }
    if (Array.isArray(source.labels)) {
      for (const item of source.labels) if (typeof item === 'string' || typeof item === 'number') context.push(item);
    }
    for (const key of ['portalNativeContract', 'originalNativeContract', 'nativeContract']) visitContext(source[key]);
  };
  semanticIds.forEach(visitContext);
  const ids = privacySemanticIdentifiers(...semanticIds, ...context).map(id => id.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_:.-]+/g, ' ')).join(' ');
  const primary = ['string', 'number'].includes(typeof value) ? String(value) : '';
  const text = `${primary} ${ids}`.replace(/\p{Cf}/gu, '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/['’`]/g, ' ').replace(/\s+/g, ' ').trim();
  return incompleteMetadata || consentContradictionPatterns.negated.test(text) || consentContradictionPatterns.facts.test(text)
    || /\b(?:bday|dob|sex|gender|country|paese|nazione|pays|land)\b/.test(text)
    || /\b(?:e ?mail|mail(?:box| address)?|phone|telephone|mobile(?: number)?|cellulare|handy|mobiltelefon|celular|movil|telefon\w*|telefono|portable|courriel|adresse|anschrift|address|indirizzo|street|strasse|rue|residence|residenza|wohnort|domicile|postal code|zip code|code postal|postleitzahl|plz|npa|cap)\b/.test(text)
    || consentContradictionPatterns.otherTerms.test(text)
    || consentContradictionPatterns.accuracy.test(text) || isOptionalPurpose(text);
}
/**
 * A narrow, multilingual checkbox acknowledgement: the candidate confirms
 * only that they read this application's privacy notice. The whole sentence
 * is closed and anchored; any extra fact, purpose or refusal stays unknown.
 * Keep the body self-contained because the extension serializes this guard.
 */
export function privacyReviewAcknowledgmentShape(value) {
  const raw = ['string', 'number'].includes(typeof value) ? String(value) : '';
  const text = raw.replace(/\p{Cf}/gu, '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/\b(?:required|mandatory|obbligatorio|obligatoire|obligatorisch|erforderlich|pflichtfeld)\b$/, '').trim();
  const exactPatterns = [
    /(?:seleziona(?:re)?|spunta|contrassegna) (?:questa|la) casella(?: di (?:controllo|spunta))? per conferm(?:are|a|i) di aver (?:letto (?:l )?|preso visione (?:dell? |di ))informativa (?:sulla )?privacy (?:per (?:i candidati|le candidate)|per questa candidatura)/,
    /(?:bitte )?(?:aktivieren|markieren|kreuzen|wahlen) sie (?:dieses|diese|das) (?:kontrollkastchen|checkbox|feld|box)(?: an)? um zu bestatigen dass sie (?:(?:die|den|das) )?datenschutz(?:erklarung|richtlinien?|hinweise?|bestimmungen|informationen?|mitteilungen?) fur (?:(?:die|diese) )?(?:bewerber(?: innen|innen)?|kandidat(?:en| innen|innen)?|bewerbung) (?:gelesen haben|zur kenntnis genommen haben)/,
    /(?:please )?(?:select|check|tick|mark) (?:this|the) (?:checkbox|check box|box) to (?:confirm|acknowledge) (?:that )?you have (?:read|reviewed) (?:the )?(?:(?:(?:privacy (?:notice|policy|statement)|notice (?:of|about) privacy) (?:(?:for|of) (?:job )?(?:candidates|applicants)|for this application))|(?:candidate|applicant) privacy (?:notice|policy|statement))/,
    /(?:veuillez )?(?:cochez|cocher|selectionnez|selectionner|coche|selectionne) (?:cette|la) (?:case|case a cocher|boite) pour confirmer que vous avez (?:lu|pris connaissance de) (?:l |la )?(?:information|avis|politique|declaration) (?:sur la |de la |de )?confidentialite (?:(?:pour les |des |destinee? aux )?candidat(?:s|es)?|pour cette candidature)/,
  ];
  const exact = exactPatterns.some(pattern => new RegExp(`^(?:${pattern.source})$`).test(text));
  const shape = /^(?:(?:please|bitte|veuillez) )?(?:select|check|tick|mark|seleziona|selezionare|spunta|contrassegna|aktivieren|markieren|kreuzen|wahlen|cochez|cocher|selectionnez|selectionner|coche|selectionne)\b[^.!?]{0,220}\b(?:privacy|datenschutz\w*|informativa|confidentialite)\b/.test(text);
  return { exact, shape };
}
export function isPrivacyReviewAcknowledgment(value, ...semanticIds) {
  const { exact } = privacyReviewAcknowledgmentShape(value);
  return Boolean(exact && !hasConsentContradiction(value, ...semanticIds));
}
export const isNoticeReview = (value, ...semanticIds) => {
  const text = plain(value);
  const privacyShape = privacyReviewAcknowledgmentShape(value);
  return Boolean(isPrivacyReviewAcknowledgment(value, ...semanticIds)
    || (!privacyShape.shape && text && positiveLanguage(text) && !hasConsentContradiction(value, ...semanticIds)));
};
