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
 * DEMOZIONI, queste si'. Due classi di item non chiudibili vengono tolte al
 * conio (misura sul bucket 10433: 36 item su 60 da bullet gia' chiusi; nei
 * bucket del 21-22-09 e 02-10, 4 file coniati nel bucket del sito e assenti
 * dal sito):
 *   - `closed-state-bullet`: l'`Original text` e' un bullet che
 *     `nonCandidateVerdict()` dichiara gia' chiuso (`per scelta`, «falso
 *     positivo», `in questa PR`…); un semplice match lessicale
 *     (`hard-exclude`) non basta. Non legge file.
 *   - `target-file-missing`: il `Target file` non esiste nel repository del
 *     bucket; prima si prova il nome che il manifest di mirror gli da' QUI
 *     (riscrittura del solo campo), e il manifest dice se va coniato nel
 *     gemello. Senza manifest o lettura → `admission-unknown`, mai demozione.
 *
 * PORTABILE. Il modulo viene copiato byte per byte nel corpus: importa
 * `../followup-resolution-match.mjs`, `../followup-has-candidates.mjs`
 * (`identical`) e `../followup-candidate-bullets.mjs` (`mirrorRoute`; nel
 * corpus arriva col suo port), allo stesso path nei due repository. Cio' che
 * diverge si inietta
 * (`options.detect`, l'`io`, il runner `gh`, il manifest). Nessuna I/O
 * diretta: niente `fs`, niente `child_process`.
 */
import {
  ACCEPTANCE_CONDITION,
  COMMAND_CONDITION,
  detectAlreadyResolved,
  normalizeAcceptanceToken,
  schedaCommand,
} from '../followup-resolution-match.mjs';
import { mirrorRoute, nonCandidateVerdict } from '../followup-candidate-bullets.mjs';

/** Interruttore della demozione degli item nati soddisfatti. Spento: solo misura. */
export const DEMOTE_BORN_SATISFIED = false;

/** Codici delle osservazioni, insieme chiuso. */
export const MINT_OBSERVATIONS = Object.freeze({
  bornSatisfied: 'acceptance-already-true',
  declaration: 'token-is-declaration',
  unknown: 'admission-unknown',
  closedState: 'closed-state-bullet',
  targetMissing: 'target-file-missing',
  targetInTwin: 'target-in-twin',
  targetRewritten: 'target-rewritten',
  targetIdenticalInCorpus: 'target-identical-in-corpus',
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

const FENCE_RE = /^\s*(?:>\s*)?(`{3,}|~{3,})/u;

function closesFence(line, fence) {
  const mark = FENCE_RE.exec(line)?.[1];
  return Boolean(mark) && mark[0] === fence[0] && mark.length >= fence.length;
}

/**
 * Il testo del campo `Original text` di un item (il bullet della PR sorgente),
 * senza i marcatori di citazione e di fence, su una riga; stringa vuota se
 * l'item non ha il campo. Copre la forma in linea (`- Original text: > …`),
 * quella citata su righe successive e quella in un fence.
 */
export function originalTextOf(itemText) {
  const out = [];
  let inside = false;
  let fence = null;
  for (const line of String(itemText ?? '').split('\n')) {
    if (!inside) {
      const head = /^\s*-\s+Original text\s*:(.*)$/iu.exec(line);
      if (head) {
        inside = true;
        out.push(head[1]);
      }
      continue;
    }
    if (fence) {
      if (closesFence(line, fence)) fence = null;
      else out.push(line);
      continue;
    }
    const mark = FENCE_RE.exec(line)?.[1];
    if (mark) {
      fence = mark;
      continue;
    }
    if (/^(?:-\s+[^\s:][^:\n]*:|#{1,6}\s)/u.test(line)) break;
    out.push(line);
  }
  return out.map((line) => line.replace(/^\s*(?:>\s?)+/u, '').trim()).filter(Boolean).join(' ').trim();
}

/**
 * Il bullet da cui l'item nasce e' gia' chiuso? Stesso oracolo del bundle del
 * triage (`nonCandidateVerdict()`, sopra `isCandidateItem()`): demota solo i
 * VERDETTI (`closing-state`: `per scelta` o «falso positivo» motivati, `by
 * construction`, `in questa PR`, `PR concatenata #N`; `empty`: «Nessuno»).
 * `hard-exclude` e' un match lessicale («post-deploy», «deferred», «add a
 * test»…), sicuro solo come gate aggregato: bullet per bullet resta un indizio
 * e l'item coniato dal triage resta ammesso. Non legge file. Senza `Original
 * text` non c'e' niente da giudicare → `false`.
 */
export function closedStateBullet(item) {
  const original = originalTextOf(typeof item === 'string' ? item : item?.text);
  if (!original) return false;
  const verdict = nonCandidateVerdict(original);
  return verdict === 'closing-state' || verdict === 'empty';
}

// ── Il bersaglio: esiste nel repository del bucket? ─────────────────

const ARTICLES_PACKAGE_PREFIX = 'packages/articles/';
const SAFE_TARGET_RE = /^[\w@()[\]+.-]+(?:\/[\w@()[\]+.-]+)*\/?$/u;
const PLACEHOLDER_TARGET_RE = /^(?:n\/?a|none|nessuno|tbd|-+)$/iu;
const isWorkflowPath = (path) => /^\.github\/(?:workflows|corpus-workflows)\//u.test(path);

/** Il nome del motore articoli sull'altro lato (`engine/x` ↔ `packages/articles/engine/x`). */
function engineAlias(target, side) {
  if (side === 'site' && target.startsWith('engine/')) return `${ARTICLES_PACKAGE_PREFIX}${target}`;
  if (side === 'corpus' && target.startsWith(`${ARTICLES_PACKAGE_PREFIX}engine/`)) {
    return target.slice(ARTICLES_PACKAGE_PREFIX.length);
  }
  return null;
}

const statusAsBoolean = (status) => (status === 'present' ? true : status === 'missing' ? false : null);

/**
 * Il `Target file` esiste nel repository del bucket? Verdetti:
 *   - `ok`: esiste, oppure manca ma la scheda `COMANDO` lo nomina come
 *     referente futuro (regola esistente); `identicalInCorpus` quando un
 *     bucket del corpus punta a un file `identical` (si corregge nel sito);
 *   - `rewrite`: esiste QUI con un altro nome (`identical` con `sitePath`,
 *     o `engine/` ↔ `packages/articles/engine/`): `path` e' il nome giusto;
 *   - `missing`: non esiste qui; `twin` se il manifest lo assegna al gemello;
 *   - `unknown`: lettura o manifest non disponibili → nessuna demozione.
 * Un workflow non viene mai riscritto (`.github/corpus-workflows/**` e' una
 * copia, non il posto in cui si corregge).
 *
 * @param {{targetFile?: string, text?: string}} item
 * @param {object} io l'`io` del repository del bucket
 * @param {{side: 'site'|'corpus', manifestFiles: Array<object>|null|(() => Array<object>|null), twinIo?: object}} context
 */
export function targetResolves(item, io, { side, manifestFiles, twinIo } = {}) {
  const target = normalizeRepoPath(item?.targetFile);
  // Niente da controllare: vuoto, non un path, oppure un segnaposto (`n/a`,
  // `none`, `-`, una parola senza directory ne' estensione).
  if (!target || !SAFE_TARGET_RE.test(target) || target.split('/').includes('..')
    || PLACEHOLDER_TARGET_RE.test(target) || (!target.includes('/') && !target.includes('.'))) {
    return { status: 'ok', target };
  }
  const files = () => (typeof manifestFiles === 'function' ? manifestFiles() : manifestFiles);
  const here = pathStatus(io, target);
  if (here === 'present') {
    const manifest = side === 'corpus' ? files() : null;
    const identical = Array.isArray(manifest) && manifest.some((entry) => entry?.mode === 'identical'
      && normalizeRepoPath(entry.path) === target);
    return identical ? { status: 'ok', target, identicalInCorpus: true } : { status: 'ok', target };
  }
  if (here !== 'missing') return { status: 'unknown', target };
  const command = schedaCommand(String(item?.text ?? ''));
  const named = Boolean(command) && command.replace(/[`'"]/gu, '').split(/\s+/u)
    .some((token) => normalizeRepoPath(token) === target);
  const futureOrMissing = () => (named ? { status: 'ok', target, future: true } : { status: 'missing', target });

  const alias = engineAlias(target, side);
  if (alias) {
    const status = pathStatus(io, alias);
    if (status === 'present') return { status: 'rewrite', target, path: alias };
    if (status === 'unknown') return { status: 'unknown', target };
  }
  const twin = side === 'site' ? 'corpus' : side === 'corpus' ? 'site' : null;
  const route = mirrorRoute({
    path: target,
    side,
    manifestFiles: files(),
    existsHere: (path) => statusAsBoolean(pathStatus(io, path)),
    existsTwin: (path) => statusAsBoolean(pathStatus(twinIo, path)),
  });
  // Port pendente verso il sito: il file va CREATO qui, l'item ne e' il referente futuro.
  if (route.why === 'manifest:corpus-only-pending' && route.repo === side) return { status: 'ok', target, future: true };
  if (route.repo === side && route.targetPath && route.targetPath !== target) {
    if (isWorkflowPath(target) || isWorkflowPath(route.targetPath)) return { status: 'missing', target };
    const status = pathStatus(io, route.targetPath);
    if (status === 'present') return { status: 'rewrite', target, path: route.targetPath };
    if (status === 'unknown') return { status: 'unknown', target };
    return futureOrMissing();
  }
  if (twin && route.repo === twin) return { status: 'missing', target, twin: { repo: twin, path: route.targetPath } };
  if (route.repo === side || route.why === 'no-entry:not-found') return futureOrMissing();
  return { status: 'unknown', target };
}

/**
 * Sostituisce il valore del solo campo `- Target file:` dell'item, fuori da
 * fence e citazioni; il resto del testo resta byte per byte.
 */
export function rewriteTargetFileField(text, path) {
  let fence = null;
  let done = false;
  return String(text ?? '').split('\n').map((line) => {
    if (done) return line;
    if (fence) {
      if (closesFence(line, fence)) fence = null;
      return line;
    }
    const mark = FENCE_RE.exec(line)?.[1];
    if (mark) {
      fence = mark;
      return line;
    }
    const field = /^(\s*-\s+Target file\s*:\s*)\S.*$/iu.exec(line);
    if (!field) return line;
    done = true;
    return `${field[1]}\`${path}\``;
  }).join('\n');
}

function withTargetFile(item, path) {
  return {
    ...item,
    text: rewriteTargetFileField(item.text, path),
    raw: rewriteTargetFileField(item.raw, path),
    targetFile: `\`${path}\``,
  };
}

function demote(code, detail, observed) {
  return { admit: false, observed: [...new Set([...observed, code])], skipped: null, demotion: { code, detail } };
}

/**
 * Verdetto di ammissione al conio per UN item. Demota i bullet gia' chiusi e
 * (con `options.target`) i bersagli assenti;
 * altrimenti ammette, e `observed` e' la misura che il gate conta e marca.
 * `item` nel risultato c'e' solo quando il `Target file` e' stato riscritto.
 *
 * @param {object} item item di `parseFollowupItems`
 * @param {object} io l'`io` del repository del bucket
 * @param {{detect?: Function, target?: {side: string, manifestFiles: unknown, twinIo?: object}}} [options]
 * @returns {{admit: boolean, observed: string[], skipped: string|null,
 *            demotion?: {code: string, detail: string}, item?: object}}
 */
export function mintAdmission(item, io, options = {}) {
  if (closedStateBullet(item)) {
    return demote(MINT_OBSERVATIONS.closedState, 'il bullet della PR dichiara gia\' uno stato che chiude la voce', []);
  }
  const observed = [];
  let admitted = item;
  if (options.target) {
    const verdict = targetResolves(item, io, options.target);
    if (verdict.status === 'unknown') observed.push(MINT_OBSERVATIONS.unknown);
    if (verdict.identicalInCorpus) observed.push(MINT_OBSERVATIONS.targetIdenticalInCorpus);
    if (verdict.status === 'rewrite') {
      admitted = withTargetFile(item, verdict.path);
      observed.push(MINT_OBSERVATIONS.targetRewritten);
    }
    if (verdict.status === 'missing') {
      const twin = verdict.twin
        ? `; secondo il manifest va coniato in ${verdict.twin.repo} come \`${verdict.twin.path}\``
        : '';
      return demote(MINT_OBSERVATIONS.targetMissing,
        `\`${verdict.target}\` non esiste nel repository del bucket${twin}`,
        verdict.twin ? [MINT_OBSERVATIONS.targetInTwin] : []);
    }
  }
  const rewritten = admitted === item ? {} : { item: admitted };
  if (isSchedaOnlyItem(admitted)) return { admit: true, observed, skipped: 'scheda-only', ...rewritten };
  const satisfied = acceptanceAlreadySatisfied(admitted, io, options);
  if (satisfied === true) observed.push(MINT_OBSERVATIONS.bornSatisfied);
  else {
    const declaration = satisfied === 'unknown' ? 'unknown' : acceptanceIsDeclaration(admitted, io, options);
    if (declaration === true) observed.push(MINT_OBSERVATIONS.declaration);
    if (satisfied === 'unknown' || declaration === 'unknown') observed.push(MINT_OBSERVATIONS.unknown);
  }
  const admit = !(DEMOTE_BORN_SATISFIED && observed.includes(MINT_OBSERVATIONS.bornSatisfied));
  return { admit, observed: [...new Set(observed)], skipped: null, ...rewritten };
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
 * - Tetto dichiarato: oltre `cap` chiamate un path nuovo vale `unknown`
 *   (`stats().capped` = path distinti non letti).
 * - 404 → `missing` SOLO se il repository e' leggibile con questo `gh`: l'API
 *   risponde 404 anche a un token senza accesso. La prova e' UNA lettura del
 *   ref (`repos/<repo>/commits/<ref>`) per run, fatta solo dopo il primo 404;
 *   se non risponde (404, 403, rete) ogni 404 vale `unknown` e si conta in
 *   `errors`. Ogni altro errore → `unknown` (mai un «no» inventato).
 *
 * @param {{repo: string, ref?: string, gh: (args: string[]) => string, cap?: number}} options
 *   `gh(args)` ritorna lo stdout o lancia un errore con `stderr`/`message`.
 */
export function contentsApiIo({ repo, ref = 'main', gh, cap = DEFAULT_ADMISSION_READ_CAP } = {}) {
  const cache = new Map();
  const limit = Number.isInteger(cap) && cap >= 0 ? cap : DEFAULT_ADMISSION_READ_CAP;
  const stats = { reads: 0, cap: limit, capped: 0, errors: 0 };
  let readable;
  // `true` se il ref di `repo` si legge con questo `gh`: solo allora un 404 sul
  // file dice «non c'e'». Un esito per run, anche negativo (fail-open: unknown).
  const repoReadable = () => {
    if (readable === undefined) {
      try {
        const out = gh(['api', `repos/${repo}/commits/${encodeURIComponent(ref)}`, '--jq', '.sha']);
        readable = typeof out === 'string' && out.trim() !== '';
      } catch {
        readable = false;
      }
    }
    return readable;
  };
  const lookup = (rawPath) => {
    const path = normalizeRepoPath(rawPath);
    if (cache.has(path)) return cache.get(path);
    let entry;
    if (!path || path.startsWith('/') || path.split('/').includes('..')) {
      entry = { status: 'missing', content: null };
    } else if (!repo || typeof gh !== 'function') {
      entry = { status: 'unknown', content: null };
    } else if (stats.reads >= limit) {
      // In cache anche il rifiuto: un path oltre il tetto resta `unknown` per
      // tutta la run e `capped` conta i PATH non letti, non le consultazioni
      // (lo stesso path e' citato in piu' sezioni e riletto da piu' controlli).
      stats.capped += 1;
      entry = { status: 'unknown', content: null };
    } else {
      stats.reads += 1;
      try {
        const out = gh(['api', '-H', 'Accept: application/vnd.github.raw',
          `repos/${repo}/contents/${encodeRepoPath(path)}?ref=${encodeURIComponent(ref)}`]);
        entry = typeof out === 'string' ? { status: 'present', content: out } : { status: 'unknown', content: null };
      } catch (error) {
        const detail = `${error?.stderr ?? ''}\n${error?.message ?? ''}`;
        if (NOT_FOUND_RE.test(detail) && repoReadable()) entry = { status: 'missing', content: null };
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
