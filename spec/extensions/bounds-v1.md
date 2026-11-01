# Bounds extension (A2A)

Version 1. URI: `https://github.com/aantenore/agent-plexus/blob/main/spec/extensions/bounds-v1.md`

An [A2A extension](https://a2a-protocol.org/latest/topics/extensions/) that carries what is left of a run's limits to
the next agent: time, hop count and, when the run has them, a token and a cost budget. A chain of agents then works
within one set of limits instead of each agent applying its own from scratch. A2A defines no deadline, budget or hop
limit; this extension adds the three without changing any core structure.

## Data

One object, carried in `message.metadata` of a message the sender passes on, under the extension URI as key.

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `remainingMs` | integer ≥ 0 | yes | Time the receiver has left, in milliseconds. Never a clock time. |
| `hops` | integer ≥ 1 | yes | Agent-to-agent calls in the chain including this one. |
| `maxHops` | integer ≥ 1 | yes | Largest `hops` the chain accepts. |
| `tokens` | number ≥ 0 | | Tokens (input plus output) the receiver may still spend, delegated runs included. Absent: no token budget. |
| `costUsd` | number ≥ 0 | | Spend in US dollars the receiver may still incur, delegated runs included. Absent: no cost budget. |
| `rootRunId` | string | yes | Id of the run that started the chain. |
| `parentRunId` | string | yes | Id of the sender's run. |

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

## Rules

1. **Activation.** The sender lists the URI in the `A2A-Extensions` header of the request (and in `message.extensions`).
   A receiver reads the data only when the extension was activated. The agent card may declare the extension in
   `capabilities.extensions` with `required: false`: an agent that does not know it ignores the data and works as before.
2. **Remaining time, not clock time.** `remainingMs` is what is left when the message is sent. Network latency only
   shortens it, and clock differences between hosts cannot extend it. The receiver starts its own timer on receipt.
3. **Receivers only tighten.** The receiver's limits are the smaller of its own and the received ones: the time, the
   hop limit, and each budget present. It never raises a received value.
4. **Hops grow by one per call.** A sender that passes the data on sets `hops` to the `hops` of its own run plus one, and
   keeps `maxHops` (or a smaller value).
5. **Refusal.** A receiver refuses a call with `hops` above `maxHops`, or with too little time left to start. A refusal
   ends the task in the rejected state, and the extension data on the task, `{ "stop": "hop_limit" }` or
   `{ "stop": "timeout" }`, tells it apart from other rejections.
6. **Retries share the budget.** A retry carries what is left after the first attempt, never a fresh allowance.
7. **Cancellation.** A sender whose deadline passes, or that is aborted, cancels the task (`CancelTask`).
8. **Trust.** The values are asserted by the sender. They stop bugs (a loop, a delegate that forgets the deadline) and
   bound an adversary only as far as the receiver also verifies who is calling.

## Implementations

- [`a2a-member`](../../adapters/a2a-member/README.md) sends the data on every message it passes on, from the outbound
  bounds of the member call.
- The [agent-layers delegation proposal](../../docs/proposals/agent-layers-delegation-bounds.md) uses the same fields for
  its `a2a` adapter (`remainingMs`, `hops`, `maxHops`, `tokens`, `costUsd`, `rootRunId`, `parentRunId`; its optional
  `path` is not part of version 1).

## Version history

- 1: initial.
