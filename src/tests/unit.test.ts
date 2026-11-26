import assert from 'node:assert/strict';
import { zeroAddress } from 'viem';
import { mainnet } from 'viem/chains';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { Keypair, PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import bs58 from 'bs58';
import { TronWeb } from 'tronweb';
import {
  computeExactFundingWei,
  parseEip7702Delegation,
} from '../utils/config.js';
import { buildAtomicSplRelayInstructions, parseSolKeypair, SOL_USDT_MINT } from '../sol/rescue.js';
import { auditTronPermissions, buildOfflineSignedTrxTransfer } from '../trx/rescue.js';

async function runTests() {
  console.log('1. Testing EIP-7702 delegation bytecode detection...');
  assert.equal(
    parseEip7702Delegation('0xef0100cd7b35a913dff15a364e4611d2db1cfcb179ae5b'),
    '0xcd7b35a913dff15a364e4611d2db1cfcb179ae5b'
  );
  assert.equal(parseEip7702Delegation('0x'), null);
  assert.equal(parseEip7702Delegation('0x6080604052'), null);
  console.log('   PASS');

  console.log('2. Testing exact-wei funding math (matching real tx 0x8985ee... / 0x72714d...)...');
  const funding = computeExactFundingWei({
    victimExistingBalance: 0n,
    txGasLimits: [21000n],
    txValues: [963_861_000_000_000n],
    maxFeePerGas: 589_857_508n,
    useExistingBalance: false,
  });
  assert.equal(funding.sponsorFundingWei, 976_248_007_668_000n);
  console.log('   PASS (exact to 1 wei: 976248007668000)');

  console.log('3. Testing offline 3-tx EIP-7702 Revoke + Pre-fund + Transfer signing...');
  const sponsor = privateKeyToAccount(generatePrivateKey());
  const victim = privateKeyToAccount(generatePrivateKey());
  const recipient = privateKeyToAccount(generatePrivateKey()).address;

  const auth = await victim.signAuthorization({
    contractAddress: zeroAddress,
    chainId: mainnet.id,
    nonce: 20,
  });
  const tx1 = await sponsor.signTransaction({
    chainId: mainnet.id,
    type: 'eip7702',
    to: sponsor.address,
    value: 0n,
    nonce: 0,
    gas: 50000n,
    maxFeePerGas: 589_857_508n,
    maxPriorityFeePerGas: 500_000_000n,
    authorizationList: [auth],
  });
  const tx2 = await sponsor.signTransaction({
    chainId: mainnet.id,
    type: 'eip1559',
    to: victim.address,
    value: funding.sponsorFundingWei,
    nonce: 1,
    gas: 21000n,
    maxFeePerGas: 589_857_508n,
    maxPriorityFeePerGas: 500_000_000n,
  });
  const tx3 = await victim.signTransaction({
    chainId: mainnet.id,
    type: 'eip1559',
    to: recipient,
    value: 963_861_000_000_000n,
    nonce: 21,
    gas: 21000n,
    maxFeePerGas: 589_857_508n,
    maxPriorityFeePerGas: 500_000_000n,
  });
  assert.ok(tx1.startsWith('0x04'), 'Tx 1 must be EIP-7702 Type 4');
  assert.ok(tx2.startsWith('0x02'), 'Tx 2 must be EIP-1559 Type 2');
  assert.ok(tx3.startsWith('0x02'), 'Tx 3 must be EIP-1559 Type 2');
  console.log('   PASS (all 3 raw bundle txs signed cleanly)');

  console.log('4. Testing Solana keypair parsing (Base58 & JSON array)...');
  const kp = Keypair.generate();
  const parsedB58 = parseSolKeypair(bs58.encode(kp.secretKey), 'test-b58');
  const parsedJson = parseSolKeypair(JSON.stringify(Array.from(kp.secretKey)), 'test-json');
  assert.equal(parsedB58.publicKey.toBase58(), kp.publicKey.toBase58());
  assert.equal(parsedJson.publicKey.toBase58(), kp.publicKey.toBase58());
  console.log('   PASS');

  console.log('5. Testing Tron permission audit (clean vs multi-sig takeover)...');
  const tw = new TronWeb({ fullHost: 'https://api.trongrid.io' });
  const victimTrx = await tw.createAccount();
  const attackerTrx = await tw.createAccount();

  const cleanAudit = auditTronPermissions(
    tw,
    {
      address: victimTrx.address.hex,
      owner_permission: {
        threshold: 1,
        keys: [{ address: victimTrx.address.hex, weight: 1 }],
      },
      active_permission: [
        {
          permission_name: 'active',
          threshold: 1,
          keys: [{ address: victimTrx.address.hex, weight: 1 }],
        },
      ],
    },
    victimTrx.address.base58
  );
  assert.equal(cleanAudit.isCompromisedMultiSig, false);

  const hijackedAudit = auditTronPermissions(
    tw,
    {
      address: victimTrx.address.hex,
      owner_permission: {
        threshold: 2,
        keys: [
          { address: attackerTrx.address.hex, weight: 2 },
          { address: victimTrx.address.hex, weight: 1 },
        ],
      },
      active_permission: [
        {
          permission_name: 'active',
          threshold: 2,
          keys: [{ address: attackerTrx.address.hex, weight: 2 }],
        },
      ],
    },
    victimTrx.address.base58
  );
  assert.equal(hijackedAudit.isCompromisedMultiSig, true);
  console.log('   PASS');

  console.log('6. Testing Tron offline pre-signed TransferContract (0 balance victim)...');
  const now = Date.now();
  const signedTrx = await buildOfflineSignedTrxTransfer({
    tronWeb: tw,
    fromPrivateKey: victimTrx.privateKey,
    fromBase58: victimTrx.address.base58,
    toBase58: attackerTrx.address.base58,
    amountSun: 4_000_000,
    refBlockBytes: 'abcd',
    refBlockHash: '0123456789abcdef',
    timestamp: now,
    expiration: now + 60_000,
  });
  assert.ok(typeof signedTrx.txID === 'string' && signedTrx.txID.length === 64);
  assert.ok(Array.isArray(signedTrx.signature) && signedTrx.signature.length === 1);
  console.log('   PASS');

  console.log('7. Testing Solana 1-Tx Atomic SPL Relay instruction builder...');
  const solSponsor = Keypair.generate();
  const solVictim = Keypair.generate();
  const solRecipient = Keypair.generate();
  const relayBuilt = buildAtomicSplRelayInstructions({
    sponsor: solSponsor.publicKey,
    victim: solVictim.publicKey,
    recipient: solRecipient.publicKey,
    mint: new PublicKey(SOL_USDT_MINT),
    programId: TOKEN_PROGRAM_ID,
    amountRaw: 1_500_000n,
    decimals: 6,
    closeVictimAta: true,
  });
  assert.equal(relayBuilt.instructions.length, 5);
  console.log('   PASS (5 atomic instructions: 2x createATA + 2x transferChecked + closeATA)');

  console.log('\nALL UNIT TESTS PASSED!');
}

runTests().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
