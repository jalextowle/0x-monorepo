#!/usr/bin/env node
// We need the above pragma since this script will be run as a command-line tool.

import { buildAsync } from './build';
import { testAsync } from './test';
import * as yargs from 'yargs';

(async () => {
    if (process.argv[2] === 'build') {
        await buildAsync();
    } else if (process.argv[2] === 'test') {
        await testAsync();
    } else {
        // FIXME - Usage
        console.log(process.argv);
    }
})();
