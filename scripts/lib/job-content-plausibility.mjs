/**
 * job-content-plausibility.mjs — riconoscimento deterministico di record
 * `data/jobs/by-crawler/*.json` che NON sono annunci di lavoro.
 *
 * Perche' esiste (2026-08-24, due difetti trovati A MANO dal proprietario —
 * nessuno strumento automatico li aveva mai segnalati):
 *   1. `hotel-international` (crawler promosso dal prospector) pubblicava 5/5
 *      "annunci" che erano offerte promozionali per camere d'hotel:
 *      "Prenota SENZA carta di credito!", "Offerta speciale 3 notti",
 *      "Perche' prenotare direttamente", "Top-3-Star-Hotels".
 *   2. `schindler` aveva 11 job con titolo "Manager fur Cookie-Einwilligungen"
 *      / "Gestore consenso ai cookie" / "Gestionnaire de consentements pour
 *      les cookies" — il widget di consenso cookie del sito sorgente scambiato
 *      per un titolo, abbinato alla descrizione di un ruolo reale diverso.
 *
 * Cosa NON copriva il resto della cassetta degli attrezzi:
 *   - `scripts/check-crawler-health.mjs` / `crawler-health-monitor.yml`:
 *     freshness e non-vuoto. Un crawler che pubblica 5 offerte alberghiere e'
 *     UP e fresco.
 *   - `scripts/audit-parser-quality.mjs`: descrizioni thin, duplicate,
 *     struttura mancante, URL stale. Le descrizioni dei due casi sopra sono
 *     lunghe, uniche e ben strutturate — l'audit passa.
 *   - `crawler-data-quality-audit.yml`: slug/previousSlugs/traduzioni/merge.
 *     Nessuna categoria guarda se il titolo *e' un lavoro*.
 *
 * Perche' un lessico e non un LLM da solo: 30.320 job su 573 crawler. Dare
 * tutto in pasto a un modello non e' ne' economico ne' ripetibile. Perche' non
 * SOLO il lessico: la lista corta va verificata, un lessico da solo produce
 * falsi positivi che diventerebbero issue-spam. Lo split e' quello gia' in uso
 * in `scripts/audit-ai-crawlers.mjs`: filtro deterministico economico → lista
 * corta → giudizio LLM sulla lista corta.
 *
 * Le tre calibrazioni misurate sul corpus reale (30.320 job), che spiegano
 * perche' il rilevatore ha la forma che ha:
 *   - Titolo ripetuto dentro lo stesso crawler NON e' un segnale: 584 casi,
 *     quasi tutti legittimi (retail multi-filiale — `coop-ticino` ha 379 job
 *     "Detailhandelsfachfrau:mann EFZ"). Scartato come trigger.
 *   - Divergenza titolo↔descrizione NON e' un segnale autonomo: 2.670 job
 *     (8,8% del corpus, 214 crawler) hanno zero sovrapposizione lessicale, e
 *     la stragrande maggioranza sono annunci veri con una descrizione
 *     boilerplate. Resta come CORROBORAZIONE riportata nell'evidenza, mai
 *     come trigger. (Nota: non avrebbe comunque preso `hotel-international`,
 *     dove titolo e descrizione coincidono — sono entrambi sbagliati.)
 *   - Il vocabolario deve essere LEGATO, non a token singoli. `cookie` da solo
 *     boccia un vero "Category Manager Cookies"; `reservation`/`prenotazione`
 *     da soli bocciano "Reservation Agent" e "Addetto alle prenotazioni";
 *     `newsletter` da solo boccia "Newsletter Manager". Ogni regola qui sotto
 *     richiede DUE elementi in co-occorrenza, o una forma imperativa che in un
 *     titolo di lavoro non compare mai ("Prenota...", "Buchen Sie...").
 *
 * Locali coperti: it, de, fr, en (gli stessi di `docs/CRAWLERS.md`).
 *
 * Uso come modulo (e' cosi' che lo usano i test):
 *   import { classifyJobTitle, scanSlice } from './lib/job-content-plausibility.mjs';
 */

/**
 * Normalizza per il matching: minuscole, accenti rimossi, punteggiatura →
 * spazio. Serve a far combaciare "Perche'" / "Perché" / "Perche", e a rendere
 * i pattern scrivibili in ASCII puro (niente sorprese di encoding nel file).
 *
 * @param {unknown} s
 * @returns {string}
 */
