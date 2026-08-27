import "mocha";
import sinon from "sinon";
import { expect } from "chai";
import { FaucetError, PublicFaucetError } from "../src/common/FaucetError.js";
import { FaucetProcess } from "../src/common/FaucetProcess.js";
import { ServiceManager } from "../src/common/ServiceManager.js";
import {
  getPublicClaimError,
  PUBLIC_CLAIM_FAILED_MESSAGE,
  PUBLIC_CLAIM_REVERTED_MESSAGE,
  PUBLIC_INTERNAL_ERROR_MESSAGE,
  toClientFailure,
  toStoredClientFailure,
} from "../src/webserv/PublicErrors.js";

describe("Public error projection", () => {
  const address = "0x0000000000000000000000000000000000001337";
  let logSpy: sinon.SinonSpy;

  beforeEach(() => {
    const faucetProcess = ServiceManager.GetService(FaucetProcess);
    faucetProcess.hideLogOutput = true;
    logSpy = sinon.spy(faucetProcess, "emitLog");
  });

  afterEach(async () => {
    sinon.restore();
    await ServiceManager.DisposeService(FaucetProcess);
  });

  function expectInternalFailure(failure: ReturnType<typeof toClientFailure>): void {
    expect(failure).deep.equal({
      failedCode: "INTERNAL_ERROR",
      failedReason: PUBLIC_INTERNAL_ERROR_MESSAGE,
    });
  }

  it("uses fixed messages for ordinary known faucet errors", () => {
    const cases = [
      ["BALANCE_ERROR", "Could not get wallet balance."],
      ["CONTRACT_LIMIT", "Could not check contract status of wallet."],
      ["FAUCET_UNAVAILABLE", "The faucet is temporarily unavailable. Please try again shortly."],
      ["INVALID_ENSNAME", "Could not resolve ENS Name."],
      ["INVALID_IPINFO", "Error while checking your IP."],
      ["MAINNET_BALANCE_CHECK", "Could not get balance of mainnet wallet."],
      ["MAINNET_TXCOUNT_CHECK", "Could not get tx-count of mainnet wallet."],
      ["SLASHED", "invalid PoW verification result"],
    ] as const;

    for(const [code, fallback] of cases) {
      const error = new FaucetError(code, `private marker for ${code}`);
      error.data = { secret: `private data for ${code}` };
      expect(toClientFailure(error, "during test", true)).deep.equal({
        failedCode: code,
        failedReason: fallback,
      });
    }
    expect(logSpy.callCount).equal(0, "expected faucet failures were logged as unexpected");
  });

  it("does not publish ordinary error data for a data-bearing code", () => {
    const error = new FaucetError("STAKE_REQUIRED", "private stake detail");
    error.data = { address, secret: "private marker" };

    expect(toClientFailure(error, "during test", true)).deep.equal({
      failedCode: "STAKE_REQUIRED",
      failedReason: "Your wallet does not meet the minimum staked HYPE requirement.",
    });
  });

  it("preserves every approved text-only dynamic error", () => {
    const dynamicCases = [
      ["AUTHENTICATOOR_CONCURRENCY_LIMIT", "Concurrent session limit reached for this authenticated user."],
      ["AUTHENTICATOOR_LIMIT", "Authenticated-user faucet limit reached."],
      ["BALANCE_LIMIT", "This wallet exceeds the faucet balance limit."],
      ["CONCURRENCY_LIMIT", "Concurrent session limit reached."],
      ["FAUCET_EMPTY", "The faucet is empty. Wait for it to be refilled and try again"],
      ["FAUCET_DISABLED", "The faucet is currently not allowing new sessions."],
      ["GITHUB_CHECK", "Your github account does not meet the minimum requirements."],
      ["GITHUB_LIMIT", "GitHub account faucet limit reached."],
      ["MAINNET_BALANCE_LIMIT", "This wallet does not meet the mainnet balance requirement."],
      ["MAINNET_TXCOUNT_LIMIT", "This wallet does not meet the mainnet transaction-count requirement."],
      ["RECURRING_LIMIT", "Faucet request limit reached."],
      ["ZUPASS_CONCURRENCY_LIMIT", "Concurrent session limit reached for this ticket holder."],
      ["ZUPASS_LIMIT", "Ticket-holder faucet limit reached."],
    ] as const;

    for(const [code, fallback] of dynamicCases) {
      const dynamicMessage = `Approved detail for ${code}.`;
      expect(toClientFailure(
        new FaucetError(code, dynamicMessage),
        "during test",
      )).deep.equal({
        failedCode: code,
        failedReason: fallback,
      });
      expect(toClientFailure(new PublicFaucetError({
        code,
        message: dynamicMessage,
      }), "during test")).deep.equal({
        failedCode: code,
        failedReason: dynamicMessage,
      });
    }
  });

  it("copies approved address DTOs field by field", () => {
    for(const code of ["STAKE_REQUIRED", "PASSPORT_SCORE"] as const) {
      const data = { address, secret: "private marker" };
      const error = new PublicFaucetError({
        code,
        message: `approved ${code} text`,
        data,
      });
      expect(toClientFailure(error, "during test", true)).deep.equal({
        failedCode: code,
        failedReason: `approved ${code} text`,
        failedData: { address },
      });
    }
  });

  it("copies the approved IP restriction DTO field by field", () => {
    const data = {
      address,
      ipflags: [true, false] as [boolean, boolean],
      secret: "private marker",
    };
    const error = new PublicFaucetError({
      code: "IPINFO_RESTRICTION",
      message: "IP blocked by the hosting policy.",
      data,
    });

    expect(toClientFailure(error, "during test", true)).deep.equal({
      failedCode: "IPINFO_RESTRICTION",
      failedReason: "IP blocked by the hosting policy.",
      failedData: {
        address,
        ipflags: [true, false],
      },
    });
  });

  it("omits valid public data where the caller does not allow it", () => {
    const error = new PublicFaucetError({
      code: "STAKE_REQUIRED",
      message: "The wallet needs more staked HYPE.",
      data: { address },
    });

    expect(toClientFailure(error, "during test")).deep.equal({
      failedCode: "STAKE_REQUIRED",
      failedReason: "The wallet needs more staked HYPE.",
    });
  });

  it("fails closed on malformed public data", () => {
    const malformedSpecs = [
      {
        code: "STAKE_REQUIRED",
        message: "approved text",
        data: { address: "0x0000000000000000000000000000000000000000" },
      },
      {
        code: "PASSPORT_SCORE",
        message: "approved text",
        data: { address: "not-an-address" },
      },
      {
        code: "IPINFO_RESTRICTION",
        message: "approved text",
        data: { address, ipflags: [true, "false"] },
      },
    ];

    for(const spec of malformedSpecs) {
      expectInternalFailure(toClientFailure(
        new PublicFaucetError(spec as any),
        "during test",
        true,
      ));
    }
    expect(logSpy.callCount).equal(malformedSpecs.length, "malformed public errors were not logged");
  });

  it("fails closed on malformed public messages and disallowed codes", () => {
    const malformedErrors = [
      new PublicFaucetError({ code: "CONCURRENCY_LIMIT", message: "line one\nprivate line" }),
      new PublicFaucetError({ code: "CONCURRENCY_LIMIT", message: "x".repeat(513) }),
      new PublicFaucetError({ code: "BALANCE_ERROR", message: "private marker" } as any),
    ];

    for(const error of malformedErrors)
      expectInternalFailure(toClientFailure(error, "during test"));
    expect(logSpy.callCount).equal(malformedErrors.length, "malformed public errors were not logged");
  });

  it("rewrites private and unknown error classes", () => {
    const privateErrors = [
      new FaucetError("INTERNAL_ERROR", "private internal marker"),
      new FaucetError("INVALID_STATE", "private state marker"),
      new FaucetError("UNKNOWN_CODE", "private unknown marker"),
      new Error("private native marker"),
      "private non-error marker",
    ];

    for(const error of privateErrors)
      expectInternalFailure(toClientFailure(error, "during test"));
    expect(logSpy.callCount).equal(privateErrors.length, "private errors were not logged");
  });

  it("uses fixed fallbacks for stored failures and rewrites unknown codes", () => {
    expect(toStoredClientFailure("SESSION_TIMEOUT")).deep.equal({
      failedCode: "SESSION_TIMEOUT",
      failedReason: "Session timed out",
    });
    expect(toStoredClientFailure("UNKNOWN_STORED_CODE")).deep.equal({
      failedCode: "INTERNAL_ERROR",
      failedReason: PUBLIC_INTERNAL_ERROR_MESSAGE,
    });
    expect(toStoredClientFailure(null)).deep.equal({
      failedCode: "INTERNAL_ERROR",
      failedReason: PUBLIC_INTERNAL_ERROR_MESSAGE,
    });
  });

  it("maps only fixed public claim states", () => {
    expect(getPublicClaimError("failed")).equal(PUBLIC_CLAIM_FAILED_MESSAGE);
    expect(getPublicClaimError("reverted")).equal(PUBLIC_CLAIM_REVERTED_MESSAGE);
    expect(getPublicClaimError("private RPC marker")).equal(undefined);
  });
});
