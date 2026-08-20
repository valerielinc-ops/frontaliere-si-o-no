import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  RSS_CEILING_FRACTION,
  DEFAULT_HOST_AVAIL_FLOOR_MB,
  HOST_AVAIL_FLOOR_FRACTION,
  DEFAULT_CONSECUTIVE_SAMPLES,
  FAILURE_ISSUE_TITLE,
  SWAP_CEILING_CREDIT_CAP_MB,
  DEFAULT_SWAP_FLOOR_MB,
  SWAP_FLOOR_FRACTION,
  SWAP_FLOOR_MIN_TOTAL_MB,
  PREFLIGHT_RAISED_WALL_MB,
  PREFLIGHT_MIN_SWAP_MB,
  PREFLIGHT_OVERHEAD_MB,
  readHostAvailableMb,
  readHostTotalMb,
  readHostSwapMb,
  readSelfAnonMb,
  applyTighteningOverride,
  resolveThresholds,
  resolvePreflight,
  createGuardState,
  observeSample,
  formatBreachDiagnosis,
  type GuardThresholds,
} from '../build-plugins/shared/buildMemoryGuard';
import { canonicalCleanedKey } from '../build-plugins/shared/canonicalCleanedKey';

/**
 * L'osservatore di #5369 §7 — il gate che deve andare rosso PRIMA che l'host
 * uccida la build.
 *
 * ─── Perche' questi test e non «lanciare la build» ──────────────────────
 *
 * L'evento non e' riproducibile a comando: serve un runner da 16 GB, ~70
 * minuti e un corpus da 331 MB. Quindi la logica di decisione e' una funzione
 * PURA (`observeSample`) e i test la guidano con i numeri VERI misurati sul
 * run 31747139648 (2026-08-13, ultimo deploy verde 4 su 4), letti dal
 * campionatore `[hostmem]` dello step:
 *
 *   leg | topRSS max | MemAvailable min
 *   ----|------------|------------------
 *   it  | 12279 MB   | 1912 MB
 *   de  | 12524 MB   | 1152 MB
 *   fr  | 12532 MB   | 1800 MB
 *   en  | 12407 MB   | 1293 MB
 *
 * La proprieta' che conta piu' di tutte e' la PRIMA: un gate che fa fallire
 * anche solo uno di quei quattro leg non e' un osservatore, e' un guasto
 * nuovo. La seconda e' che scatti davvero quando la pressione e' quella che
 * uccide.
 */

const MEMINFO_16GB = [
  'MemTotal:       16371340 kB',
  'MemFree:          423936 kB',
  'MemAvailable:    6594560 kB',
  'Buffers:          104448 kB',
  'Cached:          6250496 kB',
  'SwapFree:        3145724 kB',
  'Dirty:            228352 kB',
].join('\n') + '\n';

function tmpMeminfo(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memguard-'));
  const p = path.join(dir, 'meminfo');
  fs.writeFileSync(p, content, 'utf-8');
  return p;
}

/** Soglie del runner GitHub, senza dipendere dall'host che esegue i test.
 * `swapFreeFloorMb: null` = il regime storico pre-swap-awareness: i quattro
 * leg verdi del run 31747139648 non hanno una serie SwapFree campionata,
 * quindi qui si pinna solo cio' che quel run ha misurato davvero. */
const RUNNER: GuardThresholds = {
  rssCeilingMb: Math.round(15988 * RSS_CEILING_FRACTION), // 12902
  hostAvailFloorMb: DEFAULT_HOST_AVAIL_FLOOR_MB, // 768
  swapFreeFloorMb: null,
  consecutiveSamples: DEFAULT_CONSECUTIVE_SAMPLES, // 3
};

describe('readHostAvailableMb / readHostTotalMb', () => {
  it('legge MemAvailable, non MemFree', () => {
    const p = tmpMeminfo(MEMINFO_16GB);
    // 6594560 kB → 6440 MB. MemFree sarebbe 414 MB: se il modulo leggesse
    // quello, il pavimento scatterebbe su ogni build che ha appena scritto
    // 50k file, cioe' tutte.
    expect(readHostAvailableMb(p)).toBe(6440);
    expect(readHostAvailableMb(p)).not.toBe(414);
  });

  it('legge MemTotal', () => {
    expect(readHostTotalMb(tmpMeminfo(MEMINFO_16GB))).toBe(15988);
  });

  it('torna null (non 0, non NaN) dove /proc/meminfo non esiste — macOS', () => {
    expect(readHostAvailableMb('/nope/meminfo')).toBeNull();
  });

  it('torna null su un meminfo senza la riga MemAvailable (kernel vecchi)', () => {
    expect(readHostAvailableMb(tmpMeminfo('MemTotal: 16371340 kB\nMemFree: 423936 kB\n'))).toBeNull();
  });

  it('MemTotal ricade su os.totalmem() invece di 0 quando /proc non c\'e\'', () => {
    const fallback = readHostTotalMb('/nope/meminfo');
    expect(fallback).toBeGreaterThan(0);
    expect(fallback).toBe(Math.round(os.totalmem() / 1048576));
  });
});

