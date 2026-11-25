import 'dotenv/config';
import type { Address, Hex } from 'viem';

export const COLORS = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

export const log = {
  info: (msg: string) => console.log(`${COLORS.cyan}[INFO]${COLORS.reset} ${msg}`),
  ok: (msg: string) => console.log(`${COLORS.green}[OK]${COLORS.reset} ${msg}`),
  warn: (msg: string) => console.log(`${COLORS.yellow}[WARN]${COLORS.reset} ${msg}`),
  err: (msg: string) => console.error(`${COLORS.red}[ERROR]${COLORS.reset} ${msg}`),
  title: (msg: string) =>
    console.log(`\n${COLORS.bold}${COLORS.blue}=== ${msg} ===${COLORS.reset}`),
};

export function optionalEnv(key: string, fallback = ''): string {
  return (process.env[key] ?? fallback).trim();
}

export function requireEnv(key: string, hint?: string): string {
  const val = optionalEnv(key);
  if (!val) {
    throw new Error(
      `Env variable "${key}" belum diisi di file .env.${hint ? ` (${hint})` : ''}`
    );
  }
  return val;
}

export function normalizeHexKey(raw: string, label: string): Hex {
  const trimmed = raw.trim();
  const hex = trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(`${label} tidak valid: harus 64 karakter hex (dengan/tanpa 0x).`);
  }
  return hex as Hex;
}

export function normalizeEthAddress(raw: string, label: string): Address {
  const trimmed = raw.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(trimmed)) {
    throw new Error(`${label} tidak valid: harus alamat EVM 0x... (42 karakter).`);
  }
  return trimmed as Address;
}

export function parseCsvEnv(key: string, defaults: string[]): string[] {
  const raw = optionalEnv(key);
  if (!raw) return defaults;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function parseEip7702Delegation(bytecode: Hex | undefined): Address | null {
  if (!bytecode || bytecode === '0x') return null;
  const lower = bytecode.toLowerCase();
  // EIP-7702 delegation designator: 0xef0100 || 20-byte address (total 23 bytes = 46 hex chars + '0x' = 48 chars)
  if (lower.startsWith('0xef0100') && lower.length === 48) {
    return (`0x${lower.slice(8)}`) as Address;
  }
  return null;
}

export function computeExactFundingWei(params: {
  victimExistingBalance: bigint;
  txGasLimits: bigint[];
  txValues: bigint[];
  maxFeePerGas: bigint;
  useExistingBalance: boolean;
}): {
  totalGasBudgetWei: bigint;
  totalValueWei: bigint;
  totalRequiredWei: bigint;
  sponsorFundingWei: bigint;
} {
  const totalGasLimit = params.txGasLimits.reduce((acc, g) => acc + g, 0n);
  const totalGasBudgetWei = totalGasLimit * params.maxFeePerGas;
  const totalValueWei = params.txValues.reduce((acc, v) => acc + v, 0n);
  const totalRequiredWei = totalGasBudgetWei + totalValueWei;
  const usableBalance = params.useExistingBalance ? params.victimExistingBalance : 0n;
  const sponsorFundingWei =
    totalRequiredWei > usableBalance ? totalRequiredWei - usableBalance : 0n;

  return {
    totalGasBudgetWei,
    totalValueWei,
    totalRequiredWei,
    sponsorFundingWei,
  };
}
