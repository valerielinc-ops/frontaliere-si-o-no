import React, { useState, useEffect, useMemo } from 'react';
import { Trophy, Star, Flame, Target, Award, Sparkles, CheckCircle2, Zap, Lock } from 'lucide-react';
import { useTranslation } from '@/services/i18n';
import { ACHIEVEMENTS, loadState, getLevel, LEVEL_TITLES, type GamificationState } from '@/components/GamificationWidget';

const GamificationPage: React.FC = () => {
  const { t } = useTranslation();
  const [state, setState] = useState<GamificationState>(loadState);
  const [selectedCategory, setSelectedCategory] = useState<'all' | 'explorer' | 'calculator' | 'expert' | 'social'>('all');

  // Re-read state when localStorage changes (in case achievements unlock while on this page)
  useEffect(() => {
    const interval = setInterval(() => {
      setState(loadState());
    }, 2000);
    return () => clearInterval(interval);
  }, []);

  const levelInfo = useMemo(() => getLevel(state.xp), [state.xp]);
  const unlockedCount = Object.keys(state.unlockedAchievements).length;
  const totalCount = ACHIEVEMENTS.length;
  const progressPercent = Math.round((unlockedCount / totalCount) * 100);
  const levelTitle = LEVEL_TITLES[Math.min(levelInfo.level, LEVEL_TITLES.length - 1)] || `Level ${levelInfo.level}`;
  const xpProgressPct = Math.min(100, (levelInfo.currentXp / levelInfo.nextLevelXp) * 100);

  const filteredAchievements = useMemo(() => {
    if (selectedCategory === 'all') return ACHIEVEMENTS;
    return ACHIEVEMENTS.filter(a => a.category === selectedCategory);
  }, [selectedCategory]);

  const categoryIcons: Record<string, React.ReactNode> = {
    all: <Star size={16} />,
    explorer: <Target size={16} />,
    calculator: <Zap size={16} />,
    expert: <Award size={16} />,
    social: <Sparkles size={16} />,
  };

  const categoryColors: Record<string, string> = {
    all: 'from-amber-500 to-orange-500',
    explorer: 'from-blue-500 to-indigo-500',
    calculator: 'from-emerald-500 to-teal-500',
    expert: 'from-purple-500 to-violet-500',
    social: 'from-pink-500 to-rose-500',
  };

  // Sort: unlocked first (most recent first), then locked
  const sortedAchievements = useMemo(() => {
    return [...filteredAchievements].sort((a, b) => {
      const aUnlocked = state.unlockedAchievements[a.id];
      const bUnlocked = state.unlockedAchievements[b.id];
      if (aUnlocked && !bUnlocked) return -1;
      if (!aUnlocked && bUnlocked) return 1;
      if (aUnlocked && bUnlocked) return bUnlocked - aUnlocked; // most recent first
      return 0;
    });
  }, [filteredAchievements, state.unlockedAchievements]);

  return (
    <div className="space-y-6 pb-8">
      {/* Hero header */}
      <div className="bg-gradient-to-br from-amber-500 via-orange-500 to-red-500 rounded-2xl p-8 text-white relative overflow-hidden">
        <div className="absolute inset-0 bg-black/10" />
        <div className="relative z-10">
          <div className="flex items-center gap-4 mb-6">
            <div className="w-16 h-16 rounded-2xl bg-white/20 backdrop-blur-sm flex items-center justify-center shadow-lg">
              <Trophy size={32} className="text-white" />
            </div>
            <div>
              <h2 className="text-3xl font-extrabold">{t('gamification.pageTitle') || 'I tuoi Progressi'}</h2>
              <p className="text-amber-100 text-sm mt-1">{t('gamification.pageSubtitle') || 'Sblocca achievement esplorando tutte le funzionalità'}</p>
            </div>
          </div>

          {/* Level + Stats row */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <div className="bg-white/15 backdrop-blur-sm rounded-xl p-4">
              <div className="text-[10px] uppercase tracking-wider text-amber-200 font-bold mb-1">{t('gamification.level') || 'Livello'}</div>
              <div className="text-3xl font-black">{levelInfo.level}</div>
              <div className="text-xs text-amber-100 font-semibold">{levelTitle}</div>
            </div>
            <div className="bg-white/15 backdrop-blur-sm rounded-xl p-4">
              <div className="text-[10px] uppercase tracking-wider text-amber-200 font-bold mb-1">XP</div>
              <div className="text-3xl font-black">{state.xp}</div>
              <div className="w-full bg-white/20 rounded-full h-1.5 mt-2">
                <div className="bg-white rounded-full h-1.5 transition-all duration-500" style={{ width: `${xpProgressPct}%` }} />
              </div>
              <div className="text-[9px] text-amber-200 mt-1">{levelInfo.currentXp}/{levelInfo.nextLevelXp} → Livello {levelInfo.level + 1}</div>
            </div>
            <div className="bg-white/15 backdrop-blur-sm rounded-xl p-4">
              <div className="text-[10px] uppercase tracking-wider text-amber-200 font-bold mb-1">{t('gamification.dayStreak') || 'Streak'}</div>
              <div className="flex items-center gap-2">
                <Flame size={24} className="text-orange-200" />
                <span className="text-3xl font-black">{state.streak}</span>
              </div>
              <div className="text-xs text-amber-100">{t('gamification.daysInARow') || 'giorni consecutivi'}</div>
            </div>
            <div className="bg-white/15 backdrop-blur-sm rounded-xl p-4">
              <div className="text-[10px] uppercase tracking-wider text-amber-200 font-bold mb-1">{t('gamification.progress') || 'Progressi'}</div>
              <div className="text-3xl font-black">{unlockedCount}<span className="text-lg text-amber-200">/{totalCount}</span></div>
              <div className="text-xs text-amber-100">{progressPercent}% {t('gamification.completed') || 'completato'}</div>
            </div>
          </div>
        </div>
      </div>

      {/* Category filter tabs */}
      <div className="flex gap-2 overflow-x-auto pb-1">
        {(['all', 'explorer', 'calculator', 'expert', 'social'] as const).map(cat => {
          const catCount = cat === 'all' ? totalCount : ACHIEVEMENTS.filter(a => a.category === cat).length;
          const catUnlocked = cat === 'all'
            ? unlockedCount
            : ACHIEVEMENTS.filter(a => a.category === cat && state.unlockedAchievements[a.id]).length;

          return (
            <button
              key={cat}
              onClick={() => setSelectedCategory(cat)}
              className={`flex items-center gap-2 px-4 py-2.5 text-sm font-bold whitespace-nowrap rounded-xl transition-all ${
                selectedCategory === cat
                  ? `bg-gradient-to-r ${categoryColors[cat]} text-white shadow-md`
                  : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-700'
              }`}
            >
              {categoryIcons[cat]}
              <span>{t(`gamification.category.${cat}`)}</span>
              <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${selectedCategory === cat ? 'bg-white/30' : 'bg-slate-200 dark:bg-slate-700'}`}>
                {catUnlocked}/{catCount}
              </span>
            </button>
          );
        })}
      </div>

      {/* Achievement grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {sortedAchievements.map(achievement => {
          const isUnlocked = !!state.unlockedAchievements[achievement.id];
          const count = state.actionCounts[achievement.id] || 0;
          const progress = Math.min(count / achievement.requiredCount, 1);
          const unlockedAt = state.unlockedAchievements[achievement.id];
          const unlockedDate = unlockedAt ? new Date(unlockedAt).toLocaleDateString() : null;

          return (
            <div
              key={achievement.id}
              className={`relative flex items-start gap-4 p-4 rounded-2xl transition-all ${
                isUnlocked
                  ? 'bg-white dark:bg-slate-800 border-2 border-amber-300 dark:border-amber-700 shadow-md'
                  : 'bg-white/60 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 opacity-70'
              }`}
            >
              {/* Icon */}
              <div className={`text-3xl flex-shrink-0 w-12 h-12 rounded-xl flex items-center justify-center ${
                isUnlocked
                  ? 'bg-amber-50 dark:bg-amber-900/20'
                  : 'bg-slate-100 dark:bg-slate-700 grayscale'
              }`}>
                {isUnlocked ? achievement.icon : <Lock size={20} className="text-slate-500" />}
              </div>

              {/* Content */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <h3 className={`text-sm font-bold ${isUnlocked ? 'text-amber-700 dark:text-amber-400' : 'text-slate-500 dark:text-slate-500'}`}>
                    {t(`gamification.achievement.${achievement.id}`)}
                  </h3>
                  {isUnlocked && <CheckCircle2 size={14} className="text-emerald-500 flex-shrink-0" />}
                </div>
                <p className="text-xs text-slate-500 dark:text-slate-500 mt-0.5">
                  {t(`gamification.achievementDesc.${achievement.id}`)}
                </p>

                {/* Progress bar for locked multi-count achievements */}
                {!isUnlocked && achievement.requiredCount > 1 && (
                  <div className="flex items-center gap-2 mt-2">
                    <div className="flex-1 bg-slate-200 dark:bg-slate-600 rounded-full h-1.5">
                      <div className="bg-amber-500 rounded-full h-1.5 transition-all" style={{ width: `${progress * 100}%` }} />
                    </div>
                    <span className="text-[10px] text-slate-500 font-bold">{count}/{achievement.requiredCount}</span>
                  </div>
                )}

                {/* Unlocked date */}
                {isUnlocked && unlockedDate && (
                  <div className="text-[10px] text-slate-500 mt-1.5 flex items-center gap-1">
                    <CheckCircle2 size={10} />
                    {t('gamification.unlockedOn') || 'Sbloccato il'} {unlockedDate}
                  </div>
                )}

                {/* XP reward */}
                <div className="flex items-center gap-1 mt-1.5">
                  <Zap size={10} className={isUnlocked ? 'text-amber-500' : 'text-slate-500'} />
                  <span className={`text-[10px] font-bold ${isUnlocked ? 'text-amber-600 dark:text-amber-400' : 'text-slate-500'}`}>
                    +50 XP
                  </span>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Level progression guide */}
      <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-6">
        <h3 className="text-lg font-bold text-slate-800 dark:text-slate-100 mb-4 flex items-center gap-2">
          <Trophy size={20} className="text-amber-500" />
          {t('gamification.levelGuide') || 'Livelli'}
        </h3>
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          {LEVEL_TITLES.slice(1).map((title, i) => {
            const lvl = i + 1;
            const isCurrent = lvl === levelInfo.level;
            const isReached = lvl <= levelInfo.level;
            return (
              <div
                key={lvl}
                className={`p-3 rounded-xl text-center transition-all ${
                  isCurrent
                    ? 'bg-gradient-to-br from-amber-100 to-orange-100 dark:from-amber-900/30 dark:to-orange-900/30 border-2 border-amber-400 dark:border-amber-700 shadow-sm'
                    : isReached
                      ? 'bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800'
                      : 'bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700 opacity-50'
                }`}
              >
                <div className={`text-lg font-black ${isCurrent ? 'text-amber-600' : isReached ? 'text-emerald-600' : 'text-slate-500'}`}>
                  {lvl}
                </div>
                <div className="text-[10px] font-bold text-slate-600 dark:text-slate-300 mt-0.5">{title}</div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

export default GamificationPage;
