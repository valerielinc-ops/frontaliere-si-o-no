import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Trophy, Star, Flame, Target, Award, ChevronDown, ChevronUp, Sparkles, Lock, CheckCircle2, Zap, X } from 'lucide-react';
import { useTranslation } from '@/services/i18n';
import { Analytics } from '@/services/analytics';

// ─── Achievement Definitions ────────────────────────────────────────────────

export interface Achievement {
  id: string;
  icon: string;
  category: 'explorer' | 'calculator' | 'expert' | 'social';
  requiredCount: number; // times the action must be performed
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
const STREAK_KEY = 'frontaliere_streak';
const LEVEL_KEY = 'frontaliere_xp';

interface GamificationState {
  unlockedAchievements: Record<string, number>; // id -> timestamp unlocked
  actionCounts: Record<string, number>; // id -> count of actions
  xp: number;
  streak: number; // daily streak
  lastVisitDay: string; // YYYY-MM-DD
}

function loadState(): GamificationState {
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

function getLevel(xp: number): { level: number; currentXp: number; nextLevelXp: number } {
  // XP needed: Level 1=0, Level 2=100, Level 3=250, Level 4=500, ...
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
  '', // 0
  'Novizio', 'Esploratore', 'Viaggiatore', 'Pendolare',
  'Veterano', 'Esperto', 'Maestro', 'Guru', 'Leggenda', 'Frontaliere DOC',
];

// ─── Global API to unlock achievements from other components ────────────────

type AchievementListener = (id: string) => void;
const listeners: Set<AchievementListener> = new Set();

export function unlockAchievement(achievementId: string) {
  const state = loadState();
  const currentCount = (state.actionCounts[achievementId] || 0) + 1;
  state.actionCounts[achievementId] = currentCount;

  const achievement = ACHIEVEMENTS.find(a => a.id === achievementId);
  if (achievement && currentCount >= achievement.requiredCount && !state.unlockedAchievements[achievementId]) {
    state.unlockedAchievements[achievementId] = Date.now();
    state.xp += 50; // 50 XP per achievement
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

// ─── Gamification Widget Component ──────────────────────────────────────────

const GamificationWidget: React.FC = () => {
  const { t } = useTranslation();
  const [state, setState] = useState<GamificationState>(loadState);
  const [isExpanded, setIsExpanded] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [selectedCategory, setSelectedCategory] = useState<'all' | 'explorer' | 'calculator' | 'expert' | 'social'>('all');

  // Subscribe to achievement unlocks
  useEffect(() => {
    const handleUnlock = (id: string) => {
      const newState = loadState();
      // Check if this unlock was new
      if (newState.unlockedAchievements[id] && !state.unlockedAchievements[id]) {
        const achievement = ACHIEVEMENTS.find(a => a.id === id);
        if (achievement) {
          setToast(id);
          setTimeout(() => setToast(null), 4000);
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
        st.xp += 10 * Math.min(st.streak, 7); // bonus XP for streaks, max 70
      } else if (st.lastVisitDay === '') {
        st.streak = 1;
        st.xp += 10;
      } else {
        st.streak = 1; // reset
        st.xp += 10;
      }
      st.lastVisitDay = today;
      saveState(st);
      setState(st);
    }

    // First visit achievement
    if (!st.unlockedAchievements['first_visit']) {
      unlockAchievement('first_visit');
    }
  }, []);

  const levelInfo = useMemo(() => getLevel(state.xp), [state.xp]);
  const unlockedCount = Object.keys(state.unlockedAchievements).length;
  const totalCount = ACHIEVEMENTS.length;
  const progressPercent = Math.round((unlockedCount / totalCount) * 100);

  const filteredAchievements = useMemo(() => {
    if (selectedCategory === 'all') return ACHIEVEMENTS;
    return ACHIEVEMENTS.filter(a => a.category === selectedCategory);
  }, [selectedCategory]);

  const categoryIcons: Record<string, React.ReactNode> = {
    all: <Star size={14} />,
    explorer: <Target size={14} />,
    calculator: <Zap size={14} />,
    expert: <Award size={14} />,
    social: <Sparkles size={14} />,
  };

  return (
    <>
      {/* Achievement Toast */}
      {toast && (
        <div className="fixed top-20 left-1/2 -translate-x-1/2 z-[70] animate-slide-up">
          <div className="bg-gradient-to-r from-amber-500 to-orange-500 text-white rounded-2xl shadow-2xl px-5 py-3 flex items-center gap-3">
            <div className="text-2xl">{ACHIEVEMENTS.find(a => a.id === toast)?.icon || '🏆'}</div>
            <div>
              <div className="text-xs font-bold uppercase tracking-wider opacity-80">{t('gamification.achievementUnlocked')}</div>
              <div className="font-extrabold text-sm">{t(`gamification.achievement.${toast}`)}</div>
            </div>
            <button onClick={() => setToast(null)} className="ml-2 p-1 hover:bg-white/20 rounded-full transition-colors">
              <X size={14} />
            </button>
          </div>
        </div>
      )}

      {/* Floating Gamification Button */}
      <div className="fixed bottom-20 right-4 z-40">
        <button
          onClick={() => { setIsExpanded(!isExpanded); Analytics.trackUIInteraction('gamification', 'widget', 'toggle', isExpanded ? 'close' : 'open'); }}
          className="relative bg-gradient-to-br from-amber-500 to-orange-600 text-white w-12 h-12 rounded-full shadow-lg hover:shadow-xl transition-all hover:scale-105 flex items-center justify-center"
          aria-label={t('gamification.title')}
        >
          <Trophy size={22} />
          {unlockedCount > 0 && (
            <span className="absolute -top-1 -right-1 bg-red-500 text-white text-[10px] font-black w-5 h-5 rounded-full flex items-center justify-center shadow-sm">
              {unlockedCount}
            </span>
          )}
        </button>
      </div>

      {/* Expanded Panel */}
      {isExpanded && (
        <div className="fixed bottom-36 right-4 z-40 w-[320px] sm:w-[360px] max-h-[70vh] bg-white dark:bg-slate-800 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-700 overflow-hidden animate-slide-up">
          {/* Header */}
          <div className="bg-gradient-to-r from-amber-500 via-orange-500 to-red-500 p-4 text-white">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Trophy size={20} />
                <h3 className="font-extrabold text-sm">{t('gamification.title')}</h3>
              </div>
              <button onClick={() => setIsExpanded(false)} className="p-1 hover:bg-white/20 rounded-full transition-colors">
                <X size={16} />
              </button>
            </div>

            {/* Level & XP */}
            <div className="flex items-center gap-3">
              <div className="bg-white/20 backdrop-blur-sm rounded-xl px-3 py-1.5 text-center">
                <div className="text-[10px] font-bold uppercase tracking-wider opacity-80">LVL</div>
                <div className="text-xl font-black">{levelInfo.level}</div>
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between text-xs mb-1">
                  <span className="font-bold">{LEVEL_TITLES[Math.min(levelInfo.level, LEVEL_TITLES.length - 1)] || `Level ${levelInfo.level}`}</span>
                  <span className="opacity-80">{levelInfo.currentXp}/{levelInfo.nextLevelXp} XP</span>
                </div>
                <div className="w-full bg-white/20 rounded-full h-2">
                  <div
                    className="bg-white rounded-full h-2 transition-all duration-500"
                    style={{ width: `${Math.min(100, (levelInfo.currentXp / levelInfo.nextLevelXp) * 100)}%` }}
                  />
                </div>
              </div>
            </div>

            {/* Streak */}
            <div className="flex items-center gap-2 mt-2 text-xs">
              <Flame size={14} className="text-yellow-300" />
              <span className="font-bold">{state.streak} {t('gamification.dayStreak')}</span>
              <span className="opacity-60">•</span>
              <span className="opacity-80">{unlockedCount}/{totalCount} {t('gamification.achievements')}</span>
              <span className="opacity-60">•</span>
              <span className="opacity-80">{progressPercent}%</span>
            </div>
          </div>

          {/* Category tabs */}
          <div className="flex border-b border-slate-200 dark:border-slate-700 px-2 overflow-x-auto">
            {(['all', 'explorer', 'calculator', 'expert', 'social'] as const).map(cat => (
              <button
                key={cat}
                onClick={() => setSelectedCategory(cat)}
                className={`flex items-center gap-1 px-3 py-2 text-xs font-bold whitespace-nowrap transition-colors border-b-2 ${
                  selectedCategory === cat
                    ? 'border-amber-500 text-amber-600 dark:text-amber-400'
                    : 'border-transparent text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'
                }`}
              >
                {categoryIcons[cat]}
                {t(`gamification.category.${cat}`)}
              </button>
            ))}
          </div>

          {/* Achievements list */}
          <div className="overflow-y-auto max-h-[40vh] p-3 space-y-2">
            {filteredAchievements.map(achievement => {
              const isUnlocked = !!state.unlockedAchievements[achievement.id];
              const count = state.actionCounts[achievement.id] || 0;
              const progress = Math.min(count / achievement.requiredCount, 1);

              return (
                <div
                  key={achievement.id}
                  className={`flex items-center gap-3 p-2.5 rounded-xl transition-all ${
                    isUnlocked
                      ? 'bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800'
                      : 'bg-slate-50 dark:bg-slate-700/50 border border-slate-200 dark:border-slate-600 opacity-70'
                  }`}
                >
                  <div className={`text-2xl flex-shrink-0 ${!isUnlocked ? 'grayscale opacity-50' : ''}`}>
                    {isUnlocked ? achievement.icon : '🔒'}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className={`text-xs font-bold ${isUnlocked ? 'text-amber-700 dark:text-amber-400' : 'text-slate-500 dark:text-slate-400'}`}>
                        {t(`gamification.achievement.${achievement.id}`)}
                      </span>
                      {isUnlocked && <CheckCircle2 size={12} className="text-emerald-500 flex-shrink-0" />}
                    </div>
                    <p className="text-[10px] text-slate-500 dark:text-slate-400 mt-0.5">
                      {t(`gamification.achievementDesc.${achievement.id}`)}
                    </p>
                    {!isUnlocked && achievement.requiredCount > 1 && (
                      <div className="mt-1 flex items-center gap-2">
                        <div className="flex-1 bg-slate-200 dark:bg-slate-600 rounded-full h-1.5">
                          <div className="bg-amber-500 rounded-full h-1.5 transition-all" style={{ width: `${progress * 100}%` }} />
                        </div>
                        <span className="text-[10px] text-slate-400 font-bold">{count}/{achievement.requiredCount}</span>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
};

export default GamificationWidget;
