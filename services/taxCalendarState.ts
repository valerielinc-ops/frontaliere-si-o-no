export const TAX_CHECKLIST_PROFILES = ['tutti', 'vecchio', 'nuovo'] as const;

export type TaxChecklistProfile = (typeof TAX_CHECKLIST_PROFILES)[number];

export interface TaxChecklistPreferences {
  profile: TaxChecklistProfile;
  reminderEnabled: boolean;
}

/** Compatibility aliases for the shared persisted-state parser API. */
export type TaxCalendarProfile = TaxChecklistProfile;
export type TaxCalendarPreferences = TaxChecklistPreferences;

const DEFAULT_TAX_CHECKLIST_PREFERENCES: TaxChecklistPreferences = {
  profile: 'tutti',
  reminderEnabled: false,
};

function isTaxChecklistProfile(value: unknown): value is TaxChecklistProfile {
  return typeof value === 'string'
    && (TAX_CHECKLIST_PROFILES as readonly string[]).includes(value);
}

export function normalizeTaxChecklistCompletedIds(
  value: unknown,
  deadlineIds: ReadonlySet<string>,
): string[] {
  if (!Array.isArray(value)) return [];

  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    if (typeof candidate !== 'string') continue;
    const id = candidate.trim();
    if (!id || !deadlineIds.has(id) || seen.has(id)) continue;
    seen.add(id);
    normalized.push(id);
  }
  return normalized;
}

export function normalizeTaxChecklistIds(
  value: unknown,
  deadlineIds: ReadonlySet<string>,
): string[] {
  return normalizeTaxChecklistCompletedIds(value, deadlineIds);
}

export function parseTaxChecklistCompletedIds(
  raw: string | null,
  deadlineIds: ReadonlySet<string>,
): string[] {
  if (!raw) return [];

  try {
    return normalizeTaxChecklistCompletedIds(JSON.parse(raw), deadlineIds);
  } catch {
    return [];
  }
}

export function normalizeTaxChecklistPreferences(value: unknown): TaxChecklistPreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ...DEFAULT_TAX_CHECKLIST_PREFERENCES };
  }

  const record = value as Record<string, unknown>;
  return {
    profile: isTaxChecklistProfile(record.profile)
      ? record.profile
      : DEFAULT_TAX_CHECKLIST_PREFERENCES.profile,
    reminderEnabled: typeof record.reminderEnabled === 'boolean'
      ? record.reminderEnabled
      : DEFAULT_TAX_CHECKLIST_PREFERENCES.reminderEnabled,
  };
}

export function normalizeTaxCalendarPreferences(value: unknown): TaxCalendarPreferences {
  return normalizeTaxChecklistPreferences(value);
}

export function parseTaxChecklistPreferences(raw: string | null): TaxChecklistPreferences {
  if (!raw) return { ...DEFAULT_TAX_CHECKLIST_PREFERENCES };

  try {
    return normalizeTaxChecklistPreferences(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_TAX_CHECKLIST_PREFERENCES };
  }
}
