import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import YAML from 'yaml';

import {
  addDaysIso,
  checkpointDays,
  collectAlarms,
  decideAction,
  diffMonitorState,
  estimateDecisionWindowEnd,
  evaluateWindow,
  inclusiveDays,
  monitorStateMarker,
  planExperiment,
  readMonitorState,
  renderMonitorReport,
} from '../scripts/lib/experiment-monitor.mjs';
import { buildExperimentReadout } from '../scripts/lib/experiment-stats.mjs';
import { JOBGATE_V3_PLAN } from '../scripts/experiments/jobgate-v3-plan.mjs';
import { ISSUE_TITLES, mayPublishPromotion, rcStateFromValues, resolvePlan, runMonitor } from '../scripts/experiments/jobgate-v3-monitor.mjs';

const PLAN = JOBGATE_V3_PLAN;
const WEIGHTS = { control: 25, similar_alerts: 25, social_first: 25, email_first: 25 };
const ARMS_JSON = JSON.stringify(WEIGHTS);
const RC_ON = { enabled: true, force: '' };

type ArmSpec = { n: number; x: number; auth?: number; confirmed?: number; assigned?: number };

/**
 * Payload come quello di `job-gate-experiment-readout.mjs --json`, costruito
 * con la VERA buildExperimentReadout: i test attraversano la stessa statistica.
 */
function payload(days: number, arms: Record<string, ArmSpec>, { coverage = 1, weights = WEIGHTS } = {}) {
  const ga: Record<string, { gateView: number; authSuccess: number; assigned: number }> = {};
  const subs: Record<string, { newSubscribers: number; confirmed: number; matured: number; confirmedWithin72hMatured: number; active: number }> = {};
  let tagged = 0;
  for (const [arm, s] of Object.entries(arms)) {
    ga[arm] = { gateView: s.n, authSuccess: s.auth ?? Math.round(s.n * 0.16), assigned: s.assigned ?? s.n };
    const confirmed = s.confirmed ?? Math.round(s.x * 0.45);
    subs[arm] = { newSubscribers: s.x, confirmed, matured: s.x, confirmedWithin72hMatured: confirmed, active: confirmed };
    tagged += s.x;
  }
  const untagged = coverage >= 1 ? 0 : Math.round((tagged * (1 - coverage)) / coverage);
  const until = addDaysIso(PLAN.analysisStart, days - 1);
  return {
    mode: 'experiment',
    experimentId: 'jobgate-v3',
    since: PLAN.analysisStart,
    until,
    windowDays: days,
    weights,
    readout: buildExperimentReadout({ arms: Object.keys(arms), control: 'control', ga, subs, weights, relativeMde: 0.3, windowDays: days }),
    excluded: { applied: true, signatures: [{ id: 'automation-1280x1200', label: 'robot', assigned: { control: 3 }, gateView: { control: 5, email_first: 4 } }] },
    attribution: { tagged, untaggedFromGate: untagged, coverage: tagged + untagged ? tagged / (tagged + untagged) : null, untaggedByComponent: untagged ? { authService: untagged } : {} },
  };
}

const flat = (n: number, rate: number): ArmSpec => ({ n, x: Math.round(n * rate) });
const planned = planExperiment(PLAN, WEIGHTS);

function decide(p: ReturnType<typeof payload> | null, rc = RC_ON) {
  const statusEval = p ? evaluateWindow(p, PLAN, planned) : null;
  const cp = checkpointDays(statusEval?.days ?? 0, PLAN.checkpointDays);
  const decisionEval = statusEval && cp >= planned.minDays && cp === statusEval.days ? statusEval : null;
  const decision = decideAction({ rc, decisionEval, plan: PLAN, planned });
  const alarms = statusEval && rc.enabled && !rc.force ? collectAlarms(statusEval, PLAN) : [];
  return { decision, alarms, statusEval };
}

