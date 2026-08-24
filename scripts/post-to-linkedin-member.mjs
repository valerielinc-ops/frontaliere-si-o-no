#!/usr/bin/env node
/**
 * post-to-linkedin-member.mjs — daily personal-profile LinkedIn post:
 * yesterday's most-clicked ARTICLE and yesterday's most-clicked JOB.
 *
 * ── This is NOT scripts/post-to-linkedin.mjs ───────────────────────────────
 * They are separate on purpose; the two LinkedIn surfaces share nothing but
 * the hostname:
 *
 *   |            | post-to-linkedin.mjs        | this file                   |
 *   | author URN | urn:li:organization:<id>    | urn:li:person:<id>          |
 *   | scope      | w_organization_social       | w_member_social             |
 *   | product    | Community Management API    | Share on LinkedIn           |
 *   | status     | access DENIED (appeal       | provisioned, instant, no    |
 *   |            | CAS-11756532-G7J8T5)        | review                      |
 *   | token      | LINKEDIN_POST_*             | LINKEDIN_MEMBER_*           |
 *
 * Merging them would couple a working path to a blocked one and would make the
 * author URN a runtime branch on a credential — the exact shape that makes a
 * mis-posted-as-the-wrong-identity bug possible. A post published under the
 * wrong author cannot be "moved"; it can only be deleted and redone.
 *
 * Usage:
 *   node scripts/post-to-linkedin-member.mjs                # post both slots
 *   node scripts/post-to-linkedin-member.mjs --dry-run      # print, post nothing
 *   node scripts/post-to-linkedin-member.mjs --only=article # one slot
 *   node scripts/post-to-linkedin-member.mjs --date=2026-08-23
 *
 * Env (all via Firebase Remote Config → scripts/load-rc-env.mjs):
 *   LINKEDIN_MEMBER_ACCESS_TOKEN   required unless the refresh trio is set
 *   LINKEDIN_MEMBER_REFRESH_TOKEN  + _CLIENT_ID + _CLIENT_SECRET → auto-refresh
 *   LINKEDIN_MEMBER_URN            required: urn:li:person:<id> (see below)
 *   GA4_PROPERTY_ID                defaults to properties/524485296
 *   GOOGLE_APPLICATION_CREDENTIALS service account for the GA4 read
 *
 * FAIL-SOFT: exit code is ALWAYS 0. A missing token, a missing URN, an empty
 * GA4 day or a LinkedIn 4xx all log a reason and return — this runs on a cron
 * and must never turn the repo red for a credential the owner has not set yet.
 * The only thing that changes state is a successful post, and the ledger is
 * appended immediately after each one (never batched at the end), so a failure
 * on the second slot can never cause the first to be reposted tomorrow.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SITE_URL,
  loadLedger,
  appendLedger,
  truncateBody,
} from './lib/social-post-utils.mjs';
import {
  linkedinUrl,
  LINKEDIN_MEMBER_CAMPAIGN_ARTICLE,
  LINKEDIN_MEMBER_CAMPAIGN_JOB,
} from './lib/linkedin-links.mjs';
import {
  previousReportDay,
  rankCandidates,
  pickFirstUnposted,
} from './lib/daily-top-content.mjs';
import {
  DEFAULT_GA4_PROPERTY_ID,
  getServiceAccountToken,
  fetchRetry,
} from './lib/ga4-service-account.mjs';
import { createCantonResolvers, AGGREGATE_KEY } from '../build-plugins/shared/cantonResolvers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const LEDGER_PATH = path.join(ROOT, 'data', 'linkedin-member-posted.json');
const POSTED_TRIM_LIMIT = 1000;

/**
 * Only the last 30 days block a repost. Deduping against the ledger FOREVER
 * would slowly starve the picker: an evergreen article that legitimately tops
 * the day again six months later is a fine thing to post, and permanent
 * exclusion would push the daily pick further and further down the ranking
 * until it is posting the day's #40.
 */
const DEDUP_WINDOW_DAYS = 30;

const LINKEDIN_API = 'https://api.linkedin.com/rest/posts';
const LINKEDIN_VERSION = '202401';
/** LinkedIn hard-rejects commentary over 3000 chars; stay under it. */
const COMMENTARY_MAX = 2900;

const HASHTAGS_ARTICLE = '#frontalieri #ticino #svizzera #italia #lavoro';
const HASHTAGS_JOB = '#frontalieri #ticino #lavoro #svizzera #offertedilavoro';

// ─────────────────────────── credentials ───────────────────────────

