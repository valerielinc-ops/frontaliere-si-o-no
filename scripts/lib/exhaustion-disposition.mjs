/**
 * ── COSA FARE DI UNA CASCATA CHE SI E' SVUOTATA (issue #313 / #348) ─────────
 *
 * `callLLM()` lancia `code = 'ALL_MODELS_EXHAUSTED'` ogni volta che la catena
 * si svuota, QUALUNQUE sia la ragione. Chi la riceve deve decidere una cosa
 * sola: aspettare, o gridare. Questo modulo e' quella decisione, e sta in un
 * file suo per un motivo preciso — `create-article.mjs` non e' importabile da
 * un test (761 KB, e la prima cosa che fa e' una chiamata di rete), quindi una
 * regola scritta la' dentro e' verificabile solo leggendo il sorgente come
 * testo. Qui invece `node --test` la esegue davvero.
 *
 * IL DIFETTO CHE HA RESO NECESSARIO IL MODULO. `isQuotaExhaustedError()` si
 * fida di `err.transientExhaustion`, che `classifyExhaustionCause()` calcola
 * come `transient >= persistent`: un voto di MAGGIORANZA sulle ragioni di
 * fallimento, con il PAREGGIO che va al transitorio. Accanto a quel calcolo
 * c'e' pero' un invariante dichiarato piu' forte del voto:
 *
 *   «The input-cap class stays PERSISTENT on purpose … a prompt larger than
 *    every declared cap does not get smaller at the next quota window, so
 *    deferring on it would loop forever and swallow the alert.»
 *
 * Niente teneva insieme le due cose, e il voto ha vinto. MISURATO sulla run
 * 31817957722 del 2026-08-14, ricontando i 107 errori del messaggio aggregato
 * con le stesse due regex di `classifyExhaustionCause`:
 *
 *     transient = 53   persistent = 53   ambiguo = 1
 *     di cui rifiuti su input cap = 38
 *     → 53 >= 53 → transientExhaustion = true → exit 0 → run VERDE
 *
 * Un pareggio esatto. Il ramo di differimento ha poi stampato «tutti i modelli
 * AI gratuiti sono temporaneamente esauriti (quota giornaliera)», che era
 * falso: i modelli non venivano chiamati, venivano SALTATI dal pre-flight
 * perche' il prompt (~9740 token stimati) superava il cap piu' permissivo del
 * roster (8000). Nessuna finestra di quota rimpicciolisce un prompt, quindi il
 * run successivo ha rifatto identico: 60+ run `success` di fila senza un
 * articolo, dalle 06:06Z alle 16:30Z, e nessuna «Workflow Failure» perche'
 * `scan-failed-runs.mjs` raccoglie solo le run `failure`.
 */

/**
 * Exit code dedicato: «il roster non puo' servire questo prompt».
 *
 * Non un generico `1`. Serve al chiamante — lo step «Generate the article» di
 * `.github/workflows/generate-article.yml` — per distinguere QUESTA condizione
 * da tutte le altre uscite non-zero, che quello step assorbe deliberatamente
 * come `no-article-this-run` (una fonte inadatta, un rigetto di qualita': sono
 * esiti normali, e farli fallire spegnerebbe la catena).
 *
 * Il branch la' e' scritto sul CODICE DI USCITA e non su una stringa dello
 * stdout: quel flusso e' pieno di sequenze ANSI e di virgolette tipografiche, e
 * un `grep` su di esso e' un oracolo che si acceca senza dirlo.
 *
 * 3 e non 2: `node` usa 1 per un'eccezione non gestita e 2 per un uso errato
 * della CLI, quindi il primo codice libero e non ambiguo e' 3.
 */
export const EXIT_ROSTER_CANNOT_SERVE_PROMPT = 3;

/**
 * Vero quando differire sarebbe un ciclo infinito: la cascata si e' svuotata e
 * almeno un modello ha rifiutato il payload sulla TAGLIA.
 *
 * LA REGOLA, e perche' e' formulata cosi'. Quando `inputCapReport` esiste — e
 * `callLLM` lo popola esattamente quando ≥1 modello ha rifiutato su input cap —
 * il pareggio non va piu' al transitorio: serve che il transitorio superi
 * STRETTAMENTE il persistente per poter differire. E' l'inversione minima del
 * `>=` che ha prodotto il verde, e lascia il comportamento IDENTICO su ogni
 * cascata senza rifiuti su taglia: li' il pareggio continua a differire, com'e'
 * giusto, perche' quelle ragioni si curano da sole a mezzanotte UTC.
 *
 * NON e' «piu' rosso per prudenza»: e' che le due classi hanno rimedi diversi e
 * incompatibili. Una quota si aspetta; un prompt sopra ogni cap si accorcia, e
 * finche' nessuno lo accorcia la condizione e' stabile per costruzione. Il
 * falso rosso costa una issue; il falso verde e' costato dieci ore di silenzio.
 *
 * SU QUALI NUMERI SI VOTA (issue #856). Sui secchi al NETTO degli echi di
 * cooldown, non su quelli lordi. Un solo guasto di provider — un 429, o un host
 * che smette di rispondere — lascia una riga di skip per ogni id fratello
 * servito da quell'host, ~11-12 su un roster da ~106: non sono fallimenti
 * indipendenti, sono lo stesso guasto contato dodici volte, e votavano qui
 * dentro una maggioranza che si decide per uno o due voti. Sulla run
 * 31823202761 (transient 53, persistent 52, di cui 11 echi TRANSITORI) il lordo
 * dava 53 > 52 → nessun veto → differimento concesso su una cascata che il
 * netto legge 42 contro 52. Lo stesso errore veniva misurato su due campioni
 * diversi: `isLegitimateQuotaDeferral` al netto (#805), questo al lordo.
 *
 * Se il breakdown contiene anche un `inputCapReport`, la taglia e' una causa
 * persistente gia' dichiarata dal produttore. Gli echi non attribuiti che
 * restano nei secchi vanno quindi addebitati a quella causa nel solo controllo
 * del veto; non si possono spostare automaticamente sul transitorio perche'
 * oggi ha il numero piu' alto (#938).
 *
 * La POLARITA' non cambia: pareggio al persistente, deciso da #357/#767. Cambia
 * solo il campione — ed e' esattamente ciò che `isTransientMajority` esprime,
 * col `tie` a parametro e la sottrazione presa da `deferralTally`, una sorgente
 * sola invece di una copia dell'aritmetica clampata (AGENTS.md #6).
 *
 * @param {unknown} err l'errore risalito fino al catch di primo livello
 * @returns {boolean} true → uscire con EXIT_ROSTER_CANNOT_SERVE_PROMPT
 */
export function isInputCapDeferralVeto(err) {
  if (!err || typeof err !== 'object') return false;
  if (err.code !== 'ALL_MODELS_EXHAUSTED') return false;
  const cap = err.inputCapReport;
  if (!cap || typeof cap !== 'object') return false;
  if (!(Number(cap.count) > 0)) return false;
  return !isTransientMajority(err.exhaustionBreakdown, {
    tie: 'persistent',
    // The consumer has already declared input-cap as the persistent cause.
    // Do not let an unclassified cooldown echo be charged to the opposite
    // bucket merely because transient currently leads by one vote.
    marginAttribution: 'persistent',
  });
}

