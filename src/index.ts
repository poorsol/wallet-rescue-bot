import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { checkEthWallet, runEthRescue, type EthRescueMode } from './eth/rescue.js';
import { checkSolWallet, runSolRelay, runSolRescue, SOL_USDT_MINT } from './sol/rescue.js';
import { checkTrxWallet, runTrxRelay, runTrxRescue, runTrxWatcher } from './trx/rescue.js';
import { COLORS, log } from './utils/config.js';

const rl = createInterface({ input, output });

async function ask(prompt: string, defaultVal = ''): Promise<string> {
  const suffix = defaultVal ? ` [${defaultVal}]` : '';
  const ans = (await rl.question(`${prompt}${suffix}: `)).trim();
  return ans || defaultVal;
}

async function askYesNo(prompt: string, defaultYes = true): Promise<boolean> {
  const hint = defaultYes ? 'Y/n' : 'y/N';
  const ans = (await rl.question(`${prompt} (${hint}): `)).trim().toLowerCase();
  if (!ans) return defaultYes;
  return ans === 'y' || ans === 'ya' || ans === 'yes';
}

async function menuEthRescue() {
  console.log('\nPilih Mode Rescue Ethereum Mainnet:');
  console.log('  1. Kirim ETH (dari wallet korban ke alamat tujuan / verifikasi)');
  console.log('  2. Rescue Token ERC-20 (USDT, USDC, token airdrop, dll.)');
  console.log('  3. Rescue NFT ERC-721');
  console.log('  4. Custom Contract Call (mis. claim() / unstake() + opsional transfer token)');
  const choice = await ask('Pilih (1-4)', '1');

  const recipient = await ask('Alamat tujuan aman (kosongkan untuk pakai ETH_SAFE_RECIPIENT di .env)');
  const priorityFeeGwei = await ask('Priority Fee Gwei (kosongkan untuk default .env)', '');

  let mode: EthRescueMode = 'eth';
  const opts: any = {
    recipient: recipient || undefined,
    priorityFeeGwei: priorityFeeGwei || undefined,
  };

  if (choice === '1') {
    mode = 'eth';
    opts.ethAmount = await ask('Jumlah ETH yang ingin dikirim (mis. 0.001, kosongkan untuk sweep saldo korban)');
    opts.useExistingEth = await askYesNo('Gunakan saldo ETH yg ada di korban dulu jika ada?', false);
  } else if (choice === '2') {
    mode = 'erc20';
    opts.tokenAddress = await ask('Alamat kontrak token ERC-20 (0x...)');
    opts.tokenAmount = await ask('Jumlah token (ketik "max" untuk semua saldo)', 'max');
  } else if (choice === '3') {
    mode = 'erc721';
    opts.nftAddress = await ask('Alamat kontrak NFT ERC-721 (0x...)');
    opts.tokenId = await ask('Token ID NFT');
  } else if (choice === '4') {
    mode = 'custom';
    opts.customTo = await ask('Alamat kontrak tujuan (0x...)');
    opts.customData = await ask('Calldata hex (0x...)');
    opts.customValueEth = await ask('ETH value yang dikirim ke kontrak', '0');
    opts.customGasLimit = await ask('Gas Limit kontrak', '250000');
    const addFollowUp = await askYesNo('Tambahkan transfer ERC-20 otomatis di Tx berikutnya dalam bundle yang sama?', false);
    if (addFollowUp) {
      opts.followUpTokenAddress = await ask('Alamat kontrak ERC-20 hasil claim (0x...)');
      opts.followUpTokenAmount = await ask('Jumlah token persis yang akan di-transfer');
    }
  } else {
    throw new Error('Pilihan tidak valid.');
  }

  opts.mode = mode;
  opts.dryRun = await askYesNo('Jalankan DRY-RUN / simulasi dulu tanpa kirim live?', true);

  await runEthRescue(opts);

  if (opts.dryRun) {
    const goLive = await askYesNo('\nSimulasi selesai. Lanjutkan kirim LIVE sekarang?', false);
    if (goLive) {
      await runEthRescue({ ...opts, dryRun: false });
    }
  }
}

