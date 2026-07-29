/**
 * Tests for scripts/lib/article-defect-memory.mjs — the cross-run learning
 * store, and for the gate wiring that consumes it
 * (collectInstitutionAcronyms / checkFabricatedInstitutionAcronyms).
 *
 * The subject under test is a FEEDBACK LOOP, and the loop this repo already
 * shipped degenerated (2026-07-28, run 30350429920: the fact-checker's own
 * false positives were fed back as rewrite instructions until the surviving
 * draft had abandoned the source and invented an institution, a statistic and
 * two contradictory decree dates). So the tests below are weighted towards the
 * cases where a naive learner would go wrong rather than towards the happy
 * path: every promotion test is paired with the near-miss that must NOT
 * promote, because a false entry in the denylist blocks correct articles and
 * the pipeline has already been taken to ~0 articles/run once by over-tight
 * gates (#2947).
 */
import { describe, it, expect } from 'vitest';
import {
  emptyMemory,
  parseMemory,
  recordObservations,
  evaluateEntity,
  applyPromotionPolicy,
  learnedDenylist,
  learnedSuspects,
  reviewQueue,
  memoryHealth,
  PROMOTION_POLICY,
  MEMORY_SCHEMA_VERSION,
  SUPPORT,
  ENTITY_STATUS,
} from '../scripts/lib/article-defect-memory.mjs';
import {
  collectInstitutionAcronyms,
  checkFabricatedInstitutionAcronyms,
  runFactualityGates,
} from '../scripts/lib/article-factuality-gates.mjs';

const codes = (issues: any[]) => issues.map((i) => i.code);

/** Feeds `n` unsupported sightings, each from its own run, at `now`. */
function feedUnsupported(memory: any, acronym: string, n: number, now = '2026-07-28T00:00:00.000Z') {
  for (let i = 0; i < n; i++) {
    recordObservations(memory, [{ acronym, name: `Ufficio di prova ${acronym}`, support: SUPPORT.ABSENT }], {
      runId: `run-${i}`,
      articleId: `art-${i}`,
      now,
    });
  }
  return memory;
}

describe('recordObservations', () => {
  it('records prevalence and blocking evidence separately', () => {
    const m = emptyMemory();
    recordObservations(m, [{ acronym: 'UFI', name: 'Ufficio federale delle imposte', support: SUPPORT.ABSENT }], {
      runId: 'r1', articleId: 'a1', now: '2026-07-28T00:00:00.000Z',
    });
    const e = m.entities.UFI;
    expect(e.seen).toBe(1);
    expect(e.unsupportedSightings).toBe(1);
    expect(e.unsupportedRuns).toEqual(['r1']);
    expect(e.names).toContain('Ufficio federale delle imposte');
  });

  it('does not let one run manufacture evidence by repeating itself', () => {
    // The retry loop regenerates the article up to 6 times per run and the same
    // hallucinated acronym comes back every time. Counting those as six
    // independent observations is how a single degraded run would write its own
    // defect into the blocking set.
    const m = emptyMemory();
    for (let i = 0; i < 6; i++) {
      recordObservations(m, [{ acronym: 'UFI', support: SUPPORT.ABSENT }], {
        runId: 'r1', articleId: 'a1', now: '2026-07-28T00:00:00.000Z',
      });
    }
    expect(m.entities.UFI.seen).toBe(6);           // prevalence counts every emission
    expect(m.entities.UFI.unsupportedSightings).toBe(1); // evidence counts the article once
  });

  it('records a source-supported sighting as clearing evidence, not blocking evidence', () => {
    const m = emptyMemory();
    recordObservations(m, [{ acronym: 'USTRA', support: SUPPORT.PRESENT }], { runId: 'r1', articleId: 'a1' });
    expect(m.entities.USTRA.supportedSightings).toBe(1);
    expect(m.entities.USTRA.unsupportedSightings).toBe(0);
  });

  it('treats a source-less sighting as prevalence only', () => {
    // The corpus retro-audit has no source pages to compare against. It must be
    // able to raise review priority without being able to block anything.
    const m = emptyMemory();
    recordObservations(m, [{ acronym: 'USGC', support: SUPPORT.UNKNOWN }], { runId: 'r1', articleId: 'a1' });
    expect(m.entities.USGC.seen).toBe(1);
    expect(m.entities.USGC.unsupportedSightings).toBe(0);
    expect(evaluateEntity('USGC', m.entities.USGC).status).toBe(ENTITY_STATUS.SUSPECT);
  });

  it('ignores empty acronyms instead of creating a junk entry', () => {
    const m = emptyMemory();
    recordObservations(m, [{ acronym: '  ', support: SUPPORT.ABSENT }, null as any], { runId: 'r1' });
    expect(Object.keys(m.entities)).toHaveLength(0);
  });
});

