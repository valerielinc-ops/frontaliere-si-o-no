import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import AssistedApplicationInbox from '@/components/pages/AssistedApplicationInbox';

afterEach(cleanup);

const item = (category: string, forwarded: string, forwardedReason: string | null) => ({
  receivedAt: 1793270000000, from: 'job@stelle.example.test', subject: 'Ihre Bewerbung', category, summaryIt: '', interviewWhen: '', forwarded, forwardedReason,
});

describe('admin inbox: why a message was kept from the candidate', () => {
  it.each([
    ['auto_acknowledgement', 'application_receipt', 'Ricevuta automatica registrata, non inoltrata'],
    ['verification', 'portal_verification', 'Verifica account gestita dall’automazione'],
    ['verification', 'portal_account_notice', 'Avviso dell’account portale gestito dall’automazione'],
    ['verification', null, 'Gestita dall’automazione, non inoltrata'],
  ])('%s kept as %s', (category, reason, label) => {
    render(<AssistedApplicationInbox automation={{ candidateAlias: null, inbox: [item(category, 'skipped', reason)] } as any} />);
    expect(screen.getByText(label)).toBeTruthy();
  });

  it('a forwarded message still says so', () => {
    render(<AssistedApplicationInbox automation={{ candidateAlias: null, inbox: [item('interview_invite', 'sent', null)] } as any} />);
    expect(screen.getByText('Inoltrata al candidato')).toBeTruthy();
  });
});
