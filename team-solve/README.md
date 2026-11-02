# team-solve

A pi **saved SubagentWorkflow**: solve one coding task with a small agent team,
adapted from [memdoor](https://github.com/guregodevo/memdoor)'s
`examples/workflows/team-solve` (a 5-agent harness that outscored one
big-model call 9.8 vs 8.0 on LiveCodeBench).

Pipeline, each phase a subagent:

```
plan → [ideate-a ∥ ideate-b] → solve → test → review → repair? → verify
```

Rules carried over from the original:

- **Evidence ledger on disk** — `/tmp/team-solve/<epoch>/` holds `plan.md`,
  `proposal-a.md`, `proposal-b.md`, `solution-notes.md`, `test-output.txt`.
  A fresh directory is created per run by the plan agent (epoch from
  `date +%s`); `args.scratchDir` overrides. Nothing lands in the project
  directory, so no `.gitignore` entry is needed. `/tmp` is shared scratch on
  this machine — keep secret-bearing tasks out of it.
- **Two deliberately divergent proposals** before implementing.
- **Truth is the captured artifact** — the test step saves command output +
  exit code; the reviewer must quote real lines, and may modify nothing.
- **Repair is capped at one round.** The final verify gate's exit code decides
  the run — never "the model said so".

Deviation from the original: proposals go to two separate files instead of
parallel appends into one ledger with unique markers — same information,
no write-race.

## Invoke

```
SubagentWorkflow({ name: "team-solve", args: {
  task: "Add a retry helper to src/client.ts with exponential backoff",
  testCommand: "npm test",          // optional; auto-writes a test if omitted
  scratchDir: "run/team-solve",     // optional
} })
```

`testCommand` runs from the session working directory and must exit 0. With no
`testCommand`, the test agent writes and runs a minimal objective check
instead.

## Install

```
ln -s "$PWD/team-solve/team-solve.js" ~/.pi/agent/workflows/team-solve.js
```
