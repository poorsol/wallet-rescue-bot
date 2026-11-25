import { TronWeb, utils as tronUtils } from 'tronweb';
import { log, optionalEnv, parseCsvEnv, requireEnv, sleep } from '../utils/config.js';

const DEFAULT_USDT_TRC20 = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const DEFAULT_TRON_EXTRA_NODES = ['https://tron-rpc.publicnode.com'];

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

export interface TrxRelayOptions {
  recipient?: string;
  amountTrx: number; // e.g., 4 TRX (~$1.23)
  activateRecipientFirst?: boolean; // if true & recipient inactive, sponsor activates it via AccountCreateContract first
  burstIntervalMs?: number; // default 150ms
  burstDurationMs?: number; // default 9000ms
  dryRun?: boolean;
}

/**
 * Build & sign a Tron TransferContract 100% OFFLINE (works even while victim balance is 0!).
 * Reuses node-verified TaPoS ref_block_bytes & ref_block_hash from tx1.
 */
export async function buildOfflineSignedTrxTransfer(params: {
  tronWeb: TronWeb;
  fromPrivateKey: string;
  fromBase58: string;
  toBase58: string;
  amountSun: number;
  refBlockBytes: string;
  refBlockHash: string;
  timestamp: number;
  expiration: number;
}): Promise<any> {
  const txJson = {
    visible: false,
    raw_data: {
      contract: [
        {
          parameter: {
            value: {
              amount: params.amountSun,
              owner_address: params.tronWeb.address.toHex(params.fromBase58),
              to_address: params.tronWeb.address.toHex(params.toBase58),
            },
            type_url: 'type.googleapis.com/protocol.TransferContract',
          },
          type: 'TransferContract',
        },
      ],
      ref_block_bytes: params.refBlockBytes,
      ref_block_hash: params.refBlockHash,
      expiration: params.expiration,
      timestamp: params.timestamp,
    },
  };

  const pb = tronUtils.transaction.txJsonToPb(txJson as any);
  const raw_data_hex = tronUtils.transaction.txPbToRawDataHex(pb);
  const txID = tronUtils.transaction.txPbToTxID(pb).replace(/^0x/, '');
  const fullTx = { ...txJson, txID, raw_data_hex } as any;
  const signed = await params.tronWeb.trx.sign(fullTx, params.fromPrivateKey);

  if (!tronUtils.transaction.txCheck(signed)) {
    throw new Error('Validasi offline protobuf txCheck(tx2) gagal!');
  }
  return signed;
}

async function broadcastRawBodyToNode(
  host: string,
  serializedTxBody: string,
  apiKey?: string
): Promise<{ host: string; ok: boolean; code?: string; message?: string; elapsedMs: number }> {
  const t0 = Date.now();
  const url = `${host.replace(/\/$/, '')}/wallet/broadcasttransaction`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey && host.includes('trongrid')) {
    headers['TRON-PRO-API-KEY'] = apiKey;
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: serializedTxBody,
      signal: controller.signal,
    });
    clearTimeout(timer);
    const json: any = await res.json();
    const decodedMsg =
      typeof json.message === 'string' && /^[0-9a-fA-F]+$/.test(json.message)
        ? Buffer.from(json.message, 'hex').toString('utf8')
        : json.message;
    return {
      host,
      ok: Boolean(json.result),
      code: json.code,
      message: decodedMsg,
      elapsedMs: Date.now() - t0,
    };
  } catch (err: any) {
    return {
      host,
      ok: false,
      message: err?.message ?? String(err),
      elapsedMs: Date.now() - t0,
    };
  }
}

