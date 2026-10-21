import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeProspectorPath, mergeThreeWay } from '../scripts/lib/resolve-prospector-conflicts.mjs';

const now = Date.now();
const iso = (offsetMs: number) => new Date(now + offsetMs).toISOString();

describe('Prospector rebase conflict resolver', () => {
  it('unisce queue concorrenti e non fa regredire lo stato del candidato', () => {
    const base: any = {
      version: 2,
      updatedAt: iso(0),
      candidates: {
        shared: {
          key: 'shared',
          status: 'traced',
          sources: ['seco'],
          firstSeenAt: iso(-3000),
          updatedAt: iso(-2000),
          validationHistory: [{ at: iso(-1000), verdict: 'weak', score: 0.4 }],
        },
      },
      rejectedTombstones: {},
    };
    const upstream = structuredClone(base);
    upstream.updatedAt = iso(1000);
    upstream.candidates.remote = { key: 'remote', status: 'new', sources: ['osm'], updatedAt: iso(1000) };
    upstream.candidates.shared.status = 'promoted';
    upstream.candidates.shared.sources = ['seco', 'web'];
    upstream.candidates.shared.validationHistory.push({ at: iso(1100), verdict: 'good', score: 0.9 });

    const local = structuredClone(base);
    local.updatedAt = iso(2000);
    local.candidates.local = { key: 'local', status: 'synthesized', sources: ['own'], updatedAt: iso(2000) };
    local.candidates.shared.status = 'production';
    local.candidates.shared.sources = ['seco', 'web', 'own'];
    local.candidates.shared.validationHistory.push({ at: iso(2100), verdict: 'good', score: 0.95 });

    const merged = mergeProspectorPath('data/prospector/candidates.json', base, upstream, local) as typeof base;
    expect(Object.keys(merged.candidates)).toEqual(['local', 'remote', 'shared']);
    expect(merged.candidates.shared.status).toBe('production');
    expect(merged.candidates.shared.sources).toEqual(['seco', 'web', 'own']);
    expect(merged.candidates.shared.validationHistory).toHaveLength(3);
    expect(merged.updatedAt).toBe(local.updatedAt);
  });

  it('ordina il requeue legacy rispetto a rejection concorrenti dello stesso candidato', () => {
    const rejectedReason = 'sintesi fallita: nessun annuncio estratto dal seed';
    const recoveryAt = iso(3000);
    const base: any = {
      version: 2,
      updatedAt: iso(0),
      candidates: {
        legacy: {
          key: 'legacy',
          status: 'rejected',
          reason: rejectedReason,
          rejectedAt: iso(0),
          updatedAt: iso(0),
          synthesisRetryable: false,
        },
      },
    };
    const upstream = structuredClone(base);
    upstream.candidates.legacy.sources = ['osm', 'web'];
    upstream.candidates.legacy.updatedAt = iso(4000);
    const local = structuredClone(base);
    Object.assign(local.candidates.legacy, {
      status: 'traced',
      reason: 'sintesi senza annunci: recupero multi-seed in coda',
      synthesisRetryable: false,
      synthesisRetryExhausted: false,
      synthesisAttempts: 0,
      synthesisOutcome: 'legacy_no_vacancy_recovery',
      synthesisRecoveryQueuedAt: recoveryAt,
      reopenedAt: recoveryAt,
      updatedAt: recoveryAt,
    });
    delete local.candidates.legacy.rejectedAt;

    const mergedRecovery = mergeProspectorPath('data/prospector/candidates.json', base, upstream, local) as typeof base;
    expect(mergedRecovery.candidates.legacy).toMatchObject({
      status: 'traced',
      synthesisOutcome: 'legacy_no_vacancy_recovery',
      synthesisRecoveryQueuedAt: recoveryAt,
    });
    expect(mergedRecovery.candidates.legacy.rejectedAt).toBeUndefined();

    const freshRejection = structuredClone(upstream);
    Object.assign(freshRejection.candidates.legacy, {
      reason: 'sintesi fallita: seed irraggiungibile (404)',
      rejectedAt: iso(5000),
      updatedAt: iso(5000),
      synthesisAttempts: 1,
      synthesisOutcome: 'permanent_seed_failure',
    });
    const mergedRejection = mergeProspectorPath('data/prospector/candidates.json', base, freshRejection, local) as typeof base;
    expect(mergedRejection.candidates.legacy).toMatchObject({
      status: 'rejected',
      reason: 'sintesi fallita: seed irraggiungibile (404)',
      synthesisOutcome: 'permanent_seed_failure',
      synthesisAttempts: 1,
    });
    expect(mergedRejection.candidates.legacy.synthesisRecoveryQueuedAt).toBeUndefined();
  });

  it('preserves a retryable legacy recovery after its outcome changes in a concurrent run', () => {
    const recoveryAt = iso(3000);
    const base: any = {
      version: 2,
      updatedAt: iso(0),
      candidates: {
        legacy: {
          key: 'legacy',
          status: 'rejected',
          reason: 'sintesi fallita: nessun annuncio estratto dal seed',
          rejectedAt: iso(0),
          updatedAt: iso(0),
          synthesisRetryable: false,
        },
      },
    };
    const upstream = structuredClone(base);
    upstream.candidates.legacy.sources = ['osm', 'web'];
    upstream.candidates.legacy.updatedAt = iso(4000);

    const local = structuredClone(base);
    Object.assign(local.candidates.legacy, {
      key: 'legacy',
      status: 'traced',
      reason: 'sintesi fallita: seed irraggiungibile (503)',
      synthesisRetryable: true,
      synthesisRetryExhausted: false,
      synthesisAttempts: 1,
      synthesisLastAttemptAt: iso(4000),
      synthesisRetryAt: iso(86_400_000),
      synthesisOutcome: 'transient_seed_failure',
      synthesisRecoveryQueuedAt: recoveryAt,
      reopenedAt: recoveryAt,
      updatedAt: iso(4000),
    });
    delete local.candidates.legacy.rejectedAt;

    const merged = mergeProspectorPath('data/prospector/candidates.json', base, upstream, local) as typeof base;
    expect(merged.candidates.legacy).toMatchObject({
      status: 'traced',
      reason: 'sintesi fallita: seed irraggiungibile (503)',
      synthesisRetryable: true,
      synthesisAttempts: 1,
      synthesisOutcome: 'transient_seed_failure',
      synthesisRecoveryQueuedAt: recoveryAt,
    });
    expect(merged.candidates.legacy.rejectedAt).toBeUndefined();
  });

  it.each([
    ['a definitive 404', {
      reason: 'sintesi fallita: seed irraggiungibile (404)',
      attempts: 1,
      exhausted: false,
    }],
    ['an exhausted retry', {
      reason: 'sintesi fallita: seed irraggiungibile (503) — retry esauriti',
      attempts: 6,
      exhausted: true,
    }],
  ])('keeps the newer rejection after recovery over an intermediate concurrent rejection (%s)', (_label, latest) => {
    const recoveryAt = iso(3000);
    const upstreamRejectedAt = iso(5000);
    const recoveredRejectedAt = iso(7000);
    const base: any = {
      version: 2,
      updatedAt: iso(0),
      candidates: {
        legacy: {
          key: 'legacy',
          status: 'rejected',
          reason: 'sintesi fallita: nessun annuncio estratto dal seed',
          rejectedAt: iso(0),
          updatedAt: iso(0),
          synthesisRetryable: false,
        },
      },
    };
    const upstream = structuredClone(base);
    Object.assign(upstream.candidates.legacy, {
      reason: 'sintesi fallita: seed irraggiungibile (410)',
      rejectedAt: upstreamRejectedAt,
      updatedAt: upstreamRejectedAt,
      synthesisAttempts: 1,
      synthesisOutcome: 'permanent_seed_failure',
    });

    const local = structuredClone(base);
    Object.assign(local.candidates.legacy, {
      reason: latest.reason,
      rejectedAt: recoveredRejectedAt,
      updatedAt: recoveredRejectedAt,
      synthesisRetryable: false,
      synthesisRetryExhausted: latest.exhausted,
      synthesisAttempts: latest.attempts,
      synthesisOutcome: 'permanent_seed_failure',
      synthesisRecoveryQueuedAt: recoveryAt,
      reopenedAt: recoveryAt,
    });

    const merged = mergeProspectorPath('data/prospector/candidates.json', base, upstream, local) as typeof base;
    expect(merged.candidates.legacy).toMatchObject({
      status: 'rejected',
      reason: latest.reason,
      rejectedAt: recoveredRejectedAt,
      synthesisRetryExhausted: latest.exhausted,
      synthesisAttempts: latest.attempts,
      synthesisRecoveryQueuedAt: recoveryAt,
    });
  });

  it.each([
    ['newer than', iso(7000), iso(6000)],
    ['at the same time as', iso(7000), iso(7000)],
  ])('keeps a terminal recovery rejection when it is %s the retryable branch attempt', (_label, terminalAt, retryableAt) => {
    const recoveryAt = iso(3000);
    const base: any = {
      version: 2,
      updatedAt: iso(0),
      candidates: {
        legacy: {
          key: 'legacy',
          status: 'rejected',
          reason: 'sintesi fallita: nessun annuncio estratto dal seed',
          rejectedAt: iso(0),
          updatedAt: iso(0),
          synthesisRetryable: false,
        },
      },
    };

    const upstream = structuredClone(base);
    Object.assign(upstream.candidates.legacy, {
      status: 'rejected',
      reason: 'sintesi fallita: seed irraggiungibile (404)',
      rejectedAt: terminalAt,
      updatedAt: terminalAt,
      synthesisRetryable: false,
      synthesisRetryExhausted: false,
      synthesisAttempts: 1,
      synthesisLastAttemptAt: terminalAt,
      synthesisOutcome: 'permanent_seed_failure',
      synthesisRecoveryQueuedAt: recoveryAt,
      reopenedAt: recoveryAt,
    });

    const local = structuredClone(base);
    Object.assign(local.candidates.legacy, {
      status: 'traced',
      reason: 'sintesi fallita: seed irraggiungibile (503)',
      synthesisRetryable: true,
      synthesisRetryExhausted: false,
      synthesisAttempts: 1,
      synthesisLastAttemptAt: retryableAt,
      synthesisRetryAt: iso(Date.parse(retryableAt) + 86_400_000),
      synthesisOutcome: 'transient_seed_failure',
      synthesisRecoveryQueuedAt: recoveryAt,
      reopenedAt: recoveryAt,
      updatedAt: retryableAt,
    });
    delete local.candidates.legacy.rejectedAt;

    const merged = mergeProspectorPath('data/prospector/candidates.json', base, upstream, local) as typeof base;
    expect(merged.candidates.legacy).toMatchObject({
      status: 'rejected',
      reason: 'sintesi fallita: seed irraggiungibile (404)',
      rejectedAt: terminalAt,
      synthesisRetryable: false,
      synthesisRetryExhausted: false,
      synthesisAttempts: 1,
      synthesisLastAttemptAt: terminalAt,
      synthesisOutcome: 'permanent_seed_failure',
      synthesisRecoveryQueuedAt: recoveryAt,
    });
    expect(merged.candidates.legacy.synthesisRetryAt).toBeUndefined();
  });

  it('does not downgrade a synthesized candidate for a later retryable recovery branch', () => {
    const recoveryAt = iso(3000);
    const base: any = {
      version: 2,
      updatedAt: iso(0),
      candidates: {
        legacy: {
          key: 'legacy',
          status: 'rejected',
          reason: 'sintesi fallita: nessun annuncio estratto dal seed',
          rejectedAt: iso(0),
          updatedAt: iso(0),
          synthesisRetryable: false,
        },
      },
    };

    const upstream = structuredClone(base);
    Object.assign(upstream.candidates.legacy, {
      status: 'synthesized',
      reason: null,
      updatedAt: iso(7000),
      synthesisRetryable: false,
      synthesisRecoveryQueuedAt: recoveryAt,
      synthesisLastAttemptAt: iso(7000),
    });
    delete upstream.candidates.legacy.rejectedAt;

    const local = structuredClone(base);
    Object.assign(local.candidates.legacy, {
      status: 'traced',
      reason: 'sintesi fallita: seed irraggiungibile (503)',
      updatedAt: iso(8000),
      synthesisRetryable: true,
      synthesisAttempts: 1,
      synthesisLastAttemptAt: iso(8000),
      synthesisOutcome: 'transient_seed_failure',
      synthesisRecoveryQueuedAt: recoveryAt,
    });
    delete local.candidates.legacy.rejectedAt;

    const merged = mergeProspectorPath('data/prospector/candidates.json', base, upstream, local) as typeof base;
    expect(merged.candidates.legacy.status).toBe('synthesized');
  });

  it('preserves a later terminal attempt even when another recovery has a newer queue marker', () => {
    const base: any = {
      version: 2,
      updatedAt: iso(0),
      candidates: {
        legacy: {
          key: 'legacy',
          status: 'rejected',
          reason: 'sintesi fallita: nessun annuncio estratto dal seed',
          rejectedAt: iso(0),
          updatedAt: iso(0),
          synthesisRetryable: false,
        },
      },
    };
    const olderRecoveryTerminal = structuredClone(base);
    Object.assign(olderRecoveryTerminal.candidates.legacy, {
      reason: 'sintesi fallita: seed irraggiungibile (404)',
      rejectedAt: iso(9000),
      updatedAt: iso(9000),
      synthesisRetryable: false,
      synthesisAttempts: 1,
      synthesisOutcome: 'permanent_seed_failure',
      synthesisRecoveryQueuedAt: iso(3000),
    });

    const newerRecoveryRetryable = structuredClone(base);
    Object.assign(newerRecoveryRetryable.candidates.legacy, {
      status: 'traced',
      reason: 'sintesi fallita: seed irraggiungibile (503)',
      rejectedAt: undefined,
      updatedAt: iso(8000),
      synthesisRetryable: true,
      synthesisAttempts: 2,
      synthesisLastAttemptAt: iso(8000),
      synthesisRetryAt: iso(86_400_000),
      synthesisOutcome: 'transient_seed_failure',
      synthesisRecoveryQueuedAt: iso(6000),
    });
    delete newerRecoveryRetryable.candidates.legacy.rejectedAt;

    const merged = mergeProspectorPath(
      'data/prospector/candidates.json', base, olderRecoveryTerminal, newerRecoveryRetryable,
    ) as typeof base;
    expect(merged.candidates.legacy).toMatchObject({
      status: 'rejected',
      reason: 'sintesi fallita: seed irraggiungibile (404)',
      rejectedAt: iso(9000),
      synthesisRecoveryQueuedAt: iso(3000),
      synthesisOutcome: 'permanent_seed_failure',
    });
  });

  it('allows a genuinely later requeue to reopen a previously terminal recovery', () => {
    const base: any = {
      version: 2,
      updatedAt: iso(0),
      candidates: {
        legacy: {
          key: 'legacy',
          status: 'rejected',
          reason: 'sintesi fallita: nessun annuncio estratto dal seed',
          rejectedAt: iso(0),
          updatedAt: iso(0),
          synthesisRetryable: false,
        },
      },
    };
    const terminal = structuredClone(base);
    Object.assign(terminal.candidates.legacy, {
      reason: 'sintesi fallita: seed irraggiungibile (404)',
      rejectedAt: iso(7000),
      updatedAt: iso(7000),
      synthesisRetryable: false,
      synthesisAttempts: 1,
      synthesisRecoveryQueuedAt: iso(3000),
      synthesisOutcome: 'permanent_seed_failure',
    });
    const laterRequeue = structuredClone(base);
    Object.assign(laterRequeue.candidates.legacy, {
      status: 'traced',
      reason: 'sintesi senza annunci: recupero multi-seed in coda',
      updatedAt: iso(8000),
      synthesisRetryable: false,
      synthesisRetryExhausted: false,
      synthesisAttempts: 0,
      synthesisLastAttemptAt: null,
      synthesisRetryAt: null,
      synthesisRecoveryQueuedAt: iso(8000),
      synthesisOutcome: 'legacy_no_vacancy_recovery',
    });
    delete laterRequeue.candidates.legacy.rejectedAt;

    const merged = mergeProspectorPath('data/prospector/candidates.json', base, terminal, laterRequeue) as typeof base;
    expect(merged.candidates.legacy).toMatchObject({
      status: 'traced',
      reason: 'sintesi senza annunci: recupero multi-seed in coda',
      synthesisRecoveryQueuedAt: iso(8000),
      synthesisOutcome: 'legacy_no_vacancy_recovery',
    });
    expect(merged.candidates.legacy.rejectedAt).toBeUndefined();
  });

  it('mantiene i segnali SECO più freschi insieme ai timestamp delle altre fonti', () => {
    const base: any = {
      version: 2,
      updatedAt: iso(0),
      candidates: {
        shared: {
          key: 'shared',
          status: 'new',
          sourceSeenAt: { seco: iso(-3000), osm: iso(-3000) },
          adCount: 1,
          sampleTitles: ['Titolo SECO vecchio'],
          applyHosts: ['old-board.example'],
        },
      },
      rejectedTombstones: {},
    };
    const upstream = structuredClone(base);
    upstream.candidates.shared.sourceSeenAt.seco = iso(1000);
    upstream.candidates.shared.adCount = 4;
    upstream.candidates.shared.sampleTitles = ['Titolo SECO aggiornato'];
    upstream.candidates.shared.applyHosts = ['new-board.example'];

    const local = structuredClone(base);
    local.candidates.shared.sourceSeenAt.osm = iso(2000);
    local.candidates.shared.updatedAt = iso(2000);

    const merged = mergeProspectorPath('data/prospector/candidates.json', base, upstream, local) as typeof base;
    expect(merged.candidates.shared.sourceSeenAt).toEqual({ seco: iso(1000), osm: iso(2000) });
    expect(merged.candidates.shared).toMatchObject({
      adCount: 4,
      sampleTitles: ['Titolo SECO aggiornato'],
      applyHosts: ['new-board.example'],
    });
  });

  it('mantiene la precedenza locale nei conflitti legacy senza timestamp SECO', () => {
    const base: any = {
      version: 2,
      updatedAt: iso(0),
      candidates: { shared: { key: 'shared', adCount: 1, sampleTitles: ['Base'], applyHosts: ['base.example'] } },
      rejectedTombstones: {},
    };
    const upstream = structuredClone(base);
    upstream.candidates.shared.adCount = 2;
    upstream.candidates.shared.sampleTitles = ['Upstream'];
    upstream.candidates.shared.applyHosts = ['upstream.example'];
    const local = structuredClone(base);
    local.candidates.shared.adCount = 3;
    local.candidates.shared.sampleTitles = ['Local'];
    local.candidates.shared.applyHosts = ['local.example'];

    const merged = mergeProspectorPath('data/prospector/candidates.json', base, upstream, local) as typeof base;
    expect(merged.candidates.shared).toMatchObject({
      adCount: 3,
      sampleTitles: ['Local'],
      applyHosts: ['local.example'],
    });
  });

  it('mantiene il rifiuto terminale contro una snapshot locale più vecchia', () => {
    const base: any = {
      version: 2,
      updatedAt: iso(0),
      candidates: { shared: { key: 'shared', status: 'traced', sources: ['seco'] } },
      rejectedTombstones: {},
    };
    const upstream = structuredClone(base);
    upstream.candidates.shared.status = 'rejected';
    upstream.candidates.shared.reason = 'nessun annuncio';
    upstream.rejectedTombstones.shared = { rejectedAt: iso(1000) };
    const local = structuredClone(base);
    local.candidates.shared.status = 'production';

    const merged = mergeProspectorPath('data/prospector/candidates.json', base, upstream, local) as typeof base;
    expect(merged.candidates.shared.status).toBe('rejected');
    expect(merged.rejectedTombstones.shared.rejectedAt).toBe(iso(1000));
  });

  it('fonde registry e conteggi senza sommare due volte le stesse osservazioni', () => {
    const base = {
      version: 1,
      updatedAt: iso(0),
      platforms: {
        vendor: {
          domain: 'vendor.example',
          status: 'candidate',
          seenOn: ['one.example'],
          markers: ['one'],
          hostSamples: ['one.vendor.example'],
          hostHits: { 'one.vendor.example': 1 },
          hostEmployers: { 'one.vendor.example': ['one.example'] },
          hostEmployerUnknown: { 'base.vendor.example': true },
          pathHits: {},
          listingPaths: [],
          tenantCount: 1,
          discoveredAt: iso(-1000),
          expansionRetryHosts: [{ host: 'base.vendor.example', attempts: 1 }],
        },
      },
    };
    const upstream = structuredClone(base);
    upstream.platforms.vendor.status = 'confirmed';
    upstream.platforms.vendor.seenOn.push('two.example');
    upstream.platforms.vendor.hostHits['one.vendor.example'] = 2;
    upstream.platforms.vendor.hostHits['two.vendor.example'] = 2;
    upstream.platforms.vendor.hostEmployers['one.vendor.example'].push('two.example');
    upstream.platforms.vendor.hostEmployers['two.vendor.example'] = ['two.example'];
    upstream.platforms.vendor.hostEmployerUnknown['upstream.vendor.example'] = true;
    upstream.platforms.vendor.tenantCount = 2;
    upstream.platforms.vendor.lastExpandedAt = iso(1000);
    upstream.platforms.vendor.expansionRetryHosts = [{ host: 'upstream.vendor.example', attempts: 1 }];
    const local = structuredClone(base);
    local.platforms.vendor.status = 'supported';
    local.platforms.vendor.seenOn.push('three.example');
    local.platforms.vendor.hostHits['one.vendor.example'] = 3;
    local.platforms.vendor.hostEmployers['one.vendor.example'].push('three.example');
    local.platforms.vendor.hostEmployerUnknown['local.vendor.example'] = true;
    local.platforms.vendor.tenantCount = 3;
    local.platforms.vendor.lastExpandedAt = iso(2000);
    local.platforms.vendor.expansionRetryHosts = [{ host: 'local.vendor.example', attempts: 2 }];

    const merged = mergeProspectorPath('data/prospector/platforms.json', base, upstream, local) as typeof base;
    expect(merged.platforms.vendor.status).toBe('supported');
    expect(merged.platforms.vendor.seenOn).toEqual(['one.example', 'two.example', 'three.example']);
    expect(merged.platforms.vendor.hostHits).toEqual({ 'one.vendor.example': 4, 'two.vendor.example': 2 });
    expect(merged.platforms.vendor.hostEmployers).toEqual({
      'one.vendor.example': ['one.example', 'three.example', 'two.example'],
      'two.vendor.example': ['two.example'],
    });
    expect(merged.platforms.vendor.hostEmployerUnknown).toEqual({
      'base.vendor.example': true,
      'local.vendor.example': true,
      'upstream.vendor.example': true,
    });
    expect(merged.platforms.vendor.tenantCount).toBe(3);
    expect(merged.platforms.vendor.expansionRetryHosts).toEqual([
      { host: 'local.vendor.example', attempts: 2 },
      { host: 'upstream.vendor.example', attempts: 1 },
    ]);
  });

  it('preserves concurrent retry additions and applies a confirmed removal of an unchanged base retry', () => {
    const base = {
      version: 1,
      updatedAt: iso(0),
      platforms: {
        vendor: {
          domain: 'vendor.example',
          status: 'candidate',
          seenOn: [],
          markers: [],
          hostSamples: [],
          hostHits: {},
          pathHits: {},
          listingPaths: [],
          tenantCount: 0,
          lastExpandedAt: iso(0),
          expansionRetryHosts: [
            { host: 'resolved.vendor.example', attempts: 1 },
            { host: 'still-pending.vendor.example', attempts: 1 },
          ],
        },
      },
    };
    const upstream = structuredClone(base);
    upstream.platforms.vendor.expansionRetryHosts = [
      { host: 'still-pending.vendor.example', attempts: 2 },
      { host: 'upstream-new.vendor.example', attempts: 1 },
    ];
    upstream.platforms.vendor.lastExpandedAt = iso(1000);
    const local = structuredClone(base);
    local.platforms.vendor.expansionRetryHosts = [
      { host: 'local-new.vendor.example', attempts: 1 },
    ];
    local.platforms.vendor.lastExpandedAt = iso(2000);

    const merged = mergeProspectorPath('data/prospector/platforms.json', base, upstream, local) as typeof base;

    expect(merged.platforms.vendor.expansionRetryHosts).toEqual([
      { host: 'local-new.vendor.example', attempts: 1 },
      { host: 'still-pending.vendor.example', attempts: 2 },
      { host: 'upstream-new.vendor.example', attempts: 1 },
    ]);
  });

  it('keeps the expansion offset from the run whose timestamp wins the registry merge', () => {
    const base = { platforms: { vendor: { expansionProbeOffset: 0, lastExpandedAt: iso(0) } } };
    const upstream = { platforms: { vendor: { expansionProbeOffset: 11, lastExpandedAt: iso(2000) } } };
    const local = { platforms: { vendor: { expansionProbeOffset: 22, lastExpandedAt: iso(1000) } } };

    const merged = mergeProspectorPath('data/prospector/platforms.json', base, upstream, local) as typeof base;

    expect(merged.platforms.vendor.expansionProbeOffset).toBe(11);
    expect(merged.platforms.vendor.lastExpandedAt).toBe(iso(2000));
  });

  it('keeps the newest run’s unprobed retry queue ahead of older branch additions at capacity', () => {
    const baseRetries = Array.from({ length: 300 }, (_, index) => ({
      host: `pending-${index}.vendor.example`, attempts: 1,
    }));
    const base = { platforms: { vendor: { expansionRetryHosts: baseRetries, lastExpandedAt: iso(0) } } };
    const upstream = {
      platforms: {
        vendor: {
          expansionRetryHosts: [...baseRetries, ...Array.from({ length: 150 }, (_, index) => ({
            host: `upstream-${index}.vendor.example`, attempts: 1,
          }))],
          lastExpandedAt: iso(1000),
        },
      },
    };
    const local = {
      platforms: {
        vendor: {
          expansionRetryHosts: [...baseRetries, ...Array.from({ length: 150 }, (_, index) => ({
            host: `local-${index}.vendor.example`, attempts: 1,
          }))],
          lastExpandedAt: iso(2000),
        },
      },
    };

    const merged = mergeProspectorPath('data/prospector/platforms.json', base, upstream, local) as typeof base;
    const mergedHosts = merged.platforms.vendor.expansionRetryHosts.map(({ host }) => host);

    expect(mergedHosts).toHaveLength(500);
    expect(mergedHosts.slice(0, 300)).toEqual(baseRetries.map(({ host }) => host));
    expect(mergedHosts.slice(300, 450)).toEqual(Array.from({ length: 150 }, (_, index) => `local-${index}.vendor.example`));
    expect(mergedHosts.slice(450)).toEqual(Array.from({ length: 50 }, (_, index) => `upstream-${index}.vendor.example`));
  });

  it('unisce report per azienda, ricalcola tally e annunci coperti', () => {
    const base = {
      generatedAt: iso(0),
      tally: { good: 0, weak: 1, bad: 0, insufficient: 0 },
      promotedVacancies: 0,
      reports: [{ companyKey: 'base', verdict: 'weak', vacancyCount: 1 }],
    };
    const upstream = {
      ...structuredClone(base),
      generatedAt: iso(1000),
      reports: [
        { companyKey: 'base', verdict: 'good', vacancyCount: 2 },
        { companyKey: 'remote', verdict: 'good', vacancyCount: 4 },
      ],
    };
    const local = {
      ...structuredClone(base),
      generatedAt: iso(2000),
      reports: [
        { companyKey: 'base', verdict: 'weak', vacancyCount: 3 },
        { companyKey: 'local', verdict: 'bad', vacancyCount: 5 },
      ],
    };

    const merged = mergeProspectorPath('data/prospector/validation.json', base, upstream, local) as typeof base;
    expect(merged.reports.map((report) => report.companyKey)).toEqual(['base', 'local', 'remote']);
    expect(merged.tally).toEqual({ good: 1, weak: 1, bad: 1, insufficient: 0 });
    expect(merged.promotedVacancies).toBe(4);
    expect(merged.generatedAt).toBe(local.generatedAt);
  });

  it('conserva per crawler lo stato retry più recente tra run concorrenti', () => {
    const entry = (at: string, retryAfterAt: string | null) => ({
      at,
      qualityContractVersion: 3,
      sourceAdapterVersion: null,
      verdict: 'weak',
      runtimeSnapshotComplete: false,
      retryAfterAt,
    });
    const base: any = {
      generatedAt: iso(0),
      validationSchedule: { shared: entry(iso(0), iso(24 * 60 * 60 * 1000)) },
      reports: [],
    };
    const upstream = structuredClone(base);
    upstream.validationSchedule.shared = entry(iso(3000), iso(3000 + 24 * 60 * 60 * 1000));
    upstream.validationSchedule.upstreamOnly = entry(iso(3000), iso(3000 + 24 * 60 * 60 * 1000));
    const local = structuredClone(base);
    local.validationSchedule.shared = entry(iso(2000), iso(2000 + 24 * 60 * 60 * 1000));
    local.validationSchedule.localOnly = entry(iso(2000), iso(2000 + 24 * 60 * 60 * 1000));

    const merged = mergeProspectorPath('data/prospector/validation.json', base, upstream, local) as typeof base;
    expect(merged.validationSchedule.shared.at).toBe(iso(3000));
    expect(merged.validationSchedule.upstreamOnly.at).toBe(iso(3000));
    expect(merged.validationSchedule.localOnly.at).toBe(iso(2000));
  });

  it('unisce la storia Common Crawl e mantiene solo la finestra prevista', () => {
    const entry = (index: number) => ({ at: iso(index * 1000), collection: 'cc', totalPages: 1, pagesRead: index, employers: index, outage: false });
    const base = Array.from({ length: 60 }, (_, index) => entry(index));
    const upstream = [...base.slice(1), entry(60)];
    const local = [...base.slice(1), entry(61)];
    const merged = mergeProspectorPath('data/prospector/web-channel-health.json', base, upstream, local) as typeof base;
    expect(merged).toHaveLength(60);
    expect(merged.at(-1)?.pagesRead).toBe(61);
    expect(merged.some((sample) => sample.pagesRead === 60)).toBe(true);
    expect(merged.some((sample) => sample.pagesRead === 0)).toBe(false);
  });

  it('mantiene il cursore SECO più recente per canton nei push concorrenti', () => {
    const base: any = {
      version: 1,
      updatedAt: iso(0),
      cantons: { TI: { nextPage: 2, onlineSinceDays: 30, updatedAt: iso(0) } },
    };
    const upstream = structuredClone(base);
    upstream.cantons.TI = { nextPage: 7, onlineSinceDays: 30, updatedAt: iso(1000) };
    upstream.cantons.ZH = { nextPage: 4, onlineSinceDays: 30, updatedAt: iso(900) };
    const local = structuredClone(base);
    local.cantons.TI = { nextPage: 5, onlineSinceDays: 30, updatedAt: iso(2000) };

    const merged = mergeProspectorPath('data/prospector/seco-page-cursors.json', base, upstream, local) as typeof base;
    expect(merged.cantons).toEqual({ TI: local.cantons.TI, ZH: upstream.cantons.ZH });
    expect(merged.updatedAt).toBe(local.updatedAt);
  });

  it('non accetta un path conflitto inatteso', () => {
    expect(() => mergeProspectorPath('data/prospector/unknown.json', {}, {}, {})).toThrow(/unsupported Prospector conflict/);
  });

  it('il workflow passa il resolver al retry di push', () => {
    const workflow = readFileSync(new URL('../.github/workflows/prospector-loop.yml', import.meta.url), 'utf8');
    expect(workflow).toContain("--in-place-resolver-cmd 'node scripts/lib/resolve-prospector-conflicts.mjs && git add -A'");
  });

  it('risolve un rebase reale con conflitto queue + crawler add/add', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'prospector-rebase-'));
    const resolver = fileURLToPath(new URL('../scripts/lib/resolve-prospector-conflicts.mjs', import.meta.url));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
    const writeJson = (file: string, value: unknown) => {
      const target = path.join(dir, file);
      const parent = path.dirname(target);
      mkdirSync(parent, { recursive: true });
      writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
    };
    const candidates = (extra: Record<string, unknown>) => ({
      version: 2,
      updatedAt: iso(0),
      candidates: {
        base: { key: 'base', status: 'new', sources: ['seco'], updatedAt: iso(0) },
        ...extra,
      },
      rejectedTombstones: {},
    });
    const crawler = (seedUrl: string) => ({
      companyKey: 'shared-crawler',
      companyName: 'Shared crawler',
      companyHost: 'shared.example',
      mode: 'template',
      seedUrls: [seedUrl],
      detailTemplate: seedUrl.includes('upstream') ? '/upstream/*' : '/local/*',
    });

    try {
      git('init', '-b', 'main');
      git('config', 'user.email', 'test@example.invalid');
      git('config', 'user.name', 'test');
      writeJson('data/prospector/candidates.json', candidates({}));
      git('add', '.');
      git('commit', '-m', 'base');

      git('checkout', '-b', 'upstream');
      writeJson('data/prospector/candidates.json', candidates({ remote: { key: 'remote', status: 'new', sources: ['osm'] } }));
      writeJson('data/prospector/crawlers/shared-crawler.json', crawler('https://upstream.example/jobs'));
      git('add', '.');
      git('commit', '-m', 'upstream prospector run');

      git('checkout', '-b', 'local', 'main');
      writeJson('data/prospector/candidates.json', candidates({ local: { key: 'local', status: 'synthesized', sources: ['own'] } }));
      writeJson('data/prospector/crawlers/shared-crawler.json', crawler('https://local.example/jobs'));
      git('add', '.');
      git('commit', '-m', 'local prospector run');

      expect(() => git('rebase', 'upstream')).toThrow();
      execFileSync(process.execPath, [resolver], { cwd: dir, encoding: 'utf8' });
      execFileSync('git', ['rebase', '--continue'], { cwd: dir, env: { ...process.env, GIT_EDITOR: ':' }, encoding: 'utf8' });

      const mergedCandidates = JSON.parse(readFileSync(path.join(dir, 'data/prospector/candidates.json'), 'utf8'));
      expect(Object.keys(mergedCandidates.candidates)).toEqual(['base', 'local', 'remote']);
      expect(JSON.parse(readFileSync(path.join(dir, 'data/prospector/crawlers/shared-crawler.json'), 'utf8')).seedUrls)
        .toEqual(['https://upstream.example/jobs', 'https://local.example/jobs']);
      expect(JSON.parse(readFileSync(path.join(dir, 'data/prospector/crawlers/shared-crawler.json'), 'utf8')).detailTemplate)
        .toEqual(['/upstream/*', '/local/*']);
      expect(git('diff', '--name-only')).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('la scelta three-way applica la cancellazione del solo lato modificato', () => {
    const merged = mergeThreeWay({ present: true }, { present: true }, { present: false }, (upstream, local) => ({ ...upstream, ...local }));
    expect(merged).toEqual({ present: false });
  });
});
