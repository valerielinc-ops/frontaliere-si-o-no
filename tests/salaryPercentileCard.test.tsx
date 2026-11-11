// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { SalaryPercentileCard } from '../components/community/SalaryPercentileCard';

afterEach(() => {
  cleanup();
});

describe('SalaryPercentileCard', () => {
  it('renderizza i percentili osservati e lo Schema.org localizzato', () => {
    const { container } = render(
      <SalaryPercentileCard
        p10Salary={65000}
        p25Salary={70000}
        medianSalary={90000}
        p75Salary={110000}
        p90Salary={122000}
        exactSalaryCount={5}
        salaryRangeCount={250}
        canton="TI"
        locale="en"
      />
    );

    expect(screen.getByTestId('salary-percentile-card')).toBeTruthy();
    expect(screen.getByText('Observed exact salary amounts')).toBeTruthy();

    // Percentili
    expect(screen.getByText('P25 (first quartile)')).toBeTruthy();
    expect(screen.getByText('P50 (median)')).toBeTruthy();
    expect(screen.getByText('P75 (third quartile)')).toBeTruthy();
    expect(screen.getByText('P90')).toBeTruthy();
    expect(screen.getByText('Exact amounts: 5; listings with reported salary: 250.')).toBeTruthy();
    expect(screen.getByText(/Percentiles use only exact annual salary amounts reported in CHF/i)).toBeTruthy();

    // Verifica Schema.org Dataset & Occupation
    const jsonLd = container.querySelector('script[type="application/ld+json"]');
    expect(jsonLd).toBeTruthy();
    const data = JSON.parse(jsonLd?.textContent || '{}');
    expect(data['@context']).toBe('https://schema.org');
    expect(data['@graph']).toHaveLength(2);
    expect(data['@graph'][0]['@type']).toBe('Dataset');
    expect(data['@graph'][1]['@type']).toBe('Occupation');
    expect(data['@graph'][0].name).toContain('Observed salary distribution');
    expect(data['@graph'][0].description).toContain('listings with reported salary ranges');
    expect(data['@graph'][1].estimatedSalary[0]).toMatchObject({
      percentile10: 65000,
      percentile25: 70000,
      median: 90000,
      percentile75: 110000,
      percentile90: 122000,
    });
    expect(JSON.stringify(data)).not.toContain('netto');
  });

  it('non pubblica un percentile card o JSON-LD senza un campione osservato', () => {
    const { container } = render(
      <SalaryPercentileCard
        p10Salary={65000}
        p25Salary={70000}
        medianSalary={90000}
        p75Salary={110000}
        p90Salary={122000}
        exactSalaryCount={0}
        salaryRangeCount={0}
      />
    );

    expect(screen.queryByTestId('salary-percentile-card')).toBeNull();
    expect(container.querySelector('script[type="application/ld+json"]')).toBeNull();
  });

  it('non inventa un campione o valori percentili quando manca la copertura', () => {
    const { container } = render(<SalaryPercentileCard />);

    expect(screen.queryByTestId('salary-percentile-card')).toBeNull();
    expect(container.querySelector('script[type="application/ld+json"]')).toBeNull();
  });

  it('mostra i limiti mediani ma non percentili/JSON-LD per annunci con soli range', () => {
    const { container } = render(
      <SalaryPercentileCard
        exactSalaryCount={0}
        salaryRangeCount={8}
        medianRangeMin={80000}
        medianRangeMax={100000}
        locale="en"
      />
    );

    expect(screen.getByText('Reported salary ranges')).toBeTruthy();
    expect(screen.getByText('Separate medians of reported lower and upper bounds')).toBeTruthy();
    expect(screen.getByText(/Listings provide ranges rather than individual amounts/i)).toBeTruthy();
    expect(screen.getByText('Listings with reported ranges: 8')).toBeTruthy();
    expect(container.querySelector('script[type="application/ld+json"]')).toBeNull();
    expect(screen.queryByText('P25 (first quartile)')).toBeNull();
  });
});
