import { describe, expect, it } from 'vitest';
import { mergeRequiredDocuments, requiredDocumentsOf } from '../functions/src/assistedApplicationExtraDocuments.js';
import { portalRequiredDocumentFromField } from '../scripts/assisted-application/lib/portal/portal.mjs';

describe('live portal photo requirements', () => {
  it('preserves the field accept list through shared requirement merging', () => {
    const photo = portalRequiredDocumentFromField({
      id: 'profile_photo', kind: 'file', required: true, label: 'Foto*', accept: 'image/jpeg,.jpg,.png',
      maxFileSizeBytes: 1_048_576,
    });
    expect(photo).toMatchObject({ kind: 'photo', accept: 'image/jpeg,.jpg,.png', maxBytes: 1_048_576 });
    expect(requiredDocumentsOf({ requiredDocuments: [photo] })).toMatchObject([
      { kind: 'photo', accept: 'image/jpeg,.jpg,.png', maxBytes: 1_048_576 },
    ]);
    expect(mergeRequiredDocuments([{ id: 'posting_photo', label: 'Foto' }], [photo])).toMatchObject([
      { kind: 'photo', accept: 'image/jpeg,.jpg,.png', maxBytes: 1_048_576 },
    ]);
  });
});
