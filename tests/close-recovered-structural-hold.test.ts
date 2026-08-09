/**
 * #5454 — `scripts/ci/close-recovered-failure-issues.mjs` closed on the SYMPTOM.
 *
 * A green run answers "is the failure happening right now?". The reconciler read that as
 * "was the fault fixed?" and closed. For a transient failure the two questions have the
 * same answer; for a structural one they do not, and the diagnosis written into the
 * issue's comments was thrown away with the issue.
 *
 * MEASURED (this is what the fixtures below reproduce, not invented shapes):
 *   - corpus nanakokyobashi-rgb/frontaliere-articles#76 and #77, closed 2026-08-09 at
 *     08:25:17Z / 08:25:14Z with "✅ Auto-resolved — the failing check is green again".
 *     Neither fix existed: `scripts/lib/npm-ci-retry.sh` was a 404 and
 *     `fast-publish-article.yml` still ran a bare `npm ci`. Last verdict on both:
 *     `<!-- FIX_OUTCOME: blocked-workflows-scope -->`, posted by claude[bot].
 *     #77 was reopened by a human at 12:13:57Z and re-closed here at 12:17:55Z.
 *   - this repo, same shape: `CI Failure: PR auto-rebase (near-merge only, no-Claude)`
 *     came back as a NEW issue EIGHT times between 2026-07-23 and 2026-08-05 (#4712,
 *     #4977, #5038, #5054, #5090, #5144, #5145, #5173) — a fresh issue each time
 *     because the previous one had been closed on green. All ten in-scope issues ever
 *     labelled `blocked-workflows-scope` carried that marker as their LAST verdict; six
 *     of them were auto-closed here on green.
 *
 * The two rejected signals are asserted as rejected, because "add all three for safety"
 * is the obvious wrong turn:
 *   - the `blocked-workflows-scope` LABEL was NOT on #76/#77 (labels: bug, agent:triaged,
 *     fu-prio:high, fu-parked, priority:high) → it would have missed the incident.
 *   - `fu-parked` is applied after MAX_ATTEMPTS too, a road that runs through three
 *     Claude quota 429s → it would pin transients open, which is the opposite failure.
 *
 * And the graveyard risk gets its own block: a hold that never releases is a worse bug
 * than the one being fixed, since scan-failed-runs.mjs opens one issue per failing
 * workflow.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  FIX_OUTCOME_RE,
  STRUCTURAL_OUTCOMES,
  HOLD_MARKER,
  DEFAULT_HOLD_MAX_DAYS,
  lastFixOutcome,
  alreadyHeld,
  decideStructuralHold,
  structuralHoldNote,
  ttlReleaseNote,
} from '../scripts/ci/close-recovered-failure-issues.mjs';

const NOW = Date.parse('2026-08-09T08:25:17Z'); // the instant #76 was auto-closed
const DAY = 86400000;
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

/** Verbatim shape of the claude[bot] verdict comment on corpus #76 / #77. */
const blockedVerdict = (msAgo = 2 * 3600 * 1000) => ({
  createdAt: iso(msAgo),
  body:
    '**Root cause (non del sintomo):** lo step `Install dependencies` di '
    + '`fast-publish-article.yml` esegue `npm ci` senza retry…\n\n'
    + '<!-- FIX_OUTCOME: blocked-workflows-scope -->',
});

describe('FIX_OUTCOME_RE — parses the marker exactly as followup-drainer.mjs does', () => {
  it('extracts the code from the real marker string found on corpus #76/#77', () => {
    const m = FIX_OUTCOME_RE.exec('bla\n<!-- FIX_OUTCOME: blocked-workflows-scope -->');
    expect(m?.[1]).toBe('blocked-workflows-scope');
  });

  it('tolerates the whitespace variants the writers actually emit', () => {
    expect(FIX_OUTCOME_RE.exec('<!--FIX_OUTCOME:blocked-secrets-->')?.[1]).toBe('blocked-secrets');
    expect(FIX_OUTCOME_RE.exec('<!--   FIX_OUTCOME:   pr-created   -->')?.[1]).toBe('pr-created');
  });

  it('does not match prose merely mentioning the word', () => {
    expect(FIX_OUTCOME_RE.exec('il FIX_OUTCOME era blocked-workflows-scope')).toBeNull();
  });
});

