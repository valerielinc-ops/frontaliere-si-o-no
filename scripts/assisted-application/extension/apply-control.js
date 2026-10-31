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
  // BEGIN GENERATED APPLICATION CONSENT
  const pureApplicationConsent = (function createApplicationConsentGuard(factSources = {}) {
  const plain = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/['’`]/g, ' ').replace(/\s+/g, ' ').trim();
  const PRIVACY = /privacy|datenschutz|datenverarbeitung|data protection|data processing|processing (?:of )?(?:(?:my|your|the|personal) )*data|protezione (?:dei )?dati|trattamento (?:(?:dei|di|miei|tuoi|propri) )*dati|informativa|protection des donnees|traitement (?:(?:de|des|mes|vos) )*donnees|confidentialite/;
  const APPLICATION_TERMS = /(?:application|bewerbung|candidatur[ae]).{0,100}(?:terms|conditions|bedingungen|agb|termini|condizioni)|(?:terms|conditions|bedingungen|agb|termini|condizioni).{0,100}(?:application|bewerbung|candidatur[ae])/;
  const ACCEPTANCE = /\b(?:accept(?:e|ed)?|agree(?:d)?|consent(?:o|ire)?|accett[oa]|acconsent[oa]|akzeptiere|stimme zu|j accepte)\b/;
  const NEGATED = /\b(?:do(?:es)? not|don t|doesn t|cannot|can t|can not|unable to|not able to|will not|won t|shall not|shan t) (?:accept|agree|consent)|\b(?:non|nein|nicht) (?:accett|acconsent|accept|agree|consent|akzept|stimm)|\bn accepte pas|\b(?:accepte|akzeptiere|stimme) (?:pas|nicht)|\b(?:refus\w*|rifiut[oa]|verweiger\w*)\b/;
  const OPTIONAL = /newsletter|marketing|werbung|pubblicit|promozion|promotion|offerte|angebote|job.?alert|job.?abo|talent.?pool|future (?:openings|opportunities|positions|vacancies)|other (?:companies|vacancies|positions)|weitere stellen|andere stellen|altre (?:posizioni|offerte|societa)|autres (?:postes|offres|societes)|third part|dritte|\bterzi\b|\btiers\b|whatsapp/;
  const OTHER_TERMS = /vermittlungsburo|personalvermittl|placement agency|recruit(?:ment|ing) agency|staffing agency|agenzia (?:per il lavoro|di collocamento|interinale)|agence (?:de placement|de recrutement)|erfolgsbasis|success fee|membership|subscription|abonnement|abbonamento|purchase|purchasing|agency terms|commercial terms|conditions de vente|condizioni di vendita|verkaufsbedingungen|credit check|background check|medical examination|drug test/;
  const factSource = String.raw`permit|bewilligung|permesso di (?:lavoro|soggiorno|domicilio)|\bvisa\b|passport|passaport|passeport|reisepass|ausweis|patente|f[üu]hrerschein|fahrausweis|driving licen[cs]e|permis de (?:conduire|travail|séjour)|\b[abc][12]\b|years? of|berufserfahrung|anni di esperienza|ann[ée]es d.exp[ée]rience|strafregister|casellario|criminal|\bdiplom|\bdegree\b|abschluss|\blaurea\b|certificat|attestat|zeugnis|\bexperience\b|\berfahrung\b|\besperienza\b|qualification|requirements|voraussetzungen|requisiti|maggiorenn|volljahr|\bmajeur\b|\bover\s+18\b`;
  const FACTS = new RegExp([factSource, ...Object.values(factSources).filter(Boolean)].join('|'), 'i');
  const ACCURACY = /(?:information|details|answers|angaben|informationen|dati|informazioni|renseignements).{0,80}(?:true|accurate|correct|complete|truthful|wahr|richtig|vollstandig|veritier|corrett|veriti|esatt|sincere|exact|complet)/;

  // A privacy word is not authority for the rest of a sentence. Every word
  // must stay in the closed language of reading/accepting this notice.
  // New declarations, qualifications or other purposes remain unknown.
  const PRIVACY_WORDS = new Set(`i me my myself you your yours we our the a an and or to of for in on by with under as per that this these have has having am are is been be it its here hereby do yes read reading understood understand acknowledge acknowledged acknowledgment consent consenting accept accepts accepted accepting agree agreed agreement clicking click confirming confirm accordance pursuant subject comply complies provided provide provision provisions terms conditions application applications candidate candidates applicant applicants applying privacy policy policies statement statements notice notices protection processing process processed collection collected collecting storage storing stored electronic electronically personal data information handling use using accordance
  io ho do permesso me mia mie miei mio tu tuo tua tuoi tue noi nostri nostri il lo la le gli l dei degli delle della dello dell di del al alla allo all ai agli alle a da dal dalla in con su per e o secondo sensi disposizioni materia accetto accetta accettare accettazione acconsento consenso consento autorizzo autorizzazione letto letta leggere lettura compreso compresa comprendo preso visione informativa trattamento trattati trattare protezione dati personali memorizzazione elettronica elettronico conservazione candidatura candidature candidato candidati condizioni termini sensi
  ich mir mich mein meine meiner meinen meines du dir dich dein deine ihrer ihre ihren ihrem sie wir uns unser unsere der die das des den dem ein eine einer eines einem einen und oder zu zur zum von im in am an fur mit nach gemaess gemass laut dass diese dieser dieses diesen hiermit habe haben gelesen lesen verstanden verstehe akzeptiere akzeptieren akzeptiert stimme stimmen zustimmung einwillige einwilligung einverstanden erklarung erklarungen datenschutz datenschutzerklarung datenschutzerklaerung datenschutzhinweise datenschutzbestimmungen daten personenbezogenen personenbezogener personlichen verarbeitung verarbeiten speicherung elektronischen elektronischer elektronische bewerbung bewerbungen bewerber bewerberin nutzungsbedingungen bewerbungsbedingungen hinweise bestimmungen
  je moi mon ma mes me vous votre vos nous nos le la les l de des du d au aux a par pour en avec et ou que cette ce ces j ai lu lire pris prise connaissance compris comprends accepte accepter acceptation consens consentement autorise autorisation conformement dispositions matiere politique confidentialite protection traitement donnees personnelles conservation electronique candidature candidatures candidat candidats conditions generales utilisation`.split(/\s+/));
  const OPTIONAL_WORDS = new Set(`receive receiving send sending subscribe subscribing subscription newsletter newsletters marketing promotional promotion advertising advertisements job jobs alert alerts pool talent future opportunities openings positions vacancies whatsapp messages message communication communications contacted contact updates offers other companies third parties
  ricevere ricevo inviare invio comunicazioni comunicazione messaggi messaggio aggiornamenti newsletter marketing pubblicita promozionali promozioni offerte altre posizioni societa terzi whatsapp
  erhalten empfange senden zusenden abonnieren abonniere newsletter werbung marketing werbliche informationen stellen stellenangebote jobabo talentpool zukunftige weitere andere unternehmen dritte dritter whatsapp nachrichten kontaktieren
  recevoir envoyer abonner abonnement newsletter marketing publicite promotionnelles offres autres postes societes tiers whatsapp messages communications actualites`.split(/\s+/));
  const positiveLanguage = (value, optional = false) => plain(value).replace(/&/g, ' and ').split(/[^a-z0-9]+/).filter(Boolean)
    .every(word => PRIVACY_WORDS.has(word) || optional && OPTIONAL_WORDS.has(word));

  const GENERIC_TERMS = /\bterms\b|nutzungsbedingungen|teilnahmebedingungen|\bagb\b|termini|condizioni|conditions generales|conditions d utilisation/;
  const context = field => {
    if (field?.kind !== 'checkbox' || field.consentOwnershipUnknown === true || field.ownConsentMetadataComplete !== true
      || field.ownConsentQuestionOwned !== true || !Array.isArray(field.ownConsentText)
      || !Array.isArray(field.ownConsentLinks) || typeof field.ownConsentOwnerKey !== 'string') return null;
    const own = [...new Set([field.label, ...field.ownConsentText].map(value => String(value || '').trim()).filter(Boolean))].join(' ');
    if (!own || own.length > 16_000 || field.ownConsentOwnerKey.length > 4096) return null;
    let owner;
    try { owner = JSON.parse(field.ownConsentOwnerKey); } catch { return null; }
    if (owner?.v !== 1 || !Array.isArray(owner.scopes)) return null;
    const text = plain(own), veto = `${own} ${field.name || ''} ${field.autocomplete || ''}`;
    const normalizedVeto = plain(veto);
    if (NEGATED.test(normalizedVeto) || OTHER_TERMS.test(normalizedVeto)
      || FACTS.test(veto) || FACTS.test(normalizedVeto) || ACCURACY.test(normalizedVeto)
      ) return null;
    if (field.ownConsentLinks.length > 16) return null;
    const purposes = [];
    for (const link of field.ownConsentLinks) {
      if (typeof link !== 'string' || link.length > 2048) return null;
      let url;
      try { url = new URL(link); } catch { return null; }
      if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) return null;
      try { purposes.push(plain(decodeURIComponent(`${url.pathname} ${url.search} ${url.hash}`)).replace(/[-_/?=&.]+/g, ' ')); } catch { return null; }
    }
    return { text, purposes, positive: positiveLanguage(text), optionalPositive: positiveLanguage(text, true) };
  };
  const isConsentOnly = field => {
    const value = context(field);
    return Boolean(value && value.optionalPositive && (PRIVACY.test(value.text) || APPLICATION_TERMS.test(value.text) || OPTIONAL.test(value.text))
      && value.purposes.every(purpose => !OTHER_TERMS.test(purpose) && !FACTS.test(purpose) && (PRIVACY.test(purpose) || APPLICATION_TERMS.test(purpose) || OPTIONAL.test(purpose))));
  };
  const isConsentRefusal = value => value === false || value === 0
    || /^(?:no|nein|non|false|0|decline|refuse|rifiuto|non accetto|ich stimme nicht|je refuse)(?:$|[ ,;.!])/.test(plain(value));
  const pureApplicationConsent = field => {
    const value = context(field);
    if (!value || !value.positive || (!PRIVACY.test(value.text) && !APPLICATION_TERMS.test(value.text))) return false;
    if (!field.required && !ACCEPTANCE.test(value.text)) return false;
    if (OPTIONAL.test(value.text) || value.purposes.some(purpose => OPTIONAL.test(purpose) || OTHER_TERMS.test(purpose) || FACTS.test(purpose) || !PRIVACY.test(purpose) && !APPLICATION_TERMS.test(purpose))) return false;
    if (GENERIC_TERMS.test(`${value.text} ${value.purposes.join(' ')}`) && !APPLICATION_TERMS.test(value.text)) return false;
    return true;
  };
  return Object.freeze(Object.assign(pureApplicationConsent, { isConsentOnly, isConsentRefusal }));
})({"birth":"birth|geburt|nascita|\\bnat[oa]\\b|naissance","nationality":"nationalit|nazionalit|cittadinanz|citizen|staatsangeh|staatsb(?:ü|ue)rger|citoyennet","workAuthorisation":"arbeitserlaubnis|aufenthaltserlaubnis|aufenthaltsstatus|aufenthaltstitel|ausl(?:ä|ae)nderausweis|ausweis(?:typ|art|kategorie)|\\bausweis\\b(?!\\s*-?\\s*(?:nr|nummer|no)\\b)|grenzg(?:ä|ae)nger|frontali(?:e|è)r|autorizzazione (?:al|di|per il) lavoro|autorizzat[oa] a lavorare|diritto (?:al|di) lavor|titolo di soggiorno|stato di soggiorno|permis de (?:travail|s(?:é|e)jour)|autorisation (?:de travail|de s(?:é|e)jour|frontali(?:è|e)re|d['’](?:é|e)tablissement|de courte dur(?:é|e)e)|titre de s(?:é|e)jour|statut de s(?:é|e)jour|autoris(?:é|e)e? (?:à|a) travailler|droit de travailler|work authori[sz]ation|authori[sz]ed to work|right to work|eligib(?:le|ility) to work|legally (?:able|allowed|entitled|permitted) to work|sponsorship|residence status|immigration status"});
  const readOwnConsentMetadata = function readOwnConsentMetadata(element, primaryLabel = '', questionOwned = false, questionNodes = []) {
  let complete = Boolean(element?.isConnected && element.matches('input[type="checkbox"]'));
  const own = new Set(), primary = new Set(), links = new Set(), visited = new Set(), active = new Set();
  const doc = element?.ownerDocument;
  const direct = ['aria-label', 'aria-description', 'aria-roledescription', 'title', 'placeholder', 'alt'];
  const refs = ['aria-labelledby', 'aria-describedby', 'aria-details'];
  const controlSelector = 'input:not([type="hidden"]), select, textarea, [role="checkbox"], [role="radio"], [role="combobox"], button[aria-haspopup="listbox"], [ui5-date-picker], [data-scope="date-picker"][data-part="root"]';
  const ids = new Map();
  if (doc) for (const node of doc.querySelectorAll('[id]')) {
    if (node.id) ids.set(node.id, [...ids.get(node.id) || [], node]);
  }
  if (element?.id && ids.get(element.id)?.length !== 1) complete = false;
  let bytes = 0, linkBytes = 0, referenceCount = 0;
  const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
  const add = (value, isPrimary = false) => {
    const text = clean(value);
    if (!text) return;
    if (text.length > 8_000 || !own.has(text) && (bytes + text.length > 12_000 || own.size >= 64)) { complete = false; return; }
    if (!own.has(text)) { own.add(text); bytes += text.length; }
    if (isPrimary) primary.add(text);
  };
  const textOf = node => {
    const parts = [], walker = doc.createTreeWalker(node, 4);
    for (let text = walker.nextNode(); text; text = walker.nextNode()) {
      if (!text.parentElement?.closest('script, style, noscript, select, option, textarea')) parts.push(text.textContent);
    }
    return clean(parts.join(' '));
  };
  const visit = (node, isPrimary = false) => {
    if (!node?.isConnected || active.has(node)) { complete = false; return; }
    if (visited.has(node)) { if (isPrimary) add(textOf(node), true); return; }
    if (visited.size >= 64) { complete = false; return; }
    if ([...node.querySelectorAll(controlSelector)].some(control => control !== element)) { complete = false; return; }
    const linkedLabels = [...node.querySelectorAll('label[for]'), ...(node.matches('label[for]') ? [node] : [])];
    if (linkedLabels.some(label => label.getAttribute('for') && label.control !== element && !questionNodes.includes(label))) { complete = false; return; }
    const label = node.closest('label');
    if (label?.hasAttribute('for') && label.getAttribute('for') && label.control !== element && !questionNodes.includes(label)) { complete = false; return; }
    visited.add(node); active.add(node);
    add(textOf(node), isPrimary);
    for (const anchor of [...(node.matches('a[href]') ? [node] : []), ...node.querySelectorAll('a[href]')]) {
      const raw = anchor.getAttribute('href') || '';
      if (raw.length > 2048) { complete = false; continue; }
      let href;
      try {
        const url = new URL(raw, doc.baseURI);
        if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) { complete = false; continue; }
        href = url.href;
      } catch { complete = false; continue; }
      if (href.length > 2048 || !links.has(href) && (links.size >= 16 || linkBytes + href.length > 8192)) { complete = false; continue; }
      if (!links.has(href)) { links.add(href); linkBytes += href.length; }
    }
    for (const attribute of direct) add(node.getAttribute(attribute), isPrimary && attribute === 'aria-label');
    for (const attribute of refs) {
      for (const id of clean(node.getAttribute(attribute)).split(/\s+/).filter(Boolean)) {
        if (++referenceCount > 24 || id.length > 256 || ids.get(id)?.length !== 1) { complete = false; continue; }
        visit(ids.get(id)[0], isPrimary && attribute === 'aria-labelledby');
      }
    }
    for (const child of node.querySelectorAll(direct.concat(refs).map(attribute => `[${attribute}]`).join(','))) {
      if (child !== element && !visited.has(child)) visit(child, isPrimary);
    }
    active.delete(node);
  };
  if (complete) {
    // Keep the input active while following references: a self-reference is unknown.
    active.add(element);
    for (const label of element.labels || []) visit(label, true);
    const wrapping = element.closest('label');
    if (wrapping && !visited.has(wrapping)) visit(wrapping, true);
    for (const attribute of direct) add(element.getAttribute(attribute), attribute === 'aria-label');
    for (const attribute of refs) for (const id of clean(element.getAttribute(attribute)).split(/\s+/).filter(Boolean)) {
      if (++referenceCount > 24 || id.length > 256 || ids.get(id)?.length !== 1) { complete = false; continue; }
      visit(ids.get(id)[0], attribute === 'aria-labelledby');
    }
    const labelledBy = clean(element.getAttribute('aria-labelledby')).split(/\s+/).filter(Boolean);
    if (labelledBy.length && labelledBy.every(id => ids.get(id)?.length === 1)) add(labelledBy.map(id => textOf(ids.get(id)[0])).join(' '), true);
    active.delete(element);
    for (const node of questionNodes) visit(node, true);
    if (questionOwned) add(primaryLabel);
  }
  const form = element?.form || element?.closest('[role="form"]');
  let actionPath = '';
  try { const url = new URL(form?.action || doc?.URL || ''); actionPath = `${url.origin}${url.pathname}`; } catch { complete = false; }
  const scopes = [];
  for (let node = element?.parentElement, depth = 0; node && node !== doc?.body; node = node.parentElement, depth++) {
    if (depth >= 64) { complete = false; break; }
    if (!node.matches('fieldset, section, article, [role="group"], [role="radiogroup"], [role="region"], form, [role="form"]')) continue;
    const values = [node.getAttribute('aria-label') || ''];
    for (const id of clean(node.getAttribute('aria-labelledby')).split(/\s+/).filter(Boolean)) {
      if (ids.get(id)?.length !== 1) { complete = false; continue; }
      values.push(textOf(ids.get(id)[0]));
    }
    const heading = [...node.children].find(child => child.matches('legend, h1, h2, h3, h4, [role="heading"]'));
    if (heading) values.push(textOf(heading));
    const label = [...new Set(values.map(clean).filter(Boolean))].join(' · ');
    if (label.length > 1024) { complete = false; continue; }
    if (label || node.id) scopes.push({ tag: node.tagName, id: node.id || '', role: node.getAttribute('role') || '', label });
  }
  const owner = { v: 1, tag: element?.tagName, type: element?.type, id: element?.id || '', name: element?.name || '',
    form: { tag: form?.tagName || '', id: form?.id || '', index: form ? [...doc.querySelectorAll('form, [role="form"]')].indexOf(form) : -1,
      action: actionPath, method: form?.method || '' }, autocomplete: element?.getAttribute('autocomplete') || '', scopes };
  let ownerKey = '';
  if ([owner.id, owner.name, owner.form.id, actionPath, owner.autocomplete].some(value => value.length > 2048)) complete = false;
  else ownerKey = JSON.stringify(owner);
  if (ownerKey.length > 4096) { complete = false; ownerKey = ''; }
  return {
    ownConsentText: complete ? [...own] : [],
    ownConsentQuestionLabels: complete ? [...primary] : [],
    ownConsentLinks: complete ? [...links] : [],
    ownConsentMetadataComplete: complete,
    ownConsentQuestionOwned: questionOwned === true,
    ownConsentOwnerKey: ownerKey,
    consentOwnershipUnknown: !complete || questionOwned !== true,
  };
};
  // END GENERATED APPLICATION CONSENT
  root.AssistedApplyControls = Object.freeze({ APPLY_RE, APPLY_LATER_RE, startsApplication, preferredDocumentControls, isNonCvDocumentLabel, pureApplicationConsent, isConsentOnly: pureApplicationConsent.isConsentOnly, isConsentRefusal: pureApplicationConsent.isConsentRefusal, readOwnConsentMetadata });
})(globalThis);
