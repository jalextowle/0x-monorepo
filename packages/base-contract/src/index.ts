import { AbiEncoder, abiUtils, BigNumber } from '@0x/utils';
import { Web3Wrapper } from '@0x/web3-wrapper';
import {
    AbiDefinition,
    AbiType,
    ConstructorAbi,
    ContractAbi,
    DataItem,
    MethodAbi,
    SupportedProvider,
    TxData,
    TxDataPayable,
} from 'ethereum-types';
import * as VM from 'ethereumjs-vm';
import * as ethers from 'ethers';
import * as _ from 'lodash';

import { formatABIDataItem } from './utils';

export interface AbiEncoderByFunctionSignature {
    [key: string]: AbiEncoder.Method;
}

// tslint:disable: max-classes-per-file
/**
 * @dev A promise-compatible type that exposes a `txHash` field.
 *      Not used by BaseContract, but generated contracts will return it in
 *      `awaitTransactionSuccessAsync()`.
 *      Maybe there's a better place for this.
 */
export class PromiseWithTransactionHash<T> implements PromiseLike<T> {
    public readonly txHashPromise: Promise<string>;
    private readonly _promise: Promise<T>;
    constructor(txHashPromise: Promise<string>, promise: Promise<T>) {
        this.txHashPromise = txHashPromise;
        this._promise = promise;
    }
    public then<TResult>(
        onFulfilled?: (v: T) => TResult | PromiseLike<TResult>,
        onRejected?: (reason: any) => PromiseLike<never>,
    ): PromiseLike<TResult> {
        return this._promise.then<TResult>(onFulfilled, onRejected);
    }
}

const REVERT_ERROR_SELECTOR = '08c379a0';
const REVERT_ERROR_SELECTOR_OFFSET = 2;
const REVERT_ERROR_SELECTOR_BYTES_LENGTH = 4;
const REVERT_ERROR_SELECTOR_END = REVERT_ERROR_SELECTOR_OFFSET + REVERT_ERROR_SELECTOR_BYTES_LENGTH * 2;

