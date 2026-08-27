import "mocha";
import { expect } from "chai";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function readConfig(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), "utf8");
}

function firstBlock(config: string, start: string, end: string): string {
  const startIndex = config.indexOf(start);
  expect(startIndex, `${start} block`).to.be.at.least(0);
  const endIndex = config.indexOf(end, startIndex + start.length);
  expect(endIndex, `${start} terminator`).to.be.at.least(0);
  return config.slice(startIndex, endIndex + end.length);
}

function blockContaining(config: string, start: string, end: string, marker: string): string {
  const markerIndex = config.indexOf(marker);
  expect(markerIndex, `${marker} marker`).to.be.at.least(0);
  const startIndex = config.lastIndexOf(start, markerIndex);
  expect(startIndex, `${marker} block`).to.be.at.least(0);
  const endIndex = config.indexOf(end, markerIndex + marker.length);
  expect(endIndex, `${marker} terminator`).to.be.at.least(0);
  return config.slice(startIndex, endIndex + end.length);
}

function expectNginxCallbackHeaders(config: string): void {
  expect(config).to.include('default "$http_x_forwarded_proto, $scheme";');
  expect(config).to.include("proxy_set_header Host $http_host;");
  expect(config).to.include("proxy_set_header X-Forwarded-Proto $faucet_forwarded_proto;");
  expect(config).to.not.include("proxy_hide_header Content-Security-Policy;");
}

describe("reverse-proxy examples", () => {
  it("preserves callback headers through the container nginx proxy", () => {
    const config = readConfig("docker/nginx.conf");
    expectNginxCallbackHeaders(config);
  });

  it("keeps documented nginx HTTP redirect-only and preserves callback headers", () => {
    const config = readConfig("docs/sitecfg-nginx.conf");
    const defaultHttpServer = firstBlock(config, "server {", "\n}");
    const defaultTlsServer = blockContaining(config, "server {", "\n}", "listen 443 ssl default_server;");
    const httpServer = blockContaining(
      config,
      "server {",
      "\n}",
      "server_name holesky-faucet.pk910.de www.holesky-faucet.pk910.de;",
    );
    expect(defaultHttpServer).to.include("listen 80 default_server;");
    expect(defaultHttpServer).to.include("return 444;");
    expect(defaultTlsServer).to.include("ssl_reject_handshake on;");
    expect(httpServer).to.include("listen 80;");
    expect(httpServer).to.include("return 301 https://holesky-faucet.pk910.de$request_uri;");
    expect(httpServer).to.not.include("proxy_pass");
    expect(httpServer).to.not.include("root ");
    expectNginxCallbackHeaders(config);
  });

  it("keeps documented Apache HTTP redirect-only and preserves callback headers", () => {
    const config = readConfig("docs/sitecfg-apache2.conf");
    const defaultHttpVirtualHost = firstBlock(config, "<VirtualHost *:80>", "</VirtualHost>");
    const defaultTlsVirtualHost = firstBlock(config, "<VirtualHost *:443>", "</VirtualHost>");
    const httpVirtualHost = blockContaining(
      config,
      "<VirtualHost *:80>",
      "</VirtualHost>",
      "ServerName kiln-faucet.pk910.de",
    );
    expect(defaultHttpVirtualHost).to.include("ServerName invalid.example");
    expect(defaultHttpVirtualHost).to.include("Redirect 404 /");
    expect(defaultTlsVirtualHost).to.include("Require all denied");
    expect(httpVirtualHost).to.include("Redirect permanent / https://kiln-faucet.pk910.de/");
    expect(httpVirtualHost).to.not.include("DocumentRoot");
    expect(httpVirtualHost).to.include("RewriteRule ^ - [R=421,L]");
    expect(config).to.include("Header always setifempty Content-Security-Policy");
    expect(config).to.not.include("<IfModule");
    expect(config).to.include("ProxyPreserveHost On");
    expect(config).to.include('RequestHeader append X-Forwarded-Proto "https"');
  });
});
