import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseJsonResponse } from '@/services/jsonResponseParser';

describe('parseJsonResponse', () => {
 afterEach(() => {
  vi.unstubAllGlobals();
 });

 it('keeps small responses on the local path', async () => {
  vi.stubGlobal('Worker', undefined);

  await expect(parseJsonResponse(new Response('{"ok":true}'))).resolves.toEqual({ ok: true });
 });

 it('falls back to local parsing when the worker cannot start', async () => {
  class BlockedWorker {
   constructor() {
    throw new Error('worker blocked');
   }
  }
  vi.stubGlobal('Worker', BlockedWorker);

  const response = new Response(JSON.stringify({ payload: 'x'.repeat(300_000) }));
  await expect(parseJsonResponse(response)).resolves.toEqual({ payload: 'x'.repeat(300_000) });
 });
});
