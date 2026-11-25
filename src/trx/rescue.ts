import { TronWeb } from 'tronweb';
import { log, optionalEnv, requireEnv, sleep } from '../utils/config.js';

const DEFAULT_USDT_TRC20 = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

export interface TronPermissionAudit {
  isCompromisedMultiSig: boolean;
  ownerSummary: string;
  activeSummary: string;
  reasons: string[];
}

export interface TrxRescueOptions {
  tokenAddress?: string;
  recipient?: string;
  amount?: string; // human amount or "max"
  delegateEnergyTrx?: number; // Stake 2.0 TRX amount to temporarily delegate for ENERGY (0 = skip)
  delegateBandwidthTrx?: number; // Stake 2.0 TRX amount to temporarily delegate for BANDWIDTH (0 = skip)
  autoReclaimResources?: boolean; // Undelegate resources back to sponsor right after transfer
  dryRun?: boolean;
}

function createTronWeb(privateKey?: string): TronWeb {
  const fullHost = optionalEnv('TRX_FULL_HOST', 'https://api.trongrid.io');
  const apiKey = optionalEnv('TRX_TRONGRID_API_KEY');
  const headers = apiKey ? { 'TRON-PRO-API-KEY': apiKey } : undefined;

  return new TronWeb({
    fullHost,
    headers,
    privateKey: privateKey ? privateKey.replace(/^0x/, '').trim() : undefined,
  });
}

export function auditTronPermissions(
  tronWeb: TronWeb,
  account: any,
  walletBase58: string
): TronPermissionAudit {
  const reasons: string[] = [];
  const walletHex = tronWeb.address.toHex(walletBase58).toLowerCase();

  // If account hasn't been activated on-chain yet, default permission belongs to owner
  if (!account || !account.address) {
    return {
      isCompromisedMultiSig: false,
      ownerSummary: 'Default (akun belum aktif on-chain)',
      activeSummary: 'Default (akun belum aktif on-chain)',
      reasons: [],
    };
  }

  let ownerSummary = 'Default (single owner)';
  if (account.owner_permission) {
    const threshold = Number(account.owner_permission.threshold ?? 1);
    const keys: Array<{ address: string; weight: number }> =
      account.owner_permission.keys ?? [];
    const selfKey = keys.find(
      (k) => String(k.address).toLowerCase() === walletHex
    );
    const selfWeight = Number(selfKey?.weight ?? 0);
    const otherKeys = keys.filter(
      (k) => String(k.address).toLowerCase() !== walletHex
    );

    ownerSummary = `threshold=${threshold}, keys=${keys
      .map((k) => `${tronWeb.address.fromHex(k.address)}(w=${k.weight})`)
      .join(', ')}`;

    if (selfWeight < threshold) {
      reasons.push(
        `Owner Permission diambil alih: bobot key kamu (${selfWeight}) < threshold (${threshold}).`
      );
    }
    if (otherKeys.length > 0) {
      reasons.push(
        `Ada key asing di Owner Permission: ${otherKeys
          .map((k) => tronWeb.address.fromHex(k.address))
          .join(', ')}`
      );
    }
  }

  let activeSummary = 'Default (single active)';
  if (Array.isArray(account.active_permission) && account.active_permission.length > 0) {
    const summaries: string[] = [];
    let hasUsableActive = false;

    for (const perm of account.active_permission) {
      const threshold = Number(perm.threshold ?? 1);
      const keys: Array<{ address: string; weight: number }> = perm.keys ?? [];
      const selfKey = keys.find(
        (k) => String(k.address).toLowerCase() === walletHex
      );
      const selfWeight = Number(selfKey?.weight ?? 0);
      if (selfWeight >= threshold) hasUsableActive = true;

      summaries.push(
        `[${perm.permission_name ?? 'active'} th=${threshold}: ${keys
          .map((k) => `${tronWeb.address.fromHex(k.address)}(w=${k.weight})`)
          .join(', ')}]`
      );
    }
    activeSummary = summaries.join(' | ');

    if (!hasUsableActive) {
      reasons.push(
        'Active Permission diambil alih: private key kamu tidak memenuhi threshold untuk menandatangani transaksi transfer.'
      );
    }
  }

  const isCompromisedMultiSig = reasons.some((r) =>
    r.includes('diambil alih')
  );

  return {
    isCompromisedMultiSig,
    ownerSummary,
    activeSummary,
    reasons,
  };
}

