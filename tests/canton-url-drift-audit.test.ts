/**
 * Unit cover for scripts/audit-canton-url-drift.mjs — the monitor that reports
 * whether job URLs are still changing canton section (#6318 fixed the cause;
 * this watches the flow).
 *
 * Pure functions only: no store, no git, no dataset. The measurement itself is
 * exercised against production data by the weekly workflow — what these tests
 * pin is the arithmetic and the classification, which is where a silent wrong
 * answer would hide. A monitor that reports a comfortable number for the wrong
 * reason is worse than no monitor.
 */
import { describe, expect, it } from 'vitest';
import {
  italianPath,
  sectionOf,
  pickShards,
  oracleCantonFromSlug,
  classifyDirection,
  buildSectionToCanton,
  diffShard,
  evaluateDriftAlert,
  readDriftSeries,
  buildAlertBody,
  // @ts-expect-error — plain .mjs script, no type declarations
} from '../scripts/audit-canton-url-drift.mjs';

describe('italianPath — the store has carried two entry shapes', () => {
  it('reads a per-locale object', () => {
    expect(italianPath({ it: '/cerca-lavoro-berna/x', de: '/de/jobs-in-bern/x' })).toBe('/cerca-lavoro-berna/x');
  });
  it('reads a bare string', () => {
    expect(italianPath('/cerca-lavoro-berna/x')).toBe('/cerca-lavoro-berna/x');
  });
  it('returns empty for anything else, so it is skipped rather than counted', () => {
    expect(italianPath(undefined)).toBe('');
    expect(italianPath({ de: '/de/jobs-in-bern/x' })).toBe('');
  });
});

describe('sectionOf', () => {
  it('takes the canton section off a job path', () => {
    expect(sectionOf('/cerca-lavoro-lucerna/metzger-in-coop-schenkon-luzern-6o32er')).toBe('cerca-lavoro-lucerna');
  });
  it('is indifferent to the trailing slash', () => {
    expect(sectionOf('/cerca-lavoro-ticino/x/')).toBe('cerca-lavoro-ticino');
  });
  it('refuses a path with no slug segment — a one-segment entry is not a job URL', () => {
    expect(sectionOf('/cerca-lavoro-ticino')).toBe('');
    expect(sectionOf('')).toBe('');
  });
});

describe('pickShards — the sample must be the same population week over week', () => {
  it('is deterministic', () => {
    expect(pickShards(5, 32)).toEqual(pickShards(5, 32));
  });
  it('spreads across the store instead of clustering at the start', () => {
    // Indices, not filenames: naming the shard file is the producer's job
    // (scripts/lib/all-known-job-slugs-store.mjs), so the layout can change
    // without this reader going quietly empty.
    expect(pickShards(5, 32)).toEqual([0, 6, 12, 19, 25]);
  });
  it('never asks for more shards than exist, nor fewer than one', () => {
    expect(pickShards(99, 4)).toHaveLength(4);
    expect(pickShards(0, 32)).toHaveLength(1);
  });
});

describe('oracleCantonFromSlug — the municipality in the slug is the independent check', () => {
  // A stub, so the test does not depend on the live municipality DB growing.
  const infer = (t: string) => {
    const db: Record<string, string> = {
      richterswil: 'ZH', schenkon: 'LU', 'sankt gallen': 'SG', gallen: 'XX', basel: 'BS',
    };
    return db[t.toLowerCase()] ?? null;
  };

  it('finds the municipality at the end of the slug', () => {
    expect(oracleCantonFromSlug('vendita-prodotti-freschi-coop-genossenschaft-richterswil', infer)).toBe('ZH');
  });

  it('prefers the longer name, so a word inside it cannot win', () => {
    // 'gallen' alone resolves to a decoy here: only right-to-left 3-token-first
    // scanning returns SG.
    expect(oracleCantonFromSlug('chauffeur-fust-oberburen-sankt-gallen', infer)).toBe('SG');
  });

  it('prefers the RIGHTMOST municipality when the slug names two', () => {
    // Employer city then posting city: the posting's is last and is the one the
    // URL section should follow.
    expect(oracleCantonFromSlug('verkaufer-coop-basel-schenkon', infer)).toBe('LU');
  });

  it('returns empty when nothing in the slug is a municipality', () => {
    expect(oracleCantonFromSlug('projektmanager-roche-budapest', infer)).toBe('');
  });

  it('survives an inference that throws', () => {
    expect(oracleCantonFromSlug('anything-here', () => { throw new Error('db down'); })).toBe('');
  });
});

