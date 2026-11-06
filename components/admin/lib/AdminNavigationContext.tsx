import { createContext, useContext } from 'react';

export interface AdminNavigationContextValue {
  section: string;
  searchParams: URLSearchParams;
  locationKey: string;
  navigateSection: (section: string) => void;
  replaceQuery: (updates: Record<string, string | null | undefined>) => void;
  canonicalUrl: () => string;
  copyCanonicalLink: () => Promise<boolean>;
}

export const AdminNavigationContext = createContext<AdminNavigationContextValue | null>(null);

export function useAdminNavigation(): AdminNavigationContextValue {
  const context = useContext(AdminNavigationContext);
  if (!context) throw new Error('useAdminNavigation deve essere usato dentro AdminApp.');
  return context;
}

