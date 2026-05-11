import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const DIST = path.resolve(__dirname, '../../dist');

describe('sitemap shards partition jobs by canton (P1-C)', () => {
  it('non-TI canton job URLs appear in the matching canton shard, not TI', () => {
    if (!fs.existsSync(DIST)) return;
    const tiShardPath = path.join(DIST, 'sitemap-jobs-ticino.xml');
    const zhShardPath = path.join(DIST, 'sitemap-jobs-zurigo.xml');
    if (!fs.existsSync(tiShardPath) || !fs.existsSync(zhShardPath)) return;
    const tiShard = fs.readFileSync(tiShardPath, 'utf8');
    const zhShard = fs.readFileSync(zhShardPath, 'utf8');
    // A URL containing /cerca-lavoro-zurigo/ must NOT appear in the TI shard
    const tiLeak = tiShard.match(/<loc>https:\/\/[^<]*\/cerca-lavoro-zurigo\//g) || [];
    expect(tiLeak.length, `TI shard contains ZH URLs: ${tiLeak.slice(0, 3).join(',')}`).toBe(0);
    // And the ZH shard must contain at least one /cerca-lavoro-zurigo/ URL
    const zhContent = zhShard.match(/<loc>https:\/\/[^<]*\/cerca-lavoro-zurigo\//g) || [];
    expect(zhContent.length).toBeGreaterThan(0);
  });
});
