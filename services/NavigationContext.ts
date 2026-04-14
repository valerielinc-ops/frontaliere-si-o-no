/**
 * NavigationContext — Centralised tab navigation state + actions.
 *
 * Provides:
 * - activeTab, calcolatoreSubTab, confrontiSubTab, etc.
 * - navigateTo(tab, subTab?) — one-call navigation with URL push
 * - isDarkMode, toggleTheme, isFocusMode, setIsFocusMode
 *
 * This eliminates prop-drilling for onNavigate / onTabChange callbacks.
 */
import { createContext, useContext } from 'react';
import type { ActiveTab, CalcolatoreSubTab, ConfrontiSubTab, FiscoSubTab, GuidaSubTab, VitaSubTab, StatsSubTab } from '@/services/router';

export interface NavigationState {
 activeTab: ActiveTab;
 calcolatoreSubTab: CalcolatoreSubTab;
 confrontiSubTab: ConfrontiSubTab;
 fiscoSubTab: FiscoSubTab;
 guidaSubTab: GuidaSubTab;
 vitaSubTab: VitaSubTab;
 statsSubTab: StatsSubTab;
 isDarkMode: boolean;
 isFocusMode: boolean;
}

export interface NavigationActions {
 setActiveTab: (tab: ActiveTab) => void;
 setCalcolatoreSubTab: (tab: CalcolatoreSubTab) => void;
 setConfrontiSubTab: (tab: ConfrontiSubTab) => void;
 setFiscoSubTab: (tab: FiscoSubTab) => void;
 setGuidaSubTab: (tab: GuidaSubTab) => void;
 setVitaSubTab: (tab: VitaSubTab) => void;
 setStatsSubTab: (tab: StatsSubTab) => void;
 toggleTheme: () => void;
 setIsFocusMode: (v: boolean) => void;
 /**
 * Navigate to a tab (and optional sub-tab) in one call.
 * Sets activeTab + matching sub-tab state + pushes the URL.
 * Use this instead of manually calling setActiveTab + set*SubTab + pushRoute.
 */
 navigateTo: (tab: ActiveTab, subTab?: string) => void;
}

export type NavigationContextType = NavigationState & NavigationActions;

const NavigationContext = createContext<NavigationContextType | null>(null);

/**
 * Hook to consume navigation state and actions.
 * Can be used from any component instead of prop-drilling.
 */
export function useNavigation(): NavigationContextType {
 const ctx = useContext(NavigationContext);
 if (!ctx) throw new Error('useNavigation must be used within NavigationProvider');
 return ctx;
}

/**
 * Optional hook — returns null if outside provider (for backward compat).
 */
export function useNavigationOptional(): NavigationContextType | null {
 return useContext(NavigationContext);
}

export { NavigationContext };
export default NavigationContext;
