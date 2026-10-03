import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildL2DemandExport,
  main,
  SUMMARY_CANDIDATE_LIMIT,
} from '../scripts/ci/export-l2-demand-outcomes.mjs';
import { validateDemandSnapshot } from '../scripts/ci/loop-l2-demand-utility.mjs';

// The CLI output is tee'd into the job log and into GITHUB_STEP_SUMMARY, whose
// upload aborts above 1 MiB. The full snapshot belongs in --out (uploaded as
// an artifact), never on stdout.
const STDOUT_BYTE_CEILING = 64 * 1024;
const FIXTURE_CLUSTERS = 3_000;
const NOW = new Date('2026-09-12T12:00:00.000Z');

function largeSnapshot() {
  return {
    generatedAt: NOW.toISOString(),
    _meta: { generatedAt: NOW.toISOString(), source: 'fixture' },
    clusters: Array.from({ length: FIXTURE_CLUSTERS }, (_, index) => ({
      clusterId: `it-query-${index}`,
      locale: 'it',
      canonicalQuery: `query numero ${index} lavoro ticino`,
      canonicalSlug: `query-numero-${index}-lavoro-ticino`,
      queries: [`query numero ${index} lavoro ticino`, `query ${index} ticino`],
      totalImpressions: 10 + index,
      totalClicks: index % 10,
    })),
  };
}

const fakeClient = { accessToken: async () => 'test-token' };

async function fakeGa4Runner({ body }: { body: any }) {
  return body.dimensionFilter
    ? { rows: [{ dimensionValues: [{ value: '/ricerca/query-numero-1-lavoro-ticino/' }], metricValues: [{ value: '3' }] }] }
    : { rows: [
      { dimensionValues: [{ value: '/ricerca/query-numero-1-lavoro-ticino/' }], metricValues: [{ value: '40' }] },
      { dimensionValues: [{ value: '/ricerca/query-numero-2-lavoro-ticino/' }], metricValues: [{ value: '2' }] },
    ] };
}

async function runCli(argvExtra: string[] = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-l2-output-'));
  const inputPath = path.join(dir, 'gsc.json');
  const outputPath = path.join(dir, 'demand-outcomes.json');
  const source = largeSnapshot();
  fs.writeFileSync(inputPath, `${JSON.stringify(source)}\n`);
  const lines: string[] = [];
  const logger = { log: (...args: unknown[]) => lines.push(args.map(String).join(' ')) };
  const output = await main({
    argv: ['--json', '--input', inputPath, '--days', '8', '--out', outputPath, ...argvExtra],
    logger: logger as any,
    now: NOW,
    client: fakeClient as any,
    ga4Runner: fakeGa4Runner as any,
  });
  const stdout = `${lines.join('\n')}\n`;
  return { source, output, outputPath, stdout };
}

describe('L2 export CLI output budget', () => {
  it('prints only a bounded summary with counts, window and join quality', async () => {
    const { source, stdout, outputPath } = await runCli();
    expect(Buffer.byteLength(stdout, 'utf8')).toBeLessThan(STDOUT_BYTE_CEILING);
    const summary = JSON.parse(stdout);
    expect(summary).toMatchObject({
      loopId: 'L2',
      outputPath,
      outcomes: { eligibleLandingSessions: 42, usefulActions: 3 },
      outcomeJoin: 'joined',
      independent: true,
      clusters: source.clusters.length,
    });
    expect(summary.telemetryWindow).toMatchObject({ lagDays: 2 });
    expect(summary).not.toHaveProperty('output');
    expect(summary.topCandidates.length).toBeLessThanOrEqual(SUMMARY_CANDIDATE_LIMIT);
    expect(summary.topCandidates.length).toBeGreaterThan(0);
    const impressions = summary.topCandidates.map((candidate: any) => candidate.totalImpressions);
    expect(impressions).toEqual([...impressions].sort((a, b) => b - a));
    expect(impressions[0]).toBe(Math.max(...source.clusters.map((cluster) => cluster.totalImpressions)));
  });

  it('keeps every cluster in the snapshot file', async () => {
    const { source, output, outputPath } = await runCli();
    const written = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    expect(written.clusters).toHaveLength(source.clusters.length);
    expect(written.clusters).toEqual(source.clusters);
    expect(written).toEqual(JSON.parse(JSON.stringify(output)));
  });

  it('leaves the snapshot contract and the L2 verdict unchanged', async () => {
    const { source, outputPath } = await runCli();
    const written = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    const expected = buildL2DemandExport(source, {
      eligibleLandingSessions: 42,
      usefulActions: 3,
      generatedAt: NOW.toISOString(),
      telemetryWindow: written.telemetryWindow,
    });
    expect(written).toEqual(JSON.parse(JSON.stringify(expected)));
    const verdictOptions = { now: NOW, sourcePath: outputPath };
    expect(validateDemandSnapshot(written, verdictOptions))
      .toEqual(validateDemandSnapshot(expected, verdictOptions));
  });

  it('summarizes an explicitly unavailable export without the snapshot', async () => {
    const { stdout, outputPath } = await runCli(['--unavailable', '--reason', 'credentials unavailable']);
    expect(Buffer.byteLength(stdout, 'utf8')).toBeLessThan(STDOUT_BYTE_CEILING);
    const summary = JSON.parse(stdout);
    expect(summary).toMatchObject({
      loopId: 'L2',
      outputPath,
      outcomeJoin: 'unavailable',
      independent: false,
      unavailableReason: 'credentials unavailable',
    });
    expect(JSON.parse(fs.readFileSync(outputPath, 'utf8'))._meta.independent).toBe(false);
  });
});
