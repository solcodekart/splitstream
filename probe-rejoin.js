// Probe: hammer the F9 "clean re-join" handoff to catch the intermittent revert
// and surface the *real* reason (staticCall) + token state at the failure point.
const fs = require("fs");
const path = require("path");
const ganache = require("ganache");
const { ethers } = require("ethers");

const artifacts = JSON.parse(fs.readFileSync(path.join(__dirname, "out", "artifacts.json"), "utf8"));
const subscriptionRef = ethers.zeroPadValue("0x01", 32);

async function once(iter) {
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
  const token = await deploy("MockERC20", owner);
  const factory = await deploy("SubscriptionPoolFactory", owner, [await verifier.getAddress(), await arbitrator.getAddress()]);

  const seatPrice = 100000n;
  const params = [await token.getAddress(), seatPrice, 100n, 3n, 50000n, 5000n, 100000n, 10n, 100000n, subscriptionRef, "Test Pool"];
  await (await factory.connect(owner).createPool(params)).wait();
  const poolAddr = await factory.allPools(0);
  const pool = new ethers.Contract(poolAddr, artifacts["SubscriptionPool"].abi, owner);
  for (const [s, a] of [[owner, ownerAddr], [alice, aliceAddr]]) {
    await (await token.mint(a, 100_000_000n)).wait();
    await (await token.connect(s).approve(poolAddr, ethers.MaxUint256)).wait();
  }
  await (await pool.connect(owner).fundOwnerBond()).wait();
  await (await pool.connect(alice).join(seatPrice * 2n)).wait();

  await inc(40n);
  await (await pool.connect(alice).exit()).wait();
  await throwsIgnore(() => pool.connect(alice).join.staticCall(100000n));
  await (await verifier.connect(owner).setAccepts(aliceAddr, true)).wait();
  await (await pool.connect(owner).submitAccessProof(aliceAddr, "0x")).wait();
  await (await pool.connect(owner).ownerClaim(aliceAddr)).wait();

  // The flaky send:
  try {
    await (await pool.connect(alice).join(100000n)).wait();
    return true;
  } catch (e) {
    console.log(`\n=== FAIL iter ${iter} ===`);
    // Surface the real reason via staticCall on current state.
    const m = await pool.members(aliceAddr);
    console.log("member:", {
      buffer: m.buffer.toString(), pending: m.pending.toString(), bond: m.bond.toString(),
      isActive: m.isActive, joined: m.joined, inDispute: m.inDispute,
    });
    console.log("seatsTaken:", (await pool.seatsTaken()).toString(), "active:", await pool.active());
    console.log("alice bal:", (await token.balanceOf(aliceAddr)).toString(),
                "allowance:", (await token.allowance(aliceAddr, poolAddr)).toString());
    try {
      await pool.connect(alice).join.staticCall(100000n);
      console.log("staticCall SUCCEEDED on retry (=> transient/ordering, not logic)");
    } catch (se) {
      console.log("staticCall reason:", se.shortMessage || se.message);
    }
    // Try a plain retry send:
    try {
      await (await pool.connect(alice).join(100000n)).wait();
      console.log("plain retry send SUCCEEDED");
    } catch (re) {
      console.log("plain retry send FAILED:", re.shortMessage || re.message);
    }
    // Try with an explicit generous gasLimit (bypasses eth_estimateGas):
    try {
      const r = await (await pool.connect(alice).join(100000n, { gasLimit: 500000n })).wait();
      console.log("explicit-gasLimit send SUCCEEDED, gasUsed:", r.gasUsed.toString());
    } catch (ge) {
      console.log("explicit-gasLimit send FAILED:", ge.shortMessage || ge.message);
    }
    return false;
  }
}
async function throwsIgnore(fn) { try { await fn(); } catch {} }

(async () => {
  let pass = 0, fail = 0;
  const N = Number(process.argv[2] || 30);
  for (let i = 1; i <= N; i++) {
    if (await once(i)) pass++; else fail++;
  }
  console.log(`\nprobe done: ${pass} pass, ${fail} fail of ${N}`);
  process.exit(0);
})();
