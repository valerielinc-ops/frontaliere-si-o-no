/**
 * Regression for the shared MapCanvas readiness contract.
 *
 * The shell owns the Leaflet imports, but active marker content must not wait
 * on a second asynchronous chunk: a slow worker used to leave live popups
 * absent until after the caller's assertion timeout.
 */
import React from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import MapCanvas from '@/components/shared/MapCanvas';

afterEach(cleanup);

describe('MapCanvas readiness', () => {
  it('renders active children in the first committed shell', () => {
    render(
      <MapCanvas ariaLabel="interactive map">
        <span>live popup content</span>
      </MapCanvas>,
    );

    const shell = screen.getByLabelText('interactive map');
    expect(shell).toHaveTextContent('live popup content');
    expect(shell).not.toHaveAttribute('aria-busy');
  });
});
