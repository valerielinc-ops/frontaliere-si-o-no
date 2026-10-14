// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { compactFuelArchiveDay, readFuelArchive, writeFuelArchive } from '../scripts/lib/fuel-monthly-archive.mjs';
import { generateFuelArchivePages } from '../build-plugins/fuelDailyPagesPlugin';
import { FUEL_ZONES } from '../build-plugins/shared/fuelRouteSlugs.mjs';
import type { FuelZone } from '../build-plugins/fuelDailyData';
import { htmlHasIndexableRobots } from '../build-plugins/shared/incrementalHtmlReuse.mjs';
const today = new Date();
const day = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 0)).toISOString().slice(0, 10);
const row = () => ({ date: day, diesel: { source: 'api' as const }, zones: Object.fromEntries(FUEL_ZONES.map((zone) => [zone, { benzina: 1.8, diesel: 1.9 }])) as Record<FuelZone, { benzina: number; diesel: number }> });

describe('durable fuel monthly facts', () => {
  it('keeps unknown diesel archives reachable but only petrol observations indexable', () => {
    const snapshot = compactFuelArchiveDay({ ...row(), diesel: { source: 'mixed' } });
    const pages = generateFuelArchivePages({ history: [snapshot], today });
    expect(Object.keys(pages)).toHaveLength(40);
    for (const [url, html] of Object.entries(pages)) {
      const diesel = /diesel|gasoil/.test(url);
      expect(htmlHasIndexableRobots(html), url).toBe(!diesel);
      expect(html).toContain(`https://frontaliereticino.ch${url}`);
    }
    const source = fs.readFileSync(new URL('../build-plugins/fuelDailyPagesPlugin.ts', import.meta.url), 'utf8');
    const writer = source.slice(source.indexOf('for (const [path, html] of Object.entries(archives))'));
    expect(writer).toContain('if (htmlHasIndexableRobots(html)) sitemapPaths.push(path)');
  });
  it('retains observed prices without reviving synthetic or unknown diesel', () => {
    const api = compactFuelArchiveDay({ ...row(), stations: { private: 'discard' } });
    expect(api.zones.chiasso.diesel).toBe(1.9);
    expect(compactFuelArchiveDay(api)).toEqual(api);
    expect(api).not.toHaveProperty('stations');
    for (const source of ['mixed', 'derived', 'unavailable', 'unknown']) {
      const compact = compactFuelArchiveDay({ ...row(), diesel: { source } });
      expect(compact.zones.chiasso.diesel).toBeNull();
      expect(compact.zones.chiasso.benzina).toBe(1.8);
    }
  });
  it('keeps the monthly record after daily pruning and writes idempotently', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fuel-archive-'));
    const history = path.join(root, 'history'); const archive = path.join(root, 'archive');
    fs.mkdirSync(history);
    try {
      const file = path.join(history, `${day}.json`);
      fs.writeFileSync(file, JSON.stringify(row()));
      expect(writeFuelArchive(history, archive, today.toISOString().slice(0, 10))).toBe(1);
      expect(writeFuelArchive(history, archive, today.toISOString().slice(0, 10))).toBe(0);
      fs.unlinkSync(file);
      writeFuelArchive(history, archive, today.toISOString().slice(0, 10));
      expect(readFuelArchive(archive)).toEqual([compactFuelArchiveDay(row())]);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  it('preserves the renderer and counts a fresh overlapping day once', () => {
    const original = row(); const compact = compactFuelArchiveDay(original);
    const rawPages = generateFuelArchivePages({ history: [original], today });
    expect(generateFuelArchivePages({ history: [compact], today })).toEqual(rawPages);
    expect(generateFuelArchivePages({ history: [compact, original], today })).toEqual(rawPages);
    expect(Object.keys(rawPages)).toHaveLength(40);
  });
});
