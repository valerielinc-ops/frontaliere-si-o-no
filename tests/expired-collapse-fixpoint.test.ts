import { describe, expect, it } from 'vitest';
import { collapseDuplicateRouteEntries } from '../scripts/lib/expired-jobs-archive.mjs';
import { localeRouteKeys } from '../scripts/reconcile-crawler-company-ownership.mjs';
import capRefusedFixture from './__fixtures__/expired-collapse-cap-refused-roche.json';
import multipassFixture from './__fixtures__/expired-collapse-multipass-coop-ticino.json';

/**
 * Punto fisso di `collapseDuplicateRouteEntries` (issue #7737).
 *
 * Il collasso gira dentro il cron: ogni scrittore (`cleanup-jobs`,
 * `assemble-jobs-dataset`, i `backfill-*`) rilegge una slice GIA' collassata e
 * riapplica la stessa funzione. La sua uscita deve quindi essere un punto
 * fisso, o quasi: una voce il cui merge e' rifiutato dal cap resta nell'output
 * con `claimsRoutes: false`, quindi invisibile alle fusioni dello stesso giro,
 * e al giro dopo entra in un input diverso — cioe' l'output puo' cambiare
 * ancora. Fin qui e' innocuo (converge), ma niente lo verificava: un ciclo fra
 * due uscite alternate riscriverebbe ~330 MB di slice a ogni cron e farebbe
 * apparire e sparire rotte legacy senza che nessun gate se ne accorga.
 *
 * Misurato il 2026-09-06 sulle 549 slice committate: 7 hanno `capRefused > 0`,
 * TUTTE raggiungono un punto fisso, nessun ciclo, e il caso peggiore
 * (`coop-ticino-locale-cache`) si stabilizza alla terza applicazione.
 *
 * Le fixture sono DERIVATE da quelle slice — la componente connessa per rotta
 * minimizzata di `coop-ticino-locale-cache` (3 applicazioni, cascata) e di
 * `roche` (rifiuto del cap, idempotente subito), proiettate sui soli campi che
 * il collasso legge. Sono pinnate e non lette dal corpus vivo: il gate deve
 * fallire quando cambia il CODICE, non quando i crawler pubblicano.
 */

/** Tetto oltre il quale l'iterazione e' considerata non convergente. */
const MAX_COLLAPSE_PASSES = 8;

/**
 * Profilo MISURATO di ogni fixture (2026-09-06), letto come CRICCHETTO: ogni
 * soglia e' un massimo, quindi un fix che collassa di piu' o converge prima
 * resta verde, mentre uno che allunga la cascata, lascia piu' superstiti o
 * moltiplica i rifiuti del cap diventa rosso prima del merge — che e' il
 * segnale che qui manca(va) del tutto.
 *
 * Le soglie sono discriminanti, non decorative: verificato per mutazione il
 * 2026-09-06 sul solo fixture a cascata — tenere le voci rifiutate a reclamare
 * le proprie rotte (`keep(entry)` invece di `claimsRoutes: false`) porta i
 * superstiti da 3 a 4, e togliere l'ordinamento canonico dell'input porta i
 * rifiuti del cap da 1 a 2. Entrambe passavano con le sole asserzioni di
 * convergenza.
 */
const PROFILES: Record<string, { maxPasses: number; maxSurvivors: number; maxCapRefused: number }> = {
  'cap refusal (roche)': { maxPasses: 1, maxSurvivors: 2, maxCapRefused: 1 },
  'cascade (coop-ticino-locale-cache)': { maxPasses: 3, maxSurvivors: 3, maxCapRefused: 1 },
};

interface ArchiveEntry {
  companyKey?: string;
  slug?: string;
  expiredAt?: string;
  slugByLocale?: Record<string, string>;
  previousSlugs?: string[];
  previousSlugsByLocale?: Record<string, string[]>;
}

function namespacedRoutes(entries: ArchiveEntry[]): Set<string> {
  return new Set(entries.flatMap((entry) => (entry.companyKey
    ? [...localeRouteKeys(entry)].map((route) => `${entry.companyKey}::${route}`)
    : [])));
}

interface FixedPointProbe {
  /** Applicazioni distinte prima che l'uscita si ripeta. 1 = idempotente subito. */
  passes: number;
  /** 0 = punto fisso; > 1 = oscillazione fra `cycleLength` uscite diverse. */
  cycleLength: number;
  capRefusedFirstPass: number;
  routesLost: string[];
  entries: ArchiveEntry[];
}

