/**
 * public/robots.txt — group semantics (RFC 9309 §2.2.1).
 *
 * A crawler obeys ONLY the most specific group that names it and ignores
 * `User-agent: *`. Until 2026-10 every welcomed bot (Googlebot, Bingbot,
 * GPTBot, ClaudeBot, PerplexityBot…) had its own `Allow: /` group, which
 * silently cancelled every Disallow written for `*`:
 * `/cerca-lavoro-ticino/?q=infermiere` answered 200 and was crawlable by all
 * of them. These cases evaluate the file the way a compliant crawler does —
 * via the RFC 9309 matcher in scripts/lib/robots-policy.mjs — instead of
 * grepping for the Disallow lines, because the lines WERE there: it is the
 * group they sit in that decides whether anybody reads them.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isAllowed, parseRobotsTxt } from '../scripts/lib/robots-policy.mjs';

const ROBOTS_PATH = path.resolve(__dirname, '..', 'public', 'robots.txt');
const raw = fs.readFileSync(ROBOTS_PATH, 'utf-8');
const parsed = parseRobotsTxt(raw);
const BASE = 'https://frontaliereticino.ch';

/** Paths no crawler — welcomed or not — may fetch. */
const MUST_DISALLOW = [
  '/api/jobs/',
  '/data/jobs.json',
  '/data/jobs-ai-cache.json',
  '/data/expired-jobs.json',
  '/data/translation-cache/it.json',
  '/cerca-lavoro-ticino/?q=infermiere',
  '/cerca-lavoro-ticino/?canton=ti&q=infermiere',
  '/?debug=1',
  '/cerca-lavoro-ticino/?status=expired',
];

/** Paths every welcomed crawler must still reach. */
const MUST_ALLOW = [
  '/',
  '/cerca-lavoro-ticino/',
  '/llms.txt',
  '/llms-full.txt',
  '/llms-index.txt',
  '/.well-known/llms.txt',
  '/data/fuel-prices.json',
  '/data/health-premiums.json',
  '/data/jobs-stats.json',
  '/manifest.webmanifest',
];

/** Welcomed crawlers, by product token. The last one has no named line and falls to `*`. */
const WELCOMED = [
  'Googlebot',
  'Googlebot-Image',
  'Bingbot',
  'GPTBot',
  'ChatGPT-User',
  'OAI-SearchBot',
  'Google-Extended',
  'ClaudeBot',
  'Claude-User',
  'Claude-SearchBot',
  'PerplexityBot',
  'Perplexity-User',
  'MistralAI-User',
  'Applebot',
  'CCBot',
  'SemrushBot',
  'SomeUnlistedBot',
];

const BLOCKED = ['Amazonbot', 'Bytespider', 'AhrefsBot', 'DotBot', 'MJ12bot', 'BLEXBot', 'DataForSeoBot', 'serpstatbot'];

const isFullBlock = (g: { rules: { allow: boolean; path: string }[] }) =>
  g.rules.length === 1 && !g.rules[0].allow && g.rules[0].path === '/';

describe('public/robots.txt group semantics (RFC 9309)', () => {
  it.each(WELCOMED)('%s: every shared Disallow applies', (agent) => {
    for (const p of MUST_DISALLOW) {
      expect(isAllowed(parsed, agent, `${BASE}${p}`).allowed, `${agent} must NOT crawl ${p}`).toBe(false);
    }
  });

  it.each(WELCOMED)('%s: public pages, data feeds and llms.txt stay crawlable', (agent) => {
    for (const p of MUST_ALLOW) {
      expect(isAllowed(parsed, agent, `${BASE}${p}`).allowed, `${agent} must crawl ${p}`).toBe(true);
    }
  });

  it.each(BLOCKED)('%s: blocked site-wide', (agent) => {
    expect(isAllowed(parsed, agent, `${BASE}/`).allowed).toBe(false);
    expect(isAllowed(parsed, agent, `${BASE}/cerca-lavoro-ticino/`).allowed).toBe(false);
  });

  it('every group that is not a full block carries the whole `*` rule set', () => {
    const star = parsed.groups.find((g) => g.agents.includes('*'));
    expect(star, 'a `User-agent: *` group must exist').toBeTruthy();
    const starRules = new Set(star!.rules.map((r) => `${r.allow ? 'Allow' : 'Disallow'}:${r.path}`));
    for (const g of parsed.groups) {
      if (isFullBlock(g)) continue;
      const rules = new Set(g.rules.map((r) => `${r.allow ? 'Allow' : 'Disallow'}:${r.path}`));
      const missing = [...starRules].filter((r) => !rules.has(r));
      expect(missing, `group [${g.agents.join(', ')}] drops ${missing.join(' ')}`).toEqual([]);
    }
  });

  it('no agent is named by more than one group', () => {
    const seen = new Map<string, number>();
    parsed.groups.forEach((g, i) => {
      for (const a of g.agents) {
        expect(seen.has(a), `${a} named by groups #${seen.get(a)} and #${i}`).toBe(false);
        seen.set(a, i);
      }
    });
  });

  it('the welcomed search and AI crawlers are named explicitly in the shared group', () => {
    const star = parsed.groups.find((g) => g.agents.includes('*'))!;
    for (const a of ['googlebot', 'bingbot', 'gptbot', 'claudebot', 'perplexitybot', 'oai-searchbot']) {
      expect(star.agents).toContain(a);
    }
  });

  it('names only live product tokens, never retired or invented ones', () => {
    const star = parsed.groups.find((g) => g.agents.includes('*'))!;
    for (const a of ['claude-user', 'claude-searchbot', 'perplexity-user', 'mistralai-user']) {
      expect(star.agents).toContain(a);
    }
    for (const a of ['claude-web', 'anthropic-ai', 'neevabot', 'msnbot', 'slurp', 'copilotbot', 'grokbot', 'qwenbot', 'mistralbot', 'deepseekbot']) {
      expect(star.agents).not.toContain(a);
    }
  });

  it('every Allow/Disallow line sits inside a group (never after a Sitemap/Host record)', () => {
    let previous: string | null = null;
    for (const rawLine of raw.split(/\r?\n/)) {
      const line = rawLine.replace(/#.*$/, '').trim();
      if (!line) continue;
      const key = (/^([A-Za-z-]+)\s*:/.exec(line)?.[1] ?? '').toLowerCase();
      if (key === 'allow' || key === 'disallow') {
        expect(['user-agent', 'allow', 'disallow', 'crawl-delay'], `"${line}" follows a ${previous} record`).toContain(previous);
      }
      previous = key;
    }
  });

  it('has no `Host:` record (Yandex-only extension; the canonical host is an edge 301)', () => {
    expect(raw).not.toMatch(/^\s*host\s*:/im);
  });

  it('still declares the sitemap indexes', () => {
    expect(raw).toMatch(/^Sitemap: https:\/\/frontaliereticino\.ch\/sitemap\.xml$/m);
    expect(raw).toMatch(/^Sitemap: https:\/\/frontaliereticino\.ch\/sitemap-news\.xml$/m);
    expect(raw).toMatch(/^Sitemap: https:\/\/frontaliereticino\.ch\/sitemap-cantons\.xml$/m);
  });
});
