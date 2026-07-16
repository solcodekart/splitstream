# Shared Subscriptions — Smart Contract Prototype

A working, tested prototype of the on-chain core for a decentralised shared-subscription
marketplace. It implements the trust mechanism from the design doc: members **stream**
a stablecoin to a subscription **owner**, the owner can only **withdraw** while the member
holds a fresh **proof-of-access**, both sides post **bonds**, and disputes go to a
**decentralised arbitrator**.

This is a prototype to validate the mechanics — **not audited, not production-hardened.**

## Run it

```bash
npm install
npm test          # compiles contracts, then runs the end-to-end suite
```

Expected: `RESULTS: 29 passed, 0 failed`.

## Run the app (frontend wired to the contracts)

The `app/` folder is a Vite + React + ethers front end that talks to the real
contracts on a local **ganache** chain. No MetaMask needed — it signs with
ganache's deterministic dev accounts (the "Connect" menu is an account picker).

Open **three terminals** from the project root:

```bash
# 0) one-time
npm install
npm run compile

# 1) terminal A — start a local chain (mines every second so the stream advances)
npm run chain        # ganache on http://127.0.0.1:8545, keep running

# 2) terminal B — deploy contracts + seed pools, write addresses/ABIs into app/src
npm run deploy

# 3) terminal C — run the UI
cd app
npm install
npm run dev          # opens http://localhost:5173
```

Then in the browser: **Connect** → pick *Alice* → **Browse** a pool → **Join**
(signs `approve` + `join`). Open **My Pools** and watch the buffer tick down in
real time; near empty the amber *“top up or lose your seat”* banner fires, and if
it drains the seat is auto-excluded — all read straight from the contract
(`runwaySeconds` / `reminderDue` / `members`). **Top up** and **Exit** are live
transactions too. Switch to *Owner* and open **Host** to mark a member's access
proven and `ownerClaim()` their streamed funds (the proof-gated payout).

`npm run deploy` regenerates `app/src/deployed.json` and `app/src/abis.json`;
restart the chain + re-deploy any time you want a clean slate.

> The deterministic mnemonic and dev private keys are **local-only** — never use
> them on a real network.

## Run on a public testnet (Base Sepolia + MetaMask)

Same app, but pointed at a real test network and signing through **MetaMask**
instead of dev keys. Defaults to **Base Sepolia**; any of Ethereum / Arbitrum /
OP Sepolia work too via `RPC_URL`.

```bash
# 0) one-time
npm install
npm run compile

# 1) fund a deployer key with a little testnet ETH (gas only)
#    faucet: https://www.alchemy.com/faucets/base-sepolia
export DEPLOYER_KEY=0x<a funded testnet private key>
#    optional overrides:
#    export RPC_URL=https://sepolia.base.org   (or another supported testnet)
#    export CYCLE=120   SEED=2                 (cadence + how many pools to seed)

# 2) deploy + seed, writing addresses/ABIs into app/src (mode: "injected")
npm run deploy:testnet

# 3) run the UI
cd app
npm install
npm run dev          # opens http://localhost:5173
```

In the browser: **Connect MetaMask** (the app prompts MetaMask to switch/add the
target chain automatically) → **Browse** → **Join**. Members only need a little
native ETH for gas — the test stablecoin (mUSD) mints on demand from the app, so
no faucet is needed for the token itself.

> Only the **deployer** key is sensitive, and it's read from the `DEPLOYER_KEY`
> (or `PRIVATE_KEY`) env var — never hardcoded. Use a throwaway testnet key.

> Toolchain note: this uses a pure-npm Solidity stack (`solc` + `ganache` + `ethers`)
> instead of Foundry, because the build environment could not download Foundry/solc
> binaries. The contracts are standard Solidity and will compile under Foundry/Hardhat
> unchanged. Bytecode is compiled for the **paris** EVM (`evmVersion` in `compile.js`);
> bump this to `shanghai`/`cancun` for chains that support PUSH0.

## Contracts (`contracts/`)

| File | Role |
|---|---|
| `SubscriptionPool.sol` | Core pool: join, streaming buffer→pending accounting, reminder + auto-exclusion, proof-gated owner claim, bonds, disputes, pull-payment withdrawals. |
| `SubscriptionPoolFactory.sol` | Deploys and indexes pools. |
| `interfaces/IProofVerifier.sol` | Abstraction over a **zkTLS** oracle (zkPass / Reclaim). |
| `interfaces/IArbitrator.sol` | Kleros-style arbitrator + arbitrable interfaces. |
| `mocks/MockProofVerifier.sol` | Test double — toggles whether a proof verifies. |
| `mocks/MockArbitrator.sol` | Test double — lets the test deliver a jury ruling. |
| `mocks/MockERC20.sol` | Stand-in stablecoin (e.g. USDC). |

## How the trust mechanism works

1. **Owner** funds a bond → pool goes live.
2. **Member** joins: deposits a prepaid streaming **buffer** (≥ one cycle) + a member bond.
3. The buffer **streams** to the owner over time at `seatPrice / cycleDuration` per second,
   accrued full-precision as `seatPrice * elapsed / cycleDuration`.
   This models a Superfluid flow in self-contained, testable form.
4. As the buffer nears empty, `reminderDue()` flips true → off-chain watcher sends the
   "top up or lose your seat" notification. If unfunded, the next `settle()` **excludes**
   the member automatically (no human decides).
5. The owner can only `ownerClaim()` a member's streamed funds while that member has a
   **fresh zkTLS proof-of-access** (`submitAccessProof`) — i.e. proof the service was
   actually delivered. No proof, no payout.
6. If the owner takes money but cuts access, the member opens a **dispute**; a member-win
   ruling refunds the streamed funds **and slashes the owner's bond**. An owner-win
   releases the funds to the owner.

## What the tests cover (`test.js`, 29 assertions)

activation & join · streaming accounting · reminder near end of runway · auto-exclusion on
drain · proof-gated owner claim (blocked then allowed) · top-up extends runway · dispute
won by member (bond slash) · dispute won by owner · voluntary exit refund.

## Production swaps (nothing here is locked in)

- `MockProofVerifier` → real **Reclaim** on-chain verifier — **built**: `ReclaimAdapterVerifier`
  calls the deployed Reclaim beacon and enforces provider/member/pool/freshness bindings
  (`contracts/ReclaimAdapterVerifier.sol`, 13 tests in `test-reclaim-adapter.js`). The
  member's "Prove access" flow is wired in the app (`app/src/reclaim.js`). To run it live on
  a testnet, follow **`docs/reclaim-runbook.md`** (needs a Reclaim app id/secret + the beacon
  address for your chain). Still the riskiest dependency — scope v1 to family/household plans
  per the feasibility spike.
- `MockArbitrator` → **Kleros** court.
- Internal buffer→pending streaming → **Superfluid** Constant Flow Agreements.
- `MockERC20` → a real stablecoin (USDC, etc.).

## Known limitations (prototype scope)

- No reentrancy/economic audit; bond sizing and `slashAmount` are illustrative.
- The reminder is an on-chain *signal* (`ReminderDue` event / `reminderDue()` view); the
  actual notification is sent by an off-chain watcher.
- Proof freshness is a simple timestamp window; production needs replay protection and a
  proof scoped to the specific pool/household (the interface already passes `pool` +
  `subscriptionRef` for this).
- Does not address the **platform ToS / legal** questions — that's a go-live decision,
  separate from the tech.
