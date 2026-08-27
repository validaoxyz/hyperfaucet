import { expect } from "chai";
import {
  BrowserAuthFlow,
  postBrowserAuthRequest,
} from "../../faucet-client/src/components/frontpage/BrowserAuthFlow.js";

class MemoryStorage {
  private readonly values = new Map<string, string>();

  public getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  public setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  public removeItem(key: string): void {
    this.values.delete(key);
  }
}

interface FakePopup {
  closed: boolean;
  close(): void;
  focus(): void;
}

interface SubmittedForm {
  action: string;
  hidden: boolean;
  method: string;
  target: string;
}

function installBrowser(openPopup?: (url: string, target: string, features: string) => FakePopup | null) {
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  const session = new MemoryStorage();
  const local = new MemoryStorage();
  const openedWindows: Array<{url: string; target: string; features: string}> = [];
  const submittedForms: SubmittedForm[] = [];
  const activeForms = new Set<object>();
  const fakeWindow = {
    location: {
      href: "https://client.example/app",
      origin: "https://client.example",
    },
    addEventListener(type: string, listener: (event: unknown) => void) {
      const eventListeners = listeners.get(type) || new Set();
      eventListeners.add(listener);
      listeners.set(type, eventListeners);
    },
    removeEventListener(type: string, listener: (event: unknown) => void) {
      listeners.get(type)?.delete(listener);
    },
    open(url: string, target: string, features: string) {
      openedWindows.push({url, target, features});
      return openPopup?.(url, target, features) ?? null;
    },
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  };
  const fakeDocument = {
    body: {
      appendChild(form: object) {
        activeForms.add(form);
      },
      removeChild(form: object) {
        activeForms.delete(form);
      },
    },
    createElement(tagName: string) {
      if(tagName !== "form")
        throw new Error(`Unexpected element: ${tagName}`);
      return {
        action: "",
        hidden: false,
        method: "",
        target: "",
        submit() {
          submittedForms.push({
            action: this.action,
            hidden: this.hidden,
            method: this.method,
            target: this.target,
          });
        },
      };
    },
  };

  Object.defineProperties(globalThis, {
    window: { configurable: true, value: fakeWindow },
    document: { configurable: true, value: fakeDocument },
    sessionStorage: { configurable: true, value: session },
    localStorage: { configurable: true, value: local },
  });

  return {
    session,
    local,
    activeForms,
    openedWindows,
    submittedForms,
    dispatch(type: string, event: unknown): void {
      for(const listener of listeners.get(type) || [])
        listener(event);
    },
    restore(): void {
      delete (globalThis as Record<string, unknown>).window;
      delete (globalThis as Record<string, unknown>).document;
      delete (globalThis as Record<string, unknown>).sessionStorage;
      delete (globalThis as Record<string, unknown>).localStorage;
    },
  };
}

function isAuthData(value: unknown): value is {token: string} {
  return typeof value === "object" && value !== null
    && Object.keys(value).length === 1
    && typeof (value as {token?: unknown}).token === "string";
}

