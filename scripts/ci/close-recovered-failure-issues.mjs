#!/usr/bin/env node
/**
 * close-recovered-failure-issues.mjs — zero-Claude reconciler.
 *
 * Auto-closes the auto-generated `Workflow Failure: <name>` / `Crawler Failure: <name>` /
 * `CI Failure: <name>` issues once the workflow has recovered — i.e. its NEXT run after
 * the failure is green. These three are the only failure-title prefixes minted by the
 * github-issue-creator.mjs reporters across all workflows (Crawler 439, Workflow 50, CI 8).
 *
 * WHY this is centralized (one reconciler, not 300 per-workflow steps):
 * Every scheduled workflow already opens a stable-titled issue on `if: failure()` via
 * scripts/lib/github-issue-creator.mjs. The mirror `--resolve` step (close on green) was
 * only ever wired into ~5 workflows (deploy/lighthouse/post-deploy/watchdog), so the
 * ~300 `update-jobs-*` crawlers, `update-fuel-prices`, `quality-alerts`, etc. left their
 * failure issue OPEN even when the very next run went green (e.g. #2354: failed run
 * 27646211111, then two green runs, issue stayed open). Wiring `--resolve` into every
 * workflow file = 300-file churn that silently misses any future workflow. Instead this
 * single cron job reconciles ALL of them — present and future — by construction.
 *
 * ALGORITHM for `Workflow Failure:` / `CI Failure:` issues:
 *   1. Parse the workflow display name out of the stable title prefix.
 *   2. Ask GitHub for that workflow's most-recent COMPLETED runs on `main` (one page,
 *      RUN_HISTORY_LIMIT rows — the run HISTORY, not just the head of it).
 *   3. If the latest one is `success` AND started after the issue was opened (so it is a
 *      run that happened *after* the reported failure, not a stale pre-failure green) →
 *      close the issue via the same resolveGithubIssue() the inline `--resolve` uses
 *      (posts the "✅ Auto-resolved — green again" comment; reopens automatically if the
 *      same failure recurs) — UNLESS one of the three HOLDS below applies, evaluated in
 *      this order: CHRONIC ESCALATION (the failure has recurred N times → label and never
 *      auto-close again), RECURRENCE GATE (the failure is still recurring in the recent
 *      window → hold and comment the count), STRUCTURAL HOLD (the last FIX_OUTCOME verdict
 *      says the written fix was never applied).
 *   4. Otherwise (latest completed run still red, or no completed run / renamed workflow)
 *      → leave the issue open. Bias is conservative: never close while currently red.
 *
 * ── STRUCTURAL HOLD (#5454): a green run is a statement about the SYMPTOM ──────────────
 *
 * Steps 1-3 close on the symptom. For a transient failure (a network `ETIMEDOUT`, a
 * provider 429) that is exactly right: the condition is gone and the issue is noise.
 * For a STRUCTURAL defect it is a loss, because the diagnosis written into the issue's
 * comments goes with it — and the defect returns the moment its condition recurs.
 *
 * MEASURED, both repos:
 *   - corpus #76 / #77, closed 2026-08-09T08:25:1{4,7}Z with "✅ Auto-resolved — the
 *     failing check is green again". Neither fix had been applied: `scripts/lib/
 *     npm-ci-retry.sh` was a 404 and `fast-publish-article.yml` still ran a bare
 *     `npm ci`. #77 was then REOPENED by a human at 12:13:57Z and re-closed by this
 *     very reconciler at 12:17:55Z — four minutes later.
 *   - this repo: `CI Failure: PR auto-rebase (near-merge only, no-Claude)` came back as a
 *     NEW issue EIGHT times in thirteen days (#4712, #4977, #5038, #5054, #5090, #5144,
 *     #5145, #5173) — same structural defect, a fresh issue each time because the
 *     previous one had been closed. Ten issues here have ever had a failure title and
 *     the `blocked-workflows-scope` label; all ten carried that marker as their LAST
 *     verdict, and six were auto-closed by this script on green.
 *
 * THE SIGNAL — the LAST `<!-- FIX_OUTCOME: <code> -->` marker in the issue's comments,
 * restricted to the three BLOCKED codes (see STRUCTURAL_OUTCOMES). That marker is the
 * fixer's own verdict: `blocked-*` means "the root cause was found and a fix was
 * written, and the automation cannot push it" — a permission/credential fact that no
 * amount of green changes. Parsed with the same regex and the same last-marker-wins rule
 * followup-drainer.mjs already uses, so there is one reading of the marker in the repo.
 *
 * WHY NOT the other two candidates — both were falsified against the incident, not
 * reasoned about:
 *   - the `blocked-workflows-scope` LABEL: absent from corpus #76/#77 (labels were
 *     `bug, agent:triaged, fu-prio:high, fu-parked, priority:high`). Only
 *     check-workflows-scope.mjs's applyBlockedOutcome() applies it, and that function
 *     posts the SAME marker in the same breath; the followup-drainer pre-flight path
 *     that actually parked #76/#77 posts the marker with NO label. Marker ⊋ label: the
 *     label adds zero coverage where the marker fires and misses the incident itself.
 *   - the `fu-parked` LABEL: too wide, and wide in the worst direction. The drainer
 *     parks after MAX_ATTEMPTS, and the documented road to `fu-attempt:3 → fu-parked`
 *     runs through three Claude quota 429s (followup-drainer.mjs, claude-rate-limit.mjs
 *     naming #5004/#5001/#4974). `fu-parked` therefore means "out of the active queue",
 *     transient causes included — holding on it would pin open the exact class this
 *     reconciler exists to close.
 *
 * THE OPPOSITE RISK — a hold that never releases turns the queue into a graveyard, and
 * scan-failed-runs.mjs opens one issue per failing workflow. Four bounded valves:
 *   1. The hold RELEASES ITSELF. Only the LAST marker counts, so when the fix finally
 *      lands the next verdict (`pr-created`, `already-fixed`) makes the issue closeable
 *      and this reconciler closes it on the following pass. No human bookkeeping.
 *   2. Holding SHRINKS the queue for a recurring defect instead of growing it.
 *      createGithubIssue() dedups against OPEN issues by title prefix and comments on
 *      the match rather than minting a duplicate — so one held issue absorbs every
 *      recurrence. The `PR auto-rebase` defect above would have been 1 issue, not 8.
 *      Replayed over the last 250 closed issues here: of the 33 that this reconciler
 *      auto-closed, 26 still close and 7 would be held — and those 7 collapse to 4
 *      distinct titles, i.e. 4 open issues in steady state.
 *   3. A TTL (HOLD_MAX_DAYS, default 14). A blocked verdict that is still the last word
 *      after 14 days, with the check green, is a stale diagnosis, not a live fix: the
 *      issue closes anyway, with a comment saying so. 14 is above every observed
 *      lifetime of a `blocked-workflows-scope` issue in this repo (31 issues ever, max
 *      8.7 days, second-longest 3.9) — so it is a ceiling, not a schedule.
 *   4. Comments unreadable → hold, but only until the TTL measured from the issue's own
 *      createdAt. A permanently broken comment read degrades to "closes 14 days late",
 *      never to "never closes".
 *
 * The hold posts ONE comment (idempotent via HOLD_MARKER) and leaves the issue open. It
 * never reopens and never closes something it did not decide to close: the structural
 * hold's blast radius stays "close or don't close".
 *
 * IT DOES LABEL, though — since the chronic-recurrence gate (#249). The blast radius is
 * NOT "never edits" any more, and pretending otherwise is how the next reader gets
 * surprised: `applyChronicLabels()` runs `gh issue edit --add-label priority:urgent
 * --add-label needs-human --remove-label priority:high|medium|low` when a failure
 * recurs past threshold, and `clearChronicLabels()` takes them back off when it stops.
 * Both are best-effort: a failing `gh` never changes the close/don't-close verdict.
 *
 * ALGORITHM for `Crawler Failure:` issues — DIFFERENT since the crawler-workflow
 * consolidation (2026-07, see scripts/generate-crawler-group-workflows.mjs): 581
 * individual per-crawler workflows were replaced by 23 grouped `crawler-group-*.yml`
 * workflows, each running ~25 crawlers as concurrent `background: true` steps inside
 * ONE job. `Crawler Failure:` titles now embed `Run <slug>` (the crawler's OWN
 * background-step name, baked in as a literal at generation time — see that script's
 * "HAZARD FIX 3" comment) instead of a dispatchable workflow name, because
 * `${{ github.workflow }}` would otherwise resolve to the shared GROUP's name for every
 * crawler in it. `Run <slug>` cannot be looked up via `gh run list -w <name>` (it isn't a
 * workflow) — it identifies one STEP inside a group's shared job. So for these:
 *   1. Extract the crawler slug from `Run <slug>`.
 *   2. Find which `crawler-group-*.yml` file currently contains that crawler (greps each
 *      group file's `id: crawler-<slug>` markers — group membership can shift whenever
 *      the generator re-runs, so this is resolved fresh each time, not cached).
 *   3. Ask GitHub for that GROUP workflow's most-recent COMPLETED run on `main`.
 *   4. Fetch that run's job(s) via the Jobs API and find the STEP named `Run <slug>`
 *      inside it — steps have their OWN independent `conclusion` in the API response
 *      (confirmed empirically against a live run using this repo's other background-step
 *      workflow), so a sibling crawler's failure in the same job does NOT affect this
 *      step's own conclusion.
 *   5. If that STEP's conclusion is `success` and the run started after the issue was
 *      opened → close, exactly as the non-crawler path (structural hold included).
 *      Otherwise keep open.
 *   If the crawler can't be found in any current group file (renamed/removed), or the
 *   step can't be found in the run's job list (renamed background step id) → keep open
 *   (same conservative bias as the "no completed run" case).
 *
 * Best-effort and idempotent: safe to run on a schedule. `--dry-run` reports without
 * mutating. Scope is strictly the three auto-generated failure-title prefixes; follow-up,
 * tracker, validation-failure and other issues are never touched.
 *
 * Known edge: a workflow whose failure title names something that does NOT equal its
 * `name:` won't resolve via `gh run list -w <title>` → its issue stays open forever
 * (conservative/safe, but indistinguishable from "covered" by eye — the title HAS the
 * right prefix, so this reconciler picks it up and then finds no run).
 *
 * This docstring used to claim `persist-job-stats` was the ONLY such workflow. It was
 * not — there were three — and the count is now MEASURED rather than asserted, by
 * `node scripts/ci/failure-issue-inventory.mjs --json` (rows carrying a `detail`), and
 * pinned as a shrink-only baseline in tests/failure-issue-closers.test.ts.
 *
 * As of #5437 that baseline is EMPTY: all three (persist-job-stats, fast-publish-article,
 * crawl-events) now build their title from `${{ github.workflow }}` instead of a
 * hand-copied literal, so the title cannot drift from the `name:` even if the workflow is
 * renamed later. The renames were done in the one window where they were safe — no issue
 * with any of the OLD titles was open at the time (`gh issue list --state open --search
 * 'in:title "<old>"'`, empty for all three), because dedup is by title and a rename
 * orphans whatever is already open.
 *
 * If a new mismatch ever appears, fixing it belongs in its own workflow file, not here,
 * and under the same window rule.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveGithubIssue, commentOnGithubIssue } from '../lib/github-issue-creator.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const WORKFLOWS_DIR = path.join(REPO_ROOT, '.github', 'workflows');

const DRY_RUN = process.argv.includes('--dry-run');
// Stable titles minted by github-issue-creator.mjs failure reporters. For `Workflow`/`CI`
// prefixes, group 2 is the workflow display name (equals `github.workflow` and `gh run
// list -w <name>`). For `Crawler` prefixes (post-consolidation), group 2 is instead the
// literal `Run <slug>` background-step identifier — see the module docstring above.
export const TITLE_RE = /^(?:Workflow|Crawler|CI) Failure: (.+)$/;
export const CRAWLER_STEP_RE = /^Run (.+)$/;
const REPO = process.env.GH_REPO || process.env.GITHUB_REPOSITORY || '';
// I crawler vengono ancora definiti nel sito, ma dopo la migrazione cross-repo le
// loro run possono vivere nel corpus. Il workflow del sito imposta questo override;
// il gemello del corpus resta sul default locale.
const CRAWLER_RUN_REPO = process.env.CRAWLER_RUN_REPO || REPO;
// Separato dal token che modifica le issue del sito: GITHUB_TOKEN e' limitato
// al repository della run e non puo' leggere Actions nel corpus.
const CRAWLER_RUN_GH_TOKEN = process.env.CRAWLER_RUN_GH_TOKEN
  || process.env.GITHUB_PAT_NANAKO
  || '';

// ── Structural hold (#5454) ───────────────────────────────────────────────────────────

// Canonical shape of the `<!-- FIX_OUTCOME: <code> -->` marker the fixer posts.
// Defined HERE and imported by the other scripts/ci consumers (followup-drainer,
// needs-human-prepass, harvest-agent-lessons): re-declaring the literal per file
// let the parsers drift apart silently. This module keeps it as a local literal
// rather than importing it from a shared lib because it is `mode: identical` in
// the corpus loop-sync manifest and must stay copyable with only
// scripts/lib/github-issue-creator alongside it — a constraint on what it may
// import, not on who may import FROM it (same as `TITLE_RE`).
export const FIX_OUTCOME_RE = /<!--\s*FIX_OUTCOME:\s*([a-z0-9-]+)\s*-->/i;

/**
 * Verdicts that mean "root cause found, fix written, automation cannot apply it".
 * Deliberately NOT the whole FIX_OUTCOME vocabulary:
 *   `pr-created`     → the fix is in flight and its PR carries `Closes #n`; holding here
 *                      would double-handle what the PR layers already own.
 *   `already-fixed`  → applied by definition.
 *   `no-root-cause`  → nothing was written down, so closing loses nothing — holding it
 *                      would be pure graveyard.
 *   `overlap-skip` / `pr-already-open` → scheduling, resolved by the next pass.
 *   `rate-limited`   → transient by construction; check-quota-backoff.mjs re-queues.
 */