describe('lastFixOutcome — LAST verdict wins, by timestamp not array order', () => {
  it('returns the most recent marker when the array is already chronological', () => {
    const v = lastFixOutcome([blockedVerdict(3 * DAY), { createdAt: iso(DAY), body: '<!-- FIX_OUTCOME: pr-created -->' }]);
    expect(v?.code).toBe('pr-created');
  });

  it('still returns the most recent marker when the array arrives out of order', () => {
    // Load-bearing: picking an OLD blocked-* over a NEWER pr-created would pin the issue
    // open forever — the graveyard failure mode, introduced by a listing-order change.
    const v = lastFixOutcome([{ createdAt: iso(DAY), body: '<!-- FIX_OUTCOME: pr-created -->' }, blockedVerdict(3 * DAY)]);
    expect(v?.code).toBe('pr-created');
  });

  it('accepts the REST spelling created_at as well as the gh --json createdAt', () => {
    const v = lastFixOutcome([
      { created_at: iso(3 * DAY), body: '<!-- FIX_OUTCOME: blocked-secrets -->' },
      { created_at: iso(DAY), body: 'nessun marker qui' },
    ]);
    expect(v?.code).toBe('blocked-secrets');
  });

  it('falls back to array order for comments with no parseable timestamp', () => {
    const v = lastFixOutcome([
      { body: '<!-- FIX_OUTCOME: blocked-workflows-scope -->' },
      { body: '<!-- FIX_OUTCOME: already-fixed -->' },
    ]);
    expect(v?.code).toBe('already-fixed');
  });

  it('returns null when no comment carries a marker', () => {
    expect(lastFixOutcome([{ createdAt: iso(DAY), body: 'solo prosa' }])).toBeNull();
    expect(lastFixOutcome([])).toBeNull();
  });
});

describe('decideStructuralHold — the #5454 regression', () => {
  it('HOLDS corpus #76/#77: green again, but the last verdict is blocked-workflows-scope', () => {
    const d = decideStructuralHold([blockedVerdict()], { now: NOW, maxDays: DEFAULT_HOLD_MAX_DAYS });
    expect(d.hold).toBe(true);
    expect(d.code).toBe('blocked-workflows-scope');
    expect(d.notified).toBe(false); // first pass → the hold comment must be posted
  });

  it('HOLDS the other two blocked verdicts (secrets, admin-settings)', () => {
    for (const code of ['blocked-secrets', 'blocked-admin-settings']) {
      const d = decideStructuralHold([{ createdAt: iso(3600_000), body: `<!-- FIX_OUTCOME: ${code} -->` }], { now: NOW });
      expect(d.hold, code).toBe(true);
      expect(d.code, code).toBe(code);
    }
  });

  it('CLOSES a plain transient: an ETIMEDOUT issue nobody ever diagnosed', () => {
    // No FIX_OUTCOME anywhere → the reconciler keeps its original behaviour. This is the
    // majority case and the reason the fix cannot key on "has any comment".
    const d = decideStructuralHold([{ createdAt: iso(3600_000), body: 'Run failed: ETIMEDOUT 150.171.109.146:443' }], { now: NOW });
    expect(d.hold).toBe(false);
    expect(d.reason).toMatch(/transient by default/);
  });

  it('CLOSES an issue with no comments at all', () => {
    expect(decideStructuralHold([], { now: NOW }).hold).toBe(false);
  });
});

