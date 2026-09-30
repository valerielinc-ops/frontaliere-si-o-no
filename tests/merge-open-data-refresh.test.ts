import { mergeRefreshContent } from '../scripts/ci/open-data-refresh-merge.mjs';

import { describe, expect, it } from 'vitest';

describe('merge-open-data-refresh', () => {
  it('preserves both runs in append-only history and posted ledgers', () => {
    const baseHistory = '{"run":"base"}\n';
    const remoteHistory = `${baseHistory}{"run":"first"}\n`;
    const refreshHistory = `${baseHistory}{"run":"second"}\n`;
    expect(mergeRefreshContent(
      'data/cf-5xx-history.jsonl',
      baseHistory,
      remoteHistory,
      refreshHistory,
    )).toBe(`${baseHistory}{"run":"first"}\n{"run":"second"}\n`);

    const baseLedger = JSON.stringify({ schemaVersion: 1, posted: [{ id: 'base' }] });
    const remoteLedger = JSON.stringify({ schemaVersion: 1, posted: [{ id: 'base' }, { id: 'first' }] });
    const refreshLedger = JSON.stringify({ schemaVersion: 1, posted: [{ id: 'base' }, { id: 'second' }] });
    const mergedLedger = JSON.parse(
      mergeRefreshContent(
        'data/telegram-posted-jobs.json',
        baseLedger,
        remoteLedger,
        refreshLedger,
      ),
    ) as { posted: Array<{ id: string }> };
    expect(mergedLedger.posted.map((entry) => entry.id)).toEqual(['base', 'first', 'second']);
  });
});
