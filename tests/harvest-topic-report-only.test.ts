/**
 * lessons-harvester — bucket di argomento solo nel report (decisione del
 * proprietario I3 del 2026-10-05, issue 10112).
 *
 * `canonical-sitemap` e' un lessico (canonical|sitemap|noindex|cross-section) e
 * sommava 9 finding di argomento, mentre la sua sottoclasse vera,
 * `canonical-trailing-slash`, aveva gia' un gate nel generatore e un bucket
 * proprio. Decisione: i bucket di argomento restano nel report e nella tally,
 * l'escalation scatta solo per le voci legate a una regola violata. Soglie
 * invariate.
 */
import { describe, it, expect } from 'vitest';
import {
  TAXONOMY,
  TAXONOMY_ESCALATION_KINDS,
  bucketEscalationKind,
  isTopicOnlyBucket,
  considerBuckets,
  clusterReportTag,
  selfHealDecision,
} from '../scripts/ci/harvest-agent-lessons.mjs';

const at = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString();
const examplesFor = (n: number, firstPr: number) =>
  Array.from({ length: n }, (_, i) => ({ pr: firstPr + i, severity: '🔴', snippet: `finding ${i}`, at: at(i + 1) }));

// Corpus dei doc che documenta entrambe le voci: l'unica differenza fra le due
// e' la classe di escalation.
const corpus = 'trailing slash obbligatorio. canonical e sitemap. cls e reserve space.';

describe('classificazione della TAXONOMY: regola o argomento, col motivo', () => {
  it('ogni voce dichiara una classe nota e un motivo non vuoto', () => {
    expect(TAXONOMY.length).toBeGreaterThan(0);
    for (const t of TAXONOMY) {
      expect(TAXONOMY_ESCALATION_KINDS, t.key).toContain(t.escalation);
      expect(String(t.why || '').length, t.key).toBeGreaterThan(20);
    }
  });

  it.each(['canonical-sitemap', 'cls-layout', 'router-nav', 'auto-ads'])('%s e\' argomento', (key) => {
    expect(bucketEscalationKind('reviewer-finding', key)).toBe('topic');
    expect(isTopicOnlyBucket('reviewer-finding', key)).toBe(true);
  });

  it.each([
    'canonical-trailing-slash', 'adsense-thin-content', 'adsense-slot-lifecycle', 'adsense-bot-gate',
    'adsense-loader-contract', 'structured-data-parser', 'workflow-scope-creds', 'pr-body-contract',
  ])('%s e\' regola', (key) => {
    expect(bucketEscalationKind('reviewer-finding', key)).toBe('rule');
    expect(isTopicOnlyBucket('reviewer-finding', key)).toBe(false);
  });

  it('le voci ambigue restano nell escalation', () => {
    const ambiguous = TAXONOMY.filter((t) => t.escalation === 'ambiguous').map((t) => t.key);
    for (const key of ambiguous) expect(isTopicOnlyBucket('reviewer-finding', key)).toBe(false);
  });

  it('fuori tassonomia la decisione non si applica: fingerprint e fix-outcome invariati', () => {
    expect(bucketEscalationKind('reviewer-finding', 'fp:manca-la-sezione-body')).toBeNull();
    expect(bucketEscalationKind('fix-outcome', 'canonical-sitemap')).toBeNull();
    expect(isTopicOnlyBucket('issue-class', 'cls-layout')).toBe(false);
  });

  it('accetta anche la chiave piena del titolo di escalation', () => {
    expect(bucketEscalationKind('reviewer-finding', 'reviewer-finding/canonical-sitemap')).toBe('topic');
  });
});

