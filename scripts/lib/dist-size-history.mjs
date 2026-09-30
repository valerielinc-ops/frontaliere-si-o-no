import {
  appendFileSync,
  existsSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';

/** Keep this accumulator comfortably below GitHub's 100 MB blob limit. */
export const DIST_HISTORY_MAX_BYTES = 80 * 1024 * 1024;

function byteLength(value) {
  return Buffer.byteLength(value, 'utf8');
}

/** Append a row and retain the newest lines within the byte budget. */
export function boundedHistoryText(previousText, row, maxBytes = DIST_HISTORY_MAX_BYTES) {
  const lines = String(previousText || '')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => `${line}\n`);
  lines.push(`${JSON.stringify(row)}\n`);

  let bytes = lines.reduce((total, line) => total + byteLength(line), 0);
  let firstKept = 0;
  while (bytes > maxBytes && firstKept < lines.length - 1) {
    bytes -= byteLength(lines[firstKept]);
    firstKept += 1;
  }

  return {
    text: lines.slice(firstKept).join(''),
    dropped: firstKept,
    bytes,
  };
}

/** Append one deploy row, compacting atomically when the accumulator is over budget. */
export function appendDistHistoryRow(historyPath, row, maxBytes = DIST_HISTORY_MAX_BYTES) {
  const previousText = existsSync(historyPath) ? readFileSync(historyPath, 'utf8') : '';
  const next = boundedHistoryText(previousText, row, maxBytes);

  if (next.dropped === 0) {
    appendFileSync(historyPath, `${JSON.stringify(row)}\n`, 'utf8');
    return next;
  }

  const tempPath = `${historyPath}.${process.pid}.tmp`;
  try {
    writeFileSync(tempPath, next.text, 'utf8');
    renameSync(tempPath, historyPath);
  } catch (error) {
    try { unlinkSync(tempPath); } catch { /* best effort */ }
    throw error;
  }
  return next;
}
