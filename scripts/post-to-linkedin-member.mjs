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

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SITE_URL,
  loadLedger,
  appendLedger,
  loadJobSections,
  loadJobIndex,
} from './lib/social-post-utils.mjs';
import {
  linkedinUrl,
  LINKEDIN_MEMBER_CAMPAIGN_ARTICLE,
  LINKEDIN_MEMBER_CAMPAIGN_JOB,
  LINKEDIN_REST_VERSION,
} from './lib/linkedin-links.mjs';
import {
  previousReportDay,
  rankCandidates,
  pickFirstUnposted,
} from './lib/daily-top-content.mjs';
import { fetchGa4PageReport } from './lib/ga4-service-account.mjs';
import { getLinkedInMemberAccessToken } from './lib/linkedin-member-access-token.mjs';
import {
  buildArticleContent,
  buildMemberCommentary,
  buildMemberPostPayload,
  inferArticleLocation,
  resolveJobCompany,
  resolveJobDescription,
  resolveJobLocation,
  resolveOrganizationUrn,
} from './lib/linkedin-member-copy.mjs';
import { fetchPageOg, uploadLinkedInImage } from './lib/linkedin-member-media.mjs';
import { buildSocialCopyBlockContext, loadSocialCopyPack, markSocialCopyAssignmentPublished, releaseUnpublishedSocialCopyAssignmentBestEffort, selectSocialCopyForPublish, socialCopyLedgerFields, socialCopyTrackingContent } from './lib/social-copy-pack.mjs';
import {
  markSocialPublishReservationPublished,
  releaseSocialPublishReservation,
  reserveSocialPublishBatch,
  socialPublishContentFingerprint,
  socialPublishReservationKey,
} from './lib/social-publish-reservations.mjs';
import { classifyLinkedInMemberPostResponse } from './lib/linkedin-member-publish.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const LEDGER_PATH = path.join(ROOT, 'data', 'linkedin-member-posted.json');
const POSTED_TRIM_LIMIT = 1000;
const SOCIAL_COPY_PACK = loadSocialCopyPack({
  onWarning: (message) => console.warn(`⚠️  ${message}`),
});

/**
 * Only the last 30 days block a repost. Deduping against the ledger FOREVER
 * would slowly starve the picker: an evergreen article that legitimately tops
 * the day again six months later is a fine thing to post, and permanent
 * exclusion would push the daily pick further and further down the ranking
 * until it is posting the day's #40.
 */
const DEDUP_WINDOW_DAYS = 30;

const LINKEDIN_API = 'https://api.linkedin.com/rest/posts';
const LINKEDIN_VERSION = LINKEDIN_REST_VERSION;

// ─────────────────────────── credentials ───────────────────────────

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
// loadJobSections/loadJobIndex moved to scripts/lib/social-post-utils.mjs —
// the Instagram/TikTok carousel posters need the identical logic (project
// rule: a helper duplicated literally in ≥2 files MUST live in ONE shared
// module).

// fetchGa4Day moved to scripts/lib/ga4-service-account.mjs#fetchGa4PageReport
// — Instagram/TikTok posters need the identical report (project rule: a
// helper duplicated literally in ≥2 files MUST live in ONE shared module).

// Commentary, mentions and article-card payload live in
// scripts/lib/linkedin-member-copy.mjs so vitest can drive them with fixtures.

// ─────────────────────────── posting ───────────────────────────

