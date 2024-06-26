import { expect } from 'chai';
import { step } from 'mocha-steps';
import { AbiItem } from 'web3-utils';

import {
    GENESIS_ACCOUNT,
    GENESIS_ALICE,
    GENESIS_ACCOUNT_PRIVATE_KEY,
    GENESIS_ALICE_PRIVATE_KEY,
    INITIAL_BASE_FEE,
} from './config';

import {
    generate,
    describeWithMetachain,
    customRequest,
    nestedSingle,
} from './util';

// Import contracts
import Incrementor from '../build/contracts/Incrementor.json';
import TraceFilter from '../build/contracts/TraceFilter.json';

describeWithMetachain('Metachain RPC (TraceTransaction - Raw)', (context) => {
    // gen(1) is required to enable evm feature in defichain ecosys
    step('should be at block 1', async function () {
        expect(await context.web3.eth.getBlockNumber()).to.equal(1);
    });

    // Test 1
    it("should replay over an intermediate state", async function () {
        const TEST_INCREMENTOR_BYTECODE = Incrementor.bytecode;
        const TEST_INCREMENTOR_ABI = Incrementor.abi as AbiItem[];

        const contract = new context.web3.eth.Contract(TEST_INCREMENTOR_ABI);
        const tx = await context.web3.eth.accounts.signTransaction(
            {
                from: GENESIS_ACCOUNT,
                data: TEST_INCREMENTOR_BYTECODE,
                value: '0x00',
                gasPrice: context.web3.utils.numberToHex(INITIAL_BASE_FEE),
                gas: '0x100000',
            },
            GENESIS_ACCOUNT_PRIVATE_KEY
        );
        await customRequest(context.web3, 'eth_sendRawTransaction', [tx.rawTransaction]);
        await generate(context.client, 1);
        let receipt0 = await context.web3.eth.getTransactionReceipt(tx.transactionHash);
        let contractAddress = receipt0.contractAddress;

        // In our case, the total number of transactions == the max value of the incrementer.
        // If we trace the last transaction of the block, should return the total number of
        // transactions we executed (10).
        // If we trace the 5th transaction, should return 5 and so on.
        //
        // So we set 5 different target txs for a single block: the 1st, 3 intermediate, and
        // the last.
        const totalTxs = 10;
        const targets = [1, 2, 5, 8, 10];
        const txs: any[] = [];
        const nonce = await context.web3.eth.getTransactionCount(GENESIS_ALICE);

        // Create 10 transactions in a block.
        for (let numTxs = nonce; numTxs <= nonce + totalTxs; numTxs++) {
            const callTx = await context.web3.eth.accounts.signTransaction(
                {
                    from: GENESIS_ALICE,
                    to: contractAddress,
                    data: contract.methods.incr(1).encodeABI(),
                    nonce: numTxs,
                    value: '0x00',
                    gas: '0x100000',
                },
                GENESIS_ALICE_PRIVATE_KEY,
            );
            const { result: data } = await customRequest(
                context.web3,
                'eth_sendRawTransaction',
                [callTx.rawTransaction],
            );
            txs.push(data);
        }
        await generate(context.client, 1);

        // Trace 5 target transactions on it.
        for (const target of targets) {
            const index = target - 1;

            await context.web3.eth.getTransactionReceipt(txs[index]);

            const { result: traceTx } = await customRequest(
                context.web3,
                'debug_traceTransaction',
                [txs[index]],
            );

            const evmResult = context.web3.utils.hexToNumber("0x" + traceTx.returnValue);
            expect(evmResult).to.equal(target);
        }
    });

    // Test 2
    it("should trace nested contract calls", async function () {
        const { result: send } = await nestedSingle(context);
        await generate(context.client, 1);
        const { result: traceTx } = await customRequest(
            context.web3,
            'debug_traceTransaction',
            [send],
        );
        const logs: any[] = [];
        for (const log of traceTx.structLogs) {
            if (logs.length == 1) {
                logs.push(log);
            }
            if (log.op == "RETURN") {
                logs.push(log);
            }
        }
        expect(logs).to.be.lengthOf(2);
        expect(logs[0].depth).to.be.equal(2);
        expect(logs[1].depth).to.be.equal(1);
    });

    // Test 3
    it("should use optional disable parameters", async function () {
        const { result: send } = await nestedSingle(context);
        await generate(context.client, 1);
        const { result: traceTx } = await customRequest(
            context.web3, 'debug_traceTransaction',
            [send, { disableMemory: true, disableStack: true, disableStorage: true }],
        );
        const logs: any[] = [];
        for (const log of traceTx.structLogs) {
            const hasStorage = Object.prototype.hasOwnProperty.call(log, "storage");
            const hasMemory = Object.prototype.hasOwnProperty.call(log, "memory");
            const hasStack = Object.prototype.hasOwnProperty.call(log, "stack");
            if (hasStorage || hasMemory || hasStack) {
                logs.push(log);
            }
        }
        expect(logs.length).to.be.equal(0);
    });

    // Test 4
    it("should trace correctly transfers (raw)", async function () {
        const callTx = await context.web3.eth.accounts.signTransaction(
            {
                from: GENESIS_ALICE,
                to: GENESIS_ACCOUNT,
                data: '0x',
                value: "0x10000000",
                gas: '0xdb3b',
            },
            GENESIS_ALICE_PRIVATE_KEY,
        );
        const { result: data } = await customRequest(
            context.web3,
            'eth_sendRawTransaction',
            [callTx.rawTransaction],
        );
        await generate(context.client, 1);
        const { result: traceTx } = await customRequest(
            context.web3,
            'debug_traceTransaction',
            [data],
        );
        expect(traceTx.gas).to.be.eq("0x5208"); // 21_000 gas for a transfer.
    });

    // Test 5
    it("should not trace call that would produce too big responses", async function () {
        const TEST_TRACE_FILTER_BYTECODE = TraceFilter.bytecode;
        const TEST_TRACE_FILTER_ABI = TraceFilter.abi as AbiItem[];

        const contract = new context.web3.eth.Contract(TEST_TRACE_FILTER_ABI);
        const bytecode = contract
            .deploy({
                data: TEST_TRACE_FILTER_BYTECODE,
                arguments: [false],
            })
            .encodeABI();
        const tx = await context.web3.eth.accounts.signTransaction(
            {
                from: GENESIS_ACCOUNT,
                data: bytecode,
                value: '0x00',
                gasPrice: context.web3.utils.numberToHex(INITIAL_BASE_FEE),
                gas: '0x100000',
            },
            GENESIS_ACCOUNT_PRIVATE_KEY
        );
        await customRequest(context.web3, 'eth_sendRawTransaction', [tx.rawTransaction]);
        await generate(context.client, 1);
        let receipt0 = await context.web3.eth.getTransactionReceipt(tx.transactionHash);
        let contractAddress = receipt0.contractAddress;

        const callTx = await context.web3.eth.accounts.signTransaction(
            {
                from: GENESIS_ALICE,
                to: contractAddress,
                gas: '0x800000',
                value: "0x00",
                // 100 represents the number of storage modified
                // 1000 represents the number of simple steps (that will have 100 storage items in trace)
                data: contract.methods.heavy_steps(100, 1000).encodeABI(),
            },
            GENESIS_ALICE_PRIVATE_KEY,
        );
        const { result: data } = await customRequest(
            context.web3,
            'eth_sendRawTransaction',
            [callTx.rawTransaction],
        );
        await generate(context.client, 1);
        expect(await customRequest(context.web3, 'debug_traceTransaction', [data])).to.deep.equal({
            id: 1,
            jsonrpc: '2.0',
            error: {
                message: `Custom error: error calling EVM : \"replayed transaction generated too ` +
                    `much data. try disabling memory or storage?\"`,
                code: -32001,
            },
        });
    });
});
