// Deploys the stack to a public testnet (default: Base Sepolia) and writes
// app/src/deployed.json in "injected" mode so the frontend signs via MetaMask.
//
//   1) compile:  npm run compile
//   2) set env:  export DEPLOYER_KEY=0x<a funded testnet private key>
//                (optional) export RPC_URL=https://sepolia.base.org
//                (optional) export CYCLE=120   SEED=2
//   3) deploy:   npm run deploy:testnet
//
// Get test ETH from a faucet (e.g. https://www.alchemy.com/faucets/base-sepolia).
// The mUSD test token mints freely from the app, so members don't need a faucet
// for the stablecoin — only a little native ETH for gas.
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const ROOT = path.join(__dirname, "..");

// Known testnets. `defaultRpc` is used for both deploy + the frontend's reads
// unless RPC_URL overrides it.
const CHAINS = {
  84532: { name: "Base Sepolia", defaultRpc: "https://sepolia.base.org", explorer: "https://sepolia.basescan.org" },
  11155111: { name: "Ethereum Sepolia", defaultRpc: "https://ethereum-sepolia-rpc.publicnode.com", explorer: "https://sepolia.etherscan.io" },
  421614: { name: "Arbitrum Sepolia", defaultRpc: "https://sepolia-rollup.arbitrum.io/rpc", explorer: "https://sepolia.arbiscan.io" },
  11155420: { name: "OP Sepolia", defaultRpc: "https://sepolia.optimism.io", explorer: "https://sepolia-optimism.etherscan.io" },
};
const ETH = { name: "Ether", symbol: "ETH", decimals: 18 };

const artifacts = JSON.parse(fs.readFileSync(path.join(ROOT, "out", "artifacts.json"), "utf8"));

const DEC = 18;
const u = (x) => ethers.parseUnits(String(x), DEC);
const CYCLE = BigInt(process.env.CYCLE || 120);
const REMINDER = 20n;
const SEED = Number(process.env.SEED ?? 2);

// ── Optional: wire the REAL Reclaim zkTLS verifier instead of MockProofVerifier ──
// Set all four to switch the pool's proof gate to ReclaimAdapterVerifier, which calls
// the already-deployed Reclaim beacon on this chain. Leave any unset to keep the mock
// demo path (host toggles proofs). See docs/reclaim-runbook.md for how to obtain these.
//   RECLAIM_ADDRESS        deployed Reclaim beacon for THIS chain (from Reclaim's Addresses.sol)
//   RECLAIM_APP_ID         application id from dev.reclaimprotocol.org
//   RECLAIM_PROVIDER_ID    provider id (the httpProvider you configured in the dashboard)
//   RECLAIM_PROVIDER_NAME  the exact string that appears as claimInfo.provider in a generated
//                          proof — subscriptionRef == keccak256(bytes(this))
const RC = {
  address: process.env.RECLAIM_ADDRESS,
  appId: process.env.RECLAIM_APP_ID,
  providerId: process.env.RECLAIM_PROVIDER_ID,
  providerName: process.env.RECLAIM_PROVIDER_NAME,
};
const USE_RECLAIM = !!(RC.address && RC.appId && RC.providerId && RC.providerName);

const COMMON = {
  cycleDuration: CYCLE,
  ownerBondRequired: u(30),
  memberBondRequired: u(2),
  proofValidity: 600n,
  reminderWindow: REMINDER,
  slashAmount: u(30),
};
const SEED_POOLS = [
  { platform: "spotify", region: "EU", plan: "Premium Family", seatPrice: u("4.25"), seatCount: 6n },
  { platform: "netflix", region: "US", plan: "Premium 4K", seatPrice: u("6.99"), seatCount: 5n },
  { platform: "youtube", region: "EU", plan: "Premium Family", seatPrice: u("4.99"), seatCount: 6n },
];

