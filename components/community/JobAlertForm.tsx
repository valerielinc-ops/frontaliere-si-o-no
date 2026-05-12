/**
 * FRO-332: Job Alert Form — allows users to subscribe to email notifications
 * when new jobs matching their criteria are published.
 *
 * Integrates with jobAlertService.ts for Firestore CRUD.
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useTranslation } from '@/services/i18n';
import { Bell, BellRing, Trash2, ChevronDown, ChevronUp, Loader2, Pencil } from 'lucide-react';
import type { JobAlert, JobAlertConfig } from '@/services/jobAlertService';
import { listCantonOptions, getCantonLabel, type CantonLocale } from '@/services/cantonList';

// ── Types ────────────────────────────────────────────────────

interface JobAlertFormProps {
 /** Currently authenticated user (null if not logged in) */
 authUser: { uid: string; email?: string | null } | null;
 /** Callback to trigger auth flow when user isn't logged in */
 onRequireAuth?: () => void;
 /** Pre-fill the keyword from current search query */
 initialKeyword?: string;
}

// ── Constants ────────────────────────────────────────────────

const LOCATIONS = [
 { value: 'Lugano', label: 'Lugano' },
 { value: 'Mendrisio', label: 'Mendrisio' },
 { value: 'Bellinzona', label: 'Bellinzona' },
 { value: 'Locarno', label: 'Locarno' },
 { value: 'Chiasso', label: 'Chiasso' },
 { value: 'Coira', label: 'Coira / Chur' },
];

const CONTRACT_TYPES = [
 { value: 'full-time', labelKey: 'jobBoard.contract.fullTime' },
 { value: 'part-time', labelKey: 'jobBoard.contract.partTime' },
 { value: 'temporary', labelKey: 'jobBoard.contract.temporary' },
 { value: 'internship', labelKey: 'jobBoard.contract.internship' },
];

const SECTORS = [
 { value: 'Fintech / Blockchain', label: 'Fintech' },
 { value: 'Tecnologia / Data Center', label: 'Tecnologia' },
 { value: 'Consulenza', label: 'Consulenza' },
 { value: 'Sanità / Assistenza', label: 'Sanità' },
 { value: 'Farmaceutica / Biotecnologia', label: 'Farmaceutica' },
 { value: 'Ospitalità / Hotellerie', label: 'Ospitalità' },
 { value: 'Banca / Gestione patrimoniale', label: 'Banca' },
 { value: 'Amministrazione Pubblica', label: 'Amm. Pubblica' },
 { value: 'Edilizia e tecnica', label: 'Edilizia' },
 { value: 'Istruzione e ricerca', label: 'Istruzione' },
];

// ── Component ────────────────────────────────────────────────

