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
 *   node recipes/reconcile.mjs [--json]
 */
import { createFileIntentStore, isTerminalExecutionStatus } from '@waterx/predict-agent-sdk';

import { connect, emit, out, INTENT_LEDGER } from './_client.mjs';

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
    out('  do          : re-run the SAME intent. The key replays and the server');
    out('                resolves it to the original order if one exists. Never');
    out('                change a field and never mint a new key to "try again".');
    resolved.push({ ...record, outcome: 'NO_EXECUTION_ID' });
    continue;
  }

  try {
    const execution = await client.getExecution(record.executionId);
    out(`  execution   : ${record.executionId} → ${execution.status}`);
    resolved.push({ ...record, status: execution.status, execution });
    if (isTerminalExecutionStatus(execution.status)) {
      await store.settle(record.idempotencyKey, execution.status);
      out('  settled     : recorded, and off this list.');
    } else {
      out('  still live  : leave it. Run this again rather than sending anything.');
    }
  } catch (error) {
    out(`  read failed : ${error?.message ?? String(error)}`);
    out('  do          : retry the READ. A failed read is not a failed order.');
    resolved.push({ ...record, outcome: 'READ_FAILED' });
  }
}

emit({ ledger: INTENT_LEDGER, pending: resolved });
