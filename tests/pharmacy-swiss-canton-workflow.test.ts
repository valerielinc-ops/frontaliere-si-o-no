import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const workflow = readFileSync(new URL('../.github/workflows/sync-pharmacies-border.yml', import.meta.url), 'utf8');
const importer = readFileSync(new URL('../scripts/import-pharmacy-duties-swiss-cantons.mjs', import.meta.url), 'utf8');
const parser = readFileSync(new URL('../scripts/lib/pharmacy-swiss-canton-parser.mjs', import.meta.url), 'utf8');

describe('Swiss canton pharmacy duty release', () => {
  it('runs in the single atomic pharmacy writer and stages the snapshot with its registry', () => {
    const importer = workflow.indexOf('node scripts/import-pharmacy-duties-swiss-cantons.mjs');
    const finalizer = workflow.indexOf('run: npm run pharmacies:import');
    const checker = workflow.indexOf('run: npm run pharmacies:check');
    const publisher = workflow.indexOf('scripts/lib/open-data-refresh-pr.sh');

    expect(importer).toBeGreaterThan(-1);
    expect(workflow).toContain('pull-requests: write');
    expect(workflow).toContain('--path data/pharmacy-duties-swiss-cantons.json');
    expect(workflow).toContain('--path data/pharmacy-sources-registry.json');
    expect(workflow).not.toContain('--regenerate-cmd');
    expect(finalizer).toBeGreaterThan(importer);
    expect(checker).toBeGreaterThan(finalizer);
    expect(publisher).toBeGreaterThan(checker);
  });

  it('fails closed when a Jura source changes or an identity cannot be resolved', () => {
    expect(importer).toContain('failedSnapshot');
    expect(importer).toContain('discoverJuraPdfUrls');
    expect(importer).toContain('if (result.fetchError || Object.values(result.output.snapshots).some((snapshot) => snapshot._releaseReady !== true)) process.exitCode = 1;');
    expect(parser).toContain('parseMoutierCalendar');
    expect(parser).toContain('Moutier calendar is missing');
    expect(parser).toContain('Ajoie pharmacy identity is not allowlisted');
  });

  it('keeps Basel-Stadt on the same atomic snapshot and release path', () => {
    expect(importer).toContain('parseBaselStadtDutyPage');
    expect(importer).toContain('BASEL_STADT_SOURCE_KEY');
    expect(importer).toContain('failedBaselStadtSnapshot');
    expect(parser).toContain('Basel-Stadt page no longer declares year-round opening');
  });

  it('keeps Zürich on the same atomic snapshot and release path', () => {
    expect(importer).toContain('parseZurichDutyPage');
    expect(importer).toContain('ZURICH_SOURCE_KEY');
    expect(importer).toContain('failedZurichSnapshot');
    expect(parser).toContain('Zürich page no longer declares year-round opening');
  });

  it('keeps Solothurn on the same atomic snapshot and release path', () => {
    expect(importer).toContain('parseSolothurnDutyPage');
    expect(importer).toContain('SOLOTHURN_SOURCE_KEY');
    expect(importer).toContain('failedSolothurnSnapshot');
    expect(parser).toContain('Solothurn page no longer declares the three-region Sunday/holiday duty system');
  });
});