describe('piano jobgate-v3', () => {
  it('baseline reale 2,88%, +30%, 3 confronti Bonferroni, 700 persone/giorno → 8.981 per braccio e 56 giorni', () => {
    expect(planned.challengers).toEqual(['similar_alerts', 'social_first', 'email_first']);
    expect(planned.alphaPerTest).toBeCloseTo(0.05 / 3, 12);
    expect(planned.requiredPerArm).toBe(8981);
    expect(planned.perArmDaily).toBe(175);
    expect(planned.daysForSample).toBe(52);
    expect(planned.minDays).toBe(56);
    expect(planned.minWindowEnd).toBe('2026-11-20');
    expect(planned.maxWindowEnd).toBe('2026-12-04');
  });

  it('la durata minima non scende sotto quattro settimane e segue il braccio più piccolo', () => {
    expect(planExperiment({ ...PLAN, relativeMde: 0.6 }, WEIGHTS).minDays).toBe(28);
    const uneven = planExperiment(PLAN, { control: 50, email_first: 50, social_first: 0 });
    expect(uneven.challengers).toEqual(['email_first']);
    expect(uneven.perArmDaily).toBe(350);
    expect(uneven.alphaPerTest).toBeCloseTo(0.05, 12);
  });

  it('date e finestre di settimane intere', () => {
    expect(addDaysIso('2026-09-26', 48)).toBe('2026-11-13');
    expect(inclusiveDays('2026-09-26', '2026-09-26')).toBe(1);
    expect(inclusiveDays('2026-09-26', '2026-09-25')).toBe(0);
    expect(checkpointDays(55, 7)).toBe(49);
    expect(checkpointDays(6, 7)).toBe(0);
    expect(checkpointDays(10, 1)).toBe(10);
  });

  it('opzioni CLI validate e stato Remote Config letto come nel browser', () => {
    expect(resolvePlan({ mde: '0.4', 'max-days': '84' }).relativeMde).toBe(0.4);
    expect(() => resolvePlan({ mde: 'abc' })).toThrow(/--mde/);
    expect(() => resolvePlan({ 'max-days': '70.5' })).toThrow(/--max-days/);
    // Review #9836: una soglia ≤ 0 farebbe passare anche una copertura nulla.
    expect(() => resolvePlan({ 'min-attribution': '-0.1' })).toThrow(/--min-attribution non valido/);
    expect(() => resolvePlan({ 'min-attribution': '0' })).toThrow(/--min-attribution non valido/);
    expect(resolvePlan({ 'min-attribution': '0.9' }).minAttributionCoverage).toBe(0.9);
    expect(rcStateFromValues({ JOBGATE_EXPERIMENT_ENABLED: 'TRUE', JOBGATE_EXPERIMENT_ARMS: ARMS_JSON, JOBGATE_EXPERIMENT_FORCE: ' Email_First ' }))
      .toMatchObject({ enabled: true, force: 'email_first', armsValid: true, weights: WEIGHTS });
    expect(rcStateFromValues({ JOBGATE_EXPERIMENT_ENABLED: 'true', JOBGATE_EXPERIMENT_ARMS: '{bad', JOBGATE_EXPERIMENT_FORCE: 'nope' }))
      .toMatchObject({ enabled: true, force: '', armsValid: false, weights: { control: 100 } });
  });
});

