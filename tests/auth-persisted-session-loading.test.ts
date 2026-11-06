import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '..');
const source = readFileSync(resolve(root, 'services/authService.ts'), 'utf8');

describe('Auth hydration loading gate', () => {
  it('keeps auth-dependent content blocked while a persisted session resolves', () => {
    const hook = source.slice(source.indexOf('export function useAuth()'));

    expect(hook).toMatch(
      /const \[loading, setLoading\] = useState\(\(\) => \{[\s\S]*?if \(hasPersistedAuthSession\(\)\) return true;/,
    );
  });
});
