import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { ChevronDown, Newspaper, X } from 'lucide-react';
import { buildPath, isArticleSectionRoute, type AppRoute } from '@/services/router';
import { t, useLocale, type Locale } from '@/services/i18n';
import {
  loadLiveCantonArticleSections,
  localizeCantonArticleSections,
  type RuntimeCantonArticleSection,
} from '@/services/runtimeArticleSections';
import type { ArticleSection } from '@/services/articleSections';

const COPY: Record<Locale, {
  navigationLabel: string;
  cantons: string;
  panelLabel: string;
  close: string;
  open: string;
}> = {
  it: {
    navigationLabel: 'Navigazione sezioni articoli',
    cantons: 'Cantoni',
    panelLabel: 'Articoli per cantone',
    close: 'Chiudi',
    open: 'Apri elenco cantoni',
  },
  en: {
    navigationLabel: 'Article section navigation',
    cantons: 'Cantons',
    panelLabel: 'Articles by canton',
    close: 'Close',
    open: 'Open canton list',
  },
  de: {
    navigationLabel: 'Navigation der Artikelbereiche',
    cantons: 'Kantone',
    panelLabel: 'Artikel nach Kanton',
    close: 'Schließen',
    open: 'Kantonliste öffnen',
  },
  fr: {
    navigationLabel: 'Navigation des sections d’articles',
    cantons: 'Cantons',
    panelLabel: 'Articles par canton',
    close: 'Fermer',
    open: 'Ouvrir la liste des cantons',
  },
};

interface ArticleSectionNavProps {
  activeSection: ArticleSection;
  onSelect: (section: ArticleSection) => void;
}

interface ArticleSectionNavigationProps extends ArticleSectionNavProps {
  route: Pick<AppRoute, 'activeTab'>;
}

function linkClass(active: boolean, extra = '') {
  return `inline-flex min-h-11 min-w-0 items-center justify-center rounded-xl px-2 text-sm font-semibold leading-tight transition-[color,background-color,border-color,box-shadow] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 sm:px-3 ${extra} ${
    active
      ? 'bg-tab-active-bg text-tab-active-text ring-2 ring-tab-active-border'
      : 'text-tab-inactive-text hover:bg-tab-hover-bg'
  }`;
}

function focusableElements(panel: HTMLElement): HTMLElement[] {
  return Array.from(panel.querySelectorAll<HTMLElement>('button:not([disabled]), a[href][tabindex="0"]'));
}

/** Mount seam for the shell: the article nav has no DOM outside article routes. */
export function ArticleSectionNavigation({ route, ...props }: ArticleSectionNavigationProps) {
  if (!isArticleSectionRoute(route)) return null;
  return <ArticleSectionNav {...props} />;
}

