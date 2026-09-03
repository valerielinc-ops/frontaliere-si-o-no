/**
 * claude-rate-limit.mjs — single source of truth per riconoscere una run Claude
 * morta su QUOTA (HTTP 429 / weekly limit) e per propagare la finestra di reset.
 *
 * ## Perché esiste (misurato 2026-08-05, finestra 7gg 2026-07-29 → 2026-08-05)
 *
 * `issue-fix.yml` risultava al 52% di failure-rate (61 fail su 117 run reali) e
 * l'allarme era acceso nel tracker #1951 da ≥7 report settimanali consecutivi.
 * Scaricando i log di TUTTE e 61 le run fallite, la classificazione per causa è
 * risultata degenere:
 *
 *   60/61  → `terminal_reason: "api_error"`, `api_error_status: 429`,
 *            `rateLimitType: "seven_day"`, `num_turns: 1`, `total_cost_usd: 0`
 *    1/61  → `api_error_status: 529` (overloaded, transiente)
 *    0/61  → `error_max_turns`
 *    0/61  → push/PR/sibling-gate falliti
 *    0/61  → timeout dei 360 minuti
 *
 * Cioè: **Claude non ha mai eseguito**. Zero turni, zero token, zero costo. Non
 * è il fixer che fallisce a fixare — è la quota Max condivisa esaurita.
 *
 * ## Il difetto strutturale: 429 indistinguibile da «run morta»
 *
 * Il payload di un 429 ha `"subtype": "success"` con `"is_error": true`. Lo step
 * `Mark error_max_turns` di issue-fix.yml è gated sul subtype `error_max_turns`,
 * quindi NON scatta; il backstop deterministico posta allora un generico
 * `no-pr-unspecified` che `followup-drainer.mjs` **ignora di proposito**
 * (BACKSTOP_MARKER) per non confondere un crash con un verdetto. Risultato:
 * `latestFixOutcome()` ritorna `null` → il rescue classifica la issue come
 * «run davvero morta, nessun verdetto» → ri-tentabile.
 *
 * Da lì la catena assorbente, verificata sulle issue reali:
 *
 *   429 (Claude non gira)
 *     → nessun marker granulare → outcome null
 *     → RE-QUEUE con `fu-attempt`++ → ri-promossa mentre la quota è ANCORA esaurita
 *     → altri due 429 identici
 *     → `fu-attempt:3` → `fu-parked` (fuori dalla coda attiva)
 *     → parked + inattiva ≥7gg + vecchia ≥10gg → AGE-OUT close «not planned»
 *
 * Una issue perfettamente fixabile viene quindi parcheggiata e infine chiusa in
 * automatico **senza che nessun agent l'abbia mai letta**. Osservato su #5008,
 * #5004, #5001, #4974 (tutte `fu-parked` + `fu-attempt:3`, tutte con 3 run da
 * $0 e 1 turno). È l'equivalente lato fixer dello stato assorbente del grafo di
 * recupero PR fixato in #5099.
 *
 * ## L'amplificazione
 *
 * `issue-fix` è serializzato (`concurrency: issue-fix`) e `followup-drainer.yml`
 * gira su `workflow_run` a ogni fine run: appena una run muore di 429 il drainer
 * promuove la successiva, che sbatte sulla stessa quota esaurita, ~5 minuti per
 * giro. Il 2026-07-31 questo ha prodotto 27 run reali e 27 fallimenti (100%).
 * Sui 61 fallimenti totali, **49 (80%) sono avvenuti dentro una finestra di
 * rate-limit già aperta da un fallimento precedente** — cioè erano prevedibili
 * in modo deterministico e completamente evitabili.
 *
 * ## Cosa fa questo modulo
 *
 * Espone il riconoscimento del 429 e il formato del beacon di backoff, così che
 * la regex NON venga duplicata letteralmente fra workflow (AGENTS.md #6). Il
 * dato chiave è `resetsAt`: il payload del rate-limit porta l'epoch esatto in
 * cui la quota torna disponibile, quindi il backoff non è un'euristica a tempo
 * ma una scadenza dichiarata dal server.
 *
 * NB: `pr-review-loop.yml` gestiva già il 429 dal suo lato (exit 0 con warning,
 * per non innescare re-run amplificanti) con una grep inline in bash; non è
 * stato consolidato qui perché toccare quel file impone il vincolo di
 * byte-identità con `main` del reviewer (AGENTS.md → workflow-validation drift)
 * senza alcun guadagno di comportamento. Vedi `## Non implementato` della PR.
 */