export const STRUCTURAL_OUTCOMES = Object.freeze([
  'blocked-workflows-scope',
  'blocked-secrets',
  'blocked-admin-settings',
]);

/** Idempotency marker for the "held open" comment — posted once, never per pass. */
export const HOLD_MARKER = '<!-- CLOSE_RECOVERED: structural-hold -->';

/** Graveyard valve. See docstring valve 3 for why 14 and not "forever". */
// 9, non 14. Il `followup-drainer` — anch'esso `mode: identical`, quindi vivo
// su entrambi i repo — chiude per age-out a FOLLOWUP_AGEOUT_DAYS=10 le issue
// che `classifyIssue` instrada in coda, e i titoli «Workflow Failure:» /
// «CI Failure:» ci finiscono tutti (osservato: #4641 chiusa a 13,4 giorni con
// «Auto-chiusa dal followup-drainer»). Un TTL a 14 sarebbe quindi in gran parte
// IRRAGGIUNGIBILE: la diagnosi verrebbe buttata da un altro strato, ~4 giorni
// prima, con una nota («mai entrato in lavorazione») falsa per una issue tenuta
// apposta. Stare sotto i 10 rende questo TTL quello che decide davvero.
export const DEFAULT_HOLD_MAX_DAYS = 9;

function holdMaxDays() {
  const raw = Number(process.env.CLOSE_RECOVERED_HOLD_MAX_DAYS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_HOLD_MAX_DAYS;
}

/**
 * The LAST `<!-- FIX_OUTCOME: <code> -->` in a comment list, as `{ code, at }`, or null.
 *
 * "Last" is by comment timestamp, not array position: the REST listing is oldest-first
 * today, but ordering is not part of that contract and a wrong pick here inverts the
 * decision (an old `blocked-*` beating a newer `pr-created` would pin the issue open
 * forever). Comments without a parseable timestamp keep their relative array position,
 * so a caller passing plain `{ body }` objects still gets last-wins.
 *
 * Accepts both `createdAt` (gh --json) and `created_at` (REST) spellings.
 *
 * @param {Array<{body?: string, createdAt?: string, created_at?: string}>} comments
 */
export function lastFixOutcome(comments) {
  if (!Array.isArray(comments)) return null;
  const ordered = comments
    .map((c, i) => {
      const stamp = Date.parse(c?.createdAt ?? c?.created_at ?? '');
      return { c, i, t: Number.isNaN(stamp) ? null : stamp };
    })
    .sort((a, b) => (a.t !== null && b.t !== null && a.t !== b.t ? a.t - b.t : a.i - b.i));

  let found = null;
  for (const { c, t } of ordered) {
    const m = FIX_OUTCOME_RE.exec(String(c?.body || ''));
    if (m) found = { code: m[1].toLowerCase(), at: t };
  }
  return found;
}

/** True when any comment already carries the hold marker (so we comment once). */
export function alreadyHeld(comments) {
  return Array.isArray(comments)
    && comments.some((c) => String(c?.body || '').includes(HOLD_MARKER));
}

/**
 * Decide whether a recovered issue must be HELD OPEN instead of closed.
 *
 * Called only once the check is already green and the green run post-dates the issue —
 * i.e. exactly at the moment the old code would have closed.
 *
 * @param {Array|null} comments  the issue's comments, or `null` when unreadable
 * @param {{ issueCreatedAt?: string, now?: number, maxDays?: number }} [opts]
 * @returns {{ hold: boolean, code: string|null, unknown: boolean, notified: boolean,
 *            ageDays: number|null, reason: string }}
 */
export function decideStructuralHold(comments, opts = {}) {
  const now = opts.now ?? Date.now();
  const maxDays = opts.maxDays ?? holdMaxDays();
  const ageInDays = (ms) => (now - ms) / 86400000;

  // Unreadable comments: we cannot tell transient from structural. Hold — but bounded by
  // the SAME TTL, measured on the issue itself, so a permanently failing read degrades
  // to "closes late", not "never closes". `notified: true` suppresses the comment: we
  // would not be able to see our own marker, so posting one would spam every pass.
  if (comments === null || comments === undefined) {
    const opened = Date.parse(opts.issueCreatedAt ?? '');
    const age = Number.isNaN(opened) ? null : ageInDays(opened);
    if (age !== null && age > maxDays) {
      return {
        hold: false,
        code: null,
        unknown: true,
        notified: true,
        ageDays: age,
        reason: `comments unreadable and issue is ${age.toFixed(1)}d old (> ${maxDays}d TTL) — closing`,
      };
    }
    return {
      hold: true,
      code: null,
      unknown: true,
      notified: true,
      ageDays: age,
      reason: 'comments unreadable — holding until the next pass (bounded by the TTL)',
    };
  }

  const verdict = lastFixOutcome(comments);
  if (!verdict) {
    return { hold: false, code: null, unknown: false, notified: false, ageDays: null, reason: 'no FIX_OUTCOME verdict — transient by default' };
  }
  if (!STRUCTURAL_OUTCOMES.includes(verdict.code)) {
    return { hold: false, code: verdict.code, unknown: false, notified: false, ageDays: null, reason: `last verdict '${verdict.code}' is not structural` };
  }

  // F3: un verdetto il cui commento non ha timestamp parsabile lasciava `age`
  // a null, saltava il ramo TTL e teneva la issue in hold PER SEMPRE — cioe'
  // la quinta valvola non c'era. Si ricade sull'eta' della issue, esattamente
  // come fa gia' il ramo «commenti illeggibili» qui sopra: un hold non deve
  // mai poter essere illimitato, qualunque cosa non si riesca a leggere.
  let age = verdict.at === null ? null : ageInDays(verdict.at);
  if (age === null) {
    const opened = Date.parse(opts.issueCreatedAt ?? '');
    if (!Number.isNaN(opened)) age = ageInDays(opened);
  }
  if (age !== null && age > maxDays) {
    return {
      hold: false,
      code: verdict.code,
      unknown: false,
      notified: alreadyHeld(comments),
      ageDays: age,
      reason: `structural verdict '${verdict.code}' is ${age.toFixed(1)}d old (> ${maxDays}d TTL) — stale diagnosis, closing`,
    };
  }
  return {
    hold: true,
    code: verdict.code,
    unknown: false,
    notified: alreadyHeld(comments),
    ageDays: age,
    reason: `last verdict '${verdict.code}' is structural — the written fix was never applied`,
  };
}

/** The one comment the hold posts. Contains HOLD_MARKER, which makes it idempotent. */
export function structuralHoldNote({ code, workflow, runUrl, maxDays = DEFAULT_HOLD_MAX_DAYS } = {}) {
  return [
    `⏸️ **Sintomo rientrato, issue tenuta aperta.** L'ultimo run${workflow ? ` di \`${workflow}\`` : ''} è verde${runUrl ? ` (${runUrl})` : ''}, quindi il *sintomo* non c'è più.`,
    '',
    `Non la chiudo: l'ultimo verdetto registrato qui è \`${code}\`, cioè la root cause è stata trovata e **il fix è scritto nei commenti ma non è mai stato applicato** (l'automazione non ha i permessi per pusharlo). Il guasto è strutturale: si ripresenta appena ricapita la condizione che l'ha causato, e chiuderla ora butterebbe via il fix già scritto.`,
    '',
    `Si sblocca da sola: appena il fix atterra, il verdetto successivo (\`pr-created\` / \`already-fixed\`) rende la issue di nuovo chiudibile e questo reconciler la chiude al giro dopo, senza che nessuno debba toccarla.`,
    '',
    `Valvola anti-cimitero: se \`${code}\` resta l'ultimo verdetto per più di ${maxDays} giorni con il check verde, la issue viene chiusa comunque.`,
    '',
    HOLD_MARKER,
  ].join('\n');
}

