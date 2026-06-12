/**
 * loop-health-report.mjs — osservabilità DETERMINISTICA del loop autonomo
 * (zero-Claude). Calcola le metriche di salute che altrimenti vanno raccolte
 * a mano (fatto l'ultima volta il 2026-06-12, ~4 agent-ore): failure-rate per
 * workflow Claude, first-shot LGTM rate, zombie agent:fix, backlog coda.
 *
 * Perché: il sistema si auto-ripara solo se l'osservazione è essa stessa
 * automatica. Questo report chiude il ciclo osserva→fixa→valida: dopo ogni
 * tuning (es. turn-cap bump #1919) il trend dei failure-rate dice se il fix
 * performa o va revertato — senza sessione di analisi dedicata.
 *
 * Output: report markdown su stdout + commento su una issue-tracker dedup
 * (titolo stabile, find-or-create) così lo storico resta consultabile in un
 * posto solo. Soglie ⚠️ inline per le regressioni più care.
 *
 * Uso:  node scripts/ci/loop-health-report.mjs [--days 7] [--no-post]
 * Env:  GH_TOKEN (GITHUB_TOKEN basta: sola lettura + issue comment),
 *       GITHUB_REPOSITORY o GH_REPO.
 */
import { execFileSync } from 'node:child_process';

const REPO = process.env.GH_REPO || process.env.GITHUB_REPOSITORY || '';
const argv = process.argv.slice(2);
const DAYS = Number(argv.includes('--days') ? argv[argv.indexOf('--days') + 1] : 7);
const NO_POST = argv.includes('--no-post');
const TRACKER_TITLE = '📊 Loop health report (tracker)';

// Workflow Claude = i soli 5 che bruciano quota Max (AGENTS.md § frugalità).
const CLAUDE_WORKFLOWS = [
  'pr-review-loop.yml',
  'issue-fix.yml',
  'pr-redflag-fixer.yml',
  'post-merge-followup.yml',
  'lessons-harvester.yml',
];
// Failure-rate sopra questa soglia (sui run reali, esclusi skipped/cancelled)
// = regressione da investigare (baseline post-#1919: redflag-fixer era al 56%).
const FAIL_RATE_WARN = 0.2;

function gh(args, { json = true } = {}) {
  const out = execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return json ? JSON.parse(out) : out;
}

function isoDaysAgo(d) {
  return new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 10);
}

function runStats(workflow, since) {
  let runs = [];
  try {
    runs = gh(['run', 'list', '--repo', REPO, '--workflow', workflow,
      '--created', `>${since}`, '--limit', '1000', '--json', 'conclusion,status']);
  } catch { /* workflow senza run nel periodo */ }
  const total = runs.length;
  const by = {};
  for (const r of runs) {
    const k = r.conclusion || r.status || 'unknown';
    by[k] = (by[k] || 0) + 1;
  }
  const real = total - (by.cancelled || 0) - (by.skipped || 0); // run che hanno lavorato
  const fail = by.failure || 0;
  return { total, real, fail, ok: by.success || 0, cancelled: by.cancelled || 0, skipped: by.skipped || 0, rate: real ? fail / real : 0 };
}

function mergedPrStats(since) {
  let prs = [];
  try {
    prs = gh(['pr', 'list', '--repo', REPO, '--state', 'merged',
      '--search', `merged:>${since}`, '--limit', '300', '--json', 'number,reviews']);
  } catch { /* noop */ }
  const claudeReviews = (pr) => (pr.reviews || []).filter((r) => /^claude/i.test(r.author?.login || '')).length;
  const merged = prs.length;
  const firstShot = prs.filter((p) => claudeReviews(p) <= 1).length;
  const totalReviews = prs.reduce((a, p) => a + claudeReviews(p), 0);
  return { merged, firstShot, totalReviews };
}

/** Zombie: issue follow-up con agent:fix, ferma da >24h, senza PR fix APERTA
 * (stessa semantica open-only del drainer post-#1919). */
function zombieCount() {
  let issues = [];
  try {
    issues = gh(['issue', 'list', '--repo', REPO, '--state', 'open',
      '--label', 'agent:fix', '--label', 'follow-up',
      '--json', 'number,updatedAt', '--limit', '100']);
  } catch { /* noop */ }
  const old = issues.filter((i) => Date.now() - Date.parse(i.updatedAt) > 24 * 3_600_000);
  let z = 0;
  for (const i of old) {
    try {
      const prs = gh(['pr', 'list', '--repo', REPO, '--head', `fix/issue-${i.number}`,
        '--state', 'open', '--json', 'number', '--limit', '1']);
      if (!Array.isArray(prs) || prs.length === 0) z++;
    } catch { /* conservativo: non contare */ }
  }
  return z;
}

