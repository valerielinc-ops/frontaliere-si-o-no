import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import ProviderLogo from '@/components/shared/ProviderLogo';

// logoService is NOT mocked globally in tests/setup.tsx — mock locally:
vi.mock('@/services/logoService', () => ({
  COMPANY_LOGO_PLACEHOLDER: '/icons/company-placeholder.svg',
  handleCompanyLogoError: vi.fn(),
}));

describe('ProviderLogo', () => {
  it('renders img with Clearbit src for known slug', () => {
    const { container } = render(<ProviderLogo slug="swisscom" name="Swisscom" />);
    const img = container.querySelector('img')!;
    expect(img.src).toContain('logo.clearbit.com/swisscom.ch');
    expect(img.alt).toBe('Swisscom');
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