describe('considerBuckets: un argomento sopra soglia non escala, una regola si', () => {
  const run = () => {
    const bucketMeasures = new Map();
    const clusters = considerBuckets({
      source: 'reviewer-finding',
      counts: { 'canonical-sitemap': 9, 'canonical-trailing-slash': 7 },
      examples: { 'canonical-sitemap': examplesFor(9, 11000), 'canonical-trailing-slash': examplesFor(7, 12000) },
      corpus,
      bucketMeasures,
      threshold: 3,
    });
    return { clusters, bucketMeasures, byKey: new Map(clusters.map((c) => [c.key, c])) };
  };

  it('il bucket di argomento sopra soglia non escala', () => {
    const topic = run().byKey.get('canonical-sitemap');
    expect(topic).toBeDefined();
    expect(topic.alreadyDocumented).toBe(true);
    expect(topic.effectiveCount).toBe(9);
    expect(topic.recurringDespiteRule).toBe(false);
    expect(topic.topicAboveLimit).toBe(true);
    expect(topic.postCutoffExamples).toBeUndefined();
  });

  it('il bucket di regola sopra soglia escala', () => {
    const rule = run().byKey.get('canonical-trailing-slash');
    expect(rule).toBeDefined();
    expect(rule.recurringDespiteRule).toBe(true);
    expect(rule.topicAboveLimit).toBe(false);
    expect(rule.postCutoffExamples.length).toBe(rule.effectiveCount);
  });

  it('il report li elenca entrambi, con la misura e un etichetta distinta', () => {
    const { clusters, bucketMeasures, byKey } = run();
    expect(clusters.map((c) => c.key).sort()).toEqual(['canonical-sitemap', 'canonical-trailing-slash']);
    expect(clusterReportTag(byKey.get('canonical-sitemap'))).toBe('TOPIC-REPORT-ONLY');
    expect(clusterReportTag(byKey.get('canonical-trailing-slash'))).toBe('ESCALATE');
    // La tally non cambia: entrambi misurati per il self-heal.
    expect(bucketMeasures.get('reviewer-finding/canonical-sitemap').effectiveCount).toBe(9);
    expect(bucketMeasures.get('reviewer-finding/canonical-trailing-slash').effectiveCount).toBe(7);
  });

  it('sotto soglia un argomento non e\' marcato sopra soglia', () => {
    const clusters = considerBuckets({ source: 'reviewer-finding', counts: { 'cls-layout': 4 },
      examples: { 'cls-layout': examplesFor(4, 13000) }, corpus, threshold: 3 });
    expect(clusters[0].topicAboveLimit).toBe(false);
    expect(clusters[0].recurringDespiteRule).toBe(false);
    expect(clusterReportTag(clusters[0])).toBe('documented');
  });
});

describe('self-heal: l escalation aperta di un argomento si chiude da sola (issue 10112)', () => {
  const base = { partialSources: new Set<string>(), windowDays: 14, sinceDay: '2026-09-21', threshold: 3, factor: 2 };

  it('argomento sopra soglia → chiusa, citando la decisione I3 e la misura', () => {
    const d = selfHealDecision({ ...base, key: 'reviewer-finding/canonical-sitemap',
      labels: ['priority:high', 'follow-up', 'severity:medium'], measure: { effectiveCount: 9, cutoffMs: null } });
    expect(d.action).toBe('close');
    expect(d.comment).toContain('I3 del 2026-10-05');
    expect(d.comment).toContain('9 su soglia 6');
  });

  it('argomento con vista parziale della finestra → chiusa lo stesso: decide la classe, non la misura', () => {
    const d = selfHealDecision({ ...base, key: 'reviewer-finding/canonical-sitemap', labels: [],
      partialSources: new Set(['reviewer-finding']), measure: { effectiveCount: 9, cutoffMs: null } });
    expect(d.action).toBe('close');
  });

  it('pin e claim valgono anche per un argomento', () => {
    const key = 'reviewer-finding/canonical-sitemap';
    expect(selfHealDecision({ ...base, key, labels: ['keep-open'] }).action).toBe('skip');
    expect(selfHealDecision({ ...base, key, labels: ['agent:in-progress'] }).action).toBe('skip');
  });

  it('una regola sopra soglia ma non attiva resta aperta (comportamento invariato)', () => {
    const d = selfHealDecision({ ...base, key: 'reviewer-finding/canonical-trailing-slash', labels: [],
      measure: { effectiveCount: 7, cutoffMs: null } });
    expect(d.action).toBe('skip');
  });
});
