/**
 * buildMemoryGuard — fa fallire la build PRIMA che l'host la uccida (#5369 §7).
 *
 * ─── Il difetto che toglie ───────────────────────────────────────────────
 *
 * Il 2026-08-13T06:19:48Z il leg `build-locale (it)` del run 31672320271 e'
 * morto dentro lo step «Build (BUILD_LOCALE=it)»: nessun errore, nessuno
 * stack, nessun exit code, e via API quello step risulta ancora
 * `status: in_progress` su un job `conclusion: failure`. E' la firma di un
 * kill dell'host. Il push CDN del leg IT non e' quindi mai avvenuto, e il
 * guard #2569 («IT pubblicato per primo») ha bloccato de/fr/en — le issue
 * #5773 / #5772 / #5771 sono i tre sintomi a valle di quel silenzio.
 *
 * La PR #5775 ha aggiunto l'OSSERVATORE (un host-kill ora apre una issue
 * invece di sparire) e ha lasciato aperta la CAUSA apposta: un retry cieco
 * avrebbe mascherato un OOM ricorrente prima che il sampler lo dimostrasse.
 * Il sampler l'ha dimostrato — vedi la sezione «La misura» qui sotto.
 *
 * Questo modulo chiude l'altra meta': converte un kill opaco (exit 143 su uno
 * step che non conclude mai, quindi nessuno step `if: failure()` viene
 * valutato) in un **fallimento nominato**, con un exit code vero. Il
 * differenziale non e' cosmetico: `deploy.yml` ha gia' lo step «Report failure
 * to GitHub Issues (build)» a valle del build, ed e' rimasto `pending`
 * proprio perche' lo step ucciso non ha mai concluso. Con un'uscita
 * esplicita quello step gira.
 *
 * ─── La misura, run 31747139648 (2026-08-13, ultimo deploy verde 4/4) ────
 *
 * Host: `MemTotal=15988MB`. Per ogni leg, dal campionatore `[hostmem]` dello
 * step (ogni 10 s) e dalle milestone `[mem]` dentro la build:
 *
 *   leg | topRSS max | MemAvailable min
 *   ----|------------|------------------
 *   it  | 12279 MB   | 1912 MB
 *   de  | 12524 MB   | **1152 MB**
 *   fr  | 12532 MB   | 1800 MB
 *   en  | 12407 MB   | 1293 MB
 *
 * Cioe': **tutti e quattro i leg di una build VERDE finiscono entro ~1,2 GB
 * dal muro**, su un host da 16 GB. Il kill del 06:19 non e' stato un'anomalia:
 * e' il lato sfortunato di un margine del 7%.
 *
 * ─── Le due soglie, e perche' QUESTE ────────────────────────────────────
 *
 * 1. `rssCeilingMb` — il RATCHET. Deve stare SOPRA ogni picco verde misurato
 *    (max 12 532 MB) e SOTTO il punto in cui questo runner ha gia' ucciso una
 *    build. Quel punto e' documentato dal repo stesso: `profilePlugin.ts`
 *    registra che sul run 26480152688 l'ultima riga prima di exit 143 era
 *    `rss=13,100`. Quindi la finestra utile e' [12 532, 13 100] e il centro
 *    ragionevole e' **12 900 MB** — 368 MB (2,9 %) di margine sul verde piu'
 *    alto, 200 MB sotto il kill osservato. Un margine stretto e' voluto: e'
 *    un gate sulla PRESSIONE di memoria, e uno largo non farebbe in tempo.
 *
 *    Espresso come FRAZIONE di `MemTotal` (12 900 / 15 988 = 0,807) e non come
 *    assoluto, cosi' la stessa regola non fa fallire una build su una macchina
 *    piu' grande: la soglia significa «l'80,7 % dell'host», che e' la cosa che
 *    conta, non «12,9 GB».
 *
 * 2. `hostAvailFloorMb` — l'ULTIMA LINEA, e l'unica che vede la verita'. Il
 *    processo puo' restare sotto il suo tetto di RSS e morire lo stesso,
 *    perche' a uccidere e' la memoria dell'HOST (runner agent, sampler, page
 *    cache non reclamabile). **768 MB**: sotto il minimo verde piu' basso
 *    (1152 MB, leg de) di 384 MB — 33 % di margine, quindi non puo' scattare
 *    su una build che sarebbe arrivata in fondo — e abbastanza sopra lo zero
 *    perche' Node riesca ancora a scrivere la diagnosi e uscire.
 *
 *    Solo Linux con `/proc/meminfo`: `MemAvailable` (free + reclaimable) e'
 *    il numero giusto, `MemFree` no. Su macOS non esiste un equivalente
 *    confrontabile, quindi li' questa meta' e' spenta e resta il tetto RSS.
 *
 * ─── Perche' 3 campioni consecutivi ─────────────────────────────────────
 *
 * `WriteCollector` scarica a blocchi di 5000 file: un singolo campione puo'
 * cadere nel mezzo di un flush e leggere un picco che non e' uno stato. Con
 * `sampleIntervalMs=5000` e `consecutiveSamples=3` la soglia vuole **15 s di
 * pressione sostenuta**. E' anche il motivo per cui il tetto puo' permettersi
 * un margine del 2,9 %: non e' un campione, e' una tendenza.
 *
 * ─── Le env possono solo STRINGERE ──────────────────────────────────────
 *
 * `BUILD_MEM_RSS_CEILING_MB` e `BUILD_MEM_HOST_FLOOR_MB` esistono per gli
 * esperimenti locali, ma un valore che ALLENTA la soglia viene ignorato (e
 * detto a voce). Un gate che si puo' disattivare da env e' un gate vacuo: lo
 * stesso difetto che questa PR sta togliendo, con un nome diverso.
 *
 * ─── Il tetto RSS e' swap-aware (2026-08-20, issue #6134) ────────────────
 *
 * Il modello originale del tetto era «RSS oltre il 80,7% di MemTotal ⇒ kill
 * dell'host imminente». La campagna OOM del 19-08 (7 deploy su 8 morti exit
 * 134) ha dimostrato che il modello era incompleto: i leg morivano sul muro
 * V8 (`--max-old-space-size`) con ~2 GB di MemAvailable e ~3 GB di SwapFree
 * ancora liberi (run 32319344037), cioe' ben prima del kill dell'host. E i
 * leg VERDI chiudevano gia' con ~3 GB di swap usati senza alcun danno.
 *
 * La distanza dal kill dell'host non e' funzione della sola RAM fisica: e'
 * funzione della capacita' anonima totale (RAM + swap), perche' il kernel
 * EVICE le pagine fredde — il grafo Vite/Rollup (~4 GB, fermo durante tutta
 * la fase SSG) e le arene glibc pinnate sono esattamente quel tipo di pagina.
 * Quindi il tetto e' `RSS_CEILING_FRACTION × (MemTotal + credito swap)`, dove
 * il credito e' `min(SwapTotal, SWAP_CEILING_CREDIT_CAP_MB)`: il cap evita
 * che uno swapfile patologico (100 GB) renda il tetto irraggiungibile e il
 * ratchet vacuo. Su un host SENZA swap il comportamento e' byte-identico a
 * prima (credito 0), ed e' cosi' che i fixture storici dei test restano
 * validi senza riscriverli.
 *
 * A presidiare l'esaurimento della nuova capacita' c'e' un pavimento nuovo,
 * `swapFreeFloorMb`: quando `SwapFree` scende sotto, il kill e' davvero
 * vicino perche' il kernel non ha piu' dove evicere. Armato solo quando
 * SwapTotal ≥ 2 GB — su uno swap minuscolo il pavimento sarebbe
 * permanentemente sfondato gia' a riposo, cioe' un falso allarme strutturale.
 *
 * ─── La quantita' misurata e' il FOOTPRINT ANONIMO, non l'RSS nudo ───────
 *
 * La review di #6150 ha trovato il difetto della prima versione swap-aware:
 * confrontava l'RSS (pagine RESIDENTI, per definizione ≤ MemTotal) con un
 * tetto calcolato su MemTotal + swap — cioe' 16 208 MB gia' col solo swap di
 * default del runner (4 GB), sopra i 15 988 MB fisici. Un tetto che l'RSS
 * non puo' raggiungere e' un ratchet MORTO: una regressione da 12,5 a 15 GB
 * sarebbe passata in silenzio, e la prima diagnosi sarebbe tornata a essere
 * il kill opaco che questo modulo esiste per prevenire.
 *
 * Il fix e' misurare la stessa unita' del tetto: il footprint anonimo del
 * processo, `VmRSS + VmSwap` da `/proc/self/status`. Su un host senza swap
 * (o dove /proc non esiste) VmSwap e' 0/illeggibile e il footprint coincide
 * con l'RSS: il regime storico e' un caso particolare del nuovo, non un
 * ramo separato. I nomi esterni (`rssCeilingMb`, breach `rss-ceiling`,
 * `BUILD_MEM_RSS_CEILING_MB`) restano per compatibilita' di report, issue e
 * override — e' la quantita' campionata a essere cambiata, ed e' detto a
 * voce nella diagnosi e nella riga di log verde.
 *
 * ─── Il preflight: il lockstep tetto V8 ↔ swap e' MECCANICO ──────────────
 *
 * `build:ci` fissa il tetto V8 (14 336 MB) in package.json; lo swapfile lo
 * crea `scripts/ci/grow-build-swap.sh`, chiamato dai workflow. Sono due
 * file diversi, e la review di #6150 ha trovato due workflow che lanciavano
 * il build col tetto alzato senza lo swap — piu' il ramo fail-open dello
 * step (niente /mnt → warning e avanti). Il preflight di `buildStart`
 * chiude la classe: se il tetto configurato richiede lo swap e lo swap non
 * c'e', il build fallisce in 5 secondi con un errore nominato, invece di
 * morire host-kill 40 minuti dopo. Vale per QUALUNQUE workflow, anche uno
 * scritto domani che non ha mai sentito nominare lo step.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import v8 from 'node:v8';
import type { Plugin } from 'vite';

const MB = 1048576;

/**
 * Frazione di `MemTotal` oltre la quale l'RSS del processo di build e'
 * considerato una regressione. 0.807 → 12 900 MB sul runner GitHub da
 * 15 988 MB. Derivazione completa nel docblock del modulo.
 */
