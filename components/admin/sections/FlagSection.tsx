import { useEffect, useMemo, useState } from 'react';
import { RefreshCw, Search } from 'lucide-react';
import { useAuth } from '@/services/authService';
import { fetchAdminRemoteConfig, type AdminRemoteConfigParameter } from '@/services/adminRemoteConfig';
import { AdminButton } from '@/components/admin/ui/AdminButton';
import { AdminSectionHeader } from '@/components/admin/ui/AdminSectionHeader';
import { AdminSkeleton } from '@/components/admin/ui/AdminSkeleton';
import { AdminStatusPill } from '@/components/admin/ui/AdminStatusPill';

const HIGHLIGHT_NAMES = new Set(['admin_shell_v2', 'SEO_SERP_EXPERIMENT_ENABLED', 'SEO_SERP_EXPERIMENT_VARIANT', 'SEO_SERP_EXPERIMENT_TARGETS', 'SEO_SERP_EXPERIMENT_YEAR']);

export default function FlagSection() {
  const { user } = useAuth();
  const [parameters, setParameters] = useState<AdminRemoteConfigParameter[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = async () => {
    setLoading(true); setError(null);
    try { setParameters(await fetchAdminRemoteConfig(user)); } catch (err) { setError(err instanceof Error ? err.message : 'Flag non disponibili.'); } finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, [user]);
  const filtered = useMemo(() => { const value = query.trim().toLocaleLowerCase('it-CH'); return parameters.filter((parameter) => !value || `${parameter.name} ${parameter.description || ''} ${parameter.defaultValue || parameter.value || ''}`.toLocaleLowerCase('it-CH').includes(value)); }, [parameters, query]);
  return (
    <div className="space-y-6">
      <AdminSectionHeader title="Flag" summary="Istantanea in sola lettura dei parametri Remote Config. I valori sensibili arrivano solo come “valore nascosto”." secondaryActions={<AdminButton icon={<RefreshCw size={16} aria-hidden="true" />} loading={loading} onClick={() => void load()}>Aggiorna</AdminButton>} />
      {error && <p role="alert" className="rounded-stripe border border-danger-border bg-danger-subtle px-4 py-3 text-sm text-danger">{error}</p>}
      <div className="relative"><Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" aria-hidden="true" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Cerca parametro…" aria-label="Cerca parametro Remote Config" className="min-h-10 w-full rounded-stripe border border-edge bg-surface pl-9 pr-3 text-sm text-heading focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30" /></div>
      {loading && parameters.length === 0 ? <div className="rounded-stripe border border-edge bg-surface p-5"><AdminSkeleton lines={6} /></div> : <div className="space-y-3">{filtered.map((parameter) => {
        const hidden = parameter.hidden === true || parameter.value === 'valore nascosto';
        const highlighted = HIGHLIGHT_NAMES.has(parameter.name);
        return <article key={parameter.name} className={`rounded-stripe border p-4 ${highlighted ? 'border-accent-border bg-accent-subtle' : 'border-edge bg-surface'}`}><div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><h2 className="break-all font-mono text-sm font-semibold text-heading">{parameter.name}</h2>{parameter.description && <p className="mt-1 text-sm text-subtle">{parameter.description}</p>}</div><div className="flex items-center gap-2">{highlighted && <AdminStatusPill tone="info">In evidenza</AdminStatusPill>}{hidden && <AdminStatusPill tone="neutral">Protetto</AdminStatusPill>}</div></div><dl className="mt-3 grid gap-2 text-sm sm:grid-cols-[auto_1fr]"><dt className="font-semibold text-heading">Valore</dt><dd className="break-all text-subtle">{hidden ? <span>Valore nascosto · {parameter.reason || 'non è un flag'}</span> : <span className="font-mono">{parameter.defaultValue || '—'}</span>}</dd>{!hidden && parameter.conditionalValues?.length ? <><dt className="font-semibold text-heading">Condizioni</dt><dd className="space-y-1 text-subtle">{parameter.conditionalValues.map((entry) => <div key={entry.condition}><span className="font-medium text-heading">{entry.condition}</span>: <span className="font-mono">{entry.value || '—'}</span></div>)}</dd></> : null}</dl></article>;
      })}{!loading && filtered.length === 0 && <p className="rounded-stripe border border-edge bg-surface px-4 py-6 text-center text-sm text-subtle">Nessun parametro trovato.</p>}</div>}
    </div>
  );
}
