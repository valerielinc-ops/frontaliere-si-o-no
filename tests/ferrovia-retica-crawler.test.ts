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
  sourceLangFromUrl,
} from '@/scripts/lib/ferrovia-retica-job-parser.mjs';
import { mergeDiscoveredJobWithPrev } from '@/scripts/update-ferrovia-retica-jobs.mjs';
import { repairRelabeledSourceLocale } from '@/scripts/lib/dedicated-crawler-common.mjs';

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

  it('derives sourceLang from the crawled locale URL, not a hardcoded default', () => {
    const itJob = buildJob({ title: 'Test Job', location: 'Chur', url: 'https://www.rhb.ch/it/job/test-job_2026-0001/' });
    expect(itJob!.sourceLang).toBe('it');
    expect(itJob!.titleByLocale).toEqual({ it: 'Test Job' });

    const deJob = buildJob({ title: 'Testjob', location: 'Chur', url: 'https://www.rhb.ch/de/job/testjob_2026-0002/' });
    expect(deJob!.sourceLang).toBe('de');

    const frJob = buildJob({ title: 'Poste de test', location: 'Chur', url: 'https://www.rhb.ch/fr/job/poste-de-test_2026-0003/' });
    expect(frJob!.sourceLang).toBe('fr');
  });

  it('falls back to sourceLang de when the URL carries no locale segment', () => {
    const job = buildJob({ title: 'Test Job', location: 'Chur' });
    expect(job!.sourceLang).toBe('de');
    expect(job!.titleByLocale).toEqual({ de: 'Test Job' });
  });
});

