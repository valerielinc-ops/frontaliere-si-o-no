/**
 * Gamification Service — Pure data & state management (no React, no Analytics)
 * This module is intentionally kept dependency-free to avoid pulling in
 * heavy vendor chunks (Firebase, etc.) into the main bundle.
 */

// ─── Achievement Definitions ────────────────────────────────────────────────

export interface Achievement {
 id: string;
 icon: string;
 category: 'explorer' | 'calculator' | 'expert' | 'social';
 requiredCount: number;
}

export const ACHIEVEMENTS: Achievement[] = [
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
 { id: 'what_if_dreamer', icon: '💭', category: 'calculator', requiredCount: 1 },
 { id: 'simulation_pro', icon: '📊', category: 'calculator', requiredCount: 5 },
 // Expert — deep usage
 { id: 'currency_watcher', icon: '💱', category: 'expert', requiredCount: 1 },
 { id: 'tax_calendar_user', icon: '📅', category: 'expert', requiredCount: 1 },
 { id: 'health_researcher', icon: '🏥', category: 'expert', requiredCount: 1 },
 { id: 'dark_mode_fan', icon: '🌙', category: 'expert', requiredCount: 1 },
 // Social — engagement
 { id: 'feedback_giver', icon: '💬', category: 'social', requiredCount: 1 },
 { id: 'stats_checker', icon: '📈', category: 'social', requiredCount: 1 },
 { id: 'newsletter_sub', icon: '📧', category: 'social', requiredCount: 1 },
 { id: 'app_shortcut', icon: '📱', category: 'social', requiredCount: 1 },
 { id: 'social_login', icon: '🔑', category: 'social', requiredCount: 1 },
 { id: 'profile_complete', icon: '👤', category: 'social', requiredCount: 1 },
 { id: 'quiz_completed', icon: '🧠', category: 'expert', requiredCount: 1 },
 { id: 'quiz_perfect', icon: '🎯', category: 'expert', requiredCount: 1 },
 { id: 'survey_participant', icon: '📊', category: 'social', requiredCount: 1 },
 { id: 'salary_quiz', icon: '💸', category: 'calculator', requiredCount: 1 },
 { id: 'social_sharer', icon: '📤', category: 'social', requiredCount: 1 },
 { id: 'email_results', icon: '📩', category: 'social', requiredCount: 1 },
 { id: 'forum_first_question', icon: '❓', category: 'social', requiredCount: 1 },
 { id: 'forum_first_answer', icon: '💡', category: 'social', requiredCount: 1 },
 { id: 'chatbot_user', icon: '🤖', category: 'explorer', requiredCount: 1 },
 { id: 'dialect_explorer', icon: '🗣️', category: 'explorer', requiredCount: 5 },
];

// ─── Gamification State Management ──────────────────────────────────────────

const STORAGE_KEY = 'frontaliere_achievements';

export interface GamificationState {
 unlockedAchievements: Record<string, number>;
 actionCounts: Record<string, number>;
 xp: number;
 streak: number;
 lastVisitDay: string;
}

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

export function saveState(state: GamificationState) {
 localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
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

export const LEVEL_TITLES = [
 '',
 'Novizio', 'Esploratore', 'Viaggiatore', 'Pendolare',
 'Veterano', 'Esperto', 'Maestro', 'Guru', 'Leggenda', 'Frontaliere DOC',
];

// ─── Global API ─────────────────────────────────────────────────────────────

type AchievementListener = (id: string) => void;
const listeners: Set<AchievementListener> = new Set();

export function subscribeAchievements(fn: AchievementListener): () => void {
 listeners.add(fn);
 return () => listeners.delete(fn);
}

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