describe('decisione di promozione (tabella di casi)', () => {
  const N = 10000; // > 8.981 pianificate per braccio
  const baseArms = { control: flat(N, 0.033), similar_alerts: flat(N, 0.034), social_first: flat(N, 0.032), email_first: flat(N, 0.033) };

  it('troppo presto: 21 giorni → raccolta dati, nessuna azione', () => {
    const { decision } = decide(payload(21, { ...baseArms, email_first: flat(N, 0.06) }));
    expect(decision).toMatchObject({ phase: 'collecting', action: 'none', winner: null });
  });

  it('vincente chiaro: tutte le condizioni vere → promuove il vincente', () => {
    const { decision, alarms } = decide(payload(56, { ...baseArms, email_first: flat(N, 0.045) }));
    expect(decision.action).toBe('promote');
    expect(decision.winner).toBe('email_first');
    expect(decision.checks.every((c) => c.ok)).toBe(true);
    expect(alarms).toEqual([]);
  });

  it('più vincenti significativi: promuove quello con la CR più alta', () => {
    const { decision } = decide(payload(56, { ...baseArms, similar_alerts: flat(N, 0.044), email_first: flat(N, 0.048) }));
    expect(decision.winner).toBe('email_first');
  });

  it('nessun vincente: nessuna promozione', () => {
    const { decision } = decide(payload(56, baseArms));
    expect(decision.action).toBe('none');
    expect(decision.checks.find((c) => c.id === 'winner')?.ok).toBe(false);
  });

  it('control migliore di tutti: nessuna promozione, allarme guardrail', () => {
    const { decision, alarms } = decide(payload(56, {
      control: flat(N, 0.045), similar_alerts: flat(N, 0.03), social_first: flat(N, 0.03), email_first: flat(N, 0.03),
    }));
    expect(decision.action).toBe('none');
    expect(alarms.map((a) => a.id)).toContain('guardrail');
  });

  it('SRM: allocazione sbilanciata blocca la promozione e allarma', () => {
    const arms = { ...baseArms, email_first: { ...flat(N, 0.045), assigned: N }, control: { ...flat(N, 0.033), assigned: N * 1.2 } };
    const { decision, alarms } = decide(payload(56, arms));
    expect(decision.action).toBe('none');
    expect(decision.checks.find((c) => c.id === 'srm')?.ok).toBe(false);
    expect(alarms.map((a) => a.id)).toContain('srm');
  });

  it('campione sotto il piano: nessuna promozione anche con p piccolo', () => {
    const n = 3000;
    const { decision } = decide(payload(56, { control: flat(n, 0.03), similar_alerts: flat(n, 0.03), social_first: flat(n, 0.03), email_first: flat(n, 0.07) }));
    expect(decision.action).toBe('none');
    expect(decision.checks.find((c) => c.id === 'sample')?.ok).toBe(false);
    expect(decision.checks.find((c) => c.id === 'winner')?.ok).toBe(true);
  });

  it('braccio peggiore del control: allarme, ma non blocca il vincente (la promozione lo spegne)', () => {
    const { decision, alarms } = decide(payload(56, { ...baseArms, social_first: flat(N, 0.02), email_first: flat(N, 0.045) }));
    expect(alarms.find((a) => a.id === 'guardrail')?.detail).toMatch(/social_first/);
    expect(decision.action).toBe('promote');
    expect(decision.winner).toBe('email_first');
  });

  it('vincente sulla CR primaria ma peggiore su auth/gate: guardrail del vincente, niente promozione', () => {
    const { decision, alarms } = decide(payload(56, { ...baseArms, email_first: { ...flat(N, 0.045), auth: Math.round(N * 0.1) } }));
    expect(decision.checks.find((c) => c.id === 'winner')?.ok).toBe(true);
    expect(decision.checks.find((c) => c.id === 'guardrail')?.ok).toBe(false);
    expect(decision.action).toBe('none');
    expect(alarms.find((a) => a.id === 'guardrail')?.detail).toMatch(/`email_first` auth\/gate −?-?\d/);
  });

  it('attribuzione degli iscritti sotto soglia: niente promozione e allarme', () => {
    const { decision, alarms } = decide(payload(56, { ...baseArms, email_first: flat(N, 0.045) }, { coverage: 0.4 }));
    expect(decision.action).toBe('none');
    expect(decision.checks.find((c) => c.id === 'attribution')?.ok).toBe(false);
    expect(alarms.map((a) => a.id)).toContain('attribution');
  });

  it('durata massima senza vincente: chiede al proprietario, nessun cambio', () => {
    const { decision } = decide(payload(70, baseArms));
    expect(decision).toMatchObject({ phase: 'max-duration', action: 'ask-owner', winner: null });
  });

  it('dopo la durata massima un vincente tardivo non promuove: decide il proprietario', () => {
    const atMax = decide(payload(70, { ...baseArms, email_first: flat(N, 0.045) })).decision;
    expect(atMax).toMatchObject({ action: 'promote', winner: 'email_first' });
    const late = decide(payload(77, { ...baseArms, email_first: flat(N, 0.045) })).decision;
    expect(late).toMatchObject({ phase: 'max-duration', action: 'ask-owner', winner: null });
    expect(late.checks.every((c) => c.ok)).toBe(true);
  });

  it('FORCE già impostato: nessuna azione e nessun allarme (idempotente dopo la promozione)', () => {
    const { decision, alarms } = decide(payload(56, { ...baseArms, email_first: flat(N, 0.045) }), { enabled: true, force: 'email_first' });
    expect(decision).toMatchObject({ phase: 'forced', action: 'none', winner: 'email_first' });
    expect(alarms).toEqual([]);
  });

  it('kill switch spento: nessuna azione', () => {
    const { decision } = decide(payload(56, { ...baseArms, email_first: flat(N, 0.045) }), { enabled: false, force: '' });
    expect(decision).toMatchObject({ phase: 'disabled', action: 'none' });
  });

  it('un braccio pianificato senza dati conta zero persone', () => {
    const { control, similar_alerts, social_first } = baseArms;
    const e = evaluateWindow(payload(56, { control, similar_alerts, social_first }), PLAN, planned);
    expect(e.persons.email_first).toBe(0);
    expect(e.minPersons).toBe(0);
  });

  it('allarme attribuzione solo con un campione minimo di iscritti', () => {
    const tiny = evaluateWindow(payload(7, { control: { n: 100, x: 1 }, similar_alerts: { n: 100, x: 1 }, social_first: { n: 100, x: 1 }, email_first: { n: 100, x: 1 } }, { coverage: 0.3 }), PLAN, planned);
    expect(tiny.attribution.total).toBeLessThan(20);
    expect(collectAlarms(tiny, PLAN).map((a) => a.id)).not.toContain('attribution');
  });
});

