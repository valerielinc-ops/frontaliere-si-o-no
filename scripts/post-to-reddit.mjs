#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
/**
 * Post a new blog article to Reddit.
 *
 * Mirrors scripts/post-to-facebook.mjs but for Reddit. Reddit has no
 * server-side scheduled-publish, so the article is submitted IMMEDIATELY
 * to every automation-enabled subreddit routed for the "articles" topic,
 * with a small delay between subs to respect Reddit rate limits.
 *
 * Usage:
 *   node scripts/post-to-reddit.mjs <article-id> <article-url> <og-title> <og-description> [category] [--dry-run]
 *
 * Environment variables (consumed by scripts/lib/reddit-client.mjs):
 *   REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET, REDDIT_USERNAME,
 *   REDDIT_PASSWORD, REDDIT_USER_AGENT — OAuth "script" app credentials.
 *
 * Exit code is always 0 (soft failure) — this script should never block CI.
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getAccessToken, submitPost, userAgent } from './lib/reddit-client.mjs';
import { buildArticlePost } from './lib/reddit-templates.mjs';
import { automationEligibleSubs } from './lib/redditAutomationPolicy.mjs';
import { redditUrl, REDDIT_CAMPAIGN_ARTICLE } from './lib/reddit-links.mjs';
import { loadLedger, appendLedger } from './lib/social-post-utils.mjs';
import {
  loadSocialCopyPack,
  releaseSocialCopyAssignment,
  selectSocialCopyForPublish,
  socialCopyLedgerFields,
  socialCopyTrackingContent,
} from './lib/social-copy-pack.mjs';

// Delay between subreddit submissions (ms). Conservative to respect
// Reddit anti-spam / rate limits.
const INTER_SUB_DELAY_MS = 3000;
const ARTICLE_POSTED_TRIM_LIMIT = 1000;

function defaultRepoRoot() {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  return resolve(__dirname, '..');
}

function subredditsPath(repoRoot) {
  return resolve(repoRoot, 'data', 'reddit-subreddits.json');
}

/**
 * Read `data/reddit-subreddits.json`. Returns a config object with empty
 * `subreddits`/`routing` on missing file or malformed JSON — never throws.
 */
function loadSubreddits(repoRoot) {
  const file = subredditsPath(repoRoot);
  try {
    if (!existsSync(file)) return { schemaVersion: 1, subreddits: {}, routing: {} };
    const parsed = JSON.parse(readFileSync(file, 'utf-8'));
    if (!parsed || typeof parsed !== 'object') {
      return { schemaVersion: 1, subreddits: {}, routing: {} };
    }
    return {
      schemaVersion: Number(parsed.schemaVersion) || 1,
      subreddits: parsed.subreddits && typeof parsed.subreddits === 'object' ? parsed.subreddits : {},
      routing: parsed.routing && typeof parsed.routing === 'object' ? parsed.routing : {},
    };
  } catch {
    return { schemaVersion: 1, subreddits: {}, routing: {} };
  }
}

/**
 * Resolve the subreddits automation may post to for a topic, as names.
 *
 * Delegates to the shared policy module so this script and the daily cron
 * cannot disagree about who is a legitimate target — they used to be two
 * independent implementations of the same filter, one tested and one not.
 */
export function automationSubsForTopic(config, topic, opts) {
  return automationEligibleSubs(config, topic, opts).map((s) => s.name);
}

export function unpostedArticleTargets(articleId, targets, ledger) {
  const id = String(articleId || '').trim();
  if (!id || !Array.isArray(targets)) return [];
  const posted = new Set((Array.isArray(ledger?.posted) ? ledger.posted : [])
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry) => `${String(entry.id || '').trim()}\u0000${String(entry.subreddit || '').trim()}`));
  return targets.filter((subreddit) => !posted.has(`${id}\u0000${String(subreddit || '').trim()}`));
}

