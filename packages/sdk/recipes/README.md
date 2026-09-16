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
and no policy.

`tests/workspace.test.ts` holds them to a whitelist of four modules and refuses
the loader-acquisition forms it knows about. **Neither that test nor the
package's `exports` map is a sandbox or a security boundary**, and it is worth
being exact about what each one is. The test is a review aid: it catches an
accident and makes a deliberate detour visible, but a static reading of source
cannot enumerate every way a runtime can be asked for a module. `exports` is an
API and resolution boundary: it decides what `@waterx/predict-agent-sdk/…`
resolves to, and nothing more — anyone holding these files can still load
`dist/src/…` by absolute path or `file:` URL, because that is how the filesystem
works and no package manifest changes it.

What they are for is keeping the SUPPORTED surface honest: one entry point, so
an upgrade cannot break a caller who stayed inside it, and no recipe quietly
depending on something the package does not promise.

## The scripts

| | What it answers |
| --- | --- |
| `diagnose.mjs` | May this agent trade right now, and if not, who does what? Run it first, and run it again whenever something stops working. |
| `onboard.mjs` | Prints the owner's authorization link **and waits for the signature**, instead of stopping and asking someone to come back and say they are done. Run it in the background — a measured owner took thirty-six minutes. |
| `browse.mjs` | What is there to trade, cheapest spread first. The prompt an agent actually gets names no market, and this is the step that was hand-written in every recorded session. |
| `markets.mjs` | Free text — plus, when you have it, `--closes-at` — to one market, or to a shortlist with the prices already attached. |
| `order.mjs` | One protected market order, with the spread and the size confidence stated *before* it goes, and the key kept on disk. `--dry-run` stops after the disclosure; `--account <id>` pins the account; `--retry` states a genuinely new attempt. |
| `positions.mjs` | What is held, and what is left to spend. |
| `reconcile.mjs` | What did this project start writing and never see land? Reads it back, and tells the difference between an order that is *in flight* and one that is *stopped waiting for this agent to sign* — the second is not fixed by reading. |

## Running them

```bash
# Your key file. The agent's own wallet — never the account owner's.
export WATERX_PREDICT_KEY_FILE=./agent.key
export WATERX_PREDICT_ENVIRONMENT=testnet     # practice money

node node_modules/@waterx/predict-agent-sdk/recipes/diagnose.mjs
```

## Run them, or copy them. Do not import them.

```bash
cp -r node_modules/@waterx/predict-agent-sdk/recipes ./waterx-recipes
```

They are not importable, and the package says so rather than leaving you to find
out:

```
import { connect } from '@waterx/predict-agent-sdk/recipes/_client.mjs';
Error [ERR_PACKAGE_PATH_NOT_EXPORTED]: Package subpath './recipes/_client.mjs'
is not defined by "exports"
```

That is deliberate, and the reason is in the file rather than in the manifest:
`_client.mjs` reads environment variables, writes to stderr and calls
`process.exit()`. That is correct in a script and wrong in a library, and
exporting it would hand you something that can end your process. Reaching it by
relative path through `node_modules` works and is worse — it depends on a layout
nothing promises.

What people reach for it for is `connect()`, and that is three lines of the SDK
proper:

```ts
const signer = Ed25519Keypair.fromSecretKey(await loadAgentSecretKey());
const client = new PredictAgentClient({
  deployment: 'testnet',
  signer,
  intentStore: createFileIntentStore('.waterx/intents.json'),
});
await client.authenticate();
```

Every script takes `--json` and writes **exactly one** JSON document to stdout,
with the human lines on stderr — so a caller parsing stdout never has to strip
prose out of it, and never has to tell "this failed" apart from "this produced
nothing". Success is `{ "ok": true, … }`; every handled failure is
`{ "ok": false, "error": { "code", … } }`, on the same stream.

**An option these do not recognise is refused, not ignored.** A misspelled
`--dryrun` exits 2 having read nothing and sent nothing. A script that moves
money and silently drops a flag is a trade nobody asked for.

**Pin the account when you resume something.** An idempotency key covers the
account, so `order.mjs` without `--account` — which trades whichever single
account is authorized right now — turns the same arguments into a different
intent the moment an owner authorizes a different one. `reconcile.mjs` always
passes it.

**The ledger is read strictly, and its index verifies itself.** Every record has
to hash to the key it is filed under, no two records may hold one idempotency
key, and every intent has to carry enough to be re-sent — because a record that
holds a key and cannot finish its write is worse than no record at all. A record
under the wrong key, two records sharing a key, a file with no `intents`, a
version this build does not read: all refusals naming what is wrong, never a
skipped row and never "absent means empty". A record nobody can read may be the
one naming an order that exists, and dropping it frees the next attempt to mint
a new key.

Where a refusal cannot tell *which side* is wrong — a key and an intent that
disagree — it says so and points at the execution to read back, rather than
suggesting a repair that could attach a live key to a different order.

**Nothing removes a lock it did not create.** If a run is killed mid-write, the
next one stops and tells you whether the holder is still running, so you know
whether removing `.waterx/intents.json.lock` is safe. Automatic takeover is two
steps — check, then remove — and two callers can both take it, which is how one
intent becomes two orders.

**`0` means a fill, and nothing else.** This used to exit zero on a `CANCELLED`
order — four times out of five orders in one re-test — with the word three lines
into a result block that otherwise looked exactly like a success. A terminal
order that traded nothing now leads with `*** NOT FILLED ***` and exits 7.

**A non-fill does not become a fill by running it again.** The key is
content-addressed, so the same arguments replay the same key and return the same
recorded outcome — which is the guarantee working, and also means those
arguments can never do anything else. `order.mjs` says that when it happens, and
`--retry` mints a `clientOrderId` so a genuinely new attempt is a different
intent rather than a hope.

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
| `7` | The order finished and **did not fill** — `CANCELLED`, `REJECTED`, `EXPIRED`. It existed, it was answered, and the answer was no. |
| `70` | An unexpected fault. Still a `{ "ok": false }` document — an unhandled failure is a thing that happened, and stdout says so. |
