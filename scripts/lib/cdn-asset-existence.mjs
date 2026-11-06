import {
  ASSET_EXT_ALTERNATION,
  ASSETS_SAME_ORIGIN_RX,
  CDN_ASSET_ORIGIN,
} from '../../build-plugins/shared/cdnAssetOffloadRx.mjs';

/**
 * cdn-asset-existence.mjs — l'asset riscritto sul CDN esiste davvero?
 *
 * ## IL DIFETTO (issue #7366)
 *
 * `scripts/offload-generated-images-cdn.mjs` riscrive OGNI `/assets/<file>`
 * same-origin trovato nell'HTML in `${CDN_BASE}/assets/<file>`, e nessuno
 * verifica che l'oggetto esista dall'altra parte. Per le altre fasi
 * dell'offload l'esistenza e' garantita dall'ORDINE: og, data, images e
 * job-canon sono spinti sul CDN dal deploy PRIMA che lo script giri, quindi
 * riscrivere cio' che si e' appena caricato e' sicuro per costruzione.
 *
 * `/assets/` no. Quei riferimenti puntano al bundle dell'ULTIMO deploy, e la
 * catena di fast-publish (`scripts/publish-article-fast.mjs` →
 * `scripts/lib/render-and-push-hubs.mjs`) pubblica pagine SENZA ricostruire
 * `dist/assets`. Fra quei riferimenti c'e' `/assets/partnerize-tag.js`, emesso
 * dal sito (`PARTNERIZE_TAG_FILENAME` in `build-plugins/constants.ts`,
 * scritto da `build-plugins/staticScriptsPlugin.ts`): se non e' sul CDN, ogni
 * pagina pubblicata lo carica a vuoto — nessuna eccezione, nessun gate rosso,
 * zero tracking affiliato, e il 404 resta invisibile.
 *
 * ## PERCHE' NON-FATALE
 *
 * L'offload e' non-fatale per costruzione: su un guard leak, un `CDN_BASE`
 * assente o QUALSIASI errore lascia `dist` intatto ed esce 0. Non si rinuncia
 * a pubblicare un articolo perche' manca uno script di tracking. Quello che
 * mancava non era il rifiuto: era il DIRLO. Una HEAD per URL distinto — una
 * manciata per run, deduplicata sull'intero dist — trasforma un 404 silenzioso
 * in una riga `::warning::` nel log, che e' la differenza fra un difetto che si
 * scopre e uno che non si scopre.
 *
 * ## PERCHE' LO STATUS CODE NON BASTA
 *
 * Su questo dominio un path inesistente non risponde sempre 404: l'origin del
 * sito serve la SPA su qualunque path e restituisce `200` con `text/html`
 * (misurato piu' volte su questo workspace; il 2026-09-05 il solo
 * `cdn.frontaliereticino.ch` risponde 404, ma l'edge davanti puo' cambiare
 * senza che questo file lo sappia). Un controllo che si accontenta di `res.ok`
 * dichiarerebbe «presente» una pagina HTML servita al posto di un `.js`. Per
 * questo un `200` il cui `content-type` e' HTML mentre l'URL chiede uno script,
 * un foglio di stile, un font o un JSON viene classificato `missing` con
 * motivo `soft-404`: e' esattamente il caso in cui il browser caricherebbe
 * HTML dentro un `<script>` e non se ne accorgerebbe nessuno.
 *
 * Fail-open su ogni errore di rete/timeout e su ogni 5xx: un DNS che flappa non
 * deve produrre un avviso che accusa il CDN di non avere un file che ha.
 */

/**
 * Tetto sul NUMERO di URL verificati in una run. Oggi i riferimenti distinti
 * sono una manciata; il tetto non serve a limitarli, serve a pinnare il costo
 * peggiore perche' non cresca con l'HTML senza che nessuno se ne accorga.
 */
export const CDN_ASSET_CHECK_MAX_URLS = 24;

/**
 * Tetto sul TEMPO complessivo. Le HEAD sono in serie e ciascuna vale
 * `timeoutMs`: senza un budget, un CDN che pende sul timeout moltiplica il
 * ritardo per il numero di URL dentro il percorso di pubblicazione.
 */
export const CDN_ASSET_CHECK_BUDGET_MS = 30_000;

/**
 * Un 5xx dal CDN o un abort/timeout transitorio e' una risposta non conclusiva
 * dell'infrastruttura, non una prova che l'oggetto manchi. Ritenta poche volte
 * prima di lasciare il risultato `unknown`; 4xx ed errori di rete persistenti
 * non vengono trasformati in un falso `present`.
 */
export const CDN_ASSET_CHECK_MAX_ATTEMPTS = 3;
export const CDN_ASSET_CHECK_RETRY_DELAY_MS = 250;