export function normalize(s) {
  return String(s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9%]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Un titolo e' corto: la co-occorrenza dentro il titolo BASTA come prossimita'. */
const has = (t, re) => re.test(t);

/**
 * Regole DECISIVE: se scattano, il record non e' un annuncio di lavoro, a
 * prescindere da qualunque segnale job-positivo nel titolo (il caso schindler
 * contiene "Manager", che e' job-positivo: se il segnale positivo potesse
 * annullare l'anti-segnale, quel difetto resterebbe invisibile).
 *
 * Ogni voce: { code, why, test(normalizedTitle) => boolean, evidence(t) => string }
 */
const DECISIVE = [
  {
    code: 'consent-widget',
    why: 'widget di consenso cookie/privacy del sito sorgente scambiato per un titolo',
    // cookie + una parola di consenso, oppure consenso/privacy + una parola di gestione.
    // "Category Manager Cookies" non ha parole di consenso → passa.
    test: (t) =>
      (has(t, /\bcookies?\b/) &&
        has(
          t,
          /\b(einwilligung(en)?|zustimmung(en)?|consent(s|ement|ements|imento|i|o)?|consenso|consensi|richtlinie|banner|praferenz(en)?|preferen(ce|ces|ze|zen|cias)|einstellung(en)?|impostazion[ei]|parametr(e|es|i)|policy)\b/
        )) ||
      has(t, /\b(datenschutz|privacy)\b.*\b(einstellung(en)?|settings|center|centre|policy|preferences|impostazion[ei])\b/) ||
      // Composti tedeschi FUSI: la normalizzazione spezza su trattino e spazio,
      // quindi "Cookie-Einwilligungen" e' gia' preso dalla regola sopra, ma
      // "Datenschutzeinstellungen" e' UN token solo e le sfuggirebbe.
      // I secondi membri elencati non formano mai un nome di ruolo: e' cio' che
      // tiene fuori "Datenschutzbeauftragte/r", che e' un lavoro vero.
      has(t, /\bdatenschutz(einstellung|erklarung|bestimmung|hinweis|richtlinie)\w*/) ||
      has(t, /\bcookie(einstellung|einwilligung|richtlinie|banner|hinweis|zustimmung|praferenz)\w*/) ||
      has(t, /\b(gestisci|gestione|gestione dei|verwalten|verwaltung|manage)\b.*\b(cookies?|einwilligung(en)?|consens[oi])\b/),
  },
  {
    code: 'booking-offer',
    why: 'offerta commerciale / promozione di prenotazione, non una posizione aperta',
    test: (t) =>
      // CTA imperative: non compaiono mai in un titolo di lavoro.
      has(t, /\b(prenota|prenotate|prenotare|buchen sie|jetzt buchen|reservez|reserver maintenant|book (now|direct|your)|buchen und)\b/) ||
      has(t, /\bperche prenotare\b|\bwarum direkt buchen\b|\bwhy book\b|\bpourquoi reserver\b/) ||
      // offerte / prezzi
      has(t, /\b(offerta special[ei]|offerte speciali|sonderangebot|angebot des|offre special[e]?|special offer|last minute|miglior prezzo|best ?price|bestpreis|meilleur prix|superprezz[oi]|prezzo speciale)\b/) ||
      has(t, /\b(senza carta di credito|ohne kreditkarte|sans carte de credit|no credit card)\b/) ||
      // soggiorno
      has(t, /\b\d+\s*(notti|notte|nacht|nachte|nuits|nuit|nights|night)\b/) ||
      has(t, /\b(mezza pensione|halbpension|demi pension|colazione inclusa|fruhstuck inklusive|petit dejeuner inclus|breakfast included)\b/) ||
      // stelle / classificazione alberghiera come TITOLO
      has(t, /\btop \d star\b|\b\d star hotels?\b|\bhotel a \d stelle\b|\b\d sterne hotel\b/) ||
      // camere legate a prezzo/disponibilita' (non "Addetto alle camere", che e' un lavoro)
      has(t, /\bcamere?\b.*\b(rinnovat[ae]|superprezz[oi]|prezz[oi]|disponibil[ei]|offerta)\b/) ||
      has(t, /\b(zimmer|chambres?)\b.*\b(ab chf|ab eur|des chf|preis|prix)\b/),
  },
  {
    code: 'site-chrome',
    why: 'elemento di navigazione/UI del sito sorgente (link, legale, auth, carrello)',
    test: (t) =>
      has(t, /\b(iscriviti|iscrizione|abonnieren|inscrivez vous|subscribe to)\b.*\b(newsletter|alert|aggiornament|updates)\b/) ||
      has(t, /\b(leggi di piu|scopri di piu|read more|learn more|mehr erfahren|weiterlesen|en savoir plus|lire la suite)\b/) ||
      has(t, /\b(torna su|back to top|skip to (main )?content|vai al contenuto|zum inhalt springen|aller au contenu|menu principale|main menu)\b/) ||
      has(t, /\b(impressum|note legali|mentions legales|allgemeine geschaftsbedingungen|condizioni generali|terms (and|of) (use|service|conditions))\b/) ||
      has(t, /\b(aggiungi al carrello|add to cart|in den warenkorb|ajouter au panier|risultati della ricerca|search results|suchergebnisse|resultats de recherche)\b/) ||
      has(t, /\b(password dimenticata|passwort vergessen|forgot (your )?password|mot de passe oublie|crea un account|create an account|konto erstellen)\b/) ||
      has(t, /\b(abilita javascript|enable javascript|activer javascript|javascript aktivieren)\b/) ||
      has(t, /\b(pagina non trovata|page not found|seite nicht gefunden|page introuvable|error(e)? 404)\b/) ||
      has(t, /\b(condividi su|share on|seguici su|follow us on)\b/),
  },
  {
    code: 'unresolved-placeholder',
    why: 'placeholder di template mai risolto: il parser ha copiato lo scheletro, non il dato',
    // Si applica al titolo GREZZO, non normalizzato: la normalizzazione mangia le parentesi.
    raw: true,
    test: (raw) =>
      /\[\[[^\]]*\]\]?|\{\{[^}]*\}\}?|\$\{[^}]*\}?|<%[^%]*%>/.test(raw) ||
      /(^|\s)(undefined|null|nan)(\s|$)/i.test(raw),
  },
];

