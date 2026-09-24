import { describe, expect, it } from 'vitest';

import {
  achievedPower,
  aggregateSubscribers,
  armFromVariantTag,
  buildBaseline,
  buildExperimentReadout,
  chiSquareSf,
  classifySubscriber,
  funnelUsersByArm,
  holmAdjust,
  logGamma,
  normalCdf,
  normalQuantile,
  parseGa4Rows,
  relativeUplift,
  renderBaselineMarkdown,
  renderExperimentMarkdown,
  sampleSizePerArm,
  srmCheck,
  sumGa4Metric,
  twoProportionZTest,
  wilsonInterval,
} from '../scripts/lib/experiment-stats.mjs';

// Valori di riferimento da R (stats) / statsmodels, non dal codice sotto test.
describe('normale standard', () => {
  it('Φ e Φ⁻¹ combaciano con i quantili noti', () => {
    expect(normalCdf(1.96)).toBeCloseTo(0.9750021, 6);
    expect(normalCdf(0)).toBeCloseTo(0.5, 7);
    expect(normalCdf(-2.5758293)).toBeCloseTo(0.005, 6);
    expect(normalQuantile(0.975)).toBeCloseTo(1.959964, 5);
    expect(normalQuantile(0.8)).toBeCloseTo(0.8416212, 6);
    expect(normalQuantile(0.001)).toBeCloseTo(-3.090232, 5);
  });
});

describe('wilsonInterval', () => {
  it('1/10 → prop.test(1, 10, correct = FALSE)$conf.int (0.017876, 0.404150)', () => {
    const ci = wilsonInterval(1, 10)!;
    expect(ci.p).toBeCloseTo(0.1, 12);
    expect(ci.lo).toBeCloseTo(0.01787621, 6);
    expect(ci.hi).toBeCloseTo(0.40415003, 6);
  });

  it('estremi 0/n e n/n restano in [0,1]', () => {
    const zero = wilsonInterval(0, 20)!;
    expect(zero.lo).toBe(0);
    expect(zero.hi).toBeCloseTo(0.1611252, 6);
    const all = wilsonInterval(20, 20)!;
    expect(all.hi).toBe(1);
    expect(all.lo).toBeCloseTo(0.8388748, 6);
  });

  it('null su input non definiti', () => {
    expect(wilsonInterval(0, 0)).toBeNull();
    expect(wilsonInterval(5, 3)).toBeNull();
  });
});

describe('twoProportionZTest', () => {
  it('50/1000 vs 70/1000 → X² = 3.5461, p = 0.0597 (prop.test senza correzione)', () => {
    const t = twoProportionZTest(50, 1000, 70, 1000)!;
    expect(t.z * t.z).toBeCloseTo(3.5461, 3);
    expect(t.pValue).toBeCloseTo(0.05969, 4);
    expect(t.diff).toBeCloseTo(0.02, 12);
  });

  it('segno di z segue il challenger (B − A)', () => {
    expect(twoProportionZTest(70, 1000, 50, 1000)!.z).toBeLessThan(0);
  });

  it('varianza nulla → p = 1, denominatore 0 → null', () => {
    expect(twoProportionZTest(0, 100, 0, 100)!.pValue).toBe(1);
    expect(twoProportionZTest(1, 0, 1, 10)).toBeNull();
  });

  it('uplift relativo', () => {
    expect(relativeUplift(0.05, 0.07)).toBeCloseTo(0.4, 12);
    expect(relativeUplift(0, 0.07)).toBeNull();
  });
});

describe('holmAdjust', () => {
  it('step-down monotono, nell\'ordine di input (p.adjust(method = "holm"))', () => {
    const adj = holmAdjust([0.01, 0.04, 0.03, 0.005]);
    expect(adj[0]).toBeCloseTo(0.03, 12);
    expect(adj[1]).toBeCloseTo(0.06, 12);
    expect(adj[2]).toBeCloseTo(0.06, 12);
    expect(adj[3]).toBeCloseTo(0.02, 12);
  });

  it('tronca a 1 e ignora i null nel conteggio delle ipotesi', () => {
    const adj = holmAdjust([0.6, null, 0.02]);
    expect(adj).toEqual([0.6, null, 0.04]);
    expect(holmAdjust([0.7, 0.8])).toEqual([1, 1]);
  });
});

