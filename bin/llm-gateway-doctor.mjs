#!/usr/bin/env node
import { main } from '../src/cli.mjs';

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  (e) => {
    process.stderr.write(`error: ${e && e.message ? e.message : String(e)}\n`);
    process.exitCode = 2;
  },
);
