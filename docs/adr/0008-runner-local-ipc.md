# ADR-0008 — How a local client authenticates to the Runner

- Status: Accepted
- Date: 2026-08-17
- Refines: ADR-0001 §4 (the Runner is a reserved local boundary), ADR-0001 §6
  (self-hosted, no managed-runner promise), ADR-0002 (supported platforms)
- Affects: `waterx-predict-agent-sdk` (`packages/runner` only)

## Context

The Runner is a process that outlives one invocation, holds job leases, and will
hold the signer. Something has to talk to it — a CLI, an adapter, an operator — and
whatever that channel is, it is a channel into the process that can move funds.

A TCP port on loopback is the obvious shape and the wrong one. Loopback is
reachable by *every* local account and by anything that can make a request from a
browser; "localhost" is not an authentication boundary. The alternative is a Unix
domain socket, where the filesystem is the boundary — but Node's `net` exposes no
peer credentials, so there is no portable `SO_PEERCRED` to ask a connection who it
is.

## Decision

Local IPC is a **Unix domain socket inside a `0700` runtime directory owned by the
Runner's uid, with a bearer token as the second factor.** Newline-delimited JSON
frames, one versioned protocol.

- The directory is the isolation. It is asserted — mode, owner, type — before the
  socket is bound, and a directory that is group- or world-accessible **stops the
  Runner from starting**. It is not quietly tightened: chmod'ing it would hide that
  the socket and the token file were reachable by another local account up to that
  moment, which is exactly the fact the operator needs.
- The token is 256 CSPRNG bits, written at `0600` and **reminted on every start**,
  so a token left behind by a crashed Runner cannot authenticate against the one
  that replaced it. It is compared with `timingSafeEqual`, and a failed handshake
  echoes neither the expected token nor the guess.
- A connection sends `hello` first. A request before the handshake is refused, and
  a second handshake on the same connection is a protocol error.
- Every frame carries the protocol version. A mismatch is refused by number rather
  than tolerated, because a client that guesses wrong about this socket is guessing
  about order placement.
- Frames are bounded and a malformed frame disconnects. Requests on one connection
  are answered in order and processed sequentially.
- The **socket path length is checked** (103 bytes, the lower of the macOS and
  Linux `sun_path` limits). Binding a longer path does not fail — it binds a
  truncated one, and the Runner listens somewhere nobody will look.
- This socket is **not a second command surface**. `runner.*` commands are about
  the process's own lifecycle and are declared in the Runner; agent commands are
  recognized through `@waterx/predict-agent-schema`, the same registry the CLI and
  every adapter validate against (ADR-0006), and refused with `NOT_IMPLEMENTED`
  until something can perform them.

## What this forbids

- A TCP or HTTP listener for local control, including on loopback, and including
  "just for development". If a remote control plane is ever wanted, it is a
  different ADR with authentication that does not rest on file modes.
- Starting with a runtime directory that is not private, under any flag.
- Reusing a token across restarts, or writing it to stdout, to a log line, or into
  an error body.
- Adding trading capability to `runner.*`. A command an agent may issue belongs in
  the shared contract or it does not exist.
- Claiming Windows support. There is no fallback transport, by design: a named-pipe
  path would need its own security argument and ADR-0002 already excludes the
  platform.

## Consequences

- **Root is not excluded and nothing here pretends otherwise.** Root reads any file
  and connects to any socket regardless of mode. The boundary is other *users*, not
  other privilege levels.
- The uid check is `stat`-based rather than per-connection. A process running as the
  same user — including one an agent subprocess starts — can read the token and
  connect. That is consistent with the trust model, in which the signer's boundary
  is the user account, and it is the reason models and ordinary agent subprocesses
  are given commands rather than keys.
- The runtime directory is per-uid, so two Runners for one user must be given
  different directories. A live socket at the path is refused with
  `ADDRESS_IN_USE`; a stale one left by a crash is probed and taken over.
- A future managed Runner does not inherit this. It would be authenticated over a
  network transport, which is a different decision and a different ADR.
