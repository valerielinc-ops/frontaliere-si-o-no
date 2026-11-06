import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const { readJsonFileMock } = vi.hoisted(() => ({ readJsonFileMock: vi.fn() }));

vi.mock('../scripts/lib/read-large-json.mjs', () => ({ readJsonFile: readJsonFileMock }));

import { runTranslationObservabilityCollector } from '../scripts/collect-translation-observability.mjs';

describe('translation observability jobs reader', () => {
  it('routes only jobs through the large-file reader and preserves auxiliary JSON validation', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'translation-observability-reader-'));
    const jobsPath = path.join(directory, 'jobs.json');
    const beforePath = path.join(directory, 'before.json');
    const outputPath = path.join(directory, 'report.json');

    try {
      fs.writeFileSync(jobsPath, '[]');
      readJsonFileMock.mockImplementation((file: string) => JSON.parse(fs.readFileSync(file, 'utf8')));

      runTranslationObservabilityCollector([
        '--mode', 'start', '--jobs', jobsPath, '--output', beforePath,
        '--now', '2026-11-06T00:00:00.000Z',
      ]);
      runTranslationObservabilityCollector([
        '--mode', 'finish', '--jobs', jobsPath, '--before', beforePath, '--output', outputPath,
        '--run-id', '1314', '--started-at', '2026-11-06T00:00:00.000Z',
        '--finished-at', '2026-11-06T00:01:00.000Z', '--source-commit', 'abc',
        '--outcome', 'success', '--advance-state', 'false',
      ]);

      expect(readJsonFileMock.mock.calls).toEqual([[jobsPath], [jobsPath]]);

      fs.writeFileSync(beforePath, '{');
      readJsonFileMock.mockClear();
      expect(() => runTranslationObservabilityCollector([
        '--mode', 'finish', '--jobs', jobsPath, '--before', beforePath, '--output', outputPath,
      ])).toThrow(SyntaxError);
      expect(readJsonFileMock).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
