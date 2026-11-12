/** Shared classic-script control helpers, used by the extension and Node runner. */
(function (root) {
  'use strict';
// Anywhere in the label: Personio says "Auf diese Stelle bewerben".
// Match complete human-readable action tokens, with optional decorative
// punctuation. URL/query/email fragments are never standalone action words.
// This same expression is also used by the accessible-link fallback.
// «Inviate la vostra candidatura» (ECAM's career page, CVRDEqJ3 2026-11-11) is the plural/formal
// imperative of «invia la tua candidatura»: the same entry, addressed to more than one reader.
const APPLY_RE = /(?:^applica(?: ora| adesso| subito)?$|(?:^|\s)[([{«»“”‘’"'›•*-]*(apply(?:-now)?|bewerben|bewerbung starten|zur bewerbung|candidati|candidarsi|invia (la (?:tua|sua) )?candidatura|invii la sua candidatura|inviate (la (?:vostra|sua) )?candidatura|candidatura\s+online|postuler|postulez|je postule)[.!?:,;)\]}«»“”‘’"']*(?=\s|$))/i;
// «Später bewerben» on Prospective.ch's career pages (Coop, 2026-10-02) keeps
// the posting for later by e-mail: never the way into the form.
const APPLY_LATER_RE = /(später|spaeter|\blater\b|più tardi|piu tardi|plus tard|merken)/i;
const startsApplication = (text) => {
  const words = String(text || '').split(/\s+/)
    .filter(token => !/:\/\/|\bwww\.|mailto:|@|^[/?]/i.test(token)).join(' ');
  return APPLY_RE.test(words) && !APPLY_LATER_RE.test(text);
};
  // Callers classify the document family first: a mandatory CV attachment
  // takes precedence over an optional CV importer that redraws the form.
  const preferredDocumentControls = (controls) => {
    const required = controls.filter(control => control.required);
    return required.length ? required : controls;
  };
  const isNonCvDocumentLabel = value => /\b(?:degree|diplom\w*|certificat\w*|(?:arbeits|schul|abschluss)?zeugni\w*|attestat\w*|abschluss\w*|reference\w*|referenz\w*|transcript\w*|bulletin\w*|pagell\w*|passport\w*|passaport\w*|passeport\w*|[a-z]*ausweis\w*|licen[cs]\w*|patent\w*|photo\w*|foto\w*|permits?|permess\w*|permis|(?:arbeits)?bewilligung\w*|other (?:documents|attachments)|additional (?:documents|attachments)|weitere unterlagen|altri (?:documenti|allegati)|autres (?:documents|pieces))\b/i
    .test(String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[_:.-]+/g, ' '));
  // Serialized from functions/src/lib/addressContextContract.js; parity is tested.
/** Native control ownership is distinct from flattened sibling labels. Missing is not an owned contract. */
function addressContextContract(question) {
  if (!Object.hasOwn(question || {}, 'addressContext')) return undefined;
  const context = question.addressContext;
  if (!context || typeof context !== 'object' || Array.isArray(context)
    || Object.keys(context).some(key => !['section', 'owners', 'unknown'].includes(key))
    || typeof context.section !== 'string' || context.section.length > 300
    || typeof context.unknown !== 'boolean' || !Array.isArray(context.owners) || context.owners.length > 16
    || context.owners.some(owner => typeof owner !== 'string' || owner.length > 300)) return null;
  return { section: context.section, owners: [...context.owners], unknown: context.unknown };
}

/** A valid representation is not ownership proof. This does not identify self/employer or an address purpose. */
function hasAddressContextOwnership(question) {
  const context = addressContextContract(question);
  return context != null && context.unknown === false
    && (Boolean(context.section.trim()) || context.owners.some(owner => Boolean(owner.trim())));
}

  // Serialized from functions/src/lib/nativeQuestionText.js; parity is tested.
function nativeQuestionText(value, counter = null) {
  const text = String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (!counter || !Number.isSafeInteger(counter.currentLength) || !Number.isSafeInteger(counter.maxLength)
    || counter.currentLength < 0 || counter.maxLength < 0) return text;
  const match = /^(\d{1,6})\s*\/\s*(\d{1,6})\s*(Zeichen|characters?|chars?|caratteri|caract[eè]res)$/iu.exec(text);
  return match && Number(match[1]) === counter.currentLength && Number(match[2]) === counter.maxLength
    ? `max ${counter.maxLength} ${match[3]}` : text;
}
  // Serialized from functions/src/lib/applicationOrigin.js; parity is tested.
function individualApplicationOriginQuestion(value) {
  const text = String(value || '').normalize('NFKC').replace(/\s+/g, ' ').replace(/^\s*[*＊]\s*/u, '').trim();
  if (!text || text.length > 1600) return false;
  const question = /^(?:stammt diese bewerbung von einem vermittlungsb[üu]ro|wird diese bewerbung (?:von|durch) eine(?:r)? (?:personalvermittlung|personalvermittlungsagentur) eingereicht|is this application (?:submitted by|from) (?:a|an) (?:recruitment|recruiting|staffing|employment|placement) agency|are you applying through (?:a|an) (?:recruitment |staffing |employment )?agency|questa candidatura (?:proviene da|è presentata da|viene presentata da) un['’]agenzia (?:per il lavoro|di collocamento|interinale)|cette candidature (?:provient-elle d['’]une|est-elle présentée par une) agence (?:de placement|de recrutement|intérimaire))\s*\?/iu;
  const match = question.exec(text);
  if (!match) return false;
  const tail = text.slice(match[0].length).trim();
  if (!tail) return true;
  // One closed conditional legal clause applies ONLY to an agency's Yes.
  // The organisation's name is data in a noun phrase, never another assertion.
  return /^\(Falls ja: Mit Einreichen des Dossiers werden die AGB der [\p{L}\p{N}'’& .-]{1,100} für die Personalvermittlung auf Erfolgsbasis akzeptiert\.\)$/iu.test(tail);
}
  const withoutCanonicalCounter = value => value.replace(/\s+max \d{1,6} (?:zeichen|characters?|chars?|caratteri|caracteres)$/i, '');
  /** A positive field caption identifies an address role; a personal section only identifies its owner. */
  const residenceFieldRole = value => {
    let caption = String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
      .replace(/[＊*]/g, '').replace(/\s+/g, ' ').trim();
    if (!caption || caption.length > 300) return '';
    caption = withoutCanonicalCounter(caption).replace(/\s*\((?:required|mandatory|optional|obbligatorio|facoltativo|erforderlich|pflichtfeld|obligatoire|facultatif)\)\s*$/, '')
      .replace(/[?:;.]\s*$/, '').trim()
      .replace(/^(?:(?:what is|please enter|please select|enter|select|choose|provide|qual e|indica|inserisci|seleziona|selezionare|veuillez indiquer|veuillez saisir|indiquez|saisissez|bitte eingeben|bitte angeben)\s+)?(?:(?:your|the|il tuo|la tua|il|la|le|votre|ihr|ihre|dein|deine)\s+)?/, '')
      .replace(/^current\s+/, '');
    const city = /^(?:(?:city|town|municipality|locality)(?:\s*\/\s*(?:city|town))?(?: of residence)?|(?:citta|comune|localita)(?: di (?:residenza|domicilio))?|(?:ville|commune|localite)(?: de residence| du domicile)?|place of residence|luogo di (?:residenza|domicilio)|lieu de residence|ort|stadt|wohnort|wohnsitz)$/;
    // «Country/Region of Residence» (SuccessFactors, Damiani 2026-11-10) as «Land/Region des Wohnorts».
    const country = /^(?:country(?:\s*(?:\/|or)\s*region)?(?: of (?:residence|domicile))?|residence country|(?:paese|nazione)(?:\s*\/\s*regione)?(?: di (?:residenza|domicilio))?|stato di residenza|pays(?:\s*\/\s*region)?(?: de (?:residence|domicile))?|land(?:\s*\/\s*region)?(?: des wohnorts| des wohnsitzes)?|wohnland|wohnsitzland)$/;
    const postalCode = /^(?:zip(?: code)?|postal code|postalcode|post code|postcode|zip\s*(?:\/|or)\s*postal code|postal\s*\/\s*zip code|cap|codice (?:di avviamento )?postale|plz|postleitzahl|nap|npa|code postal)$/;
    const streetNumber = /^(?:(?:street|address|via|indirizzo|rue|strasse|straße)\s+(?:and|e|et|und|&)\s+(?:(?:the|il|le|die)\s+)?(?:house number|number|numero(?: civico)?|hausnummer))$/;
    const street = /^(?:street(?: address| name)?|road name|address(?: line 1)?|residential address|residence address|(?:via(?:\s*\/\s*(?:piazza|viale))?|indirizzo)(?: di residenza| stradale| completo)?|nome (?:della )?via|strasse|straße|strassenname|adresse|wohnadresse|rue|nom de (?:la )?rue|adresse (?:personnelle|de residence))$/;
    const number = /^(?:house number|street number|numero civico|civico|hausnummer|numero (?:civique|de la rue))$/;
    if (city.test(caption)) return 'city';
    if (country.test(caption)) return 'country';
    if (postalCode.test(caption)) return 'postalCode';
    if (streetNumber.test(caption)) return 'address';
    if (street.test(caption)) return 'street';
    return number.test(caption) ? 'houseNumber' : '';
  };
  const normalizeScope = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
  const explicitResidence = value => /\b(?:residen\w*|domicil\w*|wohn(?:sitz|ort|adresse)\w*)\b/.test(normalizeScope(value));
  // Each entry is all names of ONE physical scope, joined by the producer.
  // A heading and an ARIA name in that same scope must agree before any
  // positive name can authorize a default. Ancestors remain separate entries.
  const ownedScopePurpose = value => {
    const personal = /^(?:personal(?: information| details| data)?|my information|your details|contact (?:details|information)|candidate(?: personal)? (?:information|details|data|profile)|applicant (?:information|details)|dati anagrafici|(?:dati|informazioni) personali|recapiti personali|(?:donnees|informations|coordonnees) personnelles|personliche (?:daten|angaben|informationen))$/;
    const residence = /^(?:residence|residential address|residence address|home address|current address|private address|indirizzo di residenza|residenza|domicilio|wohnadresse|wohnsitz|wohnort|private adresse|adresse (?:personnelle|de residence)|domicile)$/;
    const telephone = /^(?:phone|telephone|mobile|mobile phone|phone number|telephone number|telefon|telefonnummer|telefono|numero di telefono|natel|telephonie)$/;
    const neutral = /^(?:address|address details|address information|adresse|indirizzo|application|application form|job application|online application|bewerbung|candidatura|formulaire de candidature|formulario di candidatura)$/;
    const parts = String(value || '').split(' · ').map(normalizeScope).filter(Boolean);
    if (parts.length > 16) return 'unknown';
    let purpose = '';
    let personalOwner = false;
    for (const scope of parts) {
      if (personal.test(scope)) { personalOwner = true; continue; }
      const kind = telephone.test(scope) ? 'telephone'
        : residence.test(scope) || (residenceFieldRole(scope) && explicitResidence(scope)) ? 'residence' : '';
      if (kind) {
        if (purpose && purpose !== kind) return 'unknown';
        purpose = kind;
      } else if (!neutral.test(scope) && !residenceFieldRole(scope)) return 'unknown';
    }
    return purpose || (personalOwner ? 'personal' : 'neutral');
  };
  const validPurposeScopes = scopes => Array.isArray(scopes) && scopes.length <= 17
    && scopes.every(name => typeof name === 'string' && name.length <= 300);
  const hasResidencePurpose = (scopes, caption = '') => {
    if (!validPurposeScopes(scopes)) return false;
    if (residenceFieldRole(caption) && explicitResidence(caption)) return true;
    let personalOwner = false;
    for (const scope of scopes) {
      const purpose = ownedScopePurpose(scope);
      if (purpose === 'unknown' || purpose === 'telephone') return false;
      if (purpose === 'residence') return true;
      if (purpose === 'personal') personalOwner = true;
    }
    return personalOwner;
  };
  const hasTelephonePurpose = scopes => {
    if (!validPurposeScopes(scopes)) return false;
    for (const scope of scopes) {
      const purpose = ownedScopePurpose(scope);
      if (purpose === 'unknown' || purpose === 'residence') return false;
      if (purpose === 'telephone') return true;
    }
    return false;
  };
  // A contact e-mail caption is a different semantic role from a postal address.
  const isIdentityEmailCaption = value => {
    const text = String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
      .replace(/[＊*]/g, '').replace(/\s+/g, ' ').trim();
    if (!text || text.length > 300) return false;
    const caption = withoutCanonicalCounter(text).replace(/\s*\((?:required|mandatory|optional|obbligatorio|facoltativo|erforderlich|pflichtfeld|obligatoire|facultatif)\)\s*$/, '').replace(/[?:;.!]+\s*$/, '').trim();
    return /^(?:(?:please |bitte )?(?:enter|provide|confirm|verify|repeat|re-enter|re enter|reenter|retype|re-type|re type|reconfirm|confirmez|confirmer|verifiez|verifier|repeter|repetez|ressaisir|ressaisissez|ripeti|ripetere|conferma|confermare|verifica|reinserisci|reinserire|ridigita|ridigitare|erneut|wiederholen|bestatigen|bestaetigen)\s+)?(?:(?:your|my|the|personal|primary|contact|votre|il tuo|la tua|ihr|ihre)\s+)?(?:(?:e[- ]?mail|email|courriel|correo)(?:[- ]*(?:address|adresse|indirizzo))?|(?:address|adresse|indirizzo)[- ]*(?:e[- ]?mail|email|courriel))(?:(?:\s*[/|]\s*(?:login|identifiant))|(?:\s+(?:(?:erneut|nochmals)\s+)?(?:eingeben|wiederholen|bestatigen|bestaetigen))|(?:\s+(?:a nouveau|de nouveau|di nuovo|again)))?$/.test(caption);
  };
  // A lexical hint can require provenance, never authorize an address value.
  // Derive it from the same positive vocabulary instead of a second alias list.
  const mentionsResidenceFieldRole = value => {
    if (isIdentityEmailCaption(value)) return false;
    const words = String(value || '').match(/\p{L}+/gu) || [];
    return Boolean(residenceFieldRole(value)) || words.some((word, index) =>
      residenceFieldRole(word) || residenceFieldRole(`${word} ${words[index + 1] || ''}`));
  };
  // Generated consent-purpose guard (build-runner-fields.mjs).
  // consent-purpose:start
function isOptionalPurpose(...values) {
  const text = values.join(' ').replace(/\p{Cf}/gu, '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/['’`]/g, ' ').replace(/\s+/g, ' ').trim();
  return /newsletter|marketing|\bwerbung\b|pubblicit|promozion|promotion|offerte|angebote|job.?alert|job.?abo|talent.?pool|future (?:openings|opportunities|positions|vacancies)|other (?:companies|vacancies|positions)|weitere stellen|andere stellen|altre (?:posizioni|offerte|societa)|autres (?:postes|offres|societes)|third part|dritte|\bterzi\b|\btiers\b|whatsapp|cookie|(?:shar(?:e|ed|ing)|disclos(?:e|ed|ing|ure)|transfer(?:red|ring)?)(?: [^.!?;:\r\n]{0,60})? (?:with|to) (?:(?:a|our|selected|trusted|commercial|third party|other) )*partners?\b|(?:weitergabe|weitergeben|teilen|ubermittlung|ubermitteln)(?: [^.!?;:\r\n]{0,60})? (?:an|mit) (?:(?:die|den|unsere|unseren|ausgewahlte|ausgewahlten) )*partner(?:firmen|unternehmen|n)?\b|(?:condivisione|condividere|condivido|condividi|condividiamo|trasmissione|trasmettere)(?: [^.!?;:\r\n]{0,60})? (?:con|ai|a) (?:(?:i|le|nostri|nostre|selezionati|selezionate) )*partner\b|(?:partage|partager|transmission|transmettre)(?: [^.!?;:\r\n]{0,60})? (?:avec|aux|a) (?:(?:nos|les|des|leurs) )*partenaires?\b/.test(text);
}
const consentContradictionPatterns = Object.freeze({ "negated": new RegExp("\\b(?:do(?:es)? not|don t|doesn t|cannot|can t|can not|unable to|not able to|will not|won t|shall not|shan t) (?:accept|agree|consent)|\\b(?:non|nein|nicht) (?:accett|acconsent|accept|agree|consent|akzept|stimm)|\\bn accepte pas|\\b(?:accepte|akzeptiere|stimme) (?:pas|nicht)|\\b(?:refus\\w*|rifiut[oa]|verweiger\\w*)\\b", ""), "facts": new RegExp("permit|bewilligung|permesso di (?:lavoro|soggiorno|domicilio)|\\bvisa\\b|passport|passaport|passeport|reisepass|ausweis|patente|f[üu]hrerschein|fahrausweis|driving licen[cs]e|permis de (?:conduire|travail|séjour)|\\b[abc][12]\\b|years? of|berufserfahrung|anni di esperienza|ann[ée]es d.exp[ée]rience|strafregister|casellario|criminal|\\bdiplom|\\bdegree\\b|abschluss|\\blaurea\\b|certificat|attestat|zeugnis|\\bexperience\\b|\\berfahrung\\b|\\besperienza\\b|qualification|requirements|voraussetzungen|requisiti|maggiorenn|volljahr|\\bmajeur\\b|\\bover\\s+18\\b|\\bbirth(?:day|date|place)?\\b|\\bgeburts?(?:datum|tag|ort|land)?\\b|\\bnascita\\b|\\bnat[oa]\\b|\\bnaissance\\b|nationalit|nazionalit|cittadinanz|citizen|staatsangeh|staatsb(?:ü|ue)rger|citoyennet|arbeitserlaubnis|aufenthaltserlaubnis|aufenthaltsstatus|aufenthaltstitel|ausl(?:ä|ae)nderausweis|ausweis(?:typ|art|kategorie)|\\bausweis\\b(?!\\s*-?\\s*(?:nr|nummer|no)\\b)|grenzg(?:ä|ae)nger|frontali(?:e|è)r|autorizzazione (?:al|di|per il) lavoro|autorizzat[oa] a lavorare|diritto (?:al|di) lavor|titolo di soggiorno|stato di soggiorno|statuto di soggiorno|\\bpermis suisse\\b|permis de (?:travail|s(?:é|e)jour)|autorisation (?:de travail|de s(?:é|e)jour|frontali(?:è|e)re|d['’](?:é|e)tablissement|de courte dur(?:é|e)e)|titre de s(?:é|e)jour|statut de s(?:é|e)jour|autoris(?:é|e)e? (?:à|a) travailler|droit de travailler|\\bpermiso\\b(?!\\s+(?:(?:de|para)\\s+conducir|de\\s+(?:la\\s+)?conducci[oó]n|para\\s+(?:la\\s+)?conducci[oó]n))|permiso de trabajo|autorizaci(?:ó|o)n (?:de trabajo|para trabajar)|autorizad[oa] (?:a|para) trabajar|derecho (?:a|de) trabajar|elegible para trabajar|entitled to (?:work|be employed)|work authori[sz]ation|authori[sz]ed to work|right to work|eligib(?:le|ility) to work|legally (?:able|allowed|entitled|permitted) to work|sponsorship|residence status|immigration status", "i"), "otherTerms": new RegExp("vermittlungsburo|personalvermittl|placement agency|recruit(?:ment|ing) agency|staffing agency|agenzia (?:per il lavoro|di collocamento|interinale)|agence (?:de placement|de recrutement)|erfolgsbasis|success fee|membership|subscription|abonnement|abbonamento|purchase|purchasing|agency terms|commercial terms|conditions de vente|condizioni di vendita|verkaufsbedingungen|credit check|background check|medical examination|drug test", ""), "accuracy": new RegExp("(?:information|details|answers|angaben|informationen|dati|informazioni|renseignements).{0,80}(?:true|accurate|correct|complete|truthful|wahr|richtig|vollstandig|veritier|corrett|veriti|esatt|sincere|exact|complet)", "") });
const privacySemanticIdentifierFields = Object.freeze(["name","id","fieldId","controlId","nativeControlId","nativeSelectId","semanticId","autocomplete","domId","dataAutomationId","dataControlId","dataSemanticId","elementId","nativeFieldId"]);
function privacySemanticIdentifiers(...sources) {
  const keys = privacySemanticIdentifierFields;
  const technicalId = /^(?:[a-z]{1,4}\d{1,4}|(?:input|field|control|question|checkbox|radio)[-:.]?\d+)$/i;
  const semanticFactId = /^(?:e?mail|mail|tel(?:ephone)?|phone|mobile|cellulare|handy|telefon\w*|telefono|sex|gender|birth|dob|bday|country|paese|nazione|pays|land|visa|address|indirizzo|adresse|residence|residenza|wohnort|domicile|street|strasse|rue|postal|zip|code|postleitzahl|plz|npa|cap)\d{1,4}$/i;
  const nestedKeys = ['portalNativeContract', 'originalNativeContract', 'nativeContract'];
  const values = [];
  const seen = new Set();
  const add = value => {
    if (!['string', 'number'].includes(typeof value)) return;
    const normalized = String(value).normalize('NFKC').replace(/\p{Cf}/gu, '').trim();
    if (!normalized) return;
    // An opaque generated control id may look like a CEFR level such as `c1`.
    if (technicalId.test(normalized) && !semanticFactId.test(normalized)) return;
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
function hasConsentContradiction(value, ...semanticIds) {
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
  const ids = privacySemanticIdentifiers(...semanticIds, ...context).map(id => id.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([a-z])(\d)/gi, '$1 $2').replace(/[_:.-]+/g, ' ')).join(' ');
  const primary = ['string', 'number'].includes(typeof value) ? String(value) : '';
  const text = `${primary} ${ids}`.replace(/\p{Cf}/gu, '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/['’`]/g, ' ').replace(/\s+/g, ' ').trim();
  return incompleteMetadata || consentContradictionPatterns.negated.test(text) || consentContradictionPatterns.facts.test(text)
    || /\b(?:bday|dob|sex|gender|country|paese|nazione|pays|land)\b/.test(text)
    || /\b(?:e ?mail|mail(?:box| address)?|tel(?:ephone)?|phone|mobile(?: number)?|cellulare|handy|mobiltelefon|celular|movil|telefon\w*|telefono|portable|courriel|adresse|anschrift|address|indirizzo|street|strasse|rue|residence|residenza|wohnort|domicile|postal code|zip code|code postal|postleitzahl|plz|npa|cap)\b/.test(text)
    || consentContradictionPatterns.otherTerms.test(text)
    || consentContradictionPatterns.accuracy.test(text) || isOptionalPurpose(text);
}
function minimumDataRetentionOption(options, question = '') {
  const normalize = value => String(value ?? '').replace(/\p{Cf}/gu, '').normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/['’`]/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
  const selectionPrompt = /^(?:(?:please )?(?:choose|select)(?: (?:one|a|an|the|your))?(?: (?:option|answer|response|choice|retention period|period|duration|term))?|(?:seleziona(?:re)?|selezioni|scegli(?:ere)?)(?: (?:un|uno|una|il|la|l))?(?: (?:opzione|risposta|durata|periodo|scelta|termine|voce|valore))?|(?:bitte )?(?:wahlen|auswahlen)(?: sie)?(?: (?:ein|eine|einen|einer|den|die|das))?(?: (?:option|auswahl|antwort|dauer|frist|zeitraum))?(?: aus(?: der liste)?)?|(?:veuillez )?(?:selectionnez?|selectionner|choisir|choisissez)(?: (?:un|une|le|la|les|votre))?(?: (?:option|reponse|choix|duree|periode|selection))?|aucune selection|keine auswahl|no selection|nothing selected)$/;
  const rows = (Array.isArray(options) ? options : []).map(option => {
    const label = typeof option === 'string' ? option : String(option?.label ?? option?.value ?? '');
    const value = typeof option === 'string' ? label : String(option?.value ?? label);
    const purpose = [...new Set([label.trim(), value.trim()].filter(Boolean))].join('. ');
    return { label: label.trim(), value: [...new Set([normalize(label), normalize(value)].filter(Boolean))].join(' '), purpose };
  }).filter(option => option.label && option.value && !selectionPrompt.test(normalize(option.label)));
  if (!rows.length) return '';

  const durationFactor = { day: 1, week: 7, month: 30, year: 365 };
  const durationUnit = /\b(days?|giorn[io]|tage?n?|jours?)\b/;
  const weekUnit = /\b(weeks?|settimane?|wochen|semaines?)\b/;
  const monthUnit = /\b(months?|mes(?:e|i)|monate?n?|mois)\b/;
  const yearUnit = /\b(years?|ann(?:o|i)|jahre?n?|ans?)\b/;
  const durationPattern = /\b(\d{1,3}(?:[.,]\d{1,2})?|one|uno|un|une|ein|eins|eine|two|due|zwei|deux|three|tre|drei|trois|four|quattro|vier|quatre|five|cinque|funf|fuenf|cinq|six|sei|sechs)\s*(days?|giorn[io]|tage?n?|jours?|weeks?|settimane?|wochen|semaines?|months?|mes(?:e|i)|monate?n?|mois|years?|ann(?:o|i)|jahre?n?|ans?)\b/g;
  const numberWords = { one: 1, uno: 1, un: 1, une: 1, ein: 1, eins: 1, eine: 1, two: 2, due: 2, zwei: 2, deux: 2,
    three: 3, tre: 3, drei: 3, trois: 3, four: 4, quattro: 4, vier: 4, quatre: 4, five: 5, cinque: 5, funf: 5,
    fuenf: 5, cinq: 5, six: 6, sei: 6, sechs: 6 };
  const retentionQuestionContext = /\b(?:retain\w*|retention\w*|stor(?:e|es|ed|ing|age)|(?:ge)?speicher\w*|stock\w*|keep\w*|kept|hold\w*|held|preserv\w*|conserv\w*|memorizz\w*|behalten\w*|aufbewahr\w*)\b/.test(normalize(question));
  const deletionWords = /\b(?:delet\w*|elimin\w*|cancell\w*|delete|supprim\w*|losch\w*|loesch\w*)\b/;
  const rejectedApplicationProcess = /\b(?:application|candidacy|candidature|bewerbung)\b(?: [a-z0-9]+){0,4} (?:is|was|were|has|have|had|gets?|got|a|est|sont|ete|werden|wurde)(?: [a-z0-9]+){0,2} (?:reject\w*|declin\w*|refus\w*|rejet\w*|abgelehnt|verworfen)\b/;
  // Rejection of the application itself leaves the deletion timing ambiguous.
  // Do not fall through to a longer-duration choice in that catalogue.
  if (rows.some(option => deletionWords.test(option.value) && rejectedApplicationProcess.test(option.value))) return '';
  const rank = option => {
    const value = option.value;
    const futureStorage = isOptionalPurpose(option.purpose);
    if (futureStorage) return Number.POSITIVE_INFINITY;

    const deletes = deletionWords.test(value);
    // normalize() turns English n't contractions into a word ending in n + "t".
    // Keep the negation and deletion in the same clause; words between them
    // may be arbitrarily long (“not under any circumstances ... delete”).
    const negationWords = /\b(?:not|never|no|non|nicht|nie|pas|aucun(?:e|s|es)?|kein\w*|\w+n t|cannot)\b/;
    const refusalWords = /\b(?:refus\w*|declin\w*|reject\w*|disagree\w*|unwilling\w*|unwillig\w*|reluctant\w*|rifiut\w*|verweiger\w*)\b/;
    const commaBoundary = '\u0001';
    // Never bridge an independent, conditional, or uncertain clause when filtering negated refusals.
    const refusalBridgeBoundaryWords = String.raw`(?:and|or|but|however|although|though|whereas|while|yet|instead|otherwise|because|since|therefore|so|ma|pero|bensi|mais|cependant|pourtant|toutefois|neanmoins|et|ou|aber|sondern|jedoch|hingegen|und|oder|e|ed|o|oppure|mas|sino|if|whether|ob|se|si|qualora|falls|wenn|sure|sur|certain\w*|uncertain|unsure|maybe|perhaps|probably|possibly|likely|think|believe|know|suppose|guess|doubt|credo|penso|pensare|forse|magari|incerto|incerta|certo|certa|sicur\w*|crois|pense|sais|savoir|doute|vielleicht|glaube|denke|weiss|wissen|unsicher|i|we|our|you|he|she|they|their|candidate|applicant|employer|company|recruiter\w*|hiring|team|organization|organisation|firm|management|hr|human|resources|board|committee|azienda|datore|societa|impresa|selezionator\w*|responsabile|commissione|employeur|entreprise|recruteur\w*|equipe|arbeitgeber|unternehmen|firma|personalabteilung|empresa|equipo|je|tu|il|elle|nous|notre|leur|vous|ils|elles|io|lui|lei|noi|voi|loro|ich|du|er|sie|wir|ihr|unser\w*|bewerber\w*|kandidat\w*|candidat\w*|candidato\w*|candidata\w*)`;
    const refusalBridge = String.raw`(?:${commaBoundary} )*(?:(?!\b${refusalBridgeBoundaryWords}\b)[a-z0-9]+ (?:${commaBoundary} )*){0,3}`;
    // Preserve an active answer such as “No, I refuse”, but do not bypass
    // negation filtering for “No, I did not refuse”.
    const startsWithNegativeAnswerAndFirstPersonRefusal = clauseText => {
      const normalized = clauseText.split(commaBoundary).join(' ').replace(/\s+/g, ' ').trim();
      const match = new RegExp(
        `^(?:no|non|nein) (?:i|we|io|ich|je|nous|noi|loro)\\b((?: [a-z0-9]+){0,3}) ${refusalWords.source}`,
      ).exec(normalized);
      return Boolean(match && !negationWords.test(match[1]));
    };
    const removeNegatedRefusal = clauseText => startsWithNegativeAnswerAndFirstPersonRefusal(clauseText)
      ? clauseText : clauseText.replace(
        new RegExp(`(?:${negationWords.source} ${refusalBridge}${refusalWords.source}|${refusalWords.source} ${refusalBridge}(?:pas|plus|jamais|nicht)\\b)`, 'g'),
        match => /\bnot only\b/.test(match) ? match : ' ',
      );
    const withoutWords = /\b(?:without|sans|ohne|senza)\b/;
    // Split before normalize(), which would otherwise erase Unicode clause dashes.
    const clauseGroups = option.purpose.split(/[.!?;:\r\n\u2012-\u2015]+|\s+-\s+/u);
    const commaClauseGroups = clauseGroups.map(clauseText => clauseText.split(',').map(normalize));
    const clauseTexts = commaClauseGroups.flat();
    const applicationOutcomeWords = String.raw`(?:selected|chosen|hired|accepted|approved|eligible|successful|rejected|declined|refused|selezionat\w*|assunt\w*|selectionne\w*|retenu\w*|choisi\w*|embauch\w*|ausgewahlt|ausgewaehlt|eingestellt|abgelehnt|abgelehn\w*|verworfen)`;
    const selectionConditionPattern = new RegExp(
      `\\b(?:if|unless|when|whenever|provided that|se|qualora|wenn|falls|si)\\b(?: [a-z0-9]+){0,12}(?: ${negationWords.source}(?: [a-z0-9]+){0,12})? \\b${applicationOutcomeWords}\\b`,
      'g',
    );
    const selectionCondition = clauseText => clauseText.replace(selectionConditionPattern, (match, offset, wholeClause) => {
      const conditionTail = wholeClause.slice(offset + match.length);
      const consentOrDataContext = /\b(?:consent\w*|einwillig\w*|zustimm\w*|daten|data|donnee\w*|personal|retention\w*|stor\w*|speicher\w*|privacy|protection|processing|traitement|permission|authoriz\w*|authoris\w*|agreement|option)\b/.test(match)
        || /^ (?:[a-z0-9]+ ){0,3}(?:consent\w*|einwillig\w*|zustimm\w*|agreement|authoriz\w*|authoris\w*)\b/.test(conditionTail)
        || (/(?:accepted|approved)$/.test(match)
          && /^ (?:[a-z0-9]+ ){0,3}(?:data|daten|donnee\w*|personal|retention\w*|stor\w*|privacy|protection|processing|traitement|permission|option)\b/.test(conditionTail));
      const applicantContext = /\b(?:application\w*|candidac\w*|candidatur\w*|bewerbung\w*|candidate\w*|applicant\w*|you|your|they|their|he|she|i|me|my|we|our|person|candidat\w*|bewerber\w*|jobseeker\w*)\b/.test(match);
      const activeCandidateRejection = /\b(?:i|you)\b(?: (?:have|has|had))? (?:rejected|refused|declined)\b/.test(match);
      const bareRejection = /^\b(?:if|unless|when|whenever|provided that|se|qualora|wenn|falls|si)\b rejected$/.test(match);
      const bareNonSelection = /^\b(?:if|unless|when|whenever|provided that|se|qualora|wenn|falls|si)\b (?:not|never|no|non|nicht|nie) (?:selected|chosen|hired|eligible|successful|selezionat\w*|assunt\w*|selectionne\w*|retenu\w*|choisi\w*|embauch\w*|ausgewahlt|ausgewaehlt|eingestellt)$/.test(match);
      return !consentOrDataContext && !activeCandidateRejection && (applicantContext || bareRejection || bareNonSelection) ? ' ' : match;
    });
    const scopedClauseGroups = commaClauseGroups.map(group => group.map(selectionCondition));
    const scopedClauseTexts = scopedClauseGroups.flat();
    const refusalAwareClauseGroups = scopedClauseGroups.map(group =>
      removeNegatedRefusal(group.join(` ${commaBoundary} `)));
    const refusalAwareClauseTexts = refusalAwareClauseGroups.flatMap(clauseText =>
      clauseText.split(commaBoundary).map(normalize));
    const negatesDeletion = refusalAwareClauseTexts.some(clauseText => {
      const negatesBeforeDeletion = new RegExp(`${negationWords.source}(?: [a-z0-9]+)* ${deletionWords.source}`);
      const affirmativeWithoutQualifier = /(?:(?:any|a|an|the|further|additional|undue|more|another|weitere|weiteren|ulteriore|ulteriori|plus|aucun|aucune) )*(?:delay|delai|verzoegerung|verzogerung|ritardo|indugio|hesitation|hesitance|esitazione|zogern|zogerung|attendre|waiting|warning|notice|reservation|interruption|prejudice|ado)\b/;
      // Keep positive modifiers such as “without delay” distinct from negated deletion.
      const withoutDeletion = new RegExp(
        `${withoutWords.source}(?! ${affirmativeWithoutQualifier.source})(?: [a-z0-9]+)* ${deletionWords.source}`,
      );
      return negatesBeforeDeletion.test(clauseText) || withoutDeletion.test(clauseText);
    });
    const currentApplicationWords = String.raw`(?:current application|this application|application process|questa candidatura|candidatura corrente|procedura di candidatura corrente|(?:la |cette )?candidature(?: en cours)?|(?:la )?procedure de candidature(?: en cours)?|bewerbung(?:sverfahren)?)`;
    const currentApplicationCompletion = String.raw`once.{0,80}\b(?:(?:the )?(?:current|present)|this) application process\b.{0,40}\b(?:complet(?:e|ed|ion)|finish(?:ed)?|ends?|ended|over|conclud(?:e|es|ed)|terminat(?:e|ed|es))\b`;
    const currentApplicationTiming = String.raw`(?:\b(?:after|dopo|nach|apres)\b.{0,80}\b${currentApplicationWords}\b|${currentApplicationCompletion})`;
    const afterCurrentApplication = new RegExp(`\\b(?:after|dopo|nach|apres)\\b.{0,80}\\b${currentApplicationWords}\\b`);
    const onceCurrentApplicationCompletes = new RegExp(currentApplicationCompletion);
    const negatesCurrentTiming = refusalAwareClauseTexts.some(clauseText => new RegExp(
      `${negationWords.source}(?:(?! ${deletionWords.source}) [a-z0-9]+)* ${currentApplicationTiming}`,
    ).test(clauseText));
    const prohibitionWords = String.raw`(?:permit\w*|allow\w*|authoriz\w*|authoris\w*|autorise\w*|erlaub\w*|possible|impossible|permissible|lawful|unlaw\w*|legal|illegal|consentit\w*|required|necessary|unnecessary)`;
    const directProhibitionWords = String.raw`(?:prohibit\w*|forbidden|banned|illegal|interdit\w*|verboten|vietat\w*|unlaw\w*|impossible|unnecessary|disallow\w*|forbid\w*|prevent\w*|restrict\w*)`;
    const negatesPostTemporalProhibition = refusalAwareClauseTexts.some(clauseText => new RegExp(
      `\\b${currentApplicationTiming}\\b(?: [a-z0-9]+){0,12} ${negationWords.source}(?: [a-z0-9]+){0,4} \\b${prohibitionWords}\\b|\\b${currentApplicationTiming}\\b(?: [a-z0-9]+){0,12}\\b${directProhibitionWords}\\b`,
    ).test(clauseText));
    const negatesPreTemporalProhibition = refusalAwareClauseTexts.some(clauseText => new RegExp(
      `(?:${negationWords.source}(?: [a-z0-9]+){0,4} \\b${prohibitionWords}\\b|\\b${directProhibitionWords}\\b).{0,80}${currentApplicationTiming}`,
    ).test(clauseText));
    // Do not infer authorization from an explicit refusal. These choices are
    // excluded from the minimum so a separate, affirmative finite option can
    // still be selected. Keep ambiguous anti-deletion wording unresolved above.
    const consentActionWords = /\b(?:consent\w*|acconsent\w*|agree\w*|accept\w*|authoriz\w*|authoris\w*|autoriz\w*|autoris\w*|allow\w*|permit\w*|erlaub\w*|gestatt\w*|einwillig\w*|zustimm\w*|akzeptier\w*|accepter\w*|willing\w*|want\w*|wish\w*|bereit|dispost\w*|einverstanden|accord\w*)\b/;
    const storageActionWords = /\b(?:retain\w*|kept|keep\w*|held|hold\w*|stor(?:e|es|ed|ing)|storage(?:s)?|(?:ge)?speicher(?:n|st|t|te|ten|test|tet|nd|e|en)?|speicherung(?:en)?|stock(?:er|e|es|ent|ons|ez|ait|aient|ant|ee|ees|ions|iez)|stockage(?:s)?|preserv\w*|conserv\w*|memorizz\w*|behalten\w*|aufbewahr\w*)\b/;
    const negationBefore = actionWords => clauseText => new RegExp(
      `${negationWords.source}(?: [a-z0-9]+){0,12} ${actionWords.source}`,
    ).test(clauseText);
    const consentSubjectContext = /\b(?:consent\w*|einwillig\w*|zustimm\w*|acconsent\w*|agree\w*|agreement|permission|authorization|authorisation|i|me|my|we|our|you|your|candidate|applicant|data|daten|donnee\w*|dati|personal)\b/;
    const noAdditionalStoragePermission = /\bno\b(?: [a-z0-9]+){0,3} storage(?:s)?\b(?: (?:(?:is|are|was|were) )?(?:permitted|allowed)\b)/;
    const negatesConsentChoice = refusalAwareClauseTexts.some(clauseText => {
      const consentClause = clauseText.replace(noAdditionalStoragePermission, ' ');
      return consentSubjectContext.test(consentClause) && negationBefore(consentActionWords)(consentClause);
    });
    const firstPersonDataChoice = /\b(?:i|me|my|we|our|io|me|mio|mia|ich|mir|mich|mein\w*|je|moi|mon|ma|mes|nous|notre)\b/;
    const negatesPersonalRetention = refusalAwareClauseTexts.some((clauseText, index) => scopedClauseTexts[index] === clauseTexts[index]
      && firstPersonDataChoice.test(clauseText) && negationBefore(storageActionWords)(clauseText));
    const retentionSubjectContext = /\b(?:data|daten|donnee\w*|dati|personal|candidate|applicant|my|your|our|their|mio|mia|mein\w*|mon|ma|mes|notre)\b/;
    const noAdditionalStorageDeclaration = /\bno\b (?:additional|extra|further|more|other)(?: [a-z0-9]+){0,2} storage(?:s)?\b(?: (?:(?:is|are|was|were) )?(?:needed|necessary|required|permitted|allowed)\b)?/;
    const negatesRetentionAction = refusalAwareClauseTexts.some(clauseText => {
      const retentionClause = clauseText.replace(noAdditionalStorageDeclaration, ' ');
      return (retentionSubjectContext.test(retentionClause) || retentionQuestionContext)
        && negationBefore(storageActionWords)(retentionClause);
    });
    const candidateInitiatedRejection = /\b(?:i|you)\b(?: (?:have|has|had))? (?:reject\w*|refus\w*|declin\w*)\b/;
    const candidateAsRejectionAgent = /\b(?:reject\w*|refus\w*|declin\w*|rifiut\w*|verweiger\w*|abgelehn\w*)\b(?: [a-z0-9]+){0,8} \b(?:by (?:me|you|the candidate|the applicant)|da (?:me|te|candidat\w*)|par (?:moi|vous|candidat\w*)|von (?:mir|ihnen|dem bewerber\w*))\b/;
    const candidateRefusalSubject = String.raw`(?:i|we|you|me|my|yo|nosotros|usted|ustedes|io|noi|tu|voi|je|nous|vous|ich|wir|du|ihr|candidate\w*|applicant\w*|candidat\w*|bewerber\w*|kandidat\w*|candidato\w*|candidata\w*)`;
    const candidateExplicitRefusal = new RegExp(String.raw`\b${candidateRefusalSubject}\b ${refusalBridge}${refusalWords.source}`);
    const applicantRejectedByEmployer = /\b(?:candidate\w*|applicant\w*|candidat\w*|bewerber\w*|kandidat\w*|candidato\w*|candidata\w*)\b(?: (?:after review|following review|after consideration|apres examen|apres etude|dopo la revisione|nach der prufung|tras la revision)){0,2}(?: (?:am|is|are|was|were|has been|have been|had been|got|ist|war|wurde|wird|sind|wurden|viene|vengono|suis|est|sommes|sont|a ete|ont ete|e stato|e stata|sono stati|sono state|bin|bist|waren|werden) (?:reject\w*|refus\w*|declin\w*|rifiutat\w*|respint\w*|abgelehn\w*)| (?:reject\w*|refus\w*|declin\w*|rifiutat\w*|respint\w*|abgelehn\w*))\b(?: (?:yesterday|today|recently|previously|earlier|already|gestern|heute|vorher|bereits|hier|auparavant|recemment|aujourd hui|ieri|oggi|prima|recentemente|ayer|hoy|antes|recientemente)){0,2} (?:by (?:the )?(?:employer|company|recruiter\w*|organization|organisation|eoc|hospital)|par (?:l )?(?:employeur|entreprise|recruteur\w*|societe|eoc|hopital)|(?:da|dal|dalla|dall|dell|della|dello) (?:l )?(?:datore|azienda|societa|impresa|recruiter\w*|eoc|ospedale)|(?:vom|von (?:dem )?)(?:arbeitgeber|unternehmen|firma|eoc|krankenhaus)|por (?:el )?(?:empleador|empresa|recruiter\w*|eoc|hospital)|del (?:empleador|recruiter\w*|eoc))\b/;
    const applicationOutcomeRejection = /\b(?:application(?: process)?|candidac\w*|candidatur\w*|bewerbung(?:sverfahren)?|job|position|stelle)\b(?: (?:is|was|are|were|has been|have been|had been|got|ist|war|wurde|wird|sind|wurden|e stato|e stata|sono stati|sono state|a ete|ont ete|est|sont))? (?:not )?(?:reject\w*|refus\w*|declin\w*|rifiut\w*|rejet\w*|abgelehn\w*|verworfen|not selected|nicht ausgewahlt|non selezionat\w*|pas selectionne\w*)\b/;
    const passiveApplicantRejection = /\b(?:i|you|he|she|they|je|tu|il|elle|nous|vous|ils|elles|on|io|lui|lei|noi|voi|loro|er|sie|ich|du|wir|ihr|candidate|applicant|candidat\w*|bewerber\w*|kandidat\w*|candidato\w*|candidata\w*)\b.{0,24}\b(?:am|is|are|was|were|have been|has been|got|sono(?: stato| stata| stati| state)?|sei|e(?: stato| stata)?|siamo|siete|viene|vengono|suis|es|est|sommes|etes|sont|a ete|ont ete|bin|bist|ist|sind|war|waren|wurde|wurden|wird|werden)\b.{0,24}\b(?:rejected|refused|declined|rifiutat\w*|respint\w*|refuse(?:e|es|s)?|rejete(?:e|es|s)?|decline(?:e|es|s)?|abgelehnt|verworfen)\b/;
    const employerRejection = /\b(?:we|they|the employer|the company)\b.{0,20}\b(?:reject(?:ed)?|refuse(?:d)?|decline(?:d)?|abgelehnt|verworfen)\b.{0,25}\b(?:you|your application|candidate|applicant|(?:the|an|my) application|candidac\w*|candidatur\w*)\b/;
    const removeAtsRejectionOutcome = clauseText => candidateAsRejectionAgent.test(clauseText)
      ? clauseText
      : [applicationOutcomeRejection, passiveApplicantRejection, applicantRejectedByEmployer, employerRejection]
        .reduce((remaining, pattern) => remaining.replace(new RegExp(pattern.source, 'g'), ' '), clauseText);
    const explicitlyRefuses = refusalAwareClauseGroups.some(clauseText => {
      const candidateRefusalClause = removeAtsRejectionOutcome(
        clauseText.split(commaBoundary).join(' ').replace(/\s+/g, ' ').trim(),
      );
      return candidateInitiatedRejection.test(candidateRefusalClause)
        || candidateAsRejectionAgent.test(candidateRefusalClause)
        || candidateExplicitRefusal.test(candidateRefusalClause);
    });
    const answerIsNo = /^(?:no|non|nein|nein danke|non desidero|non acconsento|non consento|i do not consent|i don t consent)$/
      .test(normalize(option.label));
    if (answerIsNo || explicitlyRefuses) return Number.POSITIVE_INFINITY;
    if (negatesDeletion || negatesCurrentTiming || negatesPostTemporalProhibition || negatesPreTemporalProhibition) return null;
    if (negatesConsentChoice || negatesPersonalRetention) return Number.POSITIVE_INFINITY;
    if (negatesRetentionAction) return null;
    const followsCurrentApplication = afterCurrentApplication.test(value) || onceCurrentApplicationCompletes.test(value);
    const currentOnly = /\b(?:only|solo|uniquement|nur)\b/.test(value)
      && /\b(?:this application|current application|questa candidatura|candidatura corrente|candidature en cours|bewerbung)\b/.test(value);
    if ((deletes && followsCurrentApplication) || currentOnly) return 0;

    // A form may repeat the same duration in a human label and a machine value
    // (for example “six months” and “6_months”). Deduplicate the parsed tuple,
    // not its source spelling, while still rejecting genuinely mixed terms.
    const durationMatches = new Map();
    for (const match of value.matchAll(durationPattern)) {
      const [, amountText, unit] = match;
      const amount = /^\d/.test(amountText) ? Number(amountText.replace(',', '.')) : numberWords[amountText];
      const unitKey = durationUnit.test(unit) ? 'day' : weekUnit.test(unit) ? 'week'
        : monthUnit.test(unit) ? 'month' : yearUnit.test(unit) ? 'year' : '';
      if (!Number.isFinite(amount) || !unitKey) continue;
      durationMatches.set(`${amount}:${unitKey}`, { amount, unitKey });
    }
    if (durationMatches.size > 1) return null;
    if (durationMatches.size === 1) {
      const [{ amount, unitKey }] = durationMatches.values();
      return amount >= 0 ? amount * durationFactor[unitKey] : null;
    }
    return null;
  };

  const ranked = rows.map(option => ({ ...option, rank: rank(option) }));
  // A current-application deletion choice is unambiguously the minimum even
  // when another option describes a future pool without a numeric duration.
  const zero = ranked.filter(option => option.rank === 0);
  if (zero.length === 1) return zero[0].label;
  if (zero.length > 1 || ranked.some(option => option.rank === null)) return '';
  // A future-purpose option has no finite retention term. It must not make a
  // clear, finite application-retention choice ambiguous; when no finite
  // option exists, leave the future-only catalogue unanswered.
  const finite = ranked.filter(option => Number.isFinite(option.rank));
  if (!finite.length) return '';
  const minimum = Math.min(...finite.map(option => option.rank));
  const matches = finite.filter(option => option.rank === minimum);
  return matches.length === 1 ? matches[0].label : '';
}
function isApplicationDataProcessingConsent(value, ...semanticMetadata) {
  const text = String(value || '').replace(/\p{Cf}/gu, '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/['’`]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text || hasConsentContradiction(text, ...semanticMetadata)) return false;
  const asksConsent = /\b(?:consent\w*|acconsent\w*|agree\w*|accept\w*|einwillig\w*|zustimm\w*|akzeptier\w*|accepter\w*|autoris\w*|autoriz\w*)\b/.test(text);
  const processesData = /\b(?:process\w*|tratt\w*|verarbeit\w*|trait\w*)\b/.test(text);
  const personalData = /\b(?:personal data|personal information|dati personali|dati di carattere personale|personenbezogen\w* daten|personliche daten|persoenliche daten|donnees personnelles|donnees a caractere personnel)\b/.test(text);
  return asksConsent && processesData && personalData;
}
function privacyReviewAcknowledgmentShape(value) {
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
function isPrivacyReviewAcknowledgment(value, ...semanticIds) {
  const { exact } = privacyReviewAcknowledgmentShape(value);
  return Boolean(exact && !hasConsentContradiction(value, ...semanticIds));
}
  // consent-purpose:end
  root.AssistedApplyControls = Object.freeze({ APPLY_RE, APPLY_LATER_RE, startsApplication, preferredDocumentControls, isNonCvDocumentLabel, residenceFieldRole, explicitResidence, mentionsResidenceFieldRole, isIdentityEmailCaption, hasResidencePurpose, hasTelephonePurpose, nativeQuestionText, individualApplicationOriginQuestion, addressContextContract, hasAddressContextOwnership, isOptionalPurpose, privacySemanticIdentifiers, hasConsentContradiction, minimumDataRetentionOption, isApplicationDataProcessingConsent, privacyReviewAcknowledgmentShape, isPrivacyReviewAcknowledgment });
})(globalThis);
