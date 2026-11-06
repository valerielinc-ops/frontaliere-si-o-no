export const ADMIN_PAGE_SIZE = 50;

function normalizePageSize(pageSize: number): number {
  return Number.isInteger(pageSize) && pageSize > 0 ? pageSize : ADMIN_PAGE_SIZE;
}

function normalizeTotal(total: number): number {
  return Number.isFinite(total) ? Math.max(0, total) : 0;
}

function normalizePage(page: number): number {
  return Number.isFinite(page) ? Math.max(1, Math.floor(page)) : 1;
}

export function pageCount(total: number, pageSize = ADMIN_PAGE_SIZE): number {
  return Math.max(1, Math.ceil(normalizeTotal(total) / normalizePageSize(pageSize)));
}

export function clampPage(page: number, total: number, pageSize = ADMIN_PAGE_SIZE): number {
  return Math.min(normalizePage(page), pageCount(total, pageSize));
}

export function pageSlice<T>(items: readonly T[], page: number, pageSize = ADMIN_PAGE_SIZE): T[] {
  const safePageSize = normalizePageSize(pageSize);
  const safePage = clampPage(page, items.length, safePageSize);
  return items.slice((safePage - 1) * safePageSize, safePage * safePageSize);
}
