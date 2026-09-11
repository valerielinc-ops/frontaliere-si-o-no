import { describe, expect, it } from 'vitest';

import {
  buildPublicTrafficDocument,
  encodeFirestoreValue,
  PUBLIC_TRAFFIC_FIELDS,
} from '../functions/src/publicTrafficCurrent.js';

describe('public traffic read model', () => {
  it('serializes the supported Firestore scalar and timestamp values', () => {
    const timestamp = { toDate: () => new Date('2026-09-11T08:00:00.000Z') };

    expect(encodeFirestoreValue('green')).toEqual({ stringValue: 'green' });
    expect(encodeFirestoreValue(7)).toEqual({ integerValue: '7' });
    expect(encodeFirestoreValue(7.5)).toEqual({ doubleValue: 7.5 });
    expect(encodeFirestoreValue(true)).toEqual({ booleanValue: true });
    expect(encodeFirestoreValue(timestamp)).toEqual({ timestampValue: '2026-09-11T08:00:00.000Z' });
    expect(encodeFirestoreValue({ private: 'object' })).toBeNull();
  });

  it('returns only the public traffic allowlist', () => {
    const document = buildPublicTrafficDocument({
      id: 'chiasso-brogeda',
      data: () => ({
        crossingName: 'Chiasso-Brogeda',
        waitTimeMinutes: 8,
        status: 'yellow',
        lastUpdate: new Date('2026-09-11T08:00:00.000Z'),
        privateSecret: 'must not be serialized',
      }),
    });

    expect(document.name).toBe('chiasso-brogeda');
    expect(Object.keys(document.fields).sort()).toEqual(
      ['crossingName', 'lastUpdate', 'status', 'waitTimeMinutes'].sort(),
    );
    expect(PUBLIC_TRAFFIC_FIELDS).not.toContain('privateSecret');
  });
});
