# docs/archive — reference & build history

This folder holds **compressed records and locked contracts for already-shipped
subsystems**, plus the build/UX history of how Sutra got to its current state.

These are **reference material, not the canonical published docs.** The current,
authoritative docs live one level up:

- [`../OVERVIEW.md`](../OVERVIEW.md) — what Sutra is, principles, audience, north star
- [`../FEATURES.md`](../FEATURES.md) — everything built today (core app **+** MCP, Tier B, Your Context)
- [`../ROADMAP.md`](../ROADMAP.md) — what's next
- [`../PERFECTION-RUBRIC.md`](../PERFECTION-RUBRIC.md) — acceptance rubric
- [`../M0-research-and-plan.md`](../M0-research-and-plan.md) — locked stack decisions, diarize/ranking contracts
- [`../../README.md`](../../README.md) · [`../../PRODUCT.md`](../../PRODUCT.md) · [`../../RUN-ON-DEVICE.md`](../../RUN-ON-DEVICE.md)

## What's in here

| File | What it is | Source docs it compresses |
|---|---|---|
| [`MCP.md`](./MCP.md) | Tier A (local, read-only) MCP — locked contract still backing shipped code + the access/hosting decision rationale | `mcp-plan.md`, `mcp-access-decision.md` |
| [`TIER-B.md`](./TIER-B.md) | Tier B (hosted, multi-tenant, read+write MCP, OAuth 2.1) — locked contracts + the human run/test guide | `tier-b-plan.md`, `tier-b-phase23-contract.md`, `tier-b-test-guide.md` |
| [`YOUR-CONTEXT.md`](./YOUR-CONTEXT.md) | Your Context (priors) — the live v7 schema/contract, hard product rules, and the designed-not-built backlog | `feature.md`, `YOUR-CONTEXT-PROPOSAL.md` |
| [`BUILD-HISTORY.md`](./BUILD-HISTORY.md) | As-built internals (schema, retrieval, graph, on-device gate), dev/debug notes, the UI/UX redesign decisions, the UX audit, the 45-fix bug hunt, and the iOS-port gap list | `handoff.md`, `PHASE-1-2.md`, `redesign-plan.md`, `UX-AUDIT.md`, `UX-FIXES.md`, `gaps.md`, `issues.md` |

> Note: the live, user-facing MCP-server setup guide stays where it ships —
> [`../../mcp-server/README.md`](../../mcp-server/README.md).
