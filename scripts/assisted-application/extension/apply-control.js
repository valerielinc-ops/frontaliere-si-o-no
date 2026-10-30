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
  /** A positive field caption identifies an address role; a personal section only identifies its owner. */
  const residenceFieldRole = value => {
    let caption = String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
      .replace(/[＊*]/g, '').replace(/\s+/g, ' ').trim();
    if (!caption || caption.length > 300) return '';
    caption = caption.replace(/\s*\((?:required|mandatory|optional|obbligatorio|facoltativo|erforderlich|pflichtfeld|obligatoire|facultatif)\)\s*$/, '')
      .replace(/[?:;.]\s*$/, '').trim()
      .replace(/^(?:(?:what is|please enter|please select|enter|select|choose|provide|qual e|indica|inserisci|seleziona|selezionare|veuillez indiquer|veuillez saisir|indiquez|saisissez|bitte eingeben|bitte angeben)\s+)?(?:(?:your|the|il tuo|la tua|il|la|le|votre|ihr|ihre|dein|deine)\s+)?/, '')
      .replace(/^current\s+/, '');
    const city = /^(?:(?:city|town|municipality|locality)(?:\s*\/\s*(?:city|town))?(?: of residence)?|(?:citta|comune|localita)(?: di (?:residenza|domicilio))?|(?:ville|commune|localite)(?: de residence| du domicile)?|place of residence|luogo di (?:residenza|domicilio)|lieu de residence|ort|stadt|wohnort|wohnsitz)$/;
    const country = /^(?:country(?: of residence)?|residence country|country\s*\/\s*region|(?:paese|nazione)(?: di residenza)?|stato di residenza|pays(?: de residence)?|land|wohnland|wohnsitzland)$/;
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
  // A contact e-mail caption is a different semantic role from a postal address.
  const isIdentityEmailCaption = value => {
    const text = String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
      .replace(/[＊*]/g, '').replace(/\s+/g, ' ').trim();
    if (!text || text.length > 300) return false;
    const caption = text.replace(/\s*\((?:required|mandatory|optional|obbligatorio|facoltativo|erforderlich|pflichtfeld|obligatoire|facultatif)\)\s*$/, '').replace(/[?:;.]\s*$/, '').trim();
    return /^(?:(?:confirm|repeat|re-enter|confirmez|confirmer|repeter|ripeti|conferma|erneut|wiederholen|bestatigen)\s+)?(?:(?:your|my|the|personal|primary|contact|votre|il tuo|la tua|ihr|ihre)\s+)?(?:(?:e[- ]?mail|email|courriel|correo)(?:[- ]*(?:address|adresse|indirizzo))?|(?:address|adresse|indirizzo)[- ]*(?:e[- ]?mail|email|courriel))$/.test(caption);
  };
  // A lexical hint can require provenance, never authorize an address value.
  // Derive it from the same positive vocabulary instead of a second alias list.
  const mentionsResidenceFieldRole = value => {
    if (isIdentityEmailCaption(value)) return false;
    const words = String(value || '').match(/\p{L}+/gu) || [];
    return Boolean(residenceFieldRole(value)) || words.some((word, index) =>
      residenceFieldRole(word) || residenceFieldRole(`${word} ${words[index + 1] || ''}`));
  };
  root.AssistedApplyControls = Object.freeze({ APPLY_RE, APPLY_LATER_RE, startsApplication, preferredDocumentControls, isNonCvDocumentLabel, residenceFieldRole, mentionsResidenceFieldRole, isIdentityEmailCaption });
})(globalThis);
