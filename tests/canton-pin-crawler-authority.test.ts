/**
 * Canton PIN ledger must not outrank the job's own canton (#4838, #4947).
 *
 * The pin ledger (`data/job-canton-pins.json`) exists to keep an already-indexed
 * `/cerca-lavoro-<canton>/<slug>/` URL from drifting between builds. It is a
 * tie-break signal — the best available value when the record carries no canton
 * of its own — but it used to win outright whenever `inferAnyCanton(city)` came
 * back empty, which is the normal outcome for any locality BFS does not list as
 * a municipality (a hamlet, a resort, a "Remote" placeholder).
 *
 * Bürgenstock Hotels AG is the reported instance: the crawler records canton NW
 * on all 39 postings (Obbürgen, a village inside the municipality of Stansstad),
 * BFS cannot resolve "Obbürgen", so a stale TI pin overwrote NW on every single
 * build and — because a contradicted pin was never rewritten — could never heal.
 * 28 of 39 jobs shipped `canton="TI"`: wrong URL section, wrong
 * `addressRegion` in the JobPosting (AGENTS.md Non-Negotiable #3), and Ticino
 * search pages padded with jobs that are not in Ticino.
 *
 * Measured across `data/jobs/by-crawler/` at the time of the fix: 1,188 jobs
 * across 100+ employers were relabelled this way, plus 455 where inference
 * already beat the pin but the stale value stayed in the ledger.
 *
 * These tests pin the precedence rule directly (pure function, no dataset), so
 * they fail on the pre-fix code regardless of what the live data happens to
 * contain.
 */
import { describe, expect, it } from 'vitest';
import {
  resolveCantonAgainstPin,
  cantonFallbackLocality,
  realignCantonOnlyLocality,
  normalizeParsedJobsForSlice,
} from '../scripts/assemble-jobs-dataset.mjs';
// @ts-expect-error — plain .mjs lib, no type declarations
import { inferAnyCanton, isTargetCanton } from '../scripts/lib/target-swiss-locations.mjs';

/** Test fixtures must never carry absolute dates (AGENTS.md → test fixtures). */
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

