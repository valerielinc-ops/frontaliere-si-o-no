/**
 * UserProfile — "Il tuo spazio" unified profile + dashboard
 * 
 * Features:
 * - Google Sign-In with cloud sync (Firestore)
 * - Job position autocomplete with common frontaliere roles
 * - Municipality autocomplete with geographic bias (CO/VA/VB/SO/LC)
 * - Family members management (add/edit/remove with relationships)
 * - Profile completeness progress bar
 * - Contextual gamification CTAs
 * - Quick action links to simulators
 * - Data privacy disclaimer
 */

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { reportCaughtError } from '@/services/errorReporter';
import {
  User, LogIn, LogOut, Camera, Briefcase, Users, Calendar,
  Shield, Save, CheckCircle2, MapPin, Heart, Baby, Loader2, Edit3, Sparkles,
  Plus, Trash2, Calculator, BookOpen, ArrowRightLeft, Award,
  AlertCircle, Building2, Navigation, Globe, Banknote,
  Clock, FileCheck,
} from 'lucide-react';
import { useTranslation, type Locale, setLocale as setGlobalLocale, getLocale, LOCALE_LABELS } from '@/services/i18n';
import { useAuth, getUserDisplayName, getUserPhotoURL, promptOneTap, renderGoogleButton, cancelOneTap, deleteCurrentUser, signInWithFacebook, reAuthFacebook, getLinkedProviders, getAuthEmail, consumeFacebookProfilePrefill, eagerAuth, isLinkedInSignInAvailable, signInWithLinkedIn } from '@/services/authService';
import { Analytics } from '@/services/analytics';
import { unlockAchievement } from '@/services/gamificationService';
import { borderCrossings } from '@/data/borderCrossings';
import { getMunicipalityNames, findMunicipality } from '@/data/municipalities';
import { calculateSimulation } from '@/services/calculationService';
import { useExchangeRate } from '@/services/exchangeRateService';
import { DEFAULT_INPUTS } from '@/constants';
import type { SimulationInputs } from '@/types';

// ─── Types ───────────────────────────────────────────────────

export interface FamilyMember {
  id: string;
  relationship: 'spouse' | 'child' | 'parent' | 'sibling' | 'other';
  birthYear?: string;
  liveTogether: boolean;
  dependent: boolean;
}

export interface UserProfileData {
  workPosition: string;
  age: string;
  gender: string;
  familySituation: string;
  frontaliereType: string;
  municipality: string;
  children: string;
  familyMembers: string;
  familyMembersList?: FamilyMember[];
  workplace: string;
  preferredDogana: string;
  preferredLanguage: string;
  grossSalary: string;
  permitExpiry: string;
}

const PROFILE_STORAGE_KEY = 'frontaliere_user_profile';

const DEFAULT_PROFILE: UserProfileData = {
  workPosition: '',
  age: '',
  gender: '',
  familySituation: '',
  frontaliereType: '',
  municipality: '',
  children: '0',
  familyMembers: '1',
  familyMembersList: [],
  workplace: '',
  preferredDogana: '',
  preferredLanguage: '',
  grossSalary: '',
  permitExpiry: '',
};

// ─── Common job positions for frontalieri ────────────────────

const COMMON_POSITIONS = [
  'Software Engineer', 'Project Manager', 'Business Analyst', 'Data Scientist',
  'DevOps Engineer', 'UX Designer', 'Product Manager', 'Consulente IT',
  'Ingegnere meccanico', 'Ingegnere elettronico', 'Ingegnere civile',
  'Tecnico di laboratorio', 'Ricercatore', 'Chimico', 'Biologo',
  'Farmacista', 'Infermiere/a', 'Medico', 'Fisioterapista',
  'Analista finanziario', 'Contabile', 'Revisore', 'Bancario',
  'Responsabile HR', 'Recruiter', 'Formatore',
  'Operaio specializzato', 'Elettricista', 'Idraulico', 'Muratore',
  'Cuoco/a', 'Cameriere/a', 'Receptionist', 'Barista',
  'Autista', 'Magazziniere', 'Logistico',
  'Commesso/a', 'Cassiere/a', 'Store Manager',
  'Architetto', 'Geometra', 'Avvocato', 'Notaio',
  'Insegnante', 'Professore', 'Educatore/trice',
  'Grafico', 'Fotografo', 'Marketing Manager', 'Social Media Manager',
  'Amministratore di sistema', 'DBA', 'QA Engineer', 'Scrum Master',
];

// ─── Common workplace cities for frontalieri ─────────────────

const COMMON_WORKPLACES = [
  'Lugano', 'Mendrisio', 'Chiasso', 'Bellinzona', 'Locarno',
  'Manno', 'Bioggio', 'Mezzovico', 'Stabio', 'Balerna',
  'Rivera', 'Taverne', 'Agno', 'Paradiso', 'Massagno',
  'Vezia', 'Lamone', 'Noranco', 'Grancia', 'Bedano',
  'Cadenazzo', 'Giubiasco', 'Arbedo', 'Monte Carasso',
  'Zurigo', 'Winterthur', 'Baden', 'Zugo', 'Coira',
];

// ─── Firestore persistence (lazy) ────────────────────────────

let firestoreDb: any = null;

const initFirestore = async () => {
  if (firestoreDb) return firestoreDb;
  try {
    const { getFirestore } = await import('firebase/firestore');
    const { app } = await import('@/services/firebase');
    firestoreDb = getFirestore(app);
    return firestoreDb;
  } catch {
    return null;
  }
};

const saveProfileToFirestore = async (email: string, data: UserProfileData) => {
  try {
    const db = await initFirestore();
    if (!db) return;
    const { doc, setDoc } = await import('firebase/firestore');
    const key = email.trim().toLowerCase();
    await setDoc(doc(db, 'newsletter_subscribers', key), {
      ...data,
      updatedAt: new Date().toISOString(),
    }, { merge: true });
  } catch (e) {
    console.warn('[Profile] Firestore save failed:', e);
    reportCaughtError(e, 'userProfile.saveToFirestore', { type: 'api_error' });
  }
};

const loadProfileFromFirestore = async (email: string): Promise<UserProfileData | null> => {
  try {
    const db = await initFirestore();
    if (!db) return null;
    const { doc, getDoc } = await import('firebase/firestore');
    const key = email.trim().toLowerCase();
    const snap = await getDoc(doc(db, 'newsletter_subscribers', key));
    if (snap.exists()) {
      const data = snap.data();
      return {
        workPosition: data.workPosition || '',
        age: data.age || '',
        gender: data.gender || '',
        familySituation: data.familySituation || '',
        frontaliereType: data.frontaliereType || '',
        municipality: data.municipality || '',
        children: data.children || '0',
        familyMembers: data.familyMembers || '1',
        familyMembersList: data.familyMembersList || [],
        workplace: data.workplace || '',
        preferredDogana: data.preferredDogana || '',
        preferredLanguage: data.preferredLanguage || '',
        grossSalary: data.grossSalary || '',
        permitExpiry: data.permitExpiry || '',
      };
    }
    return null;
  } catch {
    return null;
  }
};

// ─── Exported helpers (used by App.tsx for prefill) ────────────

export function loadUserProfile(): UserProfileData {
  try {
    const stored = localStorage.getItem(PROFILE_STORAGE_KEY);
    if (stored) return { ...DEFAULT_PROFILE, ...JSON.parse(stored) };
  } catch { /* ignore */ }
  return DEFAULT_PROFILE;
}

