/**
 * Tests for the wrong-language job-title self-report loop:
 *   1. the audit's pure core (scripts/audit-job-title-locale.mjs)
 *   2. the scheduled workflow's CONTRACT — routing and, above all, closability
 *   3. the repair path's idempotence (scripts/mark-mistranslated-jobs.mjs)
 *
 * (2) is the part that earns its keep. `alert-pat-down.mjs` shipped an alert
 * whose only declared point of closure was a workflow that did not exist; with
 * title-based dedup that `priority:urgent` issue could never have been closed
 * by anything, and would have stayed open forever behind a green CI. That
 * contract had no import form, so no guard that follows imports could see it.
 * These assertions give this one a form a test CAN see.
 *
 * Everything here runs against inline fixtures: `data/jobs.json` is a build
 * artefact and `data/` is excluded from every sparse worktree in this repo.
 */
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { auditJobTitles } from '../scripts/audit-job-title-locale.mjs';
import {
  selectMistranslatedJobs,
  applyMarks,
  isAlreadyQueued,
  DEFAULT_MARK_CAP,
  DEFAULT_QUEUE_CEILING,
} from '../scripts/mark-mistranslated-jobs.mjs';
import { classifyIssue } from '../scripts/lib/classify-issue.mjs';
import { TITLE_RE } from '../scripts/ci/close-recovered-failure-issues.mjs';
import { inventory, coverageOf } from '../scripts/ci/failure-issue-inventory.mjs';

const ROOT = path.resolve(__dirname, '..');
const WORKFLOW_FILE = 'job-title-locale-audit.yml';
const WORKFLOW_PATH = path.join(ROOT, '.github', 'workflows', WORKFLOW_FILE);
const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf-8');

/** The workflow as the repo's own opener/closer parser sees it. */
const record = inventory().find((w: { file: string }) => w.file === WORKFLOW_FILE)!;
const metricOpener = record.openers.find(
  (o: { title: string }) => !/^(?:Workflow|Crawler|CI) Failure:/.test(o.title)
);
const ISSUE_TITLE: string | undefined = metricOpener?.title;

/** A DE-source job with a broken IT slot and correct EN/FR slots. */
const brokenJob = {
  slug: 'fachfrau-gesundheit-aarreha',
  company: 'aarReha Schinznach',
  location: 'Schinznach-Bad',
  canton: 'AG',
  sourceLang: 'de',
  titleByLocale: {
    de: 'Lehrstelle 2027 als Fachfrau / Fachmann Gesundheit EFZ',
    it: 'Apprendistato 2027 come Fachfrau / Fachmann Gesundheit CFC',
    en: 'Apprenticeship 2027 as a healthcare professional',
    fr: "Apprentissage 2027 comme professionnel de la santé",
  },
};

/**
 * A DE-source job whose three target slots are all correct.
 *
 * The French slot deliberately avoids the article `des`: `titleLooksUntranslated`
 * scans GERMAN markers against every non-source slot, and German `des` is also
 * an everyday French word, so "Directeur des opérations" reads as a
 * `source-function-word` hit. That is a real (measured) false positive in the
 * detector's lexicon — 1,967 flags on live FR titles, isolated by the audit's
 * `topEvidence` table — and not something this fixture should encode as normal.
 */
const cleanJob = {
  slug: 'infermiere-diplomato-ksa',
  company: 'Kantonsspital Aarau',
  location: 'Aarau',
  canton: 'AG',
  sourceLang: 'de',
  titleByLocale: {
    de: 'Betriebsleiter Logistik',
    it: 'Direttore operativo logistica',
    en: 'Operations director logistics',
    fr: 'Directeur opérationnel logistique',
  },
};

