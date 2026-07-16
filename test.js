// End-to-end tests for the SubscriptionPool prototype.
// Uses an in-process ganache EVM + ethers v6. No external network needed.
const fs = require("fs");
const path = require("path");
const ganache = require("ganache");
const { ethers } = require("ethers");

const artifacts = JSON.parse(
  fs.readFileSync(path.join(__dirname, "out", "artifacts.json"), "utf8")
);

// ---- tiny test harness ----
let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log("  ✓ " + msg); }
  else { failed++; console.log("  ✗ " + msg); }
}
function eq(a, b, msg) { ok(BigInt(a) === BigInt(b), `${msg} (got ${a}, want ${b})`); }
async function throws(fn, msg) {
  try { await fn(); ok(false, msg + " (expected revert, but succeeded)"); }
  catch (e) { ok(true, msg); }
}

// ---- pool params (small numbers for exact math) ----
const P = {
  seatPrice: 100000n,        // per cycle
  cycleDuration: 100n,       // seconds
  // ratePerSecond = 1000 wei/s
  seatCount: 3n,
  ownerBondRequired: 50000n,
  memberBondRequired: 5000n,
  proofValidity: 1000n,      // proof must be < 1000s old to claim
  reminderWindow: 10n,       // remind when <=10s runway
  slashAmount: 100000n,
  subscriptionRef: ethers.zeroPadValue("0x01", 32),
  metadata: "Spotify Family - EU",
};

