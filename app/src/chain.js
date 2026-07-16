// Thin ethers v6 layer over the deployed contracts.
// Works in two modes, chosen by app/src/deployed.json (written by a deploy script):
//   • "local"    — ganache dev accounts, signs with baked-in private keys
//   • "injected" — public testnet, signs through MetaMask (window.ethereum)
import { ethers } from "ethers";
import deployed from "./deployed.json";
import abis from "./abis.json";

export const configured =
  !!deployed.contracts && !!deployed.contracts.factory && !!abis.SubscriptionPool;

export const CFG = deployed;
export const DECIMALS = deployed.tokenDecimals ?? 18;
export const CYCLE = deployed.cycleDuration ?? 120;
export const REMINDER_WINDOW = deployed.reminderWindow ?? 20;
export const ACCOUNTS = deployed.accounts ?? [];

// Mode: explicit field wins; otherwise infer from whether dev keys are present.
export const MODE = deployed.mode || (ACCOUNTS.length ? "local" : "injected");
export const CHAIN = deployed.chain || null; // testnet metadata (name, currency, explorer…)
export const EXPLORER = CHAIN?.explorer || null;

const netHint = CHAIN?.chainId || deployed.chainId;
// Read-only provider — pools load even before a wallet is connected.
export const provider = configured ? new ethers.JsonRpcProvider(deployed.rpcUrl, netHint) : null;

// amount helpers
export const toUnits = (x) => ethers.parseUnits(String(x), DECIMALS);
export const fromUnits = (x) => Number(ethers.formatUnits(x, DECIMALS));
export const fmt = (x) => fromUnits(x).toFixed(2);

// ── signers ─────────────────────────────────────────────────────────────────
let injectedSigner = null;

// Local mode: build a Wallet from a dev private key.
export function signerFor(privateKey) {
  return new ethers.Wallet(privateKey, provider);
}

// The signer used to send writes for the connected account.
export function getWriteSigner(acct) {
  if (acct?.injected) return injectedSigner;
  return signerFor(acct.privateKey);
}

function chainIdHex() {
  return "0x" + Number(CHAIN.chainId).toString(16);
}

// Ask the wallet to switch to (or add) the target chain.
async function ensureChain() {
  if (!CHAIN) return;
  const hex = chainIdHex();
  try {
    await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
  } catch (e) {
    const code = e?.code ?? e?.data?.originalError?.code;
    if (code === 4902) {
      await window.ethereum.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: hex,
          chainName: CHAIN.name,
          nativeCurrency: CHAIN.currency,
          rpcUrls: CHAIN.rpcUrls,
          blockExplorerUrls: EXPLORER ? [EXPLORER] : [],
        }],
      });
    } else {
      throw e;
    }
  }
}

// Injected mode: connect MetaMask, ensure correct network, return the account.
export async function connectInjected() {
  if (typeof window === "undefined" || !window.ethereum) {
    throw new Error("No wallet found — install MetaMask to connect.");
  }
  await ensureChain();
  const bp = new ethers.BrowserProvider(window.ethereum);
  await bp.send("eth_requestAccounts", []);
  injectedSigner = await bp.getSigner();
  const address = await injectedSigner.getAddress();
  // reload on account / network change so state never goes stale
  if (window.ethereum.on) {
    window.ethereum.on("accountsChanged", () => location.reload());
    window.ethereum.on("chainChanged", () => location.reload());
  }
  return { label: "MetaMask", address, injected: true };
}

// ── contract factories ───────────────────────────────────────────────────────
export function factory(runner) {
  return new ethers.Contract(deployed.contracts.factory, abis.SubscriptionPoolFactory, runner ?? provider);
}
export function pool(addr, runner) {
  return new ethers.Contract(addr, abis.SubscriptionPool, runner ?? provider);
}
export function token(runner) {
  return new ethers.Contract(deployed.contracts.token, abis.MockERC20, runner ?? provider);
}
export function verifier(runner) {
  return new ethers.Contract(deployed.contracts.verifier, abis.MockProofVerifier, runner ?? provider);
}
// Mock arbitrator (stands in for Kleros). Minimal inline ABI so the dispute demo
// works without regenerating abis.json — `giveRuling` relays a verdict back into
// the pool's `rule()`. In production a real court delivers this, not the app.
const ARBITRATOR_ABI = [
  "function giveRuling(uint256 disputeId, uint256 ruling) external",
  "function createDispute(uint256 choices, bytes extraData) payable returns (uint256)",
];
export function arbitrator(runner) {
  return new ethers.Contract(deployed.contracts.arbitrator, ARBITRATOR_ABI, runner ?? provider);
}

