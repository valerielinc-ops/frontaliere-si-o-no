import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';

const mocks = vi.hoisted(() => ({
  trackAssistedApplicationEvent: vi.fn(),
}));

vi.mock('@/services/i18n', () => ({
  useTranslation: () => ({
    t: (key: string) => ({
      'common.close': 'Chiudi',
      'jobBoard.assisted.title': 'Vuoi delegare questa candidatura?',
      'jobBoard.assisted.body': 'Invia il CV e i dati necessari.',
      'jobBoard.assisted.stepsLabel': 'Come funziona',
      'jobBoard.assisted.step1': 'Ci invii il CV',
      'jobBoard.assisted.step2': 'Prepariamo la candidatura',
      'jobBoard.assisted.step3': 'La inviamo quando possibile',
      'jobBoard.assisted.transparency': 'Nessuna garanzia di assunzione.',
      'jobBoard.assisted.externalCta': 'Candidati da solo, gratis',
      'jobBoard.assisted.paidCta': 'Delega l’invio — 0,99 €',
      'jobBoard.assisted.paidLoading': 'Apro il pagamento…',
      'jobBoard.assisted.priceNote': 'Pagamento unico · nessun abbonamento',
      'jobBoard.assisted.disclaimer': 'Privacy prima dell’upload.',
      'jobBoard.assisted.rewardedTitle': 'Candidati direttamente dopo un breve video',
      'jobBoard.assisted.rewardedBody': 'Guarda un breve annuncio.',
      'jobBoard.assisted.rewardedCta': 'Guarda il video e continua',
      'jobBoard.assisted.rewardedLoading': 'Preparo il video…',
      'jobBoard.assisted.rewardedUnavailable': 'Video non disponibile.',
      'jobBoard.assisted.rewardedExpiry': 'Accesso diretto per 12 ore.',
      'jobBoard.assisted.rewardedExternalCta': 'Vai comunque all’annuncio',
    }[key] || key),
  }),
}));

vi.mock('@/services/assistedApplicationExperiment', () => ({
  ASSISTED_APPLICATION_PRICE_EUR_CENTS: 99,
  trackAssistedApplicationEvent: mocks.trackAssistedApplicationEvent,
}));

import AssistedApplicationOffer from '@/components/community/AssistedApplicationOffer';

function renderOffer(overrides: Partial<ComponentProps<typeof AssistedApplicationOffer>> = {}) {
  const props: ComponentProps<typeof AssistedApplicationOffer> = {
    jobId: 'job-42',
    companyId: 'company-acme',
    companyName: 'Acme',
    jobTitle: 'Responsabile operativo',
    variant: 'assisted_application',
    onChooseExternal: vi.fn(),
    onChoosePaid: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
  render(<AssistedApplicationOffer {...props} />);
  return props;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('AssistedApplicationOffer', () => {
  it('shows one primary paid CTA, a clear free alternative, and records the price', () => {
    renderOffer();

    expect(screen.getByTestId('assisted-application-offer-paid')).toHaveTextContent('Delega l’invio — 0,99 €');
    expect(screen.getByTestId('assisted-application-offer-external')).toHaveTextContent('Candidati da solo, gratis');
    expect(screen.getByText('Pagamento unico · nessun abbonamento')).toBeTruthy();
    expect(mocks.trackAssistedApplicationEvent).toHaveBeenCalledWith(
      'assisted_application_offer_viewed',
      expect.objectContaining({ price_eur_cents: 99, jobId: 'job-42', companyId: 'company-acme' }),
    );
  });

  it('routes both choices and closes with Escape', () => {
    const props = renderOffer();

    fireEvent.click(screen.getByTestId('assisted-application-offer-paid'));
    fireEvent.click(screen.getByTestId('assisted-application-offer-external'));
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(props.onChoosePaid).toHaveBeenCalledTimes(1);
    expect(props.onChooseExternal).toHaveBeenCalledTimes(1);
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps checkout errors visible to assist recovery', () => {
    renderOffer({ error: 'Non siamo riusciti ad avviare il pagamento.' });

    expect(screen.getByRole('alert')).toHaveTextContent('Non siamo riusciti ad avviare il pagamento.');
  });

});
