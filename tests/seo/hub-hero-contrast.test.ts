import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '../..');

const relativeLuminance = (hex: string): number => {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const linear = channels.map((channel) => (
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  ));
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
};

const contrastWithWhite = (hex: string): number => (1.05) / (relativeLuminance(hex) + 0.05);

describe('static hub hero contrast', () => {
  it('keeps the green hero gradient readable with its white text', () => {
    const source = fs.readFileSync(path.join(root, 'build-plugins/shared/hubChrome.ts'), 'utf8');
    const gradient = source.match(/green: 'background:linear-gradient\([^#]*(#[0-9a-f]{6})[^#]*(#[0-9a-f]{6})[^']*color:#fff'/i);

    expect(gradient).not.toBeNull();
    for (const stop of gradient?.slice(1) ?? []) {
      expect(contrastWithWhite(stop)).toBeGreaterThanOrEqual(4.5);
    }
  });
});
