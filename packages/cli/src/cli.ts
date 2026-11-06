#!/usr/bin/env node
import { cli } from './main.ts';

process.exitCode = await cli(process.argv.slice(2));
