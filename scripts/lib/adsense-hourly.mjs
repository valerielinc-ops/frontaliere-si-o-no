/**
 * adsense-hourly.mjs — logica pura del monitor orario AdSense
 * (scripts/adsense-hourly-monitor.mjs, .github/workflows/adsense-hourly-monitor.yml).
 *
 * L'API AdSense non ha una dimensione oraria: espone solo il totale del giorno.
 * Ogni run salva quel totale come snapshot cumulativo e il dettaglio orario
 * nasce dalla differenza fra snapshot consecutivi.
 *
 * Due controlli, entrambi contro lo stesso giorno della settimana precedente:
 *   - closed:   giorno chiuso, dai totali AdSense. Funziona subito, senza storico.
 *   - intraday: cumulato di oggi contro quello alla stessa ora di sette giorni
 *     prima. Richiede una settimana di snapshot.
 *
 * Backtest giugno-ottobre 2026 sui giorni chiusi, agosto-ottobre (91 giorni):
 * -20% in 6 giorni, -30% in 1, due giorni di fila in 1. Il -20% singolo e' quindi
 * rumore frequente (25 e 26/10 senza alcun guasto): apre la issue a priorita'
 * media, e sale ad alta solo se il calo e' profondo o persiste.
 */

export const ADSENSE_TIME_ZONE = 'Europe/Rome';
export const SNAPSHOT_COLLECTION = 'adsense_hourly_snapshots';
export const ALERT_COLLECTION = 'adsense_hourly_alerts';

export const DEFAULT_CONFIG = Object.freeze({
  dropThreshold: 0.2,
  severeDropThreshold: 0.3,
  // Replay sulle ore GA4 di 70 giorni fino al 30/10/2026: con 5 euro scattano 14
  // giorni, molti alle 10-11 su pochi euro; con 12 sono 7 e resta rilevato
  // l'incidente reale del 27/09 (che con 15 euro o 4 conferme si perde).
  minBaselineEarnings: 12,
  confirmRuns: 3,
  matchToleranceMinutes: 45,
  // I totali di ieri si assestano nella mattina: rpm-canary aspetta lo stesso assestamento.
  closedDaySettledHour: 12,
  staleRuns: 4,
  staleFromHour: 8,
  staleToHour: 22,
});