describe('decideStructuralHold — the graveyard valves (the opposite risk)', () => {
  it('RELEASES itself once the fix lands: a later pr-created beats the earlier block', () => {
    const d = decideStructuralHold(
      [blockedVerdict(3 * DAY), { createdAt: iso(DAY), body: 'PR #99 aperta.\n<!-- FIX_OUTCOME: pr-created -->' }],
      { now: NOW },
    );
    expect(d.hold).toBe(false);
    expect(d.code).toBe('pr-created');
  });

  it('RELEASES on already-fixed', () => {
    const d = decideStructuralHold(
      [blockedVerdict(3 * DAY), { createdAt: iso(DAY), body: '<!-- FIX_OUTCOME: already-fixed -->' }],
      { now: NOW },
    );
    expect(d.hold).toBe(false);
  });

  it('does NOT hold no-root-cause: nothing was written down, so closing loses nothing', () => {
    const d = decideStructuralHold([{ createdAt: iso(DAY), body: '<!-- FIX_OUTCOME: no-root-cause -->' }], { now: NOW });
    expect(d.hold).toBe(false);
  });

  it('does NOT hold rate-limited: quota is transient by construction', () => {
    const d = decideStructuralHold([{ createdAt: iso(DAY), body: '<!-- FIX_OUTCOME: rate-limited -->' }], { now: NOW });
    expect(d.hold).toBe(false);
  });

  it('does NOT hold overlap-skip / pr-already-open: scheduling, not a fault', () => {
    for (const code of ['overlap-skip', 'pr-already-open']) {
      expect(decideStructuralHold([{ createdAt: iso(DAY), body: `<!-- FIX_OUTCOME: ${code} -->` }], { now: NOW }).hold, code).toBe(false);
    }
  });

  it('TTL: a blocked verdict stale beyond the ceiling closes anyway, with the reason', () => {
    const d = decideStructuralHold([blockedVerdict(15 * DAY)], { now: NOW, maxDays: 14 });
    expect(d.hold).toBe(false);
    expect(d.reason).toMatch(/stale diagnosis/);
    expect(d.ageDays).toBeGreaterThan(14);
  });

  it('TTL: just inside the ceiling still holds (the boundary is not off by a day)', () => {
    const d = decideStructuralHold([blockedVerdict(13.9 * DAY)], { now: NOW, maxDays: 14 });
    expect(d.hold).toBe(true);
  });

  it('TTL ceiling clears every observed blocked-workflows-scope lifetime in this repo', () => {
    // 31 issues have ever carried the label; the longest lived 8.7 days (#4437), the
    // next 3.9 (#4926). A 14-day ceiling therefore never fires on the observed
    // population — it is a bound on the pathological case, not a scheduled eviction.
    expect(DEFAULT_HOLD_MAX_DAYS).toBeGreaterThan(8.7);
  });

  it('unreadable comments hold, but only up to the SAME ceiling', () => {
    const fresh = decideStructuralHold(null, { now: NOW, issueCreatedAt: iso(2 * DAY), maxDays: 14 });
    expect(fresh.hold).toBe(true);
    expect(fresh.unknown).toBe(true);
    expect(fresh.notified).toBe(true); // cannot see our own marker → must not spam

    const old = decideStructuralHold(null, { now: NOW, issueCreatedAt: iso(20 * DAY), maxDays: 14 });
    expect(old.hold).toBe(false);
    expect(old.reason).toMatch(/unreadable/);
  });

  it('an empty comment array is NOT the same as unreadable comments', () => {
    // `[]` means "read fine, nothing there" → close. `null` means "could not read" →
    // hold. Collapsing the two is how a read failure would silently start closing.
    expect(decideStructuralHold([], { now: NOW }).hold).toBe(false);
    expect(decideStructuralHold(null, { now: NOW, issueCreatedAt: iso(DAY) }).hold).toBe(true);
  });
});