describe('evaluateEntity — the evidence bar for blocking', () => {
  it('promotes only when both the sighting AND the distinct-run bar are met', () => {
    const m = emptyMemory();
    feedUnsupported(m, 'UFOL', PROMOTION_POLICY.minUnsupportedSightings);
    expect(evaluateEntity('UFOL', m.entities.UFOL).status).toBe(ENTITY_STATUS.CONFIRMED);
  });

  it('does NOT promote on sightings alone when they all come from one run', () => {
    const m = emptyMemory();
    for (let i = 0; i < 5; i++) {
      recordObservations(m, [{ acronym: 'UFOL', support: SUPPORT.ABSENT }], {
        runId: 'same-run', articleId: `art-${i}`,
      });
    }
    expect(m.entities.UFOL.unsupportedSightings).toBe(5);
    expect(m.entities.UFOL.unsupportedRuns).toHaveLength(1);
    expect(evaluateEntity('UFOL', m.entities.UFOL).status).toBe(ENTITY_STATUS.SUSPECT);
  });

  it('does NOT promote one sighting below the bar', () => {
    const m = emptyMemory();
    feedUnsupported(m, 'UFOL', PROMOTION_POLICY.minUnsupportedSightings - 1);
    expect(evaluateEntity('UFOL', m.entities.UFOL).status).toBe(ENTITY_STATUS.SUSPECT);
  });

  it('clears an entity the moment one real source names it, whatever the pile against it', () => {
    // The cheap exit path. Without it a false positive is permanent, because a
    // blocked article is never published and can never produce the evidence
    // that would overturn the block.
    const m = emptyMemory();
    feedUnsupported(m, 'UFIS', 10);
    expect(evaluateEntity('UFIS', m.entities.UFIS).status).toBe(ENTITY_STATUS.CONFIRMED);
    recordObservations(m, [{ acronym: 'UFIS', support: SUPPORT.PRESENT }], { runId: 'r99', articleId: 'a99' });
    expect(evaluateEntity('UFIS', m.entities.UFIS).status).toBe(ENTITY_STATUS.CLEARED);
  });

  it('never promotes an acronym on the curated allowlist, however much evidence piles up', () => {
    // USTRA is real. If a run of sources happens never to spell it out, the
    // learner must not be able to conclude the Federal Roads Office is fiction.
    const m = emptyMemory();
    feedUnsupported(m, 'USTRA', 20);
    expect(evaluateEntity('USTRA', m.entities.USTRA).status).toBe(ENTITY_STATUS.CLEARED);
  });

  it('never overrides a human verdict', () => {
    const m = emptyMemory();
    feedUnsupported(m, 'XYZ', 20);
    m.entities.XYZ.status = ENTITY_STATUS.CLEARED;
    m.entities.XYZ.statusSource = 'human';
    expect(evaluateEntity('XYZ', m.entities.XYZ).status).toBe(ENTITY_STATUS.CLEARED);
    applyPromotionPolicy(m);
    expect(m.entities.XYZ.status).toBe(ENTITY_STATUS.CLEARED);
  });
});

