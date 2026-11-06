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
      await writeFile(legacyPath, JSON.stringify({ pharmacies: [{
        id: 'ti-duty',
        slug: 'benu-giubiasco-giubiasco',
        urlAliases: [
          { country: 'CH', city: 'Lugano', slug: 'benu-giubiasco-giubiasco' },
          { country: 'CH', city: 'Bellinzona', slug: 'benu-giubiasco-legacy' },
        ],
      }] }));

      const merged = await readPreviousTicinoSnapshots({ completePath, legacyPath });

      expect(merged.pharmacies).toEqual([
        { id: 'ti-complete', slug: 'benu-giubiasco-giubiasco' },
        {
          id: 'ti-duty',
          slug: 'benu-giubiasco-giubiasco-2',
          urlAliases: [{ country: 'CH', city: 'Bellinzona', slug: 'benu-giubiasco-legacy' }],
        },
      ]);
      expect(new Set(merged.pharmacies.map((pharmacy) => pharmacy.slug)).size).toBe(merged.pharmacies.length);
      expect(merged.pharmacies[1].urlAliases).not.toContainEqual({ country: 'CH', city: 'Lugano', slug: 'benu-giubiasco-giubiasco' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
