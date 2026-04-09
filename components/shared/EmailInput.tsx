/**
 * EmailInput — Email field with domain autocomplete suggestions
 * 
 * Shows a dropdown of common email providers (gmail, outlook, yahoo, etc.)
 * when user types '@'. Also validates against known invalid/disposable domains.
 */

import React, { useState, useRef, useEffect, useCallback } from 'react';
import Mailcheck from 'mailcheck';
import { useTranslation } from '@/services/i18n';

const COMMON_DOMAINS = [
  'gmail.com',
  'outlook.com',
  'hotmail.com',
  'yahoo.com',
  'icloud.com',
  'live.com',
  'libero.it',
  'virgilio.it',
  'tim.it',
  'alice.it',
  'tiscali.it',
  'fastwebnet.it',
  'pec.it',
  'aruba.it',
  'protonmail.com',
  'proton.me',
  'msn.com',
  'gmx.com',
  'gmx.net',
  'bluewin.ch',
  'hispeed.ch',
  'sunrise.ch',
  'swissonline.ch',
];

const FAKE_DOMAINS = [
  'test.com', 'example.com', 'fake.com', 'asdf.com', 'aaa.com',
  'mailinator.com', 'guerrillamail.com', 'tempmail.com', 'throwaway.email',
  'yopmail.com', 'sharklasers.com', 'guerrillamailblock.com', 'grr.la',
  'dispostable.com', 'maildrop.cc', 'temp-mail.org',
];

const VALID_TLDS = [
  'com', 'it', 'ch', 'net', 'org', 'de', 'fr', 'eu', 'co', 'uk', 'at',
  'info', 'biz', 'me', 'io', 'dev', 'app', 'online', 'email', 'mail',
];

/** Extended domain list for mailcheck typo detection (COMMON_DOMAINS + extras) */
const MAILCHECK_DOMAINS = [
  ...COMMON_DOMAINS,
  'yahoo.it', 'yahoo.co.uk', 'yahoo.de', 'yahoo.fr',
  'outlook.it', 'hotmail.it', 'hotmail.co.uk', 'hotmail.fr', 'hotmail.de',
  'googlemail.com', 'aol.com', 'me.com', 'mac.com',
  'mail.com', 'email.it', 'posta.it', 'tin.it',
  'ticino.com', 'bluemail.ch',
];

const MAILCHECK_SLDS = [
  'yahoo', 'hotmail', 'mail', 'live', 'outlook', 'gmx',
  'libero', 'virgilio', 'alice', 'tiscali', 'fastwebnet',
  'protonmail', 'proton', 'bluewin', 'sunrise', 'hispeed',
];

const MAILCHECK_TLDS = [
  'com', 'it', 'ch', 'net', 'org', 'de', 'fr', 'eu', 'co.uk',
  'at', 'me', 'io', 'dev',
];

/**
 * Detect gibberish / random keyboard mashing in a string.
 * Checks consonant runs, character entropy, and lack of vowel structure.
 */
export function isGibberish(str: string): boolean {
  const lower = str.toLowerCase().replace(/[^a-z]/g, '');
  if (lower.length < 5) return false;

  const vowels = new Set('aeiou');
  const consonants = lower.replace(/[aeiou]/g, '');
  const vowelRatio = (lower.length - consonants.length) / lower.length;

  // Natural text has ~35-45% vowels; gibberish skews low
  if (vowelRatio < 0.12 && lower.length >= 5) return true;

  // Consecutive consonants: 6+ in a row is very unlikely in real names
  if (/[^aeiou]{6,}/i.test(lower)) return true;

  // High entropy + very low vowel ratio → gibberish
  const freq = new Map<string, number>();
  for (const ch of lower) freq.set(ch, (freq.get(ch) || 0) + 1);
  let entropy = 0;
  for (const count of freq.values()) {
    const p = count / lower.length;
    entropy -= p * Math.log2(p);
  }
  if (entropy > 3.8 && vowelRatio < 0.2 && lower.length >= 7) return true;

  // Keyboard row mashing: 6+ consecutive chars all from the same keyboard row
  const rows = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'];
  for (const row of rows) {
    let run = 0;
    for (const ch of lower) {
      run = row.includes(ch) ? run + 1 : 0;
      if (run >= 6) return true;
    }
  }

  return false;
}

