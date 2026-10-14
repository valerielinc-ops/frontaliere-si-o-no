import fs from 'node:fs';
import path from 'node:path';
import { BORDER_WAIT_ARCHIVE_CROSSINGS } from './borderWaitSections.mjs';

/** Keep only the five archive crossings and hourly means actually observed. */
export function compactBorderWaitArchiveDay(day) {
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day.date || '')
    || !Number.isFinite(Date.parse(day.date)) || new Date(day.date).toISOString().slice(0, 10) !== day.date) return null;
  const perCrossing = {};
  for (const crossing of BORDER_WAIT_ARCHIVE_CROSSINGS) {
    const series = day.perCrossing?.[crossing];
    if (!Array.isArray(series) || series.length !== 24) continue;
    perCrossing[crossing] = series.map((cell) => Number.isFinite(cell?.avg) && cell.avg >= 0 ? { avg: cell.avg } : null);
  }
  if (!Object.keys(perCrossing).length) return null;
  return { date: day.date, perCrossing };
}

function readDays(file) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (data.schema !== 1 || !Array.isArray(data.days)) throw new Error(`Invalid border-wait archive: ${file}`);
  const days = data.days.map(compactBorderWaitArchiveDay);
  if (days.some((day) => !day)) throw new Error(`Invalid day in border-wait archive: ${file}`);
  return days;
}

export function readBorderWaitArchive(directory, recoveryFile) {
  const days = recoveryFile && fs.existsSync(recoveryFile) ? readDays(recoveryFile) : [];
  if (fs.existsSync(directory)) {
    for (const file of fs.readdirSync(directory).filter((name) => /^\d{4}-(0[1-9]|1[0-2])\.json$/.test(name)).sort()) {
      days.push(...readDays(path.join(directory, file)));
    }
  }
  return [...new Map(days.map((day) => [day.date, day])).values()].sort((a, b) => a.date.localeCompare(b.date));
}

/** Persist closed months before the daily collector prunes its 90-day window. */
export function writeBorderWaitArchive(historyDir, directory, today) {
  fs.mkdirSync(directory, { recursive: true });
  const months = new Map();
  for (const file of fs.readdirSync(historyDir).filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name)).sort()) {
    const month = file.slice(0, 7);
    if (month >= today.slice(0, 7)) continue;
    const day = compactBorderWaitArchiveDay(JSON.parse(fs.readFileSync(path.join(historyDir, file), 'utf8')));
    if (!day) continue; // no eligible crossing facts; never invent an empty archive
    if (day.date !== file.slice(0, 10)) throw new Error(`Invalid border-wait history: ${file}`);
    const target = path.join(directory, `${month}.json`);
    if (!months.has(month)) months.set(month, new Map(fs.existsSync(target) ? readDays(target).map((old) => [old.date, old]) : []));
    months.get(month).set(day.date, day);
  }
  let written = 0;
  for (const [month, byDate] of months) {
    const file = path.join(directory, `${month}.json`);
    const days = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
    const json = `${JSON.stringify({ schema: 1, days })}\n`;
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === json) continue;
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, json, 'utf8');
    fs.renameSync(temporary, file);
    written++;
  }
  return written;
}