describe('the signal is the MARKER, not the labels — both alternatives stay rejected', () => {
  it('STRUCTURAL_OUTCOMES holds exactly the three blocked-* verdicts', () => {
    expect([...STRUCTURAL_OUTCOMES].sort()).toEqual([
      'blocked-admin-settings', 'blocked-secrets', 'blocked-workflows-scope',
    ]);
  });

  it('never grows to swallow the transient verdicts', () => {
    for (const code of ['pr-created', 'already-fixed', 'no-root-cause', 'overlap-skip', 'pr-already-open', 'rate-limited']) {
      expect(STRUCTURAL_OUTCOMES, code).not.toContain(code);
    }
  });

  it('holds on the marker even with the exact label set corpus #76 carried (no blocked label)', () => {
    // #76's labels were bug, agent:triaged, fu-prio:high, fu-parked, priority:high — no
    // `blocked-workflows-scope`. A label-based gate would have closed it. The decision
    // takes comments only, so labels cannot enter the criterion by accident.
    expect(decideStructuralHold([blockedVerdict()], { now: NOW }).hold).toBe(true);
    expect(decideStructuralHold.length).toBeLessThanOrEqual(2); // (comments, opts) — no labels arg
  });

  it('does NOT hold a fu-parked issue whose parking was a quota burnout', () => {
    // followup-drainer parks after MAX_ATTEMPTS; the documented road there is three
    // Claude 429s (#5004, #5001, #4974). Those carry no blocked-* verdict, and must
    // still close on green — otherwise the fix pins open exactly what it should close.
    const d = decideStructuralHold(
      [{ createdAt: iso(DAY), body: '3 tentativi falliti per quota → `fu-parked`.\n<!-- FIX_OUTCOME: rate-limited -->' }],
      { now: NOW },
    );
    expect(d.hold).toBe(false);
  });
});

describe('the hold comment is posted once', () => {
  it('carries HOLD_MARKER and names the verdict, the TTL and the self-release', () => {
    const note = structuralHoldNote({ code: 'blocked-workflows-scope', workflow: 'fast-publish-article', runUrl: 'https://x/1', maxDays: 14 });
    expect(note).toContain(HOLD_MARKER);
    expect(note).toContain('blocked-workflows-scope');
    expect(note).toContain('14');
    expect(note).toMatch(/pr-created/);
  });

  it('alreadyHeld sees its own marker, so the second pass stays silent', () => {
    const note = structuralHoldNote({ code: 'blocked-secrets' });
    expect(alreadyHeld([{ body: note }])).toBe(true);
    expect(alreadyHeld([{ body: 'altro' }])).toBe(false);

    const d = decideStructuralHold([blockedVerdict(), { createdAt: iso(60_000), body: note }], { now: NOW });
    expect(d.hold).toBe(true);
    expect(d.notified).toBe(true);
  });

  it('the hold note does not itself look like a FIX_OUTCOME verdict', () => {
    // It mentions `pr-created` in prose. If that got parsed as a verdict the hold would
    // release itself on its own comment — the marker must be a comment node, not a word.
    const note = structuralHoldNote({ code: 'blocked-workflows-scope' });
    expect(lastFixOutcome([blockedVerdict(), { createdAt: iso(60_000), body: note }])?.code)
      .toBe('blocked-workflows-scope');
  });

  it('a TTL-released close is never silent', () => {
    const note = ttlReleaseNote({ code: 'blocked-workflows-scope', maxDays: 14, ageDays: 15.2 });
    expect(note).toContain('blocked-workflows-scope');
    expect(note).toContain('15.2');
  });
});

