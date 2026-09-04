/**
 * Evidence-based shrink acceptance (issues #5016 / #5017).
 *
 * `shouldBlockShrink()` (see shrink-guard.test.ts) only ever says "refuse".
 * That is right when the source degraded, but it left the opposite case with
 * no exit: an employer that genuinely closes most of its vacancies bricks its
 * crawler forever — every run trips the guard, throws, fails the workflow
 * step, re-files the "Crawler Failure" issue, and (because the group workflow
 * runs housekeeping/commit only when the crawl step SUCCEEDED) freezes the
 * slice full of jobs that no longer exist. The guard built to prevent silent
 * content LOSS then causes silent content ROT.
 *
 * Confirmed incident: grace-la-margna. Its 14 winter-season postings expired
 * at the end of July 2026; hotelcareer.com has listed exactly one open role
 * on every run since (runs 30814154182 / 30905340681 / 30955742385 all
 * discovered the same single "Restaurant Supervisor (m/w)"), the independent
 * catererglobal.com board shows 0, and the crawler failed 10 consecutive
 * runs while 13 dead jobs stayed live on the site.
 *
 * `verifyShrinkAgainstSource()` adds a PROOF requirement, not a lower
 * threshold: the shrink is accepted only when every disappearing job is
 * provably gone at its own source URL. The underlying validator is fail-open,
 * so a bot challenge / timeout / 403 reports "still alive" and the guard
 * stands — a blocked source can never be mistaken for a legitimate shrink.
 */
import { describe, it, expect } from 'vitest';
import {
  shouldBlockShrink,
  verifyShrinkAgainstSource,
} from '../../scripts/assemble-jobs-dataset.mjs';

type Verdict = { id?: string; valid: boolean; definitive?: boolean; reason: string; status?: number };

/** Build a job with a stable identity the differ can key on. */
function job(id: string, url = `https://example.test/jobs/${id}`) {
  return { id, url, title: `Job ${id}`, slug: id };
}

/** Injectable validator returning a canned verdict per URL. */
function validatorFrom(byUrl: Record<string, Verdict>) {
  return async (jobs: Array<{ id: string; url: string }>) =>
    jobs.map((j) => byUrl[j.url] ?? { id: j.id, valid: true, reason: 'ok' });
}

const gone404 = (url: string): Verdict => ({ valid: false, definitive: true, status: 404, reason: 'http-404' });
const goneExpired = (): Verdict => ({ valid: false, definitive: true, status: 200, reason: 'phrase:this posting has expired' });
const stillLive = (): Verdict => ({ valid: true, status: 200, reason: 'ok' });
const botChallenge = (): Verdict => ({ valid: true, status: 403, reason: 'blocked-403' });
const networkError = (): Verdict => ({ valid: true, status: 0, reason: 'network-error' });

