# 🔐 Security Review — sharedsub (SubscriptionPool)

---

## Scope

|                                  |                                                                                 |
| -------------------------------- | ------------------------------------------------------------------------------- |
| **Mode**                         | default (full repo, exclude interfaces/mocks/test)                               |
| **Files reviewed**               | `SubscriptionPool.sol` · `SubscriptionPoolFactory.sol`<br>`ReclaimProofVerifier.sol` |
| **Confidence threshold (1-100)** | 80                                                                              |

Methodology: Pashov Audit Group `solidity-auditor` skill — 12 specialty attacker lenses (math/precision, access-control, economic-security, execution-trace, invariant, boundary, trust-gap, flow-gap, asymmetry, …) run across the source, then deduplicated and gate-validated against the actual code.

---

## Findings

[90] **1. Auto-excluded members can never reclaim their bond — funds permanently locked**

`SubscriptionPool.exit` · Confidence: 90

**Description**
`exit()` reverts on `if (!m.isActive) revert NotMember();`, but a member's seat is set `isActive = false` inside `_settle` the moment their buffer is exhausted (`owed >= m.buffer`, which anyone can trigger via the permissionless `settle(member)` or via `ownerClaim`), leaving `m.bond` funded with no code path that ever returns it — the bond is stranded in the contract forever.

**Fix**

```diff
-        if (!m.isActive) revert NotMember();
+        if (!m.joined) revert NotMember();
         if (m.inDispute) revert InDispute();
         _settle(msg.sender);
         uint256 refund = m.buffer + m.bond;
```
(with the existing `if (m.isActive)` guard at the seat-decrement already handling the already-excluded case)

---

[85] **2. Exited/excluded member can still open disputes and claw back the owner's earned funds**

`SubscriptionPool.raiseDispute` · Confidence: 85

**Description**
`raiseDispute` gates only on `if (!m.joined) revert NotMember();` and `joined` is never cleared, so a member who has already `exit()`ed (buffer + bond refunded, `pending` legitimately left for the owner) can still freeze that `pending` and — on any ruling other than owner-win (2) — have it refunded to themselves plus slash the owner bond, stealing revenue for service that was actually delivered.

**Fix**

```diff
-        if (!m.joined) revert NotMember();
+        if (!m.isActive) revert NotMember();
         if (m.inDispute) revert InDispute();
```

---

[82] **3. Owner can drain the bond before a pending dispute is ruled, nullifying the slash**

`SubscriptionPool.reclaimOwnerBond` · Confidence: 82

**Description**
`reclaimOwnerBond` gates only on `require(seatsTaken == 0)`, but a raised-but-unruled dispute does not reserve any bond (the bond is only decremented inside `rule`), so an owner facing a dispute from an already-excluded member (`seatsTaken == 0`) can withdraw the entire `ownerBondBalance` first, leaving `slash = min(slashAmount, 0) = 0` when the member wins.

**Fix**

```diff
+    uint256 public openDisputes; // incremented in raiseDispute, decremented in rule
     function reclaimOwnerBond() external onlyOwner nonReentrant {
         require(seatsTaken == 0, "seats active");
+        require(openDisputes == 0, "dispute pending");
         uint256 amount = ownerBondBalance;
```

---

[80] **4. Owner bond is slashed on a member-win even when zero funds are in dispute**

`SubscriptionPool.rule` · Confidence: 80

**Description**
In `rule`, the refund is gated on `if (amount > 0)` but the `ruling == 1` slash block sits outside that guard, so a member with `pending == 0` (e.g. after a full `exit()` and the owner already claiming) who wins a dispute still extracts `slashAmount` from the owner bond for free.

**Fix**

```diff
-            if (amount > 0) withdrawable[member] += amount;
-            if (ruling == 1) {
-                uint256 slash = slashAmount;
-                if (slash > ownerBondBalance) slash = ownerBondBalance;
-                ownerBondBalance -= slash;
-                withdrawable[member] += slash;
-            }
+            if (amount > 0) {
+                withdrawable[member] += amount;
+                if (ruling == 1) {
+                    uint256 slash = slashAmount;
+                    if (slash > ownerBondBalance) slash = ownerBondBalance;
+                    ownerBondBalance -= slash;
+                    withdrawable[member] += slash;
+                }
+            }
```

---

[78] **5. Repeated disputes drain the entire owner bond**

`SubscriptionPool.rule` · Confidence: 78

**Description**
`rule` sets `m.inDispute = false` unconditionally and records nothing about prior compensation, so a member can re-`raiseDispute` after each member-win ruling and slash `slashAmount` per win until `ownerBondBalance` reaches zero, with no per-member slash-once limit.

---

