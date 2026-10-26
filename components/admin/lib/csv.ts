export function escapeCsvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n\r]/u.test(text) ? `"${text.replace(/"/gu, '""')}"` : text;
}

function csvRowText(row: unknown): string {
  return (Array.isArray(row) ? row : []).map(escapeCsvCell).join(',');
}

export function csvText(headers: readonly unknown[], rows: readonly (readonly unknown[])[]): string {
  return [headers, ...rows].map(csvRowText).join('\r\n');
}

export function datedExportFilename(prefix: string, date = new Date()): string {
  const dateKey = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Zurich' }).format(date);
  return `${prefix}-${dateKey}.csv`;
}

export function downloadCsv(filename: string, headers: readonly unknown[], rows: readonly (readonly unknown[])[]): void {
  if (
    typeof document === 'undefined'
    || typeof Blob === 'undefined'
    || typeof URL === 'undefined'
    || typeof URL.createObjectURL !== 'function'
    || typeof URL.revokeObjectURL !== 'function'
  ) return;
  const blob = new Blob([`\uFEFF${csvText(headers, rows)}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}
