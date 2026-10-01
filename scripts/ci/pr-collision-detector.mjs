/**
 * pr-collision-detector.mjs — rileva PR aperte che toccano gli stessi file
 * funnel-critical (zero-Claude, deterministico).
 *
 * Root cause del main-red #1454↔#1459: due PR aperte in parallelo mutavano gli
 * stessi file funnel-critical; la seconda mergiata senza rebase sulla prima ha
 * mandato main rosso. Qui rileviamo a monte le coppie collidenti e le
 * etichettiamo `collision-risk` → il gate di auto-merge-on-lgtm (P1) impedisce
 * alla seconda di mergiare finché non è rebasata oltre la prima.
 *
 * Logica:
 *   - PR gemelle (stesso head ref): chiude le duplicate e tiene la più vecchia
 *     (`findDuplicateHeadPrs`), prima di costruire il grafo.
 *   - lista PR OPEN NON-DRAFT; per ognuna i file cambiati (gh pr view N --json files).
 *   - FUNNEL-CRITICAL globs: scripts/lib/**, build-plugins/**,
 *     services/seoService.ts, services/seo/**, .github/workflows/**,
 *     scripts/update-*.mjs.
 *   - per ogni COPPIA di PR open che condivide ≥1 file funnel-critical:
 *     label `collision-risk` su ENTRAMBE + UN commento per PR che nomina la PR
 *     collidente + i file condivisi (dedup via marker `<!-- COLLISION:<other> -->`).
 *   - ricalcolo ad ogni run: una PR che non collide più con nessuna →
 *     RIMUOVI `collision-risk` (il vecchio commento resta, innocuo).
 *
 * ## Perché le draft non collidono
 *
 * Ogni altro componente del ciclo salta le draft — `auto-merge-eval` («PR è
 * draft — skip»), `auto-merge-sweep` (`selectSweepCandidates`), `pr-autorebase`,
 * `stale-pr-rescuer`, `pr-review-loop`. Questo script era l'unico a non farlo:
 * chiedeva `--json number,labels` e trattava una draft come qualunque altra PR.
 *
 * L'asimmetria non è teorica. Su `nanakokyobashi-rgb/frontaliere-articles` una
 * draft di sola conservazione (uno snapshot di sessione morta, PR #33, aperta
 * esplicitamente per NON essere mergiata) toccava 22 file `.github/workflows/**`
 * e 7 `scripts/lib/**` — tutti funnel-critical. Finché restava aperta, ogni PR
 * che avesse toccato uno di quei 29 file sarebbe stata etichettata
 * `collision-risk` e commentata contro una controparte che non poteva mergiare
 * mai. E la label non è inerte: `pr-autorebase` la usa come criterio
 * "near-merge" e rebasa+ri-testa la PR a ogni tick.
 *
 * Il senso della label lo dice il suo stesso commento: «la seconda a raggiungere
 * il merge DEVE prima rebasare oltre l'altra». Una draft non sta raggiungendo il
 * merge — nessun percorso automatico può portarla lì — quindi non è "l'altra" di
 * nessuno. Quando torna `ready_for_review` rientra nello scan (il trigger
 * `ready_for_review` sotto la ri-valuta subito, senza aspettare il cron).
 *
 * Le draft restano nel giro per la SOLA pulizia: una PR messa in draft dopo aver
 * preso `collision-risk` se la deve vedere tolta, altrimenti la label sopravvive
 * al motivo che l'aveva prodotta.
 *
 * Uso:  node scripts/ci/pr-collision-detector.mjs [--dry-run]
 * Env:  GH_TOKEN (PAT preferito per coerenza; label via GITHUB_TOKEN basta per
 *       il gating), GITHUB_REPOSITORY. Richiede `gh` in PATH.
 */
import { execFileSync } from 'node:child_process';
import { commentOnce as commentOnceShared } from './lib/prComments.mjs';
import { fetchPrFiles, GRAPHQL_FILES_CAP, REST_FILES_HARD_CAP } from './lib/fetchPrFiles.mjs';

export { fetchPrFiles, GRAPHQL_FILES_CAP, REST_FILES_HARD_CAP };

const DRY = process.argv.includes('--dry-run');
const REPO = process.env.GITHUB_REPOSITORY || '';
const AUTOFIX_LABEL = 'agent:autofix';

