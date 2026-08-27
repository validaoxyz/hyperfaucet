import "mocha";
import { expect } from "chai";
import { getTrustedClientIp, normalizeIpAddress } from "../src/utils/IPAddress.js";

describe("IP address boundary", () => {
  it("canonicalizes IPv4, IPv6, and IPv4-mapped IPv6 addresses", () => {
    expect(normalizeIpAddress(" 8.8.8.8 ")).to.equal("8.8.8.8");
    expect(normalizeIpAddress("2001:0DB8:0:0:0:0:0:1")).to.equal("2001:db8::1");
    expect(normalizeIpAddress("::ffff:8.8.8.8")).to.equal("8.8.8.8");
    expect(normalizeIpAddress("0:0:0:0:0:ffff:0808:0808")).to.equal("8.8.8.8");
  });

  it("rejects malformed, ambiguous, and scoped addresses", () => {
    expect(normalizeIpAddress("001.002.003.004")).to.equal(null);
    expect(normalizeIpAddress("fe80::1%en0")).to.equal(null);
    expect(normalizeIpAddress("not-an-ip")).to.equal(null);
    expect(normalizeIpAddress(null)).to.equal(null);
  });

  it("ignores forwarded headers without configured trusted proxies", () => {
    expect(getTrustedClientIp("::ffff:8.8.8.8", "1.1.1.1", 0)).to.equal("8.8.8.8");
  });

  it("selects the client at the configured trusted-proxy depth", () => {
    expect(getTrustedClientIp(
      "10.0.0.3",
      "1.1.1.1,2.2.2.2, 10.0.0.2",
      2,
    )).to.equal("2.2.2.2");
  });

  it("fails closed for incomplete or invalid proxy chains", () => {
    expect(getTrustedClientIp("10.0.0.3", "1.1.1.1", 2)).to.equal(null);
    expect(getTrustedClientIp("10.0.0.3", "1.1.1.1, invalid", 1)).to.equal(null);
    expect(getTrustedClientIp("10.0.0.3", ["1.1.1.1", "2.2.2.2"], 1)).to.equal(null);
    expect(getTrustedClientIp("invalid", "1.1.1.1", 1)).to.equal(null);
    expect(getTrustedClientIp("10.0.0.3", "1.1.1.1", -1)).to.equal(null);
  });
});
