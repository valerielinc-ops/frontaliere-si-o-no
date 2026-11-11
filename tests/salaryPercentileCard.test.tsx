// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { SalaryPercentileCard } from '../components/community/SalaryPercentileCard';

afterEach(() => {
  cleanup();
});

describe('SalaryPercentileCard Component (FreeHire Model)', () => {
  it('renderizza la griglia percentili (P25, P50, P75, P90) e la stima netto mensile', () => {
    const { container } = render(
      <SalaryPercentileCard
        medianSalary={90000}
        sampleSize={250}
        canton="TI"
        locale="it"
      />
    );

    expect(screen.getByTestId('salary-percentile-card')).toBeTruthy();
    expect(screen.getByText(/Distribuzione Percentili e Stima Netto Frontaliere \(FreeHire Model\)/i)).toBeTruthy();

    // Percentili
    expect(screen.getByText(/P25 \(Entry\)/i)).toBeTruthy();
    expect(screen.getByText(/P50 \(Mediana\)/i)).toBeTruthy();
    expect(screen.getByText(/P75 \(Senior\)/i)).toBeTruthy();
    expect(screen.getByText(/P90 \(Lead\)/i)).toBeTruthy();

    // Stima netto mensile
    expect(screen.getByText(/Stima Netto Mensile Mediano \(Accordo Fiscale 2026\)/i)).toBeTruthy();
    expect(screen.getByText(/mese/i)).toBeTruthy();

    // Verifica Schema.org Dataset & Occupation
    const jsonLd = container.querySelector('script[type="application/ld+json"]');
    expect(jsonLd).toBeTruthy();
    const data = JSON.parse(jsonLd?.textContent || '{}');
    expect(data['@context']).toBe('https://schema.org');
    expect(data['@graph']).toHaveLength(2);
    expect(data['@graph'][0]['@type']).toBe('Dataset');
    expect(data['@graph'][1]['@type']).toBe('Occupation');
  });
});