/** The note posted just before a TTL-released close, so the close is never silent. */
export function ttlReleaseNote({ code, maxDays = DEFAULT_HOLD_MAX_DAYS, ageDays } = {}) {
  const age = typeof ageDays === 'number' ? `${ageDays.toFixed(1)} giorni` : `oltre ${maxDays} giorni`;
  return [
    `🗓️ **Chiusa dopo il TTL del hold strutturale.** Il verdetto \`${code}\` è fermo da ${age} (soglia: ${maxDays}) e nel frattempo il check è tornato verde e non è più fallito.`,
    '',
    'Una diagnosi che nessuno applica per così a lungo, su un guasto che non si ripresenta, è una diagnosi stantia — non un fix in coda. Se il guasto torna, il reporter riapre questa stessa issue (dedup per titolo) con il contesto nuovo.',
  ].join('\n');
}

// ── Recurrence gate (#249) ────────────────────────────────────────────────────────────
//
// IL DIFETTO CHE CHIUDE. Fino a qui il reconciler rispondeva a una sola domanda —
// «l'ULTIMA run è verde?» — e su un guasto INTERMITTENTE quella domanda ha sempre
// risposta sì: un fallimento al 20% produce una run verde entro pochi minuti. La
// issue si chiude, il reporter la riapre alla ricorrenza successiva, e il ciclo
// gira all'infinito senza che nessuno la veda mai aperta.
//
// MISURATO su questo repo (2026-08-18), issue #249 `Workflow Failure: Generate Blog
// Article`, il guasto che stava bruciando più produzione di qualunque altro:
//   - 42 run di `generate-article.yml` su 69 fallimenti dal 13-08 sono un wedge
//     (processo piantato, SIGKILL a 2400+60s): 26,6 ore di runner in 5 giorni, e
//     dal 17-08 è l'UNICA causa di fallimento (12 su 12 il 17, 2 su 2 il 18);
//   - la issue ha 83 commenti, 45 dei quali `🔁` di ricorrenza, ed è stata
//     auto-chiusa 37 volte in 7 giorni. Vive fra i 5 e i 40 minuti per volta,
//     quindi non entra MAI né nella coda del fixer né in un triage umano.
// È il rovescio dello «stato orfano»: lì il ciclo lasciava appeso un lavoro morto,
// qui cancella un segnale vivo.
//
// LA MISURA CHE DISCRIMINA, e perché non è il verde. Replay dei 36 momenti di
// auto-chiusura di #249 coperti dallo storico run (`gh run list -w 'Generate Blog
// Article' -b main -L 900`):
//   - streak di run verdi consecutive al momento della chiusura: min 0, mediana 4,
//     MAX 19. Una soglia sulla sola streak non discrimina niente — 19 verdi di fila
//     su un guasto che il giorno dopo brucia altre 12 run;
//   - fallimenti nelle 24h precedenti: MIN 6, mediana 17. Nelle 6h precedenti:
//     MIN 2, mediana 4. Cioè: in ognuna delle 36 chiusure il guasto aveva già
//     colpito almeno due volte nella finestra recente.
// Il conteggio dei fallimenti in una finestra RECENTE è quindi il segnale, e la
// streak da sola non lo è. Restano entrambe le condizioni perché la streak copre
// il caso opposto, osservato: 2 chiusure su 36 sono avvenute con l'ultima run
// completata ROSSA (corsa fra il listing e la run in corso).
//
// I PARAMETRI, e la misura da cui escono. Finestra 8h, `maxRecurrences` 1,
// `minGreenStreak` 3, valvola sul tasso al 2%. Replay in avanti (passata oraria
// dal primo auto-close coperto dallo storico) su tutte le 9 issue di fallimento
// con storico run disponibile:
//   - 8 su 9 si chiudono lo stesso, con ritardo mediano ~6h (0h, 0h, 1h, 2h, 5h,
//     6h, 9h, 13h) rispetto alla chiusura di oggi;
//   - #249 NON si chiude mai nei 5,5 giorni di storico — che è il risultato voluto,
//     perché il guasto in quei 5,5 giorni non è mai stato risolto.
// Finestre più larghe (18h/24h) tengono aperte anche #411 e #412 (5-8 fallimenti
// in 24h, fast-publish-article e Publish article data API): stringono troppo, e
// il numero di chiusure crolla da 9 a 6. Finestre più strette (6h) lasciano
// chiudere anche #249 (dopo 77h). 8h è il punto in cui le due curve si separano.
//
// PERCHÉ ANCHE UNA VALVOLA SUL TASSO. Il conteggio assoluto penalizza i workflow ad
// alta cadenza: `Generate Blog Article` gira ~170 volte al giorno, quindi 2
// fallimenti in 8h sono l'1,2% delle sue run. Senza valvola, un workflow che gira
// ogni 5 minuti resterebbe pinnato aperto da un flake trascurabile. Con la valvola
// al 2% il caso trascurabile chiude comunque — e NON copre #249: nei 36 momenti di
// chiusura il suo tasso su 24h era al minimo 4,9% (mediana 12%), sempre sopra.
//
// PERCHÉ NON CAMBIA NIENTE PER I WORKFLOW LENTI. Se nella finestra non è fallito
// niente (`failures === 0`) si chiude subito, senza chiedere la streak: un cron
// giornaliero che ha fallito una volta ed è tornato verde ha finestra vuota, e
// deve chiudersi come si chiudeva prima. Il requisito 1 — la chiusura automatica
// resta per il guasto transitorio davvero rientrato — è qui, non altrove.

