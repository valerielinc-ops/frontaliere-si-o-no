/**
 * audit-job-description-locale — the measurement, and the issue contract around it.
 *
 * WHAT THIS FILE IS FOR. The audit exists because on 2026-08-11 the DESCRIPTIONS
 * ratchet in tests/job-locale-consistency.test.ts breached and reddened every
 * open PR at once, with no signal naming the cause: the gate speaks only inside
 * a PR run, prints no offenders, and the defect was in main's DATA, so no branch
 * could fix it. Two things therefore have to hold forever, and both are asserted
 * here:
 *
 *   1. the audit measures the SAME number the gate does — otherwise the alert
 *      is about a different metric than the one breaking CI;
 *   2. the alert it opens can actually be CLOSED, by the repo's own
 *      opener/closer model rather than by a comment claiming so. That is the
 *      alert-pat-down.mjs incident, and it is why the closer assertions below
 *      go through `coverageOf` instead of grepping for a step name.
 */
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { auditDescriptionLocales, MAX_RATE, DEFAULT_MIN_HEADROOM_PP } from '../scripts/audit-job-description-locale.mjs';
import { evaluateQueueAlarm } from '../scripts/lib/queue-alarm.mjs';
import { classifyIssue } from '../scripts/lib/classify-issue.mjs';
import { TITLE_RE } from '../scripts/ci/close-recovered-failure-issues.mjs';
import { inventory, coverageOf } from '../scripts/ci/failure-issue-inventory.mjs';

const ROOT = path.resolve(__dirname, '..');
const WORKFLOW_FILE = 'job-description-locale-audit.yml';
const WORKFLOW_PATH = path.join(ROOT, '.github', 'workflows', WORKFLOW_FILE);
const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf-8');

const record = inventory().find((w: { file: string }) => w.file === WORKFLOW_FILE)!;
const metricOpener = record.openers.find(
  (o: { title: string }) => !/^(?:Workflow|Crawler|CI) Failure:/.test(o.title)
);
const ISSUE_TITLE: string | undefined = metricOpener?.title;

/**
 * Real shapes, not invented ones. The German paragraph is the defect family that
 * caused the breach: a DE-source apprenticeship posting whose `it` slot holds a
 * byte-identical copy of the source. Measured with the shipped detector, it
 * reads `de` at 0.72 — above the 0.65 gate threshold.
 */
const DE_TEXT =
  'Akten vorbereiten, überprüfen und archivieren. Kontakt mit Rekrutenschulen und externen '
  + 'Partnern pflegen. E-Mails, Briefe und Protokolle schreiben; Telefonzentrale und Postbüro '
  + 'betreuen. Präsentationen vorbereiten und Sitzungen organisieren.';
const IT_TEXT =
  'Preparare, verificare e archiviare i documenti. Mantenere i contatti con le scuole reclute '
  + 'e i partner esterni. Scrivere e-mail, lettere e verbali; gestire il centralino e l ufficio '
  + 'postale. Preparare presentazioni e organizzare riunioni.';

/** DE-source job whose `it` slot is an untranslated copy of the source. */
const sourceCopyJob = {
  slug: 'apprendista-kaufmann-frau-thun',
  company: 'Confederazione Svizzera',
  sourceLang: 'de',
  descriptionByLocale: { de: DE_TEXT, it: DE_TEXT, en: IT_TEXT, fr: IT_TEXT },
};

/** Every slot in the language its key claims. */
const cleanJob = {
  slug: 'infermiere-diplomato-ksa',
  company: 'Kantonsspital Aarau',
  sourceLang: 'de',
  descriptionByLocale: { de: DE_TEXT, it: IT_TEXT, en: IT_TEXT, fr: IT_TEXT },
};

