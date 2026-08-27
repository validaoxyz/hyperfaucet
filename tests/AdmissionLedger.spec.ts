import 'mocha';
import { expect } from 'chai';
import {
  AdmissionLedger,
  admissionSubject,
  excludeCommittedUsage,
} from '../src/session/AdmissionLedger.js';

describe("Admission Ledger", () => {
  it("gives overlapping starting reservations to the first binder and counts each session once", () => {
    let ledger = new AdmissionLedger();
    let ip = admissionSubject.ip("8.8.8.8");
    let address = admissionSubject.address("0x0000000000000000000000000000000000001337");

    ledger.begin("first", 100, 10n, [ip, address]);
    ledger.begin("second", 101, 20n, [ip, address]);

    let firstUsage = ledger.getPriorUsage("first", [ip, address]);
    let secondUsage = ledger.getPriorUsage("second", [ip, address]);
    expect(firstUsage.count).to.equal(0);
    expect(secondUsage.count).to.equal(1);
    expect(secondUsage.amount).to.equal(10n);
    expect(Array.from(secondUsage.sessionIds)).to.deep.equal(["first"]);
  });

  it("holds claim ceilings until release and removes historical overlap", () => {
    let ledger = new AdmissionLedger();
    let principal = admissionSubject.principal("github", "1337");

    ledger.begin("first", 100, 10n, [principal]);
    ledger.reserveClaimCeiling("first", 30n);
    ledger.begin("second", 101, 20n, [principal]);
    expect(ledger.getPriorUsage("second", [principal]).provisionalAmountSessionIds.has("first")).to.equal(true);
    ledger.setClaimCeiling("first", 30n);
    ledger.markCommitting("first");

    let usage = ledger.getPriorUsage("second", [principal]);
    expect(usage.amount).to.equal(30n);
    expect(excludeCommittedUsage(usage, ["first"])).to.deep.equal({
      count: 0,
      amount: 0n,
      hasProvisionalAmount: false,
    });

    ledger.release("first");
    expect(ledger.getPriorUsage("second", [principal]).count).to.equal(0);
  });

  it("keeps the old subject during a move and swaps it only after commit", () => {
    let ledger = new AdmissionLedger();
    let oldIp = admissionSubject.ip("8.8.8.8");
    let newIp = admissionSubject.ip("8.8.4.4");

    ledger.begin("moving", 100, 10n, [oldIp], true);
    ledger.markRunning("moving");
    let move = ledger.prepareMove("moving", oldIp, newIp);

    ledger.begin("old-before-commit", 101, 10n, [oldIp]);
    expect(ledger.getPriorUsage("old-before-commit", [oldIp]).sessionIds.has("moving")).to.equal(true);

    ledger.abortMove(move);
    ledger.begin("new-after-abort", 102, 10n, [newIp]);
    expect(ledger.getPriorUsage("new-after-abort", [newIp]).sessionIds.has("moving")).to.equal(false);

    move = ledger.prepareMove("moving", oldIp, newIp);
    ledger.commitMove(move);
    ledger.begin("old-after-commit", 103, 10n, [oldIp]);
    expect(ledger.getPriorUsage("old-after-commit", [oldIp]).sessionIds.has("moving")).to.equal(false);
    ledger.begin("new-after-commit", 104, 10n, [newIp]);
    expect(ledger.getPriorUsage("new-after-commit", [newIp]).sessionIds.has("moving")).to.equal(true);
  });
});
