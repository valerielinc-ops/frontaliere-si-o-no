import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';
import { describe, expect, it } from 'vitest';
import {
  GROUP_IDS,
  MAX_CYCLE_MANIFEST_BYTES,
  MAX_GROUP_MANIFEST_BYTES,
  createGroupTerminalManifest,
  digestDocument,
  validateCrawlerGenerationRoster,
} from '../scripts/lib/crawler-generation-contract.mjs';
import {
  assertCrawlerLogicParity,
  checkGeneratedArtifacts,
  generate,
  generateCrossRepoExecutionArtifacts,
} from '../scripts/generate-crawler-group-workflows.mjs';

const ROOT = process.cwd();
const WORKFLOWS = path.join(ROOT, '.github/workflows');
const PORTABLE = path.join(ROOT, '.github/corpus-workflows');
const ASSIGNMENTS = path.join(ROOT, 'data/crawler-group-assignments.json');
const ROSTER = path.join(ROOT, 'scripts/ci/crawler-generation-roster.json');
const hash = `sha256:${'0'.repeat(64)}`;

function jobFrom(text: string) {
  return Object.values(YAML.parse(text).jobs)[0] as any;
}

function benchmarkReceipt(crawlerId: string, primarySlice: string) {
  const blobOid = 'c'.repeat(40);
  const payload = {
    schemaVersion: 1,
    crawlerId,
    outcome: 'pushed',
    commit: 'a'.repeat(40),
    remoteBaseCommit: 'b'.repeat(40),
    files: [
      primarySlice,
      `data/jobs-crawler-adapters/adapters/${crawlerId}.json`,
      `data/jobs/expired/by-crawler/${crawlerId}.json`,
      `data/jobs-crawler-summaries/by-crawler/${crawlerId}.json`,
      `data/translation-cache/${crawlerId}.json`,
      'data/jobs-ai-cache.json',
    ].sort().map((filePath) => ({
      path: filePath,
      state: 'present',
      blobOid,
      sha256: /^data\/jobs\/(?:expired\/)?by-crawler\//.test(filePath) ? hash : null,
    })),
  };
  return { ...payload, digest: digestDocument(payload) };
}

