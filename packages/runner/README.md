# @waterx/predict-agent-runner — reserved, not implemented

**There is no Runner yet.** This directory reserves the package boundary so that
the daemon, its SQLite/WAL job store and the signer never become dependencies of
the published SDK library (ADR-0001 §4). It contains no source and publishes
nothing.

Implementation is tracked as backlog items 2.5–2.7. Synthetic limit orders today run
in-process via the SDK's `waitForPriceAndExecute`, which means they die with the
process — see `packages/sdk/README.md`.

Two properties are load-bearing for whatever lands here, and neither is provided
by an empty directory:

- **The Runner is self-hosted and local.** The agent device and the Runner must
  stay awake, online and running for a job to make progress. Nothing here is a
  managed service.
- **The signer lives inside the Runner trust boundary.** Models and ordinary
  agent subprocesses never receive raw keys.
