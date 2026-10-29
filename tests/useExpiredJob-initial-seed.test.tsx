// @vitest-environment jsdom
import React, { useLayoutEffect } from 'react';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
    document.body.innerHTML = `<main data-expired-static-body="true" data-expired-static-path="${EXPIRED_PATH}"></main>`;
    (window as unknown as Record<string, unknown>).__EXPIRED_JOB_DATA__ = {
      slug: EXPIRED_SLUG,
      title: 'Crew member',
      company: 'McDonald’s Switzerland',
    };

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

    const staticBody = document.querySelector<HTMLElement>('main[data-expired-static-body]');
    expect(staticBody?.isConnected).toBe(true);
    expect(staticBody?.style.getPropertyValue('display')).toBe('none');
    expect(screen.getByText('Crew member')).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
