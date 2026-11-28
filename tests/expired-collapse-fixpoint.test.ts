import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { getPreviousSlugsForLocale, LOCALES } from '../scripts/lib/dedicated-crawler-common.mjs';
import {
  collapseDuplicateRouteEntries,
  localeRouteKeys as archiveLocaleRouteKeys,
  MAX_COLLAPSE_PASSES,
  repairExpiredRoutesWithinArchive,
} from '../scripts/lib/expired-jobs-archive.mjs';
import { clear as clearSlugJournal, getEvents } from '../scripts/lib/slug-history-journal.mjs';
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

  it.each(fixtures)('returns a fixed point in one call on %s', (_name, fixture) => {
    const first = collapseDuplicateRouteEntries(fixture, { source: 'fixed-point-contract' });
    const second = collapseDuplicateRouteEntries(first.entries, { source: 'fixed-point-contract' });

    expect(JSON.stringify(second.entries)).toBe(JSON.stringify(first.entries));
    expect(second.collapsed).toBe(0);
  });

  it('keeps every route of the input served at the fixed point', () => {
    for (const [, fixture] of fixtures) {
      const probe = iterateToFixedPoint(fixture);
      const served = namespacedRoutes(probe.entries);
      for (const route of namespacedRoutes(fixture)) expect(served.has(route), route).toBe(true);
    }
  });

  it('computes convergence signatures without serialising the full archive', () => {
    const source = readFileSync(
      new URL('../scripts/lib/expired-jobs-archive.mjs', import.meta.url),
      'utf8',
    );

    expect(source).toContain('archiveEntriesSignature(current)');
    expect(source).toContain('archiveEntriesSignature(result.entries)');
    expect(source).not.toContain('JSON.stringify(current)');
    expect(source).not.toContain('JSON.stringify(result.entries)');
  });

});

/**
 * Prova differenziale della velocita' del collasso (assemblaggio a freddo: ~370 s
 * sugli scaduti, quasi tutti spesi a ricalcolare chiavi e firme).
 *
 * Il collasso e' un invariante SEO: una rotta persa e' un 404 su un URL
 * indicizzato. Le ottimizzazioni (chiavi di rotta calcolate una volta per
 * record, nessuna firma ne' seconda passata quando il giro non ha formato
 * componenti ne' riparato nulla) devono quindi lasciare IDENTICO tutto cio'
 * che un chiamante puo' osservare: risultato completo, ordine, ordine delle
 * chiavi, contatori, eccezioni (non convergenza inclusa), mutazioni in place e
 * gli eventi del journal degli slug.
 *
 * I digest sotto sono stati calcolati con l'implementazione di origin/main
 * PRIMA dell'ottimizzazione, su archivi sintetici inventati (nessun dato
 * reale) generati da un PRNG con seme fisso. Se cambiano, l'uscita del
 * collasso e' cambiata: non rigenerarli senza capire perche'.
 */
type Loose = Record<string, any>;

