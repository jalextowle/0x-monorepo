#!/usr/bin/env node

import { logUtils } from '@0x/utils';

import { contractsGenAsync } from './contracts-gen';

contractsGenAsync()
    .then(() => {
        process.exit(0);
    })
    .catch(err => {
        logUtils.log(err);
        process.exit(1);
    });