describe('le env possono solo STRINGERE la soglia', () => {
  it('un tetto piu\' BASSO e\' accettato', () => {
    expect(applyTighteningOverride(12902, '9000', 'lower')).toEqual({ value: 9000, ignored: false });
  });

  it('un tetto piu\' ALTO e\' IGNORATO — e\' la porta che renderebbe il gate vacuo', () => {
    expect(applyTighteningOverride(12902, '99999', 'lower')).toEqual({ value: 12902, ignored: true });
  });

  it('un pavimento piu\' ALTO e\' accettato, uno piu\' BASSO e\' ignorato', () => {
    expect(applyTighteningOverride(768, '2000', 'raise')).toEqual({ value: 2000, ignored: false });
    expect(applyTighteningOverride(768, '10', 'raise')).toEqual({ value: 768, ignored: true });
  });

  it('valori non numerici, zero e negativi non disarmano niente', () => {
    for (const bad of ['', '   ', 'off', 'false', '0', '-1', 'NaN']) {
      expect(applyTighteningOverride(12902, bad, 'lower').value).toBe(12902);
    }
  });

  it('resolveThresholds deriva il tetto dalla MemTotal dell\'host, non da una costante', () => {
    const t = resolveThresholds({} as NodeJS.ProcessEnv, tmpMeminfo(MEMINFO_16GB));
    // 15988 × 0,807 = 12902 MB: sopra il picco verde piu' alto misurato
    // (12532 MB) e sotto il punto di kill osservato (~13100 MB, run
    // 26480152688, documentato in profilePlugin.ts).
    expect(t.rssCeilingMb).toBe(12902);
    expect(t.rssCeilingMb).toBeGreaterThan(12532);
    expect(t.rssCeilingMb).toBeLessThan(13100);
    expect(t.hostAvailFloorMb).toBe(768);
  });

  it('il pavimento host si spegne (null) dove MemAvailable non e\' leggibile', () => {
    expect(resolveThresholds({} as NodeJS.ProcessEnv, '/nope/meminfo').hostAvailFloorMb).toBeNull();
  });
});

/**
 * L'osservatore di #5831 item 5 — il pavimento host deve riscalare con la
 * taglia del runner, come gia' fa il tetto RSS.
 *
 * Il dubbio del reviewer di #5816 era un'asimmetria vera: `rssCeilingMb` e'
 * una frazione di `MemTotal` e segue l'host, `hostAvailFloorMb` era un
 * assoluto tarato su un runner da 15 988 MB. `deploy.yml` gira su
 * `ubuntu-latest`, un'etichetta la cui spec la decide GitHub, non il repo.
 *
 * Questi test pinnano le DUE meta' della regola, che tirano in direzioni
 * opposte e per ragioni diverse:
 *   - la frazione, perche' su un host grande un assoluto diventa
 *     irraggiungibile e questa meta' del gate smette di vedere;
 *   - l'assoluto, perche' su un host piccolo Node deve comunque avere la
 *     headroom per scrivere la diagnosi e uscire.
 */
