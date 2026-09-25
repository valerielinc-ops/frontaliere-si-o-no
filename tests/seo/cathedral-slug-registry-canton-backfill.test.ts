import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('slug-registry canton back-fill (P1-B)', () => {
  const reg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../data/slug-registry.json'), 'utf8'));
  it('every entry has a canton field', () => {
    const missing = Object.entries(reg).filter(([, v]) => !(v as { canton?: string }).canton);
    expect(missing.length, `Entries without canton: ${missing.slice(0,5).map(([k])=>k).join(',')}`).toBe(0);
  });
  it('canton field is a valid 2-letter code or APPENZELLO/BASILEA', () => {
    const valid = new Set(['TI','ZH','AG','GE','VD','BE','LU','VS','GR','SG','SO','SZ','SH','OW','NW','UR','TG','GL','FR','JU','NE','ZG','APPENZELLO','BASILEA','AI','AR','BL','BS']);
    const invalid = Object.entries(reg).filter(([, v]) => !valid.has((v as { canton: string }).canton));
    expect(invalid.length, `Invalid canton values: ${invalid.slice(0,5).map(([k,v])=>`${k}=${(v as { canton: string }).canton}`).join(',')}`).toBe(0);
  });
});
