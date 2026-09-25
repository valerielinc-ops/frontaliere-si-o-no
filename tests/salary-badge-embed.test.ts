/**
 * Tests for the embeddable "stipendio medio {professione}" badge (sub #4474,
 * epic #4472).
 *
 * Covers `buildSalaryBadgeSnapshot` (pure transform of
 * data/profession-salary-medians.json → dist/embed/salary-badge-data.json):
 *  - real presets → entries with trailing-slash IT landing URLs
 *  - clean fallback: presets without a median / label / known IT landing dropped
 *  - `updatedAt` derived from `generatedAt`, generic salary-hub `canonicalUrl`
 * Plus a consistency check that the checked-in fallback snapshot matches the
 * live source dataset, and that the static widget files are self-contained.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildSalaryBadgeSnapshot,
  SALARY_BADGE_HUB_URL,
} from '@/build-plugins/salaryBadgeEmbedPlugin';

const ROOT = path.resolve(__dirname, '..');
const BASE = 'https://frontaliereticino.ch';

describe('buildSalaryBadgeSnapshot', () => {
  it('maps real presets to entries with trailing-slash IT landing URLs', () => {
    const snap = buildSalaryBadgeSnapshot({
      generatedAt: '2026-07-16T23:05:07.079Z',
      source: 'test-source',
      presets: [
        { id: 'infermiere', label: { it: 'Infermiere' }, medianSalaryChf: 75250 },
        { id: 'ingegnere', label: { it: 'Ingegnere' }, medianSalaryChf: 73000.4 },
      ],
    });
    expect(snap.updatedAt).toBe('2026-07-16');
    expect(snap.canonicalUrl).toBe(SALARY_BADGE_HUB_URL);
    expect(snap.source).toBe('test-source');
    expect(snap.professions).toHaveLength(2);

    const nurse = snap.professions.find((p) => p.id === 'infermiere');
    expect(nurse).toEqual({
      id: 'infermiere',
      label: 'Infermiere',
      medianChf: 75250,
      landingUrl: `${BASE}/lavoro-ticino-infermiere/`,
    });
    // Median is rounded to an integer.
    expect(snap.professions.find((p) => p.id === 'ingegnere')?.medianChf).toBe(73000);
    // Every landing URL keeps the canonical trailing slash.
    for (const p of snap.professions) {
      expect(p.landingUrl.startsWith(`${BASE}/`)).toBe(true);
      expect(p.landingUrl.endsWith('/')).toBe(true);
    }
  });

  it('drops presets without a median, label, or known IT landing (clean fallback)', () => {
    const snap = buildSalaryBadgeSnapshot({
      generatedAt: '2026-07-16T00:00:00.000Z',
      presets: [
        { id: 'infermiere', label: { it: 'Infermiere' }, medianSalaryChf: 75250 }, // kept
        { id: 'infermiere', label: { it: 'Infermiere' } }, // no median → dropped
        { id: 'ingegnere', label: {}, medianSalaryChf: 70000 }, // no IT label → dropped
        { id: 'not-a-real-profession', label: { it: 'Boh' }, medianSalaryChf: 60000 }, // no landing → dropped
      ],
    });
    expect(snap.professions.map((p) => p.id)).toEqual(['infermiere']);
  });

  it('tolerates a missing/empty dataset', () => {
    const snap = buildSalaryBadgeSnapshot({});
    expect(snap.professions).toEqual([]);
    expect(snap.updatedAt).toBeNull();
    expect(snap.canonicalUrl).toBe(SALARY_BADGE_HUB_URL);
  });
});

describe('checked-in fallback snapshot', () => {
  const fallbackPath = path.join(ROOT, 'public', 'embed', 'salary-badge-data.json');
  const sourcePath = path.join(ROOT, 'data', 'profession-salary-medians.json');

  it('matches what the plugin would emit from the live source dataset', () => {
    const source = JSON.parse(fs.readFileSync(sourcePath, 'utf-8'));
    const expected = buildSalaryBadgeSnapshot(source);
    const fallback = JSON.parse(fs.readFileSync(fallbackPath, 'utf-8'));
    expect(fallback.canonicalUrl).toBe(expected.canonicalUrl);
    expect(fallback.updatedAt).toBe(expected.updatedAt);
    expect(fallback.professions).toEqual(expected.professions);
    // Non-empty: the source dataset ships real medians.
    expect(expected.professions.length).toBeGreaterThan(0);
  });
});

describe('static embed widget files', () => {
  const embedDir = path.join(ROOT, 'public', 'embed');

  it('salary-badge.html is self-contained and noindex,follow', () => {
    const html = fs.readFileSync(path.join(embedDir, 'salary-badge.html'), 'utf-8');
    expect(html).toContain('noindex,follow');
    // No third-party scripts/styles.
    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(html).not.toMatch(/<link[^>]+href=["']https?:/i);
    // Reads the JSON snapshot and honours the professione query param.
    expect(html).toContain('/embed/salary-badge-data.json');
    expect(html).toContain('professione');
    // Well under the 50KB budget.
    expect(html.length).toBeLessThan(50 * 1024);
  });

  it('embed gallery index documents all three widgets', () => {
    const html = fs.readFileSync(path.join(embedDir, 'index.html'), 'utf-8');
    expect(html).toContain('salary-badge.html');
    expect(html).toContain('border-wait-widget.html');
    expect(html).toContain('currency-widget.html');
    expect(html).not.toMatch(/<script[^>]+src=/i);
  });
});
