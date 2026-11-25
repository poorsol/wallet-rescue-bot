import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import bs58 from 'bs58';
import {
  log,
  optionalEnv,
  parseCsvEnv,
  requireEnv,
  sleep,
} from '../utils/config.js';

const DEFAULT_JITO_ENDPOINTS = [
  'https://mainnet.block-engine.jito.wtf/api/v1/bundles',
  'https://ny.mainnet.block-engine.jito.wtf/api/v1/bundles',
  'https://amsterdam.mainnet.block-engine.jito.wtf/api/v1/bundles',
  'https://tokyo.mainnet.block-engine.jito.wtf/api/v1/bundles',
];

// Official Jito Mainnet Tip Accounts
const JITO_TIP_ACCOUNTS = [
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
  'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
  'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
  '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
];

export type SolRescueMode = 'spl' | 'sol';

export interface SolRescueOptions {
  mode: SolRescueMode;
  recipient?: string;
  mintAddress?: string; // specific SPL mint, or omit / "all" to rescue all non-zero tokens
  closeTokenAccounts?: boolean; // reclaim ~0.002039 SOL rent directly to safe recipient
  solAmount?: string; // for mode='sol', omit or "max" to sweep all victim SOL
  jitoTipLamports?: number;
  useDirectRpc?: boolean;
  dryRun?: boolean;
}

export function parseSolKeypair(raw: string, label: string): Keypair {
  const trimmed = raw.trim();
  try {
    if (trimmed.startsWith('[')) {
      const arr = JSON.parse(trimmed);
      if (!Array.isArray(arr) || arr.length !== 64) {
        throw new Error('JSON keypair harus berisi array 64 angka (byte).');
      }
      return Keypair.fromSecretKey(Uint8Array.from(arr));
    }
    const decoded = bs58.decode(trimmed);
    if (decoded.length !== 64) {
      throw new Error(`Keypair Base58 harus 64 bytes (ditemukan ${decoded.length} bytes).`);
    }
    return Keypair.fromSecretKey(decoded);
  } catch (err: any) {
    throw new Error(`${label} tidak valid: ${err?.message ?? String(err)}`);
  }
}

function getSolConnection(): Connection {
  const rpcUrl = optionalEnv('SOL_RPC_URL', 'https://api.mainnet-beta.solana.com');
  return new Connection(rpcUrl, 'confirmed');
}

interface ParsedTokenHolding {
  tokenAccount: PublicKey;
  mint: PublicKey;
  programId: PublicKey;
  amountRaw: bigint;
  decimals: number;
  uiAmountString: string;
  delegate: string | null;
}

async function fetchAllTokenHoldings(
  connection: Connection,
  owner: PublicKey
): Promise<ParsedTokenHolding[]> {
  const results: ParsedTokenHolding[] = [];
  for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    const res = await connection.getParsedTokenAccountsByOwner(owner, { programId });
    for (const item of res.value) {
      const info = item.account.data.parsed?.info;
      if (!info) continue;
      const amountRaw = BigInt(info.tokenAmount?.amount ?? '0');
      if (amountRaw <= 0n) continue;
      results.push({
        tokenAccount: item.pubkey,
        mint: new PublicKey(info.mint),
        programId,
        amountRaw,
        decimals: Number(info.tokenAmount?.decimals ?? 0),
        uiAmountString: String(info.tokenAmount?.uiAmountString ?? '0'),
        delegate: info.delegate ?? null,
      });
    }
  }
  return results;
}

