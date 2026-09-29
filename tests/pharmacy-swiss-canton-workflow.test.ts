import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const workflow = readFileSync(new URL('../.github/workflows/sync-pharmacies-border.yml', import.meta.url), 'utf8');
const importer = readFileSync(new URL('../scripts/import-pharmacy-duties-swiss-cantons.mjs', import.meta.url), 'utf8');
const parser = readFileSync(new URL('../scripts/lib/pharmacy-swiss-canton-parser.mjs', import.meta.url), 'utf8');

describe('Swiss canton pharmacy duty release', () => {
  it('runs in the single atomic pharmacy writer and stages the snapshot with its registry', () => {
    expect(workflow).toContain('node scripts/import-pharmacy-duties-swiss-cantons.mjs');
    expect(workflow).toContain('data/pharmacy-duties-swiss-cantons.json');
    expect(workflow).toContain('data/pharmacy-sources-registry.json');
    expect(workflow).toMatch(/node scripts\/import-pharmacy-duties-swiss-cantons\.mjs[\s\S]*?--regenerate-cmd[\s\S]*?node scripts\/import-pharmacy-duties-swiss-cantons\.mjs/);
  });

  it('fails closed when a Jura source changes or an identity cannot be resolved', () => {
    expect(importer).toContain('failedSnapshot');
    expect(importer).toContain('discoverJuraPdfUrls');
    expect(importer).toContain('if (result.fetchError || !result.snapshot._releaseReady) process.exitCode = 1;');
    expect(parser).toContain('parseMoutierCalendar');
    expect(parser).toContain('Moutier calendar is missing');
    expect(parser).toContain('Ajoie pharmacy identity is not allowlisted');
  });
});