export function validateEmailStrict(emailStr: string): { valid: boolean; reason?: string } {
  // Basic format
  if (!/^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/.test(emailStr)) {
    return { valid: false, reason: 'format' };
  }

  const [localPart, domain] = emailStr.split('@');
  if (!localPart || !domain) return { valid: false, reason: 'format' };

  const domainLower = domain.toLowerCase();

  // Local part checks
  if (localPart.length < 2) return { valid: false, reason: 'local_too_short' };
  if (/^[.\-_]|[.\-_]$/.test(localPart)) return { valid: false, reason: 'local_invalid' };

  // Gibberish detection on local part
  const localAlpha = localPart.replace(/[^a-zA-Z]/g, '');
  if (localAlpha.length >= 5 && isGibberish(localAlpha)) {
    return { valid: false, reason: 'gibberish' };
  }

  // Domain structure
  const domainParts = domainLower.split('.');
  if (domainParts.length < 2) return { valid: false, reason: 'domain_invalid' };

  const tld = domainParts[domainParts.length - 1];
  if (tld.length < 2) return { valid: false, reason: 'tld_invalid' };

  // Reject purely numeric domains (e.g., 123.123)
  if (domainParts.every(p => /^\d+$/.test(p))) return { valid: false, reason: 'domain_numeric' };

  // Reject disposable/fake domains
  if (FAKE_DOMAINS.includes(domainLower)) return { valid: false, reason: 'disposable' };

  // Reject domains with all same characters (aaaa.com)
  const sld = domainParts[0];
  if (sld.length >= 3 && /^(.)\1+$/.test(sld)) return { valid: false, reason: 'domain_spam' };

  return { valid: true };
}

/**
 * Async MX record check via dns.google public API.
 * Returns true if the domain has at least one MX record.
 * Falls back to true on network/timeout errors (fail-open).
 */
export async function checkMxRecord(domain: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(
      `https://dns.google/resolve?name=${encodeURIComponent(domain)}&type=MX`,
      { signal: controller.signal },
    );
    clearTimeout(timer);
    if (!res.ok) return true; // fail-open
    const data = await res.json();
    // Status 0 = NOERROR; Answer array contains MX records
    if (data.Status === 3) return false; // NXDOMAIN — domain doesn't exist
    return Array.isArray(data.Answer) && data.Answer.length > 0;
  } catch {
    return true; // fail-open on network error
  }
}

interface EmailInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  required?: boolean;
  className?: string;
  id?: string;
  name?: string;
  /** Accessible label for the input when no visible <label> is associated */
  ariaLabel?: string;
  /** Dark-on-dark theme (for compact newsletter on purple bg) */
  darkVariant?: boolean;
}

