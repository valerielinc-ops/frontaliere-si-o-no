import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  ALBERGO_GARDENIA_COMPANY_DOMAIN,
  ALBERGO_GARDENIA_COMPANY_NAME,
  ALBERGO_GARDENIA_KEY,
  ALBERGO_GARDENIA_SITEMAP_URL,
  assertCompleteAlbergoGardeniaSnapshot,
  assertNoGardeniaCareerSurface,
  fetchAllAlbergoGardeniaJobs,
  isAlbergoGardeniaJob,
  isTrustedDomain,
  parseAlbergoGardeniaSitemap,
} from '../scripts/lib/albergo-gardenia-job-parser.mjs';
import { buildExpiredEntry } from '../scripts/lib/expired-jobs-archive.mjs';
import { expiredJobSlugVariants } from '../build-plugins/shared/expiredSlugVariants';

const ROOT = path.resolve(import.meta.dirname, '..');
const SLICE_PATH = path.join(ROOT, 'data/jobs/by-crawler/albergo-gardenia.json');
const RUNNER_PATH = path.join(ROOT, 'scripts/update-albergo-gardenia-jobs.mjs');
const FALSE_SPEC_PATHS = [
  'data/prospector/crawlers/albergo-gardenia.json',
  'data/prospector/crawlers/alpenhof-davos.json',
  'data/prospector/crawlers/weisskreuz.json',
];

function representativeSitemap({ contentCount = 40, totalCount = 50 } = {}) {
  const urls = [];
  for (let i = 0; i < contentCount; i++) {
    const pathName = i % 5 === 0 ? 'index.php' : 'story.php';
    urls.push(`https://www.albergo-gardenia.ch/${pathName}?mid=${i + 1}&amp;amp;pid=1`);
  }
  for (let i = contentCount; i < totalCount; i++) {
    urls.push(`https://www.albergo-gardenia.ch/room.php?mid=${i + 1}&amp;amp;pid=1`);
  }
  return `${urls.map((url) => `<url><loc>${url}</loc></url>`).join('')}</urlset>`;
}

function gardeniaPage(extra = '') {
  return `<html><head><title>Villa Garni Gardenia - Caslano</title></head><body><main><h1>Gardenia</h1>${extra}</main></body></html>`;
}

