// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import PharmacyItalyDutyWeek from '../components/pages/PharmacyItalyDutyWeek';
import PharmacyDutyCoverageMatrix from '../components/pharmacies/PharmacyDutyCoverageMatrix';
import dutiesJson from '../data/pharmacy-duties-ticino.json';
import italyDutiesJson from '../data/pharmacy-duties-italy.json';
import italyStatusJson from '../data/pharmacy-duties-italy-status.json';
import type { ItalyDutySnapshot } from '../services/pharmacies/italyRelease';
import type { PharmacyDutiesDataset } from '../services/pharmacies/types';

const duties = dutiesJson as unknown as PharmacyDutiesDataset;
// Keep the clock just after the checked-in duty snapshot. The fixture is
// refreshed independently of the test source, so a historical fixed date
// would make a valid fresh release look like it came from the future.
const now = new Date(new Date(duties._fetchedAt).getTime() + 60 * 60 * 1000);

afterEach(cleanup);

describe('PharmacyDutyCoverageMatrix', () => {
  it.each(['it', 'en', 'de', 'fr'] as const)('keeps the same five-region/25-source-only shape in %s', (locale) => {
    const { container } = render(<PharmacyDutyCoverageMatrix locale={locale} now={now} weekStart="2026-09-14" />);
    const root = container.querySelector('[data-coverage-matrix="true"]');

    expect(root).toHaveAttribute('data-release-ready', 'true');
    expect(root).toHaveAttribute('data-italy-release-ready', 'false');
    expect(root).toHaveAttribute('data-italy-indexable', 'false');
    expect(root).toHaveAttribute('data-italy-release-state', 'not_published');
    expect(root?.querySelectorAll('[data-coverage-kind="ticino-region"]')).toHaveLength(5);
    expect(root?.querySelectorAll('[data-coverage-kind="italy-province"]')).toHaveLength(3);
    expect(root?.querySelectorAll('[data-coverage-kind="italy-province"] [data-duty-id]')).toHaveLength(0);
    expect(root?.querySelectorAll('[data-coverage-kind="italy-province"] time')).toHaveLength(0);
    expect(root?.querySelectorAll('[data-coverage-kind="italy-province"] [data-italy-duty-published]')).toHaveLength(0);
    expect(root?.querySelectorAll('[data-coverage-kind="source-only-canton"]')).toHaveLength(25);
    expect(root?.querySelectorAll('[data-coverage-kind="source-only-canton"] a[href^="https://"]')).toHaveLength(25);
    expect(root?.querySelectorAll('[data-coverage-kind="ticino-region"] [data-duty-id]').length).toBeGreaterThan(0);
  });

  it('does not render duty rows or times in the Ticino region cards when the release is stale', () => {
    const tampered = {
      ...duties,
      _release: { ...duties._release, state: 'partial' },
    } as unknown as PharmacyDutiesDataset;
    const { container } = render(<PharmacyDutyCoverageMatrix locale="it" now={now} weekStart="2026-09-14" duties={tampered} />);
    const root = container.querySelector('[data-coverage-matrix="true"]');
    const regions = root?.querySelectorAll('[data-coverage-kind="ticino-region"]');

    expect(root).toHaveAttribute('data-release-ready', 'false');
    expect(regions).toHaveLength(5);
    regions?.forEach((region) => {
      expect(region.querySelectorAll('[data-duty-id]')).toHaveLength(0);
      expect(region.querySelectorAll('time')).toHaveLength(0);
    });
  });

  it('keeps Italian official sources visible without duty markers for a partial release', () => {
    const partialDuties = {
      ...italyDutiesJson,
      _release: { ...italyDutiesJson._release, state: 'partial' },
    } as unknown as ItalyDutySnapshot;
    const partialStatus = {
      ...italyStatusJson,
      _release: { ...italyStatusJson._release, state: 'partial' },
    } as unknown as ItalyDutySnapshot;
    const { container } = render(<PharmacyDutyCoverageMatrix locale="it" now={now} weekStart="2026-09-14" italyDuties={partialDuties} italyStatus={partialStatus} />);
    const root = container.querySelector('[data-coverage-matrix="true"]');
    const italy = root?.querySelectorAll('[data-coverage-kind="italy-province"]');

    expect(root).toHaveAttribute('data-italy-release-state', 'partial');
    expect(root).toHaveAttribute('data-italy-release-ready', 'false');
    expect(italy).toHaveLength(3);
    expect(root?.querySelectorAll('[data-coverage-kind="italy-province"] [data-duty-id]')).toHaveLength(0);
    expect(root?.querySelectorAll('[data-coverage-kind="italy-province"] time')).toHaveLength(0);
    expect(root?.querySelectorAll('[data-coverage-kind="italy-province"] [data-italy-duty-published]')).toHaveLength(0);
    expect(root?.querySelectorAll('[data-coverage-kind="italy-province"] a[href^="https://"]')).toHaveLength(3);
  });

  it('renders an Italian duty week as source-only while the checked-in release is not published', () => {
    const { container } = render(<PharmacyItalyDutyWeek page={{ kind: 'italy-duty-week', country: 'IT', locale: 'it', weekStart: '2026-09-14' }} now={now} />);
    const root = container.querySelector('[data-italy-duty-week="true"]');

    expect(root).toHaveAttribute('data-italy-release-state', 'not_published');
    expect(root).toHaveAttribute('data-italy-publishable', 'false');
    expect(root).toHaveAttribute('data-italy-indexable', 'false');
    expect(root?.querySelectorAll('[data-italy-duty-province]')).toHaveLength(3);
    expect(root?.querySelectorAll('[data-italy-duty-province] a[href^="https://"]')).toHaveLength(3);
    expect(root?.querySelectorAll('[data-italy-duty-province] [data-duty-id]')).toHaveLength(0);
    expect(root?.querySelectorAll('[data-italy-duty-province] time')).toHaveLength(0);
    expect(root?.querySelectorAll('[data-italy-duty-province] [data-italy-duty-published]')).toHaveLength(0);
  });
});
