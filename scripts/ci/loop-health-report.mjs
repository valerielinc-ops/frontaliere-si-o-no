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
// Never eligible for followup-drainer's age-out close (#5615): a quiet stretch
// with nothing to report still makes this tracker look old+idle to the
// drainer, which would close it — the next run just recreates it, but the
// historical comment thread is lost. Checked in isAgeOutEligible
// (scripts/ci/followup-drainer.mjs); keep the literal in sync.
const LBL_NO_AGE_OUT = 'agent:no-age-out';

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
  // PUNTO CIECO NOTO, non una svista: `cancelled` NON è una cosa sola. GitHub marca
  // `cancelled` anche il job che sfonda `timeout-minutes` (è la premessa di
  // `scan-job-timeouts.mjs`), quindi un timeout esce sia da `fail` sia da `real` e questo
  // report non lo vede. Il discriminante esiste — `total_count` dei job della run, zero
  // per uno scarto in coda e >0 per un timeout: è quello che usa `hasNoJobs` in
  // `close-recovered-failure-issues.mjs` (#5333). Qui NON si applica per costo: sarebbe
  // una chiamata `gh api .../jobs` per run, su una finestra di 1000 run × 11 workflow.
  // Per i timeout la fonte giusta resta `scan-job-timeouts.mjs`, che li apre come issue.
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
  // === 1 (non <=1): una PR mergiata con ZERO review claude (merge manuale,
  // o reopen-path prima che la review atterri) non e' un "first-shot LGTM" —
  // contarla gonfierebbe la metrica (adversarial check review #1930).
  const firstShot = prs.filter((p) => claudeReviews(p) === 1).length;
  const zeroReview = prs.filter((p) => claudeReviews(p) === 0).length;
  const totalReviews = prs.reduce((a, p) => a + claudeReviews(p), 0);
  return { merged, firstShot, zeroReview, totalReviews };
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

/** Tracker issue number (find only — creation stays in the posting path). */
function findTracker() {
  try {
    const found = gh(['issue', 'list', '--repo', REPO, '--state', 'open',
      '--search', `in:title "${TRACKER_TITLE}"`, '--json', 'number,title', '--limit', '5']);
    return (found.find((i) => i.title === TRACKER_TITLE) || {}).number || null;
  } catch { return null; }
}

/**
 * Stable key for a warning, so a streak survives the numbers changing.
 * "failure-rate 53% su issue-fix.yml (54/102 run reali)" → "failure-rate:issue-fix.yml".
 */
export function warnKey(text) {
  const s = String(text || '');
  const wf = s.match(/\bsu ([a-z0-9-]+\.yml)/i);
  if (/failure-rate/i.test(s) && wf) return `failure-rate:${wf[1]}`;
  if (/first-shot LGTM rate/i.test(s)) return 'first-shot-lgtm';
  if (/agent:fix zombie/i.test(s)) return 'zombie';
  return s.replace(/\d+/g, '#').trim();
}

/**
 * How many CONSECUTIVE prior reports already carried each warning.
 *
 * A threshold line that has been on for two months and never changed state
 * carries no information: the reader learns nothing new from the ninth
 * identical "failure-rate 53% su issue-fix.yml". The count is what makes it
 * readable again — "1 report" is noise from a bad week, "9 consecutive" is an
 * escalation nobody acted on. Deliberately NOT a threshold change: the warning
 * still fires at exactly the same point (AGENTS.md Non-Negotiable #1), it just
 * says how long it has been firing.
 *
 * Source is the tracker's own prior comments — this script's own output — so
 * there is no new state file to keep in sync. Only the last `COMMENT_WINDOW`
 * comments are read, so a streak that reaches the far end of that window is
 * reported as a LOWER BOUND (`capped`) rather than as an exact count.
 *
 * @param {number|null} tracker issue number, or null when it does not exist yet
 * @returns {Map<string, {count: number, since: string, capped: boolean}>}
 */