describe('resolveCantonAgainstPin — the job outranks the ledger', () => {
  it('BFS cannot resolve "Obbürgen", so the pre-fix code froze it to the stale pin', () => {
    // Guards the premise: if BFS ever learns Obbürgen this test still holds,
    // but the bug it describes would have a second, independent fix path.
    expect(inferAnyCanton('Obbürgen')).toBeFalsy();
  });

  it('keeps the crawler canton and REWRITES a contradicting pin (#4838)', () => {
    const d = resolveCantonAgainstPin({
      jobCanton: 'NW',
      inferredCanton: null, // Obbürgen — not a BFS municipality
      pinnedCanton: 'TI',
    });
    expect(d.canton).toBe('NW');
    expect(d.pin).toBe('NW'); // the ledger heals instead of re-losing the fix
    expect(d.outcome).toBe('pin-corrected');
  });

  it('persists the correction when inference beats the pin (was counted, never written)', () => {
    const d = resolveCantonAgainstPin({
      jobCanton: 'BE',
      inferredCanton: 'BE',
      pinnedCanton: 'TI',
    });
    expect(d.canton).toBe('BE');
    expect(d.pin).toBe('BE');
    expect(d.outcome).toBe('pin-corrected');
  });

  it('still freezes a canton-LESS job to the pin (URL-stability guarantee kept)', () => {
    const d = resolveCantonAgainstPin({
      jobCanton: '',
      inferredCanton: null,
      pinnedCanton: 'TI',
    });
    expect(d.canton).toBe('TI');
    expect(d.pin).toBe('TI');
    expect(d.outcome).toBe('pin-frozen');
  });

  it('is a no-op when job and pin agree', () => {
    const d = resolveCantonAgainstPin({ jobCanton: 'ZH', inferredCanton: 'ZH', pinnedCanton: 'ZH' });
    expect(d.canton).toBe('ZH');
    expect(d.outcome).toBe('pin-agrees');
  });

  it('only creates a pin for a non-empty canton backed by a confident inference', () => {
    expect(resolveCantonAgainstPin({ jobCanton: 'VD', inferredCanton: 'VD', pinnedCanton: undefined }))
      .toMatchObject({ canton: 'VD', pin: 'VD', outcome: 'pin-added' });
    // No confident city signal → do not seed the ledger with an unverified value.
    expect(resolveCantonAgainstPin({ jobCanton: 'VD', inferredCanton: null, pinnedCanton: undefined }))
      .toMatchObject({ canton: 'VD', pin: '', outcome: 'unpinned' });
    // Empty canton → pinning "" would freeze the job mis-placed forever.
    expect(resolveCantonAgainstPin({ jobCanton: '', inferredCanton: 'GE', pinnedCanton: undefined }))
      .toMatchObject({ pin: '', outcome: 'unpinned' });
  });

  it('normalises case so a lowercase crawler canton is not read as a contradiction', () => {
    expect(resolveCantonAgainstPin({ jobCanton: 'nw', inferredCanton: null, pinnedCanton: 'NW' }))
      .toMatchObject({ canton: 'NW', outcome: 'pin-agrees' });
  });

  it('does not let an OFF-FUNNEL canton overrule the pin, nor enter the ledger', () => {
    // Three live records carry the country code "CH" in the canton field.
    // /cerca-lavoro-ch/ does not exist, so letting it win would convert a job
    // the pin was placing correctly into an orphan with no URL section — the
    // outcome acceptInferredCantonForFill already blocks on the inference path.
    expect(isTargetCanton('CH')).toBe(false);
    expect(resolveCantonAgainstPin({ jobCanton: 'CH', inferredCanton: null, pinnedCanton: 'ZH' }))
      .toEqual({ canton: 'ZH', pin: 'ZH', outcome: 'pin-frozen' });
    // …and it is never seeded into the ledger as a new pin either.
    expect(resolveCantonAgainstPin({ jobCanton: 'CH', inferredCanton: 'ZH', pinnedCanton: undefined }))
      .toMatchObject({ pin: '', outcome: 'unpinned' });
  });

  it('leaves an off-funnel canton untouched when there is no pin to fall back on', () => {
    // Blanking it here would hide a crawler bug the location audit should see.
    expect(resolveCantonAgainstPin({ jobCanton: 'CH', inferredCanton: null, pinnedCanton: undefined }))
      .toEqual({ canton: 'CH', pin: '', outcome: 'unpinned' });
  });
});

/**
 * A BFS inference must not re-section an already-indexed URL — UNLESS it
 * converges on a value that NEITHER the pin NOR the crawler agree with, in
 * which case a plain misclassification outranks URL stability.
 *
 * `jobCanton` reaches the resolver AFTER the inference fill step, so the
 * causes of a pin contradiction are indistinguishable from it alone:
 *
 *   1. the crawler records a canton that disagrees with a stale pin — #4838
 *      (Obbürgen) and the galenica identity collision. The pin must heal
 *      with the crawler's value.
 *   2. `inferAnyCanton(location)` returns something new because the crawler
 *      re-extracted a different `location` string, while the crawler's OWN
 *      canton field (if any) still agrees with the pin, or never had one.
 *      Nothing about the job changed; only a lookup did. Rewriting the pin
 *      here moves a live, already-indexed URL for no reason.
 *
 * Case 2 is what GSC was counting: measured 2026-08-24 across 5 of the 32
 * data/all-known-job-slugs shards (44,919 slugs present in both the
 * 2026-08-17 and the 2026-08-24 build), 387 slugs — 0.86% per week — changed
 * their URL section, ~10,500 already-indexed URLs per week once the 4
 * locales are counted. Direction, using a municipality named in the slug as
 * the oracle (330 of the 387 resolvable): 108 moved towards that
 * municipality's canton, 154 moved away, 68 were lateral. Churn, not
 * convergence — so freezing case 2 is the fix.
 *
 * BUT case 2 has a failure mode of its own, found on the real dataset the
 * same day: coop-ticino/coopjobs.ch stamps FIVE different cantons
 * (BE/SG/TI/ZH…) on postings that all say `location: "Jegensdorf"` (a single,
 * unambiguous BE municipality) — the crawler's canton field tracks something
 * other than the job's real location for this source, so "the crawler agrees
 * with the pin" is not independent confirmation when the crawler itself is
 * provably self-inconsistent for the identical location. Freezing there left
 * 5 postings misclassified TI in production — a
 * `tests/canton-ti-misclassification-guard.test.ts` failure, and worse than
 * the redirect churn this function exists to stop (wrong `addressRegion` in
 * the JobPosting, AGENTS.md Non-Negotiable #3). So: when a confident
 * inference disagrees with BOTH the pin and the crawler, it wins.
 */
