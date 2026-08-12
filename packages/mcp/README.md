# @waterx/predict-agent-mcp — reserved, not implemented

**There is no MCP adapter yet.** This directory reserves the package boundary so
that an optional adapter's protocol dependencies never enter the published SDK
library (ADR-0001 §4). It contains no source and publishes nothing.

The design constraint matters more than the timing: an adapter is a **thin
translation** over `@waterx/predict-agent-schema` and
`@waterx/predict-agent-sdk`. It advertises the commands in
`schemas/v1/agent-commands.json`, validates with the same validator, and calls
the SDK method each command's `implementation` names. It does not define
commands of its own, relax a rule, or
add a shortcut — the moment it does, the same instruction means two different
things depending on which host an agent is running in.

Implementation is tracked as backlog item 3.2. Whether MCP ships in the first
wave is still open (D-28), which is exactly why this is a boundary and not a
build.
