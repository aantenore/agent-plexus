#!/usr/bin/env node
// The command line of @agent-plexus/cli under the short package name, so that `npx agent-plexus` runs it.
import { cli } from '@agent-plexus/cli';

process.exitCode = await cli(process.argv.slice(2));
