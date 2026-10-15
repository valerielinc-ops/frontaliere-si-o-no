import { appendFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

const activePhases = new Set();
let exitHookRegistered = false;

function emitTimingSafely(log, event) {
  try {
    log(`[pipeline-timing] ${JSON.stringify(event)}\n`);
  } catch {
    // Timing is observational: a failing log sink must not change pipeline behavior.
  }
}

function appendSummary(summaryPath, markdown, log) {
  if (!summaryPath) return;
  try {
    appendFileSync(summaryPath, markdown, 'utf8');
  } catch {
    // Timing is observational: an unavailable summary file must not change the
    // result of a build, publish, or bounded network command.
    emitTimingSafely(log, { event: 'summary-write-failed' });
  }
}

function markdownLabel(value) {
  return String(value)
    .replace(/\r?\n/gu, ' ')
    .replace(/\\/gu, '\\\\')
    .replace(/`/gu, '\\`')
    .replace(/\|/gu, '\\|');
}

function finalizeOpenPhases(exitCode) {
  const outcome = exitCode === 0 ? 'interrupted' : 'failure';
  for (const finish of [...activePhases]) finish(outcome);
}

/**
 * Start a monotonic pipeline phase and return an idempotent completion hook.
 * Start/finish events go to stderr as JSON lines; GitHub Actions also receives
 * a readable step-summary entry when GITHUB_STEP_SUMMARY is available.
 *
 * @param {string} pipeline
 * @param {string} phase
 * @param {{ now?: () => number, log?: (line: string) => void, summaryPath?: string }} [options]
 * @returns {(outcome?: 'success' | 'failure' | 'timeout' | 'cancelled' | 'interrupted' | 'skipped') => number}
 */
export function startPipelinePhase(pipeline, phase, {
  now = () => performance.now(),
  log = (line) => process.stderr.write(line),
  summaryPath = process.env.GITHUB_STEP_SUMMARY,
} = {}) {
  const startedAt = now();
  let finished = false;
  const heading = `### Pipeline timing — ${markdownLabel(pipeline)} / ${markdownLabel(phase)}\n\n`;

  emitTimingSafely(log, { pipeline, phase, event: 'start' });
  appendSummary(summaryPath, `${heading}- Started; elapsed time pending.\n\n`, log);

  const finish = (outcome = 'success') => {
    if (finished) return 0;
    finished = true;
    activePhases.delete(finish);
    const durationMs = Math.max(0, Math.round(now() - startedAt));
    emitTimingSafely(log, { pipeline, phase, event: 'finish', duration_ms: durationMs, outcome });
    appendSummary(
      summaryPath,
      `- Finished: \`${markdownLabel(outcome)}\`; duration: **${durationMs} ms**.\n\n`,
      log,
    );
    return durationMs;
  };

  activePhases.add(finish);
  if (!exitHookRegistered) {
    exitHookRegistered = true;
    process.once('exit', finalizeOpenPhases);
  }
  return finish;
}
