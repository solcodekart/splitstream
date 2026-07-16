# zkTLS proof-of-access — feasibility spike

**Question this spike answers:** can we actually generate, and verify on-chain, a proof
that a specific pool member has live access to a shared Spotify / Netflix / YouTube plan —
the single assumption the whole trust model rests on (today it's `MockProofVerifier`
returning `true`)?

**One-line verdict:** the cryptography is real and ships today; a point-in-time
"this account's plan is active" proof is generatable against the platforms' own logged-in
web endpoints and verifiable on-chain through our `IProofVerifier` interface with minor
changes. The risk is *not* cryptographic — it's (1) whether a *per-member* seat can be
proven (only on plans with named sub-accounts), and (2) platform durability, where Netflix
is directly adversarial. **Recommendation: conditional GO — run one real provider against
Spotify Premium Family before building anything further; treat Netflix as high-risk.**

---

## 1. The two production options

Both are live "web proof" / zkTLS systems that let a user prove a statement about their own
authenticated HTTPS session **without revealing password, cookies, or access token**. Neither
needs the platform's official developer API — they run against the same endpoints the
logged-in user's browser hits.

**Reclaim Protocol (YC W21) — proxy / attestor model.**
An "attestor" sits as an *opaque proxy*: it forwards the TLS traffic it cannot decrypt,
validates the server's CA certificate, and signs a *claim* attesting the response came
unaltered from the real domain. A ZK (chaCha) circuit redacts everything except the field
being proven. Proof generation is ~2–4s on a phone via an App Clip / Instant App — no install.
Custom endpoints are added as **providers** built in the Reclaim DevTool (define request +
which response bytes to redact/assert). On-chain, `Reclaim.verifyProof(proof)` checks the
attestor's ECDSA signature — cheap gas, EVM-wide (Ethereum, Base, Arbitrum, Polygon, …).

**zkPass (TransGate) — 3-party TLS / MPC model.**
The user, the server, and a zkPass MPC node run a three-party TLS handshake. The node holds a
share of the MAC key, so the user provably cannot tamper with the server's bytes; a hybrid ZK
proof (VOLE-ZK + SNARK) asserts the response matches a schema/condition (e.g. `plan == active`).
"Compatible with any HTTPS website, no API or license required." Verified results are signed
and posted (SBT / Merkle root); on-chain you check the node/allocator signature (optionally via
zkVerify for ~90% cheaper verification).

| | Reclaim | zkPass |
|---|---|---|
| Root of trust | Attestor/witness quorum + TLS CA | MPC node set + TLS CA |
| Proof gen | ~2–4s, mobile, no install | ms-level local ZK, browser extension |
| On-chain verify | ECDSA sig check (`Reclaim.sol`) | Node/validator sig, optional zkVerify |
| Custom site support | Provider (DevTool) | Schema (TransGate) |
| Best fit for us | ✅ mobile, low friction | strong tamper-proofing, more setup |

---

## 2. The honest caveat: neither is "trustless"

Our design doc language ("a zero-knowledge proof that the member controls an active account")
should be tightened. On-chain, **we are verifying a signature from the provider's attestor /
MPC-node set** — not a standalone SNARK of the full TLS session. The security assumption is
therefore *"the attestor/node quorum is honest AND standard TLS/CA holds"*, not *"pure math."*
That is a meaningfully weaker (though still strong, and audited) guarantee. It maps to
`IProofVerifier` fine — but say so plainly in the doc and pick a provider whose decentralisation
roadmap you trust.

---

## 3. The design finding that actually matters: *who* proves *what*

In a shared pool the **owner** holds the real subscription (they pay the platform). Our
contract currently calls `submitAccessProof(member, …)` per member — but a member has no
separate credential on a bare password-shared account, so there is nothing member-specific to
prove. This splits by platform:

