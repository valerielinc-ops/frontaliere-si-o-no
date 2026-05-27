/**
 * Ferrovia Retica (RhB) crawler parser tests
 *
 * Tests parseListingPage(), parseDetailPage(), buildJob(),
 * isGrigioniItalianoJob(), inferLocation().
 */
import { describe, it, expect } from 'vitest';

import {
  parseListingPage,
  parseDetailPage,
  buildJob,
  buildFallbackDescription,
  getLocationAddress,
  isGrigioniItalianoJob,
  inferLocation,
  stripHtml,
  normalizeSpace,
} from '@/scripts/lib/ferrovia-retica-job-parser.mjs';

// ─── Fixture: Career listing page ──────────────────────────
const LISTING_HTML = `
<html>
<body>
<main>
  <h1>Offene Stellen</h1>
  <div class="job-list">
    <div class="job-card vacancy">
      <a href="/de/arbeitgeber/stellen/lokfuehrer-poschiavo">Lokführer/in 80-100% — Poschiavo</a>
      <span class="location">Poschiavo</span>
      <span class="percentage">80-100%</span>
    </div>
    <div class="job-card vacancy">
      <a href="/de/arbeitgeber/stellen/gleisbauarbeiter-chur">Gleisbauarbeiter/in — Chur</a>
      <span class="location">Chur</span>
      <span class="percentage">100%</span>
    </div>
    <div class="job-card vacancy">
      <a href="/de/arbeitgeber/stellen/kaufmann-landquart">Kaufmann/Kauffrau EFZ (Lernende/r) — Landquart</a>
      <span class="location">Landquart</span>
    </div>
  </div>
</main>
</body>
</html>`;

// ─── Fixture: Detail page ──────────────────────────────────
const DETAIL_HTML = `
<html>
<body>
<main>
  <article>
    <h1>Lokführer/in 80-100%</h1>
    <div class="content">
      <p>Die Rhätische Bahn sucht für den Standort Poschiavo eine/n erfahrene/n
         Lokführer/in für den Personenverkehr auf der Berninastrecke. Die UNESCO-Welterbestrecke
         verbindet das Engadin mit dem Valposchiavo und ist eine der schönsten Bahnstrecken der Welt.</p>
      <h2>Anforderungen</h2>
      <ul>
        <li>Abgeschlossene Grundausbildung als Lokführer/in Kategorie B</li>
        <li>Erfahrung im Personenverkehr von Vorteil</li>
        <li>Gute Kenntnisse der deutschen und italienischen Sprache</li>
        <li>Bereitschaft zu unregelmässigen Arbeitszeiten</li>
        <li>Wohnsitz in der Region Valposchiavo oder Bereitschaft zum Umzug</li>
      </ul>
      <h2>Wir bieten</h2>
      <ul>
        <li>Arbeitsplatz an einer der schönsten Bahnstrecken der Welt</li>
        <li>Zeitgemässe Anstellungsbedingungen</li>
        <li>Vielfältige Weiterbildungsmöglichkeiten</li>
      </ul>
    </div>
  </article>
</main>
</body>
</html>`;

// ═══════════════════════════════════════════════════════════════
// parseListingPage
// ═══════════════════════════════════════════════════════════════