/**
 * Segnali job-positivi. NON annullano mai una regola decisiva: servono al
 * livello crawler (§ scanSlice) per distinguere "questo crawler pubblica
 * lavori con qualche difetto" da "questo crawler non pubblica lavori affatto".
 */
const JOB_POSITIVE = [
  /\b\d{1,3}\s*(%|prozent|percento)/, // grado di occupazione: 80%, 80-100%
  /\bm w d\b|\bw m d\b|\bh f d\b|\bf m d\b|\bm f d\b|\bm w\b|\bw m\b|\bh f\b/, // marcatori di genere
  /\b(efz|eba|cfc|afc|fh|hf|mba|bsc|msc)\b/,
  /\b(lehrstelle|lehre|ausbildung|praktikum|praktikant|stagiaire|stage|tirocinio|apprendist|apprenti|apprentissage|lernende|internship|intern)\w*/,
  /\b(gesucht|cercasi|recherch|wanted|vacancy|vacature|offre d emploi|posto vacante|offene stelle)\w*/,
  /\b(manager|leiter|leitung|monteur|ingenieur|ingegner|engineer|entwickler|developer|sviluppator|assistent|assistant|berater|consultant|consulent|advisor|adviser|verkauf|vendit|sales|koch|kochin|cuoc|chef|cook|pflege|infermier|nurse|arzt|arztin|medic|doctor|techniker|tecnic|technician|operator|operatric|mitarbeiter|collaborator|specialist|spezialist|analyst|analist|architekt|architett|designer|therapist|terapist|fahrer|autist|driver|logistiker|elektriker|elettricist|mechaniker|meccanic|disponent|sachbearbeiter|buchhalter|contabil|jurist|avvocat|lawyer|projektleiter|teamleiter|filialleiter|direttor|direktor|director|responsabil|responsable|coordinator|coordinatric|sekretar|segretari|receptionist|hauswart|reinigung|pulizi|cleaner|security|sicherheit|gardien|barista|camerier|kellner|serveur|waiter|apotheker|farmacist|pharmacien|polymechaniker|informatiker|informatic|kaufmann|kauffrau|employe|impiegat|hilfskraft|aushilfe|praktikum|zusteller|verkaufer|verkauferin|conseiller|conseillere|stockiste|addett|runner|agent|agente|steward|hostess|sommelier|facchin|magazzinier|lagerist|commis|apprenti|apprendist)\w*/,
];

/**
 * Classifica UN titolo.
 *
 * @param {unknown} title titolo grezzo
 * @returns {{ isJob: boolean, reasons: Array<{code: string, why: string}>, jobPositive: boolean }}
 */
export function classifyJobTitle(title) {
  const raw = String(title ?? '');
  const t = normalize(raw);
  const reasons = [];
  for (const rule of DECISIVE) {
    if (rule.test(rule.raw ? raw : t)) reasons.push({ code: rule.code, why: rule.why });
  }
  const jobPositive = JOB_POSITIVE.some((re) => re.test(t));
  return { isJob: reasons.length === 0, reasons, jobPositive };
}

/**
 * Sovrapposizione lessicale titolo→descrizione, nella stessa lingua del record
 * base. Corroborazione riportata nell'evidenza, MAI un trigger da sola (2.670
 * falsi positivi misurati sul corpus — vedi l'intestazione).
 *
 * @param {unknown} title
 * @param {unknown} description
 * @returns {number|null} 0..1, oppure null se non calcolabile
 */
