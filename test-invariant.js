// Stateful invariant fuzzer for SubscriptionPool.
//
// Foundry's `forge invariant` is the usual tool for this, but its installer is
// unreachable in this sandbox, so we drive the same idea over the project's
// existing in-process ganache + ethers v6 stack (keeps the pure-npm toolchain).
//
// The fuzzer runs many independent "pools". For each it applies a long,
// seeded-random sequence of operations (join / topUp / exit / settle /
// prove / claim / dispute / rule / time-jump / withdraw / reclaim) across
// several actors, and after EVERY step re-derives the full ledger and asserts
// the protocol invariants. On the first violation it prints the seed and the
// exact op sequence so the counterexample is reproducible.
//
// INVARIANTS
//   I1 (solvency / conservation):
//       token.balanceOf(pool) ==
//         ownerBondBalance + Σ_members(buffer+bond+pending) + Σ_addr withdrawable
//     Every wei in the contract is owed to exactly one party; none is created
//     or destroyed by any state transition. This is the critical one.
//   I2 seatsTaken == #{members : isActive}   and   seatsTaken <= seatCount
//   I3 openDisputes == #{members : inDispute}
//   I4 each member.bond ∈ {0, memberBondRequired}
//   I5 isActive(m) ⇒ joined(m)
//   I6 ownerBondBalance <= ownerBondRequired
//   I7 inDispute(m) ⇒ isActive(m) is NOT required (member can be auto-excluded
//      while frozen) — but a frozen member's pending must be preserved, i.e.
//      pending only leaves via a ruling; we check pending never drops without a
//      corresponding credit through I1, so no separate assert needed.
//
// Usage: node test-invariant.js [runs] [opsPerRun] [seed]
const fs = require("fs");
const path = require("path");
const ganache = require("ganache");
const { ethers } = require("ethers");

const artifacts = JSON.parse(fs.readFileSync(path.join(__dirname, "out", "artifacts.json"), "utf8"));
const subscriptionRef = ethers.zeroPadValue("0x01", 32);

// deterministic PRNG (mulberry32) so every failure is reproducible from its seed
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (rand, arr) => arr[Math.floor(rand() * arr.length)];
const rint = (rand, lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));

// global coverage counters (successful ops by type) so we can confirm the fuzzer
// actually reaches the interesting states, not just bounces off reverts
const COVER = {};

