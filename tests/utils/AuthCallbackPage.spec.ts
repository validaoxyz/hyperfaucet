import "mocha";
import { expect } from "chai";
import { IncomingMessage } from "node:http";
import { runInNewContext } from "node:vm";
import {
  AuthCallbackContext,
  buildAuthCallbackPage,
  normalizeHttpOrigin,
  resolveAuthCallbackContext,
  serializeInlineJson,
} from "../../src/webserv/AuthCallbackPage.js";

const AUTH_STATE = "c".repeat(64);
const CALLBACK_ORIGIN = "https://callback.example";

function fakeRequest(options: {
  host?: string;
  encrypted?: boolean;
  forwardedProtocol?: string;
} = {}): IncomingMessage {
  const headers: Record<string, string> = { host: options.host || "callback.example" };
  if(options.forwardedProtocol !== undefined)
    headers["x-forwarded-proto"] = options.forwardedProtocol;
  return {
    headers,
    socket: { encrypted: options.encrypted === true },
  } as unknown as IncomingMessage;
}

function resolveContext(options: {
  state?: string | boolean;
  clientOrigin?: string | boolean;
  redirectUrl?: string | null;
  corsAllowOrigins?: string[];
  request?: IncomingMessage;
  trustedProxyCount?: number;
} = {}): AuthCallbackContext | null {
  const clientOrigin = options.clientOrigin === undefined
    ? encodeURIComponent(CALLBACK_ORIGIN)
    : options.clientOrigin;
  return resolveAuthCallbackContext({
    request: options.request || fakeRequest({ encrypted: true }),
    query: {
      state: options.state === undefined ? AUTH_STATE : options.state,
      clientOrigin,
    },
    redirectUrl: options.redirectUrl === undefined
      ? `${CALLBACK_ORIGIN}/api/githubCallback`
      : options.redirectUrl,
    corsAllowOrigins: options.corsAllowOrigins || [],
    trustedProxyCount: options.trustedProxyCount || 0,
  });
}

function extractScript(page: string): string {
  const match = /<script>([\s\S]*)<\/script>/.exec(page);
  expect(match, "callback script missing").to.not.equal(null);
  return match![1];
}