describe('applyPromotionPolicy — decay and amnesty', () => {
  it('amnesties a stale auto-confirmation and HALVES its blocking evidence', () => {
    const m = emptyMemory();
    feedUnsupported(m, 'UFOL', 4, '2026-01-01T00:00:00.000Z');
    applyPromotionPolicy(m, { now: '2026-01-02T00:00:00.000Z' });
    expect(m.entities.UFOL.status).toBe(ENTITY_STATUS.CONFIRMED);

    // Half a year with the generator never emitting it again.
    const out = applyPromotionPolicy(m, { now: '2026-09-01T00:00:00.000Z' });
    expect(m.entities.UFOL.status).toBe(ENTITY_STATUS.SUSPECT);
    expect(m.entities.UFOL.unsupportedSightings).toBe(2); // 4 → 2, not 0 and not 4
    expect(out.demoted.map((d: any) => d.acronym)).toContain('UFOL');
  });

  it('makes re-blocking after amnesty require FRESH evidence, not one more sighting', () => {
    // This is what halving buys: if the counters survived intact, a single new
    // sighting would re-block instantly and the amnesty would be decorative.
    const m = emptyMemory();
    feedUnsupported(m, 'UFOL', 3, '2026-01-01T00:00:00.000Z');
    applyPromotionPolicy(m, { now: '2026-01-02T00:00:00.000Z' });
    applyPromotionPolicy(m, { now: '2026-09-01T00:00:00.000Z' });
    expect(m.entities.UFOL.unsupportedSightings).toBe(1);

    recordObservations(m, [{ acronym: 'UFOL', support: SUPPORT.ABSENT }], {
      runId: 'fresh-1', articleId: 'fresh-a', now: '2026-09-01T00:00:00.000Z',
    });
    applyPromotionPolicy(m, { now: '2026-09-01T00:00:00.000Z' });
    expect(m.entities.UFOL.status).toBe(ENTITY_STATUS.SUSPECT); // 2 < 3, still short
  });

  it('does NOT decay clearing evidence — a cleared entity stays cleared forever', () => {
    const m = emptyMemory();
    recordObservations(m, [{ acronym: 'IUFFP', support: SUPPORT.PRESENT }], {
      runId: 'r1', articleId: 'a1', now: '2026-01-01T00:00:00.000Z',
    });
    m.entities.IUFFP.status = ENTITY_STATUS.CLEARED;
    applyPromotionPolicy(m, { now: '2030-01-01T00:00:00.000Z' });
    expect(m.entities.IUFFP?.status).toBe(ENTITY_STATUS.CLEARED);
    expect(m.entities.IUFFP.supportedSightings).toBe(1);
  });

  it('forgets a suspect nobody has emitted for months', () => {
    const m = emptyMemory();
    feedUnsupported(m, 'ZZZ', 1, '2026-01-01T00:00:00.000Z');
    const out = applyPromotionPolicy(m, { now: '2026-06-01T00:00:00.000Z' });
    expect(m.entities.ZZZ).toBeUndefined();
    expect(out.evicted).toContain('ZZZ');
  });

  it('keeps a suspect that is still being emitted', () => {
    const m = emptyMemory();
    feedUnsupported(m, 'ZZZ', 1, '2026-06-01T00:00:00.000Z');
    applyPromotionPolicy(m, { now: '2026-06-10T00:00:00.000Z' });
    expect(m.entities.ZZZ).toBeDefined();
  });
});

describe('applyPromotionPolicy — saturation stop', () => {
  it('refuses to promote past the cap and says so instead of silently blocking more', () => {
    // #2947: over-tight gates took the evergreen path to ~0 articles/run. A
    // learner that can only ever tighten is a ratchet; the cap is the stop.
    const m = emptyMemory();
    const policy = { ...PROMOTION_POLICY, maxAutoConfirmed: 2 };
    for (const acr of ['AAA', 'BBB', 'CCC', 'DDD']) feedUnsupported(m, acr, 3);

    const out = applyPromotionPolicy(m, { policy, now: '2026-07-28T00:00:00.000Z' });
    expect(learnedDenylist(m).size).toBe(2);
    expect(out.saturated).toBe(true);
    expect(out.blockedPromotions.length).toBe(2);
    expect(out.warnings.join(' ')).toMatch(/satura/i);
  });

  it('does not report saturation when the population is healthy', () => {
    const m = emptyMemory();
    feedUnsupported(m, 'AAA', 3);
    const out = applyPromotionPolicy(m, { now: '2026-07-28T00:00:00.000Z' });
    expect(out.saturated).toBe(false);
    expect(out.warnings).toHaveLength(0);
    expect(memoryHealth(m).saturated).toBe(false);
  });

  it('evicts the least-prevalent suspects when the store exceeds its population cap, never a clearance', () => {
    const m = emptyMemory();
    const policy = { ...PROMOTION_POLICY, maxEntities: 2 };
    feedUnsupported(m, 'RARE', 1);
    feedUnsupported(m, 'COMMON', 1);
    for (let i = 0; i < 9; i++) {
      recordObservations(m, [{ acronym: 'COMMON', support: SUPPORT.UNKNOWN }], { runId: `r${i}`, articleId: `a${i}` });
    }
    recordObservations(m, [{ acronym: 'REAL', support: SUPPORT.PRESENT }], { runId: 'r1', articleId: 'a1' });

    applyPromotionPolicy(m, { policy, now: '2026-07-28T00:00:00.000Z' });
    expect(m.entities.REAL.status).toBe(ENTITY_STATUS.CLEARED); // clearances survive
    expect(m.entities.RARE).toBeUndefined();                    // lowest prevalence goes first
    expect(m.entities.COMMON).toBeDefined();
  });
});