async function menuSolRescue() {
  console.log('\nPilih Mode Rescue Solana:');
  console.log('  1. Rescue SPL / Token-2022 (sponsor bayar gas 100%, 0 SOL ke korban)');
  console.log('  2. Rescue Native SOL (sponsor bayar fee, 100% SOL korban terkirim)');
  const choice = await ask('Pilih (1-2)', '1');

  const recipient = await ask('Alamat Solana tujuan aman (kosongkan untuk SOL_SAFE_RECIPIENT di .env)');
  const useDirectRpc = await askYesNo('Kirim via Direct RPC? (Pilih N untuk Jito Private Bundle / anti-frontrun)', false);
  const dryRun = await askYesNo('Jalankan DRY-RUN / simulasi dulu?', true);

  const opts: any = {
    mode: choice === '2' ? 'sol' : 'spl',
    recipient: recipient || undefined,
    useDirectRpc,
    dryRun,
  };

  if (opts.mode === 'spl') {
    opts.mintAddress = await ask('Alamat Mint token (ketik "all" untuk rescue semua token)', 'all');
    opts.closeTokenAccounts = await askYesNo('Tutup akun token kosong & tarik rent (~0.002 SOL) ke wallet aman?', true);
  } else {
    opts.solAmount = await ask('Jumlah SOL (ketik "max" untuk semua saldo)', 'max');
  }

  await runSolRescue(opts);

  if (dryRun) {
    const goLive = await askYesNo('\nSimulasi selesai. Lanjutkan kirim LIVE sekarang?', false);
    if (goLive) {
      await runSolRescue({ ...opts, dryRun: false });
    }
  }
}

async function menuSolRelay() {
  const recipient = await ask('Alamat Solana tujuan wajib (kosongkan untuk SOL_SAFE_RECIPIENT di .env)');
  const mintAddress = await ask('Mint SPL Token (Enter = USDT Solana)', SOL_USDT_MINT);
  const amount = await ask('Jumlah token yang ingin dikirim lewat wallet korban (mis. 1.5)', '1.5');
  const closeVictimAta = await askYesNo(
    'Tutup ATA kosong korban di tx yang sama & kembalikan rent ~0.002 SOL ke Sponsor?',
    true
  );
  const useDirectRpc = await askYesNo(
    'Kirim via Direct RPC? (N = Jito Bundle dengan fallback otomatis ke Direct RPC)',
    false
  );
  const dryRun = await askYesNo('Jalankan DRY-RUN / simulasi Mainnet dulu?', true);

  const opts = {
    recipient: recipient || undefined,
    mintAddress: mintAddress || SOL_USDT_MINT,
    amount,
    closeVictimAta,
    useDirectRpc,
    dryRun,
  };

  await runSolRelay(opts);

  if (dryRun) {
    const goLive = await askYesNo('\nSimulasi SUKSES. Lanjutkan kirim LIVE sekarang?', false);
    if (goLive) {
      await runSolRelay({ ...opts, dryRun: false });
    }
  }
}

async function menuTrxRescue() {
  const tokenAddress = await ask('Alamat kontrak TRC-20 (kosongkan untuk USDT TR7NHqje...)');
  const recipient = await ask('Alamat Tron tujuan aman (kosongkan untuk TRX_SAFE_RECIPIENT di .env)');
  const amount = await ask('Jumlah token (ketik "max" untuk semua saldo)', 'max');
  const delegateEnergyTrx = Number(
    await ask('Jumlah TRX staked (Stake 2.0) untuk delegate ENERGY sementara (0 = skip)', '0')
  );
  const delegateBandwidthTrx = Number(
    await ask('Jumlah TRX staked untuk delegate BANDWIDTH sementara (0 = skip)', '0')
  );
  const dryRun = await askYesNo('Jalankan DRY-RUN dulu?', true);

  const opts = {
    tokenAddress: tokenAddress || undefined,
    recipient: recipient || undefined,
    amount,
    delegateEnergyTrx,
    delegateBandwidthTrx,
    autoReclaimResources: true,
    dryRun,
  };

  await runTrxRescue(opts);

  if (dryRun) {
    const goLive = await askYesNo('\nCek selesai. Lanjutkan kirim LIVE sekarang?', false);
    if (goLive) {
      await runTrxRescue({ ...opts, dryRun: false });
    }
  }
}

async function menuTrxRelay() {
  const recipient = await ask('Alamat Tron tujuan wajib (kosongkan untuk TRX_SAFE_RECIPIENT di .env)');
  const amountTrx = Number(await ask('Jumlah TRX yang ingin dikirim (mis. 4 untuk ~$1.23)', '4'));
  const activateRecipientFirst = await askYesNo(
    'Jika tujuan belum aktif, aktifkan dulu dari Sponsor via AccountCreateContract? (N = tambah +1.1 TRX di Tx#1)',
    false
  );
  const dryRun = await askYesNo('Jalankan DRY-RUN (uji pre-sign offline tanpa kirim) dulu?', true);

  const opts = {
    recipient: recipient || undefined,
    amountTrx,
    activateRecipientFirst,
    dryRun,
  };

  await runTrxRelay(opts);

  if (dryRun) {
    const goLive = await askYesNo('\nPre-sign OK. Lanjutkan tembak LIVE sekarang?', false);
    if (goLive) {
      await runTrxRelay({ ...opts, dryRun: false });
    }
  }
}