describe('resolveCantonAgainstPin — an inference may not re-section an indexed URL', () => {
  it('is a no-op — silent crawler — when job already agrees with the pin', () => {
    // job === pinned is caught earlier as 'pin-agrees'; this just confirms a
    // silent crawler does not change that earlier, unrelated branch.
    const d = resolveCantonAgainstPin({
      jobCanton: 'ZH',
      inferredCanton: 'ZH',
      pinnedCanton: 'ZH',
      crawlerCanton: '',
    });
    expect(d).toEqual({ canton: 'ZH', pin: 'ZH', outcome: 'pin-agrees' });
  });

  it('freezes a silent crawler when the job DISAGREES with the pin but the inference does not', () => {
    // job (post-fill) reads AG here — e.g. a stale field that inference
    // itself does not confirm — while the inference and the pin agree on ZH.
    // Nothing actually contradicts the pin, so it holds.
    const d = resolveCantonAgainstPin({
      jobCanton: 'AG',
      inferredCanton: 'ZH',
      pinnedCanton: 'ZH',
      crawlerCanton: '',
    });
    expect(d).toEqual({ canton: 'ZH', pin: 'ZH', outcome: 'pin-frozen' });
  });

  it('freezes when the crawler is silent and there is no inference at all', () => {
    const d = resolveCantonAgainstPin({
      jobCanton: 'AG',
      inferredCanton: null,
      pinnedCanton: 'ZH',
      crawlerCanton: '',
    });
    expect(d).toEqual({ canton: 'ZH', pin: 'ZH', outcome: 'pin-frozen' });
  });

  it('freezes when the crawler AGREES with the pin and the inference does not contradict it', () => {
    const d = resolveCantonAgainstPin({
      jobCanton: 'AG',
      inferredCanton: 'ZH',
      pinnedCanton: 'ZH',
      crawlerCanton: 'ZH',
    });
    expect(d).toEqual({ canton: 'ZH', pin: 'ZH', outcome: 'pin-frozen' });
  });

  it('lets a confident inference win when the crawler is SILENT and the inference contradicts the pin', () => {
    // The classic drift shape: crawler records nothing of its own, only the
    // BFS lookup contradicts the pin. Since a crawler canton is present on
    // 99.6% of live jobs (30,219 of 30,332, data/jobs/by-crawler/*.json,
    // 2026-08-24), this specific shape is the rarer one — the bulk of the
    // measured drift comes from the NEXT test instead.
    const d = resolveCantonAgainstPin({
      jobCanton: 'SG',        // already overwritten by the fill step
      inferredCanton: 'SG',
      pinnedCanton: 'ZH',
      crawlerCanton: '',
    });
    expect(d).toEqual({ canton: 'SG', pin: 'SG', outcome: 'pin-corrected' });
  });

  it('lets a confident inference win even when the crawler AGREES with the pin (Jegensdorf, 2026-08-24)', () => {
    // Measured on the real dataset: coop-ticino/coopjobs.ch stamped "TI" —
    // matching a stale TI pin — on postings whose `location` is "Jegensdorf"
    // (BE). The crawler's agreement with the pin is not trustworthy here:
    // the SAME crawler stamps BE/SG/ZH on OTHER postings at the identical
    // location, so its canton field is not per-job evidence for this source.
    // Confirmed by diffing against origin/main on the identical assembled
    // dataset: main passes tests/canton-ti-misclassification-guard.test.ts
    // (2/2); a draft of this fix that froze whenever crawler and pin merely
    // agreed did not (5 offenders, all real coopjobs.ch/Jegensdorf postings).
    const d = resolveCantonAgainstPin({
      jobCanton: 'BE',        // location-inference result, post-fill
      inferredCanton: 'BE',
      pinnedCanton: 'TI',     // stale, from an earlier TI-stamped posting
      crawlerCanton: 'TI',    // THIS posting's own (unreliable) crawler stamp
    });
    expect(d).toEqual({ canton: 'BE', pin: 'BE', outcome: 'pin-corrected' });
  });

  it('still lets the CRAWLER heal a stale pin (#4838 keeps working)', () => {
    // Obbürgen: crawler says NW on all 39 postings, BFS cannot resolve the
    // village, a stale TI pin used to win every build.
    const d = resolveCantonAgainstPin({
      jobCanton: 'NW',
      inferredCanton: null,
      pinnedCanton: 'TI',
      crawlerCanton: 'NW',
    });
    expect(d).toEqual({ canton: 'NW', pin: 'NW', outcome: 'pin-corrected' });
  });

  it('heals with the CRAWLER value, not `job`, when inference has overwritten job.canton to a THIRD value (review finding, PR #6318)', () => {
    // Same Obbürgen trigger as #4838 (crawler NW ≠ stale pin TI, so the heal
    // branch fires), but this build's inference resolves the job's `location`
    // to something else — BE — AND that resolution has already been written
    // into `job.canton` by the caller's fill step BEFORE this function runs.
    // `jobCanton` here is that post-fill value, exactly as the real call site
    // passes it. If the heal branch returned `job` (as the pre-review-fix code
    // did), the ledger would be written to BE — the inference's guess, not the
    // crawler's evidence — which is the very drift `crawlerCanton` exists to
    // stop, only reached through the branch meant to be immune to it.
    const d = resolveCantonAgainstPin({
      jobCanton: 'BE', // job.canton AFTER the inference fill step overwrote it
      inferredCanton: 'BE',
      pinnedCanton: 'TI',
      crawlerCanton: 'NW', // what the crawler itself actually declared
    });
    expect(d).toEqual({ canton: 'NW', pin: 'NW', outcome: 'pin-corrected' });
  });

  it('still lets the crawler heal a COLLIDED pin (galenica, 220 jobs)', () => {
    // One listing URL shared by every posting collapsed the identity, so a
    // single early TI pin held non-TI jobs on the Ticino section.
    const d = resolveCantonAgainstPin({
      jobCanton: 'BE',
      inferredCanton: 'BE',
      pinnedCanton: 'TI',
      crawlerCanton: 'BE',
    });
    expect(d).toEqual({ canton: 'BE', pin: 'BE', outcome: 'pin-corrected' });
  });

  it('does not let an OFF-FUNNEL crawler canton unlock the freeze', () => {
    // `CH` has no URL section, so it is not evidence that the pin is stale.
    const d = resolveCantonAgainstPin({
      jobCanton: 'VD',
      inferredCanton: 'VD',
      pinnedCanton: 'GE',
      crawlerCanton: 'CH',
    });
    expect(d).toEqual({ canton: 'GE', pin: 'GE', outcome: 'pin-frozen' });
  });

  it('omitting crawlerCanton preserves the previous precedence exactly', () => {
    // Callers that cannot supply provenance (and every pre-existing test above)
    // must behave as before: any contradiction rewrites the ledger.
    expect(resolveCantonAgainstPin({ jobCanton: 'BE', inferredCanton: 'BE', pinnedCanton: 'TI' }))
      .toEqual({ canton: 'BE', pin: 'BE', outcome: 'pin-corrected' });
  });

  it('leaves the unpinned and agreeing paths untouched', () => {
    expect(resolveCantonAgainstPin({ jobCanton: 'ZH', inferredCanton: 'ZH', pinnedCanton: 'ZH', crawlerCanton: '' }))
      .toMatchObject({ canton: 'ZH', outcome: 'pin-agrees' });
    expect(resolveCantonAgainstPin({ jobCanton: 'VD', inferredCanton: 'VD', pinnedCanton: undefined, crawlerCanton: '' }))
      .toMatchObject({ canton: 'VD', pin: 'VD', outcome: 'pin-added' });
  });
});