describe('parseMemory — degradation is reported, never swallowed', () => {
  it('reports invalid JSON and returns an empty store', () => {
    const { memory, degraded } = parseMemory('{not json');
    expect(memory.entities).toEqual({});
    expect(degraded).toMatch(/JSON non valido/);
  });

  it('refuses an unknown schema version rather than guessing at the layout', () => {
    const { degraded } = parseMemory(JSON.stringify({ schemaVersion: 99, entities: {} }));
    expect(degraded).toMatch(/schemaVersion 99/);
  });

  it('drops a single malformed entry without blinding the whole store', () => {
    const { memory, degraded } = parseMemory(JSON.stringify({
      schemaVersion: MEMORY_SCHEMA_VERSION,
      entities: {
        GOOD: { status: 'confirmed', statusSource: 'auto', seen: 3, unsupportedSightings: 3, unsupportedRuns: ['a', 'b'] },
        BAD: { status: 'nonsense' },
      },
    }));
    expect(learnedDenylist(memory).has('GOOD')).toBe(true);
    expect(memory.entities.BAD).toBeUndefined();
    expect(degraded).toMatch(/malformate/);
  });

  it('accepts a well-formed store without reporting degradation', () => {
    const { memory, degraded } = parseMemory(JSON.stringify({
      schemaVersion: MEMORY_SCHEMA_VERSION,
      updatedAt: '2026-07-28T00:00:00.000Z',
      entities: { UFI: { status: 'confirmed', statusSource: 'human', seen: 4 } },
    }));
    expect(degraded).toBeNull();
    expect(learnedDenylist(memory)).toEqual(new Set(['UFI']));
  });
});

describe('reviewQueue', () => {
  it('ranks by blocking evidence first, prevalence second, and shows only suspects', () => {
    const m = emptyMemory();
    feedUnsupported(m, 'WEAK', 1);
    feedUnsupported(m, 'STRONG', 2);
    recordObservations(m, [{ acronym: 'DONE', support: SUPPORT.PRESENT }], { runId: 'r', articleId: 'a' });
    applyPromotionPolicy(m, { now: '2026-07-28T00:00:00.000Z' });

    const q = reviewQueue(m);
    expect(q.map((r: any) => r.acronym)).toEqual(['STRONG', 'WEAK']);
    expect(q[0].evidence.length).toBeGreaterThan(0);
  });
});

describe('collectInstitutionAcronyms — the support oracle', () => {
  const article = 'Secondo l\'Ufficio federale delle imposte (UFI) e l\'Ufficio federale delle strade (USTRA) '
    + 'la misura entra in vigore subito.';

  it('marks an acronym the source names literally as supported', () => {
    const source = 'x'.repeat(500) + ' Comunicato USTRA sulle strade nazionali.';
    const obs = collectInstitutionAcronyms(article, { sourceText: source });
    expect(obs.find((o: any) => o.acronym === 'USTRA')?.support).toBe('present');
  });

  it('marks an acronym the source never backs up as absent', () => {
    const source = 'x'.repeat(500) + ' Comunicato USTRA sulle strade nazionali.';
    const obs = collectInstitutionAcronyms(article, { sourceText: source });
    expect(obs.find((o: any) => o.acronym === 'UFI')?.support).toBe('absent');
  });

  it('accepts an acronym the source only spells out in full', () => {
    // The article correctly coins "(UFI)" for an institution the source names
    // without the acronym. Judging on the literal token alone would score a
    // faithful article as a fabrication.
    const source = 'Nota stampa. '.repeat(30)
      + " L'Ufficio federale delle imposte ha comunicato la nuova aliquota.";
    const obs = collectInstitutionAcronyms(article, { sourceText: source });
    expect(obs.find((o: any) => o.acronym === 'UFI')?.support).toBe('present');
  });

  it('refuses to judge without a usable source instead of assuming fabrication', () => {
    expect(collectInstitutionAcronyms(article, { sourceText: '' })
      .every((o: any) => o.support === 'unknown')).toBe(true);
    expect(collectInstitutionAcronyms(article, { sourceText: 'troppo corta' })
      .every((o: any) => o.support === 'unknown')).toBe(true);
  });

  it('reports each acronym once however often the article repeats it', () => {
    const obs = collectInstitutionAcronyms(`${article} ${article}`, { sourceText: '' });
    expect(obs.filter((o: any) => o.acronym === 'UFI')).toHaveLength(1);
  });
});

