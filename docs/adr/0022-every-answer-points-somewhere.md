# ADR-0022 — Every answer points somewhere, and says whose step it is

- Status: Accepted
- Date: 2026-09-21
- Decides: that every envelope carries one runnable pointer, and how a step
  whose signature is a person's is handed to the agent that must run its command
- Amends: ADR-0020 (the split between a person's steps and the agent's now
  covers the owner's state too)
- Affects: `packages/cli` (`envelope`, `run`, `next`, `onboard`, `configure`,
  `policy`)

## Context

Two install sessions of the perp agent stopped one command short of what their
user needed, and the same two shapes were present here.

**An outcome with no exit.** `bootstrap` returned `status`, `message` and
`details` and no pointer on the path it takes most often. The session read that
as the end of the road and stopped (`waterx-agent` #31). Here, only `next` and
`configure` handed anything back; `onboard` returned a `nextStep` in prose with
no command in it, and every refusal ended with an error and nothing else.

**A step attributed to the wrong person.** `next` answers the owner's state with
`actor: ACCOUNT_OWNER` and `stop: true`, which is correct — a signature in
somebody else's wallet is not the agent's to give. But the command that prints
the link, waits for the grant and adopts the account is the AGENT's, and the
screen led with the person. A real session read "ask the account owner", stopped,
and produced no link at all — so the owner it was waiting for never received
anything to sign (`waterx-agent` #32). The two halves are both true and they
attach to different people.

## Decision

### 1. `meta.nextCommand`, on every envelope

Success or refusal, every answer carries one command to run next. The default is
`waterx-predict next`, which answers in every state — so the fallback is never a
dead end — and a command may name a better one through `context.pointTo`.

**It is a promise about copying, not composing.** `pointTo` refuses, and the
default stands, for either of the two things a host must not supply on its own:

- a `<placeholder>` — a value only a person can choose. `order preview` returns
  the `order execute --approve <token> --approver <name>` line, and that line is
  deliberately NOT a pointer: filling in an approval is the one thing that must
  not be automatic (ADR-0018).
- `--yes` — a person's consent to widen what may be signed (ADR-0021). The
  refusal names it in its message, where a person reads it; the pointer does not.

`meta` is therefore never absent now. It used to be omitted when there was
nothing to report; what it always has to report is where to go.

### 2. The owner's state carries the agent's own command

`AWAITING_OWNER` keeps `stop: true` and `actor: ACCOUNT_OWNER` — a person really
must sign — and now also carries `agentSteps`, the same field a host already
learned to read during setup (ADR-0020):

```
headline: … Send them the link, then run the step below while they sign.
handOver: to ACCOUNT_OWNER — send the owner this link …
agentSteps: waterx-predict onboard --wait
            safeBecause: it reads; it signs the login challenge and nothing
            else, grants nothing, and cannot make the owner's decision — only
            notice when they have made it.
meta.nextCommand: waterx-predict onboard --wait
```

`onboard` itself points at `onboard --wait` until the grant lands, including
after a wait that ran out: a wait running out is not a refusal, and resuming
means calling it again.

## Consequences

- **No envelope is a dead end**, and the pointer is in one place rather than in
  each command's `data` under a different name. The ad-hoc `then` fields added
  with ADR-0020 and ADR-0021 are gone; `pointTo` replaced them.
- **`EnvelopeMeta` is always present.** Anything asserting its absence was
  asserting that an answer could be terminal.
- **A host that stops at the owner's step is still doing the right thing** — it
  just has a command to run while it waits, and a link to hand over that it has
  actually produced.
- **The rule has teeth rather than prose.** The two exclusions live in
  `pointTo`, so a command that tries to point at `--yes` or at a placeholder
  gets the safe default instead of a reviewer's note.
