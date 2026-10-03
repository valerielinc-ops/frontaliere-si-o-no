import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Firestore indicizza da solo ogni campo scalare (asc e desc), ogni elemento
 * di array e ogni chiave di mappa. Il 03-10-2026 lo storage del progetto era
 * 28,79 GiB, in buona parte voci d'indice su campi che nessuna query usa.
 * `fieldOverrides` con `indexes: []` spegne quell'indice automatico.
 *
 * Due modi di rompere, e questo test li guarda entrambi:
 *  - un'esenzione sparisce -> lo storage torna a crescere in silenzio;
 *  - un'esenzione finisce su un campo interrogato -> la query fallisce in
 *    produzione con FAILED_PRECONDITION.
 *
 * Un'esenzione vale per l'intero collection GROUP (ogni collection con quel
 * nome, sotto qualunque genitore). Prima di aggiungere una query su una di
 * queste collection, o un'esenzione nuova, aggiorna QUERIED qui sotto.
 */

type FieldIndex = { order?: string; arrayConfig?: string; queryScope: string };
type FieldOverride = { collectionGroup: string; fieldPath: string; ttl?: boolean; indexes: FieldIndex[] };
type CompositeIndex = { collectionGroup: string; queryScope: string; fields: Array<{ fieldPath: string }> };

const config = JSON.parse(
  readFileSync(path.resolve(__dirname, '..', 'firestore.indexes.json'), 'utf8'),
) as { indexes: CompositeIndex[]; fieldOverrides: FieldOverride[] };

const overrides = config.fieldOverrides;
const key = (collectionGroup: string, fieldPath: string) => `${collectionGroup}.${fieldPath}`;
const isExempt = (override: FieldOverride) => override.indexes.length === 0;
const exempted = new Set(overrides.filter(isExempt).map((o) => key(o.collectionGroup, o.fieldPath)));

/** Limite Firestore: 200 esenzioni di indice a campo singolo per database. */
const FIRESTORE_FIELD_OVERRIDE_LIMIT = 200;

/**
 * Campi usati da una query in codice (where / orderBy / filtro REST), con il
 * file che la esegue. Nessuno di questi puo' avere `indexes: []`.
 */
const QUERIED: Array<[string, string, string]> = [
  ['plate_auctions_history', 'sourceFetchedAt', 'functions/src/plateAuctions.js orderBy desc'],
  ['plate_auctions_history', 'sourceKey', 'tenuto per parita con plate_auctions_current'],
  ['plate_auctions_history', 'lastSeenAt', 'conteggi diagnostici per giorno'],
  ['campaign_deliveries', 'campaign_id', 'scripts/lib/newsletter-ab-data.mjs'],
  ['campaign_deliveries', 'sent_at', 'scripts/report-daily-brief-cadence.mjs, scripts/ci/export-loop-outcomes.mjs'],
  ['campaign_deliveries', 'clicked_at', 'scripts/send-daily-brief.mjs'],
  ['events', 'timestamp', 'scripts/report-email-engagement.mjs'],
  ['events', 'campaign_id', 'scripts/lib/newsletter-ab-data.mjs'],
  ['events', 'event_type', 'scripts/check-unsubscribe-credential-rate.mjs'],
  ['events', 'provider', 'indice composito provider + timestamp'],
  ['events', 'occurred_at', 'functions/src/lib/preferredSendHour.js'],
  ['events', 'source_channel', 'scripts/newsletter-confirmed-status-backfill.mjs'],
  ['events', 'pair_re_opt_in_at', 'scripts/audit-resubscribe-pairs.mjs'],
  ['alerts', 'active', 'scripts/send-job-alerts.mjs, functions/src/jobAlertUnsubscribe.js'],
  ['alerts', 'frequency', 'scripts/send-company-alerts.mjs'],
  ['alerts', 'userId', 'services/jobAlertService.ts'],
  ['alerts', 'createdAt', 'services/jobAlertService.ts'],
  ['job_email_ranking_events', 'occurred_at', 'conteggi diagnostici per giorno'],
  ['job_email_ranking_deliveries', 'sent_at', 'conteggi diagnostici per giorno'],
  ['job_email_ranking_stats', 'surface', 'functions/src/lib/jobEmailRankingStore.js'],
  ['job_email_ranking_stats', 'surface_id', 'functions/src/lib/jobEmailRankingStore.js'],
  ['job_email_ranking_stats', 'date', 'functions/src/lib/jobEmailRankingStore.js'],
];

