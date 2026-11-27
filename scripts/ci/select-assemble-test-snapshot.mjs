// Finds the newest trusted, fresh and compatible assemble test snapshot.
//
// Producers: the hourly seed and the push runs of tests.yml on main. Both
// publish the artifact `assemble-test-snapshot-manifest` after saving the
// snapshot cache. Only node builtins are imported, so the seed guard can load
// this file from a sparse checkout before the full checkout of main.
//
// An artifact is trusted only when all three hold:
//   - its run ran on `main`;
//   - the run's head repository and repository are both this repository (a fork
//     that names a branch `main` fails here);
//   - the run, read from the runs API, has a producer event and workflow path
//     (a pull_request run never qualifies, whatever it uploads).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const MANIFEST_ARTIFACT_NAME = 'assemble-test-snapshot-manifest';
export const MANIFEST_FILE_NAME = 'test-snapshot.json';
export const SNAPSHOT_MAX_AGE_MS = 60 * 60 * 1000;
export const TRUSTED_PRODUCER_EVENTS = Object.freeze(['push', 'schedule', 'workflow_dispatch']);
export const TRUSTED_PRODUCER_WORKFLOWS = Object.freeze([
  '.github/workflows/tests.yml',
  '.github/workflows/hourly-test-assemble-snapshot.yml',
]);
const MAX_PAGES = 5;
const MAX_EXAMINED = 40;
const MAX_MANIFEST_BYTES = 1024 * 1024;

const sameId = (a, b) => a !== undefined && a !== null && b !== undefined && b !== null && String(a) === String(b);

export function isTrustedArtifactShape(artifact, repositoryId) {
  const run = artifact?.workflow_run;
  return Boolean(run
    && run.head_branch === 'main'
    && sameId(run.head_repository_id, run.repository_id)
    && sameId(run.repository_id, repositoryId));
}

export function isTrustedProducerRun(run) {
  if (!run || !TRUSTED_PRODUCER_EVENTS.includes(run.event)) return false;
  const workflowPath = String(run.path || '');
  // The runs API reports `<file>@<ref>`; a longer file name is another workflow.
  return TRUSTED_PRODUCER_WORKFLOWS.some((file) => workflowPath === file || workflowPath.startsWith(`${file}@`));
}

// Newest first. Pages stop once an artifact is older than the cutoff, so a
// flood of untrusted artifacts only costs pages, never hides a fresh one past
// MAX_PAGES * 100 entries of the last window.
export async function listFreshManifestArtifacts({ github, owner, repo, now = Date.now(), maxAgeMs = SNAPSHOT_MAX_AGE_MS }) {
  const fresh = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const { data } = await github.rest.actions.listArtifactsForRepo({
      owner, repo, name: MANIFEST_ARTIFACT_NAME, per_page: 100, page,
    });
    const artifacts = Array.isArray(data?.artifacts) ? data.artifacts : [];
    let reachedCutoff = false;
    for (const artifact of artifacts) {
      const createdAt = Date.parse(artifact?.created_at || '');
      if (!Number.isFinite(createdAt)) continue;
      if (now - createdAt > maxAgeMs) { reachedCutoff = true; continue; }
      if (artifact.expired || createdAt > now + 60 * 1000) continue;
      fresh.push({ artifact, createdAt });
    }
    if (reachedCutoff || artifacts.length < 100) break;
  }
  return fresh.sort((a, b) => b.createdAt - a.createdAt).map(({ artifact }) => artifact);
}

async function readTrustedProducerRun({ github, owner, repo, repositoryId, artifact }) {
  if (!isTrustedArtifactShape(artifact, repositoryId)) return null;
  const { data: run } = await github.rest.actions.getWorkflowRun({
    owner, repo, run_id: artifact.workflow_run.id,
  });
  // The runs API must agree with the artifact listing on where the run lives.
  if (run?.head_branch !== 'main'
    || !sameId(run.head_repository?.id, repositoryId)
    || !isTrustedProducerRun(run)) return null;
  return run;
}

// Throttle and seed guard: the newest trusted producer whose CAPTURE is within
// `withinMs`. The age is measured from the producer run's `created_at`, not
// from the artifact's creation: the artifact appears when the producer ends
// (a seed takes about 17 minutes), and the 60 minute life of a snapshot runs
// from its capture. For a push run `created_at` is the value used as
// sourceCapturedAt; for the seed it is a few seconds before the capture, so it
// is the prudent side. Artifacts are listed over the full 60 minute life so a
// producer that captured long before it published is still seen.
// Returns { artifact, run, producerCreatedAt } (ms) or null. Throws when the
// API cannot be read; callers decide fail-open or fail-closed.
export async function findRecentTrustedManifest({
  github, owner, repo, repositoryId, now = Date.now(), withinMs,
}) {
  const artifacts = await listFreshManifestArtifacts({ github, owner, repo, now });
  let best = null;
  let examined = 0;
  for (const artifact of artifacts) {
    if (examined >= MAX_EXAMINED) break;
    examined += 1;
    const run = await readTrustedProducerRun({ github, owner, repo, repositoryId, artifact });
    if (!run) continue;
    const producerCreatedAt = Date.parse(run.created_at || '');
    if (!Number.isFinite(producerCreatedAt) || producerCreatedAt > now || now - producerCreatedAt > withinMs) continue;
    if (!best || producerCreatedAt > best.producerCreatedAt) best = { artifact, run, producerCreatedAt };
  }
  return best;
}

export function classifySkipReason(reason) {
  const text = String(reason || '');
  if (/older than 60 minutes/u.test(text)) return 'stale';
  if (/compatibility changed|output contract changed|schema is unsupported/u.test(text)) return 'incompatible';
  return 'not-checked';
}