/**
 * Extract the canonical CDN asset URLs from one rendered HTML document.
 * The extension alphabet is shared with the offload rewrite and deploy Guard B
 * so a new asset type cannot silently bypass this publish-time check.
 * @param {string} html
 * @param {string} [cdnOrigin]
 * @returns {string[]}
 */
export function extractCdnAssetUrlsFromHtml(html, cdnOrigin = CDN_ASSET_ORIGIN) {
  let origin;
  try {
    origin = new URL(cdnOrigin).origin;
  } catch {
    return [];
  }
  const escapedOrigin = origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `${escapedOrigin}/assets/([^"'\\s)?]+?\\.(?:${ASSET_EXT_ALTERNATION}))`,
    'g',
  );
  const urls = new Set();
  for (const match of String(html).matchAll(pattern)) {
    urls.add(`${origin}/assets/${match[1]}`);
  }
  return [...urls];
}

/**
 * Return surviving same-origin asset references in a rendered HTML document.
 * A shard page cannot resolve these after the deploy drops dist/assets.
 * @param {string} html
 * @returns {string[]}
 */
export function findSameOriginAssetRefs(html) {
  const pattern = new RegExp(ASSETS_SAME_ORIGIN_RX.source, 'g');
  return String(html).match(pattern) || [];
}

/** Estensioni per cui una risposta `text/html` non puo' essere l'oggetto chiesto. */
const NEVER_HTML = new RegExp(`\\.(?:${ASSET_EXT_ALTERNATION})(?:[?#]|$)`, 'i');

/**
 * Un `200` che non e' l'oggetto chiesto. Vedi «PERCHE' LO STATUS CODE NON
 * BASTA» in testa al file.
 */
export function isSoftMissing(url, contentType) {
  if (!NEVER_HTML.test(String(url))) return false;
  return /^\s*text\/html\b/i.test(String(contentType || ''));
}

/**
 * Un abort/timeout del probe puo' essere transitorio: undici usa sia
 * `AbortError` sia il messaggio "This operation was aborted" a seconda del
 * punto in cui il signal interrompe la richiesta. Per gli errori di rete si
 * ritentano solo i codici di trasporto noti come transitori; un `ENOTFOUND`
 * o un `fetch failed` senza causa leggibile non deve spendere il budget
 * intero per ripetere una diagnosi non classificabile.
 * @param {unknown} error
 * @returns {boolean}
 */
const TRANSIENT_PROBE_ERROR_CODES = new Set([
  'EAI_AGAIN',
  'ECONNRESET',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
  'ERR_SOCKET_TIMEOUT',
]);

function probeErrorCode(error) {
  return String(error?.cause?.code || error?.code || '');
}

function isRetryableProbeError(error) {
  const name = String(error?.name || '');
  const message = String(error?.message || error || '');
  return name === 'AbortError'
    || name === 'TimeoutError'
    || /(?:operation was aborted|timed out|timeout)/i.test(message)
    || TRANSIENT_PROBE_ERROR_CODES.has(probeErrorCode(error));
}

function probeErrorReason(error) {
  const message = String(error?.message || error || '');
  const code = probeErrorCode(error);
  return code && !message.includes(code) ? `${message} (${code})` : message;
}

/**
 * Verifica l'esistenza degli URL dati. Non lancia mai: ogni esito e' un record.
 *
 * @param {object} a
 * @param {string[]} a.urls URL assoluti, gia' deduplicati
 * @param {typeof fetch} [a.fetchImpl]
 * @param {number} [a.timeoutMs]
 * @param {number} [a.maxUrls]
 * @param {number} [a.budgetMs]
 * @param {number} [a.maxAttempts] tentativi per risposta HTTP 5xx o trasporto transitorio classificato
 * @param {number} [a.retryDelayMs] base del backoff esponenziale sui transienti
 * @param {() => number} [a.now] orologio iniettabile per i test
 * @returns {Promise<Array<{url: string, state: 'present'|'missing'|'unknown'|'skipped', status: number|null, reason: string|null}>>}
 */