async function getAccessToken() {
  const refreshToken = process.env.LINKEDIN_MEMBER_REFRESH_TOKEN;
  const clientId = process.env.LINKEDIN_MEMBER_CLIENT_ID;
  const clientSecret = process.env.LINKEDIN_MEMBER_CLIENT_SECRET;
  const staticToken = process.env.LINKEDIN_MEMBER_ACCESS_TOKEN;

  if (refreshToken && clientId && clientSecret) {
    try {
      const res = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: clientId,
          client_secret: clientSecret,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (data.access_token) {
        console.log(`🔄 member token refreshed (expires in ${data.expires_in}s)`);
        return data.access_token;
      }
      console.warn('⚠️  member token refresh failed — falling back to the static token');
    } catch (err) {
      console.warn(`⚠️  member token refresh threw: ${err.message}`);
    }
  }
  return staticToken || null;
}

/**
 * The author URN, which this app CANNOT discover on its own.
 *
 * /v2/userinfo (OIDC) and the legacy /v2/me are the only endpoints returning
 * the person id, and both need a scope the app does not have: it carries ONLY
 * w_member_social ("Sign In with LinkedIn using OpenID Connect" is not an added
 * product — verified on the app's Products page 2026-08-24). So the URN is
 * configuration, not something to resolve at runtime.
 * scripts/linkedin-member-auth.mjs prints it when it can, and documents the two
 * manual ways to obtain it otherwise.
 */
function getAuthorUrn() {
  const raw = String(process.env.LINKEDIN_MEMBER_URN || '').trim();
  if (!raw) return null;
  if (raw.startsWith('urn:li:person:')) return raw;
  if (/^[A-Za-z0-9_-]+$/.test(raw)) return `urn:li:person:${raw}`;
  console.warn(`⚠️  LINKEDIN_MEMBER_URN is malformed: ${raw}`);
  return null;
}

// ─────────────────────────── GA4 ───────────────────────────

/**
 * Italian job-board section slugs: the 24 canton sections, the legacy Ticino
 * one, and the AGGREGATE section.
 *
 * `_AGGREGATE_` resolves to `cerca-lavoro-svizzera` and is easy to forget
 * because it is not in the `cantons` table — omitting it silently dropped every
 * job living under the Swiss-wide board from the ranking.
 */
function loadJobSections() {
  try {
    const cantonSlugFile = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'data', 'canton-url-slugs.json'), 'utf-8'),
    );
    const municipalitiesFile = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'data', 'canton-municipalities.json'), 'utf-8'),
    );
    const { resolveCantonSection } = createCantonResolvers({
      cantonSlugFile,
      municipalitiesFile,
    });
    const out = new Set();
    const codes = [...Object.keys(cantonSlugFile.cantons || {}), 'TI', AGGREGATE_KEY];
    for (const code of codes) {
      const section = resolveCantonSection('it', code);
      if (section) out.add(section);
    }
    return out;
  } catch (err) {
    console.warn(`⚠️  could not build the job-section set: ${err.message}`);
    return new Set();
  }
}

/**
 * slug → job record, across every locale slug variant.
 *
 * WHY this is mandatory and not a nicety: under a canton section the URL shape
 * of a job detail page and of a generated SEO landing page are identical.
 * `/cerca-lavoro-ticino/infermieri/` topped 2026-08-23 with 271 views and is a
 * "37 offerte" profession page, not an offer — posting it as "the most clicked
 * job" would be simply false. Membership in the real dataset is the only
 * non-rotting way to tell them apart, so when the dataset is unavailable this
 * returns an empty Map and the caller SKIPS the job slot rather than guessing.
 *
 * @returns {Map<string, object>}
 */
