import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  formatCompleteRatio,
  classifyJob,
  summarizeJobs,
  mergeCounters,
  emptyCounters,
  finalizeEntry,
  formatReport,
} from '../scripts/log-translation-stats.mjs';
import {
  formatFlaggedRate,
  collectBlockingIssues,
  collectRetranslationFlags,
  collectLanguageSuspects,
  analyzeJobs,
  MIN_TITLE_CHARS,
  MIN_DESCRIPTION_CHARS,
  LOCALES,
} from '../scripts/validate-translation-completeness.mjs';

/**
 * Guards the two lines that made "job translation is at 100%" believable:
 *
 *   - log-translation-stats.mjs printed `Math.round(complete/total*100)`, so a
 *     run with 26208/26321 complete (113 incomplete, 1930 needsRetranslation)
 *     printed `Complete: … (100%)`;
 *   - validate-translation-completeness.mjs printed "all N jobs have complete
 *     4-locale coverage" from a >=3-char title / >=120-char description rule
 *     that measures PRESENCE and never language, while its own header claimed
 *     it flagged `needsRetranslation` — which it never read.
 *
 * The second half of this file is the safety proof for a BLOCKING deploy gate:
 * `collectBlockingIssues` must stay bit-identical to the pre-change inline
 * loop, so the honesty pass cannot have tightened what stops a deploy.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

type Job = Record<string, unknown>;

const LONG = 'x'.repeat(200);

/**
 * A job whose four locale slots are all populated, long enough, AND actually
 * read as their own locale (required since #5593 item1: `classifyJob` now
 * delegates to the language-aware canonical `isIncomplete()`, so a slot that
 * merely LOOKS long enough but still reads as the source language no longer
 * counts as complete here).
 */
function slotComplete(overrides: Job = {}): Job {
  return {
    slug: 'job-a',
    sourceLang: 'de',
    title: 'Physiotherapeut/in Stationär mit Fachverantwortung Neurologie',
    description: LONG,
    company: 'ZURZACH Care',
    titleByLocale: {
      de: 'Physiotherapeut/in Stationär mit Fachverantwortung Neurologie',
      it: 'Fisioterapista di reparto con responsabilità in neurologia',
      en: 'Physiotherapist, inpatient, responsible for neurology',
      fr: 'Physiothérapeute hospitalier, responsable neurologie',
    },
    descriptionByLocale: { de: LONG, it: `${LONG}it`, en: `${LONG}en`, fr: `${LONG}fr` },
    ...overrides,
  };
}

describe('formatCompleteRatio — a success rate can never overstate itself', () => {
  it('prints the real 26208/26321 case as 99.5%, not 100%', () => {
    const out = formatCompleteRatio(26208, 26321);
    expect(out).toBe('26208/26321 (99.5%)');
    expect(out).not.toContain('100%');
  });

  it('prints the counts alongside the percentage', () => {
    expect(formatCompleteRatio(26477, 26556)).toBe('26477/26556 (99.7%)');
  });

  it('reserves 100% for the exact case', () => {
    expect(formatCompleteRatio(10, 10)).toBe('10/10 (100%)');
  });

  it('never reaches 100% while a single item is missing, however large the set', () => {
    for (const total of [1_000, 26_321, 1_000_000, 10_000_000]) {
      expect(formatCompleteRatio(total - 1, total)).not.toContain('100%');
    }
  });

  it('degrades safely on an empty dataset', () => {
    expect(formatCompleteRatio(0, 0)).toContain('n/a');
  });
});

describe('formatFlaggedRate — a problem rate can never understate itself', () => {
  it('ceils, so a single flagged job out of 26321 is not 0%', () => {
    expect(formatFlaggedRate(1, 26321)).toBe('1/26321 (0.1%)');
  });

  it('reports the real 1930-flagged backlog', () => {
    expect(formatFlaggedRate(1930, 26321)).toBe('1930/26321 (7.4%)');
  });

  it('prints 0% only for an exactly-zero count', () => {
    expect(formatFlaggedRate(0, 26321)).toBe('0/26321 (0%)');
  });
});

