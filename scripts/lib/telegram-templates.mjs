/**
 * Build the Italian Telegram broadcast message for the "jobs of the day"
 * digest. One message per run lists the top N freshest never-posted jobs, each
 * a canonical trailing-slash link to its job page, followed by a CTA to the
 * full Ticino job board.
 *
 * Generic text sanitizers, job selection, salary formatting and URL building
 * live in ./social-post-utils.mjs and are REUSED here — never re-implemented
 * (project rule: a helper duplicated in ≥2 files must live in one shared
 * module). HTML escaping comes from ./telegram-client.mjs (Telegram HTML parse
 * mode). Both dependencies are plain `.mjs`, so this module — and the jobs mode
 * of post-to-telegram.mjs — run under plain `node` (no `tsx`).
 */

import {
  buildJobUrl,
  formatJobSalaryLabel,
  EMPLOYMENT_TYPE_LABEL,
  SITE_URL,
} from './social-post-utils.mjs';
import { escapeHtml } from './telegram-client.mjs';
import { telegramUrl, TELEGRAM_CAMPAIGN_JOBS } from './telegram-links.mjs';

// Default number of jobs per daily digest. Conservative — a broadcast channel
// wants a scannable shortlist, not a wall of every job crawled today.
export const DEFAULT_JOBS_LIMIT = 5;

// Canonical IT-locale job-board hub (trailing slash — site convention).
export const JOB_BOARD_HUB_URL = `${SITE_URL}/cerca-lavoro-ticino/`;

/** One numbered job entry: linked title + a meta line (city · salary · type). */
function jobEntry(job, index) {
  // UTM-tagged so the click is attributable in GA4. `buildJobUrl` still decides
  // whether the job is linkable at all — tagging never invents a URL.
  const canonical = buildJobUrl(job);
  const url = canonical
    ? telegramUrl(canonical, TELEGRAM_CAMPAIGN_JOBS, job?.slug || job?.id || '')
    : canonical;
  const title = escapeHtml((job?.titleByLocale?.it || job?.title || 'Offerta di lavoro').trim());
  const linkedTitle = url ? `<a href="${escapeHtml(url)}">${title}</a>` : title;

  const company = escapeHtml((job?.hiringOrganization?.name || job?.company || '').trim());
  const city = escapeHtml((job?.jobLocation?.address?.addressLocality || job?.location || '').trim());
  const salary = escapeHtml(formatJobSalaryLabel(job));
  const empLabel = EMPLOYMENT_TYPE_LABEL[job?.employmentType];

  const meta = [
    company && `🏢 ${company}`,
    city && `📍 ${city}`,
    salary && `💰 ${salary}`,
    empLabel && `📋 ${empLabel}`,
  ]
    .filter(Boolean)
    .join(' · ');

  const head = `${index + 1}. ${linkedTitle}`;
  return meta ? `${head}\n   ${meta}` : head;
}

/**
 * Build the daily jobs digest message. Only jobs with a resolvable canonical
 * URL are included (a broadcast must never link to a dead page). Caller is
 * responsible for pre-filtering already-posted jobs (dedup ledger) and passing
 * the freshest candidates; this builder just formats + caps the list.
 *
 * @param {Array<object>} jobs — candidate jobs (freshest first).
 * @param {{ limit?: number, dateLabel?: string }} [opts]
 * @returns {{ text: string, jobIds: string[], count: number }}
 */
export function buildDailyJobsDigest(jobs, { limit = DEFAULT_JOBS_LIMIT, dateLabel } = {}) {
  const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_JOBS_LIMIT;
  const usable = (Array.isArray(jobs) ? jobs : [])
    .filter((job) => job && job.id && buildJobUrl(job))
    .slice(0, cap);

  if (usable.length === 0) {
    return { text: '', jobIds: [], count: 0 };
  }

  const header = `💼 <b>Offerte di lavoro in Ticino${dateLabel ? ` — ${escapeHtml(dateLabel)}` : ''}</b>`;
  const entries = usable.map((job, i) => jobEntry(job, i));
  const ctaUrl = telegramUrl(JOB_BOARD_HUB_URL, TELEGRAM_CAMPAIGN_JOBS, 'hub');
  const cta = `👉 <a href="${escapeHtml(ctaUrl)}">Tutte le offerte in Ticino</a>`;

  const text = [header, '', entries.join('\n\n'), '', cta].join('\n');
  return { text, jobIds: usable.map((j) => j.id), count: usable.length };
}
