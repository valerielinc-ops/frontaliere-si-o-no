import { describe, expect, it } from 'vitest';

import {
  collectJobDetailDays,
  deriveSitemapLastmods,
  newestDeclaredDay,
  newestLinkedJobDay,
  newestSitemapDay,
} from '../build-plugins/shared/sitemapDerivedLastmod';
import { pruneSeededPagesAlreadyListed } from '../build-plugins/shared/sitemapUrlsetDedupe';

const BASE = 'https://frontaliereticino.ch';
const NOW = new Date('2026-10-31T12:00:00Z');

const url = (path: string, lastmod?: string) =>
  `  <url>\n    <loc>${BASE}${path}</loc>\n${lastmod ? `    <lastmod>${lastmod}</lastmod>\n` : ''}    <changefreq>daily</changefreq>\n  </url>`;
const urlset = (...blocks: string[]) => `<urlset>\n${blocks.join('\n')}\n</urlset>\n`;

const JOBS = urlset(
  url('/cerca-lavoro-ticino/operaio-a/', '2026-09-01'),
  url('/cerca-lavoro-ticino/operaio-b/', '2026-10-20'),
  url('/cerca-lavoro-ticino/lugano/'),
  url('/cerca-lavoro-ticino/chiasso/'),
);

describe('collectJobDetailDays', () => {
  it('maps only dated entries of the job sitemaps', () => {
    const days = collectJobDetailDays([
      { file: 'sitemap-jobs.xml', xml: JOBS },
      { file: 'sitemap-jobs-expired.xml', xml: urlset(url('/cerca-lavoro-ticino/scaduto/', '2026-10-30')) },
      { file: 'sitemap-blog.xml', xml: urlset(url('/articoli/x/', '2026-10-30')) },
    ]);
    expect([...days.keys()].sort()).toEqual([
      `${BASE}/cerca-lavoro-ticino/operaio-a/`,
      `${BASE}/cerca-lavoro-ticino/operaio-b/`,
    ]);
  });
});

describe('newestLinkedJobDay', () => {
  const days = new Map([
    [`${BASE}/a/`, '2026-09-01'],
    [`${BASE}/b/`, '2026-10-20'],
  ]);

  it('takes the newest listed job, for relative and absolute links', () => {
    expect(newestLinkedJobDay(`<a href="/a/">x</a><a href="${BASE}/b/">y</a>`, days)).toBe('2026-10-20');
  });

  it('ignores a query string or a fragment on the link', () => {
    expect(newestLinkedJobDay('<a href="/a/?ref=hub">x</a><a href="/b/#apply">y</a>', days)).toBe('2026-10-20');
  });

  it('has no opinion on a page that links no dated job', () => {
    expect(newestLinkedJobDay('<a href="/altro/">x</a>', days)).toBeUndefined();
  });
});

describe('newestDeclaredDay', () => {
  it('repeats the newest dateModified the page states', () => {
    const html = '{"dateModified":"2026-08-10T00:00:00.000Z"} {"dateModified": "2026-10-25T09:11:35.438Z"}';
    expect(newestDeclaredDay(html, NOW)).toBe('2026-10-25');
  });

  it('rejects a future or malformed value instead of publishing it', () => {
    expect(newestDeclaredDay('{"dateModified":"2031-01-01"}', NOW)).toBeUndefined();
    expect(newestDeclaredDay('{"dateModified":"ieri"}', NOW)).toBeUndefined();
  });
});

