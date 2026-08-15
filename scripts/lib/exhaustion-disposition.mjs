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
 * @param {unknown} err l'errore risalito fino al catch di primo livello
 * @returns {boolean} true → uscire con EXIT_ROSTER_CANNOT_SERVE_PROMPT
 */
export function isInputCapDeferralVeto(err) {
  if (!err || typeof err !== 'object') return false;
  if (err.code !== 'ALL_MODELS_EXHAUSTED') return false;
  const cap = err.inputCapReport;
  if (!cap || typeof cap !== 'object') return false;
  if (!(Number(cap.count) > 0)) return false;
  const breakdown = err.exhaustionBreakdown || {};
  const transient = Number(breakdown.transient) || 0;
  const persistent = Number(breakdown.persistent) || 0;
  // Il pareggio passa al PERSISTENTE: `>` e non `>=` — esattamente il confronto
  // di classifyExhaustionCause, invertito sul solo caso di parita'.
  return !(transient > persistent);
}

/**
 * La riga che dice al chiamante DI QUANTO tagliare. Separata dal predicato
 * perche' il numero e' l'unica cosa azionabile e non deve dipendere dal fatto
 * che qualcuno legga il messaggio lungo.
 */
export function inputCapVetoSummary(err) {
  const cap = (err && err.inputCapReport) || {};
  const est = Number(cap.estimatedRequestTokens) || 0;
  const best = Number(cap.maxSkippedReqLimit) || 0;
  return {
    estimatedRequestTokens: est,
    maxSkippedReqLimit: best,
    over: est - best,
    refusals: Number(cap.count) || 0,
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
export function isLegitimateQuotaDeferral(err) {
  if (!err || typeof err !== 'object') return false;
  if (err.code !== 'ALL_MODELS_EXHAUSTED') return false;
  const breakdown = err.exhaustionBreakdown || {};
  const transient = Number(breakdown.transient) || 0;
  const total = Number(breakdown.total) || 0;
  // Senza denominatore non si puo' affermare niente, e l'affermazione non
  // dimostrata qui vale «rosso»: e' la direzione in cui l'errore costa meno.
  if (total <= 0) return false;
  return transient / total > QUOTA_DEFERRAL_MIN_TRANSIENT_SHARE;
}

/**
 * La riga machine-readable che spiega PERCHE' un differimento e' stato rifiutato.
 * Separata dal predicato per la stessa ragione di `inputCapVetoSummary`: il
 * numero azionabile non deve dipendere da chi legge la prosa.
 */
export function quotaDeferralShare(err) {
  const breakdown = (err && err.exhaustionBreakdown) || {};
  const transient = Number(breakdown.transient) || 0;
  const persistent = Number(breakdown.persistent) || 0;
  const total = Number(breakdown.total) || 0;
  return {
    transient,
    persistent,
    ambiguous: Math.max(0, total - transient - persistent),
    total,
    share: total > 0 ? transient / total : 0,
    required: QUOTA_DEFERRAL_MIN_TRANSIENT_SHARE,
  };
}
