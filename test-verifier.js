// Tests for ReclaimProofVerifier — the production-shaped proof-of-access verifier.
// A local ethers Wallet plays the role of the zkTLS attestor (Reclaim witness /
// zkPass MPC node). Covers: authenticity, (member/pool/ref) binding, freshness,
// the "active" assertion, malformed blobs, and an end-to-end pool integration
// where a real signed attestation gates ownerClaim (replacing MockProofVerifier).
const fs = require("fs");
const path = require("path");
const ganache = require("ganache");
const { ethers } = require("ethers");

const artifacts = JSON.parse(fs.readFileSync(path.join(__dirname, "out", "artifacts.json"), "utf8"));

let passed = 0, failed = 0;
const ok = (c, m) => (c ? (passed++, console.log("  ✓ " + m)) : (failed++, console.log("  ✗ " + m)));
// verify() now returns (bool ok, uint256 observedAt); vok pulls out just the boolean.
const vok = async (v, ...a) => (await v.verify(...a))[0];
async function throws(fn, m) {
  try { await fn(); ok(false, m + " (expected revert)"); } catch { ok(true, m); }
}

const abi = ethers.AbiCoder.defaultAbiCoder();
const TYPEHASH = ethers.id(
  "AccessAttestation(address member,address pool,bytes32 subscriptionRef,uint256 issuedAt,bool active)"
);

// Build a proof blob exactly as the attestor would: sign the struct hash (EIP-191),
// then abi-encode {issuedAt, active, signature} — the verifier's `Attestation` struct.
async function makeProof(attestorWallet, { member, pool, ref, issuedAt, active }) {
  const structHash = ethers.keccak256(
    abi.encode(
      ["bytes32", "address", "address", "bytes32", "uint256", "bool"],
      [TYPEHASH, member, pool, ref, BigInt(issuedAt), active]
    )
  );
  const signature = await attestorWallet.signMessage(ethers.getBytes(structHash));
  return abi.encode(["tuple(uint256,bool,bytes)"], [[BigInt(issuedAt), active, signature]]);
}