function labelNames(pr) {
  if (!Array.isArray(pr?.labels)) return [];
  return pr.labels
    .map((label) => (typeof label === 'string' ? label : label?.name))
    .filter((label) => typeof label === 'string');
}

/**
 * Provenienza autonoma della PR, nella stessa forma usata dagli altri custodi
 * del ciclo: branch convenzionale, autore bot o label esplicita. Serve prima
 * di propagare `agent:autofix` da una PR duplicata al keeper: una label sulla
 * duplicata non dimostra che il keeper sia stato aperto dall'automazione.
 * Pura → testabile.
 */
export function isAutonomousCollisionPr(pr) {
  if (!pr || typeof pr !== 'object') return false;
  const ref = String(pr.headRefName || pr.headRef || '');
  if (ref.startsWith('fix/') || ref.startsWith('automerge-')) return true;
  if (pr.authorType === 'Bot') return true;
  if (pr.author?.type === 'Bot' || pr.author?.isBot === true || pr.author?.is_bot === true) return true;
  return labelNames(pr).includes(AUTOFIX_LABEL);
}

// Glob funnel-critical → predicate. Manteniamo i pattern espliciti e ristretti:
// allargarli genererebbe falsi positivi (ogni PR collide con ogni PR).
const FUNNEL_PREDICATES = [
  (f) => f.startsWith('scripts/lib/'),
  (f) => f.startsWith('build-plugins/'),
  (f) => f === 'services/seoService.ts',
  (f) => f.startsWith('services/seo/'),
  (f) => f.startsWith('.github/workflows/'),
  (f) => /^scripts\/update-[^/]*\.mjs$/.test(f),
];

const isFunnel = (f) => FUNNEL_PREDICATES.some((p) => p(f));

function gh(args, { json = true, allowFail = false } = {}) {
  try {
    const out = execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return json ? JSON.parse(out) : out;
  } catch (e) {
    if (allowFail) return json ? null : '';
    throw e;
  }
}

function addLabel(num, label) {
  if (DRY) { console.log(`[dry] +label ${label} #${num}`); return; }
  gh(['pr', 'edit', String(num), '--repo', REPO, '--add-label', label], { json: false, allowFail: true });
}

function removeLabel(num, label) {
  if (DRY) { console.log(`[dry] -label ${label} #${num}`); return; }
  gh(['pr', 'edit', String(num), '--repo', REPO, '--remove-label', label], { json: false, allowFail: true });
}

function commentOnce(num, marker, body) {
  commentOnceShared(gh, REPO, num, marker, body, { dry: DRY });
}

/**
 * Chi partecipa allo scan come collider: le OPEN non-draft con numero valido.
 * Puro → testabile, e stessa forma di `selectSweepCandidates` in
 * auto-merge-sweep.mjs, che risolve lo stesso problema per l'auto-merge.
 *
 * `isDraft` mancante (campo non chiesto, risposta parziale) NON è trattato come
 * draft: il default resta "partecipa", così una regressione nella query degrada
 * verso il comportamento storico invece che verso uno scan muto.
 */
export function selectCollisionCandidates(prs) {
  if (!Array.isArray(prs)) return [];
  return prs.filter((p) => p && p.isDraft !== true && Number.isInteger(p.number)).map((p) => p.number);
}

/** `owner/name` del repository di testa, minuscolo; null se non leggibile. */
export function headRepositoryIdentity(pr) {
  const full = pr?.headRepository?.nameWithOwner;
  if (typeof full === 'string' && /^[^/\s]+\/[^/\s]+$/u.test(full)) return full.toLowerCase();
  const owner = pr?.headRepositoryOwner?.login;
  const name = pr?.headRepository?.name;
  if (typeof owner === 'string' && owner && typeof name === 'string' && name) return `${owner}/${name}`.toLowerCase();
  return null;
}

