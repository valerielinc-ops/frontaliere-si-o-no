import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Trophy, Star, Flame, Target, Award, Sparkles, CheckCircle2, Zap, X } from 'lucide-react';
import { useTranslation } from '@/services/i18n';
import { Analytics } from '@/services/analytics';

// ─── Achievement Definitions ────────────────────────────────────────────────

export interface Achievement {
  id: string;
  icon: string;
  category: 'explorer' | 'calculator' | 'expert' | 'social';
  requiredCount: number;
}

const ACHIEVEMENTS: Achievement[] = [
  // Explorer — visit sections
  { id: 'first_visit', icon: '🚀', category: 'explorer', requiredCount: 1 },
  { id: 'guide_reader', icon: '📖', category: 'explorer', requiredCount: 1 },
  { id: 'comparator_curious', icon: '🔍', category: 'explorer', requiredCount: 3 },
  { id: 'comparator_master', icon: '🏆', category: 'explorer', requiredCount: 9 },
  { id: 'map_explorer', icon: '🗺️', category: 'explorer', requiredCount: 1 },
  { id: 'school_finder', icon: '🎓', category: 'explorer', requiredCount: 1 },
  // Calculator — use simulation tools
  { id: 'first_simulation', icon: '🧮', category: 'calculator', requiredCount: 1 },
  { id: 'pension_planner', icon: '🏦', category: 'calculator', requiredCount: 1 },
  { id: 'pillar3_saver', icon: '💰', category: 'calculator', requiredCount: 1 },
  { id: 'what_if_dreamer', icon: '💭', category: 'calculator', requiredCount: 1 },
  { id: 'simulation_pro', icon: '📊', category: 'calculator', requiredCount: 5 },
  // Expert — deep usage
  { id: 'currency_watcher', icon: '💱', category: 'expert', requiredCount: 1 },
  { id: 'tax_calendar_user', icon: '📅', category: 'expert', requiredCount: 1 },
  { id: 'health_researcher', icon: '🏥', category: 'expert', requiredCount: 1 },
  { id: 'transport_planner', icon: '🚗', category: 'expert', requiredCount: 1 },
  { id: 'dark_mode_fan', icon: '🌙', category: 'expert', requiredCount: 1 },
  // Social — engagement
  { id: 'feedback_giver', icon: '💬', category: 'social', requiredCount: 1 },
  { id: 'stats_checker', icon: '📈', category: 'social', requiredCount: 1 },
  { id: 'newsletter_sub', icon: '📧', category: 'social', requiredCount: 1 },
  { id: 'pwa_installer', icon: '📱', category: 'social', requiredCount: 1 },
];

// ─── Gamification State Management ──────────────────────────────────────────

const STORAGE_KEY = 'frontaliere_achievements';

interface GamificationState {
  unlockedAchievements: Record<string, number>;
  actionCounts: Record<string, number>;
  xp: number;
  streak: number;
  lastVisitDay: string;
}

export type { GamificationState };

export function loadState(): GamificationState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        unlockedAchievements: parsed.unlockedAchievements || {},
        actionCounts: parsed.actionCounts || {},
        xp: parsed.xp || 0,
        streak: parsed.streak || 0,
        lastVisitDay: parsed.lastVisitDay || '',
      };
    }
  } catch {}
  return { unlockedAchievements: {}, actionCounts: {}, xp: 0, streak: 0, lastVisitDay: '' };
}

function saveState(state: GamificationState) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function getToday(): string {
  return new Date().toISOString().split('T')[0];
}

export function getLevel(xp: number): { level: number; currentXp: number; nextLevelXp: number } {
  const thresholds = [0, 100, 250, 500, 800, 1200, 1700, 2300, 3000, 4000, 5000];
  let level = 1;
  for (let i = 1; i < thresholds.length; i++) {
    if (xp >= thresholds[i]) level = i + 1;
    else break;
  }
  const currentThreshold = thresholds[Math.min(level - 1, thresholds.length - 1)];
  const nextThreshold = thresholds[Math.min(level, thresholds.length - 1)] || currentThreshold + 1000;
  return {
    level,
    currentXp: xp - currentThreshold,
    nextLevelXp: nextThreshold - currentThreshold,
  };
}

const LEVEL_TITLES = [
  '',
  'Novizio', 'Esploratore', 'Viaggiatore', 'Pendolare',
  'Veterano', 'Esperto', 'Maestro', 'Guru', 'Leggenda', 'Frontaliere DOC',
];

// ─── Global API ─────────────────────────────────────────────────────────────

type AchievementListener = (id: string) => void;
const listeners: Set<AchievementListener> = new Set();

export { ACHIEVEMENTS, LEVEL_TITLES };

