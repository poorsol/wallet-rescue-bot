import { checkEthWallet, runEthRescue, type EthRescueMode } from './eth/rescue.js';
import { checkSolWallet, runSolRescue } from './sol/rescue.js';
import { checkTrxWallet, runTrxRelay, runTrxRescue } from './trx/rescue.js';
import { log } from './utils/config.js';

function parseArgs(argv: string[]): { positional: string[]; flags: Record<string, string | boolean> } {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function strFlag(flags: Record<string, string | boolean>, key: string): string | undefined {
  const v = flags[key];
  return typeof v === 'string' ? v : undefined;
}

function boolFlag(flags: Record<string, string | boolean>, key: string): boolean {
  return flags[key] === true || flags[key] === 'true';
}

function printHelp() {
  console.log(`
Penggunaan CLI langsung (atau jalankan "npm start" untuk menu interaktif):

ETHEREUM:
  npm run eth:check -- --address 0x... [--token 0x...]
  npm run eth:rescue -- --mode eth --amount 0.001 [--recipient 0x...] [--dry-run]
  npm run eth:rescue -- --mode erc20 --token 0x... [--amount max] [--dry-run]
  npm run eth:rescue -- --mode erc721 --nft 0x... --token-id 123 [--dry-run]
  npm run eth:rescue -- --mode custom --to 0x... --data 0x... [--gas 250000] [--dry-run]

SOLANA:
  npm run sol:check -- --address <Base58>
  npm run sol:rescue -- --mode spl [--mint all|<Mint>] [--close] [--direct-rpc] [--dry-run]
  npm run sol:rescue -- --mode sol [--amount max|0.01] [--direct-rpc] [--dry-run]

TRON:
  npm run trx:check T... [--token TR7NHq...]
  npm run trx:rescue -- [--token TR7NHq...] [--amount max] [--delegate-energy 3000] [--dry-run]
  npm run trx:relay -- --amount 4 [--recipient T...] [--activate-first] [--dry-run]
`);
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [chain, action, extraPositional] = positional;

  if (!chain || !action || boolFlag(flags, 'help')) {
    printHelp();
    return;
  }

  if (chain === 'eth' && action === 'check') {
    await checkEthWallet(strFlag(flags, 'address') ?? extraPositional, strFlag(flags, 'token'));
    return;
  }

  if (chain === 'eth' && action === 'rescue') {
    const mode = (strFlag(flags, 'mode') ?? 'eth') as EthRescueMode;
    await runEthRescue({
      mode,
      recipient: strFlag(flags, 'recipient'),
      ethAmount: strFlag(flags, 'amount'),
      useExistingEth: boolFlag(flags, 'use-existing-eth'),
      tokenAddress: strFlag(flags, 'token'),
      tokenAmount: strFlag(flags, 'amount'),
      nftAddress: strFlag(flags, 'nft'),
      tokenId: strFlag(flags, 'token-id'),
      customTo: strFlag(flags, 'to'),
      customData: strFlag(flags, 'data'),
      customValueEth: strFlag(flags, 'value'),
      customGasLimit: strFlag(flags, 'gas'),
      followUpTokenAddress: strFlag(flags, 'followup-token'),
      followUpTokenAmount: strFlag(flags, 'followup-amount'),
      forceRevoke7702: boolFlag(flags, 'force-revoke'),
      priorityFeeGwei: strFlag(flags, 'priority-gwei'),
      dryRun: boolFlag(flags, 'dry-run'),
    });
    return;
  }

  if (chain === 'sol' && action === 'check') {
    await checkSolWallet(strFlag(flags, 'address') ?? extraPositional);
    return;
  }

  if (chain === 'sol' && action === 'rescue') {
    const mode = (strFlag(flags, 'mode') ?? 'spl') as 'spl' | 'sol';
    await runSolRescue({
      mode,
      recipient: strFlag(flags, 'recipient'),
      mintAddress: strFlag(flags, 'mint') ?? 'all',
      closeTokenAccounts: boolFlag(flags, 'close'),
      solAmount: strFlag(flags, 'amount') ?? 'max',
      useDirectRpc: boolFlag(flags, 'direct-rpc'),
      dryRun: boolFlag(flags, 'dry-run'),
    });
    return;
  }

  if (chain === 'trx' && action === 'check') {
    await checkTrxWallet(strFlag(flags, 'address') ?? extraPositional, strFlag(flags, 'token'));
    return;
  }

  if (chain === 'trx' && action === 'rescue') {
    await runTrxRescue({
      tokenAddress: strFlag(flags, 'token'),
      recipient: strFlag(flags, 'recipient'),
      amount: strFlag(flags, 'amount') ?? 'max',
      delegateEnergyTrx: Number(strFlag(flags, 'delegate-energy') ?? '0'),
      delegateBandwidthTrx: Number(strFlag(flags, 'delegate-bandwidth') ?? '0'),
      autoReclaimResources: !boolFlag(flags, 'no-reclaim'),
      dryRun: boolFlag(flags, 'dry-run'),
    });
    return;
  }

  if (chain === 'trx' && action === 'relay') {
    await runTrxRelay({
      recipient: strFlag(flags, 'recipient'),
      amountTrx: Number(strFlag(flags, 'amount') ?? '4'),
      activateRecipientFirst: boolFlag(flags, 'activate-first'),
      burstIntervalMs: Number(strFlag(flags, 'interval') ?? '150'),
      burstDurationMs: Number(strFlag(flags, 'duration') ?? '9000'),
      dryRun: boolFlag(flags, 'dry-run'),
    });
    return;
  }

  printHelp();
}

main().catch((err) => {
  log.err(err?.message ?? String(err));
  process.exit(1);
});