export function profileToSimInputs(profile: UserProfileData): Partial<SimulationInputs> {
  const partial: Partial<SimulationInputs> = {};
  if (profile.familySituation) {
    const map: Record<string, string> = { single: 'SINGLE', married: 'MARRIED', divorced: 'SINGLE', cohabiting: 'SINGLE' };
    partial.maritalStatus = (map[profile.familySituation] || 'SINGLE') as SimulationInputs['maritalStatus'];
  }
  if (profile.frontaliereType) {
    partial.frontierWorkerType = (profile.frontaliereType === 'permit-g' ? 'NEW' : 'OLD') as SimulationInputs['frontierWorkerType'];
  }
  if (profile.children) {
    const n = parseInt(profile.children, 10);
    if (!isNaN(n)) partial.children = n;
  }
  if (profile.familyMembers) {
    const n = parseInt(profile.familyMembers, 10);
    if (!isNaN(n)) partial.familyMembers = n;
  }
  if (profile.age) {
    const midpoints: Record<string, number> = { '18-25': 22, '26-35': 30, '36-45': 40, '46-55': 50, '56-65': 60, '65+': 67 };
    if (midpoints[profile.age]) partial.age = midpoints[profile.age];
  }
  if (profile.municipality) {
    const muni = findMunicipality(profile.municipality);
    if (muni) {
      partial.distanceZone = (muni.distanceKm <= 20 ? 'WITHIN_20KM' : 'BEYOND_20KM') as SimulationInputs['distanceZone'];
    }
  }
  if (profile.grossSalary) {
    const salary = parseFloat(profile.grossSalary);
    if (!isNaN(salary) && salary > 0) {
      partial.annualIncomeCHF = salary;
    }
  }
  return partial;
}

// ─── ProfileLoginCTA (reusable CTA for other sections) ────────

export const ProfileLoginCTA: React.FC<{
  onLogin: () => void;
  onDismiss?: () => void;
  t: (key: string) => string;
}> = ({ onLogin, onDismiss, t }) => {
  const [dismissed, setDismissed] = React.useState(false);
  if (dismissed) return null;
  return (
    <div className="flex items-center gap-3 p-3 bg-gradient-to-r from-indigo-50 to-purple-50 dark:from-indigo-950/40 dark:to-purple-950/40 rounded-xl border border-indigo-200 dark:border-indigo-800">
      <Sparkles size={18} className="text-indigo-500 flex-shrink-0" />
      <p className="text-xs text-slate-700 dark:text-slate-300 flex-1">{t('profile.cta.title')}</p>
      <button
        onClick={onLogin}
        className="px-3 py-1 text-xs font-bold text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg transition-colors"
      >
        {t('profile.cta.login')}
      </button>
      {onDismiss && (
        <button
          onClick={() => { setDismissed(true); onDismiss(); }}
          className="text-xs text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300"
          aria-label={t('profile.cta.dismiss')}
        >
          ✕
        </button>
      )}
    </div>
  );
};

// ─── Autocomplete component ─────────────────────────────────

