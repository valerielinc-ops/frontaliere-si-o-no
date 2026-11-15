import { describe, expect, it, vi } from 'vitest';
import { createMemoryFirestore } from './helpers/memoryFirestore';
import { syntheticImagePdf, syntheticJpeg } from './helpers/syntheticImagePdf.mjs';

vi.mock('../functions/src/remoteConfigSecrets.js', () => ({ getRemoteConfigValue: vi.fn(async () => '') }));
vi.mock('../functions/src/assistedApplicationPostalPacket.js', () => ({
  postalPacketReadiness: vi.fn(() => ({ ready: true })),
}));

const { applyAutomationEvent } = await import('../functions/src/assistedApplicationAutomation.js');

const NOW = Date.UTC(2026, 10, 13, 8, 0, 0);
const ORDER_ID = 'order_photo_fixture';
const ORDER_PATH = `assisted_applications/${ORDER_ID}`;
const CV_KEY = `assisted-application-uploads/${ORDER_ID}/cv-fixture.pdf`;
const PHOTO_DOCUMENT_ID = 'portal_document_f1_fixture';

function photoBucket(cvPdf: Buffer, {
  failDownloads = 0,
  onDownload,
}: { failDownloads?: number; onDownload?: (key: string) => void | Promise<void> } = {}) {
  const objects = new Map<string, Buffer>([[CV_KEY, cvPdf]]);
  const writes: Array<{ key: string; bytes: Buffer; options: any }> = [];
  const stats = { downloads: 0 };
  let remainingFailures = failDownloads;
  return {
    writes,
    stats,
    file(key: string) {
      return {
        async download() {
          stats.downloads += 1;
          if (key === CV_KEY && remainingFailures > 0) {
            remainingFailures -= 1;
            throw new Error('synthetic_storage_unavailable');
          }
          if (key === CV_KEY) await onDownload?.(key);
          const bytes = objects.get(key);
          if (!bytes) throw Object.assign(new Error('not found'), { code: 404 });
          return [bytes];
        },
        async exists() { return [objects.has(key)]; },
        async save(bytes: Buffer, options: any) {
          objects.set(key, Buffer.from(bytes));
          writes.push({ key, bytes: Buffer.from(bytes), options });
        },
      };
    },
  };
}

