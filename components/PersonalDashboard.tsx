import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useTranslation } from '@/services/i18n';
import { calculateSimulation } from '@/services/calculationService';
import { DEFAULT_INPUTS } from '@/constants';
import { SimulationInputs, SimulationResult } from '@/types';
import { unlockAchievement } from '@/components/GamificationWidget';
import { useAuth, getUserDisplayName, getUserPhotoURL } from '@/services/authService';
import {
  saveSimulationToCloud,
  loadSimulationsFromCloud,
  deleteSimulationFromCloud,
} from '@/services/firestoreService';
import { History, Plus, Trash2, Download, TrendingUp, TrendingDown, Calendar, ChevronDown, ChevronUp, Clock, AlertCircle, BarChart2, LogIn, LogOut, Cloud, HardDrive, User, Loader2 } from 'lucide-react';

// ─── Types ───────────────────────────────────────────────────

interface SavedSimulation {
  id: string;
  date: string; // ISO
  label: string;
  inputs: SimulationInputs;
  result: SimulationResult;
  cloudId?: string; // Firestore doc ID if synced
}

const STORAGE_KEY = 'frontaliere_saved_simulations';

// ─── Storage helpers ─────────────────────────────────────────

function loadSimulations(): SavedSimulation[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveSimulationsLocal(sims: SavedSimulation[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(sims));
}

// ─── Component ───────────────────────────────────────────────

interface PersonalDashboardProps {
  currentInputs?: SimulationInputs;
  currentResult?: SimulationResult | null;
}

const PersonalDashboard: React.FC<PersonalDashboardProps> = ({ currentInputs, currentResult }) => {
  const { t } = useTranslation();
  const { user, loading: authLoading, signIn, logout } = useAuth();
  const [simulations, setSimulations] = useState<SavedSimulation[]>(loadSimulations);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [newLabel, setNewLabel] = useState('');
  const [showSaveForm, setShowSaveForm] = useState(false);
  const [compareIds, setCompareIds] = useState<[string, string] | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);

  useEffect(() => {
    saveSimulationsLocal(simulations);
  }, [simulations]);

  // Load from cloud when user logs in
  useEffect(() => {
    if (!user) return;
    let mounted = true;

    const syncFromCloud = async () => {
      setSyncing(true);
      setSyncError(null);
      try {
        const cloudSims = await loadSimulationsFromCloud(user.uid);
        if (!mounted) return;
        const localSims = loadSimulations();
        const cloudIds = new Set(cloudSims.map(s => s.id));
        const merged: SavedSimulation[] = [
          ...cloudSims.map(cs => ({
            id: cs.id,
            date: cs.date,
            label: cs.label,
            inputs: cs.inputs,
            result: cs.result,
            cloudId: cs.id,
          })),
          ...localSims.filter(ls => !ls.cloudId || !cloudIds.has(ls.cloudId)),
        ];
        setSimulations(merged);
      } catch (e) {
        console.warn('Cloud sync failed:', e);
        if (mounted) setSyncError(t('dashboard.syncError') || 'Sincronizzazione cloud fallita');
      } finally {
        if (mounted) setSyncing(false);
      }
    };

    syncFromCloud();
    return () => { mounted = false; };
  }, [user, t]);

  const handleSave = useCallback(async () => {
    const inputs = currentInputs || DEFAULT_INPUTS;
    const result = currentResult || calculateSimulation(inputs);
    const sim: SavedSimulation = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      date: new Date().toISOString(),
      label: newLabel || `${t('dashboard.simulation')} ${simulations.length + 1}`,
      inputs,
      result,
    };

    // Save to cloud if logged in
    if (user) {
      try {
        const cloudId = await saveSimulationToCloud(user.uid, sim);
        sim.cloudId = cloudId;
        sim.id = cloudId;
      } catch (e) {
        console.warn('Cloud save failed, keeping locally:', e);
      }
    }

    setSimulations(prev => [sim, ...prev]);
    setNewLabel('');
    setShowSaveForm(false);
    unlockAchievement('first_simulation');
    if (simulations.length >= 2) unlockAchievement('simulation_pro');
  }, [currentInputs, currentResult, newLabel, simulations.length, t, user]);

  const handleDelete = async (id: string) => {
    const sim = simulations.find(s => s.id === id);
    if (sim?.cloudId && user) {
      try { await deleteSimulationFromCloud(sim.cloudId); } catch { /* ignore */ }
    }
    setSimulations(prev => prev.filter(s => s.id !== id));
    if (compareIds && (compareIds[0] === id || compareIds[1] === id)) {
      setCompareIds(null);
    }
  };

  const handleExportPDF = useCallback(async () => {
    try {
      const { default: jsPDF } = await import('jspdf');
      const { default: autoTable } = await import('jspdf-autotable');
      const doc = new jsPDF();

      doc.setFontSize(18);
      doc.text(t('dashboard.title'), 14, 22);
      doc.setFontSize(10);
      doc.text(`${t('dashboard.exported')}: ${new Date().toLocaleDateString('it-IT')}`, 14, 30);

      const rows = simulations.map(s => [
        new Date(s.date).toLocaleDateString('it-IT'),
        s.label,
        `CHF ${s.inputs.grossSalary.toLocaleString('it-IT')}`,
        `CHF ${Math.round(s.result.chResident.netAnnual).toLocaleString('it-IT')}`,
        `€ ${Math.round(s.result.itResident.netAnnual).toLocaleString('it-IT')}`,
        `CHF ${Math.round(s.result.savings.annual).toLocaleString('it-IT')}`,
      ]);

      autoTable(doc, {
        head: [[t('dashboard.date'), t('dashboard.label'), t('dashboard.gross'), t('dashboard.netCH'), t('dashboard.netIT'), t('dashboard.savings')]],
        body: rows,
        startY: 36,
        styles: { fontSize: 8 },
      });

      doc.save('frontaliere-storico-simulazioni.pdf');
      unlockAchievement('pdf_downloaded');
    } catch (e) {
      console.warn('PDF export failed', e);
    }
  }, [simulations, t]);

  // Comparison
  const comparison = useMemo(() => {
    if (!compareIds) return null;
    const a = simulations.find(s => s.id === compareIds[0]);
    const b = simulations.find(s => s.id === compareIds[1]);
    if (!a || !b) return null;

    const netDiffCH = b.result.chResident.netAnnual - a.result.chResident.netAnnual;
    const netDiffIT = b.result.itResident.netAnnual - a.result.itResident.netAnnual;
    const pctCH = a.result.chResident.netAnnual > 0 ? (netDiffCH / a.result.chResident.netAnnual) * 100 : 0;
    const pctIT = a.result.itResident.netAnnual > 0 ? (netDiffIT / a.result.itResident.netAnnual) * 100 : 0;

    return { a, b, netDiffCH, netDiffIT, pctCH, pctIT };
  }, [compareIds, simulations]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-gradient-to-br from-sky-50 to-blue-50 dark:from-sky-950/30 dark:to-blue-950/30 rounded-2xl p-6 border border-sky-200 dark:border-sky-800">
        <div className="flex items-center gap-3 mb-2">
          <div className="p-2 bg-sky-100 dark:bg-sky-900/50 rounded-xl">
            <History className="w-6 h-6 text-sky-600 dark:text-sky-400" />
          </div>
          <h2 className="text-2xl font-bold text-sky-900 dark:text-sky-100">{t('dashboard.title')}</h2>
        </div>
        <p className="text-sky-700 dark:text-sky-300 text-sm">{t('dashboard.subtitle')}</p>
      </div>

      {/* Auth Section */}
      <div className="bg-white dark:bg-slate-800 rounded-xl p-4 border border-slate-200 dark:border-slate-700">
        {authLoading ? (
          <div className="flex items-center gap-2 text-sm text-slate-500">
            <Loader2 className="w-4 h-4 animate-spin" />
            {t('dashboard.loadingAuth') || 'Caricamento...'}
          </div>
        ) : user ? (
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              {getUserPhotoURL(user) ? (
                <img src={getUserPhotoURL(user)!} alt="" className="w-9 h-9 rounded-full border-2 border-sky-200" referrerPolicy="no-referrer" />
              ) : (
                <div className="w-9 h-9 rounded-full bg-sky-100 dark:bg-sky-900/50 flex items-center justify-center">
                  <User className="w-5 h-5 text-sky-600" />
                </div>
              )}
              <div>
                <p className="text-sm font-bold text-slate-800 dark:text-slate-200">{getUserDisplayName(user)}</p>
                <div className="flex items-center gap-1 text-[10px] text-emerald-600">
                  <Cloud className="w-3 h-3" />
                  {syncing ? (t('dashboard.syncing') || 'Sincronizzazione...') : (t('dashboard.cloudSync') || 'Sincronizzato con il cloud')}
                </div>
              </div>
            </div>
            <button onClick={logout} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold text-slate-500 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition-colors">
              <LogOut className="w-3.5 h-3.5" /> Logout
            </button>
          </div>
        ) : (
          <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4">
            <div className="flex items-center gap-2 flex-1">
              <HardDrive className="w-5 h-5 text-amber-500 shrink-0" />
              <div>
                <p className="text-sm font-bold text-slate-800 dark:text-slate-200">{t('dashboard.localMode') || 'Modalità locale'}</p>
                <p className="text-[10px] text-slate-400">{t('dashboard.loginBenefits') || 'Accedi con Google per salvare nel cloud e accedere da qualsiasi dispositivo'}</p>
              </div>
            </div>
            <button onClick={signIn} className="flex items-center gap-2 px-4 py-2.5 bg-white dark:bg-slate-700 border border-slate-300 dark:border-slate-600 rounded-xl text-sm font-bold text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-600 transition-colors shadow-sm">
              <svg className="w-4 h-4" viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>
              {t('dashboard.loginGoogle') || 'Accedi con Google'}
            </button>
          </div>
        )}
        {syncError && <p className="mt-2 text-xs text-amber-600 flex items-center gap-1"><AlertCircle className="w-3 h-3" /> {syncError}</p>}
      </div>

      {/* Actions */}
      <div className="flex flex-wrap gap-3">
        <button
          onClick={() => setShowSaveForm(!showSaveForm)}
          className="flex items-center gap-2 px-4 py-2.5 bg-sky-600 text-white rounded-xl text-sm font-bold hover:bg-sky-700 transition-colors"
        >
          <Plus className="w-4 h-4" />
          {t('dashboard.saveNew')}
        </button>

        {simulations.length > 0 && (
          <button
            onClick={handleExportPDF}
            className="flex items-center gap-2 px-4 py-2.5 bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 rounded-xl text-sm font-bold hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"
          >
            <Download className="w-4 h-4" />
            {t('dashboard.exportPdf')}
          </button>
        )}
      </div>

      {/* Save form */}
      {showSaveForm && (
        <div className="bg-white dark:bg-slate-800 rounded-xl p-4 border border-sky-200 dark:border-sky-800 flex flex-col sm:flex-row gap-3">
          <input
            type="text"
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            placeholder={t('dashboard.labelPlaceholder')}
            className="flex-1 px-3 py-2 rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-sm"
          />
          <button
            onClick={handleSave}
            className="px-4 py-2 bg-sky-600 text-white rounded-lg text-sm font-bold hover:bg-sky-700 transition-colors flex items-center gap-1.5"
          >
            {user && <Cloud className="w-3.5 h-3.5" />}
            {t('dashboard.save')}
          </button>
        </div>
      )}

      {/* Comparison mode */}
      {simulations.length >= 2 && (
        <div className="bg-white dark:bg-slate-800 rounded-xl p-4 border border-slate-200 dark:border-slate-700">
          <h3 className="font-bold text-sm text-slate-600 dark:text-slate-300 mb-3 flex items-center gap-2">
            <BarChart2 className="w-4 h-4" />
            {t('dashboard.compare')}
          </h3>
          <div className="flex flex-col sm:flex-row gap-3">
            <select
              value={compareIds?.[0] || ''}
              onChange={(e) => setCompareIds([e.target.value, compareIds?.[1] || simulations[1]?.id || ''])}
              className="flex-1 px-3 py-2 rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-sm"
            >
              <option value="">{t('dashboard.selectA')}</option>
              {simulations.map(s => (
                <option key={s.id} value={s.id}>{s.label} ({new Date(s.date).toLocaleDateString('it-IT')})</option>
              ))}
            </select>
            <span className="text-slate-400 self-center">vs</span>
            <select
              value={compareIds?.[1] || ''}
              onChange={(e) => setCompareIds([compareIds?.[0] || simulations[0]?.id || '', e.target.value])}
              className="flex-1 px-3 py-2 rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-sm"
            >
              <option value="">{t('dashboard.selectB')}</option>
              {simulations.map(s => (
                <option key={s.id} value={s.id}>{s.label} ({new Date(s.date).toLocaleDateString('it-IT')})</option>
              ))}
            </select>
          </div>

          {/* Comparison result */}
          {comparison && (
            <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className={`p-4 rounded-lg ${comparison.netDiffCH >= 0 ? 'bg-emerald-50 dark:bg-emerald-950/20' : 'bg-red-50 dark:bg-red-950/20'}`}>
                <p className="text-xs text-slate-500 mb-1">🇨🇭 {t('dashboard.netCH')}</p>
                <div className="flex items-center gap-2">
                  {comparison.netDiffCH >= 0 ? <TrendingUp className="w-5 h-5 text-emerald-500" /> : <TrendingDown className="w-5 h-5 text-red-500" />}
                  <span className={`text-xl font-black ${comparison.netDiffCH >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                    {comparison.netDiffCH >= 0 ? '+' : ''}CHF {Math.round(comparison.netDiffCH).toLocaleString('it-IT')}
                  </span>
                </div>
                <p className="text-xs text-slate-400 mt-1">{comparison.pctCH >= 0 ? '+' : ''}{comparison.pctCH.toFixed(1)}%</p>
              </div>
              <div className={`p-4 rounded-lg ${comparison.netDiffIT >= 0 ? 'bg-emerald-50 dark:bg-emerald-950/20' : 'bg-red-50 dark:bg-red-950/20'}`}>
                <p className="text-xs text-slate-500 mb-1">🇮🇹 {t('dashboard.netIT')}</p>
                <div className="flex items-center gap-2">
                  {comparison.netDiffIT >= 0 ? <TrendingUp className="w-5 h-5 text-emerald-500" /> : <TrendingDown className="w-5 h-5 text-red-500" />}
                  <span className={`text-xl font-black ${comparison.netDiffIT >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                    {comparison.netDiffIT >= 0 ? '+' : ''}€ {Math.round(comparison.netDiffIT).toLocaleString('it-IT')}
                  </span>
                </div>
                <p className="text-xs text-slate-400 mt-1">{comparison.pctIT >= 0 ? '+' : ''}{comparison.pctIT.toFixed(1)}%</p>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Saved simulations list */}
      {simulations.length === 0 ? (
        <div className="text-center py-12 text-slate-400">
          <History className="w-12 h-12 mx-auto mb-3 opacity-50" />
          <p className="font-bold">{t('dashboard.empty')}</p>
          <p className="text-sm mt-1">{t('dashboard.emptyDesc')}</p>
        </div>
      ) : (
        <div className="space-y-3">
          {simulations.map((sim) => {
            const isExpanded = expandedId === sim.id;
            return (
              <div key={sim.id} className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 overflow-hidden">
                <div className="p-4 flex items-center gap-3">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <Calendar className="w-3.5 h-3.5 text-slate-400" />
                      <span className="text-xs text-slate-400">{new Date(sim.date).toLocaleDateString('it-IT', { day: 'numeric', month: 'long', year: 'numeric' })}</span>
                      {sim.cloudId && <Cloud className="w-3 h-3 text-sky-400" title="Cloud" />}
                    </div>
                    <p className="font-bold text-sm text-slate-800 dark:text-slate-200">{sim.label}</p>
                    <div className="flex flex-wrap gap-3 mt-1 text-xs text-slate-500">
                      <span>💰 CHF {sim.inputs.grossSalary.toLocaleString('it-IT')}</span>
                      <span>🇨🇭 CHF {Math.round(sim.result.chResident.netAnnual).toLocaleString('it-IT')}/a</span>
                      <span>🇮🇹 € {Math.round(sim.result.itResident.netAnnual).toLocaleString('it-IT')}/a</span>
                    </div>
                  </div>

                  <button
                    onClick={() => handleDelete(sim.id)}
                    className="p-2 text-slate-300 hover:text-red-500 transition-colors"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => setExpandedId(isExpanded ? null : sim.id)}
                    className="p-2 text-slate-400"
                  >
                    {isExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                  </button>
                </div>

                {isExpanded && (
                  <div className="px-4 pb-4 border-t border-slate-100 dark:border-slate-700 pt-3">
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-center">
                      <div className="p-2 bg-slate-50 dark:bg-slate-900 rounded-lg">
                        <p className="text-[10px] text-slate-400">{t('dashboard.gross')}</p>
                        <p className="font-black text-sm">CHF {sim.inputs.grossSalary.toLocaleString('it-IT')}</p>
                      </div>
                      <div className="p-2 bg-slate-50 dark:bg-slate-900 rounded-lg">
                        <p className="text-[10px] text-slate-400">{t('dashboard.family')}</p>
                        <p className="font-black text-sm">{sim.inputs.familyMembers}p, {sim.inputs.children}b</p>
                      </div>
                      <div className="p-2 bg-red-50 dark:bg-red-950/20 rounded-lg">
                        <p className="text-[10px] text-slate-400">🇨🇭 {t('dashboard.netCH')}</p>
                        <p className="font-black text-sm text-red-600">CHF {Math.round(sim.result.chResident.netAnnual).toLocaleString('it-IT')}</p>
                      </div>
                      <div className="p-2 bg-green-50 dark:bg-green-950/20 rounded-lg">
                        <p className="text-[10px] text-slate-400">🇮🇹 {t('dashboard.netIT')}</p>
                        <p className="font-black text-sm text-green-600">€ {Math.round(sim.result.itResident.netAnnual).toLocaleString('it-IT')}</p>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default PersonalDashboard;
