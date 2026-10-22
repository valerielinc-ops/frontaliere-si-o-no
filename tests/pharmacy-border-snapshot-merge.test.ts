import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readPreviousTicinoSnapshots } from '../scripts/import-pharmacies-border.mjs';

describe('Ticino previous snapshot merge', () => {
  it('keeps legacy identities while disambiguating a slug already owned by the complete snapshot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pharmacy-ticino-slug-merge-'));
    try {
      const completePath = join(root, 'complete.json');
      const legacyPath = join(root, 'legacy.json');
      await writeFile(completePath, JSON.stringify({ pharmacies: [{ id: 'ti-complete', slug: 'benu-giubiasco-giubiasco' }] }));
      await writeFile(legacyPath, JSON.stringify({ pharmacies: [{ id: 'ti-duty', slug: 'benu-giubiasco-giubiasco' }] }));

      const merged = await readPreviousTicinoSnapshots({ completePath, legacyPath });

      expect(merged.pharmacies).toEqual([
        { id: 'ti-complete', slug: 'benu-giubiasco-giubiasco' },
        { id: 'ti-duty', slug: 'benu-giubiasco-giubiasco-2' },
      ]);
      expect(new Set(merged.pharmacies.map((pharmacy) => pharmacy.slug)).size).toBe(merged.pharmacies.length);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
