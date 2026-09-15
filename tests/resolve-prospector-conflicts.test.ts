import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeProspectorPath, mergeThreeWay } from '../scripts/lib/resolve-prospector-conflicts.mjs';

const now = Date.now();
const iso = (offsetMs: number) => new Date(now + offsetMs).toISOString();

describe('Prospector rebase conflict resolver', () => {
  it('unisce queue concorrenti e non fa regredire lo stato del candidato', () => {
    const base: any = {
      version: 2,
      updatedAt: iso(0),
      candidates: {
        shared: {
          key: 'shared',
          status: 'traced',
          sources: ['seco'],
          firstSeenAt: iso(-3000),
          updatedAt: iso(-2000),
          validationHistory: [{ at: iso(-1000), verdict: 'weak', score: 0.4 }],
        },
      },
      rejectedTombstones: {},
    };
    const upstream = structuredClone(base);
    upstream.updatedAt = iso(1000);
    upstream.candidates.remote = { key: 'remote', status: 'new', sources: ['osm'], updatedAt: iso(1000) };
    upstream.candidates.shared.status = 'promoted';
    upstream.candidates.shared.sources = ['seco', 'web'];
    upstream.candidates.shared.validationHistory.push({ at: iso(1100), verdict: 'good', score: 0.9 });

    const local = structuredClone(base);
    local.updatedAt = iso(2000);
    local.candidates.local = { key: 'local', status: 'synthesized', sources: ['own'], updatedAt: iso(2000) };
    local.candidates.shared.status = 'production';
    local.candidates.shared.sources = ['seco', 'web', 'own'];
    local.candidates.shared.validationHistory.push({ at: iso(2100), verdict: 'good', score: 0.95 });

    const merged = mergeProspectorPath('data/prospector/candidates.json', base, upstream, local) as typeof base;
    expect(Object.keys(merged.candidates)).toEqual(['local', 'remote', 'shared']);
    expect(merged.candidates.shared.status).toBe('production');
    expect(merged.candidates.shared.sources).toEqual(['seco', 'web', 'own']);
    expect(merged.candidates.shared.validationHistory).toHaveLength(3);
    expect(merged.updatedAt).toBe(local.updatedAt);
  });

  it('fonde registry e conteggi senza sommare due volte le stesse osservazioni', () => {
    const base = {
      version: 1,
      updatedAt: iso(0),
      platforms: {
        vendor: {
          domain: 'vendor.example',
          status: 'candidate',
          seenOn: ['one.example'],
          markers: ['one'],
          hostSamples: ['one.vendor.example'],
          hostHits: { 'one.vendor.example': 1 },
          pathHits: {},
          listingPaths: [],
          tenantCount: 1,
          discoveredAt: iso(-1000),
        },
      },
    };
    const upstream = structuredClone(base);
    upstream.platforms.vendor.status = 'confirmed';
    upstream.platforms.vendor.seenOn.push('two.example');
    upstream.platforms.vendor.hostHits['two.vendor.example'] = 2;
    upstream.platforms.vendor.tenantCount = 2;
    const local = structuredClone(base);
    local.platforms.vendor.status = 'supported';
    local.platforms.vendor.seenOn.push('three.example');
    local.platforms.vendor.hostHits['one.vendor.example'] = 2;
    local.platforms.vendor.tenantCount = 3;

    const merged = mergeProspectorPath('data/prospector/platforms.json', base, upstream, local) as typeof base;
    expect(merged.platforms.vendor.status).toBe('supported');
    expect(merged.platforms.vendor.seenOn).toEqual(['one.example', 'two.example', 'three.example']);
    expect(merged.platforms.vendor.hostHits).toEqual({ 'one.vendor.example': 2, 'two.vendor.example': 2 });
    expect(merged.platforms.vendor.tenantCount).toBe(3);
  });

  it('unisce report per azienda, ricalcola tally e annunci coperti', () => {
    const base = {
      generatedAt: iso(0),
      tally: { good: 0, weak: 1, bad: 0, insufficient: 0 },
      promotedVacancies: 0,
      reports: [{ companyKey: 'base', verdict: 'weak', vacancyCount: 1 }],
    };
    const upstream = {
      ...structuredClone(base),
      generatedAt: iso(1000),
      reports: [
        { companyKey: 'base', verdict: 'good', vacancyCount: 2 },
        { companyKey: 'remote', verdict: 'good', vacancyCount: 4 },
      ],
    };
    const local = {
      ...structuredClone(base),
      generatedAt: iso(2000),
      reports: [
        { companyKey: 'base', verdict: 'weak', vacancyCount: 3 },
        { companyKey: 'local', verdict: 'bad', vacancyCount: 5 },
      ],
    };

    const merged = mergeProspectorPath('data/prospector/validation.json', base, upstream, local) as typeof base;
    expect(merged.reports.map((report) => report.companyKey)).toEqual(['base', 'local', 'remote']);
    expect(merged.tally).toEqual({ good: 1, weak: 1, bad: 1, insufficient: 0 });
    expect(merged.promotedVacancies).toBe(4);
    expect(merged.generatedAt).toBe(local.generatedAt);
  });

  it('unisce la storia Common Crawl e mantiene solo la finestra prevista', () => {
    const entry = (index: number) => ({ at: iso(index * 1000), collection: 'cc', totalPages: 1, pagesRead: index, employers: index, outage: false });
    const base = Array.from({ length: 60 }, (_, index) => entry(index));
    const upstream = [...base.slice(1), entry(60)];
    const local = [...base.slice(1), entry(61)];
    const merged = mergeProspectorPath('data/prospector/web-channel-health.json', base, upstream, local) as typeof base;
    expect(merged).toHaveLength(60);
    expect(merged.at(-1)?.pagesRead).toBe(61);
    expect(merged.some((sample) => sample.pagesRead === 60)).toBe(true);
    expect(merged.some((sample) => sample.pagesRead === 0)).toBe(false);
  });

  it('non accetta un path conflitto inatteso', () => {
    expect(() => mergeProspectorPath('data/prospector/unknown.json', {}, {}, {})).toThrow(/unsupported Prospector conflict/);
  });

  it('il workflow passa il resolver al retry di push', () => {
    const workflow = readFileSync(new URL('../.github/workflows/prospector-loop.yml', import.meta.url), 'utf8');
    expect(workflow).toContain("--in-place-resolver-cmd 'node scripts/lib/resolve-prospector-conflicts.mjs && git add -A'");
  });

  it('risolve un rebase reale con conflitto queue + crawler add/add', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'prospector-rebase-'));
    const resolver = fileURLToPath(new URL('../scripts/lib/resolve-prospector-conflicts.mjs', import.meta.url));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
    const writeJson = (file: string, value: unknown) => {
      const target = path.join(dir, file);
      const parent = path.dirname(target);
      mkdirSync(parent, { recursive: true });
      writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
    };
    const candidates = (extra: Record<string, unknown>) => ({
      version: 2,
      updatedAt: iso(0),
      candidates: {
        base: { key: 'base', status: 'new', sources: ['seco'], updatedAt: iso(0) },
        ...extra,
      },
      rejectedTombstones: {},
    });
    const crawler = (seedUrl: string) => ({
      companyKey: 'shared-crawler',
      companyName: 'Shared crawler',
      companyHost: 'shared.example',
      mode: 'template',
      seedUrls: [seedUrl],
    });

    try {
      git('init', '-b', 'main');
      git('config', 'user.email', 'test@example.invalid');
      git('config', 'user.name', 'test');
      writeJson('data/prospector/candidates.json', candidates({}));
      git('add', '.');
      git('commit', '-m', 'base');

      git('checkout', '-b', 'upstream');
      writeJson('data/prospector/candidates.json', candidates({ remote: { key: 'remote', status: 'new', sources: ['osm'] } }));
      writeJson('data/prospector/crawlers/shared-crawler.json', crawler('https://upstream.example/jobs'));
      git('add', '.');
      git('commit', '-m', 'upstream prospector run');

      git('checkout', '-b', 'local', 'main');
      writeJson('data/prospector/candidates.json', candidates({ local: { key: 'local', status: 'synthesized', sources: ['own'] } }));
      writeJson('data/prospector/crawlers/shared-crawler.json', crawler('https://local.example/jobs'));
      git('add', '.');
      git('commit', '-m', 'local prospector run');

      expect(() => git('rebase', 'upstream')).toThrow();
      execFileSync(process.execPath, [resolver], { cwd: dir, encoding: 'utf8' });
      execFileSync('git', ['rebase', '--continue'], { cwd: dir, env: { ...process.env, GIT_EDITOR: ':' }, encoding: 'utf8' });

      const mergedCandidates = JSON.parse(readFileSync(path.join(dir, 'data/prospector/candidates.json'), 'utf8'));
      expect(Object.keys(mergedCandidates.candidates)).toEqual(['base', 'local', 'remote']);
      expect(JSON.parse(readFileSync(path.join(dir, 'data/prospector/crawlers/shared-crawler.json'), 'utf8')).seedUrls)
        .toEqual(['https://local.example/jobs']);
      expect(git('status', '--porcelain')).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('la scelta three-way applica la cancellazione del solo lato modificato', () => {
    const merged = mergeThreeWay({ present: true }, { present: true }, { present: false }, (upstream, local) => ({ ...upstream, ...local }));
    expect(merged).toEqual({ present: false });
  });
});
