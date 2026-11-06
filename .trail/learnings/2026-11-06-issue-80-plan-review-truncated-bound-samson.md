---
title: "Issue 80 plan review: truncated bound MCP instructions"
author: Samson
date: 2026-11-06
branch: main
cost: { minutes: 2, tokens: 64980 }
touches:
  - src/mcp.ts
  - src/integrations.ts
---

## Decided
- Root cause of #80 is instruction text, not a missing entry point: bound serverInstructions (src/mcp.ts serverInstructions) say "do not call resolve again", and mcpHandoff (src/integrations.ts) says to skip resolve when server instructions "already contain" the profile. A truncated payload satisfies both. Fix both texts first; bump PROTOCOL (src/integrations.ts) so doctor/init flag stale CLAUDE.md blocks.
- Bound instructions should become UNBOUND plus bound selectors and the stamp line, with no bodies. Add an end-of-context manifest line (profile, role, required skill count) to resolve output so the agent can detect truncation.
- Lifecycle hooks are a conditional phase. Reuse the existing ManagedHook/hookMarker path (#49), not Ponytail's pattern. Hooks can't see the model ID, so they can only inject a "call resolve" reminder.

## Tried and ruled out
- Raising host limits or adding a new chunking scheme: for oversized output, fall back to the manifest plus the existing library_read.
- Treating `notice --hook claude` as a carrier: it's documented as never reaching model context.

## Watch out
- selectors() in src/mcp.ts gives tool args priority over bound options (args.model ?? options.model). Once every bound session calls resolve, the agent can silently override the operator's binding. Reject conflicting args in bound mode.
- The session recorder writes via "bound" at server start. After the fix that record shows selection, not delivery.
- The MCP handoff's "no server connected" fallback doesn't cover a server that's still connecting (seen in T3).
- Review comment with the full list: https://github.com/guisam/Agent-Profiles/issues/80#issuecomment-6693972406
