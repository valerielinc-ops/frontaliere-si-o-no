import React, { useState, useEffect, useRef } from 'react';

/** Generic string-suggestion combobox (keyboard nav + click-outside close). */
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
    if (highlightIdx >= 0 && listRef.current) {
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
          className="absolute z-50 w-full mt-1 bg-surface border border-edge rounded-xl shadow-lg max-h-48 overflow-y-auto"
        >
          {filtered.map((item, i) => (
            <li
              key={item}
              id={`${id}-opt-${i}`}
              role="option"
              aria-selected={i === highlightIdx}
              className={`px-4 py-2 text-sm cursor-pointer transition-colors ${i === highlightIdx ? 'bg-accent-subtle text-accent' : 'text-body hover:bg-surface-raised'}`}
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

export default Autocomplete;
