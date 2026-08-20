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

const DRY = process.argv.includes('--dry-run');
const REPO = process.env.GITHUB_REPOSITORY || '';

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

function main() {
  if (!REPO) { console.error('GITHUB_REPOSITORY mancante'); process.exit(1); }
  console.log(`pr-collision-detector${DRY ? ' [DRY-RUN]' : ''} repo=${REPO}`);

  let prs;
  try {
    prs = gh(['pr', 'list', '--repo', REPO, '--state', 'open', '--limit', '50',
      '--json', 'number,labels,isDraft']);
  } catch (e) {
    console.error(`gh pr list fallito: ${String(e).slice(0, 160)}`);
    process.exit(0);
  }
  prs = prs || [];
  if (prs.length < 1) { console.log('Nessuna PR aperta.'); return; }

  const candidates = new Set(selectCollisionCandidates(prs));
  const skipped = prs.length - candidates.size;
  console.log(`PR open: ${prs.length}${skipped ? ` (${skipped} draft → fuori dal grafo, solo cleanup della label)` : ''}`);

  // File funnel-critical per PR. Le draft restano nella mappa con set vuoto: non
  // collidono, ma il loop finale le vede e può togliere una `collision-risk`
  // rimasta appesa. Niente `gh pr view` per loro — è la chiamata costosa dello
  // scan (una per PR) e su una draft non serve a nulla.
  const funnelFiles = new Map(); // num -> Set(files)
  const hasLabel = new Map();    // num -> bool collision-risk già presente
  for (const pr of prs) {
    hasLabel.set(pr.number, (pr.labels || []).some((l) => l.name === 'collision-risk'));
    if (!candidates.has(pr.number)) { funnelFiles.set(pr.number, new Set()); continue; }
    // `gh pr view --json files` passa da GraphQL, che su una PR con migliaia
    // di file cambiati risponde `{"files":null}` invece di un errore (misurato
    // su #6175, 5.576 file): il `--jq` muore, `allowFail` torna null, e il set
    // finisce vuoto. Vuoto qui significa «non collide con nessuno», cioe' il
    // fail-open esatto che questo scan deve evitare — e proprio sulla PR piu'
    // grande, quella con piu' probabilita' di collidere davvero.
    //
    // Il fallback REST risponde con una lista troncata (misurato: 100 file,
    // senza header `Link`) ma mai nulla. Un elenco parziale puo' mancare una
    // collisione, il vuoto le manca tutte: la direzione e' comunque migliore.
    let files = [];
    try {
      files = gh(['pr', 'view', String(pr.number), '--repo', REPO, '--json', 'files',
        '--jq', '[.files // [] | .[].path]'], { allowFail: true }) || [];
    } catch { files = []; }
    if (!files.length) {
      try {
        // `--paginate` applica il `--jq` a OGNI pagina: un filtro che produce un
        // array darebbe piu' valori JSON top-level concatenati, che JSON.parse
        // rifiuta. Quindi filtro a righe e split, che regge n pagine.
        const raw = gh(['api', `repos/${REPO}/pulls/${pr.number}/files`, '--paginate',
          '--jq', '.[].filename'], { json: false, allowFail: true }) || '';
        files = raw.split('\n').map((l) => l.trim()).filter(Boolean);
        if (files.length) console.log(`PR #${pr.number}: file list GraphQL nulla → fallback REST (${files.length} file, lista possibilmente troncata).`);
      } catch { files = []; }
    }
    const set = new Set(files.filter(isFunnel));
    funnelFiles.set(pr.number, set);
    if (set.size) console.log(`PR #${pr.number}: ${set.size} file funnel-critical.`);
  }

  // Coppie collidenti.
  const nums = prs.map((p) => p.number);
  const colliders = computeColliders(nums, funnelFiles);

  // Applica/rimuovi label + commenta.
  for (const num of nums) {
    const cols = colliders.get(num);
    if (cols && cols.size) {
      if (!hasLabel.get(num)) addLabel(num, 'collision-risk');
      else console.log(`PR #${num}: collision-risk già presente.`);
      for (const [other, shared] of cols) {
        const list = shared.map((f) => `\`${f}\``).join(', ');
        commentOnce(num, `<!-- COLLISION:${other} -->`,
          `⚠️ **collision-risk**: questa PR tocca file funnel-critical condivisi con la PR #${other}: ${list}. La seconda a raggiungere il merge DEVE prima rebasare oltre l'altra (\`git merge origin/main\` dopo che l'altra è mergiata) — l'auto-merge è bloccato finché \`collision-risk\` + dietro main. _Segnale deterministico da pr-collision-detector.yml (zero-Claude)._`);
      }
    } else if (hasLabel.get(num)) {
      console.log(`PR #${num}: non collide più → rimuovo collision-risk.`);
      removeLabel(num, 'collision-risk');
    }
  }
  console.log('collision scan completo.');
}

if (process.argv[1]?.endsWith('pr-collision-detector.mjs')) {
  main();
}