describe('parseListingPage', () => {
  it('extracts job listings', () => {
    const jobs = parseListingPage(LISTING_HTML);
    expect(jobs.length).toBe(3);
  });

  it('extracts job titles', () => {
    const jobs = parseListingPage(LISTING_HTML);
    const titles = jobs.map((j: { title: string }) => j.title);
    expect(titles[0]).toContain('Lokführer');
    expect(titles[1]).toContain('Gleisbauarbeiter');
  });

  it('generates valid URLs', () => {
    const jobs = parseListingPage(LISTING_HTML);
    for (const job of jobs) {
      expect((job as { url: string }).url).toMatch(/^https:\/\//);
    }
  });

  it('returns empty array for empty input', () => {
    expect(parseListingPage('')).toHaveLength(0);
    expect(parseListingPage(null as unknown as string)).toHaveLength(0);
  });

  it('returns empty for page without job cards', () => {
    expect(parseListingPage('<html><body><p>No jobs</p></body></html>')).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// parseDetailPage
// ═══════════════════════════════════════════════════════════════

describe('parseDetailPage', () => {
  it('extracts title', () => {
    const result = parseDetailPage(DETAIL_HTML);
    expect(result).not.toBeNull();
    expect(result!.title).toContain('Lokführer');
  });

  it('extracts requirements', () => {
    const result = parseDetailPage(DETAIL_HTML);
    expect(result!.requirements.length).toBeGreaterThanOrEqual(3);
    expect(result!.requirements[0]).toContain('Lokführer');
  });

  it('infers location from content', () => {
    const result = parseDetailPage(DETAIL_HTML);
    expect(result!.location).toBe('Poschiavo');
  });

  it('sets canton to GR', () => {
    const result = parseDetailPage(DETAIL_HTML);
    expect(result!.canton).toBe('GR');
  });

  it('returns null for empty input', () => {
    expect(parseDetailPage('')).toBeNull();
    expect(parseDetailPage(null as unknown as string)).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
// isGrigioniItalianoJob
// ═══════════════════════════════════════════════════════════════

describe('isGrigioniItalianoJob', () => {
  it('returns true for Poschiavo', () => {
    expect(isGrigioniItalianoJob('Poschiavo', '')).toBe(true);
  });

  it('returns true for Brusio', () => {
    expect(isGrigioniItalianoJob('Brusio', '')).toBe(true);
  });

  it('returns false for Chur', () => {
    expect(isGrigioniItalianoJob('Chur', '')).toBe(false);
  });

  it('detects location in description text', () => {
    expect(isGrigioniItalianoJob('', 'Standort Poschiavo im Valposchiavo')).toBe(true);
  });

  it('returns false for empty input', () => {
    expect(isGrigioniItalianoJob('', '')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// inferLocation
// ═══════════════════════════════════════════════════════════════

describe('inferLocation', () => {
  it('detects Poschiavo from title', () => {
    expect(inferLocation('Lokführer Poschiavo', '')).toBe('Poschiavo');
  });

  it('detects Chur from description', () => {
    expect(inferLocation('', 'Arbeitsort: Chur, Graubünden')).toBe('Chur');
  });

  it('defaults to Chur for unknown locations', () => {
    expect(inferLocation('Generic Job', 'Some description')).toBe('Chur');
  });
});

// ═══════════════════════════════════════════════════════════════
// buildJob
// ═══════════════════════════════════════════════════════════════

describe('buildJob', () => {
  it('builds complete job object', () => {
    const job = buildJob({
      title: 'Lokführer/in',
      url: 'https://www.rhb.ch/de/arbeitgeber/stellen/lokfuehrer',
      location: 'Poschiavo',
    });
    expect(job).not.toBeNull();
    expect(job!.company).toBe('Ferrovia Retica (RhB)');
    expect(job!.companyKey).toBe('ferrovia-retica');
    expect(job!.canton).toBe('GR');
  });

  it('generates consistent slugs across all locales to prevent churn', () => {
    const job = buildJob({ title: 'Macchinista', location: 'Poschiavo' });
    expect(job!.slugByLocale.it).toContain('ferrovia-retica-rhb');
    expect(job!.slugByLocale.en).toContain('ferrovia-retica-rhb');
    expect(job!.slugByLocale.de).toContain('ferrovia-retica-rhb');
    expect(job!.slugByLocale.fr).toContain('ferrovia-retica-rhb');
    // All locales should have the same slug (no locale-specific company names)
    expect(job!.slugByLocale.it).toBe(job!.slugByLocale.en);
    expect(job!.slugByLocale.it).toBe(job!.slugByLocale.de);
    expect(job!.slugByLocale.it).toBe(job!.slugByLocale.fr);
  });

  it('returns null for empty title', () => {
    expect(buildJob({ title: '' })).toBeNull();
    expect(buildJob(null as any)).toBeNull();
  });

  it('includes postalCode and streetAddress', () => {
    const job = buildJob({ title: 'Macchinista', location: 'Poschiavo' });
    expect(job!.postalCode).toBe('7742');
    expect(job!.streetAddress).toContain('Poschiavo');
  });

  it('includes postalCode for Chur (default)', () => {
    const job = buildJob({ title: 'Sachbearbeiter', location: 'Chur' });
    expect(job!.postalCode).toBe('7000');
  });

  it('includes employmentType', () => {
    const job = buildJob({ title: 'Test Job', location: 'Chur', percentage: '100%' });
    expect(job!.employmentType).toBe('FULL_TIME');
    const partTime = buildJob({ title: 'Test Job', location: 'Chur', percentage: '50-100%' });
    expect(partTime!.employmentType).toBe('PART_TIME');
  });

  it('generates description with >=50 words (fallback)', () => {
    const job = buildJob({ title: 'Lokführer/in', location: 'Poschiavo' });
    const wordCount = job!.description.split(/\s+/).length;
    expect(wordCount).toBeGreaterThanOrEqual(50);
  });

  it('uses detail description when provided and >50 words', () => {
    const longDesc = Array(60).fill('word').join(' ');
    const job = buildJob({ title: 'Test Job', location: 'Chur', description: longDesc });
    expect(job!.description).toBe(longDesc);
  });
});

// ═══════════════════════════════════════════════════════════════
// getLocationAddress
// ═══════════════════════════════════════════════════════════════

describe('getLocationAddress', () => {
  it('returns correct postal code for Poschiavo', () => {
    expect(getLocationAddress('Poschiavo').postalCode).toBe('7742');
  });

  it('returns correct postal code for Chur', () => {
    expect(getLocationAddress('Chur').postalCode).toBe('7000');
  });

  it('returns correct postal code for Davos', () => {
    expect(getLocationAddress('Davos').postalCode).toBe('7270');
  });

  it('defaults to Chur for unknown location', () => {
    expect(getLocationAddress('UnknownTown').postalCode).toBe('7000');
  });
});

// ═══════════════════════════════════════════════════════════════
// buildFallbackDescription
// ═══════════════════════════════════════════════════════════════

describe('buildFallbackDescription', () => {
  it('generates description with >=50 words', () => {
    const desc = buildFallbackDescription('Lokführer/in', 'Poschiavo', '80-100%');
    const wordCount = desc.split(/\s+/).length;
    expect(wordCount).toBeGreaterThanOrEqual(50);
  });

  it('includes job title and location', () => {
    const desc = buildFallbackDescription('Macchinista', 'Poschiavo', '');
    expect(desc).toContain('Macchinista');
    expect(desc).toContain('Poschiavo');
  });
});
