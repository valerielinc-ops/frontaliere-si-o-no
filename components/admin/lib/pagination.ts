export const ADMIN_PAGE_SIZE = 50;

export function pageCount(total: number, pageSize = ADMIN_PAGE_SIZE): number {
  return Math.max(1, Math.ceil(Math.max(0, total) / pageSize));
}

export function clampPage(page: number, total: number, pageSize = ADMIN_PAGE_SIZE): number {
  return Math.min(Math.max(1, page), pageCount(total, pageSize));
}

export function pageSlice<T>(items: readonly T[], page: number, pageSize = ADMIN_PAGE_SIZE): T[] {
  const safePage = clampPage(page, items.length, pageSize);
  return items.slice((safePage - 1) * pageSize, safePage * pageSize);
}
