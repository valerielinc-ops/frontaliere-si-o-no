import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');

describe('widget and Mailgun probe requests', () => {
  it('keeps the Playwright fetch and manual Mailgun send bounded', () => {
    const widget = readFileSync(resolve(ROOT, 'scripts/lib/pastahr-widget-client.mjs'), 'utf8');
    const probe = readFileSync(resolve(ROOT, 'scripts/probe-mailgun-scheduled.mjs'), 'utf8');

    expect(widget).toContain('const controller = new AbortController();');
    expect(widget).toContain('signal: controller.signal');
    expect(widget).toContain('{ ep: endpoint, body: bodyString, ct: contentType, timeoutMs }');
    expect(probe).toContain('const PROBE_REQUEST_TIMEOUT_MS = 30_000;');
    expect(probe).toContain('signal: AbortSignal.timeout(PROBE_REQUEST_TIMEOUT_MS)');
  });
});
