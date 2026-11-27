import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryFirestore } from './helpers/memoryFirestore';

const mocks = vi.hoisted(() => ({ run: vi.fn(async () => ({ ok: true })) }));
vi.mock('@/services/assistedApplicationAdminService', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runAutomationAdminAction: mocks.run,
}));
vi.mock('@/components/admin/ui/AdminConfirmDialog', () => ({
  useAdminConfirm: () => ({ requestConfirmation: async () => true }),
}));
vi.mock('../functions/src/remoteConfigSecrets.js', () => ({
  getRemoteConfigValue: vi.fn(async () => ''),
  bridgeEmailCascadeCredentialsToEnv: vi.fn(async () => {}),
}));

const { default: AssistedApplicationAutomationPanel } = await import('../components/pages/AssistedApplicationAutomationPanel');
const { handleAutomationAdminAction } = await import('../functions/src/assistedApplicationAutomationAdmin.js');

afterEach(() => { cleanup(); mocks.run.mockClear(); });

const order: any = {
  orderId: 'order_panel_test', jobTitle: 'Ruolo di prova', companyName: 'Azienda di prova',
  paymentStatus: 'paid', submissionStatus: 'in_progress', hasCv: true,
  automation: {
    flow: { state: 'owner_takeover', round: 1, heldBy: ['portal:account_sign_in_failed'], roundSent: true, sendOutcomeUnconfirmed: true, history: [], feedback: [], answers: {} },
    // The admin view always sends the arrays the panel maps over (loadAutomationForAdmin): checksIt, questions, documents.
    draft: { round: 1, status: 'ready', channel: { type: 'portal' }, checksIt: [], requirements: [], matches: [], questions: [], requiredDocuments: [], factCheck: { ok: true, unsupported: [], advisories: [] } },
  },
};

describe('owner confirmation «not sent» (panel to admin handler)', () => {
  it('keeps the retry disabled until the owner ticks the checkbox, then sends confirmedNotSent:true', async () => {
    render(<AssistedApplicationAutomationPanel order={order} user={{ getIdToken: async () => 'token' }} onChanged={vi.fn()} />);
    const retry = screen.getByRole('button', { name: /Riprova l’invio automatico/, hidden: true }) as HTMLButtonElement;
    expect(retry.disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { hidden: true }));
    expect(retry.disabled).toBe(false);
    fireEvent.click(retry);
    await waitFor(() => expect(mocks.run).toHaveBeenCalledTimes(1));
    expect(mocks.run).toHaveBeenCalledWith(expect.anything(), 'order_panel_test', 'automationRetrySubmit', { confirmedNotSent: true });
  });

  it('shows neither the checkbox nor the flag when no send of unknown outcome stands', async () => {
    const plain = { ...order, automation: { ...order.automation, flow: { ...order.automation.flow, sendOutcomeUnconfirmed: false } } };
    render(<AssistedApplicationAutomationPanel order={plain} user={{ getIdToken: async () => 'token' }} onChanged={vi.fn()} />);
    expect(screen.queryByRole('checkbox', { hidden: true })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Riprova l’invio automatico/, hidden: true }));
    await waitFor(() => expect(mocks.run).toHaveBeenCalledWith(expect.anything(), 'order_panel_test', 'automationRetrySubmit', {}));
  });

  it('admin handler: {action:"automationRetrySubmit", confirmedNotSent:true} on owner_takeover + ambiguousSubmit gives submitting', async () => {
    const root = 'assisted_applications/order_panel_test';
    const store = createMemoryFirestore({
      [root]: { paymentStatus: 'paid', submissionStatus: 'in_progress' },
      [`${root}/automation/flow`]: { state: 'owner_takeover', round: 1, heldBy: ['portal:account_sign_in_failed'], ambiguousSubmit: { round: 1, at: 1, error: 'portal_ambiguous' }, dispatch: { mode: 'submit', round: 1, attempts: 1 }, answers: {} },
      [`${root}/ai_drafts/current`]: { round: 1, status: 'ready', questions: [] },
    });
    const runEffect = async () => ({ ok: true });
    await expect(handleAutomationAdminAction(store.db, { action: 'automationRetrySubmit', orderId: 'order_panel_test' }, 'owner@example.test', { runEffect }))
      .rejects.toBeTruthy();
    const result: any = await handleAutomationAdminAction(store.db, { action: 'automationRetrySubmit', orderId: 'order_panel_test', confirmedNotSent: true }, 'owner@example.test', { runEffect });
    expect(result).toMatchObject({ ok: true, state: 'submitting' });
    expect(store.read(`${root}/automation/flow`)).toMatchObject({ state: 'submitting', ambiguousSubmit: null });
  });
});
