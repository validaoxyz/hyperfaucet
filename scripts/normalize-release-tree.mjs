import { chmod, lstat, readdir, utimes } from "node:fs/promises";
import path from "node:path";

const [rootArgument, epochArgument] = process.argv.slice(2);
if (!rootArgument || !epochArgument || !/^\d+$/u.test(epochArgument)) {
  throw new Error("usage: normalize-release-tree.mjs <root> <non-negative epoch>");
}

const root = path.resolve(rootArgument);
const epoch = Number(epochArgument);
if (!Number.isSafeInteger(epoch)) {
  throw new Error("release epoch exceeds the safe integer range");
}

async function normalize(entryPath) {
  const entryStat = await lstat(entryPath);
  if (entryStat.isSymbolicLink()) {
    throw new Error(`release inputs must not contain symbolic links: ${entryPath}`);
  }
  if (entryStat.isDirectory()) {
    const names = await readdir(entryPath);
    for (const name of names) {
      await normalize(path.join(entryPath, name));
    }
    await chmod(entryPath, 0o755);
    await utimes(entryPath, epoch, epoch);
    return;
  }
  if (!entryStat.isFile()) {
    throw new Error(`release input must be a regular file or directory: ${entryPath}`);
  }
  const mode = path.relative(root, entryPath) === "run-faucet.sh" ? 0o755 : 0o644;
  await chmod(entryPath, mode);
  await utimes(entryPath, epoch, epoch);
}

await normalize(root);
