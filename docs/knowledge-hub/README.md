# Knowledge hub — lessons for the next session

One lesson per file, named `YYYY-MM-DD-<slug>.md`, in the schema kept at
`Bucket-Protocol/waterx-commons/knowledge-hub/SCHEMA.md` (frontmatter fields, body sections, a
worked example). Record corrections and confirmed approaches alike, including why they mattered;
a lesson is only useful with its reason. Do not save what the repository or its git history
already records: a rule belongs in `AGENTS.md`, a nested `AGENTS.md`, a skill or a code comment,
with a note here only when the story behind it is longer than the rule. Update an existing note
rather than creating a duplicate; delete a note that turns out to be wrong.

Agents: scan the `title` lines here (`grep -h '^title:' docs/knowledge-hub/*.md`) at the start
of work in an unfamiliar area, and add a note at the end of a task when you learned something
the next session would otherwise rediscover.

## Shape

```markdown
---
title: "<the lesson in one sentence>"
date: "YYYY-MM-DD"
domain: "engineering"
knowledge_type: "error"            # error | decision | pattern
source: "ai-agent"                 # human | ai-agent
source_agent: "Claude Code"        # tool name when source is ai-agent, else ""
project: "waterx-predict-agent"
tags: [<lowercase topic words>]
roles: [Backend]                   # Backend | Frontend | DevOps | DataEngineer | Contracts
error_type: runtime                # config | deploy | build | runtime | data (error entries)
severity: high                     # low | medium | high | critical
verification_command: ""           # a command that shows the lesson still holds, or ""
affected_files: ["<path>"]
related_errors: []                 # slugs of other entries
---

## Problem

## Root cause

## Resolution

## Prevention
```