describe("Browser authentication flow", () => {
  it("includes credentials on browser authentication endpoint requests", async () => {
    const originalFetch = Object.getOwnPropertyDescriptor(globalThis, "fetch");
    const calls: Array<{url: string; options: RequestInit}> = [];
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: (url: string, options: RequestInit) => {
        calls.push({url, options});
        return Promise.resolve({ok: true});
      },
    });

    try {
      await postBrowserAuthRequest("https://callback.example/api/githubAuthState");
    } finally {
      if(originalFetch)
        Object.defineProperty(globalThis, "fetch", originalFetch);
      else
        delete (globalThis as Record<string, unknown>).fetch;
    }

    expect(calls).to.deep.equal([{
      url: "https://callback.example/api/githubAuthState",
      options: {
        method: "POST",
        cache: "no-store",
        credentials: "include",
      },
    }]);
  });

  it("recovers a same-origin result after the parent page reloads", () => {
    const browser = installBrowser();
    const state = "a".repeat(64);
    const envelope = {
      authModule: "github",
      authState: state,
      authResult: {data: {token: "authenticated"}},
    };
    browser.session.setItem("github.AuthState", state);
    browser.local.setItem(`github.AuthResult.${state}`, JSON.stringify(envelope));
    let received: unknown = null;
    const flow = new BrowserAuthFlow("github", isAuthData, (result) => received = result, () => {});

    expect(flow.attach()).to.equal(true);
    expect(received).to.deep.equal(envelope.authResult);
    expect(browser.session.getItem("github.AuthState")).to.equal(null);
    expect(browser.local.getItem(`github.AuthResult.${state}`)).to.equal(null);

    flow.detach();
    browser.restore();
  });

  it("accepts a popup result only from the bound source, origin, module, and state", () => {
    const popup: FakePopup = {
      closed: false,
      close() { this.closed = true; },
      focus() {},
    };
    const browser = installBrowser(() => popup);
    let received: unknown = null;
    const flow = new BrowserAuthFlow("github", isAuthData, (result) => received = result, () => {});
    flow.attach();
    flow.start(
      (state) => `https://github.example/authorize?state=${state}`,
      "https://callback.example/api/githubCallback",
      "",
    );
    const state = flow.getPendingState();
    expect(state).to.match(/^[0-9a-f]{64}$/);
    const envelope = {
      authModule: "github",
      authState: state,
      authResult: {data: {token: "authenticated"}},
    };

    browser.dispatch("message", {origin: "https://attacker.example", source: popup, data: envelope});
    browser.dispatch("message", {origin: "https://callback.example", source: {}, data: envelope});
    browser.dispatch("message", {
      origin: "https://callback.example",
      source: popup,
      data: {...envelope, authModule: "zupass"},
    });
    browser.dispatch("message", {
      origin: "https://callback.example",
      source: popup,
      data: {...envelope, authState: "b".repeat(64)},
    });
    expect(received).to.equal(null);
    expect(flow.getPendingState()).to.equal(state);

    browser.dispatch("message", {origin: "https://callback.example", source: popup, data: envelope});
    expect(received).to.deep.equal(envelope.authResult);
    expect(flow.getPendingState()).to.equal(null);
    expect(popup.closed).to.equal(true);

    flow.detach();
    browser.restore();
  });

  it("submits an origin-bound POST into a pre-opened named popup", () => {
    const popup: FakePopup = {
      closed: false,
      close() { this.closed = true; },
      focus() {},
    };
    const browser = installBrowser(() => popup);
    const popupStates: boolean[] = [];
    const flow = new BrowserAuthFlow("zupass", isAuthData, () => {}, (isOpen) => popupStates.push(isOpen));

    flow.startWithPost(
      (state) => `https://api.example/zupassLogin?state=${state}&clientOrigin=${encodeURIComponent("https://client.example")}`,
      "https://api.example/zupassCallback",
      "width=450,height=600,popup",
    );

    const state = flow.getPendingState();
    expect(state).to.match(/^[0-9a-f]{64}$/);
    expect(browser.openedWindows).to.have.length(1);
    expect(browser.openedWindows[0].url).to.equal("");
    expect(browser.openedWindows[0].target).to.match(/^zupass-auth-[0-9a-f]{64}$/);
    expect(browser.openedWindows[0].features).to.equal("width=450,height=600,popup");
    expect(browser.submittedForms).to.deep.equal([{
      action: `https://api.example/zupassLogin?state=${state}&clientOrigin=https%3A%2F%2Fclient.example`,
      hidden: true,
      method: "POST",
      target: browser.openedWindows[0].target,
    }]);
    expect(browser.activeForms.size).to.equal(0);
    expect(popupStates).to.deep.equal([true]);

    flow.detach();
    browser.restore();
  });

  it("does not submit a form when the browser blocks the popup", () => {
    const browser = installBrowser(() => null);
    const popupStates: boolean[] = [];
    const flow = new BrowserAuthFlow("zupass", isAuthData, () => {}, (isOpen) => popupStates.push(isOpen));

    flow.startWithPost(
      (state) => `https://api.example/zupassLogin?state=${state}`,
      "https://api.example/zupassCallback",
      "popup",
    );

    expect(browser.submittedForms).to.have.length(0);
    expect(browser.activeForms.size).to.equal(0);
    expect(flow.getPendingState()).to.equal(null);
    expect(popupStates).to.deep.equal([false]);

    flow.detach();
    browser.restore();
  });
});