/** La finestra recente su cui si misura la ricorrenza. Vedi la misura qui sopra. */
export const DEFAULT_RECURRENCE_WINDOW_HOURS = 8;
/** Fallimenti tollerati nella finestra: 1 è quello che ha aperto la issue. */
export const DEFAULT_MAX_RECURRENCES = 1;
/** Run verdi consecutive richieste quando nella finestra c'è stato un fallimento. */
export const DEFAULT_MIN_GREEN_STREAK = 3;
/** Valvola per i workflow ad alta cadenza: sotto questo tasso il flake non pinna. */
export const DEFAULT_MAX_FAILURE_RATE = 0.02;

function envNumber(name, fallback, { min = 0 } = {}) {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= min ? raw : fallback;
}

function recurrenceOptions() {
  return {
    windowHours: envNumber('CLOSE_RECOVERED_WINDOW_HOURS', DEFAULT_RECURRENCE_WINDOW_HOURS, { min: 1 }),
    maxRecurrences: envNumber('CLOSE_RECOVERED_MAX_RECURRENCES', DEFAULT_MAX_RECURRENCES),
    minGreenStreak: envNumber('CLOSE_RECOVERED_MIN_GREEN_STREAK', DEFAULT_MIN_GREEN_STREAK, { min: 1 }),
    maxFailureRate: envNumber('CLOSE_RECOVERED_MAX_FAILURE_RATE', DEFAULT_MAX_FAILURE_RATE),
  };
}

/**
 * Decide whether a recovered issue must be HELD OPEN because the failure RECURS.
 *
 * Pure: takes the run history it is given, never calls `gh`. `runs` is the workflow's
 * COMPLETED runs, newest-first, as `recentCompletedRuns()` returns them; `null` (or an
 * empty list) means "no history available" — the crawler-step path, where a per-run Jobs
 * API call per historical run would be unaffordable. In that case the gate is a NO-OP and
 * the old behaviour stands, deliberately: silently changing the crawler family, which has
 * a different reporter and a different cadence, on a measurement taken on the workflow
 * family is exactly the kind of unannounced side effect this repo keeps biting on.
 *
 * SCOPE OF THAT PROMISE: it covers THIS gate only, and it is a cost argument, not a
 * semantic one. The chronic-recurrence gate further down reads the issue's COMMENTS,
 * which cost the same single call for every family, so it does apply to
 * `Crawler Failure:` — measured on that family, see the "SOGLIA" block there. Do not
 * read "the crawler family is untouched" out of this paragraph: it is not true of the
 * file as a whole, and #5139 is the issue that proves it.
 *
 * @param {Array<{conclusion?: string, createdAt?: string}>|null} runs newest-first
 * @param {{ now?: number, windowHours?: number, maxRecurrences?: number,
 *           minGreenStreak?: number, maxFailureRate?: number }} [opts]
 * @returns {{ hold: boolean, failures: number, sample: number, rate: number,
 *             streak: number, windowHours: number, measured: boolean, reason: string }}
 */
export function decideRecurrenceHold(runs, opts = {}) {
  const now = opts.now ?? Date.now();
  const defaults = recurrenceOptions();
  const windowHours = opts.windowHours ?? defaults.windowHours;
  const maxRecurrences = opts.maxRecurrences ?? defaults.maxRecurrences;
  const minGreenStreak = opts.minGreenStreak ?? defaults.minGreenStreak;
  const maxFailureRate = opts.maxFailureRate ?? defaults.maxFailureRate;
  const none = (reason) => ({
    hold: false, failures: 0, sample: 0, rate: 0, streak: 0, windowHours, measured: false, reason,
  });

  if (!Array.isArray(runs) || runs.length === 0) {
    return none('no run history available — recurrence gate not applicable');
  }

  // Streak over the WHOLE history, not just the window: a long green streak that
  // predates the window is still evidence, and a workflow slower than the window
  // would otherwise have no streak at all.
  let streak = 0;
  for (const r of runs) {
    if (r?.conclusion === 'success') streak++;
    else break;
  }

  const cutoff = now - windowHours * 3600 * 1000;
  const window = runs.filter((r) => {
    const t = Date.parse(r?.createdAt ?? '');
    return !Number.isNaN(t) && t >= cutoff;
  });
  const failures = window.filter((r) => r.conclusion !== 'success').length;
  const sample = window.length;
  const rate = sample ? failures / sample : 0;
  const pct = (rate * 100).toFixed(1);
  const stat = `${failures} fallimenti su ${sample} run in ${windowHours}h (${pct}%), streak verde ${streak}`;

  if (failures === 0) {
    return {
      hold: false, failures, sample, rate, streak, windowHours, measured: true,
      reason: `nessun fallimento nella finestra di ${windowHours}h — transitorio rientrato`,
    };
  }
  if (streak >= minGreenStreak && failures <= maxRecurrences) {
    return {
      hold: false, failures, sample, rate, streak, windowHours, measured: true,
      reason: `${stat} — un solo fallimento e ${streak} verdi dopo: transitorio`,
    };
  }
  if (streak >= minGreenStreak && rate <= maxFailureRate) {
    return {
      hold: false, failures, sample, rate, streak, windowHours, measured: true,
      reason: `${stat} — sotto la soglia del ${(maxFailureRate * 100).toFixed(1)}% su un workflow ad alta cadenza`,
    };
  }
  return {
    hold: true, failures, sample, rate, streak, windowHours, measured: true,
    reason: `${stat} — il guasto RICORRE: una run verde non lo risolve`,
  };
}

/** Marker di idempotenza del commento di ricorrenza: uno per passata di hold. */
export const RECURRENCE_HOLD_MARKER = '<!-- CLOSE_RECOVERED: recurrence-hold -->';

/** True quando il commento di ricorrenza è già stato postato dopo l'ultima riapertura. */
export function alreadyRecurrenceHeld(comments) {
  // Commenti illeggibili → `true`, cioè "non postare". Stessa scelta del
  // `notified: true` dello structural hold sullo stesso caso: non potendo vedere il
  // nostro marker, postare vorrebbe dire riscrivere il commento a OGNI passata oraria.
  // L'hold resta comunque in piedi: si perde la notifica, non la decisione.
  if (!Array.isArray(comments)) return true;
  // Solo DOPO l'ultima ricorrenza: se il guasto è tornato dopo il nostro commento, il
  // conteggio è cambiato e va riscritto. Senza questo, il conteggio nel thread resta
  // fermo al primo hold e la issue smette di dire quanto sta bruciando.
  let lastRecurrence = -1;
  let lastHold = -1;
  comments.forEach((c, i) => {
    const body = String(c?.body || '');
    if (body.includes(RECURRENCE_MARKER)) lastRecurrence = i;
    if (body.includes(RECURRENCE_HOLD_MARKER)) lastHold = i;
  });
  return lastHold > lastRecurrence;
}

/** Il commento che il recurrence hold posta. Contiene il conteggio, che è il punto. */
export function recurrenceHoldNote({ workflow, runUrl, decision } = {}) {
  const d = decision || {};
  return [
    `⏸️ **Ultima run verde, issue tenuta aperta: il guasto ricorre.** L'ultima run${workflow ? ` di \`${workflow}\`` : ''} è verde${runUrl ? ` (${runUrl})` : ''}, ma una run verde risponde a «il sintomo è tornato adesso?», non a «il guasto è stato risolto?».`,
    '',
    `**Misura sulle ultime ${d.windowHours ?? DEFAULT_RECURRENCE_WINDOW_HOURS}h di run su \`main\`:** ${d.failures ?? '?'} fallimenti su ${d.sample ?? '?'} run completate (${(((d.rate ?? 0) * 100)).toFixed(1)}%), con ${d.streak ?? '?'} run verdi consecutive in coda.`,
    '',
    'Un guasto intermittente produce sempre una run verde subito dopo: chiudere qui vorrebbe dire cancellare il segnale e riaprirlo alla ricorrenza successiva, senza che la issue resti aperta abbastanza da entrare in una coda. Si chiude da sola appena la finestra recente torna pulita — nessun intervento manuale richiesto.',
    '',
    RECURRENCE_HOLD_MARKER,
  ].join('\n');
}