describe('il pavimento host riscala con la taglia del runner (#5831 item 5)', () => {
  /** `/proc/meminfo` sintetico per un host di `totalMb`, con `availMb` liberi. */
  function meminfoFor(totalMb: number, availMb = Math.round(totalMb / 2)): string {
    return [
      `MemTotal:       ${totalMb * 1024} kB`,
      `MemFree:          ${Math.round(availMb / 2) * 1024} kB`,
      `MemAvailable:    ${availMb * 1024} kB`,
    ].join('\n') + '\n';
  }

  const floorFor = (totalMb: number): number | null =>
    resolveThresholds({} as NodeJS.ProcessEnv, tmpMeminfo(meminfoFor(totalMb))).hostAvailFloorMb;

  it('sul runner ATTUALE il valore e\' invariato: nessun cambio di comportamento oggi', () => {
    // La proprieta' che rende sicura questa modifica. 15988 × 0,048 = 767,4
    // → 767, che perde contro l'assoluto 768. Se un domani la frazione venisse
    // alzata al punto da superare l'assoluto QUI, questo test lo dice prima
    // che il gate inizi a bocciare build che oggi passano.
    expect(floorFor(15988)).toBe(DEFAULT_HOST_AVAIL_FLOOR_MB);
    // …e resta sotto il minimo verde piu' basso mai misurato (leg de, 1152 MB),
    // altrimenti il gate boccerebbe una build che sarebbe arrivata in fondo.
    expect(floorFor(15988)!).toBeLessThan(1152);
  });

  it('su un host PIU\' GRANDE la frazione vince e il pavimento sale', () => {
    // 32 GB: un assoluto da 768 MB sarebbe il 2,3% dell'host, cioe' un
    // pavimento che in pratica non scatta mai.
    expect(floorFor(32768)).toBe(Math.round(32768 * HOST_AVAIL_FLOOR_FRACTION));
    expect(floorFor(32768)!).toBeGreaterThan(DEFAULT_HOST_AVAIL_FLOOR_MB);
  });

  it('su un host PIU\' PICCOLO vince l\'assoluto: la headroom della diagnosi non scala', () => {
    expect(floorFor(8192)).toBe(DEFAULT_HOST_AVAIL_FLOOR_MB);
    expect(floorFor(4096)).toBe(DEFAULT_HOST_AVAIL_FLOOR_MB);
  });

  it('il pavimento non scende MAI sotto l\'assoluto, per nessuna taglia plausibile', () => {
    for (const totalMb of [2048, 4096, 8192, 15988, 16384, 32768, 65536, 131072]) {
      const floor = floorFor(totalMb)!;
      expect(floor, `host da ${totalMb} MB`).toBeGreaterThanOrEqual(DEFAULT_HOST_AVAIL_FLOOR_MB);
      // …ed e' monotono non decrescente nella taglia dell'host.
      expect(floor, `host da ${totalMb} MB`).toBeGreaterThanOrEqual(
        Math.round(totalMb * HOST_AVAIL_FLOOR_FRACTION) < DEFAULT_HOST_AVAIL_FLOOR_MB
          ? DEFAULT_HOST_AVAIL_FLOOR_MB
          : Math.round(totalMb * HOST_AVAIL_FLOOR_FRACTION),
      );
    }
  });

  it('l\'override da env puo\' ancora solo STRINGERE, anche contro il pavimento scalato', () => {
    const big = tmpMeminfo(meminfoFor(32768));
    const scaled = Math.round(32768 * HOST_AVAIL_FLOOR_FRACTION); // 1573
    // Un valore che ALLENTA (sotto il pavimento scalato) viene scartato…
    const loosened = resolveThresholds(
      { BUILD_MEM_HOST_FLOOR_MB: '900' } as NodeJS.ProcessEnv,
      big,
    );
    expect(loosened.hostAvailFloorMb).toBe(scaled);
    expect(loosened.ignoredOverrides).toContain('BUILD_MEM_HOST_FLOOR_MB');
    // …e uno che stringe passa.
    const tightened = resolveThresholds(
      { BUILD_MEM_HOST_FLOOR_MB: '2000' } as NodeJS.ProcessEnv,
      big,
    );
    expect(tightened.hostAvailFloorMb).toBe(2000);
    expect(tightened.ignoredOverrides).not.toContain('BUILD_MEM_HOST_FLOOR_MB');
  });
});

describe('observeSample — i quattro leg VERDI devono restare verdi', () => {
  const GREEN_LEGS = [
    { leg: 'it', peakRssMb: 12279, minAvailMb: 1912 },
    { leg: 'de', peakRssMb: 12524, minAvailMb: 1152 },
    { leg: 'fr', peakRssMb: 12532, minAvailMb: 1800 },
    { leg: 'en', peakRssMb: 12407, minAvailMb: 1293 },
  ];

  for (const { leg, peakRssMb, minAvailMb } of GREEN_LEGS) {
    it(`leg ${leg} (picco ${peakRssMb} MB, avail min ${minAvailMb} MB) non scatta`, () => {
      const state = createGuardState();
      // 40 campioni al picco sostenuto: molto piu' dei 3 consecutivi
      // richiesti, quindi non e' la finestra a salvarlo — sono le soglie.
      for (let i = 0; i < 40; i += 1) {
        expect(observeSample(state, { rssMb: peakRssMb, hostAvailMb: minAvailMb, swapFreeMb: null }, RUNNER)).toBeNull();
      }
      expect(state.breach).toBeNull();
      expect(state.peakRssMb).toBe(peakRssMb);
      expect(state.minHostAvailMb).toBe(minAvailMb);
    });
  }
});

