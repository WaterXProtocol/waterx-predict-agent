# @waterx/predict-agent-signer-keystore

The signer for **unattended** work: a price trigger fires at 03:00, and there is
nobody to press a button. This is the only provider a Runner can use, and the one
`delegated-auto` was always describing.

It is shaped like `ssh-agent`, for the same reason `ssh-agent` is shaped that way:

```
waterx-predict-keystore init      # create an encrypted keystore
waterx-predict-keystore agent     # unlock it ONCE; stays resident, holds the key
export WATERX_PREDICT_SIGNER_COMMAND='["waterx-predict-keystore","sign"]'
```

`agent` is the only thing that ever sees the passphrase. `sign` is spawned per
request, holds nothing, and forwards to the agent over a private socket — so the
CLI and the Runner still never hold key material (ADR-0001 §7), and the operator
types a passphrase once instead of once per order.

## The trade this makes, stated plainly

A decrypted key sits in one process's memory for as long as that process runs.
That is strictly weaker than the browser-wallet provider, where no key exists in
this workspace at all — and it is the price of signing while nobody is watching.
There is no third option: a signature with no human and no resident key is a
contradiction.

**So do not load the account owner's key here.** Load a *delegated agent wallet*:

```
owner wallet   in a browser extension, used only to change delegation and limits
    │ on-chain delegation, predictPermissions = 9 (PLACE_ORDER | REQUEST_CLOSE)
    ▼
agent wallet   in this keystore, signing unattended
               bounded by the account's risk profile: per-order, per-hour, in-flight
```

The key that is resident can then only place bounded orders. It cannot withdraw,
cannot raise a limit, and cannot grant itself anything. That is what delegation
and the risk profile are for: **not making the powerful key ambient, making a weak
one ambient.**

## What the agent refuses

| | |
| --- | --- |
| A caller without the token | Minted per start, `0600` beside the socket, compared in constant time. |
| An address it does not hold | Named in the refusal, so a misconfigured Runner says which key is loaded. |
| A runtime directory others can reach | Asserted, never repaired — tightening someone's filesystem is not its call. |
| A wrong passphrase | Indistinguishable from an altered file, on purpose. |

It does **not** decide whether a signature should happen. That is the policy in
the runtime that asked (`packages/cli/src/policy.ts`, the Runner's job snapshot).
A signer that also enforced policy would be a second place for the rules to live.

## The file

scrypt (`N = 2¹⁷`) into AES-256-GCM. The parameters live in the file, so raising
them later still opens today's keystore. GCM's tag is the passphrase check: there
is no separate verifier, because one would tell an attacker when they had guessed
everything except the passphrase.

The passphrase is read from the terminal, or from a `0600` file named by
`WATERX_KEYSTORE_PASSPHRASE_FILE` for a machine that starts unattended. Never
from an environment variable: `ps eww` shows those to anyone on the box.