/**
 * Applica il collasso finche' l'uscita non si ripete. Il confronto e' sulla
 * FIRMA dell'intero array, ordine incluso: due passaggi che producono le stesse
 * voci in ordine diverso riscriverebbero comunque il file su disco, quindi per
 * il churn del cron non sono lo stesso stato.
 */
function iterateToFixedPoint(input: ArchiveEntry[]): FixedPointProbe {
  const signatures: string[] = [];
  const routesLost: string[] = [];
  let current = input;
  let capRefusedFirstPass = 0;
  for (let pass = 1; pass <= MAX_COLLAPSE_PASSES; pass += 1) {
    const before = namespacedRoutes(current);
    const result = collapseDuplicateRouteEntries(current, { source: 'fixpoint-probe' });
    if (pass === 1) capRefusedFirstPass = result.capRefused;
    // Iterare non deve mai perdere una rotta: ogni URL indicizzato che sparisce
    // dall'archivio e' un 404 su un soft landing, non un'ambiguita'.
    const after = namespacedRoutes(result.entries);
    for (const route of before) if (!after.has(route)) routesLost.push(`pass ${pass}: ${route}`);
    const signature = JSON.stringify(result.entries);
    const seenAt = signatures.indexOf(signature);
    if (seenAt !== -1) {
      return {
        passes: signatures.length,
        cycleLength: seenAt === signatures.length - 1 ? 0 : signatures.length - seenAt,
        capRefusedFirstPass,
        routesLost,
        entries: result.entries,
      };
    }
    signatures.push(signature);
    current = result.entries;
  }
  return {
    passes: Number.POSITIVE_INFINITY,
    cycleLength: 0,
    capRefusedFirstPass,
    routesLost,
    entries: current,
  };
}

describe('collapseDuplicateRouteEntries fixed point', () => {
  const fixtures: Array<[string, ArchiveEntry[]]> = [
    ['cap refusal (roche)', capRefusedFixture as ArchiveEntry[]],
    ['cascade (coop-ticino-locale-cache)', multipassFixture as ArchiveEntry[]],
  ];

  it.each(fixtures)('reaches a fixed point on %s, and never cycles', (name, fixture) => {
    const probe = iterateToFixedPoint(fixture);
    const profile = PROFILES[name];

    // La fixture deve ancora esercitare la forma DIFFICILE. Se un cambio la
    // rende fondibile, il test resterebbe verde senza piu' osservare nulla:
    // meglio rosso, con l'istruzione di ri-derivarla dalle slice committate.
    expect(probe.capRefusedFirstPass, 'fixture no longer hits the legacy cap — re-derive it').toBeGreaterThan(0);
    // Un ciclo e' il difetto che questo test esiste per prendere: due uscite
    // che si alternano riscrivono le slice a ogni cron per sempre.
    expect(probe.cycleLength, 'collapse oscillates between outputs').toBe(0);
    expect(probe.passes).toBeLessThanOrEqual(MAX_COLLAPSE_PASSES);
    expect(probe.passes, 'convergence got slower').toBeLessThanOrEqual(profile.maxPasses);
    expect(probe.entries.length, 'fewer entries collapsed than before').toBeLessThanOrEqual(profile.maxSurvivors);
    expect(probe.capRefusedFirstPass, 'more merges refused by the cap than before').toBeLessThanOrEqual(profile.maxCapRefused);
    expect(probe.routesLost).toEqual([]);
  });

  it.each(fixtures)('is idempotent once stabilised on %s', (_name, fixture) => {
    const stable = iterateToFixedPoint(fixture).entries;

    // Al punto fisso, riapplicare il collasso non deve cambiare NIENTE — ne'
    // le voci ne' il loro ordine: e' la condizione che rende innocua la
    // rilettura che ogni scrittore fa della slice gia' collassata.
    const again = collapseDuplicateRouteEntries(stable, { source: 'fixpoint-probe' });
    expect(JSON.stringify(again.entries)).toBe(JSON.stringify(stable));
    expect(again.collapsed).toBe(0);
  });

  it('keeps every route of the input served at the fixed point', () => {
    for (const [, fixture] of fixtures) {
      const probe = iterateToFixedPoint(fixture);
      const served = namespacedRoutes(probe.entries);
      for (const route of namespacedRoutes(fixture)) expect(served.has(route), route).toBe(true);
    }
  });
});
