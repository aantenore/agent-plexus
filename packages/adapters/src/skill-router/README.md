# @agent-plexus/adapters/skill-router

Maps **rules on regular expressions, tags and skills** → **AgentRouterPort** (layer `routing`). Tier: prototype,
production.

Chooses a member among the candidates with declared rules, without calling anything. A rule applies when its member
is a candidate and every condition it has holds; the heaviest applicable rule wins.

## Options

| Option | Type | Default | Meaning |
|---|---|---|---|
| `rules` | object[] | required | Rules, see below |
| `fallbackRanking` | boolean | `false` | When no rule applies, return every candidate in `ranked` with score 0, still without a `member` |
| `maxInputChars` | integer | `10000` | Input characters a regular expression reads |

Rule fields:

| Field | Meaning |
|---|---|
| `member` | Member id the rule picks |
| `matches` | Regular expression on the input text; a leading `(?i)` sets the `i` flag (`m` and `s` also work) |
| `tags` | Tags the candidate must carry, across its skills (all of them) |
| `skills` | Skill ids the candidate must have (all of them) |
| `weight` | Higher wins; default 1; rule order breaks ties |

```json
{
  "ports": {
    "router": {
      "adapter": "skill-router",
      "options": { "rules": [{ "member": "billing", "matches": "(?i)invoice|refund", "weight": 2 }, { "member": "triage" }] }
    }
  }
}
```

## Behaviour

| Case | Decision |
|---|---|
| One or more rules apply | `member` is the heaviest; `ranked` lists every applicable member, best first |
| A member has several applicable rules | Its best weight counts |
| No rule applies | `{}` (no member) |
| Invalid regular expression or option | Error when the router is created |

## Limits

| Limit | Default | Why |
|---|---|---|
| `options.maxInputChars` | 10000 | Bounds the cost of a slow expression on a huge input; characters beyond it are not matched |