export function titleDescriptionOverlap(title, description) {
  const tw = normalize(title).split(' ').filter((w) => w.length >= 4);
  const d = normalize(description);
  if (!tw.length || !d) return null;
  return tw.filter((w) => d.includes(w)).length / tw.length;
}

const MAX_EVIDENCE_CHARS = 180;

/**
 * Scansiona la slice di UN crawler.
 *
 * Due livelli, perche' i due incidenti reali hanno forma diversa:
 *   - `job`: singoli record non-lavoro dentro un crawler per il resto sano
 *     (schindler: 11 su 91).
 *   - `crawler`: il crawler punta a una pagina che non e' una lista di lavori
 *     (hotel-international: 5 su 5). Soglia: >= `crawlerRatio` di record
 *     bocciati, oppure zero record con un solo segnale job-positivo su un
 *     campione non banale. Riportato come UN finding invece di N, perche' la
 *     riparazione e' una sola (il crawler, non i record).
 *
 * @param {{crawlerKey: string, jobs: Array<object>}} slice
 * `minJobsForNoSignalVerdict` e' piu' alto di `minJobsForCrawlerVerdict` (5 vs
 * 3) perche' l'assenza di parole-chiave e' evidenza debole: su un crawler da 3
 * record bastano tre titoli laconici ma legittimi. Misurato: a 3 il verdetto
 * bocciava `prada` (3 job veri — "Client Advisor", "PRADA Runner",
 * "Addetto/a Laboratorio"), a 5 no, e `gemeinde-st-moritz` (5 record, difetto
 * vero) resta preso.
 *
 * @param {{crawlerRatio?: number, minJobsForCrawlerVerdict?: number, minJobsForNoSignalVerdict?: number}} [opts]
 * @returns {{crawlerKey: string, totalJobs: number, flagged: number, ratio: number, level: 'crawler'|'job'|null, findings: Array<object>}}
 */
export function scanSlice(slice, opts = {}) {
  const crawlerRatio = opts.crawlerRatio ?? 0.5;
  const minJobs = opts.minJobsForCrawlerVerdict ?? 3;
  const minJobsNoSignal = opts.minJobsForNoSignalVerdict ?? 5;
  const crawlerKey = slice?.crawlerKey || 'unknown';
  const jobs = Array.isArray(slice?.jobs) ? slice.jobs : [];

  const findings = [];
  let jobPositiveCount = 0;
  for (const job of jobs) {
    const { isJob, reasons, jobPositive } = classifyJobTitle(job?.title);
    if (jobPositive) jobPositiveCount++;
    if (isJob) continue;
    const overlap = titleDescriptionOverlap(job?.title, job?.description);
    findings.push({
      crawlerKey,
      jobId: job?.id ?? null,
      slug: job?.slug ?? null,
      url: job?.url ?? null,
      title: String(job?.title ?? ''),
      codes: reasons.map((r) => r.code),
      why: reasons.map((r) => r.why),
      // Corroborazione, non trigger. `null` = non calcolabile.
      titleDescriptionOverlap: overlap,
      descriptionHead: String(job?.description ?? '').replace(/\s+/g, ' ').slice(0, MAX_EVIDENCE_CHARS),
    });
  }

  const total = jobs.length;
  const ratio = total ? findings.length / total : 0;
  let level = null;
  if (findings.length) {
    level = total >= minJobs && ratio >= crawlerRatio ? 'crawler' : 'job';
  } else if (total >= minJobsNoSignal && jobPositiveCount === 0) {
    // Nessun record bocciato dal lessico ma NEMMENO uno che somigli a un
    // lavoro: la forma che avrebbe un crawler puntato a una pagina sbagliata
    // con vocabolario non ancora conosciuto. Sospetto da verificare, non
    // verdetto — per questo entra con `codes: ['no-job-signal']` e senza `why`
    // decisivo.
    level = 'crawler';
    findings.push({
      crawlerKey,
      jobId: null,
      slug: null,
      url: jobs[0]?.url ?? null,
      title: jobs.slice(0, 5).map((j) => String(j?.title ?? '')).join(' | '),
      codes: ['no-job-signal'],
      why: [`nessuno dei ${total} record ha un segnale job-positivo (grado occupazione, m/w/d, EFZ, nome di ruolo)`],
      titleDescriptionOverlap: null,
      descriptionHead: String(jobs[0]?.description ?? '').replace(/\s+/g, ' ').slice(0, MAX_EVIDENCE_CHARS),
    });
  }

  return { crawlerKey, totalJobs: total, flagged: findings.length, ratio, level, findings };
}
