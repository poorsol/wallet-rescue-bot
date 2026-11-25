import { keccak256, stringToBytes, toHex, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { log } from '../utils/config.js';

export interface BundleSubmitResult {
  builder: string;
  ok: boolean;
  bundleHash?: string;
  error?: string;
}

export interface BundleSimResult {
  builder: string;
  ok: boolean;
  totalGasUsed?: number;
  coinbaseDiff?: string;
  results?: Array<{
    txHash?: string;
    gasUsed?: number;
    error?: string;
    revert?: string;
  }>;
  error?: string;
}

export class MevBundleClient {
  private authAccount;
  private builders: string[];

  constructor(builders: string[], flashbotsAuthKey?: Hex) {
    this.builders = builders;
    const key = flashbotsAuthKey ?? generatePrivateKey();
    this.authAccount = privateKeyToAccount(key);
  }

  private async signFlashbotsBody(body: string): Promise<string> {
    const hash = keccak256(stringToBytes(body));
    const sig = await this.authAccount.signMessage({ message: hash });
    return `${this.authAccount.address}:${sig}`;
  }

  private async postJsonRpc(
    url: string,
    method: string,
    params: unknown[]
  ): Promise<{ ok: boolean; result?: any; error?: string }> {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method,
      params,
    });

    const signature = await this.signFlashbotsBody(body);

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 12000);
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Flashbots-Signature': signature,
        },
        body,
        signal: controller.signal,
      });
      clearTimeout(timer);

      const text = await res.text();
      let parsed: any;
      try {
        parsed = JSON.parse(text);
      } catch {
        return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
      }

      if (parsed.error) {
        return {
          ok: false,
          error: parsed.error.message ?? JSON.stringify(parsed.error),
        };
      }
      return { ok: true, result: parsed.result };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? String(err) };
    }
  }

  async simulateBundle(
    signedTxs: Hex[],
    targetBlockNumber: bigint,
    stateBlockNumber: bigint | 'latest' = 'latest'
  ): Promise<BundleSimResult> {
    // Prefer Flashbots relay or Titan for eth_callBundle simulation
    const simEndpoint =
      this.builders.find((b) => b.includes('flashbots')) ??
      this.builders.find((b) => b.includes('titan')) ??
      this.builders[0];

    const stateBlock =
      stateBlockNumber === 'latest' ? 'latest' : toHex(stateBlockNumber);

    const res = await this.postJsonRpc(simEndpoint, 'eth_callBundle', [
      {
        txs: signedTxs,
        blockNumber: toHex(targetBlockNumber),
        stateBlockNumber: stateBlock,
      },
    ]);

    if (!res.ok) {
      return { builder: simEndpoint, ok: false, error: res.error };
    }

    const r = res.result ?? {};
    const txResults = Array.isArray(r.results) ? r.results : [];
    const failedTx = txResults.find((x: any) => x.error || x.revert);
    if (failedTx) {
      return {
        builder: simEndpoint,
        ok: false,
        totalGasUsed: r.totalGasUsed,
        coinbaseDiff: r.coinbaseDiff,
        results: txResults,
        error: `Simulasi gagal di tx ${failedTx.txHash ?? ''}: ${failedTx.error ?? failedTx.revert}`,
      };
    }

    return {
      builder: simEndpoint,
      ok: true,
      totalGasUsed: r.totalGasUsed,
      coinbaseDiff: r.coinbaseDiff,
      results: txResults,
    };
  }

  async sendBundleToAll(
    signedTxs: Hex[],
    targetBlockNumber: bigint
  ): Promise<BundleSubmitResult[]> {
    const blockHex = toHex(targetBlockNumber);
    const promises = this.builders.map(async (builder): Promise<BundleSubmitResult> => {
      const res = await this.postJsonRpc(builder, 'eth_sendBundle', [
        {
          txs: signedTxs,
          blockNumber: blockHex,
        },
      ]);

      if (!res.ok) {
        return { builder, ok: false, error: res.error };
      }

      return {
        builder,
        ok: true,
        bundleHash: res.result?.bundleHash ?? (typeof res.result === 'string' ? res.result : 'accepted'),
      };
    });

    const results = await Promise.all(promises);
    const okCount = results.filter((r) => r.ok).length;
    log.info(
      `Bundle untuk block #${targetBlockNumber} terkirim: ${okCount}/${results.length} builder menerima.`
    );
    for (const r of results) {
      if (r.ok) {
        console.log(`   -> [OK] ${r.builder} (${r.bundleHash})`);
      } else {
        console.log(`   -> [SKIP] ${r.builder}: ${r.error}`);
      }
    }
    return results;
  }
}
