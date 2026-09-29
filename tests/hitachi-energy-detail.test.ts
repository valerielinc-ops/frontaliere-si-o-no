import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseHitachiEnergyDetailPage,
  publishableHitachiEnergyRows,
  buildHitachiEnergyLocalizedContent,
} from '../scripts/lib/hitachi-energy-job-parser.mjs';

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

// Only the posting's own text is published (issue 5253). A listing whose
// detail page yielded no body used to go out with an invented blurb in four
// languages ("Hitachi Energy is hiring for the {title} role based in {city}.
// … Apply through the official Hitachi Energy careers page."); it is not
// published any more.
describe('Hitachi Energy — listing without vacancy text', () => {
  it('keeps only the rows whose detail page yielded a body', () => {
    const rows = [
      { jobId: '1', title: 'Produktionsplaner/in', description: 'Ihre Aufgaben: Planung der Fertigungsaufträge. Sie arbeiten eng mit Kolleginnen und Kollegen aus mehreren Bereichen zusammen, dokumentieren Ihre Arbeit sorgfältig und bringen Ideen zur Verbesserung der Abläufe ein. Wir bieten flexible Arbeitszeiten, Weiterbildungen und ein kollegiales Team in einem modernen Umfeld. Gute Deutschkenntnisse und eine strukturierte Arbeitsweise runden Ihr Profil ab.' },
      { jobId: '2', title: 'Service Engineer', description: '' },
      { jobId: '3', title: 'Buyer', description: '   ' },
    ];
    const { rows: kept, withoutBody } = publishableHitachiEnergyRows(rows);
    expect(kept.map((row) => row.jobId)).toEqual(['1']);
    expect(withoutBody).toBe(2);
  });

  it('never composes a stand-in description', () => {
    const content = buildHitachiEnergyLocalizedContent({ title: 'Service Engineer', location: 'Baden, Aargau, Switzerland', jobFunction: 'Service', jobType: 'Full time' });
    for (const text of Object.values(content.descriptionByLocale)) {
      expect(text).toBe('');
    }
  });
});
