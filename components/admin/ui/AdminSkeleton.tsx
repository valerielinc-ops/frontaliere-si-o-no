export function AdminSkeleton({ lines = 3, className = '' }: { lines?: number; className?: string }) {
  return (
    <div className={`space-y-3 ${className}`} role="status" aria-label="Caricamento dati">
      {Array.from({ length: lines }, (_, index) => (
        <div
          key={index}
          className={`h-4 animate-pulse rounded-stripe bg-surface-raised ${index === lines - 1 ? 'w-2/3' : 'w-full'}`}
        />
      ))}
    </div>
  );
}
