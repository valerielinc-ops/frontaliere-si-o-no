import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent, type ReactNode, type RefObject } from 'react';
import { Building2, Check, Command, Copy, LayoutDashboard, Newspaper, Search, Settings2, Workflow } from 'lucide-react';
import { useAdminWorkflow } from '@/components/admin/AdminWorkflowProvider';
import { getAdminSection, type AdminSection, type AdminSectionGroup } from '@/components/admin/adminSections';
import { adminSectionPath, navigateAdminSection, replaceAdminQuery } from '@/components/admin/lib/adminNavigation';
import { buildAdminPaletteIndex, filterAdminPaletteIndex } from '@/components/admin/lib/adminPalette';
import type { AdminPaletteItem, AdminPaletteItemKind } from '@/components/admin/lib/adminPalette';

export type { AdminPaletteItem, AdminPaletteItemKind } from '@/components/admin/lib/adminPalette';

const GROUPS: readonly AdminSectionGroup[] = ['oggi', 'lavoro', 'aziende', 'redazione', 'sistema'];

const GROUP_LABELS: Record<AdminSectionGroup, string> = {
  oggi: 'Oggi',
  lavoro: 'Lavoro',
  aziende: 'Aziende',
  redazione: 'Redazione',
  sistema: 'Sistema',
};

const EMPTY_PALETTE_ITEMS: readonly AdminPaletteItem[] = [];

const GROUP_ICONS = {
  oggi: LayoutDashboard,
  lavoro: Workflow,
  aziende: Building2,
  redazione: Newspaper,
  sistema: Settings2,
} satisfies Record<AdminSectionGroup, typeof LayoutDashboard>;

export interface AdminShellProps {
  sections: readonly AdminSection[];
  activeSection: string;
  onNavigate: (event: MouseEvent<HTMLAnchorElement>, section: AdminSection) => void;
  onCopyLink: () => void;
  copyFeedback: boolean;
  children: ReactNode;
  getGroupBadge?: (group: AdminSectionGroup) => number | null;
  getSectionBadge?: (section: string) => number | null;
  paletteItems?: readonly AdminPaletteItem[];
}

function routeLabel(section: AdminSection): string {
  return section.slug ? section.label : 'Panoramica';
}

function NavBadge({ value }: { value: number | null }) {
  if (!value) return null;
  return <span className="inline-flex min-w-6 items-center justify-center rounded-full bg-danger-strong px-1.5 py-0.5 text-xs font-semibold tabular-nums text-on-accent">{value}</span>;
}

function paletteKindLabel(kind: AdminPaletteItemKind): string {
  if (kind === 'action') return 'Azione';
  if (kind === 'crawler') return 'Crawler';
  if (kind === 'company') return 'Azienda';
  return 'Sezione';
}

