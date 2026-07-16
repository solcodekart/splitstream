# Splitstream — decentralized shared-subscription marketplace

A working, tested prototype of the on-chain core for a decentralized shared-subscription
marketplace. Members **stream** a stablecoin to a subscription **host**; the host can only
**withdraw** while the member holds a fresh **proof-of-access**; both sides post **bonds**;
and disputes settle through a **decentralized arbitrator**. A React dApp drives the whole
flow against the real contracts.

> **Status: prototype.** The mechanics are implemented, tested, and self-reviewed, but this
> is **not professionally audited and not production-hardened.** See
> [Security posture](#security-posture) and [Known limitations](#known-limitations) before
> going anywhere near mainnet or real funds.

## How the trust mechanism works

1. **Host** funds a bond → the pool goes live.
2. **Member** joins: deposits a prepaid streaming **buffer** (≥ one cycle) plus a member bond.
3. The buffer **streams** to the host over time at `seatPrice / cycleDuration` per second,
   accrued full-precision as `seatPrice * elapsed / cycleDuration` (a self-contained,
   testable stand-in for a Superfluid flow).
4. As the buffer nears empty, `reminderDue()` flips true → an off-chain watcher sends the
   "top up or lose your seat" notice. If left unfunded, the next `settle()` **excludes** the
   member automatically — no human decides.
5. The host can only `ownerClaim()` a member's streamed funds while that member has a **fresh
   zkTLS proof-of-access** (`submitAccessProof`) — proof the service was actually delivered.
   No proof, no payout. Each proof is **single-use** and freshness is measured from the
   witness observation time, so a proof can't be replayed or laundered into extra coverage.
6. If the host takes money but cuts access, the member opens a **dispute**; a member-win
   ruling refunds the streamed funds **and slashes the host's bond**. An owner-win releases
   the funds to the host.

## Quick start (run the tests)

```bash
npm install
npm test          # compiles, then runs the full suite
```

Expected: **121 assertions green** across seven suites (core pool, verifier, Reclaim adapter,
parser fuzz, and three regression/audit-fix suites). A separate stateful invariant fuzzer runs
via `npm run fuzz`.

## Run the app on a local chain

The `app/` folder is a Vite + React + ethers front end wired to the real contracts on a local
**ganache** chain — no MetaMask needed; it signs with ganache's deterministic dev accounts (the
"Connect" menu is an account picker).

Open **three terminals** from the project root:

```bash
# 0) one-time
npm install
npm run compile

# 1) terminal A — local chain (mines every second so the stream advances)
npm run chain        # ganache on http://127.0.0.1:8545, keep running

# 2) terminal B — deploy + seed pools, write addresses/ABIs into app/src
npm run deploy

# 3) terminal C — the UI
cd app && npm install && npm run dev   # http://localhost:5173
```

In the browser: **Connect** → pick *Alice* → **Browse** a pool → **Join** (signs `approve`
+ `join`). Open **My Pools** and watch the buffer tick down in real time; near empty the amber
"top up or lose your seat" banner fires, and if it drains the seat is auto-excluded — all read
straight from the contract. Switch to *Owner* → **Host** to mark a member's access proven and
`ownerClaim()` their streamed funds.

> The deterministic mnemonic and dev keys are **local-only** — never use them on a real network.

## Run on a public testnet (MetaMask)

Same app, pointed at a real test network and signing through **MetaMask**. Defaults to **Base
Sepolia**; Ethereum / Arbitrum / OP Sepolia also work via `RPC_URL`.

```bash
npm install && npm run compile

# fund a throwaway deployer key with a little testnet ETH (gas only)
export DEPLOYER_KEY=0x<funded testnet private key>
# optional: export RPC_URL=https://ethereum-sepolia-rpc.publicnode.com

npm run deploy:testnet                 # writes app/src/deployed.json (mode: "injected")
cd app && npm install && npm run dev
```

In the browser: **Connect MetaMask** on the target network → **Browse** → **Join**. Members
only need a little native ETH for gas — the test stablecoin (mUSD) mints on demand from the app.

> Only the **deployer** key is sensitive; it's read from `DEPLOYER_KEY` (or `PRIVATE_KEY`),
> never hardcoded. Use a throwaway testnet key that holds nothing else.