describe('stato persistito e report', () => {
  it('marker leggibile e diff delle transizioni', () => {
    const state = { v: 1, phase: 'decision', action: 'none', winner: null, alarms: ['srm'], applied: null };
    expect(readMonitorState(`testo\n${monitorStateMarker(state)}\n`)).toEqual(state);
    expect(readMonitorState('nessun marker')).toBeNull();
    const d = diffMonitorState({ phase: 'collecting', alarms: ['guardrail'], action: 'none' }, { phase: 'decision', alarms: ['srm'], action: 'none' });
    expect(d).toEqual({ phaseChanged: true, newAlarms: ['srm'], clearedAlarms: ['guardrail'], firstAskOwner: false });
    expect(diffMonitorState({ phase: 'max-duration', alarms: [], action: 'ask-owner' }, { phase: 'max-duration', alarms: [], action: 'ask-owner' }).firstAskOwner).toBe(false);
    expect(diffMonitorState(null, { phase: 'max-duration', alarms: [], action: 'ask-owner' }).firstAskOwner).toBe(true);
  });

  it('report con giorni, bracci, SRM, potenza, data prevista e marker', () => {
    const p = payload(56, { control: flat(10000, 0.033), similar_alerts: flat(10000, 0.034), social_first: flat(10000, 0.02), email_first: flat(10000, 0.045) });
    const statusEval = evaluateWindow(p, PLAN, planned);
    const decision = decideAction({ rc: RC_ON, decisionEval: statusEval, plan: PLAN, planned });
    const alarms = collectAlarms(statusEval, PLAN);
    const estimate = estimateDecisionWindowEnd(statusEval, PLAN, planned);
    const state = { v: 1, phase: decision.phase, action: decision.action, winner: decision.winner, alarms: alarms.map((a) => a.id), applied: null };
    const md = renderMonitorReport({ plan: PLAN, planned, rc: { ...RC_ON, armsRaw: ARMS_JSON }, statusEval, decisionEval: statusEval, decision, alarms, estimate, statusPayload: p, state });
    expect(md).toContain('**Giorni trascorsi:** 56');
    // fmtInt usa it-CH: il separatore delle migliaia dipende dall'ICU del runtime.
    expect(md).toMatch(/\*\*8\D?981 persone gate_view per braccio\*\*/);
    expect(md).toMatch(/\| `email_first` \| 10\D?000 \|/);
    expect(md).toContain('Braccio peggiore del control');
    expect(md).toContain('✅ (d) vincente sulla CR primaria');
    expect(md).toContain('Promozione di `email_first` pronta');
    expect(md).toContain('servono `--apply --approve-promotion`');
    expect(md).toContain('via `workflow_dispatch`');
    expect(md).toContain('**Robot esclusi:** 9 persone');
    expect(md).toContain('**Data prevista della decisione:** finestra fino al **2026-11-20**');
    expect(readMonitorState(md)).toEqual(state);
  });

  it('data prevista: dal piano nella prima settimana, poi dal ritmo osservato', () => {
    const firstDays = evaluateWindow(payload(3, { control: flat(30, 0.03), similar_alerts: flat(30, 0.03), social_first: flat(30, 0.03), email_first: flat(30, 0.03) }), PLAN, planned);
    expect(estimateDecisionWindowEnd(firstDays, PLAN, planned)).toMatchObject({ days: 56, provisional: true, beyondMax: false });
    const slow = evaluateWindow(payload(14, { control: flat(1400, 0.03), similar_alerts: flat(1400, 0.03), social_first: flat(1400, 0.03), email_first: flat(1400, 0.03) }), PLAN, planned);
    // 100 persone/giorno per braccio → 90 giorni → 91 (settimane intere), oltre i 70.
    expect(estimateDecisionWindowEnd(slow, PLAN, planned)).toMatchObject({ days: 91, provisional: false, beyondMax: true, windowEnd: '2026-12-25' });
  });

  it('titoli delle issue distinti nei primi 60 caratteri (chiave di dedup)', () => {
    const prefixes = Object.values(ISSUE_TITLES).map((t) => t.slice(0, 60));
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });

  it('richiede approvazione esplicita e rifiuta ogni evento GitHub non manuale', () => {
    expect(mayPublishPromotion({ apply: true, approvePromotion: false, eventName: 'workflow_dispatch' })).toBe(false);
    expect(mayPublishPromotion({ apply: false, approvePromotion: true, eventName: 'workflow_dispatch' })).toBe(false);
    expect(mayPublishPromotion({ apply: true, approvePromotion: true, eventName: 'schedule' })).toBe(false);
    expect(mayPublishPromotion({ apply: true, approvePromotion: true, eventName: 'workflow_run' })).toBe(false);
    expect(mayPublishPromotion({ apply: true, approvePromotion: true, eventName: 'workflow_dispatch' })).toBe(true);
    expect(mayPublishPromotion({ apply: true, approvePromotion: true })).toBe(true);
  });
});

