import Web3 from 'web3';
import { AbiItem } from 'web3-utils';
import { ethers } from 'ethers';
import { JsonRpcResponse } from 'web3-core-helpers';
import { TransactionConfig } from 'web3-core';
import { spawn, ChildProcess } from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import {
    CHAIN_ID,
    GENESIS_ACCOUNT,
    GENESIS_ACCOUNT_PRIVATE_KEY,
    GENESIS_ALICE,
    GENESIS_ALICE_PRIVATE_KEY,
    INITIAL_BASE_FEE,
} from './config';
import TraceCallee from '../build/contracts/TraceCallee.json';
import TraceCaller from '../build/contracts/TraceCaller.json';

import { JsonRpcClient } from '@defichain/jellyfish-api-jsonrpc';

export const PORT = 24555;
export const RPC_PORT = 24554;
export const ETH_PORT = 24551;
export const WS_PORT = 9999;

export const DISPLAY_LOG = process.env.RUST_LOG || false;
export const METACHAIN_LOG = process.env.METACHAIN_LOG || 'info';
export const METACHAIN_BUILD = process.env.METACHAIN_BUILD || 'release';
export const METACHAIN_BACKEND_TYPE = process.env.METACHAIN_BACKEND_TYPE || 'key-value';

export const BINARY_PATH = process.env.DEFID;
export const SPAWNING_TIME = 120_000;

const PRIV_KEYS = [
    {
        ownerAuthAddress: 'mwsZw8nF7pKxWH8eoKL9tPxTpaFkz7QeLU',
        ownerPrivKey: 'cRiRQ9cHmy5evDqNDdEV8f6zfbK6epi9Fpz4CRZsmLEmkwy54dWz',
        operatorAuthAddress: 'mswsMVsyGMj1FzDMbbxw2QW3KvQAv2FKiy',
        operatorPrivKey: 'cPGEaz8AGiM71NGMRybbCqFNRcuUhg3uGvyY4TFE1BZC26EW2PkC',
    },
];

export async function customRequest(web3: Web3, method: string, params: any[]) {
    return new Promise<JsonRpcResponse>((resolve, reject) => {
        (web3.currentProvider as any).send(
            {
                jsonrpc: '2.0',
                id: 1,
                method,
                params,
            },
            (error: Error | null, result?: JsonRpcResponse) => {
                if (error) {
                    reject(
                        `Failed to send custom request (${method} (${params.join(',')})): ${error.message || error.toString()
                        }`
                    );
                }
                resolve(result);
            }
        );
    });
}

export async function sendTransaction(context: { web3: Web3; client: JsonRpcClient }, payload?: TransactionConfig) {
    const defaultPayload: TransactionConfig = {
        from: GENESIS_ACCOUNT,
        value: '0x00',
        gas: '0x100000',
    };

    if (payload && !payload.gasPrice && !payload.maxFeePerGas) {
        defaultPayload.gasPrice = context.web3.utils.numberToHex(INITIAL_BASE_FEE);
    }

    if (payload && !payload.nonce) {
        defaultPayload.nonce = (await context.web3.eth.getTransactionCount(GENESIS_ACCOUNT)) || 0;
    }

    const signed = await context.web3.eth.accounts.signTransaction(
        {
            ...defaultPayload,
            ...payload,
        },
        GENESIS_ACCOUNT_PRIVATE_KEY
    );

    await customRequest(context.web3, 'eth_sendRawTransaction', [signed.rawTransaction]);
    return signed;
}

export async function createContracts(context: { web3: Web3; client: JsonRpcClient }) {
    const TEST_TRACE_CALLER_BYTECODE = TraceCaller.bytecode;
    const nonce = await context.web3.eth.getTransactionCount(GENESIS_ACCOUNT);
    const caller_tx = await context.web3.eth.accounts.signTransaction(
        {
            from: GENESIS_ACCOUNT,
            data: TEST_TRACE_CALLER_BYTECODE,
            value: '0x00',
            gasPrice: context.web3.utils.numberToHex(INITIAL_BASE_FEE),
            gas: '0x100000',
            nonce: nonce,
        },
        GENESIS_ACCOUNT_PRIVATE_KEY
    );
    await customRequest(context.web3, 'eth_sendRawTransaction', [caller_tx.rawTransaction]);

    const TEST_TRACE_CALLEE_BYTECODE = TraceCallee.bytecode;
    const callee_tx = await context.web3.eth.accounts.signTransaction(
        {
            from: GENESIS_ACCOUNT,
            data: TEST_TRACE_CALLEE_BYTECODE,
            value: '0x00',
            gasPrice: context.web3.utils.numberToHex(INITIAL_BASE_FEE),
            gas: '0x100000',
            nonce: nonce + 1,
        },
        GENESIS_ACCOUNT_PRIVATE_KEY
    );
    await customRequest(context.web3, 'eth_sendRawTransaction', [callee_tx.rawTransaction]);
    await generate(context.client, 1);

    let caller_receipt = await context.web3.eth.getTransactionReceipt(caller_tx.transactionHash);
    let callee_receipt = await context.web3.eth.getTransactionReceipt(callee_tx.transactionHash);
    return [caller_receipt.contractAddress, callee_receipt.contractAddress]
}

