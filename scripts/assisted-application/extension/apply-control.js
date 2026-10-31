/** Shared classic-script control helpers, used by the extension and Node runner. */
(function (root) {
  'use strict';
// Anywhere in the label: Personio says "Auf diese Stelle bewerben".
// Match complete human-readable action tokens, with optional decorative
// punctuation. URL/query/email fragments are never standalone action words.
// This same expression is also used by the accessible-link fallback.
const APPLY_RE = /(?:^|\s)[([{«»“”‘’"'›•*-]*(apply(?:-now)?|bewerben|bewerbung starten|zur bewerbung|candidati|candidarsi|invia (la tua )?candidatura|candidatura\s+online|postuler|postulez|je postule)[.!?:,;)\]}«»“”‘’"']*(?=\s|$)/i;
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
  const isNonCvDocumentLabel = value => /\b(?:degree|diplom\w*|certificat\w*|(?:arbeits|schul|abschluss)?zeugni\w*|attestat\w*|abschluss\w*|reference\w*|referenz\w*|transcript\w*|bulletin\w*|pagell\w*|passport\w*|passaport\w*|passeport\w*|ausweis\w*|licen[cs]\w*|patent\w*|photo\w*|foto\w*|permits?|permess\w*|permis|(?:arbeits)?bewilligung\w*|other (?:documents|attachments)|additional (?:documents|attachments)|weitere unterlagen|altri (?:documenti|allegati)|autres (?:documents|pieces))\b/i
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
    const country = /^(?:country(?: of residence)?|residence country|country\s*\/\s*region|(?:paese|nazione)(?: di residenza)?|stato di residenza|pays(?: de residence)?|land(?:\s*\/\s*region)?(?: des wohnorts| des wohnsitzes)?|wohnland|wohnsitzland)$/;
    const postalCode = /^(?:zip(?: code)?|postal code|postalcode|post code|postcode|zip\s*(?:\/|or)\s*postal code|postal\s*\/\s*zip code|cap|codice (?:di avviamento )?postale|plz|postleitzahl|npa|code postal)$/;
    const streetNumber = /^(?:(?:street|address|via|indirizzo|rue|strasse|straße)\s+(?:and|e|et|und|&)\s+(?:(?:the|il|le|die)\s+)?(?:house number|number|numero(?: civico)?|hausnummer))$/;
    const street = /^(?:street(?: address| name)?|road name|address(?: line 1)?|residential address|residence address|(?:via|indirizzo)(?: di residenza| stradale| completo)?|nome (?:della )?via|strasse|straße|strassenname|adresse|wohnadresse|rue|nom de (?:la )?rue|adresse (?:personnelle|de residence))$/;
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
    return /^(?:(?:please )?(?:enter|provide|confirm|verify|repeat|re-enter|confirmez|confirmer|repeter|ripeti|conferma|erneut|wiederholen|bestatigen)\s+)?(?:(?:your|my|the|personal|primary|contact|votre|il tuo|la tua|ihr|ihre)\s+)?(?:(?:e[- ]?mail|email|courriel|correo)(?:[- ]*(?:address|adresse|indirizzo))?|(?:address|adresse|indirizzo)[- ]*(?:e[- ]?mail|email|courriel))(?:(?:\s*[/|]\s*(?:login|identifiant))|(?:\s+(?:(?:erneut|nochmals)\s+)?eingeben))?$/.test(caption);
  };
  // A lexical hint can require provenance, never authorize an address value.
  // Derive it from the same positive vocabulary instead of a second alias list.
  const mentionsResidenceFieldRole = value => {
    if (isIdentityEmailCaption(value)) return false;
    const words = String(value || '').match(/\p{L}+/gu) || [];
    return Boolean(residenceFieldRole(value)) || words.some((word, index) =>
      residenceFieldRole(word) || residenceFieldRole(`${word} ${words[index + 1] || ''}`));
  };
  root.AssistedApplyControls = Object.freeze({ APPLY_RE, APPLY_LATER_RE, startsApplication, preferredDocumentControls, isNonCvDocumentLabel, residenceFieldRole, mentionsResidenceFieldRole, isIdentityEmailCaption, hasResidencePurpose, hasTelephonePurpose, nativeQuestionText, individualApplicationOriginQuestion, addressContextContract, hasAddressContextOwnership });
})(globalThis);