/**
 * PR GEMELLE: due PR aperte sullo stesso head (stesso repository, stesso
 * branch, stesso commit) verso la stessa base sono la stessa PR due volte —
 * stessi commit, stesso diff — non due lavori in parallelo. Osservate #10608 e
 * #10609 su `fix/issue-10544`, create nello stesso secondo: condividendo ogni
 * file si etichettavano `collision-risk` a vicenda, e la «seconda a
 * raggiungere il merge» non poteva esistere. Si tiene la piu' vecchia fra le
 * non-draft (una draft solo se lo sono tutte); le altre sono duplicate da
 * chiudere (il branch resta: e' quello della PR tenuta). Pura → testabile.
 *
 * L'identita' e' completa e fail-closed: repository di testa (non il solo
 * owner, che puo' avere piu' repository con lo stesso nome di branch), branch,
 * SHA di testa e base. Un campo mancante o illeggibile = nessun raggruppamento
 * e quindi nessuna chiusura.
 *
 * @param {Array<{number:number, isDraft?:boolean, headRefName?:string, headRefOid?:string, baseRefName?:string,
 *   headRepositoryOwner?:{login?:string}, headRepository?:{name?:string, nameWithOwner?:string},
 *   labels?:Array<{name:string}>}>} prs
 * @returns {Array<{number:number, keeper:number, labels:string[]}>} duplicate da chiudere
 */
export function findDuplicateHeadPrs(prs) {
  if (!Array.isArray(prs)) return [];
  const byHead = new Map(); // repo:ref:oid:base -> [pr]
  for (const pr of prs) {
    if (!pr || !Number.isInteger(pr.number)) continue;
    const repo = headRepositoryIdentity(pr);
    const ref = pr.headRefName;
    const oid = String(pr.headRefOid || '').toLowerCase();
    const base = pr.baseRefName;
    if (!repo || typeof ref !== 'string' || !ref || !/^[0-9a-f]{40}$/u.test(oid)
      || typeof base !== 'string' || !base) continue;
    const key = `${repo}:${ref}:${oid}:${base}`;
    if (!byHead.has(key)) byHead.set(key, []);
    byHead.get(key).push(pr);
  }
  const duplicates = [];
  for (const group of byHead.values()) {
    if (group.length < 2) continue;
    // Tenuta: prima una PR pronta, poi la piu' vecchia. Una draft piu' vecchia
    // non deve far chiudere la PR che sta andando al merge.
    group.sort((a, b) => Number(a.isDraft === true) - Number(b.isDraft === true) || a.number - b.number);
    const keeper = group[0].number;
    for (const dup of group.slice(1)) {
      duplicates.push({ number: dup.number, keeper, labels: (dup.labels || []).map((l) => l?.name).filter(Boolean) });
    }
  }
  return duplicates.sort((a, b) => a.number - b.number);
}

/**
 * Coppie collidenti da `num -> Set(file funnel-critical)`.
 *
 * Una PR assente da `funnelFiles` (o con set vuoto) non collide con nessuno: è
 * così che le draft escono dal grafo pur restando nel giro per la rimozione
 * della label.
 */
export function computeColliders(nums, funnelFiles) {
  const colliders = new Map(); // num -> Map(otherNum -> [shared files])
  for (let i = 0; i < nums.length; i++) {
    for (let j = i + 1; j < nums.length; j++) {
      const a = nums[i], b = nums[j];
      const sa = funnelFiles.get(a) || new Set();
      const sb = funnelFiles.get(b) || new Set();
      const shared = [...sa].filter((f) => sb.has(f));
      if (shared.length) {
        if (!colliders.has(a)) colliders.set(a, new Map());
        if (!colliders.has(b)) colliders.set(b, new Map());
        colliders.get(a).set(b, shared);
        colliders.get(b).set(a, shared);
      }
    }
  }
  return colliders;
}

/**
 * Cosa fare della label `collision-risk` su una PR che al momento NON risulta
 * collidere. Pura ed esportata perche' e' la decisione che questo modulo
 * esiste per prendere, e viveva inline in `main()` — cioe' senza copertura,
 * esattamente come ci era finito il cap a 100.
 *
 * @returns {'add'|'keep'|'remove'|'none'}
 */
export function decideCollisionLabel({ collides, hasLabel, listComplete }) {
  if (collides) return hasLabel ? 'none' : 'add';
  if (!hasLabel) return 'none';
  // «Nessuna collisione VISTA» e «non collide» coincidono solo se l'elenco era
  // completo. Con una lista troncata o non recuperata, togliere la label
  // sblocca l'auto-merge su una PR che puo' collidere davvero.
  return listComplete ? 'remove' : 'keep';
}