describe('chi-quadro', () => {
  it('logGamma su valori noti', () => {
    expect(logGamma(5)).toBeCloseTo(Math.log(24), 10);
    expect(logGamma(0.5)).toBeCloseTo(Math.log(Math.sqrt(Math.PI)), 10);
  });

  it('coda superiore = pchisq(x, df, lower.tail = FALSE)', () => {
    expect(chiSquareSf(3.841459, 1)).toBeCloseTo(0.05, 6);
    expect(chiSquareSf(5.991465, 2)).toBeCloseTo(0.05, 6);
    expect(chiSquareSf(10, 3)).toBeCloseTo(0.01856614, 7);
    expect(chiSquareSf(0.5, 4)).toBeCloseTo(0.9735010, 6);
    expect(chiSquareSf(0, 2)).toBe(1);
  });

  it('SRM: 5100/4900 su 50/50 non scatta (p≈0.0455), 5300/4700 sì', () => {
    const ok = srmCheck({ control: 5100, b: 4900 }, { control: 50, b: 50 })!;
    expect(ok.chi2).toBeCloseTo(4, 10);
    expect(ok.pValue).toBeCloseTo(0.0455003, 6);
    expect(ok.mismatch).toBe(false);
    const bad = srmCheck({ control: 5300, b: 4700 }, { control: 50, b: 50 })!;
    expect(bad.chi2).toBeCloseTo(36, 10);
    expect(bad.mismatch).toBe(true);
  });

  it('SRM con pesi non uniformi e braccio osservato senza peso', () => {
    const r = srmCheck({ control: 2000, x: 1000 }, { control: 2, x: 1 })!;
    expect(r.expected.control).toBeCloseTo(2000, 10);
    expect(r.pValue).toBeCloseTo(1, 10);
    const orphan = srmCheck({ control: 1000, x: 1000, ghost: 7 }, { control: 1, x: 1 })!;
    expect(orphan.missingWeights).toEqual(['ghost']);
    expect(orphan.mismatch).toBe(true);
    expect(srmCheck({ control: 10 }, { control: 1 })).toBeNull();
  });
});

describe('potenza', () => {
  it('0.10 → 0.12, α 0.05, potenza 0.8 → 3841 per braccio (Fleiss senza correzione)', () => {
    expect(sampleSizePerArm(0.1, 0.12)).toBe(3841);
  });

  it('la potenza raggiunta alla numerosità calcolata è ~0.8', () => {
    expect(achievedPower(3841, 3841, 0.1, 0.12)).toBeCloseTo(0.8, 2);
    expect(achievedPower(500, 500, 0.1, 0.12)!).toBeLessThan(0.2);
  });

  it('null su effetto nullo o tasso degenere', () => {
    expect(sampleSizePerArm(0, 0.1)).toBeNull();
    expect(sampleSizePerArm(0.1, 0.1)).toBeNull();
  });
});

// Fixture sintetiche con la forma della risposta GA4 Data API v1beta runReport.
const funnelFixture = {
  dimensionHeaders: [{ name: 'customEvent:variant' }, { name: 'customEvent:step' }],
  metricHeaders: [{ name: 'totalUsers', type: 'TYPE_INTEGER' }],
  rows: [
    { dimensionValues: [{ value: 'control' }, { value: 'gate_view' }], metricValues: [{ value: '1000' }] },
    { dimensionValues: [{ value: 'control' }, { value: 'auth_success' }], metricValues: [{ value: '90' }] },
    { dimensionValues: [{ value: 'benefit_first' }, { value: 'gate_view' }], metricValues: [{ value: '980' }] },
    { dimensionValues: [{ value: 'benefit_first' }, { value: 'auth_success' }], metricValues: [{ value: '120' }] },
    { dimensionValues: [{ value: '(not set)' }, { value: 'gate_view' }], metricValues: [{ value: '17' }] },
  ],
  rowCount: 5,
};

describe('parsing GA4', () => {
  it('indicizza per nome di header, non per posizione', () => {
    const swapped = {
      dimensionHeaders: [{ name: 'customEvent:step' }, { name: 'customEvent:variant' }],
      metricHeaders: [{ name: 'eventCount' }, { name: 'totalUsers' }],
      rows: [{ dimensionValues: [{ value: 'gate_view' }, { value: 'control' }], metricValues: [{ value: '55' }, { value: '44' }] }],
    };
    const [row] = parseGa4Rows(swapped);
    expect(row.dims['customEvent:variant']).toBe('control');
    expect(row.metrics.totalUsers).toBe(44);
    expect(funnelUsersByArm(swapped).byArm).toEqual({ control: { gate_view: 44 } });
  });

  it('funnel per braccio × step, (not set) a parte', () => {
    const { byArm, unattributed } = funnelUsersByArm(funnelFixture);
    expect(byArm).toEqual({
      control: { gate_view: 1000, auth_success: 90 },
      benefit_first: { gate_view: 980, auth_success: 120 },
    });
    expect(unattributed).toBe(17);
  });

  it('risposta vuota (nessuna riga) → zero, non eccezione', () => {
    expect(parseGa4Rows({ dimensionHeaders: [], metricHeaders: [] })).toEqual([]);
    expect(sumGa4Metric([], { keyDims: ['customEvent:variant'] })).toEqual({ byKey: {}, unattributed: 0 });
  });
});

