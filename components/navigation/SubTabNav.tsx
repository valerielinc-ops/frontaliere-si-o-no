import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import type { LucideIcon } from 'lucide-react';

export interface SubTabItem<K extends string = string> {
 key: K;
 icon: LucideIcon;
 label: string;
}

interface SubTabNavProps<K extends string> {
 items: readonly SubTabItem<K>[];
 activeKey: K;
 onSelect: (key: K) => void;
 /** Hub identifier for `data-hub` attribute. Mirrors build-plugins/shared/hubChrome.ts. */
 hubKey: string;
 /** Build the canonical href for a sub-tab key. Anchors use it for SEO + middle-click support. */
 hrefFor: (key: K) => string;
}

export function SubTabNav<K extends string>({ items, activeKey, onSelect, hubKey, hrefFor }: SubTabNavProps<K>) {
 const tabRefs = useRef<(HTMLAnchorElement | null)[]>([]);
 const scrollRef = useRef<HTMLDivElement | null>(null);
 const [hasScrollEnd, setHasScrollEnd] = useState(false);

 useEffect(() => {
  const el = scrollRef.current;
  if (!el) return;

  const update = () => {
   const atEnd = el.scrollLeft + el.clientWidth >= el.scrollWidth - 2;
   setHasScrollEnd(atEnd);
  };

  update();
  el.addEventListener('scroll', update, { passive: true });
  const ro = new ResizeObserver(update);
  ro.observe(el);
  return () => {
   el.removeEventListener('scroll', update);
   ro.disconnect();
  };
 }, []);

 const handleKeyDown = useCallback((e: KeyboardEvent<HTMLAnchorElement>, index: number) => {
  let nextIndex: number | null = null;

  switch (e.key) {
   case 'ArrowRight':
    e.preventDefault();
    nextIndex = (index + 1) % items.length;
    break;
   case 'ArrowLeft':
    e.preventDefault();
    nextIndex = (index - 1 + items.length) % items.length;
    break;
   case 'Home':
    e.preventDefault();
    nextIndex = 0;
    break;
   case 'End':
    e.preventDefault();
    nextIndex = items.length - 1;
    break;
  }

  if (nextIndex !== null) {
   tabRefs.current[nextIndex]?.focus();
   onSelect(items[nextIndex].key);
  }
 }, [items, onSelect]);

 const handleClick = useCallback((e: MouseEvent<HTMLAnchorElement>, key: K) => {
  // Preserve new-tab / new-window behavior: modifier keys and non-primary
  // mouse buttons fall through to the browser's default anchor handling.
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
  e.preventDefault();
  onSelect(key);
 }, [onSelect]);

 return (
  <nav className="seo-hub-subnav border-t border-edge bg-surface" aria-label="Hub navigation" data-hub={hubKey}>
   <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-2 md:py-3">
    <div className="relative md:static">
     <div ref={scrollRef} role="tablist" className="flex md:grid md:grid-cols-8 gap-1.5 overflow-x-auto md:overflow-x-visible scrollbar-hide pr-8 md:pr-0 py-1">
      {items.map(({ key, icon: Icon, label }, index) => {
       const isActive = activeKey === key;
       return (
        <a
         key={key}
         ref={(el) => { tabRefs.current[index] = el; }}
         href={hrefFor(key)}
         role="tab"
         aria-selected={isActive}
         aria-current={isActive ? 'page' : undefined}
         data-subtab-active={isActive ? 'true' : undefined}
         data-subtab-key={key}
         tabIndex={isActive ? 0 : -1}
         onClick={(e) => handleClick(e, key)}
         onKeyDown={(e) => handleKeyDown(e, index)}
         className={`flex items-center md:flex-col gap-2 md:gap-0.5 px-3 md:px-1 py-2 md:py-1.5 min-h-[44px] md:min-h-0 rounded-xl text-sm font-semibold transition-[color,background-color,border-color,box-shadow] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 shrink-0 md:shrink ${
          isActive
           ? 'bg-tab-active-bg text-tab-active-text ring-2 ring-tab-active-border'
           : 'text-tab-inactive-text hover:bg-tab-hover-bg'
         }`}
        >
         <Icon size={16} className="shrink-0 md:w-[18px] md:h-[18px]" aria-hidden="true" />
         <span className="leading-tight text-center whitespace-nowrap md:whitespace-normal md:w-full md:line-clamp-2">{label}</span>
        </a>
       );
      })}
     </div>
     {/* Right-edge gradient fade — signals more tabs to the right on mobile.
         Hidden once the user has scrolled to the end of the list. */}
     <div
      aria-hidden="true"
      className={`pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-surface to-transparent md:hidden transition-opacity duration-200 ${hasScrollEnd ? 'opacity-0' : 'opacity-100'}`}
     />
    </div>
   </div>
  </nav>
 );
}
