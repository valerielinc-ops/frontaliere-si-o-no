import { describe, expect, it } from 'vitest';
import { buildHovalLocalizedContent } from '../scripts/lib/hoval-job-parser.mjs';
import { buildKnowledgeLabLocalizedContent } from '../scripts/lib/knowledge-lab-job-parser.mjs';
import { buildMticLocalizedContent } from '../scripts/lib/mtic-job-parser.mjs';
import { buildTarchiniLocalizedContent } from '../scripts/lib/tarchini-group-job-parser.mjs';
import { buildRelewantLocalizedContent } from '../scripts/lib/relewant-job-parser.mjs';

// Twins of the Convit builder: each wrote a sentence of its own into the
// en/de/fr slots ("<company> is hiring for the <title> role … Apply through
// the official … careers page.") — MTIC even when the posting had a text — and,
// without a posting text, an Italian one too. Those slots were "full", so the
// translation step never replaced them.
const INVENTED = /is hiring for the|is looking for a|sucht derzeit|recrute actuellement|ha aperto una selezione|Apply through the official|Candidati tramite/;

const builders: Array<[string, (job: Record<string, unknown>) => any]> = [
  ['hoval', buildHovalLocalizedContent],
  ['knowledge-lab', buildKnowledgeLabLocalizedContent],
  ['mtic', buildMticLocalizedContent],
  ['tarchini-group', buildTarchiniLocalizedContent],
  ['relewant', buildRelewantLocalizedContent],
];

describe.each(builders)('%s localized content — the posting text only', (_name, build) => {
  // Minimized from a stored Tarchini Group posting (slice of 2026-09-29).
  const POSTING = 'GIG Europe SA, ein Unternehmen der Tarchini-Gruppe, das sich mit der Planung, Entwicklung und Verwaltung von grünen Energieanlagen befasst, sucht eine technisch-kaufmännische Fachperson.';

  it('writes the posting only in the slot of its language', () => {
    const result = build({ title: 'Technisch-kaufmännische Fachperson', location: 'Manno', city: 'Manno', description: POSTING, sourceLang: 'de' });
    expect(Object.keys(result.descriptionByLocale)).toEqual(['de']);
    expect(result.descriptionByLocale.de).toContain(POSTING);
    expect(result.description).toBe(result.descriptionByLocale.de);
    expect(JSON.stringify(result.descriptionByLocale)).not.toMatch(INVENTED);
  });

  it('gives a posting without text no description instead of a sentence of its own', () => {
    const result = build({ title: 'Software Engineer', location: 'Lugano', city: 'Lugano', description: '' });
    expect(result.description).toBe('');
    expect(result.descriptionByLocale).toEqual({});
    expect(result.slugByLocale.it).toContain('software-engineer');
  });
});
