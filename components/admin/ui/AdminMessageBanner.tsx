export type AdminMessage = { kind: 'ok' | 'warn' | 'error'; text: string };

export function AdminMessageBanner({ message }: { message: AdminMessage | null }) {
  if (!message) return null;
  const styles = message.kind === 'ok'
    ? 'bg-success-subtle border-success-border text-success'
    : message.kind === 'warn'
      ? 'bg-warning-subtle border-warning-border text-warning'
      : 'bg-danger-subtle border-danger-border text-danger';
  return (
    <div role={message.kind === 'error' ? 'alert' : 'status'} className={`rounded-lg border px-3 py-2 text-xs ${styles}`}>
      {message.text}
    </div>
  );
}

