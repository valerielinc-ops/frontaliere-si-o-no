import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
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
  ['events', 'timestamp', 'scripts/report-email-engagement.mjs, scripts/build-job-email-affinity.mjs'],
  ['events', 'campaign_id', 'scripts/lib/newsletter-ab-data.mjs'],
  ['events', 'event_type', 'scripts/check-unsubscribe-credential-rate.mjs, scripts/build-job-email-affinity.mjs'],
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
  ['private', 'applicationIntentAuthUid', 'functions/src/authAccountCleanup.js'],
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
  // Profilo di affinita' dai clic: letto e scritto solo per id documento
  // (scripts/build-job-email-affinity.mjs), mai interrogato per campo.
  ['job_email_affinity', 'user_id'],
  ['job_email_affinity', 'dimensions'],
  ['job_email_affinity', 'clicks'],
  ['job_email_affinity', 'applied_clicks'],
  ['job_email_affinity', 'last_click_at'],
  ['job_email_affinity', 'updated_at'],
  ['job_email_affinity', 'version'],
  ['job_email_affinity_meta', 'processed_until'],
  ['job_email_affinity_meta', 'updated_at'],
  ['job_email_affinity_meta', 'version'],
  // Flag che il passo 3 dell'ordinamento per affinita' scrivera' su ogni riga.
  ['job_email_ranking_events', 'affinity_profile'],
  ['job_email_ranking_deliveries', 'affinity_profile'],
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

/**
 * Una query `collectionGroup('<gruppo>').where('<campo>', ...)` non usa
 * l'indice automatico (che ha scope COLLECTION): le serve un indice con scope
 * COLLECTION_GROUP, dichiarato qui come override a campo singolo oppure come
 * indice composito. Senza, Firestore risponde `9 FAILED_PRECONDITION` solo in
 * produzione: nessun test locale lo vede. Dal 29-09 al 03-10-2026
 * `cleanupUserDataOnAccountDelete` e' fallita cosi' a ogni cancellazione di
 * account, su `private.applicationIntentAuthUid`.
 */
function hasCollectionGroupCoverage(collectionGroup: string, fieldPath: string): boolean {
  const single = overrides.some(
    (o) => o.collectionGroup === collectionGroup
      && o.fieldPath === fieldPath
      && o.indexes.some((index) => index.queryScope === 'COLLECTION_GROUP'),
  );
  const composite = config.indexes.some(
    (index) => index.collectionGroup === collectionGroup
      && index.queryScope === 'COLLECTION_GROUP'
      && index.fields.some((field) => field.fieldPath === fieldPath),
  );
  return single || composite;
}

/** Radici scandite dalla guardia di classe: codice server che usa l'Admin SDK. */
const SOURCE_ROOTS = ['functions/src', 'functions/index.js', 'scripts'];
const SOURCE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts']);
const repoRoot = path.resolve(__dirname, '..');

function listSources(relative: string): string[] {
  const absolute = path.join(repoRoot, relative);
  if (!existsSync(absolute)) return [];
  if (statSync(absolute).isFile()) return [relative];
  const found: string[] = [];
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) found.push(...listSources(child));
    else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) found.push(child);
  }
  return found;
}

