import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  formatRefundAttemptComment,
  formatRefundComment,
  pickRoundCommentId,
  refundMarkerName,
  roundMarkerRe,
} from '../scripts/ci/refund-fix-round.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('refund-fix-round', () => {
  it('seleziona solo il marker del round richiesto', () => {
    const comments = [
      { id: 1, body: '<!-- REDCHECK_FIX_ROUND: 1 -->' },
      { id: 2, body: '<!-- REDCHECK_FIX_ROUND: 2 -->' },
    ];
    expect(pickRoundCommentId(comments, 'REDCHECK_FIX_ROUND', 2)).toBe(2);
    expect(pickRoundCommentId(comments, 'REDFLAG_FIX_ROUND', 2)).toBeNull();
    expect(roundMarkerRe('REDCHECK_FIX_ROUND', 1).test('<!-- REDCHECK_FIX_ROUND: 12 -->')).toBe(false);
  });

  it('mantiene il beacon nel commento provvisorio senza riarmare il round', () => {
    const body = formatRefundAttemptComment({
      round: 2,
      workflow: 'pr-redcheck-fixer',
      resetsAt: 1788624000,
      rateLimitType: 'five_hour',
      runUrl: '',
    });
    expect(body).toContain('<!-- QUOTA_RESETS_AT: 1788624000 -->');
    expect(body).not.toContain('FIX_REFUNDED');
    expect(body).not.toContain('REDCHECK_FIX_ROUND:');
  });

  it('il commento finale usa l’handle di re-trigger separato', () => {
    const marker = 'REDFLAG_FIX_ROUND';
    const body = formatRefundComment({
      round: 1,
      workflow: 'pr-redflag-fixer',
      resetsAt: null,
      rateLimitType: null,
      runUrl: '',
      marker,
    });
    expect(body).toContain(`<!-- ${refundMarkerName(marker)}: 1 -->`);
    expect(body).not.toContain(`<!-- ${marker}: 1 -->`);
  });

  it('i due fixer continuano a cablare lo script di rimborso', () => {
    for (const file of ['.github/workflows/pr-redcheck-fixer.yml', '.github/workflows/pr-redflag-fixer.yml']) {
      const yaml = fs.readFileSync(path.join(ROOT, file), 'utf8');
      expect(yaml).toContain('node scripts/ci/refund-fix-round.mjs');
    }
  });
});
