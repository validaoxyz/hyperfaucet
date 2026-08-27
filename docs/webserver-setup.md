# Production web server setup

Terminate TLS at a dedicated reverse proxy. Serve `static/` there, proxy `/api/*` to the Node
process, and proxy `/ws/*` with WebSocket upgrades enabled.

## Process ownership

Run one active Node process for each faucet database and payout wallet. Do not put active-active
backends behind the proxy when they share either resource. Start a failover only after the previous
process has stopped, drained its work, and closed the database.

## Trusted proxy boundary

The Node server listens on its configured port without an interface allowlist. Use a host firewall,
security group, private container network, or equivalent control so only the trusted proxy chain can
reach that port. Do this before setting `httpProxyCount` above 0.

Set `httpProxyCount` to the exact number of trusted hops between the client and Node. A direct nginx
or Apache proxy is one hop. A CDN followed by an origin proxy is two hops. Every hop must preserve
the public `Host` header and append valid `X-Forwarded-For` and `X-Forwarded-Proto` values. The final
proxy must not pass an attacker-selected `Host` for an unconfigured virtual host.

Treat these checks as a deployment gate:

```bash
curl -fsS https://faucet.example/api/getVersion
curl --connect-timeout 5 http://ORIGIN_IP:8080/api/getVersion
```

The public request must succeed over HTTPS. The direct-origin request must fail to connect or time
out. Any HTTP response from the Node port means the origin is still reachable and the deployment
fails this gate. Also confirm that per-IP limits distinguish two external clients and cannot be
bypassed with a supplied `X-Forwarded-For` header.

## Authentication callbacks

Set explicit production callback URLs even when the client and API share one origin.

For a same-origin deployment at `https://faucet.example`:

```yaml
corsAllowOrigin: []
modules:
  github:
    redirectUrl: "https://faucet.example/api/githubCallback"
  zupass:
    redirectUrl: "https://faucet.example/api/zupassCallback"
```

Register the exact GitHub URL in the OAuth app. The proxy must pass `Host: faucet.example` and an
effective `X-Forwarded-Proto: https` chain.

For a client at `https://app.example` and API at `https://api.example`, use callback URLs on the API
origin and allow only the client origin. The GitHub client and API must be HTTPS origins on the same
schemeful site (normally sibling hosts under the same registrable domain); its recovery flow uses a
Secure, SameSite=Lax browser cookie and same-site Fetch Metadata:

```yaml
corsAllowOrigin:
  - "https://app.example"
modules:
  github:
    redirectUrl: "https://api.example/api/githubCallback"
  zupass:
    redirectUrl: "https://api.example/api/zupassCallback"
```

Do not use `corsAllowOrigin: ["*"]` for a split-origin authentication flow. After deployment, run
both callbacks through the public client. Confirm that the proxy rejects an unconfigured `Host`
and that the application rejects a different `clientOrigin`.

## Cloudflare live configuration

This repository supplies application headers, Turnstile integration, a 64 KiB WebSocket frame
limit, and local PoW capacity controls. It does not supply Cloudflare zone configuration or origin
access control. Configure and verify these controls in the live zone:

- proxy the hostname through Cloudflare and restrict the origin to Cloudflare, or use a Tunnel or
  authenticated origin; a direct request to the origin port must fail;
- use Full (strict) TLS validation to the origin;
- bypass cache for `/api/*` and `/ws/*`, including authentication callbacks and status responses;
- enable managed WAF rules and narrow rate limits for session creation, authentication callbacks,
  refresh endpoints, and WebSocket upgrades; and
- keep WebSocket frame validation and PoW accounting in the application because edge rules do not
  inspect messages after an upgrade.

After each deployment, test public anonymous and authenticated flows, callback origins, a
WebSocket upgrade, cache behavior, and direct-origin rejection. Passing source tests does not prove
the live-zone configuration.

## Apache

Use `mpm_event` for long-lived WebSocket connections. The example
[sitecfg-apache2.conf](sitecfg-apache2.conf) requires these modules:

- `headers`
- `proxy`
- `proxy_http`
- `proxy_wstunnel`
- `rewrite`
- `ssl`

`mod_headers` is mandatory. It supplies both the security response headers and the
`X-Forwarded-Proto` request header. Confirm every module with `apachectl -M`, then run
`apachectl configtest`. The example keeps required TLS directives unguarded so a missing module
fails configuration validation.

## Nginx

Use [sitecfg-nginx.conf](sitecfg-nginx.conf) as the starting point. Keep the included `Host`,
`X-Forwarded-For`, and `X-Forwarded-Proto` forwarding on both `/api/` and `/ws/`.

Verify unknown hosts are rejected:

```bash
curl -k --resolve unexpected.example:443:ORIGIN_IP https://unexpected.example/
```

The request must not reach the faucet virtual host.

## Connection limits

Check the file-descriptor limit with `ulimit -n`, then size it for the proxy user and faucet process.
Each active WebSocket consumes a descriptor. Apache's default `mpm_prefork` limit is too low for a
busy faucet; use `mpm_event` or nginx.
