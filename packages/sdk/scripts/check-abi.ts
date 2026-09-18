/**
 * `pnpm --filter @waterx/predict-agent-sdk abi:check` — do the deployed
 * packages still have the call shapes the direct-mode verifier binds?
 *
 * Reads waterx-config and the public Sui GraphQL for each network named (both
 * by default), compares every bound function with `BOUND_FUNCTIONS`, and exits
 * 1 on any difference. Reads only: no key, no WaterX API, nothing signed. Run
 * daily in CI, so a package upgrade is found by a job and not by an order.
 */
import { findAbiMismatches } from '../src/direct/abi.ts';
import { SuiGraphqlChainReader } from '../src/direct/chain.ts';
import { FetchedDeployment, type DirectNetwork } from '../src/direct/deployment.ts';

const networks = (process.argv.slice(2).filter((arg) => arg === 'mainnet' || arg === 'testnet') as DirectNetwork[]);
let failed = false;
for (const network of networks.length > 0 ? networks : (['mainnet', 'testnet'] as const)) {
  const deployment = await new FetchedDeployment({ network }).load();
  const mismatches = await findAbiMismatches(deployment, new SuiGraphqlChainReader({ network }));
  if (mismatches.length === 0) {
    process.stdout.write(`${network}: every bound call has the pinned shape\n`);
    continue;
  }
  failed = true;
  for (const mismatch of mismatches) {
    process.stdout.write(
      `${network}: ${mismatch.function} differs\n  expected ${JSON.stringify(mismatch.expected)}\n  actual   ${JSON.stringify(mismatch.actual ?? null)}\n`,
    );
  }
}
process.exitCode = failed ? 1 : 0;