To swap the mock proof gate for **real Reclaim zkTLS proofs** on a testnet, set the four
`RECLAIM_*` env vars before deploying and follow **[`docs/reclaim-runbook.md`](docs/reclaim-runbook.md)**.

## The plan catalog

The host "Create pool" form is backed by a catalog of ~12 real services (Spotify, Netflix,
YouTube Premium, Disney+, Apple Music, Apple TV+, Amazon Prime, Max, Hulu, Paramount+, Peacock,
Nintendo Switch Online) with current US and EU plan prices and official seat counts. Picking a
plan pre-fills the suggested per-seat price as `full plan price ÷ seats` (editable), and the
price book switches with the region selector. Numbers and sources live in
[`docs/plan-catalog.md`](docs/plan-catalog.md). Note pool `seatPrice` is **immutable** once a
pool is created — repricing means spinning up a new pool.

## Repository layout

```
contracts/            Solidity core + Reclaim adapter + mocks/test doubles
  SubscriptionPool.sol         streaming, bonds, proof-gated claim, disputes
  SubscriptionPoolFactory.sol  deploys + indexes pools
  ReclaimAdapterVerifier.sol   real zkTLS gate (wraps the deployed Reclaim beacon)
  interfaces/                  IProofVerifier, IArbitrator, IReclaim
  mocks/                       MockProofVerifier, MockArbitrator, MockERC20, MockReclaim, …
app/                  Vite + React + ethers dApp (App.jsx, reclaim.js, chain.js)
scripts/              deploy.js (ganache) · deploy-testnet.js (public testnets)
test-*.js             standalone node test suites (run via `npm test`)
compile.js            solc build → out/artifacts.json
docs/                 runbook, security review, plan catalog, zkTLS spike memo
```

## Security posture

This prototype has been iteratively hardened, but **not independently audited**:

- An AI/tool audit pass (Pashov solidity-auditor) plus manual review; findings fixed with
  regression tests (`test-audit-fixes*.js`).
- A homegrown stateful **invariant fuzzer** (`test-invariant.js`) that surfaced and drove fixes
  for orphaned-bond / orphaned-buffer re-join bugs.
- A dedicated review of the Reclaim proof gate — [`docs/reclaim-security-review.md`](docs/reclaim-security-review.md) —
  covering the beacon trust model, a `_extractField` parser fuzz, **replay / single-use proof
  hardening**, and a defense-in-depth guard rejecting future-dated observations.

What is explicitly **out of scope** and required before mainnet: a professional third-party
security audit (bond sizing, arbitration economics, and base-pool mechanics were not audited),
and a legal / platform-ToS review (splitting subscriptions runs into providers' account-sharing
terms).

## Production swaps (nothing is locked in)

- `MockProofVerifier` → real **Reclaim** on-chain verifier — **built** (`ReclaimAdapterVerifier`,
  28 assertions in `test-reclaim-adapter.js`; member flow in `app/src/reclaim.js`).
- `MockArbitrator` → **Kleros** court.
- Internal buffer→pending streaming → **Superfluid** Constant Flow Agreements.
- `MockERC20` → a real stablecoin (USDC, etc.).

## Known limitations

- No professional reentrancy/economic audit; bond sizing and `slashAmount` are illustrative.
- The reminder is an on-chain *signal* (`ReminderDue` event / `reminderDue()` view); the actual
  notification is sent by an off-chain watcher.
- The Reclaim beacon's SNARK step is marked `//@TODO verify zkproof` upstream, so the guarantee
  is witness-signature + TLS/CA trust, not a standalone zero-knowledge proof — a disclosed,
  residual-trust assumption (see the spike memo).
- Platform **ToS / legal** questions are unaddressed — a go-live decision separate from the tech.

## Toolchain note

Uses a pure-npm Solidity stack (`solc` + `ganache` + `ethers`) instead of Foundry, because the
build environment couldn't fetch Foundry binaries. The contracts are standard Solidity and
compile under Foundry/Hardhat unchanged. Bytecode targets the **paris** EVM (`evmVersion` in
`compile.js`); bump to `shanghai`/`cancun` for chains that support PUSH0.