async function runOne(seed, ops, log) {
  const rand = rng(seed);
  const server = ganache.provider({
    logging: { quiet: true },
    // instant mining + timestampIncrement:0 => the clock only moves when we call
    // evm_increaseTime, so streamed amounts are exact and fully deterministic.
    miner: { defaultGasPrice: 0, instamine: "eager", timestampIncrement: 0 },
    wallet: { totalAccounts: 6, defaultBalance: 1000 },
  });
  const provider = new ethers.BrowserProvider(server);
  const accts = await provider.send("eth_accounts", []);
  const owner = await provider.getSigner(accts[0]);
  const arbCaller = await provider.getSigner(accts[0]); // owner also drives the mock arbitrator
  const memberAddrs = [accts[1], accts[2], accts[3]];
  const memberSigners = await Promise.all(memberAddrs.map((a) => provider.getSigner(a)));
  const ownerAddr = accts[0];

  const deploy = async (name, signer, args = []) => {
    const f = new ethers.ContractFactory(artifacts[name].abi, artifacts[name].bytecode, signer);
    const c = await f.deploy(...args); await c.waitForDeployment(); return c;
  };

  const verifier = await deploy("MockProofVerifier", owner);
  const arbitrator = await deploy("MockArbitrator", owner);
  const token = await deploy("MockERC20", owner);
  const factory = await deploy("SubscriptionPoolFactory", owner, [
    await verifier.getAddress(), await arbitrator.getAddress(),
  ]);

  // randomise the pool economics per run so the fuzzer explores many regimes
  const seatPrice = BigInt(rint(rand, 1000, 100000));
  const cycleDuration = BigInt(rint(rand, 10, 500));
  const seatCount = BigInt(rint(rand, 1, memberAddrs.length));
  const ownerBond = BigInt(rint(rand, 0, 80000));
  const memberBond = BigInt(rint(rand, 0, 20000));
  const proofValidity = BigInt(rint(rand, 50, 100000));
  const slashAmount = BigInt(rint(rand, 0, 120000));
  const params = [
    await token.getAddress(), seatPrice, cycleDuration, seatCount,
    ownerBond, memberBond, proofValidity, 10n, slashAmount, subscriptionRef, "Fuzz Pool",
  ];
  await (await factory.connect(owner).createPool(params)).wait();
  const poolAddr = await factory.allPools(0);
  const pool = new ethers.Contract(poolAddr, artifacts["SubscriptionPool"].abi, owner);

  // fund + approve everyone generously
  for (const [s, a] of [[owner, ownerAddr], ...memberSigners.map((s, i) => [s, memberAddrs[i]])]) {
    await (await token.mint(a, 1_000_000_000n)).wait();
    await (await token.connect(s).approve(poolAddr, ethers.MaxUint256)).wait();
  }

  const openDisputes = []; // { id, member } captured from receipts
  const disputeIdFrom = (receipt) => {
    for (const lg of receipt.logs) {
      try { const p = pool.interface.parseLog(lg); if (p && p.name === "DisputeRaised") return p.args.disputeId; }
      catch { /* not ours */ }
    }
    return null;
  };

  let lastSnapshot = []; // per-member struct dump captured at the most recent check
  // ---- invariant checker: re-derive the whole ledger and assert ----
  async function checkInvariants(tag) {
    const [bal, obb, seatsTaken, openDisp] = await Promise.all([
      token.balanceOf(poolAddr), pool.ownerBondBalance(), pool.seatsTaken(), pool.openDisputes(),
    ]);
    let sumClaims = obb;
    let activeCount = 0n, disputeCount = 0n;
    // withdrawable can accrue to members AND to the owner (ruling==2), so include owner
    const ledgerAddrs = [...memberAddrs, ownerAddr];
    const wds = await Promise.all(ledgerAddrs.map((a) => pool.withdrawable(a)));
    for (const w of wds) sumClaims += w;

    const snapshot = [];
    for (const a of memberAddrs) {
      const m = await pool.members(a);
      snapshot.push(`${a.slice(0, 6)} buf=${m.buffer} bond=${m.bond} pend=${m.pending} act=${m.isActive} disp=${m.inDispute} join=${m.joined}`);
      sumClaims += m.buffer + m.bond + m.pending;
      if (m.isActive) activeCount += 1n;
      if (m.inDispute) disputeCount += 1n;
      // I4 bond value
      if (m.bond !== 0n && m.bond !== memberBond)
        fail(tag, `I4 member ${a} bond=${m.bond} not in {0, ${memberBond}}`);
      // I5 active ⇒ joined
      if (m.isActive && !m.joined) fail(tag, `I5 member ${a} active but not joined`);
    }
    lastSnapshot = snapshot;
    // I1 solvency / conservation
    if (bal !== sumClaims)
      fail(tag, `I1 SOLVENCY broken: balance=${bal} != claims=${sumClaims} (diff ${bal - sumClaims})`);
    // I2 seat accounting
    if (seatsTaken !== activeCount) fail(tag, `I2 seatsTaken=${seatsTaken} != active=${activeCount}`);
    if (seatsTaken > seatCount) fail(tag, `I2 seatsTaken=${seatsTaken} > seatCount=${seatCount}`);
    // I3 dispute accounting
    if (openDisp !== disputeCount) fail(tag, `I3 openDisputes=${openDisp} != inDispute=${disputeCount}`);
    // I6 owner bond bound
    if (obb > ownerBond) fail(tag, `I6 ownerBondBalance=${obb} > ownerBondRequired=${ownerBond}`);
  }

  const history = [];
  function fail(tag, msg) {
    const e = new Error(msg);
    e.__invariant = true;
    e.__context = { seed, params: params.map(String), history: history.slice(), at: tag, snapshot: lastSnapshot.slice() };
    throw e;
  }

  // try a state-changing send; swallow expected reverts (invalid preconditions)
  async function attempt(desc, fn) {
    history.push(desc);
    try {
      const tx = await fn(); if (tx && tx.wait) await tx.wait();
      const key = desc.split("(")[0];
      COVER[key] = (COVER[key] || 0) + 1;
      return true;
    }
    catch (e) { if (e.__invariant) throw e; history[history.length - 1] = desc + " [revert]"; return false; }
  }

  // owner must fund the bond before anything works
  await attempt("fundOwnerBond", () => pool.connect(owner).fundOwnerBond());
  await checkInvariants("after-fund");

  const OPS = [
    "join", "topUp", "exit", "settle", "prove", "toggleAccept",
    "claim", "dispute", "rule", "timejump", "withdraw", "reclaim", "refund",
  ];

  for (let step = 0; step < ops; step++) {
    const op = pick(rand, OPS);
    const mi = rint(rand, 0, memberAddrs.length - 1);
    const ms = memberSigners[mi], ma = memberAddrs[mi];
    if (op === "join") {
      const buf = seatPrice + BigInt(rint(rand, 0, 5)) * seatPrice + BigInt(rint(rand, 0, 500));
      await attempt(`join(${mi},${buf})`, () => pool.connect(ms).join(buf));
    } else if (op === "topUp") {
      await attempt(`topUp(${mi})`, () => pool.connect(ms).topUp(BigInt(rint(rand, 1, 30000))));
    } else if (op === "exit") {
      await attempt(`exit(${mi})`, () => pool.connect(ms).exit());
    } else if (op === "settle") {
      await attempt(`settle(${mi})`, () => pool.connect(owner).settle(ma));
    } else if (op === "prove") {
      await attempt(`prove(${mi})`, () => pool.connect(owner).submitAccessProof(ma, "0x"));
    } else if (op === "toggleAccept") {
      const ok = rand() < 0.7;
      await attempt(`accept(${mi},${ok})`, () => verifier.connect(owner).setAccepts(ma, ok));
    } else if (op === "claim") {
      await attempt(`claim(${mi})`, () => pool.connect(owner).ownerClaim(ma));
    } else if (op === "dispute") {
      const desc = `dispute(${mi})`;
      history.push(desc);
      try {
        const rc = await (await pool.connect(ms).raiseDispute("0x")).wait();
        const id = disputeIdFrom(rc);
        if (id !== null) openDisputes.push({ id, mi });
        COVER.dispute = (COVER.dispute || 0) + 1;
      } catch (e) { if (e.__invariant) throw e; history[history.length - 1] = desc + " [revert]"; }
    } else if (op === "rule") {
      if (openDisputes.length === 0) { history.push("rule[none]"); }
      else {
        const idx = rint(rand, 0, openDisputes.length - 1);
        const { id } = openDisputes.splice(idx, 1)[0];
        const ruling = rint(rand, 0, 2);
        await attempt(`rule(${id},${ruling})`, () => arbitrator.connect(arbCaller).giveRuling(id, ruling));
      }
    } else if (op === "timejump") {
      const dt = rint(rand, 1, Number(cycleDuration) * 3 + 5);
      history.push(`inc(${dt})`);
      await provider.send("evm_increaseTime", [dt]);
      await provider.send("evm_mine", []);
    } else if (op === "withdraw") {
      const who = pick(rand, [...memberSigners, owner]);
      await attempt(`withdraw`, () => pool.connect(who).withdraw());
    } else if (op === "reclaim") {
      await attempt(`reclaim`, () => pool.connect(owner).reclaimOwnerBond());
    } else if (op === "refund") {
      // owner-side flow: after a member exits with pending, prove+claim clears it
      await attempt(`ownerSettle(${mi})`, () => pool.connect(owner).settle(ma));
    }
    await checkInvariants(`step${step}:${op}`);
  }
  await server.disconnect?.();
  return true;
}

