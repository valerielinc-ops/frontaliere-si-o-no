/**
 * Static scan: every Leaflet map in components/ goes through the shared
 * `MapCanvas` shell.
 *
 * Six components used to repeat `import 'leaflet/dist/leaflet.css'`, their own
 * `<MapContainer>` + the identical OSM `<TileLayer>`, and their own reserved
 * height (the 320px floor was copy-pasted literally in three files). A constant
 * duplicated in ≥2 files drifts, so it lives once in the shell (AGENTS.md #6)
 * and this test fails if a new component reintroduces the copy-paste.
 *
 * String-based, like `no-missing-aria-labels`: rendering Leaflet in jsdom is
 * far more expensive than reading the sources.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const COMPONENTS_DIR = path.join(ROOT, 'components');
const SHELL = path.join(COMPONENTS_DIR, 'shared', 'MapCanvas.tsx');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.tsx') || entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

const files = walk(COMPONENTS_DIR).map(file => ({ file, src: readFileSync(file, 'utf8') }));
const rel = (file: string) => path.relative(ROOT, file);

describe('MapCanvas is the single Leaflet shell', () => {
  it('only the shell imports leaflet.css', () => {
    const importers = files
      .filter(({ src }) => src.includes('leaflet/dist/leaflet.css'))
      .map(({ file }) => rel(file));
    expect(importers).toEqual([rel(SHELL)]);
  });

  it('only the shell mounts MapContainer / TileLayer', () => {
    const mounters = files
      .filter(({ src }) => /<MapContainer\b|<TileLayer\b/.test(src))
      .map(({ file }) => rel(file));
    expect(mounters).toEqual([rel(SHELL)]);
  });

  it('only the shell hard-codes the OSM tile URL and attribution', () => {
    const tileUsers = files
      .filter(({ src }) => src.includes('tile.openstreetmap.org'))
      .map(({ file }) => rel(file));
    expect(tileUsers).toEqual([rel(SHELL)]);
  });

  it('the shell reserves a height floor against CLS', () => {
    const src = readFileSync(SHELL, 'utf8');
    expect(src).toMatch(/export const MAP_MIN_HEIGHT = \d+;/);
    // The reserved box gets both height and minHeight, so the async Leaflet
    // load never shifts the layout (AGENTS.md #7).
    expect(src).toContain('style={{ height, minHeight }}');
  });
});