describe('CLI jobgate-v3-monitor (fixture, nessuna rete)', () => {
  const script = path.resolve(__dirname, '../scripts/experiments/jobgate-v3-monitor.mjs');

  function run(files: Record<string, unknown>, extra: string[] = []) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobgate-monitor-test-'));
    const args: string[] = [script, '--out', path.join(dir, 'out')];
    for (const [flag, content] of Object.entries(files)) {
      const f = path.join(dir, `${flag}.json`);
      fs.writeFileSync(f, JSON.stringify(content));
      args.push(`--${flag}`, f);
    }
    const res = spawnSync(process.execPath, [...args, ...extra], { encoding: 'utf8' });
    const json = fs.existsSync(path.join(dir, 'out', 'monitor.json'))
      ? JSON.parse(fs.readFileSync(path.join(dir, 'out', 'monitor.json'), 'utf8'))
      : null;
    return { res, json };
  }

  const rcOn = { JOBGATE_EXPERIMENT_ENABLED: 'true', JOBGATE_EXPERIMENT_ARMS: ARMS_JSON, JOBGATE_EXPERIMENT_FORCE: '' };
  const winning = payload(56, { control: flat(10000, 0.033), similar_alerts: flat(10000, 0.034), social_first: flat(10000, 0.032), email_first: flat(10000, 0.045) });

  async function runWithPublisher(extra: string[], eventName: string) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobgate-monitor-publish-test-'));
    const rcPath = path.join(dir, 'rc.json');
    const statusPath = path.join(dir, 'status.json');
    fs.writeFileSync(rcPath, JSON.stringify(rcOn));
    fs.writeFileSync(statusPath, JSON.stringify(winning));
    const publishRc = vi.fn();
    const result = await runMonitor([
      '--rc-json', rcPath,
      '--status-json', statusPath,
      ...extra,
    ], { eventName, publishRc });
    return { result, publishRc };
  }

  it('dry-run di default: promozione pronta, comando stampato e non eseguito', () => {
    const { res, json } = run({ 'rc-json': rcOn, 'status-json': winning });
    expect(res.status).toBe(0);
    expect(json.state).toMatchObject({ phase: 'decision', action: 'promote', winner: 'email_first', applied: null });
    expect(res.stderr).toContain('DRY-RUN');
    expect(res.stderr).toContain('--force-arm email_first');
    expect(res.stderr).toContain(`--arms '${ARMS_JSON}'`);
    expect(res.stdout).toContain('Promozione di `email_first` pronta');
  });

  it('non invoca Remote Config senza approvazione esplicita o da un evento schedulato', async () => {
    const noApproval = await runWithPublisher(['--apply'], 'workflow_dispatch');
    expect(noApproval.result.state).toMatchObject({ action: 'promote', applied: null });
    expect(noApproval.publishRc).not.toHaveBeenCalled();

    const scheduled = await runWithPublisher(['--apply', '--approve-promotion'], 'schedule');
    expect(scheduled.result.state).toMatchObject({ action: 'promote', applied: null });
    expect(scheduled.publishRc).not.toHaveBeenCalled();
  });

  it('invoca il publisher solo con input manuale approvato (publisher sostituito nel test)', async () => {
    const approved = await runWithPublisher(['--apply', '--approve-promotion'], 'workflow_dispatch');
    expect(approved.result.state).toMatchObject({ action: 'promote', applied: true });
    expect(approved.publishRc).toHaveBeenCalledOnce();
    expect(approved.publishRc.mock.calls[0][0]).toContain('--apply');
  });

  it('FORCE già pubblicato: nessuna azione (non ripubblica)', () => {
    const { res, json } = run({ 'rc-json': { ...rcOn, JOBGATE_EXPERIMENT_FORCE: 'email_first' }, 'status-json': winning }, ['--apply']);
    expect(res.status).toBe(0);
    expect(json.state).toMatchObject({ phase: 'forced', action: 'none', applied: null });
    expect(res.stderr).not.toContain('DRY-RUN');
  });

  it('--min-attribution negativo: errore, nessuna decisione né promozione', () => {
    const { res, json } = run({ 'rc-json': rcOn, 'status-json': payload(56, { control: flat(10000, 0.033), similar_alerts: flat(10000, 0.034), social_first: flat(10000, 0.032), email_first: flat(10000, 0.045) }, { coverage: 0 }) }, ['--min-attribution=-0.1', '--apply']);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('--min-attribution non valido');
    expect(json).toBeNull();
  });

  it('--apply con readout vero ma senza GA4_PROPERTY_ID: si ferma prima di leggere GA4', () => {
    const env = { ...process.env, GA4_PROPERTY_ID: '' };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobgate-monitor-test-'));
    const rcFile = path.join(dir, 'rc.json');
    fs.writeFileSync(rcFile, JSON.stringify(rcOn));
    const res = spawnSync(process.execPath, [script, '--rc-json', rcFile, '--until', '2026-10-02', '--apply'], { encoding: 'utf8', env });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('GA4_PROPERTY_ID mancante');
  });

  it('prima del primo giorno assestato: fase di attesa, nessun readout', () => {
    const { res, json } = run({ 'rc-json': rcOn }, ['--until', '2026-09-25']);
    expect(res.status).toBe(0);
    expect(json.state).toMatchObject({ phase: 'waiting', action: 'none', window: null });
  });
});

