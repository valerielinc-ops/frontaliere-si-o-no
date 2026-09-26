/**
 * experiment-monitor.mjs — decisioni PURE del monitor di un test A/B (primo
 * consumer: scripts/experiments/jobgate-v3-monitor.mjs).
 *
 * Niente I/O: prende il piano (scripts/experiments/jobgate-v3-plan.mjs), lo
 * stato di Remote Config e il JSON del readout
 * (scripts/analytics/job-gate-experiment-readout.mjs --json) e restituisce
 * fase, allarmi, azione e il markdown della issue di stato. Tutto ciò che
 * decide una pubblicazione in produzione sta qui ed è pinnato da test a
 * tabella (tests/experiment-monitor.test.ts).
 *
 * Regole (la promozione richiede TUTTE le condizioni, valutate su una
 * finestra di settimane intere):
 *  (a) giorni della finestra ≥ durata minima pianificata;
 *  (b) persone gate_view per braccio (il minimo fra control e challenger) ≥
 *      campione pianificato;
 *  (c) nessun SRM;
 *  (d) un challenger batte il control sulla CR primaria con p Holm < α;
 *  (e) guardrail ok per il vincente (non significativamente peggiore del
 *      control su nessuna metrica di guardrail) e attribuzione degli iscritti
 *      sopra la copertura minima.
 * Alla durata massima senza promozione (e da lì in poi, anche se un vincente
 * arriva dopo): nessun cambio, si chiede al proprietario. Control «vincente» o nessun challenger migliore: nessuna
 * promozione. FORCE già impostato o kill switch spento: nessuna azione.
 */

import { countInclusiveUtcDays, fmtUtcDate } from './analytics-settled-window.mjs';
import { achievedPower, fmtCi, fmtInt, fmtP, fmtPct, sampleSizePerArm } from './experiment-stats.mjs';

/**
 * Piano di un esperimento (forma di JOBGATE_V3_PLAN, con valori sostituibili).
 * @typedef {{
 *   experimentId: string, control: string, launchedAt: string, analysisStart: string,
 *   baselineRate: number, baselineWindow: string, dailyGatePersons: number,
 *   relativeMde: number, alpha: number, power: number, checkpointDays: number,
 *   minDaysFloor: number, maxDays: number, srmAlpha: number,
 *   guardrail: { alpha: number, minRelativeDrop: number, families: readonly string[] },
 *   minAttributionCoverage: number,
 * }} ExperimentPlan
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** `YYYY-MM-DD` + n giorni (calendario, UTC). */
export function addDaysIso(date, n) {
  return fmtUtcDate(new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS));
}

/** Giorni di calendario da `since` a `until` inclusi (0 se `until` precede `since`). */
export function inclusiveDays(since, until) {
  return countInclusiveUtcDays(since, until) ?? 0;
}

/**
 * Piano: campione per braccio e durata minima, dai pesi di allocazione attivi.
 * Il braccio più piccolo detta il ritmo (con pesi uguali: 1/4 delle persone).
 *
 * @param {ExperimentPlan} plan
 * @param {Record<string, number>} weights pesi Remote Config (anche non normalizzati)
 */
export function planExperiment(plan, weights) {
  const active = Object.entries(weights || {}).filter(([, w]) => Number(w) > 0);
  const challengers = active.map(([arm]) => arm).filter((arm) => arm !== plan.control);
  const k = Math.max(1, challengers.length);
  const alphaPerTest = plan.alpha / k;
  const pA = plan.baselineRate;
  const pB = pA * (1 + plan.relativeMde);
  const requiredPerArm = pB < 1 ? sampleSizePerArm(pA, pB, { alpha: alphaPerTest, power: plan.power }) : null;
  const wSum = active.reduce((s, [, w]) => s + Number(w), 0);
  const minShare = wSum > 0 ? Math.min(...active.map(([, w]) => Number(w) / wSum)) : 0;
  const perArmDaily = plan.dailyGatePersons * minShare;
  const daysForSample = requiredPerArm != null && perArmDaily > 0 ? Math.ceil(requiredPerArm / perArmDaily) : null;
  const step = Math.max(1, plan.checkpointDays || 1);
  const minDays = daysForSample == null
    ? plan.maxDays
    : Math.max(plan.minDaysFloor || 0, Math.ceil(daysForSample / step) * step);
  return {
    challengers,
    k,
    alphaPerTest,
    requiredPerArm,
    perArmDaily,
    daysForSample,
    minDays,
    maxDays: plan.maxDays,
    minWindowEnd: addDaysIso(plan.analysisStart, minDays - 1),
    maxWindowEnd: addDaysIso(plan.analysisStart, plan.maxDays - 1),
  };
}

