// Funzioni pure di scripts/report-job-email-ranking-experiment.mjs e la
// fotografia committata dell'esperimento CTR (2026-09-08 → 2026-10-03), che è
// l'unica copia dei dati: in Firestore hanno TTL di 100 giorni.
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  aggregateStats,
  buildExperimentReport,
  classifyRankingEvent,
  filterClicks,
  findIdentifierLeaks,
  parseArgs,
  positionBucket,
} from '@/scripts/report-job-email-ranking-experiment.mjs';

const BASE = Date.now() - 5 * 86_400_000;
const at = (seconds: number) => new Date(BASE + seconds * 1000);

function impressions(deliveryId: string, variant: string, positions: number, extra: Record<string, unknown> = {}, surface = 'job_alert') {
  return Array.from({ length: positions }, (_, i) => ({
    event_type: surface === 'job_alert' ? 'job_alert_impression' : 'newsletter_job_impression',
    surface,
    delivery_id: deliveryId,
    job_id: `job-${i + 1}`,
    position: i + 1,
    ranking_variant: variant,
    user_id: `user-of-${deliveryId}`,
    occurred_at: at(0),
    ...extra,
  }));
}

function click(deliveryId: string, variant: string, position: number, second: number, extra: Record<string, unknown> = {}, surface = 'job_alert') {
  return {
    event_type: surface === 'job_alert' ? 'job_alert_click' : 'newsletter_job_click',
    surface,
    delivery_id: deliveryId,
    job_id: `job-${position}`,
    position,
    ranking_variant: variant,
    user_id: `user-of-${deliveryId}`,
    message_id: `msg-${deliveryId}`,
    occurred_at: at(second),
    ...extra,
  };
}

describe('classificazione degli eventi', () => {
  it('riconosce impression e clic dal tipo, non da un filtro di query', () => {
    expect(classifyRankingEvent(impressions('d1', 'control', 1)[0])?.kind).toBe('impression');
    expect(classifyRankingEvent(click('d1', 'control', 1, 5))?.kind).toBe('click');
    expect(classifyRankingEvent({ event_type: 'something_else', occurred_at: at(0) })).toBeNull();
    expect(classifyRankingEvent({ event_type: 'job_alert_click' })).toBeNull();
  });

  it('posizioni 1-10, oltre 10 e sconosciuta', () => {
    expect(positionBucket(1)).toBe('1');
    expect(positionBucket(10)).toBe('10');
    expect(positionBucket(11)).toBe('>10');
    expect(positionBucket(null)).toBe('unknown');
    expect(positionBucket(0)).toBe('unknown');
  });
});

describe('varianti arbitrarie e posizioni', () => {
  const events = [
    ...impressions('c1', 'control', 10),
    ...impressions('t1', 'treatment', 10),
    ...impressions('a1', 'affinity', 12),
    ...impressions('n1', 'affinity', 4, {}, 'newsletter'),
    click('c1', 'control', 1, 10),
    click('t1', 'treatment', 2, 10),
    click('a1', 'affinity', 1, 10),
    click('a1', 'affinity', 11, 60),
    click('n1', 'affinity', 3, 10, {}, 'newsletter'),
  ];
  const report = buildExperimentReport({ events });

  it('riporta ogni etichetta trovata, senza cablare control/treatment', () => {
    expect(report.events.variants).toEqual(['affinity', 'control', 'treatment']);
    expect(report.events.by_variant_surface.affinity.all).toMatchObject({ impressions: 16, clicks: 3 });
    expect(report.events.by_variant_surface.affinity.newsletter).toMatchObject({ impressions: 4, clicks: 1, ctr_pct: 25 });
    expect(report.events.by_variant_surface.control.all.ctr_pct).toBe(10);
  });

  it('la somma per posizione coincide con il totale di ogni variante', () => {
    for (const v of report.events.variants) {
      expect(report.consistency.by_variant[v].position_sum_matches_total).toBe(true);
    }
    const aff = report.events.by_variant_surface_position.filter((r: any) => r.variant === 'affinity' && r.surface === 'job_alert');
    expect(aff.find((r: any) => r.position === '>10')).toMatchObject({ impressions: 2, clicks: 1 });
    expect(aff.find((r: any) => r.position === '1')).toMatchObject({ impressions: 1, clicks: 1, ctr_pct: 100 });
  });

  it('confronta ogni variante con il control, per invio', () => {
    expect(Object.keys(report.events.comparisons_vs_control).sort()).toEqual(['affinity_vs_control', 'treatment_vs_control']);
    expect(report.events.per_delivery.control.job_alert).toMatchObject({ deliveries: 1, clicks: 1 });
  });
});

