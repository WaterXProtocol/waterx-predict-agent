# packages/signer-browser — `@waterx/predict-agent-signer-browser`

A `SIGNER_PROTOCOL` v1 provider that asks a browser wallet. Holds no key, not
even an encrypted one. Decodes a `TRANSACTION` with
`Transaction.from().toJSON()` so the wallet renders it — never sign what nobody
can read — **signs without executing** (a sponsored order's second signature is
the server's), and refuses an address the wallet does not hold.

Reached as a PROCESS: the CLI and the Runner must never import it, and it
carries `@mysten/sui`, which is the dependency the CLI's budget exists to keep
out (`tests/workspace.test.ts` lists it under `PROVIDERS` for that reason).

Serves `interactive` only; `delegated-auto` uses `packages/signer-keystore`.
The provider decides nothing about *whether* to sign — that stays in the CLI's
`policy.ts` and the Runner's job snapshot. `private`, Node 20.