async function main() {
  const server = ganache.provider({
    logging: { quiet: true },
    // timestampIncrement:0 -> blocks share a timestamp unless evm_increaseTime is
    // called, so elapsed time (and thus streamed/refund amounts) is exact & drift-free.
    miner: { defaultGasPrice: 0, timestampIncrement: 0 },
    wallet: { totalAccounts: 6, defaultBalance: 1000 },
  });
  const provider = new ethers.BrowserProvider(server);
  const accts = await provider.send("eth_accounts", []);
  const owner = await provider.getSigner(accts[0]);
  const alice = await provider.getSigner(accts[1]);
  const bob = await provider.getSigner(accts[2]);
  const keeper = await provider.getSigner(accts[3]);

  const ownerAddr = accts[0], aliceAddr = accts[1], bobAddr = accts[2];

  async function deploy(name, signer, args = []) {
    const f = new ethers.ContractFactory(artifacts[name].abi, artifacts[name].bytecode, signer);
    const c = await f.deploy(...args);
    await c.waitForDeployment();
    return c;
  }
  async function inc(seconds) {
    await provider.send("evm_increaseTime", [Number(seconds)]);
    await provider.send("evm_mine", []);
  }

  // shared infra
  const verifier = await deploy("MockProofVerifier", owner);
  const arbitrator = await deploy("MockArbitrator", owner);

  // helper: fresh token + pool, owner activated, members funded/approved
  async function freshPool() {
    const token = await deploy("MockERC20", owner);
    const factory = await deploy("SubscriptionPoolFactory", owner, [
      await verifier.getAddress(), await arbitrator.getAddress(),
    ]);
    const params = [
      await token.getAddress(), P.seatPrice, P.cycleDuration, P.seatCount,
      P.ownerBondRequired, P.memberBondRequired, P.proofValidity,
      P.reminderWindow, P.slashAmount, P.subscriptionRef, P.metadata,
    ];
    const tx = await factory.connect(owner).createPool(params);
    await tx.wait();
    const poolAddr = await factory.allPools(0);
    const pool = new ethers.Contract(poolAddr, artifacts["SubscriptionPool"].abi, owner);

    // fund everyone
    for (const [signer, addr] of [[owner, ownerAddr], [alice, aliceAddr], [bob, bobAddr]]) {
      await (await token.mint(addr, 10_000_000n)).wait();
      await (await token.connect(signer).approve(poolAddr, ethers.MaxUint256)).wait();
    }
    return { token, pool, poolAddr };
  }

  console.log("\n== Scenario 1: activation & join ==");
  {
    const { token, pool, poolAddr } = await freshPool();
    await throws(() => pool.connect(alice).join.staticCall(P.seatPrice), "cannot join before pool active");
    await (await pool.connect(owner).fundOwnerBond()).wait();
    eq(await pool.ownerBondBalance(), P.ownerBondRequired, "owner bond recorded");
    const balBefore = await token.balanceOf(aliceAddr);
    await (await pool.connect(alice).join(P.seatPrice)).wait();
    eq(await pool.seatsTaken(), 1n, "seat taken");
    eq(balBefore - (await token.balanceOf(aliceAddr)), P.seatPrice + P.memberBondRequired, "alice paid buffer+bond");
    await throws(() => pool.connect(alice).join.staticCall(P.seatPrice), "cannot double-join");
    await throws(() => pool.connect(bob).join.staticCall(P.seatPrice - 1n), "buffer below one cycle rejected");
  }

  console.log("\n== Scenario 2: streaming accounting ==");
  {
    const { pool } = await freshPool();
    await (await pool.connect(owner).fundOwnerBond()).wait();
    await (await pool.connect(alice).join(P.seatPrice)).wait(); // buffer=100000
    await inc(30n);
    await (await pool.connect(keeper).settle(aliceAddr)).wait(); // permissionless poke
    const m = await pool.members(aliceAddr);
    eq(m.pending, 30000n, "30s streamed to pending");
    eq(m.buffer, 70000n, "buffer reduced");
  }

  console.log("\n== Scenario 3: reminder fires near end of runway ==");
  {
    const { pool } = await freshPool();
    await (await pool.connect(owner).fundOwnerBond()).wait();
    await (await pool.connect(alice).join(P.seatPrice)).wait();
    ok(!(await pool.reminderDue(aliceAddr)), "no reminder right after join");
    await inc(91n); // runway ~9s <=10 window
    ok(await pool.reminderDue(aliceAddr), "reminder due near end of runway");
  }

  console.log("\n== Scenario 4: auto-exclusion when buffer drained ==");
  {
    const { pool } = await freshPool();
    await (await pool.connect(owner).fundOwnerBond()).wait();
    await (await pool.connect(alice).join(P.seatPrice)).wait();
    await inc(150n); // > one cycle
    await (await pool.connect(keeper).settle(aliceAddr)).wait();
    const m = await pool.members(aliceAddr);
    ok(!m.isActive, "member excluded after buffer drained");
    eq(m.buffer, 0n, "buffer zero");
    eq(m.pending, P.seatPrice, "full cycle streamed, capped at buffer");
    eq(await pool.seatsTaken(), 0n, "seat freed");
  }

  console.log("\n== Scenario 5: owner claim is gated on a fresh proof ==");
  {
    const { token, pool } = await freshPool();
    await (await pool.connect(owner).fundOwnerBond()).wait();
    await (await pool.connect(alice).join(P.seatPrice)).wait();
    await inc(40n);
    await throws(() => pool.connect(owner).ownerClaim.staticCall(aliceAddr), "claim blocked without proof");
    await (await verifier.setAccepts(aliceAddr, true)).wait();
    await (await pool.submitAccessProof(aliceAddr, "0x")).wait();
    const ownerBal = await token.balanceOf(ownerAddr);
    await (await pool.connect(owner).ownerClaim(aliceAddr)).wait();
    const gained = (await token.balanceOf(ownerAddr)) - ownerBal;
    ok(gained >= 40000n, "owner received >= 40s of stream after proving delivery");
    const m = await pool.members(aliceAddr);
    eq(m.pending, 0n, "pending cleared after claim");
    await (await verifier.setAccepts(aliceAddr, false)).wait();
  }

  console.log("\n== Scenario 6: top-up extends runway ==");
  {
    const { pool } = await freshPool();
    await (await pool.connect(owner).fundOwnerBond()).wait();
    await (await pool.connect(alice).join(P.seatPrice)).wait();
    await inc(95n);
    const before = await pool.runwaySeconds(aliceAddr);
    await (await pool.connect(alice).topUp(100000n)).wait();
    const after = await pool.runwaySeconds(aliceAddr);
    ok(after > before + 90n, "runway extended by ~100s after top-up");
    ok(!(await pool.reminderDue(aliceAddr)), "reminder cleared after top-up");
  }

  console.log("\n== Scenario 7: dispute resolved for the member (slash owner) ==");
  {
    const { token, pool } = await freshPool();
    await (await pool.connect(owner).fundOwnerBond()).wait();
    await (await pool.connect(alice).join(P.seatPrice)).wait();
    await inc(40n);
    const did7 = await arbitrator.nextDisputeId(); // id this dispute will get
    await (await pool.connect(alice).raiseDispute("0x")).wait(); // pending ~40000 frozen
    const dm = await pool.members(aliceAddr);
    ok(dm.inDispute, "member marked in dispute");
    await throws(() => pool.connect(owner).ownerClaim.staticCall(aliceAddr), "owner cannot claim during dispute");
    const bondBefore = await pool.ownerBondBalance();
    await (await arbitrator.giveRuling(did7, 1)).wait(); // ruling 1 = member wins
    const bondAfter = await pool.ownerBondBalance();
    ok(bondAfter < bondBefore, "owner bond slashed on member win");
    const w = await pool.withdrawable(aliceAddr);
    ok(w >= 40000n + (bondBefore - bondAfter), "member credited refund + slash");
    const balBefore = await token.balanceOf(aliceAddr);
    await (await pool.connect(alice).withdraw()).wait();
    ok((await token.balanceOf(aliceAddr)) > balBefore, "member withdrew successfully");
  }

  console.log("\n== Scenario 8: dispute resolved for the owner ==");
  {
    const { pool } = await freshPool();
    await (await pool.connect(owner).fundOwnerBond()).wait();
    await (await pool.connect(alice).join(P.seatPrice)).wait();
    await inc(40n);
    const did8 = await arbitrator.nextDisputeId();
    await (await pool.connect(alice).raiseDispute("0x")).wait();
    await (await arbitrator.giveRuling(did8, 2)).wait(); // ruling 2 = owner wins
    const w = await pool.withdrawable(ownerAddr);
    ok(w >= 40000n, "owner credited streamed funds on win");
    const m = await pool.members(aliceAddr);
    ok(!m.inDispute, "dispute cleared");
  }

  console.log("\n== Scenario 9: voluntary exit refunds buffer + bond ==");
  {
    const { token, pool } = await freshPool();
    await (await pool.connect(owner).fundOwnerBond()).wait();
    await (await pool.connect(alice).join(P.seatPrice)).wait();
    await inc(20n);
    await (await pool.connect(alice).exit()).wait();
    eq(await pool.seatsTaken(), 0n, "seat freed on exit");
    const credit = await pool.withdrawable(aliceAddr);
    // buffer after 20s = 80000, + bond 5000 = 85000
    eq(credit, 85000n, "refund = remaining buffer + bond");
    const balBefore = await token.balanceOf(aliceAddr);
    await (await pool.connect(alice).withdraw()).wait();
    eq((await token.balanceOf(aliceAddr)) - balBefore, 85000n, "withdraw pays out refund");
  }

  console.log(`\n==== RESULTS: ${passed} passed, ${failed} failed ====`);
  await server.disconnect?.();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
