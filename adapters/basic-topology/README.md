# @agent-plexus/adapter-basic-topology

Maps **in-process topology executor** → **TopologyPort** (layer `topology`). Tier: prototype, production.

Runs a `TopologySpec` in the host process. Members are reached only through the run scope's `call`, so every member
call goes through the memberCall pipeline.

## Kinds

`sequence`, `route`, `loop`, `parallel`. `handoff`, `supervise` and `graph` are not supported yet: `bind` rejects a
spec that contains one, naming the kind and its path.

| Kind | Behaviour |
|---|---|
| `sequence` | Steps run in order, each receiving the previous output. Stops at the first step that is not `completed` and returns its result. |
| `route` | Asks the router; runs the chosen member, else `fallback`, else stops with `rejected` (layer `routing`). |
| `loop` | Runs `body` until `until` holds. Bounded by `maxIterations`, else `limits.system.maxIterations`; if the condition never holds, stops with `limit`. Each iteration receives the previous iteration's output. A body result that is not `completed` ends the loop. |
| `parallel` | Runs branches at most `limits.system.maxParallel` at a time, each reserving `1/branches` of the budget. `join: "all"` waits for all branches, returns the first non-completed one (by branch order), else the `merge` node's result or the branch outputs as `[<member or path>]` blocks. `join: "first"` returns the first completed branch, aborts the others and abandons their hops. If a branch throws, the siblings are aborted, awaited, their in-flight hops abandoned, and the error is rethrown. |

`input: "original"` on a node makes it receive the system's original input instead of the previous output. Usage and
`costUsd` of every call under a node are summed into its result.

Node paths used in hop records: `root`, `root.steps[i]`, `root.branches[i]`, `root.merge`, `root.fallback`,
`root.body#<iteration>` (iterations count from 1).

## Options

None.

```json
{
  "ports": { "topology": { "adapter": "basic-topology" } },
  "topology": { "kind": "sequence", "steps": ["triage", { "kind": "route", "candidates": ["billing"], "fallback": "triage" }] }
}
```
