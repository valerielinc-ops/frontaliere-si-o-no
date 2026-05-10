import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { Trophy, Star, Flame, Target, Award, Sparkles, CheckCircle2, Zap, X } from 'lucide-react';
import { useTranslation } from '@/services/i18n';
import { Analytics } from '@/services/analytics';
import { useNavigationOptional } from '@/services/NavigationContext';
import { requestSlot, releaseSlot, isActive, subscribe, POPUP_PRIORITY } from '@/services/popupQueue';
import {
 type Achievement,
 type GamificationState,
 ACHIEVEMENTS,
 LEVEL_TITLES,
 loadState,
 saveState,
 getLevel,
 unlockAchievement,
 addXp,
 subscribeAchievements,
} from '@/services/gamificationService';

const GAMIFICATION_TOAST_VISIBILITY_EVENT = 'gamification-toast-visibility';
const GAMIFICATION_LAST_SEEN_UNLOCK_KEY = 'frontaliere_gamification_last_seen_unlock_ts';

// Re-export from service for backward compatibility
export { ACHIEVEMENTS, LEVEL_TITLES, loadState, getLevel, unlockAchievement, addXp };
export type { Achievement, GamificationState };

function getToday(): string {
 return new Date().toISOString().split('T')[0];
}

function getLatestUnlockTsFromState(state: GamificationState): number {
 const unlockTimestamps = Object.values(state.unlockedAchievements || {});
 return unlockTimestamps.length > 0 ? Math.max(...unlockTimestamps) : 0;
}

function getLastSeenUnlockTs(): number {
 try {
 const raw = localStorage.getItem(GAMIFICATION_LAST_SEEN_UNLOCK_KEY);
 if (raw !== null) {
 const parsed = Number(raw);
 return Number.isFinite(parsed) ? parsed : 0;
 }
 // Bootstrap: mark existing historic unlocks as already seen.
 const bootstrapSeenTs = getLatestUnlockTsFromState(loadState());
 localStorage.setItem(GAMIFICATION_LAST_SEEN_UNLOCK_KEY, String(bootstrapSeenTs));
 return bootstrapSeenTs;
 } catch {
 return 0;
 }
}

function setLastSeenUnlockTs(ts: number): void {
 try {
 localStorage.setItem(GAMIFICATION_LAST_SEEN_UNLOCK_KEY, String(ts));
 } catch {
 // ignore storage failures
 }
}

// ─── Gamification Widget — Navbar notification button ───────────────────────

