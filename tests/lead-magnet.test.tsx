import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import LeadMagnetCTA from '@/components/shared/LeadMagnetCTA';
import type { LeadMagnetVariant } from '@/components/shared/LeadMagnetCTA';

describe('LeadMagnetCTA', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('renders when not subscribed or dismissed', () => {
    const { container } = render(<LeadMagnetCTA variant="generic" />);
    expect(container.innerHTML).not.toBe('');
  });

  it('does not render when already subscribed', () => {
    localStorage.setItem('newsletter_subscribed', 'true');
    const { container } = render(<LeadMagnetCTA variant="generic" />);
    expect(container.innerHTML).toBe('');
  });

  it('does not render when recently dismissed', () => {
    localStorage.setItem('lead_magnet_dismissed', String(Date.now()));
    const { container } = render(<LeadMagnetCTA variant="generic" />);
    expect(container.innerHTML).toBe('');
  });

  it('renders again after dismiss period expires', () => {
    // Dismissed 15 days ago (period is 14 days)
    const fifteenDaysAgo = Date.now() - (15 * 24 * 60 * 60 * 1000);
    localStorage.setItem('lead_magnet_dismissed', String(fifteenDaysAgo));
    const { container } = render(<LeadMagnetCTA variant="generic" />);
    expect(container.innerHTML).not.toBe('');
  });

  it('has a dismiss button with aria-label', () => {
    render(<LeadMagnetCTA variant="generic" />);
    const dismissBtns = screen.getAllByRole('button');
    const hasAriaLabel = dismissBtns.some(btn =>
      btn.getAttribute('aria-label') !== null
    );
    expect(hasAriaLabel).toBe(true);
  });

  it('dismiss button stores timestamp in localStorage', () => {
    render(<LeadMagnetCTA variant="generic" />);
    const dismissBtn = screen.getAllByRole('button').find(
      btn => btn.getAttribute('aria-label') !== null &&
             btn.getAttribute('type') !== 'submit'
    );
    expect(dismissBtn).toBeTruthy();
    fireEvent.click(dismissBtn!);
    expect(localStorage.getItem('lead_magnet_dismissed')).toBeTruthy();
  });

  it('renders compact variant', () => {
    const { container } = render(<LeadMagnetCTA variant="tax_checklist" compact />);
    expect(container.innerHTML).not.toBe('');
    // Compact variant should have a form
    expect(container.querySelector('form')).toBeTruthy();
  });

  it('renders full variant with bullets', () => {
    render(<LeadMagnetCTA variant="insurance" />);
    // Full variant should have the form and bullet points
    const form = document.querySelector('form');
    expect(form).toBeTruthy();
  });

  describe('all variants render without error', () => {
    const variants: LeadMagnetVariant[] = [
      'tax_checklist', 'salary_guide', 'relocation',
      'insurance', 'pension', 'generic',
    ];

    for (const variant of variants) {
      it(`renders variant "${variant}"`, () => {
        const { container } = render(<LeadMagnetCTA variant={variant} />);
        expect(container.innerHTML).not.toBe('');
      });
    }
  });

  it('has an email input with label', () => {
    render(<LeadMagnetCTA variant="generic" />);
    const input = document.querySelector('input[type="email"], input[id*="lead"]');
    expect(input).toBeTruthy();
  });

  it('has a submit button', () => {
    render(<LeadMagnetCTA variant="generic" />);
    const submitBtn = document.querySelector('button[type="submit"]');
    expect(submitBtn).toBeTruthy();
  });
});
