// Regression tests for the four above-threshold findings from the Pashov
// solidity-auditor pass (see sharedsub-pashov-ai-audit-report-*.md):
//   F1  exit() bond lock            — auto-excluded member must recover their bond
//   F2  post-exit disputes          — an exited member must NOT be able to dispute
//   F3  bond drain before ruling    — reclaimOwnerBond must block while a dispute is open
//   F4  slash on zero pending       — a member-win with pending==0 must NOT slash the bond
// Each test first pins the intended post-fix behaviour, and F3/F4 also demonstrate the
// pre-fix attack is now blocked. In-process ganache + ethers v6.
const fs = require("fs");
const path = require("path");
const ganache = require("ganache");
const { ethers } = require("ethers");

const artifacts = JSON.parse(fs.readFileSync(path.join(__dirname, "out", "artifacts.json"), "utf8"));

let passed = 0, failed = 0;
const ok = (c, m) => (c ? (passed++, console.log("  ✓ " + m)) : (failed++, console.log("  ✗ " + m)));
const eq = (a, b, m) => ok(BigInt(a) === BigInt(b), `${m} (got ${a}, want ${b})`);
async function throws(fn, m) {
  try { await fn(); ok(false, m + " (expected revert)"); } catch { ok(true, m); }
}

const P = {
  seatPrice: 100000n, cycleDuration: 100n, seatCount: 3n,
  ownerBondRequired: 50000n, memberBondRequired: 5000n, proofValidity: 1000n,
  reminderWindow: 10n, slashAmount: 100000n,
  subscriptionRef: ethers.zeroPadValue("0x01", 32), metadata: "Spotify Family - EU",
};

async function latestDisputeId(pool, who) {
  const evs = await pool.queryFilter(pool.filters.DisputeRaised(who));
  return evs.length ? evs[evs.length - 1].args.disputeId : null;
}