describe('filtro dei clic non umani', () => {
  it('scarta la raffica: 5 clic della stessa consegna entro 3 secondi', () => {
    const clicks = [1, 2, 3, 4, 5].map((p) => classifyRankingEvent(click('d', 'control', p, 100 + p * 0.5)));
    const { kept, dropped } = filterClicks(clicks);
    expect(kept).toHaveLength(0);
    expect(dropped.burst).toBe(5);
  });

  it('tiene 4 clic rapidi e 5 clic lenti', () => {
    const fast = [1, 2, 3, 4].map((p) => classifyRankingEvent(click('d', 'control', p, 100 + p * 0.5)));
    expect(filterClicks(fast).kept).toHaveLength(4);
    const slow = [1, 2, 3, 4, 5].map((p) => classifyRankingEvent(click('e', 'control', p, 100 + p * 2)));
    expect(filterClicks(slow).kept).toHaveLength(5);
  });

  it('deduplica consegna + annuncio, anche per i link legacy senza delivery_id', () => {
    const twice = [click('d', 'control', 1, 10), click('d', 'control', 1, 20)].map(classifyRankingEvent);
    expect(filterClicks(twice).dropped.duplicate).toBe(1);
    const legacy = [click('', 'control', 1, 10, { delivery_id: null }), click('', 'control', 1, 30, { delivery_id: null })].map(classifyRankingEvent);
    expect(filterClicks(legacy).kept).toHaveLength(1);
  });

  it('applica la stessa regola a ogni variante e dichiara lo scarto', () => {
    const events = [
      ...impressions('c', 'control', 10),
      ...impressions('t', 'treatment', 10),
      ...[1, 2, 3, 4, 5].map((p) => click('c', 'control', p, 100 + p * 0.2)),
      ...[1, 2, 3, 4, 5].map((p) => click('t', 'treatment', p, 100 + p * 0.2)),
    ];
    const report = buildExperimentReport({ events });
    expect(report.click_filter_effect).toEqual({ clicks_before_filter: 10, dropped_duplicate: 0, dropped_burst: 10, clicks_after_filter: 0 });
    expect(report.consistency.by_variant.control.clicks_dropped_by_filter).toBe(5);
    expect(report.consistency.by_variant.treatment.clicks_dropped_by_filter).toBe(5);
    expect(report.events.by_variant_surface.control.all.clicks_before_filter).toBe(5);
  });
});

describe('affinity_profile', () => {
  it('assente: nessuna separazione', () => {
    const report = buildExperimentReport({ events: [...impressions('c', 'control', 3), click('c', 'control', 1, 5)] });
    expect(report.by_affinity_profile).toBeNull();
  });

  it('presente sulle impression: i clic ereditano il valore dalla consegna', () => {
    const events = [
      ...impressions('p', 'affinity', 4, { affinity_profile: true }),
      ...impressions('q', 'affinity', 4, { affinity_profile: false }),
      ...impressions('c', 'control', 4),
      click('p', 'affinity', 1, 5),
      click('p', 'affinity', 2, 50),
      click('q', 'affinity', 1, 5),
    ];
    const split = buildExperimentReport({ events }).by_affinity_profile;
    expect(split.true.by_variant_surface.affinity.all).toMatchObject({ impressions: 4, clicks: 2 });
    expect(split.false.by_variant_surface.affinity.all).toMatchObject({ impressions: 4, clicks: 1 });
    expect(split.unset.by_variant_surface.control.all).toMatchObject({ impressions: 4, clicks: 0 });
  });

  it('presente solo sulla consegna: arriva dalla mappa delle consegne', () => {
    const events = [...impressions('p', 'affinity', 2), click('p', 'affinity', 1, 5)];
    const split = buildExperimentReport({ events, deliveryAffinity: new Map([['p', true]]) }).by_affinity_profile;
    expect(split.true.by_variant_surface.affinity.all).toMatchObject({ impressions: 2, clicks: 1 });
  });
});

