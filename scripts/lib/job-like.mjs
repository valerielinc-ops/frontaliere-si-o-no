/**
 * "Is this page actually a job ad?" — the check the quality gate never had.
 *
 * The four checks in `validate.mjs` (reachable, titleMatch, contentful,
 * distinct) all grade the extraction against ITSELF: does the URL resolve, does
 * the title we hold match the heading that page serves, is there prose, are the
 * rows different from one another. Every one of them can be perfectly satisfied
 * by content that is not a vacancy at all, and that is not a hypothetical:
 *
 *   - hotel-international scored 1.00 on all four while publishing four room
 *     promos ("Offerta speciale 3 notti", "Prenota SENZA carta di credito!")
 *     as job listings — the hotel's `/it/jobs/` page carries no vacancy, only
 *     the site's promo carousel, and `/it/offerte/*​/` won the cluster;
 *   - 115west scored 1.00 on architecture competition write-ups
 *     (`/projekte/wettbewerbe/<slug>`);
 *   - albergo-gardenia scored 1.00 on trade-association policy articles.
 *
 * Internally coherent, semantically wrong. So this module asks the one question
 * the others cannot: does the detail page READ like a job ad?
 *
 * It is deliberately a MARGIN, not a veto on forbidden words. A hotel's real
 * vacancy page carries the same site chrome as its promo page — "Camere",
 * "Colazione", "Prenota" all sit in the nav of both — so any rule that rejects
 * on the presence of booking vocabulary would delete exactly the hospitality
 * employers this loop exists to find, in a canton where hospitality is the
 * sector. What separates the two is that a real vacancy also carries the things
 * a promo page never has: a way to apply, a CV, a workload, requirements,
 * duties, an offer. The rule is therefore "enough job evidence, and more job
 * evidence than not-job evidence".
 *
 * Signals are counted as GROUPS, once each, so a page repeating "prenota"
 * fifteen times weighs the same as one that says it once. Vocabulary covers the
 * four locales the corpus serves (it/de/fr/en) because a Swiss employer's
 * careers page is as likely to be German as Italian.
 */

/**
 * Evidence that a page is a job ad. One entry = one independent signal group.
 * @type {[string, RegExp][]}
 */
const JOB_SIGNALS = [
  ['apply', /(candidat|candidar|postul|bewerb|apply now|apply for|how to apply|invia(?:re)? (?:il tuo |la )?(?:cv|candidatura)|jetzt bewerben)/i],
  ['cv', /(curriculum vitae|\bcv\b|lebenslauf|dossier de candidature|\bresume\b|bewerbungsunterlagen|lettera di motivazione|motivationsschreiben|lettre de motivation|cover letter)/i],
  ['pay', /(stipendio|salario|retribuzione|salaire|r[eé]mun[eé]ration|gehalt|\blohn\b|salary|compensation package)/i],
  ['workload', /(tempo pieno|tempo parziale|vollzeit|teilzeit|temps plein|temps partiel|full.?time|part.?time|\bpensum\b|grado di occupazione|besch[aä]ftigungsgrad|taux d.occupation|\b\d{1,3}\s?[-–]\s?100\s?%|\b(?:50|60|70|80|90|100)\s?%)/i],
  ['contract', /(contratto (?:di|a|d.) |tipo di contratto|arbeitsvertrag|unbefristet|befristet|contrat (?:[aà] dur[eé]e|de travail)|permanent (?:position|contract)|employment type|rapporto di lavoro)/i],
  ['requirements', /(requisiti|profilo (?:richiesto|ricercato)|competenze richieste|anforderungen|voraussetzungen|dein profil|ihr profil|exigences|profil recherch[eé]|votre profil|requirements|qualifications|your profile|what you bring)/i],
  ['duties', /(mansioni|compiti|le tue attivit|i tuoi compiti|aufgaben|t[aä]tigkeiten|deine aufgaben|ihre aufgaben|vos missions|responsabilit[eé]s|t[aâ]ches|responsibilities|your role|il tuo ruolo|what you.ll do)/i],
  ['offer', /(ti offriamo|vi offriamo|offriamo|cosa offriamo|wir bieten|unser angebot|wir freuen uns auf|nous (?:vous )?offrons|ce que nous offrons|we offer|what we offer)/i],
  ['gender-tag', /\(\s*[mwfh]\s*[\/|]\s*[mwfdh](?:\s*[\/|]\s*[mwfdhx])?\s*\)/i],
  ['workplace', /(sede di lavoro|luogo di lavoro|arbeitsort|einsatzort|lieu de travail|work location|place of work|data (?:di )?inizio|eintrittsdatum|entr[eé]e en fonction|start date|ab sofort|inizio immediato)/i],
  ['hr', /(risorse umane|ufficio del personale|human resources|personalabteilung|personaldienst|ressources humaines|hiring manager|talent acquisition|recruiting team|selezione del personale)/i],
];

