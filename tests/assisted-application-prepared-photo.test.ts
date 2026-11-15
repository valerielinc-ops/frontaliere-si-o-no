import { describe, expect, it } from 'vitest';
import { persistPreparedPhoto } from '../scripts/assisted-application/lib/persist-prepared-photo.mjs';
import { createMemoryFirestore } from './helpers/memoryFirestore';

const ORDER_ID = 'order_photo_guard_fixture';
const ORDER_PATH = `assisted_applications/${ORDER_ID}`;
const FLOW_PATH = `${ORDER_PATH}/automation/flow`;
const SOURCE_CV_KEY = `assisted-application-uploads/${ORDER_ID}/source-cv.pdf`;
const PHOTO_DOCUMENT_ID = 'portal_photo_fixture';
const draft = {
  requiredDocuments: [{ id: PHOTO_DOCUMENT_ID, label: 'Foto', kind: 'photo', required: true }],
};
const flow = { round: 1, state: 'submitting' };
const file = {
  key: `assisted-application-uploads/${ORDER_ID}/doc-${PHOTO_DOCUMENT_ID}-0-abcd1234.jpg`,
  name: 'photo.jpg', size: 1200, detectedType: 'jpg', uploadedAt: 123,
};

describe('prepared CV portrait persistence', () => {
  it('rejects the extracted portrait when the order now points to a different CV', async () => {
    const originalFlow = { ...flow, documents: { keep: { files: [] } } };
    const store = createMemoryFirestore({
      [ORDER_PATH]: { cvStorageKey: `${SOURCE_CV_KEY}.replacement` },
      [FLOW_PATH]: originalFlow,
    });
    const orderRef = store.db.collection('assisted_applications').doc(ORDER_ID);

    const persisted = await persistPreparedPhoto({
      db: store.db, orderRef, documentId: PHOTO_DOCUMENT_ID, file, round: 1,
      sourceCvKey: SOURCE_CV_KEY, draft, flow,
    });

    expect(persisted).toBe(false);
    expect(store.read(FLOW_PATH)).toEqual(originalFlow);
  });

  it('persists a portrait when the source CV and submission round remain current', async () => {
    const store = createMemoryFirestore({
      [ORDER_PATH]: { cvStorageKey: SOURCE_CV_KEY },
      [FLOW_PATH]: flow,
    });
    const orderRef = store.db.collection('assisted_applications').doc(ORDER_ID);

    const persisted = await persistPreparedPhoto({
      db: store.db, orderRef, documentId: PHOTO_DOCUMENT_ID, file, round: 1,
      sourceCvKey: SOURCE_CV_KEY, draft, flow,
    });

    expect(persisted).toBe(true);
    expect(store.read(FLOW_PATH)).toMatchObject({
      documents: { [PHOTO_DOCUMENT_ID]: { files: [file] } },
    });
  });
});