const MAX = ethers.MaxUint256;

// Ensure `ownerSigner` holds at least `amount` of the test token.
// MockERC20.mint is public — this doubles as a faucet on a public testnet so a
// fresh wallet can try the app. (A real stablecoin pool would remove this.)
export async function ensureBalance(ownerSigner, amount) {
  const t = token(ownerSigner);
  const who = await ownerSigner.getAddress();
  const bal = await t.balanceOf(who);
  if (bal < amount) {
    await (await t.mint(who, amount - bal)).wait();
  }
}

// Ensure `ownerSigner` has approved `spender` for at least `amount`.
export async function ensureApproval(ownerSigner, spender, amount) {
  const t = token(ownerSigner);
  const current = await t.allowance(await ownerSigner.getAddress(), spender);
  if (current < amount) {
    await (await t.approve(spender, MAX)).wait();
  }
}

// ── reads ─────────────────────────────────────────────────────────────────────
export async function loadPools() {
  const f = factory();
  const count = Number(await f.poolCount());
  const out = [];
  for (let i = 0; i < count; i++) {
    const addr = await f.allPools(i);
    const c = pool(addr);
    const [metaRaw, owner, seatPrice, seatCount, seatsTaken, active, ownerBond, openDisputes] = await Promise.all([
      c.metadata(), c.owner(), c.seatPrice(), c.seatCount(), c.seatsTaken(), c.active(), c.ownerBondBalance(), c.openDisputes(),
    ]);
    let meta;
    try { meta = JSON.parse(metaRaw); }
    catch { meta = { platform: "spotify", region: "?", plan: metaRaw }; }
    out.push({
      address: addr, owner, meta, seatPrice,
      seatCount: Number(seatCount), seatsTaken: Number(seatsTaken), active, ownerBond,
      openDisputes: Number(openDisputes),
    });
  }
  return out;
}

// Member view for `who` on a given pool address.
export async function loadMember(poolAddr, who) {
  const c = pool(poolAddr);
  const [m, runway, reminder, wd] = await Promise.all([
    c.members(who), c.runwaySeconds(who), c.reminderDue(who), c.withdrawable(who),
  ]);
  return {
    buffer: m.buffer, pending: m.pending, bond: m.bond,
    joined: m.joined, isActive: m.isActive, inDispute: m.inDispute,
    withdrawable: wd, runway: Number(runway), reminderDue: reminder,
  };
}

// Members of a pool, discovered from Joined events (works in both modes —
// no dev-account list required on a public testnet).
export async function loadJoinedMembers(poolAddr) {
  const c = pool(poolAddr);
  let evs = [];
  try { evs = await c.queryFilter(c.filters.Joined()); } catch { evs = []; }
  const addrs = [...new Set(evs.map((e) => e.args.member))];
  const labelOf = (a) =>
    ACCOUNTS.find((x) => x.address.toLowerCase() === a.toLowerCase())?.label || (a.slice(0, 6) + "…" + a.slice(-4));
  const out = [];
  for (const a of addrs) {
    out.push({ address: a, label: labelOf(a), m: await loadMember(poolAddr, a) });
  }
  return out;
}

// The open dispute id for `who` on a pool, read from the pool's DisputeRaised
// events (needed to relay a verdict through the mock arbitrator's giveRuling).
export async function latestDisputeId(poolAddr, who) {
  const c = pool(poolAddr);
  let evs = [];
  try { evs = await c.queryFilter(c.filters.DisputeRaised(who)); } catch { evs = []; }
  if (!evs.length) return null;
  return evs[evs.length - 1].args.disputeId;
}
