import { FUEL_ZONES } from '../../build-plugins/shared/fuelRouteSlugs.mjs';
import { readMonthlyHistoryArchive, writeMonthlyHistoryArchive } from './monthly-history-archive.mjs';

/** Monthly pages need only observed daily zone prices, never station data. */
export function compactFuelArchiveDay(day) {
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day.date || '') || !Number.isFinite(Date.parse(day.date))
    || new Date(day.date).toISOString().slice(0, 10) !== day.date || !day.zones) return null;
  /** @type {Record<(typeof FUEL_ZONES)[number], {benzina: number|null, diesel: number|null}>} */
  const zones = {};
  const observed = (value) => Number.isFinite(value) && value > 0 ? value : null;
  for (const zone of FUEL_ZONES) {
    zones[zone] = {
      benzina: observed(day.zones[zone]?.benzina),
      diesel: day.diesel?.source === 'api' ? observed(day.zones[zone]?.diesel) : null,
    };
  }
  if (!Object.values(zones).some((zone) => zone.benzina !== null || zone.diesel !== null)) return null;
  /** @type {{source: 'api'|'unavailable'}} */
  const diesel = { source: day.diesel?.source === 'api' ? 'api' : 'unavailable' };
  return { date: day.date, diesel, zones };
}

export function readFuelArchive(directory, recoveryFile) {
  return readMonthlyHistoryArchive(directory, recoveryFile, compactFuelArchiveDay);
}

export function writeFuelArchive(historyDir, directory, today) {
  return writeMonthlyHistoryArchive(historyDir, directory, today, compactFuelArchiveDay);
}