export function localClock(date, timeZone = ADSENSE_TIME_ZONE) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(date).map((p) => [p.type, p.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
    minuteOfDay: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

export function shiftDate(date, days) {
  const shifted = new Date(`${date}T12:00:00Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

/** Id in UTC: l'ora legale ripete un'ora locale, l'UTC mai. */
export function snapshotId(capturedAt) {
  return capturedAt.toISOString().slice(0, 16);
}

export function buildSnapshot({ capturedAt, today, previousDay = null, ga4 = null, currency = null }) {
  const clock = localClock(capturedAt);
  return {
    capturedAt: capturedAt.toISOString(),
    date: clock.date,
    minuteOfDay: clock.minuteOfDay,
    currency,
    earnings: today?.earnings ?? 0,
    pageViews: today?.pageViews ?? 0,
    adRequests: today?.adRequests ?? 0,
    impressions: today?.impressions ?? 0,
    clicks: today?.clicks ?? 0,
    coverage: today?.coverage ?? null,
    previousDay,
    ga4,
  };
}

const byCapture = (a, b) => a.capturedAt.localeCompare(b.capturedAt);

/**
 * Dettaglio orario di un giorno. Una differenza negativa non e' un calo di
 * revenue ma una revisione di AdSense: viene segnalata, non azzerata.
 */
export function hourlyDeltas(snapshots, date) {
  const rows = snapshots.filter((s) => s.date === date).sort(byCapture);
  return rows.map((s, i) => {
    const prev = rows[i - 1];
    const earnings = s.earnings - (prev?.earnings ?? 0);
    return {
      capturedAt: s.capturedAt,
      minuteOfDay: s.minuteOfDay,
      spanMinutes: prev ? s.minuteOfDay - prev.minuteOfDay : s.minuteOfDay,
      earnings: Number(earnings.toFixed(2)),
      pageViews: s.pageViews - (prev?.pageViews ?? 0),
      revised: earnings < 0,
    };
  });
}

export function comparableSnapshot(snapshots, date, minuteOfDay, toleranceMinutes) {
  let best = null;
  for (const s of snapshots) {
    if (s.date !== date) continue;
    const distance = Math.abs(s.minuteOfDay - minuteOfDay);
    if (distance <= toleranceMinutes && (!best || distance < best.distance)) best = { snapshot: s, distance };
  }
  return best?.snapshot ?? null;
}

function comparison(current, baseline, config) {
  // Arrotondata: in virgola mobile 8/10 - 1 e' -0.19999..., sopra la soglia del -20%.
  const change = Number((current.earnings / baseline.earnings - 1).toFixed(6));
  const pageViewsChange = baseline.pageViews > 0 ? current.pageViews / baseline.pageViews - 1 : null;
  const rpm = current.pageViews > 0 ? current.earnings / current.pageViews : null;
  const baselineRpm = baseline.pageViews > 0 ? baseline.earnings / baseline.pageViews : null;
  return {
    earnings: current.earnings,
    baselineEarnings: baseline.earnings,
    change,
    pageViewsChange,
    rpmChange: rpm !== null && baselineRpm ? rpm / baselineRpm - 1 : null,
    dropped: change <= -config.dropThreshold,
    severe: change <= -config.severeDropThreshold,
  };
}

/** Cumulato di oggi contro lo stesso orario di sette giorni prima, per `confirmRuns` run di fila. */
export function evaluateIntraday(snapshots, date, config = DEFAULT_CONFIG) {
  const today = snapshots.filter((s) => s.date === date).sort(byCapture).slice(-config.confirmRuns);
  if (today.length < config.confirmRuns) return { status: 'pending', reason: 'snapshot di oggi insufficienti' };
  const baselineDate = shiftDate(date, -7);
  const checks = [];
  for (const current of today) {
    const baseline = comparableSnapshot(snapshots, baselineDate, current.minuteOfDay, config.matchToleranceMinutes);
    if (!baseline) return { status: 'pending', reason: `nessuno snapshot comparabile il ${baselineDate}` };
    if (baseline.earnings < config.minBaselineEarnings) {
      return { status: 'pending', reason: `baseline sotto ${config.minBaselineEarnings} alla stessa ora` };
    }
    checks.push(comparison(current, baseline, config));
  }
  const latest = checks[checks.length - 1];
  const dropped = checks.every((c) => c.dropped);
  return { status: dropped ? 'alarm' : 'ok', date, baselineDate, ...latest, key: `intraday-${date}` };
}

/** Giorno chiuso contro lo stesso giorno della settimana precedente. */
export function evaluateClosedDay(dailyRows, today, hour, config = DEFAULT_CONFIG) {
  if (hour < config.closedDaySettledHour) return { status: 'pending', reason: 'totali di ieri non ancora assestati' };
  const byDate = new Map(dailyRows.map((r) => [r.date, r]));
  const date = shiftDate(today, -1);
  const baselineDate = shiftDate(date, -7);
  const current = byDate.get(date);
  const baseline = byDate.get(baselineDate);
  if (!current || !baseline || baseline.earnings <= 0) {
    return { status: 'pending', reason: `dati mancanti per ${date} o ${baselineDate}` };
  }
  const result = comparison(current, baseline, config);
  const priorDay = byDate.get(shiftDate(date, -1));
  const priorBaseline = byDate.get(shiftDate(baselineDate, -1));
  const previousDayDropped = Boolean(priorDay && priorBaseline?.earnings > 0
    && comparison(priorDay, priorBaseline, config).dropped);
  return {
    status: result.dropped ? 'alarm' : 'ok',
    date,
    baselineDate,
    ...result,
    consecutive: result.dropped && previousDayDropped,
    key: `closed-${date}`,
  };
}

/**
 * Totale fermo in piena giornata: il run funziona ma AdSense non aggiorna, o gli
 * annunci non vengono piu' serviti. Il confronto settimanale non lo distingue.
 */
export function detectStale(snapshots, date, config = DEFAULT_CONFIG) {
  const rows = snapshots.filter((s) => s.date === date).sort(byCapture).slice(-config.staleRuns);
  if (rows.length < config.staleRuns) return false;
  const last = rows[rows.length - 1];
  const inDaytime = last.minuteOfDay >= config.staleFromHour * 60 && last.minuteOfDay < config.staleToHour * 60;
  return inDaytime && rows.every((s) => s.earnings === last.earnings && s.pageViews === last.pageViews);
}

/**
 * Stato del run. `recovered` richiede un giorno chiuso misurato e sano: chiude
 * la issue. `pending` non apre e non chiude nulla.
 */
export function monitorDecision({ closed, intraday, stale, alreadyNotified = () => false }) {
  const alarms = [];
  if (closed.status === 'alarm') alarms.push({ kind: 'closed', ...closed });
  if (intraday.status === 'alarm') alarms.push({ kind: 'intraday', ...intraday });
  if (stale) alarms.push({ kind: 'stale', key: `stale-${stale}` });
  if (alarms.length > 0) {
    const fresh = alarms.filter((a) => !alreadyNotified(a.key));
    const severe = alarms.some((a) => a.severe || a.consecutive);
    return { status: fresh.length > 0 ? 'alarm' : 'notified', alarms: fresh, priority: severe ? 2 : 3 };
  }
  return { status: closed.status === 'ok' ? 'recovered' : 'pending', alarms: [], priority: null };
}

const percent = (value) => (value === null || value === undefined ? 'n/d' : `${(value * 100).toFixed(0)}%`);

/** Lettura rapida: chi deve agire vede subito se manca traffico o monetizzazione. */
export function diagnose(alarm) {
  if (alarm.kind === 'stale') return 'Totale AdSense fermo in piena giornata: verifica erogazione annunci e ritardo del report.';
  if (alarm.pageViewsChange !== null && alarm.pageViewsChange <= -0.15 && (alarm.rpmChange ?? 0) > -0.15) {
    return 'Calo trainato dal traffico: RPM stabile, pageview in calo.';
  }
  if ((alarm.rpmChange ?? 0) <= -0.15 && (alarm.pageViewsChange ?? 0) > -0.15) {
    return 'Calo trainato dalla monetizzazione: pageview stabili, RPM in calo.';
  }
  return 'Calo misto di traffico e RPM.';
}

export function buildIssueBody({ decision, runUrl = '' }) {
  const lines = [
    '## Revenue AdSense sotto la settimana precedente',
    '',
    '| Controllo | Periodo | Revenue | Baseline | Variazione | Pageview | RPM |',
    '|---|---|---:|---:|---:|---:|---:|',
  ];
  const notes = [];
  for (const alarm of decision.alarms) {
    if (alarm.kind === 'stale') {
      lines.push(`| stale | ${alarm.key.slice(6)} | - | - | - | - | - |`);
    } else {
      const label = alarm.kind === 'closed' ? 'giorno chiuso' : 'cumulato intraday';
      lines.push(`| ${label} | ${alarm.date} vs ${alarm.baselineDate} | ${alarm.earnings.toFixed(2)} | ${alarm.baselineEarnings.toFixed(2)} | ${percent(alarm.change)} | ${percent(alarm.pageViewsChange)} | ${percent(alarm.rpmChange)} |`);
    }
    notes.push(`- ${diagnose(alarm)}`);
  }
  lines.push('', ...notes, '');
  lines.push('Soglia -20% contro lo stesso giorno della settimana precedente; un singolo giorno sotto soglia capita circa 2 volte al mese senza guasti (backtest in `scripts/lib/adsense-hourly.mjs`).');
  lines.push(`Storico: collezione Firestore \`${SNAPSHOT_COLLECTION}\`. Controlla anche \`revenue-signal-monitor\` e \`rpm-canary\`.`);
  if (runUrl) lines.push('', `**Run:** ${runUrl}`);
  return lines.join('\n');
}
