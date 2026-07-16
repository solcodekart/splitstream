# Reclaim zkTLS — live integration runbook

This is the operator's guide for switching Splitstream's proof gate from the
`MockProofVerifier` demo path to the **real Reclaim Protocol** zkTLS verifier end to
end: on-chain adapter → deploy wiring → frontend "Prove access" flow.

Everything the code needs is already in the repo. What *cannot* live in the repo — and
what this runbook is for — is the set of **live credentials and per-network addresses**
that only exist once you register an app with Reclaim and pick a target chain.

> The prototype runs fine without any of this (mock mode). Follow this only when you want
> real membership proofs gating payouts on a public testnet.

---

## What's already built

| Piece | File | Status |
|---|---|---|
| On-chain adapter (calls the deployed Reclaim beacon, enforces provider/member/pool/freshness) | `contracts/ReclaimAdapterVerifier.sol` | done, 13 tests |
| ABI-compatible interface to the deployed beacon | `contracts/interfaces/IReclaim.sol` | done |
| Local test double for the beacon (real serialise + recover) | `contracts/mocks/MockReclaim.sol` | done |
| Adapter + pool integration tests | `test-reclaim-adapter.js` | 13/13 passing |
| Frontend proof session → on-chain bytes | `app/src/reclaim.js` | done |
| Member "Prove access" UI | `app/src/App.jsx` (`ProveAccessModal`) | done |
| Env-gated deploy wiring | `scripts/deploy-testnet.js` | done |

The four application-level properties the adapter enforces (on top of Reclaim's witness
signature check): **provider ⇄ subscriptionRef** binding, **member** binding
(`contextAddress`), **pool** binding (`contextMessage`), and **freshness** (`timestampS`
within `proofValidity`). See the contract's header comment for the full rationale, and
`docs/zktls-proof-spike.md` §2–3 for the residual-trust model.

---

## Step 1 — Register a Reclaim app + provider

1. Go to the Reclaim developer dashboard (`dev.reclaimprotocol.org`) and create an
   **application**. You get an **App ID** and an **App Secret**.
2. Add/choose an **HTTP provider** that proves the membership you care about — for v1
   scope this is a **family/household plan** check (e.g. a Spotify "family members" page
   or a YouTube family-management page), **not** a Netflix login (see the spike memo:
   Netflix is high-risk/adversarial). You get a **Provider ID**.
3. Generate one proof in the Reclaim playground and **inspect the resulting proof
   object**. Note the exact string in `claimInfo.provider`. That string — verbatim — is
   what `subscriptionRef` must hash to. Call it `PROVIDER_NAME`.

> Why read it off a real proof: `subscriptionRef == keccak256(bytes(claimInfo.provider))`
> is checked on-chain byte-for-byte. Guessing the provider string will silently fail
> every proof. Read it once, then it's fixed.

---

## Step 2 — Find the Reclaim beacon address for your chain

The Reclaim verifier contract is **already deployed** on every supported network; you do
not deploy it. Get the address for your target testnet from Reclaim's
`verifier-solidity-sdk` `contracts/Addresses.sol` (or their docs). Call it
`RECLAIM_ADDRESS`.

> Do not hardcode an address from memory — these are per-network and can change. Copy the
> current value from the SDK for the exact chainId you deploy to.

---

## Step 3 — Deploy with the real adapter

From the project root:

```bash
npm run compile

# funded deployer (throwaway testnet key — gas only)
export DEPLOYER_KEY=0x<funded testnet private key>
# optional: export RPC_URL=https://sepolia.base.org   (default is Base Sepolia)

# the four Reclaim env vars flip the deploy from mock -> real adapter
export RECLAIM_ADDRESS=0x<reclaim beacon on this chain>
export RECLAIM_APP_ID=<app id from the dashboard>
export RECLAIM_PROVIDER_ID=<provider id from the dashboard>
export RECLAIM_PROVIDER_NAME='<exact claimInfo.provider string from a sample proof>'
export SEED=1   # seed a single pool that this provider unlocks

npm run deploy:testnet
```

