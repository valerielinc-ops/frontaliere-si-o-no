import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  appendDistHistoryRow,
  boundedHistoryText,
  DIST_HISTORY_MAX_BYTES,
} from '../scripts/lib/dist-size-history.mjs';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe('dist-size-history retention', () => {
  it('keeps the newest rows within the byte budget', () => {
    const result = boundedHistoryText(
      `${JSON.stringify({ runId: 'old', payload: 'x'.repeat(40) })}\n`,
      { runId: 'new', payload: 'y'.repeat(40) },
      100,
    );

    expect(result.dropped).toBe(1);
    expect(result.text).toContain('"runId":"new"');
    expect(result.text).not.toContain('"runId":"old"');
    expect(result.bytes).toBeLessThanOrEqual(100);
  });

  it('compacts the real file atomically when an append crosses the budget', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dist-size-history-'));
    tempDirs.push(dir);
    const file = path.join(dir, 'history.jsonl');

    appendDistHistoryRow(file, { runId: 'one', payload: 'a'.repeat(40) }, 100);
    const result = appendDistHistoryRow(file, { runId: 'two', payload: 'b'.repeat(40) }, 100);

    expect(result.dropped).toBe(1);
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('"runId":"two"');
    expect(text).not.toContain('"runId":"one"');
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(100);
  });

  it('keeps a production-sized budget below GitHub’s hard blob limit', () => {
    expect(DIST_HISTORY_MAX_BYTES).toBeLessThan(95 * 1024 * 1024);
  });
});
