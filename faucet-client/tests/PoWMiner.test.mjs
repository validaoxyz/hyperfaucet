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

class TestWorker {
  listeners = [];
  messages = [];
  terminated = false;

  addEventListener(type, listener) {
    if(type === "message")
      this.listeners.push(listener);
  }

  postMessage(message) {
    this.messages.push(message);
  }

  terminate() {
    this.terminated = true;
  }

  emit(message) {
    for(const listener of this.listeners)
      listener({ data: message });
  }
}

async function loadMiner() {
  const source = await readFile(new URL("../src/pow/PoWMiner.ts", import.meta.url), "utf8");
  const transformed = await transformAsync(source, {
    babelrc: false,
    configFile: false,
    filename: "PoWMiner.ts",
    presets: [presetTypeScript],
    sourceType: "module",
  });
  assert.ok(transformed?.code);
  const output = transformed.code;

  const storage = new Map();
  const context = vm.createContext({
    Blob,
    Worker: TestWorker,
    clearTimeout,
    console,
    localStorage: {
      getItem: (key) => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, value),
    },
    location: { origin: "https://hyperfaucet.dev" },
    navigator: { hardwareConcurrency: 2 },
    setTimeout,
    window: { URL: { createObjectURL: () => "blob:worker-init" } },
  });
  const module = new vm.SourceTextModule(output, { context });
  await module.link(async (specifier) => {
    let exports;
    if(specifier === "tiny-typed-emitter") {
      exports = { TypedEmitter: TestEmitter };
    }
    else if(specifier.endsWith("PoWParamsHelper")) {
      exports = { getPoWParamsStr: (params, difficulty) => `${params.a}:${difficulty}` };
    }
    else if(specifier.endsWith("PoWMinerSrc")) {
      exports = {
        PoWHashAlgo: {
          SCRYPT: "scrypt",
          CRYPTONIGHT: "cryptonight",
          ARGON2: "argon2",
          NICKMINER: "nickminer",
        },
      };
    }
    else {
      throw new Error(`unexpected PoWMiner dependency: ${specifier}`);
    }
    const dependency = new vm.SyntheticModule(Object.keys(exports), function() {
      for(const [name, value] of Object.entries(exports))
        this.setExport(name, value);
    }, { context });
    await dependency.link(() => {});
    await dependency.evaluate();
    return dependency;
  });
  await module.evaluate();
  return module.namespace.PoWMiner;
}

test("terminated workers cannot submit queued messages", async () => {
  const PoWMiner = await loadMiner();
  const submitted = [];
  let nextNonce = 1;
  const session = {
    getLastNonce: () => nextNonce,
    getNonceRange: (count) => {
      const start = nextNonce;
      nextNonce += count;
      return start;
    },
    getPreImage: () => "AA==",
    getStartTime: () => 0,
    setMiner: () => {},
    submitShare: (share) => submitted.push(share),
  };
  const miner = new PoWMiner({
    difficulty: 1,
    hashrateLimit: 0,
    powParams: { a: "scrypt" },
    session,
    time: {
      getSyncedDate: () => new Date(0),
      getSyncedTime: () => 100,
    },
    workerSrc: {
      argon2: "/worker.js",
      cryptonight: "/worker.js",
      nickminer: "/worker.js",
      scrypt: "/worker.js",
    },
  });

  miner.startMiner();
  const retained = miner.workers[0];
  const removed = miner.workers[1];
  retained.ready = true;
  retained.lastNonce = 100;

  removed.worker.emit({ action: "preinit" });
  miner.setWorkerCount(1);
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(removed.active, false);
  assert.equal(removed.worker.terminated, true);
  assert.equal(removed.worker.messages.length, 0);

  removed.worker.emit({
    action: "nonce",
    data: { nonce: 50, params: "scrypt:1" },
  });
  assert.equal(submitted.length, 0);
  assert.equal(miner.nonceQueue.length, 0);
});
