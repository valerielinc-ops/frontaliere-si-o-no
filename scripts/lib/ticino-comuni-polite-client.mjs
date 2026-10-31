/**
 * Client HTTP dei crawler comunali ticinesi: robots.txt prima di tutto.
 *
 * Tre promesse, tutte verificate da tests/ticino-comuni-family.test.ts:
 *
 *  1. Nessuna richiesta a un path che robots.txt vieta al nostro agente. Le
 *     regole si leggono a ogni run: un Comune che cambia robots.txt viene
 *     rispettato al giro dopo, senza una PR.
 *  2. Crawl-delay onorato per host. I siti su CMS ASSOLO dichiarano 30 secondi:
 *     e' un valore del gestore, non un parametro nostro. MIN_GAP_MS vale solo
 *     dove il sito non dichiara niente.
 *  3. Nessun aggiramento: niente proxy, niente UA diverso, niente secondo
 *     canale. Un 403/406/429 e' una risposta, e resta tale.
 */
import { isAllowed, robotsFromResponse } from './robots-policy.mjs';

export const TICINO_COMUNI_USER_AGENT =
  'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';
export const TICINO_COMUNI_AGENT_TOKEN = 'FrontaliereTicinoBot';
export const MIN_GAP_MS = 5_000;
export const DEFAULT_TIMEOUT_MS = 30_000;

/** Un path che robots.txt vieta: non e' un guasto, e non si riprova. */
export class RobotsDisallowedError extends Error {
  constructor(url, rule) {
    super(`robots.txt vieta ${url} (${rule})`);
    this.name = 'RobotsDisallowedError';
    this.robotsDisallowed = true;
    this.url = url;
  }
}

/** robots.txt irraggiungibile (5xx/rete): RFC 9309, vale come divieto totale. */
export class RobotsUnreachableError extends Error {
  constructor(origin) {
    super(`robots.txt irraggiungibile per ${origin}: nessuna lettura in questo giro`);
    this.name = 'RobotsUnreachableError';
    this.code = 'ECONNRESET';
  }
}

const defaultSleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * @param {{
 *   fetchImpl?: typeof fetch,
 *   sleep?: (ms: number) => Promise<void>,
 *   clock?: () => number,
 *   timeoutMs?: number,
 * }} [options]
 */
export function createPoliteClient({
  fetchImpl = fetch,
  sleep = defaultSleep,
  clock = Date.now,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const robotsByOrigin = new Map();
  const nextSlotByHost = new Map();

  async function waitForSlot(host, gapMs) {
    const nowMs = clock();
    const slot = Math.max(nextSlotByHost.get(host) ?? 0, nowMs);
    nextSlotByHost.set(host, slot + gapMs);
    if (slot > nowMs) await sleep(slot - nowMs);
  }

  async function timedFetch(url, init = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetchImpl(url, {
        redirect: 'follow',
        ...init,
        signal: controller.signal,
        headers: {
          Accept: 'text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.8',
          'User-Agent': TICINO_COMUNI_USER_AGENT,
          ...(init.headers || {}),
        },
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async function robotsFor(origin) {
    if (robotsByOrigin.has(origin)) return robotsByOrigin.get(origin);
    await waitForSlot(new URL(origin).host, MIN_GAP_MS);
    let robots;
    try {
      const response = await timedFetch(`${origin}/robots.txt`, { headers: { Accept: 'text/plain,*/*;q=0.5' } });
      robots = robotsFromResponse(response.status, await response.text());
    } catch {
      robots = robotsFromResponse(503, '');
    }
    robotsByOrigin.set(origin, robots);
    return robots;
  }

  /** Il verdetto di robots.txt per un URL, senza consumare il turno dell'host. */
  async function canFetch(url) {
    const { origin } = new URL(url);
    const robots = await robotsFor(origin);
    if (robots.state === 'unreachable') throw new RobotsUnreachableError(origin);
    return isAllowed(robots.parsed, TICINO_COMUNI_AGENT_TOKEN, url);
  }

  /** Verifica robots.txt e attende il turno dell'host: anche per il browser. */
  async function reserve(url) {
    const target = String(url);
    const verdict = await canFetch(target);
    if (!verdict.allowed) throw new RobotsDisallowedError(target, verdict.rule);
    const gapMs = Math.max(MIN_GAP_MS, (verdict.crawlDelay ?? 0) * 1000);
    await waitForSlot(new URL(target).host, gapMs);
    return gapMs;
  }

  /**
   * Stessa forma di `fetch`, cosi' si puo' passare a extractPdfJobContentFromUrl.
   * Un errore di rete si ritenta una volta sola, nel turno successivo dell'host.
   */
  async function politeFetch(url, init = {}) {
    const target = String(url);
    const gapMs = await reserve(target);
    try {
      return await timedFetch(target, init);
    } catch {
      await waitForSlot(new URL(target).host, gapMs);
      return timedFetch(target, init);
    }
  }

  return { fetch: politeFetch, canFetch, reserve };
}
