import React, { startTransition, useOptimistic } from 'react';

export interface JobBoardQuickFilterChip {
 id: string;
 /** Chips in the same group drive the same filter atom, so at most one is on. */
 group: string;
 icon: React.ComponentType<{ className?: string }>;
 label: string;
 active: boolean;
 action: () => void;
}

export function toggleQuickFilterChip(
 chips: readonly JobBoardQuickFilterChip[],
 id: string,
): JobBoardQuickFilterChip[] {
 const clicked = chips.find((chip) => chip.id === id);
 if (!clicked) return [...chips];
 const nextActive = !clicked.active;
 return chips.map((chip) => {
 if (chip.id === id) return { ...chip, active: nextActive };
 if (nextActive && chip.group === clicked.group && chip.active) return { ...chip, active: false };
 return chip;
 });
}

/**
 * Quick filter chips of the job board.
 *
 * INP: a chip used to call the JobBoard setter as an urgent update, so the tap
 * re-rendered the whole JobBoard component (one ~12k-line Fiber that cannot be
 * interrupted) before the browser could paint the pressed chip — 1.8 s of
 * processing measured on a Pixel 5 profile with 4x CPU. The filter update now
 * runs in a transition, and the pressed state is an optimistic value owned by
 * this small component: the urgent render touches only this row, the paint
 * happens right away, and the list follows when the transition commits. The
 * optimistic value falls back to the committed `active` props as soon as the
 * transition ends, so the parent stays the single source of truth.
 */
export default function JobBoardQuickFilterChips({ chips }: { chips: readonly JobBoardQuickFilterChip[] }) {
 const [shown, toggleShown] = useOptimistic(chips, toggleQuickFilterChip);
 return (
 <>
 {shown.map((chip) => (
 <button
 key={chip.id}
 type="button"
 onClick={() => {
 startTransition(() => {
 toggleShown(chip.id);
 chip.action();
 });
 }}
 className={`flex-shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 min-h-11 text-xs font-medium rounded-full border transition-[color,background-color,border-color,box-shadow] ${
 chip.active
 ? 'bg-accent-strong border-accent text-on-accent shadow-sm shadow-accent/20'
 : 'bg-surface border-edge text-subtle hover:bg-surface-raised hover:border-accent'
 }`}
 aria-pressed={chip.active}
 >
 <chip.icon className="w-3 h-3" />
 {chip.label}
 </button>
 ))}
 </>
 );
}
