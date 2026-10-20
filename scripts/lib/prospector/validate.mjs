/**
 * Extraction quality — graded against the employer's own page, field by field.
 *
 * "The crawler ran" is not quality. A parser that returns twelve rows of
 * navigation chrome runs perfectly and publishes twelve fake vacancies, and the
 * existing health monitor cannot tell the difference because it counts rows.
 * So this grades CONTENT: for a sample of the vacancies a spec produced, fetch
 * the detail page the employer actually serves and check that what we hold is
 * what that page says.
 *
 * Five checks, each a fraction in [0,1], because they fail independently:
 *
 *   reachable   — the URL we would publish resolves. A dead link is the one
 *                 defect a reader always notices.
 *   titleMatch  — our title is recognisably the page's own <h1>/<title>.
 *                 Catches the classic template-clustering failure, where the
 *                 anchor text was a category label rather than a job title.
 *   contentful  — the detail page carries real vacancy prose, not a shell.
 *                 Catches SPA listings whose detail pages render client-side.
 *   distinct    — titles across the listing differ from one another. Catches a
 *                 selector that latched onto a repeated element and produced
 *                 N copies of the same row.
 *   jobLike     — the prose reads as a job ad and not as something else.
 *
 * The first four all grade the extraction against ITSELF, and that was the hole
 * this file had until 2026-08-24: content that is not a vacancy at all can
 * satisfy every one of them. hotel-international scored 1.00 on all four while
 * publishing four hotel room promos as job listings, because its `/it/jobs/`
 * page carries no vacancy and the promo carousel won the link cluster; 115west
 * scored 1.00 on architecture competition write-ups. `jobLike` (see
 * `job-like.mjs`) is the only check that asks what the page IS rather than
 * whether we copied it faithfully.
 *
 * A grade is only as good as its sample, so the sample size is recorded with
 * the score and a spec graded on fewer than two detail pages is reported as
 * `insufficient` rather than given a number that reads as confidence.
 */
import { politeFetch } from './polite-fetch.mjs';
import {
  isSufficientVacancyDescription,
  textOf,
} from './extract.mjs';
import { resolveDetailOrListingSwissGeography } from './location-evidence.mjs';
import { gradeJobLike } from '../job-like.mjs';
import { createSpecUrlPolicy } from './public-fetch-policy.mjs';
import { extractRuntimeDetailFields, runtimeDetailFallbackUrl } from './detail-extract.mjs';
import { selectValidationSample } from './validation-sample.mjs';
import {
  isGenericVacancyTitle,
  rawDetailTitleEvidence,
  vacancyTitleFromDocumentTitle,
} from './production-title.mjs';

/**
 * Whether a fetched body is text we can actually read.
 *
 * Several legitimate employers publish vacancies as PDFs under a
 * `Stellenausschreibungen/`-style path (sac-cas.ch, adelboden-lenk.ch,
 * swiss-solidarity.org all do). Read as UTF-8 those bodies are compressed
 * binary, so a semantic check on them measures nothing — and reporting
 * "not a job ad" for bytes we cannot decode would be a defect of the measure,
 * not a finding. Such samples are reported as unmeasured instead of failed.
 *
 * @param {string} body
 * @returns {boolean}
 */
export function isReadableText(body = '') {
  const head = String(body || '').slice(0, 4000);
  if (!head) return false;
  if (/^\s*%PDF-/.test(head)) return false;
  const opaque = (head.match(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffd]/g) || []).length;
  return opaque / head.length < 0.02;
}

/** Share of the quality score carried by the semantic `jobLike` check. */
export const JOB_LIKE_WEIGHT = 0.15;

/** Normalise a string for fuzzy comparison. */
const norm = (s = '') => String(s).toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9 ]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

/**
 * Token-overlap ratio of `needle` against `haystack`, in [0,1].
 * Word-level rather than substring, so word order and punctuation do not matter.
 *
 * @param {string} needle
 * @param {string} haystack
 * @returns {number}
 */
