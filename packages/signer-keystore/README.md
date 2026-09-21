# @waterx/predict-agent-signer-keystore

The signer for **unattended** work: a price trigger fires at 03:00, and there is
nobody to press a button. This is the only provider a Runner can use, and the one
`delegated-auto` was always describing.

Installed from a release, it arrives beside the CLI in the same `npm install`
(ADR-0012), so run it through `npx --no`; `waterx-predict next` tells an
operator which of the steps below is still undone.

It is shaped like `ssh-agent`, for the same reason `ssh-agent` is shaped that way:

```
waterx-predict-keystore init            # create an encrypted keystore
waterx-predict-keystore agent           # unlock it ONCE; stays resident, holds the key
waterx-predict-keystore agent --detach  # …or in the background, for a machine with one terminal
waterx-predict configure --fromKeystore # tell the CLI which wallet this is, and who signs
```

`agent` is the only thing that ever sees the passphrase. `sign` is spawned per
request, holds nothing, and forwards to the agent over a private socket — so the
CLI and the Runner still never hold key material (ADR-0001 §7), and the operator
types a passphrase once instead of once per order.

## …or with no passphrase at all

```
waterx-predict-keystore init --no-passphrase
waterx-predict configure --fromKeystore
```

`--no-passphrase` writes the key **in plaintext** in a `0600` file: no
passphrase, no resident agent, `sign` opens the file itself. It exists because an
unattended host has nobody to type a passphrase and nowhere to keep a process
holding one unlocked, and it is the same posture the perp agent takes with
`SUI_PRIVATE_KEY` in a `.env` (ADR-0020).

|  | sealed (the default) | `--no-passphrase` |
| --- | --- | --- |
| Key at rest | AES-256-GCM under scrypt | plaintext |
| Protected by | a passphrase nobody else has | the file mode, and nothing else |
| Signing needs | a resident `agent` | the file |
| Someone must type | the passphrase, once per start | nothing |

Anything running as this user can read a plaintext keystore. The only key that
belongs in one is a **delegated agent wallet** — never the owner's. That is the
same rule as below, and it matters more here.

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
from an environment variable: `ps eww` shows those to anyone on the box. With
`--detach` it is read by the process that still has a terminal and handed to the
background child on a pipe, so it reaches neither `ps` nor the filesystem.

A passphrase-less keystore is the same document with `protection: "NONE"`, the
secret in `secretBase64`, and the warning written into the file so nothing has to
infer it from a missing field. `openKeystore` reads both; `agent` refuses the
plaintext one, because there is nothing to hold.
