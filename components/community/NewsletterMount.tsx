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
 */
import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import Newsletter from './Newsletter';

interface MountTarget {
  el: HTMLElement;
  acquisitionSource?: string;
  heading?: string;
  subtitle?: string;
}

const NewsletterMount: React.FC = () => {
  const [targets, setTargets] = useState<MountTarget[]>([]);

  useEffect(() => {
    const scan = () => {
      const elements = Array.from(
        document.querySelectorAll<HTMLElement>('[data-newsletter-mount]:not([data-newsletter-mounted])'),
      );
      if (elements.length === 0) return;
      const next: MountTarget[] = elements.map((el) => {
        el.dataset.newsletterMounted = '1';
        // Static HTML placeholders are intentionally minimal — clear any
        // skeleton placeholder content before mounting the real component.
        el.innerHTML = '';
        return {
          el,
          acquisitionSource: el.dataset.acquisitionSource,
          heading: el.dataset.heading,
          subtitle: el.dataset.subtitle,
        };
      });
      setTargets((prev) => [...prev, ...next]);
    };
    scan();
    // Re-scan when SPA navigates between static-overlay pages without a full
    // reload. The router emits popstate; mutationobserver catches React rerenders.
    const onPop = () => scan();
    window.addEventListener('popstate', onPop);
    const observer = new MutationObserver(() => scan());
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      window.removeEventListener('popstate', onPop);
      observer.disconnect();
    };
  }, []);

  if (targets.length === 0) return null;
  return (
    <>
      {targets.map((t, i) =>
        createPortal(
          <Newsletter
            compact
            headingOverride={t.heading}
            subtitleOverride={t.subtitle}
            acquisitionSource={t.acquisitionSource}
          />,
          t.el,
          `newsletter-mount-${i}`,
        ),
      )}
    </>
  );
};

export default NewsletterMount;