// ── Chronic escalation (#249) ─────────────────────────────────────────────────────────
//
// Il gate qui sopra impedisce la chiusura FINCHÉ il guasto è caldo. Manca il caso
// cronico: una issue riaperta decine di volte in pochi giorni non deve ricominciare
// il ciclo nemmeno quando la finestra si sgombra per qualche ora — deve diventare
// VISIBILE e restare aperta. Il conteggio esiste già ed è leggibile senza inventare
// niente: `scripts/lib/github-issue-creator.mjs` marca OGNI ricorrenza con `🔁`
// (`RECURRENCE_MARKER`), sia la riapertura di una issue chiusa sia il commento su
// una issue già aperta, e `countRecentFailureEvents()` lì conta gli stessi commenti.
//
// QUESTO GATE VALE PER TUTTE E TRE LE FAMIGLIE, `Crawler Failure:` COMPRESA.
// È il punto in cui differisce dal gate di ricorrenza qui sopra, e la differenza non
// è un'incoerenza: quel gate legge lo STORICO DELLE RUN, che per uno step di
// background costerebbe una chiamata alla Jobs API per ogni run storica, e per questo
// lì è un no-op dichiarato. Questo legge i COMMENTI della issue, che costano una sola
// chiamata identica per ogni famiglia. Non c'è quindi una ragione di costo per
// esentare i crawler, e la ragione semantica punta nel verso opposto (vedi sotto).
//
// SOGLIA — misurata su DUE famiglie, perché sono due popolazioni diverse.
//
// Famiglia `Workflow Failure:`, 22 issue di fallimento chiuse di questo repo (massimo
// di commenti `🔁` in una finestra mobile di 168h): #249 → 45; #411 → 3; #62 → 2; le
// altre 19 → 0. Bimodale, nessuna coda da tarare: a 5 il gate scatta su #249 e su
// nessun'altra. #249 avrebbe superato la soglia già alla quinta ricorrenza, cioè
// giorni prima che il costo arrivasse a 26,6 ore.
//
// Famiglia `Crawler Failure:`, campione delle 60 issue chiuse più recenti del sito
// (`valerielinc-ops/frontaliere-si-o-no`, misurato il 2026-08-18 — è lì che vive
// questa famiglia: qui il corpus non ha crawler). Stesso massimo mobile a 168h:
// 54/60 → 0; poi 1, 2, 2, 4, 6, 9. Bimodale anche questa, con lo stacco fra 2 e 4.
// A 5 il gate scatta su 2/60 (3,3%): #5017 (9) e #4731 (6). La soglia misurata sulla
// famiglia `Workflow` regge quindi anche qui — ma ora è misurata, non presunta, ed è
// questa riga il motivo per cui `Crawler Failure:` non è esentata.
//
// PERCHÉ NON ESENTARLA. Al 2026-08-18 l'unica issue crawler aperta sul sito è #5139
// `Crawler Failure: Run grace`: 6 commenti `🔁` fra il 15-08 21:57 e il 18-08 09:55,
// e già `fu-parked` — cioè il drainer ha esaurito MAX_ATTEMPTS e ha smesso. È il caso
// #249 esatto su un'altra famiglia: esentare i crawler vorrebbe dire lasciare che il
// solo guasto cronico oggi osservabile continui a essere auto-chiuso a ogni run verde
// e riaperto alla ricorrenza dopo, che è il difetto che questo file ripara.
//
// I LABEL. `priority:urgent` perché il costo misurato lo è, e `needs-human` perché
// l'automazione ha già provato e si è fermata da sola: #249 porta `fu-parked`, che il
// drainer mette dopo MAX_ATTEMPTS. Gli altri `priority:*` vengono tolti, come fa
// `setIssuePriorityLabel()` nel creator, per non lasciare due priorità in conflitto
// sulla stessa issue. Best-effort: se un label non esiste nel repo, `gh` fallisce e
// il gate resta comunque un hold — il label è la visibilità, non la decisione.
//
// I LABEL SI TOLGONO. `needs-human` è un filtro di ESCLUSIONE, non un selettore:
// `scripts/ci/followup-drainer.mjs` lo usa per tenere una issue fuori dal pool dei
// retry parcheggiati (:1091) e fuori dal rescue `agent:fix` dei crawler (:1204).
// Applicarlo e non toglierlo mai renderebbe l'escalation una porta a senso unico: la
// issue si richiuderebbe quando la finestra si svuota, ma una riapertura successiva
// ripartirebbe già esclusa da ogni coda automatica, per sempre. Quindi quando il
// conteggio rientra sotto soglia i label cronici vengono rimossi — vedi
// `decideChronicDeescalation()`. Il `priority:*` non si ripristina perché non serve:
// alla ricorrenza successiva è il reporter a riscriverlo (`setIssuePriorityLabel()`
// in github-issue-creator.mjs), e nel frattempo la issue sta per essere chiusa.

/**
 * Lo stesso marker che il reporter scrive su ogni ricorrenza.
 *
 * È una COPIA di `RECURRENCE_MARKER` in `scripts/lib/github-issue-creator.mjs:75`, che
 * lì è privato: un contratto senza forma di import, quindi invisibile a ogni guard che
 * segue gli import. Se il creator cambiasse marker, `countRecurrences()` tornerebbe 0,
 * il gate cronico morirebbe in silenzio e la CI resterebbe verde. Lo tiene ancorato una
 * asserzione grep nella suite `close-recovered-recurrence` — qui
 * `generator/tests/close-recovered-recurrence.test.mjs`, sul sito la gemella sotto
 * `tests/` in TypeScript — con la stessa tecnica che ancora il template del titolo.
 */
export const RECURRENCE_MARKER = '🔁';
/** Ricorrenze nella finestra oltre le quali la issue è cronica e non si richiude. */
export const DEFAULT_CHRONIC_RECURRENCES = 5;
/** Finestra mobile del conteggio cronico. */
export const DEFAULT_CHRONIC_WINDOW_HOURS = 168;
/** Marker di idempotenza dell'escalation: label e commento una volta sola. */
export const CHRONIC_MARKER = '<!-- CLOSE_RECOVERED: chronic-recurrence -->';
/** I label che rendono visibile una issue cronica. */
export const CHRONIC_LABELS = Object.freeze(['priority:urgent', 'needs-human']);
/** I `priority:*` che l'escalation rimuove per non lasciarne due in conflitto. */
export const SUPERSEDED_PRIORITY_LABELS = Object.freeze(['priority:high', 'priority:medium', 'priority:low']);

/**
 * Quante ricorrenze (`🔁`) sono state registrate sulla issue nella finestra.
 *
 * La creazione della issue stessa NON conta: è il primo fallimento, non una ricorrenza.
 *
 * @param {Array|null} comments
 * @param {{ now?: number, windowHours?: number }} [opts]
 */
export function countRecurrences(comments, opts = {}) {
  if (!Array.isArray(comments)) return 0;
  const now = opts.now ?? Date.now();
  const windowHours = opts.windowHours ?? DEFAULT_CHRONIC_WINDOW_HOURS;
  const cutoff = now - windowHours * 3600 * 1000;
  return comments.filter((c) => {
    if (!String(c?.body || '').includes(RECURRENCE_MARKER)) return false;
    const t = Date.parse(c?.createdAt ?? c?.created_at ?? '');
    return Number.isNaN(t) ? true : t >= cutoff;
  }).length;
}

/**
 * Decide l'escalation cronica. `escalate` è vero solo al primo passaggio sopra soglia
 * (poi il marker lo spegne), `hold` resta vero finché la issue è cronica.
 *
 * @param {Array|null} comments
 * @param {{ now?: number, windowHours?: number, threshold?: number }} [opts]
 */
export function decideChronicEscalation(comments, opts = {}) {
  const threshold = opts.threshold
    ?? envNumber('CLOSE_RECOVERED_CHRONIC_RECURRENCES', DEFAULT_CHRONIC_RECURRENCES, { min: 1 });
  const windowHours = opts.windowHours
    ?? envNumber('CLOSE_RECOVERED_CHRONIC_WINDOW_HOURS', DEFAULT_CHRONIC_WINDOW_HOURS, { min: 1 });
  const count = countRecurrences(comments, { now: opts.now, windowHours });
  if (count < threshold) {
    return { hold: false, escalate: false, count, threshold, windowHours, reason: `${count} ricorrenze in ${windowHours}h (soglia ${threshold})` };
  }
  const notified = Array.isArray(comments)
    && comments.some((c) => String(c?.body || '').includes(CHRONIC_MARKER));
  return {
    hold: true,
    escalate: !notified,
    count,
    threshold,
    windowHours,
    reason: `CRONICA: ${count} ricorrenze in ${windowHours}h (soglia ${threshold}) — non si richiude da sola`,
  };
}

