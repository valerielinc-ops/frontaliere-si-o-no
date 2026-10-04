/**
 * followup-mint-admission.mjs — osservazione al CONIO del referente di un item.
 *
 * Il gate sul conio (`gate-minted-followups.mjs`) controlla la FORMA
 * dell'accettazione (`hasFalsifiableAcceptance()`), non il suo referente: un
 * item il cui token di accettazione e' GIA' vero su `main` quando nasce passa,
 * e il reconciler lo marca `done` alla prima passata senza nessuna PR.
 * Misurato sul bucket 10677: 57 item su 60 avevano il token gia' vero al commit
 * precedente al conio. Il ramo scheda rifiuta gia' la metrica al bersaglio
 * (`metricAlreadyGreen`); questo modulo e' il controllo simmetrico per il ramo
 * token, con LO STESSO oracolo della chiusura (`detectAlreadyResolved`).
 *
 * MISURA, NON DEMOZIONE. Con quasi tutto il conio nato soddisfatto, demotare
 * oggi toglierebbe dal tracciamento quasi tutto; e in questo gate scartare a
 * torto costa piu' che ammettere a torto. `mintAdmission()` quindi ammette
 * sempre (`DEMOTE_BORN_SATISFIED = false`) e riporta cosa ha osservato; il
 * chiamante conta e marca. L'interruttore si gira quando il prompt del triage
 * smette di derivare token gia' veri e il contatore scende.
 *
 * PORTABILE. Il modulo viene copiato byte per byte nel corpus: importa solo
 * `../followup-resolution-match.mjs`, che esiste allo stesso path nei due
 * repository con gli stessi export usati qui. Cio' che diverge si inietta
 * (`options.detect`, l'`io`, il runner `gh`). Nessuna I/O diretta: niente
 * `fs`, niente `child_process`.
 */
import {
  ACCEPTANCE_CONDITION,
  COMMAND_CONDITION,
  detectAlreadyResolved,
  normalizeAcceptanceToken,
} from '../followup-resolution-match.mjs';

/** Interruttore della demozione degli item nati soddisfatti. Spento: solo misura. */
export const DEMOTE_BORN_SATISFIED = false;

/** Codici delle osservazioni, insieme chiuso. */
export const MINT_OBSERVATIONS = Object.freeze({
  bornSatisfied: 'acceptance-already-true',
  declaration: 'token-is-declaration',
  unknown: 'admission-unknown',
});

/** Tetto di default delle letture di file per run (API contents). */
export const DEFAULT_ADMISSION_READ_CAP = 200;

