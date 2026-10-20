// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/i18n', () => ({
  useTranslation: () => ({
    t: (key: string) => ({
      'common.close': 'Chiudi',
      'jobBoard.assisted.title': 'Vuoi delegare questa candidatura?',
      'jobBoard.assisted.paidLoading': 'Apro il pagamento…',
      'jobBoard.assisted.priceNote': 'Pagamento unico · nessun abbonamento',
    }[key] || key),
  }),
}));

vi.mock('@/services/assistedApplicationExperiment', () => ({
  ASSISTED_APPLICATION_PRICE_EUR_CENTS: 199,
}));

const firebaseMocks = vi.hoisted(() => ({
  getConfigValue: vi.fn(),
}));

vi.mock('@/services/firebase', () => firebaseMocks);

import SumUpPaymentWidget from '@/components/community/SumUpPaymentWidget';

const mount = vi.fn(() => ({ unmount: vi.fn() }));

const renderWidget = (overrides: Partial<ComponentProps<typeof SumUpPaymentWidget>> = {}) => {
  const props: ComponentProps<typeof SumUpPaymentWidget> = {
    checkoutId: 'checkout-1',
    locale: 'it',
    onResponse: vi.fn(),
    onError: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
  render(<SumUpPaymentWidget {...props} />);
  return props;
};

beforeEach(() => {
  firebaseMocks.getConfigValue.mockResolvedValue('');
  (window as unknown as { SumUpCard: { mount: typeof mount } }).SumUpCard = { mount };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  firebaseMocks.getConfigValue.mockReset();
  delete (window as unknown as { SumUpCard?: unknown }).SumUpCard;
  document.body.style.overflow = '';
});

describe('SumUpPaymentWidget', () => {
  it('shows a clear payment summary and a mobile-safe dialog shell', async () => {
    renderWidget();

    expect(screen.getByRole('dialog')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByText('Pagamento unico · nessun abbonamento')).toBeInTheDocument();
    expect(screen.getByText(/1,99/)).toBeInTheDocument();
    expect(screen.getByTestId('sumup-payment-widget-close')).toHaveAccessibleName('Chiudi');

    await act(async () => {});

    expect(screen.getByRole('dialog')).toHaveAttribute('aria-busy', 'false');
    expect(mount).toHaveBeenCalledWith(expect.objectContaining({
      checkoutId: 'checkout-1',
      amount: '1.99',
      currency: 'EUR',
    }));
  });

  it('supports a different checkout amount and title for the concierge service', async () => {
    renderWidget({
      amountCents: 3999,
      title: 'Completa il pagamento',
    });

    expect(screen.getByRole('heading', { name: 'Completa il pagamento' })).toBeInTheDocument();
    expect(screen.getByText(/39,99/)).toBeInTheDocument();

    await act(async () => {});

    expect(mount).toHaveBeenCalledWith(expect.objectContaining({ amount: '39.99' }));
  });

  it('passes the Google Pay merchant configuration when Remote Config provides it', async () => {
    firebaseMocks.getConfigValue.mockResolvedValue('merchant-123');

    renderWidget();

    await act(async () => {});

    expect(mount).toHaveBeenCalledWith(expect.objectContaining({
      googlePay: {
        merchantId: 'merchant-123',
        merchantName: 'Frontaliere Ticino',
      },
    }));
  });

  it('closes from the backdrop but keeps the checkout locked while busy', () => {
    const onClose = vi.fn();
    renderWidget({ onClose });

    fireEvent.mouseDown(screen.getByTestId('sumup-payment-widget'));
    expect(onClose).toHaveBeenCalledTimes(1);

    cleanup();
    renderWidget({ onClose, busy: true });
    fireEvent.mouseDown(screen.getByTestId('sumup-payment-widget'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('sumup-payment-widget-close')).toBeDisabled();
  });
});
