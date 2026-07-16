// Tests for ReclaimAdapterVerifier — the *real-Reclaim* IProofVerifier adapter.
//
// A local ethers Wallet plays the Reclaim witness: it signs the claim exactly as the
// real witness quorum does (SDK Claims.serialise + EIP-191), and a local MockReclaim
// contract (byte-for-byte the SDK's serialise/recover) stands in for the deployed
// Reclaim beacon. This lets us mint genuine witness signatures and exercise the whole
// adapter path — authenticity (verifyProof), provider⇄ref binding, member binding,
// pool binding, freshness — plus an end-to-end pool integration where a Reclaim proof
// gates ownerClaim, and a cross-check that a *different* witness key is rejected.
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
const PROOF_TYPE = [
  "tuple(" +
    "tuple(string provider,string parameters,string context) claimInfo," +
    "tuple(" +
      "tuple(bytes32 identifier,address owner,uint32 timestampS,uint32 epoch) claim," +
      "bytes[] signatures" +
    ") signedClaim" +
  ")",
];
const PROOF_VALIDITY = 1000n;

// Build a ReclaimProof exactly as the js-sdk + witness quorum would, then abi-encode it
// into the bytes blob the adapter decodes. `provider` is the zkTLS provider name (its
// keccak256 is the pool's subscriptionRef); context carries the (member,pool) binding.
async function makeReclaimProof(witness, { provider, member, pool, issuedAt, epoch = 1, context, parameters = "" }) {
  const owner = member;                                      // claim owner (unchecked by adapter)
  // Default context binds (member, pool); a test may pass its own to probe the parser.
  const ctx = context ?? `{"contextAddress":"${member.toLowerCase()}","contextMessage":"${pool.toLowerCase()}"}`;

  // identifier commits to the whole claimInfo — keccak256(provider "\n" parameters "\n" context),
  // exactly as SDK Claims.hashClaimInfo. The beacon (and our faithful MockReclaim) require it.
  const identifier = ethers.id(`${provider}\n${parameters}\n${ctx}`);

  // Serialise byte-for-byte with SDK Claims.serialise, then EIP-191 personal_sign.
  const serialised =
    identifier + "\n" +
    owner.toLowerCase() + "\n" +
    issuedAt.toString() + "\n" +
    epoch.toString();
  const signature = await witness.signMessage(serialised);

  const claimInfo = [provider, parameters, ctx];
  const claim = [identifier, owner, Number(issuedAt), epoch];
  const signedClaim = [claim, [signature]];
  return abi.encode(PROOF_TYPE, [[claimInfo, signedClaim]]);
}

