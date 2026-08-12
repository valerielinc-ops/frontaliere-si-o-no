/**
 * THE INVARIANT: no channel mails an address that never opted in (#5686).
 *
 * `tests/newsletter-confirmed-implies-stamp.test.ts` proves the WRITE side —
 * nothing fabricates `status: 'confirmed'` without the click that earns it.
 * This file is the READ side: given a corpus where `status` cannot be trusted,
 * which senders consult the proof before choosing a recipient.
 *
 * It exists because the same defect was found twice in five days, in two
 * different channels, by two different people:
 *   - #5677: the daily brief let an unconfirmed newsletter row in through the
 *     job-alert side of its union;
 *   - #5686: the weekly newsletter took every non-excluded row on purpose,
 *     `pending` included, on the strength of a comment claiming that "clicking
 *     a link auto-confirms them" — which nothing implements. 1.488 addresses
 *     that never confirmed had been receiving it indefinitely; the person who
 *     reported it had signed up on 2026-06-10, never confirmed, and was in the
 *     `weekly_2026-06-08` campaign two days later.
 * Both were fixed one channel at a time, and neither fix could see the other
 * coming, because nothing enumerated the channels. This does.
 *
 * WHY IT IS A SOURCE SCAN AND NOT A BEHAVIOURAL TEST. Of the thirteen senders
 * below, exactly one can be imported and driven: `send-daily-brief.mjs`, which
 * has a Firestore seam and pure exports (and IS driven, in
 * tests/daily-brief-recipients.test.ts). `send-newsletter.mjs` exports nothing
 * at all; `blast-publisher-ads.mjs`, `newsletter-sunset.mjs`,
 * `newsletter-winback-campaign.mjs` and `send-onboarding-drip.mjs` call
 * `main()` unconditionally at module scope, so importing them would RUN them.
 * A scan is what can be written today; the alternative was nothing, which is
 * what there was.
 *
 * WHAT IT DOES NOT PROVE, said plainly so nobody reads a wider promise into
 * it: that a file mentions the gate is not proof that the gate covers every
 * path through the file. It is proof that the author of a new channel had to
 * answer the question — which is the failure mode that produced both issues.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasConfirmationProof } from '../services/subscriberConsent.mjs';
import { NEWSLETTER_EXCLUDED_STATUSES } from '../services/emailSuppression.mjs';
import { classifySunset } from '../scripts/lib/subscriberSunset.mjs';
import { classifyDormantWinback } from '../scripts/lib/dormantWinback.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

/**
 * Comments are where this invariant is DISCUSSED — the gate's own docblock
 * names every sender — so a scan that did not strip them would pass on a file
 * that only talks about the gate without calling it.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const CALLS_GATE = /hasConfirmationProof\s*\(/;

type Verdict =
  /** Consults the proof before choosing a recipient. */
  | { verdict: 'gated'; why: string; gateIn?: string }
  /**
   * Its purpose is reaching people the ordinary campaigns no longer may, so
   * the gate would make it inert. Declared, not ignored — and each one's real
   * audience rule is asserted below, so "re-permission" cannot become a label
   * somebody pins on an ordinary campaign to get past this file.
   */
  | { verdict: 're-permission'; why: string }
  /** Does not choose recipients from the subscriber collections at all. */
  | { verdict: 'not-a-broadcast'; why: string }
  /**
   * Reaches an address this file cannot vouch for, and is recorded as a FACT
   * rather than tolerated in silence — the shape the precedent file uses for
   * its blind spot. The entry fails the day the file starts calling the gate,
   * which is how the change gets noticed instead of absorbed.
   *
   * `onFire` says what to do WHEN it fails, and it is not the same answer
   * everywhere: for the drip the answer is "good, move it to `gated`", for the
   * alert channels it is "stop — that is the wrong fix". A single generic
   * message would push somebody toward the wrong one.
   */
  | { verdict: 'known-gap'; why: string; issue: string; onFire: string };

/**
 * Every top-level sender, with the verdict that lets it past this file.
 *
 * The KEYS are checked for exhaustiveness against the filesystem below, so a
 * fourteenth sender fails this test on the day it is written rather than on
 * the day somebody notices it mailing the wrong people.
 */