describe('observeSample — scatta quando la pressione e\' quella che uccide', () => {
  it('il pavimento host vuole 3 campioni CONSECUTIVI', () => {
    const state = createGuardState();
    expect(observeSample(state, { rssMb: 11000, hostAvailMb: 700, swapFreeMb: null }, RUNNER)).toBeNull();
    expect(observeSample(state, { rssMb: 11000, hostAvailMb: 640, swapFreeMb: null }, RUNNER)).toBeNull();
    expect(observeSample(state, { rssMb: 11000, hostAvailMb: 500, swapFreeMb: null }, RUNNER)).toBe('host-floor');
  });

  it('due campioni sotto e poi un recupero NON fanno fallire — un flush non e\' uno stato', () => {
    const state = createGuardState();
    observeSample(state, { rssMb: 11000, hostAvailMb: 700, swapFreeMb: null }, RUNNER);
    observeSample(state, { rssMb: 11000, hostAvailMb: 640, swapFreeMb: null }, RUNNER);
    expect(observeSample(state, { rssMb: 11000, hostAvailMb: 3000, swapFreeMb: null }, RUNNER)).toBeNull();
    expect(observeSample(state, { rssMb: 11000, hostAvailMb: 700, swapFreeMb: null }, RUNNER)).toBeNull();
    expect(observeSample(state, { rssMb: 11000, hostAvailMb: 700, swapFreeMb: null }, RUNNER)).toBeNull();
    expect(state.breach).toBeNull();
    // il minimo osservato resta registrato anche se non ha fatto scattare nulla
    expect(state.minHostAvailMb).toBe(640);
  });

  it('il tetto RSS scatta a 3 campioni sopra soglia', () => {
    const state = createGuardState();
    expect(observeSample(state, { rssMb: 13000, hostAvailMb: 4000, swapFreeMb: null }, RUNNER)).toBeNull();
    expect(observeSample(state, { rssMb: 13050, hostAvailMb: 4000, swapFreeMb: null }, RUNNER)).toBeNull();
    expect(observeSample(state, { rssMb: 13090, hostAvailMb: 4000, swapFreeMb: null }, RUNNER)).toBe('rss-ceiling');
    expect(state.peakRssMb).toBe(13090);
  });

  it('quando entrambe sfondano vince host-floor: e\' quella che descrive il kill', () => {
    const state = createGuardState();
    for (let i = 0; i < 2; i += 1) observeSample(state, { rssMb: 13500, hostAvailMb: 400, swapFreeMb: null }, RUNNER);
    expect(observeSample(state, { rssMb: 13500, hostAvailMb: 400, swapFreeMb: null }, RUNNER)).toBe('host-floor');
  });

  it('su un host senza /proc/meminfo il tetto RSS resta armato da solo', () => {
    const noFloor: GuardThresholds = { ...RUNNER, hostAvailFloorMb: null };
    const state = createGuardState();
    for (let i = 0; i < 2; i += 1) observeSample(state, { rssMb: 13500, hostAvailMb: null, swapFreeMb: null }, noFloor);
    expect(observeSample(state, { rssMb: 13500, hostAvailMb: null, swapFreeMb: null }, noFloor)).toBe('rss-ceiling');
  });
});

/**
 * Il tetto swap-aware (issue #6134, 2026-08-20). La campagna OOM del 19-08
 * (7 deploy su 8, exit 134) e' morta sul muro V8 con ~2 GB di MemAvailable e
 * ~3 GB di SwapFree ancora liberi: il modello «RSS ≥ 80,7% di MemTotal ⇒
 * kill imminente» era falso su un host CON swap. Il tetto ora conta la
 * capacita' anonima totale (RAM + swap, con credito cappato), e a presidiare
 * l'esaurimento della capacita' nuova c'e' il pavimento su SwapFree.
 */