// Build a proof, then tamper with the context AFTER signing (identifier still commits to the
// original) — models an attacker swapping the (member,pool) binding on a validly-signed claim.
async function makeTamperedProof(witness, opts, newContext) {
  const encoded = await makeReclaimProof(witness, opts);
  const [[ci, sc]] = abi.decode(PROOF_TYPE, encoded);
  const claimInfo = [ci[0], ci[1], newContext]; // swap context, keep signed identifier + sig
  return abi.encode(PROOF_TYPE, [[claimInfo, sc]]);
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

  const witness = ethers.Wallet.createRandom();   // the Reclaim witness key
  const rogue = ethers.Wallet.createRandom();      // a key NOT in the witness set

  const deploy = async (name, signer, args = []) => {
    const f = new ethers.ContractFactory(artifacts[name].abi, artifacts[name].bytecode, signer);
    const c = await f.deploy(...args); await c.waitForDeployment(); return c;
  };
  const now = async () => BigInt((await provider.getBlock("latest")).timestamp);
  const inc = async (s) => { await provider.send("evm_increaseTime", [Number(s)]); await provider.send("evm_mine", []); };

  const PROVIDER_NAME = "spotify-family-membership";
  const REF = ethers.id(PROVIDER_NAME);   // keccak256(bytes(provider)) == subscriptionRef
  const POOL = ethers.getAddress("0x00000000000000000000000000000000000000A1");

  console.log("\n== Unit: ReclaimAdapterVerifier.verify (real witness signatures) ==");
  const reclaim = await deploy("MockReclaim", owner, [witness.address]);
  const adapter = await deploy("ReclaimAdapterVerifier", owner, [await reclaim.getAddress(), PROOF_VALIDITY]);
  {
    const t = await now();

    let proof = await makeReclaimProof(witness, { provider: PROVIDER_NAME, member: aliceAddr, pool: POOL, issuedAt: t });
    ok(await vok(adapter, aliceAddr, POOL, REF, proof) === true, "valid fresh witness-signed proof verifies");

    // authenticity: signed by a key outside the witness set → Reclaim.verifyProof reverts → false
    proof = await makeReclaimProof(rogue, { provider: PROVIDER_NAME, member: aliceAddr, pool: POOL, issuedAt: t });
    ok(await vok(adapter, aliceAddr, POOL, REF, proof) === false, "non-witness signer rejected (authenticity)");

    // provider⇄ref binding: proof for a different provider than the pool's ref
    proof = await makeReclaimProof(witness, { provider: "google-login", member: aliceAddr, pool: POOL, issuedAt: t });
    ok(await vok(adapter, aliceAddr, POOL, REF, proof) === false, "wrong-provider proof rejected (no cheap-provider substitution)");

    // member binding: proof issued for alice, checked for owner
    proof = await makeReclaimProof(witness, { provider: PROVIDER_NAME, member: aliceAddr, pool: POOL, issuedAt: t });
    ok(await vok(adapter, ownerAddr, POOL, REF, proof) === false, "member-binding mismatch rejected (no cross-member replay)");

    // pool binding: proof issued for a different pool
    const OTHER_POOL = ethers.getAddress("0x00000000000000000000000000000000000000B2");
    proof = await makeReclaimProof(witness, { provider: PROVIDER_NAME, member: aliceAddr, pool: OTHER_POOL, issuedAt: t });
    ok(await vok(adapter, aliceAddr, POOL, REF, proof) === false, "pool-binding mismatch rejected (no cross-pool replay)");

    // freshness: stale
    proof = await makeReclaimProof(witness, { provider: PROVIDER_NAME, member: aliceAddr, pool: POOL, issuedAt: t - PROOF_VALIDITY - 10n });
    ok(await vok(adapter, aliceAddr, POOL, REF, proof) === false, "stale proof rejected");

    // freshness: future-dated
    proof = await makeReclaimProof(witness, { provider: PROVIDER_NAME, member: aliceAddr, pool: POOL, issuedAt: t + 5000n });
    ok(await vok(adapter, aliceAddr, POOL, REF, proof) === false, "future-dated proof rejected");

    // malformed blob → decode reverts → false (never bubbles up)
    ok(await vok(adapter, aliceAddr, POOL, REF, "0x1234") === false, "malformed proof blob returns false (no bubble-up)");
  }

  console.log("\n== Context tampering & adversarial parser (member/pool binding integrity) ==");
  {
    const t = await now();

    // Take a validly-signed proof for (alice, POOL) and swap the context to credit owner.
    // The identifier still commits to the ORIGINAL context, so the beacon's identifier check
    // (MockReclaim, faithful to Reclaim.sol L157-158) rejects it → verify=false. This is the
    // guarantee that makes the whole member/pool binding sound.
    let tampered = await makeTamperedProof(
      witness, { provider: PROVIDER_NAME, member: aliceAddr, pool: POOL, issuedAt: t },
      `{"contextAddress":"${ownerAddr.toLowerCase()}","contextMessage":"${POOL.toLowerCase()}"}`
    );
    ok(await vok(adapter, ownerAddr, POOL, REF, tampered) === false, "swapped-context (member) proof rejected — identifier binding holds");

    tampered = await makeTamperedProof(
      witness, { provider: PROVIDER_NAME, member: aliceAddr, pool: POOL, issuedAt: t },
      `{"contextAddress":"${aliceAddr.toLowerCase()}","contextMessage":"0x00000000000000000000000000000000000000c3"}`
    );
    ok(await vok(adapter, aliceAddr, POOL, REF, tampered) === false, "swapped-context (pool) proof rejected — identifier binding holds");

    // Adversarial context strings that ARE properly signed (attacker controls their own
    // context via addContext) but must still fail the (member,pool) check. The parser must
    // not be fooled into matching the wrong value.
    const advCases = [
      // decoy contextAddress (alice) hidden in an escaped junk value before the real key
      // (owner). The escaped `\"` breaks the target match, so the parser reads owner, not
      // the alice decoy — so a proof trying to credit alice must fail.
      {
        ctx: `{"junk":"x\\"contextAddress\\":\\"${aliceAddr.toLowerCase()}","contextAddress":"${ownerAddr.toLowerCase()}","contextMessage":"${POOL.toLowerCase()}"}`,
        member: aliceAddr, label: "escaped-decoy contextAddress not matched (parser reads real owner key)",
      },
      // contextAddress present but value is a prefix of member's address (substring collision)
      {
        ctx: `{"contextAddress":"${aliceAddr.toLowerCase().slice(0, 20)}","contextMessage":"${POOL.toLowerCase()}"}`,
        member: aliceAddr, label: "truncated address value rejected (no prefix match)",
      },
      // missing contextAddress entirely
      {
        ctx: `{"contextMessage":"${POOL.toLowerCase()}"}`,
        member: aliceAddr, label: "missing contextAddress rejected",
      },
      // empty context object
      { ctx: `{}`, member: aliceAddr, label: "empty context rejected" },
      // contextAddress with EIP-55 checksummed (mixed-case) hex won't match lowercase _toHexString
      {
        ctx: `{"contextAddress":"${ethers.getAddress(aliceAddr)}","contextMessage":"${POOL.toLowerCase()}"}`,
        member: aliceAddr, label: "checksummed (mixed-case) address rejected — must be lowercase",
      },
    ];
    for (const c of advCases) {
      const proof = await makeReclaimProof(witness, {
        provider: PROVIDER_NAME, member: aliceAddr, pool: POOL, issuedAt: t, context: c.ctx,
      });
      ok(await vok(adapter, c.member, POOL, REF, proof) === false, c.label);
    }

    // Sanity: the SAME well-formed context that the decoy tried to spoof still verifies for
    // the correct member — proving the rejections above aren't false negatives.
    const honest = await makeReclaimProof(witness, { provider: PROVIDER_NAME, member: aliceAddr, pool: POOL, issuedAt: t });
    ok(await vok(adapter, aliceAddr, POOL, REF, honest) === true, "control: honest proof still verifies (rejections aren't blanket-false)");
  }

  console.log("\n== Integration: Reclaim proof gates ownerClaim in a live pool ==");
  {
    const token = await deploy("MockERC20", owner);
    const arbitrator = await deploy("MockArbitrator", owner);
    const factory = await deploy("SubscriptionPoolFactory", owner, [
      await adapter.getAddress(), await arbitrator.getAddress(),
    ]);

    const P = {
      seatPrice: 100000n, cycleDuration: 100n, seatCount: 3n,
      ownerBondRequired: 50000n, memberBondRequired: 5000n,
      proofValidity: PROOF_VALIDITY, reminderWindow: 10n, slashAmount: 100000n,
      metadata: PROVIDER_NAME,
    };
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
    await inc(40n);

    await throws(() => pool.connect(owner).ownerClaim.staticCall(aliceAddr), "ownerClaim blocked before any proof");

    const staleProof = await makeReclaimProof(witness, { provider: PROVIDER_NAME, member: aliceAddr, pool: poolAddr, issuedAt: (await now()) - PROOF_VALIDITY - 10n });
    await throws(() => pool.connect(owner).submitAccessProof(aliceAddr, staleProof), "stale proof rejected by pool");

    const wrongPoolProof = await makeReclaimProof(witness, { provider: PROVIDER_NAME, member: aliceAddr, pool: ethers.getAddress("0x00000000000000000000000000000000000000C3"), issuedAt: await now() });
    await throws(() => pool.connect(owner).submitAccessProof(aliceAddr, wrongPoolProof), "wrong-pool proof rejected by pool");

    const goodAt = await now();
    const goodProof = await makeReclaimProof(witness, { provider: PROVIDER_NAME, member: aliceAddr, pool: poolAddr, issuedAt: goodAt });
    await (await pool.connect(owner).submitAccessProof(aliceAddr, goodProof)).wait();
    await (await pool.connect(owner).settle(aliceAddr)).wait();
    const pendingBefore = (await pool.members(aliceAddr)).pending;
    const balBefore = await token.balanceOf(ownerAddr);
    await (await pool.connect(owner).ownerClaim(aliceAddr)).wait();
    const claimed = (await token.balanceOf(ownerAddr)) - balBefore;
    ok(pendingBefore > 0n, "member had streamed funds pending");
    ok(claimed === pendingBefore, "owner claimed the streamed funds after a valid Reclaim proof");

    // ---- Replay / single-use hardening --------------------------------------------------
    // lastProof is stamped from the witness OBSERVATION time (goodAt), not the block. It also
    // must advance strictly, so a given observation is single-use and cannot roll freshness.
    const stamped = (await pool.members(aliceAddr)).lastProof;
    ok(stamped === goodAt, "lastProof stamped from witness observation time, not submission block");

    await throws(() => pool.connect(owner).submitAccessProof(aliceAddr, goodProof),
      "exact same proof cannot be replayed (single-use)");

    // A *different* proof blob that attests the SAME observation time is still rejected —
    // single-use is by observation, not by bytes, so re-witnessing the old moment can't refresh.
    const sameMomentProof = await makeReclaimProof(witness, { provider: PROVIDER_NAME, member: aliceAddr, pool: poolAddr, issuedAt: goodAt, epoch: 2 });
    await throws(() => pool.connect(owner).submitAccessProof(aliceAddr, sameMomentProof),
      "distinct proof at same observation time rejected (no bytes-only replay)");

    // A genuinely newer observation advances the stamp.
    await inc(5n);
    const newerAt = await now();
    const newerProof = await makeReclaimProof(witness, { provider: PROVIDER_NAME, member: aliceAddr, pool: poolAddr, issuedAt: newerAt });
    await (await pool.connect(owner).submitAccessProof(aliceAddr, newerProof)).wait();
    ok((await pool.members(aliceAddr)).lastProof === newerAt, "newer observation advances the freshness stamp");

    // An older-but-still-in-window observation cannot roll freshness backwards.
    const backdatedProof = await makeReclaimProof(witness, { provider: PROVIDER_NAME, member: aliceAddr, pool: poolAddr, issuedAt: goodAt + 2n });
    await throws(() => pool.connect(owner).submitAccessProof(aliceAddr, backdatedProof),
      "older in-window observation cannot roll freshness backwards");
  }

  console.log("\n== Defense-in-depth: pool rejects a verifier that reports a FUTURE observation ==");
  {
    // A broken verifier that approves the proof but returns observedAt = now + 1 day. The pool
    // must reject with BadProofTime rather than stamp lastProof in the future (which would brick
    // ownerClaim via `now - lastProof` underflow). No real verifier does this — this is the guard.
    const token = await deploy("MockERC20", owner);
    const arbitrator = await deploy("MockArbitrator", owner);
    const badVerifier = await deploy("MockFutureVerifier", owner, [86400n]);
    const factory = await deploy("SubscriptionPoolFactory", owner, [
      await badVerifier.getAddress(), await arbitrator.getAddress(),
    ]);
    const ref = ethers.id(PROVIDER_NAME);
    const params = [
      await token.getAddress(), 100000n, 100n, 3n,
      50000n, 5000n, PROOF_VALIDITY, 10n, 100000n, ref, PROVIDER_NAME,
    ];
    await (await factory.connect(owner).createPool(params)).wait();
    const poolAddr = await factory.allPools(0);
    const pool = new ethers.Contract(poolAddr, artifacts["SubscriptionPool"].abi, owner);
    for (const [s, a] of [[owner, ownerAddr], [alice, aliceAddr]]) {
      await (await token.mint(a, 10_000_000n)).wait();
      await (await token.connect(s).approve(poolAddr, ethers.MaxUint256)).wait();
    }
    await (await pool.connect(owner).fundOwnerBond()).wait();
    await (await pool.connect(alice).join(100000n)).wait();

    await throws(() => pool.connect(alice).submitAccessProof(aliceAddr, "0x"),
      "future-dated observation rejected by pool (BadProofTime), lastProof not moved forward");
    ok((await pool.members(aliceAddr)).lastProof === 0n, "lastProof untouched after rejected future proof");
  }

  console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
