# Specification

This directory is the source of truth for the contracts between the layers of a multi-agent system. It is language
neutral: a host or an adapter written in any language implements these pages. The TypeScript in `packages/core` is
one binding of the spec, not the spec itself. When the two disagree, the spec wins and the binding is fixed.

| Path | Content |
| --- | --- |
| [`language.md`](language.md) | The language 0.1: naming rules, shapes, vocabularies, `ext`, `Condition`, `TopologySpec`, stop codes, telemetry names. |
| [`hooks.md`](hooks.md) | The four host hooks: `gate`, `telemetry`, `score`, `state`, and the `Host` that carries them. |
| [`ports/`](ports/README.md) | One page per port: operations, data shapes, semantics, errors, conformance. |

JSON Schemas of the data that crosses a port, and a `VERSIONING.md` with the rules for breaking changes, are planned.
Until then the shapes are defined by the tables in these pages and by `packages/core/src/shapes.ts`.

The data shapes are written in one language, version 0.1, described in [language.md](language.md). Start with it, then
the [port index](ports/README.md), which explains the notation used on the pages and the types shared by every port,
then [hooks.md](hooks.md).

An implementation is conformant for a port when it passes the conformance suite listed on that port's page and declares
the port version it implements. Conformance suites are planned; today each adapter is covered by its own tests.
