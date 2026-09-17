/** The market catalog two processes share: the CLI writes it, a Runner reads it. */
import { mkdtempSync, rmSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { FileMarketCatalog } from '../src/direct/catalog-file.ts';
import type { CatalogEntry } from '../src/direct/client.ts';

const entry = (marketId: string): CatalogEntry => ({
  marketId,
  title: `market ${marketId}`,
  category: 'politics',
  status: 'PREGAME',
  closesAt: null,
  eventId: null,
  slug: `slug-${marketId}`,
});

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('FileMarketCatalog', () => {
  it('shows a reader what a writer added after the reader started, and keeps the file private', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wxp-catalog-'));
    dirs.push(dir);
    const path = join(dir, 'state', 'direct-markets.json');
    const reader = new FileMarketCatalog(path);
    expect(reader.get('m1')).toBeUndefined();

    const writer = new FileMarketCatalog(path);
    writer.put([entry('m1')]);
    // Force a visibly different mtime even on a coarse filesystem clock.
    const later = new Date(Date.now() + 2_000);
    utimesSync(path, later, later);
    expect(reader.get('m1')?.title).toBe('market m1');
    expect(statSync(path).mode & 0o777).toBe(0o600);

    // A write merges with what is on disk, not with what the writer read first.
    reader.put([entry('m2')]);
    const fresh = new FileMarketCatalog(path);
    expect(fresh.get('m1')).toBeDefined();
    expect(fresh.get('m2')).toBeDefined();
  });
});