/** Il commento dell'escalation. Non contiene `🔁`: non deve gonfiare il proprio contatore. */
export function chronicEscalationNote({ workflow, decision } = {}) {
  const d = decision || {};
  return [
    `🔒 **Guasto cronico: questa issue non verrà più auto-chiusa.** ${d.count ?? '?'} ricorrenze registrate in ${d.windowHours ?? DEFAULT_CHRONIC_WINDOW_HOURS}h${workflow ? ` su \`${workflow}\`` : ''}, contro una soglia di ${d.threshold ?? DEFAULT_CHRONIC_RECURRENCES}.`,
    '',
    `Fin qui il ciclo la chiudeva a ogni run verde e il reporter la riapriva alla ricorrenza successiva: la issue viveva pochi minuti per volta e **non entrava mai né nella coda del fixer né in un triage umano**. Un guasto che ricorre non è un guasto risolto.`,
    '',
    `Da adesso resta aperta con \`${CHRONIC_LABELS.join('`, `')}\` finché qualcuno la chiude a mano dopo aver applicato un fix. Le ricorrenze successive continuano ad accumularsi qui, in un thread solo.`,
    '',
    `Finché \`needs-human\` è applicata la issue compare nel digest giornaliero di \`recycle-stale-prs.yml\`. Se il guasto smette da solo e il conteggio rientra sotto ${d.threshold ?? DEFAULT_CHRONIC_RECURRENCES} nella finestra, questi label vengono tolti automaticamente e la issue torna nel flusso normale — l'escalation non è una porta a senso unico.`,
    '',
    CHRONIC_MARKER,
  ].join('\n');
}

/**
 * Decide se TOGLIERE i label cronici. È la metà mancante di `applyChronicLabels()`.
 *
 * `needs-human` non è una segnalazione: è un filtro di esclusione letto da
 * `followup-drainer.mjs` (:1091 pool dei retry parcheggiati, :1204 rescue `agent:fix`
 * dei crawler). Lasciarlo appeso dopo che il guasto è rientrato esclude la issue da
 * ogni coda automatica anche alla riapertura successiva, cioè per sempre.
 *
 * Pura. Toglie solo se ci sono tutte e tre le condizioni, così non spende una chiamata
 * `gh` per passata oraria su ogni issue già pulita:
 *  1. la decisione corrente NON è un hold cronico (il conteggio è rientrato);
 *  2. l'escalation c'era davvero (CHRONIC_MARKER nei commenti);
 *  3. almeno uno dei label cronici è ancora sulla issue ADESSO.
 *
 * Il `priority:*` soppresso non viene ripristinato: non lo conosciamo più, e non serve.
 * Alla ricorrenza successiva lo riscrive il reporter (`setIssuePriorityLabel()` in
 * github-issue-creator.mjs), e nel frattempo la issue sta per essere chiusa.
 *
 * @param {{ comments?: Array|null, labels?: Array<string>|null,
 *           decision?: { hold?: boolean } }} [input]
 * @returns {{ clear: boolean, labels: string[], reason: string }}
 */
export function decideChronicDeescalation({ comments, labels, decision } = {}) {
  const none = (reason) => ({ clear: false, labels: [], reason });
  if (decision?.hold) return none('ancora cronica');
  const escalated = Array.isArray(comments)
    && comments.some((c) => String(c?.body || '').includes(CHRONIC_MARKER));
  // Commenti illeggibili → non togliamo niente: non sapremmo se l'escalation c'è mai
  // stata, e togliere label a caso è peggio che lasciarli un'ora in più.
  if (!escalated) return none('nessuna escalation cronica da revocare');
  const present = Array.isArray(labels)
    ? CHRONIC_LABELS.filter((l) => labels.includes(l))
    : [];
  if (present.length === 0) return none('label cronici già assenti');
  return {
    clear: true,
    labels: present,
    reason: `rientrata sotto soglia: tolgo ${present.join('+')}`,
  };
}

// ──────────────────────────────────────────────────────────────────────────────────────

function repoFlag(repo = REPO) {
  return repo ? ['--repo', repo] : [];
}

function gh(args, { allowFailure = false, token } = {}) {
  try {
    return execFileSync('gh', args, {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      env: token ? { ...process.env, GH_TOKEN: token } : process.env,
    });
  } catch (err) {
    if (allowFailure) return null;
    throw err;
  }
}

export function crawlerRunToken(
  repo,
  issueRepo = REPO,
  runRepo = CRAWLER_RUN_REPO,
  token = CRAWLER_RUN_GH_TOKEN,
) {
  return repo && runRepo && repo === runRepo && repo !== issueRepo ? token : undefined;
}

function listFailureIssues() {
  const out = gh([
    'issue', 'list', '--state', 'open', '--limit', '300',
    // `labels` serve solo alla de-escalation cronica: arriva già in questa chiamata,
    // così non costa un giro `gh` in più per issue (vedi decideChronicDeescalation).
    '--json', 'number,title,createdAt,labels', ...repoFlag(),
  ]);
  return JSON.parse(out)
    .map((i) => ({ issue: i, m: TITLE_RE.exec(i.title) }))
    .filter(({ m }) => m)
    .map(({ issue, m }) => ({
      number: issue.number,
      title: issue.title,
      createdAt: issue.createdAt,
      labels: (issue.labels || []).map((l) => l?.name).filter(Boolean),
      workflow: m[1].trim(),
    }));
}

/**
 * The issue's comments, oldest-first, or `null` when they cannot be read.
 *
 * Fetched LAZILY — only for an issue that is already about to be closed. On the common
 * path (still red, or green but pre-dating the issue) this costs zero extra API calls,
 * which is what keeps a 300-issue listing from turning into 300 comment fetches.
 *
 * `null` (not `[]`) on failure is load-bearing: `[]` would read as "no verdict → close",
 * which is precisely the mistake this whole section exists to stop.
 */
function fetchIssueComments(issueNumber) {
  const out = gh(
    ['api', `repos/${REPO || '{owner}/{repo}'}/issues/${issueNumber}/comments`, '--paginate'],
    { allowFailure: true },
  );
  if (out === null) return null;
  try {
    const parsed = JSON.parse(out);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    // `--paginate` concatenates pages as separate JSON arrays; splice them.
    try {
      const spliced = JSON.parse(`[${out.replace(/\]\s*\[/g, ',').replace(/^\s*\[|\]\s*$/g, '')}]`);
      return Array.isArray(spliced) ? spliced : null;
    } catch {
      return null;
    }
  }
}

// Quante run di storico chiede il listing. Una pagina di `gh run list` è 100 righe,
// quindi alzare il vecchio `-L 20` a 100 costa LA STESSA singola chiamata di prima —
// nessun costo di quota aggiunto. Misurato su `Generate Blog Article` (~170 run/giorno
// qui): 100 righe coprono ~14h, largamente più della finestra di 8h su cui il gate
// misura. Se un workflow è abbastanza veloce da superare le 100 run dentro la finestra,
// la finestra si tronca: può solo SOTTO-contare i fallimenti, quindi la troncatura
// spinge verso la chiusura (il comportamento vecchio), mai verso l'hold.
const RUN_HISTORY_LIMIT = 100;

/**
 * True quando la run `cancelled` non ha una prova di timeout. Uno scarto in coda non ha
 * job; una cancellazione manuale o una supersessione dopo l'avvio ha job, ma nessuna
 * annotation di timeout. Nessuna delle due è un fallimento del workflow. Misurato su #5333:
 * `tests` a push-su-main gira con
 * `cancel-in-progress: false` apposta perché "main deve arrivare a un verdetto" (vedi
 * tests.yml), ma GitHub tiene comunque un solo run pending per gruppo di concorrenza e
 * scarta il pending superato a ogni push successivo — "un burst di N merge costa 2 run,
 * non N", per usare le parole del workflow stesso. Contare quello scarto come fallimento
 * in `decideRecurrenceHold` gonfia artificialmente il tasso: nella finestra dell'8h che
 * ha tenuto #5333 aperta con "5 fallimenti su 21 run (23.8%)", tutti e 5 i "fallimenti"
 * erano cancellazioni senza timeout — zero timeout, zero test rossi — eppure la issue restava
 * bloccata da un artefatto della concorrenza scambiato per un guasto che ricorreva.
 * PROCEED-SAFE: errore gh/API, JSON malformato, job senza check-run o annotation illeggibile
 * → false (non esclude nulla), lo stesso bias-verso-l'hold di ogni altro fallback di questo
 * file.
 *
 * PERCHÉ non filtrare tutti i `cancelled`, che non costerebbe nemmeno una chiamata:
 * `loop-health-report.mjs` sceglie la scorciatoia (`real = total - cancelled - skipped`) e
 * qui sarebbe SBAGLIATA. GitHub marca `cancelled` anche il job che sfonda `timeout-minutes`
 * — è la premessa su cui `scan-job-timeouts.mjs` è costruito per intero — e il timeout è
 * proprio il guasto che ha RIAPERTO #5333 (`typecheck (tsc --noEmit)`, "the job has
 * exceeded the maximum execution time"). La stessa annotation e' la prova che separa il
 * timeout da una cancellazione normale: avere job non basta.
 */