function normalizeRepoPath(value) {
  return String(value ?? '').trim()
    .replace(/^`+|`+$/gu, '')
    .replace(/:L?\d+(?:-L?\d+)?$/u, '')
    .replace(/^\.\//u, '');
}

/**
 * Item ammesso SOLO dalla scheda `COMANDO`: non ha un token prescritto, quindi
 * i controlli sul token non lo riguardano.
 */
export function isSchedaOnlyItem(item) {
  const text = String(item?.text ?? '');
  return COMMAND_CONDITION.holds(text) && !ACCEPTANCE_CONDITION.holds(text);
}

/** Il token di accettazione esplicito dell'item, normalizzato, o stringa vuota. */
function acceptanceTokenOf(item) {
  return normalizeAcceptanceToken(item?.acceptanceToken);
}

/**
 * Stato di un path secondo l'`io`: `present`, `missing` o `unknown`.
 * Un `io` con `status(path)` (come `contentsApiIo`) lo dice da se'; un `io`
 * minimale (`fileExists`/`readFile`, disco o finto) e' noto per costruzione,
 * e una sua eccezione vale `unknown`.
 */
function pathStatus(io, path) {
  try {
    if (typeof io?.status === 'function') {
      const status = io.status(path);
      return status === 'present' || status === 'missing' ? status : 'unknown';
    }
    if (typeof io?.fileExists === 'function') return io.fileExists(path) ? 'present' : 'missing';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Avvolge l'`io` per l'oracolo di chiusura registrando i path che non si sono
 * potuti leggere: `detectAlreadyResolved` inghiotte ogni errore e risponde
 * `resolved=false`, che qui sarebbe un «no» inventato.
 */
function trackingIo(io) {
  const unknown = new Set();
  const read = (path) => {
    const status = pathStatus(io, path);
    if (status === 'unknown') unknown.add(path);
    if (status !== 'present') return null;
    try {
      const content = io.readFile(path);
      if (typeof content === 'string') return content;
    } catch {
      // ricade su unknown
    }
    unknown.add(path);
    return null;
  };
  return {
    unknown,
    read,
    io: {
      fileExists: (path) => {
        const status = pathStatus(io, path);
        if (status === 'unknown') unknown.add(path);
        return status === 'present';
      },
      readFile: read,
    },
  };
}

/**
 * Il token di accettazione dell'item e' GIA' vero oggi? Stesso oracolo della
 * chiusura (`detectAlreadyResolved(item.text, io, { acceptanceToken })`),
 * simmetrico di `metricAlreadyGreen` sul ramo scheda.
 *
 * @param {{text?: string, acceptanceToken?: string}} item item di `parseFollowupItems`
 * @param {{fileExists?: Function, readFile?: Function, status?: Function}} io
 * @param {{detect?: Function}} [options] `detect` iniettabile (adattatore del corpus)
 * @returns {true|false|'unknown'} `unknown` quando un file citato non si e' potuto leggere
 */
export function acceptanceAlreadySatisfied(item, io, { detect = detectAlreadyResolved } = {}) {
  const tracked = trackingIo(io);
  let result;
  try {
    result = detect(String(item?.text ?? ''), tracked.io, { acceptanceToken: acceptanceTokenOf(item) });
  } catch {
    return 'unknown';
  }
  if (result?.resolved === true) return true;
  return tracked.unknown.size ? 'unknown' : false;
}

const EMPTY_CALL_RE = /^([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\(\)$/u;

function escapedRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/**
 * Il token e' `nome()` e nel `Target file` `nome` compare solo in
 * dichiarazione: l'oracolo di chiusura non lo riconoscera' finche' nessuno lo
 * chiama. E' un'OSSERVAZIONE, non un motivo di rifiuto: una fix che aggiunge
 * la chiamata lo fa combaciare.
 *
 * «Solo in dichiarazione» e' letto contro l'oracolo stesso: il file contiene
 * una forma di dichiarazione di `nome` E `acceptanceAlreadySatisfied` risponde
 * `false`. Le due osservazioni sono quindi disgiunte per costruzione.
 *
 * @returns {true|false|'unknown'}
 */
export function acceptanceIsDeclaration(item, io, options = {}) {
  const call = EMPTY_CALL_RE.exec(acceptanceTokenOf(item));
  const target = normalizeRepoPath(item?.targetFile);
  if (!call || !target) return false;
  const tracked = trackingIo(io);
  const content = tracked.read(target);
  if (typeof content !== 'string') return tracked.unknown.size ? 'unknown' : false;
  const name = call[1].split('.').pop();
  const n = escapedRegExp(name);
  const declared = [
    new RegExp(`\\bfunction\\s*\\*?\\s*${n}\\s*\\(`, 'u'),
    new RegExp(`\\b(?:const|let|var)\\s+${n}\\s*=`, 'u'),
    new RegExp(`(?:^|[\\s;{,])(?:static\\s+|async\\s+|get\\s+|set\\s+)*${n}\\s*\\([^()]*\\)\\s*\\{`, 'mu'),
    new RegExp(`(?:^|[\\s{,])${n}\\s*:\\s*(?:async\\s+)?(?:function\\b|\\([^()]*\\)\\s*=>)`, 'mu'),
  ].some((re) => re.test(content));
  if (!declared) return false;
  const satisfied = acceptanceAlreadySatisfied(item, io, options);
  if (satisfied === 'unknown') return 'unknown';
  return satisfied === false;
}

/**
 * Verdetto di ammissione al conio per UN item. In questa versione ammette
 * sempre: `observed` e' la misura che il gate conta e marca.
 *
 * @returns {{admit: boolean, observed: string[], skipped: string|null}}
 */
export function mintAdmission(item, io, options = {}) {
  if (isSchedaOnlyItem(item)) return { admit: true, observed: [], skipped: 'scheda-only' };
  const observed = [];
  const satisfied = acceptanceAlreadySatisfied(item, io, options);
  if (satisfied === true) observed.push(MINT_OBSERVATIONS.bornSatisfied);
  else {
    const declaration = satisfied === 'unknown' ? 'unknown' : acceptanceIsDeclaration(item, io, options);
    if (declaration === true) observed.push(MINT_OBSERVATIONS.declaration);
    if (satisfied === 'unknown' || declaration === 'unknown') observed.push(MINT_OBSERVATIONS.unknown);
  }
  const admit = !(DEMOTE_BORN_SATISFIED && observed.includes(MINT_OBSERVATIONS.bornSatisfied));
  return { admit, observed, skipped: null };
}

const NOT_FOUND_RE = /\bHTTP 404\b|\(HTTP 404\)|Not Found/u;

function encodeRepoPath(path) {
  return path.split('/').map((segment) => encodeURIComponent(segment)).join('/');
}

/**
 * `io` che legge i file di `repo` al ref `ref` dall'API contents (media type
 * raw), MAI dal disco: i passaggi del gate girano su checkout diversi (anche
 * sparse, o del repository sbagliato) e cosi' fanno tutti lo stesso controllo.
 *
 * - Cache per run: una sola chiamata per path.
 * - Tetto dichiarato: oltre `cap` chiamate un path nuovo vale `unknown`.
 * - 404 → `missing`; ogni altro errore → `unknown` (mai un «no» inventato).
 *
 * @param {{repo: string, ref?: string, gh: (args: string[]) => string, cap?: number}} options
 *   `gh(args)` ritorna lo stdout o lancia un errore con `stderr`/`message`.
 */
export function contentsApiIo({ repo, ref = 'main', gh, cap = DEFAULT_ADMISSION_READ_CAP } = {}) {
  const cache = new Map();
  const limit = Number.isInteger(cap) && cap >= 0 ? cap : DEFAULT_ADMISSION_READ_CAP;
  const stats = { reads: 0, cap: limit, capped: 0, errors: 0 };
  const lookup = (rawPath) => {
    const path = normalizeRepoPath(rawPath);
    if (cache.has(path)) return cache.get(path);
    let entry;
    if (!path || path.startsWith('/') || path.split('/').includes('..')) {
      entry = { status: 'missing', content: null };
    } else if (!repo || typeof gh !== 'function') {
      entry = { status: 'unknown', content: null };
    } else if (stats.reads >= limit) {
      stats.capped += 1;
      // Non in cache: un path oltre il tetto resta `unknown` per tutta la run.
      return { status: 'unknown', content: null };
    } else {
      stats.reads += 1;
      try {
        const out = gh(['api', '-H', 'Accept: application/vnd.github.raw',
          `repos/${repo}/contents/${encodeRepoPath(path)}?ref=${encodeURIComponent(ref)}`]);
        entry = typeof out === 'string' ? { status: 'present', content: out } : { status: 'unknown', content: null };
      } catch (error) {
        const detail = `${error?.stderr ?? ''}\n${error?.message ?? ''}`;
        if (NOT_FOUND_RE.test(detail)) entry = { status: 'missing', content: null };
        else {
          stats.errors += 1;
          entry = { status: 'unknown', content: null };
        }
      }
    }
    cache.set(path, entry);
    return entry;
  };
  return {
    status: (path) => lookup(path).status,
    fileExists: (path) => lookup(path).status === 'present',
    readFile: (path) => lookup(path).content,
    stats: () => ({ ...stats }),
  };
}