async function menuTrxWatch() {
  const recipient = await ask(
    'Alamat WALLET AMAN PRIBADI tujuan auto-forward (WAJIB cek jgn sampai masih alamat tujuan lama!)'
  );
  const minTrx = Number(await ask('Minimal saldo TRX untuk langsung diteruskan (mis. 0.5 atau 1)', '0.5'));
  const pollIntervalMs = Number(await ask('Interval cek dalam ms (rekomendasi: 250)', '250'));
  const stopAfterFirst = await askYesNo('Otomatis berhenti setelah 1x kiriman berhasil diteruskan?', false);
  const dryRun = await askYesNo('Mode DRY-RUN (pantau saja tanpa kirim live)?', false);

  await runTrxWatcher({
    recipient: recipient || undefined,
    minTrx,
    pollIntervalMs,
    stopAfterFirst,
    dryRun,
  });
}

async function main() {
  console.log(`${COLORS.bold}${COLORS.cyan}`);
  console.log('======================================================');
  console.log('   WALLET RESCUE BOT (ETH EIP-7702 | SOL JITO | TRX)  ');
  console.log('======================================================');
  console.log(`${COLORS.reset}Semua private key diproses 100% lokal dari file .env.\n`);

  while (true) {
    console.log('\n--- MENU UTAMA ---');
    console.log('  1. [ETH] Cek Status Wallet & Deteksi EIP-7702 Drainer');
    console.log('  2. [ETH] Jalankan Rescue via Private MEV Bundle');
    console.log('  3. [SOL] Cek Status Wallet & Daftar SPL Token');
    console.log('  4. [SOL] Jalankan Sponsored Rescue via Jito Bundle');
    console.log('  5. [SOL] 1-Tx Atomic SPL Relay (Kirim USDT/SPL lewat wallet korban, 100% anti-sweeper)');
    console.log('  6. [TRX] Cek Status Wallet & Deteksi Multi-Sig Takeover');
    console.log('  7. [TRX] Jalankan Resource-Delegated TRC-20 Rescue (USDT)');
    console.log('  8. [TRX] Kirim TRX via Offline Pre-Sign & Rapid-Fire Relay');
    console.log('  9. [TRX] Standby Auto-Forward Watcher (Otomatis teruskan TRX masuk ke wallet aman)');
    console.log('  0. Keluar');

    const pick = await ask('\nPilih menu (0-9)');
    try {
      if (pick === '0') {
        break;
      } else if (pick === '1') {
        const addr = await ask('Alamat ETH (kosongkan untuk pakai ETH_VICTIM_PRIVATE_KEY di .env)');
        const tok = await ask('Alamat ERC-20 opsional untuk cek saldo (kosongkan jika tidak perlu)');
        await checkEthWallet(addr || undefined, tok || undefined);
      } else if (pick === '2') {
        await menuEthRescue();
      } else if (pick === '3') {
        const addr = await ask('Alamat SOL (kosongkan untuk pakai SOL_VICTIM_PRIVATE_KEY di .env)');
        await checkSolWallet(addr || undefined);
      } else if (pick === '4') {
        await menuSolRescue();
      } else if (pick === '5') {
        await menuSolRelay();
      } else if (pick === '6') {
        const addr = await ask('Alamat TRX T... (kosongkan untuk pakai TRX_VICTIM_PRIVATE_KEY di .env)');
        const tok = await ask('Alamat TRC-20 opsional (kosongkan untuk USDT)');
        await checkTrxWallet(addr || undefined, tok || undefined);
      } else if (pick === '7') {
        await menuTrxRescue();
      } else if (pick === '8') {
        await menuTrxRelay();
      } else if (pick === '9') {
        await menuTrxWatch();
      } else {
        log.warn('Menu tidak dikenali.');
      }
    } catch (err: any) {
      log.err(err?.message ?? String(err));
    }
  }

  rl.close();
}

main().catch((err) => {
  log.err(err?.message ?? String(err));
  rl.close();
  process.exit(1);
});