What changes when all four `RECLAIM_*` are set (see `scripts/deploy-testnet.js`):

- Deploys `ReclaimAdapterVerifier(RECLAIM_ADDRESS, proofValidity)` instead of
  `MockProofVerifier`, and wires the factory to it.
- Sets each seeded pool's `subscriptionRef = keccak256(PROVIDER_NAME)`.
- Writes a `reclaim: { appId, providerId, providerName, beacon }` block and the
  `ReclaimAdapterVerifier` ABI into `app/src/deployed.json` / `abis.json`.

Leave any of the four unset and the deploy stays on the **mock path** unchanged.

---

## Step 4 — Run the frontend with the app secret

The App Secret must **never** be committed or written into `deployed.json`. The frontend
reads it from a Vite env var at build/run time:

```bash
cd app
npm install
export VITE_RECLAIM_APP_SECRET=<app secret from the dashboard>
npm run dev
```

When `deployed.json` contains a `reclaim` block, `app/src/reclaim.js` flips
`reclaimEnabled = true`, and a **"Prove access"** button appears on each active seat in
**My Pools**.

> Production note: shipping the App Secret to the browser is insecure. For a real launch,
> initialise `ReclaimProofRequest` on a small backend and hand the browser a prepared
> request (the SDK supports backend init). `reclaim.js` is structured so only that init
> call needs to move server-side.

---

## Step 5 — End-to-end flow (who does what)

1. **Member** joins a pool (streams the buffer as usual).
2. **Member** clicks **Prove access** → `ProveAccessModal` calls
   `ReclaimProofRequest.init(appId, secret, providerId)`, binds the proof to
   `(member, pool)` via `addContext(member, pool)` (both lowercased so they match the
   adapter's `contextAddress` / `contextMessage` checks), and opens the Reclaim flow.
3. **Member** completes the zkTLS flow on the Reclaim app. Credentials/cookies stay on
   their device; only the witness-signed attestation is produced.
4. The SDK returns a proof → `transformForOnchain` → abi-encoded bytes → the member's
   wallet sends `submitAccessProof(member, proofBytes)`. On-chain the adapter runs the
   witness-signature + four bindings + freshness checks and stamps `lastProof`.
5. **Host** clicks **Verify & claim** → `ownerClaim(member)`. Because a fresh proof is
   already on-chain, the `StaleProof` guard passes and the streamed funds are released.
   (If the member hasn't proven within `proofValidity`, `ownerClaim` reverts — by design.)

---

## Verifying it works before spending real gas

The adapter is exercised end to end against a faithful local beacon
(`MockReclaim`, which reproduces the SDK's `serialise` + EIP-191 `recover`) in
`test-reclaim-adapter.js`:

```bash
npm test        # includes the 13-assertion Reclaim adapter suite
```

That suite proves the happy path plus every rejection: non-witness signer, wrong provider,
wrong member, wrong pool, stale, future-dated, and malformed blobs. It's the closest you
can get to the real thing without live Reclaim infrastructure — the only piece the local
run can't stand in for is Reclaim's actual witness quorum + TLS/CA trust, which is exactly
the residual-trust boundary documented in the spike memo.

---

## Gotchas checklist

- **Provider string mismatch** is the #1 failure: `RECLAIM_PROVIDER_NAME` must equal
  `claimInfo.provider` from a real proof, exactly.
- **Address casing**: the adapter compares lowercase hex; `reclaim.js` lowercases
  `member` and `pool` before `addContext`. Don't change that.
- **`proofValidity`**: the adapter's constructor arg should match the pool's
  `proofValidity` (default `600`s here) so a proof accepted at submit time is still fresh
  at claim time.
- **Beacon per chain**: redeploying to a different testnet needs that chain's
  `RECLAIM_ADDRESS`.
- **App Secret**: only ever in `VITE_RECLAIM_APP_SECRET`, never in git or `deployed.json`.