describe('workflow jobgate-experiment-monitor', () => {
  const wf = YAML.parse(fs.readFileSync(path.resolve(__dirname, '../.github/workflows/jobgate-experiment-monitor.yml'), 'utf8'));
  const steps: Array<Record<string, any>> = wf.jobs.monitor.steps;
  const run = steps.find((s) => s.name === 'Run monitor')!;

  it('giornaliero, serializzato, con i soli permessi che servono', () => {
    expect(wf.on.schedule).toHaveLength(1);
    expect(wf.on.schedule[0].cron).toMatch(/^\d+ \d+ \* \* \*$/);
    expect(wf.concurrency).toEqual({ group: 'jobgate-experiment-monitor', 'cancel-in-progress': false });
    expect(wf.permissions).toEqual({ contents: 'read', issues: 'write' });
  });

  it('il cron non scrive su Remote Config; solo apply=true nel dispatch manuale passa entrambe le guardie', () => {
    expect(wf.on.workflow_dispatch.inputs.apply.default).toBe('false');
    expect(wf.on.workflow_dispatch.inputs.apply.description).toContain('Conferma manualmente');
    expect(run.env.APPLY).toBe("${{ github.event_name == 'workflow_dispatch' && inputs.apply == 'true' && 'true' || 'false' }}");
    expect(run.run).toContain('if [ "${APPLY}" = "true" ]; then flags+=(--apply --approve-promotion); fi');
    expect(run.run).toContain('node scripts/experiments/jobgate-v3-monitor.mjs "${flags[@]}"');
    expect(run.run).toContain('--issues');
  });

  it('credenziali e property GA4 fail-closed prima del monitor', () => {
    const creds = steps.findIndex((s) => s.name === 'Prepare Firebase credentials');
    expect(creds).toBeGreaterThan(-1);
    expect(creds).toBeLessThan(steps.indexOf(run));
    expect(steps[creds].run).toContain('exit 1');
    // Review #9836: il loader è fail-open, quindi niente continue-on-error e
    // un controllo esplicito sulla variabile prima di `Run monitor`.
    const load = steps.find((s) => s.name === 'Load Remote Config env')!;
    expect(load['continue-on-error']).toBeUndefined();
    const guard = steps.findIndex((s) => s.name === 'Require GA4 property');
    expect(guard).toBeGreaterThan(steps.indexOf(load));
    expect(guard).toBeLessThan(steps.indexOf(run));
    expect(steps[guard].run).toContain('GA4_PROPERTY_ID');
    expect(steps[guard].run).toContain('exit 1');
    expect(steps[guard]['continue-on-error']).toBeUndefined();
  });
});
