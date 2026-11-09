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
import { escapeHtml, TELEGRAM_MESSAGE_MAX } from './telegram-client.mjs';
import { telegramUrl, TELEGRAM_CAMPAIGN_BORDER } from './telegram-links.mjs';
import { isGeneratedSocialCopyMode, socialCopyTrackingContent } from './social-copy-pack.mjs';
import {
  computeRanking,
  computeWeekWindow,
  computeFunFacts,
  DEFAULT_WINDOW_DAYS,
} from './border-wait-ranking.mjs';
import { RANKING_ARTICLE_SLUGS } from './border-wait-ranking-content.mjs';

// How many crossings to show in each of the fast/slow shortlists.
export const TELEGRAM_BORDER_TOP = 5;

export function telegramBorderCopyAssignmentKey(todayIso, days = DEFAULT_WINDOW_DAYS) {
  return 'border:' + computeWeekWindow(todayIso, days).weekStart;
}

/** "13–19 luglio 2026" (same month collapses to one month name). */
function humanRangeIt(weekStart, weekEnd) {
  const [ys, mos, ds] = weekStart.split('-').map(Number);
  const [ye, moe, de] = weekEnd.split('-').map(Number);
  if (ys === ye && mos === moe) return `${ds}–${de} ${MONTHS_IT[mos - 1]} ${ye}`;
  if (ys === ye) return `${ds} ${MONTHS_IT[mos - 1]} – ${de} ${MONTHS_IT[moe - 1]} ${ye}`;
  return `${ds} ${MONTHS_IT[mos - 1]} ${ys} – ${de} ${MONTHS_IT[moe - 1]} ${ye}`;
}

function crossingLine(entry, index, socialCopy) {
  const name = escapeHtml(BORDER_CROSSING_DISPLAY[entry.slug] || entry.slug);
  const href = escapeHtml(
    telegramUrl(
      `${SITE_URL}${buildOggiPath('it', entry.slug)}`,
      TELEGRAM_CAMPAIGN_BORDER,
      socialCopyTrackingContent(entry.slug, socialCopy),
    ),
  );
  return `${index + 1}. <a href="${href}">${name}</a> — ${escapeHtml(fmtMinutes(entry.avgMinutes))}`;
}

function renderBorderDigest({ weekStart, weekEnd, fastest, slowest, funFacts, articleUrl, hubUrl, generatedCopy }) {
  const parts = [
    `🚧 <b>Classifica dogane Ticino</b> — settimana del ${escapeHtml(humanRangeIt(weekStart, weekEnd))}`,
    '',
    ...(generatedCopy ? [escapeHtml(generatedCopy.hook), ''] : []),
    'Tempo medio di attesa (avvicinamento + coda al varco) sugli ultimi 7 giorni.',
    '',
    '🟢 <b>Le più veloci</b>',
    ...fastest.map((e, i) => crossingLine(e, i, generatedCopy)),
    '',
    '🔴 <b>Le più lente</b>',
    ...slowest.map((e, i) => crossingLine(e, i, generatedCopy)),
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
    articleUrl ? `👉 <a href="${escapeHtml(articleUrl)}">${escapeHtml(generatedCopy?.cta || 'Classifica completa e trend settimanale')}</a>` : '',
    `🚦 <a href="${escapeHtml(hubUrl)}">Traffico live alle dogane</a>`,
  );

  return parts.filter((line) => line !== undefined && line !== null).join('\n');
}

function copyPrefix(value, length) {
  return Array.from(String(value ?? '')).slice(0, length).join('');
}

/**
 * Fit untrusted/generated copy before the ranking loop can settle on one
 * crossing. The fixed digest (including both CTA anchors) must remain intact;
 * only the dynamic hook and article CTA label may be shortened.
 */