const Autocomplete: React.FC<{
  id: string;
  value: string;
  onChange: (v: string) => void;
  suggestions: string[];
  disabled?: boolean;
  placeholder?: string;
  className?: string;
  autoComplete?: string;
}> = ({ id, value, onChange, suggestions, disabled, placeholder, className, autoComplete }) => {
  const [open, setOpen] = useState(false);
  const [filtered, setFiltered] = useState<string[]>([]);
  const [highlightIdx, setHighlightIdx] = useState(-1);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    if (!value.trim()) { setFiltered([]); return; }
    const q = value.toLowerCase();
    setFiltered(suggestions.filter(s => s.toLowerCase().includes(q)).slice(0, 8));
    setHighlightIdx(-1);
  }, [value, suggestions]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!open || !filtered.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setHighlightIdx(i => Math.min(i + 1, filtered.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHighlightIdx(i => Math.max(i - 1, 0)); }
    else if (e.key === 'Enter' && highlightIdx >= 0) { e.preventDefault(); onChange(filtered[highlightIdx]); setOpen(false); }
    else if (e.key === 'Escape') setOpen(false);
  };

  useEffect(() => {
    if (listRef.current && highlightIdx >= 0) {
      const item = listRef.current.children[highlightIdx] as HTMLElement;
      item?.scrollIntoView({ block: 'nearest' });
    }
  }, [highlightIdx]);

  return (
    <div ref={wrapperRef} className="relative">
      <input
        id={id}
        type="text"
        value={value}
        onChange={(e) => { onChange(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={handleKeyDown}
        disabled={disabled}
        placeholder={placeholder}
        autoComplete={autoComplete}
        className={className}
        role="combobox"
        aria-expanded={open && filtered.length > 0}
        aria-autocomplete="list"
        aria-controls={`${id}-listbox`}
        aria-activedescendant={highlightIdx >= 0 ? `${id}-opt-${highlightIdx}` : undefined}
      />
      {open && filtered.length > 0 && !disabled && (
        <ul
          ref={listRef}
          id={`${id}-listbox`}
          role="listbox"
          className="absolute z-50 w-full mt-1 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl shadow-lg max-h-48 overflow-y-auto"
        >
          {filtered.map((item, i) => (
            <li
              key={item}
              id={`${id}-opt-${i}`}
              role="option"
              aria-selected={i === highlightIdx}
              className={`px-4 py-2 text-sm cursor-pointer transition-colors ${i === highlightIdx ? 'bg-indigo-50 dark:bg-indigo-900/40 text-indigo-700 dark:text-indigo-300' : 'text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700'}`}
              onMouseDown={() => { onChange(item); setOpen(false); }}
            >
              {item}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

// ─── Family member row ──────────────────────────────────────

const FamilyMemberRow: React.FC<{
  member: FamilyMember;
  onUpdate: (m: FamilyMember) => void;
  onRemove: () => void;
  disabled: boolean;
  t: (key: string) => string;
}> = ({ member, onUpdate, onRemove, disabled, t }) => {
  const currentYear = new Date().getFullYear();
  return (
    <div className="flex flex-col sm:flex-row gap-2 p-3 bg-slate-50 dark:bg-slate-900/40 rounded-xl border border-slate-100 dark:border-slate-800">
      <div className="flex-1 grid grid-cols-2 gap-2">
        <div>
          <label htmlFor={`rel-${member.id}`} className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase">{t('profile.family.relationship')}</label>
          <select
            id={`rel-${member.id}`}
            value={member.relationship}
            onChange={(e) => onUpdate({ ...member, relationship: e.target.value as FamilyMember['relationship'] })}
            disabled={disabled}
            className="w-full px-3 py-1.5 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500"
          >
            <option value="spouse">{t('profile.family.spouse')}</option>
            <option value="child">{t('profile.family.child')}</option>
            <option value="parent">{t('profile.family.parent')}</option>
            <option value="sibling">{t('profile.family.sibling')}</option>
            <option value="other">{t('profile.family.other')}</option>
          </select>
        </div>
        <div>
          <label htmlFor={`year-${member.id}`} className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase">{t('profile.family.birthYear')}</label>
          <input
            id={`year-${member.id}`}
            type="number"
            min={1920}
            max={currentYear}
            value={member.birthYear || ''}
            onChange={(e) => onUpdate({ ...member, birthYear: e.target.value })}
            disabled={disabled}
            placeholder={t('profile.family.optional')}
            className="w-full px-3 py-1.5 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
        </div>
      </div>
      <div className="flex items-center gap-3 sm:gap-2">
        <label className="flex items-center gap-1 text-xs font-medium text-slate-600 dark:text-slate-400 cursor-pointer">
          <input
            type="checkbox"
            checked={member.dependent}
            onChange={(e) => onUpdate({ ...member, dependent: e.target.checked })}
            disabled={disabled}
            className="rounded border-slate-300 dark:border-slate-600 text-indigo-600 focus:ring-indigo-500"
          />
          {t('profile.family.dependent')}
        </label>
        <label className="flex items-center gap-1 text-xs font-medium text-slate-600 dark:text-slate-400 cursor-pointer">
          <input
            type="checkbox"
            checked={member.liveTogether}
            onChange={(e) => onUpdate({ ...member, liveTogether: e.target.checked })}
            disabled={disabled}
            className="rounded border-slate-300 dark:border-slate-600 text-indigo-600 focus:ring-indigo-500"
          />
          {t('profile.family.liveTogether')}
        </label>
        {!disabled && (
          <button
            onClick={onRemove}
            className="p-1 text-red-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/30 rounded-lg transition-colors"
            aria-label={t('profile.family.remove')}
          >
            <Trash2 size={14} />
          </button>
        )}
      </div>
    </div>
  );
};

// ─── Component ───────────────────────────────────────────────

const UserProfile: React.FC = () => {
  const { t, locale } = useTranslation();
  const { user, loading: authLoading, signIn, signInFacebook, logout } = useAuth();
  // Profile page needs auth immediately — skip the interaction-deferred loading
  useEffect(() => { eagerAuth(); }, []);
  const [profile, setProfile] = useState<UserProfileData>(DEFAULT_PROFILE);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [showFamily, setShowFamily] = useState(false);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);
  const googleButtonRef = useRef<HTMLDivElement>(null);
  const [gisButtonRendered, setGisButtonRendered] = useState(false);
  const [linkedInAvailable, setLinkedInAvailable] = useState(false);

  const municipalityNames = useMemo(() => getMunicipalityNames(), []);

  // Profile completeness calculation
  const completeness = useMemo(() => {
    const fields = ['workPosition', 'age', 'gender', 'familySituation', 'frontaliereType', 'municipality'] as const;
    const filled = fields.filter(f => !!profile[f]).length;
    return Math.round((filled / fields.length) * 100);
  }, [profile]);

  // Municipality info
  const selectedMuni = useMemo(() => {
    if (!profile.municipality) return null;
    return findMunicipality(profile.municipality);
  }, [profile.municipality]);

  // Exchange rate for sidebar widget
  const { rate: fxRate } = useExchangeRate();

  // Quick simulation for sidebar widget (net salary estimate)
  const quickSimResult = useMemo(() => {
    const salary = parseFloat(profile.grossSalary);
    if (!salary || salary <= 0) return null;
    try {
      const profilePartial = profileToSimInputs(profile);
      const simInputs: SimulationInputs = {
        ...DEFAULT_INPUTS,
        ...profilePartial,
        annualIncomeCHF: salary,
        customExchangeRate: fxRate,
      };
      return calculateSimulation(simInputs);
    } catch {
      return null;
    }
  }, [profile, fxRate]);

  // Preferred dogana info
  const preferredCrossing = useMemo(() => {
    if (!profile.preferredDogana) return null;
    return borderCrossings.find(c => c.name === profile.preferredDogana) || null;
  }, [profile.preferredDogana]);
  // Load profile from localStorage (immediate) + Firestore (async)
  useEffect(() => {
    const stored = localStorage.getItem(PROFILE_STORAGE_KEY);
    if (stored) {
      try {
        const parsed = { ...DEFAULT_PROFILE, ...JSON.parse(stored) };
        setProfile(parsed);
        // Apply saved language preference from local profile
        if (parsed.preferredLanguage && ['it', 'en', 'de', 'fr'].includes(parsed.preferredLanguage)) {
          setGlobalLocale(parsed.preferredLanguage as Locale);
        }
      } catch { /* ignore corrupt data */ }
    }
  }, []);

  // When user signs in, try loading from Firestore (cloud sync)
  useEffect(() => {
    const email = user ? getAuthEmail(user) : null;
    if (!email) return;
    loadProfileFromFirestore(email).then((cloudProfile) => {
      if (cloudProfile) {
        setProfile(prev => {
          const merged: UserProfileData = { ...prev };
          // Merge string fields: cloud wins if local is empty
          const stringFields = ['workPosition', 'age', 'gender', 'familySituation', 'frontaliereType', 'municipality', 'children', 'familyMembers', 'workplace', 'preferredDogana', 'preferredLanguage', 'grossSalary', 'permitExpiry'] as const;
          stringFields.forEach(k => {
            if (cloudProfile[k] && !prev[k]) merged[k] = cloudProfile[k];
          });
          // Merge family members list
          if (cloudProfile.familyMembersList?.length && !prev.familyMembersList?.length) {
            merged.familyMembersList = cloudProfile.familyMembersList;
          }
          localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(merged));
          // Apply saved language preference
          if (merged.preferredLanguage && ['it', 'en', 'de', 'fr'].includes(merged.preferredLanguage)) {
            setGlobalLocale(merged.preferredLanguage as Locale);
          }
          return merged;
        });
      }
    });

    // Newsletter auto-subscribe is now handled in App.tsx (runs on any login, not just profile tab)
  }, [user?.uid]);

  // Merge Facebook Graph API profile data (age from birthday) into profile
  useEffect(() => {
    const fbData = consumeFacebookProfilePrefill();
    if (!fbData) return;

    setProfile(prev => {
      const merged = { ...prev };
      let changed = false;

      // Age bracket: only if user hasn't set it yet
      if (fbData.age && !prev.age) {
        merged.age = fbData.age;
        changed = true;
      }

      if (changed) {
        localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(merged));
      }
      return merged;
    });
  }, [user?.uid]);

  // Google One Tap: prompt when user is not signed in
  useEffect(() => {
    if (user || authLoading) return;
    
    // Show One Tap prompt after a brief delay
    const oneTapTimer = setTimeout(() => {
      promptOneTap();
    }, 1500);
    
    // Render the Google button in the container (wait for ref to be available)
    const buttonTimer = setTimeout(() => {
      if (googleButtonRef.current) {
        const rendered = renderGoogleButton(googleButtonRef.current, {
          theme: 'outline',
          size: 'large',
          text: 'signin_with',
        });
        // Check if GIS button was rendered (has child elements)
        setTimeout(() => {
          if (googleButtonRef.current && googleButtonRef.current.children.length > 0) {
            setGisButtonRendered(true);
          }
        }, 500);
      }
    }, 100);
    
    return () => {
      clearTimeout(oneTapTimer);
      clearTimeout(buttonTimer);
      cancelOneTap();
    };
  }, [user, authLoading]);

  useEffect(() => {
    isLinkedInSignInAvailable().then(setLinkedInAvailable).catch(() => {});
  }, []);

  const handleGoogleSignIn = async () => {
    Analytics.trackUIInteraction('profile', 'auth', 'google_signin', 'click');
    const result = await signIn();
    if (result) {
      unlockAchievement('social_login');
      Analytics.trackUIInteraction('profile', 'auth', 'google_signin', 'success');
    }
  };

  const handleFacebookSignIn = async () => {
    Analytics.trackUIInteraction('profile', 'auth', 'facebook_signin', 'click');
    const result = await signInFacebook();
    if (result) {
      unlockAchievement('social_login');
      Analytics.trackUIInteraction('profile', 'auth', 'facebook_signin', 'success');
    }
  };

  const handleLogout = async () => {
    await logout();
    Analytics.trackUIInteraction('profile', 'auth', 'logout', 'click');
  };

  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [privacyOpen, setPrivacyOpen] = useState(false);
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);

  useEffect(() => {
    try {
      const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
      setPrefersReducedMotion(mq.matches);
      const handler = (e: MediaQueryListEvent) => setPrefersReducedMotion(e.matches);
      if (mq.addEventListener) mq.addEventListener('change', handler);
      else mq.addListener(handler as any);
      return () => {
        if (mq.removeEventListener) mq.removeEventListener('change', handler);
        else mq.removeListener(handler as any);
      };
    } catch {
      setPrefersReducedMotion(false);
    }
  }, []);

  const handleDeleteAccount = async () => {
    if (!user?.uid) return;
    setDeleting(true);
    try {
      // 1. Delete Firestore profile
      const db = await (async () => {
        try {
          const { getFirestore } = await import('firebase/firestore');
          const { app } = await import('@/services/firebase');
          return getFirestore(app);
        } catch { return null; }
      })();
      if (db) {
        const { doc, deleteDoc, collection, getDocs, query, where } = await import('firebase/firestore');
        // user_profiles no longer used — data is in newsletter_subscribers (deleted below)
        // Delete newsletter subscription by deterministic docId + legacy duplicates.
        const delEmail = getAuthEmail(user);
        if (delEmail) {
          const normalizedEmail = delEmail.trim().toLowerCase();
          await deleteDoc(doc(db, 'newsletter_subscribers', normalizedEmail)).catch(() => {});

          const legacyQueries = [
            query(collection(db, 'newsletter_subscribers'), where('email', '==', normalizedEmail)),
            query(collection(db, 'newsletter_subscribers'), where('email', '==', delEmail)),
          ];
          for (const newsletterQuery of legacyQueries) {
            const snap = await getDocs(newsletterQuery).catch(() => null);
            if (!snap) continue;
            for (const d of snap.docs) {
              await deleteDoc(d.ref).catch(() => {});
            }
          }
        }
        // Delete feedback entries
        const feedbackQuery = query(collection(db, 'feedback'), where('userId', '==', user.uid));
        const feedbackSnap = await getDocs(feedbackQuery).catch(() => null);
        if (feedbackSnap) {
          for (const d of feedbackSnap.docs) {
            await deleteDoc(d.ref).catch(() => {});
          }
        }
      }
      // 2. Terminate Firestore to close listeners before auth sign-out
      const { terminate } = await import('firebase/firestore');
      await terminate(db).catch(() => {});
      // 3. Clear localStorage
      localStorage.removeItem('frontaliere_user_profile');
      localStorage.removeItem('frontaliere_achievements');
      // 4. Delete Firebase Auth account
      const deleted = await deleteCurrentUser();
      if (deleted) {
        setShowDeleteConfirm(false);
        // Reset profile to default
        setProfile(DEFAULT_PROFILE);
        Analytics.trackUIInteraction('profile', 'account', 'delete', 'success');
      }
    } catch (e) {
      console.warn('[Profile] Account deletion error:', e);
      reportCaughtError(e, 'userProfile.deleteAccount');
    } finally {
      setDeleting(false);
    }
  };

  const handleExportData = () => {
    const exportData: Record<string, unknown> = {
      exportDate: new Date().toISOString(),
      source: 'Frontaliere Ticino',
      profile: profile,
      achievements: (() => { try { return JSON.parse(localStorage.getItem('frontaliere_achievements') || '{}'); } catch { return {}; } })(),
      preferences: {
        theme: localStorage.getItem('theme') || 'light',
        locale: getLocale(),
      },
    };
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `frontaliere-dati-personali-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    Analytics.trackUIInteraction('profile', 'gdpr', 'export_data', 'click');
  };

  // Auto-save debounce ref
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const autoSave = useCallback((updatedProfile: UserProfileData) => {
    localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(updatedProfile));
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(async () => {
      setSaveStatus('saving');
      const email = user ? getAuthEmail(user) : null;
      if (email) {
        await saveProfileToFirestore(email, updatedProfile);
      }
      setSaveStatus('saved');
      const fields = ['workPosition', 'age', 'familySituation', 'frontaliereType', 'municipality', 'grossSalary'] as const;
      const filled = fields.filter(f => !!updatedProfile[f]).length;
      if (filled === fields.length) unlockAchievement('profile_complete');
      setTimeout(() => setSaveStatus('idle'), 2000);
    }, 800);
  }, [user?.uid]);

  const updateField = (field: keyof UserProfileData, value: string) => {
    setProfile(prev => {
      const updated = { ...prev, [field]: value };
      autoSave(updated);
      return updated;
    });
  };

  // Family members management
  // Helper to sync counters from family members list
  const syncFamilyCounters = (members: FamilyMember[]): Partial<UserProfileData> => {
    const childCount = members.filter(m => m.relationship === 'child').length;
    return {
      children: String(childCount),
      familyMembers: String(members.length + 1), // +1 for self
    };
  };

  const addFamilyMember = () => {
    const newMember: FamilyMember = {
      id: Date.now().toString(36),
      relationship: 'child',
      liveTogether: true,
      dependent: true,
    };
    setProfile(prev => {
      const newList = [...(prev.familyMembersList || []), newMember];
      const updated = { ...prev, familyMembersList: newList, ...syncFamilyCounters(newList) };
      autoSave(updated);
      return updated;
    });
  };

  const updateFamilyMember = (updatedMember: FamilyMember) => {
    setProfile(prev => {
      const newList = (prev.familyMembersList || []).map(m => m.id === updatedMember.id ? updatedMember : m);
      const updated = { ...prev, familyMembersList: newList, ...syncFamilyCounters(newList) };
      autoSave(updated);
      return updated;
    });
  };

  const removeFamilyMember = (id: string) => {
    setProfile(prev => {
      const newList = (prev.familyMembersList || []).filter(m => m.id !== id);
      const updated = { ...prev, familyMembersList: newList, ...syncFamilyCounters(newList) };
      autoSave(updated);
      return updated;
    });
  };

  // ─── Sign-in screen ─────────────────────────────────────────

  if (!user && !authLoading) {
    return (
      <div className="max-w-lg mx-auto animate-fade-in">
        <div className="bg-white dark:bg-slate-800 rounded-3xl shadow-xl border border-slate-200 dark:border-slate-700 overflow-hidden">
          {/* Header */}
          <div className="bg-gradient-to-br from-blue-600 via-indigo-600 to-purple-600 p-4 sm:p-8 text-center text-white">
            <div className="w-20 h-20 mx-auto bg-white/20 rounded-full flex items-center justify-center mb-4 backdrop-blur-sm">
              <User size={40} className="text-white/90" />
            </div>
            <h1 className="text-2xl font-extrabold">{t('profile.title')}</h1>
            <p className="text-blue-100 text-sm mt-2">{t('profile.subtitle')}</p>
          </div>

          {/* Sign-in card */}
          <div className="p-4 sm:p-8 space-y-6">
            <div className="text-center space-y-3">
              <p className="text-slate-600 dark:text-slate-400 text-sm leading-relaxed">
                {t('profile.signInDescription')}
              </p>
            </div>

            {/* Benefits list */}
            <div className="space-y-2">
              {['personalizedSim', 'cloudSync', 'contextual'].map(key => (
                <div key={key} className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-400">
                  <CheckCircle2 size={14} className="text-emerald-500 flex-shrink-0" />
                  {t(`profile.benefit.${key}`)}
                </div>
              ))}
            </div>

            {/* Google Sign-In Button Container (rendered by Google Identity Services) */}
            <div ref={googleButtonRef} className="flex justify-center" />

            {/* Fallback button if GIS doesn't load */}
            {!gisButtonRendered && (
              <button
                onClick={handleGoogleSignIn}
                className="w-full flex items-center justify-center gap-3 px-6 py-3.5 bg-white dark:bg-slate-700 border-2 border-slate-200 dark:border-slate-600 rounded-2xl hover:border-blue-300 dark:hover:border-blue-600 hover:shadow-lg transition-[border-color,box-shadow] group"
              >
                <svg viewBox="0 0 24 24" className="w-5 h-5" aria-hidden="true">
                  <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4" />
                  <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
                  <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
                  <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
                </svg>
                <span className="font-semibold text-slate-700 dark:text-slate-200 group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors">
                  {t('profile.signInWithGoogle')}
                </span>
              </button>
            )}

            {/* LinkedIn Sign-In Button (conditional on Remote Config) */}
            {linkedInAvailable && (
              <button
                type="button"
                onClick={() => signInWithLinkedIn()}
                className="w-full flex items-center justify-center gap-3 px-6 py-3.5 bg-[#0A66C2] hover:bg-[#004182] border-2 border-[#0A66C2] hover:border-[#004182] rounded-2xl hover:shadow-lg transition-[color,background-color,border-color,box-shadow] text-white font-semibold"
              >
                <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 0 1-2.063-2.065 2.064 2.064 0 1 1 2.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></svg>
                <span>{locale === 'it' ? 'Continua con LinkedIn' : locale === 'de' ? 'Mit LinkedIn fortfahren' : locale === 'fr' ? 'Continuer avec LinkedIn' : 'Continue with LinkedIn'}</span>
              </button>
            )}

            {/* Facebook Sign-In Button — hidden until Facebook app approval
            <button
              onClick={handleFacebookSignIn}
              className="w-full flex items-center justify-center gap-3 px-6 py-3.5 bg-[#1877F2] border-2 border-[#1877F2] rounded-2xl hover:bg-[#166FE5] hover:shadow-lg transition-[color,background-color,box-shadow] group"
            >
              <svg viewBox="0 0 24 24" className="w-5 h-5" fill="white" aria-hidden="true">
                <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z" />
              </svg>
              <span className="font-semibold text-white">
                {t('profile.signInWithFacebook')}
              </span>
            </button>
            */}

            <div className="flex items-center gap-2 justify-center text-xs text-slate-500 dark:text-slate-400">
              <Shield size={12} />
              <span>{t('profile.privacyNote')}</span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ─── Loading ─────────────────────────────────────────────────

  if (authLoading) {
    return (
      <div className="flex items-center justify-center py-24">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-indigo-500 border-t-transparent" />
      </div>
    );
  }

  // ─── Signed-in: "Il tuo spazio" ────────────────────────────

  const photoURL = getUserPhotoURL(user, user?.uid);
  const displayName = getUserDisplayName(user);

  return (
    <div className="max-w-2xl mx-auto space-y-6 animate-fade-in">
      {/* Profile header card */}
      <div className="bg-white dark:bg-slate-800 rounded-3xl shadow-xl border border-slate-200 dark:border-slate-700 overflow-hidden">
        <div className="bg-gradient-to-br from-blue-600 via-indigo-600 to-purple-600 p-4 sm:p-6 text-white">
          <div className="flex items-center gap-5">
            <div className="relative">
              {photoURL ? (
                <img
                  src={photoURL}
                  alt={displayName}
                  width={72}
                  height={72}
                  className="w-[72px] h-[72px] rounded-full ring-3 ring-white/40 object-cover"
                  referrerPolicy="no-referrer"
                />
              ) : (
                <div className="w-[72px] h-[72px] rounded-full bg-white/20 flex items-center justify-center ring-3 ring-white/40">
                  <Camera size={28} className="text-white/70" />
                </div>
              )}
            </div>
            <div className="flex-1 min-w-0">
              <h2 className="text-xl font-bold truncate">{displayName}</h2>
              {getAuthEmail(user) ? (
                <p className="text-blue-100 text-sm truncate">{getAuthEmail(user)}</p>
              ) : getLinkedProviders(user).includes('facebook.com') ? (
                <button
                  onClick={async () => { await reAuthFacebook(); }}
                  className="flex items-center gap-1.5 text-yellow-200 text-xs hover:text-yellow-100 transition-colors mt-0.5"
                  title={t('profile.facebookReauth') || 'Riprova per ottenere l\'email'}
                >
                  <AlertCircle size={12} />
                  <span>{t('profile.emailNotShared') || 'Email non condivisa — riprova'}</span>
                </button>
              ) : null}
            </div>
            <button
              onClick={handleLogout}
              className="p-2.5 bg-white/15 hover:bg-white/25 rounded-xl transition-colors flex-shrink-0"
              aria-label={t('profile.logout')}
              title={t('profile.logout')}
            >
              <LogOut size={18} />
            </button>
          </div>

          {/* Profile completeness bar */}
          <div className="mt-4">
            <div className="flex items-center justify-between text-xs mb-1.5">
              <span className="text-blue-100 font-medium">{t('profile.completeness')}</span>
              <span className="font-bold">{completeness}%</span>
            </div>
            <div className="w-full bg-white/20 rounded-full h-2">
              <div
                className="bg-white rounded-full h-2 transition-[width] duration-500"
                style={{ width: `${completeness}%` }}
              />
            </div>
            {completeness < 100 && (
              <p className="text-blue-200 text-xs mt-1">{t('profile.completeForBetter')}</p>
            )}
          </div>
        </div>

        {/* Quick actions strip */}
        <div className="px-6 py-3 bg-slate-50 dark:bg-slate-900/50 border-b border-slate-100 dark:border-slate-800">
          <div className="flex items-center gap-2 overflow-x-auto">
            <span className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase whitespace-nowrap">{t('profile.quickActions')}</span>
            {[
              { icon: Calculator, label: t('profile.action.simulate'), tab: 'calculator' },
              { icon: Sparkles, label: t('profile.action.whatif'), tab: 'calculator', subTab: 'whatif' },
              { icon: ArrowRightLeft, label: t('profile.action.exchange'), tab: 'confronti', subTab: 'exchange' },
              { icon: BookOpen, label: t('profile.action.guide'), tab: 'guida' },
            ].map(a => (
              <button
                key={a.label}
                onClick={() => {
                  window.dispatchEvent(new CustomEvent('navigate-tab', { detail: { tab: a.tab, ...(a.subTab ? { subTab: a.subTab } : {}) } }));
                }}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-xs font-medium text-slate-600 dark:text-slate-400 hover:border-indigo-300 dark:hover:border-indigo-600 hover:text-indigo-600 dark:hover:text-indigo-400 transition-[color,border-color] whitespace-nowrap"
              >
                <a.icon size={13} />
                {a.label}
              </button>
            ))}
          </div>
        </div>

        {/* ─── Sidebar Widget: key metrics ─── */}
        {(quickSimResult || fxRate) && (
          <div className="px-6 py-4 bg-gradient-to-r from-indigo-50/50 to-purple-50/50 dark:from-indigo-950/20 dark:to-purple-950/20 border-b border-slate-100 dark:border-slate-800">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {/* Net salary (CH) */}
              {quickSimResult && (
                <button
                  onClick={() => window.dispatchEvent(new CustomEvent('navigate-tab', { detail: { tab: 'calculator' } }))}
                  aria-label={t('profile.widget.netSalary')}
                  className="flex flex-col items-center gap-1 p-3 bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 hover:border-indigo-300 dark:hover:border-indigo-600 transition-[border-color] cursor-pointer"
                >
                  <span className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase">{t('profile.widget.netCH')}</span>
                  <span className="text-lg font-bold text-emerald-700 dark:text-emerald-400 tabular-nums">
                    {Math.round(quickSimResult.chResident.netIncomeMonthly).toLocaleString('de-CH')}
                  </span>
                  <span className="text-xs text-slate-500 dark:text-slate-400">CHF/{t('profile.widget.month')}</span>
                </button>
              )}
              {/* Net salary (IT) */}
              {quickSimResult && (
                <button
                  onClick={() => window.dispatchEvent(new CustomEvent('navigate-tab', { detail: { tab: 'calculator' } }))}
                  aria-label={t('profile.widget.netSalary')}
                  className="flex flex-col items-center gap-1 p-3 bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 hover:border-indigo-300 dark:hover:border-indigo-600 transition-[border-color] cursor-pointer"
                >
                  <span className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase">{t('profile.widget.netIT')}</span>
                  <span className="text-lg font-bold text-blue-600 dark:text-blue-400 tabular-nums">
                    {Math.round(quickSimResult.itResident.netIncomeMonthly).toLocaleString('de-CH')}
                  </span>
                  <span className="text-xs text-slate-500 dark:text-slate-400">EUR/{t('profile.widget.month')}</span>
                </button>
              )}
              {/* EUR/CHF rate */}
              <button
                onClick={() => window.dispatchEvent(new CustomEvent('navigate-tab', { detail: { tab: 'confronti', subTab: 'exchange' } }))}
                aria-label={t('profile.widget.fxRate')}
                className="flex flex-col items-center gap-1 p-3 bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 hover:border-indigo-300 dark:hover:border-indigo-600 transition-[border-color] cursor-pointer"
              >
                <span className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase">EUR/CHF</span>
                <span className="text-lg font-bold text-amber-600 dark:text-amber-400 tabular-nums">
                  {fxRate.toFixed(4)}
                </span>
                <span className="text-xs text-slate-500 dark:text-slate-400">{t('profile.widget.live')}</span>
              </button>
              {/* Preferred dogana / morning dashboard */}
              <button
                onClick={() => window.dispatchEvent(new CustomEvent('navigate-tab', { detail: { tab: 'morning' } }))}
                aria-label={t('profile.widget.morning')}
                className="flex flex-col items-center gap-1 p-3 bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 hover:border-orange-300 dark:hover:border-orange-600 transition-[border-color] cursor-pointer"
              >
                <span className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase">
                  {preferredCrossing ? preferredCrossing.name : t('profile.widget.morning')}
                </span>
                <span className="text-lg">☀️</span>
                <span className="text-xs text-orange-600 dark:text-orange-400 font-medium">{t('profile.widget.openDashboard')}</span>
              </button>
            </div>
          </div>
        )}

        {/* ─── Permit Deadline Tracker Card ─────────────────── */}
        {profile.permitExpiry && (() => {
          const today = new Date();
          today.setHours(0, 0, 0, 0);
          const expiry = new Date(profile.permitExpiry + 'T00:00:00');
          const diffMs = expiry.getTime() - today.getTime();
          const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
          const diffMonths = Math.max(0, Math.round(diffDays / 30.44));
          const isExpired = diffDays <= 0;
          const isUrgent = diffDays > 0 && diffDays <= 60;
          const isSoon = diffDays > 60 && diffDays <= 180;

          const bgColor = isExpired
            ? 'bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-800'
            : isUrgent
            ? 'bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-800'
            : isSoon
            ? 'bg-blue-50 dark:bg-blue-950/30 border-blue-200 dark:border-blue-800'
            : 'bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-800';

          const textColor = isExpired
            ? 'text-red-700 dark:text-red-400'
            : isUrgent
            ? 'text-amber-700 dark:text-amber-400'
            : isSoon
            ? 'text-blue-700 dark:text-blue-400'
            : 'text-emerald-700 dark:text-emerald-400';

          const numColor = isExpired
            ? 'text-red-600 dark:text-red-400'
            : isUrgent
            ? 'text-amber-600 dark:text-amber-400'
            : isSoon
            ? 'text-blue-600 dark:text-blue-400'
            : 'text-emerald-700 dark:text-emerald-400';

          const permitLabel = profile.frontaliereType === 'permit-g' ? t('profile.permitG') : t('profile.permitB');

          return (
            <div className={`mx-6 mt-4 p-4 rounded-2xl border ${bgColor}`}>
              <div className="flex items-start gap-3">
                <div className={`p-2 rounded-xl ${isExpired ? 'bg-red-100 dark:bg-red-900/40' : isUrgent ? 'bg-amber-100 dark:bg-amber-900/40' : isSoon ? 'bg-blue-100 dark:bg-blue-900/40' : 'bg-emerald-100 dark:bg-emerald-900/40'}`}>
                  <FileCheck size={20} className={numColor} />
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className={`text-sm font-bold ${textColor}`}>{t('profile.permit.tracker')}</h3>
                  <p className="text-xs text-slate-600 dark:text-slate-400 mt-0.5">
                    {permitLabel} — {t('profile.permit.expires')} {expiry.toLocaleDateString(locale === 'it' ? 'it-IT' : locale === 'de' ? 'de-DE' : locale === 'fr' ? 'fr-FR' : 'en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}
                  </p>
                  <div className="flex items-baseline gap-1 mt-2">
                    {isExpired ? (
                      <span className={`text-2xl font-bold ${numColor}`}>{t('profile.permit.expired')}</span>
                    ) : (
                      <>
                        <span className={`text-2xl font-bold tabular-nums ${numColor}`}>{diffDays}</span>
                        <span className={`text-sm font-medium ${textColor}`}>{t('profile.permit.daysLeft')}</span>
                        {diffMonths > 0 && <span className="text-xs text-slate-500 dark:text-slate-400 ml-1">({diffMonths} {t('profile.permit.months')})</span>}
                      </>
                    )}
                  </div>
                  {/* Contextual tips */}
                  <p className={`text-xs mt-2 ${textColor}`}>
                    {isExpired ? t('profile.permit.tipExpired')
                      : isUrgent ? t('profile.permit.tipUrgent')
                      : isSoon ? t('profile.permit.tipSoon')
                      : t('profile.permit.tipOk')}
                  </p>
                </div>
              </div>
            </div>
          );
        })()}

        {/* Profile data form */}
        <div className="p-6 space-y-5">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-bold text-slate-800 dark:text-slate-100 flex items-center gap-2">
              <Edit3 size={18} className="text-indigo-500" />
              {t('profile.personalInfo')}
            </h2>
            {saveStatus === 'saved' && (
              <span className="flex items-center gap-1 text-xs text-emerald-700 dark:text-emerald-400 font-medium">
                <CheckCircle2 size={13} />
                {t('profile.saved')}
              </span>
            )}
            {saveStatus === 'saving' && (
              <span className="flex items-center gap-1 text-xs text-slate-500 dark:text-slate-400 font-medium">
                <Loader2 size={13} className="animate-spin" />
                {t('profile.saving')}
              </span>
            )}
          </div>

          {/* Validation errors */}
          {validationErrors.length > 0 && (
            <div className="p-3 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 rounded-xl space-y-1">
              {validationErrors.map((err, i) => (
                <div key={i} className="flex items-center gap-2 text-xs text-red-700 dark:text-red-400">
                  <AlertCircle size={13} className="flex-shrink-0" />
                  {err}
                </div>
              ))}
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {/* Frontaliere Type */}
            <div>
              <label htmlFor="frontaliereType" className="flex items-center gap-1.5 text-xs font-bold text-slate-600 dark:text-slate-400 uppercase mb-1.5">
                <MapPin size={13} />
                {t('profile.frontaliereType')}
              </label>
              <select
                id="frontaliereType"
                value={profile.frontaliereType}
                onChange={(e) => updateField('frontaliereType', e.target.value)}
                className="w-full px-4 py-2.5 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              >
                <option value="">{t('profile.selectOption')}</option>
                <option value="permit-g">{t('profile.permitG')}</option>
                <option value="permit-b">{t('profile.permitB')}</option>
                <option value="considering">{t('profile.considering')}</option>
              </select>
            </div>

            {/* Permit expiry date — shown only for G or B */}
            {(profile.frontaliereType === 'permit-g' || profile.frontaliereType === 'permit-b') && (
              <div>
                <label htmlFor="permitExpiry" className="flex items-center gap-1.5 text-xs font-bold text-slate-600 dark:text-slate-400 uppercase mb-1.5">
                  <Clock size={13} />
                  {t('profile.permitExpiry')}
                </label>
                <input
                  id="permitExpiry"
                  type="date"
                  value={profile.permitExpiry}
                  onChange={(e) => updateField('permitExpiry', e.target.value)}
                  min={new Date().toISOString().split('T')[0]}
                  className="w-full px-4 py-2.5 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">{t('profile.permitExpiryHint')}</p>
              </div>
            )}

            {/* Age */}
            <div>
              <label htmlFor="age" className="flex items-center gap-1.5 text-xs font-bold text-slate-600 dark:text-slate-400 uppercase mb-1.5">
                <Calendar size={13} />
                {t('profile.age')}
              </label>
              <select
                id="age"
                value={profile.age}
                onChange={(e) => updateField('age', e.target.value)}
                className="w-full px-4 py-2.5 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              >
                <option value="">{t('profile.selectOption')}</option>
                <option value="18-25">18-25</option>
                <option value="26-35">26-35</option>
                <option value="36-45">36-45</option>
                <option value="46-55">46-55</option>
                <option value="56-65">56-65</option>
                <option value="65+">65+</option>
              </select>
            </div>

            {/* Gender */}
            <div>
              <label htmlFor="gender" className="flex items-center gap-1.5 text-xs font-bold text-slate-600 dark:text-slate-400 uppercase mb-1.5">
                <User size={13} />
                {t('profile.gender')}
              </label>
              <select
                id="gender"
                value={profile.gender}
                onChange={(e) => updateField('gender', e.target.value)}
                className="w-full px-4 py-2.5 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              >
                <option value="">{t('profile.selectOption')}</option>
                <option value="male">{t('profile.genderMale')}</option>
                <option value="female">{t('profile.genderFemale')}</option>
                <option value="other">{t('profile.genderOther')}</option>
              </select>
            </div>

            {/* Family Situation */}
            <div>
              <label htmlFor="familySituation" className="flex items-center gap-1.5 text-xs font-bold text-slate-600 dark:text-slate-400 uppercase mb-1.5">
                <Heart size={13} />
                {t('profile.familySituation')}
              </label>
              <select
                id="familySituation"
                value={profile.familySituation}
                onChange={(e) => updateField('familySituation', e.target.value)}
                className="w-full px-4 py-2.5 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              >
                <option value="">{t('profile.selectOption')}</option>
                <option value="single">{t('profile.single')}</option>
                <option value="married">{t('profile.married')}</option>
                <option value="divorced">{t('profile.divorced')}</option>
                <option value="cohabiting">{t('profile.cohabiting')}</option>
              </select>
            </div>

            {/* Preferred language */}
            <div>
              <label htmlFor="preferredLanguage" className="flex items-center gap-1.5 text-xs font-bold text-slate-600 dark:text-slate-400 uppercase mb-1.5">
                <Globe size={13} />
                {t('profile.preferredLanguage')}
              </label>
              <select
                id="preferredLanguage"
                value={profile.preferredLanguage || getLocale()}
                onChange={(e) => {
                  const locale = e.target.value as Locale;
                  updateField('preferredLanguage', locale);
                  setGlobalLocale(locale);
                }}
                className="w-full px-4 py-2.5 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              >
                {(Object.entries(LOCALE_LABELS) as [Locale, typeof LOCALE_LABELS[Locale]][]).map(([locale, label]) => (
                  <option key={locale} value={locale}>{label.flag} {label.nativeName}</option>
                ))}
              </select>
            </div>

            {/* Municipality (autocomplete) */}
            <div className="sm:col-span-2">
              <label htmlFor="municipality" className="flex items-center gap-1.5 text-xs font-bold text-slate-600 dark:text-slate-400 uppercase mb-1.5">
                <MapPin size={13} />
                {t('profile.municipality')}
              </label>
              <Autocomplete
                id="municipality"
                value={profile.municipality}
                onChange={(v) => updateField('municipality', v)}
                suggestions={municipalityNames}
                placeholder={t('profile.municipalityPlaceholder')}
                autoComplete="address-level2"
                className="w-full px-4 py-2.5 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
              {/* Municipality info badges */}
              {selectedMuni && (
                <div className="flex flex-wrap gap-2 mt-2">
                  <span className="px-2 py-0.5 bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 text-xs font-bold rounded-md">
                    {t('profile.muniDistance')}: {selectedMuni.distanceKm} km
                  </span>
                  <span className="px-2 py-0.5 bg-amber-50 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 text-xs font-bold rounded-md">
                    {t('profile.muniIrpef')}: {selectedMuni.irpefAddizionale}%
                  </span>
                  <span className="px-2 py-0.5 bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400 text-xs font-bold rounded-md">
                    {t('profile.muniFascia')}: {selectedMuni.fascia}
                  </span>
                  <span className="px-2 py-0.5 bg-purple-50 dark:bg-purple-900/30 text-purple-700 dark:text-purple-400 text-xs font-bold rounded-md">
                    {t('profile.muniRent')}: €{selectedMuni.avgRentMonthly}/m
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* ─── Family Members Section ─────────────────────────── */}
          <div className="border-t border-slate-100 dark:border-slate-800 pt-4">
            <button
              onClick={() => setShowFamily(!showFamily)}
              className="flex items-center justify-between w-full text-left"
            >
              <h3 className="text-sm font-bold text-slate-800 dark:text-slate-100 flex items-center gap-2">
                <Users size={16} className="text-indigo-500" />
                {t('profile.family.title')}
                {(profile.familyMembersList?.length || 0) > 0 && (
                  <span className="text-xs font-bold px-1.5 py-0.5 bg-indigo-100 dark:bg-indigo-900/40 text-indigo-600 dark:text-indigo-400 rounded-md">
                    {profile.familyMembersList!.length}
                  </span>
                )}
              </h3>
              <span className="text-slate-500 dark:text-slate-400 text-lg font-medium" aria-hidden>
                {showFamily ? '−' : '+'}
              </span>
            </button>

            {showFamily && (
              <div className="mt-3 space-y-3 animate-fade-in">
                {/* Legacy selects for children/members */}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label htmlFor="children" className="flex items-center gap-1.5 text-xs font-bold text-slate-600 dark:text-slate-400 uppercase mb-1.5">
                      <Baby size={13} />
                      {t('profile.children')}
                    </label>
                    <select
                      id="children"
                      value={profile.children}
                      onChange={(e) => updateField('children', e.target.value)}
                      className="w-full px-4 py-2.5 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    >
                      <option value="0">0</option>
                      <option value="1">1</option>
                      <option value="2">2</option>
                      <option value="3">3</option>
                      <option value="4+">4+</option>
                    </select>
                  </div>
                  <div>
                    <label htmlFor="familyMembers" className="flex items-center gap-1.5 text-xs font-bold text-slate-600 dark:text-slate-400 uppercase mb-1.5">
                      <Users size={13} />
                      {t('profile.familyMembers')}
                    </label>
                    <select
                      id="familyMembers"
                      value={profile.familyMembers}
                      onChange={(e) => updateField('familyMembers', e.target.value)}
                      className="w-full px-4 py-2.5 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    >
                      <option value="1">1 ({t('profile.justMe')})</option>
                      <option value="2">2</option>
                      <option value="3">3</option>
                      <option value="4">4</option>
                      <option value="5">5</option>
                      <option value="6+">6+</option>
                    </select>
                  </div>
                </div>

                {/* Detailed family members list */}
                <div className="space-y-2">
                  <p className="text-xs text-slate-500 dark:text-slate-400 font-medium">{t('profile.family.detailLabel')}</p>
                  {(profile.familyMembersList || []).map(member => (
                    <FamilyMemberRow
                      key={member.id}
                      member={member}
                      onUpdate={updateFamilyMember}
                      onRemove={() => removeFamilyMember(member.id)}
                      t={t}
                    />
                  ))}
                  <button
                    onClick={addFamilyMember}
                    className="flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-indigo-600 dark:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-900/30 rounded-xl transition-colors w-full justify-center border border-dashed border-indigo-300 dark:border-indigo-700"
                  >
                    <Plus size={14} />
                    {t('profile.family.addMember')}
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* ─── Work Info Section ─────────────────────────── */}
          <div className="border-t border-slate-100 dark:border-slate-800 pt-5">
            <h2 className="text-lg font-bold text-slate-800 dark:text-slate-100 flex items-center gap-2 mb-4">
              <Briefcase size={18} className="text-emerald-500" />
              {t('profile.workInfo')}
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {/* Gross Salary CHF */}
              <div>
                <label htmlFor="grossSalary" className="flex items-center gap-1.5 text-xs font-bold text-slate-600 dark:text-slate-400 uppercase mb-1.5">
                  <Banknote size={13} />
                  {t('profile.grossSalary')}
                </label>
                <input
                  id="grossSalary"
                  type="number"
                  inputMode="numeric"
                  min="0"
                  step="1000"
                  value={profile.grossSalary}
                  onChange={(e) => updateField('grossSalary', e.target.value)}
                  placeholder="e.g. 85000"
                  className="w-full px-4 py-2.5 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
              </div>

              {/* Work Position (autocomplete) */}
              <div>
                <label htmlFor="workPosition" className="flex items-center gap-1.5 text-xs font-bold text-slate-600 dark:text-slate-400 uppercase mb-1.5">
                  <Briefcase size={13} />
                  {t('profile.workPosition')}
                </label>
                <Autocomplete
                  id="workPosition"
                  value={profile.workPosition}
                  onChange={(v) => updateField('workPosition', v)}
                  suggestions={COMMON_POSITIONS}
                  placeholder={t('profile.workPositionPlaceholder')}
                  autoComplete="organization-title"
                  className="w-full px-4 py-2.5 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
              </div>

              {/* Workplace (autocomplete) */}
              <div>
                <label htmlFor="workplace" className="flex items-center gap-1.5 text-xs font-bold text-slate-600 dark:text-slate-400 uppercase mb-1.5">
                  <Building2 size={13} />
                  {t('profile.workplace')}
                </label>
                <Autocomplete
                  id="workplace"
                  value={profile.workplace}
                  onChange={(v) => updateField('workplace', v)}
                  suggestions={COMMON_WORKPLACES}
                  placeholder={t('profile.workplacePlaceholder')}
                  autoComplete="address-level2"
                  className="w-full px-4 py-2.5 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
              </div>

              {/* Preferred border crossing (dogana) */}
              <div>
                <label htmlFor="preferredDogana" className="flex items-center gap-1.5 text-xs font-bold text-slate-600 dark:text-slate-400 uppercase mb-1.5">
                  <Navigation size={13} />
                  {t('profile.preferredDogana')}
                </label>
                <select
                  id="preferredDogana"
                  value={profile.preferredDogana}
                  onChange={(e) => updateField('preferredDogana', e.target.value)}
                  className="w-full px-4 py-2.5 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                >
                  <option value="">{t('profile.selectDogana')}</option>
                  {borderCrossings.map(bc => (
                    <option key={bc.name} value={bc.name}>{bc.name} ({bc.italianSide})</option>
                  ))}
                </select>
                {/* Dogana traffic info badge */}
                {profile.preferredDogana && (() => {
                  const bc = borderCrossings.find(b => b.name === profile.preferredDogana);
                  if (!bc) return null;
                  const levelColors: Record<string, string> = {
                    high: 'bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-400',
                    medium: 'bg-amber-50 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400',
                    low: 'bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400',
                    closed: 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400',
                  };
                  return (
                    <div className="flex flex-wrap gap-2 mt-2">
                      <span className={`px-2 py-0.5 text-xs font-bold rounded-md ${levelColors[bc.trafficLevel]}`}>
                        {bc.trafficLevel === 'high' ? '🔴' : bc.trafficLevel === 'medium' ? '🟡' : '🟢'} {t('profile.doganaTraffic')}: {bc.trafficLevel}
                      </span>
                      <span className="px-2 py-0.5 bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 text-xs font-bold rounded-md">
                        🌅 {t('profile.doganaMorning')}: {bc.avgWaitMorning}
                      </span>
                      <span className="px-2 py-0.5 bg-orange-50 dark:bg-orange-900/30 text-orange-700 dark:text-orange-400 text-xs font-bold rounded-md">
                        🌆 {t('profile.doganaEvening')}: {bc.avgWaitEvening}
                      </span>
                      <span className="px-2 py-0.5 bg-purple-50 dark:bg-purple-900/30 text-purple-700 dark:text-purple-400 text-xs font-bold rounded-md">
                        ⏰ {t('profile.doganaPeak')}: {bc.peak}
                      </span>
                    </div>
                  );
                })()}
              </div>
            </div>
          </div>


        </div>
      </div>

      {/* Contextual CTA card */}
      {completeness < 100 && (
        <div className="bg-gradient-to-r from-amber-50 to-orange-50 dark:from-amber-950/30 dark:to-orange-950/30 rounded-2xl border border-amber-200 dark:border-amber-800 p-4">
          <div className="flex items-start gap-3">
            <Award size={20} className="text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-bold text-amber-800 dark:text-amber-300">{t('profile.cta.completeProfile')}</p>
              <p className="text-xs text-amber-700 dark:text-amber-400 mt-1">{t('profile.cta.completeDesc')}</p>
            </div>
          </div>
        </div>
      )}

      {/* ─── Privacy & Data Management Section ─── */}
      <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 overflow-hidden shadow-sm">
        <div className="p-6 space-y-4">
          <div
            role="button"
            tabIndex={0}
            onClick={() => setPrivacyOpen(o => !o)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setPrivacyOpen(o => !o); } }}
            aria-expanded={privacyOpen}
            aria-controls="profile-privacy-content"
            className="flex items-center gap-2 text-lg font-bold text-slate-800 dark:text-slate-100 focus:outline-none cursor-pointer rounded-md focus:ring-2 focus:ring-indigo-500"
          >
            <Shield size={18} className="text-slate-500 dark:text-slate-400" />
            <span>{t('profile.privacySection')}</span>
          </div>

          <div
            id="profile-privacy-content"
            className={`grid ${prefersReducedMotion ? '' : 'transition-[grid-template-rows,opacity] duration-300 ease-[cubic-bezier(.2,.8,.2,1)]'}`}
            style={{
              gridTemplateRows: privacyOpen ? '1fr' : '0fr',
              opacity: privacyOpen ? 1 : 0,
            }}
          >
          <div className="overflow-hidden space-y-3 mt-3">
            {/* Privacy note */}
            <div className="flex items-center gap-3 px-4 py-3 bg-slate-50 dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-700 text-xs text-slate-500 dark:text-slate-400">
              <Shield size={14} className="flex-shrink-0" />
              <p>{t('profile.dataPrivacy')}</p>
            </div>

            {/* GDPR Data Export */}
            <div className="flex items-center justify-between px-4 py-3 bg-blue-50 dark:bg-blue-950/30 rounded-xl border border-blue-100 dark:border-blue-900/50">
              <div className="flex items-center gap-2 text-xs text-blue-700 dark:text-blue-300 font-medium">
                <Shield size={14} className="flex-shrink-0" />
                <span>{t('profile.gdprExportDesc')}</span>
              </div>
              <button
                onClick={handleExportData}
                className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold uppercase rounded-lg transition-colors flex-shrink-0"
              >
                {t('profile.gdprExport')}
              </button>
            </div>

            {/* Account Deletion */}
            {user && (
              <div className="px-4 py-3 bg-red-50 dark:bg-red-950/20 rounded-xl border border-red-200 dark:border-red-900/50">
                {!showDeleteConfirm ? (
                  <button
                    onClick={() => setShowDeleteConfirm(true)}
                    className="flex items-center gap-2 text-xs text-red-600 dark:text-red-400 font-medium hover:text-red-700 dark:hover:text-red-300 transition-colors"
                    aria-label={t('profile.deleteAccount')}
                  >
                    <Trash2 size={14} className="flex-shrink-0" />
                    {t('profile.deleteAccount')}
                  </button>
                ) : (
                  <div className="space-y-3">
                    <div className="flex items-start gap-2">
                      <AlertCircle size={16} className="text-red-600 dark:text-red-400 flex-shrink-0 mt-0.5" />
                      <p className="text-xs text-red-700 dark:text-red-300 font-medium">
                        {t('profile.deleteAccountConfirm')}
                      </p>
                    </div>
                    <div className="flex gap-2">
                      <button
                        onClick={handleDeleteAccount}
                        disabled={deleting}
                        className="flex items-center gap-1.5 px-3 py-1.5 bg-red-600 hover:bg-red-700 disabled:bg-red-400 text-white text-xs font-bold uppercase rounded-lg transition-colors"
                      >
                        {deleting ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                        {t('profile.deleteAccountConfirmBtn')}
                      </button>
                      <button
                        onClick={() => setShowDeleteConfirm(false)}
                        className="px-3 py-1.5 bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-300 text-xs font-bold uppercase rounded-lg transition-colors hover:bg-slate-300 dark:hover:bg-slate-600"
                      >
                        {t('profile.deleteAccountCancel')}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default UserProfile;
