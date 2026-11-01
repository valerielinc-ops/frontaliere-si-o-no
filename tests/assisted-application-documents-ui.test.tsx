import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import translations from '../services/locales/it-core';
import type { ReviewDocument } from '../services/assistedApplicationReviewService';

vi.mock('@/services/i18n', () => ({ useTranslation: () => ({ t: (key: string) => translations[key] || key }) }));

import { AssistedApplicationDocuments } from '../components/community/AssistedApplicationDocuments';

afterEach(cleanup);

describe('requested document verification status', () => {
  it('shows an unknown readable file neutrally instead of a mismatch warning', () => {
    const document: ReviewDocument = {
      id: 'degree', label: 'degree certificates', kind: 'diploma', keywords: [], required: true, quote: '',
      files: [{
        id: 'degree.pdf', name: 'degree.pdf', size: 128, detectedType: 'pdf', uploadedAt: 1,
        clientCheck: { verdict: 'unknown', matched: '', version: 5 },
      }],
    };

    render(<AssistedApplicationDocuments
      documents={[document]}
      limits={{ maxBytes: 1024, maxFiles: 5 }}
      disabled={false}
      onUpload={vi.fn(async () => true)}
      onRemove={vi.fn(async () => true)}
    />);

    const status = screen.getByRole('status');
    expect(status).toHaveTextContent(translations['jobBoard.assisted.review.documents.check.unknown']);
    expect(status).toHaveClass('text-subtle');
    expect(status).not.toHaveClass('text-warning');
  });
});