export const RSS_CEILING_FRACTION = 0.807;

/**
 * Pavimento ASSOLUTO su `MemAvailable` dell'host, in MB. Vedi il docblock:
 * 384 MB sotto il minimo osservato su una build verde.
 *
 * Resta un assoluto perche' una delle due ragioni che lo fissano lo e': Node
 * deve avere abbastanza memoria per scrivere la diagnosi e uscire, e quel
 * fabbisogno non cambia con la taglia dell'host. E' il PAVIMENTO del
 * pavimento — vedi {@link HOST_AVAIL_FLOOR_FRACTION} per la meta' che scala.
 */
export const DEFAULT_HOST_AVAIL_FLOOR_MB = 768;

/**
 * Frazione di `MemTotal` sotto la quale `MemAvailable` conta come pressione.
 *
 * ─── Perche' esiste (#5831 item 5) ──────────────────────────────────────
 *
 * Il reviewer di #5816 ha notato un'asimmetria reale fra le due soglie: il
 * tetto RSS e' espresso come FRAZIONE di `MemTotal` ({@link
 * RSS_CEILING_FRACTION}) e quindi riscala da solo se il runner cambia
 * taglia, mentre il pavimento era un assoluto calibrato su un runner
 * specifico da 15 988 MB. `deploy.yml` gira su `ubuntu-latest` per tutti i
 * suoi job (verificato: 4 occorrenze, nessun runner large/self-hosted), che
 * e' un'etichetta gestita da GitHub, non una taglia fissata dal repo: se
 * quella spec cambiasse, il tetto seguirebbe e il pavimento no.
 *
 * Su un host PIU' GRANDE un pavimento assoluto diventa progressivamente
 * irraggiungibile — la build morirebbe di pressione host senza che questa
 * meta' del gate dica niente, e resterebbe solo il tetto RSS, cioe' proprio
 * la meta' che il docblock sopra descrive come «non vede la verita'».
 *
 * 768 / 15 988 = 0,048. Espresso cosi', la soglia effettiva e' il MASSIMO
 * fra l'assoluto e la frazione:
 *
 *   host 15 988 MB (oggi) → max(768,  767) =  768 MB  ← INVARIATO
 *   host  8 192 MB        → max(768,  393) =  768 MB  ← l'assoluto protegge
 *   host 32 768 MB        → max(768, 1573) = 1573 MB  ← la frazione scala
 *
 * Cioe': sul runner attuale il comportamento e' byte-identico a prima (e
 * `tests/build-memory-guard.test.ts` lo pinna), e la regola non si allenta
 * mai — puo' solo STRINGERE su un host diverso, coerente con la direzione
 * `'raise'` che gia' governa l'override da env.
 */