/** Codice FIX_OUTCOME granulare per una run che non è mai partita per quota. */
export const RATE_LIMITED_OUTCOME = 'rate-limited';

/**
 * Beacon della finestra di quota. Deliberatamente un commento HTML SEPARATO dal
 * marker `<!-- FIX_OUTCOME: ... -->`: quest'ultimo è parsato con
 * `FIX_OUTCOME_RE` (definita in `close-recovered-failure-issues.mjs`, importata
 * da `followup-drainer.mjs` e dagli altri consumer), che
 * non ammette attributi extra dentro lo stesso commento. Tenerli separati evita
 * di dover toccare quella regex (e di romperla per tutti gli altri codici).
 */
export const QUOTA_RESETS_RE = /<!--\s*QUOTA_RESETS_AT:\s*(\d{9,13})\s*-->/i;

/**
 * Parsa l'execution file della claude-code-action, che può essere un array JSON
 * oppure ndjson (una riga per messaggio) a seconda della versione. Totale: non
 * lancia mai, ritorna [] su input illeggibile.
 * @param {string} raw
 * @returns {Array<Record<string, unknown>>}
 */
export function parseExecutionMessages(raw) {
  const text = String(raw || '').trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    // ndjson
  }
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      // riga parziale/troncata → ignora, non invalidare l'intero file
    }
  }
  return out;
}

/**
 * Riconosce una run Claude terminata perché la quota è esaurita (429).
 *
 * Tre segnali indipendenti, in OR — la action ha cambiato forma del payload nel
 * tempo e un solo segnale è fragile:
 *  1. un messaggio `type: "rate_limit_event"` con `rate_limit_info.status`
 *     `rejected` (porta anche `resetsAt`, il dato che ci serve davvero);
 *  2. il messaggio `type: "result"` con `is_error: true` e
 *     `api_error_status: 429`;
 *  3. un messaggio con `error: "rate_limit"` (forma sintetica dell'assistant).
 *
 * NON considera 5xx: un `529 overloaded` è transiente e va ri-tentato subito,
 * comportamento opposto al backoff lungo del 429. Restano quindi failure rosse
 * ri-tentabili, invariate.
 *
 * @param {string} raw contenuto dell'execution file
 * @returns {{ rateLimited: boolean, resetsAt: number|null, rateLimitType: string|null }}
 */
export function detectClaudeRateLimit(raw) {
  const msgs = parseExecutionMessages(raw);
  let rateLimited = false;
  let resetsAt = null;
  let rateLimitType = null;

  for (const m of msgs) {
    if (!m || typeof m !== 'object') continue;

    if (m.type === 'rate_limit_event' && m.rate_limit_info && typeof m.rate_limit_info === 'object') {
      const info = /** @type {Record<string, unknown>} */ (m.rate_limit_info);
      // `status` descrive la richiesta corrente; `overageStatus` dice soltanto
      // se sarebbe possibile comprare capacità extra. Una run autorizzata può
      // quindi avere status=allowed e overageStatus=rejected e proseguire fino
      // a un result success: non è un 429 terminale.
      if (info.status === 'rejected') {
        rateLimited = true;
        const r = Number(info.resetsAt);
        // Il payload usa epoch in SECONDI; accetta anche millisecondi per
        // robustezza se la action dovesse cambiarne l'unità.
        if (Number.isFinite(r) && r > 0) resetsAt = r > 1e11 ? Math.round(r / 1000) : Math.round(r);
        if (typeof info.rateLimitType === 'string') rateLimitType = info.rateLimitType;
      }
      continue;
    }

    if (m.type === 'result' && m.is_error === true && Number(m.api_error_status) === 429) {
      rateLimited = true;
      continue;
    }

    if (m.error === 'rate_limit') rateLimited = true;
  }

  return { rateLimited, resetsAt, rateLimitType };
}

