#!/usr/bin/env node
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

// Delay between subreddit submissions (ms). Conservative to respect
// Reddit anti-spam / rate limits.
const INTER_SUB_DELAY_MS = 3000;

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

  // Build the post payload.
  const post = buildArticlePost({
    id: articleId,
    url: articleUrl,
    ogTitle,
    ogDescription,
    category,
  });

  console.log('─── Reddit Article Post ───');
  console.log(`Article: ${articleId}`);
  console.log(`URL:     ${post.url || articleUrl}`);
  console.log(`Title:   ${post.title}`);
  console.log(`Targets: ${targets.join(', ')}`);
  console.log('───────────────────────────');

  if (dryRun) {
    for (const name of targets) {
      const sub = config.subreddits[name] || {};
      console.log(`🏃 [dry] would submit link to r/${name}`
        + (sub.flairText ? ` [flair=${sub.flairText}]` : ''));
    }
    console.log('🏃 Dry run — not posting to Reddit');
    process.exit(0);
  }

  const ua = userAgent(process.env);
  const token = await getAccessToken(process.env);
  if (!token) {
    console.log('⚠️  Reddit access token unavailable (missing credentials?) — skipping Reddit post');
    process.exit(0);
  }

  for (let i = 0; i < targets.length; i++) {
    const name = targets[i];
    const sub = config.subreddits[name] || {};
    try {
      // Tagged per-subreddit: one article goes to several subreddits in the
      // same run, so a single utm_content would collapse them into one GA4 row
      // and hide which community actually sends traffic.
      const submitUrl = redditUrl(post.url || articleUrl, REDDIT_CAMPAIGN_ARTICLE, name);
      const res = await submitPost({
        token,
        subreddit: name,
        kind: 'link',
        title: post.title,
        url: submitUrl,
        flairId: sub.flairId,
        flairText: sub.flairText,
        ua,
      });
      if (res?.ok) {
        console.log(`✅ Posted to r/${name}! ${res.url || res.name || res.id || ''}`.trim());
      } else {
        console.error(`⚠️  Reddit submit error for r/${name}: ${res?.error || 'unknown error'}`);
      }
    } catch (err) {
      console.error(`⚠️  Failed to post to r/${name}: ${err.message}`);
    }
    // Self-pace between subs (skip after the last one).
    if (i < targets.length - 1) await sleep(INTER_SUB_DELAY_MS);
  }

  process.exit(0);
}

// ── CLI ─────────────────────────────────────────────────────
// Guarded exactly like the sibling `schedule-reddit-jobs-daily.mjs`: without
// it, `import`ing this module to unit-test `automationSubsForTopic` runs
// `main()`, which calls `process.exit(0)` on missing argv. A posting script is
// the last place that should execute as a side effect of being read.
const isDirectInvocation = import.meta.url === `file://${process.argv[1]}`;
if (isDirectInvocation) {
  main().catch((err) => {
    console.error('⚠️ post-to-reddit crashed:', err?.message || err);
    process.exit(0); // soft-fail
  });
}
