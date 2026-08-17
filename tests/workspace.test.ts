/**
 * Cross-package invariants.
 *
 * A directory layout is not a boundary. What makes `packages/*` mean something
 * is that a violation fails a test: the SDK staying free of daemon, CLI and
 * adapter dependencies is the whole reason for the split (ADR-0001 §4), and
 * nothing inside a single package can check it.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { CAPABILITIES } from '../packages/cli/src/capabilities.ts';
import {
  openRunnerSession,
  RUNNER_IPC_PROTOCOL as CLI_IPC_PROTOCOL,
  type RunnerSocket,
} from '../packages/cli/src/runner-ipc.ts';
import { SIGNER_PROTOCOL as CLI_SIGNER_PROTOCOL } from '../packages/cli/src/signer.ts';
import { RUNNER_IPC_COMMANDS } from '../packages/runner/src/ipc/commands.ts';
import {
  decodeClientFrame,
  RUNNER_IPC_PROTOCOL as RUNNER_IPC_PROTOCOL_SELF,
} from '../packages/runner/src/ipc/protocol.ts';
import { SIGNER_PROTOCOL as RUNNER_SIGNER_PROTOCOL } from '../packages/runner/src/signer.ts';
import { JOB_STATES } from '../packages/runner/src/state-machine.ts';
import { AGENT_COMMANDS, type JsonSchema } from '../packages/schema/src/index.ts';
import { PredictAgentClient } from '../packages/sdk/src/index.ts';

/** Repository root, with a trailing slash. */
const ROOT = fileURLToPath(new URL('../', import.meta.url));

const read = (relativePath: string): string => readFileSync(`${ROOT}${relativePath}`, 'utf8');
const readJson = (relativePath: string): Record<string, unknown> =>
  JSON.parse(read(relativePath)) as Record<string, unknown>;

const PACKAGE_DIRS = readdirSync(`${ROOT}packages`).filter((entry) =>
  statSync(`${ROOT}packages/${entry}`).isDirectory(),
);

/** Packages that ship to a registry. Everything else must be `private`. */
const PUBLISHED = new Set(['sdk', 'schema']);

/**
 * Implemented, but deliberately unreleased: real code, real tests, `private`
 * until the release work in the backlog is done. The distinction from RESERVED
 * matters — these have to look like packages, and must still not be publishable
 * by accident.
 */
const INTERNAL = new Set(['cli', 'runner']);

/** Reserved boundaries with no implementation. They must not look like one. */
const RESERVED = new Set(['mcp']);

/**
 * Test harnesses. They drive the shipped artifacts and are never shipped
 * themselves, so they may depend on anything in the workspace — including the
 * unpublished CLI — and must never be publishable.
 */
const HARNESS = new Set(['e2e']);

interface PackageManifest {
  readonly name?: string;
  readonly private?: boolean;
  readonly type?: string;
  readonly main?: string;
  readonly types?: string;
  readonly bin?: unknown;
  readonly exports?: unknown;
  readonly files?: readonly string[];
  readonly license?: string;
  readonly engines?: Readonly<Record<string, string>>;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly scripts?: Readonly<Record<string, string>>;
}

const manifest = (dir: string): PackageManifest =>
  readJson(`packages/${dir}/package.json`) as PackageManifest;

describe('workspace layout', () => {
  it('accounts for every package directory', () => {
    expect(new Set(PACKAGE_DIRS)).toEqual(
      new Set([...PUBLISHED, ...INTERNAL, ...RESERVED, ...HARNESS]),
    );
  });

  it('is covered by the pnpm workspace glob', () => {
    expect(read('pnpm-workspace.yaml')).toContain("'packages/*'");
  });

  it('keeps the workspace root private and unpublishable', () => {
    const root = readJson('package.json') as PackageManifest;
    expect(root.private).toBe(true);
    expect(root.main).toBeUndefined();
    expect(root.exports).toBeUndefined();
  });

  it('gives every package a README that names it', () => {
    for (const dir of PACKAGE_DIRS) {
      expect(read(`packages/${dir}/README.md`), dir).toContain(manifest(dir).name ?? dir);
    }
  });
});