describe('il tetto RSS e\' swap-aware', () => {
  function meminfoWithSwap(totalMb: number, swapTotalMb: number, swapFreeMb = swapTotalMb): string {
    return [
      `MemTotal:       ${totalMb * 1024} kB`,
      `MemFree:          423936 kB`,
      `MemAvailable:    6594560 kB`,
      `SwapTotal:      ${swapTotalMb * 1024} kB`,
      `SwapFree:       ${swapFreeMb * 1024} kB`,
    ].join('\n') + '\n';
  }

  it('readHostSwapMb legge ENTRAMBE le righe, e torna null se manca SwapTotal', () => {
    const p = tmpMeminfo(meminfoWithSwap(15988, 4096, 3072));
    expect(readHostSwapMb(p)).toEqual({ totalMb: 4096, freeMb: 3072 });
    // Il fixture storico senza SwapTotal deve leggersi come «host senza swap»:
    // e' cio' che tiene i vecchi pin del tetto validi senza riscriverli.
    expect(readHostSwapMb(tmpMeminfo(MEMINFO_16GB))).toBeNull();
    expect(readHostSwapMb('/nope/meminfo')).toBeNull();
  });

  it('senza swap leggibile il tetto e\' IDENTICO a prima — nessun cambio sul regime storico', () => {
    const t = resolveThresholds({} as NodeJS.ProcessEnv, tmpMeminfo(MEMINFO_16GB));
    expect(t.rssCeilingMb).toBe(12902);
    expect(t.swapFreeFloorMb).toBeNull();
  });

  it('con lo swap di default del runner (4 GB) il tetto sale del credito pieno — e resta RAGGIUNGIBILE dal footprint', () => {
    const t = resolveThresholds({} as NodeJS.ProcessEnv, tmpMeminfo(meminfoWithSwap(15988, 4096)));
    expect(t.rssCeilingMb).toBe(Math.round((15988 + 4096) * RSS_CEILING_FRACTION)); // 16208
    // La proprieta' che la review di #6150 ha trovato mancante: 16208 e'
    // SOPRA la RAM fisica (15988), quindi l'RSS nudo non lo raggiunge mai —
    // ma il footprint anonimo (RSS+VmSwap) si', perche' la capacita' e'
    // RAM+swap. Il tetto deve stare SOTTO la capacita', o e' un ratchet morto.
    expect(t.rssCeilingMb).toBeLessThan(15988 + 4096);
    // Il pavimento swap e' armato: 4096 ≥ 2048, e max(512, 4096×0,04=164) = 512.
    expect(t.swapFreeFloorMb).toBe(DEFAULT_SWAP_FLOOR_MB);
  });

  it('il credito swap e\' CAPPATO, e il tetto resta sotto la capacita\' anonima', () => {
    const t = resolveThresholds({} as NodeJS.ProcessEnv, tmpMeminfo(meminfoWithSwap(15988, 32768)));
    expect(t.rssCeilingMb).toBe(
      Math.round((15988 + SWAP_CEILING_CREDIT_CAP_MB) * RSS_CEILING_FRACTION), // 19513
    );
    // Raggiungibilita': sotto la capacita' vera (RAM+swap)…
    expect(t.rssCeilingMb).toBeLessThan(15988 + 32768);
    // …mentre il pavimento segue lo swap VERO, non il credito cappato:
    // e' un pavimento di esaurimento, non un tetto di pressione.
    expect(t.swapFreeFloorMb).toBe(Math.round(32768 * SWAP_FLOOR_FRACTION)); // 1311
  });

  it('il ratchet e\' VIVO sul runner di produzione: il footprint puo\' sfondare il tetto, l\'RSS nudo no', () => {
    // Runner reale post grow-build-swap: MemTotal 15988, SwapTotal 12288 →
    // credito cappato 8192 → tetto 19513. Un processo con RSS 13 GB (sotto la
    // RAM) e 7 GB evacuati in swap ha footprint 20 GB: DEVE sfondare.
    const t = resolveThresholds({} as NodeJS.ProcessEnv, tmpMeminfo(meminfoWithSwap(15988, 12288)));
    const state = createGuardState();
    for (let i = 0; i < 2; i += 1) {
      expect(observeSample(state, { rssMb: 13000, selfSwapMb: 7000, hostAvailMb: 2000, swapFreeMb: 4000 }, t)).toBeNull();
    }
    expect(observeSample(state, { rssMb: 13000, selfSwapMb: 7000, hostAvailMb: 2000, swapFreeMb: 4000 }, t)).toBe('rss-ceiling');
    expect(state.peakAnonMb).toBe(20000);
    expect(state.peakRssMb).toBe(13000);
    // …e la diagnosi nomina il footprint, non solo l'RSS.
    const text = formatBreachDiagnosis('rss-ceiling', state, t);
    expect(text).toContain('footprint anonimo');
    expect(text).toContain('picco 20000 MB');
    // Il profilo VERDE misurato (RSS 12,5 GB + ~3 GB swap = 15,5 GB) resta verde.
    const green = createGuardState();
    for (let i = 0; i < 10; i += 1) {
      expect(observeSample(green, { rssMb: 12532, selfSwapMb: 3000, hostAvailMb: 1500, swapFreeMb: 9000 }, t)).toBeNull();
    }
  });

  it('readSelfAnonMb legge VmRSS+VmSwap; VmSwap assente vale 0; file assente vale null', () => {
    const p = tmpMeminfo('VmRSS:\t 8388608 kB\nVmSwap:\t 2097152 kB\n');
    expect(readSelfAnonMb(p)).toEqual({ rssMb: 8192, swapMb: 2048 });
    expect(readSelfAnonMb(tmpMeminfo('VmRSS:\t 1048576 kB\n'))).toEqual({ rssMb: 1024, swapMb: 0 });
    expect(readSelfAnonMb('/nope/status')).toBeNull();
    expect(readSelfAnonMb(tmpMeminfo('VmSwap:\t 1024 kB\n'))).toBeNull();
  });

  it('sotto i 2 GB di SwapTotal il pavimento swap resta SPENTO — sarebbe sfondato a riposo', () => {
    const t = resolveThresholds(
      {} as NodeJS.ProcessEnv,
      tmpMeminfo(meminfoWithSwap(15988, SWAP_FLOOR_MIN_TOTAL_MB - 1024)),
    );
    expect(t.swapFreeFloorMb).toBeNull();
    // …ma il credito sul tetto vale comunque: e' capacita' anonima reale.
    expect(t.rssCeilingMb).toBe(Math.round((15988 + 1024) * RSS_CEILING_FRACTION));
  });

  it('BUILD_MEM_SWAP_FLOOR_MB puo\' solo STRINGERE (alzare), come le altre env', () => {
    const meminfo = tmpMeminfo(meminfoWithSwap(15988, 12288));
    const loosened = resolveThresholds({ BUILD_MEM_SWAP_FLOOR_MB: '100' } as NodeJS.ProcessEnv, meminfo);
    // 12288 × 0,04 = 492 perde contro l'assoluto: max(512, 492) = 512.
    expect(loosened.swapFreeFloorMb).toBe(DEFAULT_SWAP_FLOOR_MB);
    expect(loosened.ignoredOverrides).toContain('BUILD_MEM_SWAP_FLOOR_MB');
    const tightened = resolveThresholds({ BUILD_MEM_SWAP_FLOOR_MB: '1024' } as NodeJS.ProcessEnv, meminfo);
    expect(tightened.swapFreeFloorMb).toBe(1024);
  });

  it('il pavimento swap scatta a 3 campioni consecutivi, e host-floor gli passa davanti', () => {
    const withSwap: GuardThresholds = { ...RUNNER, swapFreeFloorMb: 512 };
    const state = createGuardState();
    expect(observeSample(state, { rssMb: 11000, hostAvailMb: 2000, swapFreeMb: 400 }, withSwap)).toBeNull();
    expect(observeSample(state, { rssMb: 11000, hostAvailMb: 2000, swapFreeMb: 300 }, withSwap)).toBeNull();
    expect(observeSample(state, { rssMb: 11000, hostAvailMb: 2000, swapFreeMb: 200 }, withSwap)).toBe('swap-floor');
    expect(state.minSwapFreeMb).toBe(200);

    // Quando host-floor e swap-floor sfondano insieme, vince host-floor:
    // e' quello che descrive il kill imminente.
    const both = createGuardState();
    for (let i = 0; i < 2; i += 1) {
      observeSample(both, { rssMb: 11000, hostAvailMb: 400, swapFreeMb: 200 }, withSwap);
    }
    expect(observeSample(both, { rssMb: 11000, hostAvailMb: 400, swapFreeMb: 200 }, withSwap)).toBe('host-floor');
  });

  it('la diagnosi swap-floor nomina SwapFree, il pavimento e i numeri', () => {
    const withSwap: GuardThresholds = { ...RUNNER, swapFreeFloorMb: 512 };
    const state = createGuardState();
    for (let i = 0; i < 3; i += 1) {
      observeSample(state, { rssMb: 11000, hostAvailMb: 2000, swapFreeMb: 128 }, withSwap);
    }
    const text = formatBreachDiagnosis('swap-floor', state, withSwap);
    expect(text).toContain(FAILURE_ISSUE_TITLE);
    expect(text).toContain('SwapFree');
    expect(text).toContain('minSwapFreeMb=128');
    expect(text).toContain('swapFreeFloorMb=512');
  });
});

