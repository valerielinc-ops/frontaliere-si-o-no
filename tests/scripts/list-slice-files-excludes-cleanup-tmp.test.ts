// @vitest-environment node
/**
 * cleanup-jobs.mjs writes a transient `<slice>.cleanup-tmp.json` scratch file
 * per crawler and deletes it in a try/finally — but a hard process kill (OOM,
 * SIGKILL) mid-run can skip the finally, leaving it on disk for the rest of
 * that CI job. listSliceFiles() must not treat that orphan as a real slice:
 * run 28783188549 hard-failed the whole translate-pending workflow this way
 * (lidl-svizzera housekeeping died silently; the next "Assemble dataset" step
 * in the same job picked up lidl-svizzera.json.cleanup-tmp.json and refused
 * to parse it as malformed).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { listSliceFiles } from '../../scripts/assemble-jobs-dataset.mjs';

describe('listSliceFiles()', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'slice-files-'));
    writeFileSync(path.join(dir, 'lidl-svizzera.json'), '{"jobs":[]}');
    writeFileSync(path.join(dir, 'lidl-svizzera.json.cleanup-tmp.json'), '[]');
    writeFileSync(path.join(dir, 'some-crawler-locale-cache.json'), '{}');
    writeFileSync(path.join(dir, '.gitkeep'), '');
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('excludes orphaned .cleanup-tmp.json scratch files', () => {
    const files = listSliceFiles(dir).map((f) => path.basename(f));
    expect(files).not.toContain('lidl-svizzera.json.cleanup-tmp.json');
  });

  it('still includes the real slice for the same crawler', () => {
    const files = listSliceFiles(dir).map((f) => path.basename(f));
    expect(files).toContain('lidl-svizzera.json');
  });

  it('still excludes -cache files and .gitkeep', () => {
    const files = listSliceFiles(dir).map((f) => path.basename(f));
    expect(files).not.toContain('some-crawler-locale-cache.json');
    expect(files).not.toContain('.gitkeep');
  });
});
