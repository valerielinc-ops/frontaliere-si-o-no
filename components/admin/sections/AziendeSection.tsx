import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Building2, Eye, ExternalLink, FileText, Loader2, Mail, MousePointerClick, Pencil, RefreshCw, Save, Search, Users, X } from 'lucide-react';
import { PUBLIC_CONTACT_EMAIL } from '@/services/publicContact';
import { useAuth } from '@/services/authService';
import { fetchAdminEmployerInsights, sendColdEmail, updateEmployerContact, type EmployerInsightsRow } from '@/services/adminInsights';
import { buildSequence, OUTREACH_METRIC_LABELS } from '../../../scripts/lib/cold-email-sequence.mjs';
import { AdminMessageBanner, type AdminMessage } from '@/components/admin/ui/AdminMessageBanner';
import { useAdminConfirm } from '@/components/admin/ui/AdminConfirmDialog';
import { AdminButton } from '@/components/admin/ui/AdminButton';
import { AdminSectionHeader } from '@/components/admin/ui/AdminSectionHeader';
import { AdminStatusPill } from '@/components/admin/ui/AdminStatusPill';
import { relativeTime } from '@/components/admin/lib/formatters';
import { replaceAdminQuery } from '@/components/admin/lib/adminNavigation';
import type { EmployerInsightsWindow, EmployerOutreachStatus, InsightsSortColumn } from '@/components/admin/lib/adminTypes';

function compareNumbers(a: number | null, b: number | null): number { if (a === null && b === null) return 0; if (a === null) return 1; if (b === null) return -1; return a - b; }
function metric(value: number | null): string { return value === null ? 'non disponibile' : value.toLocaleString('it-IT'); }
function metricCard(value: number | null, loading: boolean): { label: string; className: string } {
  if (loading) return { label: 'Caricamento…', className: 'text-sm font-medium text-muted' };
  if (value === null) return { label: 'Dati non disponibili', className: 'text-sm font-medium text-muted' };
  return { label: value.toLocaleString('it-IT'), className: 'text-xl font-semibold tabular-nums text-strong' };
}
function windowLabel(value: EmployerInsightsWindow | null): string { return value ? value.from + ' → ' + value.to + (value.timezone ? ` (${value.timezone})` : '') : 'finestra non disponibile'; }
function windowKey(value: EmployerInsightsWindow | null): string { return value ? `${value.from}|${value.to}|${value.timezone || ''}` : ''; }
function dateLabel(value: string | null): string { if (!value) return '—'; const date = new Date(value); return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString('it-IT', { day: 'numeric', month: 'short', year: 'numeric' }); }

function OutreachStatusBadge({ outreach }: { outreach?: EmployerOutreachStatus }) {
  if (!outreach || (outreach.lastTouch === 0 && !outreach.replied && !outreach.suppressed)) return <AdminStatusPill tone="neutral">—</AdminStatusPill>;
  const sentLabel = outreach.lastTouch > 0 ? `Passaggio ${outreach.lastTouch}${outreach.touchesSent.length > 1 ? ` (${outreach.touchesSent.length})` : ''}` : null;
  return <span className="inline-flex flex-wrap items-center gap-1">{sentLabel && <AdminStatusPill tone="neutral">{sentLabel}</AdminStatusPill>}{outreach.suppressed ? <AdminStatusPill tone="danger">Opt-out</AdminStatusPill> : outreach.replied ? <AdminStatusPill tone="success">Ha risposto{outreach.replyCount > 1 ? ` (${outreach.replyCount})` : ''}</AdminStatusPill> : sentLabel ? <AdminStatusPill tone="neutral">In attesa</AdminStatusPill> : null}</span>;
}