function labelCount(label) {
  try {
    const out = gh(['issue', 'list', '--repo', REPO, '--state', 'open',
      '--label', label, '--json', 'number', '--limit', '200']);
    return Array.isArray(out) ? out.length : 0;
  } catch { return 0; }
}

function main() {
  if (!REPO) { console.error('GITHUB_REPOSITORY/GH_REPO mancante'); process.exit(1); }
  const since = isoDaysAgo(DAYS);
  const lines = [];
  const warns = [];

  lines.push(`## Loop health — ultimi ${DAYS}gg (dal ${since})`);
  lines.push('');
  lines.push('| Workflow Claude | run reali | ok | fail | rate | canc | skip |');
  lines.push('|---|---|---|---|---|---|---|');
  let claudePerDay = 0;
  for (const wf of CLAUDE_WORKFLOWS) {
    const s = runStats(wf, since);
    claudePerDay += s.real / DAYS;
    const flag = s.rate > FAIL_RATE_WARN && s.real >= 5 ? ' ⚠️' : '';
    if (flag) warns.push(`failure-rate ${(s.rate * 100).toFixed(0)}% su ${wf} (${s.fail}/${s.real} run reali)`);
    lines.push(`| ${wf}${flag} | ${s.real} | ${s.ok} | ${s.fail} | ${(s.rate * 100).toFixed(0)}% | ${s.cancelled} | ${s.skipped} |`);
  }
  lines.push('');
  lines.push(`**Invocazioni Claude ≈ ${claudePerDay.toFixed(0)}/giorno** (run reali, proxy token-burn).`);

  const pr = mergedPrStats(since);
  const fsRate = pr.merged ? pr.firstShot / pr.merged : 0;
  if (pr.merged >= 10 && fsRate < 0.5) warns.push(`first-shot LGTM rate ${(fsRate * 100).toFixed(0)}% (<50%)`);
  lines.push('');
  lines.push(`**PR merged:** ${pr.merged} (${(pr.merged / DAYS).toFixed(1)}/g) · first-shot LGTM ${pr.firstShot}/${pr.merged} (${(fsRate * 100).toFixed(0)}%) · review Claude totali ${pr.totalReviews} (overhead ${pr.merged ? ((pr.totalReviews / Math.max(pr.merged, 1) - 1) * 100).toFixed(0) : 0}%).`);

  const zombies = zombieCount();
  if (zombies > 0) warns.push(`${zombies} issue agent:fix zombie (>24h, nessuna PR aperta)`);
  const queued = labelCount('agent:fix-queued');
  const parked = labelCount('fu-parked');
  const needsHuman = labelCount('needs-human');
  lines.push(`**Backlog:** agent:fix zombie ${zombies} · in coda ${queued} · fu-parked ${parked} · needs-human ${needsHuman}.`);

  lines.push('');
  lines.push(warns.length
    ? `### ⚠️ Da investigare\n${warns.map((w) => `- ${w}`).join('\n')}`
    : '### ✅ Nessuna soglia superata');
  lines.push('');
  lines.push('_Report deterministico da loop-health-report.yml (zero-Claude). Baseline 2026-06-12 pre-tuning: ~89 run/g, redflag-fail 56%, first-shot 69%._');

  const report = lines.join('\n');
  console.log(report);

  if (NO_POST) return;
  // Find-or-create issue tracker, poi commenta il report (storico in un posto).
  let num = null;
  try {
    const found = gh(['issue', 'list', '--repo', REPO, '--state', 'open',
      '--search', `in:title "${TRACKER_TITLE}"`, '--json', 'number,title', '--limit', '5']);
    num = (found.find((i) => i.title === TRACKER_TITLE) || {}).number || null;
  } catch { /* noop */ }
  if (!num) {
    try {
      const url = gh(['issue', 'create', '--repo', REPO, '--title', TRACKER_TITLE,
        '--label', 'automation',
        '--body', 'Tracker permanente: il report settimanale di salute del loop autonomo atterra qui come commento (loop-health-report.yml, zero-Claude). NON chiudere: il prossimo run la ricreerebbe.'],
        { json: false });
      num = Number((url.match(/\/issues\/(\d+)/) || [])[1]) || null;
    } catch (e) { console.log(`::warning::create tracker fallita: ${String(e).slice(0, 160)}`); }
  }
  if (num) {
    try {
      gh(['issue', 'comment', String(num), '--repo', REPO, '--body', report], { json: false });
      console.log(`Report postato su #${num}.`);
    } catch (e) { console.log(`::warning::comment fallito: ${String(e).slice(0, 160)}`); }
  }
}

main();