export const HOST_AVAIL_FLOOR_FRACTION = 0.048;

/**
 * Quanto SwapTotal puo' al massimo ALZARE il tetto RSS, in MB. Vedi il
 * docblock del modulo («Il tetto RSS e' swap-aware»): senza cap, uno swap
 * enorme renderebbe il ratchet irraggiungibile. 8192 = lo swapfile extra che
 * `deploy.yml` crea per il build; col default del runner (4 GB) piu' quello,
 * il credito e' comunque saturato a 8 GB.
 */
export const SWAP_CEILING_CREDIT_CAP_MB = 8192;

/**
 * Pavimento assoluto su `SwapFree`, in MB. Sotto, il kernel sta finendo lo
 * spazio di evizione e il kill dell'host e' questione di campioni. 512 MB
 * lascia a Node la stessa headroom di diagnosi del pavimento host.
 */
export const DEFAULT_SWAP_FLOOR_MB = 512;

/** Frazione di SwapTotal sotto cui `SwapFree` conta come pressione. */
export const SWAP_FLOOR_FRACTION = 0.04;

/**
 * SwapTotal minimo perche' il pavimento swap sia armato: su uno swap sotto i
 * 2 GB il pavimento assoluto sarebbe sfondato gia' a riposo (falso allarme
 * permanente), quindi li' resta spento e presidiano tetto RSS + pavimento host.
 */
export const SWAP_FLOOR_MIN_TOTAL_MB = 2048;

/**
 * Preflight (vedi il docblock del modulo): sopra questo tetto V8 configurato,
 * il build su un runner CI Linux RICHIEDE lo swapfile di
 * `scripts/ci/grow-build-swap.sh`. 13 500 sta fra il vecchio tetto (12 288,
 * che i runner reggevano col solo swap di default) e quello nuovo (14 336).
 */
export const PREFLIGHT_RAISED_WALL_MB = 13500;

/**
 * SwapTotal minimo che prova che lo swapfile del build e' attivo: default
 * del runner (4 096) + swapfile (8 192) = 12 288; 10 240 tollera un default
 * piu' piccolo senza accettare il caso «solo default».
 */
export const PREFLIGHT_MIN_SWAP_MB = 10240;

/**
 * Overhead massimo plausibile del processo oltre l'old-space (code space,
 * external, buffer, arene glibc): serve al check di sanita' assoluta
 * «il tetto configurato non entra fisicamente nell'host».
 */
export const PREFLIGHT_OVERHEAD_MB = 2048;

/** Intervallo di campionamento e campioni consecutivi richiesti. */
export const DEFAULT_SAMPLE_INTERVAL_MS = 5000;
export const DEFAULT_CONSECUTIVE_SAMPLES = 3;

/** Il file che `scripts/ci/report-validate-dist-failure.mjs` legge (`DIAG_FILE`). */
export const DEFAULT_DIAG_FILE = '/tmp/build-failure-diag.txt';

/**
 * Dove finisce il referto. `/tmp` e NON `dist/`, di proposito: tutto cio' che
 * sta sotto `dist/` viene copiato negli shard e pubblicato, e questo file e'
 * diagnostica di CI, non contenuto del sito. In piu' `dist/` viene potato
 * (`prune-locale-shard.mjs`) e sfrondato (`strip-section-subtree.sh`) fra il
 * build e gli step che leggono il referto: `/tmp` sopravvive a entrambi.
 */
export const DEFAULT_REPORT_FILE = '/tmp/build-memory-peak.json';

/**
 * Il titolo della issue che il fallimento di questo gate apre. Vive qui e non
 * solo nel workflow perche' il body della diagnosi lo cita: chi legge la issue
 * deve poter risalire al gate senza cercare, e chi cambia il titolo deve
 * trovarsi davanti il gemello `mode: resolve` che lo chiude (vedi
 * `tests/failure-issue-closers.test.ts`).
 */
export const FAILURE_ISSUE_TITLE = 'il picco di memoria della build risale sopra la soglia';

export interface GuardThresholds {
  /** Tetto sull'RSS del processo, in MB (swap-aware — vedi il docblock). */
  rssCeilingMb: number;
  /** Pavimento su `MemAvailable` dell'host, in MB, o `null` se non misurabile. */
  hostAvailFloorMb: number | null;
  /**
   * Pavimento su `SwapFree` dell'host, in MB. `null` dove lo swap non c'e',
   * non e' leggibile, o e' troppo piccolo per un pavimento sensato
   * ({@link SWAP_FLOOR_MIN_TOTAL_MB}).
   */
  swapFreeFloorMb: number | null;
  consecutiveSamples: number;
}

