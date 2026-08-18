/**
 * What a consumer can actually import.
 *
 * `exports` admits exactly one specifier, so `src/index.ts` is the whole public
 * surface: anything not re-exported there does not exist as far as an installed
 * package is concerned, however visible it looks in this repository. That is
 * easy to get wrong in one direction in particular — `export type *` re-exports
 * a module's types and none of its runtime values, and the gap is invisible
 * until someone installs the tarball and gets `does not provide an export
 * named …` at load time.
 *
 * These assertions import through the entry point on purpose. Reaching into
 * `../src/contract.ts` would test the file rather than the surface.
 */
import { describe, expect, it } from 'vitest';

import * as sdk from '../src/index.ts';
import {
  IDEMPOTENCY_KEY_HEADER,
  PREDICT_AGENT_API_ROUTES,
  PREDICT_QUOTE_STREAM_MAX_TOPICS,
  PredictAgentClient,
  compareDecimal,
} from '../src/index.ts';

describe('the published entry point', () => {
  it('exposes the contract constants a caller would otherwise hard-code', () => {
    // Each of these is a value the SDK already holds and a consumer would
    // otherwise copy: the route it is about to call, the header the server
    // reads for idempotency, the cap a stream enforces. A copy drifts.
    const constants = [
      'IDEMPOTENCY_KEY_HEADER',
      'PREDICT_AGENT_API_ROUTES',
      'PREDICT_AGENT_STREAM_NAMESPACE',
      'PREDICT_EXECUTION_STREAM',
      'PREDICT_QUOTE_HEARTBEAT',
      'PREDICT_QUOTE_STREAM',
      'PREDICT_QUOTE_STREAM_HEARTBEAT_MS',
      'PREDICT_QUOTE_STREAM_MAX_SUBSCRIBE_RATE',
      'PREDICT_QUOTE_STREAM_MAX_TOPICS',
      'PREDICT_QUOTE_SUBSCRIBE',
      'PREDICT_QUOTE_SUBSCRIPTION',
      'PREDICT_QUOTE_UNSUBSCRIBE',
      'PREDICT_STREAM_READY',
      'RETRYABLE_PREDICT_AGENT_ERROR_CODES',
    ];
    for (const name of constants) {
      expect(Object.hasOwn(sdk, name), `${name} is not reachable from the entry point`).toBe(true);
    }
  });

  it('re-exports the same values, not copies of them', () => {
    expect(IDEMPOTENCY_KEY_HEADER).toBe('Idempotency-Key');
    expect(PREDICT_AGENT_API_ROUTES.auth).toBe('agent-api/v1/auth');
    expect(PREDICT_QUOTE_STREAM_MAX_TOPICS).toBe(32);
  });

  it('still exposes the client and the decimal helpers it is used with', () => {
    // The pairing is the point: money is compared with these, never with `<`.
    expect(PredictAgentClient).toBeTypeOf('function');
    expect(compareDecimal('0.10', '0.1')).toBe(0);
  });
});
