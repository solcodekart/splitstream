// Regression tests for the solvency bugs the invariant fuzzer (test-invariant.js)
// found in the re-join accounting path:
//   G1  orphaned bond on re-join  — an auto-excluded member who never exited still
//       has m.bond posted; a re-join must charge only the shortfall, not overwrite
//       m.bond (which would orphan the prior bond and double-charge the member).
//   G2  orphaned buffer via topUp-after-exclude — topUp checks isActive at entry,
//       then _settle can exhaust the buffer and auto-exclude the member; crediting
//       the top-up anyway leaves an INACTIVE member holding buffer, which a later
//       join() overwrites -> tokens orphaned -> solvency (conservation) broken.
// Both are asserted via the master solvency invariant:
//   token.balanceOf(pool) == ownerBondBalance + Σ(buffer+bond+pending) + Σ withdrawable
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

const P = {
  seatPrice: 100000n, cycleDuration: 100n, seatCount: 3n,
  ownerBondRequired: 50000n, memberBondRequired: 5000n, proofValidity: 1000n,
  reminderWindow: 10n, slashAmount: 30000n,
  subscriptionRef: ethers.zeroPadValue("0x01", 32), metadata: "Spotify Family - EU",
};

async function main() {
  const server = ganache.provider({
    logging: { quiet: true }, miner: { defaultGasPrice: 0, instamine: "eager", timestampIncrement: 0 },
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

  async function freshPool() {
    const token = await deploy("MockERC20", owner);
    const factory = await deploy("SubscriptionPoolFactory", owner, [await verifier.getAddress(), await arbitrator.getAddress()]);
    const params = [
      await token.getAddress(), P.seatPrice, P.cycleDuration, P.seatCount,
      P.ownerBondRequired, P.memberBondRequired, P.proofValidity,
      P.reminderWindow, P.slashAmount, P.subscriptionRef, P.metadata,
    ];
    await (await factory.connect(owner).createPool(params)).wait();
    const poolAddr = await factory.allPools(0);
    const pool = new ethers.Contract(poolAddr, artifacts["SubscriptionPool"].abi, owner);
    for (const [s, a] of [[owner, ownerAddr], [alice, aliceAddr]]) {
      await (await token.mint(a, 1_000_000_000n)).wait();
      await (await token.connect(s).approve(poolAddr, ethers.MaxUint256)).wait();
    }
    await (await pool.connect(owner).fundOwnerBond()).wait();
    return { token, pool, poolAddr };
  }

  // Re-derive the full ledger and assert conservation (the invariant the fuzzer checks).
  async function assertSolvent(token, pool, poolAddr, tag) {
    let claims = await pool.ownerBondBalance();
    for (const a of [aliceAddr, ownerAddr]) claims += await pool.withdrawable(a);
    const m = await pool.members(aliceAddr);
    claims += m.buffer + m.bond + m.pending;
    const bal = await token.balanceOf(poolAddr);
    eq(bal, claims, `solvency holds ${tag}`);
  }

  console.log("\n== G2: topUp cannot strand buffer on a member excluded mid-settle ==");
  {
    const { token, pool, poolAddr } = await freshPool();
    // buffer funds exactly one cycle (100000 / 100000 * 100s = 100s of runway)
    await (await pool.connect(alice).join(P.seatPrice)).wait();
    // Enter a dispute so the seat stays "held" but time keeps streaming.
    await inc(40n);
    await (await pool.connect(alice).raiseDispute("0x")).wait();
    ok((await pool.members(aliceAddr)).isActive, "member active before the fatal top-up");

    // Jump PAST the remaining runway, then top up: _settle inside topUp exhausts the
    // buffer and auto-excludes the member. Pre-fix, topUp still credited `amount`,
    // leaving an inactive member with buffer > 0. Post-fix it must revert.
    await inc(P.cycleDuration + 50n);
    await throws(() => pool.connect(alice).topUp.staticCall(12345n), "topUp reverts once _settle excludes the member");

    // Realize the exclusion and confirm no buffer was stranded.
    await (await pool.connect(owner).settle(aliceAddr)).wait();
    const m = await pool.members(aliceAddr);
    ok(!m.isActive, "member auto-excluded after buffer drained");
    eq(m.buffer, 0n, "no buffer stranded on the excluded member");
    await assertSolvent(token, pool, poolAddr, "after exclude");
  }

  console.log("\n== G1: re-join after exclusion charges only the bond shortfall ==");
  {
    const { token, pool, poolAddr } = await freshPool();
    await (await pool.connect(alice).join(P.seatPrice)).wait();
    // Drain buffer -> auto-exclude; bond stays posted (exit was never called).
    await inc(P.cycleDuration + 10n);
    await (await pool.connect(owner).settle(aliceAddr)).wait();
    ok(!(await pool.members(aliceAddr)).isActive, "excluded, bond still posted");
    eq((await pool.members(aliceAddr)).bond, P.memberBondRequired, "bond retained after exclusion");
    // Owner has fresh pending owed; clear it so re-join isn't blocked by PendingOutstanding.
    await (await verifier.setAccepts(aliceAddr, true)).wait();
    await (await pool.submitAccessProof(aliceAddr, "0x")).wait();
    await (await pool.connect(owner).ownerClaim(aliceAddr)).wait();

    const paidBefore = await token.balanceOf(aliceAddr);
    await (await pool.connect(alice).join(P.seatPrice)).wait(); // re-join
    const paid = paidBefore - (await token.balanceOf(aliceAddr));
    // Should pay only the new buffer (bond already posted -> shortfall 0), NOT buffer+bond.
    eq(paid, P.seatPrice, "re-join charges buffer only, reuses posted bond");
    eq((await pool.members(aliceAddr)).bond, P.memberBondRequired, "bond still exactly one bond, not doubled");
    await assertSolvent(token, pool, poolAddr, "after re-join");
  }

  console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
  await server.disconnect?.();
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