describe('audit-job-description-locale — pure core', () => {
  it('flags a wrong-language slot and leaves the correct siblings alone', () => {
    const r = auditDescriptionLocales([sourceCopyJob]);
    expect(r.flagged).toBe(1);
    expect(r.offenders[0]).toMatchObject({ locale: 'it', detected: 'de', company: 'Confederazione Svizzera' });
  });

  it('counts every eligible slot as denominator, not just the bad ones', () => {
    const r = auditDescriptionLocales([sourceCopyJob]);
    expect(r.slots).toBe(4);
    expect(r.rate).toBeCloseTo(0.25, 5);
  });

  it('does not flag a job whose slots are all in the right language', () => {
    const r = auditDescriptionLocales([cleanJob]);
    expect(r.flagged).toBe(0);
    expect(r.rate).toBe(0);
  });

  it('keeps a queued job in the DENOMINATOR but never in the numerator', () => {
    // The population is queue-free (#5638): `needsRetranslation` is a pipeline
    // queue that doubles overnight on a crawler wave, so defining the population
    // as its complement made the gate report a quality movement for a queue
    // movement. Slots stay counted; only the detection is skipped.
    //
    // This assertion inverts the one it replaces, which expected slots === 0.
    // That version encoded the pre-#5638 definition and, kept as-is, would have
    // pinned the audit to a denominator the gate no longer uses.
    const r = auditDescriptionLocales([{ ...sourceCopyJob, needsRetranslation: true }]);
    expect(r.flagged).toBe(0);
    expect(r.slots).toBe(4);
    expect(r.servedSlots).toBe(0);
    expect(r.rate).toBe(0);
  });

  it('flags GATE-BLIND when the served slice collapses', () => {
    // The failure mode that looks exactly like health: if almost nothing is
    // served, almost nothing is measured and the rate goes green because the
    // gate can no longer see. Distinct alarm from a breach, on purpose.
    const blind = auditDescriptionLocales([{ ...sourceCopyJob, needsRetranslation: true }]);
    expect(blind.gateBlind).toBe(true);
    expect(blind.servedShare).toBe(0);

    const healthy = auditDescriptionLocales([sourceCopyJob]);
    expect(healthy.gateBlind).toBe(false);
    expect(healthy.servedShare).toBe(1);
  });

  it('takes its rate from the gate\'s own measurement, not a copy of it', () => {
    // Parity by CONSTRUCTION rather than by a pinned constant: both sides call
    // measureDescriptionLocales, so the denominators cannot drift apart again.
    const audit = fs.readFileSync(path.join(ROOT, 'scripts', 'audit-job-description-locale.mjs'), 'utf-8');
    expect(audit).toMatch(/measureDescriptionLocales/);
    expect(audit).toMatch(/from '\.\/lib\/job-locale-population\.mjs'/);
    const gate = fs.readFileSync(path.join(ROOT, 'tests', 'job-locale-consistency.test.ts'), 'utf-8');
    expect(gate).toMatch(/measureDescriptionLocales/);
  });

  it('separates the free-to-repair source copies from the rest', () => {
    // A byte-identical copy of the source is repairable by the free Argos
    // mop-up; anything else needs the quota-bound cascade. The split is what
    // tells a reader whether a breach is cheap or expensive to clear.
    const r = auditDescriptionLocales([sourceCopyJob]);
    expect(r.sourceCopyCount).toBe(1);
    expect(r.offenders[0].sourceCopy).toBe(true);
  });

  it('reports headroom and breach against the ratchet, not just a rate', () => {
    const breach = auditDescriptionLocales([sourceCopyJob]);
    expect(breach.breached).toBe(true);
    expect(breach.headroomPp).toBeLessThan(0);

    const healthy = auditDescriptionLocales([cleanJob]);
    expect(healthy.breached).toBe(false);
    expect(healthy.headroomPp).toBeCloseTo(MAX_RATE * 100, 5);
  });

  it('groups offenders by company and by direction', () => {
    const r = auditDescriptionLocales([sourceCopyJob]);
    expect(r.topCompanies[0]).toEqual({ key: 'Confederazione Svizzera', count: 1 });
    expect(r.topPairs[0]).toEqual({ key: 'de->it', count: 1 });
  });

  it('counts an actionable job separately from a suppressed one', () => {
    const suppressed = { ...sourceCopyJob, localeMismatchSuppressed: true };
    expect(auditDescriptionLocales([suppressed]).actionableJobs).toBe(0);
    expect(auditDescriptionLocales([sourceCopyJob]).actionableJobs).toBe(1);
  });

  it('ignores slots under the 120-char floor, exactly as the gate does', () => {
    const short = { slug: 's', company: 'c', sourceLang: 'de', descriptionByLocale: { it: 'Kurz und knapp.' } };
    expect(auditDescriptionLocales([short]).slots).toBe(0);
  });

  it('bounds the offender list instead of dumping the whole backlog', () => {
    const many = Array.from({ length: 300 }, (_, i) => ({ ...sourceCopyJob, slug: `job-${i}` }));
    const r = auditDescriptionLocales(many);
    expect(r.flagged).toBe(300);
    expect(r.offenders.length).toBe(200);
  });

  it('never throws on half-populated or absent records', () => {
    expect(() => auditDescriptionLocales([{}, null as any, { descriptionByLocale: null } as any])).not.toThrow();
    expect(auditDescriptionLocales([]).datasetPresent).toBe(false);
  });
});

