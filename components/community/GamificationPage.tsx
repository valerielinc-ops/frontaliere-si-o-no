import React, { useState, useEffect, useMemo } from 'react';
import { Trophy, Star, Flame, Target, Award, Sparkles, CheckCircle2, Zap, Lock } from 'lucide-react';
import { useTranslation } from '@/services/i18n';
import { ACHIEVEMENTS, loadState, getLevel, LEVEL_TITLES, type GamificationState } from '@/services/gamificationService';

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
 all: 'from-warning-strong to-warning-strong',
 explorer: 'from-accent-strong to-accent-strong',
 calculator: 'from-success-strong to-info-strong',
 expert: 'from-info-strong to-info-strong',
 social: 'from-warning-strong to-warning-strong',
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
 <div className="bg-gradient-to-br from-warning-strong via-warning to-danger-strong rounded-2xl p-5 sm:p-8 text-on-accent relative overflow-hidden">
 <div className="absolute inset-0 bg-black/10" />
 <div className="relative z-10">
 <div className="flex items-center gap-4 mb-6">
 <div className="w-16 h-16 rounded-2xl bg-on-accent/20 flex items-center justify-center shadow-lg">
 <Trophy size={32} className="text-on-accent" />
 </div>
 <div>
 <h2 className="text-2xl sm:text-3xl font-bold">{t('gamification.pageTitle') || 'I tuoi Progressi'}</h2>
 <p className="text-on-accent/80 text-sm mt-1">{t('gamification.pageSubtitle') || 'Sblocca achievement esplorando tutte le funzionalità'}</p>
 </div>
 </div>

 {/* Level + Stats row */}
 <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1.5 text-sm text-on-accent/80">
 <span className="inline-flex items-baseline gap-1.5"><span className="text-lg font-semibold text-on-accent">{levelInfo.level}</span> {t('gamification.level') || 'Livello'} — <span className="text-xs text-on-accent font-semibold">{levelTitle}</span></span>
 <span className="text-on-accent/30" aria-hidden="true">·</span>
 <span className="inline-flex items-baseline gap-1.5"><span className="text-lg font-semibold text-on-accent">{state.xp}</span> XP</span>
 <span className="text-on-accent/30" aria-hidden="true">·</span>
 <span className="inline-flex items-baseline gap-1.5"><Flame size={16} className="text-on-accent" /><span className="text-lg font-semibold text-on-accent">{state.streak}</span> {t('gamification.daysInARow') || 'giorni consecutivi'}</span>
 <span className="text-on-accent/30" aria-hidden="true">·</span>
 <span className="inline-flex items-baseline gap-1.5"><span className="text-lg font-semibold text-on-accent">{unlockedCount}<span className="text-sm text-on-accent/70">/{totalCount}</span></span> {progressPercent}% {t('gamification.completed') || 'completato'}</span>
 </div>
 <div className="w-full max-w-xs bg-on-accent/20 rounded-full h-1.5 mt-3">
 <div className="bg-surface rounded-full h-1.5 transition-transform duration-500" style={{ width: '100%', transform: `scaleX(${xpProgressPct / 100})`, transformOrigin: 'left' }} />
 </div>
 <div className="text-xs text-on-accent/80 mt-1">{levelInfo.currentXp}/{levelInfo.nextLevelXp} → {t('gamification.level')} {levelInfo.level + 1}</div>
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
 className={`flex items-center gap-2 px-4 py-2.5 text-sm font-bold whitespace-nowrap rounded-xl transition-[color,background-color,border-color,box-shadow] ${
 selectedCategory === cat
 ? `bg-gradient-to-r ${categoryColors[cat]} text-on-accent shadow-md`
 : 'bg-surface text-subtle hover:bg-surface-raised border border-edge'
 }`}
 >
 {categoryIcons[cat]}
 <span>{t(`gamification.category.${cat}`)}</span>
 <span className={`text-xs px-1.5 py-0.5 rounded-full ${selectedCategory === cat ? 'bg-on-accent/30' : 'bg-surface-raised'}`}>
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
 className={`relative flex items-start gap-4 p-4 rounded-2xl transition-[color,background-color,border-color,box-shadow] ${
 isUnlocked
 ? 'bg-surface border-2 border-warning-border shadow-md'
 : 'bg-surface/60 border border-edge opacity-70'
 }`}
 >
 {/* Icon */}
 <div className={`text-3xl flex-shrink-0 w-12 h-12 rounded-xl flex items-center justify-center ${
 isUnlocked
 ? 'bg-warning-subtle'
 : 'bg-surface-raised grayscale'
 }`}>
 {isUnlocked ? achievement.icon : <Lock size={20} className="text-muted" />}
 </div>

 {/* Content */}
 <div className="flex-1 min-w-0">
 <div className="flex items-center gap-2">
 <h3 className={`text-sm font-bold ${isUnlocked ? 'text-warning' : 'text-muted'}`}>
 {t(`gamification.achievement.${achievement.id}`)}
 </h3>
 {isUnlocked && <CheckCircle2 size={14} className="text-success flex-shrink-0" />}
 </div>
 <p className="text-sm text-muted mt-0.5">
 {t(`gamification.achievementDesc.${achievement.id}`)}
 </p>

 {/* Progress bar for locked multi-count achievements */}
 {!isUnlocked && achievement.requiredCount > 1 && (
 <div className="flex items-center gap-2 mt-2">
 <div className="flex-1 bg-surface-raised rounded-full h-1.5">
 <div className="bg-warning-strong rounded-full h-1.5 transition-transform duration-300" style={{ width: '100%', transform: `scaleX(${progress})`, transformOrigin: 'left' }} />
 </div>
 <span className="text-sm text-muted font-bold">{count}/{achievement.requiredCount}</span>
 </div>
 )}

 {/* Unlocked date */}
 {isUnlocked && unlockedDate && (
 <div className="text-sm text-muted mt-1.5 flex items-center gap-1">
 <CheckCircle2 size={10} />
 {t('gamification.unlockedOn') || 'Sbloccato il'} {unlockedDate}
 </div>
 )}

 {/* XP reward */}
 <div className="flex items-center gap-1 mt-1.5">
 <Zap size={10} className={isUnlocked ? 'text-warning' : 'text-muted'} />
 <span className={`text-xs font-bold ${isUnlocked ? 'text-warning' : 'text-muted'}`}>
 +50 XP
 </span>
 </div>
 </div>
 </div>
 );
 })}
 </div>

 {/* Level progression guide */}
 <div className="bg-surface rounded-2xl border border-edge p-6">
 <h3 className="text-lg font-bold text-strong mb-4 flex items-center gap-2">
 <Trophy size={20} className="text-warning" />
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
 className={`p-3 rounded-xl text-center transition-[color,background-color,border-color,box-shadow] ${
 isCurrent
 ? 'bg-gradient-to-br from-warning-subtle to-warning-subtle border-2 border-warning-border shadow-sm'
 : isReached
 ? 'bg-success-subtle border border-success-border'
 : 'bg-surface-alt/50 border border-edge opacity-50'
 }`}
 >
 <div className={`text-lg font-bold ${isCurrent ? 'text-warning' : isReached ? 'text-success' : 'text-muted'}`}>
 {lvl}
 </div>
 <div className="text-xs font-bold text-subtle mt-0.5">{title}</div>
 </div>
 );
 })}
 </div>
 </div>
 </div>
 );
};

export default GamificationPage;