export async function checkSolWallet(overrideAddress?: string): Promise<void> {
  log.title('SOLANA MAINNET - CEK STATUS WALLET');
  const connection = getSolConnection();

  let targetPubkey: PublicKey;
  if (overrideAddress) {
    targetPubkey = new PublicKey(overrideAddress.trim());
  } else {
    targetPubkey = parseSolKeypair(
      requireEnv('SOL_VICTIM_PRIVATE_KEY', 'isi atau masukkan address secara manual'),
      'SOL_VICTIM_PRIVATE_KEY'
    ).publicKey;
  }

  const [balanceLamports, accountInfo, holdings] = await Promise.all([
    connection.getBalance(targetPubkey),
    connection.getAccountInfo(targetPubkey),
    fetchAllTokenHoldings(connection, targetPubkey),
  ]);

  console.log(`Address         : ${targetPubkey.toBase58()}`);
  console.log(
    `SOL Balance     : ${(balanceLamports / LAMPORTS_PER_SOL).toFixed(9)} SOL (${balanceLamports} lamports)`
  );

  if (accountInfo && !accountInfo.owner.equals(SystemProgram.programId)) {
    log.err(
      `PERINGATAN KRITIS: Owner akun SOL ini BUKAN System Program, melainkan ${accountInfo.owner.toBase58()}!`
    );
    console.log(
      '  -> Jika wallet korban telah di-assign ke program drainer, transfer SOL native mungkin tidak bisa dilakukan.'
    );
  } else {
    log.ok('Account Owner normal (System Program). Sponsor bisa membayarkan gas 100% tanpa kirim SOL ke korban.');
  }

  console.log(`\nSPL / Token-2022 dengan saldo > 0: ${holdings.length}`);
  for (const h of holdings) {
    const tag = h.programId.equals(TOKEN_2022_PROGRAM_ID) ? 'Token-2022' : 'SPL';
    console.log(
      `  - [${tag}] Mint: ${h.mint.toBase58()} | Saldo: ${h.uiAmountString} | ATA: ${h.tokenAccount.toBase58()}`
    );
    if (h.delegate) {
      log.warn(`    Token account ini punya delegate aktif ke: ${h.delegate}`);
    }
  }

  const sponsorRaw = optionalEnv('SOL_SPONSOR_PRIVATE_KEY');
  if (sponsorRaw) {
    try {
      const sPub = parseSolKeypair(sponsorRaw, 'SOL_SPONSOR_PRIVATE_KEY').publicKey;
      const sBal = await connection.getBalance(sPub);
      console.log(`\nSponsor Wallet  : ${sPub.toBase58()}`);
      console.log(`Sponsor Balance : ${(sBal / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
    } catch {
      // ignore optional sponsor error in check mode
    }
  }
}

async function sendJitoBundle(
  endpoints: string[],
  serializedBase64Txs: string[]
): Promise<{ accepted: number; bundleIds: string[] }> {
  const payload = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'sendBundle',
    params: [serializedBase64Txs, { encoding: 'base64' }],
  });

  const results = await Promise.all(
    endpoints.map(async (url) => {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10000);
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: payload,
          signal: controller.signal,
        });
        clearTimeout(timer);
        const json: any = await res.json();
        if (json.error) {
          return { url, ok: false, error: json.error.message ?? JSON.stringify(json.error) };
        }
        return { url, ok: true, id: String(json.result) };
      } catch (err: any) {
        return { url, ok: false, error: err?.message ?? String(err) };
      }
    })
  );

  const bundleIds: string[] = [];
  for (const r of results) {
    if (r.ok && r.id) {
      bundleIds.push(r.id);
      console.log(`   -> [OK] ${r.url} (bundleId: ${r.id})`);
    } else {
      console.log(`   -> [SKIP] ${r.url}: ${r.error}`);
    }
  }
  return { accepted: bundleIds.length, bundleIds };
}

export async function runSolRescue(options: SolRescueOptions): Promise<void> {
  log.title(`SOLANA MAINNET - SPONSORED RESCUE (${options.mode.toUpperCase()})`);

  const connection = getSolConnection();
  const sponsor = parseSolKeypair(
    requireEnv('SOL_SPONSOR_PRIVATE_KEY'),
    'SOL_SPONSOR_PRIVATE_KEY'
  );
  const victim = parseSolKeypair(
    requireEnv('SOL_VICTIM_PRIVATE_KEY'),
    'SOL_VICTIM_PRIVATE_KEY'
  );
  const recipient = new PublicKey(
    (options.recipient || requireEnv('SOL_SAFE_RECIPIENT')).trim()
  );

  const jitoTipLamports =
    options.jitoTipLamports ?? Number(optionalEnv('SOL_JITO_TIP_LAMPORTS', '100000'));
  const jitoEndpoints = parseCsvEnv('SOL_JITO_ENDPOINTS', DEFAULT_JITO_ENDPOINTS);

  const [sponsorBal, victimBal] = await Promise.all([
    connection.getBalance(sponsor.publicKey),
    connection.getBalance(victim.publicKey),
  ]);

  console.log(`Sponsor (FeePayer): ${sponsor.publicKey.toBase58()} (${(sponsorBal / LAMPORTS_PER_SOL).toFixed(6)} SOL)`);
  console.log(`Victim Wallet     : ${victim.publicKey.toBase58()} (${(victimBal / LAMPORTS_PER_SOL).toFixed(6)} SOL)`);
  console.log(`Safe Recipient    : ${recipient.toBase58()}`);
  console.log(`Mode Kirim        : ${options.useDirectRpc ? 'Direct RPC' : `Jito Private Bundle (tip=${jitoTipLamports} lamports)`}`);

  if (sponsorBal < jitoTipLamports + 500_000) {
    throw new Error(
      `Saldo Sponsor terlalu kecil (${sponsorBal} lamports). Isi minimal ~0.005 SOL di wallet sponsor untuk biaya gas/ATA/Jito tip.`
    );
  }

  // Build instruction batches (max 3-4 tokens per tx to stay safely below 1232-byte Solana tx limit)
  const batches: { label: string; instructions: TransactionInstruction[] }[] = [];

  if (options.mode === 'sol') {
    const amountLamports =
      !options.solAmount || options.solAmount.toLowerCase() === 'max'
        ? victimBal
        : Math.floor(Number(options.solAmount) * LAMPORTS_PER_SOL);

    if (amountLamports <= 0 || amountLamports > victimBal) {
      throw new Error(
        `Jumlah SOL tidak valid atau melebihi saldo victim (${victimBal} lamports).`
      );
    }

    batches.push({
      label: `Transfer ${(amountLamports / LAMPORTS_PER_SOL).toFixed(9)} SOL -> ${recipient.toBase58()}`,
      instructions: [
        SystemProgram.transfer({
          fromPubkey: victim.publicKey,
          toPubkey: recipient,
          lamports: amountLamports,
        }),
      ],
    });
  } else {
    let holdings = await fetchAllTokenHoldings(connection, victim.publicKey);
    if (options.mintAddress && options.mintAddress.toLowerCase() !== 'all') {
      const targetMint = new PublicKey(options.mintAddress.trim());
      holdings = holdings.filter((h) => h.mint.equals(targetMint));
    }

    if (holdings.length === 0) {
      throw new Error('Tidak ditemukan saldo SPL / Token-2022 yang bisa di-rescue di wallet korban.');
    }

    const CHUNK_SIZE = 3;
    for (let i = 0; i < holdings.length; i += CHUNK_SIZE) {
      const slice = holdings.slice(i, i + CHUNK_SIZE);
      const ixs: TransactionInstruction[] = [];
      const names: string[] = [];

      for (const h of slice) {
        const destAta = getAssociatedTokenAddressSync(
          h.mint,
          recipient,
          true,
          h.programId
        );

        // 1. Sponsor pays to create recipient ATA if it doesn't exist yet
        ixs.push(
          createAssociatedTokenAccountIdempotentInstruction(
            sponsor.publicKey,
            destAta,
            recipient,
            h.mint,
            h.programId
          )
        );

        // 2. Victim transfers 100% of token balance to recipient ATA
        ixs.push(
          createTransferCheckedInstruction(
            h.tokenAccount,
            h.mint,
            destAta,
            victim.publicKey,
            h.amountRaw,
            h.decimals,
            [],
            h.programId
          )
        );

        // 3. Optionally close empty token account & send reclaimed rent (~0.002039 SOL) directly to safe recipient
        if (options.closeTokenAccounts) {
          ixs.push(
            createCloseAccountInstruction(
              h.tokenAccount,
              recipient,
              victim.publicKey,
              [],
              h.programId
            )
          );
        }

        names.push(`${h.uiAmountString} (${h.mint.toBase58().slice(0, 8)}...)`);
      }

      batches.push({
        label: `Rescue ${names.join(', ')}${options.closeTokenAccounts ? ' + Close ATA (Reclaim Rent)' : ''}`,
        instructions: ixs,
      });
    }
  }

  for (let bIdx = 0; bIdx < batches.length; bIdx++) {
    const batch = batches[bIdx];
    log.info(`\nMemproses Batch ${bIdx + 1}/${batches.length}: ${batch.label}`);

    const { blockhash, lastValidBlockHeight } =
      await connection.getLatestBlockhash('confirmed');

    const fullInstructions: TransactionInstruction[] = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 25_000 }),
      ...batch.instructions,
    ];

    if (!options.useDirectRpc && jitoTipLamports > 0) {
      const tipAccount = new PublicKey(
        JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)]
      );
      fullInstructions.push(
        SystemProgram.transfer({
          fromPubkey: sponsor.publicKey,
          toPubkey: tipAccount,
          lamports: jitoTipLamports,
        })
      );
    }

    const messageV0 = new TransactionMessage({
      payerKey: sponsor.publicKey, // SPONSOR PAYS 100% OF FEES - ZERO SOL SENT TO VICTIM!
      recentBlockhash: blockhash,
      instructions: fullInstructions,
    }).compileToV0Message();

    const tx = new VersionedTransaction(messageV0);
    tx.sign([sponsor, victim]);

    const txSignature = bs58.encode(tx.signatures[0]);
    console.log(`  Tx Signature : ${txSignature}`);

    // Simulate before sending!
    log.info('Menjalankan simulasi transaksi di RPC...');
    const sim = await connection.simulateTransaction(tx, {
      replaceRecentBlockhash: true,
      sigVerify: false,
    });
    if (sim.value.err) {
      throw new Error(
        `Simulasi Solana gagal: ${JSON.stringify(sim.value.err)}\nLogs:\n${(sim.value.logs ?? []).join('\n')}`
      );
    }
    log.ok(`Simulasi SUKSES! Compute Units: ${sim.value.unitsConsumed ?? 'N/A'}`);

    if (options.dryRun) {
      log.ok('Mode DRY-RUN selesai (tidak ada transaksi dikirim).');
      continue;
    }

    const rawBytes = tx.serialize();
    if (options.useDirectRpc) {
      const sig = await connection.sendRawTransaction(rawBytes, {
        skipPreflight: false,
        maxRetries: 3,
      });
      log.info(`Terkirim via Direct RPC: https://solscan.io/tx/${sig}`);
      await connection.confirmTransaction(
        { signature: sig, blockhash, lastValidBlockHeight },
        'confirmed'
      );
      log.ok(`RESCUE SOLANA TERKONFIRMASI! https://solscan.io/tx/${sig}`);
    } else {
      const base64Tx = Buffer.from(rawBytes).toString('base64');
      log.info(`Mengirim via Jito Private Bundle ke ${jitoEndpoints.length} region...`);
      const res = await sendJitoBundle(jitoEndpoints, [base64Tx]);
      if (res.accepted === 0) {
        throw new Error(
          'Semua Jito endpoint menolak/timeout. Coba ulangi atau gunakan --direct-rpc.'
        );
      }

      log.info('Menunggu konfirmasi on-chain (maks ~45 detik)...');
      let confirmed = false;
      for (let i = 0; i < 15; i++) {
        await sleep(3000);
        const statuses = await connection.getSignatureStatuses([txSignature]);
        const st = statuses.value[0];
        if (st) {
          if (st.err) {
            throw new Error(`Transaksi masuk tapi GAGAL: ${JSON.stringify(st.err)}`);
          }
          if (
            st.confirmationStatus === 'confirmed' ||
            st.confirmationStatus === 'finalized'
          ) {
            confirmed = true;
            break;
          }
        }
      }

      if (confirmed) {
        log.ok(`RESCUE SOLANA BERHASIL! https://solscan.io/tx/${txSignature}`);
      } else {
        log.warn(
          `Bundle belum terkonfirmasi dalam 45 detik. Cek manual di https://solscan.io/tx/${txSignature} atau naikkan SOL_JITO_TIP_LAMPORTS.`
        );
      }
    }
  }
}