describe('sourceLangFromUrl', () => {
  it('extracts it/de/en/fr from RhB per-locale job URLs', () => {
    expect(sourceLangFromUrl('https://www.rhb.ch/it/job/foo_2026-0001/')).toBe('it');
    expect(sourceLangFromUrl('https://www.rhb.ch/de/job/foo_2026-0001/')).toBe('de');
    expect(sourceLangFromUrl('https://www.rhb.ch/en/job/foo_2026-0001/')).toBe('en');
    expect(sourceLangFromUrl('https://www.rhb.ch/fr/job/foo_2026-0001/')).toBe('fr');
  });

  it('defaults to de when the URL has no locale segment', () => {
    expect(sourceLangFromUrl('https://www.rhb.ch/some/other/path')).toBe('de');
    expect(sourceLangFromUrl('')).toBe('de');
    expect(sourceLangFromUrl(undefined)).toBe('de');
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

// ═══════════════════════════════════════════════════════════════
// mergeDiscoveredJobWithPrev — derived sourceLang must win over the
// pre-#3802 hardcoded 'de' stored in existing slices, and mislabeled
// locale copies must be repaired (without losing genuine translations).
// ═══════════════════════════════════════════════════════════════

const SOURCE_TITLE = 'Responsabile officina (80-100%)';
const SOURCE_DESC = 'La Ferrovia Retica cerca un responsabile officina per la sede di Poschiavo. '
  + 'Il ruolo prevede la gestione del team, la pianificazione della manutenzione del materiale rotabile '
  + 'e la collaborazione con i reparti tecnici della rete a scartamento ridotto piu estesa della Svizzera.';

function freshItJob(overrides: Record<string, unknown> = {}) {
  const job = buildJob({
    title: SOURCE_TITLE,
    location: 'Poschiavo',
    description: SOURCE_DESC,
    url: 'https://www.rhb.ch/it/job/responsabile-officina-80-100_2026-0042/',
  });
  return { ...job!, ...overrides };
}

function prevMislabeledDe(overrides: Record<string, unknown> = {}) {
  // Shape of the existing data/jobs/by-crawler/ferrovia-retica.json entries:
  // crawled from /it/job/ but stored with the hardcoded sourceLang 'de' and
  // the Italian source text mislabeled under the 'de' key.
  return {
    title: SOURCE_TITLE,
    url: 'https://www.rhb.ch/it/job/responsabile-officina-80-100_2026-0042/',
    slug: 'responsabile-officina-80-100-ferrovia-retica-rhb-poschiavo',
    sourceLang: 'de',
    description: SOURCE_DESC,
    titleByLocale: {
      de: SOURCE_TITLE, // mislabeled source copy
      fr: 'Responsable d\'atelier (80-100%)', // genuine AI translation
      en: 'Workshop manager (80-100%)',
    },
    descriptionByLocale: {
      de: SOURCE_DESC, // mislabeled source copy
      fr: 'Le Chemin de fer rhetique recherche un responsable d\'atelier pour le site de Poschiavo, charge de la gestion de l\'equipe et de la planification de la maintenance du materiel roulant.',
    },
    slugByLocale: {
      it: 'responsabile-officina-80-100-ferrovia-retica-rhb-poschiavo',
      de: 'werkstattleiter-80-100-ferrovia-retica-rhb-poschiavo',
    },
    ...overrides,
  };
}

describe('mergeDiscoveredJobWithPrev', () => {
  it('lets the URL-derived sourceLang win over the stored hardcoded de', () => {
    const merged = mergeDiscoveredJobWithPrev(freshItJob(), prevMislabeledDe());
    expect(merged.sourceLang).toBe('it');
  });

  it('removes the mislabeled de copy, re-keys the source title under it, and flags needsRetranslation', () => {
    const merged = mergeDiscoveredJobWithPrev(freshItJob(), prevMislabeledDe());
    // de slot held an identical copy of the Italian source title → dropped
    expect(merged.titleByLocale.de).toBeUndefined();
    // source title now lives under the derived source locale
    expect(merged.titleByLocale.it).toBe(SOURCE_TITLE);
    // description map repaired the same way: mislabeled de copy dropped,
    // freshest source description re-keyed under the derived source locale
    expect(merged.descriptionByLocale.de).toBeUndefined();
    expect(merged.descriptionByLocale.it).toBe(merged.description);
    // AI pipeline must regenerate the locales from the correct source
    expect(merged.needsRetranslation).toBe(true);
  });

  it('preserves genuine translations in non-source locales during the relabel', () => {
    const merged = mergeDiscoveredJobWithPrev(freshItJob(), prevMislabeledDe());
    expect(merged.titleByLocale.fr).toBe('Responsable d\'atelier (80-100%)');
    expect(merged.titleByLocale.en).toBe('Workshop manager (80-100%)');
    expect(merged.descriptionByLocale.fr).toContain('Chemin de fer rhetique');
  });

  it('preserves a genuine de translation that differs from the source text', () => {
    const prev = prevMislabeledDe({
      titleByLocale: {
        de: 'Werkstattleiter/in (80-100%)', // real German translation, not a copy
        fr: 'Responsable d\'atelier (80-100%)',
      },
    });
    const merged = mergeDiscoveredJobWithPrev(freshItJob(), prev);
    expect(merged.sourceLang).toBe('it');
    expect(merged.titleByLocale.de).toBe('Werkstattleiter/in (80-100%)');
    expect(merged.titleByLocale.it).toBe(SOURCE_TITLE);
    // relabel still requires the pipeline to re-check the locale set
    expect(merged.needsRetranslation).toBe(true);
  });

  it('does not force needsRetranslation when sourceLang is unchanged', () => {
    const prev = prevMislabeledDe({ sourceLang: 'it' });
    const merged = mergeDiscoveredJobWithPrev(freshItJob(), prev);
    expect(merged.sourceLang).toBe('it');
    expect(merged.needsRetranslation).toBeFalsy();
    // no relabel → prev de entry (whatever it is) is left to prev-wins merge
    expect(merged.titleByLocale.de).toBe(SOURCE_TITLE);
  });

  it('keeps the stored sourceLang when the fresh job has none', () => {
    const merged = mergeDiscoveredJobWithPrev(freshItJob({ sourceLang: undefined }), prevMislabeledDe());
    expect(merged.sourceLang).toBe('de');
    expect(merged.needsRetranslation).toBeFalsy();
  });
});

describe('repairRelabeledSourceLocale', () => {
  it('is a no-op when the locale did not change', () => {
    const { map, removedMislabeledCopy } = repairRelabeledSourceLocale(
      { de: 'Titel' },
      { prevLang: 'de', nextLang: 'de', sourceTexts: ['Titel'] },
    );
    expect(map).toEqual({ de: 'Titel' });
    expect(removedMislabeledCopy).toBe(false);
  });

  it('removes the old-locale entry only when it matches a source-text candidate', () => {
    const removed = repairRelabeledSourceLocale(
      { de: ' Titolo   italiano ', fr: 'Titre francais' },
      { prevLang: 'de', nextLang: 'it', sourceTexts: ['Titolo Italiano'] },
    );
    expect(removed.map.de).toBeUndefined();
    expect(removed.map.it).toBe('Titolo Italiano');
    expect(removed.map.fr).toBe('Titre francais');
    expect(removed.removedMislabeledCopy).toBe(true);

    const kept = repairRelabeledSourceLocale(
      { de: 'Echter deutscher Titel' },
      { prevLang: 'de', nextLang: 'it', sourceTexts: ['Titolo italiano'] },
    );
    expect(kept.map.de).toBe('Echter deutscher Titel');
    expect(kept.removedMislabeledCopy).toBe(false);
  });
});