describe('Albergo Gardenia authoritative crawler', () => {
  it('uses the real company identity and never claims HotellerieSuisse content', () => {
    expect(ALBERGO_GARDENIA_KEY).toBe('albergo-gardenia');
    expect(ALBERGO_GARDENIA_COMPANY_NAME).toBe('Albergo Gardenia');
    expect(ALBERGO_GARDENIA_COMPANY_DOMAIN).toBe('albergo-gardenia.ch');
    expect(isTrustedDomain('https://www.albergo-gardenia.ch/story.php?mid=1')).toBe(true);
    expect(isTrustedDomain('https://hotelleriesuisse.ch/it/politica/lavoro-e-istruzione')).toBe(false);
    expect(isAlbergoGardeniaJob({ companyKey: ALBERGO_GARDENIA_KEY })).toBe(true);
    expect(isAlbergoGardeniaJob({ company: 'Albergo Gardenia' })).toBe(true);
    expect(isAlbergoGardeniaJob({ url: 'https://www.albergo-gardenia.ch/story.php?mid=1' })).toBe(true);
    expect(isAlbergoGardeniaJob({ company: 'HotellerieSuisse', url: 'https://hotelleriesuisse.ch/jobs' })).toBe(false);
  });

  it('decodes the malformed live sitemap and proves a bounded content inventory', () => {
    const inventory = parseAlbergoGardeniaSitemap(representativeSitemap());
    expect(inventory.allUrls).toHaveLength(50);
    expect(inventory.contentUrls).toHaveLength(40);
    expect(inventory.contentUrls[0]).toContain('?mid=1&pid=1');
  });

  it('returns only a marked authoritative zero after every content page succeeds', async () => {
    const sitemap = representativeSitemap();
    const fetchPage = vi.fn(async (url: string) => {
      if (url === ALBERGO_GARDENIA_SITEMAP_URL) {
        return { ok: true, status: 200, url, body: sitemap };
      }
      return { ok: true, status: 200, url, body: gardeniaPage() };
    });

    const first = await fetchAllAlbergoGardeniaJobs({ fetchPage });
    const second = await fetchAllAlbergoGardeniaJobs({ fetchPage });
    expect(first).toEqual([]);
    expect(second).toEqual([]);
    expect(Reflect.get(first, 'sourcePageCount')).toBe(40);
    expect(Reflect.get(first, 'discoveredCount')).toBe(0);
    expect(assertCompleteAlbergoGardeniaSnapshot(first)).toBe(true);
    expect(() => assertCompleteAlbergoGardeniaSnapshot([])).toThrow(/not a proven authoritative empty state/);
    expect(fetchPage).toHaveBeenCalledTimes(82);
  });

  it.each([
    ['truncated sitemap', representativeSitemap({ contentCount: 39, totalCount: 49 }), /sitemap is incomplete/],
    ['foreign URL', representativeSitemap().replace('https://www.albergo-gardenia.ch/story.php', 'https://attacker.example/story.php'), /escaped the trusted source/],
    ['new careers URL', representativeSitemap().replace('/room.php?mid=41', '/jobs?mid=41'), /career surface/],
  ])('fails closed on %s', (_label, xml, expected) => {
    expect(() => parseAlbergoGardeniaSitemap(xml)).toThrow(expected);
  });

  it('fails closed when one authoritative page is unreachable or redirects by path', async () => {
    const sitemap = representativeSitemap();
    const unreachable = vi.fn(async (url: string) => {
      if (url === ALBERGO_GARDENIA_SITEMAP_URL) return { ok: true, status: 200, url, body: sitemap };
      if (url.includes('mid=9')) return { ok: false, status: 500, url, body: '' };
      return { ok: true, status: 200, url, body: gardeniaPage() };
    });
    await expect(fetchAllAlbergoGardeniaJobs({ fetchPage: unreachable })).rejects.toThrow(/content fetch failed/);

    const redirected = vi.fn(async (url: string) => {
      if (url === ALBERGO_GARDENIA_SITEMAP_URL) return { ok: true, status: 200, url, body: sitemap };
      return { ok: true, status: 200, url: url.includes('mid=9') ? url.replace('mid=9', 'mid=999') : url, body: gardeniaPage() };
    });
    await expect(fetchAllAlbergoGardeniaJobs({ fetchPage: redirected })).rejects.toThrow(/redirected outside its inventory/);
  });

  it('fails closed on missing source identity, career navigation, or JobPosting', () => {
    expect(() => assertNoGardeniaCareerSurface('<html><title>Unrelated site</title></html>', 'https://www.albergo-gardenia.ch/story.php'))
      .toThrow(/source identity is missing/);
    expect(() => assertNoGardeniaCareerSurface(gardeniaPage('<a href="/lavora-con-noi">Lavora con noi</a>'), 'https://www.albergo-gardenia.ch/story.php'))
      .toThrow(/career signal detected/);
    expect(() => assertNoGardeniaCareerSurface(gardeniaPage('<script type="application/ld+json">{"@type":"JobPosting"}</script>'), 'https://www.albergo-gardenia.ch/story.php'))
      .toThrow(/JobPosting detected/);
  });

  it('opts the runner into source-validated authoritative empty publishing', () => {
    const source = fs.readFileSync(RUNNER_PATH, 'utf8');
    expect(source).toContain('validateAuthoritativeSnapshot: assertCompleteAlbergoGardeniaSnapshot');
    expect(source).toContain('allowAuthoritativeEmptySnapshot: true');
  });

  it('retires exactly the three false identities through reachable archived routes', () => {
    const slice = JSON.parse(fs.readFileSync(SLICE_PATH, 'utf8'));
    const jobs = slice.jobs;
    expect(jobs.map((job: { id: string }) => job.id).sort()).toEqual([
      'albergo-gardenia-261a6e43b839',
      'albergo-gardenia-a58372a459dc',
      'albergo-gardenia-bf0d61d0f1cd',
    ]);

    for (const job of jobs) {
      const before = new Set(expiredJobSlugVariants(job));
      const archived = buildExpiredEntry(job);
      const after = new Set(expiredJobSlugVariants(archived));
      expect(after).toEqual(before);
      for (const slug of before) {
        expect(expiredJobSlugVariants(archived)).toContain(slug);
      }
    }
  });

  it('removes only the three proven inactive poisoned learned specs', () => {
    for (const relativePath of FALSE_SPEC_PATHS) {
      expect(fs.existsSync(path.join(ROOT, relativePath))).toBe(false);
    }
  });
});
