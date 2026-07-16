// Validates the EXACT dispute path the frontend uses:
//   member.raiseDispute("0x")  →  discover disputeId from DisputeRaised events
//   (chain.js latestDisputeId)  →  arbitrator.giveRuling(id, ruling)  →  withdraw()
// Runs in-process ganache + ethers v6. Covers member-win (slash) and host-win.
const fs = require("fs");
const path = require("path");
const ganache = require("ganache");
const { ethers } = require("ethers");

const artifacts = JSON.parse(fs.readFileSync(path.join(__dirname, "out", "artifacts.json"), "utf8"));

let passed = 0, failed = 0;
const ok = (c, m) => (c ? (passed++, console.log("  ✓ " + m)) : (failed++, console.log("  ✗ " + m)));
const eq = (a, b, m) => ok(BigInt(a) === BigInt(b), `${m} (got ${a}, want ${b})`);

const P = {
  seatPrice: 100000n, cycleDuration: 100n, seatCount: 3n,
  ownerBondRequired: 50000n, memberBondRequired: 5000n, proofValidity: 1000n,
  reminderWindow: 10n, slashAmount: 100000n,
  subscriptionRef: ethers.zeroPadValue("0x01", 32), metadata: "Spotify Family - EU",
};

// mirrors chain.js latestDisputeId(): read the pool's DisputeRaised(member) events.
async function latestDisputeId(pool, who) {
  const evs = await pool.queryFilter(pool.filters.DisputeRaised(who));
  return evs.length ? evs[evs.length - 1].args.disputeId : null;
}

async function main() {
  const server = ganache.provider({
    logging: { quiet: true }, miner: { defaultGasPrice: 0 },
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

  async function freshActivePoolWithAliceStreaming() {
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
    await (await pool.connect(alice).join(P.seatPrice)).wait();
    await inc(40n); // 40s streamed → pending 40000
    return { token, pool, poolAddr };
  }

  console.log("\n== Dispute A: member wins (refund pending + slash owner bond) ==");
  {
    const { token, pool } = await freshActivePoolWithAliceStreaming();
    const bondBefore = await pool.ownerBondBalance();

    // member raises dispute (frontend: pool.raiseDispute("0x"))
    await (await pool.connect(alice).raiseDispute("0x")).wait();
    const m1 = await pool.members(aliceAddr);
    ok(m1.inDispute === true, "member flagged inDispute after raiseDispute");
    ok(m1.pending > 0n, "pending frozen (settled at dispute time)");
    const frozen = m1.pending;

    // owner cannot claim while frozen
    try { await pool.connect(owner).ownerClaim.staticCall(aliceAddr); ok(false, "ownerClaim blocked during dispute"); }
    catch { ok(true, "ownerClaim blocked during dispute"); }

    // slash is capped at the available owner bond (contract: slash = min(slashAmount, bond))
    const slash = P.slashAmount > bondBefore ? bondBefore : P.slashAmount;

    // discover id the way the UI does, then jury rules for member (1)
    const id = await latestDisputeId(pool, aliceAddr);
    ok(id !== null, `disputeId discovered from events (${id})`);
    const aliceWdBefore = await pool.withdrawable(aliceAddr);
    await (await arbitrator.connect(owner).giveRuling(id, 1)).wait();

    const m2 = await pool.members(aliceAddr);
    ok(m2.inDispute === false, "inDispute cleared after ruling");
    eq(m2.pending, 0n, "pending zeroed");
    const aliceWdAfter = await pool.withdrawable(aliceAddr);
    eq(aliceWdAfter - aliceWdBefore, frozen + slash, "member refunded pending + (capped) slash");
    eq(await pool.ownerBondBalance(), bondBefore - slash, "owner bond slashed by capped amount");

    // member withdraws (frontend: pool.withdraw())
    const balBefore = await token.balanceOf(aliceAddr);
    await (await pool.connect(alice).withdraw()).wait();
    eq((await token.balanceOf(aliceAddr)) - balBefore, frozen + slash, "member withdrew payout");
  }

  console.log("\n== Dispute B: host wins (streamed funds released to owner) ==");
  {
    const { token, pool } = await freshActivePoolWithAliceStreaming();
    await (await pool.connect(alice).raiseDispute("0x")).wait();
    const frozen = (await pool.members(aliceAddr)).pending;
    const bondBefore = await pool.ownerBondBalance();

    const id = await latestDisputeId(pool, aliceAddr);
    const ownerWdBefore = await pool.withdrawable(ownerAddr);
    await (await arbitrator.connect(owner).giveRuling(id, 2)).wait();

    eq(await pool.ownerBondBalance(), bondBefore, "owner bond untouched on host win");
    eq((await pool.withdrawable(ownerAddr)) - ownerWdBefore, frozen, "streamed funds released to owner");
    const balBefore = await token.balanceOf(ownerAddr);
    await (await pool.connect(owner).withdraw()).wait();
    eq((await token.balanceOf(ownerAddr)) - balBefore, frozen, "owner withdrew released funds");
  }

  console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
