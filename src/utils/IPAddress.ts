import { isIP } from "node:net";

function mappedIpv4Address(ipv6Address: string): string | null {
  if(!ipv6Address.startsWith("::ffff:"))
    return null;

  let groups = ipv6Address.substring(7).split(":");
  if(groups.length !== 2)
    return null;

  let high = Number.parseInt(groups[0], 16);
  let low = Number.parseInt(groups[1], 16);
  if(!Number.isInteger(high) || !Number.isInteger(low) || high > 0xffff || low > 0xffff)
    return null;

  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
}

export function normalizeIpAddress(value: unknown): string | null {
  if(typeof value !== "string")
    return null;

  let address = value.trim();
  let addressFamily = isIP(address);
  if(addressFamily === 4)
    return address;
  if(addressFamily !== 6 || address.includes("%"))
    return null;

  try {
    let hostname = new URL(`http://[${address}]/`).hostname;
    let canonicalAddress = hostname.substring(1, hostname.length - 1);
    return mappedIpv4Address(canonicalAddress) || canonicalAddress;
  } catch {
    return null;
  }
}

export function getTrustedClientIp(
  socketAddress: unknown,
  forwardedFor: string | string[] | undefined,
  trustedProxyCount: number,
): string | null {
  let canonicalSocketAddress = normalizeIpAddress(socketAddress);
  if(!canonicalSocketAddress)
    return null;
  if(trustedProxyCount === 0)
    return canonicalSocketAddress;
  if(!Number.isSafeInteger(trustedProxyCount) || trustedProxyCount < 0 || typeof forwardedFor !== "string")
    return null;

  let proxyChain = forwardedFor.split(",").map(normalizeIpAddress);
  if(proxyChain.length < trustedProxyCount || proxyChain.some((address) => !address))
    return null;
  return proxyChain[proxyChain.length - trustedProxyCount];
}
