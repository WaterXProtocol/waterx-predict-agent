#!/usr/bin/env node
/**
 * "May this agent trade, and if not, who does what?" — one call, one answer.
 *
 * This is the first thing to run after an install and the first thing to run
 * when something stops working. It replaces the sequence a caller would
 * otherwise assemble — describeInstallation, authenticate, listAuthorizedAccounts,
 * describeOnboarding, buildAuthorizationUrl, getEffectiveLimits — with the one
 * call that already knows how those fit together.
 *
 *   node recipes/diagnose.mjs [--json] [--label "my bot"]
 */
import { connect, emit, out } from './_client.mjs';

const labelAt = process.argv.indexOf('--label');
const label = labelAt === -1 ? 'agent' : (process.argv[labelAt + 1] ?? 'agent');

const client = await connect({ authenticate: false });
const report = await client.diagnose({ label });

emit(report);

out(`agent wallet : ${client.agentWallet}`);
out(`deployment   : ${client.deployment ?? '(private)'}  ->  ${client.baseUrl}`);
out(`session      : ${report.authenticatedHere ? 'opened by this call' : 'already held'}`);
out(`onboarding   : ${report.onboarding.status}   (accounts: ${report.onboarding.accounts.length})`);
out('');
out(`may trade    : ${report.writes.permitted === undefined ? 'UNKNOWN' : report.writes.permitted ? 'yes' : 'no'}   (${report.writes.status})`);
out(`gated by     : ${report.writes.gatedBy}`);
out(`  ${report.writes.detail}`);

if (report.limits !== undefined) {
  out('');
  out('mandate (the owner signed this; it cannot be raised from here)');
  out(`  ${JSON.stringify(report.limits, null, 2).split('\n').join('\n  ')}`);
} else if (report.limitsError !== undefined) {
  out('');
  out(`limits       : could not be read — ${report.limitsError}`);
}

const unresolved = report.requirements.filter((entry) => entry.state !== 'SATISFIED');
if (unresolved.length > 0) {
  out('');
  out(`still open (${unresolved.length}):`);
  for (const entry of unresolved) {
    out(`  [${entry.state}] ${entry.title} — ${entry.suppliedBy}`);
    out(`      ${entry.evidence}`);
  }
}

if (report.authorizationUrl !== undefined) {
  out('');
  out('Hand this to the account owner. It carries the agent address and nothing');
  out('else — no key, no token — so it is safe to paste anywhere:');
  out('');
  out(`  ${report.authorizationUrl}`);
  out('');
  out('Then run `node recipes/onboard.mjs`, which waits for the signature instead');
  out('of asking someone to come back and announce it.');
}

out('');
out(`next — ${report.nextStep.actor}: ${report.nextStep.action || 'nothing; this agent may trade.'}`);

process.exitCode = report.ready ? 0 : 3;
