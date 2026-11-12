// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { JobCvFitMatcher } from '../components/community/JobCvFitMatcher';
import { ensureLocaleLoaded, itReady, setLocale } from '@/services/i18n';

beforeAll(async () => {
  await itReady;
});

beforeEach(() => {
  setLocale('it');
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const regulatoryRequirements = [
  'Esperienza negli affari regolatori nell’industria farmaceutica.',
  'Esperienza con registrazioni UE (MRP/DCP) e rinnovi.',
  'Conoscenza dell’inglese scritto e parlato.',
];

describe('JobCvFitMatcher', () => {
  it.each([
    ['it', 'Affinità con l’annuncio'],
    ['en', 'Match with this job'],
    ['de', 'Passung zur Stellenanzeige'],
    ['fr', 'Correspondance avec l’offre'],
  ] as const)('renders localized copy for %s', async (locale, title) => {
    await ensureLocaleLoaded(locale);
    setLocale(locale);
    render(<JobCvFitMatcher locale={locale} />);

    expect(screen.getByRole('heading', { name: title })).toBeTruthy();
  });

  it('non mostra un punteggio o competenze inventate prima che il candidato inserisca il proprio elenco', () => {
    render(<JobCvFitMatcher requirements={regulatoryRequirements} />);

    const matcher = screen.getByTestId('job-cv-fit-matcher');
    expect(within(matcher).getByText('Affinità con l’annuncio')).toBeTruthy();
    expect(within(matcher).getByText(/Aggiungi le competenze che vuoi confrontare/i)).toBeTruthy();
    expect(matcher.textContent).not.toContain('%');
    expect(matcher.textContent).not.toContain('TypeScript');
    expect(matcher.textContent).not.toContain('React');
    expect(matcher.textContent).not.toContain('Git');
  });

  it('separa le competenze del profilo dai requisiti dell’annuncio', () => {
    render(<JobCvFitMatcher requirements={regulatoryRequirements} />);

    const matcher = screen.getByTestId('job-cv-fit-matcher');
    fireEvent.click(within(matcher).getByRole('button', { name: 'Aggiungi competenze' }));
    fireEvent.change(within(matcher).getByRole('textbox', { name: 'Le competenze che vuoi confrontare' }), {
      target: { value: 'TypeScript, React, Git' },
    });

    expect(within(matcher).getByText('0%')).toBeTruthy();
    expect(within(matcher).getByText(/Indicate nei requisiti, non nel tuo elenco/)).toBeTruthy();
    expect(within(matcher).getByText(/Nel tuo elenco, non citate nei requisiti/)).toBeTruthy();
    expect(within(matcher).getByText('Affari regolatori')).toBeTruthy();
    expect(within(matcher).getByText('TypeScript')).toBeTruthy();
    expect(within(matcher).getByText('React')).toBeTruthy();
    expect(within(matcher).getByText('Git')).toBeTruthy();
    expect(localStorage.getItem('frontaliere_job_affinity_skills:anonymous')).toBe('TypeScript, React, Git');
  });

  it('calcola la copertura solo sulle competenze esplicite e salvate dall’utente', () => {
    render(<JobCvFitMatcher requirements={regulatoryRequirements} userId="candidate-1" />);

    const matcher = screen.getByTestId('job-cv-fit-matcher');
    fireEvent.click(within(matcher).getByRole('button', { name: 'Aggiungi competenze' }));
    fireEvent.change(within(matcher).getByRole('textbox', { name: 'Le competenze che vuoi confrontare' }), {
      target: { value: 'affari regolatori, industria farmaceutica, registrazioni UE, MRP/DCP, rinnovi, inglese' },
    });

    expect(within(matcher).getByText('100%')).toBeTruthy();
    expect(within(matcher).getByText(/5 di 5 competenze riconosciute/)).toBeTruthy();
    expect(localStorage.getItem('frontaliere_job_affinity_skills:candidate-1')).toContain('affari regolatori');
  });

  it('ricarica le competenze sullo stesso profilo e non le condivide tra account', () => {
    const first = render(<JobCvFitMatcher requirements={['Conoscenza di Kubernetes.']} userId="candidate-a" />);
    const matcher = screen.getByTestId('job-cv-fit-matcher');
    fireEvent.click(within(matcher).getByRole('button', { name: 'Aggiungi competenze' }));
    fireEvent.change(within(matcher).getByRole('textbox', { name: 'Le competenze che vuoi confrontare' }), {
      target: { value: 'React' },
    });
    first.unmount();

    const sameAccount = render(<JobCvFitMatcher requirements={['Conoscenza di Kubernetes.']} userId="candidate-a" />);
    const sameMatcher = screen.getByTestId('job-cv-fit-matcher');
    expect(sameMatcher.textContent).toContain('React');
    fireEvent.click(within(sameMatcher).getByRole('button', { name: 'Modifica elenco' }));
    expect((within(sameMatcher).getByRole('textbox', { name: 'Le competenze che vuoi confrontare' }) as HTMLTextAreaElement).value).toBe('React');
    sameAccount.unmount();

    render(<JobCvFitMatcher requirements={['Conoscenza di Kubernetes.']} userId="candidate-b" />);
    const otherMatcher = screen.getByTestId('job-cv-fit-matcher');
    expect(otherMatcher.textContent).not.toContain('React');
    expect(otherMatcher.textContent).not.toContain('%');
  });

  it('mantiene il download del CV bilingue quando è disponibile', () => {
    const onDownload = vi.fn();
    render(<JobCvFitMatcher onDownloadBilingualCv={onDownload} />);

    const matcher = screen.getByTestId('job-cv-fit-matcher');
    fireEvent.click(within(matcher).getByRole('button', { name: 'Scarica il CV bilingue (IT/DE)' }));
    expect(onDownload).toHaveBeenCalledTimes(1);
  });
});
