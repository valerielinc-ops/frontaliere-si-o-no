import fs from 'node:fs';
import path from 'node:path';
import { SECO_PAGE_CURSORS_PATH } from '../config.mjs';

const EMPTY = { version: 1, updatedAt: null, cantons: {} };

export function loadSecoPageCursors(file = SECO_PAGE_CURSORS_PATH) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return structuredClone(EMPTY);
    throw new Error(`Cannot read SECO page cursors at ${file}`, { cause: error });
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`Malformed SECO page cursors at ${file}`, { cause: error });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || !parsed.cantons || typeof parsed.cantons !== 'object' || Array.isArray(parsed.cantons)) {
    throw new Error(`Invalid SECO page cursor shape at ${file}`);
  }
  for (const [canton, cursor] of Object.entries(parsed.cantons)) {
    if (!/^[A-Z]{2}$/.test(canton)
      || !cursor || typeof cursor !== 'object' || Array.isArray(cursor)
      || !Number.isSafeInteger(cursor.nextPage) || cursor.nextPage < 0
      || !Number.isSafeInteger(cursor.onlineSinceDays) || cursor.onlineSinceDays < 1
      || typeof cursor.updatedAt !== 'string') {
      throw new Error(`Invalid SECO page cursor for ${canton} at ${file}`);
    }
  }
  return { ...EMPTY, ...parsed, cantons: { ...parsed.cantons } };
}

export function saveSecoPageCursors(state, file = SECO_PAGE_CURSORS_PATH) {
  state.updatedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`);
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
