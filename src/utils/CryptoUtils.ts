import crypto from "node:crypto";

const TOKEN_ENVELOPE_VERSION = "v1";
const TOKEN_ENVELOPE_AAD = Buffer.from("hyperfaucet-token:v1", "utf8");
const GCM_IV_LENGTH = 12;
const GCM_TAG_LENGTH = 16;
const MAX_TOKEN_PLAINTEXT_BYTES = 16 * 1024;
const MAX_TOKEN_ENVELOPE_LENGTH = 32 * 1024;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export function sha256(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function deriveEncryptionKey(passphrase: string): Buffer {
  return crypto.createHash("sha256").update(passphrase).digest();
}

function decodeBase64Url(value: string): Buffer | null {
  if(!BASE64URL_PATTERN.test(value))
    return null;

  const decoded = Buffer.from(value, "base64url");
  return decoded.toString("base64url") === value ? decoded : null;
}

function encryptTokenString(input: string, passphrase: string): string {
  const plaintext = Buffer.from(input, "utf8");
  if(plaintext.length > MAX_TOKEN_PLAINTEXT_BYTES)
    throw new Error("Token payload is too large.");

  const iv = crypto.randomBytes(GCM_IV_LENGTH);
  const cipher = crypto.createCipheriv("aes-256-gcm", deriveEncryptionKey(passphrase), iv, {
    authTagLength: GCM_TAG_LENGTH,
  });
  cipher.setAAD(TOKEN_ENVELOPE_AAD);

  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const envelope = Buffer.concat([iv, ciphertext, cipher.getAuthTag()]);
  return `${TOKEN_ENVELOPE_VERSION}.${envelope.toString("base64url")}`;
}

function decryptTokenString(input: unknown, passphrase: string): string | null {
  if(typeof input !== "string" || input.length > MAX_TOKEN_ENVELOPE_LENGTH)
    return null;

  const [version, encodedEnvelope, ...extraParts] = input.split(".");
  if(version !== TOKEN_ENVELOPE_VERSION || !encodedEnvelope || extraParts.length > 0)
    return null;

  const envelope = decodeBase64Url(encodedEnvelope);
  if(!envelope || envelope.length < GCM_IV_LENGTH + GCM_TAG_LENGTH)
    return null;

  const iv = envelope.subarray(0, GCM_IV_LENGTH);
  const tag = envelope.subarray(envelope.length - GCM_TAG_LENGTH);
  const ciphertext = envelope.subarray(GCM_IV_LENGTH, envelope.length - GCM_TAG_LENGTH);

  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", deriveEncryptionKey(passphrase), iv, {
      authTagLength: GCM_TAG_LENGTH,
    });
    decipher.setAAD(TOKEN_ENVELOPE_AAD);
    decipher.setAuthTag(tag);

    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    if(plaintext.length > MAX_TOKEN_PLAINTEXT_BYTES)
      return null;
    return plaintext.toString("utf8");
  } catch {
    return null;
  }
}

export function encryptTokenPayload(payload: unknown, passphrase: string): string {
  const serialized = JSON.stringify(payload);
  if(serialized === undefined)
    throw new Error("Token payload is not JSON serializable.");
  return encryptTokenString(serialized, passphrase);
}

export function decryptTokenPayload(input: unknown, passphrase: string): unknown | null {
  const serialized = decryptTokenString(input, passphrase);
  if(serialized === null)
    return null;

  try {
    return JSON.parse(serialized);
  } catch {
    return null;
  }
}
