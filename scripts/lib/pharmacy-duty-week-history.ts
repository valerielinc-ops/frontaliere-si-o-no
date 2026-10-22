import fs from 'node:fs';
import path from 'node:path';
import { isClosedDutyWeek, mergeDutyWeekHistory, observeDutyWeeks, resolveDutyWeekHistory, validateDutyWeekHistory, type DutyWeekHistory } from '../../services/pharmacies/dutyWeekHistory';
import type { PharmacyCatalogueDataset, PharmacyDutiesDataset } from '../../services/pharmacies/types';

function readWeek(file: string): DutyWeekHistory {
  const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!validateDutyWeekHistory(value)) throw new Error(`Invalid pharmacy duty history: ${file}`);
  return value;
}

export function readDutyWeekHistoryArchive(directory: string, recoveryFile: string, now = new Date()): DutyWeekHistory[] {
  const recovery = JSON.parse(fs.readFileSync(recoveryFile, 'utf8')) as { version: number; weeks: unknown[] };
  if (recovery.version !== 1 || !Array.isArray(recovery.weeks) || !recovery.weeks.every(validateDutyWeekHistory)) throw new Error('Invalid pharmacy duty recovery archive');
  const byWeek = new Map<string, DutyWeekHistory>();
  const add = (week: DutyWeekHistory) => {
    const observations = week.observations.filter((observation) =>
      Math.max(Date.parse(observation.fetchedAt), Date.parse(observation.catalogueFetchedAt)) <= now.getTime());
    if (observations.length === 0) return;
    byWeek.set(week.weekStart, mergeDutyWeekHistory(byWeek.get(week.weekStart), { ...week, observations }));
  };
  recovery.weeks.forEach(add);
  if (fs.existsSync(directory)) {
    for (const name of fs.readdirSync(directory).filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name)).sort()) {
      const week = readWeek(path.join(directory, name));
      if (`${week.weekStart}.json` !== name) throw new Error(`Mismatched pharmacy week file: ${name}`);
      add(week);
    }
  }
  return [...byWeek.values()].filter((week) => isClosedDutyWeek(week.weekStart, now)).flatMap((week) => {
    if (!resolveDutyWeekHistory(week, week.weekStart, now)) throw new Error(`Invalid pharmacy duty history: ${week.weekStart}`);
    return [week];
  }).sort((a, b) => a.weekStart.localeCompare(b.weekStart));
}

/** No retention window: dated URLs must survive replacement of the live feed. */
export function persistDutyWeekHistory(directory: string, catalogue: PharmacyCatalogueDataset, duties: PharmacyDutiesDataset, now = new Date()): number {
  const observations = observeDutyWeeks(catalogue, duties, now);
  let written = 0;
  for (const observation of observations) {
    const file = path.join(directory, `${observation.weekStart}.json`);
    const previous = fs.existsSync(file) ? readWeek(file) : undefined;
    const merged = mergeDutyWeekHistory(previous, observation);
    const json = `${JSON.stringify(merged)}\n`;
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === json) continue;
    fs.mkdirSync(directory, { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, json, 'utf8');
    fs.renameSync(temporary, file);
    written++;
  }
  return written;
}