async function publish({ accessToken, payload }) {
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

  const successfulHttpResponse = res.status >= 200 && res.status < 300;
  const text = successfulHttpResponse ? '' : await res.text().catch(() => '');
  if (res.status === 401) {
    console.error('💡 401 — the member token expired; re-run scripts/linkedin-member-auth.mjs');
  }
  if (res.status === 403) {
    console.error('💡 403 — the token is missing w_member_social, or the URN is not its owner');
  }
  return classifyLinkedInMemberPostResponse({
    status: res.status,
    postId: res.headers.get('x-restli-id'),
    body: text,
  });
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

  const rows = await fetchGa4PageReport(day);
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
    accessToken = await getLinkedInMemberAccessToken({
      log: (message) => console.log(`🔄 ${message}`),
    });
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
    // For a job the dataset is a better title source than GA4's pageTitle: it
    // carries the employer, which the page title often drops.
    const job = slot.kind === 'job' ? jobIndex.get(pick.slug) : null;
    const company = resolveJobCompany(job);
    const jobTitle = job
      ? String(job.titleByLocale?.it || job.title || '').trim()
      : '';
    const title = job
      ? [jobTitle, company].filter(Boolean).join(' — ')
      : pick.title || pick.slug.replace(/-/g, ' ');
    const location = job
      ? resolveJobLocation(job)
      : inferArticleLocation({ title, path: pick.path });

    // Live page OG: excerpt for the body + og:image for the card thumbnail.
    // Posts API does not scrape OG; without a thumbnail URN the card is text-only.
    const pageMeta = await fetchPageOg(canonical);
    const excerpt =
      slot.kind === 'job' ? resolveJobDescription(job) : pageMeta.ogDescription;

    const socialCopy = await selectSocialCopyForPublish({
      pack: SOCIAL_COPY_PACK,
      channel: 'linkedin',
      kind: slot.kind,
      assignmentKey: pick.slug,
      blockContext: buildSocialCopyBlockContext({ sourceClass: slot.kind, scheduledDate: day }),
      allowExperimentExposure: !dryRun,
      dryRun,
    });
    let reservedCopy = socialCopy;
    let deliveryAttempted = false;
    try {
    const url = linkedinUrl(
      canonical,
      slot.campaign,
      socialCopyTrackingContent(pick.slug, socialCopy),
    );
    const commentary = buildMemberCommentary({
      kind: slot.kind,
      title: job ? jobTitle || title : title,
      url,
      day,
      excerpt,
      company,
      organizationUrn: resolveOrganizationUrn(job),
      location,
      canton: job?.canton || '',
      socialCopy,
    });

    let thumbnail = null;
    if (!dryRun && accessToken && authorUrn && pageMeta.ogImage) {
      thumbnail = await uploadLinkedInImage({
        accessToken,
        ownerUrn: authorUrn,
        imageUrl: pageMeta.ogImage,
      });
      if (thumbnail) console.log(`🖼  thumbnail ${thumbnail}`);
      else console.log('⚠️  posting article card without thumbnail (upload fail-soft)');
    }

    const article = buildArticleContent({
      source: url,
      title,
      description: excerpt || pageMeta.ogDescription,
      thumbnail,
    });

    console.log(`\n─── ${slot.kind} pick: ${pick.slug} (${pick.views} views) ───`);
    console.log(commentary);
    console.log('─── article card ───');
    console.log(JSON.stringify(article, null, 2));
    console.log('───');

    if (dryRun) continue;

    const publishAt = new Date();
    const postPayload = buildMemberPostPayload({ author: authorUrn, commentary, article });
    const reservationKey = socialPublishReservationKey(
      'linkedinMember',
      'member-post',
      `${slot.kind}:${pick.slug}`,
    );
    const reservation = await reserveSocialPublishBatch({
      platform: 'linkedinMember',
      accountId: authorUrn,
      repoRoot: ROOT,
      reservations: [{
        key: reservationKey,
        publishAt,
        nativeContentFingerprint: socialPublishContentFingerprint('linkedinMember', {
          commentary: postPayload.commentary,
          content: postPayload.content,
        }),
      }],
      now: publishAt,
    });
    if (!reservation[0]?.allowed) {
      console.warn(`🛑 LinkedIn member post held by the shared daily cap (${reservation[0]?.reason || 'reservation-denied'})`);
      continue;
    }

    deliveryAttempted = true;
    const res = await publish({ accessToken, payload: postPayload });
    if (res.ok) {
      reservedCopy = null;
      console.log(`✅ posted — ${res.postId}`);
      const publishedAt = new Date().toISOString();
      // Append before closing the shared reservation. If this write fails,
      // the held reservation blocks replay and remains visible for recovery.
      try {
        appendLedger(
          LEDGER_PATH,
          [
            {
              id: pick.slug,
              kind: slot.kind,
              url: canonical,
              day,
              views: pick.views,
              ts: publishedAt,
              linkedinPostId: res.postId,
              socialReservationType: 'member-post',
              socialReservationId: `${slot.kind}:${pick.slug}`,
              ...socialCopyLedgerFields(socialCopy),
            },
          ],
          POSTED_TRIM_LIMIT,
        );
      } catch (error) {
        console.error(`❌ LinkedIn accepted the post, but its canonical ledger write failed: ${error.message}`);
        process.exitCode = 1;
        throw error;
      }
      try {
        await markSocialPublishReservationPublished({
          platform: 'linkedinMember',
          accountId: authorUrn,
          key: reservationKey,
          publishAt,
          publishedAt,
        });
      } catch (error) {
        console.error(`⚠️  LinkedIn accepted the post; its shared reservation remains held: ${error.message}`);
      }
      try {
        await markSocialCopyAssignmentPublished(socialCopy, { postId: res.postId, publishedAt });
      } catch (error) {
        console.error(`⚠️  accepted LinkedIn post could not close its copy assignment: ${error.message}`);
      }
      recent.add(pick.slug);
    } else {
      console.error(`⚠️  LinkedIn ${res.status}: ${res.body}`);
      if (res.deliveryUncertain) {
        console.error('⚠️  LinkedIn publication outcome is ambiguous; shared reservation remains held to prevent replay');
        reservedCopy = null;
      } else {
        try {
          await releaseSocialPublishReservation({
            platform: 'linkedinMember',
            accountId: authorUrn,
            key: reservationKey,
            publishAt,
          });
        } catch (error) {
          console.warn(`⚠️  LinkedIn reservation remains held after explicit API rejection: ${error.message}`);
        }
        const rejectedCopy = reservedCopy;
        reservedCopy = null;
        await releaseUnpublishedSocialCopyAssignmentBestEffort(rejectedCopy, {
          reason: 'LinkedIn explicitly rejected the member post',
          onFailure: (err) => console.error(`⚠️  Could not release LinkedIn ${slot.kind} copy reservation for ${pick.slug}: ${err.message}`),
        });
      }
    }
    } catch (err) {
      // A transport exception after the POST starts can mean LinkedIn accepted
      // the post but the response was lost; keep the assignment for reconcile.
      if (deliveryAttempted) reservedCopy = null;
      throw err;
    } finally {
      await releaseUnpublishedSocialCopyAssignmentBestEffort(reservedCopy, {
        reason: 'LinkedIn member post skipped before delivery',
        onFailure: (err) => console.error(`⚠️  Could not release LinkedIn ${slot.kind} copy reservation for ${pick.slug}: ${err.message}`),
      });
    }
  }
}

main()
  .catch((err) => {
    // General failures stay fail-soft; accepted posts missing a ledger set exitCode above.
    console.error(`⚠️  post-to-linkedin-member failed: ${err.message}`);
  })
  .finally(() => process.exit(process.exitCode ?? 0));
