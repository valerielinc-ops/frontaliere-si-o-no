import { describe, expect, it } from 'vitest';

import {
  buildPublicTrafficDocument,
  encodeFirestoreValue,
  PUBLIC_TRAFFIC_MAX_DOCUMENTS,
  PUBLIC_TRAFFIC_PAGE_SIZE,
  PUBLIC_TRAFFIC_FIELDS,
  readPublicTrafficDocuments,
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

  it('paginates the full snapshot and starts each page after the last document', async () => {
    const firstPage = Array.from({ length: PUBLIC_TRAFFIC_PAGE_SIZE }, (_, index) => ({
      id: `crossing-${String(index).padStart(3, '0')}`,
    }));
    const secondPage = [{ id: 'crossing-200' }];
    const pages = [firstPage, secondPage];
    const startAfterIds: string[] = [];
    let pageIndex = 0;

    const collectionRef = {
      orderBy(fieldPath: string) {
        expect(fieldPath).toBe('__name__');
        return {
          limit(pageSize: number) {
            expect(pageSize).toBe(PUBLIC_TRAFFIC_PAGE_SIZE);
            const page = pages[pageIndex++];
            return { get: async () => ({ docs: page }) };
          },
          startAfter(document: { id: string }) {
            startAfterIds.push(document.id);
            return {
              limit(pageSize: number) {
                expect(pageSize).toBe(PUBLIC_TRAFFIC_PAGE_SIZE);
                const page = pages[pageIndex++];
                return { get: async () => ({ docs: page }) };
              },
            };
          },
        };
      },
    };

    const documents = await readPublicTrafficDocuments(collectionRef);

    expect(documents).toHaveLength(PUBLIC_TRAFFIC_PAGE_SIZE + 1);
    expect(documents.at(-1)?.id).toBe('crossing-200');
    expect(startAfterIds).toEqual(['crossing-199']);
    expect(PUBLIC_TRAFFIC_MAX_DOCUMENTS).toBeGreaterThan(PUBLIC_TRAFFIC_PAGE_SIZE);
  });
});
