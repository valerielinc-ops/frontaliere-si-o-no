import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHitachiEnergyDetailPage } from '../scripts/lib/hitachi-energy-job-parser.mjs';

// Pinned fixture minimised from hitachienergy.com/careers/open-jobs/details/
// JID3-218019 (2026-09-29). The parser read the dataLayer "description" — the
// same text with every tag already removed, so the lists reached the site as
// run-on prose — and cut it at 4000 characters (4000 published against
// ~4500 on the source page, audit run 36528331656).
const fixture = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'hitachi-energy-detail-produktionsplaner.html'),
  'utf8',
);

describe('parseHitachiEnergyDetailPage', () => {
  it('reads the rendered description block with its lists', () => {
    const text = parseHitachiEnergyDetailPage(fixture);
    expect(text).toMatch(/^Über die Position$/m);
    expect(text).toMatch(/^Das kannst du bewirken$/m);
    expect(text).toMatch(/^• Planung, Steuerung und Überwachung der Produktionsprozesse/m);
  });

  it('does not truncate a posting longer than 4000 characters', () => {
    const text = parseHitachiEnergyDetailPage(fixture);
    expect(text.length).toBeGreaterThan(4000);
  });

  it('falls back to the dataLayer text when the block is absent', () => {
    const html = '<script>window.dataLayer.push({"description":"The opportunity  We are looking for a motivated intern."});</script>';
    expect(parseHitachiEnergyDetailPage(html)).toContain('We are looking for a motivated intern.');
  });
});
