import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DOUBLE_VALIDATED_MIN_ONSITE, DOUBLE_VALIDATED_MIN_JOBS } from '../scripts/lib/profession-taxonomy.mjs';

/**
 * Drift guard for #4564: profession-keyword-opportunities.mjs flags a gap
 * "✅ doppia validazione" once onsite >= DOUBLE_VALIDATED_MIN_ONSITE (10) AND
 * enough matching job ads exist. generate-keyword-pages-config.mjs's
 * profession-gap feed is what actually turns that flag into a live page —
 * it previously re-checked a second, independently-tuned, stricter local
 * floor (`onsiteCount >= 25`) on top of `doubleValidated`, so any gap with
 * onsite in [10, 24] sat in the weekly report forever, correctly flagged
 * "✅" but never promoted to a page. Fixed by trusting `doubleValidated` as
 * the single source of truth (shared constants below) instead of a second
 * copy-pasted threshold that could silently drift stricter again.
 */

const ROOT = resolve(import.meta.dirname, '..');
const OPPORTUNITIES_SRC = readFileSync(resolve(ROOT, 'scripts/profession-keyword-opportunities.mjs'), 'utf-8');
const FEED_SRC = readFileSync(resolve(ROOT, 'scripts/generate-keyword-pages-config.mjs'), 'utf-8');

describe('DOUBLE_VALIDATED thresholds (#4564 drift guard)', () => {
  it('are the expected values (catches an accidental rename/retune of the shared consts)', () => {
    expect(DOUBLE_VALIDATED_MIN_ONSITE).toBe(10);
    expect(DOUBLE_VALIDATED_MIN_JOBS).toBe(3);
  });

  it('profession-keyword-opportunities.mjs imports the shared consts instead of a local literal', () => {
    expect(
      /import\s*\{[^}]*\bDOUBLE_VALIDATED_MIN_ONSITE\b[^}]*\}\s*from\s*'\.\/lib\/profession-taxonomy\.mjs'/.test(OPPORTUNITIES_SRC),
      "profession-keyword-opportunities.mjs must import DOUBLE_VALIDATED_MIN_ONSITE from './lib/profession-taxonomy.mjs'",
    ).toBe(true);
    expect(
      /^\s*const DOUBLE_VALIDATED_MIN_ONSITE\s*=/m.test(OPPORTUNITIES_SRC),
      'profession-keyword-opportunities.mjs must not re-declare DOUBLE_VALIDATED_MIN_ONSITE locally',
    ).toBe(false);
  });

  it('the profession-gap feed trusts doubleValidated without a redundant stricter local onsite floor', () => {
    expect(
      FEED_SRC.includes('if (!o.doubleValidated) continue;'),
      'generate-keyword-pages-config.mjs must gate the profession-gap feed on doubleValidated alone',
    ).toBe(true);
    expect(
      /FEED_MIN_ONSITE/.test(FEED_SRC),
      'generate-keyword-pages-config.mjs must not reintroduce a second, stricter onsite floor (the #4564 dead zone)',
    ).toBe(false);
  });
});