describe('unusable location falls back to the job\'s OWN canton, never to Ticino', () => {
  it('cantonFallbackLocality maps the canton code to its Italian label', () => {
    expect(cantonFallbackLocality({ canton: 'NW' })).toBe('Nidvaldo');
    expect(cantonFallbackLocality({ canton: 'be' })).toBe('Berna');
    // No canton on record → the funnel's primary canton stays the last resort.
    expect(cantonFallbackLocality({})).toBe('Ticino');
    expect(cantonFallbackLocality({ canton: 'ZZ' })).toBe('Ticino');
  });

  it('a prose location on a non-TI job does not relabel it Ticino', () => {
    const jobs = [
      {
        url: 'https://recruitingapp-2850.umantis.com/vacancies/1541/description/1',
        company: 'Bürgenstock Hotels AG',
        canton: 'NW',
        // Body text leaked into the location field by the parser — the case the
        // sanitizer's prose fallback exists for.
        location: 'Location: Obbürgen — home office is not possible for this role',
        crawledAt: daysAgo(2),
        datePosted: daysAgo(9),
      },
      {
        url: 'https://example.ch/jobs/1',
        company: 'Fixture SA',
        canton: '',
        location: 'undefined',
        crawledAt: daysAgo(1),
        datePosted: daysAgo(3),
      },
    ];

    normalizeParsedJobsForSlice(jobs);

    // Pre-fix this was the literal 'Ticino', which inferAnyCanton then resolved
    // to TI — flipping the canton, the URL section and the structured data.
    expect(jobs[0].location).toBe('Nidvaldo');
    expect(inferAnyCanton(jobs[0].location)).toBe('NW');
    expect(jobs[0].addressLocality).toBe('Nidvaldo');
    expect(jobs[0].addressRegion).toBe('NW');

    // A record with no canton at all keeps the historical Ticino default.
    expect(jobs[1].location).toBe('Ticino');
  });
});