function PaletteInput({
  inputRef,
  items,
  search,
  setSearch,
  searchOpen,
  setSearchOpen,
  activeIndex,
  onActiveIndex,
  onSelect,
  id,
  mobile = false,
}: {
  inputRef: RefObject<HTMLInputElement | null>;
  items: readonly AdminPaletteItem[];
  search: string;
  setSearch: (value: string) => void;
  searchOpen: boolean;
  setSearchOpen: (value: boolean) => void;
  activeIndex: number;
  onActiveIndex: (value: number) => void;
  onSelect: (item: AdminPaletteItem) => void;
  id: string;
  mobile?: boolean;
}) {
  const listId = `${id}-list`;
  const activeItem = items[activeIndex];
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); setSearchOpen(true); onActiveIndex(items.length ? (activeIndex + 1) % items.length : 0); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setSearchOpen(true); onActiveIndex(items.length ? (activeIndex - 1 + items.length) % items.length : 0); }
    else if (event.key === 'Home' && items.length) { event.preventDefault(); onActiveIndex(0); }
    else if (event.key === 'End' && items.length) { event.preventDefault(); onActiveIndex(items.length - 1); }
    else if (event.key === 'Enter' && searchOpen && activeItem) { event.preventDefault(); onSelect(activeItem); }
    else if (event.key === 'Escape') { event.preventDefault(); setSearchOpen(false); inputRef.current?.blur(); }
  };
  return (
    <div className={`relative ${mobile ? 'w-full' : 'ml-auto w-full max-w-[22rem]'}`}>
      <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" aria-hidden="true" />
      <input
        ref={inputRef}
        value={search}
        onChange={(event) => { setSearch(event.target.value); setSearchOpen(true); onActiveIndex(0); }}
        onFocus={() => setSearchOpen(true)}
        onBlur={() => window.setTimeout(() => setSearchOpen(false), 140)}
        onKeyDown={handleKeyDown}
        placeholder="Vai a sezione o azione…"
        aria-label="Vai a sezione o azione"
        role="combobox"
        aria-expanded={searchOpen}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={searchOpen && activeItem ? `${id}-option-${activeIndex}` : undefined}
        className={`min-h-10 w-full rounded-stripe border border-edge bg-surface-alt py-2 pl-9 text-sm text-heading outline-none transition-colors focus:border-accent focus:ring-2 focus:ring-accent/30 ${mobile ? 'pr-3' : 'pr-14'}`}
      />
      {!mobile && <kbd className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded-stripe border border-edge bg-surface px-1.5 py-0.5 text-xs text-muted">⌘K</kbd>}
      {searchOpen && (
        <div id={listId} className="absolute left-0 right-0 top-11 z-50 max-h-[min(26rem,calc(100vh-8rem))] overflow-y-auto rounded-stripe border border-edge bg-surface shadow-stripe-md" role="listbox" aria-label="Risultati navigazione">
          <p className="border-b border-edge px-3 py-2 text-xs font-semibold text-muted">Sezioni, azioni e dati operativi</p>
          {items.length > 0 ? items.map((item, index) => <button key={item.id} id={`${id}-option-${index}`} type="button" role="option" aria-selected={index === activeIndex} onMouseDown={(event) => event.preventDefault()} onMouseEnter={() => onActiveIndex(index)} onClick={() => onSelect(item)} className={`flex w-full items-start justify-between gap-3 px-3 py-2.5 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent ${index === activeIndex ? 'bg-surface-alt' : 'hover:bg-surface-alt'}`}><span className="min-w-0"><span className="block truncate font-medium text-body">{item.label}</span>{item.description && <span className="mt-0.5 block truncate text-xs text-muted">{item.description}</span>}</span><span className="shrink-0 text-xs text-muted">{item.group ? GROUP_LABELS[item.group] : paletteKindLabel(item.kind)}</span></button>) : <p className="px-3 py-3 text-sm text-subtle">Nessun risultato trovato.</p>}
        </div>
      )}
    </div>
  );
}

