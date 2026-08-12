# @waterx/predict-agent-cli — reserved, not implemented

**There is no CLI yet.** This directory reserves the package boundary so that
CLI argument parsing, terminal output and interactive approval never become
dependencies of the published SDK library (ADR-0001 §4). It contains no source
and publishes nothing; `private: true` keeps it that way.

Implementation is tracked as backlog items 1.3 and 1.6. Until then, use
`@waterx/predict-agent-sdk` directly.

When it exists it will depend on `@waterx/predict-agent-schema` for validation
and `@waterx/predict-agent-sdk` for execution — never the reverse — and it will
follow the contract in `docs/AGENT_INSTALLATION_AND_RUNTIME_PLAN.md` §6.3:
a single stable JSON document on stdout under `--json`, diagnostics on stderr,
stable exit codes with a symbolic `error.code`, and no secrets in any output.