export async function runTrxRelay(options: TrxRelayOptions): Promise<void> {
  log.title('TRON MAINNET - OFFLINE PRE-SIGN & RAPID-FIRE TRX RELAY');

  const sponsorKey = requireEnv('TRX_SPONSOR_PRIVATE_KEY').replace(/^0x/, '').trim();
  const victimKey = requireEnv('TRX_VICTIM_PRIVATE_KEY').replace(/^0x/, '').trim();
  const recipient = (options.recipient || requireEnv('TRX_SAFE_RECIPIENT')).trim();

  if (!Number.isFinite(options.amountTrx) || options.amountTrx <= 0) {
    throw new Error('Jumlah TRX tidak valid (mis. 4).');
  }

  const primaryHost = optionalEnv('TRX_FULL_HOST', 'https://api.trongrid.io');
  const apiKey = optionalEnv('TRX_TRONGRID_API_KEY');
  const broadcastNodes = Array.from(
    new Set([
      ...parseCsvEnv('TRX_EXTRA_BROADCAST_NODES', DEFAULT_TRON_EXTRA_NODES),
      primaryHost,
    ])
  );

  const sponsorTron = createTronWeb(sponsorKey);
  const victimTron = createTronWeb(victimKey);
  const sponsorAddr = sponsorTron.defaultAddress.base58 as string;
  const victimAddr = victimTron.defaultAddress.base58 as string;

  if (!sponsorTron.isAddress(recipient)) {
    throw new Error(`Alamat tujuan Tron tidak valid: ${recipient}`);
  }

  // 1. Audit victim permissions + check accounts & bandwidth
  const [sponsorAcc, victimAcc, victimRes, recipientAcc] = await Promise.all([
    sponsorTron.trx.getAccount(sponsorAddr),
    victimTron.trx.getAccount(victimAddr),
    victimTron.trx.getAccountResources(victimAddr),
    sponsorTron.trx.getAccount(recipient),
  ]);

  const audit = auditTronPermissions(victimTron, victimAcc, victimAddr);
  if (audit.isCompromisedMultiSig) {
    log.err('BATAL OTOMATIS: Wallet korban terkena MULTI-SIG TAKEOVER!');
    for (const r of audit.reasons) console.log(`  -> ${r}`);
    throw new Error('Tidak bisa menjalankan TRX relay pada wallet Multi-Sig Takeover.');
  }

  const sponsorBalSun = Number(sponsorAcc?.balance ?? 0);
  const victimBalSun = Number(victimAcc?.balance ?? 0);
  const recipientActivated = Boolean(recipientAcc && recipientAcc.address);
  const freeBw =
    Number(victimRes?.freeNetLimit ?? 0) - Number(victimRes?.freeNetUsed ?? 0);
  const stakedBw =
    Number(victimRes?.NetLimit ?? 0) - Number(victimRes?.NetUsed ?? 0);
  const availBw = freeBw + stakedBw;

  const sendSun = Math.round(options.amountTrx * 1e6);

  // If recipient is not activated on-chain, Tron burns 1.1 TRX (1 TRX create fee + 0.1 TRX bw)
  // unless sponsor activates it first via AccountCreateContract.
  const willActivateFirst = !recipientActivated && Boolean(options.activateRecipientFirst);
  const activationExtraSun = !recipientActivated && !willActivateFirst ? 1_100_000 : 0;
  const bwExtraSun = availBw < 280 && activationExtraSun === 0 ? 280_000 : 0;
  const totalVictimNeededSun = sendSun + activationExtraSun + bwExtraSun;
  const sponsorFundSun = Math.max(0, totalVictimNeededSun - victimBalSun);

  console.log(`Sponsor Wallet    : ${sponsorAddr} (saldo: ${(sponsorBalSun / 1e6).toFixed(6)} TRX)`);
  console.log(`Victim Wallet     : ${victimAddr} (saldo: ${(victimBalSun / 1e6).toFixed(6)} TRX, BW: ${availBw})`);
  console.log(`Tujuan Wajib      : ${recipient} (${recipientActivated ? 'SUDAH AKTIF' : 'BELUM AKTIF ON-CHAIN!'})`);
  console.log(`Jumlah Kirim Tx#2 : ${(sendSun / 1e6).toFixed(6)} TRX`);

  if (!recipientActivated) {
    if (willActivateFirst) {
      log.info('Tujuan belum aktif -> Sponsor akan mengaktifkan dulu via AccountCreateContract (biaya 1 TRX dari sponsor, 0 TRX transfer ke tujuan).');
    } else {
      log.warn('Tujuan belum aktif -> Sponsor otomatis menambah +1.1 TRX biaya aktivasi protokol di Tx#1 (total terkirim ke korban = jumlah kirim + 1.1 TRX, sisa korban = 0 TRX).');
    }
  }

  const sponsorNeedWithSafety = sponsorFundSun + (willActivateFirst ? 1_200_000 : 300_000);
  if (sponsorBalSun < sponsorNeedWithSafety) {
    throw new Error(
      `Saldo Sponsor kurang! Butuh minimal ~${(sponsorNeedWithSafety / 1e6).toFixed(2)} TRX, saldo saat ini ${(sponsorBalSun / 1e6).toFixed(6)} TRX.`
    );
  }

  console.log('\n--- RENCANA EKSEKUSI ---');
  if (willActivateFirst) {
    console.log(`  Step 0: [Sponsor] Aktivasi akun ${recipient} via AccountCreateContract (biaya 1.1 TRX)`);
  }
  console.log(`  Tx #1 : [Sponsor -> Victim] Kirim ${(sponsorFundSun / 1e6).toFixed(6)} TRX`);
  console.log(`  Tx #2 : [Victim -> Tujuan]  Pre-signed OFFLINE ${(sendSun / 1e6).toFixed(6)} TRX -> ${recipient}`);
  console.log(`  Nodes : ${broadcastNodes.join(' + ')}`);
  console.log(`  Mode  : MULTI-NODE ZERO-WAIT PIPELINED (pre-warm TLS + tembak Tx#1 T=0ms, 14 gelombang Tx#2 mulai T=5ms!)`);
  log.warn('CATATAN: Tron tidak memiliki MEV Bundle atomik seperti Ethereum. Metode ini adalah balapan milidetik melawan sweeper — gunakan hanya untuk nominal kecil!');

  if (willActivateFirst && !options.dryRun) {
    log.info('Menjalankan Step 0: Aktivasi alamat tujuan dari Sponsor...');
    const createTx = await sponsorTron.transactionBuilder.createAccount(recipient, sponsorAddr);
    const signedCreate = await sponsorTron.trx.sign(createTx);
    const createRes = await sponsorTron.trx.sendRawTransaction(signedCreate);
    if (!createRes.result) {
      throw new Error(`Gagal aktivasi akun tujuan: ${JSON.stringify(createRes)}`);
    }
    log.ok(`Aktivasi terkirim: https://tronscan.org/#/transaction/${createRes.txid} (tunggu 4 detik...)`);
    await sleep(4000);
  }

  // 2. Build & sign Tx #1 on sponsor, then IMMEDIATELY build & sign Tx #2 OFFLINE using Tx #1's exact TaPoS!
  const tx1Unsigned = await sponsorTron.transactionBuilder.sendTrx(
    victimAddr,
    sponsorFundSun,
    sponsorAddr
  );
  const tx1Signed = await sponsorTron.trx.sign(tx1Unsigned);

  const tx2Signed = await buildOfflineSignedTrxTransfer({
    tronWeb: victimTron,
    fromPrivateKey: victimKey,
    fromBase58: victimAddr,
    toBase58: recipient,
    amountSun: sendSun,
    refBlockBytes: tx1Unsigned.raw_data.ref_block_bytes,
    refBlockHash: tx1Unsigned.raw_data.ref_block_hash,
    timestamp: Number(tx1Unsigned.raw_data.timestamp) + 1,
    expiration: Number(tx1Unsigned.raw_data.expiration),
  });

  console.log('\n--- PRE-SIGNED TX READY ---');
  console.log(`  Tx #1 (Sponsor -> Victim) : ${tx1Signed.txID}`);
  console.log(`  Tx #2 (Victim -> Tujuan)  : ${tx2Signed.txID}`);

  // Pre-warm TLS/TCP Keep-Alive connections to all broadcast nodes!
  log.info(`Pre-warming koneksi TLS/TCP ke ${broadcastNodes.length} node...`);
  await Promise.all(
    broadcastNodes.map(async (host) => {
      const t0 = Date.now();
      try {
        const b = await fetchNowBlockTaPoS(host, apiKey);
        console.log(`   -> [WARM] ${host} (${Date.now() - t0}ms, blk=#${b.blockNumber})`);
      } catch (e: any) {
        console.log(`   -> [WARN] ${host} (${Date.now() - t0}ms: ${e?.message ?? e})`);
      }
    })
  );

  if (options.dryRun) {
    log.ok('Mode DRY-RUN selesai! Kedua transaksi valid (txCheck=true) & semua node siap ditembak. Tidak ada yang dikirim.');
    return;
  }

  // 3. MULTI-NODE ZERO-WAIT PIPELINED LAUNCH:
  // Pre-serialize both JSON payloads, fire Tx #1 at T=0ms WITHOUT awaiting its HTTP response,
  // and immediately fire 14 tightly staggered waves of Tx #2 starting at T=5ms across ALL nodes!
  const tx1Body = JSON.stringify(tx1Signed);
  const tx2Body = JSON.stringify(tx2Signed);

  log.info(
    `ZERO-WAIT LAUNCH ke ${broadcastNodes.length} node: Tx #1 @ T=0ms, 14 gelombang Tx #2 mulai T=5ms...`
  );

  const start = Date.now();
  let tx2Accepted = false;
  let tx2AcceptedInfo = '';
  let lastRejectReason = '';
  let totalTx2Shots = 0;

  // Fire Tx #1 immediately (DO NOT await yet!)
  const tx1Promise = Promise.all(
    broadcastNodes.map((h) => broadcastRawBodyToNode(h, tx1Body, apiKey))
  );

  // Wave 1: Ultra-tight pipelined concurrent shots in the first 600ms across all nodes
  const pipelinedDelaysMs = [5, 15, 25, 40, 60, 85, 115, 150, 190, 240, 300, 380, 480, 600];
  const wave1Promises = pipelinedDelaysMs.map(async (delayMs) => {
    await sleep(delayMs);
    if (tx2Accepted) return;
    totalTx2Shots++;
    const shotNo = totalTx2Shots;
    const resList = await Promise.all(
      broadcastNodes.map((h) => broadcastRawBodyToNode(h, tx2Body, apiKey))
    );
    const hit = resList.find((r) => r.ok || r.code === 'DUP_TRANSACTION_ERROR');
    if (hit && !tx2Accepted) {
      tx2Accepted = true;
      tx2AcceptedInfo = `Wave1 shot #${shotNo} (delay=${delayMs}ms, selesai +${Date.now() - start}ms) di ${hit.host}`;
      log.ok(`Tx #2 DITERIMA NODE! ${tx2AcceptedInfo}`);
    } else if (!tx2Accepted) {
      lastRejectReason = resList.map((r) => r.message || r.code).join(' | ');
    }
  });

  // Wait for Tx #1 response + Wave 1 to settle
  const [tx1Results] = await Promise.all([tx1Promise, Promise.all(wave1Promises)]);

  const tx1Accepted = tx1Results.some((r) => r.ok || r.code === 'DUP_TRANSACTION_ERROR');
  if (!tx1Accepted) {
    throw new Error(`Tx #1 ditolak oleh semua node: ${JSON.stringify(tx1Results)}`);
  }
  const tx1Best = tx1Results.find((r) => r.ok || r.code === 'DUP_TRANSACTION_ERROR');
  log.ok(`Tx #1 diterima (${tx1Best?.host}, RTT=${tx1Best?.elapsedMs}ms).`);

  // Wave 2: If Wave 1 didn't catch same-block yet, keep firing every intervalMs until next block (~3-7s)
  const intervalMs = options.burstIntervalMs ?? 150;
  const maxDurationMs = options.burstDurationMs ?? 7000;

  while (!tx2Accepted && Date.now() - start < maxDurationMs) {
    totalTx2Shots++;
    const resList = await Promise.all(
      broadcastNodes.map((h) => broadcastRawBodyToNode(h, tx2Body, apiKey))
    );
    const hit = resList.find((r) => r.ok || r.code === 'DUP_TRANSACTION_ERROR');
    if (hit) {
      tx2Accepted = true;
      tx2AcceptedInfo = `Wave2 shot #${totalTx2Shots} (+${Date.now() - start}ms) di ${hit.host}`;
      log.ok(`Tx #2 DITERIMA NODE! ${tx2AcceptedInfo}`);
      break;
    }
    lastRejectReason = resList.map((r) => r.message || r.code).join(' | ');
    await sleep(intervalMs);
  }

  if (!tx2Accepted) {
    log.err(
      `Tx #2 belum diterima setelah ${totalTx2Shots} tembakan (${Date.now() - start}ms). Alasan terakhir: ${lastRejectReason}`
    );
  }

  // 4. Verify on-chain receipt after ~6s
  log.info('Menunggu 6 detik untuk verifikasi hasil on-chain di TronScan...');
  await sleep(6000);

  const [info1, info2] = await Promise.all([
    sponsorTron.trx.getTransactionInfo(tx1Signed.txID),
    victimTron.trx.getTransactionInfo(tx2Signed.txID),
  ]);

  console.log('\n--- HASIL ON-CHAIN ---');
  console.log(`  Tx #1: https://tronscan.org/#/transaction/${tx1Signed.txID} (${info1?.id ? 'CONFIRMED' : 'PENDING/CHECK'})`);
  console.log(`  Tx #2: https://tronscan.org/#/transaction/${tx2Signed.txID} (${info2?.id ? 'CONFIRMED' : 'NOT FOUND / CHECK'})`);

  if (info2?.id && (!info2?.receipt?.result || info2.receipt.result === 'SUCCESS')) {
    log.ok(`BERHASIL! ${(sendSun / 1e6).toFixed(6)} TRX sukses terkirim dari ${victimAddr} ke ${recipient}!`);
  } else {
    log.warn('Cek langsung link TronScan di atas untuk memastikan status akhir Tx #2 (apakah menang balapan atau kalah dengan sweeper).');
  }
}