describe('audit-job-title-locale — pure core', () => {
  it('counts only non-source, non-empty title slots', () => {
    const report = auditJobTitles([
      { ...cleanJob, titleByLocale: { de: 'Betriebsleiter Logistik', it: 'Direttore operativo logistica' } },
    ]);
    // de is the source slot, fr/en are empty => exactly one slot audited.
    expect(report.slots).toBe(1);
  });

  it('flags a partially-translated slot and leaves the correct siblings alone', () => {
    const report = auditJobTitles([brokenJob]);
    expect(report.slots).toBe(3);
    expect(report.flagged).toBe(1);
    expect(report.jobsFlagged).toBe(1);
    expect(report.byTargetLocale.it.flagged).toBe(1);
    expect(report.byTargetLocale.en.flagged).toBe(0);
    expect(report.byTargetLocale.fr.flagged).toBe(0);
    expect(report.samples[0].targetLocale).toBe('it');
    expect(report.samples[0].evidence).toBeTruthy();
  });

  it('reports a rate, not just a count — and computes it per dimension', () => {
    const report = auditJobTitles([brokenJob, cleanJob]);
    expect(report.slots).toBe(6);
    expect(report.flagged).toBe(1);
    expect(report.rate).toBeCloseTo(1 / 6, 6);
    expect(report.bySourceLang.de.slots).toBe(6);
    expect(report.byCompany[0]).toMatchObject({ company: 'aarReha Schinznach', flagged: 1 });
    expect(report.byCanton[0]).toMatchObject({ canton: 'AG', flagged: 1 });
  });

  it('separates the already-queued backlog from the actionable one', () => {
    const report = auditJobTitles([
      { ...brokenJob, needsRetranslation: true },
      { ...brokenJob, slug: 'other', localeMismatchSuppressed: true },
      { ...brokenJob, slug: 'fresh' },
    ]);
    expect(report.flagged).toBe(3); // the site serves all three
    expect(report.actionable.flagged).toBe(1); // only one is still repairable
    expect(report.actionable.jobs).toBe(1);
    expect(report.queued).toEqual({ needsRetranslation: 1, localeMismatchSuppressed: 1 });
  });

  it('groups the literal marker token so a detector lexicon bug is visible next to a real one', () => {
    const report = auditJobTitles([brokenJob, { ...brokenJob, slug: 'dup' }]);
    expect(report.topEvidence[0]).toMatchObject({ targetLocale: 'it', count: 2 });
    expect(report.topEvidence[0].reason).toBeTruthy();
  });

  it('bounds the output instead of dumping the whole backlog', () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ ...brokenJob, slug: `job-${i}` }));
    const report = auditJobTitles(many, { samples: 5, top: 3 });
    expect(report.flagged).toBe(50);
    expect(report.samples).toHaveLength(5);
    expect(report.byCompany.length).toBeLessThanOrEqual(3);
  });

  it('never throws on half-populated or absent records', () => {
    expect(() => auditJobTitles([])).not.toThrow();
    expect(() => auditJobTitles(null as never)).not.toThrow();
    expect(() => auditJobTitles([{}, { titleByLocale: null }, { sourceLang: 'de' }] as never)).not.toThrow();
    expect(auditJobTitles([{}] as never).slots).toBe(0);
  });
});

/**
 * #5587 item2 — the audit had no per-slot count of gender trigraphs left in a
 * non-locale form, even though the masking/localizing infrastructure that
 * would fix them (scripts/lib/translation-glossary.mjs) already existed from
 * #5562/#5571. This is a SEPARATE dimension from `flagged`/`untranslated`
 * above: a title can pass the language check and still carry a raw "(m/w/d)".
 */
