# Recipes

Runnable scripts for everything a caller holding only this library has to do.
They ship inside the tarball, so they are on disk the moment the package
installs:

```
node_modules/@waterx/predict-agent-sdk/recipes/
```

## Why they exist

Because the alternative was measured. In the session these were written after,
an agent holding only the library answered eight questions by writing eight
throwaway scripts — 248 lines — and every one of them opened with the same four
lines: read the key, build the keypair, construct the client, authenticate. None
of those scripts was *about* that preamble, and the one that mattered, the
order, also had to invent a durable idempotency store on the spot because the
SDK documented that as the caller's job.

A recipe is not a second trading surface. Every one of these calls the same
public entry point you would; there is no route built here, no retry, no signing
and no policy. `tests/workspace.test.ts` fails if that stops being true.

## The scripts

| | What it answers |
| --- | --- |
| `diagnose.mjs` | May this agent trade right now, and if not, who does what? Run it first, and run it again whenever something stops working. |
| `onboard.mjs` | Prints the owner's authorization link **and waits for the signature**, instead of stopping and asking someone to come back and say they are done. |
| `markets.mjs` | Free text — plus, when you have it, `--closes-at` — to one market, or to a shortlist with the prices already attached. |
| `order.mjs` | One protected market order, with the spread and the size confidence stated *before* it goes, and the key kept on disk. `--dry-run` stops after the disclosure. |
| `positions.mjs` | What is held, and what is left to spend. |
| `reconcile.mjs` | What did this project start writing and never see land? Reads it back, and tells the difference between an order that is *in flight* and one that is *stopped waiting for this agent to sign* — the second is not fixed by reading. |

## Running them

```bash
# Your key file. The agent's own wallet — never the account owner's.
export WATERX_PREDICT_KEY_FILE=./agent.key
export WATERX_PREDICT_ENVIRONMENT=testnet     # practice money

node node_modules/@waterx/predict-agent-sdk/recipes/diagnose.mjs
```

Copy them into your project if you want to edit them. They are examples that
run, not a framework:

```bash
cp -r node_modules/@waterx/predict-agent-sdk/recipes ./waterx-recipes
```

Every script takes `--json` and writes **exactly one** JSON document to stdout,
with the human lines on stderr — so a caller parsing stdout never has to strip
prose out of it, and never has to tell "this failed" apart from "this produced
nothing". Success is `{ "ok": true, … }`; every handled failure is
`{ "ok": false, "error": { "code", … } }`, on the same stream.

**An option these do not recognise is refused, not ignored.** A misspelled
`--dryrun` exits 2 having read nothing and sent nothing. A script that moves
money and silently drops a flag is a trade nobody asked for.

**A stopped order and a live one are different things.** An execution left at
`AWAITING_SIGNATURE` is not in flight — nothing but this agent's signature moves
it, and a read reports that status accurately until it expires. `reconcile.mjs`
says so and offers the line that resumes it: re-running the SAME intent replays
the key, and the server returns that same execution with bytes to sign. It is
not a second order, it is the first one finally sent. Where the intent carries
something a command line cannot express, no line is offered — the reconstruction
is digested against the record first, so a command that would be a *different*
intent is never printed.

**The key file is checked before it is read.** A symlink, a non-regular file, a
file another account owns, or one any mode bit outside the owner's can reach is
refused with the `chmod` to fix it. The SDK's signer is structural precisely so
a caller can keep the key in a KMS and never do this at all — `_client.mjs` is
the only file to change.

## The one dependency they add

`@mysten/sui`, to load an Ed25519 key from a file — **yours, not this
package's**. The SDK takes a signer structurally, so a caller holding their key
in a KMS or an HSM implements `signTransaction`, `signPersonalMessage` and
`toSuiAddress` and never installs it. `_client.mjs` is where that choice is
made, and it is the only file to change.

## Exit codes

| | |
| --- | --- |
| `0` | Done. |
| `2` | The arguments were wrong. Nothing was sent. |
| `3` | Not ready to trade, or not resolved to one market. Nothing was sent. |
| `4` | A wait expired. **Not a failure** — the order or the signature may still land. |
| `5` | An unresolved write. The outcome is unknown; run `reconcile.mjs`. |
| `6` | The server refused the order, and said why. |