function loadJobIndex() {
  /** @type {Map<string, object>} */
  const index = new Map();
  const add = (slug, job) => {
    const s = String(slug || '').trim();
    if (s) index.set(s, job);
  };

  const ingest = (jobs) => {
    for (const job of jobs || []) {
      add(job?.slug, job);
      for (const v of Object.values(job?.slugByLocale || {})) add(v, job);
    }
  };

  try {
    const assembled = path.join(ROOT, 'data', 'jobs.json');
    if (fs.existsSync(assembled)) {
      const parsed = JSON.parse(fs.readFileSync(assembled, 'utf-8'));
      ingest(Array.isArray(parsed) ? parsed : parsed.jobs);
      return index;
    }
    const dir = path.join(ROOT, 'data', 'jobs', 'by-crawler');
    if (fs.existsSync(dir)) {
      for (const file of fs.readdirSync(dir)) {
        if (!file.endsWith('.json')) continue;
        try {
          ingest(JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8')).jobs);
        } catch {
          /* one unreadable crawler file must not void the whole index */
        }
      }
    }
  } catch (err) {
    console.warn(`⚠️  could not build the job index: ${err.message}`);
  }
  return index;
}

async function fetchGa4Day(day) {
  const token = await getServiceAccountToken([
    'https://www.googleapis.com/auth/analytics.readonly',
  ]);
  if (!token) return null;

  const raw = process.env.GA4_PROPERTY_ID || DEFAULT_GA4_PROPERTY_ID;
  const property = raw.startsWith('properties/') ? raw : `properties/${raw}`;

  const res = await fetchRetry(
    `https://analyticsdata.googleapis.com/v1beta/${property}:runReport`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        dateRanges: [{ startDate: day, endDate: day }],
        dimensions: [{ name: 'pagePath' }, { name: 'pageTitle' }],
        metrics: [{ name: 'screenPageViews' }],
        orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
        limit: 10000,
      }),
    },
  );
  if (!res?.ok) {
    console.warn(`⚠️  GA4 runReport failed (${res?.status}) — nothing to post`);
    return null;
  }
  const data = await res.json();
  if (data.error) {
    console.warn(`⚠️  GA4 error: ${JSON.stringify(data.error).slice(0, 200)}`);
    return null;
  }
  return (data.rows || []).map((r) => ({
    path: r.dimensionValues?.[0]?.value || '',
    title: r.dimensionValues?.[1]?.value || '',
    views: parseInt(r.metricValues?.[0]?.value || '0', 10),
  }));
}

// ─────────────────────────── copy ───────────────────────────

function buildCommentary({ kind, title, url, views, day, location }) {
  const isJob = kind === 'job';
  const emoji = isJob ? '💼' : '📰';
  const lead = isJob
    ? "L'offerta di lavoro più cliccata di ieri su frontaliereticino.ch:"
    : "L'articolo più letto di ieri su frontaliereticino.ch:";
  const hashtags = isJob ? HASHTAGS_JOB : HASHTAGS_ARTICLE;
  const counter =
    Number(views) > 0
      ? `📊 ${views} visualizzazioni il ${formatDayIt(day)}.`
      : '';
  const place = isJob && location ? `📍 ${location}` : '';

  const body = [
    `${emoji} ${lead}`,
    '',
    truncateBody(title, 200),
    place,
    counter,
    '',
    `👉 ${url}`,
    '',
    hashtags,
  ]
    .filter((line) => line !== null && line !== undefined)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return truncateBody(body, COMMENTARY_MAX);
}

/** '2026-08-23' → '23/08/2026' (the post copy is Italian). */
function formatDayIt(day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ''));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : String(day || '');
}

// ─────────────────────────── posting ───────────────────────────

async function publish({ accessToken, authorUrn, commentary, url, title }) {
  const payload = {
    author: authorUrn,
    commentary,
    visibility: 'PUBLIC',
    distribution: {
      feedDistribution: 'MAIN_FEED',
      targetEntities: [],
      thirdPartyDistributionChannels: [],
    },
    content: { article: { source: url, title: truncateBody(title, 180) } },
    lifecycleState: 'PUBLISHED',
    isReshareDisabledByAuthor: false,
  };

  const res = await fetch(LINKEDIN_API, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'LinkedIn-Version': LINKEDIN_VERSION,
      'X-Restli-Protocol-Version': '2.0.0',
    },
    body: JSON.stringify(payload),
  });

  if (res.status === 201) {
    return { ok: true, postId: res.headers.get('x-restli-id') || 'unknown' };
  }
  const text = await res.text().catch(() => '');
  if (res.status === 401) {
    console.error('💡 401 — the member token expired; re-run scripts/linkedin-member-auth.mjs');
  }
  if (res.status === 403) {
    console.error('💡 403 — the token is missing w_member_social, or the URN is not its owner');
  }
  return { ok: false, status: res.status, body: text.slice(0, 300) };
}