const PROOF_VALIDITY = 1000n;

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

  // The attestor is an off-chain key; it never needs on-chain funds.
  const attestor = ethers.Wallet.createRandom();
  const stranger = ethers.Wallet.createRandom();

  const deploy = async (name, signer, args = []) => {
    const f = new ethers.ContractFactory(artifacts[name].abi, artifacts[name].bytecode, signer);
    const c = await f.deploy(...args); await c.waitForDeployment(); return c;
  };
  const now = async () => BigInt((await provider.getBlock("latest")).timestamp);
  const inc = async (s) => { await provider.send("evm_increaseTime", [Number(s)]); await provider.send("evm_mine", []); };

  const POOL = ethers.getAddress("0x00000000000000000000000000000000000000A1"); // dummy pool addr
  const REF = ethers.id("Spotify Family - EU");

  console.log("\n== Unit: ReclaimProofVerifier.verify ==");
  const verifier = await deploy("ReclaimProofVerifier", owner, [attestor.address, PROOF_VALIDITY]);
  {
    const t = await now();

    // happy path
    let proof = await makeProof(attestor, { member: aliceAddr, pool: POOL, ref: REF, issuedAt: t, active: true });
    ok(await vok(verifier, aliceAddr, POOL, REF, proof) === true, "valid fresh active proof verifies");

    // assertion: active = false
    proof = await makeProof(attestor, { member: aliceAddr, pool: POOL, ref: REF, issuedAt: t, active: false });
    ok(await vok(verifier, aliceAddr, POOL, REF, proof) === false, "inactive access rejected");

    // authenticity: signed by a non-attestor key
    proof = await makeProof(stranger, { member: aliceAddr, pool: POOL, ref: REF, issuedAt: t, active: true });
    ok(await vok(verifier, aliceAddr, POOL, REF, proof) === false, "wrong signer rejected");

    // freshness: stale (older than proofValidity)
    proof = await makeProof(attestor, { member: aliceAddr, pool: POOL, ref: REF, issuedAt: t - PROOF_VALIDITY - 10n, active: true });
    ok(await vok(verifier, aliceAddr, POOL, REF, proof) === false, "stale proof rejected");

    // freshness: future-dated
    proof = await makeProof(attestor, { member: aliceAddr, pool: POOL, ref: REF, issuedAt: t + 5000n, active: true });
    ok(await vok(verifier, aliceAddr, POOL, REF, proof) === false, "future-dated proof rejected");

    // binding: proof issued for alice, checked for owner (member mismatch)
    proof = await makeProof(attestor, { member: aliceAddr, pool: POOL, ref: REF, issuedAt: t, active: true });
    ok(await vok(verifier, ownerAddr, POOL, REF, proof) === false, "member-binding mismatch rejected (no cross-member replay)");

    // binding: proof issued for a different pool
    const OTHER_POOL = ethers.getAddress("0x00000000000000000000000000000000000000B2");
    proof = await makeProof(attestor, { member: aliceAddr, pool: OTHER_POOL, ref: REF, issuedAt: t, active: true });
    ok(await vok(verifier, aliceAddr, POOL, REF, proof) === false, "pool-binding mismatch rejected (no cross-pool replay)");

    // binding: proof issued for a different subscriptionRef
    proof = await makeProof(attestor, { member: aliceAddr, pool: POOL, ref: ethers.id("Netflix - US"), issuedAt: t, active: true });
    ok(await vok(verifier, aliceAddr, POOL, REF, proof) === false, "ref-binding mismatch rejected");

    // malformed blob → decode reverts
    await throws(() => vok(verifier, aliceAddr, POOL, REF, "0x1234"), "malformed proof blob reverts");
  }

  console.log("\n== Integration: Reclaim proof gates ownerClaim in a live pool ==");
  {
    const token = await deploy("MockERC20", owner);
    const arbitrator = await deploy("MockArbitrator", owner);
    // Deploy the factory wired to the REAL verifier (not the mock).
    const factory = await deploy("SubscriptionPoolFactory", owner, [
      await verifier.getAddress(), await arbitrator.getAddress(),
    ]);

    const P = {
      seatPrice: 100000n, cycleDuration: 100n, seatCount: 3n,
      ownerBondRequired: 50000n, memberBondRequired: 5000n,
      proofValidity: PROOF_VALIDITY, reminderWindow: 10n, slashAmount: 100000n,
      metadata: "Spotify Family - EU",
    };
    // subscriptionRef the pool will enforce; the attestor must sign for this exact ref.
    const ref = ethers.id(P.metadata);
    const params = [
      await token.getAddress(), P.seatPrice, P.cycleDuration, P.seatCount,
      P.ownerBondRequired, P.memberBondRequired, P.proofValidity,
      P.reminderWindow, P.slashAmount, ref, P.metadata,
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
    await inc(40n); // stream 40s -> pending

    // No proof yet: ownerClaim must fail (StaleProof).
    await throws(() => pool.connect(owner).ownerClaim.staticCall(aliceAddr), "ownerClaim blocked before any proof");

    // A stale attestation is rejected at submit time -> lastProof not stamped.
    const staleProof = await makeProof(attestor, {
      member: aliceAddr, pool: poolAddr, ref, issuedAt: (await now()) - PROOF_VALIDITY - 10n, active: true,
    });
    await throws(() => pool.connect(owner).submitAccessProof(aliceAddr, staleProof), "stale proof rejected by pool (freshness gap closed)");

    // A proof bound to the wrong pool is rejected (replay protection end to end).
    const wrongPoolProof = await makeProof(attestor, {
      member: aliceAddr, pool: ethers.getAddress("0x00000000000000000000000000000000000000C3"), ref, issuedAt: await now(), active: true,
    });
    await throws(() => pool.connect(owner).submitAccessProof(aliceAddr, wrongPoolProof), "wrong-pool proof rejected by pool");

    // A fresh, correctly-bound attestation is accepted; ownerClaim then succeeds.
    const goodProof = await makeProof(attestor, {
      member: aliceAddr, pool: poolAddr, ref, issuedAt: await now(), active: true,
    });
    await (await pool.connect(owner).submitAccessProof(aliceAddr, goodProof)).wait();
    // Materialize the streamed amount so `pending` reflects it (it otherwise only
    // accrues inside _settle, which ownerClaim runs internally).
    await (await pool.connect(owner).settle(aliceAddr)).wait();
    const pendingBefore = (await pool.members(aliceAddr)).pending;
    const balBefore = await token.balanceOf(ownerAddr);
    await (await pool.connect(owner).ownerClaim(aliceAddr)).wait();
    const claimed = (await token.balanceOf(ownerAddr)) - balBefore;
    ok(pendingBefore > 0n, "member had streamed funds pending");
    ok(claimed === pendingBefore, "owner claimed the streamed funds after a valid proof");
  }

  console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
