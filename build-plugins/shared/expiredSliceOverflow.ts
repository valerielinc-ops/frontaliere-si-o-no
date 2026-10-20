import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expiredJobSlugVariants } from './expiredSlugVariants';

type Entry = { offset: number; length: number; recency: number };

/** Disk-backed long tail: retain alias/recency metadata, not every description. */
export class ExpiredSliceOverflow<T> {
  private entries = new Map<string, Entry>();
  private dir?: string;
  private fd?: number;
  private end = 0;
  private cached?: { entry: Entry; job: T };
  private closed = false;

  constructor(private readonly tempRoot = os.tmpdir()) {}

  get size(): number { return this.entries.size; }
  has(slug: string): boolean { return this.entries.has(slug); }
  recency(slug: string): number | undefined { return this.entries.get(slug)?.recency; }

  add(slugs: string[], job: T, recency: number): void {
    if (this.closed) throw new Error('Expired slice overflow is closed');
    const missing = [...new Set(slugs)].filter((slug) => !this.entries.has(slug));
    if (missing.length === 0) return;
    if (this.fd === undefined) {
      this.dir = fs.mkdtempSync(path.join(this.tempRoot, 'jobs-expired-overflow-'));
      this.fd = fs.openSync(path.join(this.dir, 'records.jsonl'), 'wx+', 0o600);
    }
    const bytes = Buffer.from(JSON.stringify(job) + '\n');
    const entry = { offset: this.end, length: bytes.length, recency };
    let written = 0;
    while (written < bytes.length) {
      const count = fs.writeSync(this.fd, bytes, written, bytes.length - written, this.end + written);
      if (count === 0) throw new Error('Incomplete expired slice overflow write');
      written += count;
    }
    this.end += bytes.length;
    for (const slug of missing) this.entries.set(slug, entry);
  }

  get(slug: string): T | undefined {
    const entry = this.entries.get(slug);
    if (!entry) return undefined;
    if (this.cached?.entry === entry) return this.cached.job;
    if (this.fd === undefined) throw new Error('Expired slice overflow is unavailable');
    const bytes = Buffer.allocUnsafe(entry.length);
    let read = 0;
    while (read < bytes.length) {
      const count = fs.readSync(this.fd, bytes, read, bytes.length - read, entry.offset + read);
      if (count === 0) throw new Error('Incomplete expired slice overflow read');
      read += count;
    }
    const job = JSON.parse(bytes.toString('utf8')) as T;
    // One record only; aliases often render consecutively, but a full cache
    // would defeat the memory limit that required the spill in the first place.
    this.cached = { entry, job };
    return job;
  }

  close(): void {
    this.closed = true;
    this.entries.clear();
    this.cached = undefined;
    if (this.fd !== undefined) {
      fs.closeSync(this.fd);
      this.fd = undefined;
    }
    if (this.dir) {
      fs.rmSync(path.join(this.dir, 'records.jsonl'), { force: true });
      fs.rmdirSync(this.dir);
      this.dir = undefined;
    }
  }
}

/** First-owner indexing across both tiers; reaching the RAM cap never ends input. */
export function augmentExpiredSliceIndex<T extends Parameters<typeof expiredJobSlugVariants>[0]>(
  jobs: Iterable<T>, emittedSlugs: Set<string>, primary: Map<string, T>,
  overflow: ExpiredSliceOverflow<T>, memoryLimit: number, recency: (job: T) => number,
): number {
  let retained = 0;
  for (const job of jobs) {
    const overflowVariants: string[] = [];
    for (const slug of expiredJobSlugVariants(job)) {
      if (!emittedSlugs.has(slug) || primary.has(slug) || overflow.has(slug)) continue;
      if (retained < memoryLimit) {
        primary.set(slug, job);
        retained++;
      } else {
        overflowVariants.push(slug);
      }
    }
    overflow.add(overflowVariants, job, recency(job));
  }
  return retained;
}
