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
  readHostAvailableMb,
  readHostTotalMb,
  applyTighteningOverride,
  resolveThresholds,
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

/** Soglie del runner GitHub, senza dipendere dall'host che esegue i test. */
const RUNNER: GuardThresholds = {
  rssCeilingMb: Math.round(15988 * RSS_CEILING_FRACTION), // 12902
  hostAvailFloorMb: DEFAULT_HOST_AVAIL_FLOOR_MB, // 768
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
        expect(observeSample(state, { rssMb: peakRssMb, hostAvailMb: minAvailMb }, RUNNER)).toBeNull();
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
    expect(observeSample(state, { rssMb: 11000, hostAvailMb: 700 }, RUNNER)).toBeNull();
    expect(observeSample(state, { rssMb: 11000, hostAvailMb: 640 }, RUNNER)).toBeNull();
    expect(observeSample(state, { rssMb: 11000, hostAvailMb: 500 }, RUNNER)).toBe('host-floor');
  });

  it('due campioni sotto e poi un recupero NON fanno fallire — un flush non e\' uno stato', () => {
    const state = createGuardState();
    observeSample(state, { rssMb: 11000, hostAvailMb: 700 }, RUNNER);
    observeSample(state, { rssMb: 11000, hostAvailMb: 640 }, RUNNER);
    expect(observeSample(state, { rssMb: 11000, hostAvailMb: 3000 }, RUNNER)).toBeNull();
    expect(observeSample(state, { rssMb: 11000, hostAvailMb: 700 }, RUNNER)).toBeNull();
    expect(observeSample(state, { rssMb: 11000, hostAvailMb: 700 }, RUNNER)).toBeNull();
    expect(state.breach).toBeNull();
    // il minimo osservato resta registrato anche se non ha fatto scattare nulla
    expect(state.minHostAvailMb).toBe(640);
  });

  it('il tetto RSS scatta a 3 campioni sopra soglia', () => {
    const state = createGuardState();
    expect(observeSample(state, { rssMb: 13000, hostAvailMb: 4000 }, RUNNER)).toBeNull();
    expect(observeSample(state, { rssMb: 13050, hostAvailMb: 4000 }, RUNNER)).toBeNull();
    expect(observeSample(state, { rssMb: 13090, hostAvailMb: 4000 }, RUNNER)).toBe('rss-ceiling');
    expect(state.peakRssMb).toBe(13090);
  });

  it('quando entrambe sfondano vince host-floor: e\' quella che descrive il kill', () => {
    const state = createGuardState();
    for (let i = 0; i < 2; i += 1) observeSample(state, { rssMb: 13500, hostAvailMb: 400 }, RUNNER);
    expect(observeSample(state, { rssMb: 13500, hostAvailMb: 400 }, RUNNER)).toBe('host-floor');
  });

  it('su un host senza /proc/meminfo il tetto RSS resta armato da solo', () => {
    const noFloor: GuardThresholds = { ...RUNNER, hostAvailFloorMb: null };
    const state = createGuardState();
    for (let i = 0; i < 2; i += 1) observeSample(state, { rssMb: 13500, hostAvailMb: null }, noFloor);
    expect(observeSample(state, { rssMb: 13500, hostAvailMb: null }, noFloor)).toBe('rss-ceiling');
  });
});

describe('la diagnosi dice CHE COSA e\' cresciuto', () => {
  it('nomina il titolo della issue e i due numeri, non solo il fatto', () => {
    const state = createGuardState();
    for (let i = 0; i < 3; i += 1) observeSample(state, { rssMb: 13500, hostAvailMb: 400 }, RUNNER);
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