describe('crawler generation barrier wiring from the crawler SSOT', () => {
  it('validates the complete receipt roster before replacing any generated workflow', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crawler-generation-render-all-'));
    try {
      const manifestPath = path.join(tmp, 'manifest.json');
      const assignmentsPath = path.join(tmp, 'assignments.json');
      const outDir = path.join(tmp, 'workflows');
      fs.mkdirSync(outDir);
      const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/crawler-manifest.json'), 'utf8'));
      const target = manifest.manifest[0];
      for (const step of [target.runStep, ...target.postSteps]) {
        if (step.env) delete step.env.JOBS_HOUSEKEEPING_SCOPE;
      }
      fs.writeFileSync(manifestPath, JSON.stringify(manifest));
      fs.copyFileSync(ASSIGNMENTS, assignmentsPath);
      const sentinel = path.join(outDir, 'crawler-group-01.yml');
      fs.writeFileSync(sentinel, 'must remain byte-identical\n');

      expect(() => generate({
        manifestPath,
        baselinePath: path.join(ROOT, 'data/crawler-workflow-duration-baseline.json'),
        assignmentsPath,
        outDir,
        crawlerGenerationRosterPath: path.join(tmp, 'roster.json'),
        write: true,
      })).toThrow(/missing crawler generation identity/);
      expect(fs.readFileSync(sentinel, 'utf8')).toBe('must remain byte-identical\n');
      expect(fs.existsSync(path.join(tmp, 'roster.json'))).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('renders all 23 groups before atomically replacing any destination', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crawler-generation-late-render-'));
    try {
      const outDir = path.join(tmp, 'workflows');
      const assignmentsPath = path.join(tmp, 'assignments.json');
      fs.mkdirSync(outDir);
      fs.copyFileSync(ASSIGNMENTS, assignmentsPath);
      const assignmentsBefore = fs.readFileSync(assignmentsPath);
      const first = path.join(outDir, 'crawler-group-01.yml');
      fs.writeFileSync(first, 'must remain byte-identical\n');
      let rendered = 0;
      expect(() => generate({
        outDir,
        assignmentsPath,
        crawlerGenerationRosterPath: path.join(tmp, 'roster.json'),
        profileRenderer: (filePath: string) => {
          rendered += 1;
          if (rendered === 23) throw new Error('late profile render failure');
          return { text: fs.readFileSync(filePath, 'utf8') };
        },
        write: true,
      })).toThrow(/late profile render failure/);
      expect(rendered).toBe(23);
      expect(fs.readFileSync(first, 'utf8')).toBe('must remain byte-identical\n');
      expect(fs.readFileSync(assignmentsPath)).toEqual(assignmentsBefore);
      expect(fs.existsSync(path.join(tmp, 'roster.json'))).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('--check renders all artifacts without partial writes when a late render fails', () => {
    const protectedPaths = [
      ASSIGNMENTS,
      ROSTER,
      path.join(WORKFLOWS, 'crawler-group-01.yml'),
      path.join(WORKFLOWS, 'crawler-group-23-logic.yml'),
      path.join(WORKFLOWS, 'orchestrate-crawlers.yml'),
      path.join(PORTABLE, 'crawler-group-01.yml'),
      path.join(PORTABLE, 'translate-pending.yml'),
      path.join(PORTABLE, 'contract.json'),
    ];
    const before = new Map(protectedPaths.map((filePath) => [filePath, fs.readFileSync(filePath)]));
    let rendered = 0;
    expect(() => checkGeneratedArtifacts({
      profileRenderer: (filePath: string) => {
        rendered += 1;
        if (rendered === 23) throw new Error('injected --check render failure');
        return { text: fs.readFileSync(filePath, 'utf8') };
      },
    })).toThrow(/injected --check render failure/);
    expect(rendered).toBe(23);
    for (const [filePath, bytes] of before) expect(fs.readFileSync(filePath)).toEqual(bytes);
  });

  it('--check rejects bootstrap before it can write assignments', () => {
    const before = fs.readFileSync(ASSIGNMENTS);
    const result = spawnSync(process.execPath, [
      path.join(ROOT, 'scripts/generate-crawler-group-workflows.mjs'),
      '--check',
      '--bootstrap-from-workflows',
    ], { cwd: ROOT, encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/--check cannot be combined/);
    expect(fs.readFileSync(ASSIGNMENTS)).toEqual(before);
  });

  it('derives every registered identity and emits inherited receipt env plus terminal shadow steps for all 23 groups', () => {
    const results: any = generate({ outDir: WORKFLOWS, assignmentsPath: ASSIGNMENTS, write: false });
    const committedRoster = JSON.parse(fs.readFileSync(ROSTER, 'utf8'));
    const assignedCrawlerIds = Object.values(committedRoster.groups).flat() as string[];
    expect(results.generationRoster).toEqual(committedRoster);
    expect(results.generationRoster.crawlerCount).toBe(assignedCrawlerIds.length);
    expect(new Set(assignedCrawlerIds).size).toBe(assignedCrawlerIds.length);
    expect(Object.keys(results.generationRoster.primarySlices).sort()).toEqual(
      [...assignedCrawlerIds].sort(),
    );
    expect(validateCrawlerGenerationRoster(results.generationRoster)).toEqual({ valid: true, errors: [] });

    for (const group of GROUP_IDS) {
      const index = Number(group) - 1;
      const generated = results[index].content;
      const logic = fs.readFileSync(path.join(WORKFLOWS, `crawler-group-${group}-logic.yml`), 'utf8');
      expect(() => assertCrawlerLogicParity(generated, logic, `crawler-group-${group}-logic.yml`)).not.toThrow();

      const job = jobFrom(logic);
      expect(job.env.CRAWLER_GENERATION_TOKEN)
        .toBe('${{ inputs.generation_token }}');
      expect(job.env.CRAWLER_GENERATION_RECEIPT_DIR)
        .toBe('crawler-generation/receipts');
      const background = job.steps.filter((step: any) => step.background === true);
      expect(background).toHaveLength(results.generationRoster.groups[group].length);
      expect(background.every((step: any) =>
        !Object.prototype.hasOwnProperty.call(step.env ?? {}, 'CRAWLER_GENERATION_RECEIPT_DIR'))).toBe(true);
      expect(background.every((step: any) =>
        !Object.prototype.hasOwnProperty.call(step.env ?? {}, 'CRAWLER_GENERATION_TOKEN'))).toBe(true);
      expect(job.steps.at(-4)).toEqual({
        name: 'Wait for all crawlers in this group',
        'wait-all': true,
      });
      expect(job.steps.at(-3)).toEqual({
        name: 'Commit crawler group data atomically',
        if: 'always()',
        run: [
          'set +e',
          `bash scripts/lib/git-commit-data.sh --group-batch "Auto-update crawler group ${group} jobs"`,
          'git_commit_exit=$?',
          'if [ "$git_commit_exit" -eq 42 ]; then',
          '  echo "::warning::group commit: push lost the ref race after all retries (contention) on the final aggregated commit. Cycle lost, self-heals next scheduled run — group not failed (systemic class)."',
          '  echo "⚠️ group commit: push contention loss (exit 42) — crawl data was fine, group not failed" >> "$GITHUB_STEP_SUMMARY"',
          '  exit 0',
          'fi',
          'exit "$git_commit_exit"',
        ].join('\n'),
      });
      expect(job.steps.at(-2).env.CRAWLER_GENERATION_WAIT_OUTCOME).toBe('${{ job.status }}');
      expect(JSON.parse(job.steps.at(-2).env.CRAWLER_GENERATION_EXPECTED_CRAWLERS)).toEqual(
        results.generationRoster.groups[group].map((crawlerId: string) => ({
          crawlerId,
          primarySlice: results.generationRoster.primarySlices[crawlerId],
        })),
      );
      expect(job.steps.at(-1)).toMatchObject({
        uses: 'actions/upload-artifact@v7',
        with: { overwrite: true, 'retention-days': 14 },
      });

      const portableText = fs.readFileSync(path.join(PORTABLE, `crawler-group-${group}.yml`), 'utf8');
      const portable = YAML.parse(portableText);
      expect(portable['run-name']).toBe(`crawler-generation-${'${{ inputs.generation_token }}'}-group-${group}`);
      expect(portable.on.workflow_dispatch.inputs.generation_token)
        .toMatchObject({ required: false, default: '', type: 'string' });
      const portableJob = Object.values(portable.jobs)[0] as any;
      expect(portableJob.env.CRAWLER_GENERATION_TOKEN)
        .toBe('${{ inputs.generation_token }}');
      expect(portableJob.env.CRAWLER_GENERATION_TOKEN)
        .not.toMatch(/\|\||github\.run_id|github\.run_attempt/);
      expect(portableJob.env.CRAWLER_GENERATION_RECEIPT_DIR)
        .toBe('crawler-generation/receipts');
      const portableProducers = portableJob.steps.filter((step: any) =>
        step.background === true || step.name === 'Commit crawler group data atomically');
      expect(portableProducers).toHaveLength(results.generationRoster.groups[group].length + 1);
      expect(portableProducers.every((step: any) =>
        !Object.prototype.hasOwnProperty.call(step.env ?? {}, 'CRAWLER_GENERATION_TOKEN'))).toBe(true);
      expect(portableJob.steps.at(-1).with['retention-days']).toBe(14);
    }
  }, 30_000);

  it('keeps a realistic full-roster receipt cycle below the explicit 1 MiB report cap', () => {
    const roster = JSON.parse(fs.readFileSync(ROSTER, 'utf8'));
    let aggregateBytes = 0;
    let largestBytes = 0;
    let aggregateReceiptBytes = 0;
    for (const group of GROUP_IDS) {
      const receipts = roster.groups[group].map((crawlerId: string) =>
        benchmarkReceipt(crawlerId, roster.primarySlices[crawlerId]));
      const remoteSliceOids = Object.fromEntries(receipts.map((receipt: any) => {
        const primarySlice = receipt.files.find((file: any) => file.path.startsWith('data/jobs/by-crawler/'));
        return [primarySlice.path, primarySlice.blobOid];
      }));
      aggregateReceiptBytes += receipts.reduce((total: number, receipt: unknown) => (
        total + Buffer.byteLength(JSON.stringify(receipt))
      ), 0);
      const manifest = createGroupTerminalManifest({
        group,
        generationToken: '9001-2',
        callerRepository: 'nanakokyobashi-rgb/frontaliere-articles',
        callerRunId: String(Number(group) + 1000),
        callerRunAttempt: 1,
        waitOutcome: 'success',
        checkedAt: '2026-08-31T08:00:00.000Z',
        remoteRepository: 'valerielinc-ops/frontaliere-si-o-no',
        remoteRef: 'refs/heads/main',
        remoteCommit: 'a'.repeat(40),
        expectedCrawlerIds: roster.groups[group],
        expectedPrimarySlices: Object.fromEntries(roster.groups[group].map((crawlerId: string) =>
          [crawlerId, roster.primarySlices[crawlerId]])),
        receipts,
        remoteSliceOids,
      });
      const bytes = Buffer.byteLength(JSON.stringify(manifest));
      expect(manifest.valid).toBe(true);
      aggregateBytes += bytes;
      largestBytes = Math.max(largestBytes, bytes);
    }
    expect(Buffer.byteLength(JSON.stringify(roster))).toBeLessThan(64 * 1024);
    expect(aggregateReceiptBytes).toBeLessThan(MAX_CYCLE_MANIFEST_BYTES);
    expect(largestBytes).toBeLessThan(MAX_GROUP_MANIFEST_BYTES);
    expect((MAX_GROUP_MANIFEST_BYTES + 1) * GROUP_IDS.length).toBeLessThan(MAX_CYCLE_MANIFEST_BYTES);
    expect(aggregateBytes).toBeLessThan(MAX_CYCLE_MANIFEST_BYTES);
  });

  it('regenerates portable groups and contract without modifying translate or the orchestrator', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crawler-generation-transport-'));
    try {
      const results: any = generate({ outDir: WORKFLOWS, assignmentsPath: ASSIGNMENTS, write: false });
      const generated = generateCrossRepoExecutionArtifacts({
        groupResults: results,
        outDir: tmp,
        contractPath: path.join(tmp, 'contract.json'),
      });
      expect(generated.contract.crawlerGeneration).toEqual({
        mode: 'shadow',
        rosterPath: 'scripts/ci/crawler-generation-roster.json',
        rosterDigest: results.generationRoster.digest,
        artifactRetentionDays: 14,
        dispatchesTranslation: false,
      });
      expect(generated.contract.siteRuntimePaths).toEqual(expect.arrayContaining([
        'scripts/crawler-group-generation-finalizer.mjs',
        'scripts/lib/crawler-generation-contract.mjs',
        'scripts/lib/crawler-generation-receipt.mjs',
      ]));
      expect(generated.translateContent)
        .toBe(fs.readFileSync(path.join(PORTABLE, 'translate-pending.yml'), 'utf8'));
      expect(generated.translateContent).not.toContain('crawler-generation');
      const orchestrator = fs.readFileSync(path.join(WORKFLOWS, 'orchestrate-crawlers.yml'), 'utf8');
      expect(orchestrator).not.toContain('crawler_generation_barrier_shadow');
      expect(orchestrator).toContain('gh workflow run translate-pending.yml');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