export async function verifyCdnAssetRefs({
  urls,
  fetchImpl = fetch,
  timeoutMs = 8000,
  maxUrls = CDN_ASSET_CHECK_MAX_URLS,
  budgetMs = CDN_ASSET_CHECK_BUDGET_MS,
  maxAttempts = CDN_ASSET_CHECK_MAX_ATTEMPTS,
  retryDelayMs = CDN_ASSET_CHECK_RETRY_DELAY_MS,
  now = Date.now,
}) {
  const results = [];
  const startedAt = now();
  let checked = 0;
  const attemptsLimit = Number.isFinite(maxAttempts) ? Math.max(1, Math.floor(maxAttempts)) : 1;
  const retryDelayBaseMs = Number.isFinite(retryDelayMs) ? Math.max(0, retryDelayMs) : 0;

  for (const url of urls) {
    if (checked >= maxUrls) {
      results.push({ url, state: 'skipped', status: null, reason: `tetto di ${maxUrls} URL raggiunto` });
      continue;
    }
    const elapsed = now() - startedAt;
    if (elapsed >= budgetMs) {
      results.push({ url, state: 'skipped', status: null, reason: `budget di ${budgetMs}ms esaurito (${elapsed}ms)` });
      continue;
    }
    checked += 1;

    /**
     * A fetch timeout alone is not a run budget: a HEAD that reaches its
     * timeout can still be followed by a full GET fallback. Arm one
     * AbortController with the smaller of the per-request timeout and the
     * remaining run budget, and recompute that residual before a fallback.
     * The first residual is passed in because `now` is injectable and a test
     * clock may advance on every read.
     */
    const fetchWithinBudget = async (method, initialRemainingMs = null) => {
      const remainingMs = initialRemainingMs ?? (budgetMs - (now() - startedAt));
      if (remainingMs <= 0) return { budget: true };

      const controller = new AbortController();
      const deadlineMs = Math.max(1, Math.min(timeoutMs, remainingMs));
      const timer = setTimeout(() => controller.abort(), deadlineMs);
      try {
        return {
          response: await fetchImpl(url, { method, redirect: 'follow', signal: controller.signal }),
        };
      } catch (error) {
        return { error };
      } finally {
        clearTimeout(timer);
      }
    };

    try {
      let res = null;
      let budgetSkipped = false;
      let budgetReason = null;
      const waitForRetry = async (attemptNumber) => {
        const remainingMs = budgetMs - (now() - startedAt);
        const backoffMs = Math.min(retryDelayBaseMs * (2 ** (attemptNumber - 1)), remainingMs);
        if (remainingMs <= 0 || backoffMs >= remainingMs) return false;
        if (backoffMs > 0) await new Promise((resolve) => setTimeout(resolve, backoffMs));
        return true;
      };
      for (let attemptNumber = 1; attemptNumber <= attemptsLimit; attemptNumber += 1) {
        let attempt = await fetchWithinBudget('HEAD', attemptNumber === 1 ? budgetMs - elapsed : null);
        if (attempt.budget) {
          budgetSkipped = true;
          budgetReason = attemptNumber === 1
            ? `budget di ${budgetMs}ms esaurito prima della richiesta`
            : `budget di ${budgetMs}ms esaurito prima della richiesta di retry`;
          break;
        }
        if (attempt.error) {
          if (attemptNumber >= attemptsLimit
            || !isRetryableProbeError(attempt.error)
            || !await waitForRetry(attemptNumber)) {
            throw attempt.error;
          }
          continue;
        }
        res = attempt.response;
        // Alcune origin non implementano HEAD (405/501): la domanda e'
        // sull'esistenza dell'oggetto, non sul metodo, quindi si ripiega su GET
        // invece di registrare un falso `missing`.
        if (res.status === 405 || res.status === 501) {
          attempt = await fetchWithinBudget('GET');
          if (attempt.budget) {
            budgetSkipped = true;
            budgetReason = `budget di ${budgetMs}ms esaurito prima del GET di fallback`;
            break;
          }
          if (attempt.error) {
            if (attemptNumber >= attemptsLimit
              || !isRetryableProbeError(attempt.error)
              || !await waitForRetry(attemptNumber)) {
              throw attempt.error;
            }
            continue;
          }
          res = attempt.response;
        }

        // A 5xx dice che il CDN non ha servito la richiesta, non che l'asset
        // sia assente. Una nuova richiesta idempotente puo' recuperare un
        // errore edge transitorio, ma il budget resta il limite assoluto e il
        // risultato finale continua a essere `unknown` se il problema persiste.
        if (res.status < 500 || res.status > 599 || attemptNumber >= attemptsLimit) break;
        if (!await waitForRetry(attemptNumber)) break;
      }
      if (budgetSkipped) {
        results.push({
          url,
          state: 'skipped',
          status: null,
          reason: budgetReason || `budget di ${budgetMs}ms esaurito prima della richiesta`,
        });
        continue;
      }
      const contentType = res.headers?.get ? res.headers.get('content-type') : null;
      if (res.ok && isSoftMissing(url, contentType)) {
        results.push({ url, state: 'missing', status: res.status, reason: `soft-404: ${contentType}` });
      } else if (res.ok) {
        results.push({ url, state: 'present', status: res.status, reason: null });
      } else if (res.status >= 400 && res.status < 500) {
        // 4xx e' una risposta del CDN sull'oggetto: l'oggetto non c'e'.
        results.push({ url, state: 'missing', status: res.status, reason: null });
      } else {
        // 5xx: il CDN non sta rispondendo sull'oggetto, sta rispondendo su se
        // stesso. Non e' una prova di assenza.
        results.push({ url, state: 'unknown', status: res.status, reason: null });
      }
    } catch (err) {
      results.push({ url, state: 'unknown', status: null, reason: probeErrorReason(err) });
    }
  }

  return results;
}