describe('somme esatte delle stats', () => {
  it('somma i campi *_by_variant per variante, superficie e giorno', () => {
    const out = aggregateStats([
      { surface: 'job_alert', date: '2026-01-02', impressions: 7, clicks: 1, impressions_by_variant: { control: 5, treatment: 2 }, clicks_by_variant: { control: 1 } },
      { surface: 'newsletter', date: '2026-01-02', impressions: 3, clicks: 0, impressions_by_variant: { affinity: 3 } },
    ]);
    expect(out.totals).toMatchObject({ impressions: 10, clicks: 1, impressions_by_variant_sum: 10, clicks_by_variant_sum: 1 });
    expect(out.by_variant_surface.control.all).toEqual({ impressions: 5, clicks: 1, ctr_pct: 20 });
    expect(out.by_variant_surface.affinity.newsletter.impressions).toBe(3);
    expect(out.by_variant_surface_day).toHaveLength(3);
  });
});

describe('nessun identificativo nell\'output', () => {
  const email = ['someone', 'example.org'].join('@');
  const hash = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
  const events = [
    ...impressions(hash, 'control', 3, { user_id: hash, alert_id: hash }),
    click(hash, 'control', 1, 5, { user_id: hash, message_id: email }),
  ];
  const report = buildExperimentReport({ events });

  it('il report non contiene id di consegna, utente, messaggio o email', () => {
    const text = JSON.stringify(report);
    expect(text).not.toContain(hash);
    expect(text).not.toContain(email);
    expect(text).not.toContain('user-of-');
    expect(findIdentifierLeaks(report)).toEqual([]);
  });

  it('la guardia riconosce chiavi vietate, email, hash e id opachi', () => {
    expect(findIdentifierLeaks({ user_id: 'x' })).toHaveLength(1);
    expect(findIdentifierLeaks({ a: `contatto ${email}` })[0]).toContain('email');
    expect(findIdentifierLeaks({ a: hash })[0]).toContain('hash');
    expect(findIdentifierLeaks({ a: 'Xy7kP2mQ9rT4vW8zB1nC5dF3gH6jK0' })[0]).toContain('id opaco');
    expect(findIdentifierLeaks({ [hash]: 1 })[0]).toContain('chiave');
    expect(findIdentifierLeaks({ in_force_at_end_commit: hash, commit: hash })).toEqual([]);
  });
});

describe('argomenti', () => {
  it('tronca --to all\'ora del run e rifiuta un periodo vuoto', () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const opts = parseArgs(['--from', at(0).toISOString(), '--to', future]);
    expect(opts.toMs).toBeLessThan(opts.requestedToMs);
    expect(() => parseArgs(['--from', future, '--to', at(0).toISOString()])).toThrow();
    expect(() => parseArgs(['--to', future])).toThrow(/--from/);
  });
});

describe('fotografia dell\'esperimento CTR (2026-09-08 → 2026-10-03)', () => {
  const path = 'scripts/measurements/job-email-ranking-ctr-experiment-2026-09-08_2026-10-03.json';

  it('esiste, contiene solo aggregati e riconcilia eventi e stats', () => {
    if (!existsSync(path)) {
      throw new Error('report-job-email-ranking-experiment: fotografia dell\'esperimento CTR mancante');
    }
    const snap = JSON.parse(readFileSync(path, 'utf8'));
    expect(findIdentifierLeaks(snap)).toEqual([]);
    expect(snap.period.from).toBe('2026-09-08T00:00:00.000Z');
    expect(snap.parameters.code_defaults).toMatchObject({ rollout: 0.15, alpha: 0.8, epsilon: 0.15, windowDays: 60, shrinkK: 25, minImpressions: 50, newJobBoost: 0.15, maxConsecutiveExposures: 3 });
    expect(snap.parameters.remote_config).toMatchObject({ checked: true, job_email_ranking_parameters: {} });
    for (const variant of ['control', 'treatment']) {
      const row = snap.consistency.by_variant[variant];
      // Gli eventi riproducono il CTR esatto delle stats entro lo 0,01%.
      expect(Math.abs(row.events_ctr_pct_before_filter - row.stats_ctr_pct)).toBeLessThanOrEqual(0.01);
      expect(row.position_sum_matches_total).toBe(true);
      expect(row.clicks_dropped_by_filter).toBe(snap.events.by_variant_surface[variant].all.clicks_before_filter - snap.events.by_variant_surface[variant].all.clicks);
    }
    expect(snap.stats_exact.totals.impressions_by_variant_sum).toBe(snap.stats_exact.totals.impressions);
  });
});
