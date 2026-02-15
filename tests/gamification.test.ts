import { describe, it, expect, beforeEach } from 'vitest';
import {
  ACHIEVEMENTS,
  LEVEL_TITLES,
  loadState,
  getLevel,
  unlockAchievement,
  addXp,
} from '@/components/GamificationWidget';

const STORAGE_KEY = 'frontaliere_achievements';

beforeEach(() => {
  localStorage.clear();
});

// ─── Achievement definitions ────────────────────────────────────────────────

describe('ACHIEVEMENTS', () => {
  it('has no duplicate IDs', () => {
    const ids = ACHIEVEMENTS.map(a => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every achievement has a valid category', () => {
    const validCategories = ['explorer', 'calculator', 'expert', 'social'];
    for (const a of ACHIEVEMENTS) {
      expect(validCategories).toContain(a.category);
    }
  });

  it('every achievement has requiredCount >= 1', () => {
    for (const a of ACHIEVEMENTS) {
      expect(a.requiredCount).toBeGreaterThanOrEqual(1);
    }
  });

  it('has at least 15 achievements', () => {
    expect(ACHIEVEMENTS.length).toBeGreaterThanOrEqual(15);
  });

  it('contains the key achievements that must be wirable', () => {
    const ids = ACHIEVEMENTS.map(a => a.id);
    const requiredIds = [
      'first_visit', 'guide_reader', 'comparator_curious',
      'first_simulation', 'pillar3_saver', 'what_if_dreamer',
      'school_finder', 'map_explorer', 'tax_calendar_user',
      'newsletter_sub', 'pwa_installer', 'dark_mode_fan',
      'feedback_giver', 'health_researcher', 'currency_watcher',
    ];
    for (const id of requiredIds) {
      expect(ids).toContain(id);
    }
  });
});

// ─── Level titles ───────────────────────────────────────────────────────────

describe('LEVEL_TITLES', () => {
  it('has at least 10 level titles (index 1–10)', () => {
    expect(LEVEL_TITLES.length).toBeGreaterThanOrEqual(11); // index 0 is empty
  });

  it('first element is empty string (level 0 placeholder)', () => {
    expect(LEVEL_TITLES[0]).toBe('');
  });
});

// ─── loadState ──────────────────────────────────────────────────────────────

describe('loadState', () => {
  it('returns default state when localStorage is empty', () => {
    const state = loadState();
    expect(state.xp).toBe(0);
    expect(state.streak).toBe(0);
    expect(state.lastVisitDay).toBe('');
    expect(Object.keys(state.unlockedAchievements)).toHaveLength(0);
    expect(Object.keys(state.actionCounts)).toHaveLength(0);
  });

  it('loads previously saved state', () => {
    const saved = {
      unlockedAchievements: { first_visit: Date.now() },
      actionCounts: { first_visit: 1 },
      xp: 150,
      streak: 3,
      lastVisitDay: '2025-01-01',
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
    const state = loadState();
    expect(state.xp).toBe(150);
    expect(state.streak).toBe(3);
    expect(state.unlockedAchievements.first_visit).toBeDefined();
  });

  it('handles corrupted JSON gracefully', () => {
    localStorage.setItem(STORAGE_KEY, 'NOT_JSON');
    const state = loadState();
    expect(state.xp).toBe(0);
  });
});

// ─── getLevel ───────────────────────────────────────────────────────────────

describe('getLevel', () => {
  it('returns level 1 for 0 XP', () => {
    const { level, currentXp, nextLevelXp } = getLevel(0);
    expect(level).toBe(1);
    expect(currentXp).toBe(0);
    expect(nextLevelXp).toBeGreaterThan(0);
  });

  it('returns level 2 for 100 XP', () => {
    const { level } = getLevel(100);
    expect(level).toBe(2);
  });

  it('returns level 3 for 250 XP', () => {
    const { level } = getLevel(250);
    expect(level).toBe(3);
  });

  it('always returns currentXp >= 0', () => {
    for (const xp of [0, 50, 99, 100, 200, 500, 5000]) {
      const { currentXp } = getLevel(xp);
      expect(currentXp).toBeGreaterThanOrEqual(0);
    }
  });

  it('level increases monotonically with XP', () => {
    let prevLevel = 0;
    for (const xp of [0, 100, 250, 500, 800, 1200, 1700, 2300, 3000, 4000, 5000]) {
      const { level } = getLevel(xp);
      expect(level).toBeGreaterThan(prevLevel);
      prevLevel = level;
    }
  });
});

// ─── unlockAchievement ──────────────────────────────────────────────────────

describe('unlockAchievement', () => {
  it('increments action count on first call', () => {
    unlockAchievement('first_visit');
    const state = loadState();
    expect(state.actionCounts.first_visit).toBe(1);
  });

  it('unlocks a requiredCount=1 achievement immediately', () => {
    unlockAchievement('first_visit');
    const state = loadState();
    expect(state.unlockedAchievements.first_visit).toBeDefined();
    expect(state.xp).toBe(50);
  });

  it('does not re-unlock an already unlocked achievement', () => {
    unlockAchievement('first_visit');
    unlockAchievement('first_visit');
    const state = loadState();
    expect(state.xp).toBe(50); // only 50, not 100
    expect(state.actionCounts.first_visit).toBe(2);
  });

  it('respects requiredCount > 1 (comparator_curious needs 3)', () => {
    unlockAchievement('comparator_curious');
    expect(loadState().unlockedAchievements.comparator_curious).toBeUndefined();

    unlockAchievement('comparator_curious');
    expect(loadState().unlockedAchievements.comparator_curious).toBeUndefined();

    unlockAchievement('comparator_curious');
    expect(loadState().unlockedAchievements.comparator_curious).toBeDefined();
    expect(loadState().xp).toBe(50);
  });

  it('handles unknown achievement IDs without error', () => {
    expect(() => unlockAchievement('totally_fake_id')).not.toThrow();
    const state = loadState();
    expect(state.actionCounts.totally_fake_id).toBe(1);
    // no xp awarded because it's not in ACHIEVEMENTS
    expect(state.xp).toBe(0);
  });
});

// ─── addXp ──────────────────────────────────────────────────────────────────

describe('addXp', () => {
  it('adds XP to the state', () => {
    addXp(100);
    expect(loadState().xp).toBe(100);
  });

  it('accumulates XP across multiple calls', () => {
    addXp(50);
    addXp(75);
    expect(loadState().xp).toBe(125);
  });

  it('works together with unlockAchievement', () => {
    unlockAchievement('first_visit'); // +50 xp
    addXp(30);
    expect(loadState().xp).toBe(80);
  });
});