/**
 * La riga che dice al chiamante DI QUANTO tagliare. Separata dal predicato
 * perche' il numero e' l'unica cosa azionabile e non deve dipendere dal fatto
 * che qualcuno legga il messaggio lungo.
 *
 * Riporta anche i DUE SECCHI SU CUI IL VETO HA DAVVERO DECISO — quelli netti —
 * e quante righe sono state tolte, per la stessa ragione per cui lo fa
 * `quotaDeferralShare`: una diagnostica che spiega un verdetto diverso da
 * quello preso smette di essere letta. Sono i DUE SECCHI del voto — quelli di
 * `echoBuckets`, senza i clamp sul totale che `deferralTally` mette sopra per
 * il suo quoziente — quindi `transient + persistent + providerCooldownSkips`
 * ricostruisce esattamente i due secchi lordi.
 */
export function inputCapVetoSummary(err) {
  const cap = (err && err.inputCapReport) || {};
  const est = Number(cap.estimatedRequestTokens) || 0;
  const best = Number(cap.maxSkippedReqLimit) || 0;
  const buckets = echoBuckets(err && err.exhaustionBreakdown);
  // La POLARITA' del call site, non una qualsiasi: questa riga spiega il veto
  // di `isInputCapDeferralVeto`, che vota col pareggio al persistente (#357).
  // Con l'altra polarita' la diagnostica descriverebbe un voto che nessuno ha
  // fatto — che e' il difetto che sta correggendo, un giro piu' in basso.
  const vote = transientMajorityVerdict(err && err.exhaustionBreakdown, {
    tie: 'persistent',
    marginAttribution: 'persistent',
  });
  const removed = buckets.echoTransient + buckets.echoPersistent;
  return {
    estimatedRequestTokens: est,
    maxSkippedReqLimit: best,
    over: est - best,
    refusals: Number(cap.count) || 0,
    transient: buckets.netTransient,
    persistent: buckets.netPersistent,
    // Le righe tolte AI DUE SECCHI, cosi' che `transient + persistent +
    // providerCooldownSkips` ricostruisca i due secchi lordi. Gli echi ambigui
    // non sono usciti da qui — non erano in nessuno dei due — ma contano per il
    // flag sotto, che e' un'altra domanda.
    providerCooldownSkips: removed,
    // Quando gli echi sono la maggioranza il voto ricade sui numeri LORDI (vedi
    // isTransientMajority): senza questo flag la riga potrebbe mostrare due
    // secchi netti che non sono quelli che hanno deciso. La condizione e' la
    // STESSA del guardrail, massa di echi dichiarata compresa (limitata alle
    // righe che il breakdown sostiene, #932) — e ora e' LA stessa, letta dal
    // voto invece che ricopiata: una diagnostica che ricopia
    // una versione indebolita del predicato dichiara «sottrazione affidabile»
    // proprio sulle run in cui non lo era.
    echoDominated: vote.echoDominated,
    // ── I CAMPI SU CUI IL VOTO HA DAVVERO DECISO (#857 → #888 → #938) ──────
    //
    // I due controlli aggiunti da #873 — pavimento delle prove nette e margine
    // sugli echi non attribuiti — possono produrre un veto che i due secchi
    // netti sopra NON spiegano: `{transient: 53, persistent: 52, total: 106,
    // providerCooldownSkips: {total: 11}}` mostra 53 contro 52, cioe' una
    // maggioranza transitoria, accanto a un veto deciso dal margine. Una riga
    // diagnostica che spiega un verdetto diverso da quello preso smette di
    // essere letta (e' la ragione per cui `quotaDeferralShare` porta
    // `echoDominated`), quindi il verdetto porta con se' anche la sua ragione.
    //
    // Nessuno di questi e' ricalcolato qui: vengono dallo stesso voto che ha
    // deciso l'exit code, che e' l'unico modo di garantire che descrivano
    // quello e non un suo sosia (AGENTS.md #6).
    decidedBy: vote.decidedBy,
    netEvidence: vote.netEvidence,
    echoHiddenInBuckets: vote.echoHiddenInBuckets,
    marginAttribution: vote.marginAttribution,
    // Il numero a SINISTRA del confronto che ha chiuso il voto, dopo il
    // margine. Riportato grezzo, anche quando e' negativo, perche' e'
    // letteralmente cio' che `wins()` ha visto.
    votedTransient: vote.votedTransient,
    votedPersistent: vote.votedPersistent,
  };
}

/**
 * ── «NESSUN ARTICOLO ⇒ NON VERDE», E L'UNICA ECCEZIONE ──────────────────────
 *
 * Exit code dedicato: «questa run non ha prodotto un articolo, E LA RAGIONE E'
 * DICHIARATA E LEGITTIMA». E' l'UNICO codice che lo step «Generate the article»
 * assorbe quando `article=false`; qualunque altro esito senza articolo — exit 0
 * compreso — e' rosso.
 *
 * L'inversione e' il punto. Fino a qui la regola era «assorbi tutto tranne un
 * caso nominato» (prima nessuno, poi il solo exit 3 di #357), e la sua forma
 * lascia passare per costruzione ogni difetto non ancora nominato: la miscela
 * di errori che ha prodotto il verde del 2026-08-14 non era il caso nominato, e
 * infatti e' passata. Ora la regola e' «fallisci tutto tranne i casi nominati»,
 * e i casi nominati sono SEI, elencati nel catch di primo livello di
 * `create-article.mjs` e nei tre `finalizeRunReport('skipped')` del ramo
 * evergreen:
 *
 *   1. pool evergreen saturo al pre-flight
 *   2. nessuna keyword evergreen disponibile al retry
 *   3. tentativi evergreen esauriti
 *   4. duplicato rilevato
 *   5. rigetto qualita' (slop non pubblicato)
 *   6. quota giornaliera davvero esaurita — vedi isLegitimateQuotaDeferral()
 *
 * 4 e non 1/2/3: `node` usa 1 per un'eccezione non gestita e 2 per un uso
 * errato della CLI, e 3 e' gia' EXIT_ROSTER_CANNOT_SERVE_PROMPT.
 */
export const EXIT_NO_ARTICLE_DECLARED = 4;

/**
 * La frazione di cascata che deve essere transitoria perche' «differisci» sia
 * una descrizione vera dello stato del roster.
 *
 * MISURATO sulla run 31823202761 (2026-08-14T17:45Z), riclassificando i 106
 * errori del messaggio aggregato con le due regex di `classifyExhaustionCause`:
 *
 *     transient  = 53   (tutti e 53 «daily limit» — quota vera)
 *     persistent = 52   (38 rifiuti su input cap, 12 «no API key», 2 × HTTP 404)
 *     ambiguo    =  1   (`claude-cli/haiku: claude CLI timed out after 120000ms`)
 *
 * `transientExhaustion` e' `transient >= persistent`, cioe' 53 >= 52 → true →
 * differimento → exit 0 → run VERDE. UN VOTO. E il voto che decide e' quello
 * che manca: la riga ambigua e' il timeout di Haiku, che `transientRe` non
 * matcha perche' cerca il letterale `timeout` mentre il messaggio dice `timed
 * out`. Dieci ore di produzione ferma decise da una `d`.
 *
 * IL DIFETTO NON E' LA SOGLIA, E' IL DENOMINATORE. Un confronto fra i due
 * secchi butta via gli ambigui, quindi puo' dichiarare «transitorio dominante»
 * uno stato in cui il transitorio e' meta' del roster. Meta' del roster fuori
 * quota si cura a mezzanotte; l'altra meta' — un prompt sopra ogni cap, una
 * chiave assente, un modello rimosso — non si cura mai, e differire su di essa
 * e' il ciclo che #313 descrive.
 *
 * Quindi il quoziente si prende sul TOTALE, ambigui inclusi, e la maggioranza
 * e' STRETTA. Sulla run sopra: 53/106 = 0,500 → non > 0,5 → NON e' un
 * differimento → rosso. Su una notte di quota vera, dove ogni modello risponde
 * «daily limit», il rapporto e' ~1,0 → differimento → verde, come prima.
 *
 * La polarita' degli ambigui e' deliberata e va nella direzione sicura: un
 * fallimento che non si sa classificare NON e' prova che aspettare aiutera'.
 */
