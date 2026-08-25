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
  previousReportDay,
  GA4_REPORT_TIMEZONE,
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
import {
  buildArticleContent,
  buildMemberCommentary,
  buildMemberPostPayload,
  extractOgFromHtml,
  formatCompanyMention,
  inferArticleLocation,
  resolveJobCompany,
  resolveJobDescription,
  resolveJobLocation,
  resolveOrganizationUrn,
  stripViewCounts,
} from '../scripts/lib/linkedin-member-copy.mjs';
import {
  convertImageForLinkedIn,
  fetchPageOg,
  uploadLinkedInImage,
} from '../scripts/lib/linkedin-member-media.mjs';
import sharp from 'sharp';

const JOB_SECTIONS = new Set(['cerca-lavoro-ticino', 'cerca-lavoro-argovia', 'cerca-lavoro-svizzera']);

describe('previousReportDay — the GA4 window is the PROPERTY timezone', () => {
  it('reports in Europe/Zurich, the property timezone measured via the Admin API', () => {
    expect(GA4_REPORT_TIMEZONE).toBe('Europe/Zurich');
  });

  it('gives the previous local day at the cron hour', () => {
    // 08:15 UTC cron → 10:15 CEST, same date either way.
    expect(previousReportDay(Date.parse('2026-08-24T08:15:00Z'))).toBe('2026-08-23');
  });

  it('DIVERGES from the UTC day near midnight — the bug this rename fixes', () => {
    // 2026-08-23T23:59:59Z is already 2026-08-24 01:59 in Zurich. GA4 resolves
    // an explicit startDate against the property timezone, so asking for the
    // UTC day would name a bucket GA4 never filled with "yesterday"'s traffic.
    const t = Date.parse('2026-08-24T23:59:59Z');
    expect(previousReportDay(t)).toBe('2026-08-24');
    const utcDay = new Date(t - 86400000).toISOString().slice(0, 10);
    expect(utcDay).toBe('2026-08-23');
    expect(previousReportDay(t)).not.toBe(utcDay);
  });

  it('crosses a month boundary correctly', () => {
    expect(previousReportDay(Date.parse('2026-09-01T08:15:00Z'))).toBe('2026-08-31');
  });

  it('always yields a GA4-shaped date string', () => {
    for (const iso of ['2026-01-01T00:30:00Z', '2026-06-15T12:00:00Z', '2026-12-31T23:00:00Z']) {
      expect(previousReportDay(Date.parse(iso))).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('uses calendar arithmetic on the DST fall-back day (25h local day)', () => {
    // 2026-10-25 is the Europe/Zurich fall-back (CEST→CET at 03:00→02:00).
    // The local day is 25 hours long. 23:30 local = 22:30 UTC. Subtracting
    // 86400000ms from that instant lands at 00:30 the SAME local day.
    expect(previousReportDay(Date.parse('2026-10-25T22:30:00Z'))).toBe('2026-10-24');
  });

  it('uses calendar arithmetic on the DST spring-forward morning', () => {
    // 2026-03-29 skips 02:00-03:00. 00:30 CEST on 2026-03-30 = 22:30 UTC on the 29th.
    expect(previousReportDay(Date.parse('2026-03-29T22:30:00Z'))).toBe('2026-03-29');
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

  it('tolerates any spacing around the pipe', () => {
    // GA4 stores whatever the tag sent; all three forms occur.
    expect(cleanPageTitle('Tasse 2026|Frontaliere Ticino')).toBe('Tasse 2026');
    expect(cleanPageTitle('Tasse 2026  |  Frontaliere Ticino')).toBe('Tasse 2026');
    expect(cleanPageTitle('Tasse 2026 ｜ Frontaliere Ticino')).toBe('Tasse 2026');
  });

  it('keeps an inner pipe when only the last group is the site name', () => {
    expect(cleanPageTitle('A | B | Frontaliere Ticino')).toBe('A | B');
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

  it('EVERY social poster tags its links — the whole class, not just LinkedIn', () => {
    // The 🔴 on this PR: post-to-facebook.mjs and post-to-reddit.mjs shared the
    // real construct (a bare `articleUrl` posted), not an homonym, and a
    // collective "falso positivo" dismiss is exactly what AGENTS.md #6 forbids.
    // The three schedulers are here because post-to-facebook.mjs is a MANUAL
    // CLI tool by its own header — the live crons are these, so fixing only the
    // flagged file would have fixed the inert half of the channel.
    const root = path.resolve(__dirname, '..', 'scripts');
    const cases: Array<[string, string]> = [
      ['post-to-facebook.mjs', 'facebookUrl('],
      ['schedule-fb-articles-daily.mjs', 'facebookUrl('],
      ['schedule-fb-events-daily.mjs', 'facebookUrl('],
      ['schedule-fb-jobs-daily.mjs', 'facebookUrl('],
      ['post-to-reddit.mjs', 'redditUrl('],
    ];
    for (const [file, helper] of cases) {
      const src = fs.readFileSync(path.join(root, file), 'utf-8');
      expect(src, `${file} must tag its posted link`).toContain(helper);
      // The bare form must not survive at the posting boundary.
      expect(src, `${file} still posts a bare link`).not.toMatch(/\blink:\s*p\.url\b/);
      expect(src, `${file} still posts a bare link`).not.toMatch(/\blink:\s*articleUrl\b/);
    }
  });

  it('the FB ledgers keep the UNTAGGED url as their dedup key', () => {
    // Tagging `p.url` itself would rewrite the dedup key and re-post
    // everything already sent. The tag lives only at the posting boundary.
    const root = path.resolve(__dirname, '..', 'scripts');
    for (const file of ['schedule-fb-articles-daily.mjs', 'schedule-fb-jobs-daily.mjs']) {
      expect(fs.readFileSync(path.join(root, file), 'utf-8')).toContain('url: p.url');
    }
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

  it('the member poster delegates copy and the article card to the shared builders', () => {
    expect(memberCode).toContain('buildMemberCommentary');
    expect(memberCode).toContain('buildArticleContent');
    expect(memberCode).toContain('uploadLinkedInImage');
    expect(memberCode).not.toMatch(/visualizzazion/i);
    expect(org).toContain('buildArticleContent');
  });
});

/**
 * Shape of the last live member post (imposta-alla-fonte article) plus a
 * job with company+city. views is the GA4 number that used to be printed as
 * social proof — the builders must ignore it.
 */
const ARTICLE_FIXTURE = {
  kind: 'article' as const,
  title:
    "Frontalieri: quando l'imposta alla fonte copre tutta l'IRPEF 2026: cosa cambia",
  excerpt:
    "Per i frontalieri l'imposta alla fonte svizzera può coprire l'IRPEF italiana: ecco cosa cambia nel 2026 per chi lavora in Svizzera.",
  url: 'https://frontaliereticino.ch/articoli-frontaliere/imposta-alla-fonte-irpef-2026/?utm_source=linkedin',
  location: 'Ticino',
  views: 888777,
  dayA: '2026-08-23',
  dayB: '2026-08-24',
};

const JOB_FIXTURE = {
  kind: 'job' as const,
  title: 'Infermiere/a in cure generali',
  company: 'EOC',
  location: 'Novaggio, Canton Ticino',
  canton: 'TI',
  excerpt:
    'Cerchiamo un infermiere/a per il servizio di cure generali a Novaggio, con turno diurno. Posizione aperta anche ai frontalieri.',
  url: 'https://frontaliereticino.ch/cerca-lavoro-ticino/infermiere-eoc-novaggio/?utm_source=linkedin',
  organizationUrn: 'urn:li:organization:5515715',
  views: 888777,
  dayA: '2026-08-23',
  dayB: '2026-08-24',
};

function commentaryOf(
  fixture: typeof ARTICLE_FIXTURE | typeof JOB_FIXTURE,
  day: string,
  extra: Record<string, unknown> = {},
) {
  return buildMemberCommentary({ ...fixture, day, ...extra });
}

describe('member commentary — daily rotation, no views, search keywords', () => {
  it('the same article on two calendar days yields different Italian copy', () => {
    const a = commentaryOf(ARTICLE_FIXTURE, ARTICLE_FIXTURE.dayA);
    const b = commentaryOf(ARTICLE_FIXTURE, ARTICLE_FIXTURE.dayB);
    expect(a).not.toBe(b);
    expect(a.split('\n')[0]).not.toBe(b.split('\n')[0]);
  });

  it('the same job on two calendar days yields different Italian copy', () => {
    const a = commentaryOf(JOB_FIXTURE, JOB_FIXTURE.dayA);
    const b = commentaryOf(JOB_FIXTURE, JOB_FIXTURE.dayB);
    expect(a).not.toBe(b);
  });

  it('never puts site view counts in commentary even when views is passed', () => {
    for (const day of [ARTICLE_FIXTURE.dayA, ARTICLE_FIXTURE.dayB]) {
      const text = commentaryOf(ARTICLE_FIXTURE, day, { views: ARTICLE_FIXTURE.views });
      expect(text).not.toMatch(/visualizzazion/i);
      expect(text).not.toContain(String(ARTICLE_FIXTURE.views));
    }
    for (const day of [JOB_FIXTURE.dayA, JOB_FIXTURE.dayB]) {
      const text = commentaryOf(JOB_FIXTURE, day, { views: JOB_FIXTURE.views });
      expect(text).not.toMatch(/visualizzazion/i);
      expect(text).not.toContain(String(JOB_FIXTURE.views));
    }
  });

  it('article body reuses the excerpt and the search terms, not a 3-line caption', () => {
    const text = commentaryOf(ARTICLE_FIXTURE, ARTICLE_FIXTURE.dayA);
    expect(text).toContain(ARTICLE_FIXTURE.excerpt);
    expect(text.toLowerCase()).toContain('frontalieri');
    expect(text.toLowerCase()).toContain('lavoro in svizzera');
    expect(text).toContain('Ticino');
    expect(text).toMatch(/imposta alla fonte/i);
    expect(text).toMatch(/IRPEF/i);
    expect(text).toContain('#frontalieri');
    expect(text).toContain('#lavoroinSvizzera');
    const nonempty = text.split('\n').map((l) => l.trim()).filter(Boolean);
    expect(nonempty.length).toBeGreaterThanOrEqual(5);
    expect(text.length).toBeGreaterThan(280);
    expect(text.length).toBeLessThanOrEqual(2900);
  });

  it('job body reuses the description snippet plus company and location', () => {
    const withUrn = commentaryOf(JOB_FIXTURE, JOB_FIXTURE.dayA);
    expect(withUrn).toContain(JOB_FIXTURE.excerpt);
    expect(withUrn).toContain(`@[${JOB_FIXTURE.company}](${JOB_FIXTURE.organizationUrn})`);
    expect(withUrn).toContain('Novaggio');
    expect(withUrn.toLowerCase()).toContain('frontalieri');
    expect(withUrn.toLowerCase()).toContain('lavoro in svizzera');
    expect(withUrn).toContain('#offertedilavoro');

    const withoutUrn = commentaryOf(JOB_FIXTURE, JOB_FIXTURE.dayA, { organizationUrn: '' });
    expect(withoutUrn).toContain(JOB_FIXTURE.company);
    expect(withoutUrn).not.toMatch(/@\[EOC\]\(urn:li:organization:/);
  });

  it('missing company or location never blocks the post', () => {
    const text = buildMemberCommentary({
      kind: 'job',
      title: 'Magazziniere',
      url: JOB_FIXTURE.url,
      day: JOB_FIXTURE.dayA,
      excerpt: JOB_FIXTURE.excerpt,
    });
    expect(text.length).toBeGreaterThan(80);
    expect(text).toContain('Magazziniere');
  });
});

describe('article-card payload — thumbnail URN, no views in description', () => {
  const source = ARTICLE_FIXTURE.url;
  const title = ARTICLE_FIXTURE.title;
  const polluted = `${ARTICLE_FIXTURE.excerpt} 888777 visualizzazioni il 23/08/2026.`;

  it('strips view-count social proof from the card description', () => {
    const article = buildArticleContent({ source, title, description: polluted });
    expect(article.description).not.toMatch(/visualizzazion/i);
    expect(article.description).not.toContain('888777');
    expect(article.description).toContain('imposta alla fonte');
    expect(article.source).toBe(source);
    expect(article.title).toContain('IRPEF');
  });

  it('sets content.article.thumbnail when an image URN is supplied', () => {
    const thumb = 'urn:li:image:C4E10AQFoyyAjHPMQuQ';
    const article = buildArticleContent({
      source,
      title,
      description: ARTICLE_FIXTURE.excerpt,
      thumbnail: thumb,
    });
    expect(article.thumbnail).toBe(thumb);
    const payload = buildMemberPostPayload({
      author: 'urn:li:person:abc',
      commentary: 'x',
      article,
    });
    expect(payload.content.article.thumbnail).toBe(thumb);
    expect(payload.author).toBe('urn:li:person:abc');
  });

  it('omits thumbnail when upload failed (no URN) so the post still goes out', () => {
    const article = buildArticleContent({
      source,
      title,
      description: ARTICLE_FIXTURE.excerpt,
      thumbnail: null,
    });
    expect(article).not.toHaveProperty('thumbnail');
  });
});

describe('company mention + job field resolvers', () => {
  it('emits LinkedIn mention syntax only when a URN is known', () => {
    expect(formatCompanyMention('EOC', 'urn:li:organization:5515715')).toBe(
      '@[EOC](urn:li:organization:5515715)',
    );
    expect(formatCompanyMention('EOC', '5515715')).toBe(
      '@[EOC](urn:li:organization:5515715)',
    );
    expect(formatCompanyMention('EOC', '')).toBe('EOC');
    expect(formatCompanyMention('', 'urn:li:organization:1')).toBe('');
  });

  it('reads company, location and description off a real job-shaped record', () => {
    const job = {
      title: 'Infermiere/a in cure generali',
      hiringOrganization: { name: 'EOC', linkedinUrn: 'urn:li:organization:9' },
      jobLocation: { address: { addressLocality: 'Novaggio' } },
      canton: 'TI',
      description: '<p>Cerchiamo un infermiere/a per il servizio di cure generali a Novaggio.</p>',
    };
    expect(resolveJobCompany(job)).toBe('EOC');
    expect(resolveOrganizationUrn(job)).toBe('urn:li:organization:9');
    expect(resolveJobLocation(job)).toContain('Novaggio');
    expect(resolveJobLocation(job)).toContain('Ticino');
    expect(resolveJobDescription(job)).toContain('infermiere');
    expect(inferArticleLocation({ title: 'Tasse in Ticino', path: '/articoli-frontaliere/x' })).toBe(
      'Ticino',
    );
  });
});

describe('og:image extract + WebP conversion + Images upload', () => {
  it('reads og:image and og:description regardless of attribute order', () => {
    const html = [
      '<meta content="https://cdn.example/hero.webp" property="og:image">',
      '<meta name="description" content="fallback">',
      '<meta property="og:description" content="Per i frontalieri l\'imposta alla fonte.">',
    ].join('\n');
    const meta = extractOgFromHtml(html);
    expect(meta.ogImage).toBe('https://cdn.example/hero.webp');
    expect(meta.ogDescription).toContain('imposta alla fonte');
  });

  it('fetchPageOg resolves a relative og:image against the page URL', async () => {
    const html = '<meta property="og:image" content="/images/blog/x.webp">';
    const meta = await fetchPageOg('https://frontaliereticino.ch/articoli-frontaliere/x/', async () =>
      new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }),
    );
    expect(meta.ogImage).toBe('https://frontaliereticino.ch/images/blog/x.webp');
  });

  it('converts a WebP buffer to JPEG so Images API will accept it', async () => {
    const webp = await sharp({
      create: { width: 8, height: 8, channels: 3, background: '#cc0000' },
    })
      .webp()
      .toBuffer();
    const out = await convertImageForLinkedIn(webp, {
      contentType: 'image/webp',
      url: 'https://cdn.example/hero.webp',
    });
    expect(out.contentType).toBe('image/jpeg');
    expect(out.buffer[0]).toBe(0xff);
    expect(out.buffer[1]).toBe(0xd8);
  });

  it('uploadLinkedInImage returns the image URN after initializeUpload + PUT', async () => {
    const webp = await sharp({
      create: { width: 8, height: 8, channels: 3, background: '#003399' },
    })
      .webp()
      .toBuffer();
    const imageUrn = 'urn:li:image:C4E10AQFtestThumb';
    const uploadUrl = 'https://www.linkedin.com/dms-uploads/test';
    const fetchImpl = async (url: string, init?: { method?: string }) => {
      const u = String(url);
      if (u.endsWith('.webp') || u.includes('hero.webp')) {
        return new Response(webp, { status: 200, headers: { 'content-type': 'image/webp' } });
      }
      if (u.includes('initializeUpload')) {
        return new Response(
          JSON.stringify({ value: { uploadUrl, image: imageUrn } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (u === uploadUrl) {
        expect(init?.method).toBe('PUT');
        return new Response(null, { status: 201 });
      }
      throw new Error(`unexpected fetch ${u}`);
    };
    const urn = await uploadLinkedInImage({
      accessToken: 'tok',
      ownerUrn: 'urn:li:person:abc',
      imageUrl: 'https://cdn.example/hero.webp',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(urn).toBe(imageUrn);
  });

  it('uploadLinkedInImage is fail-soft on a 403 initializeUpload', async () => {
    const jpeg = await sharp({
      create: { width: 4, height: 4, channels: 3, background: '#ffffff' },
    })
      .jpeg()
      .toBuffer();
    const fetchImpl = async (url: string) => {
      if (String(url).includes('hero.jpg')) {
        return new Response(jpeg, { status: 200, headers: { 'content-type': 'image/jpeg' } });
      }
      return new Response('forbidden', { status: 403 });
    };
    const urn = await uploadLinkedInImage({
      accessToken: 'tok',
      ownerUrn: 'urn:li:person:abc',
      imageUrl: 'https://cdn.example/hero.jpg',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(urn).toBeNull();
  });
});

describe('stripViewCounts', () => {
  it('drops the exact social-proof line the last live post used', () => {
    expect(stripViewCounts('📊 30 visualizzazioni il 23/08/2026.')).toBe('');
    expect(stripViewCounts('Guida. 30 visualizzazioni.')).toBe('Guida.');
  });
});