const EmailInput: React.FC<EmailInputProps> = ({
  value,
  onChange,
  placeholder = 'email@esempio.com',
  required = true,
  className = '',
  id,
  name = 'email',
  ariaLabel,
  darkVariant = false,
}) => {
  const { t } = useTranslation();
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [typoSuggestion, setTypoSuggestion] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const computeSuggestions = useCallback((val: string) => {
    const atIndex = val.indexOf('@');
    if (atIndex === -1 || atIndex === 0) {
      setSuggestions([]);
      setShowSuggestions(false);
      return;
    }

    const localPart = val.slice(0, atIndex);
    const domainPart = val.slice(atIndex + 1).toLowerCase();

    // If the domain is already complete and matches a known domain exactly, hide
    if (COMMON_DOMAINS.includes(domainPart)) {
      setSuggestions([]);
      setShowSuggestions(false);
      return;
    }

    // Filter domains that start with what user typed after @
    const matching = COMMON_DOMAINS
      .filter(d => d.startsWith(domainPart))
      .map(d => `${localPart}@${d}`)
      .slice(0, 6);

    setSuggestions(matching);
    setShowSuggestions(matching.length > 0);
    setSelectedIndex(-1);
  }, []);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newVal = e.target.value;
    onChange(newVal);
    computeSuggestions(newVal);
    setTypoSuggestion(null); // clear typo hint while user is still typing
  };

  const checkTypo = useCallback((emailVal: string) => {
    if (!emailVal || !emailVal.includes('@')) {
      setTypoSuggestion(null);
      return;
    }
    Mailcheck.run({
      email: emailVal,
      domains: MAILCHECK_DOMAINS,
      secondLevelDomains: MAILCHECK_SLDS,
      topLevelDomains: MAILCHECK_TLDS,
      suggested: (s: { full: string }) => setTypoSuggestion(s.full),
      empty: () => setTypoSuggestion(null),
    });
  }, []);

  const handleBlur = () => {
    // Delay so click on autocomplete suggestion can fire first
    setTimeout(() => {
      setShowSuggestions(false);
      checkTypo(value);
    }, 150);
  };

  const acceptTypoSuggestion = () => {
    if (typoSuggestion) {
      onChange(typoSuggestion);
      setTypoSuggestion(null);
      inputRef.current?.focus();
    }
  };

  const handleSelect = (suggestion: string) => {
    onChange(suggestion);
    setSuggestions([]);
    setShowSuggestions(false);
    setSelectedIndex(-1);
    inputRef.current?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!showSuggestions || suggestions.length === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex(prev => (prev + 1) % suggestions.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(prev => (prev <= 0 ? suggestions.length - 1 : prev - 1));
    } else if (e.key === 'Enter' && selectedIndex >= 0) {
      e.preventDefault();
      handleSelect(suggestions[selectedIndex]);
    } else if (e.key === 'Escape') {
      setShowSuggestions(false);
    } else if (e.key === 'Tab' && selectedIndex >= 0) {
      e.preventDefault();
      handleSelect(suggestions[selectedIndex]);
    }
  };

  // Close suggestions when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setShowSuggestions(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  return (
    <div ref={containerRef} className="relative">
      <input
        ref={inputRef}
        id={id}
        type="email"
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onBlur={handleBlur}
        onFocus={() => { if (suggestions.length > 0) setShowSuggestions(true); }}
        placeholder={placeholder}
        autoComplete="email"
        name={name}
        inputMode="email"
        required={required}
        aria-label={!id ? (ariaLabel ?? 'Indirizzo email') : ariaLabel}
        className={className}
        role="combobox"
        aria-expanded={showSuggestions}
        aria-autocomplete="list"
        aria-controls={showSuggestions ? 'email-suggestions' : undefined}
        aria-activedescendant={selectedIndex >= 0 ? `email-suggestion-${selectedIndex}` : undefined}
      />
      {typoSuggestion && (
        <div className={`mt-1 px-3 py-2 text-sm rounded-lg flex items-center gap-1.5 ${
          darkVariant
            ? 'bg-amber-900/40 text-amber-200'
            : 'bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-amber-400 border border-amber-200 dark:border-amber-800'
        }`}>
          <span>{t('email.didYouMean')}</span>
          <button
            type="button"
            onClick={acceptTypoSuggestion}
            className={`font-semibold underline underline-offset-2 cursor-pointer ${
              darkVariant
                ? 'text-amber-100 hover:text-white'
                : 'text-amber-800 dark:text-amber-300 hover:text-amber-900 dark:hover:text-amber-200'
            }`}
          >
            {typoSuggestion}
          </button>
          <span>?</span>
          <button
            type="button"
            onClick={() => setTypoSuggestion(null)}
            aria-label={t('common.close')}
            className={`ml-auto text-xs opacity-60 hover:opacity-100 ${
              darkVariant ? 'text-amber-200' : 'text-amber-600 dark:text-amber-500'
            }`}
          >
            ✕
          </button>
        </div>
      )}
      {showSuggestions && suggestions.length > 0 && (
        <ul
          id="email-suggestions"
          role="listbox"
          className={`absolute z-50 left-0 right-0 mt-1 rounded-xl shadow-lg border overflow-hidden ${
            darkVariant
              ? 'bg-indigo-800 border-indigo-600'
              : 'bg-surface border-edge'
          }`}
        >
          {suggestions.map((suggestion, i) => {
            const atIdx = suggestion.indexOf('@');
            const domainHighlight = suggestion.slice(atIdx);
            const localDisplay = suggestion.slice(0, atIdx);
            return (
              <li
                key={suggestion}
                id={`email-suggestion-${i}`}
                role="option"
                aria-selected={i === selectedIndex}
                onMouseDown={(e) => { e.preventDefault(); handleSelect(suggestion); }}
                onMouseEnter={() => setSelectedIndex(i)}
                className={`px-4 py-2.5 text-sm cursor-pointer transition-colors ${
                  i === selectedIndex
                    ? darkVariant
                      ? 'bg-indigo-700 text-white'
                      : 'bg-indigo-50 dark:bg-indigo-950/30 text-indigo-700 dark:text-indigo-300'
                    : darkVariant
                      ? 'text-indigo-100 hover:bg-indigo-700'
                      : 'text-body hover:bg-slate-50 dark:hover:bg-slate-700'
                }`}
              >
                <span>{localDisplay}</span>
                <span className={`font-medium ${
                  darkVariant ? 'text-white' : 'text-indigo-600 dark:text-indigo-400'
                }`}>{domainHighlight}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};

export default EmailInput;
