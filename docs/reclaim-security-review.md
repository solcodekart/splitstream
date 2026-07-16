# Reclaim adapter — security review

Scope: `contracts/ReclaimAdapterVerifier.sol`, `contracts/interfaces/IReclaim.sol`,
`contracts/mocks/MockReclaim.sol`, and the Reclaim deploy wiring in
`scripts/deploy-testnet.js`. This is a prototype-level review of the proof gate that
replaces `MockProofVerifier` with the real Reclaim beacon. It is **not** a full audit; bond
sizing, arbitration economics, and the base pool were out of scope.

## Trust model (what the gate actually guarantees)

The adapter's security rests on one fact about the deployed Reclaim beacon, verified against
the vendored SDK source (`Reclaim.sol` L157-158): `verifyProof` requires
`signedClaim.claim.identifier == Claims.hashClaimInfo(proof.claimInfo)`, where
`hashClaimInfo == keccak256(provider "\n" parameters "\n" context)`. Because the witness
quorum signs that identifier, **the entire `claimInfo` — including the context that carries
`contextAddress`/`contextMessage` — is committed at signing time and cannot be swapped
afterward.** Every application-level binding the adapter enforces (member, pool, provider)
therefore inherits its integrity from that one check. Note the beacon at L185 marks the SNARK
step `//@TODO: verify zkproof`: the guarantee is witness-signature trust plus TLS/CA honesty,
not a standalone zero-knowledge proof of the session. This matches the residual-trust model in
`docs/zktls-proof-spike.md` §2-3 and is the correct thing to communicate to users.

## Findings

**F1 — Test double did not enforce the beacon's identifier binding (High, test-fidelity;
fixed).** The original `MockReclaim` checked witness signatures over the serialised claim but
omitted the `identifier == hashClaimInfo(claimInfo)` check the real beacon performs. That gap
meant the test suite could not detect a proof whose signed identifier didn't commit to the
context — i.e. the suite passed without actually proving the member/pool bindings were
tamper-proof, which is the adapter's whole reason to exist. Fixed: `MockReclaim.verifyProof`
now reverts on `identifier != _hashClaimInfo(claimInfo)`, `makeReclaimProof` computes a
committing identifier, and a new "Context tampering & adversarial parser" block asserts that a
proof with a post-hoc-swapped context is rejected for both member and pool. This is a fix to
test fidelity, not to on-chain code — the production path always calls the real beacon, which
already enforced this — but without it the tests gave false assurance.

**F2 — `subscriptionRef` binds only the provider name, not the claim parameters (Info /
by design).** `keccak256(provider) == subscriptionRef` ties a pool to a Reclaim provider but
not to specific `parameters` (e.g. a particular account/plan tier). Any valid proof for that
provider, bound to the right (member, pool), satisfies the gate. For the v1 scope
(family/household membership, one provider per plan) this is intended and sufficient. If a
future pool needs to distinguish tiers or specific accounts within one provider, bind a hash
of the relevant `parameters` as well. Documented here so it's a conscious product decision.

**F3 — `_extractField` returns the first match (Info; safe under F1).** The parser takes the
first occurrence of `"contextAddress":"`. If an attacker could inject a decoy field earlier in
the context they could shadow the real one — but they can't: the context is signature-bound
(F1), so its contents are fixed by an honest witness. The adversarial test block confirms an
escaped-quote decoy (`\"contextAddress\":\"<alice>`) does not match, a truncated value does
not prefix-match, and missing/empty context yields rejection. The parser is a faithful port of
the SDK's `extractFieldFromContext`; keeping it byte-identical is deliberate.

**F4 — No upper bound on context length (Info / low).** `verify` loops over the full context
string. A pathologically long context costs more gas, but the submitter pays it and a bad
proof simply returns `false`, so this is a self-DoS, not a pool DoS. Not worth a hard cap at
prototype stage; note it if gas on the target chain ever matters.

