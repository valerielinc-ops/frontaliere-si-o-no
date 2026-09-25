/**
 * `sanitizeBrowserJobTitle()` (lookbehind-free, feeds the JobPosting JSON-LD
 * via `jobPostingSchema.ts`) must reach the same decision as
 * `sanitizeJobTitleForDisplay()` (the visible H1, backed by
 * `scripts/lib/job-title-normalization.mjs`). Follow-up FU-2026-09-24-033 of
 * bucket #9609: the browser copy used a looser prefix (optional colon, no word
 * boundary) and cut real titles such as `Translation Specialist **Project
 * Manager**` down to `Project Manager` in the structured data only.
 */
import { describe, expect, it } from 'vitest';
import { sanitizeBrowserJobTitle } from '../../build-plugins/shared/literalMarkdown';
import { sanitizeJobTitleForDisplay } from '../../build-plugins/shared/stripLiteralMarkdown';

// Real employer titles that merely contain a narrative keyword: the bold
// segment is part of the title, not an AI answer.
const EMPLOYER_TITLES: ReadonlyArray<readonly [string, string]> = [
  ['Translation Project Manager **(80-100%)**', 'Translation Project Manager (80-100%)'],
  ['Translation Specialist **Project Manager**', 'Translation Specialist Project Manager'],
  ['Localization & Translation Specialist **Remote**', 'Localization & Translation Specialist Remote'],
  ['Title Insurance Officer **m/w/d**', 'Title Insurance Officer m/w/d'],
  ['Subtitle editor **Senior**', 'Subtitle editor Senior'],
  ['Outlet mechanic **Senior**', 'Outlet mechanic Senior'],
  ['Steuerübersetzung Leiter **(m/w/d)**', 'Steuerübersetzung Leiter (m/w/d)'],
  ['Traduzione tecnica **Italiano-Tedesco**', 'Traduzione tecnica Italiano-Tedesco'],
  ['Based on the contextual **Project Manager**', 'Based on the contextual Project Manager'],
];

// AI narratives whose bold segment IS the title.
const NARRATIVES: ReadonlyArray<readonly [string, string]> = [
  ['Here is the translation: **Senior Engineer**', 'Senior Engineer'],
  ['Ecco la traduzione: **Ingegnere**', 'Ingegnere'],
  ['Voici la traduction : **Ingénieur**', 'Ingénieur'],
  ['Hier ist die Übersetzung: **Ingenieur**', 'Ingenieur'],
  ['The complete translation is: **Assistente vendite 80%**', 'Assistente vendite 80%'],
  ['The translation is **Engineer**', 'Engineer'],
  ['The title needs to be **Engineer**', 'Engineer'],
  ['The title appears to be **Assistant Store Manager**', 'Assistant Store Manager'],
  ['Based on the context, **Pflegefachperson HF**', 'Pflegefachperson HF'],
  ['Let me translate **Engineer** for you', 'Engineer'],
  ['Here is the title: **Foo** and some **Bar** notes', 'Foo'],
  ['Traduzione: **Titolo vero**. Ecco: **nota**', 'Titolo vero'],
  ['Die Übersetzung: **Verkaufsberater:in**', 'Verkaufsberater:in'],
];

const PLAIN: readonly string[] = [
  '**Senior Engineer**',
  'Senior **Java** Developer',
  'Verkaufsberater:in ***delicatessa 40-60% (w/m/d)',
  'Translation: ***Brand*** **Ingegnere**',
  'Ecco il titolo: **Ingegnere** — ***Brand***',
];

describe('sanitizeBrowserJobTitle — parity with the display sanitizer (#9609 FU-033)', () => {
  it.each(EMPLOYER_TITLES)('keeps the employer title whole: %s', (input, expected) => {
    expect(sanitizeBrowserJobTitle(input)).toBe(expected);
  });

  it.each(NARRATIVES)('extracts the introduced title: %s', (input, expected) => {
    expect(sanitizeBrowserJobTitle(input)).toBe(expected);
  });

  it('decides exactly like sanitizeJobTitleForDisplay on every fixture', () => {
    const inputs = [...EMPLOYER_TITLES.map(([input]) => input), ...NARRATIVES.map(([input]) => input), ...PLAIN];
    const diverging = inputs.filter((input) => sanitizeBrowserJobTitle(input) !== sanitizeJobTitleForDisplay(input));
    expect(diverging).toEqual([]);
  });
});