const VERDICTS: Record<string, Verdict> = {
  'scripts/send-newsletter.mjs': {
    verdict: 'gated',
    why: '#5686 — the weekly campaign, the channel this file was written for',
  },
  'scripts/send-daily-brief.mjs': {
    verdict: 'gated',
    why: '#5677 — gated on both sides of its union, and driven behaviourally in tests/daily-brief-recipients.test.ts',
  },
  'scripts/blast-publisher-ads.mjs': {
    verdict: 'gated',
    why: 'paid-ad blast over the whole collection — same class as #5686, fixed in the same PR',
    gateIn: 'services/publisherBlastMatch.mjs',
  },
  'scripts/newsletter-sunset.mjs': {
    verdict: 're-permission',
    why: 'the sunset mail is the last thing a lapsed address gets; a consent gate here would only mean it lapses in silence',
  },
  'scripts/newsletter-winback-campaign.mjs': {
    verdict: 're-permission',
    why: 'two-stage win-back at the dormant end of the engagement score — same reason as the sunset above',
  },
  'scripts/send-onboarding-drip.mjs': {
    verdict: 'known-gap',
    why: 'admits `pending` whenever isActive/active is true — the shape mailtrap-suppression-retry.mjs writes — and anchors enrollment on created_at when no stamp exists',
    issue: '#5700',
    onFire: 'good — move its entry from known-gap to gated',
  },
  /**
   * The two alert channels, and the reason they are NOT simply "the newsletter
   * defect, unfixed".
   *
   * A job alert somebody really created has a consent basis of its OWN: the act
   * of creating it. Refusing to send it because the same address's NEWSLETTER
   * document carries no stamp would let one channel's consent govern another —
   * the same confusion between channels that produced #5705, pointing the other
   * way. So the gate does not belong here, and an entry that only cited #5686
   * would read as an invitation to add it.
   *
   * The real defect on this channel is not the missing stamp: it is that most
   * of these alerts were never requested at all — 7.167 of 7.745 born from a
   * backfill off the newsletter list, 6.308 still active (#5705, guarded in
   * `shouldSkipSubscriber` by PR #5722), with cross-channel opt-out propagation
   * tracked separately as #5688. Neither passes through this gate. The entries
   * below therefore describe a BOUNDARY that is policed elsewhere, not work
   * this PR postponed.
   */
  'scripts/send-job-alerts.mjs': {
    verdict: 'known-gap',
    why: 'consent here is the alert the user created, not the newsletter opt-in, so this gate does not belong here; the unrequested-alert problem is #5705 (PR #5722, guard in shouldSkipSubscriber) and opt-out propagation is #5688',
    issue: '#5705 / #5688',
    onFire: 'STOP — adding the newsletter consent gate here is the wrong fix: it lets one channel\'s consent govern another. Read #5705 and #5688 first',
  },
  'scripts/send-company-alerts.mjs': {
    verdict: 'known-gap',
    why: 'same consent basis and same boundary as send-job-alerts: isAddressSuppressed + isJobAlertExcluded, deliberately no consultation of the newsletter doc',
    issue: '#5705 / #5688',
    onFire: 'STOP — same as send-job-alerts: the followed-employer alert is its own consent. Read #5705 and #5688 first',
  },
  'scripts/send-saved-jobs-digest.mjs': {
    verdict: 'not-a-broadcast',
    why: 'audience is collectionGroup(savedJobs) + users/{uid} with its own opt-out; newsletter_subscribers is read per-address as a suppression cross-check only',
  },
  'scripts/send-cold-emails.mjs': {
    verdict: 'not-a-broadcast',
    why: 'employer outreach over employer_contacts — never touches the subscriber collections',
  },
  'scripts/preview-welcome-email.mjs': {
    verdict: 'not-a-broadcast',
    why: 'single --target-email preview tool, no collection scan',
  },
  'scripts/monitor-gsc-job-indexation.mjs': {
    verdict: 'not-a-broadcast',
    why: 'ops alert to the owner',
  },
  'scripts/notify-journalist-article-live.mjs': {
    verdict: 'not-a-broadcast',
    why: 'internal notification',
  },
};

/**
 * The senders, derived from disk rather than listed.
 *
 * `sendEmailCascade` is the only way mail leaves this repo (every provider
 * client is behind scripts/lib/email-cascade.mjs), so importing it is what
 * makes a script a sender — a definition that cannot go stale the way a
 * hand-kept array does.
 */
