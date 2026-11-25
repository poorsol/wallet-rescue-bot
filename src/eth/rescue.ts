import {
  createPublicClient,
  encodeFunctionData,
  erc20Abi,
  erc721Abi,
  formatEther,
  formatGwei,
  http,
  keccak256,
  parseEther,
  parseGwei,
  parseUnits,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem';
import { mainnet } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import {
  computeExactFundingWei,
  log,
  normalizeEthAddress,
  normalizeHexKey,
  optionalEnv,
  parseCsvEnv,
  parseEip7702Delegation,
  requireEnv,
  sleep,
} from '../utils/config.js';
import { MevBundleClient } from './mevBundle.js';

const DEFAULT_BUILDERS = [
  'https://rpc.titanbuilder.xyz',
  'https://relay.flashbots.net',
  'https://rpc.beaverbuild.org',
  'https://rsync-builder.xyz',
];

export type EthRescueMode = 'eth' | 'erc20' | 'erc721' | 'custom';

export interface EthRescueOptions {
  mode: EthRescueMode;
  recipient?: string;
  // For mode = 'eth'
  ethAmount?: string; // in ETH, e.g. "0.001"
  useExistingEth?: boolean; // if true and ethAmount omitted, sweeps victim's existing ETH
  // For mode = 'erc20'
  tokenAddress?: string;
  tokenAmount?: string; // human units or "max"
  // For mode = 'erc721'
  nftAddress?: string;
  tokenId?: string;
  // For mode = 'custom'
  customTo?: string;
  customData?: string;
  customValueEth?: string;
  customGasLimit?: string;
  // Optional follow-up ERC-20 sweep after custom call (e.g. claim() -> transfer())
  followUpTokenAddress?: string;
  followUpTokenAmount?: string;
  // Bundle / execution options
  forceRevoke7702?: boolean;
  priorityFeeGwei?: string;
  dryRun?: boolean;
}

function getEthPublicClient() {
  const rpcUrl = optionalEnv('ETH_RPC_URL', 'https://ethereum-rpc.publicnode.com');
  return createPublicClient({
    chain: mainnet,
    transport: http(rpcUrl),
  });
}

export async function checkEthWallet(
  overrideAddress?: string,
  optionalTokenAddress?: string
): Promise<void> {
  log.title('ETHEREUM MAINNET - CEK STATUS WALLET');
  const client = getEthPublicClient();

  let targetAddr: Address;
  if (overrideAddress) {
    targetAddr = normalizeEthAddress(overrideAddress, 'Address');
  } else {
    const victimKey = normalizeHexKey(
      requireEnv('ETH_VICTIM_PRIVATE_KEY', 'isi atau masukkan address secara manual'),
      'ETH_VICTIM_PRIVATE_KEY'
    );
    targetAddr = privateKeyToAccount(victimKey).address;
  }

  const [balance, nonce, code, blockNumber, feeData] = await Promise.all([
    client.getBalance({ address: targetAddr }),
    client.getTransactionCount({ address: targetAddr }),
    client.getCode({ address: targetAddr }),
    client.getBlockNumber(),
    client.estimateFeesPerGas(),
  ]);

  const delegatedTo = parseEip7702Delegation(code);

  console.log(`Address         : ${targetAddr}`);
  console.log(`Block saat ini  : #${blockNumber}`);
  console.log(`ETH Balance     : ${formatEther(balance)} ETH (${balance} wei)`);
  console.log(`Nonce saat ini  : ${nonce}`);
  console.log(
    `Base/Max Fee    : ~${formatGwei(feeData.maxFeePerGas ?? 0n)} Gwei (prio: ${formatGwei(feeData.maxPriorityFeePerGas ?? 0n)} Gwei)`
  );

  if (delegatedTo) {
    log.warn(`TERDETEKSI DELEGASI EIP-7702!`);
    console.log(`  -> Bytecode   : ${code}`);
    console.log(`  -> Contract   : ${delegatedTo}`);
    console.log(`  -> Status     : Wallet ini sedang didelegasikan ke kontrak (kemungkinan sweeper/drainer).`);
    console.log(`  -> Solusi     : Bot rescue akan otomatis menyisipkan Tx #1 (Revoke 7702 -> 0x000...000) di dalam private bundle.`);
  } else if (code && code !== '0x') {
    log.warn(`Alamat ini adalah smart contract (panjang bytecode: ${(code.length - 2) / 2} bytes).`);
  } else {
    log.ok(`Tidak ada delegasi EIP-7702 aktif (EOA bersih).`);
  }

  if (optionalTokenAddress) {
    const tokenAddr = normalizeEthAddress(optionalTokenAddress, 'Token Address');
    try {
      const [symbol, decimals, tokBal] = await Promise.all([
        client.readContract({ address: tokenAddr, abi: erc20Abi, functionName: 'symbol' }),
        client.readContract({ address: tokenAddr, abi: erc20Abi, functionName: 'decimals' }),
        client.readContract({
          address: tokenAddr,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [targetAddr],
        }),
      ]);
      const human = Number(tokBal) / 10 ** decimals;
      console.log(`Token ${symbol}      : ${human} ${symbol} (raw: ${tokBal})`);
    } catch (err: any) {
      log.warn(`Gagal membaca ERC-20 ${tokenAddr}: ${err?.shortMessage ?? err?.message}`);
    }
  }

  // Also show sponsor status if configured
  const sponsorRaw = optionalEnv('ETH_SPONSOR_PRIVATE_KEY');
  if (sponsorRaw) {
    try {
      const sponsorAddr = privateKeyToAccount(
        normalizeHexKey(sponsorRaw, 'ETH_SPONSOR_PRIVATE_KEY')
      ).address;
      const [sBal, sNonce] = await Promise.all([
        client.getBalance({ address: sponsorAddr }),
        client.getTransactionCount({ address: sponsorAddr }),
      ]);
      console.log(`\nSponsor Wallet  : ${sponsorAddr}`);
      console.log(`Sponsor Balance : ${formatEther(sBal)} ETH (nonce: ${sNonce})`);
    } catch {
      // ignore invalid optional sponsor during check
    }
  }
}

interface VictimActionTx {
  label: string;
  to: Address;
  data: Hex;
  value: bigint;
  gasLimit: bigint;
}

export async function runEthRescue(options: EthRescueOptions): Promise<void> {
  log.title(`ETHEREUM MAINNET - PRIVATE MEV RESCUE (${options.mode.toUpperCase()})`);

  const client = getEthPublicClient();
  const sponsorAccount = privateKeyToAccount(
    normalizeHexKey(requireEnv('ETH_SPONSOR_PRIVATE_KEY'), 'ETH_SPONSOR_PRIVATE_KEY')
  );
  const victimAccount = privateKeyToAccount(
    normalizeHexKey(requireEnv('ETH_VICTIM_PRIVATE_KEY'), 'ETH_VICTIM_PRIVATE_KEY')
  );
  const recipient = normalizeEthAddress(
    options.recipient || requireEnv('ETH_SAFE_RECIPIENT'),
    'Safe Recipient'
  );

  const builders = parseCsvEnv('ETH_MEV_BUILDERS', DEFAULT_BUILDERS);
  const flashbotsKeyRaw = optionalEnv('ETH_FLASHBOTS_AUTH_KEY');
  const flashbotsKey = flashbotsKeyRaw
    ? normalizeHexKey(flashbotsKeyRaw, 'ETH_FLASHBOTS_AUTH_KEY')
    : undefined;
  const mev = new MevBundleClient(builders, flashbotsKey);

  const priorityFeeGwei =
    options.priorityFeeGwei || optionalEnv('ETH_PRIORITY_FEE_GWEI', '1.5');
  const baseFeeMultiplier = Number(optionalEnv('ETH_BASE_FEE_MULTIPLIER', '1.35'));
  const maxAttempts = Number(optionalEnv('ETH_TARGET_BLOCK_ATTEMPTS', '15'));

  // 1. Fetch live state
  const [block, sponsorNonce, victimNonce, sponsorBalance, victimBalance, victimCode] =
    await Promise.all([
      client.getBlock({ blockTag: 'latest' }),
      client.getTransactionCount({ address: sponsorAccount.address }),
      client.getTransactionCount({ address: victimAccount.address }),
      client.getBalance({ address: sponsorAccount.address }),
      client.getBalance({ address: victimAccount.address }),
      client.getCode({ address: victimAccount.address }),
    ]);

  const delegatedTo = parseEip7702Delegation(victimCode);
  const needsRevoke7702 = Boolean(delegatedTo) || Boolean(options.forceRevoke7702);

  const baseFee = block.baseFeePerGas ?? parseGwei('1');
  const maxPriorityFeePerGas = parseGwei(priorityFeeGwei);
  const bufferedBaseFee =
    (baseFee * BigInt(Math.round(baseFeeMultiplier * 100))) / 100n;
  const maxFeePerGas = bufferedBaseFee + maxPriorityFeePerGas;

  console.log(`Sponsor Wallet  : ${sponsorAccount.address} (bal: ${formatEther(sponsorBalance)} ETH, nonce: ${sponsorNonce})`);
  console.log(`Victim Wallet   : ${victimAccount.address} (bal: ${formatEther(victimBalance)} ETH, nonce: ${victimNonce})`);
  console.log(`Safe Recipient  : ${recipient}`);
  console.log(`EIP-7702 Active : ${delegatedTo ? `YA (${delegatedTo}) -> AKAN DI-REVOKE DI TX #1` : 'Tidak'}`);
  console.log(
    `Gas Config      : baseFee=${formatGwei(baseFee)} Gwei | maxPriority=${formatGwei(maxPriorityFeePerGas)} Gwei | maxFee=${formatGwei(maxFeePerGas)} Gwei`
  );

  // 2. Build victim rescue action(s)
  const victimActions: VictimActionTx[] = [];

  if (options.mode === 'eth') {
    let sendValue: bigint;
    if (options.ethAmount) {
      sendValue = parseEther(options.ethAmount);
    } else if (options.useExistingEth && victimBalance > 21000n * maxFeePerGas) {
      sendValue = victimBalance - 21000n * maxFeePerGas;
    } else {
      throw new Error(
        'Untuk mode ETH, tentukan jumlah ETH (--amount 0.001) atau pastikan victim punya saldo ETH lebih besar dari biaya gas.'
      );
    }
    victimActions.push({
      label: `Transfer ${formatEther(sendValue)} ETH -> ${recipient}`,
      to: recipient,
      data: '0x',
      value: sendValue,
      gasLimit: 21000n,
    });
  } else if (options.mode === 'erc20') {
    const tokenAddr = normalizeEthAddress(options.tokenAddress || '', 'Token Address');
    const [symbol, decimals, rawBal] = await Promise.all([
      client.readContract({ address: tokenAddr, abi: erc20Abi, functionName: 'symbol' }),
      client.readContract({ address: tokenAddr, abi: erc20Abi, functionName: 'decimals' }),
      client.readContract({
        address: tokenAddr,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [victimAccount.address],
      }),
    ]);

    const amount =
      !options.tokenAmount || options.tokenAmount.toLowerCase() === 'max'
        ? rawBal
        : parseUnits(options.tokenAmount, decimals);

    if (amount <= 0n) {
      throw new Error(`Saldo token ${symbol} di wallet korban adalah 0.`);
    }

    const data = encodeFunctionData({
      abi: erc20Abi,
      functionName: 'transfer',
      args: [recipient, amount],
    });

    let gasLimit = 90000n;
    try {
      const est = await client.estimateGas({
        account: victimAccount.address,
        to: tokenAddr,
        data,
      });
      gasLimit = (est * 130n) / 100n;
    } catch {
      log.warn('Estimasi gas ERC-20 gagal (wajar jika victim sedang didelegasi 7702); pakai gasLimit aman 95,000.');
      gasLimit = 95000n;
    }

    victimActions.push({
      label: `Transfer ${Number(amount) / 10 ** decimals} ${symbol} -> ${recipient}`,
      to: tokenAddr,
      data,
      value: 0n,
      gasLimit,
    });
  } else if (options.mode === 'erc721') {
    const nftAddr = normalizeEthAddress(options.nftAddress || '', 'NFT Contract Address');
    if (!options.tokenId) throw new Error('tokenId NFT wajib diisi.');
    const tokenId = BigInt(options.tokenId);

    const data = encodeFunctionData({
      abi: erc721Abi,
      functionName: 'safeTransferFrom',
      args: [victimAccount.address, recipient, tokenId],
    });

    let gasLimit = 140000n;
    try {
      const est = await client.estimateGas({
        account: victimAccount.address,
        to: nftAddr,
        data,
      });
      gasLimit = (est * 130n) / 100n;
    } catch {
      log.warn('Estimasi gas ERC-721 gagal; pakai gasLimit aman 150,000.');
      gasLimit = 150000n;
    }

    victimActions.push({
      label: `Transfer NFT ${nftAddr} #${tokenId} -> ${recipient}`,
      to: nftAddr,
      data,
      value: 0n,
      gasLimit,
    });
  } else if (options.mode === 'custom') {
    const targetTo = normalizeEthAddress(options.customTo || '', 'Custom Contract Address');
    const calldata = (options.customData?.trim() || '0x') as Hex;
    if (!calldata.startsWith('0x')) {
      throw new Error('Custom calldata harus diawali 0x.');
    }
    const callValue = options.customValueEth ? parseEther(options.customValueEth) : 0n;
    const gasLimit = options.customGasLimit ? BigInt(options.customGasLimit) : 250000n;

    victimActions.push({
      label: `Custom Call -> ${targetTo} (value=${formatEther(callValue)} ETH, gas=${gasLimit})`,
      to: targetTo,
      data: calldata,
      value: callValue,
      gasLimit,
    });

    // Optional follow-up ERC-20 transfer (e.g., claim() in Tx A then immediately transfer() in Tx B)
    if (options.followUpTokenAddress) {
      const tokAddr = normalizeEthAddress(options.followUpTokenAddress, 'Follow-up Token Address');
      if (!options.followUpTokenAmount) {
        throw new Error(
          'Untuk follow-up transfer setelah custom call (mis. claim), isi jumlah token persis yang akan diklaim.'
        );
      }
      const [symbol, decimals] = await Promise.all([
        client.readContract({ address: tokAddr, abi: erc20Abi, functionName: 'symbol' }),
        client.readContract({ address: tokAddr, abi: erc20Abi, functionName: 'decimals' }),
      ]);
      const amt = parseUnits(options.followUpTokenAmount, decimals);
      const data = encodeFunctionData({
        abi: erc20Abi,
        functionName: 'transfer',
        args: [recipient, amt],
      });
      victimActions.push({
        label: `Follow-up Transfer ${options.followUpTokenAmount} ${symbol} -> ${recipient}`,
        to: tokAddr,
        data,
        value: 0n,
        gasLimit: 95000n,
      });
    }
  }

  // 3. Calculate exact wei funding needed from sponsor
  const funding = computeExactFundingWei({
    victimExistingBalance: victimBalance,
    txGasLimits: victimActions.map((a) => a.gasLimit),
    txValues: victimActions.map((a) => a.value),
    maxFeePerGas,
    useExistingBalance: options.mode === 'eth' ? Boolean(options.useExistingEth) : true,
  });

  const revokeGas = needsRevoke7702 ? 50000n : 0n;
  const fundGas = funding.sponsorFundingWei > 0n ? 21000n : 0n;
  const totalSponsorCost =
    funding.sponsorFundingWei + (revokeGas + fundGas) * maxFeePerGas;

  console.log('\n--- RINCIAN BUNDLE ---');
  let stepNo = 1;
  if (needsRevoke7702) {
    console.log(`  Tx #${stepNo++}: [Sponsor -> Sponsor, Type 4] Revoke EIP-7702 Victim (victim nonce ${victimNonce} -> 0x000...000)`);
  }
  if (funding.sponsorFundingWei > 0n) {
    console.log(
      `  Tx #${stepNo++}: [Sponsor -> Victim, Type 2]  Pre-fund persis ${formatEther(funding.sponsorFundingWei)} ETH (${funding.sponsorFundingWei} wei)`
    );
  }
  for (const act of victimActions) {
    console.log(`  Tx #${stepNo++}: [Victim, Type 2]             ${act.label} (gasLimit=${act.gasLimit})`);
  }
  console.log(`  Total estimasi dana keluar dari Sponsor : ~${formatEther(totalSponsorCost)} ETH`);

  if (sponsorBalance < totalSponsorCost) {
    throw new Error(
      `Saldo Sponsor kurang! Butuh minimal ${formatEther(totalSponsorCost)} ETH, saldo saat ini ${formatEther(sponsorBalance)} ETH.`
    );
  }

  // 4. Sign all transactions offline into raw serialized Hex array
  const signedBundle: Hex[] = [];
  const bundleHashes: Hex[] = [];

  let curSponsorNonce = sponsorNonce;
  let curVictimNonce = victimNonce;

  // Tx #1: Sponsored EIP-7702 Revoke
  if (needsRevoke7702) {
    const revokeAuth = await victimAccount.signAuthorization({
      contractAddress: zeroAddress,
      chainId: mainnet.id,
      nonce: curVictimNonce,
    });

    const signedRevoke = await sponsorAccount.signTransaction({
      chainId: mainnet.id,
      type: 'eip7702',
      to: sponsorAccount.address,
      value: 0n,
      nonce: curSponsorNonce,
      gas: revokeGas,
      maxFeePerGas,
      maxPriorityFeePerGas,
      authorizationList: [revokeAuth],
    });

    signedBundle.push(signedRevoke);
    bundleHashes.push(keccak256(signedRevoke));
    curSponsorNonce += 1;
    curVictimNonce += 1; // EIP-7702 authorization increments authority's nonce!
  }

  // Tx #2: Exact-Wei Sponsor Pre-funding
  if (funding.sponsorFundingWei > 0n) {
    const signedFund = await sponsorAccount.signTransaction({
      chainId: mainnet.id,
      type: 'eip1559',
      to: victimAccount.address,
      value: funding.sponsorFundingWei,
      nonce: curSponsorNonce,
      gas: 21000n,
      maxFeePerGas,
      maxPriorityFeePerGas,
    });

    signedBundle.push(signedFund);
    bundleHashes.push(keccak256(signedFund));
    curSponsorNonce += 1;
  }

  // Tx #3+: Victim Rescue Actions
  for (const act of victimActions) {
    const signedAction = await victimAccount.signTransaction({
      chainId: mainnet.id,
      type: 'eip1559',
      to: act.to,
      data: act.data,
      value: act.value,
      nonce: curVictimNonce,
      gas: act.gasLimit,
      maxFeePerGas,
      maxPriorityFeePerGas,
    });

    signedBundle.push(signedAction);
    bundleHashes.push(keccak256(signedAction));
    curVictimNonce += 1;
  }

  console.log('\n--- HASH TRANSAKSI DALAM BUNDLE ---');
  bundleHashes.forEach((h, i) => console.log(`  Tx #${i + 1}: ${h}`));

  // 5. Simulate bundle via eth_callBundle before broadcasting
  const nextBlock = block.number + 1n;
  log.info(`Menjalankan simulasi bundle (eth_callBundle) pada target block #${nextBlock}...`);
  const sim = await mev.simulateBundle(signedBundle, nextBlock, block.number);
  if (sim.ok) {
    log.ok(
      `Simulasi SUKSES di ${sim.builder}! Total gas: ${sim.totalGasUsed ?? 'N/A'}`
    );
  } else {
    log.warn(`Simulasi tidak lulus / ditolak (${sim.builder}): ${sim.error}`);
    if (options.dryRun) {
      log.info('Mode DRY-RUN selesai (tidak ada transaksi dikirim).');
      return;
    }
    throw new Error(
      `Simulasi bundle gagal: ${sim.error}. Perbaiki parameter (misal gas/nonce/amount) sebelum kirim live.`
    );
  }

  if (options.dryRun) {
    log.ok('Mode DRY-RUN selesai! Semua transaksi valid dan lolos simulasi. Tidak ada yang dikirim.');
    return;
  }

  // 6. Broadcast privately to all configured MEV builders for consecutive blocks
  const lastTxHash = bundleHashes[bundleHashes.length - 1];
  log.info(
    `Mengirim private bundle ke ${builders.length} MEV builders (maks ${maxAttempts} blok)...`
  );

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const currentBlock = await client.getBlockNumber();
    const targetBlock = currentBlock + 1n;
    console.log(
      `\n[Attempt ${attempt + 1}/${maxAttempts}] Current=#${currentBlock} -> Target=#${targetBlock}`
    );

    await mev.sendBundleToAll(signedBundle, targetBlock);

    // Wait until targetBlock is mined (Ethereum ~12s per block)
    while (true) {
      await sleep(3000);
      const latest = await client.getBlockNumber();
      if (latest >= targetBlock) break;
    }

    // Check if our final rescue transaction landed!
    try {
      const receipt = await client.getTransactionReceipt({ hash: lastTxHash });
      if (receipt) {
        if (receipt.status === 'success') {
          log.ok(`RESCUE BERHASIL MASUK BLOCK #${receipt.blockNumber}!`);
          bundleHashes.forEach((h, idx) =>
            console.log(`  Tx #${idx + 1}: https://etherscan.io/tx/${h}`)
          );
          return;
        } else {
          log.err(
            `Bundle masuk block #${receipt.blockNumber} tetapi transaksi REVERT: https://etherscan.io/tx/${lastTxHash}`
          );
          return;
        }
      }
    } catch {
      // Not included in this block yet — check if nonces moved (someone else used nonce)
      const latestVictimNonce = await client.getTransactionCount({
        address: victimAccount.address,
      });
      if (latestVictimNonce !== victimNonce) {
        log.warn(
          `Nonce wallet korban berubah (${victimNonce} -> ${latestVictimNonce}) di tengah percobaan! Hentikan dan jalankan ulang.`
        );
        return;
      }
      log.info(`Belum terpilih di block #${targetBlock}, mencoba block berikutnya...`);
    }
  }

  log.warn(
    `Bundle belum masuk setelah ${maxAttempts} blok. Coba naikkan ETH_PRIORITY_FEE_GWEI di .env (misal 3-5 Gwei) lalu jalankan lagi.`
  );
}