// `validate({ manifestText, runId, runAttempt, now })` returns '' when the
// manifest is usable and the reason otherwise; `download({ artifact })` returns
// the manifest text. Both are injected.
export async function selectAssembleTestSnapshot({
  github, owner, repo, repositoryId, validate, download,
  now = Date.now(), maxAgeMs = SNAPSHOT_MAX_AGE_MS, maxDownloads = 8, log = () => {},
}) {
  const skipped = [];
  let artifacts;
  try {
    artifacts = await listFreshManifestArtifacts({ github, owner, repo, now, maxAgeMs });
  } catch (error) {
    return { selected: null, skipped, reasonClass: 'not-checked', reason: `could not list snapshot artifacts: ${error.message}` };
  }
  let downloads = 0;
  let examined = 0;
  for (const artifact of artifacts) {
    if (downloads >= maxDownloads || examined >= MAX_EXAMINED) break;
    examined += 1;
    const runId = artifact.workflow_run?.id;
    let run;
    try {
      run = await readTrustedProducerRun({ github, owner, repo, repositoryId, artifact });
    } catch (error) {
      skipped.push({ artifactId: artifact.id, runId, reason: `producer run unreadable: ${error.message}`, class: 'not-checked' });
      continue;
    }
    if (!run) {
      skipped.push({ artifactId: artifact.id, runId, reason: 'artifact is not from a trusted producer run', class: 'untrusted' });
      continue;
    }
    downloads += 1;
    let reason;
    let manifestText = '';
    try {
      manifestText = await download({ artifact });
      reason = validate({
        manifestText, runId: String(run.id), runAttempt: String(run.run_attempt), now,
      });
    } catch (error) {
      reason = `candidate unreadable: ${error.message}`;
    }
    if (!reason) {
      log(`Selected snapshot from run ${run.id} (artifact ${artifact.id})`);
      return {
        selected: { runId: String(run.id), runAttempt: String(run.run_attempt), artifactId: artifact.id, manifestText },
        skipped, reasonClass: '', reason: '',
      };
    }
    log(`Skipped run ${run.id}: ${reason}`);
    skipped.push({ artifactId: artifact.id, runId: String(run.id), reason, class: classifySkipReason(reason) });
  }
  // Class of the newest candidate that was actually checked; none = absent.
  const checked = skipped.find((entry) => entry.class !== 'untrusted');
  if (!checked) {
    return {
      selected: null, skipped, reasonClass: 'absent',
      reason: 'no trusted snapshot manifest within the last 60 minutes',
    };
  }
  return {
    selected: null, skipped, reasonClass: checked.class,
    reason: `run ${checked.runId}: ${checked.reason}${skipped.length > 1 ? ` (+${skipped.length - 1} more skipped)` : ''}`,
  };
}

// Reads `test-snapshot.json` from the artifact zip without extracting it to
// disk. unzip -p prints to stdout, and maxBuffer bounds a hostile archive.
export function manifestDownloader({ github, owner, repo }) {
  return async ({ artifact }) => {
    const { data } = await github.rest.actions.downloadArtifact({
      owner, repo, artifact_id: artifact.id, archive_format: 'zip',
    });
    const dir = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'snapshot-artifact-'));
    try {
      const zip = path.join(dir, 'artifact.zip');
      fs.writeFileSync(zip, Buffer.from(data));
      return execFileSync('unzip', ['-p', zip, MANIFEST_FILE_NAME], {
        encoding: 'utf8', maxBuffer: MAX_MANIFEST_BYTES, stdio: ['ignore', 'pipe', 'ignore'],
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

// Validates a candidate manifest with the `node` of the JOB, never with the
// runtime of actions/github-script: the validator compares the manifest's
// nodeMajor with process.versions.node, and github-script runs on its own Node
// (observed: every candidate rejected as "output contract changed" although
// manifest and PR agreed on Node 22). The `cache-key` command is the code the
// restore path already uses; the reason is read back from its `error=` output
// line, so it stays classifiable. `execFile` is injectable for tests.
export function jobNodeValidator({
  cwd, compatibilityFingerprint, execFile = execFileSync, env = process.env, tmpRoot,
}) {
  return ({ manifestText, runId, runAttempt }) => {
    const dir = fs.mkdtempSync(path.join(tmpRoot || env.RUNNER_TEMP || os.tmpdir(), 'snapshot-candidate-'));
    try {
      const manifestFile = path.join(dir, MANIFEST_FILE_NAME);
      const outputFile = path.join(dir, 'github-output');
      fs.writeFileSync(manifestFile, manifestText);
      fs.writeFileSync(outputFile, '');
      try {
        execFile('node', ['scripts/ci/assemble-test-snapshot.mjs', 'cache-key'], {
          cwd,
          env: {
            ...env,
            ASSEMBLE_TEST_SNAPSHOT_METADATA_FILE: manifestFile,
            ASSEMBLE_TEST_SNAPSHOT_RUN_ID: String(runId),
            ASSEMBLE_TEST_SNAPSHOT_RUN_ATTEMPT: String(runAttempt),
            ASSEMBLE_TEST_SNAPSHOT_COMPATIBILITY_FINGERPRINT: compatibilityFingerprint,
            GITHUB_OUTPUT: outputFile,
          },
          stdio: ['ignore', 'ignore', 'ignore'],
          timeout: 120_000,
        });
        return '';
      } catch (error) {
        const line = fs.readFileSync(outputFile, 'utf8').split('\n').find((entry) => entry.startsWith('error='));
        return line ? line.slice('error='.length) : `validator failed: ${error.message}`;
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}