function main() {
  if (!REPO) { console.error('GITHUB_REPOSITORY mancante'); process.exit(1); }
  console.log(`pr-collision-detector${DRY ? ' [DRY-RUN]' : ''} repo=${REPO}`);

  let prs;
  try {
    prs = gh(['pr', 'list', '--repo', REPO, '--state', 'open', '--limit', '50',
      '--json', 'number,labels,isDraft,author,headRefName,headRefOid,baseRefName,headRepository,headRepositoryOwner,title']);
  } catch (e) {
    console.error(`gh pr list fallito: ${String(e).slice(0, 160)}`);
    process.exit(0);
  }
  prs = prs || [];
  if (prs.length < 1) { console.log('Nessuna PR aperta.'); return; }

  // Gemelle sullo stesso head ref: si chiude la duplicata prima del grafo, che
  // altrimenti le farebbe collidere fra loro per sempre.
  const duplicates = findDuplicateHeadPrs(prs);
  const closedDuplicates = new Set();
  for (const dup of duplicates) {
    console.log(`PR #${dup.number}: gemella di #${dup.keeper} (stesso head ref) → chiusa come duplicata.`);
    const keeper = prs.find((pr) => pr.number === dup.keeper);
    if (dup.labels.includes(AUTOFIX_LABEL) && isAutonomousCollisionPr(keeper)) {
      addLabel(dup.keeper, AUTOFIX_LABEL);
    }
    commentOnce(dup.number, `<!-- DUPLICATE_HEAD_OF:${dup.keeper} -->`,
      `♻️ **duplicata**: questa PR e la PR #${dup.keeper} hanno lo stesso head branch, quindi gli stessi commit. ` +
      `Resta aperta #${dup.keeper} (la più vecchia); questa viene chiusa senza toccare il branch. ` +
      `_Segnale deterministico da pr-collision-detector.yml (zero-Claude)._`);
    if (DRY) { console.log(`[dry] close #${dup.number}`); }
    else gh(['pr', 'close', String(dup.number), '--repo', REPO], { json: false, allowFail: true });
    closedDuplicates.add(dup.number);
  }
  if (closedDuplicates.size) prs = prs.filter((p) => !closedDuplicates.has(p.number));

  // Chi sta lavorando sull'altra PR. Senza questo il commento dice CHE c'e' una
  // collisione ma non A CHI parlarne, e con la flotta che apre PR in parallelo
  // e' proprio quella l'informazione che serve: le due PR restano indipendenti
  // (niente lock, niente serializzazione), quindi il coordinamento e' umano o
  // fra agenti, e per coordinarsi bisogna sapere con chi.
  //
  // `author.login` identifica l'identita' che ha aperto la PR (spesso la stessa
  // per tutta la flotta) e `headRefName` il branch, che per convenzione di
  // questo repo nomina il task (`fix-6298`, `ci-step-audit`, ...): e' il
  // discriminante utile quando l'autore e' lo stesso per tutti. Entrambi
  // opzionali: un campo mancante degrada il testo, non lo rompe.
  const whoBy = new Map(
    (prs || []).map((p) => [
      Number(p.number),
      { login: p?.author?.login || '', branch: p?.headRefName || '', title: p?.title || '' },
    ]),
  );
  /** Riga «chi ci lavora» per la PR `n`, vuota se non sappiamo niente. */
  const whoFor = (n) => {
    const w = whoBy.get(Number(n));
    if (!w) return '';
    const bits = [];
    if (w.login) bits.push(`@${w.login}`);
    if (w.branch) bits.push(`branch \`${w.branch}\``);
    return bits.length ? ` (ci lavora ${bits.join(', ')})` : '';
  };

  const candidates = new Set(selectCollisionCandidates(prs));
  const skipped = prs.length - candidates.size;
  console.log(`PR open: ${prs.length}${skipped ? ` (${skipped} draft → fuori dal grafo, solo cleanup della label)` : ''}`);

  // File funnel-critical per PR. Le draft restano nella mappa con set vuoto: non
  // collidono, ma il loop finale le vede e può togliere una `collision-risk`
  // rimasta appesa. Niente `gh pr view` per loro — è la chiamata costosa dello
  // scan (una per PR) e su una draft non serve a nulla.
  const funnelFiles = new Map(); // num -> Set(files)
  const hasLabel = new Map();    // num -> bool collision-risk già presente
  const listComplete = new Map(); // num -> bool elenco file misurato completo
  for (const pr of prs) {
    hasLabel.set(pr.number, (pr.labels || []).some((l) => l.name === 'collision-risk'));
    // Le draft restano fuori dal grafo ma dentro il cleanup: non le
    // interroghiamo, quindi il loro elenco e' completo per costruzione (vuoto
    // perche' non lo cerchiamo, non perche' il fetch e' fallito).
    if (!candidates.has(pr.number)) {
      funnelFiles.set(pr.number, new Set());
      listComplete.set(pr.number, true);
      continue;
    }
    // `changedFiles` e `files` vengono da `fetchPrFiles` in UNA SOLA `gh pr
    // view`, non piu' da un `pr.changedFiles` letto una volta sola nel `gh pr
    // list` di sopra e via via piu' stale man mano che questo loop avanza —
    // era la race di #6206 item 3.
    const { files, complete, expected, reason } = fetchPrFiles(pr.number, gh, REPO);
    const set = new Set(files.filter(isFunnel));
    funnelFiles.set(pr.number, set);
    listComplete.set(pr.number, complete);
    if (!complete) {
      // La causa cambia cosa farsene: `rest-hard-limit` e' il tetto dell'API e
      // non rientra da solo, gli altri sono transitori (follow-up #6206 item 1).
      const hardLimit = reason === 'rest-hard-limit';
      console.log(`PR #${pr.number}: elenco file INCOMPLETO (${files.length}/${expected ?? '?'} attesi, causa: ${reason}) → una collisione puo' sfuggire, la label non verra' rimossa.`);
      if (hardLimit) {
        console.log(`PR #${pr.number}: ⚠️  il troncamento e' il tetto rigido di ${REST_FILES_HARD_CAP} file della REST GitHub, non un errore transitorio — nessun retry lo risolve.`);
      }
    }
    if (set.size) console.log(`PR #${pr.number}: ${set.size} file funnel-critical.`);
  }

  // Coppie collidenti.
  const nums = prs.map((p) => p.number);
  const colliders = computeColliders(nums, funnelFiles);

  // Applica/rimuovi label + commenta.
  for (const num of nums) {
    const cols = colliders.get(num);
    const action = decideCollisionLabel({
      collides: Boolean(cols && cols.size),
      hasLabel: Boolean(hasLabel.get(num)),
      listComplete: Boolean(listComplete.get(num)),
    });
    if (cols && cols.size) {
      if (action === 'add') addLabel(num, 'collision-risk');
      else console.log(`PR #${num}: collision-risk già presente.`);
      for (const [other, shared] of cols) {
        const list = shared.map((f) => `\`${f}\``).join(', ');
        commentOnce(num, `<!-- COLLISION:${other} -->`,
          `⚠️ **collision-risk**: questa PR tocca file funnel-critical condivisi con la PR #${other}${whoFor(other)}: ${list}. ` +
          `Le due PR restano INDIPENDENTI — nessun lock le serializza — ma la seconda a raggiungere il merge DEVE prima rebasare oltre l'altra ` +
          `(\`git merge origin/main\` dopo che l'altra è mergiata); l'auto-merge è bloccato finché \`collision-risk\` + dietro main. ` +
          `Se ci sta lavorando qualcun altro, coordinatevi qui: chi mergia per primo lascia all'altro un rebase, non un conflitto a sorpresa. ` +
          `_Segnale deterministico da pr-collision-detector.yml (cron ogni 30 min, zero-Claude)._`);
      }
    } else if (action === 'keep') {
      console.log(`PR #${num}: nessuna collisione vista MA elenco file incompleto → tengo collision-risk (unknown ≠ non collide).`);
    } else if (action === 'remove') {
      console.log(`PR #${num}: non collide più → rimuovo collision-risk.`);
      removeLabel(num, 'collision-risk');
    }
  }
  console.log('collision scan completo.');
}

if (process.argv[1]?.endsWith('pr-collision-detector.mjs')) {
  main();
}
