import { afterEach, describe, expect, it, vi } from 'vitest';
import { readBestEffortLocalStorage, writeBestEffortLocalStorage } from '@/services/storageAvailability';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('best-effort local storage preferences', () => {
  it('keeps a page-lifetime fallback when writes are blocked', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage blocked');
    });

    writeBestEffortLocalStorage('storage-test-write', 'true');
    expect(readBestEffortLocalStorage('storage-test-write')).toBe('true');
  });

  it('reads the fallback when browser reads are blocked', () => {
    writeBestEffortLocalStorage('storage-test-read', 'en');
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage blocked');
    });

    expect(readBestEffortLocalStorage('storage-test-read')).toBe('en');
  });
});
