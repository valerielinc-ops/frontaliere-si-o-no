/**
 * Run the production Vite build in two short-lived Node processes.
 *
 * The first process owns the SPA/Rollup graph and emits the application
 * assets. The second process owns only the closeBundle SEO emitters and a
 * sentinel Rollup entry. Keeping the process boundary here is intentional:
 * Rollup retains its module graph until bundle.close(), so no in-process GC
 * can make the graph collectible while SSG is still running.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const VITE_BIN = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
const reportBase = path.resolve(process.env.BUILD_MEM_REPORT_FILE || '/tmp/build-memory-peak.json');
// In-memory state does not cross the two Vite processes (#18780 broke the IT SSG that
// way: run 43643571377). Whatever a bundle-stage plugin must hand to the SSG stage goes
// through files in this directory (build-plugins/shared/stageHandoff.ts). It lives
// OUTSIDE dist/, which is published, and is removed when the runner ends.
const HANDOFF_ENV = 'BUILD_STAGE_HANDOFF_DIR';
// The plugin-facing contract of #18828 stays an explicit path; it points INTO the single
// handoff directory, so there is one location and one cleanup (the `finally` below).
const JOB_CANON_HANDOFF_ENV = 'BUILD_JOB_CANON_ORDERING_HANDOFF_PATH';
const JOB_CANON_HANDOFF_FILE = 'job-canon-ordering-fields.json';
const stagedPhase = String(process.env.BUILD_STAGED_PHASE || 'all').trim().toLowerCase();
if (!['all', 'bundle', 'ssg'].includes(stagedPhase)) {
  throw new Error(`[build-staged] BUILD_STAGED_PHASE must be one of all, bundle, ssg; received ${stagedPhase || '<empty>'}`);
}

const configuredHandoffDir = String(process.env[HANDOFF_ENV] || '').trim();
const ownsHandoffDir = !configuredHandoffDir;
const handoffDir = configuredHandoffDir
  ? path.resolve(configuredHandoffDir)
  : fs.mkdtempSync(path.join(os.tmpdir(), 'build-stage-handoff-'));
fs.mkdirSync(handoffDir, { recursive: true });

function cleanupHandoff() {
  try {
    fs.rmSync(handoffDir, { recursive: true, force: true });
  } catch (error) {
    console.warn(`[build-staged] could not remove handoff dir ${handoffDir}: ${error.message}`);
  }
}

const manifestEnabled = ['1', 'true', 'yes'].includes(
  String(process.env.DEPLOY_CONTENT_MANIFEST || '').toLowerCase(),
);

function withSuffix(file, suffix) {
  return file.endsWith('.json')
    ? `${file.slice(0, -'.json'.length)}-${suffix}.json`
    : `${file}-${suffix}`;
}

function stageReportPath(stage) {
  return withSuffix(reportBase, stage);
}

function stageManifestPath(stage) {
  return path.resolve(ROOT, `content-manifest-${stage}.tsv`);
}

function removeGeneratedFile(file) {
  try {
    fs.unlinkSync(file);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn(`[build-staged] could not remove stale generated file ${file}: ${error.message}`);
    }
  }
}

function runStage(stage) {
  const reportPath = stageReportPath(stage);
  const env = {
    ...process.env,
    BUILD_STAGE: stage,
    BUILD_MEM_REPORT_FILE: reportPath,
    [HANDOFF_ENV]: handoffDir,
    [JOB_CANON_HANDOFF_ENV]: path.join(handoffDir, JOB_CANON_HANDOFF_FILE),
  };
  if (manifestEnabled) env.DEPLOY_CONTENT_MANIFEST_PATH = stageManifestPath(stage);

  console.log(`[build-staged] start stage=${stage}`);
  const result = spawnSync(
    process.execPath,
    [VITE_BIN, 'build', '--minify', 'esbuild'],
    { cwd: ROOT, env, stdio: 'inherit' },
  );

  if (result.error) {
    console.error(`[build-staged] ${stage} could not start: ${result.error.message}`);
    return 1;
  }
  if (result.status !== 0) {
    const reason = result.signal ? `signal=${result.signal}` : `exit=${result.status}`;
    console.error(`[build-staged] ${stage} failed (${reason})`);
    return result.status ?? 1;
  }
  console.log(`[build-staged] complete stage=${stage}`);
  return 0;
}

function readReport(file) {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    console.warn(`[build-staged] could not read memory report ${file}: ${error.message}`);
    return null;
  }
}

function minNullable(reports, key) {
  const values = reports
    .map((report) => report[key])
    .filter((value) => typeof value === 'number' && Number.isFinite(value));
  return values.length > 0 ? Math.min(...values) : null;
}

function mergeReports(reports) {
  if (reports.length === 0) return;
  const last = reports[reports.length - 1];
  const merged = {
    ...last,
    peakRssMb: Math.max(...reports.map((report) => Number(report.peakRssMb) || 0)),
    peakAnonMb: Math.max(...reports.map((report) => Number(report.peakAnonMb) || 0)),
    minHostAvailMb: minNullable(reports, 'minHostAvailMb'),
    minHostHeadroomMb: minNullable(reports, 'minHostHeadroomMb'),
    minSwapFreeMb: minNullable(reports, 'minSwapFreeMb'),
    samples: reports.reduce((total, report) => total + (Number(report.samples) || 0), 0),
    breach: reports.find((report) => report.breach)?.breach ?? null,
  };
  const temporary = `${reportBase}.tmp-${process.pid}`;
  try {
    fs.mkdirSync(path.dirname(reportBase), { recursive: true });
    fs.writeFileSync(temporary, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
    fs.renameSync(temporary, reportBase);
  } catch (error) {
    console.warn(`[build-staged] could not merge memory reports: ${error.message}`);
    try { fs.unlinkSync(temporary); } catch { /* best effort */ }
  }
}

