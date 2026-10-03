import { expect } from 'vitest';

/** Check the rendered date paragraph, without constraining unrelated dated content. */
export function expectGenerationDateLabel(html: string, locale: 'it' | 'en' | 'de' | 'fr'): void {
  const label = { it: 'Pagina generata', en: 'Page generated', de: 'Seite erstellt', fr: 'Page générée' }[locale];
  const paragraph = html.match(/<p[^>]*text-sm font-medium text-accent mt-1[^>]*>(.*?)<\/p>/)?.[1];
  expect(paragraph, 'generation date paragraph exists').toBeDefined();
  expect(paragraph).toContain(label);
  expect(paragraph).not.toMatch(/Aggiornato|Updated|Aktualisiert|Mis à jour/);
}