function discoverSenders(): string[] {
  return readdirSync(path.join(ROOT, 'scripts'), { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.mjs'))
    .map((e) => `scripts/${e.name}`)
    .filter((rel) => /sendEmailCascade/.test(stripComments(read(rel))));
}

describe('every sender is classified', () => {
  const senders = discoverSenders();

  it('the discovery found the senders at all', () => {
    // Guards the scan itself: a broken filter would otherwise make every
    // assertion below pass vacuously.
    expect(senders.length).toBeGreaterThan(8);
    expect(senders).toContain('scripts/send-newsletter.mjs');
    expect(senders).toContain('scripts/send-daily-brief.mjs');
  });

  it('no sender is missing a verdict — a new channel must declare one here', () => {
    const undeclared = senders.filter((s) => !(s in VERDICTS));
    expect(
      undeclared,
      'a new sender must say whether it consults the consent gate, and why',
    ).toEqual([]);
  });

  it('no verdict is stale — every entry still names a file that sends', () => {
    const orphaned = Object.keys(VERDICTS).filter((s) => !senders.includes(s));
    expect(orphaned, 'this entry no longer sends mail — delete it').toEqual([]);
  });
});

describe('the verdicts hold', () => {
  const entries = Object.entries(VERDICTS);
  const gated = entries.filter(([, v]) => v.verdict === 'gated') as Array<[string, Extract<Verdict, { verdict: 'gated' }>]>;
  const gaps = entries.filter(([, v]) => v.verdict === 'known-gap');
  const notBroadcast = entries.filter(([, v]) => v.verdict === 'not-a-broadcast');

  it.each(gated)('%s consults the shared gate', (file, v) => {
    const where = v.gateIn || file;
    expect(stripComments(read(where)), `${where} must call hasConfirmationProof()`).toMatch(CALLS_GATE);
    // From the shared module, never a local copy: a second definition is how
    // two channels end up disagreeing about who consented.
    expect(read(where)).toMatch(/from '[^']*subscriberConsent\.mjs'/);
    expect(stripComments(read(where))).not.toMatch(/function hasConfirmationProof/);
  });

  it.each(gaps)('%s is still the gap it is declared to be', (file, v) => {
    // Asserted as a fact, not tolerated in silence — and the message says what
    // to DO when it fires, which differs by channel: for the drip closing the
    // gap is the fix, for the alert channels closing it IS the bug.
    const g = v as Extract<Verdict, { verdict: 'known-gap' }>;
    expect(
      stripComments(read(file)),
      `${file} now consults the gate — ${g.onFire} (${g.issue})`,
    ).not.toMatch(CALLS_GATE);
  });

  it.each(notBroadcast)('%s does not scan a subscriber collection', (file) => {
    const src = stripComments(read(file));
    expect(src).not.toMatch(/collection\('newsletter_subscribers'\)\s*\.\s*get\(\)/);
    expect(src).not.toMatch(/collection\('job_alert_subscribers'\)\s*\.\s*get\(\)/);
  });

  it('the re-permission channels are exactly the ones whose audience rule says so', () => {
    // The label has to be earned by the code, or it becomes the sentence any
    // ordinary campaign writes to get past this file. Both channels admit only
    // an explicit mailable allowlist, and neither can be pointed at a fresh
    // unconfirmed signup: `pending` is not in it.
    const lapsed = { status: 'pending', sends: 99, last_sent_at: '2020-01-01T00:00:00.000Z', created_at: '2020-01-01T00:00:00.000Z' };
    expect(classifySunset(lapsed, Date.now()).action).toBe('none');
    expect(classifyDormantWinback({ ...lapsed, engagement_level: 'dormant' }, Date.now()).action).toBe('none');
  });
});

describe('send-newsletter.mjs: both recipient paths, not just the bulk one', () => {
  const src = read('scripts/send-newsletter.mjs');

  /**
   * Slice a top-level function out of the file by name.
   *
   * Enumerated per-path rather than asserted once over the whole file on
   * purpose: `fetchTargetSubscriber` is the --test/--dry-run path, it is
   * twenty lines long and nowhere near the bulk query, and a file-wide
   * `toMatch` would have read as covered while it stayed open.
   */
  function functionBody(source: string, name: string): string {
    const start = source.indexOf(`async function ${name}(`);
    if (start < 0) return '';
    const rest = source.slice(start + 1);
    const nextTop = rest.search(/\n(?:async )?function \w+\(/);
    return nextTop < 0 ? rest : rest.slice(0, nextTop);
  }

  it('finds both paths — this test is re-pointed, not deleted, if they are renamed', () => {
    expect(functionBody(src, 'fetchSubscribers').length).toBeGreaterThan(200);
    expect(functionBody(src, 'fetchTargetSubscriber').length).toBeGreaterThan(200);
  });

  it.each(['fetchSubscribers', 'fetchTargetSubscriber'])('%s consults the gate', (name) => {
    expect(stripComments(functionBody(src, name))).toMatch(CALLS_GATE);
  });

  it('the --test fallback profile cannot stand in for a refused document', () => {
    // The synthetic profile exists for an address with NO document. Before
    // #5686 a refusal and an absence were the same `null`, so the fallback
    // would have mailed exactly the address the gate had just turned away.
    const body = stripComments(src.slice(src.indexOf("if (mode === 'test')")));
    expect(body).toMatch(/refusal/);
  });

  it('the auto-confirm claim survives only where it is being refuted', () => {
    // The comment was the whole authorisation for the behaviour: it described
    // a guarantee no code provides, and a reader had every reason to trust it.
    // Deleting the words is not enough and keeping them is not forbidden —
    // what must not exist is the claim standing as a claim. So: the exact
    // sentence that authorised the send is gone, and any surviving mention has
    // to sit next to the fact that it was never true.
    expect(src).not.toMatch(/Fetch ALL subscribers \(including pending\) — clicking a link auto-confirms them\./);
    const lines = src.split('\n');
    lines.forEach((line, i) => {
      if (!/auto-confirm/i.test(line)) return;
      const window = lines.slice(Math.max(0, i - 6), i + 7).join('\n');
      expect(window, `line ${i + 1} repeats the auto-confirm claim without refuting it`)
        .toMatch(/Nothing implements that|#5686/);
    });
  });
});

describe('the fix that was NOT made, and why it must stay unmade', () => {
  it('`pending` is not in NEWSLETTER_EXCLUDED_STATUSES', () => {
    // The obvious fix, and the wrong one. That Set is shared with
    // newsletter-sunset, the dormant win-back, the onboarding drip and the
    // transactional guard; `pending` in it would make the two re-permission
    // channels inert — they exist to reach exactly these people. It would also
    // drop the 847 production rows sitting at `pending` WITH a stamp, which
    // scripts/mailtrap-suppression-retry.mjs writes as a deliverability
    // re-probe on addresses that DID confirm (measured 2026-08-12).
    expect(NEWSLETTER_EXCLUDED_STATUSES.has('pending')).toBe(false);
    expect([...NEWSLETTER_EXCLUDED_STATUSES].sort()).toEqual(
      ['bounced', 'complained', 'inactive', 'suppressed', 'unsubscribed'],
    );
  });

  it('the gate reads the stamp and never the word, in both directions', () => {
    const STAMP = '2026-01-01T00:00:00.000Z';
    // OUT: the shape the 1.488 unconfirmed rows have.
    expect(hasConfirmationProof({ status: 'pending' })).toBe(false);
    // OUT: fabricated consent — 392 rows claim `confirmed` with nothing behind it.
    expect(hasConfirmationProof({ status: 'confirmed' })).toBe(false);
    // IN: the deliverability re-probe — `pending` means "retry me", not "never consented".
    expect(hasConfirmationProof({ status: 'pending', confirmed_at: STAMP })).toBe(true);
    expect(hasConfirmationProof({ status: 'pending', confirmedAt: STAMP })).toBe(true);
    // Both spellings, on the row or on the raw doc a projection carries.
    expect(hasConfirmationProof({ doc: { confirmed_at: STAMP } })).toBe(true);
    expect(hasConfirmationProof(null)).toBe(false);
  });

  it('the gate has exactly one definition', () => {
    const dirs = ['services', 'scripts', 'scripts/lib'];
    const definers = dirs.flatMap((dir) =>
      readdirSync(path.join(ROOT, dir), { withFileTypes: true })
        .filter((e) => e.isFile() && /\.(mjs|js|ts)$/.test(e.name))
        .map((e) => `${dir}/${e.name}`)
        .filter((rel) => /(export )?function hasConfirmationProof/.test(stripComments(read(rel)))),
    );
    expect(definers).toEqual(['services/subscriberConsent.mjs']);
  });
});
