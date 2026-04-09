/**
 * FRO-332: Job Alert Form — allows users to subscribe to email notifications
 * when new jobs matching their criteria are published.
 *
 * Integrates with jobAlertService.ts for Firestore CRUD.
 */

import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from '@/services/i18n';
import { Bell, BellRing, Trash2, ChevronDown, ChevronUp, Loader2 } from 'lucide-react';
import type { JobAlert, JobAlertConfig } from '@/services/jobAlertService';

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
  { value: 'full-time', labelKey: 'jobBoard.filter.fullTime' },
  { value: 'part-time', labelKey: 'jobBoard.filter.partTime' },
  { value: 'temporary', labelKey: 'jobBoard.filter.temporary' },
  { value: 'internship', labelKey: 'jobBoard.filter.internship' },
];

// ── Component ────────────────────────────────────────────────

export default function JobAlertForm({ authUser, onRequireAuth, initialKeyword = '' }: JobAlertFormProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [keyword, setKeyword] = useState(initialKeyword);
  const [selectedLocations, setSelectedLocations] = useState<string[]>([]);
  const [selectedContracts, setSelectedContracts] = useState<string[]>([]);
  const [frequency, setFrequency] = useState<'daily' | 'weekly'>('daily');
  const [saving, setSaving] = useState(false);
  const [alerts, setAlerts] = useState<JobAlert[]>([]);
  const [loadingAlerts, setLoadingAlerts] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  // Update keyword when search changes
  useEffect(() => {
    if (initialKeyword) setKeyword(initialKeyword);
  }, [initialKeyword]);

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
        sectors: [],
        frequency,
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
      setExpanded(false);
    } catch (err: any) {
      showToast(err?.message || 'Errore durante la creazione dell\'alert.');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (alertId: string) => {
    try {
      const { deleteAlert } = await import('@/services/jobAlertService');
      await deleteAlert(alertId);
      // FRO-334: Track alert deletion
      import('@/services/analytics').then(({ Analytics }) => Analytics.trackJobAlertDeleted()).catch(() => {});
      setAlerts((prev) => prev.filter((a) => a.id !== alertId));
      showToast(t('jobAlert.deleted') || 'Alert eliminata.');
    } catch {
      showToast('Errore durante l\'eliminazione.');
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

  return (
    <div className="mt-4 mb-6">
      {/* Collapsed trigger */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 text-sm text-indigo-600 dark:text-indigo-400 hover:text-indigo-800 dark:hover:text-indigo-300 transition-colors"
      >
        <BellRing className="w-4 h-4" />
        <span>{t('jobAlert.trigger') || 'Avvisami per nuovi lavori'}</span>
        {alerts.length > 0 && (
          <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-indigo-100 dark:bg-indigo-900 text-xs font-semibold text-indigo-700 dark:text-indigo-300">
            {alerts.length}
          </span>
        )}
        {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
      </button>

      {/* Expanded form */}
      {expanded && (
        <div className="mt-3 p-4 bg-indigo-50 dark:bg-indigo-950/30 rounded-xl border border-indigo-200 dark:border-indigo-800 space-y-3">
          {/* Keyword */}
          <div>
            <label className="block text-sm font-medium text-subtle mb-1">
              {t('jobAlert.keyword') || 'Parole chiave'}
            </label>
            <input
              type="text"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder={t('jobAlert.keywordPlaceholder') || 'es. developer, ingegnere, contabile'}
              aria-label={t('jobAlert.keyword') || 'Parole chiave'}
              className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-600 bg-surface focus-visible:ring-2 focus-visible:ring-indigo-400 outline-none"
            />
          </div>

          {/* Locations */}
          <div>
            <label className="block text-sm font-medium text-subtle mb-1">
              {t('jobAlert.zone') || 'Zona'}
            </label>
            <div className="flex flex-wrap gap-2">
              {LOCATIONS.map((loc) => (
                <button
                  key={loc.value}
                  onClick={() => toggleLocation(loc.value)}
                  className={`px-3 py-1 text-xs rounded-full border transition-colors ${
                    selectedLocations.includes(loc.value)
                      ? 'bg-indigo-600 text-white border-indigo-600'
                      : 'bg-surface text-subtle border-slate-300 dark:border-slate-600 hover:border-indigo-400'
                  }`}
                >
                  {loc.label}
                </button>
              ))}
            </div>
          </div>

          {/* Contract types */}
          <div>
            <label className="block text-sm font-medium text-subtle mb-1">
              {t('jobAlert.contractType') || 'Tipo contratto'}
            </label>
            <div className="flex flex-wrap gap-2">
              {CONTRACT_TYPES.map((ct) => (
                <button
                  key={ct.value}
                  onClick={() => toggleContract(ct.value)}
                  className={`px-3 py-1 text-xs rounded-full border transition-colors ${
                    selectedContracts.includes(ct.value)
                      ? 'bg-indigo-600 text-white border-indigo-600'
                      : 'bg-surface text-subtle border-slate-300 dark:border-slate-600 hover:border-indigo-400'
                  }`}
                >
                  {t(ct.labelKey) || ct.value}
                </button>
              ))}
            </div>
          </div>

          {/* Frequency */}
          <div className="flex items-center gap-3">
            <label className="text-xs font-medium text-subtle">
              {t('jobAlert.frequency') || 'Frequenza'}:
            </label>
            <select
              value={frequency}
              onChange={(e) => setFrequency(e.target.value as 'daily' | 'weekly')}
              aria-label={t('jobAlert.frequency') || 'Frequenza'}
              className="px-2 py-1 text-xs rounded-lg border border-slate-300 dark:border-slate-600 bg-surface"
            >
              <option value="daily">{t('jobAlert.daily') || 'Giornaliera'}</option>
              <option value="weekly">{t('jobAlert.weekly') || 'Settimanale'}</option>
            </select>
          </div>

          {/* Submit button */}
          <button
            onClick={handleCreate}
            disabled={saving}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-50 transition-colors"
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
            <div className="border-t border-indigo-200 dark:border-indigo-800 pt-3 mt-3">
              <h4 className="text-xs font-semibold text-subtle mb-2">
                {t('jobAlert.yourAlerts') || 'Le tue alert'} ({alerts.length}/3)
              </h4>
              <div className="space-y-2">
                {alerts.map((alert) => (
                  <div
                    key={alert.id}
                    className="flex items-center justify-between p-2 bg-surface rounded-lg border border-edge"
                  >
                    <div className="text-xs text-subtle">
                      <span className="font-medium text-strong">
                        {alert.keywords.join(', ') || 'Tutte le offerte'}
                      </span>
                      {alert.locations.length > 0 && (
                        <span> — {alert.locations.join(', ')}</span>
                      )}
                      <span className="ml-2 text-muted">({alert.frequency})</span>
                    </div>
                    <button
                      onClick={() => handleDelete(alert.id)}
                      className="p-1 text-muted hover:text-red-500 transition-colors"
                      title={t('jobAlert.delete') || 'Elimina'}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
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
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-lg bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 text-sm shadow-lg animate-fade-in">
          {toast}
        </div>
      )}
    </div>
  );
}
