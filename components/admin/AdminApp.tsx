import { lazy, Suspense, useCallback, useEffect, useMemo, useState, type ComponentType, type LazyExoticComponent, type MouseEvent } from 'react';
import { Copy, Loader2, Shield } from 'lucide-react';
import {
  getAdminSection,
  getVisibleAdminSections,
  isAdminSectionSlug,
  type AdminSection,
  type AdminSectionGroup,
} from './adminSections';
import { AdminWorkflowProvider, useAdminWorkflow, type AdminWorkflowContext } from './AdminWorkflowProvider';
import { AdminNavigationContext, type AdminNavigationContextValue } from './lib/AdminNavigationContext';
import {
  adminSectionPath,
  canonicalAdminUrl,
  currentAdminRoute,
  navigateAdminSection,
  replaceAdminQuery,
} from './lib/adminNavigation';

const OggiSection = lazy(() => import('./sections/OggiSection'));
const CrawlerSection = lazy(() => import('./sections/CrawlerSection'));
const AutomazioniSection = lazy(() => import('./sections/AutomazioniSection'));
const ConfigurazioneCrawlerSection = lazy(() => import('./sections/ConfigurazioneCrawlerSection'));
const AziendeSection = lazy(() => import('./sections/AziendeSection'));
const CandidatureSection = lazy(() => import('./sections/CandidatureSection'));
const RedazioneSection = lazy(() => import('./sections/RedazioneSection'));
const GiornalistiSection = lazy(() => import('./sections/GiornalistiSection'));
const NewsletterSection = lazy(() => import('./sections/NewsletterSection'));
const SaluteSection = lazy(() => import('./sections/SaluteSection'));

const SECTION_COMPONENTS: Record<string, LazyExoticComponent<ComponentType>> = {
  '': OggiSection,
  crawler: CrawlerSection,
  automazioni: AutomazioniSection,
  'configurazione-crawler': ConfigurazioneCrawlerSection,
  aziende: AziendeSection,
  candidature: CandidatureSection,
  redazione: RedazioneSection,
  giornalisti: GiornalistiSection,
  newsletter: NewsletterSection,
  salute: SaluteSection,
};

const GROUP_LABELS: Record<AdminSectionGroup, string> = {
  oggi: 'Oggi',
  lavoro: 'Lavoro',
  aziende: 'Aziende',
  redazione: 'Redazione',
  sistema: 'Sistema',
};

function workflowContextsForSection(section: string): readonly AdminWorkflowContext[] {
  if (section === 'crawler' || section === 'configurazione-crawler') return ['jobs'];
  if (section === 'automazioni') return ['content', 'seo', 'analytics'];
  return [];
}

function WorkflowSummary({ section }: { section: string }) {
  const workflow = useAdminWorkflow();
  const contexts = workflowContextsForSection(section);
  if (contexts.length === 0) return null;
  const summary = contexts.reduce((total, context) => {
    const next = workflow.getSummary(context);
    return { ok: total.ok + next.ok, error: total.error + next.error, pending: total.pending + next.pending };
  }, { ok: 0, error: 0, pending: 0 });
  if (summary.ok === 0 && summary.error === 0 && summary.pending === 0) return null;
  return (
    <span className="ml-1 inline-flex items-center gap-1" aria-label={`${summary.ok} ok, ${summary.error} errori, ${summary.pending} in corso`}>
      {summary.ok > 0 && <span className="inline-flex min-w-5 justify-center rounded-full bg-success-subtle px-1.5 py-0.5 text-[10px] font-bold text-success">{summary.ok}</span>}
      {summary.error > 0 && <span className="inline-flex min-w-5 justify-center rounded-full bg-danger-subtle px-1.5 py-0.5 text-[10px] font-bold text-danger">{summary.error}</span>}
      {summary.pending > 0 && <span className="inline-flex min-w-5 justify-center rounded-full bg-warning-subtle px-1.5 py-0.5 text-[10px] font-bold text-warning">{summary.pending}</span>}
    </span>
  );
}

