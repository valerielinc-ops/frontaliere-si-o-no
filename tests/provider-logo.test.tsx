import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import ProviderLogo from '@/components/shared/ProviderLogo';

// logoService is NOT mocked: ProviderLogo now relies on the real
// generateInitialsLogo for its fallback (no Clearbit / placeholder hop).

describe('ProviderLogo', () => {
  it('renders the committed local asset for a slug that has a localPath', () => {
    // swisscom has a downloaded localPath → src is the self-hosted path,
    // never a data URI, Clearbit, or grey globe.
    const { container } = render(<ProviderLogo slug="swisscom" name="Swisscom" />);
    const img = container.querySelector('img')!;
    expect(img.getAttribute('src')).toContain('swisscom');
    expect(img.src).not.toContain('logo.clearbit.com');
    expect(img.src).not.toContain('google.com/s2/favicons');
    expect(img.src).not.toMatch(/^data:/);
    expect(img.alt).toBe('Swisscom');
  });

  it('renders a coloured-initials badge (never Clearbit) for a slug without localPath', () => {
    // intesa-sanpaolo intentionally has no localPath (download failed).
    const { container } = render(<ProviderLogo slug="intesa-sanpaolo" name="Intesa" />);
    const img = container.querySelector('img')!;
    expect(img.src).not.toContain('logo.clearbit.com');
    expect(img.src).not.toContain('google.com/s2/favicons');
    expect(img.getAttribute('src')).toMatch(/^data:image\/svg\+xml/);
  });

  it('renders initials (never Clearbit) for ad-hoc domains not in the logo maps', () => {
    const { container } = render(<ProviderLogo domain="example.com" name="Example" />);
    const img = container.querySelector('img')!;
    expect(img.src).not.toContain('logo.clearbit.com');
    expect(img.getAttribute('src')).toMatch(/^data:image\/svg\+xml/);
  });

  it('falls back to a coloured-initials badge when neither slug nor domain resolves', () => {
    const { container } = render(<ProviderLogo slug="unknown-xyz-abc" name="Unknown" />);
    const img = container.querySelector('img')!;
    expect(img.src).not.toContain('company-placeholder.svg');
    expect(img.src).not.toContain('google.com/s2/favicons');
    expect(img.getAttribute('src')).toMatch(/^data:image\/svg\+xml/);
  });

  it('applies size prop as width and height', () => {
    const { container } = render(<ProviderLogo domain="example.com" name="Wise" size={48} />);
    const img = container.querySelector('img')!;
    expect(img.getAttribute('width')).toBe('48');
    expect(img.getAttribute('height')).toBe('48');
  });

  it('passes className to img element', () => {
    const { container } = render(
      <ProviderLogo domain="example.com" name="Wise" className="rounded" />
    );
    const img = container.querySelector('img')!;
    expect(img.className).toBe('rounded');
  });
});