describe('classifyDirection — a rate alone cannot tell churn from convergence', () => {
  it('towards: the move lands on the slug municipality canton', () => {
    expect(classifyDirection('LU', 'ZH', 'LU')).toBe('towards');
  });
  it('away: the move leaves it', () => {
    expect(classifyDirection('ZH', 'ZH', 'AG')).toBe('away');
  });
  it('lateral: neither side agrees with the oracle', () => {
    expect(classifyDirection('GR', 'ZH', 'AG')).toBe('lateral');
  });
  it('lateral is not silently counted as an improvement', () => {
    expect(classifyDirection('GR', 'ZH', 'AG')).not.toBe('towards');
  });
  it('unresolved when there is no oracle or an unknown section', () => {
    expect(classifyDirection('', 'ZH', 'AG')).toBe('unresolved');
    expect(classifyDirection('ZH', undefined as unknown as string, 'AG')).toBe('unresolved');
  });
});

describe('buildSectionToCanton', () => {
  it('maps the Italian section back to the canton code', () => {
    const m = buildSectionToCanton({ cantons: { LU: { it: 'lucerna' }, ZH: { it: 'zurigo' } } });
    expect(m['cerca-lavoro-lucerna']).toBe('LU');
    expect(m['cerca-lavoro-zurigo']).toBe('ZH');
  });
  it('accepts a registry with no `cantons` wrapper', () => {
    expect(buildSectionToCanton({ TI: { it: 'ticino' } })['cerca-lavoro-ticino']).toBe('TI');
  });
});

describe('diffShard — only slugs present in BOTH builds are drift candidates', () => {
  const wrap = (m: Record<string, string>) =>
    Object.fromEntries(Object.entries(m).map(([k, v]) => [k, { it: v }]));

  it('counts a section change', () => {
    const r = diffShard(wrap({ a: '/cerca-lavoro-zurigo/a' }), wrap({ a: '/cerca-lavoro-lucerna/a' }));
    expect(r.common).toBe(1);
    expect(r.drifted).toEqual([{ slug: 'a', from: 'cerca-lavoro-zurigo', to: 'cerca-lavoro-lucerna' }]);
  });

  it('does NOT count a slug that is new — a new URL was never indexed elsewhere', () => {
    const r = diffShard(wrap({}), wrap({ b: '/cerca-lavoro-ticino/b' }));
    expect(r.common).toBe(0);
    expect(r.drifted).toHaveLength(0);
  });

  it('ignores a slug that vanished from the new build', () => {
    const r = diffShard(wrap({ c: '/cerca-lavoro-ticino/c' }), wrap({}));
    expect(r.common).toBe(0);
  });

  it('does not read a trailing-slash change as a section change', () => {
    const r = diffShard(wrap({ d: '/cerca-lavoro-ticino/d' }), wrap({ d: '/cerca-lavoro-ticino/d/' }));
    expect(r.common).toBe(1);
    expect(r.drifted).toHaveLength(0);
  });

  it('skips an entry whose path cannot be read instead of scoring it against ""', () => {
    const r = diffShard(wrap({ e: '/cerca-lavoro-ticino/e' }), { e: { de: '/de/jobs-im-tessin/e' } } as never);
    expect(r.common).toBe(1);
    expect(r.drifted).toHaveLength(0);
  });
});

/**
 * The alert is the only thing that reaches a human without them going to look,
 * so both of its failure modes are expensive: staying silent while the drift is
 * back, and crying wolf until it gets ignored (alert-pat-down.mjs, #5432).
 */
describe('evaluateDriftAlert — threshold relative to the recorded baseline', () => {
  const row = (rate: number, date = '2026-01-01') => ({ rate, date });

  it('stays silent with no history to compare against', () => {
    expect(evaluateDriftAlert([]).alert).toBe(false);
    expect(evaluateDriftAlert([row(0.0079)]).alert).toBe(false);
  });

  it('does not fire on the baseline row itself, which is over its own line by construction', () => {
    // baseline 0,79% → threshold 0,395%; the second row is still high because
    // its window straddles the fix. One point is not a trend.
    const v = evaluateDriftAlert([row(0.0079), row(0.0075)]);
    expect(v.alert).toBe(false);
    expect(v.threshold).toBeCloseTo(0.00395, 5);
  });

  it('fires when two consecutive runs stay above half the baseline', () => {
    const v = evaluateDriftAlert([row(0.0079), row(0.0075), row(0.0071)]);
    expect(v.alert).toBe(true);
    expect(v.reason).toMatch(/due run consecutivi/);
  });

  it('waits for confirmation when only the latest run is above', () => {
    // A single spike must not open an issue: that is the cries-wolf failure.
    const v = evaluateDriftAlert([row(0.0079), row(0.001), row(0.0071)]);
    expect(v.alert).toBe(false);
    expect(v.reason).toMatch(/si attende conferma/);
  });

  it('stays silent once the rate is down, which is the expected steady state', () => {
    const v = evaluateDriftAlert([row(0.0079), row(0.0012), row(0.0009)]);
    expect(v.alert).toBe(false);
    expect(v.reason).toMatch(/sotto soglia/);
  });

  it('re-fires after a regression that is confirmed', () => {
    const v = evaluateDriftAlert([row(0.0079), row(0.0009), row(0.006), row(0.0065)]);
    expect(v.alert).toBe(true);
  });

  it('does not fire on a regression seen only once', () => {
    expect(evaluateDriftAlert([row(0.0079), row(0.0009), row(0.0008), row(0.0065)]).alert).toBe(false);
  });

  it('refuses to build a threshold from an unusable baseline', () => {
    expect(evaluateDriftAlert([row(0), row(0.01), row(0.01)])).toMatchObject({ alert: false, baseline: null });
  });
});

