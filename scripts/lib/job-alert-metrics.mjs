// scripts/lib/job-alert-metrics.mjs
//
// Telemetria per fase del sender dei job alert (perf-plan PR 1). Ogni run deve
// dire da sola quanto tempo e quante operazioni Firestore spende in ciascuna
// fase: senza questo metro non si può verificare nessuna ottimizzazione.
//
// Modello. Una sola fase è «corrente» alla volta: `enter(nome)` chiude quella
// precedente (il tempo trascorso le viene addebitato) e apre la nuova. Le fasi
// del sender sono sequenziali ma alternate (planning → send → persist →
// planning …): le durate si sommano. Le operazioni Firestore arrivano da
// `firestore-op-counter.mjs` tramite `recordRead`/`recordWrite` e finiscono
// nella fase corrente, per collection.
//
// Privacy: i contatori sono aggregati. Nessuna email, nessun id di documento.

export const JOB_ALERT_PHASES = Object.freeze([
  'retry',
  'load_alerts',
  'profiles',
  'aux_profiles',
  'planning',
  'live_link',
  'send',
  'persist',
  'enrich',
  'health',
]);

const OTHER_PHASE = 'other';

function bump(map, key, amount) {
  map[key] = (map[key] || 0) + amount;
}

function sumValues(map) {
  let total = 0;
  for (const value of Object.values(map)) total += value;
  return total;
}

/**
 * @param {{ now?: () => number, memory?: () => {heapUsed: number, rss: number} }} [options]
 */
export function createJobAlertMetrics({
  now = () => performance.now(),
  memory = () => process.memoryUsage(),
} = {}) {
  const phases = new Map();
  const counters = {};
  let current = OTHER_PHASE;
  let enteredAt = now();
  let heapPeakBytes = 0;
  let rssPeakBytes = 0;

  const phaseState = (name) => {
    let state = phases.get(name);
    if (!state) {
      state = { ms: 0, readsByCollection: {}, writesByCollection: {} };
      phases.set(name, state);
    }
    return state;
  };

  const closeCurrent = () => {
    const at = now();
    phaseState(current).ms += Math.max(0, at - enteredAt);
    enteredAt = at;
  };

  const sampleMemory = () => {
    try {
      const usage = memory();
      if (usage.heapUsed > heapPeakBytes) heapPeakBytes = usage.heapUsed;
      if (usage.rss > rssPeakBytes) rssPeakBytes = usage.rss;
    } catch { /* la telemetria non deve mai rompere l'invio */ }
  };

  return {
    /** Cambia la fase corrente; il tempo trascorso va alla fase che si chiude. */
    enter(name) {
      closeCurrent();
      current = String(name || OTHER_PHASE);
      sampleMemory();
    },
    current: () => current,
    recordRead(collection, count = 1) {
      if (!(count > 0)) return;
      bump(phaseState(current).readsByCollection, String(collection || '(unknown)'), count);
    },
    recordWrite(collection, count = 1) {
      if (!(count > 0)) return;
      bump(phaseState(current).writesByCollection, String(collection || '(unknown)'), count);
    },
    /** Contatore additivo nominale (righe valutate, richieste HTTP, ...). */
    count(name, amount = 1) {
      counters[name] = (counters[name] || 0) + amount;
    },
    /** Valore puntuale (ultimo scritto vince). */
    set(name, value) {
      counters[name] = value;
    },
    sampleMemory,
    /**
     * Campiona l'heap a intervalli: il picco vero sta spesso fra due cambi di
     * fase. Il timer non tiene vivo il processo. Restituisce la funzione di stop.
     */
    startMemorySampler(intervalMs = 2000) {
      const timer = setInterval(sampleMemory, intervalMs);
      if (typeof timer.unref === 'function') timer.unref();
      return () => clearInterval(timer);
    },
    /** Chiude la fase in corso e restituisce il quadro completo. */
    snapshot({ date = null, mode = null, indexMode = null } = {}) {
      closeCurrent();
      sampleMemory();
      const byPhase = {};
      let reads = 0;
      let writes = 0;
      let ms = 0;
      const ordered = [...JOB_ALERT_PHASES, ...[...phases.keys()].filter((k) => !JOB_ALERT_PHASES.includes(k))];
      for (const name of ordered) {
        const state = phases.get(name);
        if (!state) continue;
        const phaseReads = sumValues(state.readsByCollection);
        const phaseWrites = sumValues(state.writesByCollection);
        byPhase[name] = {
          ms: Math.round(state.ms),
          reads: phaseReads,
          writes: phaseWrites,
          readsByCollection: { ...state.readsByCollection },
          writesByCollection: { ...state.writesByCollection },
        };
        reads += phaseReads;
        writes += phaseWrites;
        ms += state.ms;
      }
      return {
        v: 1,
        date,
        mode,
        indexMode,
        phases: byPhase,
        totals: { reads, writes, ms: Math.round(ms) },
        counters: { ...counters },
        heapPeakBytes,
        rssPeakBytes,
      };
    },
  };
}