describe('measurement parity with the gate it reports on', () => {
  it('uses the same MAX_RATE as the descriptions ratchet in job-locale-consistency', () => {
    // The constant is duplicated (this script must not import a vitest file), so
    // the duplication is pinned here. If they ever diverge, the audit reports
    // health while CI is red — strictly worse than having no audit at all.
    const gate = fs.readFileSync(path.join(ROOT, 'tests', 'job-locale-consistency.test.ts'), 'utf-8');
    // Anchor on the DESCRIPTIONS assertion: the titles ratchet declares its own
    // MAX_RATE later in the same file, and matching that one would pin the wrong
    // number while looking correct.
    const anchor = gate.indexOf('localized descriptions are not stored under the wrong locale');
    expect(anchor, 'descriptions assertion not found — did the gate get renamed?').toBeGreaterThan(-1);
    const match = /const MAX_RATE = ([0-9.]+);/.exec(gate.slice(anchor));
    expect(match, 'no MAX_RATE found after the descriptions assertion').toBeTruthy();
    expect(Number(match![1])).toBe(MAX_RATE);
  });

  it('applies the same confidence floor and minimum length as the gate', () => {
    // WHERE the gate keeps its thresholds is not the point — that the NUMBERS
    // agree is. The first version of this test read them out of
    // tests/job-locale-consistency.test.ts only, which pinned a location rather
    // than a value: #5638 moves the measurement into
    // scripts/lib/job-locale-population.mjs, and this assertion would have gone
    // red on a change that altered nothing it actually cares about — turning
    // main red on every open PR, which is the exact failure this whole audit
    // exists to prevent.
    const GATE_SOURCES = [
      path.join(ROOT, 'tests', 'job-locale-consistency.test.ts'),
      path.join(ROOT, 'scripts', 'lib', 'job-locale-population.mjs'),
    ].filter((p) => fs.existsSync(p));
    expect(GATE_SOURCES.length, 'no gate source found at all').toBeGreaterThan(0);
    const gate = GATE_SOURCES.map((p) => fs.readFileSync(p, 'utf-8')).join('\n');

    // 120-char floor, in either the inline or the extracted form.
    expect(gate, 'the gate no longer applies a 120-char description floor').toMatch(
      /(?:description|desc)\.length < 120|MIN_DESCRIPTION_CHARS\s*=\s*120|minLength\s*=\s*120/
    );
    // 0.65 confidence floor, likewise.
    expect(gate, 'the gate no longer applies a 0.65 confidence floor').toMatch(
      /confidence\s*>=\s*0\.65|minConfidence\s*=\s*0\.65|MIN_CONFIDENCE\s*=\s*0\.65/
    );

    const audit = fs.readFileSync(path.join(ROOT, 'scripts', 'audit-job-description-locale.mjs'), 'utf-8');
    expect(audit).toMatch(/MIN_DESCRIPTION_CHARS = 120/);
    expect(audit).toMatch(/DESCRIPTION_CONFIDENCE = 0\.65/);
  });
});

