import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import SavedJobsAlertNudge from '@/components/community/SavedJobsAlertNudge';
import { markPromotionalPromptShown } from '@/services/popupQueue';

describe('SavedJobsAlertNudge consent notice', () => {
  beforeEach(() => {
    markPromotionalPromptShown(0);
  });

  afterEach(() => {
    cleanup();
  });

  it('keeps the saved-jobs consent text readable', () => {
    render(
      <SavedJobsAlertNudge
        categoryLabel="Sanità"
        cantonCode="TI"
        cantonLabel="Ticino"
        userId="user-1"
        email="foo@example.com"
        locale="it"
        onClose={vi.fn()}
        onAccepted={vi.fn()}
        onAnonymousAccept={vi.fn()}
        onDismissed={vi.fn()}
        onAcceptTapped={vi.fn()}
        subscribe={vi.fn()}
        upgradeConsent={vi.fn()}
      />,
    );

    const consent = document.getElementById('saved-jobs-nudge-consent');
    expect(consent).toHaveClass('mt-2');

    const notice = consent?.querySelector('[data-consent-key="communicationsOptIn"]');
    expect(notice).toHaveClass('text-xs', 'text-muted', 'leading-relaxed');
    expect(notice).not.toHaveClass('text-[10px]', 'leading-tight');
  });
});
