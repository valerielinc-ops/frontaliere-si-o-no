import { AlertTriangle, CheckCircle2 } from 'lucide-react';

export function HealthBadge({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${ok ? 'bg-success-subtle text-success' : 'bg-danger-subtle text-danger'}`}>
      {ok ? <CheckCircle2 size={12} /> : <AlertTriangle size={12} />}
      {label}
    </span>
  );
}