/** Giorni dell'ultima finestra di settimane intere contenuta in `days` (0 = nessuna). */
export function checkpointDays(days, step) {
  const s = Math.max(1, step || 1);
  return Math.floor(Math.max(0, days) / s) * s;
}

/**
 * Valuta una finestra del readout (payload `--json` in modalità experiment)
 * rispetto al piano: campione, SRM, vincente, guardrail, attribuzione, potenza.
 */
export function evaluateWindow(payload, plan, planned) {
  const r = payload.readout;
  const control = r.control;
  const hasControl = r.arms.includes(control);
  // Un braccio pianificato senza dati conta 0 persone: il campione non basta.
  const arms = [control, ...planned.challengers];
  const persons = Object.fromEntries(arms.map((a) => [a, r.perArm[a]?.gateView ?? 0]));
  const minPersons = hasControl && planned.challengers.length ? Math.min(...arms.map((a) => persons[a])) : 0;

  const srmRaw = r.srm;
  const srm = srmRaw
    ? { pValue: srmRaw.pValue, mismatch: srmRaw.pValue < plan.srmAlpha || srmRaw.missingWeights.length > 0, missingWeights: srmRaw.missingWeights }
    : null;

  const primary = r.comparisons?.primary || [];
  const winners = hasControl
    ? primary
      .filter((c) => planned.challengers.includes(c.arm) && c.pHolm != null && c.pHolm < plan.alpha && c.diff > 0)
      .sort((a, b) => (r.perArm[b.arm].primary.rate ?? 0) - (r.perArm[a.arm].primary.rate ?? 0))
    : [];
  const best = winners[0] || null;

  const g = plan.guardrail;
  const guardrailBreaches = [];
  for (const family of g.families) {
    for (const c of r.comparisons?.[family] || []) {
      if (c.pHolm != null && c.pHolm < g.alpha && c.uplift != null && c.uplift <= -g.minRelativeDrop) {
        guardrailBreaches.push({ arm: c.arm, family, uplift: c.uplift, pHolm: c.pHolm });
      }
    }
  }

  const att = payload.attribution || null;
  const attributionTotal = att ? att.tagged + att.untaggedFromGate : 0;
  const attribution = {
    tagged: att?.tagged ?? null,
    untaggedFromGate: att?.untaggedFromGate ?? null,
    coverage: att?.coverage ?? null,
    total: attributionTotal,
    ok: att != null && att.coverage != null && att.coverage >= plan.minAttributionCoverage,
  };

  const pA = plan.baselineRate;
  const pB = pA * (1 + plan.relativeMde);
  const power = planned.challengers.map((arm) => ({
    arm,
    achieved: hasControl && r.perArm[arm]
      ? achievedPower(persons[control], r.perArm[arm].gateView, pA, pB, { alpha: planned.alphaPerTest })
      : null,
  }));

  const excludedGateView = (payload.excluded?.signatures || []).reduce(
    (s, sig) => s + Object.values(sig.gateView || {}).reduce((a, b) => a + (Number(b) || 0), 0),
    0,
  );

  return {
    since: payload.since,
    until: payload.until,
    days: payload.windowDays,
    hasControl,
    persons,
    minPersons,
    srm,
    best,
    winners: winners.map((w) => w.arm),
    guardrailBreaches,
    attribution,
    power,
    excludedGateView,
    excludedApplied: Boolean(payload.excluded?.applied),
  };
}

/**
 * Data prevista della decisione: la prima finestra di settimane intere che
 * rispetta la durata minima E, al ritmo osservato, il campione pianificato.
 * Il ritmo osservato è per persone uniche, quindi la stima è ottimista di
 * qualche giorno (la deduplicazione cresce con la finestra). Prima di una
 * settimana intera di dati il ritmo non è affidabile (giorno della
 * settimana, primo giorno parziale): vale il piano, marcato `provisional`.
 */
export function estimateDecisionWindowEnd(statusEval, plan, planned) {
  const step = Math.max(1, plan.checkpointDays || 1);
  let days = planned.minDays;
  const provisional = statusEval.days < step;
  if (!provisional && planned.requiredPerArm != null && statusEval.minPersons > 0) {
    const perDay = statusEval.minPersons / statusEval.days;
    const needed = Math.ceil(planned.requiredPerArm / perDay);
    days = Math.max(days, Math.ceil(needed / step) * step);
  }
  return { days, windowEnd: addDaysIso(plan.analysisStart, days - 1), beyondMax: days > plan.maxDays, provisional };
}

