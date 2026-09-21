# ADR-0024 — Handing the link over

- Status: Accepted
- Date: 2026-09-21
- Decides: how the authorization link reaches the account owner, and who
  decides whether a browser opens
- Amends: ADR-0022 (the owner's state gains two more ways to reach them)
- Affects: `packages/cli` (`onboard`, `browser`, `qr`, `next`),
  `packages/adapters` (SKILL and AGENT_INSTRUCTIONS)

## Context

Everything about `onboard` is addressed to somebody who is usually not at the
machine running it. The owner signs in their own wallet, on their own device.
What the person at this terminal has to do is get a 115-character URL to them.

Three findings from the perp agent's install sessions, all present here:

1. **`--open` was opt-in and nobody passed it.** A session that had the option
   available used neither it nor anything else (`waterx-agent` #27).
2. **`--qr` was never mentioned where an agent reads.** One session worked out
   for itself that "it opens a browser on this machine, which likely isn't
   where the owner is" — the exact case a QR code exists for — and never
   mentioned the code, because nothing it read named it. Measured on the
   shipped package, `next`'s headline and suggestions named it zero times.
3. **An agent invented a prohibition.** Told nothing either way, a session
   passed `--no-open` on its own initiative, reasoning "so nothing
   auto-launches a mainnet authorization page without you choosing to click"
   (`waterx-agent` #29). That is a real concern and it is not the agent's to
   settle: the person who installed this asked for the page, and they have a
   switch of their own.

## Decision

### 1. The page opens by itself

`onboard` opens the authorization page on the machine it runs on. The link is
still printed FIRST, so a machine with no browser loses nothing. Four things
stop it, and each says which in one line rather than silently doing nothing:

- `--no-open`, for this run;
- `WATERX_PREDICT_NO_BROWSER`, or a host `resolveOpener` already refuses — CI,
  a Linux box with no display, a missing opener, an unsupported platform;
- this exact link was opened here recently. `onboard --wait` is run again
  constantly — ask `next`, be told to wait, time out, run it again — and
  opening every time turns a five-minute wait into twenty tabs of one page. The
  memory sits with the other state, and an unreadable one counts as no memory;
- the opener failed, which is reported and stepped over.

`--open` overrides the memory: it is the "I am here, open it now" button.

What makes defaulting this on defensible is unchanged from the opt-in version:
http and https only, and spawned as argv rather than through a shell, because
the URL can come from configuration a caller controls.

### 2. `--qr` draws the link as a code

For the case this arrangement is actually built for: the owner is elsewhere,
with their wallet on a phone. It sits UNDER the link rather than instead of it —
whoever is at this terminal may be the one who signs, and a link they can click
beats a code they cannot.

The encoder is **ported from the perp agent** with its reference fixtures and
tests, rather than installed or rewritten. This repository argues for each
runtime dependency, and a QR encoder is a few hundred lines of well-specified
arithmetic with no I/O; rewriting it would have risked the two bugs that
implementation records — a reversed generator polynomial, a transposed format
block — both of which still produce something that looks like a QR code. The
fixtures come from the npm `qrcode` package, so the check is module-for-module
against somebody else's output.

### 3. Whose switch it is, said out loud, and held by tests

`--no-open` is forbidden to the agent BY NAME in both documents a host might
read, and `--qr` is named in both — and in `next`'s own answer, where an agent
that relays one field will actually see it. These agents follow a direct
instruction and do not infer one from surrounding prose, so the prohibition is
an invariant with a test behind it: if either document stops saying it, the
suite fails.

The same measurement that found the gap is now a test: in the owner's state,
`next` names `onboard --qr` in the hand-over and `--no-open` in the step it
hands the agent.

## Consequences

- **A browser may open on an operator's machine without them passing a flag.**
  That is the decision, and it is theirs to reverse — per run with `--no-open`,
  permanently with `WATERX_PREDICT_NO_BROWSER`. An agent doing it for them is
  what this forbids.
- **`context.openInBrowser` is gone**, replaced by `context.browser`, which
  carries the two flags, the opener when the host has one, and the memory.
- **The repository has a QR encoder it did not write.** Its provenance, its
  licence and the reason it is not a dependency are in its header.
- **`install:check` and `cli:bundle:check` set `WATERX_PREDICT_NO_BROWSER`.**
  Neither runs `onboard` today; a check that put a window on a reviewer's desk
  would be a check people stop running.
