import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  exchangeAssertionForToken,
  TOKEN_EXCHANGE_TIMEOUT_MS,
  GOOGLE_TOKEN_URL,
} from '../scripts/lib/google-service-account-token.mjs';
import { RC_FETCH_ATTEMPTS, RC_FETCH_TIMEOUT_MS, isRetryableRcFetchStatus, rcFetchBackoffMs } from '../scripts/load-rc-env.mjs';

/**
 * Lo scambio OAuth e' il primo anello della catena delle credenziali di
 * ENTRAMBI i cicli: `load-rc-env.mjs` lo chiama nel percorso REST (quello senza
 * `firebase-admin`, cioe' quello del fast-publish e di ogni worktree senza
 * `npm ci`), e da li' scendono i ~90 parametri di Remote Config.
 *
 * PERCHE' QUESTO TEST ESISTE QUI. `scripts/lib/google-service-account-token.mjs`
 * e' `mode: identical` in `scripts/ci/loop-sync-manifest.json` (sotto
 * `generator/scripts/lib/`), quindi la sorgente di verita' e' questo repo. Il
 * retry e il timeout erano stati scritti sul CORPUS (#173/#199/#200/#264) su un
 * file dichiarato uguale ai due lati: al mirror successivo la copia del sito li
 * avrebbe cancellati, e questo lato sarebbe tornato senza nessuno dei due.
 * Nessuno dei due repo aveva un test.
 *
 * Le due proprieta' fissate sono quelle che il difetto originale non aveva:
 *  - un 429/5xx non e' terminale (#45/#54/#171/#263: tre "Agent loop down:
 *    GITHUB_PAT failed to load" che erano un solo 429 non ritentato);
 *  - ogni tentativo ha un tetto di clock (#199): senza `signal`, un endpoint
 *    lento-ma-mai-in-errore appende la `fetch` per sempre e il cap sui
 *    tentativi non arriva mai a scattare — un retry senza timeout non e' un
 *    retry, e' un modo diverso di appendersi.
 */

const OK = { access_token: 'ya29.test' };

const okResponse = () => ({ ok: true, status: 200, json: async () => OK });
const errResponse = (status: number) => ({ ok: false, status, text: async () => `boom ${status}` });

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/**
 * Timer VERI, non finti. Il backoff del primo tentativo e' 1s: un fake timer
 * qui costringerebbe ogni test a pilotare a mano l'`await` dentro il loop di
 * retry — cioe' a riscrivere il controllo di flusso che sta verificando, che e'
 * il modo classico di ottenere un test che passa anche col loop rotto. Due
 * secondi in tutta la suite sono un prezzo onesto per esercitarlo davvero.
 */
describe('exchangeAssertionForToken: 429/5xx ritentati, 4xx no', () => {
  it('un 429 seguito da un 200 restituisce il token invece di lanciare', async () => {
    // Il caso misurato di #45/#54/#171: un solo 429 non ritentato che si
    // presentava come "credenziale rotta" e fermava l'intero ciclo agentico.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(errResponse(429))
      .mockResolvedValueOnce(okResponse());
    vi.stubGlobal('fetch', fetchMock);
    await expect(exchangeAssertionForToken('jwt')).resolves.toBe('ya29.test');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('un 503 seguito da un 200 idem — 5xx e\' transient come 429', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(errResponse(503))
      .mockResolvedValueOnce(okResponse());
    vi.stubGlobal('fetch', fetchMock);
    await expect(exchangeAssertionForToken('jwt')).resolves.toBe('ya29.test');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('un 401 lancia SUBITO: un JWT sbagliato non si risolve ritentando', async () => {
    // Il rovescio, e vale quanto il retry: ritentare sette volte un 401 brucia
    // ~63s di budget per arrivare allo stesso errore, e maschera la diagnosi.
    const fetchMock = vi.fn().mockResolvedValue(errResponse(401));
    vi.stubGlobal('fetch', fetchMock);

    await expect(exchangeAssertionForToken('jwt')).rejects.toThrow(/401/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('ogni tentativo porta un AbortSignal: senza, il cap sui tentativi non scatta mai', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal('fetch', fetchMock);

    await exchangeAssertionForToken('jwt');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(GOOGLE_TOKEN_URL);
    expect(init.signal, 'la fetch dello scambio OAuth deve avere un timeout di clock').toBeInstanceOf(AbortSignal);
    expect(TOKEN_EXCHANGE_TIMEOUT_MS).toBe(30_000);
  });

  it('un 200 senza access_token e\' un errore, non un token vuoto', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) }));
    await expect(exchangeAssertionForToken('jwt')).rejects.toThrow(/missing access_token/);
  });

  it('un AbortError (timeout scattato) viene ritentato come un 429/5xx, non propagato subito', async () => {
    // Il difetto che questo test pinna: `AbortSignal.timeout()` fa RIGETTARE la
    // fetch (non risolvere con uno status), quindi senza un try/catch attorno
    // alla fetch il branch `res.status` non viene mai raggiunto e l'AbortError
    // esce dal loop al primo tentativo — vanificando l'intero budget di 7
    // tentativi/~63s che questo loop esiste per fornire.
    const abortErr = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
    const fetchMock = vi.fn().mockRejectedValueOnce(abortErr).mockResolvedValueOnce(okResponse());
    vi.stubGlobal('fetch', fetchMock);
    await expect(exchangeAssertionForToken('jwt')).resolves.toBe('ya29.test');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('un errore non-abort (es. DNS/TLS) lancia subito, senza consumare il budget di retry', async () => {
    const dnsErr = Object.assign(new Error('getaddrinfo ENOTFOUND oauth2.googleapis.com'), { name: 'TypeError' });
    const fetchMock = vi.fn().mockRejectedValue(dnsErr);
    vi.stubGlobal('fetch', fetchMock);
    await expect(exchangeAssertionForToken('jwt')).rejects.toThrow(/ENOTFOUND/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('load-rc-env: il salto a valle ha lo stesso budget del salto a monte', () => {
  it('7 tentativi ≈ 63s di backoff — abbastanza da entrare nella finestra di quota successiva', () => {
    // #263: la quota "Read requests per minute" di firebaseremoteconfig si
    // azzera una volta al minuto. Con 4 tentativi (~7s) ogni retry atterrava
    // dentro la stessa finestra gia' spesa, quindi il retry non poteva
    // funzionare per costruzione, non per sfortuna.
    expect(RC_FETCH_ATTEMPTS).toBe(7);
    const total = Array.from({ length: RC_FETCH_ATTEMPTS - 1 }, (_, i) => rcFetchBackoffMs(i + 1)).reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(60_000);
  });

  it('la classificazione dello status e\' la stessa dei due lati della catena', () => {
    expect(isRetryableRcFetchStatus(429)).toBe(true);
    expect(isRetryableRcFetchStatus(500)).toBe(true);
    expect(isRetryableRcFetchStatus(503)).toBe(true);
    expect(isRetryableRcFetchStatus(401)).toBe(false);
    expect(isRetryableRcFetchStatus(404)).toBe(false);
  });

  it('stesso tetto di clock del salto OAuth: un solo numero, non due', () => {
    expect(RC_FETCH_TIMEOUT_MS).toBe(TOKEN_EXCHANGE_TIMEOUT_MS);
  });
});