/**
 * Allarmi giornalieri (sulla finestra più recente). Nessuno cambia nulla:
 * aprono o tengono aperta una issue.
 * @returns {{id:string, detail:string}[]}
 */
export function collectAlarms(statusEval, plan, { minAttributionSample = 20 } = {}) {
  const alarms = [];
  if (statusEval.srm?.mismatch) {
    alarms.push({ id: 'srm', detail: `SRM: p = ${fmtP(statusEval.srm.pValue)}${statusEval.srm.missingWeights.length ? `, bracci senza peso: ${statusEval.srm.missingWeights.join(', ')}` : ''}` });
  }
  if (statusEval.guardrailBreaches.length) {
    alarms.push({
      id: 'guardrail',
      detail: statusEval.guardrailBreaches
        .map((b) => `\`${b.arm}\` ${FAMILY_LABEL[b.family]} ${fmtUplift(b.uplift)} (p Holm ${fmtP(b.pHolm)})`)
        .join('; '),
    });
  }
  const att = statusEval.attribution;
  if (att.coverage != null && att.total >= minAttributionSample && att.coverage < plan.minAttributionCoverage) {
    alarms.push({ id: 'attribution', detail: `copertura ${fmtPct(att.coverage, 0)} (${att.tagged} con braccio, ${att.untaggedFromGate} senza) sotto il ${fmtPct(plan.minAttributionCoverage, 0)}` });
  }
  return alarms;
}

/**
 * Decisione del giorno.
 *
 * `rc` = stato Remote Config (`enabled`, `force`); `decisionEval` = finestra
 * di settimane intere ≥ durata minima, oppure null se non ancora raggiunta.
 *
 * @param {{
 *   rc: { enabled: boolean, force: string },
 *   decisionEval: ReturnType<typeof evaluateWindow> | null,
 *   plan: ExperimentPlan,
 *   planned: ReturnType<typeof planExperiment>,
 * }} input
 * @returns {{phase:string, action:'none'|'promote'|'ask-owner', winner:string|null, checks:{id:string, ok:boolean, detail:string}[]}}
 */
export function decideAction({ rc, decisionEval, plan, planned }) {
  if (!rc.enabled) return { phase: 'disabled', action: 'none', winner: null, checks: [] };
  if (rc.force) return { phase: 'forced', action: 'none', winner: rc.force, checks: [] };
  if (!decisionEval) return { phase: 'collecting', action: 'none', winner: null, checks: [] };

  const e = decisionEval;
  const best = e.best;
  const bestBreaches = best ? e.guardrailBreaches.filter((b) => b.arm === best.arm) : [];
  const checks = [
    { id: 'days', ok: e.days >= planned.minDays, detail: `${e.days} giorni nella finestra (minimo ${planned.minDays})` },
    {
      id: 'sample',
      ok: planned.requiredPerArm != null && e.minPersons >= planned.requiredPerArm,
      detail: `${fmtInt(e.minPersons)} persone nel braccio più piccolo (pianificate ${fmtInt(planned.requiredPerArm)})`,
    },
    { id: 'srm', ok: Boolean(e.srm) && !e.srm.mismatch, detail: e.srm ? `p = ${fmtP(e.srm.pValue)}` : 'non calcolabile' },
    {
      id: 'winner',
      ok: Boolean(best),
      detail: best
        ? `\`${best.arm}\` ${fmtUplift(best.uplift)} vs control, p Holm ${fmtP(best.pHolm)}`
        : 'nessun challenger batte il control con p Holm < α',
    },
    {
      id: 'guardrail',
      ok: Boolean(best) && bestBreaches.length === 0,
      detail: !best
        ? 'nessun vincente da verificare'
        : bestBreaches.length
          ? bestBreaches.map((b) => `${FAMILY_LABEL[b.family]} ${fmtUplift(b.uplift)} (p Holm ${fmtP(b.pHolm)})`).join('; ')
          : 'il vincente non peggiora nessuna metrica di guardrail',
    },
    {
      id: 'attribution',
      ok: e.attribution.ok,
      detail: e.attribution.coverage == null
        ? 'copertura non misurabile'
        : `copertura ${fmtPct(e.attribution.coverage, 0)} (minimo ${fmtPct(plan.minAttributionCoverage, 0)})`,
    },
  ];
  // Oltre la durata massima nessun cambio automatico, nemmeno con un vincente
  // arrivato tardi: la lettura a `maxDays` è l'ultima che può promuovere.
  if (checks.every((c) => c.ok) && e.days <= plan.maxDays) return { phase: 'decision', action: 'promote', winner: best.arm, checks };
  if (e.days >= plan.maxDays) return { phase: 'max-duration', action: 'ask-owner', winner: null, checks };
  return { phase: 'decision', action: 'none', winner: null, checks };
}

