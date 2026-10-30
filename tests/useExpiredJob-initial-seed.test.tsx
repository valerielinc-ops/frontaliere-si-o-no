// @vitest-environment jsdom
import React, { useLayoutEffect } from 'react';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { adoptStaticFallbackIntoRoot } from '@/services/staticFallbackHandoff';

const EXPIRED_SLUG = 'crew-mcdonalds-switzerland-morbio-inferiore-p8-319611-6';
const EXPIRED_PATH = `/cerca-lavoro-ticino/${EXPIRED_SLUG}/`;

afterEach(() => {
  vi.unstubAllGlobals();
  delete (window as unknown as Record<string, unknown>).__EXPIRED_JOB_DATA__;
  document.body.innerHTML = '';
  window.history.replaceState(null, '', '/');
});

describe('useExpiredJob initial document seed', () => {
  it('consumes the matching seed after the static fallback is hidden in a layout effect', async () => {
    window.history.replaceState(null, '', EXPIRED_PATH);
    document.body.innerHTML = `
      <div id="root"></div>
      <main class="seo-static-content" data-expired-static-body="true" data-expired-static-path="${EXPIRED_PATH}">
        <article class="ft-static-article"><h1>Static job detail</h1></article>
      </main>`;
    (window as unknown as Record<string, unknown>).__EXPIRED_JOB_DATA__ = {
      slug: EXPIRED_SLUG,
      title: 'Crew member',
      company: 'McDonald’s Switzerland',
    };

    const root = document.getElementById('root')!;
    const staticBody = document.querySelector<HTMLElement>('main[data-expired-static-body]')!;
    adoptStaticFallbackIntoRoot(root, staticBody);
    // createRoot().render() clears the adopted static fallback before the
    // lazy JobBoard chunk mounts. The hidden body-level marker must survive.
    root.replaceChildren();

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [],
    });
    vi.stubGlobal('fetch', fetchMock);
    const { useExpiredJob } = await import('@/hooks/useExpiredJob');

    function HydrationHarness() {
      const { expiredJob } = useExpiredJob(EXPIRED_SLUG);
      useLayoutEffect(() => {
        document.querySelector<HTMLElement>('main[data-expired-static-body]')
          ?.style.setProperty('display', 'none', 'important');
      }, []);
      return <div>{expiredJob?.title ?? 'missing expired job'}</div>;
    }

    render(<React.StrictMode><HydrationHarness /></React.StrictMode>);

    const seedMarker = document.querySelector<HTMLElement>('main[data-expired-static-body]');
    expect(seedMarker?.isConnected).toBe(true);
    expect(seedMarker?.hidden).toBe(true);
    expect(seedMarker?.textContent).toBe('');
    expect(seedMarker?.style.getPropertyValue('display')).toBe('none');
    expect(screen.getByText('Crew member')).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not preserve an expired seed marker for a different URL', () => {
    window.history.replaceState(null, '', EXPIRED_PATH);
    document.body.innerHTML = `
      <div id="root"></div>
      <main class="seo-static-content" data-expired-static-body="true" data-expired-static-path="/another-job/"></main>`;

    const root = document.getElementById('root')!;
    const staticBody = document.querySelector<HTMLElement>('main[data-expired-static-body]')!;
    adoptStaticFallbackIntoRoot(root, staticBody);
    root.replaceChildren();

    expect(document.querySelector('main[data-expired-static-body]')).toBeNull();
  });
});
