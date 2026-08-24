/**
 * Guard for the daily personal-profile LinkedIn pipeline
 * (scripts/post-to-linkedin-member.mjs + scripts/lib/daily-top-content.mjs).
 *
 * Every assertion here is an observer for a defect that was REAL and that a
 * green run hid, all four found while dry-running against GA4 property
 * 524485296 for 2026-08-23:
 *
 *  1. `cleanPageTitle` split on the en dash, so
 *     'Bollettino del frontaliere – 23 agosto 2026: 568 nuovi annunci' posted as
 *     'Bollettino del frontaliere'. Plausible-looking and wrong, and it would
 *     have made every daily bollettino share one bland headline.
 *  2. The SPA fires its GA4 pageview before `document.title` is set, so each
 *     article has TWO rows — one titled with the raw path. The path row
 *     outranked the real one 23-to-20 and became the caption's headline.
 *  3. `/cerca-lavoro-ticino/infermieri/` (271 views, the day's #1 under a job
 *     section) is a generated "37 offerte" SEO landing page, NOT an offer.
 *     Job detail pages and landing pages are indistinguishable by URL shape, so
 *     only membership in the real dataset separates them.
 *  4. The AGGREGATE section `cerca-lavoro-svizzera` is absent from the `cantons`
 *     table, so building the section set from that table alone silently dropped
 *     every Swiss-wide job.
 *
 * Plus the standing channel rule from scripts/lib/telegram-links.mjs: a posted
 * link without UTM lands in GA4 as Direct, so the channel reads as zero
 * sessions while it is in fact sending clicks — invisible, not absent.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import {
  previousUtcDay,
  normalizeGa4Path,
  classifyPath,
  cleanPageTitle,
  looksLikePathTitle,
  rankCandidates,
  pickFirstUnposted,
  ARTICLE_HUB_SEGMENTS,
} from '../scripts/lib/daily-top-content.mjs';
import {
  linkedinUrl,
  LINKEDIN_UTM_SOURCE,
  LINKEDIN_UTM_MEDIUM,
  LINKEDIN_MEMBER_CAMPAIGN_ARTICLE,
  LINKEDIN_MEMBER_CAMPAIGN_JOB,
  LINKEDIN_COMPANY_CAMPAIGN_ARTICLE,
} from '../scripts/lib/linkedin-links.mjs';
import { createCantonResolvers, AGGREGATE_KEY } from '../build-plugins/shared/cantonResolvers.mjs';

const JOB_SECTIONS = new Set(['cerca-lavoro-ticino', 'cerca-lavoro-argovia', 'cerca-lavoro-svizzera']);

describe('previousUtcDay', () => {
  it('is the UTC calendar day before, regardless of local timezone', () => {
    expect(previousUtcDay(Date.parse('2026-08-24T03:00:00Z'))).toBe('2026-08-23');
    expect(previousUtcDay(Date.parse('2026-08-24T23:59:59Z'))).toBe('2026-08-23');
    // Across a month boundary.
    expect(previousUtcDay(Date.parse('2026-09-01T00:00:01Z'))).toBe('2026-08-31');
  });
});

describe('normalizeGa4Path', () => {
  it('strips query, hash and trailing slash so one page is one slug', () => {
    const variants = [
      '/articoli-frontaliere/tasse-2026',
      '/articoli-frontaliere/tasse-2026/',
      '/articoli-frontaliere/tasse-2026/?utm_source=linkedin',
      '/articoli-frontaliere/tasse-2026#top',
      '//articoli-frontaliere//tasse-2026//',
    ];
    for (const v of variants) {
      expect(normalizeGa4Path(v)).toBe('/articoli-frontaliere/tasse-2026');
    }
  });

  it('never throws on a malformed percent-escape', () => {
    expect(() => normalizeGa4Path('/articoli-frontaliere/%E0%A4%A')).not.toThrow();
    expect(normalizeGa4Path('/articoli-frontaliere/%E0%A4%A')).toContain('/articoli-frontaliere/');
  });
});

describe('classifyPath', () => {
  it('recognizes both article hubs', () => {
    for (const hub of ARTICLE_HUB_SEGMENTS) {
      expect(classifyPath(`/${hub}/qualcosa`, { jobSections: JOB_SECTIONS })).toMatchObject({
        kind: 'article',
        slug: 'qualcosa',
      });
    }
  });

  it('recognizes a job under a canton section', () => {
    expect(
      classifyPath('/cerca-lavoro-ticino/infermiere-eoc-novaggio', { jobSections: JOB_SECTIONS }),
    ).toMatchObject({ kind: 'job', slug: 'infermiere-eoc-novaggio' });
  });

  it('excludes the board index itself (one segment, not two)', () => {
    expect(classifyPath('/cerca-lavoro-ticino', { jobSections: JOB_SECTIONS })).toBeNull();
    expect(classifyPath('/articoli-frontaliere', { jobSections: JOB_SECTIONS })).toBeNull();
  });

  it('excludes non-Italian locales rather than folding them onto the IT slug', () => {
    // Defect 4 of the family: an Italian caption pointing at a German URL.
    expect(classifyPath('/de/jobs-im-aargau/pflegefachperson', { jobSections: JOB_SECTIONS })).toBeNull();
    expect(classifyPath('/en/articoli-frontaliere/taxes', { jobSections: JOB_SECTIONS })).toBeNull();
  });

  it('excludes an unknown top segment', () => {
    expect(classifyPath('/chi-siamo/team', { jobSections: JOB_SECTIONS })).toBeNull();
  });
});

describe('cleanPageTitle — defect 1, the en dash', () => {
  it('does NOT split on an en/em dash that belongs to the headline', () => {
    const real = 'Bollettino del frontaliere – 23 agosto 2026: 568 nuovi annunci di lavoro ieri';
    expect(cleanPageTitle(`${real} | Frontaliere Ticino`)).toBe(real);
    expect(cleanPageTitle(real)).toBe(real);
    // The regression this replaces:
    expect(cleanPageTitle(real)).not.toBe('Bollettino del frontaliere');
  });

  it('drops only the site-name group after a pipe', () => {
    expect(cleanPageTitle('Tasse 2026 | Frontaliere Ticino')).toBe('Tasse 2026');
  });

  it('returns a bare site name unchanged rather than emptying it', () => {
    expect(cleanPageTitle('Frontaliere Ticino')).toBe('Frontaliere Ticino');
  });
});

describe('title selection — defect 2, the SPA path-titled row', () => {
  it('detects a path-shaped pageTitle', () => {
    expect(looksLikePathTitle('/articoli-frontaliere/bollettino-frontaliere-2026-08-23/')).toBe(true);
    expect(looksLikePathTitle('')).toBe(true);
    expect(looksLikePathTitle('Bollettino del frontaliere – 23 agosto 2026')).toBe(false);
  });

  it('sums both rows but never lets the path row supply the title', () => {
    // Verbatim shape of the two GA4 rows measured on 2026-08-23.
    const rows = [
      { path: '/articoli-frontaliere/bollettino-frontaliere-2026-08-23/', title: '/articoli-frontaliere/bollettino-frontaliere-2026-08-23/', views: 23 },
      { path: '/articoli-frontaliere/bollettino-frontaliere-2026-08-23/', title: 'Bollettino del frontaliere – 23 agosto 2026: 568 nuovi annunci di lavoro ieri | Frontaliere Ticino', views: 20 },
    ];
    const { articles } = rankCandidates(rows, { jobSections: JOB_SECTIONS });
    expect(articles).toHaveLength(1);
    // Both rows are genuine pageviews of one page.
    expect(articles[0].views).toBe(43);
    // …but the higher-view row is the useless one.
    expect(articles[0].title).toBe(
      'Bollettino del frontaliere – 23 agosto 2026: 568 nuovi annunci di lavoro ieri',
    );
    expect(looksLikePathTitle(articles[0].title)).toBe(false);
  });

  it('leaves the title empty (not path-shaped) when no real title exists', () => {
    const { articles } = rankCandidates(
      [{ path: '/articoli-frontaliere/x', title: '/articoli-frontaliere/x', views: 5 }],
      { jobSections: JOB_SECTIONS },
    );
    expect(articles[0].title).toBe('');
  });
});

describe('job validation — defect 3, the SEO landing page', () => {
  const rows = [
    // The day's #1 under a job section, and not an offer.
    { path: '/cerca-lavoro-ticino/infermieri/', title: 'Infermieri Svizzera Canton Ticino: 37 offerte', views: 271 },
    // A real offer.
    { path: '/cerca-lavoro-ticino/infermiere-a-in-cure-generali-eoc-novaggio', title: 'Infermiere/a | Frontaliere Ticino', views: 19 },
  ];
  const realSlugs = new Set(['infermiere-a-in-cure-generali-eoc-novaggio']);

  it('drops a job-shaped path that is not in the dataset', () => {
    const { jobs } = rankCandidates(rows, {
      jobSections: JOB_SECTIONS,
      isJobSlug: (s: string) => realSlugs.has(s),
    });
    expect(jobs.map((j) => j.slug)).toEqual(['infermiere-a-in-cure-generali-eoc-novaggio']);
    // The landing page must not win merely by having more views.
    expect(jobs.find((j) => j.slug === 'infermieri')).toBeUndefined();
  });

  it('yields NO jobs when the dataset is unavailable, rather than guessing', () => {
    const { jobs } = rankCandidates(rows, {
      jobSections: JOB_SECTIONS,
      isJobSlug: () => false,
    });
    expect(jobs).toHaveLength(0);
  });

  it('leaves articles untouched by the job predicate', () => {
    const { articles } = rankCandidates(
      [{ path: '/articoli-frontaliere/a', title: 'A | Frontaliere Ticino', views: 3 }],
      { jobSections: JOB_SECTIONS, isJobSlug: () => false },
    );
    expect(articles).toHaveLength(1);
  });
});

describe('job sections — defect 4, the AGGREGATE section', () => {
  it('resolveCantonSection maps _AGGREGATE_ to a section absent from the cantons table', () => {
    const root = path.resolve(__dirname, '..');
    const cantonSlugFile = JSON.parse(
      fs.readFileSync(path.join(root, 'data', 'canton-url-slugs.json'), 'utf-8'),
    );
    const municipalitiesFile = JSON.parse(
      fs.readFileSync(path.join(root, 'data', 'canton-municipalities.json'), 'utf-8'),
    );
    const { resolveCantonSection } = createCantonResolvers({ cantonSlugFile, municipalitiesFile });

    const aggregate = resolveCantonSection('it', AGGREGATE_KEY);
    expect(aggregate).toBe('cerca-lavoro-svizzera');
    // The point of the defect: it is NOT reachable by iterating `cantons`.
    expect(Object.keys(cantonSlugFile.cantons)).not.toContain(AGGREGATE_KEY);
  });
});

describe('dedup — the same winner two days running', () => {
  const ranked = [
    { slug: 'a', views: 100 },
    { slug: 'b', views: 90 },
    { slug: 'c', views: 80 },
  ];

  it('takes the top candidate when nothing was posted', () => {
    const { pick, skipped } = pickFirstUnposted(ranked, new Set());
    expect(pick?.slug).toBe('a');
    expect(skipped).toBe(0);
  });

  it('falls through to the next-best instead of skipping the day', () => {
    const { pick, skipped } = pickFirstUnposted(ranked, new Set(['a', 'b']));
    expect(pick?.slug).toBe('c');
    expect(skipped).toBe(2);
  });

  it('reports exhaustion rather than reposting when everything was posted', () => {
    const { pick, exhausted } = pickFirstUnposted(ranked, new Set(['a', 'b', 'c']));
    expect(pick).toBeNull();
    expect(exhausted).toBe(true);
  });

  it('distinguishes "nothing ranked" from "all posted"', () => {
    expect(pickFirstUnposted([], new Set()).exhausted).toBe(false);
  });
});

describe('UTM identity — a posted link must never be invisible', () => {
  it('tags both campaigns with one shared source/medium', () => {
    for (const campaign of [LINKEDIN_MEMBER_CAMPAIGN_ARTICLE, LINKEDIN_MEMBER_CAMPAIGN_JOB]) {
      const u = new URL(
        linkedinUrl('https://frontaliereticino.ch/articoli-frontaliere/x/', campaign, 'x'),
      );
      expect(u.searchParams.get('utm_source')).toBe(LINKEDIN_UTM_SOURCE);
      expect(u.searchParams.get('utm_medium')).toBe(LINKEDIN_UTM_MEDIUM);
      expect(u.searchParams.get('utm_campaign')).toBe(campaign);
      expect(u.searchParams.get('utm_content')).toBe('x');
    }
  });

  it('keeps ONE GA4 source row for LinkedIn — the surface lives in the campaign', () => {
    // A drifted utm_source splits one channel across two rows, which looks like
    // data instead of looking like a bug.
    expect(LINKEDIN_UTM_SOURCE).toBe('linkedin');
    expect(LINKEDIN_MEMBER_CAMPAIGN_ARTICLE).not.toBe(LINKEDIN_MEMBER_CAMPAIGN_JOB);
  });

  it('returns an unparseable URL verbatim rather than dropping the link', () => {
    expect(linkedinUrl('not a url', LINKEDIN_MEMBER_CAMPAIGN_JOB, 'x')).toBe('not a url');
  });

  it('keeps the three campaigns distinct so the surfaces stay separable', () => {
    const campaigns = [
      LINKEDIN_MEMBER_CAMPAIGN_ARTICLE,
      LINKEDIN_MEMBER_CAMPAIGN_JOB,
      LINKEDIN_COMPANY_CAMPAIGN_ARTICLE,
    ];
    expect(new Set(campaigns).size).toBe(3);
  });

  it('the Company Page poster tags its links too (same class of defect)', () => {
    // It posted a bare `articleUrl` until this PR: the Page channel was
    // sending clicks that GA4 attributed to Direct.
    const src = fs.readFileSync(
      path.resolve(__dirname, '..', 'scripts', 'post-to-linkedin.mjs'),
      'utf-8',
    );
    expect(src).toContain('linkedinUrl(');
    expect(src).toContain('LINKEDIN_COMPANY_CAMPAIGN_ARTICLE');
    // The bare URL must not survive in either the caption or the article card.
    expect(src).not.toContain('source: articleUrl');
    expect(src).not.toContain('completo: ${articleUrl}');
  });
});

describe('the two LinkedIn surfaces stay separate', () => {
  const root = path.resolve(__dirname, '..');
  const read = (f: string) => fs.readFileSync(path.join(root, 'scripts', f), 'utf-8');

  /**
   * Comments are stripped before asserting: the member script's header carries
   * a table contrasting the two surfaces, and that documentation is the point —
   * it must not be what trips the guard. Only executable text is judged.
   */
  const codeOnly = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  const member = read('post-to-linkedin-member.mjs');
  const memberCode = codeOnly(member);
  const org = codeOnly(read('post-to-linkedin.mjs'));

  it('the member script authors as a person and never as an organization', () => {
    expect(memberCode).toContain('urn:li:person:');
    expect(memberCode).not.toContain('urn:li:organization:');
    expect(memberCode).not.toContain('LINKEDIN_ORGANIZATION_ID');
  });

  it('the Company Page script is left alone on the organization URN', () => {
    expect(org).toContain('urn:li:organization:');
    expect(org).not.toContain('urn:li:person:');
  });

  it('the member script reads only LINKEDIN_MEMBER_* credentials', () => {
    expect(memberCode).toContain('LINKEDIN_MEMBER_ACCESS_TOKEN');
    expect(memberCode).not.toContain('LINKEDIN_POST_ACCESS_TOKEN');
  });

  it('the member script is fail-soft: it never exits non-zero', () => {
    expect(memberCode).toContain('process.exit(0)');
    expect(memberCode).not.toMatch(/process\.exit\([1-9]/);
  });
});