export default function AziendeSection() {
  const { user } = useAuth();
  const { requestConfirmation } = useAdminConfirm();
  const [rows, setRows] = useState<EmployerInsightsRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState(() => new URLSearchParams(window.location.search).get('q') || '');
  const [sort, setSort] = useState<{ column: InsightsSortColumn; direction: 'asc' | 'desc' }>({ column: 'views', direction: 'desc' });
  const [modalKey, setModalKey] = useState<string | null>(null);
  const [emailDraft, setEmailDraft] = useState('');
  const [nameDraft, setNameDraft] = useState('');
  const [roleDraft, setRoleDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<AdminMessage | null>(null);
  const [previewTouch, setPreviewTouch] = useState(1);
  const [sending, setSending] = useState(false);
  const [sendMessage, setSendMessage] = useState<AdminMessage | null>(null);
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const dialogCloseRef = useRef<HTMLButtonElement | null>(null);
  const dialogTriggerRef = useRef<HTMLElement | null>(null);

  const loadInsights = async () => { setLoading(true); setError(null); try { setRows(await fetchAdminEmployerInsights(user)); } catch (err) { setError(err instanceof Error ? err.message : 'Errore sconosciuto'); } finally { setLoading(false); } };
  useEffect(() => { void loadInsights(); }, []);

  const modalRow = useMemo(() => rows.find((row) => row.companyKey === modalKey) || null, [modalKey, rows]);
  const openModal = (row: EmployerInsightsRow) => {
    dialogTriggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setModalKey(row.companyKey); setEmailDraft(row.contactEmail || ''); setNameDraft(row.contactName || ''); setRoleDraft(row.topRole || ''); setSaveMessage(null); setSendMessage(null); setPreviewTouch(1);
    if (new URLSearchParams(window.location.search).get('azienda') !== row.companyKey) replaceAdminQuery({ azienda: row.companyKey });
  };

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!modalRow || !dialog || dialog.open) return;
    if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', '');
    window.setTimeout(() => dialogCloseRef.current?.focus(), 0);
  }, [modalRow]);

  useEffect(() => { const key = new URLSearchParams(window.location.search).get('azienda'); if (key) { const row = rows.find((candidate) => candidate.companyKey === key); if (row && modalKey !== row.companyKey) openModal(row); } else if (modalKey) setModalKey(null); }, [rows, modalKey]);

  const draftsChanged = Boolean(modalRow && (emailDraft.trim().toLowerCase() !== String(modalRow.contactEmail || '').trim().toLowerCase() || nameDraft.trim() !== String(modalRow.contactName || '').trim() || roleDraft.trim() !== String(modalRow.topRole || '').trim()));
  const completeClose = () => {
    setModalKey(null); setSaveMessage(null); replaceAdminQuery({ azienda: null });
    const trigger = dialogTriggerRef.current; dialogTriggerRef.current = null;
    window.setTimeout(() => trigger?.focus(), 0);
  };
  const closeModal = async () => {
    if (!modalRow) return;
    if (draftsChanged) {
      const confirmed = await requestConfirmation({
        title: 'Chiudi senza salvare',
        what: 'Stai per chiudere il dettaglio azienda con modifiche locali ancora aperte.',
        impact: 'Le modifiche al contatto verranno scartate.',
        input: modalRow.companyName,
        expectedDuration: 'meno di 1 min',
        confirmLabel: 'Scarta modifiche',
        confirmVariant: 'danger',
      });
      if (!confirmed) return;
    }
    if (dialogRef.current?.open) {
      if (typeof dialogRef.current.close === 'function') dialogRef.current.close();
      else { dialogRef.current.removeAttribute('open'); completeClose(); }
    } else completeClose();
  };
  const saveContact = async (): Promise<boolean> => {
    if (!modalRow) return false;
    const email = emailDraft.trim().toLowerCase();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { setSaveMessage({ kind: 'error', text: 'Email non valida.' }); return false; }
    const clearEmail = !email && !!modalRow.contactEmail;
    setSaving(true); setSaveMessage(null);
    try { await updateEmployerContact(user, { companyKey: modalRow.companyKey, ...(email ? { email } : {}), ...(clearEmail ? { clearEmail: true } : {}), contactName: nameDraft.trim(), topRole: roleDraft.trim() }); const nextEmail = email ? email : clearEmail ? '' : modalRow.contactEmail; setRows((current) => current.map((row) => row.companyKey === modalRow.companyKey ? { ...row, contactEmail: nextEmail, contactName: nameDraft.trim(), topRole: roleDraft.trim() } : row)); setSaveMessage({ kind: 'ok', text: 'Contatto salvato.' }); return true; }
    catch (err) { setSaveMessage({ kind: 'error', text: err instanceof Error ? err.message : 'Errore salvataggio.' }); return false; }
    finally { setSaving(false); }
  };

  const previewTouches = useMemo(() => {
    if (!modalRow) return [];
    const touches = buildSequence({ company: modalRow.companyName, metricValue: modalRow.totals.applyClicks, metricLabel: OUTREACH_METRIC_LABELS.applyClicks, periodLabel: modalRow.window ? `${modalRow.window.from} → ${modalRow.window.to}` : '', contactName: nameDraft, topRole: roleDraft, optOutEmail: PUBLIC_CONTACT_EMAIL });
    return touches.map((touch) => ({ ...touch, body: touch.body.split('{{INSIGHTS_URL}}').join(modalRow.insightsUrl).split('{{UNSUB_URL}}').join('[link disiscrizione one-click — generato all’invio]') }));
  }, [modalRow, nameDraft, roleDraft]);

  const sendTouch = async (force: boolean) => {
    if (!modalRow) return;
    const touch = previewTouch; const email = emailDraft.trim().toLowerCase() || modalRow.contactEmail;
    if (draftsChanged && !emailDraft.trim()) { setSendMessage({ kind: 'error', text: 'Salva un’email verificata prima di inviare il passaggio.' }); return; }
    if (!email) { setSendMessage({ kind: 'error', text: 'Imposta prima un’email verificata per questa azienda.' }); return; }
    const confirmed = await requestConfirmation({
      title: force ? 'Forza nuovo invio' : 'Invia passaggio di contatto',
      what: force ? `Il passaggio ${touch} è già stato inviato a ${email}.` : `Stai per inviare il passaggio ${touch} a ${email}.`,
      impact: draftsChanged && !force ? 'Salva il contatto e invia un’email esterna.' : 'Invia un’email esterna e registra il passaggio nel tracking.',
      input: `azienda=${modalRow.companyKey}, passaggio=${touch}, destinatario=${email}`,
      expectedDuration: 'meno di 1 min',
      confirmLabel: force ? 'Forza invio' : draftsChanged ? 'Salva e invia' : 'Invia passaggio',
      confirmVariant: force ? 'danger' : 'primary',
    });
    if (!confirmed) return;
    if (draftsChanged && !force && !(await saveContact())) return;
    setSending(true); setSendMessage(null);
    try { const response = await sendColdEmail(user, modalRow.companyKey, touch, force); const sentAt = new Date().toISOString(); setRows((current) => current.map((row) => row.companyKey !== modalRow.companyKey ? row : { ...row, outreach: { lastTouch: Math.max(touch, row.outreach?.lastTouch || 0), lastSentAt: sentAt, touchesSent: [...new Set([...(row.outreach?.touchesSent || []), touch])].sort((a, b) => a - b), sendCount: (row.outreach?.sendCount || 0) + 1, replied: row.outreach?.replied || false, lastRepliedAt: row.outreach?.lastRepliedAt || null, replyCount: row.outreach?.replyCount || 0, suppressed: row.outreach?.suppressed || false, suppressedAt: row.outreach?.suppressedAt || null } })); setSendMessage({ kind: response.tracked ? 'ok' : 'warn', text: response.tracked ? `Passaggio ${touch} inviato a ${response.to}.` : `Inviato a ${response.to}, ma il tracking non è stato scritto (ricontrolla più tardi).` }); }
    catch (err) { setSendMessage({ kind: 'error', text: err instanceof Error ? err.message : 'Invio non riuscito.' }); }
    finally { setSending(false); }
  };

  const filteredRows = useMemo(() => {
    const query = filter.trim().toLowerCase(); const filtered = query ? rows.filter((row) => row.companyName.toLowerCase().includes(query) || row.companyKey.toLowerCase().includes(query)) : rows; const direction = sort.direction === 'asc' ? 1 : -1;
    return [...filtered].sort((a, b) => { switch (sort.column) { case 'companyName': return a.companyName.localeCompare(b.companyName) * direction; case 'generatedAt': return String(a.generatedAt || '').localeCompare(String(b.generatedAt || '')) * direction; case 'window': return windowKey(a.window).localeCompare(windowKey(b.window)) * direction; case 'views': return compareNumbers(a.totals.views, b.totals.views) * direction; case 'applyClicks': return compareNumbers(a.totals.applyClicks, b.totals.applyClicks) * direction; case 'applyClickUsers': return compareNumbers(a.totals.applyClickUsers, b.totals.applyClickUsers) * direction; case 'applications': return compareNumbers(a.totals.applications, b.totals.applications) * direction; case 'profileViews': return compareNumbers(a.totals.profileViews, b.totals.profileViews) * direction; case 'adsObserved': return compareNumbers(a.totals.adsObserved, b.totals.adsObserved) * direction; default: return 0; } });
  }, [filter, rows, sort]);

  const insightsTotals = useMemo(() => {
    const firstSource = rows[0]?.source || null;
    const commonSource = firstSource && rows.every(r => r.source === firstSource) ? firstSource : null;
    const firstWindow = rows[0]?.window || null;
    const commonWindow = commonSource && firstWindow && rows.every(r => windowKey(r.window) === windowKey(firstWindow)) ? firstWindow : null;
    const sum = (get: (row: EmployerInsightsRow) => number | null): number | null => !commonSource || !commonWindow || rows.some(r => get(r) === null) ? null : rows.reduce((total, row) => total + (get(row) || 0), 0);
    return { source: commonSource, window: commonWindow, views: sum(r => r.totals.views), applyClicks: sum(r => r.totals.applyClicks), applyClickUsers: sum(r => r.totals.applyClickUsers), applications: sum(r => r.totals.applications) };
  }, [rows]);

  const toggleSort = (column: InsightsSortColumn) => setSort((current) => current.column === column ? { column, direction: current.direction === 'asc' ? 'desc' : 'asc' } : { column, direction: column === 'companyName' ? 'asc' : 'desc' });
  const headers: Array<{ column: InsightsSortColumn; label: string }> = [{ column: 'companyName', label: 'Azienda' }, { column: 'views', label: 'Visualizzazioni annuncio' }, { column: 'applyClicks', label: 'Click candidatura' }, { column: 'applyClickUsers', label: 'Utenti click' }, { column: 'applications', label: 'Candidature inviate' }, { column: 'profileViews', label: 'Visite profilo' }, { column: 'adsObserved', label: 'Annunci osservati' }, { column: 'generatedAt', label: 'Data' }, { column: 'window', label: 'Finestra' }];
  const latestInsightsUpdate = rows.map((row) => row.generatedAt).filter((value): value is string => Boolean(value)).sort().at(-1) || null;

  return (
    <div className="space-y-4">
      <AdminSectionHeader title="Aziende" summary={`${rows.length} aziende con dati di traffico · aggiornato ${relativeTime(latestInsightsUpdate) || (loading ? 'in corso' : 'adesso')}`} secondaryActions={<AdminButton icon={<RefreshCw size={16} aria-hidden="true" />} loading={loading} onClick={() => void loadInsights()}>Aggiorna</AdminButton>} />
      {error && <div className="bg-danger-subtle border border-danger-border rounded-stripe px-3 py-2 text-sm text-danger">{error}</div>}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">{[['Visualizzazioni annuncio', insightsTotals.views, Eye], ['Click candidatura', insightsTotals.applyClicks, MousePointerClick], ['Utenti click', insightsTotals.applyClickUsers, Users], ['Candidature inviate', insightsTotals.applications, FileText]].map(([label, value, Icon]) => { const cardMetric = metricCard(value as number | null, loading); return <div key={String(label)} className="bg-surface rounded-stripe border border-edge p-4"><div className="mb-1 flex items-center gap-2 text-sm text-subtle">{Icon && <Icon size={16} />}{label}</div><div className={cardMetric.className}>{cardMetric.label}</div></div>; })}</div>
      <div className="relative"><Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" /><input value={filter} onChange={(event) => { const value = event.target.value; setFilter(value); replaceAdminQuery({ q: value.trim() || null }); }} placeholder="Cerca azienda…" aria-label="Cerca azienda per nome" className="w-full pl-9 pr-3 py-2 rounded-stripe border border-edge bg-surface text-strong text-sm" /></div>
      <div className="bg-surface rounded-stripe border border-edge px-4 py-3"><p className="text-sm text-muted">Traffico reale per azienda crawlata. Usa «Apri come azienda» per vedere la pagina prova-statistiche esattamente come la riceve l&apos;azienda (link tokenizzato privato).</p><p className="mt-1 text-xs text-muted">Sorgente/finestra aggregati: {rows.length === 0 ? 'Dati non disponibili' : insightsTotals.window && insightsTotals.source ? `${insightsTotals.source} · ${windowLabel(insightsTotals.window)}` : 'non aggregabile (fonti/finestre diverse o non disponibili)'}</p></div>
      <p className="text-xs text-muted">{loading ? 'Caricamento…' : `${filteredRows.length} aziende${filter ? ` (di ${rows.length})` : ''}`}</p>
      <div className="hidden md:block overflow-x-auto rounded-stripe border border-edge"><table className="w-full text-sm tabular-nums"><caption className="sr-only">Insights di traffico per azienda crawlata</caption><thead className="bg-surface-alt text-subtle"><tr>{headers.map((header) => <th key={header.column} scope="col" aria-sort={sort.column === header.column ? sort.direction === 'asc' ? 'ascending' : 'descending' : 'none'} className="px-3 py-2 font-semibold text-left"><button type="button" onClick={() => toggleSort(header.column)} className="inline-flex min-h-8 items-center gap-1 rounded-stripe px-1 hover:bg-surface-raised hover:text-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">{header.label}{sort.column === header.column && (sort.direction === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}</button></th>)}<th className="px-3 py-2 text-left font-semibold">Outreach</th><th className="px-3 py-2 text-right font-semibold">Azione</th></tr></thead><tbody>{filteredRows.map((row) => <tr key={row.companyKey} className="border-t border-edge hover:bg-surface-alt/50"><td className="px-3 py-2"><div className="text-strong font-medium">{row.companyName}</div><div className="mt-0.5 flex items-center gap-1 text-xs"><Mail size={11} className={row.contactEmail ? 'text-success' : 'text-muted'} />{row.contactEmail ? <span className="text-muted truncate max-w-[220px]">{row.contactEmail}</span> : row.contactEmailInferred ? <span className="text-warning truncate max-w-[220px]" title="Email inferita (mai inviata in automatico)">{row.contactEmailInferred} (inferita)</span> : <span className="text-muted italic">contatto mancante</span>}</div></td><td className="px-3 py-2 text-right text-body">{metric(row.totals.views)}</td><td className="px-3 py-2 text-right text-body">{metric(row.totals.applyClicks)}</td><td className="px-3 py-2 text-right text-body">{metric(row.totals.applyClickUsers)}</td><td className="px-3 py-2 text-right text-body">{metric(row.totals.applications)}</td><td className="px-3 py-2 text-right text-body">{metric(row.totals.profileViews)}</td><td className="px-3 py-2 text-right text-body">{metric(row.totals.adsObserved)}</td><td className="px-3 py-2 text-right text-muted whitespace-nowrap">{dateLabel(row.generatedAt)}</td><td className="px-3 py-2 text-right text-muted whitespace-nowrap">{windowLabel(row.window)}</td><td className="px-3 py-2"><OutreachStatusBadge outreach={row.outreach} /></td><td className="px-3 py-2 text-right whitespace-nowrap"><button type="button" onClick={() => openModal(row)} className="inline-flex min-h-8 items-center gap-1 rounded-stripe border border-edge bg-surface-raised px-2 py-1 text-xs font-medium text-body hover:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" aria-label={`Contatto e anteprima email per ${row.companyName}`}><Mail size={12} />Email</button>{' '}<a href={row.insightsUrl} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-8 items-center gap-1 rounded-stripe border border-accent bg-accent-subtle px-2 py-1 text-xs font-medium text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" aria-label={`Apri la pagina statistiche di ${row.companyName} come azienda`}>Apri come azienda <ExternalLink size={12} /></a></td></tr>)}{!loading && filteredRows.length === 0 && <tr><td colSpan={11} className="px-3 py-6 text-center text-muted">Nessuna azienda trovata.</td></tr>}</tbody></table></div>
      <div className="md:hidden space-y-3">{filteredRows.map((row) => <div key={row.companyKey} className="bg-surface rounded-stripe border border-edge p-4 space-y-2"><div className="font-semibold text-strong">{row.companyName}</div><div className="flex items-center gap-1 text-xs"><Mail size={12} className={row.contactEmail ? 'text-success' : 'text-muted'} />{row.contactEmail ? <span className="text-muted truncate">{row.contactEmail}</span> : row.contactEmailInferred ? <span className="text-warning truncate">{row.contactEmailInferred} (inferita)</span> : <span className="text-muted italic">contatto mancante</span>}</div><div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs"><div><span className="block text-muted">Visualizzazioni</span><span className="text-body">{metric(row.totals.views)}</span></div><div><span className="block text-muted">Click candidatura</span><span className="text-body">{metric(row.totals.applyClicks)}</span></div><div><span className="block text-muted">Utenti click</span><span className="text-body">{metric(row.totals.applyClickUsers)}</span></div><div><span className="block text-muted">Candidature inviate</span><span className="text-body">{metric(row.totals.applications)}</span></div><div><span className="block text-muted">Visite profilo</span><span className="text-body">{metric(row.totals.profileViews)}</span></div><div><span className="block text-muted">Annunci osservati</span><span className="text-body">{metric(row.totals.adsObserved)}</span></div><div><span className="block text-muted">Data</span><span className="text-body">{dateLabel(row.generatedAt)}</span></div><div className="col-span-2 sm:col-span-3"><span className="block text-muted">Finestra</span><span className="text-body">{windowLabel(row.window)}</span></div></div><div className="flex items-center gap-1.5 text-xs"><span className="text-muted">Outreach:</span><OutreachStatusBadge outreach={row.outreach} /></div><div className="grid grid-cols-2 gap-2"><button type="button" onClick={() => openModal(row)} className="inline-flex min-h-10 items-center justify-center gap-1 rounded-stripe border border-edge bg-surface-raised px-3 py-2 text-sm font-medium text-body focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" aria-label={`Contatto e anteprima email per ${row.companyName}`}><Mail size={14} />Email</button><a href={row.insightsUrl} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-10 items-center justify-center gap-1 rounded-stripe border border-accent bg-accent px-3 py-2 text-sm font-medium text-on-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" aria-label={`Apri la pagina statistiche di ${row.companyName} come azienda`}>Azienda <ExternalLink size={14} /></a></div></div>)}{!loading && filteredRows.length === 0 && <p className="text-center text-muted py-6">Nessuna azienda trovata.</p>}</div>
      {modalRow && <dialog ref={dialogRef} aria-labelledby="azienda-dialog-title" onCancel={(event) => { event.preventDefault(); void closeModal(); }} onClose={completeClose} className="m-auto max-h-[92vh] w-[min(100%-1rem,42rem)] overflow-y-auto rounded-stripe border border-edge bg-surface p-0 text-body shadow-stripe-lg backdrop:bg-heading/50"><div className="w-full"><div className="sticky top-0 bg-surface border-b border-edge px-4 py-3 flex items-center justify-between"><div><h3 id="azienda-dialog-title" className="text-base font-semibold text-strong flex items-center gap-2"><Building2 size={18} className="text-accent" />{modalRow.companyName}</h3><p className="text-xs text-muted">{metric(modalRow.totals.applyClicks)} click candidatura · {metric(modalRow.totals.applyClickUsers)} utenti click · {metric(modalRow.totals.views)} visualizzazioni</p><p className="text-sm text-muted">Finestra: {windowLabel(modalRow.window)} · Sorgente: {modalRow.source || 'non disponibile'}</p><div className="mt-1.5 flex items-center gap-1.5 text-xs"><span className="text-muted">Outreach:</span><OutreachStatusBadge outreach={modalRow.outreach} /></div></div><button ref={dialogCloseRef} type="button" onClick={() => void closeModal()} className="inline-flex min-h-10 min-w-10 items-center justify-center rounded-stripe text-muted hover:bg-surface-alt hover:text-heading focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" aria-label="Chiudi"><X size={18} /></button></div>
        <div className="px-4 py-4 space-y-5"><section className="space-y-3"><h4 className="text-sm font-semibold text-strong flex items-center gap-1.5"><Pencil size={14} className="text-accent" />Contatto destinatario</h4><label className="block text-xs text-subtle">Email contatto<input type="email" inputMode="email" value={emailDraft} onChange={(event) => setEmailDraft(event.target.value)} placeholder="es. hr@azienda.ch (vuoto = nessun invio)" aria-label="Email contatto azienda" className="mt-1 w-full px-3 py-2 rounded-stripe border border-edge bg-surface-alt text-strong text-sm" /></label>{modalRow.contactEmailInferred && !emailDraft.trim() && <p className="text-xs text-warning">Suggerimento inferito (mai inviato in automatico): <button type="button" className="underline" onClick={() => setEmailDraft(modalRow.contactEmailInferred || '')}>{modalRow.contactEmailInferred}</button></p>}<div className="grid grid-cols-1 sm:grid-cols-2 gap-3"><label className="block text-xs text-subtle">Nome contatto<input value={nameDraft} onChange={(event) => setNameDraft(event.target.value)} placeholder="es. Denise" aria-label="Nome contatto" className="mt-1 w-full px-3 py-2 rounded-stripe border border-edge bg-surface-alt text-strong text-sm" /></label><label className="block text-xs text-subtle">Ruolo più cliccato<input value={roleDraft} onChange={(event) => setRoleDraft(event.target.value)} placeholder="es. Infermiere/a" aria-label="Ruolo più cliccato" className="mt-1 w-full px-3 py-2 rounded-stripe border border-edge bg-surface-alt text-strong text-sm" /></label></div><div className="flex items-center gap-3 flex-wrap"><button type="button" onClick={() => void saveContact()} disabled={saving} className="inline-flex items-center gap-2 px-4 py-2 rounded-stripe bg-accent text-on-accent text-sm font-semibold disabled:opacity-60">{saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} {saving ? 'Salvataggio…' : 'Salva contatto'}</button>{saveMessage && <AdminMessageBanner message={saveMessage} />}</div></section>
          <section className="space-y-3"><h4 className="text-sm font-semibold text-strong flex items-center gap-1.5"><Eye size={14} className="text-accent" />Anteprima email che invieremo</h4><p className="text-xs text-muted">Sequenza reale (4 passaggi) personalizzata coi dati sopra. Identica a ciò che invia lo script di outreach.</p><div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Passaggi della sequenza">{previewTouches.map((touch) => <button key={touch.touch} type="button" role="tab" aria-selected={previewTouch === touch.touch} onClick={() => { setPreviewTouch(touch.touch); setSendMessage(null); }} className={`min-h-8 rounded-stripe border px-2.5 py-1 text-xs font-medium ${previewTouch === touch.touch ? 'border-accent bg-accent-subtle text-accent' : 'border-edge bg-surface-alt text-body'}`}>Passaggio {touch.touch}{touch.gapDays ? ` · +${touch.gapDays}g` : ''}</button>)}</div>{previewTouches.filter((touch) => touch.touch === previewTouch).map((touch) => <div key={touch.touch} className="rounded-stripe border border-edge bg-surface-alt overflow-hidden"><div className="px-3 py-2 border-b border-edge bg-surface-raised"><span className="text-xs uppercase tracking-wide text-muted">Oggetto</span><div className="text-sm font-semibold text-strong">{touch.subject}</div></div><pre className="px-3 py-3 text-sm text-body whitespace-pre-wrap font-sans leading-relaxed">{touch.body}</pre></div>)}<div className="space-y-2 rounded-stripe border border-edge bg-surface-raised px-3 py-3">{modalRow.outreach?.suppressed ? <p className="text-xs text-danger">Azienda in opt-out (STOP/disiscrizione) — invio bloccato.</p> : !modalRow.contactEmail && !emailDraft.trim() ? <p className="text-xs text-subtle">Imposta un’email verificata qui sopra per abilitare l’invio.</p> : modalRow.outreach?.touchesSent?.includes(previewTouch) ? <div className="flex flex-wrap items-center gap-2"><span className="text-xs text-muted">Passaggio {previewTouch} già inviato{modalRow.outreach?.lastSentAt ? ` (${dateLabel(modalRow.outreach.lastSentAt)})` : ''}.</span><button type="button" disabled={sending} onClick={() => void sendTouch(true)} className="inline-flex min-h-10 items-center gap-2 rounded-stripe border border-edge bg-surface-muted px-3 py-1.5 text-xs font-semibold text-body focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">{sending && <Loader2 size={14} className="animate-spin" />}Forza re-invio</button></div> : <button type="button" disabled={sending} onClick={() => void sendTouch(false)} className="inline-flex min-h-10 items-center gap-2 rounded-stripe border border-success-strong bg-success-strong px-3 py-2 text-sm font-semibold text-on-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-success">{sending && <Loader2 size={14} className="animate-spin" />}{sending ? 'Invio…' : draftsChanged ? `Salva e invia passaggio ${previewTouch}` : `Invia passaggio ${previewTouch} a ${modalRow.contactEmail}`}</button>}{sendMessage && <p role={sendMessage.kind === 'error' ? 'alert' : 'status'} className={`text-xs ${sendMessage.kind === 'error' ? 'text-danger' : sendMessage.kind === 'warn' ? 'text-warning' : 'text-success'}`}>{sendMessage.text}</p>}</div><a href={modalRow.insightsUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-accent hover:underline">Apri la pagina statistiche come la vede l’azienda <ExternalLink size={12} /></a></section></div>
      </div></dialog>}
    </div>
  );
}
