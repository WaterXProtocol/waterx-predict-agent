/**
 * The harness's own argv, which is not the CLI's.
 *
 * Kept apart from `main.ts` so it can be tested without executing the binary,
 * and deliberately tiny: this is a test harness, not a second product surface.
 * Anything it does not recognise is ignored rather than rejected, because a
 * runner that refuses to start over an unknown flag reports NOTHING, and the
 * provisioning list is the output that matters most when a run cannot happen.
 */
import type { RunOptions } from './run.ts';

export const USAGE = `waterx-predict-e2e — drive the installed CLI end to end.

Three separate opt-ins, because they are three different decisions. Each ALSO
requires a non-production environment label; a flag alone is never enough.

  --allow-write            Place ONE real order.
  --allow-multi-leg        Place TWO real orders in one call, independently.
  --allow-strategy         Arm a durable strategy on the local Runner, which can
                           trade LATER, after this process has exited. The run
                           always tries to cancel it again, and says so if it
                           could not.

  --search <text>          Free text for \`market search\`.  (default: arsenal)
  --outcomeId <YES|NO>     Outcome to price.                (default: YES)
  --buyAmount <decimal>    Notional to spend.               (default: 1)
  --maxSlippageBps <int>   Price protection.                (default: 100)
  --settleTimeoutMs <int>  Bound on the terminal wait.      (default: 60000)
  --ownerAddress <0x…>     The account owner's address, for the strategy job.
                           Never inferred.
  --runner-restart <cmd>   YOUR command for restarting YOUR Runner, run once to
                           prove a job survives it. This harness never constructs
                           a way to stop a process it did not start.
  --strategyTargetPrice <decimal>
                           The armed BUY ceiling.           (default: 0.01)
  --help

stdout is one JSON report; stderr is the human account of it. With nothing
provisioned this still runs, reports every step it could not run together with
the named gaps responsible, and exits 11 — never 0.
`;

export function parseOptions(argv: readonly string[]): RunOptions | 'HELP' {
  const options: {
    -readonly [K in keyof RunOptions]: RunOptions[K];
  } = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--help' || token === '-h') return 'HELP';
    if (token === '--allow-write') {
      options.allowWrite = true;
      continue;
    }
    if (token === '--allow-multi-leg') {
      options.allowMultiLeg = true;
      continue;
    }
    if (token === '--allow-strategy') {
      options.allowStrategy = true;
      continue;
    }
    if (token === undefined || !token.startsWith('--')) continue;
    const value = argv[index + 1] ?? '';
    index += 1;
    switch (token.slice(2)) {
      case 'search':
        options.search = value;
        break;
      case 'outcomeId':
        options.outcomeId = value === 'NO' ? 'NO' : 'YES';
        break;
      case 'buyAmount':
        // Kept as the string it arrived as. Money through a float is how an
        // amount becomes almost the amount.
        options.buyAmount = value;
        break;
      case 'maxSlippageBps':
        options.maxSlippageBps = Number.parseInt(value, 10);
        break;
      case 'settleTimeoutMs':
        options.settleTimeoutMs = Number.parseInt(value, 10);
        break;
      case 'ownerAddress':
        options.ownerAddress = value;
        break;
      case 'runner-restart':
        options.runnerRestart = value;
        break;
      case 'strategyTargetPrice':
        // A price, so a string for the same reason an amount is one.
        options.strategyTargetPrice = value;
        break;
      default:
        break;
    }
  }
  return options;
}
