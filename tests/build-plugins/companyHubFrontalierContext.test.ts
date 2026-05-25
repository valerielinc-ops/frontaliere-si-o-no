import { describe, expect, it } from 'vitest';
import { renderCompanyHubFrontalierContext } from '../../build-plugins/shared/companyHubFrontalierContext';

const esc = (raw: string): string => raw
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

describe('renderCompanyHubFrontalierContext', () => {
  it('keeps company SEO prose collapsed and uses the local ECB exchange-rate snapshot', () => {
    const html = renderCompanyHubFrontalierContext({
      companyName: 'Migros',
      displayCanton: 'Ticino',
      primaryLocation: 'Lugano',
      sector: 'retail',
      companySectors: ['retail'],
      companyContracts: ['tempo indeterminato'],
      jobCount: 4,
      locale: 'it',
      esc,
    });

    expect(html).toContain('<details class="company-hub-seo-details"><summary>Lavorare da Migros come frontaliere</summary>');
    expect(html).toContain('<summary>Come candidarsi e domande frequenti</summary>');
    expect(html).not.toContain('<section class="s-7uP4UM"><h2>Come candidarsi e domande frequenti</h2>');
    expect(html).toContain('cambio CHF/EUR di 1,10');
    expect(html).toContain('snapshot ECB locale aggiornato al 24 maggio 2026');
  });
});
