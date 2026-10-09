/**
 * `itReady` is a module-level Promise.all over the core IT chunks. When one
 * chunk fails (short network drop) and no caller awaits the promise, the
 * rejection must not escape as an unhandled rejection. Callers that await it
 * still see the rejection.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const CHUNK_ERROR = 'error loading dynamically imported module: https://cdn.frontaliereticino.ch/assets/it-seo-links.js';

vi.mock('@/services/locales/it-seo-links', () => {
  throw new TypeError(CHUNK_ERROR);
});

describe('itReady chunk failure', () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);

  afterEach(() => {
    process.off('unhandledRejection', onUnhandled);
  });

  it('does not leak an unhandled rejection, and still rejects for callers', async () => {
    process.on('unhandledRejection', onUnhandled);
    const i18n = await import('@/services/i18n');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(unhandled).toEqual([]);
    await expect(i18n.itReady).rejects.toThrow();
  });
});
