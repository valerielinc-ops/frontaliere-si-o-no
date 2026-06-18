import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { jobCanonRedirectMapPlugin } from '../build-plugins/jobCanonRedirectMapPlugin';

/**
 * The plugin emits dist/job-canon/<shard>.json (slug → {locale: section prefix})
 * from data/all-known-job-slugs.json, so public/404.html / the Worker can redirect
 * a canton-drift orphan (same slug, wrong/old canton section) to the slug's
 * current canonical page at request time. Invariants:
 *   - the slug is keyed under the 2-char shard of its localized last segment,
 *   - the value is a PER-LOCALE object of canonical section prefixes (URL minus the
 *     slug segment) — NOT collapsed to one locale, since the slug is identical
 *     across locales and a flat value would 301 en/de/fr orphans to the IT page,
 *   - the same slug under a DIFFERENT requested canton rebuilds to the canonical.
 */
describe('jobCanonRedirectMapPlugin', () => {
  let tmp: string;

  const tracking = {
    'capo-ottimizzazione-portafoglio-ffs-zollikofen': {
      it: '/cerca-lavoro-berna/capo-ottimizzazione-portafoglio-ffs-zollikofen',
      de: '/de/jobs-in-bern/capo-ottimizzazione-portafoglio-ffs-zollikofen',
    },
    'data-engineer-acme-lugano': {
      it: '/cerca-lavoro-ticino/data-engineer-acme-lugano',
    },
  };

  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'job-canon-'));
    fs.mkdirSync(path.join(tmp, 'data'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'data', 'all-known-job-slugs.json'), JSON.stringify(tracking));
    const plugin = jobCanonRedirectMapPlugin(tmp);
    (plugin.closeBundle as () => void).call(plugin);
  });

  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const readShard = (slug: string): Record<string, Record<string, string>> => {
    const sk = slug.slice(0, 2).toLowerCase().replace(/[^a-z0-9]/g, '_');
    return JSON.parse(fs.readFileSync(path.join(tmp, 'dist', 'job-canon', `${sk}.json`), 'utf-8'));
  };

  it('maps the IT localized slug to its canonical section prefix', () => {
    const shard = readShard('capo-ottimizzazione-portafoglio-ffs-zollikofen');
    expect(shard['capo-ottimizzazione-portafoglio-ffs-zollikofen'].it).toBe('/cerca-lavoro-berna');
  });

  it('keeps the DE prefix under its own locale (no cross-locale collapse to IT)', () => {
    // it + de share the same last segment; the per-locale object preserves BOTH,
    // so a /de orphan never 301s to the IT page (the bug this map shape prevents).
    const shard = readShard('capo-ottimizzazione-portafoglio-ffs-zollikofen');
    const entry = shard['capo-ottimizzazione-portafoglio-ffs-zollikofen'];
    expect(entry.it).toBe('/cerca-lavoro-berna');
    expect(entry.de).toBe('/de/jobs-in-bern');
  });

  it('rebuilds a canton-orphan request to the canonical page per locale (consumer logic)', () => {
    // Request the same slug under the WRONG canton — the consumer rebuilds the URL
    // using the prefix for the REQUEST's own locale.
    const shard = readShard('capo-ottimizzazione-portafoglio-ffs-zollikofen');
    const slug = 'capo-ottimizzazione-portafoglio-ffs-zollikofen';
    const itCanon = `${shard[slug].it}/${slug}/`;
    expect(itCanon).toBe('/cerca-lavoro-berna/capo-ottimizzazione-portafoglio-ffs-zollikofen/');
    expect(itCanon).not.toBe('/cerca-lavoro-ticino/capo-ottimizzazione-portafoglio-ffs-zollikofen/');
    const deCanon = `${shard[slug].de}/${slug}/`;
    // A /de orphan must resolve to the DE page, never the IT one.
    expect(deCanon).toBe('/de/jobs-in-bern/capo-ottimizzazione-portafoglio-ffs-zollikofen/');
    expect(deCanon).not.toBe(itCanon);
  });
});