describe('readDriftSeries', () => {
  it('reads one JSON object per line, oldest first', () => {
    const s = readDriftSeries('{"date":"a","rate":0.008}\n{"date":"b","rate":0.004}\n');
    expect(s.map((r: { date: string }) => r.date)).toEqual(['a', 'b']);
  });
  it('skips a corrupt line instead of throwing — a truncated append must not blind the monitor', () => {
    expect(readDriftSeries('{"date":"a","rate":0.008}\n{oops\n')).toHaveLength(1);
  });
  it('skips a row with no usable rate', () => {
    expect(readDriftSeries('{"date":"a"}\n{"date":"b","rate":"x"}\n')).toHaveLength(0);
  });
  it('is an empty series for empty or missing input', () => {
    expect(readDriftSeries('')).toEqual([]);
    expect(readDriftSeries(undefined as unknown as string)).toEqual([]);
  });
});

/**
 * The issue body is consumed by the autonomous loop, so its structure is a
 * contract, not prose: bl-planner's 5 fields plus the command that reproduces
 * the number. A body that loses a field sends a planner off to rediscover it.
 */
describe('buildAlertBody — a scheda the loop can act on', () => {
  const record = {
    date: '2026-09-14', base: 'abc12345678', days: 7, shards: [0, 6, 12, 19, 25],
    common: 44634, drifted: 351, rate: 0.0079, totalSlugs: 304263,
    projectedUrlsPerWindow: 9571,
    direction: { towards: 101, away: 118, lateral: 74, unresolved: 58 },
  };
  const verdict = { reason: 'due run consecutivi sopra la soglia', baseline: 0.0079, threshold: 0.00395 };
  const body = buildAlertBody(record, verdict, '2026-09-07 0.80% → 2026-09-14 0.79%');

  it('carries all five scheda fields', () => {
    for (const f of ['1-CAUSA', '2-FIX', '3-METRICA', '4-OSSERVATORE', '5-FALLIMENTO']) {
      expect(body).toContain(f);
    }
  });

  it('gives the exact reproduction command, with the shard count actually used', () => {
    expect(body).toContain('--days 7 --shards 5 --no-history');
  });

  it('frames the cause as a hypothesis and ships the command that kills it', () => {
    // A cause stated as settled is worse than none: #6318 closed one path, and a
    // later return may well come from somewhere else.
    expect(body).toMatch(/ipotesi/i);
    expect(body).toContain('crawlerHasSpoken');
    expect(body).toContain('tests/canton-pin-crawler-authority.test.ts');
  });

  it('names the two upstream sources to check once that cause is excluded', () => {
    expect(body).toMatch(/per SLUG, non per `id`/);
    expect(body).toMatch(/location/);
  });

  it('states the repo and the mirror mode, so the fix does not land in the wrong repo', () => {
    expect(body).toContain('REPO**: sito');
    expect(body).toContain('non nel manifest');
  });

  it('carries the measurement and the threshold it failed', () => {
    expect(body).toContain('0.79%');
    expect(body).toContain('0.40%');
    expect(body).toContain('9571');
  });

  it('warns that the numbers go stale', () => {
    expect(body).toMatch(/rimisurali/i);
  });

  it('spells out the blast radius, naming both incidents a naive fix would recreate', () => {
    expect(body).toContain('#4838');
    expect(body).toMatch(/galenica/);
  });

  it('reads churn and genuine recovery differently', () => {
    expect(body).toMatch(/churn/);
    const recovering = buildAlertBody(
      { ...record, direction: { towards: 300, away: 10, lateral: 5, unresolved: 36 } },
      verdict, 'x',
    );
    // When most moves correct the assignment, the body must not assert a defect.
    expect(recovering).toMatch(/recupero legittimo/);
    expect(recovering).not.toMatch(/e' churn/);
  });
});
