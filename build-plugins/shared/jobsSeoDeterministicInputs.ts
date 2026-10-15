import fs from 'node:fs';
import { listSliceFileNames } from '../../scripts/lib/crawler-slice-files.mjs';

/**
 * Directory inputs used while enriching Jobs SEO pages. Both helpers return a
 * stable lexical order so a filesystem enumeration cannot decide which record
 * reaches a bounded map first.
 */
export function listJobsSeoExpiredSliceFiles(dir: string): string[] {
  return listSliceFileNames(dir);
}

export function listJobsSeoAdapterFiles(dir: string): string[] {
  try {
    return fs.readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .sort();
  } catch {
    return [];
  }
}
