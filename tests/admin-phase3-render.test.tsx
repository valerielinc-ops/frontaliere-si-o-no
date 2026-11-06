import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const renderMocks = vi.hoisted(() => ({
  user: null as { getIdToken: () => Promise<string> } | null,
  loadAdminTodayRuns: vi.fn(async () => ({ runs: [], truncated: false, totalFetched: 0 })),
}));

vi.mock('@/services/authService', () => ({
  useAuth: () => ({ user: renderMocks.user, loading: false }),
}));

vi.mock('@/components/admin/AdminWorkflowProvider', () => ({
  useAdminWorkflow: () => ({
    actions: [],
    workflowStates: [],
    getWorkflowState: () => ({ status: 'idle', conclusion: null, updatedAt: null, htmlUrl: null, message: null, error: null, durationSeconds: null }),
    isRunning: () => false,
    runWorkflowWithConfirmation: vi.fn(),
  }),
}));

vi.mock('@/components/admin/lib/adminNavigation', () => ({
  adminSectionPath: (section: string) => `/admin/${section}`,
}));

vi.mock('@/services/adminCron', () => ({
  describeCronForLocalDay: () => [],
  localDateKey: () => '2026-10-23',
}));

vi.mock('@/services/adminHealth', () => ({
  loadAdminHealth: vi.fn(async () => null),
}));

vi.mock('@/services/adminTodayRuns', () => ({
  adminTodayRunsTruncationNotice: (result: { truncated: boolean; totalFetched: number }) => result.truncated ? `Esecuzioni troncate: mostrate le più recenti ${result.totalFetched}.` : null,
  failedCrawlerRunCount: () => 0,
  isCrawlerWorkflowId: () => false,
  loadAdminTodayRuns: renderMocks.loadAdminTodayRuns,
  runIsOnLocalDay: () => false,
}));

vi.mock('@/services/adminInsights', () => ({
  fetchAdminEmployerInsights: vi.fn(async () => []),
}));

vi.mock('@/services/assistedApplicationAdminService', () => ({
  fetchAssistedApplicationOrders: vi.fn(async () => []),
}));

vi.mock('@/components/admin/lib/newsletterStats', () => ({
  loadNewsletterStats: vi.fn(async () => null),
}));

vi.mock('@/components/admin/ui/AdminButton', () => ({
  AdminButton: ({ children }: { children?: ReactNode }) => <button type="button">{children}</button>,
}));

vi.mock('@/components/admin/ui/AdminSectionHeader', () => ({
  AdminSectionHeader: ({ title }: { title: string }) => <header>{title}</header>,
}));

vi.mock('@/components/admin/ui/AdminSkeleton', () => ({
  AdminSkeleton: () => <div role="status" />,
}));

vi.mock('@/components/admin/ui/AdminStatusPill', () => ({
  AdminStatusPill: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));

vi.mock('@/components/admin/ui/AdminConfirmDialog', () => ({
  useAdminConfirm: () => ({ requestConfirmation: vi.fn(async () => false) }),
}));

import OggiSection from '@/components/admin/sections/OggiSection';

describe('Oggi board layout', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('schedule unavailable'); }));
  });

  afterEach(() => {
    cleanup();
    renderMocks.user = null;
    renderMocks.loadAdminTodayRuns.mockReset();
    renderMocks.loadAdminTodayRuns.mockResolvedValue({ runs: [], truncated: false, totalFetched: 0 });
    vi.unstubAllGlobals();
  });

  it('mantiene la tabella confinata e la riga vuota su tutte le 7 colonne', async () => {
    render(<OggiSection />);

    const table = await waitFor(() => screen.getByRole('table'));
    const emptyMessage = await waitFor(() => within(table).getByText('Calendario dei workflow non disponibile: il file non è stato pubblicato.'));

    expect(table).toHaveClass('w-full', 'table-fixed');
    expect(table.parentElement).toHaveClass('min-w-0', 'overflow-x-auto');
    expect(within(table).getByRole('columnheader', { name: 'Azione' })).toBeInTheDocument();
    expect(emptyMessage).toHaveAttribute('colspan', '7');
    expect(emptyMessage).toHaveClass('whitespace-normal', 'break-words');
  });

  it('rende visibile il limite delle esecuzioni quando la paginazione è troncata', async () => {
    renderMocks.user = { getIdToken: async () => 'token' };
    renderMocks.loadAdminTodayRuns.mockResolvedValue({ runs: [], truncated: true, totalFetched: 1000 });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ generatedAt: '2026-10-23T08:00:00.000Z', timezone: 'Europe/Zurich', workflows: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })));

    render(<OggiSection />);

    expect(await screen.findByText('Esecuzioni troncate: mostrate le più recenti 1000.')).toBeInTheDocument();
  });
});
