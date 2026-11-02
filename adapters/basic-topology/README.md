# @agent-plexus/adapter-basic-topology

Maps **in-process topology executor** → **TopologyPort** (layer `topology`). Tier: prototype, production.

Runs a `TopologySpec` in the host process. Members are reached only through the run scope's `call`, so every member
call goes through the memberCall pipeline.

## Kinds

`sequence`, `route`, `loop`, `parallel`, `handoff`, `supervise`, `graph`. `bind` rejects a spec with any other kind,
naming the kind and its path.

| Kind | Behaviour |
|---|---|
| `sequence` | Steps run in order, each receiving the previous output. Stops at the first step that is not `completed` and returns its result. |
| `route` | Asks the router; runs the chosen member, else `fallback`, else stops with `rejected` (layer `routing`). A failed routing decision (the router or the registry threw) runs `fallback`, else ends `failed`, code `error`, layer `routing`. |
| `loop` | Runs `body` until `until` holds. Bounded by `maxIterations`, else `limits.system.maxIterations`; if the condition never holds, stops with `limit`. Each iteration receives the previous iteration's output. A body result that is not `completed` ends the loop. |
| `parallel` | Runs branches at most `limits.system.maxParallel` at a time, each reserving `1/branches` of the budget. `join: "all"` waits for all branches, returns the first non-completed one (by branch order), else the `merge` node's result or the branch outputs as `[<member or path>]` blocks. `join: "first"` returns the first completed branch, aborts the others and abandons their hops. If a branch throws, the siblings are aborted, awaited, their in-flight hops abandoned, and the error is rethrown. |
| `handoff` | Calls `start`, then hands over turn by turn; each turn receives the previous output. After a completed turn the next member is the one the result names in `ext["plexus.handoff"]` (it must be in `members`, else stops with `rejected`, layer `topology`); else, if `router` is set, the router picks among `members` minus the current one; else the handoff ends. A turn that is not `completed` ends it with that result. Handoffs (turns after the first) are bounded by `maxHandoffs`, else `limits.system.maxHandoffs`; exceeding it stops with `limit`. |
| `supervise` | Calls `supervisor` with the node input. A completed result that names `ext["plexus.delegate"] = { member, input? }` delegates: `member` must be in `members` (else stops with `rejected`, layer `topology`), and is called with `input` when given (a text or `{ text }`), else with the supervisor's output. The supervisor is then called again with the turn as its input, `[<member>]` then the member's output, the block format of `parallel`. This repeats until the supervisor completes without a delegation: that result is the node's. A result that is not `completed`, from the supervisor or a member, ends the node with it (a `waiting` one included). Delegations are bounded by `limits.system.maxHandoffs`; one more stops with `limit`. |
| `graph` | Runs `nodes[start]`, then follows the first edge from the node (declaration order) that applies: an edge with `when` applies when the condition holds for the node's result, an edge without `when` only when the result is `completed`. The next node receives the output. With no edge: a `completed` result at a node in `end` finishes the graph, a result that is not `completed` is returned as is, anything else stops with `rejected` (layer `topology`). A node may be visited at most `limits.system.maxIterations` times (cycles are loops); one more stops with `limit`. |

The keys `plexus.handoff` and `plexus.delegate` are the protocol keys of the `ext` of a member's result (see
[the language](../../spec/language.md#extensions-ext)). The bare `handoff` and `delegate` of 0.1.0 are deprecated:
they are still read, and the `plexus.` key wins when a result sets both.

`input: "original"` on a node makes it receive the system's original input instead of the previous output. Usage and
`costUsd` of every call under a node are summed into its result.

Node paths used in hop records: `root`, `root.steps[i]`, `root.branches[i]`, `root.merge`, `root.fallback`,
`root.body#<iteration>` (iterations count from 1), `root.turns[i]` (handoff turns), `root.supervisor[i]` (the
supervisor's turns, from 0) and `root.members[i]` (the member of delegation `i`, from 0), `root.nodes.<id>` (graph nodes; a
revisit is `root.nodes.<id>#<visit>` from the second visit on). The route that picks a handoff turn is asked under the
path of that turn.

## Options

None.

```json
{
  "ports": { "topology": { "adapter": "basic-topology" } },
  "topology": { "kind": "sequence", "steps": ["triage", { "kind": "route", "candidates": ["billing"], "fallback": "triage" }] }
}
```