/**
 * Evidence that a page is booking, retail or promotional content.
 * @type {[string, RegExp][]}
 */
const NOT_JOB_SIGNALS = [
  ['booking', /(prenot|buchen sie|jetzt buchen|r[eé]server|r[eé]servation|book now|booking|verf[uü]gbarkeit pr[uü]fen|verifica disponibilit)/i],
  ['stay', /(camera doppia|camere|zimmer|chambre|\brooms?\b|\bsuite\b|pernottament|[uü]bernachtung|nuit[eé]e|soggiorno|aufenthalt|s[eé]jour|\d+\s?(?:notti|n[aä]chte|nuits|nights))/i],
  ['board', /(prima colazione|colazione inclusa|fr[uü]hst[uü]ck|petit.d[eé]jeuner|breakfast included|mezza pensione|halbpension|demi.pension|all inclusive)/i],
  ['promo', /(offerta speciale|prezzo speciale|miglior prezzo|sonderangebot|bestpreis|offre sp[eé]ciale|meilleur prix|special offer|best price|sconto|rabatt|r[eé]duction|\bdiscount\b|risparmia|sparen sie|buono regalo|gutschein|bon cadeau|gift card)/i],
  ['price', /(a partire da chf|ab chf|d[eè]s chf|from chf|per notte|pro nacht|par nuit|per night|iva inclusa|inkl\. mwst|tva incluse)/i],
  ['ecommerce', /(carrello|warenkorb|panier|aggiungi al carrello|in den warenkorb|add to cart|acquista ora|jetzt kaufen|acheter maintenant|buy now|spedizione|versandkosten|frais de livraison|shipping costs)/i],
  ['payment', /(carta di credito|kreditkarte|carte de cr[eé]dit|credit card|pagamento sicuro|sichere zahlung|paiement s[eé]curis[eé]|secure payment)/i],
  ['checkin', /(check.?in|check.?out|arrivo e partenza|anreise|abreise|arriv[eé]e et d[eé]part)/i],
  ['amenities', /(piscina|schwimmbad|piscine|\bspa\b|wellness|\bsauna\b|vista lago|seesicht|vue sur le lac|lake view)/i],
];

/** @param {string} text @param {[string, RegExp][]} groups @returns {string[]} */
function hits(text, groups) {
  return groups.filter(([, rx]) => rx.test(text)).map(([name]) => name);
}

/**
 * Grade one page's text on whether it reads as a job ad.
 *
 * @param {string} text  Plain text of the detail page (tags already stripped).
 * @returns {{ jobLike: boolean, jobHits: string[], notJobHits: string[] }}
 */
export function gradeJobLike(text = '') {
  const t = String(text || '');
  const jobHits = hits(t, JOB_SIGNALS);
  const notJobHits = hits(t, NOT_JOB_SIGNALS);
  // Two independent job signals is the floor: one alone is met by ordinary
  // corporate prose ("il nostro team", a percentage in a price table). Above the
  // floor the margin decides, so shared site chrome cannot sink a real vacancy
  // while a promo page — which has the chrome and none of the job evidence —
  // never clears it.
  const jobLike = jobHits.length >= 2 && jobHits.length > notJobHits.length;
  return { jobLike, jobHits, notJobHits };
}

/**
 * Does the text carry ANY evidence of being a job ad?
 *
 * Weaker than `gradeJobLike` on purpose: this is the shape a *veto* needs.
 * `shared-jobs-crawler.mjs` drops a record when enough retail vocabulary fires
 * AND no job vocabulary does, and that second half is what protects a real
 * vacancy from being thrown away. It used to carry its own eleven-string list —
 * two vocabularies for one question, drifting apart by construction. Widening
 * the veto can only make that detector more conservative, never more
 * aggressive, so sharing this direction is safe where sharing the whole rule
 * would not be.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function hasAnyJobSignal(text = '') {
  const t = String(text || '');
  return JOB_SIGNALS.some(([, rx]) => rx.test(t));
}

export const JOB_LIKE_SIGNAL_NAMES = JOB_SIGNALS.map(([n]) => n);
export const NOT_JOB_LIKE_SIGNAL_NAMES = NOT_JOB_SIGNALS.map(([n]) => n);
