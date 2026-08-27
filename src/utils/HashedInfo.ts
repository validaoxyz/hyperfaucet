import * as crypto from "crypto";
import { normalizeIpAddress } from "./IPAddress.js";

export function getHashedIp(remoteAddr: string, pseudonymKey: string): string {
  let normalizedRemoteAddr = normalizeIpAddress(remoteAddr);
  if(!normalizedRemoteAddr)
    throw new Error("Cannot pseudonymize an invalid IP address");
  remoteAddr = normalizedRemoteAddr;

  let ipMatch: RegExpExecArray;
  let hashParts: string[] = [];
  let hashGlue: string;
  let getHash = (input: string, len?: number) => {
    let hash = crypto.createHash("sha256");
    hash.update(pseudonymKey + "\r\n");
    hash.update("iphash\r\n");
    hash.update(input);
    let hashStr = hash.digest("hex");
    if(len)
      hashStr = hashStr.substring(0, len);
    return hashStr;
  };

  let hashBase = "";
  if((ipMatch = /^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$/.exec(remoteAddr))) {
    // IPv4
    hashGlue = ".";

    for(let i = 0; i < 4; i++) {
      hashParts.push(getHash(hashBase + ipMatch[i+1], 3));
      hashBase += (hashBase ? "." : "") + ipMatch[i+1];
    }
  }
  else {
    // IPv6
    hashGlue = ":";

    let [left, right = ""] = remoteAddr.split("::");
    let leftParts = left ? left.split(":") : [];
    let rightParts = right ? right.split(":") : [];
    let ipParts = remoteAddr.includes("::")
      ? [...leftParts, ...Array(8 - leftParts.length - rightParts.length).fill("0"), ...rightParts]
      : leftParts;
    for(let i = 0; i < 8; i++) {
      let part = Number.parseInt(ipParts[i], 16).toString(16);
      hashParts.push(part === "0" ? "0" : getHash(hashBase + part, 3));
      hashBase += (hashBase ? "." : "") + part;
    }
  }

  return hashParts.join(hashGlue);
}

export function getHashedSessionId(sessionId: string, pseudonymKey: string): string {
  let sessionIdHash = crypto.createHash("sha256");
  sessionIdHash.update(pseudonymKey + "\r\n");
  sessionIdHash.update(sessionId);
  return sessionIdHash.digest("hex").substring(0, 20);
}