[76] **6. Streaming rate truncation makes the owner systematically under-collect**

`SubscriptionPool.constructor / _settle` · Confidence: 76

**Description**
`ratePerSecond = seatPrice / cycleDuration` floors the rate, so a full cycle streams `floor(seatPrice/cycleDuration) * cycleDuration < seatPrice` — e.g. `seatPrice = 10_000000` (6-dp) over a 30-day cycle gives `rate = 3` and collects only `7_776_000` (~22% under seatPrice), with the remainder refunded to the member on exit rather than earned by the owner; this is not dust and scales with the `seatPrice / cycleDuration` ratio.

---

[74] **7. Proof stamped at submission time, not attestation issuance time, widens the freshness window**

`SubscriptionPool.submitAccessProof` · Confidence: 74

**Description**
`submitAccessProof` stamps `m.lastProof = block.timestamp` while `ReclaimProofVerifier.verify` independently accepts an attestation up to its own `proofValidity` old, so the effective staleness bound becomes `verifier.proofValidity + pool.proofValidity`; because the verifier is a single factory-wide singleton with one `proofValidity` and each pool configures its own, the doc's "keep == pool.proofValidity" cannot hold across pools and the real window diverges from the intended one.

---

[72] **8. A single point-in-time proof unlocks the entire accrued `pending` backlog**

`SubscriptionPool.ownerClaim` · Confidence: 72

**Description**
`ownerClaim` only checks `block.timestamp - m.lastProof <= proofValidity` and then pays out the whole `m.pending`, which may have accrued over many cycles, so one fresh proof of "access is live now" releases payment for an unbounded prior period during which delivery was never proven (member's only recourse is the trusted arbitrator).

---

[70] **9. `join` reuses a dirty Member struct on re-join**

`SubscriptionPool.join` · Confidence: 70

**Description**
`join` gates only on `if (m.isActive) revert AlreadyMember();` and overwrites `buffer`/`bond`/`lastSettled`/`joined`/`isActive` but never resets `pending`, `lastProof`, or `inDispute`, so a member who was excluded while `inDispute == true` can re-join into a live seat that is permanently frozen for the owner (`ownerClaim`/`exit` revert `InDispute`) and whose eventual ruling mixes pre- and post-rejoin accounting.

---

Findings List

| # | Confidence | Title |
|---|---|---|
| 1 | [90] | Auto-excluded members can never reclaim their bond — funds permanently locked |
| 2 | [85] | Exited/excluded member can still open disputes and claw back owner's earned funds |
| 3 | [82] | Owner can drain the bond before a pending dispute is ruled, nullifying the slash |
| 4 | [80] | Owner bond is slashed on a member-win even when zero funds are in dispute |
| 5 | [78] | Repeated disputes drain the entire owner bond |
| 6 | [76] | Streaming rate truncation makes the owner systematically under-collect |
| 7 | [74] | Proof stamped at submission time, not issuance time, widens the freshness window |
| 8 | [72] | A single point-in-time proof unlocks the entire accrued `pending` backlog |
| 9 | [70] | `join` reuses a dirty Member struct on re-join |

---

## Leads

_Vulnerability trails with concrete code smells where the full exploit path depends on the (out-of-scope, trusted) arbitrator or on deploy-time config. These are not false positives — they are high-signal leads for manual review. Not scored._

- **Owner-win ruling bypasses the proof gate** — `SubscriptionPool.rule` — Code smells: `ruling == 2` credits `withdrawable[owner] += amount` with no `StaleProof` check, unlike `ownerClaim`. If an owner can drive a `ruling == 2` without delivering service, they collect `pending` bypassing proof-gating; exploitability hinges on the arbitrator trust model.
- **`disputeToMember` entries are never cleared** — `SubscriptionPool.rule` — Code smells: the mapping is never `delete`d and the only replay guard is the transient `inDispute` flag. A late or duplicated arbitrator callback on a recycled `disputeId` could route a ruling to the wrong current member; requires an arbitrator that reuses IDs (Kleros-style monotonic IDs make this unlikely in practice).
- **No member-side dispute bond makes frivolous disputes positive-EV** — `SubscriptionPool.raiseDispute` — Code smells: the member escrows nothing in-pool (only the forwarded `msg.value` court fee) and risks only `pending` they already owed the owner, so disputing is net-positive expected value regardless of merit, enabling serial griefing that freezes the owner's claims.

---

> ⚠️ This review was performed by an AI assistant. AI analysis can never verify the complete absence of vulnerabilities and no guarantee of security is given. Team security reviews, bug bounty programs, and on-chain monitoring are strongly recommended. For a consultation regarding your projects' security, visit [https://www.pashov.com](https://www.pashov.com)
