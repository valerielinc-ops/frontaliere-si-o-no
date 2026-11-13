import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ensureLocaleLoaded, setLocale, t, type Locale } from '@/services/i18n';
import { JobPreApplyChecklist, type ATSApplicationFormSnapshot } from '@/components/community/JobPreApplyChecklist';

const snapshot: ATSApplicationFormSnapshot = {
  provider: 'ncoreplat',
  sourceUrl: 'https://app.ncoreplat.com/jobposition/808005/cmc-senior-specialist/sintetica',
  checkedAt: '2026-11-12T12:00:00.000Z',
  stage: 'Inoltra ora la candidatura',
  fields: [
    { label: 'Nome', type: 'text', required: true, kind: 'question' },
    { label: 'Email', type: 'email', required: true, kind: 'question' },
    { label: 'Disponibilità', type: 'text', required: false, kind: 'question' },
    { label: 'Ho letto ed accetto la Privacy Policy', type: 'checkbox', required: true, kind: 'consent' },
  ],
};

const DATE_LOCALES: Record<Locale, string> = {
  it: 'it-CH',
  en: 'en-GB',
  de: 'de-CH',
  fr: 'fr-CH',
};

async function prepareLocale(locale: Locale) {
  await ensureLocaleLoaded(locale);
  setLocale(locale);
}

afterEach(() => {
  cleanup();
  setLocale('it');
});

describe('JobPreApplyChecklist', () => {
  it.each(['it', 'en', 'de', 'fr'] as const)('renders localized text and date for %s', async (locale) => {
    await prepareLocale(locale);
    const date = new Date(snapshot.checkedAt).toLocaleDateString(DATE_LOCALES[locale], {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      timeZone: 'Europe/Zurich',
    });
    const title = t('jobBoard.atsChecklist.title', { company: 'Sintetica SA' });

    render(<JobPreApplyChecklist companyName="Sintetica SA" atsApplicationForm={snapshot} locale={locale} t={t} />);

    expect(screen.getByRole('region', {
      name: t('jobBoard.atsChecklist.ariaLabel', { company: 'Sintetica SA' }),
    })).toBeTruthy();
    expect(screen.getByRole('heading', { name: title })).toBeTruthy();
    expect(screen.getByText(t('jobBoard.atsChecklist.sourceVerified'))).toBeTruthy();
    expect(screen.getByText(t('jobBoard.atsChecklist.fieldsIntroWithStage', { stage: snapshot.stage }))).toBeTruthy();
    expect(screen.getByText('Nome')).toBeTruthy();
    expect(screen.getAllByText(t('jobBoard.atsChecklist.required'))).toHaveLength(3);
    expect(screen.getByText(t('jobBoard.atsChecklist.optional'))).toBeTruthy();
    expect(screen.getByText(`· ${t('jobBoard.atsChecklist.consent')}`)).toBeTruthy();
    expect(screen.getByText('Ho letto ed accetto la Privacy Policy')).toBeTruthy();
    expect(screen.queryByText('Pre-compilabile')).toBeNull();
    expect(screen.getByText(t('jobBoard.atsChecklist.laterSteps'))).toBeTruthy();
    expect(screen.getByText(t('jobBoard.atsChecklist.checkedAt', { date }))).toBeTruthy();
    expect(screen.getByRole('link', { name: t('jobBoard.atsChecklist.openSource') })).toHaveAttribute('href', snapshot.sourceUrl);
    if (locale !== 'it') expect(title).not.toContain('Domande previste');
    expect(screen.queryByText(/Permesso G|3 mesi|100%|salario mediani/i)).toBeNull();
  });

  it.each([
    ['missing source data', undefined],
    ['untrusted source host', { ...snapshot, sourceUrl: 'https://evil.example/jobposition/808005/sintetica' }],
    ['non-default source port', { ...snapshot, sourceUrl: 'https://app.ncoreplat.com:8443/jobposition/808005/sintetica' }],
    ['source query string', { ...snapshot, sourceUrl: `${snapshot.sourceUrl}?step=2` }],
    ['source fragment', { ...snapshot, sourceUrl: `${snapshot.sourceUrl}#application-form` }],
    ['source credentials', { ...snapshot, sourceUrl: snapshot.sourceUrl.replace('https://', 'https://candidate@') }],
    ['invalid check date', { ...snapshot, checkedAt: 'not-a-date' }],
  ])('does not render for %s', async (_label, atsApplicationForm) => {
    await prepareLocale('it');
    const { container } = render(
      <JobPreApplyChecklist
        companyName="Sintetica SA"
        atsApplicationForm={atsApplicationForm as ATSApplicationFormSnapshot | undefined}
        locale="it"
        t={t}
      />,
    );
    expect(container.firstChild).toBeNull();
  });
});