function AdminNavigation({ sections, activeSection, onNavigate }: {
  sections: readonly AdminSection[];
  activeSection: string;
  onNavigate: (event: MouseEvent<HTMLAnchorElement>, section: AdminSection) => void;
}) {
  const groups = ['oggi', 'lavoro', 'aziende', 'redazione', 'sistema'] as const;
  return (
    <nav aria-label="Sezioni amministrazione" className="space-y-3">
      {groups.map((group) => {
        const groupSections = sections.filter((section) => section.group === group);
        if (groupSections.length === 0) return null;
        return (
          <div key={group} className="space-y-1">
            <p className="px-1 text-[10px] font-bold uppercase tracking-wide text-muted">{GROUP_LABELS[group]}</p>
            <div className="flex gap-2 border-b border-edge pb-1 flex-wrap">
              {groupSections.map((section) => {
                const active = section.slug === activeSection;
                return (
                  <a
                    key={section.slug || 'root'}
                    href={adminSectionPath(section.slug)}
                    aria-current={active ? 'page' : undefined}
                    onClick={(event) => onNavigate(event, section)}
                    title={section.description}
                    className={`inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-t-lg transition-colors ${active ? 'bg-surface text-accent border border-b-0 border-edge' : 'text-muted hover:text-body'}`}
                  >
                    <span>{section.label}</span>
                    <WorkflowSummary section={section.slug} />
                  </a>
                );
              })}
            </div>
          </div>
        );
      })}
    </nav>
  );
}

function AdminAppContent({ requestedSection }: { requestedSection?: string }) {
  const workflow = useAdminWorkflow();
  const initialSection = isAdminSectionSlug(requestedSection)
    ? requestedSection
    : currentAdminRoute().adminSection || '';
  const [activeSection, setActiveSection] = useState(initialSection);
  const [locationKey, setLocationKey] = useState(() => `${window.location.pathname}${window.location.search}${window.location.hash}`);
  const [copyFeedback, setCopyFeedback] = useState(false);

  const syncLocation = useCallback(() => {
    const route = currentAdminRoute();
    setActiveSection(isAdminSectionSlug(route.adminSection) ? route.adminSection : '');
    setLocationKey(`${window.location.pathname}${window.location.search}${window.location.hash}`);
  }, []);

  useEffect(() => {
    window.addEventListener('popstate', syncLocation);
    return () => window.removeEventListener('popstate', syncLocation);
  }, [syncLocation]);

  useEffect(() => {
    if (!isAdminSectionSlug(requestedSection)) return;
    setActiveSection(requestedSection);
  }, [requestedSection]);

  useEffect(() => {
    if (activeSection === 'crawler' || activeSection === 'automazioni' || activeSection === 'configurazione-crawler' || activeSection === 'newsletter') {
      void workflow.refresh();
    }
  }, [activeSection, workflow.refresh]);

  const copyCanonicalLink = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(canonicalAdminUrl());
      setCopyFeedback(true);
      window.setTimeout(() => setCopyFeedback(false), 2000);
      return true;
    } catch {
      return false;
    }
  }, []);

  const navigation = useMemo<AdminNavigationContextValue>(() => ({
    section: activeSection,
    searchParams: new URLSearchParams(window.location.search),
    locationKey,
    navigateSection: navigateAdminSection,
    replaceQuery: replaceAdminQuery,
    canonicalUrl: canonicalAdminUrl,
    copyCanonicalLink,
  }), [activeSection, copyCanonicalLink, locationKey]);

  const selectedSection = getAdminSection(activeSection);
  const SectionComponent = SECTION_COMPONENTS[selectedSection.slug] || OggiSection;
  const visibleSections = getVisibleAdminSections();

  const handleNavigate = (event: MouseEvent<HTMLAnchorElement>, target: AdminSection) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    navigateAdminSection(target.slug);
  };

  return (
    <AdminNavigationContext.Provider value={navigation}>
      <div className="space-y-6">
        <div className="bg-gradient-to-br from-accent-strong to-accent-strong-hover rounded-2xl p-6 text-on-accent shadow-lg">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div>
              <div className="flex items-center gap-3 mb-2">
                <Shield size={28} />
                <h1 className="text-2xl font-bold font-display">Pannello Amministrazione</h1>
              </div>
              <p className="text-on-accent/70 text-sm">{selectedSection.description}</p>
            </div>
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => void copyCanonicalLink()} className="inline-flex items-center gap-2 rounded-lg bg-surface/15 px-3 py-2 text-sm font-medium text-on-accent hover:bg-surface/25">
                <Copy size={14} />
                Copia link
              </button>
              {copyFeedback && <span role="status" className="text-sm text-on-accent">Link copiato</span>}
            </div>
          </div>
        </div>

        <AdminNavigation sections={visibleSections} activeSection={activeSection} onNavigate={handleNavigate} />

        <Suspense fallback={<div className="flex items-center justify-center py-16 text-muted" role="status"><Loader2 size={20} className="mr-2 animate-spin" />Caricamento sezione…</div>}>
          <SectionComponent key={selectedSection.slug} />
        </Suspense>
      </div>
    </AdminNavigationContext.Provider>
  );
}

export default function AdminApp({ adminSection }: { adminSection?: string } = {}) {
  return (
    <AdminWorkflowProvider>
      <AdminAppContent requestedSection={adminSection} />
    </AdminWorkflowProvider>
  );
}

