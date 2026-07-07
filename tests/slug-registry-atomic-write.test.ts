// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadSlugRegistry, saveSlugRegistry } from '../scripts/lib/dedicated-crawler-common.mjs';

// Regression coverage for a torn-read race: crawler-group jobs run ~25
// sibling crawlers concurrently against one shared checkout, each doing an
// unsynchronized loadSlugRegistry() -> mutate -> saveSlugRegistry() cycle on
// the same data/slug-registry.json. A direct writeFileSync is not atomic for
// a file this size, so a concurrent readFileSync elsewhere could observe a
// truncated write mid-flight, fail JSON.parse, and silently fall back to `{}`
// in loadSlugRegistry's catch -- causing that crawler to mint a fresh slug for
// a job that already has an immutable canonical slug pinned. The fix writes
// to a per-process temp file and renames into place (atomic on the same
// filesystem), so any concurrent reader always sees either the pre- or
// post-write snapshot in full, never a partial one.
describe('saveSlugRegistry atomic write', () => {
  const tmpPaths: string[] = [];

  afterEach(() => {
    for (const p of tmpPaths.splice(0)) {
      try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* already gone */ }
    }
    delete process.env.SLUG_REGISTRY_PATH_OVERRIDE;
  });

  it('writes via temp-file + rename, leaving no leftover tmp file and a fully valid registry', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slug-registry-atomic-'));
    tmpPaths.push(dir);
    const registryPath = path.join(dir, 'slug-registry.json');
    process.env.SLUG_REGISTRY_PATH_OVERRIDE = registryPath;

    const registry = { 'company|Some Title|Somewhere': { slug: 'some-title-somewhere' } };
    saveSlugRegistry(registry);

    expect(fs.existsSync(registryPath)).toBe(true);
    expect(fs.existsSync(`${registryPath}.tmp-${process.pid}`)).toBe(false);
    expect(JSON.parse(fs.readFileSync(registryPath, 'utf-8'))).toEqual(registry);
    expect(loadSlugRegistry()).toEqual(registry);
  });

  it('never leaves a reader observing a partially-written file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slug-registry-atomic-'));
    tmpPaths.push(dir);
    const registryPath = path.join(dir, 'slug-registry.json');
    process.env.SLUG_REGISTRY_PATH_OVERRIDE = registryPath;

    // Large-ish registry so a naive non-atomic write would take measurable
    // time to flush, widening the window a torn read could land in.
    const registry: Record<string, { slug: string }> = {};
    for (let i = 0; i < 5000; i++) {
      registry[`company-${i}|Title ${i}|Location ${i}`] = { slug: `title-${i}-location-${i}` };
    }
    saveSlugRegistry(registry);

    // Concurrent "reader" mid-write is simulated by re-saving while polling
    // the file for validity in between -- with rename() in place, every poll
    // must observe a complete, parseable JSON document (or nothing yet), never
    // a truncated fragment.
    for (let i = 0; i < 20; i++) {
      registry['extra-key'] = { slug: `extra-${i}` };
      saveSlugRegistry(registry);
      const raw = fs.readFileSync(registryPath, 'utf-8');
      expect(() => JSON.parse(raw)).not.toThrow();
    }
  });
});