// ── Stato persistito nella issue di stato ────────────────────

export const MONITOR_STATE_RE = /<!-- experiment-monitor-state (\{[^\n]*?\}) -->/;

export function readMonitorState(body) {
  const m = MONITOR_STATE_RE.exec(String(body || ''));
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

export function monitorStateMarker(state) {
  return `<!-- experiment-monitor-state ${JSON.stringify(state)} -->`;
}

/** Cosa è cambiato rispetto al giro precedente (per commenti e issue di allarme). */
export function diffMonitorState(prev, next) {
  const before = new Set(prev?.alarms || []);
  const after = new Set(next.alarms || []);
  return {
    phaseChanged: (prev?.phase ?? null) !== next.phase,
    newAlarms: [...after].filter((a) => !before.has(a)),
    clearedAlarms: [...before].filter((a) => !after.has(a)),
    firstAskOwner: next.action === 'ask-owner' && prev?.action !== 'ask-owner',
  };
}

// ── Markdown ─────────────────────────────────────────────────

const FAMILY_LABEL = {
  primary: 'CR primaria',
  authRate: 'auth/gate',
  confirmRate: 'tasso di conferma',
};

const PHASE_LABEL = {
  waiting: 'in attesa del primo giorno assestato',
  collecting: 'raccolta dati (prima della durata minima)',
  decision: 'finestra di decisione',
  'max-duration': 'durata massima raggiunta senza vincente',
  forced: 'braccio forzato (promosso): monitor in pausa',
  disabled: 'esperimento spento (kill switch)',
};

function fmtUplift(u) {
  if (u == null || !Number.isFinite(u)) return '—';
  return `${u > 0 ? '+' : ''}${(u * 100).toFixed(1).replace('.', ',')}%`;
}

/**
 * Corpo della issue di stato. `state` finisce in un commento HTML in coda,
 * letto al giro successivo per capire cosa è cambiato.
 */
export function renderMonitorReport({ plan, planned, rc, statusEval, decisionEval, decision, alarms, estimate, statusPayload, state, runUrl = null, applied = null }) {
  const L = [];
  L.push(`# Monitor esperimento \`${plan.experimentId}\``);
  L.push('');
  L.push(`Aggiornato automaticamente ogni giorno da \`jobgate-experiment-monitor\`${runUrl ? ` ([run](${runUrl}))` : ''}. Solo lettura, salvo la promozione alle condizioni sotto.`);
  L.push('');
  L.push(`- **Fase:** ${PHASE_LABEL[decision.phase] || decision.phase}`);
  L.push(`- **Remote Config:** ENABLED=\`${rc.enabled}\`, FORCE=${rc.force ? `\`${rc.force}\`` : '(vuoto)'}, ARMS=${rc.armsRaw ? `\`${rc.armsRaw}\`` : '(assente)'}${rc.armsValid === false ? ' — **non valido: tutti in control**' : ''}`);
  if (statusEval) {
    L.push(`- **Giorni trascorsi:** ${statusEval.days} (finestra ${statusEval.since} → ${statusEval.until}, giorni assestati Europe/Zurich; dal ${plan.analysisStart}, lancio ${plan.launchedAt.slice(0, 10)})`);
  }
  L.push(`- **Piano:** baseline ${fmtPct(plan.baselineRate)} (${plan.baselineWindow}), effetto minimo +${Math.round(plan.relativeMde * 100)}%, potenza ${Math.round(plan.power * 100)}%, α ${String(plan.alpha).replace('.', ',')} (per confronto ${planned.alphaPerTest.toFixed(4).replace('.', ',')}) → **${fmtInt(planned.requiredPerArm)} persone gate_view per braccio**; durata minima **${planned.minDays} giorni** (finestra fino al ${planned.minWindowEnd}), massima ${plan.maxDays} (fino al ${planned.maxWindowEnd}); decisioni solo su settimane intere.`);
  if (estimate) {
    L.push(`- **Data prevista della decisione:** finestra fino al **${estimate.windowEnd}** (${estimate.days} giorni), leggibile ~2 giorni dopo${estimate.provisional ? ` (dal piano: la stima sul ritmo osservato parte dopo ${plan.checkpointDays} giorni)` : ''}${estimate.beyondMax ? ' — **oltre la durata massima al ritmo attuale**' : ''}.`);
  }
  L.push('');

  if (alarms.length) {
    L.push('## Allarmi');
    L.push('');
    for (const a of alarms) L.push(`- **${ALARM_LABEL[a.id] || a.id}:** ${a.detail}`);
    L.push('');
  }

  if (statusEval && statusPayload) {
    const r = statusPayload.readout;
    L.push('## Bracci (finestra più recente)');
    L.push('');
    L.push('| Braccio | Persone gate_view | Assegnati | Nuovi iscritti | CR primaria [IC95] | vs control | p Holm | Potenza raggiunta (piano) |');
    L.push('|---|---:|---:|---:|---|---:|---:|---:|');
    for (const arm of r.arms) {
      const a = r.perArm[arm];
      const cmp = (r.comparisons?.primary || []).find((c) => c.arm === arm);
      const pw = statusEval.power.find((p) => p.arm === arm);
      L.push(`| \`${arm}\` | ${fmtInt(a.gateView)} | ${fmtInt(a.assigned)} | ${fmtInt(a.newSubscribers)} | ${a.primary.rate == null ? '—' : `${fmtPct(a.primary.rate)} ${fmtCi(a.primary.ci95)}`} | ${arm === r.control ? '—' : fmtUplift(cmp?.uplift)} | ${arm === r.control ? '—' : fmtP(cmp?.pHolm)} | ${pw ? fmtPct(pw.achieved, 0) : '—'} |`);
    }
    L.push('');
    L.push(`- **SRM:** ${statusEval.srm ? `p = ${fmtP(statusEval.srm.pValue)}${statusEval.srm.mismatch ? ' — **ALLARME** (p < 0,001)' : ' (ok)'}` : 'non calcolabile'}`);
    L.push(`- **Campione:** ${fmtInt(statusEval.minPersons)} persone nel braccio più piccolo su ${fmtInt(planned.requiredPerArm)} pianificate (${planned.requiredPerArm ? fmtPct(statusEval.minPersons / planned.requiredPerArm, 0) : '—'}).`);
    L.push(`- **Attribuzione iscritti:** ${statusEval.attribution.coverage == null ? 'non misurabile' : `${fmtPct(statusEval.attribution.coverage, 0)} degli iscritti partiti dal gate porta il braccio (${statusEval.attribution.tagged} con, ${statusEval.attribution.untaggedFromGate} senza; minimo per promuovere ${fmtPct(plan.minAttributionCoverage, 0)})`}.`);
    L.push(`- **Robot esclusi:** ${statusEval.excludedApplied ? `${fmtInt(statusEval.excludedGateView)} persone gate_view nella finestra` : 'filtro disattivato'}.`);
    L.push('');
  }

  if (decision.checks.length) {
    L.push(`## Condizioni di promozione (finestra ${decisionEval.since} → ${decisionEval.until})`);
    L.push('');
    for (const c of decision.checks) L.push(`- ${c.ok ? '✅' : '❌'} ${CHECK_LABEL[c.id]}: ${c.detail}`);
    L.push('');
  }
  L.push('## Azione');
  L.push('');
  L.push(actionSentence(decision, applied));
  L.push('');
  L.push(monitorStateMarker(state));
  L.push('');
  return L.join('\n');
}

