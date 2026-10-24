/**
 * Strumentazione di fase per i plugin medi del build (campagna «durata del
 * deploy al minimo»). Due servizi, entrambi osservazionali:
 *
 *  1. `[phase-io]` — per ogni closeBundle avvolto, una riga con CPU utente /
 *     sistema e operazioni di blocco lette/scritte (`process.resourceUsage()`),
 *     cosi' un log di deploy distingue una fase legata alla CPU da una legata
 *     al disco senza un secondo run. Sempre attiva: costa due syscall a fase.
 *  2. Profilo CPU di fase — solo con `PHASE_CPU_PROFILE=1` (oppure una lista di
 *     etichette separate da virgola): apre una sessione `inspector` sul thread
 *     principale per la durata del closeBundle e scrive
 *     `<dir>/<etichetta>.cpuprofile` (dir = `PHASE_CPU_PROFILE_DIR`, default
 *     `/tmp/cpuprof`, la cartella che il banco gia' carica come artifact).
 *     Intervallo di campionamento `PHASE_CPU_PROFILE_INTERVAL_US` (default
 *     5000 us): un profilo di processo intero su una build da 2,5 h sarebbe
 *     di centinaia di MB, quello di una fase da 5-10 minuti sta in pochi MB.
 *
 * I tempi usano `performance.now()`: il clock congelato del banco
 * (freeze_clock/compare_variants) blocca `Date.now()` e li azzererebbe.
 *
 * Senza env il wrapper e' l'identita' sul comportamento: non cambia ordine,
 * `order`/`sequential` dell'hook, ne' l'output del build.
 */
import fs from 'node:fs';
import inspector from 'node:inspector';
import path from 'node:path';
import type { Plugin } from 'vite';

function profileRequested(label: string): boolean {
  const raw = (process.env.PHASE_CPU_PROFILE ?? '').trim();
  if (!raw || raw === '0') return false;
  if (raw === '1' || raw === 'all') return true;
  return raw.split(',').map((s) => s.trim()).includes(label);
}

function post(session: inspector.Session, method: string, params?: object): Promise<any> {
  return new Promise((resolve, reject) => {
    session.post(method, params ?? {}, (err, result) => (err ? reject(err) : resolve(result)));
  });
}

async function startCpuProfile(label: string): Promise<(() => Promise<void>) | null> {
  if (!profileRequested(label)) return null;
  try {
    const session = new inspector.Session();
    session.connect();
    await post(session, 'Profiler.enable');
    const interval = Number(process.env.PHASE_CPU_PROFILE_INTERVAL_US) || 5000;
    await post(session, 'Profiler.setSamplingInterval', { interval });
    await post(session, 'Profiler.start');
    return async () => {
      try {
        const { profile } = await post(session, 'Profiler.stop');
        const dir = process.env.PHASE_CPU_PROFILE_DIR || '/tmp/cpuprof';
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `${label}.cpuprofile`);
        fs.writeFileSync(file, JSON.stringify(profile));
        console.log(`[phase-cpuprof] ${label} -> ${file} (${profile.samples?.length ?? 0} samples)`);
      } finally {
        session.disconnect();
      }
    };
  } catch (error) {
    console.warn(`[phase-cpuprof] ${label}: profilo non avviato: ${(error as Error).message}`);
    return null;
  }
}

/** Esegue `run` loggando `[phase-io]` ed eventualmente profilando la CPU. */
export async function runInstrumentedPhase<T>(label: string, run: () => Promise<T> | T): Promise<T> {
  const stopProfile = await startCpuProfile(label);
  const wall0 = performance.now();
  const cpu0 = process.cpuUsage();
  const io0 = process.resourceUsage();
  try {
    return await run();
  } finally {
    const cpu = process.cpuUsage(cpu0);
    const io1 = process.resourceUsage();
    console.log(
      `[phase-io] ${label.padEnd(28)} wall_s=${((performance.now() - wall0) / 1000).toFixed(1)} ` +
        `cpu_user_s=${(cpu.user / 1e6).toFixed(1)} cpu_sys_s=${(cpu.system / 1e6).toFixed(1)} ` +
        `fs_read_ops=${io1.fsRead - io0.fsRead} fs_write_ops=${io1.fsWrite - io0.fsWrite} ` +
        `max_rss_mb=${Math.round(io1.maxRSS / 1024)}`,
    );
    if (stopProfile) await stopProfile();
  }
}

/**
 * Avvolge `closeBundle` (funzione o oggetto `{order, sequential, handler}`)
 * preservando la forma. Un plugin senza closeBundle torna invariato.
 */
export function withPhaseInstrument(label: string, plugin: Plugin): Plugin {
  const original = plugin.closeBundle as unknown;
  if (!original) return plugin;
  if (typeof original === 'function') {
    const fn = original as (this: unknown, ...a: unknown[]) => unknown;
    return {
      ...plugin,
      closeBundle: function (this: unknown, ...args: unknown[]) {
        return runInstrumentedPhase(label, () => fn.apply(this, args));
      } as Plugin['closeBundle'],
    };
  }
  const hook = original as { handler?: (this: unknown, ...a: unknown[]) => unknown };
  if (typeof hook.handler !== 'function') return plugin;
  const handler = hook.handler;
  return {
    ...plugin,
    closeBundle: {
      ...(hook as object),
      handler: function (this: unknown, ...args: unknown[]) {
        return runInstrumentedPhase(label, () => handler.apply(this, args));
      },
    } as Plugin['closeBundle'],
  };
}
