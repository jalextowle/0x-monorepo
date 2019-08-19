#!/usr/bin/env node

import { logUtils } from '@0x/utils';
import chalk from 'chalk';
import * as changeCase from 'change-case';
import * as cliFormat from 'cli-format';
import {
    AbiDefinition,
    ConstructorAbi,
    ContractAbi,
    DataItem,
    DevdocOutput,
    EventAbi,
    MethodAbi,
    TupleDataItem,
} from 'ethereum-types';
import * as _ from 'lodash';
import * as mkdirp from 'mkdirp';
import * as yargs from 'yargs';

import { abiGenAsync } from './abi-gen';
import { ContractsBackend } from './types';

const DEFAULT_NETWORK_ID = 50;
const DEFAULT_BACKEND = 'web3';

(async () => {
    const args = yargs
        .option('abis', {
            describe: 'Glob pattern to search for ABI JSON files',
            type: 'string',
            demandOption: true,
        })
        .option('output', {
            alias: ['o', 'out'],
            describe: 'Folder where to put the output files',
            type: 'string',
            normalize: true,
            demandOption: true,
        })
        .option('partials', {
            describe: 'Glob pattern for the partial template files',
            type: 'string',
            implies: 'template',
        })
        .option('template', {
            describe: 'Path for the main template file that will be used to generate each contract',
            type: 'string',
            demandOption: true,
            normalize: true,
        })
        .option('backend', {
            describe: `The backing Ethereum library your app uses. For TypeScript, either 'web3' or 'ethers'. Ethers auto-converts small ints to numbers whereas Web3 doesn't. For Python, the only possibility is Web3.py`,
            type: 'string',
            choices: [ContractsBackend.Web3, ContractsBackend.Ethers],
            default: DEFAULT_BACKEND,
        })
        .option('network-id', {
            describe: 'ID of the network where contract ABIs are nested in artifacts',
            type: 'number',
            default: DEFAULT_NETWORK_ID,
        })
        .option('language', {
            describe: 'Language of output file to generate',
            type: 'string',
            choices: ['TypeScript', 'Python'],
            default: 'TypeScript',
        })
        .example(
            "$0 --abis 'src/artifacts/**/*.json' --out 'src/contracts/generated/' --partials 'src/templates/partials/**/*.handlebars' --template 'src/templates/contract.handlebars'",
            'Full usage example',
        ).argv;

    await abiGenAsync(args);
    process.exit(0);
})().catch(err => {
    logUtils.log(err);
    process.exit(1);
});
