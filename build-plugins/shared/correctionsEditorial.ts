import { CORRECTIONS_COPY, type CorrectionsLocale, type CorrectionsLog } from '../../services/editorialCorrections';
import correctionsLog from '../../data/corrections-log.json';

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

/** Static body uses the same translated policy and actual log as the React page. */
export function renderCorrectionsEditorial(locale: CorrectionsLocale, log: CorrectionsLog = correctionsLog): string[] {
  const copy = CORRECTIONS_COPY[locale];
  const h2 = (text: string) => `<h2>${escapeHtml(text)}</h2>`;
  const p = (text: string) => `<p>${escapeHtml(text)}</p>`;
  const entries = [...log.entries].sort((a, b) => b.date.localeCompare(a.date));
  return [p(copy.intro), h2(copy.report),
    `<p>${escapeHtml(copy.contact)} <a href="mailto:${escapeHtml(log.policy.contactEmail)}">${escapeHtml(log.policy.contactEmail)}</a>.</p>`,
    `<ul>${copy.requirements.map((text) => `<li>${escapeHtml(text)}</li>`).join('')}</ul>`,
    h2(copy.handling), p(copy.handlingText), h2(copy.typesTitle),
    ...Object.entries(copy.labels).map(([key, label]) => `<h3>${escapeHtml(label)}</h3>${p(copy.types[key as keyof typeof copy.types])}`),
    h2(copy.log), entries.length === 0 ? p(copy.empty) : p(copy.sourceNote) + `<ol>${entries.map((entry) => `<li><time datetime="${escapeHtml(entry.date)}">${escapeHtml(entry.date.slice(0, 10))}</time> — ${escapeHtml(copy.labels[entry.type as keyof typeof copy.labels] || entry.type)} — ${escapeHtml(copy.article)}: ${escapeHtml(entry.articleId)}${p(entry.description)}</li>`).join('')}</ol>`,
  ];
}