export async function checkTrxWallet(
  overrideAddress?: string,
  tokenAddressOverride?: string
): Promise<void> {
  log.title('TRON MAINNET - CEK STATUS & PERMISSION WALLET');
  const tronWeb = createTronWeb();

  let targetAddr: string;
  if (overrideAddress) {
    targetAddr = overrideAddress.trim();
  } else {
    const victimKey = requireEnv(
      'TRX_VICTIM_PRIVATE_KEY',
      'isi atau masukkan address secara manual'
    )
      .replace(/^0x/, '')
      .trim();
    targetAddr = TronWeb.address.fromPrivateKey(victimKey) as string;
  }

  if (!tronWeb.isAddress(targetAddr)) {
    throw new Error(`Alamat Tron tidak valid: ${targetAddr}`);
  }

  const tokenAddr =
    tokenAddressOverride || optionalEnv('TRX_DEFAULT_TOKEN', DEFAULT_USDT_TRC20);

  const [account, resources] = await Promise.all([
    tronWeb.trx.getAccount(targetAddr),
    tronWeb.trx.getAccountResources(targetAddr),
  ]);

  const trxBal = Number(account?.balance ?? 0) / 1e6;
  const freeNet =
    Number(resources?.freeNetLimit ?? 0) - Number(resources?.freeNetUsed ?? 0);
  const stakedNet =
    Number(resources?.NetLimit ?? 0) - Number(resources?.NetUsed ?? 0);
  const availEnergy =
    Number(resources?.EnergyLimit ?? 0) - Number(resources?.EnergyUsed ?? 0);

  console.log(`Address           : ${targetAddr}`);
  console.log(`TRX Balance       : ${trxBal.toFixed(6)} TRX`);
  console.log(`Bandwidth Tersedia: ${freeNet + stakedNet} (free=${freeNet}, staked=${stakedNet})`);
  console.log(`Energy Tersedia   : ${availEnergy}`);

  const audit = auditTronPermissions(tronWeb, account, targetAddr);
  console.log(`Owner Permission  : ${audit.ownerSummary}`);
  console.log(`Active Permission : ${audit.activeSummary}`);

  if (audit.isCompromisedMultiSig) {
    log.err('MULTI-SIG TAKEOVER TERDETEKSI!');
    for (const r of audit.reasons) console.log(`  -> ${r}`);
    console.log(
      '  -> KESIMPULAN: Wallet ini TIDAK BISA di-rescue dengan bot apa pun karena attacker sudah mencabut hak tanda tangan kamu di level protokol Tron.'
    );
  } else {
    log.ok(
      'Permission masih utuh (bukan Multi-Sig Takeover). Token TRC-20 BISA di-rescue tanpa kirim TRX menggunakan Stake 2.0 Energy Delegation.'
    );
    if (audit.reasons.length > 0) {
      for (const r of audit.reasons) log.warn(`  Catatan: ${r}`);
    }
  }

  // Read TRC-20 balance
  try {
    tronWeb.setAddress(targetAddr);
    const contract = await tronWeb.contract().at(tokenAddr);
    const [symbol, decimalsRaw, balRaw] = await Promise.all([
      contract.symbol().call(),
      contract.decimals().call(),
      contract.balanceOf(targetAddr).call(),
    ]);
    const decimals = Number(decimalsRaw);
    const bal = BigInt(balRaw.toString());
    console.log(
      `\nTRC-20 (${symbol})    : ${Number(bal) / 10 ** decimals} ${symbol} (contract: ${tokenAddr})`
    );
  } catch (err: any) {
    log.warn(`Gagal membaca saldo TRC-20 (${tokenAddr}): ${err?.message ?? err}`);
  }
}

