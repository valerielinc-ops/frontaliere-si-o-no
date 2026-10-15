import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  parsePallasListing,
  extractJobPostingLd,
  buildPallasDescription,
} from '../scripts/lib/pallas-kliniken-job-parser.mjs';

const fixture = (name: string) => fs.readFileSync(
  path.join(__dirname, 'fixtures', 'pallas-kliniken', name),
  'utf8',
);

describe('parsePallasListing (issue 5253)', () => {
  // Minimised listing: one rendered card, plus the Next.js flight payload that
  // lists every position, the ones on client-side page 2 included.
  it('reads the positions only the flight payload lists, not just the anchors', () => {
    const positions = parsePallasListing(fixture('listing.html'));
    expect(positions.map((p) => p.id)).toEqual([
      'a3LTG00000QbCXw2AN',
      'a3LTG00000Kb2yb2AB',
      'a3LTG00000HYXar2AH',
    ]);
    expect(positions[1].detailUrl).toBe('https://pallasjobs.careers.flair.hr/positions/a3LTG00000Kb2yb2AB');
  });
});

describe('buildPallasDescription (issue 5253)', () => {
  // Real position JSON-LD: `description` is the intro only; tasks,
  // requirements and benefits are separate fields.
  const ld = extractJobPostingLd(fixture('detail-mpa-springer.html'));
  const text = buildPallasDescription(ld, 'de');

  it('publishes the intro and every section the page renders', () => {
    expect(text).toMatch(/^Die Pallas Kliniken sind auf die Bereiche Augenheilkunde/);
    expect(text).toContain('## Verantwortlichkeiten\n• Unterstützung der Teams an verschiedenen Standorten');
    expect(text).toContain('## Anforderungen\n• Abgeschlossene Ausbildung als MPA EFZ oder Augenoptiker/-in EFZ');
    expect(text).toContain('## Vorteile\n• Eine abwechslungsreiche Tätigkeit in einem modernen medizinischen Umfeld');
  });

  it('is not the intro alone any more', () => {
    const introOnly = buildPallasDescription({ description: ld.description }, 'de');
    expect(text.length).toBeGreaterThan(introOnly.length * 2);
  });

  it('keeps each list item on its own line', () => {
    expect(text.match(/^• /gm)?.length).toBe(14);
  });
});
