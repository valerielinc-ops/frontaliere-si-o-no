import { lazy, Suspense, useCallback, useEffect, useMemo, useState, type ComponentType, type LazyExoticComponent, type MouseEvent } from 'react';
import { Command, Copy, Loader2 } from 'lucide-react';
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
import { useAdminShellVariant } from './lib/adminShellVariant';
import { AdminButton } from './ui/AdminButton';
import { AdminConfirmProvider } from './ui/AdminConfirmDialog';
import { AdminShell, type AdminPaletteItem } from './ui/AdminShell';
import { useAuth } from '@/services/authService';
import { cdnDataUrl } from '@/services/cdnDataBase';
import { loadCrawlerData } from './lib/jobsCrawlerConfig';
import { fetchAdminEmployerInsights } from '@/services/adminInsights';
import { fetchAssistedApplicationOrders, type AssistedApplicationAdminStatus } from '@/services/assistedApplicationAdminService';
import { failedCrawlerRunCount, loadAdminTodayRuns } from '@/services/adminTodayRuns';
import { localDateKey } from '@/services/adminCron';
import { loadNewsletterStats } from '@/components/admin/lib/newsletterStats';

const OggiSection = lazy(() => import('./sections/OggiSection'));
const CrawlerSection = lazy(() => import('./sections/CrawlerSection'));
const AutomazioniSection = lazy(() => import('./sections/AutomazioniSection'));
const ConfigurazioneCrawlerSection = lazy(() => import('./sections/ConfigurazioneCrawlerSection'));
const AziendeSection = lazy(() => import('./sections/AziendeSection'));
const ConciergeSection = lazy(() => import('@/components/pages/ApplicationConciergeAdmin'));
const CandidatureSection = lazy(() => import('./sections/CandidatureSection'));
const RedazioneSection = lazy(() => import('./sections/RedazioneSection'));
const GiornalistiSection = lazy(() => import('./sections/GiornalistiSection'));
const NewsletterSection = lazy(() => import('./sections/NewsletterSection'));
const SaluteSection = lazy(() => import('./sections/SaluteSection'));
const FlagSection = lazy(() => import('./sections/FlagSection'));
const RegistroSection = lazy(() => import('./sections/RegistroSection'));

