---
name: sip-callflow-review skill location
description: The /sip-callflow-review command is implemented as a project skill, not a slash command — invoke its instructions directly
type: reference
---

`/sip-callflow-review` lives at `/home/vince/sipjsserver/.claude/skills/sip-callflow-review/SKILL.md`.
There is NO `.claude/commands/sip-callflow-review.*` file. The skill body asks
to "review in detail this SIP exchange and list all RFC violation" from each
agent's point of view, scoped to:
- RFC 3261 (SIP)
- RFC 3264 (Offer/Answer model)
- RFC 3262 (PRACK) / RFC 3311 (UPDATE) when applicable

Special context the skill explicitly states:
- The B2BUA is NOT simulating a real UA — it is allowed to fork upstream.
- ACK is end-to-end by design.
- Ignore proprietary `X-*` headers.

How to apply: when asked to invoke `/sip-callflow-review` on a trace, do not
try to run a slash command. Read the trace file(s) directly and apply the
skill's RFC checklist. Output should include per-agent UAS/UAC checks that
could have detected each issue, with the RFC citation.