describe('classifyJob — delegates to the single canonical isIncomplete() (#5593 item1)', () => {
  it('treats a fully populated, genuinely-translated job as complete', () => {
    expect(classifyJob(slotComplete())).toEqual({ incomplete: false, sourceCopyExcused: false });
  });

  it('treats a short title slot as incomplete', () => {
    const job = slotComplete();
    (job.titleByLocale as Record<string, string>).it = 'x';
    expect(classifyJob(job).incomplete).toBe(true);
  });

  it('treats a short description slot as incomplete', () => {
    const job = slotComplete();
    (job.descriptionByLocale as Record<string, string>).fr = 'troppo corto';
    expect(classifyJob(job).incomplete).toBe(true);
  });

  /**
   * THE DRIFT SCENARIO — pinned as a regression guard.
   *
   * Before #5575 (11-08) AND before this fix, this exact case ("DE source, IT
   * slot left byte-identical to the German source title, EN+FR genuinely
   * translated") was judged DIFFERENTLY by the two isIncomplete()-shaped
   * functions in this repo:
   *   - relocalize-pending-jobs.mjs's isIncomplete(): incomplete (its
   *     cross-locale `othersDiffer` escape hatch was removed by #5575).
   *   - this file's OWN copy of the same judgment: NOT incomplete (excused,
   *     because EN and FR differ from the German source title).
   * `classifyJob` no longer has a second copy to disagree with — it calls the
   * SAME function relocalize-pending-jobs.mjs calls. If this test ever goes
   * back to `incomplete: false`, the duplication has silently returned.
   */
  it('does NOT excuse a source-title byte-copy even when another locale differs (drift fix)', () => {
    const job = slotComplete();
    // IT slot left as the untouched German source title; EN and FR translated.
    (job.titleByLocale as Record<string, string>).it = job.title as string;
    const verdict = classifyJob(job);
    expect(verdict.incomplete).toBe(true); // aligned with relocalize-pending-jobs.mjs
    expect(verdict.sourceCopyExcused).toBe(false); // nothing left to "excuse"
  });

  it('flags a source-title copy when no other locale differs either', () => {
    const job = slotComplete();
    const src = job.title as string;
    job.titleByLocale = { de: src, it: src, en: src, fr: src };
    expect(classifyJob(job).incomplete).toBe(true);
  });
});

