import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const LOCALES = ['it', 'en', 'de', 'fr'];

/** Check paginated results from this workflow run's artifact endpoint. */
export function inspectHreflangManifestArtifacts(pages, runId, runAttempt) {
  if (!/^[1-9]\d*$/.test(String(runId)) || !/^[1-9]\d*$/.test(String(runAttempt))) {
    throw new Error('positive workflow run ID and attempt are required');
  }
  if (!Array.isArray(pages) || pages.length === 0) throw new Error('artifact pages are missing');

  const expected = LOCALES.map(locale => `hreflang-index-manifest-${locale}-${runId}-${runAttempt}`);
  const found = new Map();
  for (const page of pages) {
    if (!Array.isArray(page?.artifacts)) throw new Error('invalid artifact page');
    for (const artifact of page.artifacts) {
      if (!expected.includes(artifact?.name)) continue;
      if (!Number.isSafeInteger(artifact.id) || artifact.id <= 0 || typeof artifact.expired !== 'boolean') {
        throw new Error('invalid same-run artifact metadata');
      }
      // The request is run-scoped; reject contradictory context when supplied.
      if (artifact.workflow_run != null && String(artifact.workflow_run.id) !== String(runId)) {
        throw new Error('foreign workflow run in artifact response');
      }
      const previous = found.get(artifact.name);
      if (previous && (previous.id !== artifact.id || previous.expired !== artifact.expired)) {
        throw new Error('ambiguous same-run artifact metadata');
      }
      found.set(artifact.name, artifact);
    }
  }
  const missing = expected.filter(name => !found.has(name) || found.get(name).expired);
  return { complete: missing.length === 0, missing };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [file, runId, runAttempt] = process.argv.slice(2);
    const result = inspectHreflangManifestArtifacts(JSON.parse(readFileSync(file, 'utf8')), runId, runAttempt);
    if (!result.complete) console.log(`Waiting for artifact(s): ${result.missing.join(', ')}`);
    process.exitCode = result.complete ? 0 : 1;
  } catch (error) {
    console.error(`::error::cannot verify same-run hreflang artifacts: ${error.message}`);
    process.exitCode = 2;
  }
}
