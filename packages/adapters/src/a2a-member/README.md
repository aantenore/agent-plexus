# @agent-plexus/adapters/a2a-member

Maps the **Agent2Agent (A2A) protocol** → **MemberPort** (layer `member`). Tier: prototype, production. Maturity:
experimental. Uses the official JavaScript SDK ([`@a2a-js/sdk`](https://github.com/a2aproject/a2a-js), Apache-2.0,
client side only) for the client, the card resolver, the JSON-RPC transport and the card signature check. The SDK is
an optional peer dependency of `@agent-plexus/adapters`: `npm install @a2a-js/sdk` to use this adapter.

**Pinned version: A2A 1.0**, JSON-RPC binding. Agents that still speak 0.3 are called through the SDK's compatibility
layer (cards and the lower-case wire shapes are read as they are).

A remote agent, in any language or framework, becomes a member: each call is one A2A message. The call returns as soon
as the remote side has a task, the task id is journaled through `ctx.checkpoint`, and the task is polled until it ends
or waits. A restart resumes the same task through `resume` instead of sending the request again. Declared
`capabilities`: `resume`, `cancel`, `checkpoint`, `waits`.

## Options

| Option | Type | Default | Meaning |
|---|---|---|---|
| `url` | string | required | Agent card URL (`.../agent-card.json`) or the agent's JSON-RPC endpoint |
| `endpoint` | string | from the card | JSON-RPC endpoint to use instead of the one in the card; the card is still read for the entry |
| `allowedEndpoints` | string[] | none | URLs or origins a card may point to besides its own origin |
| `allowHttp` | boolean | `false` | Plain http to hosts that are not loopback |
| `audience` | string | none | Credential audience of the entry; from the config, never from the card |
| `keys` | object[] or string | none | Public keys (JWKs) or the URL of a JWKS document, to verify card signatures |
| `requireSigned` | boolean | `false` | Refuse a card that is unsigned or not verified by `keys` (needs `keys`) |
| `headers` | object | none | Static headers sent with every call to the endpoint (not with card or key fetches) |
| `timeoutMs` | integer or `"unbounded"` | `300000` | Time limit of one call, polling included |
| `pollMs` | integer | `500` | Interval of `GetTask` while the task is working |
| `maxCardBytes` | integer | `65536` | Largest agent card (or key set) read |
| `maxResponseBytes` | integer | `4194304` | Largest JSON-RPC answer read (min 1024) |
| `cardTtlMs` | integer | `300000` | How long a fetched card and its endpoint are trusted |
| `cancelTimeoutMs` | integer | `5000` | Time limit of each `CancelTask`: after a deadline, a failure or an abort before the checkpoint, and in `cancel` |
| `boundsUri` | `canonical` or `plexus` | `canonical` | URI of the bounds extension sent: the canonical one, or the alias for a peer that knows only that one |

```json
{
  "members": {
    "billing": {
      "adapter": "a2a-member",
      "options": {
        "url": "https://agents.example.com/billing/.well-known/agent-card.json",
        "audience": "https://agents.example.com",
        "keys": "https://agents.example.com/.well-known/jwks.json",
        "requireSigned": true
      }
    }
  }
}
```

The credential is not an option: the host's gate mints a token for `audience` and the member sends it as
`Authorization: Bearer <token>`. A member without `audience` calls the agent without a credential.

## Limits

Ranges and the production checks are declared once in the descriptor; `agent-plexus check` reads them.

| Limit | Default | Range | Production | Why |
|---|---|---|---|---|
| `options.timeoutMs` | 300000 | ≥ 1, or `"unbounded"` | fail if unbounded; warn above 3600000 | Time of one call, polling included. The time left of the run caps it further. |
| `options.pollMs` | 500 | ≥ 10 | warn outside 100–10000 | Interval of `GetTask` |
| `options.maxCardBytes` | 65536 | 1024–1048576 | | Largest card or key set read |
| `options.maxResponseBytes` | 4194304 | ≥ 1024 | | Largest JSON-RPC answer read |
| `options.cardTtlMs` | 300000 | 0–86400000 | | How long a card is trusted |
| `options.cancelTimeoutMs` | 5000 | 100–60000 | | Bounds each `CancelTask` |

All accept `${env:NAME}`.

## Behaviour

**describe.** Fetches the card (no credential, no redirects, size bounded, within `timeoutMs`, cached for `cardTtlMs`), verifies its JWS
signatures against `keys` when it has any, and maps it: name, description, version, skills (`id`, `name`,
`description`, `tags`). The endpoint is `{ protocol: "a2a", url }`. `trust.signed` is true only when a signature
verified with a configured key (`trust.keyId` is that key). `trust.pinned` is true: an entry exists only when its
endpoint came from the options or matched a configured origin. A `url` that is a JSON-RPC endpoint has no card: the
entry is minimal and cannot satisfy `requireSigned`.

**invoke.** Sends `SendMessage` with `returnImmediately`; the answer is a task (or a direct message, which completes
the call). While the task is not finished, `ctx.checkpoint` is called once with an opaque reference that holds the task
id and the context id, and `GetTask` runs every `pollMs`. The time is bounded by the smaller of `timeoutMs` and
`ctx.outbound.remainingMs`. The text of a message is its text; media parts are not sent.

**resume.** Without input: continues polling that task. With input: sends it as a message on the same task and
context (for `input-required`), then polls. Called by the core on restart with the journaled reference.

**cancel.** `CancelTask` for the task of the reference. The core calls it for a call it cut off whose task it knows
(an abort, or the core's own step or deadline timeout), and for a `waiting` task a topology abandons.

**abort and deadline.** The call returns `stopped`: `aborted` when the caller stopped it with time left, `timeout`
otherwise (the core's own timeout aborts the call signal with a `TimeoutError` reason). When this adapter's own time
runs out, on a failure, or when the call is cut off before its task was checkpointed, `CancelTask` is sent here
(bounded by `cancelTimeoutMs`). A call the core cuts off after the checkpoint, or on a resumed task, is not cancelled
here: the core holds the reference and calls `cancel`, so the task is cancelled once.

**Bounds.** Every message carries the [bounds extension](../../../../spec/extensions/bounds-v1.md): the URI is sent in the
`A2A-Extensions` header and in `message.extensions` (`required: false`; an agent that does not know it ignores it) and
`{ remainingMs, hops, maxHops, tokens?, costUsd?, rootRunId, parentRunId }` goes in `message.metadata[<uri>]`.
`remainingMs` is the smaller of `timeoutMs` and the time left, less the time already spent. The URI is the canonical
one, `https://github.com/aantenore/agent-layers/blob/main/spec/extensions/bounds-v1.md` (exported as `BOUNDS_URI`);
with `boundsUri: "plexus"` it is the alias `https://github.com/aantenore/agent-plexus/blob/main/spec/extensions/bounds-v1.md`
(`BOUNDS_ALIAS_URI`), for a peer that knows only that one. Only one URI is sent.

**Bounds report.** The report a receiver writes on the task, `task.metadata[<uri>]` under either URI, is read:
`usage` and `costUsd` settle what the call reserved (a figure not reported keeps its whole share spent), and `stop`
(`timeout`, `limit` or `hop_limit`, the receiver's own bounds stopped its run) becomes the result's code, so a call
the remote side refused over the hop limit is `stopped` with `hop_limit`, not `rejected`.

### Remote task state → result

`reason.layer` is absent for remote stops: the layer that stopped the remote run is unknown.

| Remote task state | Status | `reason.code` | Output |
|---|---|---|---|
| `completed` | `completed` | | Text of the artifacts, else of the status message |
| `canceled` | `stopped` | `aborted`, or the report's `stop` | |
| `rejected` | `stopped` | `rejected`, or the report's `stop` | |
| `input-required` | `waiting` | `needs_input` | Text of the status message; `taskRef` is set |
| `auth-required` | `waiting` | `needs_auth` | Text of the status message; `taskRef` is set |
| `failed` | `failed` | `error`; with a report's `stop`, `stopped` with that code | |
| any other state | `failed` | `error` | The native state in `ext["a2a-member.state"]` |

The remote wording of a failed or stopped task is not passed on. Usage and cost: each is read from the bounds report
first, else from `metadata["agent-layers"]` (`usage` with `inputTokens` and `outputTokens`, `costUsd`), so a system
calling an agent-layers stack accounts for the remote run. Malformed values, and a `stop` outside the three codes or
outside the report, are ignored.

Failures of this member (not of the remote task) are `failed` with code `error`, layer `member` and a fixed
`reason.detail`: `remote agent call failed` for any transport or protocol error, or a fixed refusal text for a card or
endpoint rule.

## Security

- **Endpoint pinning.** The endpoint in a card is used only when it has the origin of `url` or is listed in
  `allowedEndpoints`; otherwise the call is refused unless `endpoint` is set. A card cannot send the credential to
  another host.
- **https.** Required, except loopback, or with `allowHttp`. A URL with embedded credentials is refused.
- **Private addresses.** Private, loopback and link-local hosts are refused unless that origin is configured
  (`url`, `endpoint`, `allowedEndpoints`, or the JWKS URL). Host names are checked as written, not after DNS
  resolution: restrict egress at the network level too.
- **No redirects** on the card, the key set or any call.
- **Answer size.** The body of a JSON-RPC answer is read up to `maxResponseBytes`; a larger one fails the call with a
  fixed detail.
- **Card fetch.** No credential and no static headers; the size is bounded by `maxCardBytes`; the card is cached for
  `cardTtlMs`.
- **Signatures.** JWS over the canonical card (RFC 8785), checked with the SDK. Keys come from `keys` only: the `jku`
  of a signature is never fetched, and `kid` must match a configured key. Only public asymmetric keys (EC, RSA, OKP)
  are accepted. Fields outside the 1.0 card schema are not covered by a signature. The SDK writes a line to
  `console.debug` for each signature entry that fails to verify.
- **Audience** comes from the options, never from the card.
- **Credentials.** The target is checked before any call; the bearer token goes only to the checked endpoint and never
  into a result, an error, a log or the card fetch. Error bodies are dropped unread, so a token echoed by the remote
  side cannot reach a result. The member logs nothing and emits no spans of its own; the core's hop span covers it.
- **Output is data.** What the remote agent answers is text for the next member, never instructions: use the host's
  `gate.check` on `receive`.

## What is not done

- Streaming (`SendStreamingMessage`) and subscribing to a task: the member polls.
- Push notifications (webhooks).
- The HTTP+JSON and gRPC bindings: JSON-RPC only.
- Extended agent cards, `ListTasks`, multi-tenant routing.
- Media parts of the input and non-text parts of the answer (data parts are returned as JSON, files are dropped).