export interface TrxWatchOptions {
  recipient?: string;
  minTrx?: number; // trigger when victim balance >= minTrx (default 0.5 TRX)
  pollIntervalMs?: number; // default 250ms (4 req/s, safe with TronGrid API key)
  stopAfterFirst?: boolean; // default false (keep watching)
  dryRun?: boolean;
}

async function fetchNowBlockTaPoS(
  host: string,
  apiKey?: string
): Promise<{ refBlockBytes: string; refBlockHash: string; blockNumber: number; timestamp: number }> {
  const url = `${host.replace(/\/$/, '')}/wallet/getnowblock`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey && host.includes('trongrid')) {
    headers['TRON-PRO-API-KEY'] = apiKey;
  }
  const res = await fetch(url, { method: 'POST', headers, body: '{}' });
  const blk: any = await res.json();
  const blockId: string = blk?.blockID;
  const blockNumber: number = Number(blk?.block_header?.raw_data?.number ?? 0);
  if (!blockId || blockId.length < 32 || !blockNumber) {
    throw new Error(`Gagal membaca block terbaru dari ${host}`);
  }
  const refBlockBytes = (blockNumber & 0xffff).toString(16).padStart(4, '0');
  const refBlockHash = blockId.slice(16, 32);
  return {
    refBlockBytes,
    refBlockHash,
    blockNumber,
    timestamp: Date.now(),
  };
}

