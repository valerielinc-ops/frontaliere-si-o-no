import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BOUNCE_ADDRESS, BOUNCE_LOCAL_PART, EMAIL_WORKER_NAME } from '../scripts/lib/bounce-return-path.mjs';
import { isBoundToWorker } from '../scripts/set-maileroo-return-path.mjs';

// Moving Maileroo's `return_path` from abuse@ to bounce@ is safe ONLY once
// bounce@ is routed to the worker: an unbound address falls into the zone
// catch-all, which forwards to the inbox WITHOUT running the parsing code, and
// the delivery reports would go back to being invisible. The order is enforced
// by the guard tested here, not by remembering to do it in the right sequence.

const ROOT = resolve(__dirname, '..');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

function stubRules(rules: unknown[]) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ success: true, result: rules }),
  }));
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('isBoundToWorker', () => {
  it('is true for an enabled rule sending the address to the worker', async () => {
    stubRules([{
      enabled: true,
      matchers: [{ type: 'literal', field: 'to', value: BOUNCE_ADDRESS }],
      actions: [{ type: 'worker', value: [EMAIL_WORKER_NAME] }],
    }]);
    expect(await isBoundToWorker('zone', BOUNCE_ADDRESS)).toBe(true);
  });

  it('is false for a forward-only rule', async () => {
    // The catch-all case in miniature: mail is delivered to a human, but the
    // worker never runs, so nothing is parsed or recorded.
    stubRules([{
      enabled: true,
      matchers: [{ type: 'literal', field: 'to', value: BOUNCE_ADDRESS }],
      actions: [{ type: 'forward', value: ['human@example.com'] }],
    }]);
    expect(await isBoundToWorker('zone', BOUNCE_ADDRESS)).toBe(false);
  });

  it('is false for a disabled rule, and for a rule on another address', async () => {
    stubRules([{
      enabled: false,
      matchers: [{ type: 'literal', field: 'to', value: BOUNCE_ADDRESS }],
      actions: [{ type: 'worker', value: [EMAIL_WORKER_NAME] }],
    }]);
    expect(await isBoundToWorker('zone', BOUNCE_ADDRESS)).toBe(false);

    stubRules([{
      enabled: true,
      matchers: [{ type: 'literal', field: 'to', value: 'alerts@frontaliereticino.ch' }],
      actions: [{ type: 'worker', value: [EMAIL_WORKER_NAME] }],
    }]);
    expect(await isBoundToWorker('zone', BOUNCE_ADDRESS)).toBe(false);
  });

  it('is false when the zone has no rules at all', async () => {
    stubRules([]);
    expect(await isBoundToWorker('zone', BOUNCE_ADDRESS)).toBe(false);
  });
});

describe('the routing rule and the return_path agree', () => {
  it('binds bounce@ in the worker setup, from the shared module', () => {
    const setup = read('scripts/cf-email-worker-setup.mjs');
    expect(setup).toContain("from './lib/bounce-return-path.mjs'");
    // Inside the address list, not merely imported.
    const list = setup.slice(setup.indexOf('AUTO_REPLY_SINK_ADDRESSES'), setup.indexOf('const ROUTING_RULES'));
    expect(list).toContain('BOUNCE_ADDRESS');
  });

  it('keeps the address as a single literal', () => {
    // Two literals would let the routing rule and the provider field drift
    // apart, and the drift is silent: mail keeps being delivered, only the
    // recording stops.
    for (const file of ['scripts/cf-email-worker-setup.mjs', 'scripts/set-maileroo-return-path.mjs']) {
      expect(read(file)).not.toContain(`'${BOUNCE_ADDRESS}'`);
    }
    expect(BOUNCE_ADDRESS).toBe(`${BOUNCE_LOCAL_PART}@frontaliereticino.ch`);
  });
});