describe('log-translation-stats.mjs — single implementation, not two copies (#5593 item1)', () => {
  const rawSrc = fs.readFileSync(path.join(ROOT, 'scripts/log-translation-stats.mjs'), 'utf-8');
  // Comments are allowed to name the historical `othersDiffer` pattern (this
  // file's own header does, to explain what drifted and why); only CODE must
  // never re-derive it. Same stripComments approach as the block below.
  const codeSrc = rawSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('imports the canonical isIncomplete from relocalize-pending-jobs.mjs', () => {
    expect(rawSrc).toMatch(/import\s*\{\s*isIncomplete[^}]*\}\s*from\s*['"]\.\/relocalize-pending-jobs\.mjs['"]/);
  });

  it('does not re-derive its own cross-locale "othersDiffer" escape hatch in code', () => {
    // The exact pattern that drifted: iterating LOCALES a second time to ask
    // "does some OTHER non-source locale differ from the source title" is the
    // duplicated judgment call that caused #5593 item1. Any reappearance of
    // that IDENTIFIER in code (not prose) — independent of
    // relocalize-pending-jobs.mjs — is the regression this guards against.
    expect(codeSrc).not.toMatch(/othersDiffer/);
  });
});

describe('summarizeJobs / formatReport — presence is separated from translation', () => {
  it('counts a flagged-but-populated job as present, not as translated', () => {
    const counters = summarizeJobs([
      slotComplete({ slug: 'ok-1' }),
      slotComplete({ slug: 'flagged-1', needsRetranslation: true }),
      slotComplete({ slug: 'flagged-2', needsRetranslation: true }),
    ]);
    const entry = finalizeEntry(counters, { label: 'test', timestamp: 'T' });

    expect(entry.total).toBe(3);
    expect(entry.complete).toBe(3); // legacy key keeps its legacy meaning
    expect(entry.slotsPresent).toBe(3);
    expect(entry.needsRetranslation).toBe(2);
    expect(entry.flaggedAmongSlotsPresent).toBe(2);
    expect(entry.verifiedTranslated).toBe(1);
  });

  it('records "not measured", never zero, for the un-wired language check', () => {
    const entry = finalizeEntry(summarizeJobs([slotComplete()]), { label: 'test', timestamp: 'T' });
    expect(entry.languageVerified).toBeNull();
    expect(formatReport(entry).join('\n')).toContain('not measured');
  });

  it('reserves the word COMPLETE for zero incomplete AND zero flagged', () => {
    const clean = finalizeEntry(summarizeJobs([slotComplete()]), { label: 'test', timestamp: 'T' });
    expect(formatReport(clean).join('\n')).toContain('Verdict: COMPLETE');

    const flaggedOnly = finalizeEntry(
      summarizeJobs([slotComplete({ needsRetranslation: true })]),
      { label: 'test', timestamp: 'T' },
    );
    const text = formatReport(flaggedOnly).join('\n');
    expect(text).toContain('Verdict: NOT COMPLETE');
    expect(text).not.toMatch(/Verdict: COMPLETE/);
  });

  it('cannot print a bare 100% while jobs are incomplete (the reported regression)', () => {
    // 26208 complete / 26321 total, 1930 flagged — the committed history row.
    const counters = emptyCounters();
    counters.total = 26321;
    counters.incomplete = 113;
    counters.needsRetranslation = 1930;
    counters.flaggedAmongSlotsPresent = 1930;
    const text = formatReport(finalizeEntry(counters, { label: 'after', timestamp: 'T' })).join('\n');

    expect(text).toContain('26208/26321 (99.5%)');
    expect(text).toContain('Verdict: NOT COMPLETE');
    expect(text).toContain('1930');
    expect(text).not.toContain('(100%)');
  });

  it('mergeCounters adds slices without losing any figure', () => {
    const a = summarizeJobs([slotComplete({ slug: 'a', needsRetranslation: true })]);
    const b = summarizeJobs([slotComplete({ slug: 'b' })]);
    const merged = mergeCounters(a, b);
    expect(merged.total).toBe(2);
    expect(merged.needsRetranslation).toBe(1);
    expect(merged.flaggedAmongSlotsPresent).toBe(1);
  });
});

/* ── Deploy-gate safety: the blocking rules must be unchanged ───────────── */

/**
 * Verbatim copy of the pre-2026-08-10 inline loop, kept as an oracle. If
 * `collectBlockingIssues` ever diverges from it, a deploy gate changed
 * behaviour and this test says so.
 */
function legacyBlockingIssues(jobs: Job[]) {
  const issues: { slug: string; locale: string; reason: string }[] = [];
  for (const job of jobs as any[]) {
    const slug = job.slug || '(unknown)';
    const sourceLang = job.sourceLang || 'it';
    for (const locale of LOCALES) {
      const title = String(job.titleByLocale?.[locale] || '').trim();
      if (title.length < 3) {
        issues.push({ slug, locale, reason: `missing/short title (${title.length} chars)` });
      }
      const desc = String(job.descriptionByLocale?.[locale] || '').trim();
      if (desc.length < 120) {
        if (locale === sourceLang) {
          const mainDesc = String(job.description || '').trim();
          if (mainDesc.length < 120) {
            issues.push({ slug, locale, reason: `missing/short description (${desc.length} chars, main: ${mainDesc.length} chars)` });
          }
        } else {
          issues.push({ slug, locale, reason: `missing/short description (${desc.length} chars)` });
        }
      }
    }
  }
  return issues;
}

describe('validate-translation-completeness — the blocking gate is not tightened', () => {
  const corpus: Job[] = [
    slotComplete({ slug: 'clean' }),
    slotComplete({ slug: 'flagged', needsRetranslation: true }),
    slotComplete({ slug: 'suppressed', localeMismatchSuppressed: true }),
    { slug: 'no-locales', sourceLang: 'it', title: 'T', description: LONG },
    { slug: 'empty', titleByLocale: {}, descriptionByLocale: {} },
    slotComplete({ slug: 'short-title', titleByLocale: { de: 'ab', it: 'ab', en: 'ab', fr: 'ab' } }),
    slotComplete({
      slug: 'source-desc-fallback',
      sourceLang: 'it',
      description: LONG,
      descriptionByLocale: { de: LONG, it: '', en: LONG, fr: LONG },
    }),
  ];

  it('keeps the documented thresholds', () => {
    expect(MIN_TITLE_CHARS).toBe(3);
    expect(MIN_DESCRIPTION_CHARS).toBe(120);
    expect(LOCALES).toEqual(['it', 'en', 'de', 'fr']);
  });

  it('produces exactly the legacy issue set', () => {
    expect(collectBlockingIssues(corpus)).toEqual(legacyBlockingIssues(corpus));
  });

  it('does NOT block on a German title sitting in the it slot (presence != language)', () => {
    // This is the reported bug: the it slot holds an all-but-untranslated
    // German title. It must still pass the gate today — tightening it would
    // stop every deploy against the real backlog.
    expect(collectBlockingIssues([slotComplete()])).toEqual([]);
  });

  it('does NOT block on needsRetranslation — it reports it (S4)', () => {
    const flaggedJob = slotComplete({ slug: 'flagged', needsRetranslation: true });
    const result = analyzeJobs([flaggedJob]);
    expect(result.blocking).toEqual([]);
    expect(result.flagged).toEqual(['flagged']);
  });

  it('reads needsRetranslation at all — the header claim is now implemented', () => {
    const flags = collectRetranslationFlags([
      slotComplete({ slug: 'a', needsRetranslation: true }),
      slotComplete({ slug: 'b' }),
      slotComplete({ slug: 'c', needsRetranslation: true }),
    ]);
    expect(flags).toEqual(['a', 'c']);
  });
});

describe('the language-check seam', () => {
  it('is inert until a detector is supplied', () => {
    const result = analyzeJobs([slotComplete()]);
    expect(result.languageSuspects).toEqual([]);
    expect(collectLanguageSuspects([slotComplete()], null as any)).toEqual({ suspects: [], errors: 0 });
  });

  it('calls the detector once per non-source locale slot, with the pinned arguments', () => {
    const calls: any[] = [];
    const fake = (args: any) => {
      calls.push(args);
      return { untranslated: args.targetLocale === 'it', reason: 'source-overlap', overlap: 1 };
    };
    const { suspects } = collectLanguageSuspects([slotComplete({ slug: 'z' })], fake);

    expect(calls.map(c => c.targetLocale).sort()).toEqual(['en', 'fr', 'it']);
    expect(calls[0].sourceLang).toBe('de');
    expect(calls[0].sourceTitle).toContain('Physiotherapeut');
    expect(calls[0].company).toBe('ZURZACH Care');
    expect(suspects).toEqual([{ slug: 'z', locale: 'it', reason: 'source-overlap', overlap: 1 }]);
  });

  it('survives a throwing detector without failing the gate', () => {
    const boom = () => { throw new Error('detector exploded'); };
    const { suspects, errors } = collectLanguageSuspects([slotComplete()], boom);
    expect(suspects).toEqual([]);
    expect(errors).toBe(3);
  });
});

describe('source-level regression guards', () => {
  // Both files quote the old, wrong lines in their header comments on purpose
  // (that is the record of what went wrong), so every assertion below runs on
  // the code with comments stripped.
  const stripComments = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  const statsSrc = stripComments(
    fs.readFileSync(path.join(ROOT, 'scripts/log-translation-stats.mjs'), 'utf-8'),
  );
  const validatorSrc = stripComments(
    fs.readFileSync(path.join(ROOT, 'scripts/validate-translation-completeness.mjs'), 'utf-8'),
  );

  it('no percentage is rounded anywhere in the stats logger', () => {
    // `Math.round(complete / total * 100)` is what printed 99.57% as 100%.
    expect(statsSrc).not.toMatch(/Math\.round\([^\n]*100\)/);
  });

  it('the validator no longer claims "complete 4-locale coverage"', () => {
    expect(validatorSrc).not.toContain('complete 4-locale coverage');
  });

  it('the validator reads needsRetranslation in code, not only in its header', () => {
    expect(validatorSrc).toContain('needsRetranslation');
  });

  it('exits 1 only on the pre-existing conditions plus the opt-in --strict', () => {
    // Guard against a future edit quietly promoting an advisory finding to
    // fatal: three sites only — unparseable jobs.json, blocking issues, and
    // --strict (which no workflow passes).
    const exits = validatorSrc.match(/process\.exit\(1\)/g) || [];
    expect(exits.length).toBe(3);
    expect(validatorSrc).toContain('if (strict && (flagged.length > 0');
  });
});