- **Plans with named sub-members — provable per member.** Spotify Premium **Family**, YouTube
  Premium **Family**, and Netflix **extra member** each give the member their *own* login tied
  to the plan. The member can generate a proof from *their* account page ("member of household X,
  plan active"). This is the clean case and matches the contract as written.
- **Bare credential sharing — only the plan is provable, not the seat.** With one shared
  password there's no per-member identity; the best you can prove is *the owner's account is an
  active N-seat plan*. Per-seat accounting then can't be proof-gated — a weaker product.

**Implication:** scope v1 to family/household plans with named members. That is also the ToS-safer
framing (members are legitimately on the plan) and the more defensible product.

---

## 4. Mapping to our `IProofVerifier`

Current interface (good news — the shape is already right):

```solidity
function verify(address member, address pool, bytes32 subscriptionRef, bytes calldata proof)
    external view returns (bool ok);
```

A real implementation wraps `Reclaim.verifyProof` (or the zkPass verifier) and adds three checks.
The binding fields it needs are exactly the ones we already pass:

1. **Authenticity** — call the provider's verifier on `proof`; require the asserted field
   (e.g. `plan_status == "active"` / `family_member == true`) is present.
2. **Binding to (member, pool, subscriptionRef)** — both providers let you embed an app context
   in the signed proof (Reclaim: `proof.claimInfo.context` carries an address + message; zkPass:
   bind a recipient/wallet in the schema). Require `context.member == member`,
   `context.pool == pool`, `context.ref == subscriptionRef`. This is what stops a proof being
   replayed across pools.
3. **Freshness** — **this is the one real gap.** A web proof is a *point-in-time snapshot*; it
   does not prove continuous access. `verify` is `view`, and `submitAccessProof` currently stamps
   `lastProof = block.timestamp` at submission — so a stale-but-valid proof could mint a fresh
   timestamp. Fix: embed an `issuedAt` in the proof context and require
   `block.timestamp - issuedAt <= proofValidity` (in `verify` or the pool). Keep `proofValidity`
   ≈ one cycle so the member re-proves each period before the owner can `ownerClaim` — which is
   already how the streaming model is meant to work.

Replay note: because `verify` is `view` it cannot *consume* a nonce. Binding to
`(pool, member, subscriptionRef, issuedAt)` prevents cross-pool and stale replay without state;
if you want single-use proofs, make the proof path non-view and record a used-nonce set.

No other contract changes are required — the pool already tracks `lastProof`, `proofValidity`,
and reverts `StaleProof`.

---

## 5. Durability risk (the real go/no-go input)

- **Brittleness.** A provider/schema targets specific response bytes on the account page. When
  the platform restructures that page or endpoint, the provider breaks until someone updates it.
  Budget for ongoing provider maintenance per platform.
- **Platform posture.** Spotify's Feb-2026 developer changes (apps capped at 5 users, Premium
  required, "platform security" tightening) show platforms are actively restricting programmatic
  access. zkTLS runs against the consumer session rather than that API, so it routes around the
  specific change — but the direction of travel is hostile.
- **Netflix is adversarial by design.** Netflix monetised the exact thing this product enables
  (it ended free password sharing and sells paid "extra member" slots). A protocol that
  coordinates cross-household sharing is against their business model; expect ToS enforcement and
  anti-automation. **Rate Netflix high-risk / likely-not for v1.** Spotify Family and YouTube
  Family (household plans that are *meant* to have multiple named members) are far safer starting
  points.

---

## 6. Recommended next step — a 1–2 day de-risking experiment

Before touching the contracts further, prove the end-to-end path once:

1. Build a **Reclaim provider** in the DevTool for the **Spotify Premium Family** member account
   page, asserting "this account is an active family-plan member."
2. Generate a proof on a phone with an `issuedAt` + the member address embedded in `context`.
3. Deploy a `ReclaimProofVerifier is IProofVerifier` on **Base Sepolia** (we already have the
   testnet deploy path) that wraps `Reclaim.verifyProof` and enforces the three checks in §4.
4. Swap it in for `MockProofVerifier` and run the existing join → stream → `submitAccessProof`
   → `ownerClaim` flow against it.

Success = a real Spotify proof gates a real `ownerClaim` on testnet. That single result
converts the biggest unknown in the whole design from "assumed" to "shown," and tells us whether
to build for family plans only, and whether Netflix is worth attempting at all.

---

### Sources
- Reclaim Protocol — Understanding the Tech: https://docs.reclaimprotocol.org/understanding-the-tech
- Reclaim Protocol — providers: https://docs.reclaimprotocol.org/wtf-are-providers
- Reclaim Protocol — on-chain Solidity quickstart: https://docs.reclaimprotocol.org/onchain/solidity/quickstart
- Reclaim Solidity SDK — contract API: https://deepwiki.com/reclaimprotocol/reclaim-solidity-sdk/9.1-reclaim-contract-api
- zkPass — FAQ (3P-TLS, MPC, anti-cheating): https://docs.zkpass.org/supports/faq
- zkPass — technical whitepaper 2.0: https://paper.zkpass.org/tech.pdf
- zkTLS trust/proxy-vs-MPC model — Shoal Research: https://www.shoal.gg/p/zktls-verifiable-data-composability
- Spotify — Feb 2026 dev-mode/platform-security changes: https://developer.spotify.com/blog/2026-02-06-update-on-developer-access-and-platform-security
- TechCrunch — Spotify dev-mode API changes: https://techcrunch.com/2026/02/06/spotify-changes-developer-mode-api-to-require-premium-accounts-limits-test-users/
