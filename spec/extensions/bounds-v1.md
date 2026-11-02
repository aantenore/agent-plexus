# Bounds extension (A2A), alias URI

Version 1. Canonical specification: the agent-layers
[bounds extension](https://github.com/aantenore/agent-layers/blob/main/spec/extensions/bounds-v1.md), URI
`https://github.com/aantenore/agent-layers/blob/main/spec/extensions/bounds-v1.md`.

This file is the **alias** URI: `https://github.com/aantenore/agent-plexus/blob/main/spec/extensions/bounds-v1.md`, the
URI under which the same data was first published here. A receiver that implements the extension accepts both URIs
with the same meaning; a sender uses one. The rules, the validation and the activation are those of the canonical
text; this file summarises the data and the report so the alias keeps a readable target.

An [A2A extension](https://a2a-protocol.org/latest/topics/extensions/) that carries what is left of a run's limits to
the next agent: time, hop count and, when the run has them, a token and a cost budget. A chain of agents then works
within one set of limits instead of each agent applying its own from scratch.

## Data

One object, carried in `message.metadata` of a message the sender passes on, under the extension URI as key.

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `remainingMs` | integer ≥ 0 | yes | Time the receiver has left, in milliseconds. Never a clock time. |
| `hops` | integer ≥ 0 | yes | Agent-to-agent calls in the chain including this one. A sender sets at least 1. |
| `maxHops` | integer ≥ 0 | yes | Largest `hops` the chain accepts. |
| `tokens` | number ≥ 0 | | Tokens (input plus output) the receiver may still spend, delegated runs included. Absent: no token budget. |
| `costUsd` | number ≥ 0 | | Spend in US dollars the receiver may still incur, delegated runs included. Absent: no cost budget. |
| `rootRunId` | string, 1 to 128 printable characters | yes | Id of the run that started the chain. |
| `parentRunId` | string, 1 to 128 printable characters | yes | Id of the sender's run. |

```json
{
  "message": {
    "extensions": ["https://github.com/aantenore/agent-plexus/blob/main/spec/extensions/bounds-v1.md"],
    "metadata": {
      "https://github.com/aantenore/agent-plexus/blob/main/spec/extensions/bounds-v1.md": {
        "remainingMs": 45000, "hops": 2, "maxHops": 4, "costUsd": 0.5, "rootRunId": "run-a1", "parentRunId": "run-b7"
      }
    }
  }
}
```

## Report

On the task it returns, a receiver that activated the extension writes one object under the activated URI in
`task.metadata`:

| Field | Type | Meaning |
| --- | --- | --- |
| `usage` | `{inputTokens, outputTokens}`, integers ≥ 0 | Tokens the run spent, delegated runs included, when known. |
| `costUsd` | number ≥ 0 | What the run cost, delegated runs included, when known. |
| `stop` | `timeout`, `limit` or `hop_limit` | Present only when the receiver's own bounds stopped the run: its deadline, its budget, or the hop limit. |

The sender settles what it reserved for the call with `usage` and `costUsd`; a figure that is not reported keeps its
whole share spent. `stop` tells a refusal over the hop limit or the deadline apart from other rejections.

## Implementations

- [`a2a-member`](../../adapters/a2a-member/README.md) sends the canonical URI by default and this alias with
  `boundsUri: "plexus"`, for peers that know only this one; it reads the report under either URI.
- The agent-layers `a2a` adapter (runtime and channel) accepts both URIs and writes the report under the one the client
  activated.

## Version history

- 1: initial. Published here first; the canonical text moved to agent-layers (ADR 0002), which added the task report.
