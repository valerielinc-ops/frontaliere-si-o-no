import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import ProviderLogo from '@/components/shared/ProviderLogo';

// logoService is NOT mocked globally in tests/setup.tsx — mock locally:
vi.mock('@/services/logoService', () => ({
  COMPANY_LOGO_PLACEHOLDER: '/icons/company-placeholder.svg',
  handleCompanyLogoError: vi.fn(),
}));

describe('ProviderLogo', () => {
  it('renders img with resolved src for known slug (localPath or Clearbit)', () => {
    // swisscom has a downloaded localPath; intesa-sanpaolo falls back to Clearbit.
    // Either way the src must NOT be the placeholder — the slug resolved to something.
    const { container } = render(<ProviderLogo slug="swisscom" name="Swisscom" />);
    const img = container.querySelector('img')!;
    expect(img.src).not.toContain('company-placeholder.svg');
    expect(img.alt).toBe('Swisscom');
  });

  it('renders Clearbit src for slug without localPath', () => {
    // intesa-sanpaolo intentionally has no localPath (download failed)
    const { container } = render(<ProviderLogo slug="intesa-sanpaolo" name="Intesa" />);
    const img = container.querySelector('img')!;
    expect(img.src).toContain('logo.clearbit.com/intesasanpaolo.com');
  });

  it('uses domain prop for ad-hoc providers not in PROVIDER_LOGOS', () => {
    const { container } = render(<ProviderLogo domain="example.com" name="Example" />);
    const img = container.querySelector('img')!;
    expect(img.src).toContain('logo.clearbit.com/example.com');
  });

  it('falls back to placeholder when neither slug nor domain resolves', () => {
    const { container } = render(<ProviderLogo slug="unknown-xyz-abc" name="Unknown" />);
    const img = container.querySelector('img')!;
    expect(img.src).toContain('company-placeholder.svg');
  });

  it('applies size prop as width and height', () => {
    const { container } = render(<ProviderLogo domain="wise.com" name="Wise" size={48} />);
    const img = container.querySelector('img')!;
    expect(img.getAttribute('width')).toBe('48');
    expect(img.getAttribute('height')).toBe('48');
  });

  it('passes className to img element', () => {
    const { container } = render(
      <ProviderLogo domain="wise.com" name="Wise" className="rounded" />
    );
    const img = container.querySelector('img')!;
    expect(img.className).toBe('rounded');
  });
});