async function main() {
  const key = process.env.DEPLOYER_KEY || process.env.PRIVATE_KEY;
  if (!key) {
    console.error("\nSet a funded testnet key first:\n  export DEPLOYER_KEY=0x...\n");
    process.exit(1);
  }

  // Resolve RPC: explicit RPC_URL, else default for the connected chain.
  let rpcUrl = process.env.RPC_URL || CHAINS[84532].defaultRpc;
  let provider = new ethers.JsonRpcProvider(rpcUrl);
  const net = await provider.getNetwork();
  const chainId = Number(net.chainId);
  const known = CHAINS[chainId];
  if (!process.env.RPC_URL && !known) {
    console.error(`\nUnknown chainId ${chainId}. Pass RPC_URL explicitly.\n`);
    process.exit(1);
  }
  const chainMeta = known || { name: `Chain ${chainId}`, defaultRpc: rpcUrl, explorer: "" };

  const deployer = new ethers.Wallet(key, provider);
  const bal = await provider.getBalance(deployer.address);
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Chain:    ${chainMeta.name} (${chainId})`);
  console.log(`Balance:  ${ethers.formatEther(bal)} ETH`);
  if (bal === 0n) {
    console.error("\nDeployer has 0 ETH — fund it from a faucet first.\n");
    process.exit(1);
  }

  async function deploy(name, args = []) {
    const f = new ethers.ContractFactory(artifacts[name].abi, artifacts[name].bytecode, deployer);
    const c = await f.deploy(...args);
    await c.waitForDeployment();
    return c;
  }

  console.log("\nDeploying core contracts…");
  // Proof gate: real Reclaim adapter when configured, else the mock demo verifier.
  const verifier = USE_RECLAIM
    ? await deploy("ReclaimAdapterVerifier", [RC.address, COMMON.proofValidity])
    : await deploy("MockProofVerifier");
  if (USE_RECLAIM) {
    console.log("  verifier: ReclaimAdapterVerifier ->", await verifier.getAddress());
    console.log("            reclaim beacon:", RC.address);
  }
  const arbitrator = await deploy("MockArbitrator");
  const token = await deploy("MockERC20");
  const factory = await deploy("SubscriptionPoolFactory", [
    await verifier.getAddress(), await arbitrator.getAddress(),
  ]);
  const tokenAddr = await token.getAddress();
  const factoryAddr = await factory.getAddress();
  console.log("  factory:", factoryAddr);
  console.log("  token:  ", tokenAddr);

  const seeds = SEED_POOLS.slice(0, Math.max(0, SEED));
  if (seeds.length) {
    console.log("\nSeeding pools…");
    // mint enough mUSD to cover all owner bonds
    await (await token.mint(deployer.address, COMMON.ownerBondRequired * BigInt(seeds.length) + u(1000))).wait();
    for (const sp of seeds) {
      const metadata = JSON.stringify({ platform: sp.platform, region: sp.region, plan: sp.plan });
      // subscriptionRef: with the real adapter it MUST be keccak256(providerName) so a
      // Reclaim proof for that provider unlocks the pool; in mock mode any ref works, so
      // we key it off the metadata for readability.
      const subscriptionRef = USE_RECLAIM ? ethers.id(RC.providerName) : ethers.id(metadata);
      const params = [
        tokenAddr, sp.seatPrice, COMMON.cycleDuration, sp.seatCount,
        COMMON.ownerBondRequired, COMMON.memberBondRequired, COMMON.proofValidity,
        COMMON.reminderWindow, COMMON.slashAmount, subscriptionRef, metadata,
      ];
      await (await factory.createPool(params)).wait();
      const count = await factory.poolCount();
      const poolAddr = await factory.allPools(count - 1n);
      await (await token.approve(poolAddr, COMMON.ownerBondRequired)).wait();
      const pool = new ethers.Contract(poolAddr, artifacts["SubscriptionPool"].abi, deployer);
      await (await pool.fundOwnerBond()).wait();
      console.log(`  • ${sp.platform.padEnd(8)} ${poolAddr}`);
    }
  }

  const deployed = {
    mode: "injected",
    rpcUrl,
    tokenDecimals: DEC,
    cycleDuration: Number(CYCLE),
    reminderWindow: Number(REMINDER),
    chain: {
      chainId,
      name: chainMeta.name,
      currency: ETH,
      rpcUrls: [rpcUrl],
      explorer: chainMeta.explorer,
    },
    contracts: {
      factory: factoryAddr,
      token: tokenAddr,
      verifier: await verifier.getAddress(),
      arbitrator: await arbitrator.getAddress(),
    },
    // Present only when the real adapter is wired — the frontend reads this to enable
    // the member's "Prove access" (Reclaim) flow. The app secret is NOT written here;
    // it's read from VITE_RECLAIM_APP_SECRET at build/run time (never commit it).
    ...(USE_RECLAIM ? {
      reclaim: { appId: RC.appId, providerId: RC.providerId, providerName: RC.providerName, beacon: RC.address },
    } : {}),
  };
  const abis = {
    SubscriptionPoolFactory: artifacts["SubscriptionPoolFactory"].abi,
    SubscriptionPool: artifacts["SubscriptionPool"].abi,
    MockERC20: artifacts["MockERC20"].abi,
    MockProofVerifier: artifacts["MockProofVerifier"].abi,
    ReclaimAdapterVerifier: artifacts["ReclaimAdapterVerifier"].abi,
  };

  const outDir = path.join(ROOT, "app", "src");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "deployed.json"), JSON.stringify(deployed, null, 2));
  fs.writeFileSync(path.join(outDir, "abis.json"), JSON.stringify(abis, null, 2));

  console.log("\nWrote app/src/deployed.json (injected / " + chainMeta.name + ") and abis.json");
  if (chainMeta.explorer) console.log("Explorer:", `${chainMeta.explorer}/address/${factoryAddr}`);
  console.log("\nNext:  cd app && npm install && npm run dev   (connect MetaMask on " + chainMeta.name + ")");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
