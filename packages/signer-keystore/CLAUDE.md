# packages/signer-keystore — `@waterx/predict-agent-signer-keystore`

The `SIGNER_PROTOCOL` v1 provider for unattended signing, and the only one
`delegated-auto` and the Runner can use. ssh-agent shaped: `agent` unlocks the
keystore once (scrypt → AES-256-GCM; GCM's tag is the passphrase check, so a
wrong passphrase and an altered file are indistinguishable on purpose) and
holds the key in memory; `sign` is spawned per request over a `0600` socket in
a `0700` uid-owned directory, with a per-start token. Refuses an address it
does not hold, naming the one it does.

It decides nothing about *whether* to sign — that stays in the CLI's
`policy.ts` and the Runner's job snapshot. **A decrypted key is resident**, so
the documented setup loads a delegated agent wallet bounded by the on-chain
permission bits and the risk profile, never the account owner's key.

Reached as a PROCESS: the CLI and the Runner never import it (it carries
`@mysten/sui`; `tests/workspace.test.ts` lists it under `PROVIDERS`). The CLI's
`next` probes it through `packages/cli/src/keystore-probe.ts` — PATH, the
public address in `keystore.json`, the socket's existence — without dialing it.

`private`, Node 20. Ships beside the CLI as its own release asset (ADR-0012).
