#!/usr/bin/env node
/**
 * check-source-liveness.mjs — the one component whose job is to notice that a
 * monitoring source has stopped ingesting, and to say so exactly once.
 *
 * WHY THIS IS A SEPARATE SCRIPT
 * -----------------------------
 * The vitality guard (scripts/lib/source-liveness.mjs) makes every monitor
 * ABSTAIN when its source is dead. Since decision H9 (2026-10-05, «rimpiazza
 * PostHog con GA4») that source is GA4: PostHog is under quota by choice
 * (owner decision 2026-08-25) and is no longer a source the fleet expects
 * alive, so probing it here reopened the PostHog outage issue (5921)
 * forever while the monitors were already reading GA4. Abstention alone would be a
 * regression: silence is precisely how the 2026-07-23 → 2026-08-10 outage
 * survived three weeks unnoticed while twelve monitors kept exiting 0.
 *
 * The obvious fix — let each monitor report the outage — is the wrong one: it
 * turns one incident into twelve issues, which is the same "false issue"
 * problem from the other direction. So the monitors declare "non misurabile"
 * into their own logs and open nothing, and this script raises exactly ONE
 * deduped issue for the source itself.
 *
 * WHY IT EXITS 0 EVEN WHEN THE SOURCE IS DEAD
 * -------------------------------------------
 * A red run in this repo is itself an issue-opening event ("Workflow Failure:
 * …" via the `if: failure()` step every scheduled workflow carries). Exiting
 * non-zero here would therefore file a second issue about the same outage,
 * one of them with a title that says nothing useful. The issue this script
 * opens IS the alarm; the run stays green so it stays the only one.
 * `--strict` restores a non-zero exit for a caller that wants a hard gate.
 *
 * USAGE
 *   node scripts/check-source-liveness.mjs            # probe + issue if dead, close it if alive
 *   node scripts/check-source-liveness.mjs --json     # machine output
 *   node scripts/check-source-liveness.mjs --dry-run  # never opens an issue
 *   node scripts/check-source-liveness.mjs --strict   # exit 2 when dead
 *
 * ENV: GOOGLE_APPLICATION_CREDENTIALS or FIREBASE_SERVICE_ACCOUNT_JSON (GA4
 *      Data API, read-only), GA4_PROPERTY_ID (optional)
 *      SOURCE_LIVENESS_WINDOW_DAYS (default 7, settled GA4 days)
 */

import { pathToFileURL } from 'node:url';
import { checkGa4Liveness, GA4_MONITORS, DEFAULT_MIN_EVENTS_PER_DAY } from './lib/source-liveness.mjs';
import { intFromEnv } from './lib/int-from-env.mjs';
import { buildScheda } from './lib/monitor-scheda.mjs';

// Discriminant FIRST: issue dedup truncates the title at 60 chars, so a
// trailing discriminant is the token that gets dropped and collides.
export const ISSUE_TITLE = 'GA4 ingestion down — monitors are abstaining';

/**
 * Titles this script used to open for a source the fleet no longer expects
 * alive. Never created nor resolved from here again: the PostHog one stays in
 * the issue history (5921) and is closed by the H9 migration itself.
 */
export const RETIRED_ISSUE_TITLES = Object.freeze(['PostHog ingestion down — monitors are abstaining']);

