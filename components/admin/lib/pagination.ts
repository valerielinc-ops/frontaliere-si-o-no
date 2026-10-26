export const ADMIN_PAGE_SIZE = 50;

function normalizeTotal(total: number): number {
  return Number.isFinite(total) && total >= 0 ? total : 0;
}

function normalizePage(page: number): number {
  return Number.isInteger(page) && page >= 1 ? page : 1;
}

export function pageCount(total: number, pageSize = ADMIN_PAGE_SIZE): number {
  return Math.max(1, Math.ceil(normalizeTotal(total) / pageSize));
}

export function clampPage(page: number, total: number, pageSize = ADMIN_PAGE_SIZE): number {
  return Math.min(normalizePage(page), pageCount(total, pageSize));
}

export function pageSlice<T>(items: readonly T[], page: number, pageSize = ADMIN_PAGE_SIZE): T[] {
  const safePage = clampPage(page, items.length, pageSize);
  return items.slice((safePage - 1) * pageSize, safePage * pageSize);
}