describe('audit-job-title-locale — gender trigraph per-slot count (#5587 item2)', () => {
  /** A DE-source job with a raw German trigraph left in the IT slot. */
  const trigraphJob = {
    slug: 'leiter-umweltlabor',
    company: 'Umweltlabor AG',
    location: 'Aarau',
    canton: 'AG',
    sourceLang: 'de',
    titleByLocale: {
      de: 'Leiter Umweltlabor (m/w/d)',
      it: 'Responsabile Laboratorio Ambientale (m/w/d)', // raw German pair — not localized
      en: 'Environmental Lab Manager (m/f/d)', // already the correct EN form
      fr: 'Responsable Laboratoire Environnemental', // no trigraph at all
    },
  };

  it('counts a raw (m/w/d) left in a non-German slot as unlocalized', () => {
    const report = auditJobTitles([trigraphJob]);
    expect(report.genderTrigraph.slots).toBe(3); // it/en/fr — de is the source slot
    expect(report.genderTrigraph.flagged).toBe(1); // only it
    expect(report.genderTrigraph.byTargetLocale.it).toMatchObject({ slots: 1, flagged: 1 });
    expect(report.genderTrigraph.byTargetLocale.en).toMatchObject({ slots: 1, flagged: 0 });
    expect(report.genderTrigraph.byTargetLocale.fr).toMatchObject({ slots: 1, flagged: 0 });
  });

  it('does not conflate the trigraph count with the untranslated-language count', () => {
    // The IT slot above is a genuinely correct Italian translation of the
    // title (titleLooksUntranslated must NOT flag it) — the trigraph count is
    // the only signal that catches the leftover "(m/w/d)".
    const report = auditJobTitles([trigraphJob]);
    expect(report.flagged).toBe(0);
    expect(report.genderTrigraph.flagged).toBe(1);
  });

  it('does not flag a slot whose trigraph is already in the correct locale form', () => {
    const report = auditJobTitles([
      { ...trigraphJob, titleByLocale: { ...trigraphJob.titleByLocale, it: 'Responsabile Laboratorio Ambientale (m/f/d)' } },
    ]);
    expect(report.genderTrigraph.flagged).toBe(0);
  });

  it('does not flag a slot with no trigraph at all', () => {
    const report = auditJobTitles([cleanJob]);
    expect(report.genderTrigraph.flagged).toBe(0);
    expect(report.genderTrigraph.slots).toBe(3);
  });

  it('reports a rate alongside the count, consistent with the rest of the audit', () => {
    const report = auditJobTitles([trigraphJob, cleanJob]);
    expect(report.genderTrigraph.slots).toBe(6);
    expect(report.genderTrigraph.flagged).toBe(1);
    expect(report.genderTrigraph.rate).toBeCloseTo(1 / 6, 6);
  });
});

