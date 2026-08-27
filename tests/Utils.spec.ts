import 'mocha';
import sinon from 'sinon';
import { expect } from 'chai';
import { renderDate, renderTimespan } from '../src/utils/DateUtils.js';
import { timeoutPromise } from '../src/utils/PromiseUtils.js';
import { getHashedIp } from '../src/utils/HashedInfo.js';
import { isVersionLower } from '../src/utils/VersionCompare.js';
import { strFormatPlaceholder } from '../src/utils/StringUtils.js';


describe("Utility Functions", () => {

  it("PromiseUtils.timeoutPromise", async () => {
    let now = new Date().getTime();
    let err = false;
    try {
      await timeoutPromise<void>(new Promise<void>((resolve, reject) => {
        setTimeout(() => resolve(), 1000);
      }), 100);
    } catch(e) {
      err = true;
    }

    expect(new Date().getTime() - now).to.be.lessThan(200, "unexpected result");
    expect(err).to.equal(true, "no timeout error thrown")
  });

  it("DateUtils.renderTimespan", async () => {
    expect(renderTimespan(130, 2)).to.equal("2min 10sec", "unexpected result");
    expect(renderTimespan(439964, 5)).to.equal("5d 2h 12min 44sec", "unexpected result");
    expect(renderTimespan(439964, 2)).to.equal("5d 2h", "unexpected result");
  });

  it("DateUtils.renderDate", async () => {
    expect(renderDate(new Date(1970, 2, 3, 5, 11, 12), true)).to.equal("1970-03-03 05:11", "unexpected result 1");
    expect(renderDate(new Date(1970, 2, 3, 5, 11, 12), false)).to.equal("1970-03-03", "unexpected result 2");
    expect(renderDate(new Date(1970, 2, 3, 5, 11, 12), true, true)).to.equal("1970-03-03 05:11:12", "unexpected result 3");
  });

  it("HashedInfo.getHashedIp", async () => {
    expect(getHashedIp("1.2.3.4", "test")).to.equal("df6.60b.ef9.b3e", "unexpected result");
    let compressed = getHashedIp("2001:db8::1", "test");
    expect(compressed).to.equal(getHashedIp("2001:0db8:0:0:0:0:0:1", "test"), "equivalent IPv6 spellings have different pseudonyms");
    expect(compressed).not.to.equal(getHashedIp("2001:db8::2", "test"), "distinct IPv6 suffixes collide");
    expect(getHashedIp("2003:DE:C711::ECFF:FE0E:21F1", "test")).to.equal(
      getHashedIp("2003:de:c711:0:0:ecff:fe0e:21f1", "test"),
      "IPv6 hex case changes the pseudonym",
    );
  });

  it("VersionCompare.isVersionLower", async () => {
    expect(isVersionLower(null as any, "1.2")).to.equal(null, "unexpected result 1")
    expect(isVersionLower("1.2.3", "1.2.4")).to.equal(true, "unexpected result 2")
    expect(isVersionLower("1.2", "1.2.4")).to.equal(true, "unexpected result 3")
    expect(isVersionLower("1.2.3", "1.2")).to.equal(false, "unexpected result 4")
    expect(isVersionLower("1.2.3", "1.2.3")).to.equal(undefined, "unexpected result 5")
  });

  it("StringUtils.strFormatPlaceholder", async () => {
    expect(strFormatPlaceholder("1: {1}, 2: {2}", "A")).to.equal("1: A, 2: {2}", "unexpected result 1")
  });
  
});