export function tokenOverlap(needle, haystack) {
  const n = [...new Set(norm(needle).split(' ').filter((w) => w.length > 2))];
  if (!n.length) return 0;
  const hay = new Set(norm(haystack).split(' '));
  return n.filter((w) => hay.has(w)).length / n.length;
}

/**
 * Le date, tenute a parte dal resto del rumore di coda perche' sono le sole
 * forme che possono essere ANCHE contenuto dell'annuncio: si applicano dietro
 * la guardia di `CONTENT_DATE_MARKERS` (vedi `bodySignature()`).
 */
const DATE_NOISE_PATTERNS = [
  // 2026-09-05T11:01:22, 2026-09-05T11:01:22.417Z, 2026-09-05T11:01+02:00.
  // Va PRIMA delle due regex qui sotto e in una passata sola: nella forma ISO
  // non c'e' confine di parola fra la data e la `T`, quindi ne' `\b...\d{1,2}\b`
  // ne' `\b\d{1,2}:\d{2}` mordono i pezzi, e il timestamp di generazione
  // resterebbe dentro l'hash — N copie della stessa pagina tornerebbero a
  // firmare diverso, che e' il caso che il gate esiste per bocciare.
  /\b\d{4}-\d{2}-\d{2}[Tt ]\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g,
  // 05.09.2026, 5/9/26, 05-09-2026
  /\b\d{1,2}[./-]\d{1,2}[./-]\d{2,4}\b/g,
  // 2026-09-05
  /\b\d{4}[./-]\d{1,2}[./-]\d{1,2}\b/g,
];

/**
 * I marcatori che qualificano la data che SEGUE come CONTENUTO dell'annuncio —
 * data di entrata in servizio, inizio del contratto, termine di candidatura —
 * e non come data di generazione stampata in coda dal layout.
 *
 * Senza questa guardia le regex di `DATE_NOISE_PATTERNS` cancellano OGNI data,
 * quindi due annunci template dello stesso datore che differiscono solo per
 * «Eintritt per 01.11.2026» / «Eintritt per 01.03.2027» firmano UGUALE:
 * `detailDistinctRate` crolla e il promotion gate boccia un datore valido —
 * lo stesso modo di fallire gia' chiuso per NPA, pensum e numero di
 * riferimento, rimasto aperto sulla dimensione data.
 *
 * Solo marcatori espliciti: una preposizione nuda (`ab`, `dal`, `from`) e'
 * troppo comune e riaprirebbe il buco sul rumore di coda che questa lista
 * esiste per togliere («Stand: 05.09.2026» resta senza marcatore, e denoisato).
 */
const CONTENT_DATE_MARKERS = new RegExp(
  '(?:' +
    // DE
    'eintritt(?:sdatum|stermin)?|stellenantritt|arbeits(?:beginn|antritt)|' +
    'vertragsbeginn|(?:datum|termin)\\s+des\\s+eintritts|befristet\\s+bis|' +
    'bewerbungsfrist|beginn\\s+(?:der|des|am)|' +
    // IT
    'dat[ae]\\s+d(?:i|\')\\s*inizio|entrata\\s+in\\s+(?:servizio|funzione)|' +
    'inizio\\s+(?:attivita|del\\s+rapporto|contratto|dell)|a\\s+partire\\s+dal|' +
    'entro\\s+il|termine\\s+di\\s+candidatura|scadenza|' +
    // FR
    'd[eè]s\\s+le|[àa]\\s+partir\\s+d[ue]|date\\s+d[\'’]entr[ée]e|' +
    'entr[ée]e\\s+en\\s+fonction|d[ée]but\\s+d[ue]|jusqu[\'’]au|d[ée]lai\\s+de|' +
    // EN
    'start(?:ing)?\\s+date|starts?\\s+(?:on|from)|as\\s+of|deadline' +
  ')' +
  // Fra il marcatore e la data solo il connettivo della coppia
  // etichetta/valore («Eintritt per », «data di inizio: »): nessun terminatore
  // di frase, o un marcatore di un periodo precedente coprirebbe una data che
  // non e' la sua. E nessuna CIFRA: nella forma trattino/ISO la data intermedia
  // («Eintritt per 2026-11-01 Stand: 05.09.2026») non porta nessun `.!?;`, e
  // senza `\d` nella classe il marcatore scavalcherebbe la data sua e coprirebbe
  // quella di generazione che segue — N copie della stessa pagina tornerebbero a
  // firmare diverso, il danno inverso a quello che la guardia chiude.
  '[^.!?;\\d]{0,24}$',
  'i',
);