export interface MemorySample {
  /** RSS del processo di build, in MB. */
  rssMb: number;
  /**
   * `VmSwap` del processo in MB (pagine del processo evacuate in swap),
   * oppure `null`/assente dove `/proc/self/status` non e' leggibile. Il
   * tetto confronta `rssMb + selfSwapMb` — il footprint anonimo — perche'
   * l'RSS nudo e' limitato dalla RAM fisica e non puo' mai raggiungere un
   * tetto calcolato su RAM + swap (vedi il docblock del modulo).
   */
  selfSwapMb?: number | null;
  /** `MemAvailable` dell'host in MB, oppure `null` dove non e' leggibile. */
  hostAvailMb: number | null;
  /** `SwapFree` dell'host in MB, oppure `null` dove non e' leggibile. */
  swapFreeMb: number | null;
}

export type BreachKind = 'rss-ceiling' | 'host-floor' | 'swap-floor';

export interface GuardState {
  peakRssMb: number;
  /** Picco del footprint anonimo (RSS + VmSwap del processo), in MB. */
  peakAnonMb: number;
  minHostAvailMb: number | null;
  minSwapFreeMb: number | null;
  samples: number;
  consecutiveRssOver: number;
  consecutiveHostUnder: number;
  consecutiveSwapUnder: number;
  breach: BreachKind | null;
}

export function createGuardState(): GuardState {
  return {
    peakRssMb: 0,
    peakAnonMb: 0,
    minHostAvailMb: null,
    minSwapFreeMb: null,
    samples: 0,
    consecutiveRssOver: 0,
    consecutiveHostUnder: 0,
    consecutiveSwapUnder: 0,
    breach: null,
  };
}

/**
 * Legge `MemAvailable` da `/proc/meminfo`, in MB.
 *
 * `MemAvailable` e non `MemFree`: il secondo esclude la page cache
 * reclamabile e su un runner che ha appena scritto ~50k file legge sempre
 * quasi zero, che sarebbe un falso allarme permanente.
 *
 * @returns MB disponibili, o `null` dove il file non esiste (macOS) o non e'
 *   parsabile — nel qual caso il pavimento host resta semplicemente spento.
 */
export function readHostAvailableMb(procMeminfoPath = '/proc/meminfo'): number | null {
  let raw: string;
  try {
    raw = fs.readFileSync(procMeminfoPath, 'utf-8');
  } catch {
    return null;
  }
  const m = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(raw);
  if (!m) return null;
  const kb = Number.parseInt(m[1], 10);
  if (!Number.isFinite(kb)) return null;
  return Math.round(kb / 1024);
}

/**
 * Legge `SwapTotal` e `SwapFree` da `/proc/meminfo`, in MB.
 *
 * @returns `null` dove il file non esiste (macOS), non e' parsabile, o non ha
 *   ENTRAMBE le righe — un fixture storico senza `SwapTotal` deve leggersi
 *   come «host senza swap», non come «swap di taglia ignota»: e' cio' che
 *   tiene il tetto byte-identico a prima su quei fixture.
 */
/**
 * Legge `VmRSS` e `VmSwap` del PROCESSO da `/proc/self/status`, in MB.
 *
 * E' la meta' «processo» del footprint anonimo: `VmRSS + VmSwap` e' quanto
 * il processo occupa fra RAM e swap, la quantita' che il tetto swap-aware
 * deve confrontare (l'RSS nudo e' limitato dalla RAM, vedi docblock).
 *
 * @returns `null` dove il file non esiste (macOS) o manca `VmRSS`. `VmSwap`
 *   assente con `VmRSS` presente (kernel molto vecchi) vale 0, non null.
 *
 * Verificato contro l'output reale di un runner GH Actions (#6174 item 2):
 * il kernel separa etichetta e valore con TAB (`VmRSS:\t 100392 kB`), non
 * spazi come nelle fixture sintetiche dei test — `\s+` nella regex copre
 * entrambi, quindi non serve alcun fix di parsing. Il test senza path in
 * `tests/build-memory-guard.test.ts` legge il file vero del processo a ogni
 * run e fa da regression guard permanente contro derive future.
 */
export function readSelfAnonMb(
  procSelfStatusPath = '/proc/self/status',
): { rssMb: number; swapMb: number } | null {
  let raw: string;
  try {
    raw = fs.readFileSync(procSelfStatusPath, 'utf-8');
  } catch {
    return null;
  }
  const rss = /^VmRSS:\s+(\d+)\s+kB$/m.exec(raw);
  if (!rss) return null;
  const rssKb = Number.parseInt(rss[1], 10);
  if (!Number.isFinite(rssKb)) return null;
  const swap = /^VmSwap:\s+(\d+)\s+kB$/m.exec(raw);
  const swapKb = swap ? Number.parseInt(swap[1], 10) : 0;
  return {
    rssMb: Math.round(rssKb / 1024),
    swapMb: Number.isFinite(swapKb) ? Math.round(swapKb / 1024) : 0,
  };
}

export function readHostSwapMb(
  procMeminfoPath = '/proc/meminfo',
): { totalMb: number; freeMb: number } | null {
  let raw: string;
  try {
    raw = fs.readFileSync(procMeminfoPath, 'utf-8');
  } catch {
    return null;
  }
  const total = /^SwapTotal:\s+(\d+)\s+kB$/m.exec(raw);
  const free = /^SwapFree:\s+(\d+)\s+kB$/m.exec(raw);
  if (!total || !free) return null;
  const totalKb = Number.parseInt(total[1], 10);
  const freeKb = Number.parseInt(free[1], 10);
  if (!Number.isFinite(totalKb) || !Number.isFinite(freeKb)) return null;
  return { totalMb: Math.round(totalKb / 1024), freeMb: Math.round(freeKb / 1024) };
}

/**
 * Legge `MemTotal` in MB, con fallback su `os.totalmem()` dove `/proc` non
 * c'e'. Serve a esprimere il tetto RSS come frazione dell'host (vedi il
 * docblock del modulo) invece che come assoluto.
 */