describe('job-description-locale-audit.yml — issue contract', () => {
  it('opens exactly one stable metric title', () => {
    expect(ISSUE_TITLE, 'no non-failure issue opener found in the workflow').toBeTruthy();
    // Dedup matches on the first 60 chars, so the title must be a stable literal
    // with no run-varying interpolation in that window.
    expect(ISSUE_TITLE!.length).toBeLessThanOrEqual(60);
    expect(ISSUE_TITLE).not.toMatch(/\$\{\{|\$[A-Z_]/);
  });

  it('does not collide with the title audit under 60-char dedup', () => {
    // Both audits open a canonical metric issue. If their first 60 chars matched,
    // one would comment on the other's issue forever and neither would be
    // closable by its own twin step.
    const sibling = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'job-title-locale-audit.yml'), 'utf-8');
    const siblingTitle = /--title "([^"]+)"/.exec(sibling)?.[1];
    expect(siblingTitle).toBeTruthy();
    expect(ISSUE_TITLE!.slice(0, 60)).not.toBe(siblingTitle!.slice(0, 60));
  });

  it('IS COVERED BY A CLOSER, per the repo\'s own opener/closer model', () => {
    expect(coverageOf(metricOpener, record)).toEqual({ by: 'sibling-resolve-step' });
    const crashOpener = record.openers.find((o: { title: string }) => TITLE_RE.test(o.title));
    expect(coverageOf(crashOpener, record)).toEqual({ by: 'close-recovered-failure-issues' });
  });

  it('does NOT rely on close-recovered-failure-issues.yml for the metric issue', () => {
    expect(TITLE_RE.test(ISSUE_TITLE!)).toBe(false);
  });

  it('routes into the agent:fix-queued pipeline, never the immediate crawler route', () => {
    const labels = ['priority:medium', 'job-description-locale', 'bug'];
    const decision = classifyIssue(ISSUE_TITLE!, labels);
    expect(decision.category).toBe('other');
    expect(decision.route).toBe('queue');
    expect(decision.autofix).toBe(true);
    expect(decision.fuPrio).toBe('low');
  });

  it('never mints a duplicate when the metric flaps back after a close', () => {
    expect(workflow).toMatch(/--reopen-within-hours \d+/);
  });

  it('says nothing at all when there is no dataset to measure', () => {
    // Closing the tracking issue on an empty run is how a real defect
    // disappears from the tracker.
    expect(workflow).toMatch(/datasetPresent/);
    expect(workflow).toMatch(/'skip'/);
  });

  it('alerts on a thin margin, not only on a breach', () => {
    // The state that made this audit necessary: green by dilution, 0.011pp of
    // headroom, indistinguishable from healthy to every other signal.
    expect(workflow).toMatch(/min_headroom_pp/);
    expect(workflow).toMatch(/r\.breached \|\| r\.thinMargin/);
    expect(DEFAULT_MIN_HEADROOM_PP).toBeGreaterThan(0);
  });
});