const GamificationWidget: React.FC = () => {
 const { t } = useTranslation();
 const nav = useNavigationOptional();
 const [state, setState] = useState<GamificationState>(loadState);
 const [isOpen, setIsOpen] = useState(false);
 const [lastSeenUnlockTs, setLastSeenUnlockTsState] = useState<number>(() => getLastSeenUnlockTs());
 const [toast, setToast] = useState<string | null>(null);
 const [toastVisible, setToastVisible] = useState(false);
 const panelRef = React.useRef<HTMLDivElement>(null);

 // Sync with popup queue — only show toast when it's our turn
 useEffect(() => {
 if (!toast) return;
 requestSlot('achievement-toast', POPUP_PRIORITY.ACHIEVEMENT_TOAST);
 setToastVisible(isActive('achievement-toast'));
 const unsub = subscribe(() => setToastVisible(isActive('achievement-toast')));
 const autoHide = setTimeout(() => {
 setToast(null);
 releaseSlot('achievement-toast');
 }, 3500);
 return () => { unsub(); clearTimeout(autoHide); };
 }, [toast]);

 useEffect(() => {
 window.dispatchEvent(new CustomEvent(GAMIFICATION_TOAST_VISIBILITY_EVENT, { detail: { visible: toastVisible } }));
 return () => {
 window.dispatchEvent(new CustomEvent(GAMIFICATION_TOAST_VISIBILITY_EVENT, { detail: { visible: false } }));
 };
 }, [toastVisible]);

 // Subscribe to achievement unlocks
 useEffect(() => {
 const handleUnlock = (id: string) => {
 const newState = loadState();
 if (newState.unlockedAchievements[id] && !state.unlockedAchievements[id]) {
 const achievement = ACHIEVEMENTS.find(a => a.id === id);
 if (achievement) {
 setToast(id);
 Analytics.trackUIInteraction('gamification', 'achievement', id, 'unlocked');
 }
 }
 setState(newState);
 };
 const unsubscribe = subscribeAchievements(handleUnlock);
 return unsubscribe;
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
 const latestUnlockTs = useMemo(() => getLatestUnlockTsFromState(state), [state.unlockedAchievements]);
 const hasUnreadAchievements = latestUnlockTs > lastSeenUnlockTs;
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
 const markAchievementsAsSeen = useCallback(() => {
 setLastSeenUnlockTs(latestUnlockTs);
 setLastSeenUnlockTsState(latestUnlockTs);
 }, [latestUnlockTs]);

 return (
 <>
 {/* Achievement Toast — bottom-right (desktop), above bottom nav (mobile) */}
 {/* Portal to document.body so backdrop-blur on header doesn't break fixed positioning */}
 {toast && toastVisible && createPortal(
 <div data-testid="gamification-toast" className="fixed bottom-20 md:bottom-4 right-4 sm:right-6 z-[60] animate-toast-in pointer-events-auto">
 <div className="bg-warning-strong text-on-accent rounded-xl shadow-lg px-4 py-2.5 flex items-center gap-2.5 max-w-xs">
 <span className="text-xl flex-shrink-0">{ACHIEVEMENTS.find(a => a.id === toast)?.icon || '🏆'}</span>
 <div className="min-w-0">
 <div className="text-xs font-bold uppercase tracking-wider opacity-80">{t('gamification.achievementUnlocked')}</div>
 <div className="font-bold text-xs truncate">{t(`gamification.achievement.${toast}`)}</div>
 </div>
 <button onClick={() => setToast(null)} className="ml-1 p-2 min-w-[44px] min-h-[44px] flex items-center justify-center hover:bg-on-accent/20 rounded-full transition-colors flex-shrink-0 focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-amber-500" aria-label="Chiudi">
 <X size={12} />
 </button>
 </div>
 </div>,
 document.body
 )}

 {/* Notification button + dropdown */}
 <div className="relative" ref={panelRef}>
 {/* Trophy icon button */}
 <button
 onClick={() => {
 const nextOpen = !isOpen;
 if (nextOpen) markAchievementsAsSeen();
 setIsOpen(nextOpen);
 Analytics.trackUIInteraction('gamification', 'widget', 'toggle', isOpen ? 'close' : 'open');
 }}
 className={`relative p-2 rounded-xl transition-colors focus-visible:ring-2 focus-visible:ring-warning focus-visible:ring-offset-2 ${
 hasUnreadAchievements
 ? 'bg-warning-subtle text-warning'
 : isOpen
 ? 'bg-surface-raised text-body'
 : 'text-muted hover:text-body hover:bg-surface-raised'
 }`}
 title={`${levelTitle} — ${state.xp} XP`}
 aria-label={`Gamification: ${levelTitle}, ${state.xp} XP`}
 >
 <Trophy size={18} className={hasUnreadAchievements ? 'animate-pulse' : undefined} />
 </button>

 {/* Dropdown panel — fixed on mobile, absolute on desktop */}
 {isOpen && (
 <div className="fixed sm:absolute inset-x-2 sm:inset-x-auto sm:right-0 top-16 sm:top-full sm:mt-2 sm:w-[340px] bg-surface rounded-2xl shadow-2xl border border-edge overflow-hidden z-[80] animate-slide-up max-h-[calc(100vh-5rem)] overflow-y-auto">
 {/* Header — level info */}
 <div className="px-4 py-3 bg-gradient-to-r from-warning-subtle to-warning-subtle border-b border-edge">
 <div className="flex items-center gap-3">
 <div className="relative flex-shrink-0">
 <div className="w-10 h-10 rounded-xl bg-warning-strong flex items-center justify-center shadow-sm">
 <Trophy size={18} className="text-on-accent" />
 </div>
 <span className="absolute -top-1 -right-1 bg-surface-raised text-heading text-xs font-bold w-5 h-5 rounded-full flex items-center justify-center shadow-sm">
 {levelInfo.level}
 </span>
 </div>
 <div className="flex-1 min-w-0">
 <div className="text-sm font-bold text-strong">{levelTitle}</div>
 <div className="text-sm text-muted">{state.xp} XP</div>
 </div>
 <div className="flex items-center gap-2 flex-shrink-0">
 {state.streak > 0 && (
 <div className="flex items-center gap-1 text-xs text-muted">
 <Flame size={14} className="text-warning" />
 <span className="font-bold">{state.streak}</span>
 </div>
 )}
 <div className="flex items-center gap-1 text-xs text-muted">
 <CheckCircle2 size={14} className="text-success" />
 <span className="font-bold">{unlockedCount}/{totalCount}</span>
 </div>
 </div>
 </div>
 {/* XP progress bar */}
 <div className="mt-2">
 <div className="w-full bg-surface-raised rounded-full h-1.5 overflow-hidden">
 <div
 className="bg-warning-strong rounded-full h-1.5 transition-transform duration-500 origin-left"
 style={{ transform: `scaleX(${xpProgressPct / 100})` }}
 />
 </div>
 <div className="flex justify-between text-xs text-muted mt-0.5">
 <span>{levelInfo.currentXp}/{levelInfo.nextLevelXp} XP</span>
 <span>{progressPercent}%</span>
 </div>
 </div>
 </div>

 {/* Recent achievements (last unlocked) */}
 <div className="px-3 py-2">
 <div className="text-xs uppercase tracking-wider text-muted font-bold mb-2 px-1">
 {t('gamification.recentAchievements') || 'Ultimi sbloccati'}
 </div>
 {recentAchievements.length === 0 ? (
 <div className="text-center py-4 text-xs text-muted">
 {t('gamification.noAchievementsYet') || 'Nessun achievement sbloccato ancora. Esplora il sito!'}
 </div>
 ) : (
 <div className="space-y-1.5">
 {recentAchievements.map(achievement => (
 <div
 key={achievement.id}
 className="flex items-center gap-2.5 p-2 rounded-lg bg-warning-subtle border border-warning-border"
 >
 <span className="text-lg flex-shrink-0">{achievement.icon}</span>
 <div className="flex-1 min-w-0">
 <div className="flex items-center gap-1">
 <span className="text-xs font-bold truncate text-warning">
 {t(`gamification.achievement.${achievement.id}`)}
 </span>
 <CheckCircle2 size={10} className="text-success flex-shrink-0" />
 </div>
 </div>
 </div>
 ))}
 </div>
 )}
 </div>

 {/* View all button */}
 {nav && (
 <div className="px-3 pb-3">
 <button
 onClick={() => { setIsOpen(false); nav.navigateTo('gamification'); }}
 className="w-full py-2.5 text-xs font-bold text-warning bg-warning-subtle hover:bg-warning-subtle rounded-xl transition-colors border border-warning-border focus-visible:ring-2 focus-visible:ring-warning focus-visible:ring-offset-2 "
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