describe('iscritti Firestore', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const now = Date.UTC(2026, 8, 24, 12);

  it('accetta Timestamp admin, {_seconds}, ISO string; non espone l\'email', () => {
    const a = classifySubscriber({ created_at: { toMillis: () => 1000 }, status: 'confirmed', isActive: true, email: 'x@example.test' });
    expect(a.createdMs).toBe(1000);
    expect(a.confirmed).toBe(true);
    expect(a.active).toBe(true);
    expect(JSON.stringify(a)).not.toContain('example.test');
    const b = classifySubscriber({ subscribedAt: { _seconds: 2 }, confirmedAt: '1970-01-01T00:00:05.000Z' });
    expect(b.createdMs).toBe(2000);
    expect(b.confirmedWithin72h).toBe(true);
    expect(b.createdFromConsent).toBe(false);
  });

  it('senza campi di creazione ripiega sul timestamp del consenso, e lo dichiara', () => {
    const c = classifySubscriber({ consent_given_at: null, consent_ip_recorded_at: '2026-09-20T08:00:00.000Z', confirmed_at: { toMillis: () => Date.parse('2026-09-20T08:00:30.000Z') } });
    expect(c.createdMs).toBe(Date.parse('2026-09-20T08:00:00.000Z'));
    expect(c.createdFromConsent).toBe(true);
    expect(c.confirmedWithin72h).toBe(true);
  });

  it('status di soppressione batte isActive', () => {
    expect(classifySubscriber({ status: 'unsubscribed', isActive: true }).active).toBe(false);
  });

  it('aggrega nella finestra e conta i maturi per la conferma a 72h', () => {
    const subs = [
      { createdMs: now - 10 * DAY, confirmed: true, confirmedWithin72h: true, active: true, variant: 'jobgate-v3:control' },
      { createdMs: now - 5 * DAY, confirmed: true, confirmedWithin72h: false, active: false, variant: 'jobgate-v3:control' },
      { createdMs: now - 1 * DAY, confirmed: false, confirmedWithin72h: false, active: false, variant: 'jobgate-v3:benefit_first' },
      { createdMs: now - 40 * DAY, confirmed: true, confirmedWithin72h: true, active: true, variant: 'jobgate-v3:control' },
      { createdMs: null, confirmed: false, confirmedWithin72h: false, active: false, variant: 'jobgate-v3:control' },
      { createdMs: now - 2 * DAY, confirmed: true, confirmedWithin72h: true, active: true, variant: 'other-exp:control' },
    ].map((s) => ({ createdFromConsent: false, sourceCta: '', sourceChannel: '', ...s }));
    const agg = aggregateSubscribers(subs, {
      keyOf: (s: { variant: string }) => armFromVariantTag(s.variant, 'jobgate-v3'),
      startMs: now - 30 * DAY,
      endMs: now,
      nowMs: now,
    });
    expect(agg.outsideWindow).toBe(1);
    expect(agg.missingCreated).toBe(1);
    expect(agg.byKey).toEqual({
      control: { newSubscribers: 2, confirmed: 2, matured: 2, confirmedWithin72hMatured: 1, active: 1 },
      benefit_first: { newSubscribers: 1, confirmed: 0, matured: 0, confirmedWithin72hMatured: 0, active: 0 },
    });
  });

  it('armFromVariantTag', () => {
    expect(armFromVariantTag('jobgate-v3:control', 'jobgate-v3')).toBe('control');
    expect(armFromVariantTag('jobgate-v3:', 'jobgate-v3')).toBeNull();
    expect(armFromVariantTag('jobgate-v30:control', 'jobgate-v3')).toBeNull();
    expect(armFromVariantTag(null, 'jobgate-v3')).toBeNull();
  });
});