export function buildIssueBody(verdict) {
  const affected = GA4_MONITORS.map(
    (m) => `- \`${m.path}\` — ${m.emits}${m.guarded ? '' : ' _(guard non ancora cablato)_'}`,
  ).join('\n');

  return [
    `La sorgente GA4 non risulta viva sulla finestra misurata, quindi i monitor che la leggono si sono **astenuti**: nessun numero emesso, nessuna issue di regressione aperta.`,
    '',
    `**Verdetto:** ${verdict.reason}`,
    `**Soglia:** ${verdict.floor} eventi/giorno su ogni giorno completo della finestra di ${verdict.windowDays}gg`,
    verdict.deadDays?.length
      ? `**Giorni sotto la soglia:**\n${verdict.deadDays.map((d) => `- ${d.date}: ${d.count} eventi`).join('\n')}`
      : '',
    '',
    '**Monitor che leggono questa sorgente:**',
    affected,
    '',
    '**Cosa NON fare:** non chiudere le issue aperte da questi monitor con la motivazione «la sorgente e\' cieca» senza rimisurare. E\' esattamente cosi\' che #5607 e #5670 sono state chiuse il 2026-08-08 su una premessa gia\' falsa (allora la sorgente era PostHog), e riaperte il 2026-08-14.',
    '',
    '**Come rimisurare a mano:**',
    '```',
    'source bin/rc-env.sh   # dalla root del workspace',
    'node scripts/check-source-liveness.mjs --json --dry-run',
    '```',
    '',
    '_Fonte: scripts/check-source-liveness.mjs (guardia di vitalita\', scripts/lib/source-liveness.mjs). Questa issue e\' l\'UNICO canale di allarme per una sorgente morta: i singoli monitor si astengono in silenzio-dichiarato apposta, per non trasformare un guasto in dodici falsi allarmi._',
    '',
    buildScheda({
      causa: [
        `(ipotesi, da confermare.) ${verdict.reason}. Una sorgente che non riceve eventi puo'`,
        "essere rotta a monte (il client non spedisce) o a valle (l'ingestione non accetta):",
        "il verdetto qui non distingue, e la distinzione decide dove guardare.",
      ],
      fix: [
        'Dipende da quale dei due lati; non preassegnata qui. **Spesso il rimedio non e\' un',
        'commit** ma una chiave scaduta o una quota. | **REPO**: sito.',
      ],
      metrica: `prima=sotto ${verdict.floor} eventi/giorno atteso=>=${verdict.floor} su ogni giorno pieno della finestra di ${verdict.windowDays}gg`,
      comando: 'node scripts/check-source-liveness.mjs --json --dry-run',
      note: [
        '`--dry-run` non e\' decorativo: senza, con la sorgente ancora morta questo stesso',
        'script conia la issue invece di limitarsi a misurarla. Stampa il verdetto: la issue si',
        'chiude quando `alive` torna',
        'vero. Vuole il service account GA4 (Data API, sola lettura) — dalla root del workspace,',
        '`source bin/rc-env.sh`.',
      ],
      osservatore: [
        'Questa stessa guardia, rigirata dal cron che la porta: alla prima misura con `alive`',
        "vero chiude lei la issue. A mano il comando qui sopra e' il criterio — e chiuderla",
        'senza averlo eseguito e\' esattamente lo sbaglio che questo corpo documenta sopra.',
      ],
      fallimento: `\`${ISSUE_TITLE}\``,
    }),
  ]
    .filter(Boolean)
    .join('\n');
}

export async function main({
  argv = process.argv.slice(2),
  checkImpl = checkGa4Liveness,
  createIssueImpl,
  resolveIssueImpl,
  logger = console,
} = {}) {
  const json = argv.includes('--json');
  const dryRun = argv.includes('--dry-run');
  const strict = argv.includes('--strict');
  const windowDays = intFromEnv('SOURCE_LIVENESS_WINDOW_DAYS', 7);

  const verdict = await checkImpl({ windowDays, minEventsPerDay: DEFAULT_MIN_EVENTS_PER_DAY });
  // `dailyCounts` is a Map and would serialise to `{}` — drop it from output.
  const { dailyCounts, ...printable } = verdict;

  if (json) logger.log(JSON.stringify(printable, null, 2));
  else logger.log(`[check-source-liveness] ${verdict.alive ? 'ALIVE' : 'NOT MEASURABLE'} — ${verdict.reason}`);

  if (verdict.alive) {
    // The mirror of the open path below: a measured-alive source closes the
    // outage issue this script opened. `alive` is true only on a real verdict
    // (missing credentials and a failed probe both come back `alive: false`).
    if (dryRun) return { verdict, issued: false, resolved: false };
    const resolve =
      resolveIssueImpl ??
      (async (title, ctx) => {
        const { resolveGithubIssue } = await import('./lib/github-issue-creator.mjs');
        return resolveGithubIssue(title, ctx);
      });
    await resolve(ISSUE_TITLE, { workflow: 'Source Liveness' });
    return { verdict, issued: false, resolved: true };
  }

  logger.log(`::error title=GA4 not measurable::${verdict.reason}`);

  if (dryRun) return { verdict, issued: false };

  const create =
    createIssueImpl ??
    (async (payload) => {
      const { createGithubIssue } = await import('./lib/github-issue-creator.mjs');
      return createGithubIssue(payload);
    });

  await create({
    title: ISSUE_TITLE,
    description: buildIssueBody(verdict),
    priority: 2,
    labels: ['monitoring', 'source-liveness'],
    workflow: 'Source Liveness',
  });

  if (strict) process.exitCode = 2;
  return { verdict, issued: true };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((e) => {
    console.error(`[check-source-liveness] fatal: ${e.message}`);
    process.exitCode = 1;
  });
}