function fitGeneratedCopyToTelegramLimit({ generatedCopy, render }) {
  if (!generatedCopy || render(generatedCopy).length <= TELEGRAM_MESSAGE_MAX) return generatedCopy;

  let bounded = { ...generatedCopy };
  for (const field of ['hook', 'cta']) {
    const value = String(bounded[field] ?? '');
    const characters = Array.from(value);
    const candidate = (length) => ({
      ...bounded,
      [field]: copyPrefix(value, length),
    });
    let best = '';

    // An empty CTA uses the deterministic fallback label. Check it separately
    // because the fallback can be longer than a one-character generated label.
    if (render(candidate(0)).length <= TELEGRAM_MESSAGE_MAX) best = '';
    if (characters.length > 0 && render(candidate(1)).length <= TELEGRAM_MESSAGE_MAX) {
      best = candidate(1)[field];
      let low = 2;
      let high = characters.length;
      while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        const current = candidate(middle);
        if (render(current).length <= TELEGRAM_MESSAGE_MAX) {
          best = current[field];
          low = middle + 1;
        } else {
          high = middle - 1;
        }
      }
    }

    bounded = { ...bounded, [field]: best };
    if (render(bounded).length <= TELEGRAM_MESSAGE_MAX) return bounded;
  }

  // The normal deterministic digest is bounded by the source data. If a
  // malformed generated object still cannot fit, drop only that copy so the
  // fixed message and both links are not handed to sendMessage for truncation.
  return render(null).length <= TELEGRAM_MESSAGE_MAX ? null : bounded;
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
export function buildWeeklyBorderDigest({ historyDir, todayIso, days = DEFAULT_WINDOW_DAYS, socialCopy } = {}) {
  const iso = todayIso || new Date().toISOString().slice(0, 10);
  const ranking = computeRanking(historyDir, iso, { days });
  // "Classifica dogane Ticino" broadcast is Ticino-branded — the display-name
  // truthiness check used to double as the Ticino-only filter back when the
  // registry only covered 26 Ticino crossings. Now that it covers 134
  // (108 non-Ticino Germany/Austria/Liechtenstein/France crossings added,
  // #4952/#4889), every crossing has a display name, so that check no
  // longer excludes them. Filter explicitly instead (same class of bug as
  // border-wait-ranking-content.mjs `known`, #4952).
  const known = ranking.filter((r) => BORDER_CROSSING_DISPLAY[r.slug] && isTicinoCrossing(r.slug));
  const { weekStart, weekEnd } = computeWeekWindow(iso, days);

  if (known.length < 2) {
    return { text: '', rankedCount: known.length, weekStart, weekEnd };
  }

  const funFacts = computeFunFacts(known);
  const generatedCopy = isGeneratedSocialCopyMode(socialCopy?.copyMode) ? socialCopy : null;

  const rawArticleUrl = buildArticleUrl('frontaliere', RANKING_ARTICLE_SLUGS.it);
  const articleUrl = rawArticleUrl
    ? telegramUrl(
        rawArticleUrl,
        TELEGRAM_CAMPAIGN_BORDER,
        socialCopyTrackingContent('ranking_article', generatedCopy),
      )
    : rawArticleUrl;
  const hubUrl = telegramUrl(
    `${SITE_URL}${buildRootHubPath('it')}`,
    TELEGRAM_CAMPAIGN_BORDER,
    socialCopyTrackingContent('live_hub', generatedCopy),
  );

  const oneEntryArgs = {
    weekStart,
    weekEnd,
    fastest: known.slice(0, 1),
    slowest: known.slice(-1).reverse(),
    funFacts,
    articleUrl,
    hubUrl,
  };
  const generatedCopyForRender = fitGeneratedCopyToTelegramLimit({
    generatedCopy,
    render: (copy) => renderBorderDigest({ ...oneEntryArgs, generatedCopy: copy }),
  });

  let visibleTop = TELEGRAM_BORDER_TOP;
  let text = '';
  do {
    text = renderBorderDigest({
      weekStart,
      weekEnd,
      fastest: known.slice(0, visibleTop),
      slowest: known.slice(-visibleTop).reverse(),
      funFacts,
      articleUrl,
      hubUrl,
      generatedCopy: generatedCopyForRender,
    });
    if (text.length <= TELEGRAM_MESSAGE_MAX || visibleTop === 1) break;
    visibleTop -= 1;
  } while (visibleTop > 0);

  return {
    text,
    rankedCount: known.length,
    weekStart,
    weekEnd,
  };
}
