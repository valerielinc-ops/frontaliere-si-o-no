// Pinned shrink acknowledgements (issues #5220 / #5221 / #5222).
//
// The shrink guard in push-section-shard.sh refuses a push that would drop a
// section shard by >50% of its file count. It is self-perpetuating by design:
// the refused push never advances .shard-filecount, so the next deploy re-trips
// on the same numbers. giura fr/en/de sat in exactly that loop while the shard
// kept serving 2056 job pages built on a fabricated locality (PR #5172).
//
// The existing escape hatch, SHARD_SHRINK_GUARD_OVERRIDE_<SECTION>_<LOCALE>=true,
// is unpinned: it keeps the guard off for every later run too. These tests pin
// the ack mechanism to the ONE property that makes it safe — it must stop
// applying the moment the acknowledged push lands — and to the negative cases,
// because a rule that only ever says yes is not a guard.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { checkShrinkAck, DEFAULT_ACKS_PATH } from '../scripts/lib/shrink-ack-check.mjs';
import { buildFailureIssue } from '../scripts/ci/report-shard-push-failure.mjs';

const SHIPPED = JSON.parse(readFileSync(DEFAULT_ACKS_PATH, 'utf8'));
const CLI = resolve('scripts/lib/shrink-ack-check.mjs');

/** Run the CLI; returns the exit code (0 = acknowledged) and its stdout. */
function runCli(args: string[], acksPath = DEFAULT_ACKS_PATH) {
  try {
    const out = execFileSync('node', [CLI, ...args, '--acks', acksPath], { encoding: 'utf8' });
    return { code: 0, out };
  } catch (err: any) {
    return { code: err.status as number, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

describe('checkShrinkAck — the acknowledged transition', () => {
  it('accepts the exact reviewed transition (giura/fr 4948 -> 1259)', () => {
    const r = checkShrinkAck({ section: 'giura', locale: 'fr', prev: 4948, next: 1259, acks: SHIPPED });
    expect(r.acknowledged).toBe(true);
  });

  it('accepts en and de, the same correction on their own baselines', () => {
    expect(checkShrinkAck({ section: 'giura', locale: 'en', prev: 4835, next: 1203, acks: SHIPPED }).acknowledged).toBe(true);
    expect(checkShrinkAck({ section: 'giura', locale: 'de', prev: 4737, next: 1125, acks: SHIPPED }).acknowledged).toBe(true);
  });
});

// If the mechanism were wrong, every one of these would go green — which is the
// whole failure mode being guarded against.
describe('checkShrinkAck — negative controls', () => {
  it('SELF-EXPIRES: once the acknowledged push lands and the baseline moves, it no longer applies', () => {
    // The very next deploy after the ack is consumed: prev is now 1259, not 4948.
    // A collapse from there must be refused even though giura/fr HAS an entry.
    const r = checkShrinkAck({ section: 'giura', locale: 'fr', prev: 1259, next: 40, acks: SHIPPED });
    expect(r.acknowledged).toBe(false);
    expect(r.reason).toMatch(/pinned to from=4948/);
  });

  it('refuses a drop deeper than the one reviewed, on the SAME baseline', () => {
    // prev matches, so the pin alone would wave this through — the floor is what
    // catches a build that emitted almost nothing.
    const r = checkShrinkAck({ section: 'giura', locale: 'fr', prev: 4948, next: 12, acks: SHIPPED });
    expect(r.acknowledged).toBe(false);
    expect(r.reason).toMatch(/below the acknowledged floor/);
  });

  it('refuses a section with no acknowledgement at all', () => {
    expect(checkShrinkAck({ section: 'ticino', locale: 'fr', prev: 353163, next: 10, acks: SHIPPED }).acknowledged).toBe(false);
  });

  it('refuses a locale that was never acknowledged (giura/it published on its own)', () => {
    // giura-it shrank 10249 -> 7065 (-31%), stayed under the threshold and
    // pushed unaided. It must NOT inherit fr/en/de's acknowledgement.
    expect(SHIPPED.giura.it).toBeUndefined();
    expect(checkShrinkAck({ section: 'giura', locale: 'it', prev: 10249, next: 50, acks: SHIPPED }).acknowledged).toBe(false);
  });

  it('refuses non-integer counts rather than coercing them', () => {
    expect(checkShrinkAck({ section: 'giura', locale: 'fr', prev: NaN, next: 1259, acks: SHIPPED }).acknowledged).toBe(false);
    expect(checkShrinkAck({ section: 'giura', locale: 'fr', prev: 4948, next: NaN, acks: SHIPPED }).acknowledged).toBe(false);
  });

  it('refuses an entry missing its floor instead of treating it as unbounded', () => {
    const acks = { s: { l: { from: 100 } } };
    expect(checkShrinkAck({ section: 's', locale: 'l', prev: 100, next: 1, acks }).acknowledged).toBe(false);
  });
});

describe('shrink-ack-check CLI — exit codes are the shell contract', () => {
  it('exits 0 on the acknowledged transition and 1 otherwise', () => {
    expect(runCli(['--section', 'giura', '--locale', 'fr', '--prev', '4948', '--new', '1259']).code).toBe(0);
    expect(runCli(['--section', 'giura', '--locale', 'fr', '--prev', '1259', '--new', '40']).code).toBe(1);
  });

  it('fails CLOSED on an unreadable or malformed acks file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'acks-'));
    const bad = join(dir, 'broken.json');
    writeFileSync(bad, '{ not json');
    expect(runCli(['--section', 'giura', '--locale', 'fr', '--prev', '4948', '--new', '1259'], bad).code).toBe(1);
    expect(runCli(['--section', 'giura', '--locale', 'fr', '--prev', '4948', '--new', '1259'], join(dir, 'absent.json')).code).toBe(1);
  });
});

describe('push-section-shard.sh — wiring', () => {
  const script = readFileSync(resolve('scripts/lib/push-section-shard.sh'), 'utf8');

  it('consults the ack checker inside the shrink branch', () => {
    expect(script).toMatch(/shrink-ack-check\.mjs/);
  });

  it('treats only a zero exit as acknowledgement (fails closed on any error)', () => {
    // `if ack_msg="$(node …)"; then shrink_acked=1; fi` — shrink_acked stays 0
    // on every non-zero exit. A `|| true` here would silently wave through a
    // crashed checker, which is the same class of defect as the guard itself.
    expect(script).toMatch(/shrink_acked=0/);
    expect(script).not.toMatch(/shrink-ack-check\.mjs[^\n]*\|\|\s*true/);
  });

  it('records the real failure cause for the auto-filed issue', () => {
    expect(script).toMatch(/shard-fail-reason-\$section-\$loc/);
  });
});

describe('report-shard-push-failure — the filed issue leads with the measured cause', () => {
  it('puts the recorded cause ABOVE the ranked checklist, not after it', () => {
    const { description } = buildFailureIssue({
      locale: 'fr',
      shards: ['giura'],
      reasons: { giura: 'shrink guard refused: 4948 -> 1259 files (>50%)' },
    });
    const cause = description.indexOf('Causa rilevata');
    const checklist = description.indexOf('Cosa guardare, in ordine');
    const auth = description.indexOf('**Auth**');
    expect(cause).toBeGreaterThan(-1);
    expect(description).toContain('4948 -> 1259');
    // Position is the whole point: #5220 was diagnosed toward deploy keys
    // because the checklist's first item is auth and the real cause was third.
    expect(cause).toBeLessThan(checklist);
    expect(cause).toBeLessThan(auth);
  });

  it('says plainly that a shrink refusal is not an auth failure', () => {
    const { description } = buildFailureIssue({
      locale: 'de',
      shards: ['giura'],
      reasons: { giura: 'shrink guard refused: 4737 -> 1125 files (>50%)' },
    });
    expect(description).toMatch(/non è un guasto di auth/);
  });

  it('omits the block entirely when no cause was recorded (unchanged behaviour)', () => {
    const { description } = buildFailureIssue({ locale: 'en', shards: ['uri'] });
    expect(description).not.toContain('Causa rilevata');
    expect(description).toContain('Cosa guardare, in ordine');
  });

  it('names only the shards whose cause is known', () => {
    const { description } = buildFailureIssue({
      locale: 'fr',
      shards: ['giura', 'uri'],
      reasons: { giura: 'shrink guard refused: 4948 -> 1259 files (>50%)' },
    });
    const block = description.slice(description.indexOf('Causa rilevata'), description.indexOf('### Conseguenza'));
    expect(block).toContain('`giura-fr`');
    expect(block).not.toContain('`uri-fr`');
  });
});

describe('section-shard-shrink-acks.json — every entry is reviewable', () => {
  for (const [section, locales] of Object.entries(SHIPPED)) {
    if (section.startsWith('_')) continue;
    for (const [locale, ack] of Object.entries(locales as Record<string, any>)) {
      it(`${section}/${locale} carries a baseline, a floor, an issue and a reason`, () => {
        expect(Number.isInteger(ack.from)).toBe(true);
        expect(Number.isInteger(ack.min_new)).toBe(true);
        expect(ack.min_new).toBeGreaterThan(0);
        expect(ack.min_new).toBeLessThan(ack.from);
        expect(Number.isInteger(ack.issue)).toBe(true);
        expect(String(ack.reason ?? '').length).toBeGreaterThan(40);
      });
    }
  }
});
