import { useEffect, useState } from 'react';
import { Newspaper } from 'lucide-react';
import { buildPath } from '@/services/router';
import { useLocale, type Locale } from '@/services/i18n';
import {
  loadLiveCantonArticleSections,
  localizeCantonArticleSections,
  type RuntimeCantonArticleSection,
} from '@/services/runtimeArticleSections';
import type { ArticleSection } from '@/services/articleSections';

const TITLE: Record<Locale, string> = {
  it: 'Articoli per cantone',
  en: 'Articles by canton',
  de: 'Artikel nach Kanton',
  fr: 'Articles par canton',
};

const DESCRIPTION: Record<Locale, string> = {
  it: 'Notizie e guide locali sui cantoni attualmente attivi.',
  en: 'Local news and guides for the currently active cantons.',
  de: 'Lokale Nachrichten und Ratgeber für die aktuell aktiven Kantone.',
  fr: 'Actualités et guides locaux pour les cantons actuellement actifs.',
};

interface LiveCantonArticleSectionsProps {
  activeSection?: ArticleSection;
  className?: string;
}

/** Shared discovery block for the SPA article hub and other interactive lists. */
export default function LiveCantonArticleSections({
  activeSection,
  className = '',
}: LiveCantonArticleSectionsProps) {
  const [locale] = useLocale();
  const [sections, setSections] = useState<RuntimeCantonArticleSection[]>([]);

  useEffect(() => {
    let cancelled = false;
    loadLiveCantonArticleSections()
      .then((live) => {
        if (!cancelled) setSections(localizeCantonArticleSections(live, locale));
      })
      .catch(() => {
        if (!cancelled) setSections([]);
      });
    return () => { cancelled = true; };
  }, [locale]);

  if (sections.length === 0) return null;

  return (
    <section
      className={`border-t border-edge bg-surface ${className}`}
      aria-labelledby="live-canton-article-sections"
      data-testid="live-canton-article-sections"
    >
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-3">
        <div className="flex items-start gap-2 mb-2">
          <Newspaper size={16} className="mt-0.5 text-accent shrink-0" aria-hidden="true" />
          <div>
            <h2 id="live-canton-article-sections" className="text-sm font-semibold text-heading">
              {TITLE[locale]}
            </h2>
            <p className="text-xs text-muted mt-0.5">{DESCRIPTION[locale]}</p>
          </div>
        </div>
        <nav aria-label={TITLE[locale]}>
          <ul className="flex flex-wrap gap-2">
            {sections.map((entry) => (
              <li key={entry.section}>
                <a
                  href={buildPath({ activeTab: 'blog', blogSection: entry.section })}
                  aria-current={activeSection === entry.section ? 'page' : undefined}
                  className={`inline-flex min-h-[40px] items-center rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 ${
                    activeSection === entry.section
                      ? 'border-accent bg-accent-subtle text-accent'
                      : 'border-edge bg-surface-alt text-body hover:border-accent-border hover:text-accent'
                  }`}
                >
                  {entry.displayName}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </div>
    </section>
  );
}
