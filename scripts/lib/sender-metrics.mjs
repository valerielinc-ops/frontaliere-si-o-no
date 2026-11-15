// scripts/lib/sender-metrics.mjs
//
// Telemetria per fase, generica, per ogni sender di email (perf-plan email
// senders, A1). Estratta da `job-alert-metrics.mjs` (che resta un wrapper con la
// stessa API e lo stesso output `JOBALERT_METRICS`): ogni sender dichiara il
// proprio `tag` e le proprie `phases` e ottiene la stessa riga
// `📊 <TAG>_METRICS {json}` nel log e la stessa tabella nel Job Summary.
//
// Modello. Una sola fase è «corrente» alla volta: `enter(nome)` chiude quella
// precedente (il tempo trascorso le viene addebitato) e apre la nuova. Le fasi
// sono sequenziali ma possono alternarsi: le durate si sommano. Le operazioni
// Firestore arrivano da `firestore-op-counter.mjs` tramite
// `recordRead`/`recordWrite` e finiscono nella fase corrente, per collection.
//
// Privacy: i contatori sono aggregati. Nessuna email, nessun id di documento.

import { appendFileSync } from 'node:fs';

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
 * @param {{ tag?: string, phases?: readonly string[], now?: () => number,
 *   memory?: () => {heapUsed: number, rss: number} }} [options]
 */
export function createSenderMetrics({
  tag = 'SENDER',
  phases: phaseOrder = [],
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
    tag,
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
    /**
     * Chiude la fase in corso e restituisce il quadro completo. I campi extra
     * (es. `indexMode` della jobalert) finiscono subito dopo `mode`.
     */
    snapshot({ date = null, mode = null, ...extra } = {}) {
      closeCurrent();
      sampleMemory();
      const byPhase = {};
      let reads = 0;
      let writes = 0;
      let ms = 0;
      const ordered = [...phaseOrder, ...[...phases.keys()].filter((k) => !phaseOrder.includes(k))];
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
        ...extra,
        phases: byPhase,
        totals: { reads, writes, ms: Math.round(ms) },
        counters: { ...counters },
        heapPeakBytes,
        rssPeakBytes,
      };
    },
  };
}

/** La riga per il log: una sola, parsabile con `grep <TAG>_METRICS`. */
export function formatSenderMetricsLine(tag, snapshot) {
  return `📊 ${tag}_METRICS ${JSON.stringify(snapshot)}`;
}

export const fmt = (value) => (Number.isFinite(value) ? Math.trunc(value).toLocaleString('it-IT') : '—');

export function mib(bytes) {
  return Number.isFinite(bytes) && bytes > 0 ? `${(bytes / 1024 / 1024).toFixed(0)} MiB` : '—';
}

function topCollections(map, limit = 4) {
  return Object.entries(map || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name, count]) => `${name} ${fmt(count)}`)
    .join(', ');
}

/** Intestazione + tabella delle fasi (righe di markdown). */
export function senderPhaseTableLines(snapshot) {
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
  return out;
}

/** Tabella generica dei contatori (tutti, ordinati per nome) + memoria. */
export function formatSenderMetricsMarkdown(snapshot, { title = null } = {}) {
  const out = senderPhaseTableLines(snapshot);
  if (title) out[0] = `## 📊 ${title} · ${snapshot.date || '—'} · ${snapshot.mode || '—'}`;
  const c = snapshot.counters || {};
  out.push('| Contatore | Valore |', '| --- | ---: |');
  for (const key of Object.keys(c).sort()) {
    const value = c[key];
    out.push(`| ${key} | ${typeof value === 'number' ? fmt(value) : String(value)} |`);
  }
  out.push(`| heap di picco | ${mib(snapshot.heapPeakBytes)} |`);
  out.push(`| RSS di picco | ${mib(snapshot.rssPeakBytes)} |`);
  out.push('');
  return out.join('\n');
}

/** Aggiunge il markdown al Job Summary di GitHub Actions (no-op fuori da Actions). */
export function appendStepSummary(markdown, { env = process.env, append = appendFileSync } = {}) {
  const target = env.GITHUB_STEP_SUMMARY;
  if (!target || !markdown) return false;
  try {
    append(target, `${markdown}\n`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Emette la riga `<TAG>_METRICS` e la tabella nel Job Summary. Non lancia mai:
 * la telemetria non deve cambiare l'esito di una run.
 */
export function emitSenderMetrics(metrics, {
  tag = metrics?.tag || 'SENDER',
  date = null,
  mode = null,
  extra = {},
  title = null,
  log = console.log,
  warn = console.warn,
  env = process.env,
  append = appendFileSync,
} = {}) {
  try {
    const snapshot = metrics.snapshot({ date, mode, ...extra });
    log(formatSenderMetricsLine(tag, snapshot));
    if (appendStepSummary(formatSenderMetricsMarkdown(snapshot, { title }), { env, append })) {
      log('   📝 Metriche per fase aggiunte al Job Summary');
    }
    return snapshot;
  } catch (error) {
    warn(`   ⚠️  ${tag}_METRICS non emesse: ${String(error?.message || error).replace(/[^\s@]+@[^\s@]+/g, '[email]')}`);
    return null;
  }
}
