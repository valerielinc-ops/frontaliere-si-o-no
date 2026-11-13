import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { JobPreApplyChecklist, type ATSApplicationFormSnapshot } from '@/components/community/JobPreApplyChecklist';

const snapshot: ATSApplicationFormSnapshot = {
  provider: 'ncoreplat',
  sourceUrl: 'https://app.ncoreplat.com/jobposition/808005/cmc-senior-specialist/sintetica',
  checkedAt: '2026-11-12T12:00:00.000Z',
  stage: 'Inoltra ora la candidatura',
  fields: [
    { label: 'Nome', type: 'text', required: true, kind: 'question' },
    { label: 'Email', type: 'email', required: true, kind: 'question' },
    { label: 'Ho letto ed accetto la Privacy Policy', type: 'checkbox', required: true, kind: 'consent' },
  ],
};

afterEach(cleanup);

describe('JobPreApplyChecklist', () => {
  it('renders only source-observed fields with the observation date and source link', () => {
    render(<JobPreApplyChecklist companyName="Sintetica SA" atsApplicationForm={snapshot} />);

    expect(screen.getByRole('region', { name: 'Campi ATS verificati per Sintetica SA' })).toBeTruthy();
    expect(screen.getByText('Nome')).toBeTruthy();
    expect(screen.getAllByText('Obbligatorio')).toHaveLength(3);
    expect(screen.getByText('Ho letto ed accetto la Privacy Policy')).toBeTruthy();
    expect(screen.queryByText('Pre-compilabile')).toBeNull();
    expect(screen.getByText(/solo i campi osservati nella pagina pubblica/i)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Apri il modulo ATS originale' })).toHaveAttribute('href', snapshot.sourceUrl);
    expect(screen.queryByText(/Permesso G|3 mesi|100%|salario mediani/i)).toBeNull();
  });

  it.each([
    ['missing source data', undefined],
    ['untrusted source host', { ...snapshot, sourceUrl: 'https://evil.example/jobposition/808005/sintetica' }],
    ['invalid check date', { ...snapshot, checkedAt: 'not-a-date' }],
  ])('does not render for %s', (_label, atsApplicationForm) => {
    const { container } = render(
      <JobPreApplyChecklist companyName="Sintetica SA" atsApplicationForm={atsApplicationForm as ATSApplicationFormSnapshot | undefined} />,
    );
    expect(container.firstChild).toBeNull();
  });
});