/**
 * Fail closed when a page is about to become live but one of its CDN asset
 * references is missing, unverified, or skipped by the bounded checker.
 *
 * The existing offload path intentionally remains fail-open for diagnostics.
 * Shard publication has the opposite safety contract: publishing HTML that
 * points at no bytes is irreversible until the next deploy, so every state
 * other than `present` must stop the mutation.
 *
 * @param {object} options
 * @returns {Promise<Array<{url: string, state: string, status: number|null, reason: string|null}>>}
 */
export async function assertCdnAssetRefsLive(options) {
  const results = await verifyCdnAssetRefs(options);
  const notLive = results.filter((result) => result.state !== 'present');
  if (notLive.length > 0) {
    const error = new Error(
      `${notLive.length} CDN asset reference(s) are not proven live; refusing shard publication`,
    );
    error.results = results;
    throw error;
  }
  return results;
}

/**
 * Le righe di log del verdetto. `::warning::` solo sui `missing`: e' il solo
 * stato che dice qualcosa sul CDN e non sulla rete.
 */
export function formatCdnAssetReport(results, prefix = '[cdn-asset-check]') {
  const lines = [];
  const missing = results.filter((r) => r.state === 'missing');
  const unknown = results.filter((r) => r.state === 'unknown');
  const skipped = results.filter((r) => r.state === 'skipped');

  for (const r of missing) {
    lines.push(
      `::warning::${prefix} ${r.url} risponde ${r.status}${r.reason ? ` (${r.reason})` : ''}: il riferimento e' stato `
      + "riscritto sul CDN ma l'oggetto non c'e'. Ogni pagina pubblicata da questa run lo carichera' a vuoto "
      + "(se e' partnerize-tag.js: zero tracking affiliato) finche' il sito non lo ripubblica.",
    );
  }
  if (unknown.length) {
    lines.push(
      `${prefix} ${unknown.length} URL non verificabili (rete/timeout/5xx, fail-open): `
      + unknown.map((r) => `${r.url} (${r.status ?? r.reason})`).join(', '),
    );
  }
  if (skipped.length) {
    lines.push(
      `${prefix} verifica fermata al tetto: ${skipped.length} URL NON guardati (${skipped[0].reason}). `
      + 'Non sono «presenti»: sono ignoti.',
    );
  }
  lines.push(
    `${prefix} ${results.length - skipped.length} asset CDN distinti verificati ; `
    + `${results.filter((r) => r.state === 'present').length} presenti ; ${missing.length} mancanti ; `
    + `${unknown.length} non verificabili`
    + (skipped.length ? ` ; ${skipped.length} non guardati (tetto)` : ''),
  );
  return lines;
}

/**
 * L'HTML pubblicato contiene ancora un riferimento `/assets/` SAME-ORIGIN?
 *
 * E' la discriminante fra «offload fallito» e «niente da riscrivere», che nel
 * log si presentavano identiche: l'offload e' non-fatale e su un errore lascia
 * `dist` intatto uscendo 0, quindi il caso rotto NON produce URL CDN — come il
 * caso sano in cui non c'era nulla da riscrivere.
 */
export function formatOffloadCoverageReport({ cdnRefCount, sameOriginFiles, prefix = '[cdn-asset-check]' }) {
  const stragglers = sameOriginFiles || [];
  if (stragglers.length) {
    const sample = stragglers.slice(0, 5).join(', ');
    const more = stragglers.length > 5 ? ` (+${stragglers.length - 5} altri)` : '';
    return [
      `::warning::${prefix} ${stragglers.length} file HTML hanno ancora riferimenti /assets/ SAME-ORIGIN dopo `
      + `l'offload: ${sample}${more}. Il deploy tiene dist/assets in questo caso, ma se la riscrittura doveva `
      + "avvenire e non e' avvenuta questo e' l'unico segnale: l'offload esce 0 anche quando fallisce.",
    ];
  }
  if (!cdnRefCount) {
    return [`${prefix} nessun riferimento /assets/ trovato, ne' same-origin ne' CDN: non c'era niente da riscrivere.`];
  }
  return [];
}