/**
 * Il preflight di buildStart (review di #6150): il lockstep «tetto V8 alzato
 * ⇔ swapfile del build attivo» era affidato a commenti in 3 workflow, e due
 * workflow che lanciano build:ci ne erano rimasti fuori. Qui e' meccanico.
 */
describe('resolvePreflight — il lockstep tetto↔swap e\' meccanico, non un commento', () => {
  function meminfoSwap(totalMb: number, swapTotalMb: number): string {
    return [
      `MemTotal:       ${totalMb * 1024} kB`,
      `MemAvailable:    ${Math.round(totalMb / 2) * 1024} kB`,
      `SwapTotal:      ${swapTotalMb * 1024} kB`,
      `SwapFree:       ${swapTotalMb * 1024} kB`,
    ].join('\n') + '\n';
  }
  const CI = { CI: 'true' } as NodeJS.ProcessEnv;
  const LOCAL = {} as NodeJS.ProcessEnv;

  it('fuori da Linux (niente /proc/meminfo) e\' spento', () => {
    expect(resolvePreflight(18432, CI, '/nope/meminfo').verdict).toBe('ok');
  });

  it('in CI, tetto alzato + swap solo di default = FAIL nominato (la classe dei 2 workflow scoperti)', () => {
    const r = resolvePreflight(14336, CI, tmpMeminfo(meminfoSwap(15988, 4096)));
    expect(r.verdict).toBe('fail');
    expect(r.reason).toContain('grow-build-swap');
  });

  it('in CI, tetto alzato + swapfile attivo = ok (il regime di deploy.yml)', () => {
    expect(resolvePreflight(14336, CI, tmpMeminfo(meminfoSwap(15988, 12288))).verdict).toBe('ok');
  });

  it('in CI, il vecchio tetto (12288) non richiede lo swapfile — regime storico intatto', () => {
    expect(resolvePreflight(12288, CI, tmpMeminfo(meminfoSwap(15988, 4096))).verdict).toBe('ok');
  });

  it('fuori CI la regola lockstep non vale (dev Linux con molta RAM)…', () => {
    expect(resolvePreflight(14336, LOCAL, tmpMeminfo(meminfoSwap(65536, 0))).verdict).toBe('ok');
  });

  it('…ma la sanita\' assoluta vale OVUNQUE: un tetto che non entra nell\'host fallisce subito', () => {
    const r = resolvePreflight(18432, LOCAL, tmpMeminfo(meminfoSwap(15988, 0)));
    expect(r.verdict).toBe('fail');
    expect(r.reason).toContain('capacita');
    // 18432 + overhead entra invece in un host con 15988 RAM + 12288 swap…
    // MA in CI resta il lockstep: qui siamo fuori CI, quindi ok.
    expect(resolvePreflight(18432, LOCAL, tmpMeminfo(meminfoSwap(15988, 12288))).verdict).toBe('ok');
  });

  it('le costanti stanno nell\'ordine che il preflight assume', () => {
    // RAISED_WALL fra il vecchio tetto e quello nuovo; MIN_SWAP fra il
    // default del runner e default+swapfile; overhead positivo.
    expect(PREFLIGHT_RAISED_WALL_MB).toBeGreaterThan(12288);
    expect(PREFLIGHT_RAISED_WALL_MB).toBeLessThanOrEqual(14336);
    expect(PREFLIGHT_MIN_SWAP_MB).toBeGreaterThan(4096);
    expect(PREFLIGHT_MIN_SWAP_MB).toBeLessThanOrEqual(12288);
    expect(PREFLIGHT_OVERHEAD_MB).toBeGreaterThan(0);
  });
});