**F5 — Replay within the freshness window (Medium; fixed).** Originally a valid proof could be
resubmitted while still within `proofValidity`, and the pool stamped `lastProof` from the
submission block rather than the witness observation time — so a stale-but-in-window
observation could be laundered into a fresh stamp, and near the edge of validity a single
observation could extend coverage toward ~2×`proofValidity`. Fixed by threading the witness
observation time through the verifier: `IProofVerifier.verify` now returns
`(bool ok, uint256 observedAt)`; `submitAccessProof` stamps `lastProof = observedAt` and
requires `observedAt > lastProof` (strict-monotonic). A given observation is therefore
single-use — resubmitting the same proof, a different proof attesting the same moment, or an
older in-window proof all revert with `ReplayedProof` — and a proof grants at most one
`proofValidity` of coverage measured from when access was actually observed. All three
verifiers (`MockProofVerifier`, `ReclaimProofVerifier`, `ReclaimAdapterVerifier`) return the
observation time (the mock reports `block.timestamp`); five replay assertions were added to
`test-reclaim-adapter.js`.

**F6 — Pool trusted the verifier's observation time without bound (Low, defense-in-depth;
fixed).** With F5 the pool stamps `lastProof = observedAt` from the verifier's return. Every
shipped verifier reports an observation at or before `block.timestamp`, but the pool took that
on trust: a buggy or malicious verifier reporting a *future* `observedAt` would stamp
`lastProof` ahead of `block.timestamp`, which then bricks `ownerClaim` via underflow in
`block.timestamp - m.lastProof`. Fixed by adding `error BadProofTime()` and, in
`submitAccessProof`, `if (observedAt > block.timestamp) revert BadProofTime();` before the
replay check — the pool rejects rather than clamps a future-dated observation, so a broken
verifier can't move `lastProof` past the present. New `contracts/mocks/MockFutureVerifier.sol`
(returns `(true, block.timestamp + skew)`) exercises the guard; two assertions in
`test-reclaim-adapter.js` confirm the revert and that `lastProof` stays `0`.

## Deploy-wiring review

`scripts/deploy-testnet.js` switches to the real adapter only when all four `RECLAIM_*` env
vars are set, else stays on the mock path unchanged — good fail-safe default. The app secret is
never written to `deployed.json` (only `appId`/`providerId`/`providerName`/`beacon`), and is
read at runtime from `VITE_RECLAIM_APP_SECRET`; confirmed no secret is persisted. `subscriptionRef`
is set to `keccak256(providerName)` under the real adapter so a proof for that provider unlocks
the pool — consistent with the on-chain check. The one operational footgun is the provider
string: `RECLAIM_PROVIDER_NAME` must equal `claimInfo.provider` byte-for-byte, or every proof
silently fails the F2 binding; this is called out in `docs/reclaim-runbook.md`.

## Frontend QA (Reclaim UI)

Static + build QA of `app/src/reclaim.js` and the `ProveAccessModal` path in `app/src/App.jsx`:

- **SDK shape match** — called `transformForOnchain` on a sample proof and confirmed its output
  (`claimInfo.{provider,parameters,context}`, `signedClaim.claim.{identifier,owner,timestampS,
  epoch}`, `signedClaim.signatures`) matches `encodeProofForChain`'s field-by-field mapping and
  the `PROOF_TYPES` tuple, which in turn equals the adapter's on-chain decode type. Encoding is
  by field name, not object-key order, so it survives SDK reshuffles.
- **Binding** — `startAccessProof` lowercases `member` and `pool` before `addContext`, matching
  the adapter's lowercase-hex `contextAddress`/`contextMessage` checks.
- **Branching** — the "Prove access" button renders only when `reclaimEnabled && active`; the
  host's `verifyAndClaim` skips the mock `setAccepts`/`submitAccessProof("0x")` shim when
  `reclaimEnabled` (the adapter has no `setAccepts`), and the mock demo path is unchanged.
- **Interface change is invisible to the UI** — the verifier's new `(bool, uint256)` return is
  consumed only by the pool; the frontend calls `submitAccessProof(member, bytes)` and reads
  `members()`, neither of which changed.
- **Build** — `vite build` transforms all 1707 modules and completes cleanly (the app secret is
  read from `VITE_RECLAIM_APP_SECRET`, never bundled from `deployed.json`).

No frontend defects found; the modal handles the awaiting/submitting/error states and cancels
its async work on unmount (`alive` guard).

## Status

F1, F5, and F6 remediated in code and tests (28/28 adapter assertions, plus a 6-property parser
fuzz; full suite 121 green). F2-F4 are accepted prototype-scope notes.