export const QUOTA_DEFERRAL_MIN_TRANSIENT_SHARE = 0.5;

/**
 * Vero quando «differisci: quota esaurita» descrive davvero il roster.
 *
 * Da leggere INSIEME a `isInputCapDeferralVeto`, che resta il primo gate e il
 * piu' stretto: quello squalifica il differimento appena ≥1 modello ha rifiutato
 * sulla TAGLIA, questo lo squalifica quando la quota non e' la causa dominante
 * anche senza un solo rifiuto su taglia (roster mezzo senza chiavi, provider
 * giu', modelli rimossi).
 *
 * @param {unknown} err l'errore risalito fino al catch di primo livello
 * @returns {boolean} true → differire e' onesto, exit EXIT_NO_ARTICLE_DECLARED
 */
/**
 * ── GLI ECHI DI UN GUASTO NON SONO UN CAMPIONE (issue #805) ────────────────
 *
 * Il quoziente sopra e' onesto solo se ogni riga di `errors` e' un fallimento
 * INDIPENDENTE. Le righe di skip da cooldown di provider non lo sono: quando un
 * provider prende un 429 — o il suo host smette di rispondere — ogni id
 * fratello servito da quell'host lascia la sua riga, ~12 per GitHub, e sono
 * tutte lo stesso guasto, gia' contato una volta da chi il cooldown l'ha messo.
 *
 * Su un roster da ~106 valgono ~11 punti di share, cioe' piu' del margine con
 * cui la soglia decide: un solo provider morto sposta da solo il verdetto di
 * una notte di quota VERA. Prima di #767 quelle righe dicevano `cooling down`
 * (vocabolario transitorio) e GONFIAVANO lo share; da #767 la causa persistente
 * scrive `non-retryable` e lo SGONFIANO. La polarita' si e' invertita, la
 * distorsione e' rimasta: e' il denominatore a essere sbagliato, non la soglia
 * — esattamente cio' che il commento di QUOTA_DEFERRAL_MIN_TRANSIENT_SHARE
 * diceva gia' («IL DIFETTO NON E' LA SOGLIA, E' IL DENOMINATORE»).
 *
 * Quindi l'eco esce dal conteggio, e il guasto resta contato UNA volta. Sulla
 * notte misurata con l'host GitHub giu' — transient 51, persistent 55, total
 * 106, di cui 11 skip da cooldown — lo share passa da 51/106 = 0,481 (rosso,
 * Workflow-Failure su una condizione che si cura a mezzanotte) a 51/95 = 0,537
 * (differimento dichiarato, EXIT_NO_ARTICLE_DECLARED).
 *
 * RETRO-COMPATIBILE PER COSTRUZIONE. `providerCooldownSkips` arriva da
 * `classifyExhaustionCause` (ai-models.mjs); un errore serializzato prima di
 * #805, o un mock che non lo popola, degrada a zero e ottiene il quoziente di
 * oggi, byte per byte. Ogni sottrazione e' inoltre clampata al secchio da cui
 * esce: un campo incoerente non deve poter produrre un denominatore ≤ 0 o un
 * numeratore piu' grande del totale — cioe' non deve poter INVENTARE un
 * differimento, che e' l'unico errore che qui costa ore di silenzio.
 *
 * PERCHE' RIPARTITO PER SECCHIO e non un totale nudo. In una notte di quota
 * vera gli echi votano TRANSITORIO (`cooling down`), quindi vanno tolti anche
 * dal numeratore: toglierli dal solo denominatore darebbe share > 1 e, nel caso
 * limite di una cascata fatta di soli echi, una divisione per zero.
 *
 * @param {unknown} breakdown `err.exhaustionBreakdown`
 * @returns {{transient:number,persistent:number,ambiguous:number,total:number,providerCooldownSkips:number}}
 */