export default function JobAlertForm({ authUser, onRequireAuth, initialKeyword = '' }: JobAlertFormProps) {
 const { t, locale } = useTranslation();
 const [expanded, setExpanded] = useState(false);
 const [keyword, setKeyword] = useState(initialKeyword);
 const [selectedLocations, setSelectedLocations] = useState<string[]>([]);
 const [selectedContracts, setSelectedContracts] = useState<string[]>([]);
 const [selectedSectors, setSelectedSectors] = useState<string[]>([]);
 const [selectedCantons, setSelectedCantons] = useState<string[]>([]);
 const [cantonPickerOpen, setCantonPickerOpen] = useState(false);
 const [frequency, setFrequency] = useState<'daily' | 'weekly'>('daily');
 const [saving, setSaving] = useState(false);
 const [alerts, setAlerts] = useState<JobAlert[]>([]);
 const [loadingAlerts, setLoadingAlerts] = useState(false);
 const [editingAlertId, setEditingAlertId] = useState<string | null>(null);
 const [toast, setToast] = useState<string | null>(null);

 // Update keyword when search changes
 useEffect(() => {
 if (initialKeyword) setKeyword(initialKeyword);
 }, [initialKeyword]);

 // Auto-expand after the user has completed ≥2 distinct non-empty searches
 // (debounced 800ms to avoid counting every keystroke). Once expanded via
 // this path, we don't auto-collapse — user stays in control afterwards.
 const distinctSearchesRef = useRef<Set<string>>(new Set());
 const autoExpandedRef = useRef(false);
 useEffect(() => {
 if (autoExpandedRef.current || expanded) return;
 const k = (initialKeyword || '').trim();
 if (k.length < 2) return;
 const timer = window.setTimeout(() => {
 distinctSearchesRef.current.add(k.toLowerCase());
 if (distinctSearchesRef.current.size >= 2) {
 autoExpandedRef.current = true;
 setExpanded(true);
 import('@/services/analytics')
 .then(({ Analytics }) => Analytics.trackJobAlertCtaClick('inline_card', 'auto_expand', k))
 .catch(() => {});
 }
 }, 800);
 return () => window.clearTimeout(timer);
 }, [initialKeyword, expanded]);

 // Listen for external requests to open the form (sticky banner, end-of-list
 // card, post-auth prompt). Scrolls into view and expands. The optional
 // `detail.keyword` lets the caller seed the keyword field — used by the
 // post-auth prompt on a job-detail view, where the prompt's resolved
 // keyword differs from the (empty) site-wide searchQuery prop.
 useEffect(() => {
 const handler = (event: Event) => {
 const detail = (event as CustomEvent<{ keyword?: string }>).detail;
 if (detail?.keyword) setKeyword(detail.keyword);
 setExpanded(true);
 window.setTimeout(() => {
 document.getElementById('job-alert-form')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
 }, 60);
 };
 window.addEventListener('openJobAlert', handler);
 return () => window.removeEventListener('openJobAlert', handler);
 }, []);

 // Load user's existing alerts
 useEffect(() => {
 if (!authUser) {
 setAlerts([]);
 return;
 }
 setLoadingAlerts(true);
 import('@/services/jobAlertService')
 .then((m) => m.getUserAlerts(authUser.uid))
 .then(setAlerts)
 .catch(() => {})
 .finally(() => setLoadingAlerts(false));
 }, [authUser]);

 const typedLocale = (locale as CantonLocale) || 'it';
 const cantonOptions = useMemo(() => listCantonOptions(typedLocale), [typedLocale]);

 const showToast = useCallback((msg: string) => {
 setToast(msg);
 setTimeout(() => setToast(null), 3000);
 }, []);

 const handleCreate = async () => {
 if (!authUser) {
 onRequireAuth?.();
 return;
 }

 if (!keyword.trim() && selectedLocations.length === 0) {
 showToast(t('jobAlert.error.emptyFields') || 'Inserisci almeno una keyword o una zona.');
 return;
 }

 setSaving(true);
 try {
 const { createAlert } = await import('@/services/jobAlertService');
 const config: JobAlertConfig = {
 keywords: keyword.trim() ? keyword.trim().split(/[,;]+/).map((k) => k.trim()).filter(Boolean) : [],
 locations: selectedLocations,
 contractTypes: selectedContracts,
 sectors: selectedSectors,
 // Cathedral CH-wide geo scoping (CATHEDRAL-STATUS #12): empty selection
 // = "all cantons" (legacy behaviour), explicit codes scope the alert.
 cantonFilter: selectedCantons.length > 0 ? selectedCantons : null,
 frequency,
 locale: locale as 'it' | 'en' | 'de' | 'fr',
 };
 const alert = await createAlert(authUser.uid, authUser.email || '', config);
 setAlerts((prev) => [alert, ...prev]);
 // FRO-334: Track alert creation
 import('@/services/analytics').then(({ Analytics }) => {
 Analytics.trackJobAlertCreated({
 keywords: config.keywords.join(', '),
 location: config.locations.join(', '),
 frequency: config.frequency,
 });
 }).catch(() => {});
 showToast(t('jobAlert.created') || 'Alert creata! Riceverai una email con le nuove offerte.');
 // Reset form
 setKeyword('');
 setSelectedLocations([]);
 setSelectedContracts([]);
 setSelectedSectors([]);
 setSelectedCantons([]);
 setCantonPickerOpen(false);
 setExpanded(false);
 } catch (err: any) {
 showToast(err?.message || 'Errore durante la creazione dell\'alert.');
 } finally {
 setSaving(false);
 }
 };

 const handleDelete = async (alertId: string) => {
 const target = alerts.find((a) => a.id === alertId);
 const email = target?.email || authUser?.email;
 if (!email) {
 showToast('Errore durante l\'eliminazione.');
 return;
 }
 try {
 const { deleteAlert } = await import('@/services/jobAlertService');
 await deleteAlert(email, alertId);
 // FRO-334: Track alert deletion
 import('@/services/analytics').then(({ Analytics }) => Analytics.trackJobAlertDeleted()).catch(() => {});
 setAlerts((prev) => prev.filter((a) => a.id !== alertId));
 showToast(t('jobAlert.deleted') || 'Alert eliminata.');
 } catch {
 showToast('Errore durante l\'eliminazione.');
 }
 };

 const handleUpdateFrequency = async (alertId: string, newFrequency: 'daily' | 'weekly') => {
 const target = alerts.find((a) => a.id === alertId);
 const email = target?.email || authUser?.email;
 if (!email) {
 showToast('Errore durante l\'aggiornamento.');
 return;
 }
 try {
 const { updateAlert } = await import('@/services/jobAlertService');
 await updateAlert(email, alertId, { frequency: newFrequency });
 setAlerts((prev) =>
 prev.map((a) => (a.id === alertId ? { ...a, frequency: newFrequency } : a)),
 );
 setEditingAlertId(null);
 showToast(t('jobAlert.updated') || 'Alert aggiornata.');
 } catch {
 showToast('Errore durante l\'aggiornamento.');
 }
 };

 const toggleLocation = (loc: string) => {
 setSelectedLocations((prev) =>
 prev.includes(loc) ? prev.filter((l) => l !== loc) : [...prev, loc],
 );
 };

 const toggleContract = (ct: string) => {
 setSelectedContracts((prev) =>
 prev.includes(ct) ? prev.filter((c) => c !== ct) : [...prev, ct],
 );
 };

 const toggleSector = (s: string) => {
 setSelectedSectors((prev) =>
 prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s],
 );
 };

 const toggleCanton = (code: string) => {
 setSelectedCantons((prev) =>
 prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code],
 );
 };

 const clearCantons = () => {
 setSelectedCantons([]);
 };

 return (
 <div className="mt-4 mb-6">
 {/* Trigger card */}
 <button
 onClick={() => {
 if (!expanded) {
 import('@/services/analytics')
 .then(({ Analytics }) => Analytics.trackJobAlertCtaClick('inline_card', 'open', initialKeyword))
 .catch(() => {});
 }
 setExpanded(!expanded);
 }}
 aria-expanded={expanded}
 aria-controls="job-alert-form"
 className="w-full flex items-center gap-3 p-4 rounded-xl border border-accent-border bg-accent-subtle hover:bg-accent-subtle hover:border-accent transition-colors text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
 >
 <span className="flex-shrink-0 inline-flex items-center justify-center w-10 h-10 rounded-full bg-accent-strong text-on-accent shadow-sm">
 <BellRing className="w-5 h-5" aria-hidden="true" />
 </span>
 <span className="flex-1 min-w-0">
 <span className="flex items-center gap-2">
 <span className="block text-sm font-semibold text-strong">
 {alerts.length > 0
 ? (t('jobAlert.cardTitleActive') || 'Le tue alert lavoro')
 : (t('jobAlert.cardTitle') || 'Ricevi nuovi lavori via email')}
 </span>
 {alerts.length > 0 && (
 <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-accent-strong text-on-accent text-[10px] font-semibold">
 {alerts.length}
 </span>
 )}
 </span>
 <span className="block mt-0.5 text-xs text-subtle">
 {alerts.length > 0
 ? (t('jobAlert.cardDescriptionActive') || 'Gestisci o aggiungi nuove alert personalizzate.')
 : (t('jobAlert.cardDescription') || 'Attiva un\'alert gratuita: ti scriviamo quando escono offerte nei tuoi criteri.')}
 </span>
 </span>
 <span className="flex-shrink-0 inline-flex items-center gap-1 text-xs font-medium text-accent">
 {!expanded && alerts.length === 0 && (
 <span className="hidden sm:inline">{t('jobAlert.cardCta') || 'Crea alert'}</span>
 )}
 {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
 </span>
 </button>

 {/* Expanded form */}
 {expanded && (
 <div id="job-alert-form" className="mt-3 p-4 bg-accent-subtle rounded-xl border border-accent-border space-y-3">
 {/* Keyword */}
 <div>
 <label htmlFor="job-alert-keyword" className="block text-sm font-medium text-subtle mb-1">
 {t('jobAlert.keyword') || 'Parole chiave'}
 </label>
 <input
 id="job-alert-keyword"
 type="text"
 value={keyword}
 onChange={(e) => setKeyword(e.target.value)}
 placeholder={t('jobAlert.keywordPlaceholder') || 'es. developer, ingegnere, contabile'}
 className="w-full px-3 py-2 text-sm rounded-lg border border-edge bg-surface focus-visible:ring-2 focus-visible:ring-accent outline-none"
 />
 </div>

 {/* Locations */}
 <fieldset>
 <legend className="block text-sm font-medium text-subtle mb-1">
 {t('jobAlert.zone') || 'Zona'}
 </legend>
 <div className="flex flex-wrap gap-2" role="group" aria-label={t('jobAlert.zone') || 'Zona'}>
 {LOCATIONS.map((loc) => (
 <button
 key={loc.value}
 onClick={() => toggleLocation(loc.value)}
 aria-pressed={selectedLocations.includes(loc.value)}
 className={`px-3 py-1 text-xs rounded-full border transition-colors ${
 selectedLocations.includes(loc.value)
 ? 'bg-accent-strong text-on-accent border-accent'
 : 'bg-surface text-subtle border-edge hover:border-accent-border'
 }`}
 >
 {loc.label}
 </button>
 ))}
 </div>
 </fieldset>

 {/* Contract types */}
 <fieldset>
 <legend className="block text-sm font-medium text-subtle mb-1">
 {t('jobAlert.contractType') || 'Tipo contratto'}
 </legend>
 <div className="flex flex-wrap gap-2" role="group" aria-label={t('jobAlert.contractType') || 'Tipo contratto'}>
 {CONTRACT_TYPES.map((ct) => (
 <button
 key={ct.value}
 onClick={() => toggleContract(ct.value)}
 aria-pressed={selectedContracts.includes(ct.value)}
 className={`px-3 py-1 text-xs rounded-full border transition-colors ${
 selectedContracts.includes(ct.value)
 ? 'bg-accent-strong text-on-accent border-accent'
 : 'bg-surface text-subtle border-edge hover:border-accent-border'
 }`}
 >
 {t(ct.labelKey) || ct.value}
 </button>
 ))}
 </div>
 </fieldset>

 {/* Sectors */}
 <fieldset>
 <legend className="block text-sm font-medium text-subtle mb-1">
 {t('jobAlert.sector') || 'Settore'}
 </legend>
 <div className="flex flex-wrap gap-2" role="group" aria-label={t('jobAlert.sector') || 'Settore'}>
 {SECTORS.map((s) => (
 <button
 key={s.value}
 onClick={() => toggleSector(s.value)}
 aria-pressed={selectedSectors.includes(s.value)}
 className={`px-3 py-1 text-xs rounded-full border transition-colors ${
 selectedSectors.includes(s.value)
 ? 'bg-accent-strong text-on-accent border-accent'
 : 'bg-surface text-subtle border-edge hover:border-accent-border'
 }`}
 >
 {s.label}
 </button>
 ))}
 </div>
 </fieldset>

 {/* Canton geo filter (CATHEDRAL-STATUS #12: Cathedral CH-wide expansion) */}
 <fieldset>
 <div className="flex items-baseline justify-between mb-1 gap-2 flex-wrap">
 <legend className="block text-sm font-medium text-subtle">
 {t('jobAlert.canton') || 'Cantoni di interesse'}
 </legend>
 <span className="text-xs text-muted">
 {selectedCantons.length === 0
 ? (t('jobAlert.cantonAll') || 'Tutti i cantoni')
 : (t('jobAlert.cantonSelectedCount') || 'Selezionati') + `: ${selectedCantons.length}`}
 </span>
 </div>
 {/* Mobile-first: collapse the 26-canton picker by default and surface a
 compact "open"/"clear" row + chip summary so the dense data area
 stays above the fold on ≤414px (CLAUDE.md #15 / #16). */}
 <div className="flex flex-wrap items-center gap-2">
 <button
 type="button"
 onClick={() => setCantonPickerOpen((v) => !v)}
 aria-expanded={cantonPickerOpen}
 aria-controls="job-alert-canton-list"
 className="inline-flex items-center gap-1 px-3 py-1 text-xs rounded-full border border-edge bg-surface text-subtle hover:border-accent-border transition-colors"
 >
 {cantonPickerOpen
 ? (t('jobAlert.cantonHide') || 'Nascondi cantoni')
 : (t('jobAlert.cantonChoose') || 'Scegli cantoni')}
 {cantonPickerOpen ? (
 <ChevronUp className="w-3.5 h-3.5" aria-hidden="true" />
 ) : (
 <ChevronDown className="w-3.5 h-3.5" aria-hidden="true" />
 )}
 </button>
 {selectedCantons.length > 0 && (
 <button
 type="button"
 onClick={clearCantons}
 className="inline-flex items-center px-3 py-1 text-xs rounded-full border border-edge bg-surface text-subtle hover:border-accent-border transition-colors"
 >
 {t('jobAlert.cantonClear') || 'Reimposta'}
 </button>
 )}
 </div>
 {/* Compact summary of selected canton chips when picker is collapsed. */}
 {!cantonPickerOpen && selectedCantons.length > 0 && (
 <div className="mt-2 flex flex-wrap gap-1.5" aria-label={t('jobAlert.cantonSelectedAria') || 'Cantoni selezionati'}>
 {selectedCantons.map((code) => (
 <span
 key={code}
 className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] rounded-full bg-accent-strong text-on-accent"
 >
 {getCantonLabel(code, typedLocale)}
 <button
 type="button"
 onClick={() => toggleCanton(code)}
 aria-label={`${t('jobAlert.cantonRemove') || 'Rimuovi'} ${getCantonLabel(code, typedLocale)}`}
 className="ml-0.5 leading-none text-on-accent hover:opacity-80"
 >
 ×
 </button>
 </span>
 ))}
 </div>
 )}
 {cantonPickerOpen && (
 <div
 id="job-alert-canton-list"
 className="mt-2 flex flex-wrap gap-2 max-h-44 overflow-y-auto pr-1"
 role="group"
 aria-label={t('jobAlert.canton') || 'Cantoni di interesse'}
 >
 {cantonOptions.map((opt) => (
 <button
 type="button"
 key={opt.code}
 onClick={() => toggleCanton(opt.code)}
 aria-pressed={selectedCantons.includes(opt.code)}
 className={`px-3 py-1 text-xs rounded-full border transition-colors ${
 selectedCantons.includes(opt.code)
 ? 'bg-accent-strong text-on-accent border-accent'
 : 'bg-surface text-subtle border-edge hover:border-accent-border'
 }`}
 >
 <span className="font-semibold mr-1">{opt.code}</span>
 <span>{opt.label}</span>
 </button>
 ))}
 </div>
 )}
 <p className="text-[11px] text-muted mt-1">
 {t('jobAlert.cantonHint') || 'Lascia vuoto per ricevere alert da tutti i cantoni svizzeri.'}
 </p>
 </fieldset>

 {/* Frequency */}
 <div className="flex items-center gap-3">
 <label htmlFor="job-alert-frequency" className="text-xs font-medium text-subtle">
 {t('jobAlert.frequency') || 'Frequenza'}:
 </label>
 <select
 id="job-alert-frequency"
 value={frequency}
 onChange={(e) => setFrequency(e.target.value as 'daily' | 'weekly')}
 className="px-2 py-1 text-xs rounded-lg border border-edge bg-surface"
 >
 <option value="daily">{t('jobAlert.daily') || 'Giornaliera'}</option>
 <option value="weekly">{t('jobAlert.weekly') || 'Settimanale'}</option>
 </select>
 </div>

 {/* Submit button */}
 <button
 onClick={handleCreate}
 disabled={saving}
 className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-accent-strong text-on-accent text-sm font-medium hover:bg-accent-strong-hover disabled:opacity-50 transition-colors"
 >
 {saving ? (
 <Loader2 className="w-4 h-4 animate-spin" />
 ) : (
 <Bell className="w-4 h-4" />
 )}
 {authUser
 ? (t('jobAlert.create') || 'Crea alert')
 : (t('jobAlert.loginRequired') || 'Accedi per creare un alert')}
 </button>

 {/* Existing alerts */}
 {alerts.length > 0 && (
 <div className="border-t border-accent-border pt-3 mt-3">
 <h4 className="text-xs font-semibold text-subtle mb-2">
 {t('jobAlert.yourAlerts') || 'Le tue alert'} ({alerts.length}/3)
 </h4>
 <div className="space-y-2">
 {alerts.map((alert) => (
 <div
 key={alert.id}
 className="p-2 bg-surface rounded-lg border border-edge"
 >
 <div className="flex items-center justify-between">
 <div className="text-xs text-subtle min-w-0">
 <span className="font-medium text-strong">
 {alert.keywords.join(', ') || 'Tutte le offerte'}
 </span>
 {alert.locations.length > 0 && (
 <span> — {alert.locations.join(', ')}</span>
 )}
 {alert.sectors.length > 0 && (
 <span> · {alert.sectors.map(s => SECTORS.find(x => x.value === s)?.label || s).join(', ')}</span>
 )}
 {alert.cantonFilter && alert.cantonFilter.length > 0 && (
 <span> · {alert.cantonFilter.map((c) => getCantonLabel(c, typedLocale)).join(', ')}</span>
 )}
 </div>
 <div className="flex items-center gap-1 flex-shrink-0 ml-2">
 <button
 onClick={() => setEditingAlertId(editingAlertId === alert.id ? null : alert.id)}
 className="p-1 text-muted hover:text-accent transition-colors"
 title={t('jobAlert.edit') || 'Modifica'}
 >
 <Pencil className="w-3.5 h-3.5" />
 </button>
 <button
 onClick={() => handleDelete(alert.id)}
 className="p-1 text-muted hover:text-danger transition-colors"
 title={t('jobAlert.delete') || 'Elimina'}
 >
 <Trash2 className="w-3.5 h-3.5" />
 </button>
 </div>
 </div>
 {editingAlertId === alert.id ? (
 <div className="flex items-center gap-2 mt-2 pt-2 border-t border-edge">
 <label htmlFor={`alert-freq-${alert.id}`} className="text-xs text-muted">{t('jobAlert.frequency') || 'Frequenza'}:</label>
 <select
 id={`alert-freq-${alert.id}`}
 value={alert.frequency}
 onChange={(e) => handleUpdateFrequency(alert.id, e.target.value as 'daily' | 'weekly')}
 className="px-2 py-0.5 text-xs rounded border border-edge bg-surface"
 >
 <option value="daily">{t('jobAlert.daily') || 'Giornaliera'}</option>
 <option value="weekly">{t('jobAlert.weekly') || 'Settimanale'}</option>
 </select>
 </div>
 ) : (
 <div className="text-xs text-muted mt-0.5">{alert.frequency === 'daily' ? (t('jobAlert.daily') || 'Giornaliera') : (t('jobAlert.weekly') || 'Settimanale')}</div>
 )}
 </div>
 ))}
 </div>
 </div>
 )}

 {loadingAlerts && (
 <div className="flex items-center gap-2 text-xs text-muted">
 <Loader2 className="w-3 h-3 animate-spin" />
 {t('jobAlert.loading') || 'Caricamento alert...'}
 </div>
 )}
 </div>
 )}

 {/* Toast */}
 {toast && (
 <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-lg bg-heading text-heading text-sm shadow-lg animate-fade-in">
 {toast}
 </div>
 )}
 </div>
 );
}