export async function runTrxRescue(options: TrxRescueOptions): Promise<void> {
  log.title('TRON MAINNET - RESOURCE-DELEGATED TRC-20 RESCUE (0 TRX KE KORBAN)');

  const victimKey = requireEnv('TRX_VICTIM_PRIVATE_KEY').replace(/^0x/, '').trim();
  const sponsorKey = optionalEnv('TRX_SPONSOR_PRIVATE_KEY').replace(/^0x/, '').trim();
  const recipient = (options.recipient || requireEnv('TRX_SAFE_RECIPIENT')).trim();
  const tokenAddr = (
    options.tokenAddress || optionalEnv('TRX_DEFAULT_TOKEN', DEFAULT_USDT_TRC20)
  ).trim();

  const victimTron = createTronWeb(victimKey);
  const victimAddr = victimTron.defaultAddress.base58 as string;

  if (!victimTron.isAddress(recipient)) {
    throw new Error(`Alamat safe recipient Tron tidak valid: ${recipient}`);
  }

  // 1. Audit permissions FIRST so sponsor never wastes anything on a multi-sig takeover!
  const [victimAccount, victimRes] = await Promise.all([
    victimTron.trx.getAccount(victimAddr),
    victimTron.trx.getAccountResources(victimAddr),
  ]);

  const audit = auditTronPermissions(victimTron, victimAccount, victimAddr);
  if (audit.isCompromisedMultiSig) {
    log.err('BATAL OTOMATIS: Wallet korban terkena MULTI-SIG TAKEOVER!');
    for (const r of audit.reasons) console.log(`  -> ${r}`);
    throw new Error(
      'Tidak bisa rescue wallet Tron yang Owner/Active Permission-nya sudah diambil alih attacker.'
    );
  }

  // 2. Read TRC-20 token info & victim balance
  const contract = await victimTron.contract().at(tokenAddr);
  const [symbol, decimalsRaw, balRaw] = await Promise.all([
    contract.symbol().call(),
    contract.decimals().call(),
    contract.balanceOf(victimAddr).call(),
  ]);
  const decimals = Number(decimalsRaw);
  const rawBalance = BigInt(balRaw.toString());

  const transferAmount =
    !options.amount || options.amount.toLowerCase() === 'max'
      ? rawBalance
      : BigInt(Math.round(Number(options.amount) * 10 ** decimals));

  if (transferAmount <= 0n || transferAmount > rawBalance) {
    throw new Error(
      `Saldo ${symbol} tidak cukup (saldo=${Number(rawBalance) / 10 ** decimals} ${symbol}).`
    );
  }

  const availEnergy =
    Number(victimRes?.EnergyLimit ?? 0) - Number(victimRes?.EnergyUsed ?? 0);
  const availBandwidth =
    Number(victimRes?.freeNetLimit ?? 0) -
    Number(victimRes?.freeNetUsed ?? 0) +
    (Number(victimRes?.NetLimit ?? 0) - Number(victimRes?.NetUsed ?? 0));

  console.log(`Victim Wallet     : ${victimAddr}`);
  console.log(`Safe Recipient    : ${recipient}`);
  console.log(`Token TRC-20      : ${symbol} (${tokenAddr})`);
  console.log(`Jumlah Rescue     : ${Number(transferAmount) / 10 ** decimals} ${symbol}`);
  console.log(`Resource Korban   : Energy=${availEnergy}, Bandwidth=${availBandwidth}`);

  const delegateEnergyTrx = options.delegateEnergyTrx ?? 0;
  const delegateBandwidthTrx = options.delegateBandwidthTrx ?? 0;

  if (availEnergy < 65_000 && delegateEnergyTrx === 0) {
    log.warn(
      'Energy wallet korban < 65,000! Tanpa Energy cukup (minimal ~65,000 jika penerima sudah punya saldo token, atau ~131,000 jika belum), transaksi bisa gagal atau membakar TRX.'
    );
    log.warn(
      'Saran: Gunakan opsi delegate Energy dari sponsor (Stake 2.0) atau sewa Energy ke alamat korban tanpa mengirim TRX cair.'
    );
  }

  if (options.dryRun) {
    log.ok('Mode DRY-RUN selesai! Permission bersih & saldo token valid. Tidak ada transaksi dikirim.');
    return;
  }

  let sponsorTron: TronWeb | null = null;
  let sponsorAddr = '';
  const delegatedResources: Array<{ type: 'ENERGY' | 'BANDWIDTH'; sun: number }> = [];

  // 3. Optional Stake 2.0 Resource Delegation (NEVER sends liquid TRX to victim!)
  if (delegateEnergyTrx > 0 || delegateBandwidthTrx > 0) {
    if (!sponsorKey) {
      throw new Error(
        'TRX_SPONSOR_PRIVATE_KEY wajib diisi di .env untuk delegate Energy/Bandwidth.'
      );
    }
    sponsorTron = createTronWeb(sponsorKey);
    sponsorAddr = sponsorTron.defaultAddress.base58 as string;
    log.info(`Sponsor Stake 2.0 : ${sponsorAddr}`);

    if (delegateEnergyTrx > 0) {
      const sun = Math.floor(delegateEnergyTrx * 1e6);
      log.info(`Mendelegasikan ENERGY (${delegateEnergyTrx} TRX staked, unlocked) ke wallet korban...`);
      const tx = await sponsorTron.transactionBuilder.delegateResource(
        sun,
        victimAddr,
        'ENERGY',
        sponsorAddr,
        false
      );
      const signed = await sponsorTron.trx.sign(tx);
      const res = await sponsorTron.trx.sendRawTransaction(signed);
      if (!res.result) {
        throw new Error(`Gagal delegate ENERGY: ${JSON.stringify(res)}`);
      }
      log.ok(`Delegate ENERGY terkirim: https://tronscan.org/#/transaction/${res.txid}`);
      delegatedResources.push({ type: 'ENERGY', sun });
    }

    if (delegateBandwidthTrx > 0) {
      const sun = Math.floor(delegateBandwidthTrx * 1e6);
      log.info(`Mendelegasikan BANDWIDTH (${delegateBandwidthTrx} TRX staked, unlocked) ke wallet korban...`);
      const tx = await sponsorTron.transactionBuilder.delegateResource(
        sun,
        victimAddr,
        'BANDWIDTH',
        sponsorAddr,
        false
      );
      const signed = await sponsorTron.trx.sign(tx);
      const res = await sponsorTron.trx.sendRawTransaction(signed);
      if (!res.result) {
        throw new Error(`Gagal delegate BANDWIDTH: ${JSON.stringify(res)}`);
      }
      log.ok(`Delegate BANDWIDTH terkirim: https://tronscan.org/#/transaction/${res.txid}`);
      delegatedResources.push({ type: 'BANDWIDTH', sun });
    }

    log.info('Menunggu 4 detik agar delegasi Energy/Bandwidth aktif di node...');
    await sleep(4000);
  }

  // 4. Immediately execute TRC-20 transfer from victim -> safe recipient
  log.info(`Mengirim ${Number(transferAmount) / 10 ** decimals} ${symbol} ke ${recipient}...`);
  try {
    const txid = await contract
      .transfer(recipient, transferAmount.toString())
      .send({
        feeLimit: 100_000_000, // 100 TRX cap (akan memakai 0 TRX jika Energy mencukupi)
        shouldPollResponse: false,
      });

    log.ok(`Transaksi TRC-20 terkirim! TxID: https://tronscan.org/#/transaction/${txid}`);
    log.info('Menunggu 6 detik untuk pengecekan status...');
    await sleep(6000);

    const info = await victimTron.trx.getTransactionInfo(txid);
    if (info?.receipt?.result === 'SUCCESS') {
      log.ok(
        `RESCUE TRC-20 BERHASIL! Energy terpakai: ${info.receipt.energy_usage_total ?? 0}, TRX burn: ${(Number(info.fee ?? 0) / 1e6).toFixed(6)} TRX`
      );
    } else if (info?.receipt?.result) {
      log.err(`Transaksi gagal di chain: ${info.receipt.result}`);
    } else {
      log.info('Transaksi sedang diproses. Pantau langsung di link TronScan di atas.');
    }
  } finally {
    // 5. Reclaim unlocked Energy/Bandwidth back to sponsor automatically
    if (
      options.autoReclaimResources !== false &&
      sponsorTron &&
      delegatedResources.length > 0
    ) {
      log.info('Menarik kembali (undelegate) Energy/Bandwidth ke wallet sponsor...');
      for (const d of delegatedResources) {
        try {
          const tx = await sponsorTron.transactionBuilder.undelegateResource(
            d.sun,
            victimAddr,
            d.type,
            sponsorAddr
          );
          const signed = await sponsorTron.trx.sign(tx);
          const res = await sponsorTron.trx.sendRawTransaction(signed);
          if (res.result) {
            log.ok(`Reclaim ${d.type} sukses: https://tronscan.org/#/transaction/${res.txid}`);
          } else {
            log.warn(`Reclaim ${d.type} gagal: ${JSON.stringify(res)}`);
          }
        } catch (err: any) {
          log.warn(`Gagal reclaim ${d.type}: ${err?.message ?? err}`);
        }
      }
    }
  }
}
