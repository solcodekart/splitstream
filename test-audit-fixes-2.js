// Regression tests for the second batch of audit fixes (below-threshold findings):
//   F6  rate truncation      — streaming charges the exact seatPrice*elapsed/cycle,
//                              not a floored per-second rate (owner no longer under-collects)
//   F5  repeated-dispute drain— the owner bond is slashed at most ONCE per member,
//                              so a member can't re-dispute and drain the whole bond
//   F9  dirty re-join        — re-join is blocked while inDispute or with pending
//                              outstanding, and clears the stale lastProof
//   lead disputeToMember     — the id->member mapping is deleted after a ruling
// In-process ganache + ethers v6.
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

const subscriptionRef = ethers.zeroPadValue("0x01", 32);

async function main() {
  const server = ganache.provider({
    // timestampIncrement:0 -> only evm_increaseTime advances the clock; blocks
    // share a timestamp so streamed/refund math is exact and drift-free (no flakes).
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

  // Build a pool with arbitrary economics so a test can, e.g., make slashAmount < bond.
  async function freshPool({
    seatPrice = 10000n, cycleDuration = 3000n, seatCount = 3n,
    ownerBond = 50000n, memberBond = 5000n, proofValidity = 100000n,
    reminderWindow = 10n, slashAmount = 100000n, bufferCycles = 1n,
  } = {}) {
    const token = await deploy("MockERC20", owner);
    const factory = await deploy("SubscriptionPoolFactory", owner, [await verifier.getAddress(), arbAddr]);
    const params = [
      await token.getAddress(), seatPrice, cycleDuration, seatCount,
      ownerBond, memberBond, proofValidity, reminderWindow, slashAmount,
      subscriptionRef, "Test Pool",
    ];
    await (await factory.connect(owner).createPool(params)).wait();
    const poolAddr = await factory.allPools(0);
    const pool = new ethers.Contract(poolAddr, artifacts["SubscriptionPool"].abi, owner);
    for (const [s, a] of [[owner, ownerAddr], [alice, aliceAddr]]) {
      await (await token.mint(a, 100_000_000n)).wait();
      await (await token.connect(s).approve(poolAddr, ethers.MaxUint256)).wait();
    }
    await (await pool.connect(owner).fundOwnerBond()).wait();
    await (await pool.connect(alice).join(seatPrice * bufferCycles)).wait();
    return { token, pool, poolAddr, seatPrice, cycleDuration };
  }

  // Pull the disputeId straight out of the raiseDispute tx receipt's DisputeRaised
  // log — robust when a member disputes more than once in the same pool.
  function disputeIdFromReceipt(pool, receipt) {
    for (const log of receipt.logs) {
      try {
        const parsed = pool.interface.parseLog(log);
        if (parsed && parsed.name === "DisputeRaised") return parsed.args.disputeId;
      } catch { /* not our event */ }
    }
    return null;
  }

  // ------------------------------------------------------------------
  console.log("\n== F6: streaming charges the exact rate, not a floored per-second rate ==");
  {
    // seatPrice=10000 over cycleDuration=3000 => true rate 3.333.../s.
    // Old code used ratePerSecond = floor(10000/3000) = 3, under-collecting ~10%.
    const { pool, seatPrice, cycleDuration } = await freshPool({ bufferCycles: 1n });
    const flooredRate = seatPrice / cycleDuration; // = 3, what the buggy code used
    // Capture the join timestamp; ganache advances the clock by a second or two
    // between the time-jump and the settle tx, so we derive the exact expected
    // amount from the real elapsed span rather than assuming exactly 1500s.
    const tJoin = (await pool.members(aliceAddr)).lastSettled;
    await inc(1500n); // ~half a cycle
    await (await pool.connect(owner).settle(aliceAddr)).wait();
    const m = await pool.members(aliceAddr);
    const elapsed = m.lastSettled - tJoin;
    const expected = (seatPrice * elapsed) / cycleDuration; // full-precision rate
    eq(m.pending, expected, "streams exactly seatPrice*elapsed/cycleDuration (full precision)");
    ok(m.pending > flooredRate * elapsed, "collects more than the old floored-rate result (no under-collection)");
    ok(m.pending >= seatPrice / 2n, "roughly half the seat price for a ~half cycle");
  }

  // ------------------------------------------------------------------
  console.log("\n== F5: the owner bond is slashed at most once per member ==");
  {
    // slashAmount(10000) < ownerBond(50000) so a second slash would be visible if it happened.
    const { pool } = await freshPool({
      seatPrice: 100000n, cycleDuration: 100n, ownerBond: 50000n,
      slashAmount: 10000n, proofValidity: 100000n, bufferCycles: 3n,
    });
    await inc(40n);
    let rc = await (await pool.connect(alice).raiseDispute("0x")).wait();
    let id = disputeIdFromReceipt(pool, rc);
    await (await arbitrator.connect(owner).giveRuling(id, 1)).wait(); // member wins #1
    const bondAfterFirst = await pool.ownerBondBalance();
    eq(bondAfterFirst, 40000n, "first member-win slashes exactly one slashAmount (50000-10000)");
    ok((await pool.members(aliceAddr)).slashed === true, "member flagged as already-slashed");
    ok((await pool.members(aliceAddr)).isActive === true, "member keeps the seat after a win");

    // Second dispute + win: pending is refunded again, but the bond must NOT be slashed twice.
    await inc(40n);
    rc = await (await pool.connect(alice).raiseDispute("0x")).wait();
    id = disputeIdFromReceipt(pool, rc);
    const wdBefore = await pool.withdrawable(aliceAddr);
    await (await arbitrator.connect(owner).giveRuling(id, 1)).wait(); // member wins #2
    eq(await pool.ownerBondBalance(), bondAfterFirst, "second member-win does NOT slash the bond again");
    ok((await pool.withdrawable(aliceAddr)) - wdBefore > 0n, "member still gets their streamed funds refunded on win #2");
  }

  // ------------------------------------------------------------------
  console.log("\n== lead: disputeToMember is cleared after a ruling ==");
  {
    const { pool } = await freshPool({ seatPrice: 100000n, cycleDuration: 100n, bufferCycles: 2n });
    await inc(40n);
    const rc = await (await pool.connect(alice).raiseDispute("0x")).wait();
    const id = disputeIdFromReceipt(pool, rc);
    ok((await pool.disputeToMember(id)).toLowerCase() === aliceAddr.toLowerCase(), "mapping set while dispute open");
    await (await arbitrator.connect(owner).giveRuling(id, 2)).wait();
    ok((await pool.disputeToMember(id)) === ethers.ZeroAddress, "mapping deleted after ruling (no replay)");
  }

  // ------------------------------------------------------------------
  console.log("\n== F9: re-join is blocked while pending is outstanding, then allowed clean ==");
  {
    const { pool, token, poolAddr } = await freshPool({ seatPrice: 100000n, cycleDuration: 100n, bufferCycles: 2n });
    await inc(40n);
    await (await pool.connect(alice).exit()).wait(); // voluntary exit leaves pending for owner
    const m = await pool.members(aliceAddr);
    ok(m.pending > 0n, "owner-owed pending remains after exit");

    // Re-join must be blocked until that pending is resolved (no mixed accounting).
    await throws(() => pool.connect(alice).join.staticCall(100000n), "re-join blocked while pending outstanding");

    // Owner proves access and claims -> pending cleared.
    await (await verifier.connect(owner).setAccepts(aliceAddr, true)).wait();
    await (await pool.connect(owner).submitAccessProof(aliceAddr, "0x")).wait();
    await (await pool.connect(owner).ownerClaim(aliceAddr)).wait();
    eq((await pool.members(aliceAddr)).pending, 0n, "pending cleared after owner claim");

    // Now a clean re-join succeeds and the stale proof is wiped.
    // Explicit gasLimit: this re-join clears m.lastProof (a storage-refund SSTORE),
    // and in-process ganache's eth_estimateGas intermittently returns a limit that's
    // a hair too low for the refund case, causing a spurious OOG revert. The call
    // itself is valid (staticCall always passes); pinning the gas skips the flaky
    // estimate. Not needed on-chain — real nodes estimate this correctly.
    await (await pool.connect(alice).join(100000n, { gasLimit: 500000n })).wait();
    const m2 = await pool.members(aliceAddr);
    ok(m2.isActive === true, "clean re-join succeeds");
    eq(m2.lastProof, 0n, "stale lastProof reset on re-join");
  }

  // ------------------------------------------------------------------
  console.log("\n== F9: re-join is blocked while still frozen in a dispute ==");
  {
    const { pool } = await freshPool({ seatPrice: 100000n, cycleDuration: 100n, slashAmount: 10000n, bufferCycles: 1n });
    await inc(40n);
    await (await pool.connect(alice).raiseDispute("0x")).wait(); // inDispute = true, still active
    // Drain the (1-cycle) buffer and settle -> auto-excluded while inDispute stays true.
    await inc(100n);
    await (await pool.connect(owner).settle(aliceAddr)).wait();
    const m = await pool.members(aliceAddr);
    ok(m.isActive === false && m.inDispute === true, "auto-excluded but still frozen in dispute");
    await throws(() => pool.connect(alice).join.staticCall(100000n), "re-join blocked while inDispute");
  }

  console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
