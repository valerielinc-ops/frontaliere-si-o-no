import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  appendDiscoveryHealth,
  loadDiscoveryHealth,
  recordDiscoverySourceOutcome,
  startDiscoveryHealthRun,
} from '../scripts/lib/prospector/source-health.mjs';

describe('Prospector discovery source health', () => {
  let dir = '';

  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  it('persists complete, partial, unavailable, and malformed outcomes with bounded codes', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prospector-source-health-'));
    const file = path.join(dir, 'discovery-health.json');
    const run = startDiscoveryHealthRun({ runId: 'test-run', at: new Date() });
    recordDiscoverySourceOutcome(run, 'seco', { outcome: 'complete', recordsSeen: 12, newCandidatesFiled: 3 });
    recordDiscoverySourceOutcome(run, 'seco', { outcome: 'partial', recordsSeen: 4, newCandidatesFiled: 1, errorCode: 'http_503' });
    recordDiscoverySourceOutcome(run, 'osm', { outcome: 'unavailable', errorCode: 'network_error' });
    recordDiscoverySourceOutcome(run, 'web', { outcome: 'malformed', errorCode: 'malformed_json' });
    appendDiscoveryHealth(run, file);

    expect(loadDiscoveryHealth(file)[0]).toMatchObject({
      runId: 'test-run',
      sources: {
        seco: { attempts: 2, items: 16, recordsSeen: 16, newCandidatesFiled: 4, aggregateOutcome: 'partial', outcomes: { complete: 1, partial: 1 }, failureCodes: { http_503: 1 } },
        osm: { attempts: 1, outcomes: { unavailable: 1 }, failureCodes: { network_error: 1 } },
        web: { attempts: 1, outcomes: { malformed: 1 }, failureCodes: { malformed_json: 1 } },
      },
    });
  });

  it('does not overwrite malformed history', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prospector-source-health-invalid-'));
    const file = path.join(dir, 'discovery-health.json');
    fs.writeFileSync(file, 'not json', 'utf8');
    const run = startDiscoveryHealthRun();

    expect(() => appendDiscoveryHealth(run, file)).toThrow(/Malformed Prospector source health/);
    expect(fs.readFileSync(file, 'utf8')).toBe('not json');
  });

  it('retains only the newest 60 discovery runs', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prospector-source-health-cap-'));
    const file = path.join(dir, 'discovery-health.json');
    for (let index = 0; index < 61; index++) {
      const run = startDiscoveryHealthRun({ runId: `run-${index}`, at: new Date(Date.now() + index * 1000) });
      appendDiscoveryHealth(run, file);
    }

    const history = loadDiscoveryHealth(file);
    expect(history).toHaveLength(60);
    expect(history[0].runId).toBe('run-1');
    expect(history.at(-1).runId).toBe('run-60');
  });
});
