import { useEffect, useState } from 'react';

export type AdminShellVariant = 'v1' | 'v2';

const ADMIN_SHELL_CONFIG_KEY = 'admin_shell_v2';

export function shouldHideSiteNavigation(activeTab: string, variant: AdminShellVariant | null): boolean {
  return activeTab === 'admin' && variant === 'v2';
}

export function adminShellVariantOverride(search: string): AdminShellVariant | null {
  const override = new URLSearchParams(search).get('shell');
  return override === 'v1' || override === 'v2' ? override : null;
}

function adminShellVariantFromConfig(value: string): AdminShellVariant {
  return value.trim().toLowerCase() === 'true' ? 'v2' : 'v1';
}

export async function resolveAdminShellVariant(search: string): Promise<AdminShellVariant> {
  const override = adminShellVariantOverride(search);
  if (override) return override;

  try {
    const { getConfigValue } = await import('@/services/firebase');
    return adminShellVariantFromConfig(await getConfigValue(ADMIN_SHELL_CONFIG_KEY));
  } catch {
    return 'v1';
  }
}

export function useAdminShellVariant(enabled = true): AdminShellVariant | null {
  const [variant, setVariant] = useState<AdminShellVariant | null>(() => {
    if (!enabled || typeof window === 'undefined') return null;
    return adminShellVariantOverride(window.location.search);
  });

  useEffect(() => {
    let cancelled = false;
    if (!enabled) {
      setVariant(null);
      return () => { cancelled = true; };
    }

    const search = window.location.search;
    const override = adminShellVariantOverride(search);
    if (override) {
      setVariant(override);
      return () => { cancelled = true; };
    }

    setVariant(null);
    void resolveAdminShellVariant(search).then((resolved) => {
      if (!cancelled) setVariant(resolved);
    });
    return () => { cancelled = true; };
  }, [enabled]);

  return enabled ? variant : null;
}
