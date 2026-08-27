import "mocha";
import crypto from "node:crypto";
import { expect } from "chai";

import { decryptTokenPayload, encryptTokenPayload, sha256 } from "../../src/utils/CryptoUtils.js";

function encryptLegacyCbc(input: string, passphrase: string): string {
  const iv = Buffer.alloc(16, 7);
  const key = Buffer.from(sha256(passphrase), "hex");
  const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
  const ciphertext = Buffer.concat([cipher.update(input), cipher.final()]);
  return Buffer.concat([iv, ciphertext]).toString("base64");
}

function tamperToken(token: string, byteIndex: number): string {
  const [version, encodedEnvelope] = token.split(".");
  const envelope = Buffer.from(encodedEnvelope, "base64url");
  envelope[byteIndex] ^= 1;
  return `${version}.${envelope.toString("base64url")}`;
}

describe("CryptoUtils authenticated tokens", () => {
  const passphrase = "correct horse battery staple";
  const payload = { kind: "test", value: "hello 世界" };

  it("round-trips a versioned token", () => {
    const token = encryptTokenPayload(payload, passphrase);

    expect(token).to.match(/^v1\.[A-Za-z0-9_-]+$/);
    expect(decryptTokenPayload(token, passphrase)).to.deep.equal(payload);
  });

  it("uses a fresh nonce for each token", () => {
    const first = encryptTokenPayload(payload, passphrase);
    const second = encryptTokenPayload(payload, passphrase);

    expect(second).to.not.equal(first);
    expect(decryptTokenPayload(first, passphrase)).to.deep.equal(payload);
    expect(decryptTokenPayload(second, passphrase)).to.deep.equal(payload);
  });

  it("rejects changes to the nonce, ciphertext, and authentication tag", () => {
    const token = encryptTokenPayload(payload, passphrase);
    const envelope = Buffer.from(token.split(".")[1], "base64url");

    expect(decryptTokenPayload(tamperToken(token, 0), passphrase)).to.equal(null);
    expect(decryptTokenPayload(tamperToken(token, 12), passphrase)).to.equal(null);
    expect(decryptTokenPayload(tamperToken(token, envelope.length - 1), passphrase)).to.equal(null);
  });

  it("rejects the wrong key", () => {
    const token = encryptTokenPayload(payload, passphrase);
    expect(decryptTokenPayload(token, "wrong passphrase")).to.equal(null);
  });

  it("rejects a truncated token", () => {
    const token = encryptTokenPayload(payload, passphrase);
    expect(decryptTokenPayload(token.slice(0, -2), passphrase)).to.equal(null);
  });

  it("rejects unsupported versions and non-canonical encoding", () => {
    const token = encryptTokenPayload(payload, passphrase);
    expect(decryptTokenPayload(token.replace(/^v1\./, "v2."), passphrase)).to.equal(null);
    expect(decryptTokenPayload(token + "=", passphrase)).to.equal(null);
  });

  it("rejects legacy AES-CBC tokens", () => {
    const legacyToken = encryptLegacyCbc(JSON.stringify(payload), passphrase);
    expect(decryptTokenPayload(legacyToken, passphrase)).to.equal(null);
  });
});
