import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
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
  formatGenderFormRate,
  selectGenderFormSample,
  buildGenderFormRepairReport,
  slotsPresentByLength,
  isLanguageVerified,
  beforeCohortWarning,
  appendHistoryEntry,
  updateGenderFormWindow,
  readGenderFormWindowState,
  GENDER_FORM_SAMPLE_SIZE,
} from '../scripts/log-translation-stats.mjs';
import { genderFormTargetResidual } from '../scripts/mark-mistranslated-jobs.mjs';
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

  it('reports the wired language check as a ratio against presence, not "not measured"', () => {
    const entry = finalizeEntry(summarizeJobs([slotComplete()]), { label: 'test', timestamp: 'T' });
    expect(entry.slotsPresentByLength).toBe(1);
    expect(entry.languageVerified).toBe(1);
    const text = formatReport(entry).join('\n');
    expect(text).toContain('1/1 (100%)');
    // Ristretto alla RIGA della lingua (#17): il report porta ora anche l'età
    // alla completezza, che su uno snapshot senza coorte dice legittimamente
    // «not measured». Un `not.toContain` su tutto il testo confondeva le due
    // metriche e sarebbe diventato rosso per la riga sbagliata.
    const languageRow = text.split('\n').find((l) => l.includes('Language-verified:'));
    expect(languageRow).toBeDefined();
    expect(languageRow).not.toContain('not measured');
  });

  it('still prints "not measured" for a pre-wiring history row (null, never 0)', () => {
    // The 200 committed rows written before #6389 carry `languageVerified: null`.
    // A reader of the series must keep being able to tell "we did not look"
    // apart from "we looked and found zero".
    const legacy = { ...finalizeEntry(emptyCounters(), { label: 'old', timestamp: 'T' }),
      languageVerified: null, slotsPresentByLength: undefined };
    expect(formatReport(legacy).join('\n')).toContain('not measured');
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

/**
 * languageVerified (#6389) — the two failures a language check MUST catch.
 *
 * Both shapes are taken from the live corpus (data/jobs/by-crawler, origin/main
 * 2026-09-03), because a check that misses either is not a language check:
 *
 *  1. `fachkraft.json` — 2,217 jobs whose EN title is BYTE-IDENTICAL to the
 *     German one, and 2,226 whose FR title is. All 3,198 jobs in that slice have
 *     four populated slots, so pure presence counts every one of them.
 *  2. The case byte-equality alone cannot reach: German with only its two
 *     prepositions translated ("mit" -> "con"), which reads as Italian to a
 *     presence counter and is not equal to its source.
 *
 * They are asserted against `isLanguageVerified` (which composes the two
 * production detectors) rather than against a hand-rolled expectation, so the
 * day a detector is retuned this test tells us whether the corpus families it
 * was built for still land.
 */
describe('log-translation-stats.mjs — languageVerified catches what presence cannot', () => {
  const germanTitle = 'Sachbearbeiter/in Rechnungswesen mit Führungsaufgaben';

  /** The fachkraft shape: every slot populated, EN/FR left as the German. */
  function byteCopiedTitles(): Job {
    const job = slotComplete({ slug: 'fachkraft-shape' });
    job.title = germanTitle;
    job.titleByLocale = {
      de: germanTitle,
      it: 'Impiegato/a di contabilità con compiti di direzione',
      en: germanTitle,
      fr: germanTitle,
    };
    return job;
  }

  it('counts the byte-copied fachkraft shape as PRESENT but not language-verified', () => {
    const job = byteCopiedTitles();
    expect(slotsPresentByLength(job)).toBe(true);   // four slots, long enough
    expect(isLanguageVerified(job)).toBe(false);    // …and two of them are German
  });

  it('catches German whose prepositions alone were translated (byte-equality cannot)', () => {
    const source = 'Zimmermann/Zimmerin mit vielseitigen Holzbauaufgaben';
    const job = slotComplete({ slug: 'zimmermann' });
    job.title = source;
    job.titleByLocale = {
      de: source,
      it: 'Zimmermann/Zimmerin con vielseitigen Holzbauaufgaben',
      en: 'Carpenter with varied timber-construction duties',
      fr: 'Charpentier aux tâches variées de construction bois',
    };
    // Not a byte copy of its source — the IT slot really is a different string.
    expect((job.titleByLocale as Record<string, string>).it).not.toBe(source);
    expect(slotsPresentByLength(job)).toBe(true);
    expect(isLanguageVerified(job)).toBe(false);
  });

  it('verifies a genuinely translated job', () => {
    expect(isLanguageVerified(slotComplete())).toBe(true);
  });

  it('requires presence first: a short slot is never language-verified', () => {
    const job = slotComplete();
    (job.descriptionByLocale as Record<string, string>).fr = 'troppo corto';
    expect(slotsPresentByLength(job)).toBe(false);
    expect(isLanguageVerified(job)).toBe(false);
  });

  /**
   * OBSERVATIONAL — the whole point of the field. Adding it must not move a
   * single number the pipeline acts on: `incomplete` selects the retranslation
   * work, `verifiedTranslated` is the reported success rate.
   */
  it('does not feed incomplete / complete / verifiedTranslated', () => {
    const jobs = [slotComplete({ slug: 'clean' }), byteCopiedTitles()];
    const entry = finalizeEntry(summarizeJobs(jobs), { label: 'test', timestamp: 'T' });
    // The byte-copied job is judged by the canonical predicate, exactly as
    // before: classifyJob is the only thing that decides `incomplete`.
    expect(entry.incomplete).toBe(jobs.filter((j) => classifyJob(j).incomplete).length);
    expect(entry.complete).toBe(entry.total - entry.incomplete);
    expect(entry.slotsPresent).toBe(entry.complete);
    expect(entry.verifiedTranslated).toBe(entry.complete - entry.flaggedAmongSlotsPresent);
    // …while the observational pair records the gap presence alone hides.
    expect(entry.slotsPresentByLength).toBe(2);
    expect(entry.languageVerified).toBe(1);
  });
});

describe("l'età alla completezza (#17) — il numero che uno snapshot non può produrre", () => {
  // La seconda condizione della destinazione della mappa traduzioni parla di
  // «tutte e quattro le lingue entro 24 ore dal primo avvistamento». Nessuna
  // fotografia della coda può misurarla: un job che diventa completo ESCE
  // dalla coda, quindi `queueAge` non lo vede mai nel momento in cui è stato
  // servito. Serve il diff fra la coorte del passaggio `before` e lo stato del
  // passaggio `after`, ed è tutto ciò che questi casi difendono.
  const NOW = Date.parse('2026-09-04T12:00:00.000Z');
  const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

  function pending(url: string, firstSeenAt: string): Job {
    // Fessure vuote: `classifyJob` lo conta incompleto.
    return {
      url,
      firstSeenAt,
      slug: url,
      sourceLang: 'de',
      title: 'Zimmermann/Zimmerin mit vielseitigen Holzbauaufgaben',
      description: LONG,
      titleByLocale: {},
      descriptionByLocale: {},
    };
  }

  function done(url: string, firstSeenAt: string): Job {
    return slotComplete({ url, firstSeenAt, slug: url });
  }

  it('raccoglie gli id della coorte solo quando il chiamante lo chiede', () => {
    const jobs = [pending('u1', daysAgo(3)), done('u2', daysAgo(3))];
    expect(summarizeJobs(jobs).incompleteIds).toEqual([]);
    expect(summarizeJobs(jobs, { collectIncompleteIds: true }).incompleteIds).toEqual(['u1']);
  });

  it('conta come completato in questa run SOLO chi era nella coorte di partenza', () => {
    // `wasPending` era incompleto all'inizio della run: è la riparazione.
    // `alreadyDone` era già completo: contarlo gonfierebbe il numero a ogni
    // esecuzione con l'intero corpus già tradotto.
    const previouslyIncomplete = new Set(['wasPending']);
    const c = summarizeJobs(
      [done('wasPending', daysAgo(0.5)), done('alreadyDone', daysAgo(90))],
      { previouslyIncomplete },
    );
    expect(c.completedSamples).toHaveLength(1);
    expect(c.completedSamples[0].firstSeenAt).toBe(daysAgo(0.5));
  });

  it("un job ancora incompleto non entra fra i completati, anche se è nella coorte", () => {
    const c = summarizeJobs([pending('u1', daysAgo(1))], {
      previouslyIncomplete: new Set(['u1']),
    });
    expect(c.completedSamples).toEqual([]);
    expect(c.incomplete).toBe(1);
  });

  it("la entry porta la mediana dell'età alla completezza e la fascia sotto le 24 ore", () => {
    const counters = mergeCounters(
      emptyCounters(),
      summarizeJobs(
        [done('a', daysAgo(0.5)), done('b', daysAgo(0.8)), done('c', daysAgo(40))],
        { previouslyIncomplete: new Set(['a', 'b', 'c']) },
      ),
    );
    const entry = finalizeEntry(counters, { label: 'after', now: NOW });
    expect(entry.completionAge.count).toBe(3);
    expect(entry.completionAge.buckets['0-1d']).toBe(2);
    expect(entry.completionAge.p50AgeDays).not.toBeNull();
    expect(formatReport(entry).join('\n')).toContain('Age at completion (p50)');
  });

  it('«non misurato» e «nessun job completato» restano due frasi diverse', () => {
    // È la distinzione che rende il numero utilizzabile: una run che ha perso
    // la coorte non deve leggersi come una run che non ha riparato niente,
    // altrimenti la misura prima/dopo di ogni ticket successivo è falsata.
    // Nessuna coorte: è il passaggio `before`, uno snapshot manuale, o
    // lib/translation-observability.mjs. Non ha misurato.
    const noCohort = mergeCounters(emptyCounters(), summarizeJobs([pending('u1', daysAgo(3))]));
    const notMeasured = finalizeEntry(noCohort, { label: 'before', now: NOW });
    expect(notMeasured.completionAge).toBeNull();
    expect(formatReport(notMeasured).join('\n')).toContain('not measured');

    // Coorte presente, nessun job completato: ha misurato, e il risultato è zero.
    const zeroCounters = mergeCounters(
      emptyCounters(),
      summarizeJobs([pending('u1', daysAgo(3))], { previouslyIncomplete: new Set(['u1']) }),
    );
    const measuredZero = finalizeEntry(zeroCounters, { label: 'after', now: NOW });
    expect(measuredZero.completionAge.count).toBe(0);
    expect(formatReport(measuredZero).join('\n')).toContain('this run completed no job');
  });

  it('un consumatore che non chiede il diff non finge di aver misurato', () => {
    // `lib/translation-observability.mjs:72` chiama `summarizeJobs(jobs)` senza
    // opzioni: è uno snapshot, non ha un passaggio gemello, e con un `[]` di
    // default avrebbe pubblicato «zero job completati» a ogni report. Il
    // default `null` lo rende impossibile per costruzione, non per disciplina.
    const c = mergeCounters(emptyCounters(), summarizeJobs([done('a', daysAgo(1))]));
    expect(c.completedSamples).toBeNull();
    expect(finalizeEntry(c, { label: 'observability', now: NOW }).completionAge).toBeNull();
  });

  it('la staffetta before/after è cablata in main(), fuori dal repository', () => {
    // SCANSIONE DEL SORGENTE: `main()` non è esportata. Il cablaggio è la sola
    // cosa che i casi funzionali qui sopra non possono coprire, ed è quello che
    // si rompe per primo se qualcuno «semplifica» le due etichette.
    const src = fs.readFileSync(path.join(ROOT, 'scripts/log-translation-stats.mjs'), 'utf-8');
    expect(src).toMatch(/const isBefore = label === 'before'/);
    expect(src).toMatch(/const isAfter = label === 'after'/);
    // Il sidecar sta nella temp del runner, mai sotto data/: la coorte è stato
    // di una run, non un campo del corpus.
    expect(src).toMatch(/os\.tmpdir\(\)/);
    expect(src).not.toMatch(/COHORT_FILE\s*=\s*['"]data\//);
  });

  it('emette un warning distinguibile quando il pass after non trova il sidecar before', () => {
    expect(beforeCohortWarning('after', null)).toMatch(/^::warning::/);
  });

  it('non segnala una coorte before presente, anche se vuota', () => {
    expect(beforeCohortWarning('after', new Set())).toBeNull();
    expect(beforeCohortWarning('before', null)).toBeNull();
  });
});

describe('gender-form repair cohort — la misura del dopo (#7991)', () => {
  const SOURCE = 'Zimmermann/Zimmerin mit vielseitiger Erfahrung';

  function genderFormJob(url: string, overrides: Job = {}): Job {
    return slotComplete({
      url,
      slug: url,
      title: SOURCE,
      needsRetranslation: true,
      titleByLocale: {
        de: SOURCE,
        it: 'Zimmermann/Zimmerin con esperienza versatile',
        en: 'Carpenter with versatile experience',
        fr: 'Charpentier avec expérience polyvalente',
      },
      ...overrides,
    });
  }

  it('sceglie sempre lo stesso campione, indipendentemente dallordine dei crawler', () => {
    const records = Array.from({ length: 140 }, (_, index) => ({
      id: `https://example.invalid/jobs/${index}`,
      beforeSourceTitleHash: `hash-${index}`,
    }));
    const sample = selectGenderFormSample(records);
    const reversed = selectGenderFormSample([...records].reverse());

    expect(sample).toEqual(reversed);
    expect(sample).toHaveLength(120);
    expect(new Set(sample.map((record) => record.id)).size).toBe(120);
  });

  it('misura solo un job campionato che ha davvero lasciato la coda', () => {
    const before = genderFormJob('u-gender');
    const after = genderFormJob('u-gender', {
      needsRetranslation: undefined,
      titleByLocale: {
        de: SOURCE,
        it: 'Falegname con esperienza versatile',
        en: 'Carpenter with versatile experience',
        fr: 'Charpentier avec expérience polyvalente',
      },
    });
    const candidates = summarizeJobs([before], { collectGenderFormCohort: true });
    const actualSample = selectGenderFormSample(candidates.genderFormCohortCandidates);
    const observed = summarizeJobs([after], {
      previouslyGenderFormSample: new Map([[
        'u-gender',
        { id: 'u-gender', beforeSourceTitleHash: 'wrong-source-hash' },
      ]]),
    });

    expect(candidates.genderFormQueuedCandidates).toBe(1);
    expect(candidates.genderFormCohortCandidates).toHaveLength(1);
    const measured = summarizeJobs([after], {
      previouslyGenderFormSample: new Map(actualSample.map((record) => [record.id, record])),
    });
    expect(observed.genderFormSampleProcessed).toBe(0); // wrong hash is fail-closed
    expect(measured.genderFormSampleProcessed).toBe(1);
    expect(measured.genderFormSampleResidual).toBe(0);
    expect(genderFormTargetResidual(after)).toBe(false);

    const changedSourceLanguage = summarizeJobs([{
      ...after,
      sourceLang: 'it',
      titleByLocale: {
        it: 'Falegname con esperienza versatile',
        de: SOURCE,
        en: 'Carpenter with versatile experience',
        fr: 'Charpentier avec expérience polyvalente',
      },
    }], {
      previouslyGenderFormSample: new Map(actualSample.map((record) => [record.id, record])),
    });
    expect(changedSourceLanguage.genderFormSampleProcessed).toBe(0);
    expect(genderFormTargetResidual({ ...after, sourceLang: 'it' })).toBe(false);
  });

  it('normalizza il sourceLang regionale e rifiuta un prefisso non locale', () => {
    const regional = summarizeJobs([genderFormJob('regional-gender', { sourceLang: 'de-CH' })], {
      collectGenderFormCohort: true,
    });
    expect(regional.genderFormCandidates).toBe(1);
    expect(regional.genderFormCohortCandidates[0].beforeSourceLang).toBe('de');

    const invalid = summarizeJobs([genderFormJob('invalid-gender', { sourceLang: 'debug' })], {
      collectGenderFormCohort: true,
    });
    expect(invalid.genderFormCandidates).toBe(0);
    expect(invalid.genderFormCohortCandidates).toHaveLength(0);
  });

  it('non chiama misurato un campione parzialmente drenato', () => {
    expect(buildGenderFormRepairReport({
      phase: 'after',
      cohortAvailable: true,
      sampled: 120,
      processed: 119,
      residual: 2,
    })).toMatchObject({
      measured: false,
      status: 'partial',
      residualRate: 2 / 119,
    });
    expect(formatGenderFormRate(1, 120)).toBe('0.9%');
  });

  it('mantiene il tasso residuo come osservazione separata dal verdetto di completezza', () => {
    const entry = finalizeEntry(emptyCounters(), {
      label: 'after',
      genderFormRepair: {
        phase: 'after',
        cohortAvailable: true,
        sampled: 120,
        processed: 120,
        residual: 3,
      },
    });
    expect(entry.genderFormRepair).toMatchObject({
      measured: true,
      status: 'measured',
      sampled: 120,
      processed: 120,
      residual: 3,
      residualRate: 3 / 120,
    });
    expect(formatReport(entry).join('\n')).toContain('Gender-form after:');
    expect(formatReport(entry).join('\n')).toContain('3/120 (2.5%)');
  });
});

describe('gender-form window — la misura del dopo raccolta fra le run (#7991 item 3)', () => {
  type Outcome = { id: string; residual: boolean };
  type Row = Record<string, any>;

  const ids = (prefix: string, count: number) =>
    Array.from({ length: count }, (_, index) => `https://example.invalid/${prefix}/${index}`);
  const outcomes = (list: string[], residual = false): Outcome[] =>
    list.map((id) => ({ id, residual }));

  /** One `after` row as main() builds it: a per-run cohort that is only partially drained. */
  function afterRow(processed: number, residual = 0, queuedCandidates = 11543) {
    return finalizeEntry(emptyCounters(), {
      label: 'after',
      genderFormRepair: {
        phase: 'after',
        cohortAvailable: true,
        queuedCandidates,
        sampled: GENDER_FORM_SAMPLE_SIZE,
        processed,
        residual,
      },
    });
  }

  /** Append, then round-trip through JSON exactly like the committed file. */
  function write(history: Row[], entry: Row, runOutcomes: Outcome[] = []): Row[] {
    appendHistoryEntry(history, entry, { genderFormOutcomes: runOutcomes });
    return JSON.parse(JSON.stringify(history));
  }

  const rowsWithMembers = (history: Row[]) =>
    history.filter((row) => Array.isArray(row.genderFormRepair?.window?.members));

  it('tre after parziali da 50 distinti: misurata al terzo, non prima, e il per-run resta non misurato', () => {
    const third = 50;
    expect(2 * third).toBeLessThan(GENDER_FORM_SAMPLE_SIZE);
    expect(3 * third).toBeGreaterThanOrEqual(GENDER_FORM_SAMPLE_SIZE);
    let history: Row[] = [];
    for (const [run, prefix] of ['a', 'b', 'c'].entries()) {
      history = write(history, afterRow(third), outcomes(ids(prefix, third)));
      const last = history.at(-1)!;
      expect(last.genderFormRepair.measured).toBe(false);
      expect(last.genderFormRepair.status).toBe('partial');
      expect(last.genderFormRepair.window.measured).toBe(run === 2);
      expect(last.genderFormRepair.window.runs).toBe(run + 1);
    }
    const window = history.at(-1)!.genderFormRepair.window;
    expect(window.processed).toBe(GENDER_FORM_SAMPLE_SIZE);
    expect(window.size).toBe(GENDER_FORM_SAMPLE_SIZE);
    expect(window.queueCandidates).toBe(11543);
  });

  it('finestra piena + 10 nuovi tutti residui: il tasso sale perché i 10 più vecchi escono', () => {
    const full = updateGenderFormWindow({}, outcomes(ids('old', GENDER_FORM_SAMPLE_SIZE)));
    expect(full.measured).toBe(true);
    expect(full.residualRate).toBe(0);

    const next = updateGenderFormWindow(full, outcomes(ids('new', 10), true));
    expect(next.processed).toBe(GENDER_FORM_SAMPLE_SIZE);
    expect(next.residual).toBe(10);
    expect(next.residualRate).toBeCloseTo(10 / GENDER_FORM_SAMPLE_SIZE);
    // The ten oldest are gone, not averaged in: the window does not dilute.
    const oldestTen = updateGenderFormWindow({}, outcomes(ids('old', 10))).members;
    for (const member of oldestTen) expect(next.members).not.toContain(member);
  });

  it('lo stesso id in due run conta una volta, con lesito più recente in coda', () => {
    const [shared] = ids('shared', 1);
    const first = updateGenderFormWindow({}, [{ id: shared, residual: true }, ...outcomes(ids('x', 3))]);
    const second = updateGenderFormWindow(first, [{ id: shared, residual: false }]);
    expect(second.processed).toBe(first.processed);
    expect(second.residual).toBe(0);
    expect(second.members.at(-1)).toMatch(/:0$/);
    expect(second.runs).toBe(2);
  });

  it('una run con 0 processati lascia la finestra invariata', () => {
    let history = write([], afterRow(5), outcomes(ids('p', 5)));
    const before = structuredClone(history.at(-1)!.genderFormRepair.window);
    history = write(history, afterRow(0));
    const after = history.at(-1)!.genderFormRepair.window;
    expect(after.members).toEqual(before.members);
    expect(after.processed).toBe(before.processed);
    expect(after.residual).toBe(before.residual);
    expect(after.runs).toBe(before.runs);
  });

  it('members vive solo nellultima voce after, mai oltre la dimensione; le voci before restano append-only', () => {
    let history = write([], afterRow(10), outcomes(ids('m1', 10)));
    history = write(history, finalizeEntry(emptyCounters(), {
      label: 'before',
      genderFormRepair: { phase: 'before', sampled: GENDER_FORM_SAMPLE_SIZE, queuedCandidates: 11543 },
    }));
    expect(history.at(-1)!.genderFormRepair.window).toBeUndefined();
    expect(rowsWithMembers(history)).toHaveLength(1);

    history = write(history, afterRow(GENDER_FORM_SAMPLE_SIZE), outcomes(ids('m2', GENDER_FORM_SAMPLE_SIZE + 30)));
    const carriers = rowsWithMembers(history);
    expect(carriers).toHaveLength(1);
    expect(carriers[0]).toBe(history.at(-1));
    expect(carriers[0].genderFormRepair.window.members.length).toBeLessThanOrEqual(GENDER_FORM_SAMPLE_SIZE);
    // The older after row keeps its summary numbers, only the state moved.
    expect(history[0].genderFormRepair.window.processed).toBeGreaterThan(0);
  });

  it('una storia senza window (o con members illeggibili) riparte da zero senza lanciare', () => {
    expect(readGenderFormWindowState([])).toEqual({ members: [], runs: 0 });
    expect(readGenderFormWindowState(null as any)).toEqual({ members: [], runs: 0 });
    const legacy = [afterRow(1), { label: 'after', genderFormRepair: { window: { members: ['nope', 7], runs: -1 } } }];
    expect(readGenderFormWindowState(legacy)).toEqual({ members: [], runs: 0 });
    const history = write(JSON.parse(JSON.stringify([afterRow(1)])), afterRow(2), outcomes(ids('fresh', 2)));
    expect(history.at(-1)!.genderFormRepair.window).toMatchObject({ processed: 2, runs: 1, measured: false });
  });

  it('una voce partial non stampa mai «measured» nella riga della run; la finestra ha la sua riga', () => {
    const history = write([], afterRow(10, 1, 11543), outcomes(ids('r', 10)));
    const lines = formatReport(history.at(-1)!);
    const runLine = lines.find((line) => line.includes('Gender-form after:'))!;
    expect(runLine).toContain('partial');
    expect(runLine).not.toMatch(/measured/);
    const windowLine = lines.find((line) => line.includes('Gender-form window:'))!;
    expect(windowLine).toContain('coda 11543');
    expect(windowLine).toContain("1 run dall'avvio");
    expect(windowLine).toContain(`accumulating 10/${GENDER_FORM_SAMPLE_SIZE}`);
    expect(windowLine).not.toMatch(/· measured/);
  });

  it('main() porta gli esiti dal pass after alla finestra, con storia e sidecar in una directory temporanea', () => {
    const SOURCE = 'Zimmermann/Zimmerin mit vielseitiger Erfahrung';
    const queued = (url: string): Job => slotComplete({
      url, slug: url, title: SOURCE, needsRetranslation: true,
      titleByLocale: {
        de: SOURCE,
        it: 'Zimmermann/Zimmerin con esperienza versatile',
        en: 'Carpenter with versatile experience',
        fr: 'Charpentier avec expérience polyvalente',
      },
    });
    const served = (url: string): Job => slotComplete({
      url, slug: url, title: SOURCE,
      titleByLocale: {
        de: SOURCE,
        it: 'Falegname con esperienza versatile',
        en: 'Carpenter with versatile experience',
        fr: 'Charpentier avec expérience polyvalente',
      },
    });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'translation-stats-window-'));
    try {
      const slices = path.join(tmp, 'data/jobs/by-crawler');
      fs.mkdirSync(slices, { recursive: true });
      const env = {
        ...process.env,
        TRANSLATION_STATS_ROOT: tmp,
        TRANSLATION_COHORT_FILE: path.join(tmp, 'cohort.json'),
      };
      const run = (label: string) => spawnSync(process.execPath, ['scripts/log-translation-stats.mjs', label], {
        cwd: ROOT, env, encoding: 'utf8',
      });
      let stdout = '';
      for (const prefix of ['first', 'second']) {
        const urls = ids(prefix, 3);
        fs.writeFileSync(path.join(slices, 'acme.json'), JSON.stringify(urls.map(queued)));
        expect(run('before').status).toBe(0);
        fs.writeFileSync(path.join(slices, 'acme.json'), JSON.stringify(urls.map(served)));
        const after = run('after');
        expect(after.status, after.stderr).toBe(0);
        stdout = after.stdout;
      }
      const history = JSON.parse(fs.readFileSync(path.join(tmp, 'data/translation-stats-history.json'), 'utf8'));
      expect(history.map((row: Row) => row.label)).toEqual(['before', 'after', 'before', 'after']);
      expect(rowsWithMembers(history)).toEqual([history.at(-1)]);
      expect(history.at(-1).genderFormRepair.measured).toBe(true); // per-run: 3/3 drained
      expect(history.at(-1).genderFormRepair.window).toMatchObject({
        processed: 6, residual: 0, runs: 2, measured: false, queueCandidates: 3,
      });
      expect(stdout).toContain('Gender-form window:');
      expect(stdout).toContain(`accumulating 6/${GENDER_FORM_SAMPLE_SIZE}`);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
