#!/usr/bin/env bash
# PreToolUse guard: warns when an agent tries to edit the RFC-validation
# exception ledger. Wired via .claude/settings.json (PreToolUse, Edit|Write|MultiEdit).
set -euo pipefail

input=$(cat)
file_path=$(printf '%s' "$input" | jq -r '.tool_input.file_path // ""')

case "$file_path" in
  */tests/harness/rules/rfc/exceptions.ts)
    jq -nc '{
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "ask",
        permissionDecisionReason: "STOP and reconsider before editing tests/harness/rules/rfc/exceptions.ts. This file is the RFC-validation exception ledger; adding an entry here is almost always the wrong fix. First consider: (1) Can the RULE be fixed so the message no longer trips the validator? (2) Is the TEST FIXTURE generating a malformed message that should be corrected at its source? (3) ONLY add an exception when the test deliberately injects invalid SIP to exercise a corner case — and state explicitly which case and why."
      }
    }'
    ;;
esac