describe('verifyShrinkAgainstSource()', () => {
  it('corroborates the grace-la-margna shape: 14 -> 1 with all 13 dropped jobs 404 at the source', async () => {
    const prior = Array.from({ length: 14 }, (_, i) => job(`g${i}`));
    const next = [prior[0]];
    const dead: Record<string, Verdict> = {};
    for (const j of prior.slice(1)) dead[j.url] = gone404(j.url);

    // The guard still says "block" — the threshold is untouched.
    expect(shouldBlockShrink(prior.length, next.length)).toBe(true);

    const verdict = await verifyShrinkAgainstSource(prior, next, { validate: validatorFrom(dead) });
    expect(verdict.corroborated).toBe(true);
    expect(verdict.checked).toBe(13);
    expect(verdict.dead).toBe(13);
    expect(verdict.alive).toBe(0);
    expect(verdict.evidence).toHaveLength(13);
  });

  it('accepts an ATS "posting expired" marker as evidence, not just 404', async () => {
    const prior = [job('a'), job('b'), job('c')];
    const next = [job('a')];
    const verdict = await verifyShrinkAgainstSource(prior, next, {
      validate: validatorFrom({ [prior[1].url]: goneExpired(), [prior[2].url]: goneExpired() }),
    });
    expect(verdict.corroborated).toBe(true);
    expect(verdict.evidence.map((e) => e.reason)).toEqual([
      'phrase:this posting has expired',
      'phrase:this posting has expired',
    ]);
  });

  it('REFUSES when even one disappearing job is still live at the source', async () => {
    const prior = Array.from({ length: 10 }, (_, i) => job(`p${i}`));
    const next = [prior[0]];
    const byUrl: Record<string, Verdict> = {};
    for (const j of prior.slice(1)) byUrl[j.url] = gone404(j.url);
    byUrl[prior[5].url] = stillLive(); // one survivor is enough to refuse

    const verdict = await verifyShrinkAgainstSource(prior, next, { validate: validatorFrom(byUrl) });
    expect(verdict.corroborated).toBe(false);
    expect(verdict.alive).toBe(1);
    expect(verdict.survivors[0].url).toBe(prior[5].url);
  });

  it('REFUSES when the source is bot-blocked — the exact case the guard exists for', async () => {
    // The validator is fail-open: a 403/challenge is reported valid. That must
    // read as "cannot prove death", never as "legitimately gone".
    const prior = Array.from({ length: 14 }, (_, i) => job(`b${i}`));
    const next = [prior[0]];
    const byUrl: Record<string, Verdict> = {};
    for (const j of prior.slice(1)) byUrl[j.url] = botChallenge();

    const verdict = await verifyShrinkAgainstSource(prior, next, { validate: validatorFrom(byUrl) });
    expect(verdict.corroborated).toBe(false);
    expect(verdict.dead).toBe(0);
    expect(verdict.alive).toBe(13);
  });

  it('REFUSES on network errors / timeouts (degraded run, not a real drop)', async () => {
    const prior = [job('n1'), job('n2'), job('n3')];
    const next: ReturnType<typeof job>[] = [];
    const byUrl: Record<string, Verdict> = {
      [prior[0].url]: networkError(),
      [prior[1].url]: networkError(),
      [prior[2].url]: networkError(),
    };
    const verdict = await verifyShrinkAgainstSource(prior, next, { validate: validatorFrom(byUrl) });
    expect(verdict.corroborated).toBe(false);
  });

  it('REFUSES when a disappearing job has no URL to probe (absent evidence is not evidence)', async () => {
    const prior = [job('u1'), { id: 'u2', title: 'No URL', slug: 'u2' }, job('u3')];
    const next = [prior[0]];
    const verdict = await verifyShrinkAgainstSource(prior, next, {
      validate: validatorFrom({ [prior[2].url]: gone404(prior[2].url) }),
    });
    expect(verdict.corroborated).toBe(false);
    expect(verdict.unverifiable).toBe(1);
  });

  it('treats a pure-dedup shrink (nothing actually disappeared) as corroborated without probing', async () => {
    const prior = [job('d1'), job('d1'), job('d2')];
    const next = [job('d1'), job('d2')];
    let called = 0;
    const verdict = await verifyShrinkAgainstSource(prior, next, {
      validate: async (jobs) => {
        called += 1;
        return jobs.map((j) => ({ id: j.id, valid: true, reason: 'ok' }));
      },
    });
    expect(verdict.corroborated).toBe(true);
    expect(verdict.checked).toBe(0);
    expect(called).toBe(0);
  });

  it('does not accept a non-definitive dead verdict as proof', async () => {
    // Defensive: if the validator ever gains a soft "probably gone" signal it
    // must not silently become sufficient evidence.
    const prior = [job('s1'), job('s2')];
    const next = [prior[0]];
    const verdict = await verifyShrinkAgainstSource(prior, next, {
      validate: validatorFrom({ [prior[1].url]: { valid: false, reason: 'soft-signal' } }),
    });
    expect(verdict.corroborated).toBe(false);
  });

  it('returns the full disappearing job objects so an accepted shrink can archive them', () => {
    // SEO continuity: a job that leaves the slice without an expired entry
    // turns its indexed URL into a hard 404 instead of an enriched
    // soft-landing page. writeJobsCrawlerSliceVerified() feeds these objects
    // straight into archiveRemovedJobsToSlice(), so they must arrive whole
    // (slug + locale data), not as bare URLs.
    const prior = [
      { id: 'x1', url: 'https://example.test/jobs/x1', slug: 'sommelier-grace', title: 'Sommelier', slugByLocale: { it: 'sommelier-grace' } },
      { id: 'x2', url: 'https://example.test/jobs/x2', slug: 'room-attendant-grace', title: 'Room Attendant' },
    ];
    const next = [prior[0]];
    return verifyShrinkAgainstSource(prior, next, {
      validate: validatorFrom({ [prior[1].url]: gone404(prior[1].url) }),
    }).then((verdict) => {
      expect(verdict.corroborated).toBe(true);
      expect(verdict.disappearedJobs).toHaveLength(1);
      expect(verdict.disappearedJobs[0].slug).toBe('room-attendant-grace');
      expect(verdict.disappearedJobs[0].title).toBe('Room Attendant');
    });
  });

  it('REFUSES a quarantine-driven shrink instead of waving it through on a vacuous empty diff (reviewer 🔴, PR #5113)', async () => {
    // The hole: writeJobsCrawlerSlice reassigns its `jobs` internally —
    // quarantineBoilerplateJobs() returns a NEW filtered array rather than
    // mutating the caller's — so the count that trips the guard is NOT derived
    // from the array the caller passed. Diffing prior against the caller's
    // (pre-quarantine) array finds every key still present, `disappeared` is
    // empty, and "nothing disappeared" is vacuously true: the write would be
    // accepted with zero URL evidence and nothing archived.
    //
    // `expectedNewCount` is the count the guard actually measured. When the
    // array handed to us does not match it, we refuse rather than guess.
    const prior = Array.from({ length: 30 }, (_, i) => job(`q${i}`));
    const preQuarantine = prior; // what the caller passed — all 30 still here
    const verdict = await verifyShrinkAgainstSource(prior, preQuarantine, {
      expectedNewCount: 5, // ...but only 5 survived quarantine and would persist
      validate: validatorFrom({}),
    });
    expect(verdict.corroborated).toBe(false);
    expect(verdict.reason).toMatch(/array-mismatch/);
    expect(verdict.disappearedJobs).toHaveLength(0);
  });

  it('probes the post-quarantine set correctly once the measured array is used', async () => {
    // Same scenario, but now diffing against what actually persists: the 25
    // quarantined jobs show up as disappearing and get probed. They are still
    // live at the source (a quarantine is our own decision, not a source
    // removal), so the guard correctly stands.
    const prior = Array.from({ length: 30 }, (_, i) => job(`q${i}`));
    const postQuarantine = prior.slice(0, 5);
    const verdict = await verifyShrinkAgainstSource(prior, postQuarantine, {
      expectedNewCount: 5,
      validate: validatorFrom({}), // default verdict is "ok" = still live
    });
    expect(verdict.corroborated).toBe(false);
    expect(verdict.checked).toBe(25);
    expect(verdict.alive).toBe(25);
  });

  it('REFUSES rather than probing unbounded when the drop exceeds the probe budget', async () => {
    // A legitimately huge drop is possible; probing it unbounded inside the
    // crawl step is not. Above the cap the guard stands (conservative
    // direction) and the log names the reason.
    const prior = Array.from({ length: 40 }, (_, i) => job(`c${i}`));
    let probed = 0;
    const verdict = await verifyShrinkAgainstSource(prior, [], {
      maxProbes: 10,
      validate: async (jobs) => {
        probed += jobs.length;
        return jobs.map((j) => ({ id: j.id, valid: false, definitive: true, reason: 'http-404' }));
      },
    });
    expect(verdict.corroborated).toBe(false);
    expect(verdict.reason).toMatch(/probe-budget-exceeded/);
    expect(probed).toBe(0); // refused before spending any network budget
  });

  it('REFUSES an off-target drop that exceeds the probe budget even though off-target needs no probing (reviewer 🔴, PR #6717)', async () => {
    // isTargetJob misclassifying real drops as off-target must not let an
    // unbounded mass-expiry through at zero network cost and zero cap.
    const prior = Array.from({ length: 40 }, (_, i) => job(`o${i}`));
    let probed = 0;
    const verdict = await verifyShrinkAgainstSource(prior, [], {
      maxProbes: 10,
      isTargetJob: () => false, // every disappearing job is off-target
      validate: async (jobs) => {
        probed += jobs.length;
        return jobs.map((j) => ({ id: j.id, valid: false, definitive: true, reason: 'http-404' }));
      },
    });
    expect(verdict.corroborated).toBe(false);
    expect(verdict.reason).toMatch(/probe-budget-exceeded/);
    expect(probed).toBe(0);
  });

  it('still self-corroborates an off-target drop within the probe budget without probing it', async () => {
    const prior = Array.from({ length: 5 }, (_, i) => job(`ok${i}`));
    const verdict = await verifyShrinkAgainstSource(prior, [], {
      maxProbes: 10,
      isTargetJob: () => false,
      validate: async () => {
        throw new Error('must not probe off-target jobs');
      },
    });
    expect(verdict.corroborated).toBe(true);
    expect(verdict.evidence).toHaveLength(5);
  });

  it('leaves the guard threshold itself untouched (no ratio was lowered)', () => {
    // Same expectations as tests/scripts/shrink-guard.test.ts — restated here
    // so a future edit to the acceptance path cannot quietly relax the gate.
    expect(shouldBlockShrink(152, 5)).toBe(true);
    expect(shouldBlockShrink(14, 1)).toBe(true);
    expect(shouldBlockShrink(84, 18)).toBe(true);
    expect(shouldBlockShrink(100, 40)).toBe(false);
    expect(shouldBlockShrink(6, 3)).toBe(false);
  });
});
