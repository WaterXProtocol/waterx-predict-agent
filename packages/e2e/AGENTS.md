# packages/e2e — `@waterx/predict-agent-e2e`

Harness that drives the installed CLI as a subprocess; `private`, never
shipped. It may depend on nothing but the CLI and the schema. **The end-to-end
has not run** — nothing here is evidence that it passes. This is the only place
in the repository that spawns processes and opens sockets, and the only place
allowed to.

## Layout

- `src/steps.ts` — the plan, declared: what each step would PROVE, which
  provisioning gaps it needs, which steps it reads from, whether it writes.
- `src/gaps.ts` — the ten provisioning gaps and who supplies each. Two are
  owner-authenticated (`delegation`, `ownerRiskProfile`) and this repository
  **must not attempt** them: an agent runtime that could grant its own mandate
  would make the mandate meaningless (ADR-0003 §1). Three more cannot be probed
  at all — `ownerAddress` and `runnerRestart` are settled by having been
  *supplied*, and `runner` is settled by a Runner that answers **and** says it is
  driving, because one that answers and drives nothing would accept a strategy
  and leave it armed and asleep.
- `src/external.ts` — the one non-CLI command the harness runs: the operator's
  own Runner restart, awaited with a bound and with piped stdio. There is no
  `pkill`, no signal and no pid lookup here, and nothing is backgrounded.
- `src/report.ts` — the honesty rules, as types. A `NOT_RUN` step carries no
  evidence field, so "passed without running" cannot be written down; any step
  whose evidence came from a `STUB` makes the whole report `INVALID`.
- `src/run.ts` — the gates. A write needs an explicit opt-in **for its own
  capability** **and** an environment label on the non-production allowlist.
  Unlabelled counts as production and is never traded on. There are three
  capabilities, not one flag: `order` (one order), `multi-leg` (two at once) and
  `strategy` (a job that can trade after the process exits), so agreeing to the
  smallest never authorizes the largest. `strategy cancel` is deliberately
  ungated and runs last — withholding it would end a run by leaving a live job on
  the operator's Runner.
- `src/lint.ts` — every published invocation, including the examples and the
  READMEs, checked against the command contract without running it. This exists
  because a printed recovery instruction once used a flag spelling that exits
  `USAGE`.
- `examples/` — executable, and executed by the suite with nothing provisioned to
  prove they refuse with a named supplier rather than a stack trace. The one
  exception is the stream example, `packages/sdk/examples/watch-quotes.mjs`;
  this suite still executes and lints it.
