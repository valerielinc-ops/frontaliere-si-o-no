import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  new URL('../components/pages/AssistedApplicationAdmin.tsx', import.meta.url),
  'utf8',
);

describe('assisted application queue auth bootstrap', () => {
  it('waits for restored Firebase auth before loading the admin queue', () => {
    expect(source).toContain('const { user, loading: authLoading } = useAuth();');
    expect(source).toMatch(/if \(authLoading\) return;\s+void loadOrders\(\);/);
    expect(source).toContain('}, [authLoading, user]);');
  });
});
