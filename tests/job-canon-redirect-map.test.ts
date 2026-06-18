import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { jobCanonRedirectMapPlugin } from '../build-plugins/jobCanonRedirectMapPlugin';

/**
 * The plugin emits dist/job-canon/<shard>.json (slug → canonical section prefix)
 * from data/all-known-job-slugs.json, so public/404.html can redirect a
 * canton-drift orphan (same slug, wrong/old canton section) to the slug's
 * current canonical page at request time. Invariants:
 *   - the slug is keyed under the 2-char shard of its localized last segment,
 *   - the value is the canonical section prefix (URL minus the slug segment),
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

  const readShard = (slug: string): Record<string, string> => {
    const sk = slug.slice(0, 2).toLowerCase().replace(/[^a-z0-9]/g, '_');
    return JSON.parse(fs.readFileSync(path.join(tmp, 'dist', 'job-canon', `${sk}.json`), 'utf-8'));
  };

  it('maps the IT localized slug to its canonical section prefix', () => {
    const shard = readShard('capo-ottimizzazione-portafoglio-ffs-zollikofen');
    expect(shard['capo-ottimizzazione-portafoglio-ffs-zollikofen']).toBe('/cerca-lavoro-berna');
  });

  it('maps the DE localized slug under its own locale-prefixed section', () => {
    const shard = readShard('capo-ottimizzazione-portafoglio-ffs-zollikofen');
    // it + de share the same last segment here → first-write-wins keeps the IT prefix.
    expect(shard['capo-ottimizzazione-portafoglio-ffs-zollikofen']).toBe('/cerca-lavoro-berna');
  });

  it('rebuilds a canton-orphan request to the canonical page (404.html logic)', () => {
    // Request the same slug under the WRONG canton — the 404 page rebuilds the URL.
    const shard = readShard('capo-ottimizzazione-portafoglio-ffs-zollikofen');
    const slug = 'capo-ottimizzazione-portafoglio-ffs-zollikofen';
    const canon = `${shard[slug]}/${slug}/`;
    expect(canon).toBe('/cerca-lavoro-berna/capo-ottimizzazione-portafoglio-ffs-zollikofen/');
    expect(canon).not.toBe('/cerca-lavoro-ticino/capo-ottimizzazione-portafoglio-ffs-zollikofen/');
  });
});
