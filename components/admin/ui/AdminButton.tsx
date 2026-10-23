import { Loader2 } from 'lucide-react';
import type { MouseEvent, ReactNode } from 'react';

export type AdminButtonVariant = 'primary' | 'secondary' | 'danger';

export interface AdminButtonProps {
  variant?: AdminButtonVariant;
  loading?: boolean;
  loadingLabel?: string;
  icon?: ReactNode;
  className?: string;
  children?: ReactNode;
  disabled?: boolean;
  type?: 'button' | 'submit' | 'reset';
  onClick?: (event: MouseEvent<HTMLButtonElement>) => void;
  title?: string;
  'aria-label'?: string;
}

/** Shared admin action control: one vocabulary for focus, disabled and loading states. */
export function AdminButton({
  variant = 'secondary',
  loading = false,
  loadingLabel = 'Operazione in corso…',
  icon,
  className = '',
  children,
  disabled,
  type = 'button',
  ...props
}: AdminButtonProps) {
  const variantClass = variant === 'primary'
    ? 'border-accent bg-accent text-on-accent hover:bg-accent-hover'
    : variant === 'danger'
      ? 'border-danger-strong bg-danger-strong text-on-accent hover:bg-danger-strong-hover'
      : 'border-edge bg-surface text-body hover:border-accent hover:bg-surface-raised';

  return (
    <button
      {...props}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={`inline-flex min-h-10 items-center justify-center gap-2 rounded-stripe border px-3.5 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface disabled:cursor-not-allowed disabled:opacity-60 ${variantClass} ${className}`}
    >
      {loading ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : icon}
      <span>{loading ? loadingLabel : children}</span>
    </button>
  );
}
