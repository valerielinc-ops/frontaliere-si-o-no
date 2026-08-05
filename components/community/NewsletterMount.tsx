/**
 * NewsletterMount — bridges static SSG pages to the React Newsletter component.
 *
 * Static SSG pages (weather city/hub, weather alerts, future SEO landings)
 * emit a placeholder `<div data-newsletter-mount data-acquisition-source=...
 * data-heading=... data-subtitle=...></div>` in their HTML. At hydration
 * time this component scans the document for those placeholders and renders
 * the canonical `<Newsletter compact />` component into each via createPortal,
 * passing the `data-*` attrs as overrides.
 *
 * Result: SSG pages share the EXACT same newsletter UI as the footer
 * (Google one-tap, Google explicit fallback, LinkedIn, email form, MX check,
 * Firebase upsert, analytics, locale handling) — only the heading/subtitle
 * text differs per page. Per-page acquisition is tracked via `sourceCta`.
 *
 * The scan / clear / idempotency / re-scan loop used to be inline here. It now
 * lives in hooks/useHydrationIslands.ts, shared with CompanyFollowMount (#5012
 * phase 2, Non-Negotiable #6) — behaviour unchanged, one home for the four
 * details that are each a bug when forgotten.
 */
import React from 'react';
import { createPortal } from 'react-dom';
import { useHydrationIslands } from '@/hooks/useHydrationIslands';
import Newsletter from './Newsletter';

interface NewsletterMountProps {
  acquisitionSource?: string;
  heading?: string;
  subtitle?: string;
}

const NewsletterMount: React.FC = () => {
  const targets = useHydrationIslands<NewsletterMountProps>({
    attribute: 'data-newsletter-mount',
    mountedAttribute: 'data-newsletter-mounted',
    readProps: (el) => ({
      acquisitionSource: el.dataset.acquisitionSource,
      heading: el.dataset.heading,
      subtitle: el.dataset.subtitle,
    }),
  });

  if (targets.length === 0) return null;
  return (
    <>
      {targets.map((t, i) =>
        createPortal(
          <Newsletter
            compact
            headingOverride={t.props.heading}
            subtitleOverride={t.props.subtitle}
            acquisitionSource={t.props.acquisitionSource}
          />,
          t.el,
          `newsletter-mount-${i}`,
        ),
      )}
    </>
  );
};

export default NewsletterMount;