export function unlockAchievement(achievementId: string) {
  const state = loadState();
  const currentCount = (state.actionCounts[achievementId] || 0) + 1;
  state.actionCounts[achievementId] = currentCount;

  const achievement = ACHIEVEMENTS.find(a => a.id === achievementId);
  if (achievement && currentCount >= achievement.requiredCount && !state.unlockedAchievements[achievementId]) {
    state.unlockedAchievements[achievementId] = Date.now();
    state.xp += 50;
  }

  saveState(state);
  listeners.forEach(fn => fn(achievementId));
}

export function addXp(amount: number) {
  const state = loadState();
  state.xp += amount;
  saveState(state);
  listeners.forEach(fn => fn('_xp'));
}

// ─── Gamification Widget — Navbar notification button ───────────────────────

interface GamificationWidgetProps {
  onNavigateToPage?: () => void;
}

const GamificationWidget: React.FC<GamificationWidgetProps> = ({ onNavigateToPage }) => {
  const { t } = useTranslation();
  const [state, setState] = useState<GamificationState>(loadState);
  const [isOpen, setIsOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const panelRef = React.useRef<HTMLDivElement>(null);

  // Subscribe to achievement unlocks
  useEffect(() => {
    const handleUnlock = (id: string) => {
      const newState = loadState();
      if (newState.unlockedAchievements[id] && !state.unlockedAchievements[id]) {
        const achievement = ACHIEVEMENTS.find(a => a.id === id);
        if (achievement) {
          setToast(id);
          setTimeout(() => setToast(null), 3500);
          Analytics.trackUIInteraction('gamification', 'achievement', id, 'unlocked');
        }
      }
      setState(newState);
    };
    listeners.add(handleUnlock);
    return () => { listeners.delete(handleUnlock); };
  }, [state.unlockedAchievements]);

  // Daily streak
  useEffect(() => {
    const today = getToday();
    const st = loadState();
    if (st.lastVisitDay !== today) {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const yesterdayStr = yesterday.toISOString().split('T')[0];

      if (st.lastVisitDay === yesterdayStr) {
        st.streak += 1;
        st.xp += 10 * Math.min(st.streak, 7);
      } else if (st.lastVisitDay === '') {
        st.streak = 1;
        st.xp += 10;
      } else {
        st.streak = 1;
        st.xp += 10;
      }
      st.lastVisitDay = today;
      saveState(st);
      setState(st);
    }

    if (!st.unlockedAchievements['first_visit']) {
      unlockAchievement('first_visit');
    }
  }, []);

  // Click outside to close
  useEffect(() => {
    if (!isOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [isOpen]);

  const levelInfo = useMemo(() => getLevel(state.xp), [state.xp]);
  const unlockedCount = Object.keys(state.unlockedAchievements).length;
  const totalCount = ACHIEVEMENTS.length;
  const progressPercent = Math.round((unlockedCount / totalCount) * 100);

  // Recent unlocked achievements (last 5, most recent first)
  const recentAchievements = useMemo(() => {
    return ACHIEVEMENTS
      .filter(a => !!state.unlockedAchievements[a.id])
      .sort((a, b) => (state.unlockedAchievements[b.id] || 0) - (state.unlockedAchievements[a.id] || 0))
      .slice(0, 5);
  }, [state.unlockedAchievements]);

  const levelTitle = LEVEL_TITLES[Math.min(levelInfo.level, LEVEL_TITLES.length - 1)] || `Level ${levelInfo.level}`;
  const xpProgressPct = Math.min(100, (levelInfo.currentXp / levelInfo.nextLevelXp) * 100);

  return (
    <>
      {/* Achievement Toast — top-right */}
      {toast && (
        <div className="fixed top-20 right-4 sm:right-6 z-[60] animate-toast-in pointer-events-auto">
          <div className="bg-gradient-to-r from-amber-500 to-orange-500 text-white rounded-xl shadow-lg px-4 py-2.5 flex items-center gap-2.5 max-w-xs">
            <span className="text-xl flex-shrink-0">{ACHIEVEMENTS.find(a => a.id === toast)?.icon || '🏆'}</span>
            <div className="min-w-0">
              <div className="text-[10px] font-bold uppercase tracking-wider opacity-80">{t('gamification.achievementUnlocked')}</div>
              <div className="font-bold text-xs truncate">{t(`gamification.achievement.${toast}`)}</div>
            </div>
            <button onClick={() => setToast(null)} className="ml-1 p-0.5 hover:bg-white/20 rounded-full transition-colors flex-shrink-0">
              <X size={12} />
            </button>
          </div>
        </div>
      )}

      {/* Notification button + dropdown */}
      <div className="relative" ref={panelRef}>
        {/* Trophy icon button */}
        <button
          onClick={() => { setIsOpen(!isOpen); Analytics.trackUIInteraction('gamification', 'widget', 'toggle', isOpen ? 'close' : 'open'); }}
          className={`relative p-2 rounded-xl transition-all ${isOpen ? 'bg-amber-50 dark:bg-amber-900/20 text-amber-600 dark:text-amber-400' : 'text-slate-500 hover:text-slate-600 dark:hover:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'}`}
          title={`${levelTitle} — ${state.xp} XP`}
          aria-label={`Gamification: ${levelTitle}, ${state.xp} XP`}
        >
          <Trophy size={18} />
          {/* Badge with level */}
          <span aria-hidden="true" className="absolute -top-0.5 -right-0.5 bg-gradient-to-br from-amber-400 to-orange-500 text-white text-[8px] font-black min-w-[16px] h-4 rounded-full flex items-center justify-center shadow-sm px-0.5">
            {levelInfo.level}
          </span>
        </button>

        {/* Dropdown panel — fixed on mobile, absolute on desktop */}
        {isOpen && (
          <div className="fixed sm:absolute inset-x-2 sm:inset-x-auto sm:right-0 top-16 sm:top-full sm:mt-2 sm:w-[340px] bg-white dark:bg-slate-900 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-700 overflow-hidden z-[80] animate-slide-up max-h-[calc(100vh-5rem)] overflow-y-auto">
            {/* Header — level info */}
            <div className="px-4 py-3 bg-gradient-to-r from-amber-50 to-orange-50 dark:from-amber-950/30 dark:to-orange-950/30 border-b border-slate-200/60 dark:border-slate-700/50">
              <div className="flex items-center gap-3">
                <div className="relative flex-shrink-0">
                  <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-amber-400 to-orange-500 flex items-center justify-center shadow-sm">
                    <Trophy size={18} className="text-white" />
                  </div>
                  <span className="absolute -top-1 -right-1 bg-slate-800 dark:bg-slate-200 text-white dark:text-slate-800 text-[9px] font-black w-5 h-5 rounded-full flex items-center justify-center shadow-sm">
                    {levelInfo.level}
                  </span>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-bold text-slate-800 dark:text-slate-100">{levelTitle}</div>
                  <div className="text-[11px] text-slate-500 dark:text-slate-500">{state.xp} XP</div>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  {state.streak > 0 && (
                    <div className="flex items-center gap-1 text-xs text-slate-500">
                      <Flame size={14} className="text-orange-400" />
                      <span className="font-bold">{state.streak}</span>
                    </div>
                  )}
                  <div className="flex items-center gap-1 text-xs text-slate-500">
                    <CheckCircle2 size={14} className="text-emerald-500" />
                    <span className="font-bold">{unlockedCount}/{totalCount}</span>
                  </div>
                </div>
              </div>
              {/* XP progress bar */}
              <div className="mt-2">
                <div className="w-full bg-slate-200 dark:bg-slate-700 rounded-full h-1.5">
                  <div
                    className="bg-gradient-to-r from-amber-400 to-orange-500 rounded-full h-1.5 transition-all duration-500"
                    style={{ width: `${xpProgressPct}%` }}
                  />
                </div>
                <div className="flex justify-between text-[9px] text-slate-500 mt-0.5">
                  <span>{levelInfo.currentXp}/{levelInfo.nextLevelXp} XP</span>
                  <span>{progressPercent}%</span>
                </div>
              </div>
            </div>

            {/* Recent achievements (last unlocked) */}
            <div className="px-3 py-2">
              <div className="text-[10px] uppercase tracking-wider text-slate-500 font-bold mb-2 px-1">
                {t('gamification.recentAchievements') || 'Ultimi sbloccati'}
              </div>
              {recentAchievements.length === 0 ? (
                <div className="text-center py-4 text-xs text-slate-500">
                  {t('gamification.noAchievementsYet') || 'Nessun achievement sbloccato ancora. Esplora il sito!'}
                </div>
              ) : (
                <div className="space-y-1.5">
                  {recentAchievements.map(achievement => (
                    <div
                      key={achievement.id}
                      className="flex items-center gap-2.5 p-2 rounded-lg bg-amber-50/80 dark:bg-amber-900/10 border border-amber-200/60 dark:border-amber-800/40"
                    >
                      <span className="text-lg flex-shrink-0">{achievement.icon}</span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1">
                          <span className="text-[11px] font-bold truncate text-amber-700 dark:text-amber-400">
                            {t(`gamification.achievement.${achievement.id}`)}
                          </span>
                          <CheckCircle2 size={10} className="text-emerald-500 flex-shrink-0" />
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* View all button */}
            {onNavigateToPage && (
              <div className="px-3 pb-3">
                <button
                  onClick={() => { setIsOpen(false); onNavigateToPage(); }}
                  className="w-full py-2.5 text-xs font-bold text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 hover:bg-amber-100 dark:hover:bg-amber-900/40 rounded-xl transition-colors border border-amber-200/60 dark:border-amber-800/40"
                >
                  {t('gamification.viewAll') || 'Vedi tutti gli achievement →'}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
};

export default GamificationWidget;