const SECTION_COMPONENTS: Record<string, LazyExoticComponent<ComponentType>> = {
  '': OggiSection,
  crawler: CrawlerSection,
  automazioni: AutomazioniSection,
  'configurazione-crawler': ConfigurazioneCrawlerSection,
  aziende: AziendeSection,
  candidature: CandidatureSection,
  'servizio-candidature': ConciergeSection,
  redazione: RedazioneSection,
  giornalisti: GiornalistiSection,
  newsletter: NewsletterSection,
  salute: SaluteSection,
  flag: FlagSection,
  registro: RegistroSection,
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
    <span className="ml-1 inline-flex items-center gap-1" aria-label={`${summary.ok} riusciti, ${summary.error} errori, ${summary.pending} in corso`}>
      {summary.ok > 0 && <span className="inline-flex min-w-6 justify-center rounded-full bg-success-subtle px-1.5 py-0.5 text-xs font-semibold tabular-nums text-success">{summary.ok}</span>}
      {summary.error > 0 && <span className="inline-flex min-w-6 justify-center rounded-full bg-danger-subtle px-1.5 py-0.5 text-xs font-semibold tabular-nums text-danger">{summary.error}</span>}
      {summary.pending > 0 && <span className="inline-flex min-w-6 justify-center rounded-full bg-warning-subtle px-1.5 py-0.5 text-xs font-semibold tabular-nums text-warning">{summary.pending}</span>}
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
    <nav aria-label="Sezioni amministrazione" className="space-y-4">
      {groups.map((group) => {
        const groupSections = sections.filter((section) => section.group === group);
        if (groupSections.length === 0) return null;
        return (
          <div key={group} className="space-y-2">
            <p className="text-xs font-normal text-muted">{GROUP_LABELS[group]}</p>
            <div className="flex flex-wrap gap-1 border-b border-edge pb-1">
              {groupSections.map((section) => {
                const active = section.slug === activeSection;
                return (
                  <a
                    key={section.slug || 'root'}
                    href={adminSectionPath(section.slug)}
                    aria-current={active ? 'page' : undefined}
                    onClick={(event) => onNavigate(event, section)}
                    title={section.description}
                    className={`inline-flex min-h-10 items-center gap-1.5 rounded-stripe px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 ${active ? 'border border-edge bg-surface text-accent shadow-stripe-sm' : 'text-subtle hover:bg-surface-raised hover:text-heading'}`}
                  >
                    <span>{section.slug ? section.label : 'Panoramica'}</span>
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

function SectionLoading() {
  return <div className="rounded-stripe border border-edge bg-surface p-6" role="status"><div className="flex items-center gap-2 text-sm text-subtle"><span className="h-4 w-4 animate-pulse rounded-full bg-accent-subtle" aria-hidden="true" />Caricamento sezione…</div></div>;
}

function LegacyAdminContent({ activeSection, selectedSection, visibleSections, handleNavigate, copyCanonicalLink, copyFeedback, locationKey }: {
  activeSection: string;
  selectedSection: AdminSection;
  visibleSections: readonly AdminSection[];
  handleNavigate: (event: MouseEvent<HTMLAnchorElement>, section: AdminSection) => void;
  copyCanonicalLink: () => Promise<boolean>;
  copyFeedback: boolean;
  locationKey: string;
}) {
  const SectionComponent = SECTION_COMPONENTS[selectedSection.slug] || OggiSection;
  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-4 rounded-stripe border border-accent-border bg-accent-subtle p-5 text-body sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3"><Command size={25} className="mt-0.5 shrink-0 text-accent" aria-hidden="true" /><div><h1 className="font-display text-2xl font-light text-heading">Pannello amministrazione</h1><p className="mt-1 text-sm text-subtle">{selectedSection.description}</p></div></div>
        <AdminButton onClick={() => void copyCanonicalLink()}>{copyFeedback ? 'Link copiato' : 'Copia link'}</AdminButton>
      </header>
      <AdminNavigation sections={visibleSections} activeSection={activeSection} onNavigate={handleNavigate} />
      <Suspense fallback={<SectionLoading />} key={locationKey}>
        <SectionComponent />
      </Suspense>
    </div>
  );
}

function AdminAppContent({ requestedSection, shellVariant }: { requestedSection?: string; shellVariant: 'v1' | 'v2' }) {
  const { user } = useAuth();
  const workflow = useAdminWorkflow();
  const initialSection = isAdminSectionSlug(requestedSection)
    ? requestedSection
    : currentAdminRoute().adminSection || '';
  const [activeSection, setActiveSection] = useState(initialSection);
  const [locationKey, setLocationKey] = useState(() => `${window.location.pathname}${window.location.search}${window.location.hash}`);
  const [copyFeedback, setCopyFeedback] = useState(false);
  const [navigationBadges, setNavigationBadges] = useState<Record<string, number>>({});
  const [paletteItems, setPaletteItems] = useState<AdminPaletteItem[]>([]);

  useEffect(() => {
    let mounted = true;
    void loadCrawlerData(cdnDataUrl).then(({ summaries }) => {
      if (!mounted) return;
      setPaletteItems(summaries.map((summary) => ({ id: `crawler-${summary.key}`, label: summary.label, kind: 'crawler', group: 'lavoro', description: `${summary.total.toLocaleString('it-IT')} offerte attive`, onSelect: () => { navigateAdminSection('crawler'); replaceAdminQuery({ q: summary.label }); } })));
    }).catch(() => undefined);
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    let mounted = true;
    const statuses: AssistedApplicationAdminStatus[] = ['ready_for_manual_submission', 'in_progress', 'blocked'];
    void Promise.allSettled([
      fetchAdminEmployerInsights(user),
      Promise.all(statuses.map((status) => fetchAssistedApplicationOrders(user, status))),
      loadAdminTodayRuns(user),
      loadNewsletterStats(),
    ]).then(([insightsResult, applicationsResult, runsResult, newsletterResult]) => {
      if (!mounted) return;
      const insights = insightsResult.status === 'fulfilled' ? insightsResult.value : [];
      const applications = applicationsResult.status === 'fulfilled' ? applicationsResult.value.flat() : [];
      const runs = runsResult.status === 'fulfilled' ? runsResult.value.runs : [];
      const newsletterAvailable = newsletterResult.status === 'fulfilled';
      const crawlerFailures = runsResult.status === 'fulfilled' ? failedCrawlerRunCount(runs, localDateKey(new Date())) : undefined;
      setNavigationBadges({
        ...(crawlerFailures === undefined ? {} : { crawler: crawlerFailures }),
        aziende: insights.filter((row) => row.outreach?.replied && !row.outreach.suppressed).length,
        candidature: applications.length,
        ...(newsletterAvailable ? { newsletter: 1 } : {}),
      });
      setPaletteItems((current) => [...current, ...insights.map((row) => ({ id: `company-${row.companyKey}`, label: row.companyName, kind: 'company' as const, group: 'aziende' as const, description: 'Apri insights azienda', onSelect: () => { navigateAdminSection('aziende'); replaceAdminQuery({ q: row.companyName }); } }))]);
    });
    return () => { mounted = false; };
  }, [user]);

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
  const visibleSections = useMemo(() => getVisibleAdminSections(), []);
  const SectionComponent = SECTION_COMPONENTS[selectedSection.slug] || OggiSection;
  const crawlerBadge = navigationBadges.crawler ?? workflow.getSummary('jobs').error;
  const ownerTriageCount = crawlerBadge + (navigationBadges.aziende || 0) + (navigationBadges.candidature || 0) + (navigationBadges.newsletter || 0);

  const handleNavigate = (event: MouseEvent<HTMLAnchorElement>, target: AdminSection) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    navigateAdminSection(target.slug);
  };

  return (
    <AdminNavigationContext.Provider value={navigation}>
      {shellVariant === 'v2' ? (
        <AdminShell
          sections={visibleSections}
          activeSection={activeSection}
          onNavigate={handleNavigate}
          onCopyLink={() => { void copyCanonicalLink(); }}
          copyFeedback={copyFeedback}
          paletteItems={paletteItems}
          getSectionBadge={(section) => {
            if (section === '') return ownerTriageCount || null;
            if (section === 'crawler') return crawlerBadge || null;
            return navigationBadges[section] || null;
          }}
          getGroupBadge={(group) => {
            if (group === 'oggi') return ownerTriageCount || null;
            if (group === 'lavoro') return crawlerBadge || null;
            if (group === 'aziende') return (navigationBadges.aziende || 0) + (navigationBadges.candidature || 0) || null;
            return null;
          }}
        >
          <Suspense fallback={<SectionLoading />} key={locationKey}>
            <SectionComponent />
          </Suspense>
        </AdminShell>
      ) : (
        <LegacyAdminContent
          activeSection={activeSection}
          selectedSection={selectedSection}
          visibleSections={visibleSections}
          handleNavigate={handleNavigate}
          copyCanonicalLink={copyCanonicalLink}
          copyFeedback={copyFeedback}
          locationKey={locationKey}
        />
      )}
    </AdminNavigationContext.Provider>
  );
}

function AdminShellLoading() {
  return <div className="admin-shell flex min-h-[50vh] items-center justify-center bg-surface-alt px-4" role="status"><div className="flex items-center gap-2 text-sm text-subtle"><span className="h-4 w-4 animate-pulse rounded-full bg-accent-subtle" aria-hidden="true" />Preparazione pannello amministrazione…</div></div>;
}

export default function AdminApp({ adminSection }: { adminSection?: string } = {}) {
  const shellVariant = useAdminShellVariant();
  if (!shellVariant) return <AdminShellLoading />;
  return (
    <AdminConfirmProvider>
      <AdminWorkflowProvider>
        <AdminAppContent requestedSection={adminSection} shellVariant={shellVariant} />
      </AdminWorkflowProvider>
    </AdminConfirmProvider>
  );
}
