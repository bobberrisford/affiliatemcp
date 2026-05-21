# Handoffs

Each sub-agent writes a structured handoff document here when their chunk completes. Filename pattern: `<branch-name-with-slashes-as-dashes>.md` (e.g. `feature-foundations.md`).

Required sections:

1. **What I did** — concrete list of files created/modified
2. **What's tested** — which quality bars pass, how they were verified
3. **What's unfinished** — TODOs, deferred work, known gaps
4. **What surprised me** — unexpected findings the orchestrator should know
5. **Recommended next steps** — what the orchestrator should delegate next, and any cross-cutting concerns

The orchestrator reads the handoff, verifies the claimed quality bars, then merges the branch to `claude/affiliate-mcp-orchestration-qfKw4`.