export async function nestedCall(
    context: { web3: Web3; client: JsonRpcClient },
    callerAddr: string,
    calleeAddr: string,
    nonce: number,
) {
    const TEST_TRACE_CALLER_ABI = TraceCaller.abi as AbiItem[];
    const contract = new context.web3.eth.Contract(TEST_TRACE_CALLER_ABI);
    const signed = await context.web3.eth.accounts.signTransaction(
        {
            from: GENESIS_ALICE,
            to: callerAddr,
            nonce: nonce,
            data: contract.methods.someAction(calleeAddr, 6).encodeABI(),
            gas: '0x100000',
            value: '0x00',
        },
        GENESIS_ALICE_PRIVATE_KEY
    );
    return await customRequest(context.web3, 'eth_sendRawTransaction', [signed.rawTransaction]);
}

export async function nestedSingle(context: { web3: Web3; client: JsonRpcClient }) {
    const addresses = await createContracts(context);
    let nonce = await context.web3.eth.getTransactionCount(GENESIS_ALICE);
    return await nestedCall(context, addresses[0], addresses[1], nonce)
}

// Create a block and finalize it.
// It will include all previously executed transactions since the last finalized block.
export async function generate(
    client: JsonRpcClient,
    nblocks: number,
    address?: string | undefined,
    maxTries: number = 1000000
): Promise<void> {
    if (!address) {
        address = PRIV_KEYS[0].ownerAuthAddress;
    }
    for (let minted = 0, tries = 0; minted < nblocks && tries < maxTries; tries++) {
        const result = await client.call('generatetoaddress', [1, address, 1], 'number');
        if (result === 1) {
            minted += 1;
        }
    }
}

// Create a block and finalize it.
// It will include all previously executed transactions since the last finalized block.
export async function generateNowait(client: JsonRpcClient) {
    const address = await client.wallet.getNewAddress();
    const response = await client.call('generatetoaddress', [1, address, 1], 'number');
}

