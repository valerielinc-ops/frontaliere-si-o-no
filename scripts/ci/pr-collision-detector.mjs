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
 *   - lista PR OPEN; per ognuna i file cambiati (gh pr view N --json files).
 *   - FUNNEL-CRITICAL globs: scripts/lib/**, build-plugins/**,
 *     services/seoService.ts, services/seo/**, .github/workflows/**,
 *     scripts/update-*.mjs.
 *   - per ogni COPPIA di PR open che condivide ≥1 file funnel-critical:
 *     label `collision-risk` su ENTRAMBE + UN commento per PR che nomina la PR
 *     collidente + i file condivisi (dedup via marker `<!-- COLLISION:<other> -->`).
 *   - ricalcolo ad ogni run: una PR che non collide più con nessuna →
 *     RIMUOVI `collision-risk` (il vecchio commento resta, innocuo).
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

function main() {
  if (!REPO) { console.error('GITHUB_REPOSITORY mancante'); process.exit(1); }
  console.log(`pr-collision-detector${DRY ? ' [DRY-RUN]' : ''} repo=${REPO}`);

  let prs;
  try {
    prs = gh(['pr', 'list', '--repo', REPO, '--state', 'open', '--limit', '50',
      '--json', 'number,labels']);
  } catch (e) {
    console.error(`gh pr list fallito: ${String(e).slice(0, 160)}`);
    process.exit(0);
  }
  prs = prs || [];
  if (prs.length < 1) { console.log('Nessuna PR aperta.'); return; }

  // File funnel-critical per PR.
  const funnelFiles = new Map(); // num -> Set(files)
  const hasLabel = new Map();    // num -> bool collision-risk già presente
  for (const pr of prs) {
    hasLabel.set(pr.number, (pr.labels || []).some((l) => l.name === 'collision-risk'));
    let files = [];
    try {
      files = gh(['pr', 'view', String(pr.number), '--repo', REPO, '--json', 'files',
        '--jq', '[.files[].path]'], { allowFail: true }) || [];
    } catch { files = []; }
    const set = new Set(files.filter(isFunnel));
    funnelFiles.set(pr.number, set);
    if (set.size) console.log(`PR #${pr.number}: ${set.size} file funnel-critical.`);
  }

  // Coppie collidenti.
  const colliders = new Map(); // num -> Map(otherNum -> [shared files])
  const nums = prs.map((p) => p.number);
  for (let i = 0; i < nums.length; i++) {
    for (let j = i + 1; j < nums.length; j++) {
      const a = nums[i], b = nums[j];
      const sa = funnelFiles.get(a), sb = funnelFiles.get(b);
      const shared = [...sa].filter((f) => sb.has(f));
      if (shared.length) {
        if (!colliders.has(a)) colliders.set(a, new Map());
        if (!colliders.has(b)) colliders.set(b, new Map());
        colliders.get(a).set(b, shared);
        colliders.get(b).set(a, shared);
      }
    }
  }

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

main();
