import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import PaidAssistedApplicationsPage from '@/components/pages/PaidAssistedApplicationsPage';

vi.mock('@/services/i18n', async () => {
  const [{ default: core }, { default: vita }] = await Promise.all([
    import('@/services/locales/it-core'), import('@/services/locales/it-vita'),
  ]);
  const strings = { ...core, ...vita };
  return { getLocale: () => 'it', useTranslation: () => ({ locale: 'it', t: (key: string) => strings[key] || key }) };
});
vi.mock('@/services/logoService', () => ({ generateInitialsLogo: () => 'data:image/svg+xml,test' }));
vi.mock('@/services/jobDataNormalization', () => ({ resolveCompanyLogoUrl: () => '' }));
vi.mock('@/services/cdnImageBase', () => ({ cdnImageUrl: (value: string) => value }));

describe('paid application dossier status', () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it('renders the withdrawn order without losing the other applications in the response', async () => {
    const applications = ['withdrawn', 'in_progress'].map((status, index) => ({
      orderId: `order-${index}`, jobTitle: `Role ${index}`, companyName: 'Example company',
      source: 'concierge', status, updatedAt: null, requiresCvUpload: false,
    }));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, applications }), { status: 200 })));
    render(<PaidAssistedApplicationsPage user={{ getIdToken: async () => 'candidate-token' }} />);
    expect(await screen.findByText('Ritirata')).toBeTruthy();
    expect(screen.getByText('In lavorazione')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Role 0' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Role 1' })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