describe('job-title-locale-audit.yml — issue contract', () => {
  it('opens exactly one stable metric title', () => {
    expect(ISSUE_TITLE, 'no non-failure issue opener found in the workflow').toBeTruthy();
    // Dedup matches on the first 60 chars, so the title must be a stable literal
    // with no run-varying interpolation in that window.
    expect(ISSUE_TITLE!.length).toBeLessThanOrEqual(60);
    expect(ISSUE_TITLE).not.toMatch(/\$\{\{|\$[A-Z_]/);
  });

  it('IS COVERED BY A CLOSER, per the repo\'s own opener/closer model', () => {
    // The decisive assertion. `coverageOf` is the same function
    // tests/failure-issue-closers.test.ts gates the whole repo with: it returns
    // `sibling-resolve-step` only when a `--resolve` step exists in THIS
    // workflow carrying a byte-identical title to the opener. That is precisely
    // what `alert-pat-down.mjs` lacked while claiming otherwise in a comment.
    expect(coverageOf(metricOpener, record)).toEqual({ by: 'sibling-resolve-step' });
    // ...and the crash reporter is covered by the central reconciler, which
    // requires the name in the title to equal the workflow's `name:`.
    const crashOpener = record.openers.find((o: { title: string }) => TITLE_RE.test(o.title));
    expect(coverageOf(crashOpener, record)).toEqual({ by: 'close-recovered-failure-issues' });
  });

  it('ships a closer that actually exists: --resolve is implemented and closes', () => {
    expect(workflow).toMatch(/--resolve/);
    // Prove the mechanism rather than trusting the flag name.
    const creator = fs.readFileSync(path.join(ROOT, 'scripts', 'lib', 'github-issue-creator.mjs'), 'utf-8');
    expect(creator).toMatch(/args\.includes\('--resolve'\)/);
    expect(creator).toMatch(/export function resolveGithubIssue/);
    expect(creator).toMatch(/'issue', 'close'/);
  });

  it('does NOT rely on close-recovered-failure-issues.yml for the metric issue', () => {
    // The central reconciler only handles `Workflow|Crawler|CI Failure:` titles
    // AND decides on the workflow's own run conclusion, which is green here
    // whatever the metric says. Asserting the non-match documents WHY the
    // sibling resolve step is load-bearing rather than redundant.
    expect(TITLE_RE.test(ISSUE_TITLE!)).toBe(false);
  });

  it('routes into the agent:fix-queued pipeline, never the immediate crawler route', () => {
    const labels = ['priority:medium', 'job-title-locale', 'bug'];
    const decision = classifyIssue(ISSUE_TITLE!, labels);
    expect(decision.category).toBe('other');
    expect(decision.route).toBe('queue'); // -> agent:fix-queued, drained by followup-drainer
    expect(decision.autofix).toBe(true);
    expect(decision.fuPrio).toBe('low');
  });

  it('never mints a duplicate when the metric flaps back after a close', () => {
    expect(workflow).toMatch(/--reopen-within-hours \d+/);
  });

  it('says nothing at all when there is no dataset to measure', () => {
    // A silent run is correct; asserting health on an empty measurement would
    // close a real defect's issue. Both issue steps are gated on the computed
    // action, so `skip` touches neither.
    expect(workflow).toMatch(/datasetPresent/);
    expect(workflow).toMatch(/'skip'/);
    expect(workflow).toMatch(/if: steps\.body\.outputs\.action == 'alert'/);
    expect(workflow).toMatch(/if: steps\.body\.outputs\.action == 'resolve'/);
  });
});

describe('mark-mistranslated-jobs — idempotent title marking', () => {
  it('selects a job with a wrong-language title', () => {
    const sel = selectMistranslatedJobs([brokenJob]);
    expect(sel.slugs.has(brokenJob.slug)).toBe(true);
    expect(sel.titleHits).toBe(1);
  });

  it('leaves a correctly-translated job alone', () => {
    expect(selectMistranslatedJobs([cleanJob]).slugs.size).toBe(0);
  });

  it('skips jobs already queued or given up on — the anti-loop guard', () => {
    expect(isAlreadyQueued({ needsRetranslation: true })).toBe(true);
    expect(isAlreadyQueued({ localeMismatchSuppressed: true })).toBe(true);
    expect(isAlreadyQueued({})).toBe(false);

    const sel = selectMistranslatedJobs([
      { ...brokenJob, needsRetranslation: true },
      { ...brokenJob, slug: 'suppressed', localeMismatchSuppressed: true },
    ]);
    expect(sel.slugs.size).toBe(0);
    expect(sel.eligible).toBe(0);
  });

  it('is idempotent: a second pass over the marked dataset selects nothing new', () => {
    const jobs = [brokenJob, { ...brokenJob, slug: 'second' }, cleanJob].map((j) => ({ ...j }));
    const first = selectMistranslatedJobs(jobs);
    expect(first.slugs.size).toBe(2);
    expect(applyMarks(jobs, first.slugs)).toBe(2);

    const second = selectMistranslatedJobs(jobs);
    expect(second.slugs.size).toBe(0);
    // And applying the first selection again mutates nothing.
    expect(applyMarks(jobs, first.slugs)).toBe(0);
  });

  it('caps how many jobs one run may flag, and reports the true remainder', () => {
    const jobs = Array.from({ length: 10 }, (_, i) => ({ ...brokenJob, slug: `job-${i}` }));
    const sel = selectMistranslatedJobs(jobs, { cap: 3 });
    expect(sel.slugs.size).toBe(3);
    expect(sel.capped).toBe(true);
    expect(sel.remaining).toBe(7);
  });

  it('caps at the cascade throughput, not at the backlog', () => {
    // The only step that rewrites a partially-translated title is the
    // quota-bound cascade in translate-pending.yml Phase 2b (`--max-jobs`
    // default 100). Marking faster than that grows a queue that never drains.
    expect(DEFAULT_MARK_CAP).toBeGreaterThan(0); // never unlimited by default
    const yml = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'translate-pending.yml'), 'utf-8');
    const cascadeDefault = Number((yml.match(/INPUT_MAX_JOBS:\s*\$\{\{\s*inputs\.max_jobs\s*\|\|\s*'(\d+)'/) || [])[1]);
    expect(cascadeDefault).toBeGreaterThan(0);
    expect(DEFAULT_MARK_CAP).toBeLessThanOrEqual(cascadeDefault);
  });

  it('applies backpressure: marks nothing while the retranslation queue is at its ceiling', () => {
    const queued = Array.from({ length: 5 }, (_, i) => ({ slug: `q-${i}`, needsRetranslation: true }));
    const fresh = Array.from({ length: 5 }, (_, i) => ({ ...brokenJob, slug: `fresh-${i}` }));
    const sel = selectMistranslatedJobs([...queued, ...fresh], { queueCeiling: 5 });
    expect(sel.throttled).toBe(true);
    expect(sel.queueDepth).toBe(5);
    expect(sel.slugs.size).toBe(0);

    // Below the ceiling it works normally again.
    const ok = selectMistranslatedJobs([...queued, ...fresh], { queueCeiling: 6 });
    expect(ok.throttled).toBe(false);
    expect(ok.slugs.size).toBe(5);
    expect(DEFAULT_QUEUE_CEILING).toBeGreaterThan(0);
  });

  it('still catches wrong-language descriptions when titles are switched off', () => {
    const germanDescription = 'Wir suchen eine engagierte Mitarbeiterin für unser Team in der Pflege. '
      + 'Die Stelle umfasst die Betreuung von Patienten und die Zusammenarbeit mit den Ärzten der Klinik. '
      + 'Sie arbeiten selbständig und übernehmen Verantwortung für die tägliche Organisation der Abteilung.';
    const jobs = [{ slug: 'desc-only', sourceLang: 'de', descriptionByLocale: { it: germanDescription } }];
    const sel = selectMistranslatedJobs(jobs, { titles: false });
    expect(sel.slugs.has('desc-only')).toBe(true);
    expect(sel.descriptionHits).toBe(1);
  });

  it('applyMarks never clears an existing flag', () => {
    const jobs = [{ slug: 'a', needsRetranslation: true }];
    applyMarks(jobs, new Set(['a']));
    expect(jobs[0].needsRetranslation).toBe(true);
  });
});

describe('translate-pending.yml — the repair path is actually scheduled', () => {
  it('runs mark-mistranslated-jobs.mjs with both a per-run cap and backpressure', () => {
    const yml = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'translate-pending.yml'), 'utf-8');
    expect(yml).toMatch(/node scripts\/mark-mistranslated-jobs\.mjs/);
    expect(yml).toMatch(/TITLE_MISTRANSLATION_MARK_CAP/);
    expect(yml).toMatch(/TITLE_MISTRANSLATION_QUEUE_CEILING/);
    // Before this PR the script was in NO workflow at all — that was defect S13,
    // the reason the only title-language repair tooling in the repo had never run.
    expect((yml.match(/mark-mistranslated-jobs\.mjs/g) || []).length).toBeGreaterThanOrEqual(1);
  });
});

