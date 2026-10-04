import { SLUG_TABLES } from '../../services/routeSlugs.data';
import { METHODOLOGY_COPY, type MethodologyLocale } from '../../services/editorialMethodology';

/** Static disclosure uses the same sections and fragment ids as the hydrated page. */
export function buildMethodologyEditorial(locale: MethodologyLocale, escapeHtml: (text: string) => string): string[] {
  const copy = METHODOLOGY_COPY[locale];
  const prefix = locale === 'it' ? '' : `/${locale}`;
  const slugs = SLUG_TABLES[locale];
  return [
    ...copy.sections.flatMap(section => [
      `<h2 id="${section.id}" class="s-o3IET6">${escapeHtml(section.title)}</h2>`,
      ...section.paragraphs.map(escapeHtml),
    ]),
    '<p><a href="mailto:redazione@frontaliereticino.ch">redazione@frontaliereticino.ch</a></p>',
    `<p>${escapeHtml(copy.links)}: <a href="${prefix}/${slugs.chiSiamo}/">${escapeHtml(copy.about)}</a> · <a href="${prefix}/${slugs.correzioni}/">${escapeHtml(copy.corrections)}</a></p>`,
  ];
}
