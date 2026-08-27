import { deflateRawSync, gzipSync } from "node:zlib";
import { chmod, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [packageRootArgument, outputRootArgument, epochArgument] = process.argv.slice(2);
if (!packageRootArgument || !outputRootArgument || !epochArgument || !/^\d+$/u.test(epochArgument)) {
  throw new Error(
    "usage: create-release-archives.mjs <package-root> <output-root> <non-negative epoch>",
  );
}

const packageRoot = path.resolve(packageRootArgument);
const outputRoot = path.resolve(outputRootArgument);
const epoch = Number(epochArgument);
if (!Number.isSafeInteger(epoch)) {
  throw new Error("release epoch exceeds the safe integer range");
}

const rootPackage = JSON.parse(
  await readFile(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
);
if (process.version !== `v${rootPackage.engines?.node}`) {
  throw new Error(
    `release archive creation requires Node v${rootPackage.engines?.node}, got ${process.version}`,
  );
}

const zipDate = new Date(epoch * 1000);
const zipYear = zipDate.getUTCFullYear();
if (zipYear < 1980 || zipYear > 2107) {
  throw new Error("release epoch is outside the ZIP timestamp range");
}

const archiveDefinitions = [
  {
    format: "tar.gz",
    name: "powfaucet-server-all.tar.gz",
    roots: ["bundle", "static", "faucet-config.example.yaml", "run-faucet.sh"],
  },
  {
    format: "zip",
    name: "powfaucet-server-all.zip",
    roots: ["bundle", "static", "faucet-config.example.yaml", "run-faucet.bat"],
  },
  { format: "tar.gz", name: "powfaucet-static.tar.gz", roots: ["static"] },
  { format: "zip", name: "powfaucet-static.zip", roots: ["static"] },
];

function bytewiseCompare(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function expectedMode(relativePath, directory) {
  if (directory) {
    return 0o755;
  }
  return relativePath === "run-faucet.sh" ? 0o755 : 0o644;
}

async function collectEntry(relativePath, entries) {
  const absolutePath = path.join(packageRoot, ...relativePath.split("/"));
  const entryStat = await lstat(absolutePath);
  if (entryStat.isSymbolicLink()) {
    throw new Error(`release inputs must not contain symbolic links: ${relativePath}`);
  }
  if (Math.floor(entryStat.mtimeMs / 1000) !== epoch) {
    throw new Error(`release input mtime is not normalized: ${relativePath}`);
  }
  if (entryStat.isDirectory()) {
    const mode = entryStat.mode & 0o777;
    if (mode !== expectedMode(relativePath, true)) {
      throw new Error(`release directory mode is not normalized: ${relativePath}`);
    }
    entries.push({ directory: true, mode, name: `${relativePath}/`, size: 0 });
    const names = await readdir(absolutePath);
    names.sort(bytewiseCompare);
    for (const name of names) {
      await collectEntry(`${relativePath}/${name}`, entries);
    }
    return;
  }
  if (!entryStat.isFile()) {
    throw new Error(`release input must be a regular file or directory: ${relativePath}`);
  }
  const mode = entryStat.mode & 0o777;
  if (mode !== expectedMode(relativePath, false)) {
    throw new Error(`release file mode is not normalized: ${relativePath}`);
  }
  const content = await readFile(absolutePath);
  entries.push({ content, directory: false, mode, name: relativePath, size: content.length });
}

async function collectEntries(roots) {
  const entries = [];
  for (const root of [...roots].sort(bytewiseCompare)) {
    await collectEntry(root, entries);
  }
  entries.sort((left, right) => bytewiseCompare(left.name, right.name));
  const names = new Set();
  for (const entry of entries) {
    if (names.has(entry.name)) {
      throw new Error(`duplicate release archive entry: ${entry.name}`);
    }
    names.add(entry.name);
  }
  return entries;
}

function writeString(buffer, value, offset, length) {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.length > length) {
    throw new Error(`archive field is too long: ${value}`);
  }
  encoded.copy(buffer, offset);
}

function writeOctal(buffer, value, offset, length) {
  const encoded = value.toString(8).padStart(length - 1, "0");
  if (encoded.length !== length - 1) {
    throw new Error(`archive number does not fit: ${value}`);
  }
  writeString(buffer, `${encoded}\0`, offset, length);
}

function splitUstarPath(entryName) {
  if (Buffer.byteLength(entryName, "utf8") <= 100) {
    return { name: entryName, prefix: "" };
  }
  for (let index = entryName.lastIndexOf("/"); index > 0; index = entryName.lastIndexOf("/", index - 1)) {
    const prefix = entryName.slice(0, index);
    const name = entryName.slice(index + 1);
    if (Buffer.byteLength(prefix, "utf8") <= 155 && Buffer.byteLength(name, "utf8") <= 100) {
      return { name, prefix };
    }
  }
  throw new Error(`release path does not fit in USTAR: ${entryName}`);
}

function tarHeader(entry) {
  const header = Buffer.alloc(512);
  const { name, prefix } = splitUstarPath(entry.name);
  writeString(header, name, 0, 100);
  writeOctal(header, entry.mode, 100, 8);
  writeOctal(header, 0, 108, 8);
  writeOctal(header, 0, 116, 8);
  writeOctal(header, entry.size, 124, 12);
  writeOctal(header, epoch, 136, 12);
  header.fill(0x20, 148, 156);
  header[156] = entry.directory ? 0x35 : 0x30;
  writeString(header, "ustar\0", 257, 6);
  writeString(header, "00", 263, 2);
  writeOctal(header, 0, 329, 8);
  writeOctal(header, 0, 337, 8);
  writeString(header, prefix, 345, 155);
  let checksum = 0;
  for (const byte of header) {
    checksum += byte;
  }
  const encodedChecksum = checksum.toString(8).padStart(6, "0");
  writeString(header, `${encodedChecksum}\0 `, 148, 8);
  return header;
}

function createTarGzip(entries) {
  const parts = [];
  for (const entry of entries) {
    parts.push(tarHeader(entry));
    if (!entry.directory) {
      parts.push(entry.content);
      const padding = (512 - (entry.size % 512)) % 512;
      if (padding > 0) {
        parts.push(Buffer.alloc(padding));
      }
    }
  }
  parts.push(Buffer.alloc(1024));
  const archive = gzipSync(Buffer.concat(parts), { level: 9 });
  if (
    archive.length < 18 ||
    archive[0] !== 0x1f ||
    archive[1] !== 0x8b ||
    archive[2] !== 0x08 ||
    archive[3] !== 0x00
  ) {
    throw new Error("Node produced an unsupported gzip header");
  }
  archive.fill(0, 4, 8);
  archive[9] = 0xff;
  return archive;
}

const crcTable = new Uint32Array(256);
for (let index = 0; index < 256; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  crcTable[index] = value >>> 0;
}

function crc32(content) {
  let value = 0xffffffff;
  for (const byte of content) {
    value = (value >>> 8) ^ crcTable[(value ^ byte) & 0xff];
  }
  return (value ^ 0xffffffff) >>> 0;
}

function dosTimestamp() {
  const time =
    (zipDate.getUTCHours() << 11) |
    (zipDate.getUTCMinutes() << 5) |
    Math.floor(zipDate.getUTCSeconds() / 2);
  const date =
    ((zipDate.getUTCFullYear() - 1980) << 9) |
    ((zipDate.getUTCMonth() + 1) << 5) |
    zipDate.getUTCDate();
  return { date, time };
}

function createZip(entries) {
  const localParts = [];
  const centralParts = [];
  const { date, time } = dosTimestamp();
  let localOffset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const content = entry.directory ? Buffer.alloc(0) : entry.content;
    const method = entry.directory ? 0 : 8;
    const compressed = entry.directory ? content : deflateRawSync(content, { level: 9 });
    const checksum = crc32(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    const typeMode = entry.directory ? 0o040000 : 0o100000;
    const dosAttributes = entry.directory ? 0x10 : 0;
    central.writeUInt32LE((((typeMode | entry.mode) << 16) | dosAttributes) >>> 0, 38);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, name);

    localOffset += local.length + name.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

await mkdir(outputRoot, { recursive: true, mode: 0o755 });
for (const definition of archiveDefinitions) {
  const entries = await collectEntries(definition.roots);
  const archive = definition.format === "tar.gz" ? createTarGzip(entries) : createZip(entries);
  const outputPath = path.join(outputRoot, definition.name);
  await writeFile(outputPath, archive, { mode: 0o644 });
  await chmod(outputPath, 0o644);
}
