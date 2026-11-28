const SLOT_MINUTES = Object.freeze({ frontaliere: 7, svizzera: 37 });

export const GENERATION_SLOT_MAX_LATE_MINUTES = 13;
const CANTON_GENERATION_SLOT_MAX_LATE_MINUTES = 16;
export const GENERATION_SLOT_SETTLE_MINUTES = 2;
// These markers stay outside LOOP_CLOCK_ENTRIES: the observer owns ordinary
// workflow cadences, while generation health has its own article-progress scan.
export const GENERATION_SLOT_ENTRIES = Object.freeze([
  Object.freeze({
    id: 'corpus-generation-slot-frontaliere',
    repo: 'corpus',
    workflow: 'generate-article.yml',
    everyMinutes: 60,
    generationSlot: 'frontaliere',
  }),
  Object.freeze({
    id: 'corpus-generation-slot-svizzera',
    repo: 'corpus',
    workflow: 'generate-article.yml',
    everyMinutes: 60,
    generationSlot: 'svizzera',
  }),
]);

export function generationSlotWorkflow(section) {
  if (Object.hasOwn(SLOT_MINUTES, section)) return 'generate-article.yml';
  const canton = /^canton-([a-z]+)$/u.exec(section ?? '');
  return canton ? `generate-article-${canton[1]}.yml` : null;
}

export function generationSlotMinute(section) {
  return SLOT_MINUTES[section] ?? null;
}

/** Read the schedule generated from the corpus profiles and workflow names. */
export function parseCantonGenerationSchedule(document) {
  if (document?.schema !== 1 || !Array.isArray(document.entries) || document.entries.length === 0) {
    throw new TypeError('invalid canton generation schedule');
  }
  const sections = new Set();
  return document.entries.map(({ section, workflow, cron, baseSlotHours } = {}) => {
    const expectedWorkflow = typeof section === 'string' && section.startsWith('canton-')
      ? generationSlotWorkflow(section) : null;
    const schedule = /^(\d{1,2}) (\*|\d{1,2}(?:,\d{1,2})*) \* \* \*$/u.exec(cron ?? '');
    if (!expectedWorkflow || workflow !== expectedWorkflow || !schedule || sections.has(section)) {
      throw new TypeError('invalid canton generation schedule entry');
    }
    const slotMinute = Number(schedule[1]);
    const slotHours = schedule[2] === '*' ? null : schedule[2].split(',').map(Number);
    if (slotMinute > 59 || slotHours?.some((hour, index) => hour > 23 || (index > 0 && hour <= slotHours[index - 1]))) {
      throw new TypeError('invalid canton generation schedule time');
    }
    // Optional: hours (UTC) of the base cadence. Absent = every slot is a base slot.
    let base = null;
    if (baseSlotHours !== undefined) {
      if (!Array.isArray(baseSlotHours) || baseSlotHours.length === 0
        || baseSlotHours.some((hour, index) => !Number.isInteger(hour) || hour < 0 || hour > 23
          || baseSlotHours.indexOf(hour) !== index)) {
        throw new TypeError('invalid canton generation schedule base slot hours');
      }
      base = [...baseSlotHours];
    }
    sections.add(section);
    return {
      id: `corpus-generation-slot-${section}`,
      repo: 'corpus',
      workflow,
      generationSlot: section,
      slotMinute,
      slotHours,
      baseSlotHours: base,
    };
  });
}

/**
 * Parse CANTON_HIGH_CADENCE_SECTIONS like the corpus does (codes, ids, `all`;
 * separated by commas, semicolons or whitespace). Unknown tokens are ignored,
 * an empty or missing value is an empty set: never "all".
 */
export function parseHighCadenceSections(raw, knownSections) {
  const known = new Set(knownSections);
  const out = new Set();
  for (const token of String(raw ?? '').split(/[\s,;]+/u).map((t) => t.trim()).filter(Boolean)) {
    const lower = token.toLowerCase();
    if (lower === 'all' || lower === '*') {
      for (const section of known) out.add(section);
      continue;
    }
    const id = lower.startsWith('canton-') ? lower : `canton-${lower}`;
    if (known.has(id)) out.add(id);
  }
  return out;
}

/**
 * Keep a slot when the section is high-cadence, the entry carries no base
 * cadence (old calendar), or the nominal UTC hour is a base-cadence hour.
 */
export function cantonSlotIsKept(entry, nominalSlot, highCadence) {
  if (!entry.baseSlotHours) return true;
  return highCadence.has(entry.generationSlot) || entry.baseSlotHours.includes(nominalSlot.getUTCHours());
}

/**
 * Resolve the nominal UTC generation slot owned by this clock tick.
 * Cloud Scheduler ticks on five-minute boundaries; :10 and :40 own the :07
 * and :37 generation slots respectively. Canton slots can first be eligible
 * six minutes after their nominal minute, so allow two further clock ticks.
 */
export function generationSlotDateForEntry(entry, scheduledAt, {
  maxLateMinutes = typeof entry?.generationSlot === 'string' && entry.generationSlot.startsWith('canton-')
    ? CANTON_GENERATION_SLOT_MAX_LATE_MINUTES
    : GENERATION_SLOT_MAX_LATE_MINUTES,
  settleMinutes = GENERATION_SLOT_SETTLE_MINUTES,
} = {}) {
  const minute = entry?.slotMinute ?? generationSlotMinute(entry?.generationSlot);
  const scheduled = scheduledAt instanceof Date ? new Date(scheduledAt.getTime()) : new Date(scheduledAt);
  if (minute === null || !Number.isFinite(scheduled.getTime())
    || !Number.isFinite(maxLateMinutes) || maxLateMinutes < 0
    || !Number.isFinite(settleMinutes) || settleMinutes < 0) return null;

  const tickMs = 5 * 60_000;
  const tick = new Date(Math.floor(scheduled.getTime() / tickMs) * tickMs);
  const nominal = new Date(tick.getTime());
  nominal.setUTCMinutes(minute, 0, 0);
  if (nominal.getTime() > tick.getTime()) nominal.setUTCHours(nominal.getUTCHours() - 1);
  if (entry?.slotHours && !entry.slotHours.includes(nominal.getUTCHours())) return null;

  const lateByMs = tick.getTime() - nominal.getTime();
  if (lateByMs < settleMinutes * 60_000 || lateByMs > maxLateMinutes * 60_000) return null;
  return nominal;
}

/** Requires a validated calendar entry and a nominal date validated by generationSlotKey. */
export function nextGenerationSlotDateForEntry(entry, nominalSlot) {
  const nextSlot = new Date(nominalSlot.getTime());
  const hour = nextSlot.getUTCHours();
  if (entry.slotHours === null) {
    nextSlot.setUTCHours(hour + 1);
  } else {
    const nextHour = entry.slotHours.find((slotHour) => slotHour > hour);
    nextSlot.setUTCHours(nextHour ?? entry.slotHours[0] + 24);
  }
  return nextSlot;
}

export function dueGenerationSlotEntries(scheduledAt) {
  return GENERATION_SLOT_ENTRIES.filter((entry) => generationSlotDateForEntry(entry, scheduledAt));
}
