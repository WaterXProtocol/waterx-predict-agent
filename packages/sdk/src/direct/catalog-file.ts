/**
 * Market titles, slugs and schedules, remembered between processes.
 *
 * The public routes cannot look a market up by the id direct mode issues, so
 * what `market list` / `search` learned is kept here — by the CLI that learns
 * it and by a Runner that trades the same ids. Not a credential and not
 * authority: the id itself carries everything an order needs, and a lost entry
 * costs a title and a live phase read, never a trade.
 *
 * A long-running reader re-reads the file when it meets an id it does not know
 * and the file has changed since, so a market the CLI resolved after the Runner
 * started is still found.
 */
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';

import type { CatalogEntry, MarketCatalog } from './client.ts';

export class FileMarketCatalog implements MarketCatalog {
  private static readonly LIMIT = 500;
  private readonly path: string;
  private entries: Map<string, CatalogEntry> | undefined;
  private loadedMtimeMs = -1;

  constructor(path: string) {
    this.path = path;
  }

  private mtime(): number {
    try {
      return statSync(this.path).mtimeMs;
    } catch {
      return -1;
    }
  }

  private load(force = false): Map<string, CatalogEntry> {
    if (this.entries !== undefined && !force) return this.entries;
    this.loadedMtimeMs = this.mtime();
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as CatalogEntry[];
      this.entries = new Map(Array.isArray(parsed) ? parsed.map((entry) => [entry.marketId, entry]) : []);
    } catch {
      this.entries = new Map();
    }
    return this.entries;
  }

  get(marketId: string): CatalogEntry | undefined {
    const found = this.load().get(marketId);
    if (found !== undefined || this.mtime() === this.loadedMtimeMs) return found;
    return this.load(true).get(marketId);
  }

  put(entries: readonly CatalogEntry[]): void {
    // Merged into what is on disk now, not what this process read at start.
    const map = this.load(this.mtime() !== this.loadedMtimeMs);
    for (const entry of entries) {
      map.delete(entry.marketId);
      map.set(entry.marketId, entry);
    }
    const kept = [...map.values()].slice(-FileMarketCatalog.LIMIT);
    this.entries = new Map(kept.map((entry) => [entry.marketId, entry]));
    try {
      const dir = this.path.slice(0, this.path.lastIndexOf('/'));
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const temporary = `${this.path}.${String(process.pid)}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(kept)}\n`, { mode: 0o600 });
      renameSync(temporary, this.path);
      this.loadedMtimeMs = this.mtime();
    } catch {
      // A title that is not remembered is a title, not an order.
    }
  }
}