describe('la diagnosi dice CHE COSA e\' cresciuto', () => {
  it('nomina il titolo della issue e i due numeri, non solo il fatto', () => {
    const state = createGuardState();
    for (let i = 0; i < 3; i += 1) observeSample(state, { rssMb: 13500, hostAvailMb: 400, swapFreeMb: null }, RUNNER);
    const text = formatBreachDiagnosis('host-floor', state, RUNNER);
    expect(text).toContain(FAILURE_ISSUE_TITLE);
    expect(text).toContain('peakRssMb=13500');
    expect(text).toContain('minHostAvailMb=400');
    expect(text).toContain('hostAvailFloorMb=768');
    // La ragione per cui questa PR esiste deve restare leggibile dalla issue.
    expect(text).toContain('31672320271');
    expect(text).toContain('jobsSeoPages: after company-landing');
  });
});

describe('il titolo della issue e il workflow non possono divergere', () => {
  /**
   * Il chiuditore dichiarato e' `sibling-resolve-step`: lo step gemello
   * `mode: resolve` nello stesso workflow, che chiude PER TITOLO. Titolo
   * diverso fra i due step = issue immortale (il guasto di #5470), e col
   * dedup sui primi 60 caratteri nemmeno se ne aprirebbe una seconda.
   * Questo test e' l'unico posto in cui le tre copie del titolo (costante TS
   * + step report + step resolve) sono confrontate.
   */
  const deployYml = fs.readFileSync(
    path.resolve(__dirname, '..', '.github', 'workflows', 'deploy.yml'),
    'utf-8',
  );

  it('il titolo compare ESATTAMENTE due volte in deploy.yml: report e resolve', () => {
    const occurrences = deployYml.split(FAILURE_ISSUE_TITLE).length - 1;
    expect(occurrences).toBe(2);
  });

  it('lo step di report dichiara closed-by: sibling-resolve-step', () => {
    const idx = deployYml.indexOf(FAILURE_ISSUE_TITLE);
    expect(idx).toBeGreaterThan(-1);
    expect(deployYml.slice(idx, idx + 400)).toContain('closed-by: sibling-resolve-step');
  });

  it('il titolo sta dentro i 60 caratteri del dedup, senza run id ne\' sha', () => {
    expect(FAILURE_ISSUE_TITLE.length).toBeLessThanOrEqual(60);
    expect(FAILURE_ISSUE_TITLE).not.toMatch(/\d{6,}/);
  });
});