describe("Auth callback page", () => {
  it("accepts only lowercase hexadecimal callback state", () => {
    expect(resolveContext()).to.deep.equal({
      authState: AUTH_STATE,
      callbackOrigin: CALLBACK_ORIGIN,
      clientOrigin: CALLBACK_ORIGIN,
      sameOrigin: true,
    });
    for(const state of [true, "", "c".repeat(63), "c".repeat(65), "C".repeat(64), "g".repeat(64)])
      expect(resolveContext({ state })).to.equal(null);
  });

  it("normalizes only complete HTTP and HTTPS origins", () => {
    expect(normalizeHttpOrigin("HTTPS://CLIENT.EXAMPLE:443/")).to.equal("https://client.example");
    for(const origin of [
      "javascript:alert(1)",
      "https://user:password@client.example",
      "https://client.example/path",
      "https://client.example?query=1",
      "https://client.example/#fragment",
      " https://client.example",
    ]) {
      expect(normalizeHttpOrigin(origin)).to.equal(null);
    }
  });

  it("rejects malformed, double-encoded, and disallowed client origins", () => {
    expect(resolveContext({ clientOrigin: "%E0%A4%A" })).to.equal(null);
    expect(resolveContext({ clientOrigin: encodeURIComponent(encodeURIComponent(CALLBACK_ORIGIN)) })).to.equal(null);
    expect(resolveContext({ clientOrigin: encodeURIComponent("https://client.example") })).to.equal(null);
    expect(resolveContext({
      clientOrigin: encodeURIComponent("https://client.example"),
      corsAllowOrigins: ["*"],
    })).to.equal(null);
  });

  it("allows a split origin only through an exact normalized CORS entry", () => {
    expect(resolveContext({
      clientOrigin: encodeURIComponent("https://client.example"),
      corsAllowOrigins: ["HTTPS://CLIENT.EXAMPLE:443/"],
    })).to.deep.equal({
      authState: AUTH_STATE,
      callbackOrigin: CALLBACK_ORIGIN,
      clientOrigin: "https://client.example",
      sameOrigin: false,
    });
  });

  it("uses the configured redirect origin before a trusted request fallback", () => {
    expect(resolveContext({ request: fakeRequest({ host: "untrusted.example" }) })?.callbackOrigin)
      .to.equal(CALLBACK_ORIGIN);
    expect(resolveContext({
      redirectUrl: null,
      request: fakeRequest({ host: "callback.example", encrypted: false, forwardedProtocol: "https" }),
      trustedProxyCount: 1,
    })?.callbackOrigin).to.equal(CALLBACK_ORIGIN);
    expect(resolveContext({
      redirectUrl: null,
      clientOrigin: encodeURIComponent("http://callback.example"),
      request: fakeRequest({ host: "callback.example", encrypted: false, forwardedProtocol: "https" }),
      trustedProxyCount: 0,
    })?.callbackOrigin).to.equal("http://callback.example");
    expect(resolveContext({ redirectUrl: "not a URL" })).to.equal(null);
  });

  it("uses the protocol entry at the configured trusted-proxy depth", () => {
    expect(resolveContext({
      redirectUrl: null,
      request: fakeRequest({
        host: "callback.example",
        encrypted: false,
        forwardedProtocol: "https, http",
      }),
      trustedProxyCount: 2,
    })?.callbackOrigin).to.equal(CALLBACK_ORIGIN);
    expect(resolveContext({
      redirectUrl: null,
      request: fakeRequest({
        host: "callback.example",
        encrypted: false,
        forwardedProtocol: "https",
      }),
      trustedProxyCount: 2,
    })).to.equal(null);
    expect(resolveContext({
      redirectUrl: null,
      request: fakeRequest({
        host: "callback.example",
        encrypted: false,
        forwardedProtocol: "https, invalid",
      }),
      trustedProxyCount: 1,
    })).to.equal(null);
  });

  it("escapes inline JSON without changing its value", () => {
    const value = { text: "</script><script>&\u2028\u2029" };
    const serialized = serializeInlineJson(value);
    expect(serialized).to.not.include("</script>");
    expect(serialized).to.include("\\u003c/script\\u003e");
    expect(serialized).to.include("\\u0026\\u2028\\u2029");
    expect(JSON.parse(serialized)).to.deep.equal(value);
  });

  it("posts the exact callback envelope to the explicit target origin", () => {
    const messages: Array<{ value: unknown; targetOrigin: string }> = [];
    const writes: Array<{ key: string; value: string }> = [];
    const actions: string[] = [];
    const context = resolveContext()!;
    const authResult = { data: { user: "alice" } };
    const page = buildAuthCallbackPage({ authModule: "github", context, authResult });
    const window = {
      localStorage: {
        setItem(key: string, value: string) {
          actions.push("store");
          writes.push({ key, value });
        },
      },
      opener: {
        postMessage(value: unknown, targetOrigin: string) {
          actions.push("post");
          messages.push({ value, targetOrigin });
        },
      },
    };

    runInNewContext(extractScript(page), { window });

    expect(messages).to.deep.equal([{
      value: { authModule: "github", authState: AUTH_STATE, authResult },
      targetOrigin: CALLBACK_ORIGIN,
    }]);
    expect(writes).to.deep.equal([{
      key: `github.AuthResult.${AUTH_STATE}`,
      value: JSON.stringify({ authModule: "github", authState: AUTH_STATE, authResult }),
    }]);
    expect(actions).to.deep.equal(["store", "post"]);
  });

  it("uses the state-specific storage key only for same-origin fallback", () => {
    const writes: Array<{ key: string; value: string }> = [];
    const redirects: string[] = [];
    const context = resolveContext()!;
    const authResult = { errorCode: "AUTH_ERROR", errorMessage: "Try again." };
    const page = buildAuthCallbackPage({ authModule: "github", context, authResult });
    const window = {
      opener: null,
      localStorage: {
        setItem(key: string, value: string) {
          writes.push({ key, value });
        },
      },
      location: {
        replace(value: string) {
          redirects.push(value);
        },
      },
    };

    runInNewContext(extractScript(page), { window });

    expect(writes).to.deep.equal([{
      key: `github.AuthResult.${AUTH_STATE}`,
      value: JSON.stringify({ authModule: "github", authState: AUTH_STATE, authResult }),
    }]);
    expect(redirects).to.deep.equal([CALLBACK_ORIGIN]);
  });

  it("fails closed when a split-origin callback has no opener", () => {
    const context = resolveContext({
      clientOrigin: encodeURIComponent("https://client.example"),
      corsAllowOrigins: ["https://client.example"],
    })!;
    const page = buildAuthCallbackPage({
      authModule: "zupass",
      context,
      authResult: { data: { token: "sensitive-token" } },
    });
    const script = extractScript(page);
    const body = { textContent: "" };
    const window = { opener: null, document: { body } };

    expect(script.indexOf("if(!window.opener)")).to.be.lessThan(script.indexOf("const envelope"));
    runInNewContext(script, { window });

    expect(body.textContent).to.equal("Authentication could not be returned. Close this window and try again.");
  });
});
