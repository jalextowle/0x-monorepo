import { abiGenAsync } from '@0x/abi-gen';
import { contractsGenAsync } from '@0x/contracts-gen';
import { Compiler } from '@0x/sol-compiler';
import * as fs from 'fs';

export async function buildAsync(): Promise<void> {
    // Compile contracts
    const compiler = new Compiler({});
    await compiler.compileAsync();

    // Generate contract metadata
    await contractsGenAsync();

    // Generate abi wrappers contracts
    await abiGenAsync({
        abis: getAbis(),
        output: 'generated-wrappers',
        template: '../../node_modules/@0x/abi-gen-templates/contract.handlebars',
        partials: '../../node_modules/@0x/abi-gen-templates/partials/**/*.handlebars',
        language: 'TypeScript',
        backend: 'web3',
        networkId: 50,
    });
}

function getAbis(): string {
    const JSONString = fs.readFileSync('package.json', 'utf8');
    return JSON.parse(JSONString).config.abis;
}
