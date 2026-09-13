import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (rel: string) => readFileSync(resolve(__dirname, '..', '..', rel), 'utf8');

describe('calculator salary-alert capture', () => {
  it('keeps anonymous visitors on the result and provides email/social capture', () => {
    const source = read('components/calculator/SalaryAlertCTA.tsx');
    expect(source).toContain("import SocialSignInButtons from '@/components/shared/SocialSignInButtons';");
    expect(source).toContain("import EmailInput, { validateEmailStrict } from '@/components/shared/EmailInput';");
    expect(source).toContain("data-testid=\"salary-alert-capture\"");
    expect(source).toContain("savePendingSalaryAlert(config)");
    expect(source).not.toContain("navigateTo('job-board')");
    expect(source).not.toContain("window.location.assign('/lavoro/')");
  });

  it('sends a separate passwordless link for every email capture, including new DOI rows', () => {
    const source = read('components/calculator/SalaryAlertCTA.tsx');
    expect(source).toContain("await requestConfirmationEmail(trimmed, 'login');");
    expect(source).not.toContain("upsert.status !== 'pending' || upsert.hadConfirmationProof");
  });

  it('renders the alert immediately after the result banner and before the ad slot', () => {
    const source = read('components/calculator/ResultsView.tsx');
    const alert = source.indexOf('SalaryAlertCTA netMonthlyCHF');
    const ad = source.indexOf('AD_SLOTS.CALCULATOR_POST_RESULT');
    const comparison = source.indexOf('Comparison Grid:');
    expect(alert).toBeGreaterThanOrEqual(0);
    expect(alert).toBeLessThan(ad);
    expect(ad).toBeLessThan(comparison);
  });

  it.each([
    'services/locales/it-calculator.ts',
    'services/locales/en-calculator.ts',
    'services/locales/de-calculator.ts',
    'services/locales/fr-calculator.ts',
  ])('%s contains the capture copy', (path) => {
    const source = read(path);
    for (const key of [
      'results.salaryAlert.capture.title',
      'results.salaryAlert.capture.body',
      'results.salaryAlert.capture.emailCta',
      'results.salaryAlert.capture.checkEmailBody',
    ]) {
      expect(source).toContain(`'${key}'`);
    }
  });
});
