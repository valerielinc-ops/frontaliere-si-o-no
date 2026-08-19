/**
 * FRO-332: Job Alert Form — allows users to subscribe to email notifications
 * when new jobs matching their criteria are published.
 *
 * Integrates with jobAlertService.ts for Firestore CRUD.
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useTranslation } from '@/services/i18n';
import type { Locale } from '@/services/i18n';
import { Bell, BellRing, Trash2, ChevronDown, ChevronUp, Loader2, Pencil } from 'lucide-react';
import type { JobAlert, JobAlertConfig } from '@/services/jobAlertService';
import { listCantonOptions, getCantonLabel, CANTON_CODES, type CantonLocale } from '@/services/cantonList';
import { ABOVE_MOBILE_NAV_BOTTOM } from '@/components/shared/mobileNavClearance';
import { consumeJobAlertOpen } from '@/services/jobAlertOpenSignal';
import { savePendingJobAlert, consumePendingJobAlert } from '@/services/pendingJobAlert';
import ProfileEnrichmentPrompt from './ProfileEnrichmentPrompt';
import { SECTORS } from './jobAlertConstants';
import { loadEnrichmentProfileFields } from '@/services/profileFirestore';
import { JOB_ALERT_SUBSCRIBED_KEY } from '@/services/jobAlertCtaState';
import ConsentNotice from '@/components/shared/ConsentNotice';
import {
  loadGatingState,
  saveGatingState,
  pickNextQuestion,
  recordAnswer,
  recordSkip,
  type EnrichmentFieldKey,
} from '@/services/profileEnrichmentGating';

// ── Types ────────────────────────────────────────────────────

interface JobAlertFormProps {
 /** Currently authenticated user (null if not logged in) */
 authUser: { uid: string; email?: string | null } | null;
 /** Callback to trigger auth flow when user isn't logged in */
 onRequireAuth?: () => void;
 /** Pre-fill the keyword from current search query */
 initialKeyword?: string;
 /**
  * Pre-fill the canton scope from the job board's current canton route (e.g.
  * a /lavoro/vallese/ visit passes 'VS'). Issue #4298: the board already
  * knows the visitor's canton context — asking them to re-pick it in the
  * (opt-in, collapsed-by-default) "Filtri avanzati" canton picker is the same
  * re-entry friction the 2026-05-19 keyword-only simplification targeted.
  * Only seeds `selectedCantons` once (mirrors initialKeyword) so an explicit
  * user edit afterwards is never clobbered by a later prop change.
  */
 initialCantonCode?: string | null;
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

// ── Component ────────────────────────────────────────────────

