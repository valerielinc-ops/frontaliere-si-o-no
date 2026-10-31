/** Positive identity purpose and applicant ownership. No candidate value is proof of a target actor. */
import { nativeQuestionText } from './nativeQuestionText.js';

export function createCandidateIdentityContract({ nativeQuestionText }) {
  const plain = value => nativeQuestionText(value).toLocaleLowerCase().replace(/^[＊*\s]+|[＊*:?!]+$/gu, '').trim()
    .replace(/\s*\((?:required|optional|erforderlich|pflichtfeld|obbligatorio|facoltativo|obligatoire|facultatif)\)$/iu, '').trim();
  const selfPrefix = /^(?:your|my|candidate['’]?s?|applicant['’]?s?|personal|ihr(?:e|en)?|mein(?:e|en)?|dein(?:e|en)?|il tuo|la tua|il suo|la sua|tuo|tua|suo|sua|vostro|vostra|votre|mon|ma|ton|ta)\s+/iu;
  const selfQuestion = /^(?:what is your|please enter your|enter your|qual è il tuo|qual è la tua|inserisci il tuo|inserisci la tua|wie lautet ihr(?:e)?|veuillez saisir votre|saisissez votre)\s+/iu;
  const selfSuffix = /\s+(?:of (?:the )?(?:candidate|applicant)|del candidato|della candidata|du candidat|de la candidate|des bewerbers|der bewerberin)$/iu;
  const genericPrefix = /^(?:please enter|enter|inserisci|inserire|saisissez|veuillez saisir)\s+/iu;
  const parseCaption = value => {
    let text = plain(value);
    let self = selfQuestion.test(text) || selfPrefix.test(text) || selfSuffix.test(text);
    text = text.replace(selfQuestion, '').replace(genericPrefix, '').replace(selfPrefix, '').replace(selfSuffix, '');
    text = text.replace(/^(?:confirm|repeat|re-enter|conferma|ripeti|confirmer)\s+(?:your\s+)?/iu, '')
      .replace(/\s+(?:bestätigen|wiederholen|confirmation)$/iu, '');
    let role = '';
    if (/^(?:first ?name|given names?|forename|vorname(?:n|\(n\))?|prénom|nome)$/iu.test(text)) role = 'firstName';
    else if (/^(?:last ?name|surname|family name|nachname|familienname|cognome|nom|nom de famille)$/iu.test(text)) role = 'lastName';
    else if (/^(?:name|full ?name|complete name|first and last name|nome e cognome|nome completo|nom complet|vollständiger name)$/iu.test(text)) role = 'fullName';
    else if (/^(?:e-?mail(?:[ -]?(?:address|adresse))?|indirizzo e-?mail|adresse e-?mail|courriel|adresse courriel)$/iu.test(text)) role = 'email';
    else if (/^(?:phone(?: ?number)?|telephone(?: number)?|mobile(?: phone)?(?: number)?|cell phone(?: number)?|mobiltelefon|telefon(?:nummer)?(?: \(mobil\))?|mobil(?:nummer)?|numero di telefono|telefono|cellulare|téléphone|numéro de téléphone)$/iu.test(text)) role = 'phone';
    else if (/^(?:country phone code|phone country code|dialling code|dialing code|telefonvorwahl|prefisso telefonico|code téléphonique)$/iu.test(text)) role = 'phoneCountry';
    else if (/^linkedin(?: profile)?(?: url)?$/iu.test(text)) role = 'linkedin';
    return { role, self };
  };
  function candidateIdentityRole(contract) {
    if (!contract || typeof contract.question !== 'string' || !['text', 'select', 'combobox', 'listbox'].includes(contract.kind)) return '';
    const role = parseCaption(contract.question).role;
    if (!role) return '';
    if (contract.kind !== 'text' && role !== 'phoneCountry') return '';
    const type = String(contract.controlType || contract.validation?.type || '').toLowerCase();
    if (type === 'email' && role !== 'email' || type === 'tel' && !['phone', 'phoneCountry'].includes(role)) return '';
    if (!['', 'text', 'email', 'tel', 'search', 'url', 'select', 'combobox', 'listbox'].includes(type)) return '';
    const auto = String(contract.autocomplete || '').trim().split(/\s+/).at(-1);
    const roles = { email: 'email', 'given-name': 'firstName', 'family-name': 'lastName', name: 'fullName', tel: 'phone', 'tel-national': 'phone', 'tel-country-code': 'phoneCountry' };
    if (roles[auto] && roles[auto] !== role) return '';
    return role;
  }
  function identityControlRole(contract) {
    const basic = candidateIdentityRole(contract);
    if (basic) return basic;
    const question = plain(contract?.question);
    // Other-actor contact captions are recognized as a role, never as the
    // applicant. This uses the same role parser after a complete actor phrase.
    const prefix = /^(reference|referee|spouse|emergency contact|contact person|supervisor|manager|employer|company|organisation|organization|referente|coniuge|contatto di emergenza|datore di lavoro|azienda|referenzperson|ehepartner|notfallkontakt|arbeitgeber|unternehmen|personne de référence|conjoint|contact d['’]urgence|employeur|entreprise)(?:['’]s)?\s+(.+)$/iu.exec(question);
    const suffix = /^(.+)\s+(?:of (?:the )?(reference|referee|spouse|emergency contact|employer|company)|del (referente|coniuge|datore di lavoro)|della (azienda)|der (referenzperson|ehepartner)|des (arbeitgebers)|du (conjoint)|de (l['’]employeur))$/iu.exec(question);
    const caption = prefix?.[2] || suffix?.[1];
    if (!caption) return '';
    const role = candidateIdentityRole({ ...contract, question: caption });
    if (['email', 'phone', 'phoneCountry'].includes(role)) return role;
    const person = prefix?.[1] || suffix?.slice(2).find(Boolean) || '';
    return /^(?:reference|referee|spouse|emergency contact|contact person|supervisor|manager|referente|coniuge|contatto di emergenza|referenzperson|ehepartner|notfallkontakt|personne de référence|conjoint|contact d['’]urgence)$/iu.test(person) ? role : '';
  }
  const actorScope = /^(?:your (?:application|profile|personal (?:data|details|information)|contact (?:data|details|information))|personal (?:data|details|information)|candidate(?:['’]s)? (?:data|details|information|profile|contact details)|applicant(?:['’]s)? (?:data|details|information|profile|contact details)|application(?: form)?|create account|account details|registration|login details|bewerbung(?:sformular)?|bewerber(?:daten|profil)|persönliche (?:daten|angaben|informationen)|konto erstellen|benutzerkonto|registrierung|candidatura|dati personali|informazioni personali|dati del candidato|profilo del candidato|crea account|registrazione|candidature|formulaire de candidature|données personnelles|informations personnelles|profil du candidat|créer un compte|inscription)$/iu;
  const neutralScope = /^(?:contact (?:data|details|information)|contatti|dati di contatto|kontaktdaten|coordonnées|application documents|supporting documents|documents|documenti(?: di candidatura)?|bewerbungsunterlagen|unterlagen|dokumente|documents de candidature)$/iu;
  function isCandidateIdentityTarget(contract) {
    const role = candidateIdentityRole(contract);
    if (!role || !Array.isArray(contract.ownedScopes) || contract.ownedScopes.length > 32) return false;
    const own = parseCaption(contract.question);
    let provedSelf = own.self;
    let textSize = 0;
    // Every competing name at a node is checked before any self caption can
    // authorize the target. Unknown ownership never jumps to an outer actor.
    for (const scope of contract.ownedScopes) {
      if (!scope || !['group', 'form'].includes(scope.kind) || scope.unknown !== false
        || Object.keys(scope).some(key => !['kind', 'names', 'unknown'].includes(key))
        || !Array.isArray(scope.names) || scope.names.length > 64) return false;
      for (const name of scope.names) {
        if (typeof name !== 'string' || name.length > 8000 || (textSize += name.length) > 12000) return false;
        const text = plain(name);
        if (actorScope.test(text)) { provedSelf = true; continue; }
        if (neutralScope.test(text) || parseCaption(text).role === role) continue;
        return false;
      }
    }
    for (const text of [contract.context || '', contract.section || ''].flatMap(text => text.split(' · ')).filter(Boolean)) {
      const clean = plain(text);
      if (actorScope.test(clean)) { provedSelf = true; continue; }
      if (neutralScope.test(clean)) continue;
      const contextCaption = parseCaption(clean);
      if (contextCaption.role === role) { provedSelf ||= contextCaption.self; continue; }
      if (role === 'email' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(clean)) continue;
      if (/^(?:required|mandatory|pflichtfeld|erforderlich|obbligatorio|obligatoire)$/iu.test(clean)) continue;
      return false;
    }
    return provedSelf;
  }
  return { candidateIdentityRole, identityControlRole, isCandidateIdentityTarget };
}
export const { candidateIdentityRole, identityControlRole, isCandidateIdentityTarget } = createCandidateIdentityContract({ nativeQuestionText });