async function main() {
  const server = ganache.provider({
    logging: { quiet: true }, miner: { defaultGasPrice: 0, timestampIncrement: 0 },
    wallet: { totalAccounts: 6, defaultBalance: 1000 },
  });
  const provider = new ethers.BrowserProvider(server);
  const accts = await provider.send("eth_accounts", []);
  const owner = await provider.getSigner(accts[0]);
  const alice = await provider.getSigner(accts[1]);
  const ownerAddr = accts[0], aliceAddr = accts[1];

  const deploy = async (name, signer, args = []) => {
    const f = new ethers.ContractFactory(artifacts[name].abi, artifacts[name].bytecode, signer);
    const c = await f.deploy(...args); await c.waitForDeployment(); return c;
  };
  const inc = async (s) => { await provider.send("evm_increaseTime", [Number(s)]); await provider.send("evm_mine", []); };

  const verifier = await deploy("MockProofVerifier", owner);
  const arbitrator = await deploy("MockArbitrator", owner);
  const arbAddr = await arbitrator.getAddress();

  // Build a fresh pool; alice joins with a buffer that funds exactly `cycles` cycles.
  async function freshPool(bufferCycles = 1n) {
    const token = await deploy("MockERC20", owner);
    const factory = await deploy("SubscriptionPoolFactory", owner, [await verifier.getAddress(), arbAddr]);
    const params = [
      await token.getAddress(), P.seatPrice, P.cycleDuration, P.seatCount,
      P.ownerBondRequired, P.memberBondRequired, P.proofValidity,
      P.reminderWindow, P.slashAmount, P.subscriptionRef, P.metadata,
    ];
    await (await factory.connect(owner).createPool(params)).wait();
    const poolAddr = await factory.allPools(0);
    const pool = new ethers.Contract(poolAddr, artifacts["SubscriptionPool"].abi, owner);
    for (const [s, a] of [[owner, ownerAddr], [alice, aliceAddr]]) {
      await (await token.mint(a, 10_000_000n)).wait();
      await (await token.connect(s).approve(poolAddr, ethers.MaxUint256)).wait();
    }
    await (await pool.connect(owner).fundOwnerBond()).wait();
    await (await pool.connect(alice).join(P.seatPrice * bufferCycles)).wait();
    return { token, pool, poolAddr };
  }

  // ------------------------------------------------------------------
  console.log("\n== F1: auto-excluded member can still reclaim their bond ==");
  {
    const { token, pool } = await freshPool(1n); // buffer = one cycle
    const bondPosted = (await pool.members(aliceAddr)).bond;
    ok(bondPosted === P.memberBondRequired, "member bond is held by the pool");

    // Drain the buffer completely, then have anyone poke settle -> auto-exclusion.
    await inc(P.cycleDuration + 10n);
    await (await pool.connect(owner).settle(aliceAddr)).wait();
    const m = await pool.members(aliceAddr);
    ok(m.isActive === false, "member auto-excluded after buffer exhausted");
    eq(await pool.seatsTaken(), 0n, "seat freed on exclusion");
    ok(m.bond === P.memberBondRequired, "bond still locked in the pool post-exclusion");

    // Pre-fix this reverted (exit required isActive); now it must succeed and refund the bond.
    const balBefore = await token.balanceOf(aliceAddr);
    await (await pool.connect(alice).exit()).wait();
    await (await pool.connect(alice).withdraw()).wait();
    eq((await token.balanceOf(aliceAddr)) - balBefore, P.memberBondRequired, "excluded member recovered their bond");
  }

  // ------------------------------------------------------------------
  console.log("\n== F2: an exited member cannot open a dispute ==");
  {
    const { pool } = await freshPool(2n); // 2 cycles of buffer
    await inc(40n); // stream some -> pending accrues for the owner
    await (await pool.connect(alice).exit()).wait(); // voluntary exit, pending left for owner
    const m = await pool.members(aliceAddr);
    ok(m.isActive === false, "member inactive after exit");
    ok(m.pending > 0n, "owner-owed pending remains after exit");

    // Pre-fix raiseDispute gated on `joined` (still true) and would let the ex-member
    // freeze + claw back the owner's pending. Now it must revert (NotMember).
    await throws(() => pool.connect(alice).raiseDispute.staticCall("0x"), "exited member blocked from raiseDispute");
  }

  // ------------------------------------------------------------------
  console.log("\n== F3: owner cannot drain the bond while a dispute is open ==");
  {
    const { pool } = await freshPool(1n);
    await inc(40n);
    // Alice disputes while active; this both freezes her pending and locks the owner bond.
    await (await pool.connect(alice).raiseDispute("0x")).wait();
    eq(await pool.openDisputes(), 1n, "openDisputes tracked");

    // Force alice's seat to empty so seatsTaken hits 0 (the old sole guard on reclaim):
    // stream past her buffer, then settle. (inDispute member is skipped by _settle? no —
    // _settle runs; exclusion still decrements the seat.)
    await inc(P.cycleDuration + 10n);
    await (await pool.connect(owner).settle(aliceAddr)).wait();
    eq(await pool.seatsTaken(), 0n, "no active seats");

    // Pre-fix the owner could reclaim the whole bond here and dodge the slash.
    await throws(() => pool.connect(owner).reclaimOwnerBond.staticCall(), "reclaimOwnerBond blocked while dispute open");

    // After the ruling (member wins), the slash actually lands on the still-present bond.
    const id = await latestDisputeId(pool, aliceAddr);
    const wdBefore = await pool.withdrawable(aliceAddr);
    await (await arbitrator.connect(owner).giveRuling(id, 1)).wait();
    eq(await pool.openDisputes(), 0n, "openDisputes cleared after ruling");
    const slash = P.slashAmount > P.ownerBondRequired ? P.ownerBondRequired : P.slashAmount;
    ok((await pool.withdrawable(aliceAddr)) - wdBefore >= slash, "member received the (capped) slash — bond was NOT drained first");

    // Now that the dispute is resolved and seats are empty, reclaim works for the remainder.
    await (await pool.connect(owner).reclaimOwnerBond()).wait();
    ok(true, "reclaimOwnerBond succeeds once no dispute is open");
  }

  // ------------------------------------------------------------------
  console.log("\n== F4: a member-win with zero pending does NOT slash the bond ==");
  {
    const { pool } = await freshPool(2n);
    // Alice disputes immediately: active, but nothing streamed yet -> pending == 0.
    const m0 = await pool.members(aliceAddr);
    ok(m0.pending === 0n, "no pending streamed at dispute time");
    await (await pool.connect(alice).raiseDispute("0x")).wait();

    const bondBefore = await pool.ownerBondBalance();
    const wdBefore = await pool.withdrawable(aliceAddr);
    const id = await latestDisputeId(pool, aliceAddr);
    await (await arbitrator.connect(owner).giveRuling(id, 1)).wait(); // member wins

    // Pre-fix: alice would pocket slashAmount for free. Now: no pending => no slash.
    eq(await pool.ownerBondBalance(), bondBefore, "owner bond untouched when pending was zero");
    eq((await pool.withdrawable(aliceAddr)) - wdBefore, 0n, "member got no free slash");
  }

  console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