function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6D2B79F5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Archivio sintetico: poche slug e alias, cosi' le rotte si scontrano davvero. */
function generateArchive(seed: number): Loose[] {
  const random = mulberry32(seed);
  const pick = <T,>(items: T[]): T => items[Math.floor(random() * items.length)];
  // I semi multipli di 4 producono storie quasi al tetto del bucket legacy
  // (20): e' li' che la fusione viene rifiutata dal cap.
  const heavy = seed % 4 === 0;
  const count = 2 + Math.floor(random() * 15);
  const companies = random() < 0.8 ? ['acme'] : ['acme', 'beta'];
  const dates = [
    '2026-01-01T00:00:00.000Z',
    '2026-02-01T00:00:00.000Z',
    '2026-02-01T00:00:00.000Z',
    '2026-03-01T00:00:00.000Z',
    'not-a-date',
    '',
  ];
  const identities = [undefined, undefined, 'url:u1', 'url:u2', 'url:u3', 'id:7', 'id:8'];
  const slugs = Array.from({ length: 10 }, (_, index) => `role-${index}`);
  const aliases = Array.from({ length: heavy ? 44 : 16 }, (_, index) => `alias-${index}`);
  const locales = ['it', 'en', 'de', 'fr'];
  const out: Loose[] = [];
  for (let index = 0; index < count; index += 1) {
    const slug = pick(slugs) + (random() < 0.5 ? `-${index}` : '');
    const entry: Loose = {
      id: random() < 0.3 ? `id${Math.floor(random() * 5)}` : undefined,
      slug,
      title: `T${index % 3}`,
      company: 'C',
      companyKey: pick(companies),
      location: 'L',
      expiredAt: pick(dates),
    };
    if (random() < 0.6) {
      entry.slugByLocale = {};
      for (const locale of locales) {
        if (random() < 0.8) entry.slugByLocale[locale] = random() < 0.5 ? slug : pick(slugs.concat(aliases));
      }
    }
    const long = heavy ? random() < 0.6 : random() < 0.12;
    if (random() < 0.6) {
      const length = long ? (heavy ? 19 + Math.floor(random() * 3) : 16 + Math.floor(random() * 6)) : Math.floor(random() * 5);
      entry.previousSlugs = Array.from({ length }, () => pick(aliases));
    }
    if (random() < 0.6) {
      entry.previousSlugsByLocale = {};
      for (const locale of locales.concat(random() < 0.1 ? ['es'] : [])) {
        if (random() < 0.6) {
          const length = long && random() < 0.5 ? 15 + Math.floor(random() * 6) : Math.floor(random() * 4);
          entry.previousSlugsByLocale[locale] = Array.from({ length }, () => pick(aliases));
        }
      }
    }
    if (random() < 0.3 && entry.previousSlugsByLocale) {
      entry.previousSlugCantonByLocale = {};
      for (const locale of Object.keys(entry.previousSlugsByLocale)) {
        if (!locales.includes(locale)) continue;
        const bySlug: Record<string, string> = {};
        for (const previous of entry.previousSlugsByLocale[locale]) {
          if (random() < 0.5) bySlug[previous] = pick(['TI', 'GR']);
        }
        if (Object.keys(bySlug).length > 0) entry.previousSlugCantonByLocale[locale] = bySlug;
      }
    }
    const identity = pick(identities);
    if (identity) entry.sourceIdentity = identity;
    if (random() < 0.15) entry.sourceIdentityHistory = [{ sourceIdentity: pick(identities.filter(Boolean)) }];
    if (random() < 0.2) entry.url = `https://x.example/${Math.floor(random() * 4)}`;
    if (random() < 0.2) entry.canton = 'TI';
    // Due record che condividono lo stesso array: una mutazione dell'uno cambia
    // anche le chiavi dell'altro, quindi nessuna chiave puo' sopravvivere a una riparazione.
    if (index > 0 && random() < 0.08) entry.previousSlugs = out[index - 1].previousSlugs;
    if (index > 0 && random() < 0.05) entry.slugByLocale = out[index - 1].slugByLocale;
    out.push(entry);
  }
  return out;
}

const digest = (value: string): string => createHash('sha256').update(value).digest('hex');

/** Tutto cio' che un chiamante puo' osservare di una chiamata, in una stringa. */
function observe(run: (input: Loose[]) => Loose, input: Loose[]): string {
  clearSlugJournal();
  let outcome: string;
  try {
    const result = run(input);
    const shell: Loose = {};
    for (const [key, value] of Object.entries(result)) shell[key] = key === 'entries' ? '#entries' : value;
    outcome = `ok:${JSON.stringify(shell)}:${JSON.stringify(result.entries)}:${result.entries === input}`;
  } catch (error) {
    outcome = `throw:${(error as Error).name}:${(error as Error).message}`;
  }
  const events = getEvents().map(({ ts: _ts, ...event }: Loose) => event);
  return `${outcome}|${JSON.stringify(input)}|${JSON.stringify(events)}`;
}

const OPTION_SETS: Record<string, Loose> = {
  // I confini di pubblicazione di assembleExpiredJobs: ogni collisione ha un solo titolare.
  production: { repairUnprovenCollisions: true, source: 'assemble/x/route-repair' },
  // I writer generici (cleanup, backfill) restano fail-closed.
  default: { source: 'cleanup-jobs/slice' },
  // Il fallback dopo un rifiuto del cap, senza ambiti.
  sharedIdentity: { repairUnprovenCollisions: true, repairSharedIdentityCollisions: true },
  // La riconciliazione di ownership: conta solo la sourceIdentity persistita.
  sourceIdentityOnly: { sourceIdentityOnly: true },
};

const DIFFERENTIAL_SEEDS = Array.from({ length: 96 }, (_, index) => index + 1);