describe('allarme sulla coda ferma', () => {
  // `Number(q.staleSourceCopyJobs || 0) > soglia` diceva «coda a posto» quando
  // il campo mancava: 0 > 100 e' falso. Un falso negativo silenzioso su un
  // allarme, prodotto dall'unico input che l'allarme esiste per sorvegliare.

  it('misura e confronta quando il conteggio e leggibile', () => {
    expect(evaluateQueueAlarm(180, 100)).toEqual({
      valid: true, queueStuck: true, count: 180, threshold: 100,
    });
    expect(evaluateQueueAlarm('4', '100')).toEqual({
      valid: true, queueStuck: false, count: 4, threshold: 100,
    });
  });

  it('la soglia e un confronto stretto: uguale non e superata', () => {
    expect(evaluateQueueAlarm(100, 100).queueStuck).toBe(false);
    expect(evaluateQueueAlarm(101, 100).queueStuck).toBe(true);
  });

  it('un conteggio illeggibile NON e una coda sana', () => {
    // Il caso che il vecchio codice ingoiava: campo assente.
    for (const bad of [undefined, null, '', '  ', {}, [], true, NaN, Infinity, -1, 3.5, 'molti']) {
      const alarm = evaluateQueueAlarm(bad, 100);
      expect(alarm.valid, `input ${JSON.stringify(bad)}`).toBe(false);
      expect(alarm.queueStuck, `input ${JSON.stringify(bad)}`).toBe(true);
      expect(alarm.count).toBeNull();
    }
  });

  it('anche una soglia illeggibile invalida la misura', () => {
    expect(evaluateQueueAlarm(4, '')).toMatchObject({ valid: false, queueStuck: true });
    expect(evaluateQueueAlarm(4, undefined)).toMatchObject({ valid: false, queueStuck: true });
  });

  it('zero e un conteggio valido, non un input mancante', () => {
    expect(evaluateQueueAlarm(0, 100)).toEqual({
      valid: true, queueStuck: false, count: 0, threshold: 100,
    });
    expect(evaluateQueueAlarm('0', '0')).toMatchObject({ valid: true, queueStuck: false });
  });

  it('rifiuta le forme numeriche esotiche che Number() accetterebbe', () => {
    // `0x64` vale 100 e `1e3` vale 1000: entrambi interi e non negativi. Una
    // repo var scritta cosi' diventerebbe silenziosamente un numero diverso da
    // quello che sembra, che e' l'opposto di cio' che questo parser serve a fare.
    for (const esotico of ['0x64', '1e3', '+5', '5.0', ' 1_0 ', '١٢٣']) {
      expect(evaluateQueueAlarm(10, esotico), esotico).toMatchObject({ valid: false });
    }
    // Il decimale semplice, con spazi attorno, resta valido.
    expect(evaluateQueueAlarm(10, ' 100 ')).toMatchObject({ valid: true, threshold: 100 });
  });

  it('la riga «non leggibile» sta fuori dal guard su queuedJobs', () => {
    // `queueStuck` si calcola su `r.queue || {}`, quindi un oggetto `queue`
    // assente apre l'alert. Se la spiegazione vivesse dentro
    // `if (q.queuedJobs !== undefined)`, l'issue si aprirebbe senza che il
    // corpo nomini la coda da nessuna parte.
    const alarmAt = workflow.indexOf('if (!queueAlarm.valid) {');
    const guardAt = workflow.indexOf('if (q.queuedJobs !== undefined) {');
    expect(alarmAt).toBeGreaterThan(-1);
    expect(guardAt).toBeGreaterThan(-1);
    expect(alarmAt).toBeLessThan(guardAt);
  });

  it('dice QUALE dei due input manca, non incolpa sempre il conteggio', () => {
    expect(evaluateQueueAlarm(180, '50.5')).toMatchObject({ valid: false, count: 180, threshold: null });
    expect(evaluateQueueAlarm(undefined, 100)).toMatchObject({ valid: false, count: null, threshold: 100 });
    expect(workflow).toContain('la soglia non e leggibile');
    expect(workflow).toContain('il conteggio della coda non e leggibile');
  });

  it('lo script pesante NON ri-esporta l allarme', () => {
    // Un re-export ricrea il percorso di import che il modulo leggero esiste
    // per evitare: chi lo seguisse si tirerebbe dietro il rilevatore di lingua.
    const audit = fs.readFileSync(
      path.join(process.cwd(), 'scripts/audit-job-description-locale.mjs'), 'utf8',
    );
    expect(audit).not.toMatch(/export \{[^}]*evaluateQueueAlarm/);
  });

  it('il workflow usa la funzione e non ricostruisce il confronto a mano', () => {
    expect(workflow).toContain('evaluateQueueAlarm');
    expect(workflow).not.toMatch(/Number\(q\.staleSourceCopyJobs/);
  });

  it('il workflow importa dal modulo senza dipendenze, non dallo script di audit', () => {
    // Lo script inline gira in un `node --input-type=module`: importare
    // l'audit tirerebbe dentro il rilevatore di lingua per un confronto fra
    // due numeri. Vedi AGENTS.md, «Script Node prima di npm ci».
    expect(workflow).toContain("from './scripts/lib/queue-alarm.mjs'");
  });

  it('quando la misura manca il report lo dice, invece di tacere', () => {
    expect(workflow).toContain('queueAlarm.valid');
    expect(workflow).toContain('Allarme cieco');
  });
});
