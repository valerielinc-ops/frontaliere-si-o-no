/**
 * Build Italian Reddit post content for jobs and blog articles.
 *
 * Reddit has NO hashtag culture: discovery happens via subreddit + flair, not
 * inline tags. So posts are natural Italian prose; flair is applied by the
 * caller (the scheduler reads flair from data/reddit-subreddits.json). Job
 * posts are SELF posts — they keep the user on Reddit and carry the apply link
 * in the body, which is gentler on anti-spam than a bare link post.
 *
 * Generic text sanitizers (stripHtml, stripLeadingSectionLabel, truncateBody)
 * and URL building live in ./social-post-utils.mjs and are REUSED here — they
 * are never re-implemented (project rule: a helper duplicated in ≥2 files must
 * live in one shared module). Salary number formatting matches the FB
 * scheduler (Swiss apostrophe thousands separator).
 */

import {
  stripHtml,
  stripLeadingSectionLabel,
  truncateBody,
  buildJobUrl,
  EMPLOYMENT_TYPE_LABEL,
} from './social-post-utils.mjs';
import { REDDIT_TITLE_MAX } from './reddit-client.mjs';
import { redditUrl, REDDIT_CAMPAIGN_JOB } from './reddit-links.mjs';

// ── Number / salary formatting (consistent with schedule-fb-jobs-daily) ──

function formatNum(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return String(n);
  // Thousand separator with apostrophe (Swiss style).
  return Math.round(num).toString().replace(/\B(?=(\d{3})+(?!\d))/g, "'");
}

function formatSalary(job) {
  const min = job?.baseSalary?.value?.minValue ?? job?.salaryMin;
  const max = job?.baseSalary?.value?.maxValue ?? job?.salaryMax;
  const currency = job?.baseSalary?.currency || 'CHF';
  if (!min && !max) return '';
  if (min && max && min !== max) {
    return `${currency} ${formatNum(min)}–${formatNum(max)}`;
  }
  const v = min || max;
  return `${currency} ${formatNum(v)}`;
}

// ── Title helper ─────────────────────────────────────────────

/** Truncate a title to ≤ REDDIT_TITLE_MAX, ellipsizing cleanly. */
function clampTitle(s) {
  const t = (s || '').trim();
  if (t.length <= REDDIT_TITLE_MAX) return t;
  return truncateBody(t, REDDIT_TITLE_MAX);
}

// ── Job builders ─────────────────────────────────────────────

/**
 * Build a Reddit job submission title in Italian, e.g.
 *   💼 Sviluppatore Frontend · Acme SA — Lugano (CHF 90'000–110'000)
 * Absent chunks are omitted. Always ≤ REDDIT_TITLE_MAX.
 *
 * @param {object} job
 * @returns {string}
 */
export function buildJobTitle(job) {
  const title = (job?.titleByLocale?.it || job?.title || '').trim();
  const company = (job?.hiringOrganization?.name || job?.company || '').trim();
  const city = (job?.jobLocation?.address?.addressLocality || job?.location || '').trim();
  const salary = formatSalary(job);

  let out = `💼 ${title}`;
  if (company) out += ` · ${company}`;
  if (city) out += ` — ${city}`;
  if (salary) out += ` (${salary})`;

  return clampTitle(out);
}

/**
 * Build the markdown self-post body in Italian: a cleaned 1-2 sentence
 * excerpt, a bullet meta line, the apply link, and an automated-listing
 * disclosure.
 *
 * @param {object} job
 * @returns {string}
 */
export function buildJobBody(job) {
  const rawBody = job?.descriptionByLocale?.it || job?.description || '';
  const excerpt = truncateBody(stripLeadingSectionLabel(stripHtml(rawBody)), 300);

  // Meta bullet line — only present chunks.
  const city = (job?.jobLocation?.address?.addressLocality || job?.location || '').trim();
  const salary = formatSalary(job);
  const empLabel = EMPLOYMENT_TYPE_LABEL[job?.employmentType];
  const metaChunks = [];
  if (city) metaChunks.push(`📍 ${city}`);
  if (salary) metaChunks.push(`💰 ${salary}`);
  if (empLabel) metaChunks.push(`📋 ${empLabel}`);

  // Tagged, not the bare job-board URL: this apply link IS the posting
  // boundary for job self-posts (Reddit's `url` submit param is ignored for
  // kind=self — only what's embedded in the markdown body is clickable), so
  // an untagged link here means the click is invisible in GA4 just like the
  // Telegram/FB/LinkedIn links fixed in #6342/#6387.
  const url = redditUrl(buildJobUrl(job), REDDIT_CAMPAIGN_JOB, job?.id);

  const parts = [];
  if (excerpt) parts.push(excerpt);
  if (metaChunks.length) parts.push(`- ${metaChunks.join(' · ')}`);
  if (url) parts.push(`**[Vedi l'offerta e candidati →](${url})**`);
  parts.push('---');
  parts.push('_Annuncio pubblicato automaticamente da Frontaliere Ticino._');

  return parts.join('\n\n');
}

/**
 * Build a complete Reddit job post descriptor.
 * Self-post keeps the user on Reddit and carries the apply link in the body.
 *
 * @param {object} job
 * @returns {{title:string, kind:'self', text:string, topic:'jobs'}}
 */
export function buildJobPost(job) {
  return {
    title: buildJobTitle(job),
    kind: 'self',
    text: buildJobBody(job),
    topic: 'jobs',
  };
}

// ── Article builders ─────────────────────────────────────────

/**
 * Build a Reddit article submission title from the article's og:title.
 * No emoji prefix needed; just trim cleanly to ≤ REDDIT_TITLE_MAX.
 *
 * @param {string} ogTitle
 * @returns {string}
 */
export function buildArticleTitle(ogTitle) {
  return clampTitle(ogTitle);
}

/**
 * Build a complete Reddit article post descriptor. Articles are link posts:
 * Reddit renders the og:* preview from the article URL.
 *
 * @param {object} opts
 * @param {string} [opts.id]
 * @param {string} opts.url
 * @param {string} opts.ogTitle
 * @param {string} [opts.ogDescription]
 * @param {string} [opts.category]
 * @returns {{title:string, kind:'link', url:string, topic:'articles'}}
 */
export function buildArticlePost({ id, url, ogTitle, ogDescription, category } = {}) {
  return {
    title: buildArticleTitle(ogTitle),
    kind: 'link',
    url,
    topic: 'articles',
  };
}