export default function JobAlertForm({ authUser, onRequireAuth, initialKeyword = '', initialCantonCode = null }: JobAlertFormProps) {
 const { t, locale } = useTranslation();
 const [expanded, setExpanded] = useState(false);
 // 2026-05-19 simplification: open→accept funnel was 0/29 across all surfaces
 // because the form asked for 6 filters before submission. Default to
 // "keyword-only" with everything else behind an opt-in "Filtri avanzati"
 // toggle. Power users can still customize via the toggle or the
 // preferences controller; the average user just types and submits.
 const [showAdvanced, setShowAdvanced] = useState(false);
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

 // Seed the canton scope from the board's current canton route, once —
 // guarded so a later prop change (e.g. searchQuery-driven re-render) never
 // overwrites a canton the user picked or cleared by hand in "Filtri avanzati".
 const cantonSeededRef = useRef(false);
 useEffect(() => {
 if (cantonSeededRef.current) return;
 if (!initialCantonCode || !CANTON_CODES.includes(initialCantonCode)) return;
 cantonSeededRef.current = true;
 setSelectedCantons([initialCantonCode]);
 }, [initialCantonCode]);

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
 // Impression, not intent — kept out of `cta_click` so the funnel
 // ratio open→accept stays meaningful (auto_expand was 380 vs 33
 // real opens in 14 days, fully drowning the "open" signal).
 import('@/services/analytics')
 .then(({ Analytics }) => Analytics.trackJobAlertCtaShown('inline_card', k))
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

 // Cross-view open request (job-detail "Gestisci alert" → backToList → here).
 // The DOM event above can fire before this lazily-mounted form attaches its
 // listener, so the request is queued in a module signal and consumed once on
 // mount instead — guarantees the manager opens after navigating from detail.
 useEffect(() => {
 const req = consumeJobAlertOpen();
 if (!req) return;
 if (req.keyword) setKeyword(req.keyword);
 setExpanded(true);
 const id = window.setTimeout(() => {
 document.getElementById('job-alert-form')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
 }, 60);
 return () => window.clearTimeout(id);
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
  const buildConfig = useCallback((): JobAlertConfig => ({
    keywords: keyword.trim() ? keyword.trim().split(/[,;]+/).map((k) => k.trim()).filter(Boolean) : [],
    locations: selectedLocations,
    contractTypes: selectedContracts,
    sectors: selectedSectors,
    // Cathedral CH-wide geo scoping: empty selection = "all cantons", explicit codes scope it.
    cantonFilter: selectedCantons.length > 0 ? selectedCantons : null,
    frequency,
    // Explicit choice from this form's selector — pin it. Alerts created by
    // preset flows (One-Tap widget, job-specific alert) skip this and stay
    // engine-managed instead (see jobAlertService.ts subscribeJobAlert*).
    frequencyOverride: true,
    locale: locale as "it" | "en" | "de" | "fr",
  }), [keyword, selectedLocations, selectedContracts, selectedSectors, selectedCantons, frequency, locale]);

  const configIsEmpty = (c: JobAlertConfig): boolean => c.keywords.length === 0 && c.locations.length === 0;

  const persistAlert = useCallback(
    async (uid: string, email: string, config: JobAlertConfig, surface: 'inline_card' | 'post_auth_auto'): Promise<JobAlert> => {
      const { createAlert, upgradeBackfilledAlertConsent } = await import("@/services/jobAlertService");
      const alert = await createAlert(uid, email, config);
      // #5876 — operating this form is the explicit act, with the notice next
      // to the button as the stored formula. If this person also carries a
      // travaso alert, the act converts its deduced consent into an explicit
      // one. Not awaited: the alert is created either way.
      void upgradeBackfilledAlertConsent(email, config.locale).catch(() => {});
      setAlerts((prev) => [alert, ...prev]);
      import("@/services/analytics")
        .then(({ Analytics }) =>
          Analytics.trackJobAlertCreated({
            keywords: config.keywords.join(", "),
            location: config.locations.join(", "),
            frequency: config.frequency,
            surface,
          }),
        )
        .catch(() => {});
      return alert;
    },
    [],
  );

  // ── Progressive profile/jobalert enrichment (post-create prompt) ──────
  const [enrichmentField, setEnrichmentField] = useState<EnrichmentFieldKey | null>(null);
  const [enrichmentAlertId, setEnrichmentAlertId] = useState<string | null>(null);
  const [enrichmentMunicipality, setEnrichmentMunicipality] = useState<string | null>(null);

  const maybeShowEnrichmentPrompt = useCallback(async (userEmail: string, createdAlert: JobAlert) => {
    try {
      const profileFields = await loadEnrichmentProfileFields(userEmail);
      const nextField = pickNextQuestion(
        profileFields,
        { cantonFilter: createdAlert.cantonFilter ?? null, sectors: createdAlert.sectors },
        loadGatingState(),
        new Date(),
      );
      if (!nextField) return;
      setEnrichmentMunicipality(profileFields.municipality || null);
      setEnrichmentAlertId(createdAlert.id);
      setEnrichmentField(nextField);
    } catch {
      // Best-effort — never blocks the alert-creation flow.
    }
  }, []);

  const closeEnrichmentPrompt = useCallback(() => {
    setEnrichmentField(null);
    setEnrichmentAlertId(null);
    setEnrichmentMunicipality(null);
  }, []);

  const resetForm = useCallback(() => {
    setKeyword('');
    setSelectedLocations([]);
    setSelectedContracts([]);
    setSelectedSectors([]);
    setSelectedCantons([]);
    setCantonPickerOpen(false);
    setExpanded(false);
  }, []);

  // After the auth round-trip, replay a stashed alert intent so a logged-out
  // "create" completes itself instead of forcing a re-entry + re-submit
  // (the 536 click -> 39 create / 93% drop at exactly this step).
  const pendingConsumedRef = useRef(false);
  useEffect(() => {
    if (!authUser || pendingConsumedRef.current) return;
    const pending = consumePendingJobAlert();
    if (!pending) return;
    pendingConsumedRef.current = true;
    (async () => {
      try {
        const created = await persistAlert(authUser.uid, authUser.email || "", pending, "post_auth_auto");
        showToast(t("jobAlert.created") || "Alert creata! Riceverai una email con le nuove offerte.");
        // Reset like the manual path so the now-authenticated user can't re-submit
        // the still-populated form and create a duplicate alert.
        resetForm();
        if (authUser.email) maybeShowEnrichmentPrompt(authUser.email, created);
        try { localStorage.setItem(JOB_ALERT_SUBSCRIBED_KEY, 'true'); } catch { /* no-op */ }
      } catch (err: any) {
        // Surface the failure (e.g. quota full = permanent) instead of swallowing
        // it. Leave pendingConsumedRef set so we don't retry-loop on re-render;
        // the now-authenticated user can re-submit manually if needed.
        showToast(err?.message || (t("jobAlert.error.generic") as string) || "Errore durante la creazione dell'alert.");
      }
    })();
  }, [authUser, persistAlert, showToast, resetForm, t, maybeShowEnrichmentPrompt]);


 const handleCreate = async () => {
 if (!authUser) {
 const pendingConfig = buildConfig();
          if (!configIsEmpty(pendingConfig)) savePendingJobAlert(pendingConfig);
          onRequireAuth?.();
 return;
 }

 if (!keyword.trim() && selectedLocations.length === 0) {
 showToast(t('jobAlert.error.emptyFields') || 'Inserisci almeno una keyword o una zona.');
 return;
 }

 setSaving(true);
 try {
 const config = buildConfig();
      const created = await persistAlert(authUser.uid, authUser.email || '', config, 'inline_card');
 showToast(t('jobAlert.created') || 'Alert creata! Riceverai una email con le nuove offerte.');
 resetForm();
      if (authUser.email) maybeShowEnrichmentPrompt(authUser.email, created);
      try { localStorage.setItem(JOB_ALERT_SUBSCRIBED_KEY, 'true'); } catch { /* no-op */ }
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

 // 'immediate' (#5012 phase 2) is a real stored cadence: a CompanyAlert routed
 // to scripts/send-company-alerts.mjs. It is not OFFERED as a new choice here —
 // an immediate cadence without an employer pin means one email per job across
 // the whole board — but it must round-trip, so the type accepts it and the
 // option below is rendered only for an alert that already carries it.
 const handleUpdateFrequency = async (alertId: string, newFrequency: 'daily' | 'weekly' | 'immediate') => {
 const target = alerts.find((a) => a.id === alertId);
 const email = target?.email || authUser?.email;
 if (!email) {
 showToast('Errore durante l\'aggiornamento.');
 return;
 }
 try {
 const { updateAlert } = await import('@/services/jobAlertService');
 // A manual pick from this select is always a sticky pin — see
 // frequencyOverride on services/jobAlertService.ts JobAlertConfig.
 await updateAlert(email, alertId, { frequency: newFrequency, frequencyOverride: true });
 setAlerts((prev) =>
 prev.map((a) => (a.id === alertId ? { ...a, frequency: newFrequency, frequencyOverride: true } : a)),
 );
 setEditingAlertId(null);
 showToast(t('jobAlert.updated') || 'Alert aggiornata.');
 } catch {
 showToast('Errore durante l\'aggiornamento.');
 }
 };

 const handleResetToAuto = async (alertId: string) => {
 const target = alerts.find((a) => a.id === alertId);
 const email = target?.email || authUser?.email;
 if (!email) {
 showToast('Errore durante l\'aggiornamento.');
 return;
 }
 try {
 const { updateAlert } = await import('@/services/jobAlertService');
 await updateAlert(email, alertId, { frequencyOverride: false });
 setAlerts((prev) =>
 prev.map((a) => (a.id === alertId ? { ...a, frequencyOverride: false } : a)),
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

 {/* Primary submit: 1 click away from creating the alert. Advanced
 filters live behind the toggle below so the form stays at "type a
 word, hit submit" on mobile. */}
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

              <ConsentNotice
                consentKey="communicationsOptIn"
                locale={locale}
                className="mt-2 text-[11px] text-muted leading-relaxed block"
              />

 {/* Advanced filters toggle */}
 <button
 type="button"
 onClick={() => setShowAdvanced((v) => !v)}
 aria-expanded={showAdvanced}
 aria-controls="job-alert-advanced"
 className="w-full flex items-center justify-center gap-1 px-3 py-2 text-xs font-medium text-subtle hover:text-strong transition-colors"
 >
 {showAdvanced
 ? (t('jobAlert.advancedHide') || 'Nascondi filtri avanzati')
 : (t('jobAlert.advancedShow') || 'Filtri avanzati (opzionali)')}
 {showAdvanced ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
 </button>

 {showAdvanced && (
 <div id="job-alert-advanced" className="space-y-3 pt-1 border-t border-accent-border">

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
 <div>
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
 <p className="text-[11px] text-muted mt-1">
 {t('jobAlert.frequencyCreateHint') || 'Potrai passare ad automatico (la cadenza si adatta a quanto apri o clicchi) dopo la creazione.'}
 </p>
 </div>

 </div>
 )}

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
 <div className="flex flex-wrap items-center gap-2 mt-2 pt-2 border-t border-edge">
 <label htmlFor={`alert-freq-${alert.id}`} className="text-xs text-muted">{t('jobAlert.frequency') || 'Frequenza'}:</label>
 <select
 id={`alert-freq-${alert.id}`}
 value={alert.frequency}
 onChange={(e) => handleUpdateFrequency(alert.id, e.target.value as 'daily' | 'weekly' | 'immediate')}
 className="px-2 py-0.5 text-xs rounded border border-edge bg-surface"
 >
 {/* Rendered only for an alert that ALREADY is immediate (#5012 phase 2).
     Without a matching <option> the select shows no selection at all and
     the first interaction silently rewrites a followed employer onto the
     digest — a cadence downgrade the user never asked for. */}
 {alert.frequency === 'immediate' && (
 <option value="immediate">{t('jobAlert.immediate') || 'Immediata'}</option>
 )}
 <option value="daily">{t('jobAlert.daily') || 'Giornaliera'}</option>
 <option value="weekly">{t('jobAlert.weekly') || 'Settimanale'}</option>
 </select>
 {alert.frequencyOverride && (
 <button
 type="button"
 onClick={() => handleResetToAuto(alert.id)}
 className="text-xs text-accent underline underline-offset-2 hover:no-underline"
 >
 {t('jobAlert.resetToAuto') || 'Torna ad automatico'}
 </button>
 )}
 </div>
 ) : (
 <div className="text-xs text-muted mt-0.5 flex items-center gap-1.5 flex-wrap">
 {alert.frequencyOverride ? (
 <>
 {/* Three-way, not a daily/else binary (#5012 phase 2): the binary
     rendered every immediate CompanyAlert as "Settimanale" — the one
     cadence it is not. Same defect fixed in formatFrequency
     (components/preferences/SubscriptionPreferencesController.tsx). */}
 <span>
 {alert.frequency === 'immediate'
 ? (t('jobAlert.immediate') || 'Immediata')
 : alert.frequency === 'daily'
 ? (t('jobAlert.daily') || 'Giornaliera')
 : (t('jobAlert.weekly') || 'Settimanale')}
 </span>
 <span className="text-[10px] sm:text-xs px-1.5 py-0.5 rounded-full bg-surface-alt border border-edge">{t('jobAlert.pinned') || 'fissata manualmente'}</span>
 </>
 ) : (
 <>
 <span className="text-[10px] sm:text-xs px-1.5 py-0.5 rounded-full bg-accent-subtle text-accent border border-accent-border">{t('jobAlert.auto') || 'Automatico'}</span>
 <span>{t('jobAlert.autoHint') || 'la cadenza si adatta a quanto apri/clicchi'}</span>
 </>
 )}
 </div>
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

 {/* Toast. `text-surface`, not `text-heading`: both tokens resolve to
     `var(--_heading)`, so `bg-heading text-heading` painted the confirmation in
     its own background colour — an invisible toast, in both themes, on the one
     surface that tells somebody their alert was created. The sibling that got
     it right is the feedback CTA, which pairs the same background with a
     foreground token that is not the same one.
     Left OUT of the popupQueue on purpose (unlike the four prompts that now
     share BottomPromptShell): this is a 2s status message confirming an action
     the visitor just took, not an offer competing for their attention, and a
     confirmation that waits in a queue is a confirmation that never arrives.
     Its z-50 keeps it above any prompt still on screen. */}
 {toast && (
 <div className={`fixed ${ABOVE_MOBILE_NAV_BOTTOM} left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-lg bg-heading text-surface text-sm shadow-lg animate-fade-in`}>
 {toast}
 </div>
 )}

 {/* Progressive profile/jobalert enrichment prompt — one question, shown
 right after a successful alert creation. */}
 {enrichmentField && authUser?.email && (
 <ProfileEnrichmentPrompt
 field={enrichmentField}
 email={authUser.email}
 locale={locale as Locale}
 alertId={enrichmentAlertId}
 municipality={enrichmentMunicipality}
 onAnswered={() => saveGatingState(recordAnswer(loadGatingState(), new Date()))}
 onSkipped={() => saveGatingState(recordSkip(loadGatingState(), new Date()))}
 onClose={closeEnrichmentPrompt}
 />
 )}
 </div>
 );
}