/**
 * Estrae l'epoch di reset da un corpo commento (beacon di backoff), o null.
 * @param {string} body
 * @returns {number|null}
 */
export function parseQuotaResetsAt(body) {
  const m = QUOTA_RESETS_RE.exec(String(body || ''));
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n > 1e11 ? Math.round(n / 1000) : Math.round(n);
}

/**
 * L'epoch di reset più LONTANO fra i beacon presenti in una lista di commenti,
 * o null. Il più lontano e non il più recente: se una issue ha accumulato più
 * beacon (finestre successive), quella che conta per il backoff è l'ultima a
 * chiudersi — riaprire il drain prima del reset reale riprodurrebbe esattamente
 * la cascata che il backoff esiste per fermare.
 *
 * Unico punto di verità: la usano sia il pre-flight `check-quota-backoff.mjs`
 * sia `followup-drainer.mjs`. Duplicarla in due file la farebbe divergere alla
 * prima modifica (AGENTS.md #6). Pura → testabile.
 *
 * @param {Array<{body?: string}>} comments
 * @returns {number|null}
 */
export function maxQuotaResetsAt(comments) {
  let best = null;
  for (const c of comments || []) {
    const r = parseQuotaResetsAt(c?.body || '');
    if (r !== null && (best === null || r > best)) best = r;
  }
  return best;
}

/**
 * Il backoff è ancora attivo? `resetsAt` null/illeggibile → false (bias a
 * PROCEDERE: un beacon malformato non deve mai congelare la coda per sempre).
 *
 * `maxAheadSec` è un tetto di sanità: un `resetsAt` assurdamente lontano
 * (bug/payload corrotto) non deve poter bloccare il loop per settimane. Il
 * limite più lungo che l'API dichiara è `seven_day`, quindi 8 giorni copre il
 * caso peggiore legittimo con margine.
 *
 * @param {number|null} resetsAt epoch in secondi
 * @param {number} [nowSec] epoch corrente in secondi
 * @param {number} [maxAheadSec]
 */
export function isBackoffActive(resetsAt, nowSec = Math.floor(Date.now() / 1000), maxAheadSec = 8 * 86_400) {
  if (!Number.isFinite(resetsAt) || resetsAt === null || resetsAt <= 0) return false;
  if (resetsAt <= nowSec) return false;
  if (resetsAt - nowSec > maxAheadSec) return false;
  return true;
}

/**
 * Corpo del commento che il fixer posta su una issue quando la run muore di
 * quota. Contiene ENTRAMBI i marker: quello granulare letto dal drainer per
 * decidere il recupero, e il beacon con la scadenza letto dal pre-flight per il
 * backoff globale.
 * @param {{ resetsAt: number|null, rateLimitType?: string|null, runUrl?: string, workflow?: string }} opts
 */
export function formatRateLimitComment({ resetsAt, rateLimitType = null, runUrl = '', workflow = 'issue-fix' }) {
  const when = Number.isFinite(resetsAt) && resetsAt
    ? new Date(resetsAt * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
    : 'sconosciuta';
  const kind = rateLimitType ? ` (\`${rateLimitType}\`)` : '';
  const link = runUrl ? `\n\nRun: ${runUrl}` : '';
  return [
    `<!-- FIX_OUTCOME: ${RATE_LIMITED_OUTCOME} -->`,
    resetsAt ? `<!-- QUOTA_RESETS_AT: ${resetsAt} -->` : '',
    '',
    `⏳ **Quota Claude esaurita${kind}** — \`${workflow}\` è uscito su HTTP 429 al primo turno:`,
    'l\'agent **non ha letto questa issue** e non ha speso token (0 turni, $0).',
    '',
    `La quota torna disponibile alle **${when}**. Questa issue **non consuma un tentativo**`,
    '(`fu-attempt` invariato) e rientra in coda automaticamente: il drainer sospende le',
    'promozioni finché la finestra è aperta, così non si bruciano run identiche a vuoto.',
    link,
  ].filter((l) => l !== null).join('\n');
}