/**
 * Le sole forme di coda che cambiano a ogni richiesta sullo stesso annuncio,
 * riconosciute sul testo GREZZO: hanno ancora la punteggiatura che le rende
 * identificabili («05.09.2026», «15:04», «visite 1234», «annuncio n. 1234»).
 * Dopo `norm()` quella punteggiatura non c'e' piu' e restano token di sole
 * cifre indistinguibili dall'NPA, dal numero di riferimento e dal pensum.
 */
const REQUEST_NOISE_PATTERNS = [
  ...DATE_NOISE_PATTERNS,
  // 15:04, 15:04:22
  /\b\d{1,2}:\d{2}(?::\d{2})?\b/g,
  // Etichette del contatore, enumerate per lingua e per sinonimo: i layout
  // alternano «visite», «hits», «Klicks», «letture» e «consultazioni» senza
  // cambiare il resto della pagina. Il valore numerico e' obbligatorio, cosi'
  // una parola del contenuto non viene rimossa da sola.
  /\b(?:visite|visitatori|visualizzazioni|visite?urs?|vues|besucher|aufrufe|zugriffe|views?|hits?|klicks?|clicks?|letture|consultazioni|consultations?)\b[\s:]*\d[\d'’.,]*/gi,
  // il progressivo stampato in coda dal layout: «annuncio n. 1234»,
  // «Inserat Nr. 1234». NON il numero di riferimento dell'annuncio
  // (`ref`/`riferimento`/`referenz`), che e' contenuto e distingue due
  // annunci template altrimenti identici.
  /\b(?:annuncio|inserzione|inserat|stellenangebot|annonce)\b\.?\s*(?:n[or]?\.?|°|nr\.?|#)\s*\d[\d'’.,-]*/gi,
];

/** Quanto testo prima della data si guarda per cercare il marcatore. */
const CONTENT_DATE_WINDOW = 48;

/**
 * Replacer delle regex di `DATE_NOISE_PATTERNS`: cancella la data solo quando
 * NON e' preceduta da un marcatore di contenuto.
 *
 * @param {string} match
 * @param {number} offset
 * @param {string} full
 * @returns {string}
 */
function keepContentDates(match, offset, full) {
  const before = full.slice(Math.max(0, offset - CONTENT_DATE_WINDOW), offset);
  return CONTENT_DATE_MARKERS.test(before) ? match : ' ';
}

/**
 * Firma stabile del testo di una pagina, per distinguere «N pagine diverse»
 * da «N copie della stessa pagina». djb2 sul testo normalizzato: serve solo a
 * confrontare pagine fra loro, non a identificarne il contenuto.
 *
 * @param {string} text
 * @returns {string}
 */
export function bodySignature(text = '') {
  // Sul testo INTERO, non su un prefisso: con nav e banner di consenso lunghi
  // — i layout Umantis ne hanno — due annunci diversi condividono i primi
  // migliaia di caratteri e collidono sulla stessa firma, cioe' proprio il
  // falso «pagine identiche» che questa misura esiste per escludere.
  //
  // Ma il testo intero include la coda, ed e' li' che i layout server-rendered
  // mettono il rumore per-richiesta: data/ora di generazione nel footer,
  // contatore visite, «annuncio n. 1234». Con quello dentro l'hash, N copie
  // della stessa pagina firmano N volte diverso e `detailDistinctRate` legge
  // 1.00 proprio sul caso che esiste per bocciare.
  //
  // Quelle forme si tolgono PRIMA di `norm()`, una per una: dopo la
  // normalizzazione sono token di sole cifre come l'NPA («8004 Zürich» /
  // «8005 Zürich»), il numero di riferimento e il pensum («80%»), e una regola
  // unica su `\b\d+\b` cancellerebbe anche quelli — due annunci template dello
  // stesso datore che differiscono solo li' firmerebbero UGUALE e il promotion
  // gate boccerebbe un datore valido. Il resto dell'output di `norm()` resta
  // intatto: le cifre sono contenuto quando non sono rumore di coda.
  //
  // Le date fanno eccezione fra le forme di coda: la stessa `01.11.2026` e'
  // rumore nel footer («Stand: 01.11.2026») e CONTENUTO nel corpo dell'annuncio
  // («Eintritt per 01.11.2026»). Denoisate senza distinguere, due annunci
  // template dello stesso datore che differiscono solo per la data di entrata
  // firmano UGUALE — il falso negativo del gate, cioe' il danno inverso. Quindi
  // una data preceduta da un marcatore di contenuto resta dentro l'hash.
  const denoised = REQUEST_NOISE_PATTERNS.reduce(
    (acc, re) => acc.replace(re, DATE_NOISE_PATTERNS.includes(re) ? keepContentDates : ' '),
    String(text),
  );
  const body = norm(denoised);
  let h = 5381;
  for (let i = 0; i < body.length; i += 1) h = (((h << 5) + h) ^ body.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/**
 * Grade ONE vacancy against its own detail page.
 *
 * @param {{ title: string, url: string, location?: string, description?: string }} vacancy
 * @param {{ urlPolicy?: any, dispatcher?: unknown, fetchImpl?: typeof fetch, lookupImpl?: any, sleepImpl?: (ms: number) => Promise<unknown>, headers?: Record<string,string>, detailExtractor?: (html: string, url: string) => any, observedDetail?: any, requireObservedDetail?: boolean, titleEvidence?: any }} [fetchOptions]
 * @returns {Promise<{ url: string, reachable: boolean, titleMatch: number,
 *   titleSource: string, listingTitle: string, detailTitle: string, rawH1Title: string,
 *   rawDocumentTitle: string, finalTitle: string, recordedFinalTitle: string,
 *   authoritativeTitle: string, titleEvidenceSource: 'listing'|'raw_h1'|'raw_document_title'|'none',
 *   contentful: boolean, sourceBackedLocation: boolean, words: number, status: number,
 *   jobLike: boolean|null, jobSignals: string[], notJobSignals: string[] }>}
 */
export async function gradeVacancy(vacancy, fetchOptions = {}) {
  const out = {
    url: vacancy.url,
    reachable: false,
    titleMatch: 0,
    titleSource: 'none',
    listingTitle: '',
    detailTitle: '',
    rawH1Title: '',
    rawDocumentTitle: '',
    finalTitle: vacancy.title || '',
    recordedFinalTitle: vacancy.title || '',
    authoritativeTitle: '',
    titleEvidenceSource: 'none',
    contentful: false,
    sourceBackedLocation: false,
    words: 0,
    status: 0,
    /** `null` means "not measured", never "measured and fine". */
    jobLike: null,
    jobSignals: [],
    notJobSignals: [],
  };
  let res = fetchOptions.observedDetail
    ? {
      ok: true,
      status: fetchOptions.observedDetail.status || 200,
      body: fetchOptions.observedDetail.body || '',
      url: fetchOptions.observedDetail.url || vacancy.url,
    }
    : null;
  if (!res && fetchOptions.requireObservedDetail === true) return out;
  if (!res) {
    try {
      if (fetchOptions.urlPolicy) await fetchOptions.urlPolicy(vacancy.url);
    } catch {
      return out;
    }
    res = await politeFetch(vacancy.url, fetchOptions);
    if (!res.ok) {
      // Stesso retry del runtime, o il gate boccia pagine che il crawler legge.
      const fallbackUrl = runtimeDetailFallbackUrl(fetchOptions.spec || {}, res.status, vacancy.url);
      if (fallbackUrl) res = await politeFetch(fallbackUrl, fetchOptions);
    }
  }
  out.status = res.status;
  if (!res.ok || res.body.length < 200) return out;
  out.reachable = true;

  const rawTitles = rawDetailTitleEvidence(res.body);
  const bodyText = textOf(res.body);
  // Stessa catena del runtime: se il validatore grada con un estrattore piu'
  // debole di quello che pubblichera', il gate misura un altro programma.
  const detail = fetchOptions.observedDetail?.detail || extractRuntimeDetailFields(
    fetchOptions.spec || {}, res.body, res.url || vacancy.url,
    {
      detailExtractor: fetchOptions.detailExtractor,
      recordUrl: vacancy.url,
      recordTitle: vacancy.title,
    },
  );
  const titleEvidence = fetchOptions.titleEvidence || fetchOptions.observedDetail || {};
  const titleSource = titleEvidence.titleSource || (detail.title ? 'detail' : 'structured-detail');
  const finalTitle = vacancy.title || '';
  const recordedFinalTitle = titleEvidence.finalTitle || finalTitle;
  const outputTitleMatchesEvidence = norm(finalTitle) === norm(recordedFinalTitle);
  const listingTitle = String(titleEvidence.listingTitle || '').trim();
  const independentTitleCandidates = [
    { title: listingTitle, source: 'listing' },
    { title: rawTitles.rawH1Title, source: 'raw_h1' },
    { title: rawTitles.rawOpenGraphTitle, source: 'raw_open_graph' },
    { title: vacancyTitleFromDocumentTitle(rawTitles.rawDocumentTitle), source: 'raw_document_title' },
  ].filter(({ title }) => title && !isGenericVacancyTitle(title));
  const titleProof = independentTitleCandidates
    .map((candidate) => ({ ...candidate, match: tokenOverlap(finalTitle, candidate.title) }))
    .sort((left, right) => right.match - left.match)[0] || null;
  out.titleSource = titleSource;
  out.listingTitle = listingTitle;
  out.detailTitle = titleEvidence.detailTitle || detail.title || '';
  out.rawH1Title = rawTitles.rawH1Title;
  out.rawOpenGraphTitle = rawTitles.rawOpenGraphTitle;
  out.rawDocumentTitle = rawTitles.rawDocumentTitle;
  out.finalTitle = finalTitle;
  out.recordedFinalTitle = recordedFinalTitle;
  out.authoritativeTitle = titleProof?.title || '';
  out.titleEvidenceSource = titleProof?.source || 'none';
  out.titleMatch = !outputTitleMatchesEvidence || isGenericVacancyTitle(finalTitle)
    ? 0
    : (titleProof?.match || 0);
  out.sourceBackedLocation = Boolean(resolveDetailOrListingSwissGeography(detail, vacancy).geography);

  const words = bodyText.split(/\s+/).filter(Boolean).length;
  out.words = words;
  out.bodySignature = bodySignature(bodyText);
  // Grade the exact description the runtime would publish. Navigation/footer
  // prose must not make a description-less shell pass validation only to be
  // dropped by production under the shared sufficiency contract.
  // `vacancy.description` is the already selected output of the runtime's
  // per-row transform. Re-evaluating the detail body here would allow text the
  // crawler does not publish to satisfy the semantic quality gate.
  const publishableDescription = vacancy.description
    || (fetchOptions.observedDetail ? '' : detail.description || '');
  out.contentful = isSufficientVacancyDescription(publishableDescription);

  const publishableDescriptionText = textOf(publishableDescription);
  if (publishableDescriptionText && isReadableText(publishableDescriptionText)) {
    const jl = gradeJobLike(publishableDescriptionText);
    out.jobLike = jl.jobLike;
    out.jobSignals = jl.jobHits;
    out.notJobSignals = jl.notJobHits;
  }
  return out;
}

/**
 * @typedef {Object} QualityReport
 * @property {string} companyKey
 * @property {number} vacancyCount
 * @property {number} sampled
 * @property {number} reachableRate
 * @property {number} titleMatchRate
 * @property {number} contentfulRate
 * @property {number} locationSourceRate
 * @property {number} distinctRate
 * @property {number} detailDistinctRate quota di pagine campionate fra loro diverse
 * @property {number|null} jobLikeRate  `null` when no sample was readable text
 * @property {number} score           0..1, the gate value
 * @property {'good'|'weak'|'bad'|'insufficient'} verdict
 * @property {string[]} problems
 * @property {{ algorithmVersion: string, day: string, populationCount: number, sampleCount: number,
 *   selected: Array<{ index: number, stratum: number, id: string }> }} sampleSelection
 * @property {any[]} samples
 */

/**
 * Grade a whole spec's output.
 *
 * @param {{ companyKey: string }} spec
 * @param {any[]} vacancies
 * @param {{ sampleSize?: number, goodAt?: number, weakAt?: number, fetchImpl?: typeof fetch, lookupImpl?: any, sleepImpl?: (ms: number) => Promise<unknown>, detailExtractor?: (html: string, url: string) => any, observedDetailsByUrl?: Map<string, any>, requireObservedDetails?: boolean, titleEvidenceByUrl?: Map<string, any>, runtimeObservation?: Record<string, any>, sampleDate?: Date|string|number }} [opts]
 * @returns {Promise<QualityReport>}
 */
export async function gradeExtraction(spec, vacancies, opts = {}) {
  const sampleSize = opts.sampleSize ?? 4;
  const goodAt = opts.goodAt ?? 0.75;
  const weakAt = opts.weakAt ?? 0.5;
  const problems = [];

  const titles = vacancies.map((v) => norm(v.title)).filter(Boolean);
  const distinctRate = titles.length ? new Set(titles).size / titles.length : 0;
  if (vacancies.length >= 3 && distinctRate < 0.6) problems.push('titoli ripetuti: il selettore ha agganciato un elemento ricorrente');

  const selection = selectValidationSample(vacancies, {
    companyKey: spec.companyKey,
    sampleSize,
    date: opts.sampleDate,
  });

  const graded = [];
  const urlPolicy = createSpecUrlPolicy(/** @type {any} */ (spec), { lookupImpl: opts.lookupImpl });
  const isPageExecutive = /** @type {any} */ (spec).platform === 'pageexecutive.com';
  try {
    for (const picked of selection.selected) {
      const g = await gradeVacancy(picked.vacancy, {
        spec,
        urlPolicy,
        dispatcher: urlPolicy.dispatcher,
        fetchImpl: opts.fetchImpl,
        sleepImpl: opts.sleepImpl,
        detailExtractor: opts.detailExtractor,
        observedDetail: opts.observedDetailsByUrl?.get(picked.vacancy.url),
        requireObservedDetail: opts.requireObservedDetails === true,
        titleEvidence: opts.titleEvidenceByUrl?.get(picked.vacancy.url),
        ...(isPageExecutive ? { headers: { 'Accept-Encoding': 'identity' } } : {}),
      });
      graded.push({
        ...g,
        sampleIndex: picked.index,
        sampleStratum: picked.stratum,
        sampleId: picked.id,
      });
    }
  } finally {
    await urlPolicy.dispatcher.close();
  }

  const rate = (fn) => (graded.length ? graded.filter(fn).length / graded.length : 0);
  const reachableRate = rate((g) => g.reachable);
  // Distinzione misurata sulle PAGINE, non sui titoli del listing. Un'agenzia
  // interinale pubblica lo stesso ruolo per sedi diverse — anker-swiss.ch il
  // 2026-09-05: 314 annunci, 314 URL, 73 titoli, «Maler 100%» x23, ognuno una
  // localita' e una descrizione proprie — e sui soli titoli e' indistinguibile
  // dal selettore che ha agganciato N copie di una riga di chrome. Le pagine
  // lo dicono: nel primo caso sono diverse, nel secondo identiche.
  const signed = graded.filter((g) => g.bodySignature);
  const detailDistinctRate = signed.length
    ? new Set(signed.map((g) => g.bodySignature)).size / signed.length
    : 0;
  const contentfulRate = rate((g) => g.contentful);
  const measuredLocationRate = opts.runtimeObservation?.sourceBackedLocationRate;
  const locationSourceRate = typeof measuredLocationRate === 'number' && Number.isFinite(measuredLocationRate)
    ? measuredLocationRate
    : rate((g) => g.sourceBackedLocation);
  const titleMatchRate = graded.length
    ? graded.reduce((a, g) => a + g.titleMatch, 0) / graded.length
    : 0;

  // Only pages we could actually read count in the denominator, so a PDF
  // vacancy is reported as ungraded rather than as "not a job ad" — see
  // `isReadableText`. All samples unreadable => `null`, i.e. not measured.
  const jobLikeGraded = graded.filter((g) => g.jobLike !== null);
  const jobLikeRate = jobLikeGraded.length
    ? jobLikeGraded.filter((g) => g.jobLike).length / jobLikeGraded.length
    : null;

  if (reachableRate < 1 && graded.length) problems.push(`${Math.round((1 - reachableRate) * 100)}% degli URL non risolve`);
  if (titleMatchRate < 0.5 && graded.length) problems.push('i titoli estratti non corrispondono alla pagina ufficiale');
  if (contentfulRate < 0.5 && graded.length) problems.push('pagine di dettaglio senza testo: probabile render lato client');
  if (jobLikeRate !== null && jobLikeRate < 1) {
    problems.push(`${Math.round((1 - jobLikeRate) * 100)}% delle pagine di dettaglio non legge come annuncio di lavoro: probabile contenuto promozionale o editoriale`);
  }
  if (jobLikeRate === null && graded.length) {
    problems.push('nessuna pagina di dettaglio leggibile come testo: controllo semantico non eseguito');
  }

  // `jobLike` takes its weight from the other four rather than being added on
  // top, so a perfect spec still scores 1.00 and the existing thresholds keep
  // their meaning. When it could not be measured the remaining four are scaled
  // back up, which reproduces the pre-2026-08-24 formula exactly.
  const base = (reachableRate * 0.35) + (titleMatchRate * 0.35) + (contentfulRate * 0.2) + (distinctRate * 0.1);
  const score = graded.length
    ? (jobLikeRate === null
      ? base
      : (base * (1 - JOB_LIKE_WEIGHT)) + (jobLikeRate * JOB_LIKE_WEIGHT))
    : 0;

  /** @type {QualityReport['verdict']} */
  let verdict = 'insufficient';
  // Il promotion gate adatta il campione alla dimensione dell'inventario:
  // un datore con una sola vacancy viene giudicato su quella pagina, mentre
  // la stabilita' resta comunque vincolata a due validazioni in giorni
  // distinti. Richiedere qui due pagine renderebbe quel ramo del gate
  // irraggiungibile per costruzione.
  const minimumGradedForVerdict = vacancies.length > 0 ? Math.min(2, vacancies.length) : 2;
  if (graded.length >= minimumGradedForVerdict) verdict = score >= goodAt ? 'good' : (score >= weakAt ? 'weak' : 'bad');

  return {
    companyKey: spec.companyKey,
    vacancyCount: vacancies.length,
    sampled: graded.length,
    reachableRate: Number(reachableRate.toFixed(3)),
    titleMatchRate: Number(titleMatchRate.toFixed(3)),
    contentfulRate: Number(contentfulRate.toFixed(3)),
    detailDistinctRate: Number(detailDistinctRate.toFixed(3)),
    locationSourceRate: Number(locationSourceRate.toFixed(3)),
    distinctRate: Number(distinctRate.toFixed(3)),
    jobLikeRate: jobLikeRate === null ? null : Number(jobLikeRate.toFixed(3)),
    score: Number(score.toFixed(3)),
    verdict,
    problems,
    // The selected identities and strata are retained so a day's sample can
    // be replayed and the next day's rotation can be inspected.
    sampleSelection: {
      algorithmVersion: selection.algorithmVersion,
      day: selection.day,
      populationCount: selection.populationCount,
      sampleCount: selection.sampleCount,
      selected: selection.selected.map(({ index, stratum, id }) => ({ index, stratum, id })),
    },
    samples: graded,
  };
}