describe('dependency direction', () => {
  const WORKSPACE_NAMES = new Set(PACKAGE_DIRS.map((dir) => manifest(dir).name));

  const workspaceEdges = (dir: string): string[] => {
    const pkg = manifest(dir);
    return [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ].filter((name) => WORKSPACE_NAMES.has(name));
  };

  it('keeps the SDK at the bottom, depending on nothing else in the workspace', () => {
    // The SDK is the execution core. A dependency on the schema, the CLI or the
    // Runner would drag their dependencies into the published library.
    expect(workspaceEdges('sdk')).toEqual([]);
  });

  it('keeps the schema independent of the SDK', () => {
    // The command contract has to be readable by a surface that cannot import a
    // Node client — that is why it is published as plain JSON at all.
    expect(workspaceEdges('schema')).toEqual([]);
  });

  it('lets a published package take only a runtime dependency that was argued for', () => {
    // Every dependency here is installed into every consumer of this library, so
    // the list is an allowlist rather than a limit: adding one means editing this
    // test, which means saying why. `socket.io-client` is the official client for
    // the protocol the server's stream actually speaks, and re-implementing it
    // over raw `ws` would be a second, worse copy of it — the argument is written
    // out at the top of `packages/sdk/src/execution-stream.ts`.
    const ALLOWED = new Map([['sdk', ['socket.io-client']]]);
    for (const dir of PUBLISHED) {
      expect(Object.keys(manifest(dir).dependencies ?? {}).sort(), dir).toEqual(
        ALLOWED.get(dir) ?? [],
      );
    }
  });

  it('keeps the one runtime dependency behind a lazy import', () => {
    // A top-level `import 'socket.io-client'` would load the transport for every
    // caller — including a CLI that only reads a market — and would turn a pruned
    // or unavailable dependency into a crash at module load instead of a stream
    // that degrades to polling.
    for (const file of sourceFiles('packages/sdk/src')) {
      expect(read(file), file).not.toMatch(/^import .*'socket\.io-client'/mu);
    }
    for (const file of ['execution-stream.ts', 'quote-stream.ts']) {
      expect(read(`packages/sdk/src/${file}`), file).toContain("await import('socket.io-client')");
    }
  });

  it('points the CLI at both published packages and nothing else', () => {
    // The CLI is a surface over the core, not a peer of it. Its only workspace
    // edges are the two packages it compiles the same intent through.
    expect(workspaceEdges('cli').sort()).toEqual([
      '@waterx/predict-agent-schema',
      '@waterx/predict-agent-sdk',
    ]);
  });

  it('never lets a published package import an unpublished one, in source', () => {
    // A published package importing `@waterx/predict-agent-cli` would name a
    // dependency that does not exist on any registry.
    const unpublishedNames = [...RESERVED, ...INTERNAL, ...HARNESS].map(
      (dir) => manifest(dir).name ?? dir,
    );
    for (const dir of PUBLISHED) {
      for (const file of sourceFiles(`packages/${dir}/src`)) {
        for (const name of unpublishedNames) {
          expect(read(file), `${file} imports ${name}`).not.toContain(`from '${name}'`);
        }
      }
    }
  });

  it('never lets the schema reach into another package by relative path', () => {
    for (const file of sourceFiles('packages/schema/src')) {
      expect(read(file), file).not.toMatch(/from '\.\.\/\.\.\//u);
    }
  });
});

describe('published package hygiene', () => {
  it('keeps the SDK import surface exactly where it was before the split', () => {
    // Moving the sources must not move the published entry points. A consumer's
    // `import { PredictAgentClient } from '@waterx/predict-agent-sdk'` has to
    // resolve to the same file it did before.
    const pkg = manifest('sdk');
    expect(pkg.name).toBe('@waterx/predict-agent-sdk');
    expect(pkg.main).toBe('dist/src/index.js');
    expect(pkg.types).toBe('dist/src/index.d.ts');
    expect(pkg.exports).toEqual({
      '.': { types: './dist/src/index.d.ts', import: './dist/src/index.js' },
    });
  });

  it('declares a coherent, ESM, Node 20+ surface for each published package', () => {
    for (const dir of PUBLISHED) {
      const pkg = manifest(dir);
      expect(pkg.private, dir).toBeUndefined();
      expect(pkg.type, dir).toBe('module');
      expect(pkg.license, dir).toBe('MIT');
      expect(pkg.engines?.node, dir).toBe('>=20');
      expect(pkg.files, dir).toContain('dist');
      expect(pkg.files, dir).toContain('LICENSE');
      // A `files` list that promises a LICENSE the package does not have ships a
      // package without one.
      expect(() => read(`packages/${dir}/LICENSE`), dir).not.toThrow();
      for (const script of ['build', 'typecheck', 'test']) {
        expect(pkg.scripts?.[script], `${dir}: ${script}`).toBeTypeOf('string');
      }
    }
  });
});

describe('the CLI package', () => {
  it('is implemented but stays unpublishable', () => {
    // `private` is the release gate. The CLI is real code with real tests, but
    // an accidental `npm publish` would ship a binary the backlog has not
    // finished (release is 3.6), under a name nobody has claimed.
    const pkg = manifest('cli');
    expect(pkg.private).toBe(true);
    expect(pkg.type).toBe('module');
    expect(pkg.engines?.node).toBe('>=20');
    for (const script of ['build', 'typecheck', 'test']) {
      expect(pkg.scripts?.[script], script).toBeTypeOf('string');
    }
  });

  it('exposes one binary, from built output rather than source', () => {
    // A `bin` pointing at a `.ts` file works on the author's machine and
    // nowhere else.
    expect(manifest('cli').bin).toEqual({ 'waterx-predict': 'dist/src/main.js' });
  });

  it('never writes to stdout outside the one writer that owns it', () => {
    // stdout carries exactly one JSON document per invocation (plan §6.3). A
    // stray `console.log` anywhere in the CLI silently corrupts every caller's
    // parse, so the ban is structural rather than a review habit.
    for (const file of sourceFiles('packages/cli/src')) {
      if (file.endsWith('/output.ts')) continue;
      const source = read(file);
      expect(source, `${file} writes to stdout`).not.toMatch(/console\.log|process\.stdout/u);
    }
  });
});

describe('the Runner package', () => {
  it('is unpublishable, and depends on nothing outside the workspace', () => {
    // This package will hold the signer, so a runtime dependency here is a
    // decision to widen the trust boundary around the keys (ADR-0007). Adding one
    // means editing this test, which means saying why.
    const pkg = manifest('runner');
    expect(pkg.private).toBe(true);
    expect(pkg.type).toBe('module');
    // Both are workspace packages with no external dependency of their own, so
    // neither widens what runs inside the process that holds the keys. The schema
    // is here so the IPC socket validates against the SAME command contract every
    // other surface does, rather than becoming a second command surface.
    expect(Object.keys(pkg.dependencies ?? {}).sort()).toEqual([
      '@waterx/predict-agent-schema',
      '@waterx/predict-agent-sdk',
    ]);
    for (const specifier of Object.values(pkg.dependencies ?? {})) {
      expect(specifier).toBe('workspace:*');
    }
    for (const script of ['build', 'typecheck', 'test']) {
      expect(pkg.scripts?.[script], script).toBeTypeOf('string');
    }
  });

  it('declares the higher Node floor its store engine costs', () => {
    // `node:sqlite` instead of a native binding, so no compiler and no postinstall
    // script runs inside the process that holds the keys. The price is Node 24
    // here while the published packages stay at 20 — checked rather than
    // commented, because a floor that drifts is a floor nobody can rely on.
    expect(manifest('runner').engines?.node).toBe('>=24');
    expect(manifest('sdk').engines?.node).toBe('>=20');
  });

  it('keeps the SQLite engine behind the store interface', () => {
    // The JobStore interface exists so a managed Runner could implement the same
    // semantics on a different database. An engine import above `src/sqlite/`
    // would quietly make that impossible.
    for (const file of sourceFiles('packages/runner/src')) {
      if (file.startsWith('packages/runner/src/sqlite/')) continue;
      expect(read(file), `${file} imports the engine`).not.toContain("'node:sqlite'");
    }
  });

  it('says in its README which half of the Runner exists', () => {
    // The daemon, its socket, `driveJob`, the loop that calls it, the price
    // source, the signer, the configuration that assembles them, the `strategy.*`
    // commands and now a CLI that speaks this protocol are all built, so an
    // operator really can arm a durable strategy from a terminal. What is *not*
    // built is this daemon's lifecycle: nothing starts or supervises a `runnerd`
    // for them, and the device has to stay awake. A README that stopped saying so
    // would let a reader conclude `strategy create` is enough on its own — so the
    // remaining absence has to survive in prose, and so does `driving: false`,
    // which is what an unconfigured process still reports.
    const readme = read('packages/runner/README.md');
    expect(readme).toContain('**not implemented**');
    expect(readme.toLowerCase()).toContain('daemon');
    expect(readme).toContain('driving: false');
    expect(readme).toContain(
      'Starting, stopping or supervising this daemon from the CLI | **not implemented**',
    );
    expect(readme).toContain('stay awake and online');
    // The mandate is the load-bearing one now that a socket peer can arm a job:
    // it comes from this host, and the default refuses.
    expect(readme).toContain('The mandate is configuration, never a request');
    expect(readme).toContain('default is `interactive`');
    // The configuration's two load-bearing refusals, which an operator reads the
    // README to learn: it holds no token at all, and it will not build half a
    // driver. Both are the difference between a Runner that authenticates itself
    // for seven days and one that creates an order it cannot sign.
    expect(readme).toContain('There is no token setting, from anywhere');
    expect(readme).toContain('all-or-nothing');
    // The signer exists here now, and the two refusals are the part that must not
    // be quietly dropped from the prose if someone later "simplifies" the gate.
    expect(readme).toContain('Signer inside the Runner trust boundary, over an external command');
    expect(readme).toContain('`interactive` is refused');
    expect(readme).toContain('Only `delegated-auto` signs');
  });

  it('keeps the price observer from ageing a price into an answer', () => {
    // The observer's whole contract is that silence stays silence. If it ever
    // learned to mint a quote to fill a gap it would need a size a `WatchKey`
    // deliberately does not carry, and would be pricing an order off an
    // indicative observation — so it must not reach the SDK's request-building
    // surface at all, and it must read staleness through the one helper that
    // returns null for it.
    // Checked as imports, not as prose: the file's header explains at length why
    // it will not build a quote request, and naming the type there is the
    // explanation rather than a violation of it.
    const prices = read('packages/runner/src/prices.ts');
    expect(prices).toContain('streamTriggerPrice');
    expect(prices).not.toMatch(/^\s*(?:type )?CreateQuoteRequestBody,?$/m);
    expect(prices).not.toContain('quoteRequestFor');
    expect(prices).not.toContain('getQuote');
  });

  it('keeps the honest `driving` flag out of reach of a typo', () => {
    // The one field a client reads to tell reachable from running. It is now
    // computed — but from exactly one thing, whether a scheduler is ticking, and
    // never written as a literal beside a `driving:` key. Constructing a
    // scheduler is still a decision the caller makes by supplying a driver; this
    // assertion is the reminder that it must not become an inference from
    // anything else.
    const daemon = read('packages/runner/src/daemon.ts');
    expect(daemon).toContain('return this.scheduler?.started ?? false;');
    expect(daemon).not.toMatch(/driving:\s*(true|false)/);
  });

  it('serves strategies over the socket from the one implementation, under a mandate from this host', () => {
    // Two rules, both structural rather than documentary.
    //
    // The socket must not acquire its own idea of what a strategy is: it holds a
    // `StrategyService` and calls it. A dispatcher that imported `normalizeStrategy`
    // or `resolveExpiry` would be a second sizing/expiry implementation reachable
    // from a different surface, which is how a socket client and an embedder end
    // up disagreeing about what "sell half" means.
    const dispatch = read('packages/runner/src/ipc/dispatch.ts');
    expect(dispatch).toContain('context.strategies.create');
    expect(dispatch).not.toContain('normalizeStrategy');
    expect(dispatch).not.toContain('resolveExpiry');
    expect(dispatch).not.toContain('BETA_MAX_EXPIRY_MS');

    // And the mandate is never the caller's. A `policy` read off the request would
    // let a socket peer grant itself the authority to sign unattended, so the
    // input schema has no such field and the dispatcher reads only the context.
    expect(dispatch).toContain('policy: context.admissionPolicy');
    expect(dispatch).not.toContain("input['policy']");
    expect(read('packages/runner/src/ipc/commands.ts')).not.toMatch(/^\s*policy:/m);
  });

  it('ships a `runnerd` that builds no driver, and therefore promises nothing', () => {
    // The binary an operator actually starts. It has no way to construct a
    // signer, and no configured stream to put a price observer over, so it must
    // not pass a `driver` — and it must
    // print what the daemon reports rather than a literal that would keep saying
    // `false` after this file learned how.
    const bin = read('packages/runner/src/bin/runnerd.ts');
    expect(bin).not.toMatch(/^\s*driver:/m);
    expect(bin).toContain('driving: handle.driving');
  });
});

describe('the local signing protocol', () => {
  it('is one wire, spoken identically by the CLI and the Runner', () => {
    // The two implementations are deliberately separate: the CLI must not depend
    // on a daemon and the Runner must not depend on a CLI, so neither can import
    // the other's signer. That leaves the wire itself as the shared thing, and an
    // operator who configured one keystore command has to be able to point the
    // other at it unchanged — a drift here would be discovered by a signer
    // refusing a request in the middle of a triggered order.
    expect(RUNNER_SIGNER_PROTOCOL).toEqual(CLI_SIGNER_PROTOCOL);
    // Pinned, so a change to both at once is still a decision someone states.
    expect(RUNNER_SIGNER_PROTOCOL.version).toBe(1);
  });

  it('is enforced against what each side actually writes, not just declared', () => {
    // A descriptor two packages agree on is worth nothing if neither is held to
    // it. Each package asserts its own request has exactly these keys; this names
    // the tests that do it, so deleting one is visible here.
    expect(read('packages/cli/tests/signer.test.ts')).toContain('SIGNER_PROTOCOL.requests');
    expect(read('packages/runner/tests/signer.test.ts')).toContain('SIGNER_PROTOCOL');
  });

  it('keeps the two implementations from importing each other', () => {
    const cli = read('packages/cli/src/signer.ts');
    const runner = read('packages/runner/src/signer.ts');
    expect(cli).not.toContain('predict-agent-runner');
    expect(runner).not.toContain('predict-agent-cli');
  });
});

describe('the local Runner IPC protocol', () => {
  it('is one wire, spoken identically by the CLI and the Runner', () => {
    // Same arrangement, and same reason, as the signing protocol above: the CLI
    // must not depend on the Runner, so the wire is the shared thing. The drift
    // this catches is worse than a signer's, because it is silent — a CLI looking
    // for `runner.sock` in a directory the daemon no longer uses reports "no
    // Runner is listening" against a machine where one is, in the minute an
    // operator is trying to cancel something.
    expect(CLI_IPC_PROTOCOL).toEqual(RUNNER_IPC_PROTOCOL_SELF);
    // Pinned, so changing both at once is still a decision someone states.
    expect(CLI_IPC_PROTOCOL.version).toBe(1);
  });

  it('is checked against the frames the CLI really writes, through the Runner’s real decoder', async () => {
    // The part that makes the duplicated descriptor safe rather than hopeful.
    // Two matching literals prove nothing if the client builds something else, so
    // these are the CLI's own frames, from `openRunnerSession`, parsed by the
    // function the daemon actually runs on every line it receives.
    const written = await framesTheCliWrites();
    const decoded = written.map((line) => decodeClientFrame(line));
    expect(decoded.map((frame) => frame.type)).toEqual(
      CLI_IPC_PROTOCOL.clientFrames.map((frame) => frame.type),
    );
    for (const [index, expected] of CLI_IPC_PROTOCOL.clientFrames.entries()) {
      const raw = JSON.parse(written[index] ?? '{}') as Record<string, unknown>;
      expect(Object.keys(raw).sort(), expected.type).toEqual([...expected.fields].sort());
    }
  });

  it('keeps the two implementations from importing each other', () => {
    expect(read('packages/cli/src/runner-ipc.ts')).not.toContain('predict-agent-runner');
    expect(read('packages/runner/src/ipc/protocol.ts')).not.toContain('predict-agent-cli');
  });

  it('names the same strategy family in the contract, on the socket, and in the descriptor', () => {
    // Three lists that must not drift: what an agent may ask for, what the daemon
    // will answer, and what the descriptor says the family is. A command in the
    // contract with no schema on the socket is one an adapter advertises and the
    // Runner rejects as unknown.
    const contract = AGENT_COMMANDS.filter((command) => command.name.startsWith('strategy.')).map(
      (command) => command.name,
    );
    const served = Object.keys(RUNNER_IPC_COMMANDS).filter((name) => name.startsWith('strategy.'));
    expect([...CLI_IPC_PROTOCOL.strategyCommands]).toEqual(contract);
    expect(served.sort()).toEqual([...contract].sort());
  });

  it('describes the same strategy shape on both sides of the socket', () => {
    // Not the same schema — the socket's is looser on purpose, because the rules
    // live in `strategy/intent.ts` and a peer must get `SIZE_AMBIGUOUS` rather
    // than a schema violation. What must match is the SHAPE: a field an agent can
    // send that the socket rejects as unknown, or a field the socket requires and
    // the contract never mentions, is a create that fails at the daemon.
    for (const command of AGENT_COMMANDS) {
      if (!command.name.startsWith('strategy.')) continue;
      const served = RUNNER_IPC_COMMANDS[command.name];
      expect(served, command.name).toBeDefined();
      expect(keysOf(command.input), command.name).toEqual(keysOf(served));
      expect(requiredOf(command.input), command.name).toEqual(requiredOf(served));
    }

    // And the leg, which is where the four sizing fields live. All optional on
    // both sides; exactly one of them is `normalizeStrategy`'s to enforce.
    const contractLeg = commandDefs()['strategyLeg'];
    const servedLeg = ((RUNNER_IPC_COMMANDS['strategy.create']?.properties ?? {})['legs'] ?? {})
      .items;
    expect(keysOf(contractLeg)).toEqual(keysOf(servedLeg));
    expect(requiredOf(contractLeg)).toEqual(requiredOf(servedLeg));
    for (const sizing of [
      'buyAmount',
      'sellShares',
      'sellFractionOfPosition',
      'dynamicSellFractionOfPosition',
    ]) {
      expect(keysOf(contractLeg), sizing).toContain(sizing);
      expect(requiredOf(contractLeg), sizing).not.toContain(sizing);
    }
    // `expiresAt` is the same deliberate omission, and the one most likely to be
    // "fixed" by someone adding it to `required`. That would replace the sentence
    // about there being no permanent watcher with a schema violation.
    expect(keysOf(RUNNER_IPC_COMMANDS['strategy.create'])).toContain('expiresAt');
    expect(requiredOf(RUNNER_IPC_COMMANDS['strategy.create'])).not.toContain('expiresAt');
  });

  it('filters `strategy list` by the Runner’s own state machine, not by a copy of it', () => {
    const contract = (
      (AGENT_COMMANDS.find((command) => command.name === 'strategy.list')?.input.properties ?? {})[
        'state'
      ] ?? {}
    ).enum;
    expect(contract).toEqual(Object.keys(JOB_STATES));
    // PAUSED is the one an operator has to be able to ask for by name: a live
    // strategy that has stopped acting looks like a healthy one in every summary.
    expect(contract).toContain('PAUSED');
  });
});

const keysOf = (schema: JsonSchema | undefined): string[] =>
  Object.keys(schema?.properties ?? {}).sort();

const requiredOf = (schema: JsonSchema | undefined): string[] => [...(schema?.required ?? [])].sort();

/** The contract's `$defs`, read from the emitted document rather than re-derived. */
const commandDefs = (): Readonly<Record<string, JsonSchema>> =>
  (JSON.parse(read('schemas/v1/agent-commands.json')) as { $defs: Record<string, JsonSchema> }).$defs;

/**
 * Drives the CLI's real session against a socket that is not one.
 *
 * Deliberately not the Runner's server: this asserts the frames, and standing up
 * a daemon here would put a listening socket in the workspace suite for a
 * property that does not need one.
 */
async function framesTheCliWrites(): Promise<string[]> {
  const runtimeDir = '/tmp/waterx-workspace-test';
  const uid = process.getuid?.() ?? 0;
  const written: string[] = [];
  let onData: ((chunk: string) => void) | undefined;

  const socket: RunnerSocket = {
    write: (line) => {
      written.push(line);
      const frame = JSON.parse(line) as Record<string, unknown>;
      const reply =
        frame['type'] === 'hello'
          ? { v: CLI_IPC_PROTOCOL.version, type: 'hello-ok', instanceId: 'wf-1', driving: true }
          : {
              v: CLI_IPC_PROTOCOL.version,
              type: 'response',
              id: frame['id'],
              ok: true,
              result: { strategies: [] },
            };
      queueMicrotask(() => onData?.(`${JSON.stringify(reply)}\n`));
    },
    close: () => undefined,
    onData: (listener) => {
      onData = listener;
    },
    onClose: () => undefined,
  };

  const session = await openRunnerSession({
    runtimeDir,
    dial: () => Promise.resolve(socket),
    stat: (path) =>
      path === runtimeDir
        ? { kind: 'directory', uid, mode: 0o700 }
        : { kind: 'file', uid, mode: 0o600 },
    readFile: () => 'workspace-test-token',
    timeoutMs: 1_000,
    client: 'workspace-test',
  });
  await session.request('strategy.list', {});
  session.close();
  return written;
}

describe('the e2e harness package', () => {
  it('stays unpublishable and depends only on what it drives', () => {
    const pkg = manifest('e2e');
    expect(pkg.private).toBe(true);
    expect(pkg.type).toBe('module');
    expect(pkg.engines?.node).toBe('>=20');
    // It drives the CLI as a subprocess, so it resolves the CLI package. It has
    // no business reaching past that to the SDK: a harness that called the
    // client directly would stop testing the surface a user actually runs.
    expect(Object.keys(pkg.dependencies ?? {}).sort()).toEqual([
      '@waterx/predict-agent-cli',
      '@waterx/predict-agent-schema',
    ]);
    for (const script of ['build', 'typecheck', 'test']) {
      expect(pkg.scripts?.[script], script).toBeTypeOf('string');
    }
  });

  it('never imports the SDK, in source', () => {
    for (const file of sourceFiles('packages/e2e/src')) {
      expect(read(file), file).not.toContain("from '@waterx/predict-agent-sdk'");
    }
  });

  it('says in its README that it is not a production runner', () => {
    const readme = read('packages/e2e/README.md').toLowerCase();
    expect(readme).toContain('not');
    expect(readme).toContain('production');
  });
});

describe('reserved boundaries', () => {
  it('publishes nothing and claims nothing', () => {
    // A reserved directory exists so a dependency cannot leak into the SDK
    // later. It must not read as a shipped capability in the meantime.
    for (const dir of RESERVED) {
      const pkg = manifest(dir);
      expect(pkg.private, dir).toBe(true);
      expect(pkg.main, dir).toBeUndefined();
      expect(pkg.exports, dir).toBeUndefined();
      expect(pkg.bin, dir).toBeUndefined();
      expect(pkg.dependencies, dir).toBeUndefined();
      const tracked = readdirSync(`${ROOT}packages/${dir}`)
        .filter((entry) => entry !== 'node_modules' && !entry.startsWith('.'))
        .sort();
      expect(tracked, dir).toEqual(['README.md', 'package.json']);
    }
  });

  it('says so in the README', () => {
    for (const dir of RESERVED) {
      expect(read(`packages/${dir}/README.md`).toLowerCase(), dir).toContain('not implemented');
    }
  });
});

describe('the command contract compiles to the SDK', () => {
  it('names a method that actually exists on the client', () => {
    // The contract's promise is that every surface issuing the same intent makes
    // the same call (ADR-0001 §1). An `implementation` naming a method that was
    // renamed or never existed breaks that silently, at the adapter.
    const client = PredictAgentClient.prototype as unknown as Record<string, unknown>;
    for (const command of AGENT_COMMANDS) {
      if (command.implementation.kind !== 'sdk') continue;
      const { method } = command.implementation;
      expect(typeof client[method], `${command.name} -> ${method}`).toBe('function');
    }
  });

  it('maps each command to a distinct method', () => {
    const methods = AGENT_COMMANDS.flatMap((command) =>
      command.implementation.kind === 'sdk' ? [command.implementation.method] : [],
    );
    expect(new Set(methods).size).toBe(methods.length);
  });

  it('backs every command the CLI advertises as available', () => {
    // The inventory in `describe` is what a host reads to decide what it may
    // call. A capability advertised there with no command behind it is exactly
    // the fabricated support this repository's rules forbid.
    const contractNames = new Set(AGENT_COMMANDS.map((command) => command.name));
    const advertised = CAPABILITIES.filter(
      (capability) => capability.status === 'AVAILABLE' && capability.command !== undefined,
    );
    expect(advertised.length).toBeGreaterThan(0);
    for (const capability of advertised) {
      expect(contractNames.has(capability.command ?? ''), capability.id).toBe(true);
    }
    // …and the converse: a command in the contract that the CLI cannot run
    // would be advertised by an adapter and then refused.
    const availableCommands = new Set(advertised.map((capability) => capability.command));
    for (const name of contractNames) {
      expect(availableCommands.has(name), name).toBe(true);
    }
  });
});

function sourceFiles(relativeDir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(`${ROOT}${relativeDir}`, { withFileTypes: true })) {
    const path = `${relativeDir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (entry.name.endsWith('.ts')) out.push(path);
  }
  return out;
}