/** A count emitted by `classifyExhaustionCause` is always a non-negative integer. */
function nonNegativeInteger(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

/**
 * A replayed card cannot trust a denominator that is absent, malformed, or
 * smaller than the two buckets it claims to describe. The live producer emits
 * an integer `errors.length`; when old/corrupt JSON is replayed, use the
 * observed buckets as the smallest safe population instead of letting the
 * object enter the scorer in a shape the producer never writes.
 *
 * @param {unknown} breakdown
 * @returns {boolean}
 */
export function isExhaustionBreakdownTotalValid(breakdown) {
  if (!breakdown || typeof breakdown !== 'object' || Array.isArray(breakdown)) return false;
  const total = Number(breakdown.total);
  return Object.hasOwn(breakdown, 'total')
    && breakdown.total !== null
    && Number.isInteger(total)
    && total >= nonNegativeInteger(breakdown.transient) + nonNegativeInteger(breakdown.persistent);
}

/**
 * Normalize the JSON boundary used by offline run-card replays. This is a
 * copy, never a mutation: a card with a repaired denominator is kept visible,
 * but its derived share is deliberately invalidated by the caller because the
 * inferred minimum is not the original population.
 *
 * @param {unknown} breakdown
 * @returns {object|null}
 */
export function normalizeExhaustionBreakdown(breakdown) {
  if (!breakdown || typeof breakdown !== 'object' || Array.isArray(breakdown)) return null;
  const transient = nonNegativeInteger(breakdown.transient);
  const persistent = nonNegativeInteger(breakdown.persistent);
  const total = isExhaustionBreakdownTotalValid(breakdown)
    ? Number(breakdown.total)
    : transient + persistent;
  const sourceEcho = (breakdown.providerCooldownSkips
    && typeof breakdown.providerCooldownSkips === 'object'
    && !Array.isArray(breakdown.providerCooldownSkips))
    ? breakdown.providerCooldownSkips
    : {};
  return {
    ...breakdown,
    transient,
    persistent,
    total,
    providerCooldownSkips: {
      ...sourceEcho,
      total: nonNegativeInteger(sourceEcho.total),
      transient: Math.min(nonNegativeInteger(sourceEcho.transient), transient),
      persistent: Math.min(nonNegativeInteger(sourceEcho.persistent), persistent),
    },
  };
}

/**
 * ── I DUE SECCHI DEL VOTO, SENZA IL TOTALE DI MEZZO ─────────────────────────
 *
 * La sottrazione degli echi PER SECCHIO, e nient'altro: la sorgente unica sia
 * del quoziente (`deferralTally`, che ci mette sopra i suoi clamp sul totale)
 * sia del confronto di maggioranza (`isTransientMajority`, che NON deve
 * vederli).
 *
 * PERCHE' SEPARATI. `deferralTally` clampa `netPersistent` a
 * `netTotal - netTransient`, e deve: fa un quoziente, e un `total` incoerente
 * col resto non puo' comprare sconti sul denominatore. Ma quel clamp toglie
 * righe al SOLO persistente, cioe' esattamente nella direzione che TOGLIE il
 * veto — e il veto non ha un denominatore da difendere. Con
 * `{transient: 50, persistent: 60, total: 60}` il tally da' 50 vs 10 →
 * maggioranza transitoria → nessun veto, dove i due secchi dicono 50 vs 60 →
 * veto → exit 3. Speculare e nella direzione opposta: senza `total`, `netTotal`
 * e' 0 e AZZERA entrambi i secchi, cioe' `{transient: 53, persistent: 52}`
 * (breakdown serializzato prima di #805, o un mock) passerebbe da «nessun veto»
 * a «veto». Un confronto fra due secchi si fa sui due secchi.
 *
 * @param {unknown} breakdown `err.exhaustionBreakdown`
 * @returns {{transient:number,persistent:number,total:number,echoTransient:number,echoPersistent:number,netTransient:number,netPersistent:number}}
 */
function echoBuckets(breakdown) {
  const b = (breakdown && typeof breakdown === 'object') ? breakdown : {};
  const transient = Math.max(0, Number(b.transient) || 0);
  const persistent = Math.max(0, Number(b.persistent) || 0);
  const total = Math.max(0, Number(b.total) || 0);
  const echo = (b.providerCooldownSkips && typeof b.providerCooldownSkips === 'object')
    ? b.providerCooldownSkips
    : {};
  // Clampati al proprio secchio: un `echo.transient` piu' grande del secchio
  // che dice di descrivere e' un campo rotto, e non puo' togliere righe che
  // non ci sono.
  const echoTransient = Math.min(Math.max(0, Number(echo.transient) || 0), transient);
  const echoPersistent = Math.min(Math.max(0, Number(echo.persistent) || 0), persistent);
  return {
    transient,
    persistent,
    total,
    echoTransient,
    echoPersistent,
    // La massa di echi DICHIARATA, non quella attribuita: `classifyExhaustionCause`
    // incrementa `total` per ogni riga di skip e i due secchi solo quando la
    // `skipPhrase` matcha, quindi la differenza sono gli echi AMBIGUI — righe
    // vere, dello stesso guasto, che nessuna delle due regex ha collocato. Chi
    // deve decidere «gli echi sono la maggioranza delle prove» le conta; chi
    // sottrae dai secchi no, perche' non sa da quale sottrarle.
    //
    // RESTA GREZZA, e non e' una dimenticanza (#932). I due consumatori la
    // vogliono con polarita' OPPOSTE: il margine di `transientMajorityVerdict`
    // addebita l'eccedenza al vincitore e `deferralTally` la scarta per intero
    // — entrambi verso il rosso — mentre chi la usa come NUMERATORE del
    // guardrail la vuole limitata alle righe che esistono. Clampare qui
    // servirebbe il secondo indebolendo i primi due: verificato in
    // `exhaustion-transient-majority.test.mjs`, un clamp alla sorgente ribalta
    // `{transient: 1, total: 1, providerCooldownSkips: {total: 2}}` da veto a
    // differimento, cioe' un campo che CONTRADDICE il breakdown che compra il
    // differimento che #313 e' costato. Il limite vive al solo call site che ne
    // ha bisogno.
    echoTotalReported: Math.max(0, Number(echo.total) || 0),
    netTransient: transient - echoTransient,
    netPersistent: persistent - echoPersistent,
  };
}

/**
 * Riconosce il caso in cui ogni riga della cascata e' un echo di cooldown.
 *
 * Il pavimento del voto lo tratta correttamente come «nessuna prova
 * indipendente», ma il flag `transientExhaustion` diventa cosi' `false` e il
 * chiamante perde il canale `roster-down-not-deferrable`. Questo verdetto e'
 * strutturale: richiede che il produttore dichiari lo stesso numero di righe e
 * di echi e che ogni voto di secchio sia coperto; dati gonfiati o incoerenti
 * restano nel percorso generico, senza inventare una causa.
 *
 * @param {unknown} err
 * @returns {{cause:'provider-cooldown-echo-only',echoes:number,total:number,transientEchoes:number,persistentEchoes:number,unclassifiedEchoes:number}|null}
 */
export function providerCooldownEchoOnlySummary(err) {
  if (!err || typeof err !== 'object' || err.code !== 'ALL_MODELS_EXHAUSTED') return null;
  const breakdown = err.exhaustionBreakdown;
  if (!isExhaustionBreakdownTotalValid(breakdown)) return null;
  const echo = breakdown.providerCooldownSkips;
  if (!echo || typeof echo !== 'object' || Array.isArray(echo)) return null;

  const isCount = (value) => (
    value !== null
    && value !== undefined
    && value !== ''
    && Number.isInteger(Number(value))
    && Number(value) >= 0
  );
  // The producer always emits these four counters. If one is malformed, the
  // safe answer is the generic error path, not a fabricated all-echo cause.
  if (![breakdown.transient, breakdown.persistent, breakdown.total, echo.total].every(isCount)) {
    return null;
  }
  // These split counters were added with the live producer. A replay that
  // only has the aggregate echo total is legacy data, not proof that every
  // row was an echo: fail closed instead of manufacturing an all-echo cause.
  if (!['transient', 'persistent'].every((key) => (
    Object.hasOwn(echo, key) && isCount(echo[key])
  ))) {
    return null;
  }
  const total = Number(breakdown.total);
  const echoes = Number(echo.total);
  const transient = nonNegativeInteger(breakdown.transient);
  const persistent = nonNegativeInteger(breakdown.persistent);
  const transientEchoes = nonNegativeInteger(echo.transient);
  const persistentEchoes = nonNegativeInteger(echo.persistent);
  if (!Number.isInteger(echoes) || echoes <= 0 || echoes !== total) return null;
  if (transientEchoes > transient || persistentEchoes > persistent) return null;
  if (transientEchoes + persistentEchoes > echoes) return null;
  if ((transient - transientEchoes) + (persistent - persistentEchoes) > 0) return null;

  return {
    cause: 'provider-cooldown-echo-only',
    echoes,
    total,
    transientEchoes,
    persistentEchoes,
    unclassifiedEchoes: echoes - transientEchoes - persistentEchoes,
  };
}

function deferralTally(breakdown) {
  const {
    transient, persistent, total, echoTransient, echoPersistent, echoTotalReported,
  } = echoBuckets(breakdown);
  // La parte di `echo.total` NON ripartita fra i due secchi e' fatta di echi
  // AMBIGUI, e deve stare nella massa ambigua — non nel totale. Clamparla al
  // totale la lascia uscire dal solo DENOMINATORE, che e' l'unico modo di
  // inventare un differimento: con `{transient:53, persistent:52, total:106,
  // providerCooldownSkips:{total:50}}` darebbe 53/56 = 0,946 → differimento,
  // dove il lordo 53/106 = 0,500 (la run 31823202761) diceva rosso. E l'eco
  // ambiguo non e' un caso di laboratorio: basta una `skipPhrase` futura che
  // non matchi ne' `transientRe` ne' `persistentRe` — oggi le due frasi
  // matchano per costruzione, cioe' «una riformulazione di distanza», la
  // stessa trappola che `classifyExhaustionCause` si nomina addosso.
  const echoUnattributed = Math.max(0, echoTotalReported - echoTransient - echoPersistent);
  const ambiguousMass = Math.max(0, total - transient - persistent);
  // ...e se non ci sta, il campo CONTRADDICE il breakdown: non e' una misura,
  // e la parte non collocabile non compra sconti sul denominatore. Clamparla
  // (invece che scartarla) basterebbe a ribaltare la run 31823202761 con un
  // `{total: 999}`: massa ambigua 1 → 53/105 = 0,5047 → differimento inventato
  // da un campo rotto. Non attribuito ⇒ non tolto, che e' la stessa polarita'
  // di ogni altro dubbio in questo file.
  const echoAmbiguous = echoUnattributed <= ambiguousMass ? echoUnattributed : 0;
  // Somma dei tre secchi, non un `echo.total` clampato: cosi' ogni riga tolta
  // dal denominatore e' una riga tolta anche dal secchio in cui votava.
  const echoTotal = Math.min(echoTransient + echoPersistent + echoAmbiguous, total);
  const netTotal = Math.max(0, total - echoTotal);
  const netTransient = Math.min(Math.max(0, transient - echoTransient), netTotal);
  const netPersistent = Math.min(Math.max(0, persistent - echoPersistent), netTotal - netTransient);
  return {
    transient: netTransient,
    persistent: netPersistent,
    ambiguous: Math.max(0, netTotal - netTransient - netPersistent),
    total: netTotal,
    providerCooldownSkips: echoTotal,
  };
}

/**
 * ── IL VOTO DI MAGGIORANZA AL NETTO, CON LA POLARITA' A PARAMETRO (#855) ────
 *
 * L'unica sorgente del confronto «transitorio contro persistente» per chi deve
 * votare sui secchi al netto degli echi di cooldown. Esiste perche' la
 * sottrazione di `deferralTally` — clamp per secchio, echi non attribuiti,
 * guardrail di maggioranza — e' aritmetica delicata, e riscriverla in ogni
 * consumatore significa un clamp giusto qui e sbagliato la', su un errore che
 * decide l'exit code di produzione (AGENTS.md #6).
 *
 * `tie` NON e' una manopola: e' la polarita' gia' decisa altrove, resa
 * esplicita. `'transient'` e' il `>=` di `classifyExhaustionCause`;
 * `'persistent'` e' l'inversione sul solo pareggio che #357 ha introdotto per
 * `isInputCapDeferralVeto`, dove una cascata con ≥1 rifiuto su taglia non puo'
 * differire in parita'. Chi chiama sceglie la sua, nessuno la cambia.
 *
 * IL GUARDRAIL HA LA STESSA RAGIONE DI QUELLO DI `isLegitimateQuotaDeferral` —
 * quando le righe tolte sono piu' di quelle rimaste, la sottrazione decide su
 * un campione che e' in maggioranza il guasto che sta rimuovendo, quindi puo'
 * CONFERMARE il verdetto lordo ma non ribaltarlo da sola — e la stessa massa di
 * echi al numeratore: quella DICHIARATA da `providerCooldownSkips.total`,
 * ambigui compresi.
 *
 * MA NON LO STESSO DENOMINATORE, ed e' deliberato. La' e' `> total`, perche' un
 * quoziente ha un denominatore da difendere e gli ambigui ci vivono dentro; qui
 * e' `> netTransient + netPersistent`, perche' un confronto fra due secchi non
 * ha totale, e usarlo renderebbe il guardrail INERTE su un breakdown senza
 * `total` (serializzato prima di #805, o un mock parziale) — cioe' proprio dove
 * il campione e' meno affidabile. La divergenza sta tutta li': stessa nozione
 * di «gli echi sono la maggioranza delle prove», misurata contro le prove che
 * ciascuno dei due predicati usa davvero.
 *
 * ── DUE CONTROLLI CHE STANNO QUI DENTRO E NON NEI CHIAMANTI (#873) ─────────
 *
 * 1. IL PAVIMENTO DELLE PROVE NETTE. Con `netTransient + netPersistent == 0`
 *    non e' rimasta UNA riga indipendente: ogni fallimento nei due secchi era
 *    l'eco di un solo guasto. `{transient: 5, persistent: 0,
 *    providerCooldownSkips: {transient: 5, total: 5}}` — cinque fratelli
 *    saltati dallo stesso host — dava `wins(0, 0)` vero col pareggio al
 *    transitorio, poi il guardrail (5 > 0) tornava al lordo 5 vs 0 e
 *    CONFERMAVA: «maggioranza transitoria» su un campione netto VUOTO, cioe' il
 *    differimento silenzioso di #313. Il pavimento e' la stessa affermazione
 *    che `isLegitimateQuotaDeferral` fa con `total <= 0` («un guasto solo,
 *    ripetuto, non e' la prova che aspettare aiuti») e assorbe la clausola
 *    `transient > 0` del vecchio calcolo LORDO di `err.transientExhaustion`:
 *    con entrambi i secchi netti a zero non c'e' maggioranza da dichiarare,
 *    qualunque sia `tie`. Su `tie: 'persistent'` non cambia nulla — `wins(0, 0)`
 *    era gia' falso col `>` stretto — quindi la polarita' di #357/#767 resta
 *    intatta e il pavimento e' visibile solo al call site di #857.
 *
 * 2. LA COERENZA DI `echoTotalReported`: GLI ECHI CHE NON CI STANNO SONO
 *    DENTRO I SECCHI. `classifyExhaustionCause` incrementa
 *    `providerCooldownSkips.total` per OGNI riga di skip da cooldown, e i due
 *    secchi solo quando la `skipPhrase` matcha una delle due regex. La
 *    differenza — `echoTotalReported - echoTransient - echoPersistent` — sono
 *    echi che il breakdown DICHIARA e non colloca, e la loro casa naturale e'
 *    la massa ambigua (`total - transient - persistent`). Quando non ci
 *    stanno, l'eccedenza non e' rumore: e' la prova aritmetica che quelle
 *    righe sono finite DENTRO i due secchi senza che nessuno dicesse in quale.
 *    Sono la sottrazione che #805 credeva di aver fatto e non ha fatto.
 *
 *    Qui il campo si legge GREZZO, e il guardrail piu' sotto lo legge limitato
 *    alle righe che esistono (#932): l'eccedenza e' la PROVA su cui questo
 *    controllo e' costruito — limitarla lo spegnerebbe, e con esso la lettura
 *    della run 31823202761 — mentre un numeratore che conta piu' righe di
 *    quante il breakdown ne dichiari non e' una misura di niente.
 *
 *    La run 31823202761 e' esattamente questo caso: `{transient: 53,
 *    persistent: 52, total: 106, providerCooldownSkips: {total: 11}}` — massa
 *    ambigua UNO, echi non attribuiti UNDICI. Dieci echi stanno nei secchi. La
 *    sottrazione non toccava niente (53 vs 52, margine UNO) e il guardrail non
 *    entrava (11 < 105): l'helper tornava `true`, cioe' riportava in silenzio
 *    il verdetto PRE-#805 che #856 esiste per correggere — e reggeva solo
 *    perche' `transientRe` colloca `cooling down` PER COSTRUZIONE, «una
 *    riformulazione di distanza». Ora l'eccedenza gioca sul margine:
 *    `wins(53 - 10, 52)` e' falso in entrambe le polarita' → `false`.
 *
 *    L'eccedenza si toglie al VINCITORE e non all'altro secchio perche' e'
 *    l'unica direzione dimostrabile: un voto che regge anche assegnando ogni
 *    riga dubbia contro di se' e' un voto sulle prove, non sulla fortuna della
 *    classificazione. Il clamp alla massa ambigua serve a non contare due
 *    volte righe che nei secchi non sono mai entrate: `{transient: 90,
 *    persistent: 60, total: 200, echo: {total: 120, transient: 30, persistent:
 *    30}}` ha 50 ambigui che ospitano 50 dei 60 echi non attribuiti, e li'
 *    lordo (90 vs 60) e netto (60 vs 30) concordano — nessun veto da inventare.
 *
 *    NON E' LA POLITICA DI `deferralTally` SULLO STESSO NUMERO, e dedurre
 *    l'una dall'altra porta fuori strada. Su `echoUnattributed` che nella
 *    massa ambigua non ci sta, le due funzioni fanno cose OPPOSTE:
 *      - `deferralTally` scarta TUTTO O NIENTE (`echoUnattributed <=
 *        ambiguousMass ? echoUnattributed : 0`): un `echo.total` che non ci sta
 *        CONTRADDICE il breakdown, e un campo contraddittorio non compra
 *        sconti sul denominatore — quindi non se ne toglie NEMMENO la parte
 *        che ci starebbe;
 *      - qui la parte che ci sta si ignora (vive gia' fuori dai due secchi) e
 *        si addebita al vincitore la sola ECCEDENZA.
 *    Scarto integrale contro scarto della sola eccedenza. Sulla forma coerente
 *    della run storica non divergono perche' pendono entrambe verso il rosso —
 *    denominatore piu' grande la', secchio vincente piu' piccolo qui — non
 *    perche' siano la stessa regola. Chi tocca una delle due non ha licenza di
 *    allineare l'altra «per coerenza»: sono giustificate separatamente, e la
 *    divergenza e' fissata da `exhaustion-transient-majority.test.mjs` perche'
 *    su questo predicato il commento non sia l'unica specifica. L'affermazione
 *    non e' universale: esiste anche una forma incoerente in cui la
 *    diagnostica supera la soglia mentre il voto torna falso.
 *
 * @param {unknown} breakdown `err.exhaustionBreakdown`
 * @param {{tie?: 'transient'|'persistent'}} [options] a chi va il pareggio
 * @returns {boolean} true → il transitorio e' la maggioranza al netto
 */
export function isTransientMajority(breakdown, options = {}) {
  return transientMajorityVerdict(breakdown, options).verdict;
}

/**
 * ── LO STESSO VOTO, CON LA RAGIONE DEL VERDETTO ────────────────────────────
 *
 * `isTransientMajority` risponde si'/no; questa risponde ANCHE «chi ha
 * deciso», ed e' l'unica sorgente di entrambe le risposte. Esiste perche' una
 * diagnostica che vuole spiegare il verdetto ha due sole strade: ricopiare
 * l'aritmetica (pavimento, margine, guardrail) accanto al predicato — cioe'
 * AGENTS.md #6 al contrario, su un calcolo che decide l'exit code di
 * produzione — oppure leggerla da qui. `inputCapVetoSummary` legge da qui.
 *
 * `decidedBy` nomina il controllo che ha prodotto il verdetto:
 *
 *   `floor`  → nessuna riga indipendente nei due secchi netti (controllo 1).
 *   `net`    → hanno deciso i due secchi netti, in un verso o nell'altro. E'
 *              anche il caso del `true` finale, quando margine e guardrail
 *              hanno lasciato passare il confronto netto.
 *   `margin` → il netto diceva «transitorio», ma gli echi dichiarati che nella
 *              massa ambigua non ci stanno lo ribaltano (controllo 2).
 *   `gross`  → gli echi tolti erano la maggioranza delle prove rimaste, quindi
 *              il netto non poteva ribaltare da solo e il verdetto e' quello
 *              LORDO (guardrail). L'unico caso in cui i due secchi riportati
 *              qui NON sono quelli che hanno deciso.
 *
 * Il guardrail si raggiunge solo dopo che pavimento, netto e margine hanno
 * detto «transitorio»: `echoDominated` puo' quindi essere vero accanto a un
 * `decidedBy` diverso da `gross`, ed e' voluto — dice «la sottrazione era
 * inaffidabile», non «ha deciso il lordo».
 *
 * @param {unknown} breakdown `err.exhaustionBreakdown`
 * @param {{tie?: 'transient'|'persistent',marginAttribution?: 'transient'|'persistent'}} [options] a chi va il pareggio e a quale causa addebitare il margine non attribuito
 * @returns {{verdict:boolean,decidedBy:'floor'|'net'|'margin'|'gross',netTransient:number,netPersistent:number,netEvidence:number,echoHiddenInBuckets:number,marginAttribution:'transient'|'persistent',votedTransient:number,votedPersistent:number,echoRemoved:number,echoDominated:boolean}}
 */
function transientMajorityVerdict(breakdown, options = {}) {
  const tie = (options && options.tie === 'persistent') ? 'persistent' : 'transient';
  // `tie` controls equality only. Attribution is explicit because the input
  // cap consumer has already declared a persistent cause, while the ordinary
  // transient verdict keeps the historical conservative attribution.
  const marginAttribution = (options && options.marginAttribution === 'persistent')
    ? 'persistent'
    : 'transient';
  const wins = (transient, persistent) => (
    tie === 'persistent' ? transient > persistent : transient >= persistent
  );
  const buckets = echoBuckets(breakdown);
  // Margine contro gli echi dichiarati che nella massa ambigua non ci stanno,
  // e che quindi sono nei due secchi senza etichetta (vedi 2 sopra).
  const echoUnattributed = Math.max(
    0,
    buckets.echoTotalReported - buckets.echoTransient - buckets.echoPersistent,
  );
  // Un `total` ASSENTE non e' uno zero osservato: non c'e' un denominatore con
  // cui stimare quante righe ambigue possano ospitare gli echi non attribuiti.
  // Il comportamento legacy resta quindi quello dei due secchi osservati. Un
  // `total` PRESENTE ma corrotto (null, negativo o non numerico) e' diverso:
  // l'oggetto dichiara un denominatore e lo contraddice, quindi non puo' usare
  // l'assenza di una massa ambigua come prova a proprio favore. Gli echi non
  // attribuiti vengono addebitati al vincitore, come per `total: 0` esplicito;
  // `normalizeExhaustionBreakdown()` chiude poi il confine delle card rigiocate.
  const rawTotal = (breakdown && typeof breakdown === 'object') ? breakdown.total : undefined;
  const totalPresent = Boolean(
    breakdown && typeof breakdown === 'object' && Object.hasOwn(breakdown, 'total'),
  );
  const hasTotal = isExhaustionBreakdownTotalValid(breakdown);
  const ambiguousMass = hasTotal
    ? Math.max(0, buckets.total - buckets.transient - buckets.persistent)
    : 0;
  const echoHiddenInBuckets = totalPresent
    ? Math.max(0, echoUnattributed - ambiguousMass)
    : 0;
  // Il guardrail conta le righe DI QUESTO voto: gli echi DICHIARATI contro
  // quelli rimasti nei due secchi. Il denominatore sono i due secchi netti —
  // non `providerCooldownSkips > total` del tally, che porterebbe dentro il
  // totale dalla porta di servizio ed e' inerte su un breakdown senza `total`,
  // cioe' proprio dove il campione e' meno affidabile. Il numeratore invece e'
  // la massa PIENA, ambigui compresi: contare i soli echi attribuiti renderebbe
  // il guardrail cieco esattamente dove serve. Con `{transient: 50,
  // persistent: 60, total: 200, providerCooldownSkips: {total: 120,
  // persistent: 30}}` le righe di eco sono 120 contro 80 rimaste — il campione
  // e' in maggioranza il guasto che sta rimuovendo — ma i soli 30 attribuiti
  // direbbero «sottrazione affidabile» e il netto 50 vs 30 toglierebbe DA SOLO
  // il veto che il lordo 50 vs 60 metteva: il differimento su `cap.count > 0`,
  // cioe' il ciclo infinito di #313.
  // ...ma non piu' grande della POPOLAZIONE (#932). `echoTotalReported` non
  // aveva alcun pavimento superiore, quindi un `providerCooldownSkips: {total:
  // 999}` rendeva `echoDominated` vero per costruzione — e quel flag non e' piu'
  // solo interno: da #890 `inputCapVetoSummary` lo PUBBLICA accanto a
  // `decidedBy`, cioe' afferma «la sottrazione era inaffidabile» su un numero
  // che contraddice il breakdown che sta spiegando. In
  // `classifyExhaustionCause` ogni incremento di `providerCooldownSkips.total`
  // avviene dentro il ciclo su `errors`: una riga di skip e' una riga, e sopra
  // le righe esistenti il campo non e' una misura.
  //
  // Le righe esistenti sono `max(total, transient + persistent)` e non `total`
  // secco: su un breakdown gia' incoerente per conto suo (`{transient: 2,
  // persistent: 2, total: 1}`) prendere `total` alla lettera farebbe cadere il
  // guardrail e INVENTEREBBE un differimento — un secondo campo rotto non puo'
  // fare da metro al primo. Con `total` assente (serializzato prima di #805, o
  // un mock) i due secchi restano comunque un pavimento, e se anche quelli sono
  // zero non c'e' popolazione contro cui validare: il valore passa intatto,
  // perche' li' il campione e' meno affidabile, non piu'.
  //
  // Il limite e' DIAGNOSTICO e non sposta un exit code: su 624.260 combinazioni
  // di breakdown il verdetto e il ramo `decidedBy` sono identici a prima, e
  // cambia solo `echoDominated` (test in `exhaustion-transient-majority.test.mjs`).
  const evidenceRows = Math.max(buckets.total, buckets.transient + buckets.persistent);
  const echoDeclared = evidenceRows > 0
    ? Math.min(buckets.echoTotalReported, evidenceRows)
    : buckets.echoTotalReported;
  const echoRemoved = Math.max(
    buckets.echoTransient + buckets.echoPersistent,
    echoDeclared,
  );
  const netEvidence = buckets.netTransient + buckets.netPersistent;
  const votedTransient = buckets.netTransient
    - (marginAttribution === 'transient' ? echoHiddenInBuckets : 0);
  const votedPersistent = buckets.netPersistent
    - (marginAttribution === 'persistent' ? echoHiddenInBuckets : 0);
  const base = {
    netTransient: buckets.netTransient,
    netPersistent: buckets.netPersistent,
    netEvidence,
    echoHiddenInBuckets,
    marginAttribution,
    votedTransient,
    votedPersistent,
    echoRemoved,
    // Calcolato SEMPRE, anche quando il guardrail non viene raggiunto: e'
    // l'affidabilita' della sottrazione, non il ramo percorso.
    echoDominated: echoRemoved > netEvidence,
  };
  // Pavimento: niente prove indipendenti, niente maggioranza (vedi 1 sopra).
  if (netEvidence <= 0) return { ...base, verdict: false, decidedBy: 'floor' };
  if (!wins(buckets.netTransient, buckets.netPersistent)) {
    return { ...base, verdict: false, decidedBy: 'net' };
  }
  if (!wins(votedTransient, votedPersistent)) {
    return { ...base, verdict: false, decidedBy: 'margin' };
  }
  if (base.echoDominated) {
    return { ...base, verdict: wins(buckets.transient, buckets.persistent), decidedBy: 'gross' };
  }
  return { ...base, verdict: true, decidedBy: 'net' };
}

function passesShare(transient, total) {
  return total > 0 && transient / total > QUOTA_DEFERRAL_MIN_TRANSIENT_SHARE;
}

export function isLegitimateQuotaDeferral(err) {
  if (!err || typeof err !== 'object') return false;
  if (err.code !== 'ALL_MODELS_EXHAUSTED') return false;
  const { transient, total, providerCooldownSkips } = deferralTally(err.exhaustionBreakdown);
  // Senza denominatore non si puo' affermare niente, e l'affermazione non
  // dimostrata qui vale «rosso»: e' la direzione in cui l'errore costa meno.
  // Vale anche per una cascata di soli echi: un guasto solo, ripetuto, non e'
  // la prova che aspettare aiuti.
  if (total <= 0) return false;
  // ── QUANDO GLI ECHI SONO LA MAGGIORANZA, LA SOTTRAZIONE NON VOTA ─────────
  //
  // Togliere gli echi restringe il campione, e un campione piccolo si ribalta
  // con un voto — e' la stessa ragione per cui il quoziente si prende sul
  // TOTALE («dieci ore di produzione ferma decise da una `d`»). Aritmetica sul
  // codice: 12 host irraggiungibili (12 guasti persistenti VERI) + 81 echi
  // persistenti + 13 timeout su 106 righe → netto 13/25 = 0,52 → differimento,
  // exit 0, nessun articolo e nessun alert, dove il lordo 13/106 = 0,12 era
  // rosso. Dodici host che rifiutano la connessione non si curano a mezzanotte.
  //
  // Quindi: quando le righe tolte sono piu' di quelle rimaste, il differimento
  // deve reggere ANCHE sui numeri lordi. Non e' un pavimento arbitrario sul
  // campione — che boccerebbe la notte di quota vera in cui quasi ogni riga e'
  // un eco `cooling down` (share lordo ~1,0, differimento onesto) — ma il
  // divieto preciso: la sottrazione puo' confermare un verdetto, non ribaltarlo
  // da sola quando e' lei la maggioranza delle prove.
  if (providerCooldownSkips > total) {
    const b = err.exhaustionBreakdown || {};
    const grossTotal = Math.max(0, Number(b.total) || 0);
    const grossTransient = Math.max(0, Number(b.transient) || 0);
    // ── UN CAMPIONE LORDO INCOERENTE NON CONFERMA NIENTE (#832, item 1) ────
    //
    // Questi due sono letti GREZZI, senza i clamp che `deferralTally` applica
    // dieci righe sopra. Con `transient > total` lo share lordo esce > 1, il
    // ramo passa SEMPRE e il guardrail si autodisattiva in silenzio: il
    // verdetto torna a dipendere dalla sola sottrazione, che e' esattamente il
    // caso che il guardrail esiste per vietare. Il produttore odierno non puo'
    // emettere quella forma; un `err` serializzato o corrotto, e un chiamante
    // futuro, si'.
    //
    // Il clamp a `grossTotal` che la issue propone NON basta e va detto: porta
    // il rapporto a 1,0 esatto, che supera comodamente una soglia di 0,5 — il
    // ramo continuerebbe a passare sempre, solo con un numero piu' presentabile.
    // Serve rifiutare, e la direzione e' quella che il resto del modulo tiene:
    // il guardrail chiede una CONFERMA sui numeri lordi, e un campione che
    // contraddice se stesso non e' una conferma. Vale «rosso», come ogni altra
    // affermazione non dimostrata qui dentro.
    if (grossTransient > grossTotal) return false;
    if (!passesShare(grossTransient, grossTotal)) return false;
  }
  return passesShare(transient, total);
}

/**
 * La riga machine-readable che spiega PERCHE' un differimento e' stato rifiutato.
 * Separata dal predicato per la stessa ragione di `inputCapVetoSummary`: il
 * numero azionabile non deve dipendere da chi legge la prosa.
 */
export function quotaDeferralShare(err) {
  // Gli STESSI numeri su cui il predicato ha deciso — al netto degli echi di
  // cooldown (deferralTally): una riga diagnostica che riportasse il totale
  // lordo spiegherebbe un verdetto diverso da quello preso, ed e' il modo in
  // cui una metrica smette di essere letta. `providerCooldownSkips` dice
  // quante righe sono state tolte, cosi' il totale lordo resta ricostruibile.
  const tally = deferralTally(err && err.exhaustionBreakdown);
  return {
    ...tally,
    share: tally.total > 0 ? tally.transient / tally.total : 0,
    required: QUOTA_DEFERRAL_MIN_TRANSIENT_SHARE,
    // Senza questo flag la riga diagnostica potrebbe dichiarare uno share SOPRA
    // soglia accanto a un differimento RIFIUTATO — il guardrail di maggioranza
    // sopra decide su altro — ed e' esattamente il modo in cui una metrica
    // smette di essere letta.
    echoDominated: tally.providerCooldownSkips > tally.total,
  };
}

/**
 * ── IL PAVIMENTO DELL'IMPALCATURA, E PERCHE' STA QUI (issue #452) ───────────
 *
 * Il peso minimo del prompt di `create-article.mjs` a fonte E fatti AZZERATI:
 * template, schema JSON, istruzioni di sezione, blocco keyword, FAQ, LSI. E'
 * impalcatura, non contenuto, e nessun gradino della scala di riduzione la
 * tocca — il commento che la nomina in `callGemini` lo dice cosi': «il rimedio
 * onesto per i due gradini bassi non e' uno `shrink` piu' aggressivo — non
 * esiste».
 *
 * Il numero viveva come `const` locale dentro `callGemini`, cioe' dentro un
 * file che nessun test puo' importare (761 KB, e la prima cosa che fa e' una
 * chiamata di rete). Ora vive qui per la stessa ragione per cui ci vive il
 * resto del modulo: `node --test` lo esegue davvero, e le due meta' che lo
 * leggono — il marker `unsat=` di `callGemini` e l'uscita anticipata del ciclo
 * di retry — non possono divergere su un letterale riscritto a mano.
 */
export const PROMPT_SCAFFOLD_FLOOR_TOKENS = 5850;

/**
 * Vero quando un budget di prompt DETTATO DALLA FLOTTA e' irraggiungibile.
 *
 * `callLLM` allega `retryRequestTokenBudget` all'errore esattamente quando la
 * cascata si e' svuotata e ≥1 modello ha rifiutato sulla TAGLIA, e il numero e'
 * il cap PIU' PERMISSIVO fra quelli che hanno detto no. Se anche quel cap sta
 * sotto il pavimento dell'impalcatura, non esiste una riduzione che ci rientri:
 * il bersaglio e' sotto il peso del prompt vuoto.
 *
 * La forma e' quella dei predicati sopra — un numero, non un'euristica — perche'
 * il chiamante la usa PRIMA di spendere un tentativo, non dopo.
 *
 * @param {unknown} budget il target in token che la flotta ha dettato
 * @returns {boolean} true → ogni tentativo successivo e' insoddisfacibile
 */
export function isBudgetBelowScaffoldFloor(budget) {
  const n = Number(budget);
  // `> 0` e non `>= 0`: «nessun budget dettato» (0 / undefined / NaN) non e' un
  // budget impossibile, e' l'assenza di un vincolo. Confonderli farebbe uscire
  // presto ogni run che non ha mai sentito parlare di cap.
  return Number.isFinite(n) && n > 0 && n < PROMPT_SCAFFOLD_FLOOR_TOKENS;
}

/**
 * ── L'ASSORBENTE, E PERCHE' NON E' UNA DELLE SEI RAGIONI LEGITTIME ──────────
 *
 * MISURATO (issue #452, finestra 2026-08-13 → 18, 926 run di
 * `generate-article.yml`): una run `failure` dura 2510s mediani contro i 254s
 * di una `success`. La differenza e' quasi tutta macinamento DOPO che l'esito
 * era gia' deciso.
 *
 * La forma esatta dello stallo, e sono due pezzi giusti che insieme fanno un
 * assorbente perfetto:
 *
 *   1. il ciclo di retry applica il budget dettato con un `Math.min`
 *      deliberatamente MONOTONO — allentarlo vanificherebbe la riduzione gia'
 *      decisa — quindi il budget non si riallarga mai;
 *   2. sotto PROMPT_SCAFFOLD_FLOOR_TOKENS nessuna riduzione rientra.
 *
 * Quindi basta UN tentativo che detti un budget sotto il pavimento perche'
 * TUTTI i tentativi restanti di quella sezione siano insoddisfacibili per
 * costruzione. La sezione ne macinava fino a sei, ognuno con la cascata
 * sull'intero roster, fino a `hard-killed after ~1180s` (exit 124). Il marker
 * `[prompt-budget] … unsat=1` lo dichiarava a ogni giro e nessuno lo leggeva:
 * l'unica azione era un `console.warn`.
 *
 * PERCHE' L'USCITA NON E' `EXIT_NO_ARTICLE_DECLARED` (4). Le sei ragioni
 * legittime hanno tutte la stessa proprieta': il giro successivo puo' andare
 * diversamente da solo (un altro headline, un'altra finestra di quota). Questa
 * no. E' la stessa classe di `isInputCapDeferralVeto`: un roster i cui cap non
 * arrivano al peso dell'impalcatura non si cura a mezzanotte, e dichiararla
 * «legittima» rimetterebbe in piedi il verde silenzioso di #313 — con in piu'
 * il `declared=true` che fa CHAINARE il successore contro lo stesso muro.
 * Esce quindi `EXIT_ROSTER_CANNOT_SERVE_PROMPT` (3), che e' letteralmente cio'
 * che e' successo, e che il workflow gia' sa leggere (`roster_blocked=true`).
 *
 * PERCHE' UN PREDICATO NUOVO E NON `isInputCapDeferralVeto`. Quello parla di un
 * ALTRO fatto — la maggioranza fra transitorio e persistente su una cascata con
 * ≥1 rifiuto su taglia — e su un errore con quota dominante risponde `false`
 * proprio dove questo deve rispondere `true`. Condividono l'esito, non la
 * ragione, e sovrapporli renderebbe illeggibile quale dei due ha deciso.
 *
 * @param {unknown} err l'errore risalito fino al catch di primo livello
 * @returns {boolean} true → uscire con EXIT_ROSTER_CANNOT_SERVE_PROMPT
 */
export function isPromptFloorIrreducible(err) {
  if (!err || typeof err !== 'object') return false;
  if (err.code !== 'ALL_MODELS_EXHAUSTED') return false;
  const rep = err.promptFloorReport;
  if (!rep || typeof rep !== 'object') return false;
  return isBudgetBelowScaffoldFloor(rep.budget);
}

/**
 * La riga machine-readable dell'uscita anticipata. Separata dal predicato per la
 * stessa ragione di `inputCapVetoSummary` e `quotaDeferralShare`: il numero
 * azionabile — di quanto il bersaglio manca il pavimento, e quanti tentativi
 * NON sono stati spesi — non deve dipendere da chi legge la prosa.
 */
export function promptFloorSummary(err) {
  const rep = (err && err.promptFloorReport) || {};
  const budget = Number(rep.budget) || 0;
  const attempt = Number(rep.attempt) || 0;
  const maxAttempts = Number(rep.maxAttempts) || 0;
  return {
    budget,
    floor: PROMPT_SCAFFOLD_FLOOR_TOKENS,
    short: PROMPT_SCAFFOLD_FLOOR_TOKENS - budget,
    attempt,
    maxAttempts,
    // I tentativi che il ciclo avrebbe macinato e che non spende piu'. E' la
    // metrica dell'issue: non «quante run falliscono», ma «quanto costano».
    attemptsSkipped: Math.max(0, maxAttempts - attempt),
    section: typeof rep.section === 'string' ? rep.section : '',
  };
}
