import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { transformSync } from 'esbuild';
import { hasSameJobSourcePosting } from '../scripts/lib/job-identity.mjs';
import { reconcileOrphanSlugs, reconcileExpiredSlugs } from '../scripts/reconcile-job-slugs.mjs';

describe('inferred orphan aliases require positive posting identity', () => {
  const url = 'https://jobs.example.invalid/vacancies/orthopedics/';
  it.each([{}, { sourceUrl: '' }, { sourceUrl: '/vacancies/orthopedics/' },
    { sourceUrl: 'https://jobs.example.invalid/vacancies/oncology/' },
    { sourceUrl: 'mailto:jobs@example.invalid' }])('rejects unknown or different identity: %j', (record) => {
    expect(hasSameJobSourcePosting(record, { url })).toBe(false);
  });
  it('accepts the exact source posting, not just its company', () => {
    expect(hasSameJobSourcePosting({ sourceUrl: url }, { url })).toBe(true);
    expect(hasSameJobSourcePosting({ url }, { url })).toBe(true);
    expect(hasSameJobSourcePosting({ sourceUrl: url }, {})).toBe(false);
  });
  it('does not collapse distinct fragment-addressed postings', () => {
    expect(hasSameJobSourcePosting({ sourceUrl: `${url}#job.id=1` }, { url: `${url}#job.id=2` })).toBe(false);
    expect(hasSameJobSourcePosting({ sourceUrl: `${url}AbC/` }, { url: `${url}abc/` })).toBe(false);
  });
  it('recognizes explicit archive source identity and dedup history', () => {
    expect(hasSameJobSourcePosting({ sourceIdentity: `url:${url}` }, { url })).toBe(true);
    expect(hasSameJobSourcePosting({ sourceIdentityHistory: [{ sourceIdentity: `url:${url}` }] }, { url })).toBe(true);
  });
  it('also leaves identity-less expired fuzzy matches archived', () => {
    const active = { url, slug: 'software-entwickler-backend-rotation', company: 'Acme', companyKey: 'acme' };
    const expired = { slug: 'software-entwickler-backend', company: 'Acme', companyKey: 'acme' };
    const result = reconcileExpiredSlugs([active], [expired]);
    expect(result.mergedCount).toBe(0);
    expect(result.updatedExpired).toEqual([expired]);
  });
  it.each([undefined, 'https://jobs.example.invalid/vacancies/another/'])('leaves a high-overlap but unproven orphan archived (%s)', (sourceUrl) => {
    const slug = 'software-entwickler-backend';
    const active = { url, slug: `${slug}-rotation`, slugByLocale: { de: `${slug}-rotation` }, company: 'Acme', companyKey: 'acme' };
    const result = reconcileOrphanSlugs([active], [slug], [{ slug, sourceUrl }]);
    expect(result.mergedCount).toBe(0);
    expect(result.remainingOrphans).toEqual([slug]);
    expect(active).not.toHaveProperty('previousSlugs');
  });
  it('keeps the verified same-posting rename', () => {
    const slug = 'software-entwickler-backend';
    const active = { url, slug: `${slug}-rotation`, slugByLocale: { de: `${slug}-rotation` }, company: 'Acme', companyKey: 'acme' };
    const result = reconcileOrphanSlugs([active], [slug], [{ slug, sourceUrl: url }]);
    expect(result.mergedCount).toBe(1);
  });
  it('gates the independent SSG fuzzy candidate loop before scoring', () => {
    const source = fs.readFileSync(new URL('../build-plugins/jobsSeoPagesPlugin.ts', import.meta.url), 'utf8');
    const block = source.slice(source.indexOf('/* ── Fuzzy match orphan slugs'), source.indexOf('// Collect IT paths of all previous slugs'));
    expect(block).toContain('if (!orphanProof?.sourceUrl) continue;');
    expect(block.indexOf('if (!hasSameJobSourcePosting(orphanProof, cand)) continue;')).toBeLessThan(block.indexOf('const score = inter /'));
    expect(block.indexOf('if (!hasSameJobSourcePosting(orphanProof, cand)) continue;')).toBeGreaterThan(0);
  });
  it.each([undefined, 'https://jobs.example.invalid/vacancies/oncology/', url])('executes the real SSG loop without guessing oncology ownership (%s)', (sourceUrl) => {
    const source = fs.readFileSync(new URL('../build-plugins/jobsSeoPagesPlugin.ts', import.meta.url), 'utf8');
    const block = source.slice(source.indexOf('/* ── Fuzzy match orphan slugs'), source.indexOf('// Collect IT paths of all previous slugs'));
    const orphan = 'head-physician-oncology-60-100-spital-uster-uster';
    const job = { url, location: 'Uster', slug: 'assistant-physician-100-orthopedics-spital-uster-uster', slugByLocale: { en: 'assistant-physician-100-orthopedics-spital-uster-uster' } };
    const execute = new Function('validJobs', 'tracking', 'orphanGscData', 'localeList', '_allPrevSlugs', 'hasSameJobSourcePosting', transformSync(block, { loader: 'ts' }).code);
    execute([job], { [orphan]: {} }, new Map([[orphan, { sourceUrl }]]), ['en'], () => [], hasSameJobSourcePosting);
    // Even the legacy >=60% overlap must not create an alias without source proof.
    if (sourceUrl === url) expect(job).toHaveProperty('previousSlugsByLocale.en', [orphan]);
    else expect(job).not.toHaveProperty('previousSlugsByLocale');
  });
  it.each([
    { sourceUrls: [] },
    { sourceUrls: ['https://jobs.example.invalid/vacancies/oncology/'] },
    { sourceUrls: [url] },
    { sourceUrls: [url, 'https://jobs.example.invalid/vacancies/oncology/'] },
  ])('also gates the one-shot backfill heuristic (%j)', ({ sourceUrls }) => {
    const source = fs.readFileSync(new URL('../scripts/backfill-slug-aliases.mjs', import.meta.url), 'utf8');
    const helpers = source.slice(source.indexOf('function normalize('), source.indexOf('function loadJobs('));
    const loop = source.slice(source.indexOf('  const wantedOrphans ='), source.indexOf('  // ── Pass 2: Registry reconciliation'));
    const orphan = 'head-physician-oncology-60-100-spital-uster-uster';
    const job = { url, company: 'Spital Uster', location: 'Uster', slug: 'assistant-physician-100-orthopedics-spital-uster-uster' };
    const execute = new Function('orphanSlugs', 'byCompany', 'readOrphanEnriched', 'hasSameJobSourcePosting', 'ROOT', `${helpers}\n${loop}`);
    execute([orphan], new Map([['spital-uster', [job]]]), () => sourceUrls.map((sourceUrl) => ({ slug: orphan, sourceUrl })), hasSameJobSourcePosting, 'fixture-root');
    if (sourceUrls.length === 1 && sourceUrls[0] === url) expect(job).toHaveProperty('previousSlugs', [orphan]);
    else expect(job).not.toHaveProperty('previousSlugs');
  });
});