/** One compact article-hub control: two historical links plus a live canton disclosure. */
export default function ArticleSectionNav({ activeSection, onSelect }: ArticleSectionNavProps) {
  const [locale] = useLocale();
  const [sections, setSections] = useState<RuntimeCantonArticleSection[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const navRef = useRef<HTMLElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);

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

  const sortedSections = useMemo(() => {
    const collator = new Intl.Collator(locale, { sensitivity: 'base' });
    return [...sections].sort((a, b) => collator.compare(a.displayName, b.displayName));
  }, [locale, sections]);

  const activeCanton = sortedSections.find((entry) => entry.section === activeSection);
  const activeCantonLabel = activeCanton?.displayName;
  const copy = COPY[locale];
  const panelId = 'article-canton-panel';
  const panelTitleId = 'article-canton-panel-title';

  const closePanel = useCallback((restoreFocus = false) => {
    setIsOpen(false);
    if (restoreFocus) {
      window.setTimeout(() => buttonRef.current?.focus(), 0);
    }
  }, []);

  useEffect(() => {
    if (!isOpen) return undefined;

    const handleOutsidePointer = (event: PointerEvent) => {
      if (!navRef.current?.contains(event.target as Node)) closePanel(true);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closePanel(true);
        return;
      }
      if (event.key !== 'Tab' || !panelRef.current) return;

      const focusables = focusableElements(panelRef.current);
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('pointerdown', handleOutsidePointer);
    document.addEventListener('keydown', handleKeyDown);
    const focusTimer = window.setTimeout(() => {
      panelRef.current?.querySelector<HTMLElement>('[data-canton-panel-close]')?.focus();
    }, 0);

    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener('pointerdown', handleOutsidePointer);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [closePanel, isOpen]);

  const handleLinkClick = useCallback((event: MouseEvent<HTMLAnchorElement>, section: ArticleSection) => {
    // Keep normal browser behavior for Cmd/Ctrl-click, middle-click, and
    // other modified navigation; the href remains the SEO/crawler contract.
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    closePanel(true);
    onSelect(section);
  }, [closePanel, onSelect]);

  const historicalActive = activeSection === 'frontaliere' || activeSection === 'svizzera'
    ? activeSection
    : null;

  return (
    <nav
      ref={navRef}
      className="seo-hub-subnav relative z-40 border-t border-edge bg-surface"
      aria-label={copy.navigationLabel}
      data-hub="frontaliere"
      data-testid="article-section-nav"
    >
      <div className="mx-auto max-w-7xl px-3 sm:px-6 lg:px-8">
        <div className="grid min-h-14 grid-cols-3 items-center gap-1 md:flex md:justify-start md:gap-1.5">
          <a
            href={buildPath({ activeTab: 'blog' })}
            aria-current={historicalActive === 'frontaliere' ? 'page' : undefined}
            data-article-section="frontaliere"
            className={linkClass(historicalActive === 'frontaliere', 'truncate')}
            onClick={(event) => handleLinkClick(event, 'frontaliere')}
          >
            <span className="truncate">{t('blog.section.frontalieri')}</span>
          </a>
          <a
            href={buildPath({ activeTab: 'blog', blogSection: 'svizzera' })}
            aria-current={historicalActive === 'svizzera' ? 'page' : undefined}
            data-article-section="svizzera"
            className={linkClass(historicalActive === 'svizzera', 'truncate')}
            onClick={(event) => handleLinkClick(event, 'svizzera')}
          >
            <span className="truncate">{t('blog.section.svizzera')}</span>
          </a>

          {sortedSections.length > 0 && (
            <button
              ref={buttonRef}
              type="button"
              aria-expanded={isOpen}
              aria-controls={panelId}
              aria-current={activeCantonLabel ? 'page' : undefined}
              aria-label={activeCantonLabel ? `${activeCantonLabel} — ${copy.open}` : copy.open}
              data-article-section="cantons"
              data-article-section-active={activeCantonLabel ? 'true' : undefined}
              className={linkClass(Boolean(activeCantonLabel), 'w-full gap-1 whitespace-nowrap md:w-auto')}
              onClick={() => {
                if (isOpen) closePanel(true);
                else setIsOpen(true);
              }}
            >
              <span className="max-w-[7.5rem] truncate">{activeCantonLabel ?? copy.cantons}</span>
              <ChevronDown size={16} aria-hidden="true" className={`shrink-0 motion-safe:transition-transform ${isOpen ? 'rotate-180' : ''}`} />
            </button>
          )}
        </div>
      </div>

      {sortedSections.length > 0 && (
        <div
          ref={panelRef}
          id={panelId}
          role="dialog"
          aria-modal="true"
          aria-labelledby={panelTitleId}
          aria-hidden={!isOpen}
          data-testid="article-canton-panel"
          className={`absolute inset-x-0 top-full z-50 border-y border-edge bg-surface shadow-stripe-md motion-safe:transition-[opacity,transform,visibility] motion-safe:duration-200 md:left-auto md:right-3 md:w-[min(720px,calc(100vw-1.5rem))] md:rounded-b-xl md:border-x ${
            isOpen
              ? 'visible translate-y-0 opacity-100'
              : 'invisible pointer-events-none -translate-y-1 opacity-0'
          }`}
        >
          <div className="max-h-[min(70vh,32rem)] overflow-y-auto overscroll-contain px-3 py-3 sm:px-4">
            <div className="mb-2 flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2">
                <Newspaper size={16} className="shrink-0 text-accent" aria-hidden="true" />
                <h2 id={panelTitleId} className="truncate text-sm font-semibold text-heading">{copy.panelLabel}</h2>
              </div>
              <button
                type="button"
                data-canton-panel-close
                tabIndex={isOpen ? 0 : -1}
                className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-xl text-muted transition-colors hover:bg-surface-raised hover:text-heading focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
                aria-label={copy.close}
                onClick={() => closePanel(true)}
              >
                <X size={18} aria-hidden="true" />
              </button>
            </div>
            <ul className="grid grid-cols-2 gap-1.5 min-[360px]:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
              {sortedSections.map((entry) => {
                const isActive = activeSection === entry.section;
                return (
                  <li key={entry.section}>
                    <a
                      href={buildPath({ activeTab: 'blog', blogSection: entry.section })}
                      aria-current={isActive ? 'page' : undefined}
                      tabIndex={isOpen ? 0 : -1}
                      className={linkClass(isActive, 'w-full truncate border border-edge bg-surface-alt text-xs hover:border-accent-border hover:text-accent')}
                      onClick={(event) => handleLinkClick(event, entry.section)}
                    >
                      <span className="truncate">{entry.displayName}</span>
                    </a>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      )}
    </nav>
  );
}
