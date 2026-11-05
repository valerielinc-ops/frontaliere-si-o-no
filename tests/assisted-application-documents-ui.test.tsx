import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import translations from '../services/locales/it-core';
import type { ReviewDocument } from '../services/assistedApplicationReviewService';

vi.mock('@/services/i18n', () => ({ useTranslation: () => ({ t: (key: string) => translations[key] || key }) }));

import { AssistedApplicationDocuments } from '../components/community/AssistedApplicationDocuments';

afterEach(cleanup);

describe('requested document verification status', () => {
  it('shows an unknown readable file neutrally instead of a mismatch warning', () => {
    const document: ReviewDocument = {
      id: 'degree', label: 'degree certificates', kind: 'diploma', keywords: [], required: true, quote: '',
      instructions: '', delivery: 'upload', exemptions: [], preparedAt: null, exemption: null,
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

  it('keeps local-only postal scans in the page and never uploads or checks them', async () => {
    const user = userEvent.setup();
    const document: ReviewDocument = {
      id: 'health', label: 'Health questionnaire', kind: 'other', keywords: [], required: true, quote: '',
      instructions: '', delivery: 'offline', localOnly: true, exemptions: [], preparedAt: null, exemption: null, files: [],
    };
    const onUpload = vi.fn(async () => true);
    const onLocalFilesChange = vi.fn();
    render(<AssistedApplicationDocuments
      documents={[document]}
      limits={{ maxBytes: 1024, maxFiles: 5 }}
      disabled={false}
      onUpload={onUpload}
      onRemove={vi.fn(async () => true)}
      onSetPrepared={vi.fn(async () => true)}
      onSetExemption={vi.fn(async () => true)}
      postalSubmission
      onLocalFilesChange={onLocalFilesChange}
    />);

    const scan = new File(['private health information'], 'health.pdf', { type: 'application/pdf' });
    await user.upload(screen.getByLabelText(translations['jobBoard.assisted.review.documents.selectLocal']), scan);

    expect(onUpload).not.toHaveBeenCalled();
    expect(onLocalFilesChange).toHaveBeenCalledWith(document, [scan]);
    expect(screen.getByText(translations['jobBoard.assisted.review.documents.localOnlyNote'])).toBeInTheDocument();
  });

  it('uploads paper scans without running the content checker', async () => {
    const user = userEvent.setup();
    const document: ReviewDocument = {
      id: 'study', label: 'Study certificates', kind: 'other', keywords: [], required: true, quote: '',
      instructions: '', delivery: 'offline', exemptions: [], preparedAt: null, exemption: null, files: [],
    };
    const onUpload = vi.fn(async () => true);
    render(<AssistedApplicationDocuments
      documents={[document]}
      limits={{ maxBytes: 1024, maxFiles: 5 }}
      disabled={false}
      onUpload={onUpload}
      onRemove={vi.fn(async () => true)}
      onSetPrepared={vi.fn(async () => true)}
      onSetExemption={vi.fn(async () => true)}
      postalSubmission
    />);

    const scan = new File(['scan bytes'], 'certificates.pdf', { type: 'application/pdf' });
    await user.upload(screen.getByLabelText(translations['jobBoard.assisted.review.documents.upload']), scan);

    expect(onUpload).toHaveBeenCalledWith(document, scan, expect.objectContaining({ verdict: 'unreadable', matched: '' }));
  });
});
