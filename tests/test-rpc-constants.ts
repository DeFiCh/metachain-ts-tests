import { expect } from 'chai';

import { CHAIN_ID } from './config';
import { describeWithMetachain } from './util';

// All test for the RPC

describeWithMetachain('Metachain RPC (Constant)', (context) => {
	it('should have 0 hashrate', async function () {
		expect(await context.web3.eth.getHashrate()).to.equal(0);
	});

	it('should have chainId', async function () {
		// The chainId is defined by the Metachain Chain Id, default to 1133
		expect(await context.web3.eth.getChainId()).to.equal(CHAIN_ID);
	});

	it('should have no account', async function () {
		const accounts = await context.web3.eth.getAccounts();
		expect(accounts.length).to.equal(4);
	});

	// NOTE(): author is removed on block struct
	// it('block author should be 0x0000000000000000000000000000000000000000', async function () {
	// 	// This address `0x1234567890` is hardcoded into the runtime find_author
	// 	// as we are running manual sealing consensus.
	// 	expect(await context.web3.eth.getCoinbase()).to.equal('0x0000000000000000000000000000000000000000');
	// });
});
