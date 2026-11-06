import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Issue #7361 — le opzioni che i due entry point passano DAVVERO.
 *
 * I guard precedenti erano `readFileSync` + regex sui due script
 * (`/buildTrafficPriority\([^;]*freshFirst:\s*true/` sul mop-up,
 * `not.toContain('freshFirst')` sul cascade). Una regex descrive la forma
 * testuale di UN call site: sposta la chiamata dietro un helper e i guard
 * restano verdi senza piu' descrivere niente — verdi anche con la corsia spenta
 * sul percorso gratuito, o accesa su quello a pagamento.
 *
 * Qui si intercetta `buildTrafficPriority` e si guardano gli ARGOMENTI. Non
 * conta come la chiamata e' scritta: conta cosa arriva alla funzione.
 */
const buildTrafficPriority = vi.fn();

vi.mock('../scripts/lib/job-traffic-priority.mjs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../scripts/lib/job-traffic-priority.mjs')>();
  return {
    ...actual,
    buildTrafficPriority: (...args: unknown[]) => {
      buildTrafficPriority(...args);
      // Si delega all'implementazione vera: lo spy osserva, non sostituisce —
      // cosi' un'opzione illegale (corsia sconosciuta, lane+freshFirst) esplode
      // qui esattamente come esploderebbe in produzione.
      return (actual.buildTrafficPriority as (...a: any[]) => unknown)(...args);
    },
  };
});

const optionsOfLastCall = () => buildTrafficPriority.mock.calls.at(-1)?.[2] as Record<string, unknown>;

beforeEach(() => {
  buildTrafficPriority.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('corsia freschezza: le opzioni passate dagli entry point', () => {
  it('il mop-up gratuito passa la sua corsia e il cap con cui affetta', async () => {
    const { orderMopupJobsByTraffic, MOPUP_TRAFFIC_LANE } = await import('../scripts/local-mt-mopup.mjs');
    const jobs = Array.from({ length: 12 }, (_, i) => ({
      id: `j${i}`,
      url: `https://example.test/j${i}`,
      firstSeenAt: new Date(Date.now() - 3_600_000).toISOString(),
    }));

    const { selected, stats } = orderMopupJobsByTraffic(jobs, {}, 5) as {
      selected: unknown[];
      stats: { freshFirst: boolean };
    };

    expect(buildTrafficPriority).toHaveBeenCalledTimes(1);
    expect(optionsOfLastCall()).toMatchObject({ lane: MOPUP_TRAFFIC_LANE, cap: 5 });
    // La corsia non e' solo dichiarata: e' accesa nel risultato.
    expect(stats.freshFirst).toBe(true);
    // E il cap dichiarato e' quello con cui la fetta e' tagliata — l'invariante
    // che il vecchio guard inseguiva confrontando due identificatori nel testo.
    expect(selected).toHaveLength(5);
  });

  it('il cascade a pagamento passa la propria corsia, quella con la freschezza spenta', async () => {
    // L'env si stubba PRIMA dell'import: `ALLOW_NO_TRAFFIC` e' letto a livello
    // di modulo, quindi stubbarlo dopo non arriverebbe mai allo script.
    vi.stubEnv('RELOCALIZE_ALLOW_NO_TRAFFIC', '1');
    vi.resetModules();
    const cascade = await import('../scripts/relocalize-pending-jobs.mjs');
    const capture: Record<string, any> = {};

    // `orderPendingByTraffic` legge `data/job-popularity.json`; in un worktree
    // sparse puo' non esserci, e l'escape hatch documentato dello script e'
    // esattamente questo env — il percorso resta quello di produzione.
    cascade.orderPendingByTraffic(
      [{ id: 'a', url: 'https://example.test/a', firstSeenAt: new Date(Date.now() - 3_600_000).toISOString() }],
      { capture },
    );

    expect(buildTrafficPriority).toHaveBeenCalledTimes(1);
    expect(optionsOfLastCall()).toMatchObject({ lane: cascade.CASCADE_TRAFFIC_LANE });
    expect(optionsOfLastCall()).not.toHaveProperty('freshFirst');
    expect(capture.stats.freshFirst).toBe(false);
  });

  it('i due entry point non condividono la corsia', async () => {
    const { MOPUP_TRAFFIC_LANE } = await import('../scripts/local-mt-mopup.mjs');
    const { CASCADE_TRAFFIC_LANE } = await import('../scripts/relocalize-pending-jobs.mjs');
    expect(MOPUP_TRAFFIC_LANE).not.toBe(CASCADE_TRAFFIC_LANE);
  });
});