describe('collapseDuplicateRouteEntries — identical to the pre-optimisation behaviour', () => {
  it.each([
    ['production', '55eb603a1be2bbb894625918b2bb27764c6f819bf272d60d40af7a98f027cd25'],
    ['default', '37f5091218dc0b37ad359553de449fcbad8fbf36b4c7373bd46c46520ba00deb'],
    ['sharedIdentity', 'a266648bf8026ae04b6c2836c2818e14e4c115d4409b83a8254f13997ad8e6d1'],
    ['sourceIdentityOnly', '209ceb5c336a3b71faf0f37d5a05e930e5c1107e16c77258974131ce129cc051'],
  ])('keeps results, mutations, exceptions and journal events byte-identical (%s)', (name, golden) => {
    const hash = createHash('sha256');
    for (const seed of DIFFERENTIAL_SEEDS) {
      for (const reversed of [false, true]) {
        const build = () => (reversed ? generateArchive(seed).reverse() : generateArchive(seed));
        hash.update(observe((input) => collapseDuplicateRouteEntries(input, OPTION_SETS[name]), build()));
        hash.update(observe((input) => repairExpiredRoutesWithinArchive(input, OPTION_SETS[name]), build()));
      }
    }
    expect(hash.digest('hex')).toBe(golden);
  });

  it('exercises every branch the differential is meant to pin', () => {
    // Senza queste soglie un generatore che smette di produrre fusioni, rifiuti
    // del cap, riparazioni o non convergenza lascerebbe verdi i digest senza
    // piu' osservare nulla.
    const seen = { merged: 0, repaired: 0, capRefused: 0, unmergeable: 0, identityRefused: 0, threw: 0 };
    for (const seed of DIFFERENTIAL_SEEDS) {
      // `production` ripara le collisioni prima del collasso (e non rifiuta mai
      // per identita'); `default` le lascia al collasso, che le conta.
      for (const name of ['production', 'default']) {
        try {
          const result = collapseDuplicateRouteEntries(generateArchive(seed), OPTION_SETS[name]);
          seen.merged += result.collapsed;
          seen.repaired += result.repairedRoutes;
          seen.capRefused += result.capRefused;
          seen.unmergeable += result.unmergeable;
          seen.identityRefused += result.identityRefused;
        } catch {
          seen.threw += 1;
        }
      }
    }
    for (const [branch, count] of Object.entries(seen)) expect(count, branch).toBeGreaterThan(0);
  });
});

describe('localeRouteKeys — one attribution pass per record', () => {
  /** La formula storica: una chiamata a getPreviousSlugsForLocale per lingua. */
  function referenceRouteKeys(job: Loose): string[] {
    const routes = new Set<string>();
    for (const locale of LOCALES) {
      const localeSlug = job.slugByLocale?.[locale];
      const current = localeSlug || (locale === 'it' ? job.slug : '');
      if (current) routes.add(`${locale}:${current}`);
      if (locale === 'it' && job.slug && (!localeSlug || localeSlug === job.slug)) {
        routes.add(`${locale}:${job.slug}`);
      }
      for (const slug of getPreviousSlugsForLocale(job, locale)) {
        if (slug) routes.add(`${locale}:${slug}`);
      }
    }
    return [...routes];
  }

  const shapes: Array<[string, Loose]> = [
    ['empty record', {}],
    ['current slug only', { slug: 'a' }],
    ['locale slugs differing from the master', { slug: 'a', slugByLocale: { it: 'b', en: 'c' } }],
    ['flat-only history is served under every locale', { slug: 'a', previousSlugs: ['x', 'y'] }],
    [
      'a locale bucket takes the flat entry away from the other three',
      { slug: 'a', previousSlugs: ['x', 'y'], previousSlugsByLocale: { de: ['x'] } },
    ],
    [
      'a stray locale key attributes nothing',
      { slug: 'a', previousSlugs: ['x'], previousSlugsByLocale: { es: ['x'], fr: ['z'] } },
    ],
    ['falsy and repeated entries', { slug: 'a', previousSlugs: ['', 'x', 'x', null as unknown as string], previousSlugsByLocale: { it: ['', 'x'] } }],
    ['non-array history is ignored', { slug: 'a', previousSlugs: 'x' as unknown as string[], previousSlugsByLocale: { it: 'x' as unknown as string[] } }],
    ['sparse arrays', { slug: 'a', previousSlugs: new Array(3) as string[], previousSlugsByLocale: { en: new Array(2) as string[] } }],
  ];

  it.each(shapes)('matches the per-locale formula, in the same insertion order: %s', (_name, job) => {
    expect(JSON.stringify([...archiveLocaleRouteKeys(job)])).toBe(JSON.stringify(referenceRouteKeys(job)));
  });

  it('matches the per-locale formula on every synthetic record', () => {
    for (const seed of DIFFERENTIAL_SEEDS) {
      for (const job of generateArchive(seed)) {
        expect(JSON.stringify([...archiveLocaleRouteKeys(job)])).toBe(JSON.stringify(referenceRouteKeys(job)));
      }
    }
  });
});

