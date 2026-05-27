import React, { useState, useRef, useEffect, useCallback } from 'react';
import { type Locale, getLocale, setLocale, onLocaleChange, LOCALE_LABELS } from '@/services/i18n';
import { ensureJobSlugMapLoaded, updatePathForLocale } from '@/services/router';
import { Analytics } from '@/services/analytics';

const locales = Object.keys(LOCALE_LABELS) as Locale[];

const LanguageSelector: React.FC = () => {
 const [isOpen, setIsOpen] = useState(false);
 const [current, setCurrent] = useState<Locale>(getLocale());
 const [focusIdx, setFocusIdx] = useState(-1);
 const dropdownRef = useRef<HTMLDivElement>(null);
 const buttonRef = useRef<HTMLButtonElement>(null);

 useEffect(() => {
 return onLocaleChange(setCurrent);
 }, []);

 useEffect(() => {
 const handleClickOutside = (e: MouseEvent) => {
 if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
 setIsOpen(false);
 }
 };
 document.addEventListener('mousedown', handleClickOutside);
 return () => document.removeEventListener('mousedown', handleClickOutside);
 }, []);

 // Reset focus index when opening
 useEffect(() => {
 if (isOpen) {
 setFocusIdx(locales.indexOf(current));
 }
 }, [isOpen, current]);

 const handleSelect = useCallback(async (locale: Locale) => {
 try {
 await ensureJobSlugMapLoaded();
 } catch {
 // Non-blocking
 }
 setLocale(locale);
 updatePathForLocale(locale);
 setCurrent(locale);
 setIsOpen(false);
 buttonRef.current?.focus();
 Analytics.trackSettingsChange('locale', locale);
 }, []);

 const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
 if (!isOpen) {
 if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
 e.preventDefault();
 setIsOpen(true);
 }
 return;
 }
 switch (e.key) {
 case 'ArrowDown':
 e.preventDefault();
 setFocusIdx(i => (i + 1) % locales.length);
 break;
 case 'ArrowUp':
 e.preventDefault();
 setFocusIdx(i => (i - 1 + locales.length) % locales.length);
 break;
 case 'Enter':
 case ' ':
 e.preventDefault();
 if (focusIdx >= 0) handleSelect(locales[focusIdx]);
 break;
 case 'Escape':
 e.preventDefault();
 setIsOpen(false);
 buttonRef.current?.focus();
 break;
 case 'Home':
 e.preventDefault();
 setFocusIdx(0);
 break;
 case 'End':
 e.preventDefault();
 setFocusIdx(locales.length - 1);
 break;
 }
 }, [isOpen, focusIdx, handleSelect]);

 const currentLabel = LOCALE_LABELS[current];

 return (
 <div className="relative" ref={dropdownRef} onKeyDown={handleKeyDown}>
 <button
 ref={buttonRef}
 onClick={() => setIsOpen(!isOpen)}
 className="flex items-center gap-1 px-2 py-1.5 min-h-[44px] min-w-[44px] justify-center rounded-xl text-sm text-muted hover:bg-surface-raised transition-colors"
 title="Lingua / Language"
 aria-expanded={isOpen}
 aria-haspopup="listbox"
 aria-label={`Lingua: ${currentLabel.nativeName}`}
 >
 <span className="hidden sm:inline text-xs font-bold uppercase">{current.toUpperCase()}</span>
 <span className="sm:hidden">{currentLabel.flag}</span>
 </button>

 {isOpen && (
 <div
 role="listbox"
 aria-label="Lingua / Language"
 aria-activedescendant={focusIdx >= 0 ? `lang-${locales[focusIdx]}` : undefined}
 className="absolute right-0 top-full mt-1 w-44 bg-surface border border-edge rounded-xl shadow-xl z-50 overflow-hidden animate-fade-in"
 >
 {locales.map((locale, idx) => {
 const label = LOCALE_LABELS[locale];
 return (
 <button
 key={locale}
 id={`lang-${locale}`}
 role="option"
 aria-selected={current === locale}
 onClick={() => handleSelect(locale)}
 className={`w-full flex items-center gap-3 px-4 py-2.5 min-h-[44px] text-sm transition-colors ${
 current === locale
 ? 'bg-accent-subtle text-accent font-bold'
 : 'text-body hover:bg-surface-raised'
 } ${idx === focusIdx ? 'ring-2 ring-inset ring-accent' : ''}`}
 >
 <span className="text-lg">{label.flag}</span>
 <span>{label.nativeName}</span>
 </button>
 );
 })}
 </div>
 )}
 </div>
 );
};

export default LanguageSelector;