describe('canonicalCleanedKey — stessa identita\', senza tenere il testo', () => {
  /** L'espressione che c'era prima, per confrontare le classi di equivalenza. */
  const oldKey = (description: string, requirements: string[]) =>
    `${description.length}${description}${requirements.join('')}`;

  const CASES: Array<[string, string[]]> = [
    ['', []],
    ['ab', ['c']],
    ['abc', []],
    ['a', ['b', 'c']],
    ['a', ['bc']],
    ['Cercasi infermiere a Lugano', ['Patente B', 'Tedesco C1']],
    ['Cercasi infermiere a Lugano', ['Patente B', 'Tedesco C1']],
    ['Cercasi infermiere a Lugano', ['Tedesco C1', 'Patente B']],
    ['Zürich · Pflegefachfrau HF — 80–100 %', ['Deutsch', 'Führerausweis']],
  ];

  it('produce sempre 40 caratteri esadecimali, qualunque sia la taglia dell\'input', () => {
    for (const [d, r] of CASES) expect(canonicalCleanedKey(d, r)).toMatch(/^[0-9a-f]{40}$/);
    // Il punto della modifica: una descrizione da 200 kB non produce una
    // chiave da 200 kB. Prima la chiave ERA la descrizione.
    const huge = 'x'.repeat(200_000);
    expect(canonicalCleanedKey(huge, [huge]).length).toBe(40);
  });

  it('e\' deterministica', () => {
    for (const [d, r] of CASES) expect(canonicalCleanedKey(d, r)).toBe(canonicalCleanedKey(d, r));
  });

  it('le classi di equivalenza sono IDENTICHE a quelle della vecchia chiave', () => {
    // Se questa proprieta' cade, il pre-pass popola chiavi che il ciclo
    // principale non trova: nessun errore, hit rate da 96,5 % a 0 %.
    for (const [d1, r1] of CASES) {
      for (const [d2, r2] of CASES) {
        expect(canonicalCleanedKey(d1, r1) === canonicalCleanedKey(d2, r2)).toBe(
          oldKey(d1, r1) === oldKey(d2, r2),
        );
      }
    }
  });

  it('il prefisso di lunghezza separa ("ab",["c"]) da ("abc",[]) — come prima', () => {
    expect(canonicalCleanedKey('ab', ['c'])).not.toBe(canonicalCleanedKey('abc', []));
  });

  it('e\' il digest dello STESSO flusso di byte, costruito senza concatenare', () => {
    const d = 'descrizione';
    const r = ['req1', 'req2'];
    const expected = createHash('sha1').update(`${d.length}${d}${r.join('')}`).digest('hex');
    expect(canonicalCleanedKey(d, r)).toBe(expected);
  });
});
