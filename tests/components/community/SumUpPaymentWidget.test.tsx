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
  ASSISTED_APPLICATION_PRICE_EUR_CENTS: 99,
}));

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
  (window as unknown as { SumUpCard: { mount: typeof mount } }).SumUpCard = { mount };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  delete (window as unknown as { SumUpCard?: unknown }).SumUpCard;
  document.body.style.overflow = '';
});

describe('SumUpPaymentWidget', () => {
  it('shows a clear payment summary and a mobile-safe dialog shell', async () => {
    renderWidget();

    expect(screen.getByRole('dialog')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getAllByText('Pagamento unico · nessun abbonamento')).toHaveLength(2);
    expect(screen.getByText(/0,99/)).toBeInTheDocument();
    expect(screen.getByTestId('sumup-payment-widget-close')).toHaveAccessibleName('Chiudi');

    await act(async () => {});

    expect(screen.getByRole('dialog')).toHaveAttribute('aria-busy', 'false');
    expect(mount).toHaveBeenCalledWith(expect.objectContaining({
      checkoutId: 'checkout-1',
      amount: '0.99',
      currency: 'EUR',
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
