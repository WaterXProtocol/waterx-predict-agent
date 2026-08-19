# @waterx/predict-agent-signer-browser

A `SIGNER_PROTOCOL` v1 provider that asks a **browser wallet**, so no private key
ever enters a process this workspace runs.

The CLI and the Runner do not sign. They spawn a signer command, hand it one JSON
request on stdin, and read one JSON response on stdout (`packages/cli/src/signer.ts`).
This is such a command. It serves a single-use page on loopback, waits for the
wallet extension to sign, and prints the signature.

```bash
pnpm --filter @waterx/predict-agent-signer-browser build

export WATERX_PREDICT_SIGNER_COMMAND='["node","packages/signer-browser/dist/src/bin/signer.js"]'
export WATERX_PREDICT_AGENT_WALLET=0x…      # the address the wallet must hold
export WATERX_PREDICT_TIMEOUT_MS=300000     # a person has to press a button
```

Then every command that authenticates or writes opens a tab and waits.

## What it will and will not do

| | |
| --- | --- |
| `PERSONAL_MESSAGE` | Signs the login challenge. |
| `TRANSACTION` | Signs a transaction **the wallet can read** — see below. |
| Execute | **Never.** It returns a signature; submission belongs to the caller. |
| Sign for another address | **Never.** It refuses and lists what the wallet actually holds. |

**A transaction is decoded before it is shown.** `Transaction.from(bytes).toJSON()`
runs here, in Node, so the wallet renders the real contents and the person
approving sees what they are approving. Asking a wallet to sign opaque bytes gets
you either a refusal or a signature nobody understood, and the second is worse.

**It signs; it never executes.** A sponsored order has a gas owner that is not the
sender, so the chain wants two signatures — the user's and the sponsor's. The
server adds the second one on submit. A provider that executed here would fail
with `Expected 2 signer signature but got 1`, and on any path where it did not
fail it would have submitted something the caller meant to inspect first.

## Where it fits, and where it does not

This is the provider for **`interactive`** (ADR-0001 §9): every signature is a
person looking at a wallet dialog, which is exactly the guarantee that mode
promises and the CLI cannot make on its own.

It is **not usable by the Runner**. A durable strategy signs when a price target
fires, at an hour when nobody is watching a browser. `delegated-auto` needs a
keystore or a KMS provider, which are still unbuilt (backlog 1.8).

## The trust boundary

- The page is bound to `127.0.0.1` on an ephemeral port and carries a **single-use
  nonce**, so no other page on the machine can answer for the wallet.
- The address is checked before signing; a wallet that does not hold it is
  refused by name.
- Values interpolated into the page are escaped for **both** markup and script
  context — `JSON.stringify` alone leaves `</script>` intact, which is enough to
  end the element early.
- The signature is written to stdout and nowhere else: not to a log, not to an
  error, not to the page's own status line.