const ALARM_LABEL = {
  srm: 'SRM',
  guardrail: 'Braccio peggiore del control',
  attribution: 'Attribuzione incompleta',
};

const CHECK_LABEL = {
  days: '(a) durata minima',
  sample: '(b) campione per braccio',
  srm: '(c) nessun SRM',
  winner: '(d) vincente sulla CR primaria',
  guardrail: '(e) guardrail del vincente',
  attribution: '(e) attribuzione degli iscritti',
};

function actionSentence(decision, applied) {
  if (decision.action === 'promote') {
    if (applied === true) return `**Promosso \`${decision.winner}\`**: Remote Config \`JOBGATE_EXPERIMENT_FORCE=${decision.winner}\` pubblicato (etag, senza force).`;
    if (applied === false) return `**Promozione di \`${decision.winner}\` pronta** — pubblicazione fallita; Remote Config non modificato.`;
    return `**Promozione di \`${decision.winner}\` pronta** — nessuna pubblicazione senza approvazione manuale via \`workflow_dispatch\` (servono \`--apply --approve-promotion\`).`;
  }
  if (decision.action === 'ask-owner') return 'Nessun cambio automatico: durata massima raggiunta senza un vincente promuovibile. Decisione richiesta al proprietario.';
  if (decision.phase === 'forced') return `Nessuna azione: \`JOBGATE_EXPERIMENT_FORCE=${decision.winner}\` è già impostato (promozione fatta o QA in corso).`;
  if (decision.phase === 'disabled') return 'Nessuna azione: `JOBGATE_EXPERIMENT_ENABLED` non è `true`.';
  return 'Nessuna azione.';
}