describe('checkFabricatedInstitutionAcronyms — learned tiers', () => {
  const text = 'Lo ha comunicato l\'Ufficio cantonale del lavoro (UCLV).';

  it('blocks on a learned confirmation', () => {
    const issues = checkFabricatedInstitutionAcronyms(text, { learnedDenylist: new Set(['UCLV']) });
    expect(codes(issues)).toContain('fabricated-institution');
    expect(issues[0].severity).toBe('critical');
    expect(issues[0].message).toMatch(/appreso/);
  });

  it('only reports — never blocks — on a learned suspicion', () => {
    const issues = checkFabricatedInstitutionAcronyms(text, { learnedSuspects: new Set(['UCLV']) });
    expect(codes(issues)).toContain('suspected-institution');
    expect(issues.every((i: any) => i.severity !== 'critical')).toBe(true);
  });

  it('lets the curated allowlist win over a learned confirmation', () => {
    const real = 'Secondo l\'Ufficio federale delle strade (USTRA) i lavori proseguono.';
    expect(checkFabricatedInstitutionAcronyms(real, { learnedDenylist: new Set(['USTRA']) })).toHaveLength(0);
  });

  it('behaves exactly as before when no memory is supplied', () => {
    expect(codes(checkFabricatedInstitutionAcronyms(text))).toEqual(['unknown-institution']);
    expect(codes(checkFabricatedInstitutionAcronyms('Secondo l\'Ufficio federale delle imposte (UFI).')))
      .toEqual(['fabricated-institution']);
  });

  it('says loudly when the memory could not be read, without blocking on it', () => {
    const issues = checkFabricatedInstitutionAcronyms('Nessun ente qui.', { memoryDegraded: 'JSON non valido' });
    expect(codes(issues)).toEqual(['defect-memory-unavailable']);
    expect(issues[0].severity).toBe('minor');
  });

  it('does not emit the unavailability notice when the memory is fine', () => {
    expect(checkFabricatedInstitutionAcronyms('Nessun ente qui.', { memoryDegraded: null })).toHaveLength(0);
  });
});

describe('runFactualityGates — memory plumbing', () => {
  const sections = { body1: 'Secondo l\'Ufficio federale delle imposte (UFI) la misura è attiva.' };

  it('returns this run\'s observations for the caller to persist', () => {
    const r = runFactualityGates({ sections, sourceText: 'x'.repeat(600) });
    expect(r.observations.map((o: any) => o.acronym)).toContain('UFI');
    expect(r.observations[0].support).toBe('absent');
  });

  it('blocks on a learned denylist entry passed through the memory field', () => {
    const r = runFactualityGates({
      sections: { body1: 'Lo dice l\'Ufficio cantonale del lavoro (UCLV).' },
      memory: { denylist: new Set(['UCLV']) },
    });
    expect(r.passed).toBe(false);
    expect(codes(r.blocking)).toContain('fabricated-institution');
  });

  it('is unchanged when called without a memory (corpus retro-audit path)', () => {
    const r = runFactualityGates({ sections: { body1: 'Lo dice l\'Ufficio cantonale del lavoro (UCLV).' } });
    expect(r.passed).toBe(true);
    expect(codes(r.issues)).toEqual(['unknown-institution']);
    expect(r.observations[0].support).toBe('unknown');
  });
});
