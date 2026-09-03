#!/usr/bin/env node
/**
 * What did this project start writing and never see land?
 *
 * The question a durable idempotency key exists to make answerable, and the one
 * a key alone cannot answer. A key says an order MIGHT exist. The ledger this
 * SDK keeps records the execution id the moment the server admits the write, so
 * a crash between the create and the terminal read leaves something to READ BACK
 * rather than something to guess about.
 *
 * The rule this recipe exists to enforce: an unresolved write is reconciled by
 * reading, NEVER by resending under a fresh key.
 *
 * With one exception it has to name, because reading cannot fix it. An
 * execution left at `AWAITING_SIGNATURE` is not in flight — it is stopped, and
 * nothing but this agent's signature will move it. Reading reports that status
 * accurately and forever, so "read it again later" is the one piece of advice
 * that guarantees the order never happens. What resumes it is re-running the
 * SAME intent: the key replays, the server hands back that same execution with
 * bytes to sign, and it goes. That is not a second order — it is the first one,
 * finally sent.
 *
 *   node recipes/reconcile.mjs [--json]
 */
import {
  createFileIntentStore,
  intentDigest,
  isTerminalExecutionStatus,
  needsAgentSignature,
} from '@waterx/predict-agent-sdk';

import { connect, emit, out, parseArgv, INTENT_LEDGER } from './_client.mjs';

parseArgv();

/**
 * The exact line that resumes one recorded intent — or nothing.
 *
 * Printed rather than run. This recipe reads; the decision to send is the
 * operator's, and handing them a command they can see beats a script that
 * writes on their behalf while they are reading about why it has to.
 *
 * The reconstruction is CHECKED, and this is the whole point of the function.
 * `order.mjs` takes six things positionally, and an intent may carry more — a
 * `clientOrderId`, a `worstAcceptablePrice`, a `strategyId`. Print the command
 * for one of those and the operator runs a DIFFERENT intent: different digest,
 * different key, a second order, while the line above tells them it is the
 * first one finally sent. So the reconstruction is digested against the record,
 * and a command that would not reproduce it is not offered at all.
 *
 * `--account` is always passed, and it is not decoration. An idempotency key
 * covers the account, and `order.mjs` without it trades whichever account
 * happens to be the single authorized one at that moment. Verifying the digest
 * against the RECORDED account and then printing a command that resolves a
 * DIFFERENT one would be the same defect the digest check exists to catch,
 * moved one field over.
 */
const resumeCommand = (record) => {
  const intent = record.intent ?? {};
  const amount = intent.size?.buyAmount ?? intent.size?.sellShares;
  if (amount === undefined || intent.accountId === undefined) return undefined;

  const rebuilt = {
    accountId: intent.accountId,
    marketId: intent.marketId,
    outcomeId: intent.outcomeId,
    side: intent.side,
    size: intent.side === 'BUY' ? { buyAmount: amount } : { sellShares: amount },
    maxSlippageBps: Number(intent.maxSlippageBps),
    ...(intent.positionId === undefined ? {} : { positionId: intent.positionId }),
  };
  if (intentDigest(rebuilt) !== record.digest) return undefined;

  return [
    'node recipes/order.mjs',
    intent.marketId,
    intent.outcomeId,
    intent.side,
    amount,
    String(intent.maxSlippageBps),
    intent.positionId ?? '',
    `--account ${intent.accountId}`,
  ]
    .filter((part) => part !== '')
    .join(' ');
};

/** What to say when the command line cannot express this intent. */
const RESUME_BY_HAND =
  'this intent carries fields `order.mjs` cannot take on a command line, so no line is offered — re-run it from your own code with the SAME intent object and the same store. Anything else is a new key.';

const store = createFileIntentStore(INTENT_LEDGER);
const pending = await store.pending();

if (pending.length === 0) {
  out(`Nothing pending in ${INTENT_LEDGER}. Every intent this project reserved reached a terminal state.`);
  emit({ ledger: INTENT_LEDGER, pending: [] });
  process.exit(0);
}

out(`${pending.length} intent(s) reserved and never settled, in ${INTENT_LEDGER}:`);
const client = await connect();
const resolved = [];

for (const record of pending) {
  out('');
  out(`- reserved ${record.createdAt}`);
  out(`  key         : ${record.idempotencyKey}`);
  out(`  intent      : ${JSON.stringify(record.intent)}`);

  if (record.executionId === undefined) {
    // The create never returned an id. That is genuinely unresolvable from here
    // — there is no handle to read — and the safe move is to retry THIS EXACT
    // intent, which replays the same key and resolves to the original execution
    // if one was ever opened.
    out('  execution   : none recorded — the create never came back with one.');
    const resume = resumeCommand(record);
    out('  do          : re-run the SAME intent. The key replays and the server');
    out('                resolves it to the original order if one exists. Never');
    out('                change a field and never mint a new key to "try again".');
    out(resume === undefined ? `                ${RESUME_BY_HAND}` : `                ${resume}`);
    resolved.push({ ...record, disposition: 'NO_EXECUTION_ID', resume: resume ?? null });
    continue;
  }

  try {
    const execution = await client.getExecution(record.executionId);
    out(`  execution   : ${record.executionId} → ${execution.status}`);

    if (isTerminalExecutionStatus(execution.status)) {
      await store.settle(record.idempotencyKey, execution.status);
      out('  settled     : recorded, and off this list.');
      resolved.push({ ...record, status: execution.status, disposition: 'SETTLED', execution });
    } else if (needsAgentSignature(execution.status)) {
      // Stopped, not in flight. Reading again will report exactly this until it
      // expires.
      const resume = resumeCommand(record);
      out('  NOT live    : it is waiting for this agent to sign, and no amount of');
      out('                reading will advance it. It expires unsigned unless it is sent.');
      out('  do          : re-run the SAME intent. The key replays, the server returns');
      out('                this execution with bytes to sign, and it goes out. Not a');
      out('                second order — the first one, finally sent.');
      out(resume === undefined ? `                ${RESUME_BY_HAND}` : `                ${resume}`);
      resolved.push({
        ...record,
        status: execution.status,
        disposition: 'AWAITING_OUR_SIGNATURE',
        resume: resume ?? null,
        execution,
      });
    } else {
      out('  still live  : on chain and moving. Leave it; run this again later.');
      resolved.push({ ...record, status: execution.status, disposition: 'IN_FLIGHT', execution });
    }
  } catch (error) {
    out(`  read failed : ${error?.message ?? String(error)}`);
    out('  do          : retry the READ. A failed read is not a failed order.');
    resolved.push({ ...record, disposition: 'READ_FAILED', message: error?.message ?? String(error) });
  }
}

emit({ ledger: INTENT_LEDGER, pending: resolved });
