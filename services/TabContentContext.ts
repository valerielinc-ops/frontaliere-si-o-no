/**
 * TabContentContext — passes app-level state to lazy tab components.
 *
 * Navigation state (activeTab, subTabs, navigateTo) is already provided
 * by NavigationContext. This context carries the remaining app-specific
 * state that tab content components need without prop drilling.
 */
import React, { createContext, useContext } from 'react';
import type { SimulationInputs, SimulationResult } from '@/types';
import type { UserProfileData } from '@/components/pages/UserProfile';
import type { SeoLandingId, BlogArticleId, GlossaryTermId, BorderCrossingId } from '@/services/router';
import type { ContactPrefill } from '@/components/pages/ContactPage';
import type { ActiveTab } from '@/services/router';

export interface TabContentState {
 // Calculator
 inputs: SimulationInputs;
 setInputs: (inputs: SimulationInputs) => void;
 result: SimulationResult | null;
 handleCalculate: () => void;
 showDeferredHomeWidgets: boolean;
 seoLanding: SeoLandingId | null;
 setSeoLanding: (id: SeoLandingId | null) => void;

 // Auth/User
 userProfile: UserProfileData | null;
 authUser: any | null;
 authLoading: boolean;
 isPrivilegedAdmin: boolean;
 googleSignIn: () => Promise<any>;
 facebookSignIn: () => Promise<any>;
 adminGoogleButtonRef: React.RefObject<HTMLDivElement | null>;
 adminGoogleButtonReady: boolean;

 // Fisco
 taxReturnCountry: 'italia' | 'svizzera' | undefined;
 setTaxReturnCountry: (c: 'italia' | 'svizzera' | undefined) => void;

 // Guida
 borderCrossing: BorderCrossingId | null;
 setBorderCrossing: (id: BorderCrossingId | null) => void;

 // Blog
 blogArticle: BlogArticleId | null;
 setBlogArticle: (id: BlogArticleId | null) => void;

 // Job Board
 jobSlug: string | null;
 setJobSlug: (slug: string | null) => void;

 // Global navigation helpers
 setActiveTab: (tab: ActiveTab) => void;
 navigateTo: (tab: ActiveTab, subTab?: string) => void;
 setContactPrefill: (prefill: ContactPrefill | null) => void;
 glossaryTerm: GlossaryTermId | null;
 setGlossaryTerm: (term: GlossaryTermId | null) => void;
}

const TabContentContext = createContext<TabContentState | null>(null);

export function useTabContent(): TabContentState {
 const ctx = useContext(TabContentContext);
 if (!ctx) throw new Error('useTabContent must be used within TabContentProvider');
 return ctx;
}

export { TabContentContext };