describe('deriveSitemapLastmods', () => {
  const pages: Record<string, string> = {
    [`${BASE}/cerca-lavoro-ticino/lugano/`]: '<a href="/cerca-lavoro-ticino/operaio-a/">a</a><a href="/cerca-lavoro-ticino/operaio-b/">b</a>',
    [`${BASE}/cerca-lavoro-ticino/chiasso/`]: '<p>nessun annuncio</p>',
  };
  const readHtml = (loc: string) => pages[loc] ?? null;

  it('dates a hub from its jobs and leaves the others undated', () => {
    const out = deriveSitemapLastmods([{ file: 'sitemap-jobs.xml', xml: JOBS }], readHtml, NOW).get('sitemap-jobs.xml')!;
    const lugano = /<url>(?:(?!<\/url>)[\s\S])*lugano[\s\S]*?<\/url>/.exec(out)![0];
    expect(lugano).toContain('<lastmod>2026-10-20</lastmod>');
    const chiasso = /<url>(?:(?!<\/url>)[\s\S])*chiasso[\s\S]*?<\/url>/.exec(out)![0];
    expect(chiasso).not.toContain('<lastmod>');
  });

  it('never rewrites a date that is already there', () => {
    const out = deriveSitemapLastmods([{ file: 'sitemap-jobs.xml', xml: JOBS }], readHtml, NOW).get('sitemap-jobs.xml')!;
    expect(out).toContain('<lastmod>2026-09-01</lastmod>');
  });

  it('stays undated when the page is not in this build (locale shard)', () => {
    const out = deriveSitemapLastmods([{ file: 'sitemap-jobs.xml', xml: JOBS }], () => null, NOW);
    expect(out.size).toBe(0);
  });

  it('does not touch families outside the allowlist, and never reads their HTML', () => {
    const events = urlset(url('/eventi/ticino/lugano/concerto-2026-11-02/'));
    const reads: string[] = [];
    const out = deriveSitemapLastmods(
      [{ file: 'sitemap-jobs.xml', xml: urlset(url('/cerca-lavoro-ticino/operaio-b/', '2026-10-20')) }, { file: 'sitemap-eventi.xml', xml: events }],
      (loc) => { reads.push(loc); return '<a href="/cerca-lavoro-ticino/operaio-b/">b</a>'; },
      NOW,
    );
    expect(reads).toEqual([]);
    expect(out.has('sitemap-eventi.xml')).toBe(false);
  });

  it('uses the declared date for the declaring families', () => {
    const premiums = urlset(url('/premi-cassa-malati/ginevra/'));
    const out = deriveSitemapLastmods(
      [{ file: 'sitemap-health-premiums.xml', xml: premiums }],
      () => '{"dateModified":"2026-10-25T09:11:35.438Z"}',
      NOW,
    );
    expect(out.get('sitemap-health-premiums.xml')).toContain('<lastmod>2026-10-25</lastmod>');
  });
});

describe('newestSitemapDay', () => {
  it('reads the newest day and tolerates a full timestamp', () => {
    expect(newestSitemapDay('<lastmod>2026-01-02</lastmod><lastmod>2026-03-04T10:00:00Z</lastmod>')).toBe('2026-03-04');
  });

  it('is undefined for a file that dates nothing', () => {
    expect(newestSitemapDay(urlset(url('/x/')))).toBeUndefined();
  });
});

describe('pruneSeededPagesAlreadyListed', () => {
  const pagesXml = urlset(url('/calcola-stipendio/stipendio-netto-40000-chf/', '2026-04-09'), url('/solo-qui/', '2026-04-09'));
  const hubXml = urlset(url('/calcola-stipendio/stipendio-netto-40000-chf/'));

  it('drops the seeded copy and keeps its real date on the owner', () => {
    const out = pruneSeededPagesAlreadyListed([
      { file: 'sitemap-pages.xml', xml: pagesXml },
      { file: 'sitemap-salary-hub.xml', xml: hubXml },
    ]);
    expect(out.get('sitemap-pages.xml')).not.toContain('stipendio-netto-40000');
    expect(out.get('sitemap-pages.xml')).toContain('/solo-qui/');
    expect(out.get('sitemap-salary-hub.xml')).toContain('<lastmod>2026-04-09</lastmod>');
  });

  it('keeps an article in sitemap-news.xml: Google News needs it there', () => {
    const blogXml = urlset(url('/articoli/x/', '2026-10-28'));
    const newsXml = urlset(url('/articoli/x/', '2026-10-28'));
    const out = pruneSeededPagesAlreadyListed([
      { file: 'sitemap-pages.xml', xml: pagesXml },
      { file: 'sitemap-blog.xml', xml: blogXml },
      { file: 'sitemap-news.xml', xml: newsXml },
    ]);
    expect(out.size).toBe(0);
  });

  it('does not treat the seeded file as its own owner', () => {
    expect(pruneSeededPagesAlreadyListed([{ file: 'sitemap-pages.xml', xml: pagesXml }]).size).toBe(0);
  });
});