describe('realignCantonOnlyLocality — a canton-name locality must name the job\'s canton', () => {
  it('rewrites a "Ticino" locality on a non-TI job to that job\'s canton label', () => {
    expect(realignCantonOnlyLocality('Ticino', 'SO')).toBe('Soletta');
    expect(realignCantonOnlyLocality('Ticino', 'NW')).toBe('Nidvaldo');
  });

  it('leaves a locality that already agrees with the canton alone', () => {
    expect(realignCantonOnlyLocality('Ticino', 'TI')).toBe('Ticino');
  });

  it('never touches a real municipality name', () => {
    expect(realignCantonOnlyLocality('Grenchen', 'SO')).toBe('Grenchen');
    expect(realignCantonOnlyLocality('Lugano', 'TI')).toBe('Lugano');
    // Even when the city sits in a different canton than the record claims:
    // that is a canton-mismatch for the inference/audit layers to adjudicate,
    // not a placeholder to overwrite.
    expect(realignCantonOnlyLocality('Bellinzona', 'SO')).toBe('Bellinzona');
  });

  it('is a no-op without a canton or without a value', () => {
    expect(realignCantonOnlyLocality('Ticino', '')).toBe('Ticino');
    expect(realignCantonOnlyLocality('', 'SO')).toBe('');
    expect(realignCantonOnlyLocality(undefined, 'SO')).toBeUndefined();
  });

  it('repairs the locality inside the slice write funnel (JobPosting jobLocation)', () => {
    // Shape produced by safeLocationToken()'s default fallback on a non-TI
    // crawler: canton correct, locality standing in as the literal "Ticino".
    const jobs = [
      {
        url: 'https://example.ch/jobs/eta-sa-1',
        company: 'ETA SA',
        canton: 'SO',
        location: 'Ticino',
        addressLocality: 'Ticino',
        crawledAt: daysAgo(1),
        datePosted: daysAgo(5),
      },
    ];
    normalizeParsedJobsForSlice(jobs);
    expect(jobs[0].location).toBe('Soletta');
    expect(jobs[0].addressLocality).toBe('Soletta');
    expect(jobs[0].addressRegion).toBe('SO');
    expect(inferAnyCanton(jobs[0].addressLocality)).toBe('SO');
  });
});
