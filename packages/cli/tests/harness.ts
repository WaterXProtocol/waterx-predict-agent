/**
 * One place to run the CLI the way a shell would, with nothing real behind it.
 *
 * Every test in this package goes through `invoke`: no test constructs a
 * handler directly, because the properties worth protecting — one JSON document
 * on stdout, the right exit code, no secret on either stream — are properties of
 * the whole invocation, not of any handler.
 *
 * Nothing here opens a socket, spawns a process or reads a real file.
 */
import { run, type CliIo } from '../src/index.ts';

export interface Invocation {
  /** Everything written to stdout, concatenated. */
  readonly stdout: string;
  /** Everything written to stderr, concatenated. */
  readonly stderr: string;
  readonly exit: number;
  /** How many times stdout was written to. Must always be exactly 1. */
  readonly writes: number;
  /** The parsed envelope. Throws if stdout was not exactly one JSON document. */
  readonly envelope: Envelope;
  readonly fetches: readonly FetchCall[];
  readonly signerRuns: readonly SignerRun[];
}

export interface Envelope {
  schemaVersion: string;
  ok: boolean;
  command: string;
  requestId: string;
  data?: unknown;
  error?: { code: string; message: string; retryable: boolean; source: string; details?: unknown };
  meta?: { defaultsApplied?: Record<string, unknown>; warnings?: string[] };
}

export interface FetchCall {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
}

export interface SignerRun {
  readonly command: readonly string[];
  readonly input: string;
}

export interface InvokeOptions {
  readonly env?: Record<string, string | undefined>;
  readonly files?: Record<string, string>;
  readonly stdin?: string;
  /** Keyed by `METHOD /path`; the value is the response, or a thrown value. */
  readonly routes?: Record<string, RouteResponse>;
  /** Overrides the default signer, which returns a fixed fake signature. */
  readonly signer?: (command: readonly string[], input: string) => SignerResult;
  readonly homeDir?: string | null;
}

export interface SignerResult {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly code?: number | null;
  readonly timedOut?: boolean;
}

export type RouteResponse =
  | { readonly status: number; readonly body: unknown }
  | { readonly throws: unknown };

/** A base URL that no test ever actually connects to. */
export const BASE_URL = 'https://predict.test.invalid';
export const AGENT_WALLET = `0x${'a'.repeat(63)}1`;
export const ACCOUNT_ID = `0x${'c'.repeat(63)}2`;

/** The minimum a command needs to be allowed to reach the network. */
export const CONFIGURED_ENV: Record<string, string> = {
  WATERX_PREDICT_BASE_URL: BASE_URL,
  WATERX_PREDICT_AGENT_WALLET: AGENT_WALLET,
  WATERX_PREDICT_SIGNER_COMMAND: '/opt/waterx/sign',
};

export const AUTH_OK = {
  status: 200,
  body: { token: 'session-token-that-must-never-be-printed', expiresIn: 900 },
} as const;

export const ALLOWANCE_OK = {
  status: 200,
  body: {
    apiAllowance: { limit: '1000.00', reserved: '0.00', deployed: '25.00', available: '975.00' },
    accountSpendableBalance: '480.00',
    effectiveBuyCapacity: '480.00',
  },
} as const;

/**
 * A live mandate with room in it: the same allowance as above, no blockers, both
 * delegation permissions granted.
 *
 * The allowance body is reused deliberately — `account status` and `order
 * preview` read capacity out of THIS response now, so a test that changed one
 * and not the other would be asserting against two different accounts.
 */
export const EFFECTIVE_LIMITS_OK = {
  status: 200,
  body: {
    accountId: ACCOUNT_ID,
    agentWallet: AGENT_WALLET,
    limits: {
      allowanceLimit: '1000.00',
      maxOrderAmount: '200.00',
      maxSlippageBps: 500,
      maxOrdersPerHour: 20,
      maxNotionalPerHour: '2000.00',
      maxInFlightExecutions: 3,
      isSuspended: false,
      policyVersion: 4,
      updatedAt: '2026-08-01T00:00:00.000Z',
    },
    allowance: ALLOWANCE_OK.body,
    usage: {
      windowSeconds: 3600,
      ordersInWindow: 2,
      notionalInWindow: '75.00',
      inFlightExecutions: 0,
    },
    delegation: {
      mayPlaceOrder: true,
      mayRequestClose: true,
      checkedAt: '2026-08-12T00:00:00.000Z',
    },
    blockers: [],
    asOf: '2026-08-12T00:00:00.000Z',
  },
} as const;

/**
 * Runs the CLI end to end.
 *
 * `env` REPLACES the process environment rather than extending it, so a test
 * cannot accidentally pass because the developer's own machine is configured.
 */
export async function invoke(
  argv: readonly string[],
  options: InvokeOptions = {},
): Promise<Invocation> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const fetches: FetchCall[] = [];
  const signerRuns: SignerRun[] = [];
  const routes = options.routes ?? {};

  const io: CliIo = {
    argv,
    env: options.env ?? {},
    streams: {
      write: (text) => stdout.push(text),
      writeError: (text) => stderr.push(text),
    },
    fetch: (async (url: URL | string, init?: RequestInit) => {
      // Real `fetch` rejects an already-aborted request instead of sending it. A
      // double that ignored the signal would make every deadline in this CLI
      // silently untestable — a command whose signal fires too early would look
      // identical here to one whose signal is sized correctly.
      const signal = init?.signal;
      if (signal !== undefined && signal !== null && signal.aborted) {
        throw signal.reason instanceof Error
          ? signal.reason
          : new Error('The operation was aborted.');
      }
      const parsed = new URL(String(url));
      const method = init?.method ?? 'GET';
      fetches.push({
        url: String(url),
        method,
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      });
      const key = `${method} ${parsed.pathname}`;
      const route = routes[key];
      if (route === undefined) {
        throw new Error(`the test stubbed no route for ${key}`);
      }
      if ('throws' in route) throw route.throws;
      return new Response(JSON.stringify(route.body), {
        status: route.status,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof globalThis.fetch,
    runSigner: (command, input) => {
      signerRuns.push({ command, input });
      const result = options.signer?.(command, input) ?? {
        stdout: JSON.stringify({ signature: 'fake-personal-message-signature' }),
      };
      return Promise.resolve({
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
        code: result.code ?? 0,
        timedOut: result.timedOut ?? false,
      });
    },
    readFile: (path) => options.files?.[path] ?? null,
    homeDir: () => options.homeDir ?? null,
    readStdin: () => Promise.resolve(options.stdin ?? ''),
    now: () => new Date('2026-08-12T00:00:00.000Z'),
    newRequestId: () => 'req-fixed-0001',
    nodeVersion: 'v20.19.0',
  };

  const exit = await run(io);
  const out = stdout.join('');

  return {
    stdout: out,
    stderr: stderr.join(''),
    exit,
    writes: stdout.length,
    // A getter, so a test asserting on the raw stream can still run when the
    // document is unparseable — that is the failure it exists to catch.
    get envelope(): Envelope {
      return JSON.parse(out) as Envelope;
    },
    fetches,
    signerRuns,
  };
}
