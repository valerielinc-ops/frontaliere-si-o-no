/**
 * Regression guard for canton sub-hubs: every non-TI `tutti/settori/aziende`
 * page is now a complete indexable template, including a zero/low-inventory
 * canton. The old below-floor bridge policy is intentionally gone for this
 * family; other editorial and company floors remain separate.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cantonArchivePageCount } from '../build-plugins/shared/cantonArchivePlan';

const __dirname = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(__dirname, '../build-plugins/seoHubsPlugin.ts'), 'utf8');
const staticPagesSource = readFileSync(resolve(__dirname, '../build-plugins/staticPagesPlugin.ts'), 'utf8');

describe('seoHubsPlugin complete canton sub-hubs', () => {
  it('does not retain the below-floor/noindex canton bridge emitter', () => {
    expect(source).not.toContain('emitCantonHubBelowFloorBridge');
    expect(source).not.toContain('isCantonNoindex');
  });

  it('always runs the complete archive template for every non-TI canton', () => {
    const startIdx = source.indexOf('for (const canton of ALL_CANTON_CODES) {');
    const endIdx = source.indexOf('const empCounts = cantonEmployerCounts.get(canton)', startIdx);
    expect(startIdx).toBeGreaterThan(-1);
    expect(endIdx).toBeGreaterThan(startIdx);
    const body = source.slice(startIdx, endIdx);
    expect(body).toContain('cantonArchivePageCount(total, jobs, true)');
    expect(body).not.toContain('archivePages === 0');
  });

  it('does not carry the old archive floor into the shared page-count helper', () => {
    const archiveSource = readFileSync(resolve(__dirname, '../build-plugins/shared/cantonArchivePlan.ts'), 'utf8');
    expect(archiveSource).not.toContain('MIN_JOBS_FOR_CANTON_PAGE');
    expect(archiveSource).toContain('return Math.max(1, Math.ceil(itemCount / JOBS_PAGE_SIZE));');
  });

  it('keeps one complete archive page for a short or empty snapshot', () => {
    expect(cantonArchivePageCount(0, [], true)).toBe(1);
    expect(cantonArchivePageCount(3, [{ slug: 'one', role: 'Role', employer: 'Employer', employerKey: 'employer', city: 'City' }], true)).toBe(1);
    expect(cantonArchivePageCount(0, [], false)).toBe(0);
  });

  it('the caller (staticPagesPlugin.ts) wires qw to its own WriteCollector-backed _qw, the real shard-locale chokepoint', () => {
    const callIdx = staticPagesSource.indexOf('const hubs = emitSeoHubs({');
    expect(callIdx).toBeGreaterThan(-1);
    const callBody = staticPagesSource.slice(callIdx, callIdx + 200);
    expect(callBody).toContain('qw: _qw,');

    const qwDefIdx = staticPagesSource.indexOf('function _qw(');
    expect(qwDefIdx).toBeGreaterThan(-1);
    const qwBody = staticPagesSource.slice(qwDefIdx, qwDefIdx + 300);
    expect(qwBody).toContain('collector.add(');
  });
});
