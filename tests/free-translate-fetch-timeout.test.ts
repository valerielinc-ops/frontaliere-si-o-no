import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

import { fetchWithRefTimeout } from '../scripts/lib/fetch-with-ref-timeout.mjs';

const SOURCE = readFileSync(
  fileURLToPath(new URL('../scripts/lib/free-translate.mjs', import.meta.url)),
  'utf8',
);

test('free-translate usa il wrapper che copre anche la lettura dei body', async () => {
  expect(SOURCE).toContain("import { fetchWithRefTimeout, releaseFetchWithRefTimeout } from './fetch-with-ref-timeout.mjs';");
  expect(SOURCE).not.toMatch(/\bfetch\(/u);

  let aborted = false;
  let canceled = false;
  const response = await fetchWithRefTimeout(
    'https://provider.example.test/translate',
    {},
    20,
    async (_url, { signal }) => {
      signal?.addEventListener('abort', () => { aborted = true; }, { once: true });
      return {
        body: { cancel: async () => { canceled = true; } },
        json: () => new Promise(() => {}),
      } as Response;
    },
  );

  await expect(response.json()).rejects.toMatchObject({ name: 'TimeoutError' });
  expect(aborted).toBe(true);
  expect(canceled).toBe(true);
});