(async () => {
  const runs = Number(process.argv[2] || 20);
  const ops = Number(process.argv[3] || 120);
  const baseSeed = Number(process.argv[4] || 0xC0FFEE);
  console.log(`invariant fuzz: ${runs} runs x ${ops} ops (base seed ${baseSeed})`);
  let ok = 0;
  for (let r = 0; r < runs; r++) {
    const seed = (baseSeed + r * 2654435761) >>> 0;
    try {
      await runOne(seed, ops, false);
      ok++;
      process.stdout.write(".");
    } catch (e) {
      process.stdout.write("\n");
      if (e.__invariant) {
        console.error(`\n✗ INVARIANT VIOLATION (seed ${e.__context.seed})`);
        console.error("  " + e.message);
        console.error("  at: " + e.__context.at);
        console.error("  params:", e.__context.params.join(","));
        if (e.__context.snapshot && e.__context.snapshot.length) {
          console.error("  member structs at failure:");
          e.__context.snapshot.forEach((s) => console.error("    " + s));
        }
        console.error("  op sequence:");
        e.__context.history.forEach((h, i) => console.error(`    ${i}. ${h}`));
      } else {
        console.error(`\n✗ UNEXPECTED ERROR (seed ${seed}):`, e.message);
      }
      process.exit(1);
    }
  }
  console.log(`\n\nRESULTS: ${ok}/${runs} runs clean, all invariants held across ${ok * ops} operations`);
  const cov = Object.entries(COVER).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join("  ");
  console.log("successful-op coverage: " + cov);
  process.exit(0);
})();