let tmpDir;
export async function startMetachainNode(provider?: string): Promise<{
    web3: Web3;
    binary: ChildProcess;
    ethersjs: ethers.JsonRpcProvider;
    client: JsonRpcClient;
}> {
    var web3;
    if (!provider || provider == 'http') {
        web3 = new Web3(`http://127.0.0.1:${ETH_PORT}`);
    }

    const client = new JsonRpcClient(`http://test:test@127.0.0.1:${RPC_PORT}`);

    tmpDir = `/tmp/${uuidv4()}`;
    fs.mkdirSync(tmpDir);

    const genesisPath = process.env.GENESIS_PATH || `${process.cwd()}/genesis.json`;

    const cmd = BINARY_PATH;
    const args = [
        `-datadir=${tmpDir}`,
        '-regtest',
        `-ethstartstate=${genesisPath}`,
        '-gen=0',
        '-rpcpassword=test',
        '-rpcuser=test',
        `-rpcport=${RPC_PORT}`,
        `-ethrpcport=${ETH_PORT}`,
        '-jellyfish_regtest',
        '-logtimemicros',
        '-logthreadnames',
        '-debug',
        '-debugexclude=libevent',
        '-debugexclude=leveldb',
        '-debugexclude=accountchange',
        '-masternode_operator=' + PRIV_KEYS[0].operatorAuthAddress,
        '-dummypos=1',
        '-txnotokens=1',
        '-datacarriersize=40000', // Increase size of data for publishing smart contracts
    ];

    const extraArgs = [
        '-dummypos=0',
        '-txnotokens=0',
        '-amkheight=50',
        '-bayfrontheight=51',
        '-eunosheight=80',
        '-fortcanningheight=82',
        '-fortcanninghillheight=84',
        '-fortcanningroadheight=86',
        '-fortcanningcrunchheight=88',
        '-fortcanningspringheight=90',
        '-fortcanninggreatworldheight=94',
        '-fortcanningepilogueheight=96',
        '-grandcentralheight=101',
        '-metachainheight=105',
        '-subsidytest=1',
        '-txindex=1',
        "-evmestimategaserrorratio=0",
    ];

    const binary = spawn(cmd, args.concat(extraArgs));

    binary.on('error', (err) => {
        if ((err as any).errno == 'ENOENT') {
            console.error(
                `\x1b[31mMissing Metachain binary (${BINARY_PATH}).\nPlease compile the Metachain project:\ncargo build\x1b[0m`
            );
        } else {
            console.error(err);
        }
        process.exit(1);
    });

    const binaryLogs = [];
    await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
            console.error(`\x1b[31m Failed to start Metachain Template Node.\x1b[0m`);
            console.error(`Command: ${cmd} ${args.join(' ')}`);
            console.error(`Logs:`);
            console.error(binaryLogs.map((chunk) => chunk.toString()).join('\n'));
            process.exit(1);
        }, SPAWNING_TIME - 15_000);

        const onData = async (chunk) => {
            if (DISPLAY_LOG) {
                console.log(chunk.toString());
            }

            // if (chunk.toString().match(/DEBUG/)) {
            // 	console.log(chunk.toString());
            // }

            binaryLogs.push(chunk);
            // console.log(binaryLogs.map((chunk) => chunk.toString()).join('\n'));

            if (chunk.toString().match(/addcon thread start/)) {
                if (!provider || provider == 'http') {
                    try {
                        // This is needed as the EVM runtime needs to warmup with a first call
                        const chainId = await web3.eth.getChainId();
                        console.log('chainId: ', chainId);
                    } catch (err) {
                        console.log('err chainId: ', err);
                    }
                }

                clearTimeout(timer);

                if (!DISPLAY_LOG) {
                    binary.stderr.off('data', onData);
                    binary.stdout.off('data', onData);
                }
                // console.log(`\x1b[35m Starting RPC\x1b[0m`);

                await client.wallet.importPrivKey(PRIV_KEYS[0].ownerPrivKey);
                await client.wallet.importPrivKey(PRIV_KEYS[0].operatorPrivKey);

                await client.wallet.importPrivKey(GENESIS_ACCOUNT_PRIVATE_KEY.substring(2));
                await client.wallet.importPrivKey(GENESIS_ALICE_PRIVATE_KEY.substring(2));

                await generate(client, 105);

                await client.account.utxosToAccount({ [PRIV_KEYS[0].ownerAuthAddress]: '200@DFI' });
                await client.masternode.setGov({
                    ATTRIBUTES: {
                        // Enable evm
                        'v0/params/feature/evm': 'true',
                        'v0/params/feature/transferdomain': 'true',
                    },
                });
                await generate(client, 2);

                resolve();
            }
        };
        binary.stderr.on('data', onData);
        binary.stdout.on('data', onData);
    });

    if (provider == 'ws') {
        web3 = new Web3(`ws://127.0.0.1:${WS_PORT}`);
    }

    let ethersjs = new ethers.JsonRpcProvider(`http://127.0.0.1:${ETH_PORT}`, {
        chainId: CHAIN_ID,
        name: 'metachain-dev',
    });
    return { web3, binary, ethersjs, client };
}

export function describeWithMetachain(
    title: string,
    cb: (context: { web3: Web3; client: JsonRpcClient }) => void,
    provider?: string
) {
    describe(title, () => {
        let context: {
            web3: Web3;
            ethersjs: ethers.JsonRpcProvider;
            client: JsonRpcClient;
        } = { web3: null, ethersjs: null, client: null };
        let binary: ChildProcess;
        // Making sure the Metachain node has started
        before('Starting Metachain Test Node', async function () {
            this.timeout(SPAWNING_TIME);

            try {
                const init = await startMetachainNode(provider);
                context.web3 = init.web3;
                context.ethersjs = init.ethersjs;
                context.client = init.client;
                binary = init.binary;
            } catch (e) {
                console.log('Error starting node', e);
            }
        });

        after(function (done) {
            this.timeout(30000);

            const isRunning = require('is-running');
            const interval = setInterval(function () {
                if (!isRunning(binary.pid)) {
                    clearInterval(interval);
                    fs.rmdirSync(tmpDir, { recursive: true });
                    done();
                }
            }, 500);

            binary.kill();
        });

        cb(context);
    });
}

export function describeWithMetachainWs(title: string, cb: (context: { web3: Web3; client: JsonRpcClient }) => void) {
    describeWithMetachain(title, cb, 'ws');
}
