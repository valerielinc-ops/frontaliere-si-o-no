import { describe, expect, it } from 'vitest';
import {
  GRPC_ALREADY_EXISTS,
  GRPC_FAILED_PRECONDITION,
  createMicroBatcher,
  isAlreadyExists,
  isFailedPrecondition,
} from '../scripts/lib/micro-batcher.mjs';
import * as bookkeeping from '../scripts/lib/job-alert-batch-bookkeeping.mjs';

describe('micro-batcher generico', () => {
  it('raccoglie le richieste in un solo flush e risolve per posizione', async () => {
    const flushes: number[][] = [];
    const batcher = createMicroBatcher(async (requests: number[]) => {
      flushes.push(requests);
      return requests.map((r) => r * 2);
    }, { maxItems: 3, windowMs: 1 });
    const results = await Promise.all([batcher.submit(1), batcher.submit(2), batcher.submit(3), batcher.submit(4)]);
    expect(results).toEqual([2, 4, 6, 8]);
    expect(flushes[0]).toEqual([1, 2, 3]);
    expect(flushes.flat()).toEqual([1, 2, 3, 4]);
  });

  it('un flush che lancia rifiuta tutte le richieste del gruppo', async () => {
    const batcher = createMicroBatcher(async () => { throw new Error('boom'); }, { maxItems: 2, windowMs: 1 });
    const settled = await Promise.allSettled([batcher.submit('a'), batcher.submit('b')]);
    expect(settled.map((s) => s.status)).toEqual(['rejected', 'rejected']);
  });

  it('flushNow svuota subito il gruppo e size lo riflette', async () => {
    const seen: string[][] = [];
    const batcher = createMicroBatcher(async (r: string[]) => { seen.push(r); return r; }, { maxItems: 100, windowMs: 60_000 });
    const p = batcher.submit('x');
    expect(batcher.size).toBe(1);
    batcher.flushNow();
    expect(await p).toBe('x');
    expect(batcher.size).toBe(0);
    expect(seen).toEqual([['x']]);
  });

  it('e riesportato da job-alert-batch-bookkeeping con la stessa API', () => {
    expect(bookkeeping.createMicroBatcher).toBe(createMicroBatcher);
    expect(bookkeeping.isFailedPrecondition).toBe(isFailedPrecondition);
    expect(bookkeeping.GROUP_MAX_ITEMS).toBe(8);
    expect(bookkeeping.GROUP_WINDOW_MS).toBe(8);
  });
});

describe('codici gRPC', () => {
  it('riconosce FAILED_PRECONDITION come numero, come stringa e nel messaggio', () => {
    expect(isFailedPrecondition({ code: GRPC_FAILED_PRECONDITION })).toBe(true);
    expect(isFailedPrecondition({ code: 9 })).toBe(true);
    expect(isFailedPrecondition({ code: 'failed-precondition' })).toBe(true);
    expect(isFailedPrecondition({ code: 'FAILED_PRECONDITION' })).toBe(true);
    expect(isFailedPrecondition(new Error('9 FAILED_PRECONDITION: The query requires an index'))).toBe(true);
    expect(isFailedPrecondition({ code: 6 })).toBe(false);
    expect(isFailedPrecondition(null)).toBe(false);
  });

  it('riconosce ALREADY_EXISTS come numero, come stringa e nel messaggio', () => {
    expect(isAlreadyExists({ code: GRPC_ALREADY_EXISTS })).toBe(true);
    expect(isAlreadyExists({ code: 6 })).toBe(true);
    expect(isAlreadyExists({ code: 'already-exists' })).toBe(true);
    expect(isAlreadyExists({ code: 'ALREADY_EXISTS' })).toBe(true);
    expect(isAlreadyExists(new Error('6 ALREADY_EXISTS: Document already exists: projects/x'))).toBe(true);
    expect(isAlreadyExists({ code: 9 })).toBe(false);
    expect(isAlreadyExists(undefined)).toBe(false);
  });
});
