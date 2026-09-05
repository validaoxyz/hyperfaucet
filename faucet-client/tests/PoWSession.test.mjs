import assert from "node:assert/strict";
import { transformAsync } from "@babel/core";
import presetTypeScript from "@babel/preset-typescript";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

class TestEmitter {
  listeners = new Map();

  on(event, listener) {
    const listeners = this.listeners.get(event) || [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  emit(event, ...args) {
    for(const listener of this.listeners.get(event) || [])
      listener(...args);
  }
}

async function loadSession() {
  const source = await readFile(new URL("../src/pow/PoWSession.ts", import.meta.url), "utf8");
  const transformed = await transformAsync(source, {
    babelrc: false,
    configFile: false,
    filename: "PoWSession.ts",
    presets: [presetTypeScript],
    sourceType: "module",
  });
  assert.ok(transformed?.code);

  const context = vm.createContext({});
  const module = new vm.SourceTextModule(transformed.code, { context });
  const emitter = new vm.SyntheticModule(["TypedEmitter"], function() {
    this.setExport("TypedEmitter", TestEmitter);
  }, { context });
  await emitter.link(() => {});
  await emitter.evaluate();
  await module.link(async (specifier) => {
    if(specifier === "tiny-typed-emitter")
      return emitter;
    throw new Error(`unexpected PoWSession dependency: ${specifier}`);
  });
  await module.evaluate();
  return module.namespace.PoWSession;
}

test("serializes found-share submissions when the worker count increases", async () => {
  const PoWSession = await loadSession();
  let releaseFirst;
  const firstResult = new Promise((resolve) => { releaseFirst = resolve; });
  const submitted = [];
  const client = {
    isReady: () => true,
    on: () => client,
    sendRequest: async (action, share) => {
      assert.equal(action, "foundShare");
      submitted.push(share.nonce);
      if(submitted.length === 1)
        await firstResult;
    },
  };
  const session = new PoWSession({
    client,
    session: {
      getModuleState: () => ({preImage: "AA==", lastNonce: 0, shareCount: 0}),
      getDropAmount: () => 0n,
    },
    showNotification: () => {},
  });
  session.resumeSession();

  session.submitShare({nonce: 1, params: "scrypt|1", hashrate: 100});
  session.submitShare({nonce: 2, params: "scrypt|1", hashrate: 200});
  await Promise.resolve();
  assert.deepEqual(submitted, [1]);

  releaseFirst();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(submitted, [1, 2]);
});