describe('buildExperimentReadout', () => {
  const ga = {
    control: { assigned: 5000, gateView: 4000, authSuccess: 360 },
    a: { assigned: 5050, gateView: 4050, authSuccess: 450 },
    b: { assigned: 4950, gateView: 3950, authSuccess: 350 },
  };
  const subs = {
    control: { newSubscribers: 80, confirmed: 40, matured: 70, confirmedWithin72hMatured: 35, active: 38 },
    a: { newSubscribers: 120, confirmed: 66, matured: 100, confirmedWithin72hMatured: 60, active: 60 },
    b: { newSubscribers: 82, confirmed: 41, matured: 75, confirmedWithin72hMatured: 36, active: 40 },
  };

  it('Holm applicato per famiglia sui confronti vs control', () => {
    const r = buildExperimentReadout({ arms: ['control', 'a', 'b'], ga, subs, weights: { control: 1, a: 1, b: 1 }, windowDays: 14 });
    expect(r.challengers).toEqual(['a', 'b']);
    const prim = r.comparisons.primary;
    const raw = [
      twoProportionZTest(80, 4000, 120, 4050)!.pValue,
      twoProportionZTest(80, 4000, 82, 3950)!.pValue,
    ];
    const adj = holmAdjust(raw);
    expect(prim[0].pValue).toBeCloseTo(raw[0], 12);
    expect(prim[0].pHolm).toBeCloseTo(adj[0]!, 12);
    expect(prim[1].pHolm).toBeCloseTo(adj[1]!, 12);
    expect(prim[0].uplift).toBeCloseTo((120 / 4050 - 0.02) / 0.02, 10);
    expect(prim[0].significant).toBe(adj[0]! < 0.05);
    expect(r.perArm.control.primary.ci95).not.toBeNull();
    expect(r.srm!.mismatch).toBe(false);
    expect(r.srmWeightsAssumed).toBe(false);
  });

  it('potenza: numerosità per +20% su CR control con α Bonferroni e stima dei giorni mancanti', () => {
    const r = buildExperimentReadout({ arms: ['control', 'a', 'b'], ga, subs, windowDays: 14 });
    expect(r.power.baselineRate).toBeCloseTo(0.02, 12);
    expect(r.power.requiredPerArm).toBe(sampleSizePerArm(0.02, 0.024, { alpha: 0.025, power: 0.8 }));
    expect(r.power.underpowered).toBe(true);
    const rowB = r.power.rows.find((x: { arm: string }) => x.arm === 'b')!;
    expect(rowB.nPerArmObserved).toBe(3950);
    expect(rowB.extraDaysEstimate).toBe(Math.ceil((r.power.requiredPerArm! - 3950) / (3950 / 14)));
    expect(r.srmWeightsAssumed).toBe(true);
  });

  it('iscritti Firestore > gate_view GA4: segnalato e troncato, non NaN', () => {
    const r = buildExperimentReadout({
      arms: ['control', 'a'],
      ga: { control: { gateView: 10, authSuccess: 1 }, a: { gateView: 10, authSuccess: 1 } },
      subs: { control: { newSubscribers: 12, confirmed: 0, matured: 0, confirmedWithin72hMatured: 0, active: 0 }, a: { newSubscribers: 3, confirmed: 0, matured: 0, confirmedWithin72hMatured: 0, active: 0 } },
    });
    expect(r.perArm.control.primary.overflow).toBe(true);
    expect(r.comparisons.primary[0].pValue).not.toBeNaN();
    const md = renderExperimentMarkdown(r, { experimentId: 'jobgate-v3', since: '2026-09-25', until: '2026-10-08' });
    expect(md).toContain('superano le persone gate_view');
  });

  it('senza control: niente confronti, markdown lo dice', () => {
    const r = buildExperimentReadout({ arms: ['a'], ga: { a: ga.a }, subs: { a: subs.a } });
    expect(r.comparisons.primary[0].pValue).toBeNull();
    const md = renderExperimentMarkdown(r, { experimentId: 'jobgate-v3', since: '2026-09-25', until: '2026-10-08' });
    expect(md).toContain('nessun dato per il braccio di controllo');
  });

  it('markdown in italiano con tutte le sezioni', () => {
    const r = buildExperimentReadout({ arms: ['control', 'a', 'b'], ga, subs, weights: { control: 34, a: 33, b: 33 } });
    const md = renderExperimentMarkdown(r, { experimentId: 'jobgate-v3', since: '2026-09-25', until: '2026-10-08', notes: ['nota di prova'] });
    for (const heading of ['## Metriche per braccio', '## Confronti vs control', '## Controllo SRM', '## Potenza', '## Note']) {
      expect(md).toContain(heading);
    }
    expect(md).toContain('`a`');
    expect(md).toContain('nota di prova');
  });
});

describe('buildBaseline', () => {
  it('somma le CTA e calcola CR primaria e conferma', () => {
    const b = buildBaseline({
      gateView: 1000,
      authSuccess: 90,
      ctas: ['job_board_email_unlock', 'job_board_social_unlock', 'job_expired_email_unlock'],
      ctaSubs: {
        job_board_email_unlock: { newSubscribers: 10, confirmed: 3, matured: 9, confirmedWithin72hMatured: 3, active: 3 },
        job_board_social_unlock: { newSubscribers: 15, confirmed: 12, matured: 15, confirmedWithin72hMatured: 12, active: 11 },
      },
    });
    expect(b.total.newSubscribers).toBe(25);
    expect(b.primary.rate).toBeCloseTo(0.025, 12);
    expect(b.total.confirmRate.rate).toBeCloseTo(0.6, 12);
    expect(b.perCta.job_expired_email_unlock.newSubscribers).toBe(0);
    const md = renderBaselineMarkdown(b, { since: '2026-09-09', until: '2026-09-22' });
    expect(md).toContain('Persone gate_view');
    expect(md).toContain('`job_board_social_unlock`');
  });
});