export function articleHasPostedReceipt(articleId, ledger) {
  const id = String(articleId || '').trim();
  return Boolean(id && Array.isArray(ledger?.posted)
    && ledger.posted.some((entry) => entry && typeof entry === 'object' && String(entry.id || '').trim() === id));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const positional = args.filter((a) => !a.startsWith('--'));

  const [articleId, articleUrl, ogTitle, ogDescription, category] = positional;

  if (!articleId || !articleUrl || !ogTitle) {
    console.error('Usage: post-to-reddit.mjs <id> <url> <og-title> <og-description> [category] [--dry-run]');
    process.exit(0); // soft failure
  }

  const repoRoot = defaultRepoRoot();
  const config = loadSubreddits(repoRoot);
  const targets = automationSubsForTopic(config, 'articles');

  if (targets.length === 0) {
    console.log('ℹ️  no automation-enabled article subreddits — skipping');
    process.exit(0);
  }

  // The deploy workflow can be retried after a successful API submission but
  // before its ledger commit. Use the per-subreddit receipt ledger to avoid
  // reposting destinations already confirmed by Reddit.
  const articleLedgerPath = resolve(repoRoot, 'data', 'reddit-posted-articles.json');
  const articleLedger = loadLedger(articleLedgerPath);
  const articleHasPriorReceipt = articleHasPostedReceipt(articleId, articleLedger);
  const pendingTargets = unpostedArticleTargets(articleId, targets, articleLedger);
  if (pendingTargets.length === 0) {
    console.log(`ℹ️  article ${articleId} is already posted to every eligible subreddit — skipping`);
    process.exit(0);
  }

  let token = null;
  if (!dryRun) {
    token = await getAccessToken(process.env);
    if (!token) {
      console.log('⚠️  Reddit access token unavailable (missing credentials?) — skipping Reddit post');
      process.exit(0);
    }
  }

  // Build the post payload after live delivery is known to be available.
  const socialCopyPack = loadSocialCopyPack({
    filePath: resolve(repoRoot, 'data', 'social-copy-packs', 'current.json'),
    onWarning: (message) => console.warn('⚠️', message),
  });
  const socialCopy = await selectSocialCopyForPublish({
    pack: socialCopyPack,
    channel: 'reddit',
    kind: 'article',
    assignmentKey: String(articleId),
    dryRun,
  });
  const post = buildArticlePost({
    id: articleId,
    url: articleUrl,
    ogTitle,
    ogDescription,
    category,
    socialCopy,
  });

  console.log('─── Reddit Article Post ───');
  console.log(`Article: ${articleId}`);
  console.log(`URL:     ${post.url || articleUrl}`);
  console.log(`Title:   ${post.title}`);
  console.log(`Targets: ${pendingTargets.join(', ')}`);
  console.log('───────────────────────────');

  if (dryRun) {
    for (const name of pendingTargets) {
      const sub = config.subreddits[name] || {};
      console.log(`🏃 [dry] would submit ${post.kind} to r/${name}`
        + (sub.flairText ? ` [flair=${sub.flairText}]` : ''));
    }
    console.log('🏃 Dry run — not posting to Reddit');
    process.exit(0);
  }

  const ua = userAgent(process.env);
  let successfulSubmissions = 0;
  let uncertainSubmissions = 0;

  for (let i = 0; i < pendingTargets.length; i++) {
    const name = pendingTargets[i];
    const sub = config.subreddits[name] || {};
    try {
      // Tagged per-subreddit: one article goes to several subreddits in the
      // same run, so a single utm_content would collapse them into one GA4 row
      // and hide which community actually sends traffic.
      const submitUrl = redditUrl(
        articleUrl,
        REDDIT_CAMPAIGN_ARTICLE,
        socialCopyTrackingContent(name, socialCopy),
      );
      const targetPost = socialCopy
        ? buildArticlePost({
          id: articleId,
          url: articleUrl,
          ogTitle,
          ogDescription,
          category,
          socialCopy,
          destinationUrl: submitUrl,
        })
        : { ...post, url: submitUrl };
      const res = await submitPost({
        token,
        subreddit: name,
        kind: targetPost.kind,
        title: targetPost.title,
        url: targetPost.kind === 'link' ? submitUrl : undefined,
        text: targetPost.text,
        flairId: sub.flairId,
        flairText: sub.flairText,
        ua,
      });
      if (res?.ok) {
        successfulSubmissions += 1;
        console.log(`✅ Posted to r/${name}! ${res.url || res.name || res.id || ''}`.trim());
        // The article publisher historically had no ledger. Record a compact
        // receipt next to the job ledger so native metrics can join by ID.
        appendLedger(articleLedgerPath, [{
          id: articleId,
          subreddit: name,
          ts: new Date().toISOString(),
          redditPostId: res.name || res.id,
          redditUrl: res.url,
          ...socialCopyLedgerFields(socialCopy, { fallbackHook: ogTitle, fallbackCta: '' }),
        }], ARTICLE_POSTED_TRIM_LIMIT);
      } else {
        if (res?.deliveryUncertain) uncertainSubmissions += 1;
        console.error(`⚠️  Reddit submit error for r/${name}: ${res?.error || 'unknown error'}`);
      }
    } catch (err) {
      uncertainSubmissions += 1;
      console.error(`⚠️  Failed to post to r/${name}: ${err.message}`);
    }
    // Self-pace between subs (skip after the last one).
    if (i < pendingTargets.length - 1) await sleep(INTER_SUB_DELAY_MS);
  }

  if (!articleHasPriorReceipt && successfulSubmissions === 0 && uncertainSubmissions === 0 && socialCopy?.copyAssignmentMode === 'firebase-balanced'
    && !await releaseSocialCopyAssignment(socialCopy)) {
    throw new Error('Reddit article copy assignment could not be released after all submissions failed');
  }

  process.exit(0);
}

// ── CLI ─────────────────────────────────────────────────────
// Guarded exactly like the sibling `schedule-reddit-jobs-daily.mjs`: without
// it, `import`ing this module to unit-test `automationSubsForTopic` runs
// `main()`, which calls `process.exit(0)` on missing argv. A posting script is
// the last place that should execute as a side effect of being read.
const isDirectInvocation = (() => { try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; } })();
if (isDirectInvocation) {
  main().catch((err) => {
    console.error('⚠️ post-to-reddit crashed:', err?.message || err);
    process.exit(0); // soft-fail
  });
}
