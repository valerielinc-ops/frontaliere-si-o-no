import { BORDER_WAIT_ARCHIVE_CROSSINGS } from './borderWaitSections.mjs';
import { readMonthlyHistoryArchive, writeMonthlyHistoryArchive } from './monthly-history-archive.mjs';

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

export function readBorderWaitArchive(directory, recoveryFile) {
  return readMonthlyHistoryArchive(directory, recoveryFile, compactBorderWaitArchiveDay);
}

export function writeBorderWaitArchive(historyDir, directory, today) {
  return writeMonthlyHistoryArchive(historyDir, directory, today, compactBorderWaitArchiveDay);
}
