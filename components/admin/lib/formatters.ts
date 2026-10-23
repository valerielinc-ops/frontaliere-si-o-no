/** Shared admin-only formatters. Keep one implementation for all sections. */

export function relativeTime(iso: string | null, compact = false): string | null {
  if (!iso) return null;
  const diff = Date.now() - Date.parse(iso);
  if (diff < 0 || Number.isNaN(diff)) return null;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'adesso';
  if (minutes < 60) return `${minutes}${compact ? 'm' : ' min'} fa`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h fa`;
  const days = Math.floor(hours / 24);
  return days === 1 ? 'ieri' : `${days}gg fa`;
}

export function formatDuration(seconds: number | null): string {
  if (!Number.isFinite(Number(seconds)) || Number(seconds) < 0) return 'n/d';
  const totalSeconds = Math.round(Number(seconds));
  const minutes = Math.floor(totalSeconds / 60);
  const remainingSeconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${remainingSeconds}s` : `${remainingSeconds}s`;
}

