import { ChevronLeft, ChevronRight } from 'lucide-react';
import { AdminButton } from './AdminButton';
import { clampPage, pageCount } from '../lib/pagination';

export function AdminPagination({ page, total, onPageChange, pageSize = 50 }: { page: number; total: number; onPageChange: (page: number) => void; pageSize?: number }) {
  const pages = pageCount(total, pageSize);
  const current = clampPage(page, total, pageSize);
  if (pages <= 1) return null;
  return (
    <nav className="flex flex-wrap items-center justify-between gap-2" aria-label="Paginazione">
      <span className="text-sm text-subtle">Pagina {current} di {pages} · {total.toLocaleString('it-IT')} elementi</span>
      <div className="flex items-center gap-2">
        <AdminButton icon={<ChevronLeft size={15} aria-hidden="true" />} aria-label="Pagina precedente" disabled={current <= 1} onClick={() => onPageChange(current - 1)}>Precedente</AdminButton>
        <AdminButton icon={<ChevronRight size={15} aria-hidden="true" />} aria-label="Pagina successiva" disabled={current >= pages} onClick={() => onPageChange(current + 1)}>Successiva</AdminButton>
      </div>
    </nav>
  );
}