describe('collapseDuplicateRouteEntries — what the shortcuts must not skip', () => {
  const at = '2026-09-01T00:00:00.000Z';
  const named = (slug: string, extra: Loose = {}): Loose => ({
    slug,
    companyKey: 'acme',
    expiredAt: at,
    slugByLocale: { it: slug },
    sourceIdentity: `url:https://jobs.example/${slug}`,
    ...extra,
  });

  it('settles on the first pass when nothing merges, and still returns the canonical order', () => {
    const result = collapseDuplicateRouteEntries([named('a'), named('z', { expiredAt: '2026-10-01T00:00:00.000Z' })]);
    expect(result.collapsed).toBe(0);
    expect(result.repairedRoutes).toBe(0);
    expect(result.entries.map((item: Loose) => item.slug)).toEqual(['z', 'a']);
    expect(Object.keys(result)).toEqual([
      'entries', 'collapsed', 'slugsTransferred', 'unmergeable', 'capRefused',
      'identityRefused', 'finalCapRefused', 'repairedRoutes', 'repairDetails',
    ]);
  });

  it('re-reads the keys after a repair has moved a route (no stale ownership)', () => {
    // Un record con identita' e uno senza condividono una rotta storica piatta
    // (servita sotto OGNI lingua): non si fondono, quindi la riparazione sposta
    // la rotta del secondo su un alias, lingua per lingua. Le chiavi lette prima
    // della mutazione lascerebbero il record titolare della rotta vecchia.
    const shared = 'shared-history-route';
    const unnamed = { slug: 'u', companyKey: 'acme', expiredAt: at, slugByLocale: { it: 'u' }, previousSlugs: [shared] };
    const input = [named('a', { previousSlugs: [shared] }), unnamed];
    const first = collapseDuplicateRouteEntries(structuredClone(input), { repairUnprovenCollisions: true });
    const owners = new Map<string, number>();
    for (const item of first.entries) {
      for (const route of archiveLocaleRouteKeys(item)) owners.set(route, (owners.get(route) || 0) + 1);
    }
    expect(first.repairedRoutes).toBeGreaterThan(0);
    expect([...owners.values()].every((count) => count === 1)).toBe(true);
    // E il risultato e' stabile: un secondo giro non ha piu' niente da spostare.
    const second = collapseDuplicateRouteEntries(first.entries, { repairUnprovenCollisions: true });
    expect(second.repairedRoutes).toBe(0);
    expect(JSON.stringify(second.entries)).toBe(JSON.stringify(first.entries));
  });

  it('keeps a mixed-identity route apart and reports the refusal', () => {
    const unnamed = { slug: 'u', companyKey: 'acme', expiredAt: at, slugByLocale: { it: 'u' }, previousSlugs: ['a'] };
    const result = collapseDuplicateRouteEntries([named('a'), unnamed]);
    expect(result.entries).toHaveLength(2);
    expect(result.collapsed).toBe(0);
    expect(result.identityRefused).toBeGreaterThan(0);
  });

  it('merges records of the same identity class that share a route across locales', () => {
    // Stesso posting (stessa sourceIdentity): con identita' diverse la rotta
    // condivisa verrebbe spostata su un alias invece di fondere i record.
    const posting = 'url:https://jobs.example/posting';
    const left = named('a', { sourceIdentity: posting, slugByLocale: { it: 'a', en: 'shared-en' } });
    const right = named('b', {
      sourceIdentity: posting,
      slugByLocale: { it: 'b', en: 'shared-en' },
      expiredAt: '2026-08-01T00:00:00.000Z',
    });
    const result = collapseDuplicateRouteEntries([right, left]);
    expect(result.collapsed).toBe(1);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].slug).toBe('a');
    const served = archiveLocaleRouteKeys(result.entries[0]);
    for (const route of ['it:a', 'it:b', 'en:shared-en']) expect(served.has(route), route).toBe(true);
  });

  it('still throws when the collapse does not converge', () => {
    // Al punto di non convergenza (8 passate) l'eccezione e' parte del contratto.
    const seed = DIFFERENTIAL_SEEDS.find((candidate) => {
      try {
        collapseDuplicateRouteEntries(generateArchive(candidate), OPTION_SETS.production);
        return false;
      } catch (error) {
        return /did not converge/.test((error as Error).message);
      }
    });
    expect(seed, 'the generator no longer produces a non-converging archive').toBeDefined();
    expect(() => collapseDuplicateRouteEntries(generateArchive(seed as number), OPTION_SETS.production))
      .toThrow(/did not converge after 8 passes/);
  });
});

