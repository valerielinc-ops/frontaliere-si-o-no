import type { ReactNode } from 'react';

export function AdminSectionHeader({
  title,
  summary,
  primaryAction,
  secondaryActions,
}: {
  title: string;
  summary: ReactNode;
  primaryAction?: ReactNode;
  secondaryActions?: ReactNode;
}) {
  return (
    <header className="flex flex-col gap-5 border-b border-edge pb-5 lg:flex-row lg:items-end lg:justify-between">
      <div className="min-w-0">
        <h1 className="font-display text-3xl font-light leading-tight tracking-[-0.025em] text-heading">{title}</h1>
        <p className="mt-2 max-w-4xl text-sm leading-6 text-subtle">{summary}</p>
      </div>
      {(primaryAction || secondaryActions) && (
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {secondaryActions}
          {primaryAction}
        </div>
      )}
    </header>
  );
}