// ─────────────────────────── main ───────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const onlyArg = args.find((a) => a.startsWith('--only='));
  const only = onlyArg ? onlyArg.split('=')[1] : null;
  const dateArg = args.find((a) => a.startsWith('--date='));
  const day = dateArg ? dateArg.split('=')[1] : previousReportDay();

  console.log(`─── LinkedIn member daily — day ${day}${dryRun ? ' (dry run)' : ''} ───`);

  const rows = await fetchGa4Day(day);
  if (!rows) {
    console.log('ℹ️  no GA4 data available — nothing to do');
    return;
  }

  const jobSections = loadJobSections();
  const jobIndex = loadJobIndex();
  if (jobIndex.size === 0) {
    console.log(
      'ℹ️  jobs dataset unavailable (run scripts/assemble-jobs-dataset.mjs) — the job slot is skipped',
    );
  }
  const { articles, jobs } = rankCandidates(rows, {
    jobSections,
    // No index ⇒ no job passes ⇒ the slot is skipped. Never post an unvalidated path.
    isJobSlug: (slug) => jobIndex.has(slug),
  });
  console.log(
    `GA4 rows: ${rows.length} → ${articles.length} articles, ${jobs.length} jobs ` +
      `(job index: ${jobIndex.size} slugs)`,
  );

  // Ledger, filtered to the dedup window.
  const ledger = loadLedger(LEDGER_PATH);
  const cutoff = Date.now() - DEDUP_WINDOW_DAYS * 86400000;
  const recent = new Set(
    ledger.posted
      .filter((e) => {
        const ts = Date.parse(e?.ts ?? '');
        return Number.isFinite(ts) ? ts >= cutoff : true;
      })
      .map((e) => e?.id)
      .filter(Boolean),
  );

  const slots = [
    { kind: 'article', candidates: articles, campaign: LINKEDIN_MEMBER_CAMPAIGN_ARTICLE },
    { kind: 'job', candidates: jobs, campaign: LINKEDIN_MEMBER_CAMPAIGN_JOB },
  ].filter((s) => !only || s.kind === only);

  // Resolve credentials once, but only when something would actually be sent.
  let accessToken = null;
  let authorUrn = null;
  if (!dryRun) {
    accessToken = await getAccessToken();
    authorUrn = getAuthorUrn();
    if (!accessToken) {
      console.log('⚠️  no LINKEDIN_MEMBER_ACCESS_TOKEN / refresh trio — skipping (soft)');
      return;
    }
    if (!authorUrn) {
      console.log('⚠️  no LINKEDIN_MEMBER_URN — skipping (soft). See scripts/linkedin-member-auth.mjs');
      return;
    }
  }

  for (const slot of slots) {
    const { pick, skipped, exhausted } = pickFirstUnposted(slot.candidates, recent);
    if (!pick) {
      console.log(
        exhausted
          ? `ℹ️  ${slot.kind}: every candidate was posted in the last ${DEDUP_WINDOW_DAYS}d — skipping`
          : `ℹ️  ${slot.kind}: no candidate for ${day} — skipping`,
      );
      continue;
    }
    if (skipped) console.log(`↪️  ${slot.kind}: skipped ${skipped} already-posted candidate(s)`);

    const canonical = `${SITE_URL}${pick.path}/`;
    const url = linkedinUrl(canonical, slot.campaign, pick.slug);
    // For a job the dataset is a better title source than GA4's pageTitle: it
    // carries the employer, which the page title often drops.
    const job = slot.kind === 'job' ? jobIndex.get(pick.slug) : null;
    const title = job
      ? [job.title, job.company].filter(Boolean).join(' — ')
      : pick.title || pick.slug.replace(/-/g, ' ');
    const commentary = buildCommentary({
      kind: slot.kind,
      title,
      url,
      views: pick.views,
      day,
      location: job?.location || '',
    });

    console.log(`\n─── ${slot.kind} pick: ${pick.slug} (${pick.views} views) ───`);
    console.log(commentary);
    console.log('───');

    if (dryRun) continue;

    const res = await publish({ accessToken, authorUrn, commentary, url, title });
    if (res.ok) {
      console.log(`✅ posted — ${res.postId}`);
      // Append per successful post, never batched: a throw on the next slot
      // must not cost us this slot's dedup record.
      appendLedger(
        LEDGER_PATH,
        [
          {
            id: pick.slug,
            kind: slot.kind,
            url: canonical,
            day,
            views: pick.views,
            ts: new Date().toISOString(),
            linkedinPostId: res.postId,
          },
        ],
        POSTED_TRIM_LIMIT,
      );
      recent.add(pick.slug);
    } else {
      console.error(`⚠️  LinkedIn ${res.status}: ${res.body}`);
    }
  }
}

main()
  .catch((err) => {
    // Fail-soft: log and exit 0. See the header.
    console.error(`⚠️  post-to-linkedin-member failed: ${err.message}`);
  })
  .finally(() => process.exit(0));
