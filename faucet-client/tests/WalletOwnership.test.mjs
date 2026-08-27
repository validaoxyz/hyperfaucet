import assert from "node:assert/strict";
import { transformAsync } from "@babel/core";
import presetTypeScript from "@babel/preset-typescript";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function loadWalletOwnership() {
  const source = await readFile(new URL("../src/components/stake/injectedWallet.ts", import.meta.url), "utf8");
  const transformed = await transformAsync(source, {
    babelrc: false,
    configFile: false,
    filename: "injectedWallet.ts",
    presets: [presetTypeScript],
    sourceType: "module",
  });
  assert.ok(transformed?.code);

  const context = vm.createContext({TextEncoder});
  const module = new vm.SourceTextModule(transformed.code, {context});
  await module.link(() => {
    throw new Error("wallet helper must remain dependency-free");
  });
  await module.evaluate();
  return module.namespace;
}

test("requests the target account without depending on account order", async () => {
  const wallet = await loadWalletOwnership();
  const target = "0x000000000000000000000000000000000000ABCD";
  const calls = [];
  const provider = {
    request: async (request) => {
      calls.push(request);
      return ["0x0000000000000000000000000000000000001111", target.toLowerCase()];
    },
  };

  assert.equal(await wallet.requestTargetAccount(provider, target), target.toLowerCase());
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "eth_requestAccounts");
});

test("does not request a signature when the connected account differs", async () => {
  const wallet = await loadWalletOwnership();
  const calls = [];
  const provider = {
    request: async (request) => {
      calls.push(request);
      if(request.method === "eth_requestAccounts")
        return ["0x0000000000000000000000000000000000001111"];
      throw new Error("unexpected signing request");
    },
  };

  await assert.rejects(
    wallet.requestTargetAccount(provider, "0x0000000000000000000000000000000000002222"),
    (error) => error.code === "ACCOUNT_MISMATCH",
  );
  assert.equal(calls.length, 1);
});

test("hex-encodes the exact message for personal_sign", async () => {
  const wallet = await loadWalletOwnership();
  const signature = "0x" + "11".repeat(65);
  const calls = [];
  const provider = {
    request: async (request) => {
      calls.push(request);
      return signature;
    },
  };
  const address = "0x000000000000000000000000000000000000abcd";

  assert.equal(await wallet.signOwnershipMessage(provider, address, "HYPE ✓"), signature);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "personal_sign");
  assert.equal(calls[0].params[0], "0x4859504520e29c93");
  assert.equal(calls[0].params[1], address);
});

test("classifies wallet cancellation and malformed signatures", async () => {
  const wallet = await loadWalletOwnership();
  const rejectedProvider = {request: async () => { throw {code: 4001}; }};
  await assert.rejects(
    wallet.requestTargetAccount(rejectedProvider, "0x000000000000000000000000000000000000abcd"),
    (error) => error.code === "USER_REJECTED",
  );

  const malformedProvider = {request: async () => "0x1234"};
  await assert.rejects(
    wallet.signOwnershipMessage(
      malformedProvider,
      "0x000000000000000000000000000000000000abcd",
      "message",
    ),
    (error) => error.code === "INVALID_PROVIDER_RESPONSE",
  );
});
