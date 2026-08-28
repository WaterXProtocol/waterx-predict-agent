#!/usr/bin/env node
/**
 * `pnpm registry` — serve this workspace's publishable packages, so
 * `npm install <name>` resolves by NAME.
 *
 *   node dist/src/bin/registry.js [--port 4873]
 *
 * The one step a kit cannot cover. Installing a tarball by path answers "which
 * package?" in advance, and for an installation experience under observation
 * that is the first question rather than an incidental one.
 *
 * Scoped, never global. A consumer points only this workspace's scope here, so
 * every real dependency still comes from the public registry and the install has
 * the same shape a published one would. It serves what `publishedPackages`
 * reports and nothing else, so a package that is `private` cannot be reached
 * through it — the same rule the SBOM and the preflight are held to.
 *
 * It packs at startup. Rebuild, then restart it.
 */
import { createReadStream, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildPackuments, npmrcFor, packPublished, resolveRegistryRequest } from '../consumer.ts';
import { findRepoRoot } from '../workspace.ts';

function main(argv: readonly string[]): number {
  const portFlag = argv.indexOf('--port');
  const port = portFlag === -1 ? 4873 : Number(argv[portFlag + 1]);
  if (!Number.isInteger(port) || port <= 0) {
    process.stderr.write('usage: registry [--port <n>]\n');
    return 2;
  }

  const origin = `http://127.0.0.1:${String(port)}`;
  const staging = mkdtempSync(join(tmpdir(), 'waterx-registry-'));
  const artifacts = packPublished(findRepoRoot(), staging);
  if (artifacts.length === 0) {
    process.stderr.write('nothing is publishable, so there is nothing to serve.\n');
    rmSync(staging, { recursive: true, force: true });
    return 1;
  }
  const packuments = buildPackuments(artifacts, origin);
  for (const artifact of artifacts) {
    process.stderr.write(`serving ${artifact.name}@${artifact.version}\n`);
  }

  const server = createServer((request, response) => {
    // npm asks for `@scope%2fname`; the router works on a decoded path.
    const pathname = decodeURIComponent(new URL(request.url ?? '/', origin).pathname);
    const resolved = resolveRegistryRequest(pathname, packuments, artifacts);

    if (resolved.kind === 'tarball') {
      response.writeHead(200, { 'content-type': 'application/octet-stream' });
      createReadStream(resolved.filePath).pipe(response);
      return;
    }
    if (resolved.kind === 'packument') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(resolved.body));
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: resolved.message }));
  });

  const shutdown = (): void => {
    server.close();
    rmSync(staging, { recursive: true, force: true });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  server.listen(port, '127.0.0.1', () => {
    process.stderr.write(`\nregistry on ${origin}\n`);
    process.stderr.write('point a consumer at it with a project-local `.npmrc`:\n');
    for (const line of npmrcFor(artifacts, origin).trimEnd().split('\n')) {
      process.stderr.write(`  ${line}\n`);
    }
    process.stderr.write('project-local, so nothing has to be undone afterwards.\n');
  });
  return 0;
}

process.exitCode = main(process.argv.slice(2));
