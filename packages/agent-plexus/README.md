# agent-plexus

The [agent-plexus](https://github.com/aantenore/agent-plexus) command line under its short name. This package only
forwards to [`@agent-plexus/cli`](https://www.npmjs.com/package/@agent-plexus/cli), which it depends on: every command,
option and exit code is that package's, documented in its README.

```bash
npx agent-plexus --help
npm install --save-dev @agent-plexus/cli @agent-plexus/core @agent-plexus/adapters    # the supported install
```

A project installs `@agent-plexus/cli` itself (the line above): its `agent-plexus` command is the same one. This
package exists so that `npx agent-plexus` resolves to the project's own command line and not to a package someone else
publishes under the name.

Requires Node >= 22.18. License: MIT.