export class BaseContract {
    protected _abiEncoderByFunctionSignature: AbiEncoderByFunctionSignature;
    protected _web3Wrapper: Web3Wrapper;
    protected _bytecode: string;
    public abi: ContractAbi;
    public address: string;
    public contractName: string;
    public constructorArgs: any[] = [];
    protected static _formatABIDataItemList(
        abis: DataItem[],
        values: any[],
        formatter: (type: string, value: any) => any,
    ): any {
        return _.map(values, (value: any, i: number) => formatABIDataItem(abis[i], value, formatter));
    }
    protected static _lowercaseAddress(type: string, value: string): string {
        return type === 'address' ? value.toLowerCase() : value;
    }
    protected static _bigNumberToString(_type: string, value: any): any {
        return BigNumber.isBigNumber(value) ? value.toString() : value;
    }
    protected static _lookupConstructorAbi(abi: ContractAbi): ConstructorAbi {
        const constructorAbiIfExists = _.find(
            abi,
            (abiDefinition: AbiDefinition) => abiDefinition.type === AbiType.Constructor,
            // tslint:disable-next-line:no-unnecessary-type-assertion
        ) as ConstructorAbi | undefined;
        if (constructorAbiIfExists !== undefined) {
            return constructorAbiIfExists;
        } else {
            // If the constructor is not explicitly defined, it won't be included in the ABI. It is
            // still callable however, so we construct what the ABI would look like were it to exist.
            const defaultConstructorAbi: ConstructorAbi = {
                type: AbiType.Constructor,
                stateMutability: 'nonpayable',
                payable: false,
                inputs: [],
            };
            return defaultConstructorAbi;
        }
    }
    protected static async _applyDefaultsToTxDataAsync<T extends Partial<TxData | TxDataPayable>>(
        txData: T,
        txDefaults: Partial<TxData>,
        estimateGasAsync?: (txData: T) => Promise<number>,
    ): Promise<TxData> {
        // Gas amount sourced with the following priorities:
        // 1. Optional param passed in to public method call
        // 2. Global config passed in at library instantiation
        // 3. Gas estimate calculation + safety margin
        const removeUndefinedProperties = _.pickBy.bind(_);
        const txDataWithDefaults = {
            ...removeUndefinedProperties(txDefaults),
            ...removeUndefinedProperties(txData),
        };
        if (txDataWithDefaults.gas === undefined && estimateGasAsync !== undefined) {
            txDataWithDefaults.gas = await estimateGasAsync(txDataWithDefaults);
        }
        return txDataWithDefaults;
    }
    protected static _throwIfRevertWithReasonCallResult(rawCallResult: string): void {
        if (rawCallResult.slice(REVERT_ERROR_SELECTOR_OFFSET, REVERT_ERROR_SELECTOR_END) === REVERT_ERROR_SELECTOR) {
            const revertReasonArray = AbiEncoder.create('(string)').decodeAsArray(
                ethers.utils.hexDataSlice(rawCallResult, REVERT_ERROR_SELECTOR_BYTES_LENGTH),
            );
            if (revertReasonArray.length !== 1) {
                throw new Error(
                    `Cannot safely decode revert reason: Expected an array with one element, got ${revertReasonArray}`,
                );
            }
            const revertReason = revertReasonArray[0];
            throw new Error(revertReason);
        }
    }
    // Throws if the given arguments cannot be safely/correctly encoded based on
    // the given inputAbi. An argument may not be considered safely encodeable
    // if it overflows the corresponding Solidity type, there is a bug in the
    // encoder, or the encoder performs unsafe type coercion.
    public static strictArgumentEncodingCheck(inputAbi: DataItem[], args: any[]): string {
        const abiEncoder = AbiEncoder.create(inputAbi);
        const params = abiUtils.parseEthersParams(inputAbi);
        const rawEncoded = abiEncoder.encode(args);
        const rawDecoded = abiEncoder.decodeAsArray(rawEncoded);
        for (let i = 0; i < rawDecoded.length; i++) {
            const original = args[i];
            const decoded = rawDecoded[i];
            if (!abiUtils.isAbiDataEqual(params.names[i], params.types[i], original, decoded)) {
                throw new Error(
                    `Cannot safely encode argument: ${params.names[i]} (${original}) of type ${
                        params.types[i]
                    }. (Possible type overflow or other encoding error)`,
                );
            }
        }
        return rawEncoded;
    }
    protected async _evmExecAsync(input: Buffer): Promise<Buffer> {
        const contractCode = await this._lookupDeployedBytecodeAsync();
        return new Promise<Buffer>((resolve: any, reject: any) => {
            const vm = new VM();
            vm.runCode(
                {
                    code: Buffer.from(contractCode.substr(2), 'hex'),
                    data: input,
                    gasLimit: Buffer.from('ffffffff', 'hex'),
                },
                (err: any, res: any) => {
                    // res.return holds the successful result or the revert reason
                    // res.err only returns generic VmError
                    resolve(res.return);
                },
            );
        });
    }
    protected _lookupAbiEncoder(functionSignature: string): AbiEncoder.Method {
        const abiEncoder = this._abiEncoderByFunctionSignature[functionSignature];
        if (abiEncoder === undefined) {
            throw new Error(`Failed to lookup method with function signature '${functionSignature}'`);
        }
        return abiEncoder;
    }
    protected _lookupAbi(functionSignature: string): MethodAbi {
        const methodAbi = _.find(this.abi, (abiDefinition: AbiDefinition) => {
            if (abiDefinition.type !== AbiType.Function) {
                return false;
            }
            // tslint:disable-next-line:no-unnecessary-type-assertion
            const abiFunctionSignature = new AbiEncoder.Method(abiDefinition as MethodAbi).getSignature();
            if (abiFunctionSignature === functionSignature) {
                return true;
            }
            return false;
        }) as MethodAbi;
        return methodAbi;
    }
    protected async _lookupDeployedBytecodeAsync(): Promise<string> {
        const bytecode = this._bytecode;
        if (bytecode === '') {
            this._bytecode = await this._web3Wrapper.getContractCodeAsync(this.address);
        }
        return this._bytecode;
    }
    protected _strictEncodeArguments(functionSignature: string, functionArguments: any): string {
        const abiEncoder = this._lookupAbiEncoder(functionSignature);
        const inputAbi = abiEncoder.getDataItem().components;
        if (inputAbi === undefined) {
            throw new Error(`Undefined Method Input ABI`);
        }
        const abiEncodedArguments = abiEncoder.encode(functionArguments);
        return abiEncodedArguments;
    }
    constructor(
        contractName: string,
        abi: ContractAbi,
        address: string,
        supportedProvider: SupportedProvider,
        txDefaults?: Partial<TxData>,
    ) {
        this.contractName = contractName;
        this._web3Wrapper = new Web3Wrapper(supportedProvider, txDefaults);
        this.abi = abi;
        this.address = address;
        const methodAbis = this.abi.filter(
            (abiDefinition: AbiDefinition) => abiDefinition.type === AbiType.Function,
        ) as MethodAbi[];
        this._abiEncoderByFunctionSignature = {};
        this._bytecode = '';
        _.each(methodAbis, methodAbi => {
            const abiEncoder = new AbiEncoder.Method(methodAbi);
            const functionSignature = abiEncoder.getSignature();
            this._abiEncoderByFunctionSignature[functionSignature] = abiEncoder;
        });
    }
}
