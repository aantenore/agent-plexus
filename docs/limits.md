# Limits

Every timeout, step count, fan-out, loop bound, size cap and truncation length of the system is a setting with a
default. This page lists them all, per component: where to set each one, what it accepts, the range that is safe for
production, and what `agent-plexus check` does with it.

## How limits work

- **Where.** System limits live in the system config under `limits.<group>.<name>` (groups: `system`, `registry`,
  `router`, `attribution`). Adapter limits are options of the adapter entry (`members.<id>.options`, or
  `ports.<slot>.options`). Profiles override them like any other value: objects merge deeply, `null` restores the
  default.
- **Environment.** A limit may be a whole-string `${env:NAME}` or `${env:NAME:-default}` reference. After
  interpolation the string must be a number (or `unbounded`) in the accepted range, or the config is rejected.
- **Unbounded.** Leaving a limit out never removes it. Where it makes sense, the string `"unbounded"` turns a limit off
  explicitly; the Accepted column says where.
- **Validation.** Values outside the Accepted range are rejected when the config is loaded or the adapter is created.
  Every problem is reported at once, with its path.
- **Readiness gate.** On a production-tier profile, `agent-plexus check` prints `FAIL` for a limit marked
  `fail if unbounded` that is set to `"unbounded"`, and `WARN` for values outside the safe range. A `FAIL` fails the
  check (exit 1); warnings do not. Other tiers get no findings.
- **Declared once.** Each component declares its limits in one list (`SYSTEM_LIMITS` in `packages/core`, `limits` on
  each adapter descriptor). Validation and the readiness gate read that list.

```json
{
  "limits": { "system": { "maxSteps": "${env:PLEXUS_MAX_STEPS:-20}", "timeoutMs": 120000 } },
  "ports": { "router": { "adapter": "skill-router", "options": { "maxInputChars": 5000, "rules": [] } } },
  "profiles": { "production": { "tier": "production", "limits": { "system": { "maxParallel": 8 } } } }
}
```

Columns: **Setting** is the config path (for adapters, relative to the adapter entry). **Default** applies when the
setting is absent. **Accepted** is the validated range. **Safe range** is what production should stay within.
**On production** is the readiness gate behaviour described above.

## System config

### `limits.system`

| Setting | Default | Accepted | Safe range | On production | Why |
|---|---|---|---|---|---|
| `limits.system.timeoutMs` | `300000` ms | 1–∞ or unbounded | 1–3600000 | fail if unbounded; warn outside safe range | Deadline of a system run when the host passes none; a deadline from the host can only make it shorter. |
| `limits.system.maxSteps` | `20` | 1–∞ or unbounded | 1–100 | fail if unbounded; warn outside safe range | Member calls in one run; the next call stops with `limit`. |
| `limits.system.maxDepth` | `3` | 0–∞ or unbounded | 0–10 | fail if unbounded; warn outside safe range | Hops a system run may add when the host passes no bounds (nested systems, supervisors); the next call stops with `hop_limit`. |
| `limits.system.maxParallel` | `4` | 1–64 | 1–16 | warn outside safe range | Branches of a `parallel` node running at once. |
| `limits.system.maxIterations` | `5` | 1–100 | 1–20 | warn outside safe range | Default bound of a `loop` node. |
| `limits.system.maxHandoffs` | `10` | 1–100 | 1–20 | warn outside safe range | Default bound of a `handoff` node (planned: the kind is not run yet). |
| `limits.system.maxRepeats` | `3` | 1–100 | 1–10 | warn outside safe range | Back-and-forth round trips between the same two members before the next call stops with `limit`. |
| `limits.system.stepTimeoutMs` | `300000` ms | 1–∞ or unbounded | 1–3600000 | fail if unbounded; warn outside safe range | One member call, capped by the time left in the run. |

### `limits.registry`

| Setting | Default | Accepted | Safe range | On production | Why |
|---|---|---|---|---|---|
| `limits.registry.cardTtlMs` | `300000` ms | 0–86400000 | — | — | How long a fetched card is trusted. Planned use: `static-registry` fetches nothing yet. |
| `limits.registry.maxCardBytes` | `65536` bytes | 1024–1048576 | — | — | Largest card read. Planned use, as above. |

### `limits.router`

| Setting | Default | Accepted | Safe range | On production | Why |
|---|---|---|---|---|---|
| `limits.router.maxCandidates` | `20` | 1–200 | 1–50 | warn outside safe range | Candidates given to a router; the rest are cut off, so a large registry cannot flood a model or search router. |

### `limits.attribution`

| Setting | Default | Accepted | Safe range | On production | Why |
|---|---|---|---|---|---|
| `limits.attribution.maxRecords` | `500` | 1–100000 | — | — | Hop records read by one attribution. |

## Adapters

Ordered by layer. Set them under the adapter's `options`; an adapter not listed here has no limits
(`function-member`, `static-registry`, `basic-topology` and `rule-attribution` have none).

### `skill-router` · AgentRouterPort

| Setting | Default | Accepted | Safe range | On production | Why |
|---|---|---|---|---|---|
| `options.maxInputChars` | `10000` chars | 1–∞ | — | — | Input characters a rule's regular expression reads; bounds the cost of a slow expression on a huge input. |

### `memory-execution` · ExecutionPort

| Setting | Default | Accepted | Safe range | On production | Why |
|---|---|---|---|---|---|
| `options.maxRuns` | `1000` | 1–∞ | — | — | Runs kept in memory, with their stored steps and texts; ended runs are dropped oldest first. The adapter is prototype-only, so the gate refuses it on production anyway. |
