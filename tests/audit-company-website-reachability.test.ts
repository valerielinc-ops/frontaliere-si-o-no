import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  auditCompanyWebsiteReachability,
  buildCompanyWebsiteTargets,
  probePublishedWebsite,
} from '../scripts/audit-company-website-reachability.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

describe('company website reachability audit', () => {
  it('deduplicates apex/www records and reuses a verified resolver target', () => {
    const targets = buildCompanyWebsiteTargets([
      { key: 'alpha-one', name: 'Alpha One', website: 'https://www.alpha.ch/careers' },
      { key: 'alpha-two', name: 'Alpha Two', website: 'https://alpha.ch/' },
      { key: 'beta', name: 'Beta', website: 'https://beta.ch/' },
    ], {
      'alpha.ch': 'https://www.alpha.ch/',
    });

    expect(targets).toHaveLength(2);
    expect(targets[0]).toMatchObject({
      domain: 'alpha.ch',
      targetUrl: 'https://www.alpha.ch/',
      companies: ['alpha-one', 'alpha-two'],
    });
    expect(targets[1]).toMatchObject({
      domain: 'beta.ch',
      targetUrl: 'https://beta.ch/',
      companies: ['beta'],
    });
  });

  it('falls back from a HEAD 403 to GET before declaring a host unreachable', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 403, url: 'https://blocked.example/', body: '' })
      .mockResolvedValueOnce({ ok: true, status: 200, url: 'https://blocked.example/', body: '' });

    const result = await probePublishedWebsite('https://blocked.example/', { fetchImpl });

    expect(result).toMatchObject({ reachable: true, status: 200, method: 'GET' });
    expect(fetchImpl).toHaveBeenNthCalledWith(1, 'https://blocked.example/', expect.objectContaining({ method: 'HEAD' }));
    expect(fetchImpl).toHaveBeenNthCalledWith(2, 'https://blocked.example/', expect.objectContaining({ method: 'GET' }));
  });

  it('probes the apex/www alias before recording a published origin as dead', async () => {
    // The registry publishes the bare apex when the resolver has no verified
    // winner, and an apex with no A record is common on hosts that serve fine
    // on www. Measured on the 2026-09-18 run: 15 of 37 "unreachable" hosts
    // answered on their alias.
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 0, url: 'https://apex.example/', body: '', transportError: 'dns' })
      .mockResolvedValueOnce({ ok: false, status: 0, url: 'https://apex.example/', body: '', transportError: 'dns' })
      .mockResolvedValueOnce({ ok: true, status: 200, url: 'https://www.apex.example/', body: '' });

    const result = await probePublishedWebsite('https://apex.example/', { fetchImpl });

    expect(result).toMatchObject({ reachable: true, status: 200, viaAlias: 'https://www.apex.example/' });
    expect(result.publishedReason).toBe('dns');
    expect(fetchImpl).toHaveBeenNthCalledWith(3, 'https://www.apex.example/', expect.objectContaining({ method: 'HEAD' }));
  });

  it('keeps the published origin verdict when the alias is dead too', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false, status: 0, url: 'https://gone.example/', body: '', transportError: 'dns',
    });

    const result = await probePublishedWebsite('https://gone.example/', { fetchImpl });

    expect(result).toMatchObject({ reachable: false, reason: 'dns' });
    expect(result.viaAlias).toBeUndefined();
  });

  it('records a GET 403 as reachable-but-unverified instead of a dead host', async () => {
    // A WAF refusing an automated probe is the origin answering. Counting it
    // as dead charged the ceiling for 13 live hosts on the 2026-09-18 run.
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 403, url: 'https://waf.example/', body: '' });

    const result = await probePublishedWebsite('https://waf.example/', { fetchImpl });

    expect(result).toMatchObject({ reachable: true, verified: false, reason: 'access-denied' });
  });

  it('does not call an allowed-alias redirect a dead host when policy stops the final hop', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 0,
      url: 'https://alpha.example/',
      body: '',
      policyBlocked: true,
      error: 'prospector robots origin not allowed: https://www.alpha.example',
    });

    const result = await probePublishedWebsite('https://alpha.example/', { fetchImpl });

    expect(result).toMatchObject({
      reachable: true,
      verified: false,
      reason: 'unverified-policy-redirect',
    });
  });

  it('records a server rate-limit as reachable but unverified', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      url: 'https://busy.example/',
      body: '',
    });

    const result = await probePublishedWebsite('https://busy.example/', { fetchImpl });

    expect(result).toMatchObject({ reachable: true, verified: false, reason: 'rate-limited' });
  });

  it('fails the gate only when unreachable hosts exceed the measured baseline', async () => {
    const probeImpl = vi.fn(async (targetUrl: string) => ({
      reachable: !targetUrl.includes('bad'),
      status: targetUrl.includes('bad') ? 403 : 200,
      method: 'HEAD',
    }));

    const report = await auditCompanyWebsiteReachability([
      { key: 'good', website: 'https://good.example/' },
      { key: 'bad', website: 'https://bad.example/' },
    ], { baseline: { maxUnreachable: 0 }, probeImpl });

    expect(report.unreachableHosts).toBe(1);
    expect(report.exceeded).toBe(true);
    expect(report.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ domain: 'bad.example', reachable: false, status: 403 }),
    ]));
  });

  it('keeps the committed baseline and CI invocation explicit', () => {
    const baseline = JSON.parse(fs.readFileSync(
      path.join(ROOT, 'data/company-website-reachability-baseline.json'), 'utf8',
    ));
    const workflow = fs.readFileSync(
      path.join(ROOT, '.github/workflows/audit-company-website-reachability.yml'), 'utf8',
    );

    expect(baseline).toMatchObject({ schemaVersion: 1, maxUnreachable: 22, baselineWebsites: 592 });
    expect(workflow).toContain('node scripts/audit-company-website-reachability.mjs');
    expect(workflow).toContain('upload-artifact');
  });
});
