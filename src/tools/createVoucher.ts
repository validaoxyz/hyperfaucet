import { FaucetDatabase } from "../db/FaucetDatabase.js";
import crypto from "crypto";
import { Command } from "commander";
import { basename } from "path";
import { loadFaucetConfig } from "../config/FaucetConfig.js";
import { ServiceManager } from "../common/ServiceManager.js";
import { FaucetProcess } from "../common/FaucetProcess.js";
import { VoucherCodeCollisionError, VoucherDB } from "../modules/voucher/VoucherDB.js";

const ETH_DECIMALS = 18;
const ETH_BASE_UNITS = 10n ** BigInt(ETH_DECIMALS);
const MAX_VOUCHER_AMOUNT = (10n ** 50n) - 1n;

export const MAX_VOUCHER_INSERT_ATTEMPTS = 10;

function generateRandomString(length: number, prefix?: string): string {
  const chars = "ABCDEFGHIJKLMNPQRSTUVWXYZ123456789";
  let result = prefix || "";
  
  while (result.length < (prefix ? prefix.length : 0) + length) {
    const randomByte = crypto.randomBytes(1)[0];
    if (randomByte < 256 - (256 % chars.length)) {
      result += chars[randomByte % chars.length];
    }
  }
  
  return result;
}

export function parseVoucherAmount(amount: string): string {
  let baseUnits: bigint;
  const ethMatch = /^([0-9]+)(?:\.([0-9]{1,18}))?ETH$/i.exec(amount);

  if(ethMatch) {
    const whole = ethMatch[1].replace(/^0+(?=\d)/, "");
    if(whole.length > 32)
      throw new RangeError("Voucher amount exceeds the database limit.");

    const fractional = (ethMatch[2] || "").padEnd(ETH_DECIMALS, "0");
    baseUnits = (BigInt(whole) * ETH_BASE_UNITS) + BigInt(fractional || "0");
  } else if(/^[0-9]+$/.test(amount)) {
    const normalized = amount.replace(/^0+(?=\d)/, "");
    if(normalized.length > 50)
      throw new RangeError("Voucher amount exceeds the database limit.");
    baseUnits = BigInt(normalized);
  } else {
    throw new Error("Voucher amount must be a whole wei value or an ETH decimal with at most 18 fractional digits.");
  }

  if(baseUnits <= 0n)
    throw new RangeError("Voucher amount must be greater than zero.");
  if(baseUnits > MAX_VOUCHER_AMOUNT)
    throw new RangeError("Voucher amount exceeds the database limit.");

  return baseUnits.toString();
}

function parseVoucherCount(value: string): number {
  if(!/^[1-9][0-9]*$/.test(value))
    throw new Error("Voucher count must be a positive integer.");
  const count = Number(value);
  if(!Number.isSafeInteger(count))
    throw new RangeError("Voucher count is too large.");
  return count;
}

interface CreateUniqueVoucherOptions {
  generateCode: () => string;
  insertVoucher: (code: string) => Promise<void>;
  maxAttempts?: number;
}

export async function createUniqueVoucher(options: CreateUniqueVoucherOptions): Promise<string> {
  const maxAttempts = options.maxAttempts ?? MAX_VOUCHER_INSERT_ATTEMPTS;
  if(!Number.isSafeInteger(maxAttempts) || maxAttempts <= 0)
    throw new RangeError("Voucher insert attempt limit must be a positive integer.");

  for(let attempt = 0; attempt < maxAttempts; attempt++) {
    const code = options.generateCode();
    try {
      await options.insertVoucher(code);
      return code;
    } catch(error) {
      if(!(error instanceof VoucherCodeCollisionError))
        throw error;
    }
  }

  throw new Error("Could not generate a unique voucher code within the retry limit.");
}

export async function createVoucher(): Promise<void> {
  const program = new Command();
  const argv = process.argv.slice();
  argv.splice(2, 1);

  ServiceManager.GetService(FaucetProcess).hideLogOutput = true;
  
  program
    .name(basename(process.argv[1]))
    .description('Mass create voucher codes for PoWFaucet')
    .option('-c, --count <number>', 'Number of voucher codes to generate', parseVoucherCount)
    .option('-a, --amount <value>', 'Override drop amount (supports ETH as unit, otherwise wei)')
    .option('-p, --prefix [string]', 'Code prefix')
    .parse(argv);
  
  const options = program.opts();
  
  if (!options.count || options.count <= 0) {
    console.error("Error: Count must be a positive number");
    program.help();
    process.exit(1);
  }
  
  // Initialize database
  loadFaucetConfig();
  const faucetDb = ServiceManager.GetService(FaucetDatabase);
  await faucetDb.initialize();

  const amount = options.amount === undefined ? "" : parseVoucherAmount(options.amount);
  const prefix = options.prefix || "";
  const codeLength = Math.max(10, 20 - prefix.length);

  for (let i = 0; i < options.count; i++) {
    const code = await createUniqueVoucher({
      generateCode: () => generateRandomString(codeLength, prefix),
      insertVoucher: (candidate) => VoucherDB.insertVoucher(faucetDb.getDatabase(), candidate, amount),
    });
    console.log(code.match(/.{1,5}/g).join(" "));
  }

  process.exit(0);
}