async function appendFile(source, target) {
  if (!fs.existsSync(source)) return false;
  await pipeline(
    createReadStream(source),
    createWriteStream(target, { flags: 'a' }),
  );
  return true;
}

async function mergeManifests() {
  if (!manifestEnabled) return;
  const sources = ['bundle', 'ssg'].map(stageManifestPath).filter((file) => fs.existsSync(file));
  if (sources.length === 0) return;

  const temporary = `${path.resolve(ROOT, 'content-manifest.tsv')}.tmp-${process.pid}`;
  try {
    for (const source of sources) await appendFile(source, temporary);
    fs.renameSync(temporary, path.resolve(ROOT, 'content-manifest.tsv'));
    for (const source of sources) {
      try { fs.unlinkSync(source); } catch { /* generated telemetry only */ }
    }
  } catch (error) {
    console.warn(`[build-staged] could not merge content manifests: ${error.message}`);
    try { fs.unlinkSync(temporary); } catch { /* best effort */ }
  }
}

const stages = stagedPhase === 'all' ? ['bundle', 'ssg'] : [stagedPhase];
const stagesToReset = stagedPhase === 'ssg' ? ['ssg'] : ['bundle', 'ssg'];
if (stagedPhase !== 'ssg') removeGeneratedFile(reportBase);
for (const stage of stagesToReset) {
  removeGeneratedFile(stageReportPath(stage));
  if (manifestEnabled) removeGeneratedFile(stageManifestPath(stage));
}
if (manifestEnabled) removeGeneratedFile(path.resolve(ROOT, 'content-manifest.tsv'));

if (stagedPhase === 'ssg') {
  const distDir = path.resolve(ROOT, 'dist');
  if (!configuredHandoffDir) {
    throw new Error(`[build-staged] BUILD_STAGED_PHASE=ssg requires ${HANDOFF_ENV} to carry the bundle handoff`);
  }
  if (!fs.existsSync(path.join(distDir, 'assets'))) {
    throw new Error(`[build-staged] BUILD_STAGED_PHASE=ssg requires the bundle dist at ${distDir}`);
  }
}

const previousReport = stagedPhase === 'ssg' ? readReport(reportBase) : null;

function mergeSelectedReports(selectedStages) {
  const reports = [
    ...(previousReport ? [previousReport] : []),
    ...selectedStages.map(stageReportPath).map(readReport).filter(Boolean),
  ];
  mergeReports(reports);
}

let failedStatus = 0;
try {
  for (let index = 0; index < stages.length; index += 1) {
    const stage = stages[index];
    const status = runStage(stage);
    if (status !== 0) {
      mergeSelectedReports(stages.slice(0, index + 1));
      failedStatus = status;
      break;
    }
  }

  if (failedStatus === 0) {
    mergeSelectedReports(stages);
    await mergeManifests();

    for (const stage of ['bundle', 'ssg']) {
      try { fs.unlinkSync(stageReportPath(stage)); } catch { /* generated telemetry only */ }
    }
  }
} finally {
  if (ownsHandoffDir) cleanupHandoff();
}
if (failedStatus !== 0) process.exit(failedStatus);