async function fetchAccountBalanceFast(
  host: string,
  addressHex: string,
  apiKey?: string
): Promise<number> {
  const url = `${host.replace(/\/$/, '')}/wallet/getaccount`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey && host.includes('trongrid')) {
    headers['TRON-PRO-API-KEY'] = apiKey;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ address: addressHex, visible: false }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return -1;
    const json: any = await res.json();
    return Number(json?.balance ?? 0);
  } catch {
    clearTimeout(timer);
    return -1;
  }
}

export async function runTrxWatcher(options: TrxWatchOptions): Promise<void> {
  log.title('TRON MAINNET - HIGH-SPEED AUTO-FORWARD TRX WATCHER');

  const victimKey = requireEnv('TRX_VICTIM_PRIVATE_KEY').replace(/^0x/, '').trim();
  const recipient = (options.recipient || requireEnv('TRX_SAFE_RECIPIENT')).trim();
  const primaryHost = optionalEnv('TRX_FULL_HOST', 'https://api.trongrid.io');
  const apiKey = optionalEnv('TRX_TRONGRID_API_KEY');
  const broadcastNodes = Array.from(
    new Set([primaryHost, ...parseCsvEnv('TRX_EXTRA_BROADCAST_NODES', [])])
  );

  if (!apiKey && primaryHost.includes('trongrid')) {
    log.warn('TRX_TRONGRID_API_KEY kosong! Sangat disarankan pasang API key gratis TronGrid agar polling cepat tidak kena HTTP 429.');
  }

  const victimTron = createTronWeb(victimKey);
  const victimAddr = victimTron.defaultAddress.base58 as string;
  const victimHex = victimTron.address.toHex(victimAddr);

  if (!victimTron.isAddress(recipient)) {
    throw new Error(`Alamat safe recipient Tron tidak valid: ${recipient}`);
  }
  if (recipient.toLowerCase() === victimAddr.toLowerCase()) {
    throw new Error('Safe recipient tidak boleh sama dengan wallet korban!');
  }

  // 1. Audit victim permissions + check recipient activation + initial bandwidth
  const [victimAcc, victimRes, recipientAcc] = await Promise.all([
    victimTron.trx.getAccount(victimAddr),
    victimTron.trx.getAccountResources(victimAddr),
    victimTron.trx.getAccount(recipient),
  ]);

  const audit = auditTronPermissions(victimTron, victimAcc, victimAddr);
  if (audit.isCompromisedMultiSig) {
    log.err('BATAL OTOMATIS: Wallet korban terkena MULTI-SIG TAKEOVER!');
    for (const r of audit.reasons) console.log(`  -> ${r}`);
    throw new Error('Tidak bisa menjalankan watcher pada wallet Multi-Sig Takeover.');
  }

  const recipientActivated = Boolean(recipientAcc && recipientAcc.address);
  let cachedAvailBw =
    Number(victimRes?.freeNetLimit ?? 0) -
    Number(victimRes?.freeNetUsed ?? 0) +
    (Number(victimRes?.NetLimit ?? 0) - Number(victimRes?.NetUsed ?? 0));

  const minTrx = options.minTrx ?? 0.5;
  const minSun = Math.round(minTrx * 1e6);
  const pollMs = Math.max(100, options.pollIntervalMs ?? 250);

  console.log(`Victim Dipantau   : ${victimAddr}`);
  console.log(`Safe Wallet Tujuan: ${recipient} (${recipientActivated ? 'SUDAH AKTIF' : 'BELUM AKTIF! +1.1 TRX fee'})`);
  console.log(`Trigger Minimal   : >= ${minTrx} TRX`);
  console.log(`Bandwidth Awal    : ${cachedAvailBw}`);
  console.log(`Interval Polling  : ${pollMs}ms | Nodes: ${broadcastNodes.join(', ')}`);
  console.log(`Mode              : ${options.dryRun ? 'DRY-RUN (tidak kirim tx)' : 'LIVE AUTO-FORWARD'}`);

  if (!recipientActivated) {
    log.warn('PERINGATAN: Wallet tujuan belum aktif! Aktifkan dulu (kirim 0.1 TRX dari wallet lain) agar transfer rescue memakan 0 TRX biaya aktivasi.');
  }

  // 2. Keep latest TaPoS ref_block_bytes & ref_block_hash hot in memory (refreshed every 1.5s)
  let cachedTapos = await fetchNowBlockTaPoS(primaryHost, apiKey);
  log.ok(
    `TaPoS cache siap (Block #${cachedTapos.blockNumber}, ref=${cachedTapos.refBlockBytes}/${cachedTapos.refBlockHash}). Tekan Ctrl+C untuk berhenti.\n`
  );

  let running = true;
  const onSigInt = () => {
    running = false;
    console.log('\n');
    log.info('Watcher dihentikan oleh user.');
  };
  process.once('SIGINT', onSigInt);

  const taposTimer = setInterval(async () => {
    if (!running) return;
    try {
      cachedTapos = await fetchNowBlockTaPoS(primaryHost, apiKey);
    } catch {
      // keep previous TaPoS (valid for ~60s)
    }
  }, 1500);

  const bwTimer = setInterval(async () => {
    if (!running) return;
    try {
      const r = await victimTron.trx.getAccountResources(victimAddr);
      cachedAvailBw =
        Number(r?.freeNetLimit ?? 0) -
        Number(r?.freeNetUsed ?? 0) +
        (Number(r?.NetLimit ?? 0) - Number(r?.NetUsed ?? 0));
    } catch {
      // ignore transient error
    }
  }, 6000);

  let polls = 0;
  let lastLoggedBal = -1;

  try {
    while (running) {
      const balSun = await fetchAccountBalanceFast(primaryHost, victimHex, apiKey);
      polls++;

      if (balSun >= 0) {
        if (balSun !== lastLoggedBal) {
          lastLoggedBal = balSun;
          process.stdout.write(
            `\r[Poll #${polls}] Block #${cachedTapos.blockNumber} | Saldo Victim: ${(balSun / 1e6).toFixed(6)} TRX | BW: ${cachedAvailBw}   `
          );
        } else if (polls % 20 === 0) {
          process.stdout.write(
            `\r[Poll #${polls}] Block #${cachedTapos.blockNumber} | Saldo Victim: ${(balSun / 1e6).toFixed(6)} TRX | BW: ${cachedAvailBw}   `
          );
        }

        if (balSun >= minSun) {
          const detectTime = Date.now();
          console.log('\n');
          log.warn(`SALDO TERDETEKSI: ${(balSun / 1e6).toFixed(6)} TRX! Menyiapkan offline-signed sweep...`);

          const activationReserve = recipientActivated ? 0 : 1_100_000;
          const bwReserve = cachedAvailBw >= 280 ? 0 : 300_000;
          const sendSun = balSun - activationReserve - bwReserve;

          if (sendSun <= 0) {
            log.warn(
              `Saldo (${(balSun / 1e6).toFixed(6)} TRX) tidak cukup setelah cadangan fee (${((activationReserve + bwReserve) / 1e6).toFixed(2)} TRX).`
            );
          } else {
            const now = Date.now();
            const signedTx = await buildOfflineSignedTrxTransfer({
              tronWeb: victimTron,
              fromPrivateKey: victimKey,
              fromBase58: victimAddr,
              toBase58: recipient,
              amountSun: sendSun,
              refBlockBytes: cachedTapos.refBlockBytes,
              refBlockHash: cachedTapos.refBlockHash,
              timestamp: now,
              expiration: now + 60_000,
            });
            const signElapsed = Date.now() - detectTime;

            if (options.dryRun) {
              log.ok(
                `[DRY-RUN] Offline sign selesai dalam ${signElapsed}ms! Akan mengirim ${(sendSun / 1e6).toFixed(6)} TRX -> ${recipient} (txID: ${signedTx.txID})`
              );
              if (options.stopAfterFirst) break;
              await sleep(3000);
            } else {
              const body = JSON.stringify(signedTx);
              // Fire immediately + 2 fast retries (50ms, 120ms) if rejected/transient
              let accepted = false;
              for (const retryDelay of [0, 50, 120]) {
                if (retryDelay > 0) await sleep(retryDelay);
                const resList = await Promise.all(
                  broadcastNodes.map((h) => broadcastRawBodyToNode(h, body, apiKey))
                );
                const hit = resList.find((r) => r.ok || r.code === 'DUP_TRANSACTION_ERROR');
                if (hit) {
                  accepted = true;
                  log.ok(
                    `TERKIRIM dalam ${Date.now() - detectTime}ms (sign=${signElapsed}ms)! ${(sendSun / 1e6).toFixed(6)} TRX -> ${recipient}`
                  );
                  console.log(`  TronScan: https://tronscan.org/#/transaction/${signedTx.txID}`);
                  break;
                } else {
                  const errMsg = resList.map((r) => r.message || r.code).join(' | ');
                  log.warn(`Percobaan broadcast ditolak (${errMsg})`);
                }
              }

              // Refresh bandwidth & wait 1 block (~3.2s) so we don't double-fire on stale balance
              cachedAvailBw = Math.max(0, cachedAvailBw - 270);
              if (accepted && options.stopAfterFirst) {
                break;
              }
              await sleep(3200);
              lastLoggedBal = -1;
            }
          }
        }
      }

      await sleep(pollMs);
    }
  } finally {
    clearInterval(taposTimer);
    clearInterval(bwTimer);
    process.removeListener('SIGINT', onSigInt);
  }
}