export function warnStreaks(tracker, fetchComments = defaultFetchComments) {
  const streaks = new Map();
  if (!tracker) return streaks;
  const comments = fetchComments(tracker);
  if (!comments.length) return streaks;
  // Newest first: a streak ends at the first prior report that did NOT warn.
  const ordered = [...comments].reverse();
  const stillRunning = new Set();
  let first = true;
  let reportsSeen = 0;
  for (const body of ordered) {
    const text = String(body || '');
    if (!/^## Loop health/m.test(text)) continue;
    reportsSeen += 1;
    const section = text.split(/###\s*⚠️\s*Da investigare/)[1];
    const dateMatch = text.match(/\(dal (\d{4}-\d{2}-\d{2})\)/);
    const keys = new Set();
    if (section) {
      for (const line of section.split('\n')) {
        const bullet = line.match(/^-\s+(.*)$/);
        if (bullet) keys.add(warnKey(bullet[1]));
      }
    }
    if (first) {
      for (const k of keys) {
        streaks.set(k, { count: 1, since: dateMatch ? dateMatch[1] : '?', capped: false });
        stillRunning.add(k);
      }
      first = false;
      continue;
    }
    for (const k of [...stillRunning]) {
      if (keys.has(k)) {
        const cur = streaks.get(k);
        cur.count += 1;
        cur.since = dateMatch ? dateMatch[1] : cur.since;
      } else {
        stillRunning.delete(k);
      }
    }
    if (stillRunning.size === 0) break;
  }
  // Anything still running when the window ran out started before it.
  for (const k of stillRunning) {
    const cur = streaks.get(k);
    if (cur && cur.count === reportsSeen) cur.capped = true;
  }
  return streaks;
}

/** How far back a streak can be measured (tracker comments, newest last). */
const COMMENT_WINDOW = 14;

/** Last COMMENT_WINDOW tracker comments. Read-only; failures degrade to []. */
function defaultFetchComments(tracker) {
  try {
    const out = gh(['issue', 'view', String(tracker), '--repo', REPO, '--json', 'comments']);
    return (out.comments || []).slice(-COMMENT_WINDOW).map((c) => c.body || '');
  } catch { return []; }
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
  lines.push(`**PR merged:** ${pr.merged} (${(pr.merged / DAYS).toFixed(1)}/g) · first-shot LGTM ${pr.firstShot}/${pr.merged} (${(fsRate * 100).toFixed(0)}%, zero-review ${pr.zeroReview}) · review Claude totali ${pr.totalReviews} (overhead ${pr.merged ? ((pr.totalReviews / Math.max(pr.merged, 1) - 1) * 100).toFixed(0) : 0}%).`);

  const zombies = zombieCount();
  if (zombies > 0) warns.push(`${zombies} issue agent:fix zombie (>24h, nessuna PR aperta)`);
  const queued = labelCount('agent:fix-queued');
  const parked = labelCount('fu-parked');
  const needsHuman = labelCount('needs-human');
  lines.push(`**Backlog:** agent:fix zombie ${zombies} · in coda ${queued} · fu-parked ${parked} · needs-human ${needsHuman}.`);

  // Quanto dura ciascun allarme: una riga di soglia accesa da due mesi senza
  // mai cambiare stato non si legge più. Il conteggio la rende di nuovo
  // leggibile — "1 report" è rumore di una settimana storta, "9 consecutivi"
  // è un'escalation che nessuno ha raccolto.
  const tracker = findTracker();
  const streaks = warnStreaks(tracker);
  lines.push('');
  lines.push(warns.length
    ? `### ⚠️ Da investigare\n${warns.map((w) => {
      const s = streaks.get(warnKey(w));
      if (!s) return `- ${w} — **nuovo** questo report`;
      const n = `${s.capped ? '≥' : ''}${s.count + 1}`;
      return `- ${w} — sopra soglia da **${n} report consecutivi** (almeno dal ${s.since})`;
    }).join('\n')}`
    : '### ✅ Nessuna soglia superata');
  lines.push('');
  lines.push('_Report deterministico da loop-health-report.yml (zero-Claude). Baseline 2026-06-12 pre-tuning: ~89 run/g, redflag-fail 56%, first-shot 69%._');

  const report = lines.join('\n');
  console.log(report);

  if (NO_POST) return;
  // Find-or-create issue tracker, poi commenta il report (storico in un posto).
  let num = tracker;
  if (!num) {
    try {
      // Best-effort: `gh issue create --label` errors if the label doesn't
      // exist yet. `gh label create` errors if it already does — both fine.
      try { execFileSync('gh', ['label', 'create', LBL_NO_AGE_OUT, '--repo', REPO], { encoding: 'utf8' }); } catch { /* already exists */ }
      const url = gh(['issue', 'create', '--repo', REPO, '--title', TRACKER_TITLE,
        '--label', 'automation',
        '--label', LBL_NO_AGE_OUT,
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

// Guarded so the pure helpers above (warnKey/warnStreaks) can be unit-tested
// without the module firing a full network report on import.
if (import.meta.url === `file://${process.argv[1]}`) main();