describe('assisted application photo recovery', () => {
  it('attaches a CV portrait to the private order folder and resumes a held submit once', async () => {
    const portrait = await syntheticJpeg(564, 581);
    const bucket = photoBucket(syntheticImagePdf([[portrait]]));
    const store = createMemoryFirestore({
      [ORDER_PATH]: {
        orderId: ORDER_ID,
        paymentStatus: 'paid',
        consentVersion: 'assisted-application-v3',
        consentedAt: NOW - 1000,
        cvStorageKey: CV_KEY,
        cvFileCheck: { key: CV_KEY, verdict: 'ok', detectedType: 'pdf' },
      },
      [`${ORDER_PATH}/automation/flow`]: {
        state: 'needs_candidate_action', round: 1, shownRounds: [1], heldBy: [`document:${PHOTO_DOCUMENT_ID}`],
        heldSince: NOW - 1000, heldNudges: 0, reminderAt: NOW + 24 * 60 * 60 * 1000,
        dispatch: { mode: 'submit', round: 1, attempts: 1 }, documents: {},
      },
      [`${ORDER_PATH}/ai_drafts/current`]: {
        status: 'ready', round: 1, verdict: 'good', job: { source: 'job_detail' },
        channel: { type: 'lever' }, factCheck: { ok: true, unsupported: [] }, questions: [],
        requiredDocuments: [{ id: PHOTO_DOCUMENT_ID, label: 'Foto', kind: 'other', keywords: ['Foto'], required: true }],
      },
    });
    const effects: any[] = [];
    const runEffect = vi.fn(async ({ effect }: any) => { effects.push(effect); return { ok: true }; });

    const resumed = await applyAutomationEvent({
      db: store.db,
      orderId: ORDER_ID,
      event: { type: 'tick' },
      actor: 'clock',
      runEffect,
      nowMs: NOW,
      photoBucket: bucket,
    });

    const savedFlow = store.read(`${ORDER_PATH}/automation/flow`);
    expect(resumed).toMatchObject({ ok: true, flow: { state: 'submitting', round: 1, heldBy: [] } });
    expect(resumed.effects).toEqual([{ type: 'dispatch', mode: 'submit', reason: 'resolved_candidate_requirements' }]);
    expect(effects.some(effect => effect.type === 'email')).toBe(false);
    expect(savedFlow).toMatchObject({
      documents: { [PHOTO_DOCUMENT_ID]: { files: [{ detectedType: 'jpg', name: 'photo.jpg' }] } },
      photoRecovery: { version: 1, documentId: PHOTO_DOCUMENT_ID, result: 'portrait' },
    });
    expect(bucket.writes).toHaveLength(1);
    expect(bucket.writes[0].key).toMatch(new RegExp(`^assisted-application-uploads/${ORDER_ID}/doc-${PHOTO_DOCUMENT_ID}-0-[a-f0-9]{8}\\.jpg$`));
    expect(bucket.writes[0].options).toMatchObject({
      contentType: 'image/jpeg',
      resumable: false,
      metadata: { cacheControl: 'private, no-store' },
    });

    await applyAutomationEvent({ db: store.db, orderId: ORDER_ID, event: { type: 'tick' }, runEffect, nowMs: NOW + 1, photoBucket: bucket });
    expect(effects).toEqual([{ type: 'dispatch', mode: 'submit', reason: 'resolved_candidate_requirements' }]);
    expect(bucket.writes).toHaveLength(1);
  });

  it('keeps the hold when the order CV changes while the portrait is being extracted', async () => {
    const portrait = await syntheticJpeg(564, 581);
    const store = createMemoryFirestore({
      [ORDER_PATH]: {
        orderId: ORDER_ID,
        paymentStatus: 'paid',
        consentVersion: 'assisted-application-v3',
        consentedAt: NOW - 1000,
        cvStorageKey: CV_KEY,
        cvFileCheck: { key: CV_KEY, verdict: 'ok', detectedType: 'pdf' },
      },
      [`${ORDER_PATH}/automation/flow`]: {
        state: 'needs_candidate_action', round: 1, shownRounds: [1], heldBy: [`document:${PHOTO_DOCUMENT_ID}`],
        heldSince: NOW - 1000, heldNudges: 0, reminderAt: NOW + 24 * 60 * 60 * 1000,
        dispatch: { mode: 'submit', round: 1, attempts: 1 }, documents: {},
      },
      [`${ORDER_PATH}/ai_drafts/current`]: {
        status: 'ready', round: 1, verdict: 'good', job: { source: 'job_detail' },
        channel: { type: 'lever' }, factCheck: { ok: true, unsupported: [] }, questions: [],
        requiredDocuments: [{ id: PHOTO_DOCUMENT_ID, label: 'Foto', kind: 'other', keywords: ['Foto'], required: true }],
      },
    });
    const replacementCvKey = `assisted-application-uploads/${ORDER_ID}/replacement-cv-fixture.pdf`;
    const bucket = photoBucket(syntheticImagePdf([[portrait]]), {
      onDownload: async () => store.db.collection('assisted_applications').doc(ORDER_ID)
        .set({
          cvStorageKey: replacementCvKey,
          cvFileCheck: { key: replacementCvKey, verdict: 'ok', detectedType: 'pdf' },
        }, { merge: true }),
    });
    const effects: any[] = [];
    const runEffect = vi.fn(async ({ effect }: any) => { effects.push(effect); return { ok: true }; });

    const result = await applyAutomationEvent({
      db: store.db, orderId: ORDER_ID, event: { type: 'tick' }, actor: 'clock', runEffect, nowMs: NOW, photoBucket: bucket,
    });

    expect(result).toMatchObject({ ok: false, state: 'needs_candidate_action' });
    expect(store.read(`${ORDER_PATH}/automation/flow`)).toMatchObject({
      state: 'needs_candidate_action', heldBy: [`document:${PHOTO_DOCUMENT_ID}`],
    });
    expect(store.read(`${ORDER_PATH}/automation/flow`).documents[PHOTO_DOCUMENT_ID]).toBeUndefined();
    expect(effects).toEqual([]);
  });

  it('uses a candidate photo uploaded during extraction without adding a second portrait', async () => {
    const portrait = await syntheticJpeg(564, 581);
    const candidatePhoto = {
      key: `assisted-application-uploads/${ORDER_ID}/doc-${PHOTO_DOCUMENT_ID}-0-abcd1234.jpg`,
      name: 'candidate-photo.jpg', size: 1200, detectedType: 'jpg', uploadedAt: NOW,
    };
    const store = createMemoryFirestore({
      [ORDER_PATH]: {
        orderId: ORDER_ID,
        paymentStatus: 'paid',
        consentVersion: 'assisted-application-v3',
        consentedAt: NOW - 1000,
        cvStorageKey: CV_KEY,
        cvFileCheck: { key: CV_KEY, verdict: 'ok', detectedType: 'pdf' },
      },
      [`${ORDER_PATH}/automation/flow`]: {
        state: 'needs_candidate_action', round: 1, shownRounds: [1], heldBy: [`document:${PHOTO_DOCUMENT_ID}`],
        heldSince: NOW - 1000, heldNudges: 0, reminderAt: NOW + 24 * 60 * 60 * 1000,
        dispatch: { mode: 'submit', round: 1, attempts: 1 }, documents: {},
      },
      [`${ORDER_PATH}/ai_drafts/current`]: {
        status: 'ready', round: 1, verdict: 'good', job: { source: 'job_detail' },
        channel: { type: 'lever' }, factCheck: { ok: true, unsupported: [] }, questions: [],
        requiredDocuments: [{ id: PHOTO_DOCUMENT_ID, label: 'Foto', kind: 'other', keywords: ['Foto'], required: true }],
      },
    });
    const bucket = photoBucket(syntheticImagePdf([[portrait]]), {
      onDownload: async () => store.db.collection('assisted_applications').doc(ORDER_ID).collection('automation').doc('flow')
        .set({ documents: { [PHOTO_DOCUMENT_ID]: { files: [candidatePhoto] } } }, { merge: true }),
    });
    const effects: any[] = [];
    const runEffect = vi.fn(async ({ effect }: any) => { effects.push(effect); return { ok: true }; });

    const result = await applyAutomationEvent({
      db: store.db, orderId: ORDER_ID, event: { type: 'tick' }, actor: 'clock', runEffect, nowMs: NOW, photoBucket: bucket,
    });

    expect(result).toMatchObject({ ok: true, flow: { state: 'submitting', heldBy: [] } });
    expect(store.read(`${ORDER_PATH}/automation/flow`).documents[PHOTO_DOCUMENT_ID].files).toEqual([candidatePhoto]);
    expect(store.read(`${ORDER_PATH}/automation/flow`).photoRecovery).toMatchObject({ result: 'candidate_photo' });
    expect(result.effects).toEqual([{ type: 'dispatch', mode: 'submit', reason: 'resolved_candidate_requirements' }]);
    expect(effects).toEqual(result.effects);
  });

  it('uses an acceptable candidate photo already stored for the tailored CV before reading the CV', async () => {
    const bucket = photoBucket(Buffer.from('unused synthetic CV'));
    const store = createMemoryFirestore({
      [ORDER_PATH]: {
        orderId: ORDER_ID,
        paymentStatus: 'paid',
        consentVersion: 'assisted-application-v3',
        consentedAt: NOW - 1000,
        cvStorageKey: CV_KEY,
      },
      [`${ORDER_PATH}/automation/flow`]: {
        state: 'needs_candidate_action', round: 1, shownRounds: [1], heldBy: [`document:${PHOTO_DOCUMENT_ID}`],
        heldSince: NOW - 1000, dispatch: { mode: 'submit', round: 1, attempts: 1 }, documents: {},
        photo: { key: `assisted-application-uploads/${ORDER_ID}/photo-1234-abcd.jpg`, detectedType: 'jpg', size: 1200, uploadedAt: NOW - 2000 },
      },
      [`${ORDER_PATH}/ai_drafts/current`]: {
        status: 'ready', round: 1, verdict: 'good', job: { source: 'job_detail' },
        channel: { type: 'lever' }, factCheck: { ok: true, unsupported: [] }, questions: [],
        requiredDocuments: [{ id: PHOTO_DOCUMENT_ID, label: 'Foto', kind: 'other', keywords: ['Foto'], required: true, accept: 'image/jpeg' }],
      },
    });
    const effects: any[] = [];
    const runEffect = vi.fn(async ({ effect }: any) => { effects.push(effect); return { ok: true }; });

    const resumed = await applyAutomationEvent({
      db: store.db,
      orderId: ORDER_ID,
      event: { type: 'tick' },
      actor: 'clock',
      runEffect,
      nowMs: NOW,
      photoBucket: bucket,
    });

    expect(resumed).toMatchObject({ ok: true, flow: { state: 'submitting', round: 1, heldBy: [] } });
    expect(resumed.effects).toEqual([{ type: 'dispatch', mode: 'submit', reason: 'resolved_candidate_requirements' }]);
    expect(effects.some(effect => effect.type === 'email')).toBe(false);
    expect(store.read(`${ORDER_PATH}/automation/flow`)).toMatchObject({
      photoRecovery: { version: 1, documentId: PHOTO_DOCUMENT_ID, result: 'candidate_photo' },
    });
    expect(bucket.writes).toHaveLength(0);
  });

  it('retries transient Storage failures after backoff and caps automatic attempts', async () => {
    const portrait = await syntheticJpeg(564, 581);
    const bucket = photoBucket(syntheticImagePdf([[portrait]]), { failDownloads: 3 });
    const store = createMemoryFirestore({
      [ORDER_PATH]: {
        orderId: ORDER_ID,
        paymentStatus: 'paid',
        consentVersion: 'assisted-application-v3',
        consentedAt: NOW - 1000,
        cvStorageKey: CV_KEY,
        cvFileCheck: { key: CV_KEY, verdict: 'ok', detectedType: 'pdf' },
      },
      [`${ORDER_PATH}/automation/flow`]: {
        state: 'needs_candidate_action', round: 1, shownRounds: [1], heldBy: [`document:${PHOTO_DOCUMENT_ID}`],
        heldSince: NOW - 1000, heldNudges: 0, reminderAt: NOW + 24 * 60 * 60 * 1000,
        dispatch: { mode: 'submit', round: 1, attempts: 1 }, documents: {},
      },
      [`${ORDER_PATH}/ai_drafts/current`]: {
        status: 'ready', round: 1, verdict: 'good', job: { source: 'job_detail' },
        channel: { type: 'lever' }, factCheck: { ok: true, unsupported: [] }, questions: [],
        requiredDocuments: [{ id: PHOTO_DOCUMENT_ID, label: 'Foto', kind: 'photo', keywords: ['Foto'], required: true }],
      },
    });
    const effects: any[] = [];
    const runEffect = vi.fn(async ({ effect }: any) => { effects.push(effect); return { ok: true }; });
    const tick = (nowMs: number) => applyAutomationEvent({
      db: store.db, orderId: ORDER_ID, event: { type: 'tick' }, actor: 'clock', runEffect, nowMs, photoBucket: bucket,
    });

    await tick(NOW);
    const firstFailure = store.read(`${ORDER_PATH}/automation/flow`);
    expect(firstFailure).toMatchObject({
      heldBy: [`document:${PHOTO_DOCUMENT_ID}`],
      photoRecovery: { result: 'retryable_error', attempts: 1, retryAt: NOW + 5 * 60 * 1000 },
    });
    expect(store.read(ORDER_PATH).automationDueAt).toBe(NOW + 5 * 60 * 1000);
    expect(bucket.stats.downloads).toBe(1);
    expect(effects).toEqual([]);

    await tick(NOW + 4 * 60 * 1000);
    expect(bucket.stats.downloads).toBe(1);

    await tick(NOW + 5 * 60 * 1000);
    const secondFailure = store.read(`${ORDER_PATH}/automation/flow`);
    expect(secondFailure.photoRecovery).toMatchObject({
      result: 'retryable_error', attempts: 2, retryAt: NOW + 35 * 60 * 1000,
    });
    expect(bucket.stats.downloads).toBe(2);
    expect(effects).toEqual([]);

    await tick(NOW + 35 * 60 * 1000);
    const exhausted = store.read(`${ORDER_PATH}/automation/flow`);
    expect(exhausted).toMatchObject({
      state: 'needs_candidate_action',
      heldBy: [`document:${PHOTO_DOCUMENT_ID}`],
      photoRecovery: { result: 'unavailable', attempts: 3 },
    });
    expect(exhausted.photoRecovery.retryAt).toBeNull();
    expect(bucket.stats.downloads).toBe(3);
    expect(bucket.writes).toHaveLength(0);

    await tick(NOW + 36 * 60 * 1000);
    expect(bucket.stats.downloads).toBe(3);
    expect(effects).toEqual([]);
  });
});
