#!/usr/bin/env node
/**
 * Print the authorization link, then WAIT for the signature.
 *
 * The waiting is the point. An onboarding that prints a link and exits turns one
 * signature into a conversation: the person opens their wallet, signs, comes
 * back to a dead terminal, and has to tell the agent they are done — in the
 * session this was written after, that cost two minutes and twenty seconds of a
 * terminal doing nothing at all.
 *
 * Running out of time is not a failure and cancels nothing. Run it again.
 *
 *   node recipes/onboard.mjs [--label "my bot"] [--timeout 600]
 */
import { connect, emit, out } from './_client.mjs';

const arg = (flag, fallback) => {
  const at = process.argv.indexOf(flag);
  return at === -1 ? fallback : (process.argv[at + 1] ?? fallback);
};

const client = await connect();
const handle = await client.startOnboarding({ label: arg('--label', 'agent') });

if (handle.ready) {
  out(`Already authorized — account ${handle.state.account?.accountId ?? '(unnamed)'}.`);
  emit(handle.state);
  process.exit(0);
}

out('The account owner signs this, in their own wallet. Nothing here can sign it');
out('for them, and nothing here is asking them for a key:');
out('');
out(`  ${handle.url}`);
out('');
out(`Waiting. Current state: ${handle.state.status}`);

const result = await handle.wait({
  timeoutMs: Number(arg('--timeout', '600')) * 1_000,
  onChange: (state) => {
    out(`  → ${state.status}${state.account === undefined ? '' : ` (${state.account.accountId})`}`);
  },
});

emit(result);

if (result.timedOut) {
  out('');
  out('The wait expired. That is not a refusal and nothing was cancelled — the owner');
  out('may still be signing. Run this again to pick the wait back up.');
  process.exitCode = 4;
} else if (result.status === 'READY') {
  out('');
  out(`Authorized. Trading on account ${result.account?.accountId ?? '(unnamed)'}.`);
  out('Run `node recipes/diagnose.mjs` to see the mandate the owner set.');
} else {
  out('');
  out(`Stopped at ${result.status} — ${result.nextStep.actor}: ${result.nextStep.action}`);
  process.exitCode = 3;
}