function hasNoTimeoutEvidence(databaseId, repo = REPO, token) {
  const out = gh(
    ['api', `repos/${repo || '{owner}/{repo}'}/actions/runs/${databaseId}/jobs?per_page=100`],
    { allowFailure: true, token },
  );
  if (out === null) return false;
  try {
    const data = JSON.parse(out);
    const jobs = data?.jobs;
    const totalCount = Number(data?.total_count);
    if (!Array.isArray(jobs) || !Number.isInteger(totalCount) || totalCount !== jobs.length) return false;
    for (const job of jobs) {
      if (job?.conclusion !== 'cancelled') continue;
      if (!job?.check_run_url) return false;
      const annotations = gh(['api', `${job.check_run_url}/annotations`, '--paginate', '--slurp'], { allowFailure: true, token });
      if (annotations === null) return false;
      let parsed;
      try {
        parsed = JSON.parse(annotations);
      } catch {
        return false;
      }
      if (!hasReadableAnnotationPages(parsed)) return false;
      if (hasTimeoutAnnotation(parsed)) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

/** True when any paginated check-run annotation proves a timeout. */
export function hasTimeoutAnnotation(pages) {
  return pages.some((annotations) => annotations.some((annotation) => (
    /exceeded[^.]*(maximum execution time|maximum number of minutes)/i.test(annotation?.message || '')
  )));
}

/** True only for complete, readable pages returned by the annotations API. */
export function hasReadableAnnotationPages(pages) {
  return Array.isArray(pages) && pages.every((annotations) => (
    Array.isArray(annotations) && annotations.every((annotation) => (
      annotation && typeof annotation.message === 'string'
    ))
  ));
}

/**
 * Toglie dallo storico le run `cancelled` senza prova di timeout — vedi
 * `hasNoTimeoutEvidence` per il perché. Puro e iniettabile (`isPhantom`) perché è QUESTO il ramo che
 * decide se una cancellazione fisiologica diventa un fallimento misurato, e un ramo del
 * genere va provato con un test, non a occhio: `recentCompletedRuns` non è testabile
 * (parla con `gh` a ogni riga), questa lo è.
 *
 * Nota che il filtro toglie la run da NUMERATORE e DENOMINATORE insieme: è voluto — una
 * run mai partita non è né un fallimento né un'osservazione — ma su un workflow molto
 * cancellato rende il campione più piccolo e quindi il tasso più volatile. Vedi il test
 * "denominatore che si restringe".
 *
 * COSTO, misurato il 2026-08-18 su `main` (`gh run list -b main -L 100`, per workflow):
 * `Deploy to GitHub Pages` 91/100 righe `cancelled`, `Follow-up drainer` 24/75,
 * `tests` 15/100, mediana degli altri 0. Quindi NON è vero che sia "sempre una
 * minoranza": sul workflow più cancellato del repo è quasi l'intero listing, cioè ~91
 * chiamate `gh api` per singola issue e per passata oraria. Resta sostenibile solo
 * perché le issue di fallimento aperte sono poche (4 al momento della misura, con un
 * solo workflow ripetuto) e il rate limit è 5000/h; se quel numero cresce, la leva è
 * memoizzare per `workflowName` dentro la passata, non allargare il filtro.
 *
 * @param {Array<{conclusion?: string, databaseId?: number}>} runs
 * @param {(databaseId: number) => boolean} isPhantom
 */
export function dropPhantomCancellations(runs, isPhantom) {
  if (!Array.isArray(runs)) return [];
  return runs.filter((r) => r?.conclusion !== 'cancelled' || !isPhantom(r?.databaseId));
}

// Le run COMPLETATE più recenti del workflow su main, dalla più nuova alla più vecchia,
// o null se il workflow non ha run (rinominato/cancellato) o il listing è fallito — nel
// qual caso lasciamo conservativamente aperta la issue, come da sempre.
function recentCompletedRuns(workflowName, repo = REPO, token) {
  const out = gh([
    'run', 'list', '-w', workflowName, '-b', 'main', '-L', String(RUN_HISTORY_LIMIT),
    '--json', 'databaseId,conclusion,status,createdAt', ...repoFlag(repo),
  ], { allowFailure: true, token });
  if (out === null) return null;
  let runs;
  try {
    runs = JSON.parse(out);
  } catch {
    return null;
  }
  // L'ordine di `gh run list` è già newest-first, ma la streak verde ne dipende in modo
  // portante (un ordine invertito la calcolerebbe dal fondo della storia): riordinare
  // esplicitamente costa nulla e toglie la dipendenza da un contratto non scritto.
  const completed = dropPhantomCancellations(
    runs
      .filter((r) => r.status === 'completed')
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)),
    (databaseId) => hasNoTimeoutEvidence(databaseId, repo, token),
  );
  return completed.length ? completed : null;
}

// Most-recent COMPLETED run of the named workflow on main, or null if the workflow has
// no runs (e.g. renamed/deleted) — in which case we conservatively leave the issue open.
function latestCompletedRun(workflowName, repo = REPO, token) {
  const runs = recentCompletedRuns(workflowName, repo, token);
  return runs ? runs[0] : null;
}

// Find which crawler-group-*.yml currently contains a crawler's background step
// (`id: crawler-<slug>`). Group membership can shift whenever
// scripts/generate-crawler-group-workflows.mjs re-runs, so this reads the CURRENT
// workflow files directly each run (this script itself runs as a single short-lived
// process per cron invocation, so a fresh checkout is picked up naturally on the next
// scheduled run; no cross-invocation cache is kept). Returns both the group workflow's
// `name:` and filename: the local repo resolves the display name, while the remote
// cross-repo caller (which has no `name:`) is dispatchable through its filename.
export function findCrawlerGroupWorkflow(slug, workflowsDir = WORKFLOWS_DIR) {
  const groupFiles = fs.existsSync(workflowsDir)
    ? fs.readdirSync(workflowsDir).filter((f) => /^crawler-group-\d+\.yml$/.test(f))
    : [];
  // Anchored, whole-line match (not a plain substring check): a naive
  // `content.includes('id: crawler-' + slug)` would false-positive when one
  // crawler's slug is a prefix of another's in the same file (e.g. looking up
  // slug "hoch" would substring-match the UNRELATED "id: crawler-hoch-health"
  // line and return the wrong group) — the exact bug class flagged in
  // AdminPanel.tsx's failedSteps narrowing, guarded here too.
  const idLineRe = new RegExp(`^\\s*id:\\s*crawler-${slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm');
  for (const file of groupFiles) {
    const content = fs.readFileSync(path.join(workflowsDir, file), 'utf8');
    if (idLineRe.test(content)) {
      const nameMatch = content.match(/^name:\s*(.+)$/m);
      if (nameMatch) {
        return {
          filename: file,
          name: nameMatch[1].trim().replace(/^["']|["']$/g, ''),
        };
      }
    }
  }
  return null;
}

export function findCrawlerGroupWorkflowName(slug, workflowsDir = WORKFLOWS_DIR) {
  return findCrawlerGroupWorkflow(slug, workflowsDir)?.name ?? null;
}

// Il display name e' corretto nel repo che contiene il workflow generato. Nel
// repository remoto che ospita i caller minimali, invece, il file non dichiara
// `name:` e GitHub lo risolve stabilmente tramite filename.
export function crawlerWorkflowReference(group, issueRepo = REPO, runRepo = CRAWLER_RUN_REPO) {
  if (!group) return null;
  return runRepo && runRepo !== issueRepo ? group.filename : group.name;
}

// Most-recent COMPLETED run of the named GROUP workflow, then the conclusion of the
// SPECIFIC background step named `Run <slug>` inside that run's job (steps carry their
// own independent conclusion in the Jobs API — a sibling crawler's failure in the same
// job does not affect this step's own conclusion). Returns
// { conclusion, status: 'completed', createdAt, databaseId } shaped like a run object
// (so the caller's existing green/afterFailure logic works unchanged), or null if the
// run, job, or step can't be resolved.
function latestCompletedCrawlerStepRun(slug) {
  const group = findCrawlerGroupWorkflow(slug);
  const workflowRef = crawlerWorkflowReference(group);
  if (!workflowRef) return null;

  const runToken = crawlerRunToken(CRAWLER_RUN_REPO);
  const run = latestCompletedRun(workflowRef, CRAWLER_RUN_REPO, runToken);
  if (!run) return null;

  const jobsOut = gh(
    ['api', `repos/${CRAWLER_RUN_REPO || '{owner}/{repo}'}/actions/runs/${run.databaseId}/jobs`],
    { allowFailure: true, token: runToken },
  );
  if (jobsOut === null) return null;
  let jobsData;
  try {
    jobsData = JSON.parse(jobsOut);
  } catch {
    return null;
  }
  const stepName = `Run ${slug}`;
  for (const job of jobsData.jobs || []) {
    const step = (job.steps || []).find((s) => s.name === stepName);
    if (step) {
      return {
        databaseId: run.databaseId,
        status: step.status,
        conclusion: step.conclusion,
        createdAt: run.createdAt,
        repository: CRAWLER_RUN_REPO,
      };
    }
  }
  return null; // background step not found in this run's job (renamed/removed?)
}

/**
 * Applica i label dell'escalation cronica. Best-effort in senso stretto: se `gh`
 * fallisce (label inesistente nel repo, permessi) la decisione di NON chiudere resta
 * valida — il label è la visibilità, non il gate.
 */
function applyChronicLabels(issueNumber) {
  const out = gh([
    'issue', 'edit', String(issueNumber),
    ...CHRONIC_LABELS.flatMap((l) => ['--add-label', l]),
    ...SUPERSEDED_PRIORITY_LABELS.flatMap((l) => ['--remove-label', l]),
    ...repoFlag(),
  ], { allowFailure: true });
  if (out === null) {
    console.error(`  #${issueNumber} label cronici non applicati (best-effort) — la issue resta comunque aperta`);
    return false;
  }
  return true;
}

/**
 * Toglie i label cronici quando il guasto è rientrato. Best-effort come l'applicazione:
 * se `gh` fallisce, la decisione di chiudere (o di tenere aperta) non cambia.
 */
function clearChronicLabels(issueNumber, labels) {
  const out = gh([
    'issue', 'edit', String(issueNumber),
    ...labels.flatMap((l) => ['--remove-label', l]),
    ...repoFlag(),
  ], { allowFailure: true });
  if (out === null) {
    console.error(`  #${issueNumber} label cronici non rimossi (best-effort) — riprovo alla passata successiva`);
    return false;
  }
  return true;
}

function main() {
  const issues = listFailureIssues();
  const maxDays = holdMaxDays();
  const rec = recurrenceOptions();
  console.log(`[close-recovered] ${issues.length} open Workflow/Crawler/CI Failure issue(s)${DRY_RUN ? ' (dry-run)' : ''}, structural-hold TTL ${maxDays}d, recurrence gate: max ${rec.maxRecurrences} fallimenti in ${rec.windowHours}h / ${rec.minGreenStreak} verdi consecutivi / valvola ${(rec.maxFailureRate * 100).toFixed(1)}%`);
  let closed = 0;
  let kept = 0;
  let skipped = 0;
  let held = 0;
  let chronic = 0;
  let deescalated = 0;

  for (const it of issues) {
    const crawlerStepMatch = CRAWLER_STEP_RE.exec(it.workflow);
    const isCrawlerStepIdentifier = it.title.startsWith('Crawler Failure:') && crawlerStepMatch;

    // Storico run completo per la famiglia `Workflow|CI Failure:`. Per i crawler resta
    // la sola run di testa: ricostruire lo storico di UNO step di background costa una
    // chiamata alla Jobs API per ogni run storica, e il gate lì è per costruzione un
    // no-op (vedi decideRecurrenceHold).
    const history = isCrawlerStepIdentifier ? null : recentCompletedRuns(it.workflow);
    const run = isCrawlerStepIdentifier
      ? latestCompletedCrawlerStepRun(crawlerStepMatch[1])
      : (history ? history[0] : null);

    if (!run) {
      const reason = isCrawlerStepIdentifier
        ? `crawler '${crawlerStepMatch[1]}' not found in any current crawler-group-*.yml, or its step/run not resolvable`
        : 'no completed run on main (renamed/deleted?)';
      console.log(`  #${it.number} "${it.workflow}" — ${reason}, keep open`);
      skipped++;
      continue;
    }
    const green = run.conclusion === 'success';
    // The failing run that opened the issue started BEFORE the issue's createdAt (the
    // reporter step runs after the job failed). So a green run created at/after the issue
    // is necessarily a LATER run — the "next run is ok" the user asked for.
    const afterFailure = Date.parse(run.createdAt) >= Date.parse(it.createdAt);

    if (green && afterFailure) {
      const runRepo = run.repository || REPO;
      const runUrl = runRepo ? `https://github.com/${runRepo}/actions/runs/${run.databaseId}` : undefined;

      // #5454: green answers "is the symptom back?", not "was the fault fixed?".
      const comments = fetchIssueComments(it.number);

      // Gate 1 — CRONICA. Ha la precedenza su tutto, TTL dello structural hold compreso:
      // una issue riaperta N volte non deve essere rilasciata da una scadenza pensata per
      // una diagnosi ferma, e non deve nemmeno approfittare di una finestra recente
      // tranquilla per ricominciare il ciclo.
      const chronicDecision = decideChronicEscalation(comments);
      if (chronicDecision.hold) {
        if (DRY_RUN) {
          console.log(`  #${it.number} WOULD ESCALATE+HOLD — ${chronicDecision.reason}`);
        } else if (chronicDecision.escalate) {
          applyChronicLabels(it.number);
          commentOnGithubIssue(it.number, chronicEscalationNote({ workflow: it.workflow, decision: chronicDecision }));
          console.log(`  #${it.number} CHRONIC (escalated: ${CHRONIC_LABELS.join('+')}) — ${chronicDecision.reason}`);
        } else {
          console.log(`  #${it.number} CHRONIC (already escalated) — ${chronicDecision.reason}`);
        }
        chronic++;
        continue;
      }

      // Il conteggio è rientrato: se l'escalation c'era, i label cronici se ne vanno
      // adesso. `needs-human` è un'esclusione dalle code del drainer, quindi lasciarlo
      // appeso renderebbe l'escalation irreversibile anche dopo la riapertura.
      const deescalation = decideChronicDeescalation({ comments, labels: it.labels, decision: chronicDecision });
      if (deescalation.clear) {
        if (DRY_RUN) {
          console.log(`  #${it.number} WOULD DE-ESCALATE — ${deescalation.reason}`);
        } else {
          clearChronicLabels(it.number, deescalation.labels);
          console.log(`  #${it.number} de-escalated — ${deescalation.reason}`);
        }
        deescalated++;
      }

      // Gate 2 — RICORRENZA MISURATA. Una run verde su un guasto intermittente non
      // significa niente: si chiude solo se la finestra recente è pulita.
      const recurrence = decideRecurrenceHold(history, { ...rec });
      if (recurrence.hold) {
        if (DRY_RUN) {
          console.log(`  #${it.number} WOULD HOLD (recurrence) — ${recurrence.reason}`);
        } else if (alreadyRecurrenceHeld(comments)) {
          console.log(`  #${it.number} HELD (recurrence, already notified) — ${recurrence.reason}`);
        } else {
          commentOnGithubIssue(it.number, recurrenceHoldNote({ workflow: it.workflow, runUrl, decision: recurrence }));
          console.log(`  #${it.number} HELD (recurrence) — ${recurrence.reason}`);
        }
        held++;
        continue;
      }

      // Gate 3 — STRUCTURAL HOLD (#5454), invariato.
      const decision = decideStructuralHold(comments, {
        issueCreatedAt: it.createdAt,
        maxDays,
      });

      if (decision.hold) {
        if (DRY_RUN) {
          console.log(`  #${it.number} WOULD HOLD — ${decision.reason}`);
        } else if (decision.notified) {
          console.log(`  #${it.number} HELD (already notified) — ${decision.reason}`);
        } else {
          commentOnGithubIssue(
            it.number,
            structuralHoldNote({ code: decision.code, workflow: it.workflow, runUrl, maxDays }),
          );
          console.log(`  #${it.number} HELD — ${decision.reason}`);
        }
        held++;
        continue;
      }

      if (DRY_RUN) {
        console.log(`  #${it.number} WOULD CLOSE — recovered (run ${run.databaseId} success @ ${run.createdAt}); ${recurrence.reason}; ${decision.reason}`);
      } else {
        // A TTL-released close must say why, or it looks exactly like the symptom-only
        // close #5454 was opened about.
        if (decision.code && STRUCTURAL_OUTCOMES.includes(decision.code)) {
          commentOnGithubIssue(it.number, ttlReleaseNote({ code: decision.code, maxDays, ageDays: decision.ageDays }));
        }
        resolveGithubIssue(it.title, { workflow: it.workflow, runUrl });
        console.log(`  #${it.number} CLOSED — recovered via run ${run.databaseId}; ${recurrence.reason}; ${decision.reason}`);
      }
      closed++;
    } else if (green && !afterFailure) {
      console.log(`  #${it.number} latest green run ${run.databaseId} predates issue — keep open`);
      kept++;
    } else {
      console.log(`  #${it.number} still red (latest completed run ${run.databaseId}=${run.conclusion}) — keep open`);
      kept++;
    }
  }

  console.log(`[close-recovered] done: closed=${closed} held=${held} chronic=${chronic} de-escalated=${deescalated} kept=${kept} skipped=${skipped}`);
}

// CLI entry point (guarded so this module can be imported for unit tests without
// triggering real `gh` calls at import time).
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main();
}