describe('the decision is actually WIRED into the close path', () => {
  // A pure-function suite passes just as happily when main() ignores the function it
  // tests. This is the second lens: read the shipped source and check the order.
  const SRC = fs.readFileSync(
    path.resolve(import.meta.dirname, '..', 'scripts', 'ci', 'close-recovered-failure-issues.mjs'),
    'utf-8',
  );
  const mainBody = SRC.slice(SRC.indexOf('function main()'));

  it('main() consults decideStructuralHold before resolveGithubIssue', () => {
    const decide = mainBody.indexOf('decideStructuralHold(');
    const resolve = mainBody.indexOf('resolveGithubIssue(');
    expect(decide).toBeGreaterThan(-1);
    expect(resolve).toBeGreaterThan(-1);
    expect(decide).toBeLessThan(resolve);
  });

  it('a hold short-circuits the close instead of falling through to it', () => {
    expect(mainBody).toMatch(/if \(decision\.hold\)[\s\S]{0,900}continue;/);
  });

  it('a failed comment fetch stays null — it must not degrade to an empty list', () => {
    // F1, un falso verde trovato da una seconda lente: degradando
    // `if (out === null) return null;` a `return [];` la suite passava 33/33 e
    // il bug tornava. Con `[]` una fetch fallita (rate limit) diventa
    // «nessun commento» -> «nessun verdetto» -> «transiente per default» ->
    // la issue strutturale viene CHIUSA, con un log perfettamente plausibile.
    // E' la forma di #65: un errore di lettura che torna al comportamento
    // vecchio senza far fallire niente.
    //
    // La distinzione null (non ho potuto leggere) vs [] (ho letto, non c'era
    // niente) e' load-bearing, e nessun test la copriva: `fetchIssueComments`
    // non e' esportata, quindi si asserisce sul sorgente.
    const fetchFn = SRC.slice(SRC.indexOf('function fetchIssueComments'));
    expect(fetchFn.slice(0, 600)).toMatch(/if \(out === null\) return null;/);
  });

  it('the hold branch does not ALSO close — the continue must be the only exit', () => {
    // F2, secondo falso verde: aggiungendo `resolveGithubIssue(...)` PRIMA del
    // `continue;` dentro il ramo hold, la suite passava 33/33, il log diceva
    // `closed=0 held=1` e l'issue veniva chiusa lo stesso. Le asserzioni per
    // indice e la regex `if (decision.hold)[\s\S]{0,900}continue;` reggevano
    // entrambe: prendevano «manca il continue», non «chiude comunque».
    const at = mainBody.indexOf('if (decision.hold)');
    expect(at).toBeGreaterThan(-1);
    const branch = mainBody.slice(at, mainBody.indexOf('continue;', at));
    expect(branch).not.toContain('resolveGithubIssue(');
  });

  it('comments are fetched lazily, inside the green branch only', () => {
    // Fetching for all 300 open issues on every pass would be the same reconciler with a
    // 300x API bill. The call must sit after the green/afterFailure gate.
    const greenGate = mainBody.indexOf('if (green && afterFailure)');
    const fetchAt = mainBody.indexOf('fetchIssueComments(');
    expect(greenGate).toBeGreaterThan(-1);
    expect(fetchAt).toBeGreaterThan(greenGate);
  });
});

describe('nessun hold puo\' essere illimitato (F3)', () => {
  it('un verdetto senza timestamp misura l\'eta\' sulla issue, e scade', () => {
    // Il commento del verdetto puo' non avere un timestamp parsabile. Prima
    // `age` restava null, il ramo TTL veniva saltato e la issue restava in hold
    // PER SEMPRE — cioe' la valvola non c'era, mentre il docstring prometteva
    // «quattro valvole limitate». La suite esercitava il caso senza timestamp
    // ma non ne verificava mai la conseguenza sul TTL: lo LEGITTIMAVA.
    const comments = [{ body: '<!-- FIX_OUTCOME: blocked-workflows-scope -->' }]; // niente createdAt
    const quattroAnniFa = new Date(Date.now() - 4 * 365 * 24 * 3600 * 1000).toISOString();
    const d = decideStructuralHold(comments, { issueCreatedAt: quattroAnniFa, maxDays: 14 });
    expect(d.hold).toBe(false);
    expect(d.ageDays).not.toBeNull();
    expect(d.reason).toMatch(/TTL/);
  });
});