export function readHostTotalMb(procMeminfoPath = '/proc/meminfo'): number {
  try {
    const raw = fs.readFileSync(procMeminfoPath, 'utf-8');
    const m = /^MemTotal:\s+(\d+)\s+kB$/m.exec(raw);
    if (m) {
      const kb = Number.parseInt(m[1], 10);
      if (Number.isFinite(kb) && kb > 0) return Math.round(kb / 1024);
    }
  } catch {
    /* fallthrough */
  }
  return Math.round(os.totalmem() / MB);
}

/**
 * Applica un override da env **solo se STRINGE** la soglia.
 *
 * E' la regola che impedisce a questo gate di diventare vacuo: chiunque possa
 * scrivere una env in un workflow potrebbe altrimenti alzare il tetto a
 * 99999 e ottenere di nuovo un kill silenzioso, che e' il difetto di partenza.
 *
 * @param direction `'lower'` per un tetto (un valore piu' basso stringe),
 *   `'raise'` per un pavimento (un valore piu' alto stringe).
 * @returns il valore da usare, e `ignored: true` quando l'override e' stato
 *   scartato perche' allentava.
 */
export function applyTighteningOverride(
  fallback: number,
  rawEnv: string | undefined,
  direction: 'lower' | 'raise',
): { value: number; ignored: boolean } {
  if (rawEnv === undefined || rawEnv.trim() === '') return { value: fallback, ignored: false };
  const parsed = Number.parseInt(rawEnv.trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return { value: fallback, ignored: true };
  const tightens = direction === 'lower' ? parsed < fallback : parsed > fallback;
  if (!tightens) return { value: fallback, ignored: true };
  return { value: parsed, ignored: false };
}

/**
 * Risolve le soglie effettive per questo host.
 *
 * @param env normalmente `process.env`; iniettabile per i test.
 */
/**
 * Preflight di `buildStart` (vedi il docblock del modulo). Funzione PURA
 * come `observeSample`, per la stessa ragione: si testa con numeri
 * sintetici, non con una build da 90 minuti.
 *
 * Due regole, in ordine:
 * 1. Sanita' assoluta: `heapLimitMb + PREFLIGHT_OVERHEAD_MB` deve entrare in
 *    `MemTotal + SwapTotal`. Se non entra, il build morira' comunque — meglio
 *    in 5 secondi con un nome che in 40 minuti con un host-kill.
 * 2. Lockstep CI: su un runner CI Linux, un tetto ≥ PREFLIGHT_RAISED_WALL_MB
 *    richiede lo swapfile di grow-build-swap.sh (SwapTotal ≥
 *    PREFLIGHT_MIN_SWAP_MB). E' il check che rende impossibile lanciare
 *    `build:ci` col tetto alzato e lo swap dimenticato — la classe di buco
 *    trovata dalla review di #6150 su due workflow.
 *
 * Fuori da Linux (`/proc/meminfo` illeggibile) il preflight e' spento: il
 * caso e' il dev locale su macOS, dove il tetto alto esiste da sempre.
 * La regola 2 e' inoltre limitata a `CI` per non bocciare un dev Linux con
 * 64 GB di RAM che builda senza swap — per lui vale comunque la regola 1.
 */
export function resolvePreflight(
  heapLimitMb: number,
  env: NodeJS.ProcessEnv = process.env,
  procMeminfoPath = '/proc/meminfo',
): { verdict: 'ok' | 'fail'; reason: string; ciSignal: string } {
  // Segnale grezzo CI/GITHUB_ACTIONS, calcolato SEMPRE e riportato in ogni
  // ramo di ritorno (non solo nel fail della regola 2): la regola lockstep
  // (2) e' silente quando `isCi` risulta false — nessun breach, nessun
  // errore, il build passa come se fosse locale. Se la propagazione
  // env.CI/env.GITHUB_ACTIONS su uno dei 4 workflow che lanciano `build:ci`
  // (deploy.yml, deploy-matrix-experiment.yml, post-build-matrix-test.yml,
  // matrix-equivalence-check.yml) mai divergesse, questo e' l'unico punto
  // che lo renderebbe visibile — il chiamante lo stampa ad ogni build reale,
  // verde o rossa, invece di lasciare la regola 2 fail-open senza traccia.
  const isCi = env.CI === 'true' || env.GITHUB_ACTIONS === 'true';
  const ciSignal = `CI=${env.CI ?? 'unset'} GITHUB_ACTIONS=${env.GITHUB_ACTIONS ?? 'unset'} isCi=${isCi}`;
  const raw = (() => {
    try {
      return fs.readFileSync(procMeminfoPath, 'utf-8');
    } catch {
      return null;
    }
  })();
  if (raw === null) {
    return { verdict: 'ok', reason: 'preflight spento: /proc/meminfo non leggibile (host non Linux)', ciSignal };
  }
  const totalMb = readHostTotalMb(procMeminfoPath);
  const swapTotalMb = readHostSwapMb(procMeminfoPath)?.totalMb ?? 0;
  const capacityMb = totalMb + swapTotalMb;
  if (heapLimitMb + PREFLIGHT_OVERHEAD_MB > capacityMb) {
    return {
      verdict: 'fail',
      reason:
        `il tetto V8 configurato (${heapLimitMb} MB) piu' l'overhead di processo (${PREFLIGHT_OVERHEAD_MB} MB) ` +
        `non entra nella capacita' anonima dell'host (${totalMb} MB RAM + ${swapTotalMb} MB swap): ` +
        `il build morirebbe comunque — abbassa --max-old-space-size o aggiungi swap (scripts/ci/grow-build-swap.sh)`,
      ciSignal,
    };
  }
  if (isCi && heapLimitMb >= PREFLIGHT_RAISED_WALL_MB && swapTotalMb < PREFLIGHT_MIN_SWAP_MB) {
    return {
      verdict: 'fail',
      reason:
        `il tetto V8 a ${heapLimitMb} MB richiede lo swapfile del build e SwapTotal e' solo ${swapTotalMb} MB ` +
        `(soglia ${PREFLIGHT_MIN_SWAP_MB}): lo step che chiama scripts/ci/grow-build-swap.sh manca in questo workflow, ` +
        `o e' fallito (leggi il suo ::warning nel log). Senza, questo build e' la configurazione che il 19-08 ` +
        `ha ucciso 7 deploy su 8 (issue 6134)`,
      ciSignal,
    };
  }
  return { verdict: 'ok', reason: 'preflight ok', ciSignal };
}

export function resolveThresholds(
  env: NodeJS.ProcessEnv = process.env,
  procMeminfoPath = '/proc/meminfo',
): GuardThresholds & { ignoredOverrides: string[] } {
  const totalMb = readHostTotalMb(procMeminfoPath);
  // Il tetto e' swap-aware (vedi il docblock del modulo): la distanza dal
  // kill dell'host e' funzione della capacita' anonima totale, non della sola
  // RAM. Senza swap leggibile il credito e' 0 e il valore e' identico a prima.
  const swap = readHostSwapMb(procMeminfoPath);
  const swapCreditMb = Math.min(swap?.totalMb ?? 0, SWAP_CEILING_CREDIT_CAP_MB);
  const ceilingDefault = Math.round((totalMb + swapCreditMb) * RSS_CEILING_FRACTION);
  const ceiling = applyTighteningOverride(ceilingDefault, env.BUILD_MEM_RSS_CEILING_MB, 'lower');
  // Il pavimento host ha senso solo dove `MemAvailable` esiste davvero.
  const hostReadable = readHostAvailableMb(procMeminfoPath) !== null;
  // Come il tetto, anche il pavimento si deriva dalla `MemTotal` dell'host —
  // ma senza mai scendere sotto l'assoluto, che copre la headroom di cui Node
  // ha bisogno per scrivere la diagnosi. Vedi HOST_AVAIL_FLOOR_FRACTION.
  const floorDefault = Math.max(
    DEFAULT_HOST_AVAIL_FLOOR_MB,
    Math.round(totalMb * HOST_AVAIL_FLOOR_FRACTION),
  );
  const floor = applyTighteningOverride(
    floorDefault,
    env.BUILD_MEM_HOST_FLOOR_MB,
    'raise',
  );
  // Il pavimento swap e' armato solo dove lo swap e' abbastanza grande da
  // renderlo un segnale e non un falso allarme (SWAP_FLOOR_MIN_TOTAL_MB).
  const swapFloorArmed = swap !== null && swap.totalMb >= SWAP_FLOOR_MIN_TOTAL_MB;
  const swapFloorDefault = swapFloorArmed
    ? Math.max(DEFAULT_SWAP_FLOOR_MB, Math.round(swap.totalMb * SWAP_FLOOR_FRACTION))
    : DEFAULT_SWAP_FLOOR_MB;
  const swapFloor = applyTighteningOverride(
    swapFloorDefault,
    env.BUILD_MEM_SWAP_FLOOR_MB,
    'raise',
  );
  const ignoredOverrides: string[] = [];
  if (ceiling.ignored) ignoredOverrides.push('BUILD_MEM_RSS_CEILING_MB');
  if (floor.ignored) ignoredOverrides.push('BUILD_MEM_HOST_FLOOR_MB');
  // Niente gate su swapFloorArmed qui: ceiling/host-floor sopra segnalano
  // l'override ignorato indipendentemente da quanto la rispettiva soglia sia
  // "attiva" — il pavimento swap deve restare simmetrico, altrimenti un
  // override esplicito su uno swap sotto i 2 GB sparisce in silenzio invece
  // di comparire in ignoredOverrides (follow-up #6169 item 3).
  if (swapFloor.ignored) ignoredOverrides.push('BUILD_MEM_SWAP_FLOOR_MB');
  return {
    rssCeilingMb: ceiling.value,
    hostAvailFloorMb: hostReadable ? floor.value : null,
    swapFreeFloorMb: swapFloorArmed ? swapFloor.value : null,
    consecutiveSamples: DEFAULT_CONSECUTIVE_SAMPLES,
    ignoredOverrides,
  };
}

/**
 * Incorpora un campione nello stato e decide se una soglia e' stata sfondata.
 *
 * Funzione PURA di proposito: e' cio' che rende l'osservatore verificabile
 * senza una build da 70 minuti. `tests/build-memory-guard.test.ts` la guida
 * con campioni sintetici, incluso il caso reale (i minimi dei quattro leg
 * verdi devono restare verdi) e il caso che vogliamo rosso.
 *
 * @returns lo scostamento rilevato, o `null` finche' non ci sono
 *   `consecutiveSamples` campioni consecutivi oltre soglia.
 */
export function observeSample(
  state: GuardState,
  sample: MemorySample,
  thresholds: GuardThresholds,
): BreachKind | null {
  state.samples += 1;
  // Il footprint anonimo del processo: RSS + pagine del processo in swap.
  // Senza `selfSwapMb` (host senza /proc, o fixture storici) coincide con
  // l'RSS — il regime pre-swap e' il caso particolare, non un ramo a parte.
  const anonMb = sample.rssMb + (sample.selfSwapMb ?? 0);
  if (sample.rssMb > state.peakRssMb) state.peakRssMb = sample.rssMb;
  if (anonMb > state.peakAnonMb) state.peakAnonMb = anonMb;
  if (sample.hostAvailMb !== null) {
    state.minHostAvailMb =
      state.minHostAvailMb === null ? sample.hostAvailMb : Math.min(state.minHostAvailMb, sample.hostAvailMb);
  }
  if (sample.swapFreeMb !== null) {
    state.minSwapFreeMb =
      state.minSwapFreeMb === null ? sample.swapFreeMb : Math.min(state.minSwapFreeMb, sample.swapFreeMb);
  }

  // Il tetto confronta il FOOTPRINT, non l'RSS: e' l'unica delle due
  // quantita' che puo' davvero raggiungere un tetto calcolato su RAM + swap
  // (review di #6150 — un confronto RSS-vs-capacita' era un ratchet morto).
  state.consecutiveRssOver = anonMb > thresholds.rssCeilingMb ? state.consecutiveRssOver + 1 : 0;

  if (thresholds.hostAvailFloorMb !== null && sample.hostAvailMb !== null) {
    state.consecutiveHostUnder =
      sample.hostAvailMb < thresholds.hostAvailFloorMb ? state.consecutiveHostUnder + 1 : 0;
  } else {
    state.consecutiveHostUnder = 0;
  }

  if (thresholds.swapFreeFloorMb !== null && sample.swapFreeMb !== null) {
    state.consecutiveSwapUnder =
      sample.swapFreeMb < thresholds.swapFreeFloorMb ? state.consecutiveSwapUnder + 1 : 0;
  } else {
    state.consecutiveSwapUnder = 0;
  }

  // Il pavimento host ha precedenza: quando piu' soglie scattano nello stesso
  // campione e' quello che descrive la causa del kill imminente. Il pavimento
  // swap viene subito dopo: senza spazio di evizione, MemAvailable e' il
  // prossimo a collassare.
  if (state.consecutiveHostUnder >= thresholds.consecutiveSamples) {
    state.breach = 'host-floor';
    return 'host-floor';
  }
  if (state.consecutiveSwapUnder >= thresholds.consecutiveSamples) {
    state.breach = 'swap-floor';
    return 'swap-floor';
  }
  if (state.consecutiveRssOver >= thresholds.consecutiveSamples) {
    state.breach = 'rss-ceiling';
    return 'rss-ceiling';
  }
  return null;
}

/**
 * Il testo che finisce sia sullo stderr sia nel file di diagnostica letto
 * dallo step «Report failure to GitHub Issues (build)».
 *
 * Nomina il gate, la soglia sfondata e il numero misurato, perche' la issue
 * che ne nasce deve dire COSA e' cresciuto: la classe di guasto che stiamo
 * togliendo e' proprio «un fallimento senza causa scritta».
 */
export function formatBreachDiagnosis(
  kind: BreachKind,
  state: GuardState,
  thresholds: GuardThresholds,
): string {
  const cause =
    kind === 'host-floor'
      ? `Causa: MemAvailable dell'host e' sceso a ${state.minHostAvailMb} MB, sotto il pavimento di ${thresholds.hostAvailFloorMb} MB, per ${thresholds.consecutiveSamples} campioni consecutivi.`
      : kind === 'swap-floor'
        ? `Causa: SwapFree dell'host e' sceso a ${state.minSwapFreeMb} MB, sotto il pavimento di ${thresholds.swapFreeFloorMb} MB, per ${thresholds.consecutiveSamples} campioni consecutivi — il kernel sta finendo lo spazio di evizione.`
        : `Causa: il footprint anonimo del processo di build (RSS + VmSwap) ha superato il tetto di ${thresholds.rssCeilingMb} MB per ${thresholds.consecutiveSamples} campioni consecutivi (picco ${state.peakAnonMb} MB, di cui ${state.peakRssMb} MB residenti).`;
  const lines = [
    `[build-mem-guard] ${FAILURE_ISSUE_TITLE}`,
    '',
    cause,
    '',
    `peakAnonMb=${state.peakAnonMb} peakRssMb=${state.peakRssMb} minHostAvailMb=${state.minHostAvailMb ?? 'n/d'} minSwapFreeMb=${state.minSwapFreeMb ?? 'n/d'} rssCeilingMb=${thresholds.rssCeilingMb} hostAvailFloorMb=${thresholds.hostAvailFloorMb ?? 'n/d'} swapFreeFloorMb=${thresholds.swapFreeFloorMb ?? 'n/d'} samples=${state.samples}`,
    '',
    "Questa build e' stata fermata di proposito PRIMA che l'host la uccidesse.",
    "Un kill dell'host lascia lo step su `in_progress` senza exit code, e in quella",
    "condizione nessuno step `if: failure()` viene valutato: e' cosi' che il leg IT",
    "del run 31672320271 e' sparito senza aprire niente, bloccando gli shard de/fr/en.",
    '',
    'Dove guardare per prima cosa (profilo del 2026-08-13, run 31747139648):',
    "  - ~7,7 GB di RSS / ~4,1 GB di heap VIVO sono gia' residenti quando parte il PRIMO",
    "    plugin di closeBundle: e' il grafo di Vite/Rollup (20 256 moduli), trattenuto",
    "    per tutta la fase SSG perche' l'SSG gira DENTRO `bundle.close()`.",
    '  - +4,3 GB di heap vivo li aggiunge una fase sola, dentro `jobsSeoPagesPlugin`:',
    '    fra la milestone `[mem] jobsSeoPages: collector created` (4230 MB) e',
    '    `[mem] jobsSeoPages: after company-landing` (8507 MB).',
    '  - Grep utili sul log del run: `[mem] `, `[profile-mem] `, `[hostmem] `.',
  ];
  return lines.join('\n');
}

/**
 * Il plugin Vite. Campiona finche' la build vive, e alla fine scrive il
 * referto anche quando nessuna soglia e' stata sfondata — il numero verde e'
 * cio' che permette di dire «il picco e' salito» al giro dopo.
 */
export function buildMemoryGuardPlugin(): Plugin {
  const state = createGuardState();
  const thresholds = resolveThresholds();
  let timer: NodeJS.Timeout | null = null;

  const writeReport = () => {
    const report = {
      peakRssMb: state.peakRssMb,
      peakAnonMb: state.peakAnonMb,
      minHostAvailMb: state.minHostAvailMb,
      minSwapFreeMb: state.minSwapFreeMb,
      rssCeilingMb: thresholds.rssCeilingMb,
      hostAvailFloorMb: thresholds.hostAvailFloorMb,
      swapFreeFloorMb: thresholds.swapFreeFloorMb,
      consecutiveSamples: thresholds.consecutiveSamples,
      samples: state.samples,
      breach: state.breach,
      buildLocale: process.env.BUILD_LOCALE || '',
    };
    try {
      const target = process.env.BUILD_MEM_REPORT_FILE || DEFAULT_REPORT_FILE;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, JSON.stringify(report, null, 2) + '\n', 'utf-8');
    } catch {
      /* best-effort: il referto non deve mai essere lui a rompere la build */
    }
    return report;
  };

  const fail = (kind: BreachKind): never => {
    if (timer) clearInterval(timer);
    timer = null;
    const text = formatBreachDiagnosis(kind, state, thresholds);
    writeReport();
    // Scrittura SINCRONA: stdout/stderr qui sono pipe (`| tee /tmp/build.log`)
    // e possono troncare quando il processo muore. Il file no.
    try {
      fs.writeFileSync(process.env.DIAG_FILE || DEFAULT_DIAG_FILE, text + '\n', 'utf-8');
    } catch {
      /* best-effort */
    }
    // eslint-disable-next-line no-console
    console.error(text);
    throw new Error(`[build-mem-guard] ${FAILURE_ISSUE_TITLE} (${kind})`);
  };

  return {
    name: 'build-memory-guard',
    enforce: 'pre',
    // Solo `vite build`. In serve mode `buildStart` viene invocato lo stesso
    // (una volta, all'avvio del dev server) ma `closeBundle` non arriva mai:
    // il campionatore resterebbe armato per tutta la sessione di sviluppo, e
    // su una macchina gia' carica potrebbe far morire il DEV SERVER con un
    // errore pensato per la CI. Il picco che questo modulo presidia esiste
    // solo nella build.
    apply: 'build',
    buildStart() {
      if (timer) return;
      // Preflight: tetto V8 vs capacita' dell'host, e lockstep tetto↔swap in
      // CI. Fallisce in 5 secondi con un nome, invece dell'host-kill opaco
      // 40 minuti dopo. Scrive sullo stesso canale di diagnosi dei breach.
      const heapLimitMb = Math.round(v8.getHeapStatistics().heap_size_limit / MB);
      const preflight = resolvePreflight(heapLimitMb);
      // Stampato SEMPRE (ok o fail): e' la verifica end-to-end della
      // propagazione env.CI/env.GITHUB_ACTIONS nei 4 workflow che lanciano
      // `build:ci` — leggibile in ogni build log reale invece di restare un
      // presupposto mai osservato (review di #6172, item 3).
      // eslint-disable-next-line no-console
      console.log(`[build-mem-guard] preflight ciSignal: ${preflight.ciSignal}`);
      if (preflight.verdict === 'fail') {
        const text = `[build-mem-guard] preflight fallito: ${preflight.reason}`;
        try {
          fs.writeFileSync(process.env.DIAG_FILE || DEFAULT_DIAG_FILE, text + '\n', 'utf-8');
        } catch {
          /* best-effort */
        }
        // eslint-disable-next-line no-console
        console.error(text);
        throw new Error(text);
      }
      if (thresholds.ignoredOverrides.length > 0) {
        // eslint-disable-next-line no-console
        console.warn(
          `[build-mem-guard] override ignorati perche' ALLENTAVANO la soglia: ${thresholds.ignoredOverrides.join(', ')}`,
        );
      }
      // eslint-disable-next-line no-console
      console.log(
        `[build-mem-guard] armato rssCeilingMb=${thresholds.rssCeilingMb} (sul footprint RSS+VmSwap) hostAvailFloorMb=${thresholds.hostAvailFloorMb ?? 'n/d (no /proc/meminfo)'} swapFreeFloorMb=${thresholds.swapFreeFloorMb ?? 'n/d (swap assente o < 2 GB)'} heapLimitMb=${heapLimitMb} everyMs=${DEFAULT_SAMPLE_INTERVAL_MS} consecutive=${thresholds.consecutiveSamples}`,
      );
      timer = setInterval(() => {
        const self = readSelfAnonMb();
        const breach = observeSample(
          state,
          {
            rssMb: Math.round(process.memoryUsage.rss() / MB),
            selfSwapMb: self?.swapMb ?? null,
            hostAvailMb: readHostAvailableMb(),
            swapFreeMb: readHostSwapMb()?.freeMb ?? null,
          },
          thresholds,
        );
        if (breach) fail(breach);
      }, DEFAULT_SAMPLE_INTERVAL_MS);
      // Un campionatore non deve mai essere cio' che tiene vivo il processo.
      timer.unref?.();
    },
    closeBundle: {
      order: 'post',
      sequential: true,
      handler() {
        if (timer) clearInterval(timer);
        timer = null;
        const report = writeReport();
        // La riga verde porta anche la dimensione che assorbe le regressioni
        // nel regime swap-aware (footprint e swap minimo): l'RSS e' limitato
        // dalla RAM e da solo non mostrerebbe un creep di settimane che
        // consuma swap fino al pavimento (review di #6150, finding 7).
        // eslint-disable-next-line no-console
        console.log(
          `[build-mem-guard] peakAnonMb=${report.peakAnonMb} peakRssMb=${report.peakRssMb} minHostAvailMb=${report.minHostAvailMb ?? 'n/d'} minSwapFreeMb=${report.minSwapFreeMb ?? 'n/d'} rssCeilingMb=${report.rssCeilingMb} hostAvailFloorMb=${report.hostAvailFloorMb ?? 'n/d'} swapFreeFloorMb=${report.swapFreeFloorMb ?? 'n/d'} samples=${report.samples}`,
        );
      },
    },
  };
}