const GROUP_CALL = /collectionGroup\(\s*(['"])([\w-]+)\1\s*\)/g;
const FIELD_CALL = /\.\s*(?:where|orderBy)\(\s*(['"])([\w.-]+)\1/g;
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

type GroupQueryField = { collectionGroup: string; fieldPath: string; file: string; line: number };

/**
 * Estrazione statica, solo dei casi letterali:
 *  - catena nella stessa istruzione: `collectionGroup('g').where('f', ...)`;
 *  - query tenuta in una variabile: `const q = db.collectionGroup('g')` e poi
 *    `q.where('f', ...)` nello stesso file.
 * Restano fuori, per costruzione, i gruppi o i campi passati come variabile
 * (`collectionGroup(group).where(timestampField, ...)`) e le query REST
 * (`allDescendants: true`). La copertura verificata e' per campo: dice che un
 * indice collection-group esiste, non che un filtro su piu' campi abbia il
 * composito giusto.
 */
function extractGroupQueryFields(source: string, file: string): GroupQueryField[] {
  const found: GroupQueryField[] = [];
  const lineAt = (offset: number) => source.slice(0, offset).split('\n').length;
  const collectFields = (collectionGroup: string, text: string, offset: number) => {
    for (const field of text.matchAll(FIELD_CALL)) {
      found.push({ collectionGroup, fieldPath: field[2], file, line: lineAt(offset + (field.index ?? 0)) });
    }
  };
  const statementEnd = (from: number) => {
    const end = source.indexOf(';', from);
    return end === -1 ? source.length : end;
  };

  for (const call of source.matchAll(GROUP_CALL)) {
    const collectionGroup = call[2];
    const start = call.index ?? 0;
    const afterCall = start + call[0].length;
    collectFields(collectionGroup, source.slice(afterCall, statementEnd(afterCall)), afterCall);

    const lineStart = source.lastIndexOf('\n', start) + 1;
    const declaration = source.slice(lineStart, start).match(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=[^=;]*$/);
    if (!declaration) continue;
    const usage = new RegExp(`(?<![\\w$.])${escapeRegExp(declaration[1])}\\s*(?=\\.\\s*(?:where|orderBy)\\()`, 'g');
    for (const use of source.slice(afterCall).matchAll(usage)) {
      const useStart = afterCall + (use.index ?? 0);
      collectFields(collectionGroup, source.slice(useStart, statementEnd(useStart)), useStart);
    }
  }
  return found;
}

let scanned: GroupQueryField[] | null = null;
function scanSources(): GroupQueryField[] {
  scanned ??= SOURCE_ROOTS.flatMap(listSources).flatMap((file) => {
    const source = readFileSync(path.join(repoRoot, file), 'utf8');
    return source.includes('collectionGroup(') ? extractGroupQueryFields(source, file) : [];
  });
  return scanned;
}

describe('firestore.indexes.json — query collection-group', () => {
  it('private.applicationIntentAuthUid ha un indice COLLECTION_GROUP', () => {
    const override = overrides.find((o) => o.collectionGroup === 'private' && o.fieldPath === 'applicationIntentAuthUid');
    expect(
      override?.indexes,
      'cleanupUserDataOnAccountDelete: indice collection-group mancante su private.applicationIntentAuthUid',
    ).toEqual([
      { order: 'ASCENDING', queryScope: 'COLLECTION' },
      { order: 'ASCENDING', queryScope: 'COLLECTION_GROUP' },
    ]);
  });

  it('l estrattore riconosce catena, variabile e variabile derivata, e ignora i casi dinamici', () => {
    const sample = [
      "const a = await db.collectionGroup('events')",
      "  .where('event_type', '==', 'x')",
      "  .orderBy('timestamp', 'desc')",
      '  .get();',
      "const privateCollection = db.collectionGroup('private');",
      "const query = ok ? privateCollection.where('applicationIntentAuthUid', '==', uid) : privateCollection;",
      "const base = db.collectionGroup('alerts').where('active', '==', true);",
      "return await base.where('frequency', '==', f).get();",
      "const dynamic = await db.collectionGroup(group).where(field, '>=', cutoff).get();",
      "const scan = await db.collectionGroup('savedJobs').get();",
      "const other = db.collection('users').where('email', '==', email);",
    ].join('\n');
    expect(extractGroupQueryFields(sample, 'sample.js').map((q) => `${key(q.collectionGroup, q.fieldPath)}:${q.line}`)).toEqual([
      'events.event_type:2',
      'events.timestamp:3',
      'private.applicationIntentAuthUid:6',
      'alerts.active:7',
      'alerts.frequency:8',
    ]);
  });

  it('ogni coppia collectionGroup + campo letterale nei sorgenti ha un indice COLLECTION_GROUP', () => {
    const queried = scanSources();

    // Se l'estrazione smette di vedere la query che ha causato l'incidente, la
    // guardia e' diventata cieca: meglio un rosso che un verde vuoto.
    expect(
      queried.some((q) => q.file === path.join('functions', 'src', 'authAccountCleanup.js')
        && q.collectionGroup === 'private' && q.fieldPath === 'applicationIntentAuthUid'),
      'la guardia non trova piu la query di functions/src/authAccountCleanup.js: estrattore da aggiornare',
    ).toBe(true);

    const uncovered = queried
      .filter((q) => !hasCollectionGroupCoverage(q.collectionGroup, q.fieldPath))
      .map((q) => `${q.file}:${q.line} ${key(q.collectionGroup, q.fieldPath)}`);
    expect(
      uncovered,
      'query collection-group senza indice COLLECTION_GROUP in firestore.indexes.json (FAILED_PRECONDITION in produzione)',
    ).toEqual([]);
  });

  it('un campo interrogato a scope collection-group non e mai esentato', () => {
    for (const q of scanSources()) {
      expect(exemptedBy(q.collectionGroup, q.fieldPath), `${q.file}:${q.line} ${key(q.collectionGroup, q.fieldPath)} ha indexes: []`).toBeNull();
    }
  });
});

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
    for (const collectionGroup of ['job_email_ranking_stats', 'job_email_ranking_events', 'job_email_ranking_deliveries', 'job_email_affinity']) {
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
