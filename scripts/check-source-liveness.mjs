#!/usr/bin/env node
/**
 * check-source-liveness.mjs — the one component whose job is to notice that a
 * monitoring source has stopped ingesting, and to say so exactly once.
 *
 * WHY THIS IS A SEPARATE SCRIPT
 * -----------------------------
 * The vitality guard (scripts/lib/source-liveness.mjs) makes every PostHog
 * monitor ABSTAIN when its source is dead. Abstention alone would be a
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
 *   node scripts/check-source-liveness.mjs            # probe + issue if dead
 *   node scripts/check-source-liveness.mjs --json     # machine output
 *   node scripts/check-source-liveness.mjs --dry-run  # never opens an issue
 *   node scripts/check-source-liveness.mjs --strict   # exit 2 when dead
 *
 * ENV: POSTHOG_PERSONAL_API_KEY / POSTHOG_PROJECT_ID / POSTHOG_HOST
 *      SOURCE_LIVENESS_WINDOW_DAYS (default 7)
 */

import { pathToFileURL } from 'node:url';
import { checkPostHogLiveness, POSTHOG_MONITORS, DEFAULT_MIN_EVENTS_PER_DAY } from './lib/source-liveness.mjs';

// Discriminant FIRST: issue dedup truncates the title at 60 chars, so a
// trailing discriminant is the token that gets dropped and collides.
export const ISSUE_TITLE = 'PostHog ingestion down — monitors are abstaining';

export function buildIssueBody(verdict) {
  const affected = POSTHOG_MONITORS.map(
    (m) => `- \`${m.path}\` — ${m.emits}${m.guarded ? '' : ' _(guard non ancora cablato)_'}`,
  ).join('\n');

  return [
    `La sorgente PostHog non risulta viva sulla finestra misurata, quindi i monitor che la leggono si sono **astenuti**: nessun numero emesso, nessuna issue di regressione aperta.`,
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
    '**Cosa NON fare:** non chiudere le issue aperte da questi monitor con la motivazione «PostHog e\' cieco» senza rimisurare. E\' esattamente cosi\' che #5607 e #5670 sono state chiuse il 2026-08-08 su una premessa gia\' falsa, e riaperte il 2026-08-14.',
    '',
    '**Come rimisurare a mano:**',
    '```',
    'source bin/rc-env.sh   # dalla root del workspace',
    'node scripts/check-source-liveness.mjs --json',
    '```',
    '',
    '_Fonte: scripts/check-source-liveness.mjs (guardia di vitalita\', scripts/lib/source-liveness.mjs). Questa issue e\' l\'UNICO canale di allarme per una sorgente morta: i singoli monitor si astengono in silenzio-dichiarato apposta, per non trasformare un guasto in dodici falsi allarmi._',
  ]
    .filter(Boolean)
    .join('\n');
}

export async function main({
  argv = process.argv.slice(2),
  checkImpl = checkPostHogLiveness,
  createIssueImpl,
  logger = console,
} = {}) {
  const json = argv.includes('--json');
  const dryRun = argv.includes('--dry-run');
  const strict = argv.includes('--strict');
  const windowDays = Number(process.env.SOURCE_LIVENESS_WINDOW_DAYS || 7);

  const verdict = await checkImpl({ windowDays, minEventsPerDay: DEFAULT_MIN_EVENTS_PER_DAY });
  // `dailyCounts` is a Map and would serialise to `{}` — drop it from output.
  const { dailyCounts, ...printable } = verdict;

  if (json) logger.log(JSON.stringify(printable, null, 2));
  else logger.log(`[check-source-liveness] ${verdict.alive ? 'ALIVE' : 'NOT MEASURABLE'} — ${verdict.reason}`);

  if (verdict.alive) return { verdict, issued: false };

  logger.log(`::error title=PostHog not measurable::${verdict.reason}`);

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
