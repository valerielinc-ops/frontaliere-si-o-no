import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, renderHook, waitFor } from '@testing-library/react';

import { useHydrationIslands } from '@/hooks/useHydrationIslands';

describe('useHydrationIslands', () => {
  afterEach(() => {
    cleanup();
    document.body.innerHTML = '';
  });

  it('prunes detached targets when an SPA static body is replaced', async () => {
    const first = document.createElement('div');
    first.dataset.island = 'first';
    first.setAttribute('data-test-island', '');
    document.body.append(first);

    const { result } = renderHook(() => useHydrationIslands<string>({
      attribute: 'data-test-island',
      mountedAttribute: 'data-test-mounted',
      readProps: (el) => el.dataset.island ?? null,
    }));

    await waitFor(() => expect(result.current).toHaveLength(1));
    expect(result.current[0].el).toBe(first);
    expect(result.current[0].props).toBe('first');

    first.remove();
    const second = document.createElement('div');
    second.dataset.island = 'second';
    second.setAttribute('data-test-island', '');
    document.body.append(second);

    await waitFor(() => {
      expect(result.current).toHaveLength(1);
      expect(result.current[0].el).toBe(second);
    });
    expect(result.current[0].props).toBe('second');
  });
});
