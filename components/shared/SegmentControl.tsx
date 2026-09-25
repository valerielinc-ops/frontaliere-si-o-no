import { isValidElement, createElement, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

export interface SegmentOption {
 key: string;
 label: string;
 icon?: LucideIcon | ReactNode;
}

interface SegmentControlProps {
 options: readonly SegmentOption[];
 value: string;
 onChange: (key: string) => void;
 /** Tailwind text class for the active segment, e.g. 'text-section-confronti' */
 activeTextClass?: string;
 /** sm = compact (text-xs, h-11) for form fields. md = default. */
 size?: 'sm' | 'md';
}

const sizeStyles = {
 sm: { container: 'h-11', button: 'text-xs', iconSize: 14 },
 md: { container: '', button: 'text-sm py-2.5', iconSize: 16 },
} as const;

export function SegmentControl({
 options,
 value,
 onChange,
 activeTextClass = 'text-accent',
 size = 'md',
}: SegmentControlProps) {
 const s = sizeStyles[size];
 return (
 <div className={`flex gap-1 bg-segment-container-bg rounded-xl p-1 ${s.container}`} role="group">
 {options.map((opt) => {
 const isActive = value === opt.key;
 const IconEl = opt.icon;
 return (
 <button
 key={opt.key}
 onClick={() => onChange(opt.key)}
 aria-pressed={isActive}
 className={`flex-1 flex items-center justify-center gap-2 px-4 rounded-lg ${s.button} font-bold transition-[color,background-color,box-shadow,transform] ${
 isActive
 ? `bg-segment-active-bg ${activeTextClass} shadow-sm`
 : 'text-muted hover:text-strong'
 }`}
 >
 {IconEl && (isValidElement(IconEl)
 ? IconEl
 : createElement(IconEl as LucideIcon, { size: s.iconSize })
 )}
 <span className="hidden sm:inline">{opt.label}</span>
 </button>
 );
 })}
 </div>
 );
}
