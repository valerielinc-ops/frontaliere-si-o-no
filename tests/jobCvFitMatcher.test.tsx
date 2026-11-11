// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { JobCvFitMatcher } from '../components/community/JobCvFitMatcher';

afterEach(() => {
  cleanup();
});

describe('JobCvFitMatcher Component', () => {
  it('renderizza lo score di affinità, le competenze rilevate e mancanti', () => {
    render(
      <JobCvFitMatcher
        jobTitle="Frontend React Developer"
        requirements={['React', 'TypeScript', 'Tailwind', 'GraphQL']}
        preferredSkills={['Docker', 'Next.js']}
        seniority="mid"
      />
    );

    const matcher = screen.getByTestId('job-cv-fit-matcher');
    expect(matcher).toBeTruthy();
    expect(within(matcher).getByText(/Verifica Affinità CV \(FreeHire Matcher\)/i)).toBeTruthy();

    // Competenze rilevate
    expect(within(matcher).getByText(/Competenze Rilevate/i)).toBeTruthy();

    // Competenze mancanti
    expect(within(matcher).getByText('Tailwind')).toBeTruthy();
    expect(within(matcher).getByText('GraphQL')).toBeTruthy();
  });

  it('permette di modificare le competenze del candidato e ricalcolare lo score', () => {
    render(
      <JobCvFitMatcher
        jobTitle="DevOps Engineer"
        requirements={['Kubernetes', 'Terraform', 'AWS']}
      />
    );

    const matcher = screen.getByTestId('job-cv-fit-matcher');

    // Clicca "Modifica competenze"
    const editBtn = within(matcher).getByRole('button', { name: /Modifica competenze/i });
    fireEvent.click(editBtn);

    // Trova la textarea e inserisci tutte le competenze richieste
    const textarea = within(matcher).getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'Kubernetes, Terraform, AWS, DevOps' } });

    // Ora lo score deve riflettere un match alto
    expect(within(matcher).getByText(/100%|9[0-9]%/)).toBeTruthy();
    expect(within(matcher).getByText(/Profilo fortemente allineato/i)).toBeTruthy();
  });

  it('mostra il pulsante di download CV bilingue e invoca la callback', () => {
    const onDownload = vi.fn();
    render(
      <JobCvFitMatcher
        jobTitle="Software Engineer"
        onDownloadBilingualCv={onDownload}
      />
    );

    const matcher = screen.getByTestId('job-cv-fit-matcher');
    const downloadBtn = within(matcher).getByRole('button', { name: /Scarica CV Bilingue/i });
    expect(downloadBtn).toBeTruthy();
    fireEvent.click(downloadBtn);
    expect(onDownload).toHaveBeenCalledTimes(1);
  });
});