export function AdminShell({ sections, activeSection, onNavigate, onCopyLink, copyFeedback, children, getGroupBadge, getSectionBadge, paletteItems = EMPTY_PALETTE_ITEMS }: AdminShellProps) {
  const workflow = useAdminWorkflow();
  const workflowRef = useRef(workflow);
  workflowRef.current = workflow;
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const mobileSearchRef = useRef<HTMLInputElement | null>(null);
  const selectedSection = getAdminSection(activeSection);
  const currentGroup = selectedSection.group;
  const currentGroupSections = sections.filter((section) => section.group === currentGroup);
  const defaultGroupBadge = (group: AdminSectionGroup) => {
    if (group !== 'lavoro' || typeof workflow.getSummary !== 'function') return null;
    const summary = workflow.getSummary('jobs');
    return summary.pending + summary.error || null;
  };
  const badgeForGroup = getGroupBadge || defaultGroupBadge;
  const pathLabel = typeof window === 'undefined' ? adminSectionPath(activeSection) : `${window.location.pathname}${window.location.search}`;

  const items = useMemo<AdminPaletteItem[]>(() => {
    const sectionItems = sections.map((section) => ({ id: `section-${section.slug || 'root'}`, label: routeLabel(section), kind: 'section' as const, group: section.group, description: section.description, section }));
    const defaults: AdminPaletteItem[] = [
      { id: 'action-orchestrator', label: 'Lancia orchestratore', kind: 'action', group: 'lavoro', description: 'Avvia i crawler schedulati con conferma.' },
      { id: 'action-retry-failed', label: 'Rilancia crawler falliti', kind: 'action', group: 'lavoro', description: 'Apri il registro dei crawler con stato fallito.', onSelect: () => { navigateAdminSection('crawler'); replaceAdminQuery({ stato: 'falliti' }); } },
      { id: 'action-newsletter-preview', label: 'Genera anteprima newsletter', kind: 'action', group: 'redazione', description: 'Apri Newsletter sulla sezione di anteprima.', onSelect: () => { navigateAdminSection('newsletter'); replaceAdminQuery({ azione: 'anteprima' }); } },
    ];
    const orchestrator = defaults.find((item) => item.id === 'action-orchestrator');
    if (orchestrator) orchestrator.onSelect = () => {
      const currentWorkflow = workflowRef.current;
      if (typeof currentWorkflow.runWorkflowWithConfirmation === 'function') void currentWorkflow.runWorkflowWithConfirmation('orchestrate-crawlers.yml');
      else navigateAdminSection('automazioni');
    };
    const all = [...sectionItems, ...defaults, ...paletteItems];
    const seen = new Set<string>();
    return all.filter((item) => { if (seen.has(item.id)) return false; seen.add(item.id); return true; });
  }, [paletteItems, sections]);

  const paletteIndex = useMemo(() => buildAdminPaletteIndex(items), [items]);
  const largeSearch = search === debouncedSearch ? debouncedSearch : '';
  const filteredItems = useMemo(
    () => filterAdminPaletteIndex(paletteIndex, search, largeSearch),
    [largeSearch, paletteIndex, search],
  );

  useEffect(() => { setActiveIndex(0); }, [search]);
  useEffect(() => {
    const timeout = window.setTimeout(() => setDebouncedSearch(search), 100);
    return () => window.clearTimeout(timeout);
  }, [search]);
  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        const target = window.innerWidth < 1024 ? mobileSearchRef.current : searchRef.current;
        target?.focus();
        setSearchOpen(true);
      }
    };
    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
  }, []);

  const selectPaletteItem = (item: AdminPaletteItem) => {
    if (item.section) navigateAdminSection(item.section.slug);
    else item.onSelect?.();
    setSearch('');
    setSearchOpen(false);
  };

  const groupLink = (group: AdminSectionGroup) => sections.find((section) => section.group === group);
  const sectionBadge = (slug: string) => getSectionBadge?.(slug) ?? (slug === 'crawler' ? badgeForGroup('lavoro') : null);

  return (
    <div className="admin-shell min-h-screen bg-surface-alt text-body">
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-[248px] flex-col overflow-y-auto bg-admin-rail px-3 py-5 text-admin-rail-muted lg:flex">
        <div className="flex items-center gap-2 px-2 pb-5 text-sm font-semibold text-admin-rail-ink"><span className="flex h-8 w-8 items-center justify-center rounded-stripe bg-accent text-on-accent" aria-hidden="true"><Command size={17} /></span><span>Frontaliere · Admin</span></div>
        <nav aria-label="Sezioni amministrazione" className="space-y-5">
          {GROUPS.map((group) => {
            const groupSections = sections.filter((section) => section.group === group);
            if (groupSections.length === 0) return null;
            return <div key={group} className="space-y-1"><p className="px-2 text-xs font-normal text-admin-rail-muted">{GROUP_LABELS[group]}</p>{groupSections.map((section) => { const active = section.slug === activeSection; const badge = sectionBadge(section.slug); return <a key={section.slug || 'root'} href={adminSectionPath(section.slug)} aria-current={active ? 'page' : undefined} aria-label={`${routeLabel(section)}${badge ? `, ${badge} elementi da verificare` : ''}`} onClick={(event) => onNavigate(event, section)} title={section.description} className={`flex min-h-10 items-center justify-between gap-2 rounded-stripe px-2.5 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-admin-rail ${active ? 'bg-admin-rail-active text-admin-rail-ink' : 'text-admin-rail-muted hover:bg-admin-rail-active hover:text-admin-rail-ink'}`}><span className="truncate">{routeLabel(section)}</span><NavBadge value={badge} /></a>; })}</div>;
          })}
        </nav>
        <div className="mt-auto border-t border-admin-rail-edge pt-4 text-xs leading-5 text-admin-rail-muted"><p>Accesso proprietario</p><p className="mt-1 opacity-80">Le azioni con effetto sui dati chiedono conferma.</p></div>
      </aside>

      <div className="lg:pl-[248px]">
        <header className="sticky top-0 z-30 hidden min-h-14 items-center gap-4 border-b border-edge bg-surface/95 px-6 backdrop-blur-sm lg:flex"><div className="flex flex-none items-center gap-2 whitespace-nowrap text-sm text-subtle"><span className="shrink-0">{GROUP_LABELS[selectedSection.group]}</span><span aria-hidden="true">/</span><strong className="font-medium text-heading">{routeLabel(selectedSection)}</strong></div><div className="hidden min-w-0 flex-1 items-center gap-2 text-xs text-muted lg:flex"><code className="hidden min-w-0 flex-1 truncate rounded-stripe border border-edge bg-surface-alt px-2 py-1 xl:block">{pathLabel}</code><button type="button" onClick={onCopyLink} className="inline-flex min-h-8 shrink-0 items-center gap-1 whitespace-nowrap rounded-stripe border border-edge px-2.5 py-1 text-xs font-medium text-body transition-colors hover:border-accent hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2">{copyFeedback ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}{copyFeedback ? 'Copiato' : 'Copia link'}</button></div><PaletteInput inputRef={searchRef} items={filteredItems} search={search} setSearch={setSearch} searchOpen={searchOpen} setSearchOpen={setSearchOpen} activeIndex={activeIndex} onActiveIndex={setActiveIndex} onSelect={selectPaletteItem} id="admin-command-desktop" />
        </header>

        <header className="sticky top-0 z-30 flex flex-col gap-3 bg-admin-rail px-4 py-3 text-admin-rail-ink lg:hidden"><div className="flex min-h-8 items-center justify-between gap-3"><div className="flex min-w-0 items-center gap-2 text-sm font-semibold"><span className="flex h-7 w-7 items-center justify-center rounded-stripe bg-accent text-on-accent" aria-hidden="true"><Command size={15} /></span><span className="truncate">Frontaliere · Admin</span></div><span className="shrink-0 text-xs text-admin-rail-muted">{routeLabel(selectedSection)}</span></div><PaletteInput inputRef={mobileSearchRef} items={filteredItems} search={search} setSearch={setSearch} searchOpen={searchOpen} setSearchOpen={setSearchOpen} activeIndex={activeIndex} onActiveIndex={setActiveIndex} onSelect={selectPaletteItem} id="admin-command-mobile" mobile /></header>
        <nav className="flex gap-2 overflow-x-auto border-b border-edge bg-surface px-4 py-2 lg:hidden" aria-label={`Sezioni ${GROUP_LABELS[currentGroup]}`}>{currentGroupSections.map((section) => { const active = section.slug === activeSection; return <a key={section.slug || 'root'} href={adminSectionPath(section.slug)} aria-current={active ? 'page' : undefined} onClick={(event) => onNavigate(event, section)} className={`relative shrink-0 rounded-full border px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${active ? 'border-accent bg-accent-subtle text-accent' : 'border-edge bg-surface text-body hover:border-accent'}`}>{routeLabel(section)}{sectionBadge(section.slug) ? <span className="ml-1.5 align-top text-xs font-semibold text-danger">{sectionBadge(section.slug)}</span> : null}</a>; })}</nav>

        <main className="min-h-screen px-4 pb-28 pt-6 sm:px-6 lg:px-8 lg:pb-10 lg:pt-8" id="admin-main-content"><div className="mx-auto max-w-[1480px]">{children}</div></main>
      </div>

      <nav className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-5 border-t border-edge bg-surface px-1 pt-2 shadow-stripe-md lg:hidden" style={{ paddingBottom: 'calc(0.5rem + env(safe-area-inset-bottom))' }} aria-label="Gruppi amministrazione">{GROUPS.map((group) => { const Icon = GROUP_ICONS[group]; const target = groupLink(group); if (!target) return null; const active = group === currentGroup; const badge = badgeForGroup(group); return <a key={group} href={adminSectionPath(target.slug)} aria-current={active ? 'page' : undefined} aria-label={`${GROUP_LABELS[group]}${badge ? `, ${badge} elementi da verificare` : ''}`} onClick={(event) => onNavigate(event, target)} className={`relative flex min-h-11 flex-col items-center justify-center gap-1 rounded-stripe px-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${active ? 'text-accent' : 'text-subtle hover:bg-surface-alt'}`}><span className="relative"><Icon size={19} aria-hidden="true" /><span className="absolute -right-3 -top-2"><NavBadge value={badge} /></span></span><span>{GROUP_LABELS[group]}</span></a>; })}</nav>
    </div>
  );
}
