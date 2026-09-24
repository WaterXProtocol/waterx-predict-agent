# ADR-0029 — The Runner ships as a third artifact, and an optional one

- Status: Proposed
- Date: 2026-09-24
- Decides: how an operator who wants durable strategies gets the Runner, and
  what a release does about it while this ADR is not Accepted
- Amends: ADR-0009 D-28, for this one artifact and only once this ADR is
  Accepted; ADR-0010, whose release now carries a third tarball that its
  one-sentence setup does **not** install
- Leaves unchanged: ADR-0001 §4 and §7 (the Runner holds no key material and
  the SDK does not depend on it), ADR-0002 (supported platforms), ADR-0003 (the
  owner's mandate is granted on chain, never by this runtime), ADR-0007 (the
  Runner's `node:sqlite` store and its Node 24 floor), ADR-0009 D-26 (no
  auto-update)
- Affects: `packages/runner`, `packages/release`

## Context

Five `strategy` commands are built, tested and reachable, and on every standard
install all five fail. They talk to a Runner over a local socket, and no install
path contains one: `@waterx/predict-agent-runner` is `private`, the git install's
root exposes two binaries, and the release carries two tarballs. The printed
remedy named the package, which is not installable.

That has been made honest — the capability inventory, the projected tools and the
READMEs all now say the process is missing rather than unreachable. Honest is not
the same as available. The remaining question is whether an operator can get one,
and the answer today is "clone the repository and build it", which is not a thing
an agent host does.

Two facts decide the shape.

**The Runner's floor is Node 24 and the CLI's is Node 20** (ADR-0007, which this
ADR does not reopen). One tarball carrying both would raise the floor for every
operator, including the ones who will never arm a strategy. Separate tarballs do
not: npm enforces `engines` per package, so a Node 20 operator installs the CLI
and the signer and is refused only the Runner.

**The Runner is not part of the minimum setup.** ADR-0010's sentence installs the
CLI and the signer together because a CLI without a signer stops at its first
question. Nothing stops without a Runner: `next` reaches READY, orders are
previewed, approved and placed. Strategies are an additional capability, and the
release gate has to be able to say so — otherwise an unaccepted decision about a
daemon would hold back the CLI.

## Decision

The Runner is a **third operator artifact**, built by the same machinery as the
other two, and marked **optional** in `OPERATOR_ARTIFACTS`.

- It is `@waterx/predict-agent-runner` packed with the SDK and the schema inside
  it as `bundleDependencies`, exactly as the CLI is packed. It has no
  third-party dependency to lift, which is ADR-0007's other half: nothing new
  enters the process that decides what gets signed.
- It stays **`private: true`**, so `npm publish` refuses it. It is a release
  asset. It carries no lifecycle script.
- It declares **`engines.node: ">=24"`**, unchanged, and that declaration travels
  in the tarball. The CLI and the signer keep `>=20`.
- **Optional means the release gate treats it differently, and only it.**
  `releaseRefusal` refuses a release when a *required* artifact's ADR is not
  Accepted — the CLI's and the signer's, unchanged and all-or-nothing. An
  optional artifact whose ADR is not Accepted is **omitted from the release and
  named in the output**, never a refusal of the whole.
- **The one-sentence setup does not change.** It installs the CLI and the signer.
  The Runner is a second sentence, for an operator who wants strategies, and it
  states the Node 24 floor.
- Building and checking all three is always allowed, on any branch, whatever the
  status of this file. Only *releasing* is gated. That is what makes this ADR
  reviewable against a working artifact rather than against a description.

## What this forbids

- Putting the Runner inside the CLI's tarball to save an install step. It would
  raise the CLI's Node floor to 24 for everybody and put the daemon's code in the
  process that decides policy.
- Adding a runtime dependency to the Runner so that it packs more conveniently.
  ADR-0007 already forbids it; being releasable is not a new reason.
- Treating this ADR's acceptance as evidence that strategies work end to end.
  Backlog 1.11 is the only record of that, and its durable half has run once, by
  hand, against a locally started backend.
- Describing the Runner as available anywhere — `describe`, the tool
  descriptions, the READMEs — while this file says `Proposed`. The machinery
  landing does not ship anything; flipping `Status` is what does, and the
  advertising changes in that same commit.

## Consequences

**Security.** This hands an operator a process that can trade while nobody is
watching. That is more than the CLI, which is one-shot and approval-gated, and
more than the signer, which signs what it is told. Three boundaries are what make
it acceptable, and none of them is new: the Runner holds no key (ADR-0001 §7) and
reaches the signer as a separate process; it can act only inside an on-chain
delegation the owner granted and may revoke (ADR-0003), which the backend and the
chain enforce rather than this runtime; and it signs unattended only under a
`delegated-auto` mandate an operator wrote into a local file, bounded per order
and, since the cumulative ceiling exists, in total. An operator who installs this
and configures nothing gets a daemon that answers, recovers and arms nothing.

**Operational.** There is no auto-update (ADR-0009 D-26). Upgrading a Runner that
holds live jobs is `runner.drain`, read the report, then `runner.shutdown` — and
`drain` deliberately does not exit. The operator owns the machine's uptime: a
laptop that sleeps is a strategy that is not watching, and nothing server-side
takes over.

**Compatibility.** A Node 20 or 22 operator can install the CLI and the signer
and cannot install this. That is the intended outcome and the reason for three
artifacts; `npm install` says so itself through `engines`. All three artifacts
must continue to share one version, which `buildBundle` already asserts.

**What acceptance costs.** Flipping `Status` to `Accepted` makes `--release`
carry the third tarball. It does not make a strategy work on a real server;
1.11's durable half is still the evidence that would.