/** La riga per il log: una sola, parsabile con `grep JOBALERT_METRICS`. */
export function formatJobAlertMetricsLine(snapshot) {
  return `📊 JOBALERT_METRICS ${JSON.stringify(snapshot)}`;
}

const fmt = (value) => (Number.isFinite(value) ? Math.trunc(value).toLocaleString('it-IT') : '—');

function mib(bytes) {
  return Number.isFinite(bytes) && bytes > 0 ? `${(bytes / 1024 / 1024).toFixed(0)} MiB` : '—';
}

function topCollections(map, limit = 4) {
  return Object.entries(map || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name, count]) => `${name} ${fmt(count)}`)
    .join(', ');
}

/** Stessa informazione, per il Job Summary di GitHub Actions. */
export function formatJobAlertMetricsMarkdown(snapshot) {
  const out = [`## 📊 Metriche per fase · ${snapshot.date || '—'} · ${snapshot.mode || '—'}`, ''];
  out.push('| Fase | Durata | Letture | Scritture | Collection principali (letture / scritture) |');
  out.push('| --- | ---: | ---: | ---: | --- |');
  for (const [name, phase] of Object.entries(snapshot.phases || {})) {
    const reads = topCollections(phase.readsByCollection);
    const writes = topCollections(phase.writesByCollection);
    out.push(`| ${name} | ${fmt(phase.ms / 1000)} s | ${fmt(phase.reads)} | ${fmt(phase.writes)} | ${[reads, writes].filter(Boolean).join(' / ') || '—'} |`);
  }
  const totals = snapshot.totals || {};
  out.push(`| **totale** | **${fmt((totals.ms || 0) / 1000)} s** | **${fmt(totals.reads)}** | **${fmt(totals.writes)}** | |`);
  out.push('');
  const c = snapshot.counters || {};
  out.push('| Contatore | Valore |', '| --- | ---: |');
  const rows = [
    ['modalità indice candidati', snapshot.indexMode || '—'],
    ['righe in finestra (cursorCandidateCount)', fmt(c.windowRows)],
    ['righe passate allo scorer', fmt(c.scoredRows)],
    ['alert pianificati con indice', fmt(c.indexedAlerts)],
    ['alert campionati (verifica legacy)', fmt(c.indexSampled)],
    ['indexMismatch', fmt(c.indexMismatch)],
    ['richieste HTTP live-link', fmt(c.liveLinkHttpRequests)],
    ['live-link risolti dal manifest', fmt(c.liveLinkManifestResolved)],
    ['alert in fail-open live-link', fmt(c.liveLinkFailOpen)],
    ['cadenceIndexViolations', fmt(c.cadenceIndexViolations)],
    ['heap di picco', mib(snapshot.heapPeakBytes)],
    ['RSS di picco', mib(snapshot.rssPeakBytes)],
  ];
  for (const [label, value] of rows) out.push(`| ${label} | ${value} |`);
  out.push('');
  return out.join('\n');
}
