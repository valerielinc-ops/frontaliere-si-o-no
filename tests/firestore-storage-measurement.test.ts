import { describe, expect, it } from 'vitest';
import {
  firestoreDocumentNameSize,
  firestoreDocumentSize,
  firestoreIndexSize,
  firestoreValueSize,
} from '../scripts/measure-firestore-storage.mjs';

describe('Firestore storage estimate', () => {
  it('uses documented UTF-8 field and document size rules', () => {
    const document = {
      name: 'projects/example/databases/(default)/documents/cities/LA',
      fields: {
        type: { stringValue: 'TI' },
        done: { booleanValue: false },
      },
    };

    expect(firestoreDocumentNameSize('cities/LA')).toBe(26);
    expect(firestoreDocumentSize(document)).toBe(26 + 5 + 3 + 5 + 1 + 32);
    expect(firestoreValueSize({ stringValue: 'è' })).toBe(3);
  });

  it('includes the Firestore array container overhead', () => {
    expect(firestoreValueSize({ arrayValue: { values: [] } })).toBe(32);
  });

  it('includes parent document names in collection-scope single-field entries', () => {
    const document = {
      name: 'projects/example/databases/(default)/documents/users/jeff/tasks/my_task_id',
      fields: { done: { booleanValue: false } },
    };

    expect(firestoreIndexSize(document, 'tasks', { indexes: [], fieldOverrides: [] })).toBe(2 * 109);
  });

  it('counts whole-map and whole-array indexes as well as nested and array-contains entries', () => {
    const document = {
      name: 'projects/example/databases/(default)/documents/cities/LA',
      fields: {
        tags: { arrayValue: { values: [{ stringValue: 'a' }, { stringValue: 'b' }] } },
        metadata: { mapValue: { fields: { name: { stringValue: 'a' } } } },
      },
    };

    expect(firestoreIndexSize(document, 'cities', { indexes: [], fieldOverrides: [] })).toBe(330 + 362);
  });

  it('applies single-field exemptions and configured collection-group composites', () => {
    const document = {
      name: 'projects/example/databases/(default)/documents/users/jeff/events/event1',
      fields: {
        timestamp: { timestampValue: '2026-11-08T00:00:00Z' },
        rawEvent: { mapValue: { fields: { body: { stringValue: 'large payload' } } } },
      },
    };
    const config = {
      fieldOverrides: [{ collectionGroup: 'events', fieldPath: 'rawEvent', indexes: [] }],
      indexes: [{
        collectionGroup: 'events',
        queryScope: 'COLLECTION_GROUP',
        fields: [
          { fieldPath: 'timestamp', order: 'DESCENDING' },
          { fieldPath: 'rawEvent.body', order: 'ASCENDING' },
        ],
      }],
    };

    const withoutOverride = firestoreIndexSize(document, 'events', { indexes: config.indexes, fieldOverrides: [] });
    const withOverride = firestoreIndexSize(document, 'events', config);
    expect(withOverride).toBeLessThan(withoutOverride);
    expect(withOverride).toBeGreaterThan(0);
  });
});
