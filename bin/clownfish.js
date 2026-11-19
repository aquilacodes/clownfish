#!/usr/bin/env node
// Node >= 22.18 strips TypeScript types natively, so the CLI runs from source with no build step.
import '../src/cli/index.ts';