/** Campi pesanti e mai interrogati: l'esenzione deve restare nel file. */
const MUST_BE_EXEMPT: Array<[string, string]> = [
  ['campaign_deliveries', 'ranking_jobs'],
  ['alerts', 'ranking_stats'],
  ['alerts', 'sentJobIds'],
  ['events', 'metadata'],
  ['job_email_ranking_events', 'job_id'],
  ['job_email_ranking_events', 'user_id'],
  ['job_email_ranking_events', 'delivery_id'],
  ['job_email_ranking_deliveries', 'jobs'],
  ['plate_auctions_history', 'officialAuctionUrl'],
  ['plate_auctions_history', 'officialDetailUrl'],
  ['plate_auctions_history', 'rawSnapshotHash'],
];

/** Vero se `fieldPath` e' esentato, direttamente o tramite una mappa genitore. */
function exemptedBy(collectionGroup: string, fieldPath: string): string | null {
  const parts = fieldPath.split('.');
  for (let length = parts.length; length > 0; length -= 1) {
    const candidate = key(collectionGroup, parts.slice(0, length).join('.'));
    if (exempted.has(candidate)) return candidate;
  }
  return null;
}

describe('firestore.indexes.json — fieldOverrides', () => {
  it('ogni override ha una forma valida e la coppia collectionGroup + fieldPath e unica', () => {
    const seen = new Set<string>();
    for (const override of overrides) {
      const id = key(override.collectionGroup, override.fieldPath);
      expect(typeof override.collectionGroup, id).toBe('string');
      expect(typeof override.fieldPath, id).toBe('string');
      expect(Array.isArray(override.indexes), `${id}: indexes deve essere un array`).toBe(true);
      for (const index of override.indexes) {
        expect(['COLLECTION', 'COLLECTION_GROUP'], id).toContain(index.queryScope);
        expect(Boolean(index.order) !== Boolean(index.arrayConfig), `${id}: order oppure arrayConfig`).toBe(true);
      }
      expect(seen.has(id), `${id}: override duplicato`).toBe(false);
      seen.add(id);
    }
  });

  it('gli override TTL restano con ttl: true e senza indici', () => {
    for (const collectionGroup of ['job_email_ranking_stats', 'job_email_ranking_events', 'job_email_ranking_deliveries']) {
      const override = overrides.find((o) => o.collectionGroup === collectionGroup && o.fieldPath === 'expires_at');
      expect(override, `${collectionGroup}.expires_at`).toBeDefined();
      expect(override?.ttl, `${collectionGroup}.expires_at`).toBe(true);
      expect(override?.indexes, `${collectionGroup}.expires_at`).toEqual([]);
    }
    // `ttl` compare solo dove serve: un'esenzione semplice non lo dichiara.
    for (const override of overrides) {
      if (override.ttl !== undefined) expect(override.fieldPath, key(override.collectionGroup, override.fieldPath)).toBe('expires_at');
    }
  });

  it('un campo interrogato da una query non e mai esentato', () => {
    for (const [collectionGroup, fieldPath, usedBy] of QUERIED) {
      expect(
        exemptedBy(collectionGroup, fieldPath),
        `${collectionGroup}.${fieldPath} e interrogato (${usedBy}) ma ha indexes: []: la query fallirebbe in produzione`,
      ).toBeNull();
    }
  });

  it('un campo di un indice composito non e mai esentato', () => {
    for (const index of config.indexes) {
      for (const field of index.fields) {
        expect(
          exemptedBy(index.collectionGroup, field.fieldPath),
          `${index.collectionGroup}.${field.fieldPath} sta in un indice composito ma ha indexes: []`,
        ).toBeNull();
      }
    }
  });

  it('campaign_deliveries.clicked_at coincide con l override di produzione', () => {
    const override = overrides.find((o) => o.collectionGroup === 'campaign_deliveries' && o.fieldPath === 'clicked_at');
    expect(override?.indexes).toEqual([
      { order: 'ASCENDING', queryScope: 'COLLECTION' },
      { order: 'ASCENDING', queryScope: 'COLLECTION_GROUP' },
    ]);
  });

  it('i campi pesanti mai interrogati restano esentati', () => {
    const missing = MUST_BE_EXEMPT
      .filter(([collectionGroup, fieldPath]) => !exempted.has(key(collectionGroup, fieldPath)))
      .map(([collectionGroup, fieldPath]) => key(collectionGroup, fieldPath));
    expect(missing, 'firestore.indexes.json: indici automatici su campi mai interrogati').toEqual([]);
  });

  it('il totale degli override resta sotto il limite di 200 per database', () => {
    expect(overrides.length).toBeLessThan(FIRESTORE_FIELD_OVERRIDE_LIMIT);
  });
});
