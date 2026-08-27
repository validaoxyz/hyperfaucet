import { IncomingMessage, OutgoingHttpHeaders } from "node:http";

export type AuthCallbackModule = "github" | "zupass";

export type AuthCallbackResult<T> =
  | { data: T }
  | { errorCode: string; errorMessage?: string };

export interface AuthCallbackOrigins {
  callbackOrigin: string;
  clientOrigin: string;
  sameOrigin: boolean;
}

export interface AuthCallbackContext extends AuthCallbackOrigins {
  authState: string;
}

interface ResolveAuthCallbackContextOptions {
  request: IncomingMessage;
  query: Readonly<Record<string, string | boolean>>;
  redirectUrl: string | null | undefined;
  corsAllowOrigins: readonly string[];
  trustedProxyCount: number;
}

interface BuildAuthCallbackPageOptions<T> {
  authModule: AuthCallbackModule;
  context: AuthCallbackContext;
  authResult: AuthCallbackResult<T>;
}

const AUTH_STATE_PATTERN = /^[0-9a-f]{64}$/;
const MAX_ORIGIN_LENGTH = 2048;
const INLINE_JSON_ESCAPES: Readonly<Record<string, string>> = Object.freeze({
  "<": "\\u003c",
  ">": "\\u003e",
  "&": "\\u0026",
  "\u2028": "\\u2028",
  "\u2029": "\\u2029",
});

export const AUTH_CALLBACK_RESPONSE_HEADERS: Readonly<OutgoingHttpHeaders> = Object.freeze({
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "Content-Type": "text/html; charset=utf-8",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
});

function decodeQueryValue(value: string | boolean | undefined): string | null {
  if(typeof value !== "string" || value.length === 0 || value.length > MAX_ORIGIN_LENGTH * 3)
    return null;

  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function parseHttpUrl(value: string): URL | null {
  if(value.length === 0 || value.length > MAX_ORIGIN_LENGTH || value !== value.trim())
    return null;

  try {
    const url = new URL(value);
    if((url.protocol !== "http:" && url.protocol !== "https:")
      || url.origin === "null"
      || url.username !== ""
      || url.password !== ""
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

export function normalizeHttpOrigin(value: string): string | null {
  const url = parseHttpUrl(value);
  if(!url || url.pathname !== "/" || url.search !== "" || url.hash !== "")
    return null;
  return url.origin;
}

function getRedirectOrigin(redirectUrl: string): string | null {
  return parseHttpUrl(redirectUrl)?.origin || null;
}

function getForwardedProtocol(
  request: IncomingMessage,
  trustedProxyCount: number,
): "http:" | "https:" | null {
  const header = request.headers["x-forwarded-proto"];
  if(typeof header !== "string" || !Number.isSafeInteger(trustedProxyCount) || trustedProxyCount < 1)
    return null;

  const parts = header.split(",").map((part) => part.trim().toLowerCase());
  if(parts.length < trustedProxyCount || parts.some((part) => part !== "http" && part !== "https"))
    return null;

  const protocol = parts[parts.length - trustedProxyCount];
  if(protocol === "http" || protocol === "https")
    return `${protocol}:`;
  return null;
}

function isEncryptedRequest(request: IncomingMessage): boolean {
  return "encrypted" in request.socket && request.socket.encrypted === true;
}

function getRequestOrigin(request: IncomingMessage, trustedProxyCount: number): string | null {
  const host = request.headers.host;
  if(typeof host !== "string" || host.length === 0)
    return null;

  let protocol: "http:" | "https:";
  if(trustedProxyCount > 0) {
    const forwardedProtocol = getForwardedProtocol(request, trustedProxyCount);
    if(!forwardedProtocol)
      return null;
    protocol = forwardedProtocol;
  } else {
    protocol = isEncryptedRequest(request) ? "https:" : "http:";
  }
  return normalizeHttpOrigin(`${protocol}//${host}`);
}

function isExplicitlyAllowedOrigin(clientOrigin: string, corsAllowOrigins: readonly string[]): boolean {
  return corsAllowOrigins.some((configuredOrigin) => {
    if(configuredOrigin === "*")
      return false;
    return normalizeHttpOrigin(configuredOrigin) === clientOrigin;
  });
}

export function resolveAuthCallbackContext(
  options: ResolveAuthCallbackContextOptions,
): AuthCallbackContext | null {
  const stateValue = options.query.state;
  if(typeof stateValue !== "string" || !AUTH_STATE_PATTERN.test(stateValue))
    return null;

  const origins = resolveAuthCallbackOrigins(options);
  if(!origins)
    return null;

  return {
    authState: stateValue,
    ...origins,
  };
}

export function resolveAuthCallbackOrigins(
  options: ResolveAuthCallbackContextOptions,
): AuthCallbackOrigins | null {
  const decodedClientOrigin = decodeQueryValue(options.query.clientOrigin);
  const clientOrigin = decodedClientOrigin ? normalizeHttpOrigin(decodedClientOrigin) : null;
  if(!clientOrigin)
    return null;

  const hasConfiguredRedirect = typeof options.redirectUrl === "string"
    && options.redirectUrl.trim() !== "";
  const callbackOrigin = hasConfiguredRedirect
    ? getRedirectOrigin(options.redirectUrl)
    : getRequestOrigin(options.request, options.trustedProxyCount);
  if(!callbackOrigin)
    return null;

  const sameOrigin = callbackOrigin === clientOrigin;
  if(!sameOrigin && !isExplicitlyAllowedOrigin(clientOrigin, options.corsAllowOrigins))
    return null;

  return {
    callbackOrigin,
    clientOrigin,
    sameOrigin,
  };
}

export function serializeInlineJson(value: unknown): string {
  const serialized = JSON.stringify(value);
  if(serialized === undefined)
    throw new Error("Callback payload is not JSON serializable.");
  return serialized.replace(/[<>&\u2028\u2029]/g, (character) => INLINE_JSON_ESCAPES[character]);
}

export function buildAuthCallbackPage<T>(options: BuildAuthCallbackPageOptions<T>): string {
  const envelope = {
    authModule: options.authModule,
    authState: options.context.authState,
    authResult: options.authResult,
  };
  const serializedEnvelope = serializeInlineJson(envelope);
  const serializedTargetOrigin = serializeInlineJson(options.context.clientOrigin);
  const title = options.authModule === "github" ? "GitHub authentication" : "Zupass authentication";

  const script = options.context.sameOrigin
    ? [
        "(function() {",
        `const envelope = ${serializedEnvelope};`,
        `const targetOrigin = ${serializedTargetOrigin};`,
        `try { window.localStorage.setItem(${serializeInlineJson(`${options.authModule}.AuthResult.${options.context.authState}`)}, JSON.stringify(envelope)); } catch {}`,
        "if(window.opener) {",
        "window.opener.postMessage(envelope, targetOrigin);",
        "return;",
        "}",
        "window.location.replace(targetOrigin);",
        "})();",
      ].join("")
    : [
        "(function() {",
        "if(!window.opener) {",
        'window.document.body.textContent = "Authentication could not be returned. Close this window and try again.";',
        "return;",
        "}",
        `const envelope = ${serializedEnvelope};`,
        `const targetOrigin = ${serializedTargetOrigin};`,
        "window.opener.postMessage(envelope, targetOrigin);",
        "})();",
      ].join("");

  return [
    "<!DOCTYPE html>",
    '<html><head><meta charset="UTF-8">',
    `<title>${title}</title></head><body>`,
    `<script>${script}</script>`,
    "</body></html>",
  ].join("");
}
