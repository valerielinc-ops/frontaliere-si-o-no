/**
 * Regression coverage for follow-up(#4544) item 1: does `WriteCollector.add()`
 * (build-plugins/batchWrite.ts) stay silent on a path collision, e.g. if a
 * future plugin erroneously emitted under a path already owned by
 * fiscalMunicipalityPagesPlugin (`/tasse-frontalieri-comune/...`)?
 *
 * Verified: no. `add()` routes every claim through the shared write registry
 * (`sharedWriteRegistry.claim()`), which is already covered generically in
 * `tests/shared-write-registry.test.ts`. This file exercises the same
 * invariant through the `WriteCollector` surface plugins actually call, so a
 * regression in the `add()` → `claim()` wiring itself (not just the registry
 * internals) would be caught here.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { WriteCollector } from '@/build-plugins/batchWrite';
import {
  reset,
  clearDeclarationsForTest,
  setModeForTest,
  getCollisions,
  WriteCollisionError,
} from '@/build-plugins/sharedWriteRegistry';

describe('WriteCollector collision visibility', () => {
  beforeEach(() => {
    reset();
    clearDeclarationsForTest();
  });

  afterEach(() => {
    setModeForTest(null);
  });

  it('cross-plugin collision on the same path is recorded, not silently overwritten (report mode)', () => {
    setModeForTest('report');
    const owner = new WriteCollector({ pluginName: 'fiscalMunicipalityPagesPlugin' });
    const intruder = new WriteCollector({ pluginName: 'someFuturePlugin' });

    owner.add('/dist/tasse-frontalieri-comune/como/index.html', '<html>canonical</html>');
    intruder.add('/dist/tasse-frontalieri-comune/como/index.html', '<html>rogue</html>');

    const collisions = getCollisions();
    expect(collisions).toHaveLength(1);
    expect(collisions[0].first.plugin).toBe('fiscalMunicipalityPagesPlugin');
    expect(collisions[0].attempted.plugin).toBe('someFuturePlugin');
  });

  it('cross-plugin collision throws through add() when WRITE_COLLISION_MODE=throw', () => {
    setModeForTest('throw');
    const owner = new WriteCollector({ pluginName: 'fiscalMunicipalityPagesPlugin' });
    const intruder = new WriteCollector({ pluginName: 'someFuturePlugin' });

    owner.add('/dist/tasse-frontalieri-comune/como/index.html', '<html>canonical</html>');
    expect(() =>
      intruder.add('/dist/tasse-frontalieri-comune/como/index.html', '<html>rogue</html>'),
    ).toThrow(WriteCollisionError);
  });

  it('a double add() of the same path with different content within one collector is tracked, not silently dropped', () => {
    setModeForTest('report');
    const collector = new WriteCollector({ pluginName: 'fiscalMunicipalityPagesPlugin' });

    collector.add('/dist/tasse-frontalieri-comune/lugano/index.html', '<html>v1</html>');
    collector.add('/dist/tasse-frontalieri-comune/lugano/index.html', '<html>v2</html>');

    expect(collector.overwrittenInPlugin).toBe(1);
    expect(getCollisions()).toHaveLength(1);
  });

  it('a double add() of the same path with IDENTICAL content is the only genuinely silent case, and is safe (idempotent)', () => {
    setModeForTest('report');
    const collector = new WriteCollector({ pluginName: 'fiscalMunicipalityPagesPlugin' });

    collector.add('/dist/tasse-frontalieri-comune/varese/index.html', '<html>same</html>');
    collector.add('/dist/tasse-frontalieri-comune/varese/index.html', '<html>same</html>');

    expect(collector.overwrittenInPlugin).toBe(0);
    expect(collector.skippedByCollision).toBe(1);
    expect(getCollisions()).toHaveLength(0);
  });
});