describe('post-deploy-validate-dist.yml — the audit runs on every deploy, report-only and unsampled', () => {
  const POSTDEPLOY = fs.readFileSync(
    path.join(ROOT, '.github', 'workflows', 'post-deploy-validate-dist.yml'),
    'utf-8'
  );
  const AUDIT_ALL = fs.readFileSync(path.join(ROOT, 'scripts', 'audit-all.mjs'), 'utf-8');

  /**
   * The subshell that launches the audit inside the capped pool — CODE only.
   * Anchored on a line that *starts* with the command, because the rationale
   * comment above it quotes the same command and every flag it deliberately
   * does not pass; slicing from the first textual occurrence would swallow the
   * comment (and the neighbouring Discover block) and make every assertion
   * below vacuous in the direction that matters.
   */
  const block = (() => {
    const lines = POSTDEPLOY.split('\n');
    const cmd = lines.findIndex((l) => /^\s*npm run audit:job-title-locale\b/.test(l));
    if (cmd < 0) return '';
    let start = cmd;
    while (start > 0 && !/^\s*wait_slot\s*$/.test(lines[start])) start -= 1;
    let end = cmd;
    while (end < lines.length - 1 && !/^\s*\)\s*&\s*$/.test(lines[end])) end += 1;
    return lines.slice(start, end + 1).join('\n');
  })();

  it('the extracted block is the launch code, not the prose around it', () => {
    // Guards the guard: an empty or over-wide slice would make the
    // `not.toMatch` assertions below pass for the wrong reason.
    expect(block).toMatch(/^\s*wait_slot\s*$/m);
    expect(block).toMatch(/^\s*npm run audit:job-title-locale\b/m);
    expect(block.split('\n').length).toBeLessThan(20);
  });

  it('is reachable from the workflow at all — the guard tests/deploy-workflow.test.ts enforces', () => {
    // An `audit:*` script in package.json that no workflow invokes is an audit
    // that never runs. This is the same reachability assertion, stated from the
    // audit's side so the reason it holds lives next to the audit.
    expect(POSTDEPLOY).toMatch(/npm run audit:job-title-locale\b/);
  });

  it('is NOT a gate: no spawn_capped, and the timings row hard-codes rc=0', () => {
    // spawn_capped's contract is a GATE — a non-zero rc reaches
    // /tmp/post-build-failures.txt, fails the step and, via the default-deny
    // classify-validate-dist-failures.mjs, sequesters `publish`. ~30% of title
    // slots flag today, so gating here would block every deploy on a defect
    // that predates the measurement by months.
    expect(POSTDEPLOY).not.toMatch(/spawn_capped\s+audit:job-title-locale/);
    expect(block).toMatch(/rc=0/);
    // The redirection, not the word: the block's own log line SAYS
    // "post-build-failures.txt" to explain that it never writes there.
    expect(block).not.toMatch(/>>\s*\/tmp\/post-build-failures\.txt/);
    // --max-rate is the only flag that makes the script exit non-zero. Passing
    // it here would turn the report into a gate through the back door.
    expect(block).not.toMatch(/--max-rate/);
  });

  it('is NOT registered in audit-all.mjs — that would sample it at AUDIT_SAMPLE_RATE in silence', () => {
    // audit-all.mjs reads AUDIT_SAMPLE_RATE (pinned to '0.25' in this
    // workflow's env), so registering there inherits a 25% sample with nothing
    // written anywhere saying so. This audit's whole output is a published RATE
    // that tests/job-locale-consistency.test.ts ratchets against, and the
    // weekly job-title-locale-audit.yml runs the same script unsampled — the
    // two would disagree for no reason a reader could see. It is also
    // structurally impossible: audit-all's REGISTRY entries are per-dist-file
    // auditor factories, and this audit reads data/jobs.json, never dist/.
    expect(AUDIT_ALL).not.toMatch(/name:\s*['"]job-title-locale['"]/);
    expect(POSTDEPLOY).toMatch(/AUDIT_SAMPLE_RATE:\s*'0\.25'/);
  });

  it('prints its summary into the job log, on red runs too', () => {
    // The pool `cat`s gate logs only in the FAILURE branch, and this block has
    // no failure branch by construction: without an explicit cat the audit
    // would run and print nowhere. Printed before the FAIL aggregation so a red
    // gate elsewhere cannot swallow it.
    expect(POSTDEPLOY).toMatch(/cat \/tmp\/job-title-locale\.log/);
  });
});
