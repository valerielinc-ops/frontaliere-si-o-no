/**
 * Build the Italian Telegram broadcast message for the WEEKLY "best/worst
 * dogane" wait-time ranking. Reuses the same pure aggregation lib as the
 * evergreen ranking article (scripts/lib/border-wait-ranking.mjs) plus the
 * crossing display names / page-link builders from
 * build-plugins/borderWaitData.ts — so the channel and the on-site article can
 * never drift into two different rankings of the same week.
 *
 * Because it imports `.ts` modules (borderWaitData.ts, borderWaitFormat.ts) it
 * MUST run under `tsx` (or vitest), never plain `node` — the exact same split
 * as scripts/lib/border-wait-ranking-content.mjs. The border MODE of
 * post-to-telegram.mjs therefore runs via `npx tsx`; the jobs mode stays plain
 * `node` because it never imports this file.
 */

import {
  BORDER_CROSSING_DISPLAY,
  buildOggiPath,
  buildRootHubPath,
  isTicinoCrossing,
} from '../../build-plugins/borderWaitData.ts';
import { fmtMinutes } from '../../services/borderWaitFormat.ts';
import { SITE_URL, buildArticleUrl, MONTHS_IT } from './social-post-utils.mjs';
import { escapeHtml } from './telegram-client.mjs';
import {
  computeRanking,
  computeWeekWindow,
  computeFunFacts,
  DEFAULT_WINDOW_DAYS,
} from './border-wait-ranking.mjs';
import { RANKING_ARTICLE_SLUGS } from './border-wait-ranking-content.mjs';

// How many crossings to show in each of the fast/slow shortlists.
export const TELEGRAM_BORDER_TOP = 5;

/** "13–19 luglio 2026" (same month collapses to one month name). */
function humanRangeIt(weekStart, weekEnd) {
  const [ys, mos, ds] = weekStart.split('-').map(Number);
  const [ye, moe, de] = weekEnd.split('-').map(Number);
  if (ys === ye && mos === moe) return `${ds}–${de} ${MONTHS_IT[mos - 1]} ${ye}`;
  if (ys === ye) return `${ds} ${MONTHS_IT[mos - 1]} – ${de} ${MONTHS_IT[moe - 1]} ${ye}`;
  return `${ds} ${MONTHS_IT[mos - 1]} ${ys} – ${de} ${MONTHS_IT[moe - 1]} ${ye}`;
}

function crossingLine(entry, index) {
  const name = escapeHtml(BORDER_CROSSING_DISPLAY[entry.slug] || entry.slug);
  const href = escapeHtml(`${SITE_URL}${buildOggiPath('it', entry.slug)}`);
  return `${index + 1}. <a href="${href}">${name}</a> — ${escapeHtml(fmtMinutes(entry.avgMinutes))}`;
}

/**
 * Build the weekly border-ranking message from the on-disk history dir.
 * Returns `{ text:'', rankedCount:0 }` (caller skips) when there is not yet
 * enough data to rank at least two crossings — a broadcast should stay silent
 * rather than post an empty "no data" week.
 *
 * @param {{ historyDir: string, todayIso?: string, days?: number }} opts
 * @returns {{ text: string, rankedCount: number, weekStart: string, weekEnd: string }}
 */
export function buildWeeklyBorderDigest({ historyDir, todayIso, days = DEFAULT_WINDOW_DAYS } = {}) {
  const iso = todayIso || new Date().toISOString().slice(0, 10);
  const ranking = computeRanking(historyDir, iso, { days });
  // "Classifica dogane Ticino" broadcast is Ticino-branded — the display-name
  // truthiness check used to double as the Ticino-only filter back when the
  // registry only covered 26 Ticino crossings. Now that it covers 93
  // (67 Germany-corridor added, #4952), every crossing has a display name,
  // so that check no longer excludes them. Filter explicitly instead
  // (same class of bug as border-wait-ranking-content.mjs `known`, #4952).
  const known = ranking.filter((r) => BORDER_CROSSING_DISPLAY[r.slug] && isTicinoCrossing(r.slug));
  const { weekStart, weekEnd } = computeWeekWindow(iso, days);

  if (known.length < 2) {
    return { text: '', rankedCount: known.length, weekStart, weekEnd };
  }

  const fastest = known.slice(0, TELEGRAM_BORDER_TOP);
  const slowest = known.slice(-TELEGRAM_BORDER_TOP).reverse();
  const funFacts = computeFunFacts(known);

  const articleUrl = buildArticleUrl('frontaliere', RANKING_ARTICLE_SLUGS.it);
  const hubUrl = `${SITE_URL}${buildRootHubPath('it')}`;

  const parts = [
    `🚧 <b>Classifica dogane Ticino</b> — settimana del ${escapeHtml(humanRangeIt(weekStart, weekEnd))}`,
    '',
    'Tempo medio di attesa (avvicinamento + coda al varco) sugli ultimi 7 giorni.',
    '',
    '🟢 <b>Le più veloci</b>',
    ...fastest.map((e, i) => crossingLine(e, i)),
    '',
    '🔴 <b>Le più lente</b>',
    ...slowest.map((e, i) => crossingLine(e, i)),
  ];

  if (funFacts) {
    const worst = escapeHtml(BORDER_CROSSING_DISPLAY[funFacts.worstSlug] || funFacts.worstSlug);
    const best = escapeHtml(BORDER_CROSSING_DISPLAY[funFacts.bestSlug] || funFacts.bestSlug);
    parts.push(
      '',
      `📊 Chi passa ogni giorno da ${worst} invece di ${best} perde in media ` +
        `~${escapeHtml(fmtMinutes(funFacts.deltaMinutesPerCrossing))} a passaggio — ` +
        `circa ${escapeHtml(String(funFacts.hoursPerYear))} ore all'anno.`,
    );
  }

  parts.push(
    '',
    articleUrl ? `👉 <a href="${escapeHtml(articleUrl)}">Classifica completa e trend settimanale</a>` : '',
    `🚦 <a href="${escapeHtml(hubUrl)}">Traffico live alle dogane</a>`,
  );

  return {
    text: parts.filter((line) => line !== undefined && line !== null).join('\n'),
    rankedCount: known.length,
    weekStart,
    weekEnd,
  };
}
