// Deploys the full stack to a local ganache chain (http://127.0.0.1:8545) and
// writes the addresses + ABIs the frontend needs into app/src/.
//
//   1) compile:  npm run compile            (produces out/artifacts.json)
//   2) chain:    npm run chain              (ganache on :8545, mines every 1s)
//   3) deploy:   npm run deploy             (this script)
//
// Uses ganache's deterministic accounts so the frontend can sign with known
// dev keys — no MetaMask needed.
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const ROOT = path.join(__dirname, "..");
const RPC_URL = "http://127.0.0.1:8545";

// ganache --deterministic mnemonic (well-known, dev only — never use on mainnet)
const MNEMONIC = "myth like bonus scare over problem client lizard pioneer submit female collect";

const artifacts = JSON.parse(
  fs.readFileSync(path.join(ROOT, "out", "artifacts.json"), "utf8")
);

const DEC = 18;
const u = (x) => ethers.parseUnits(String(x), DEC);

// Compressed demo cadence so the stream visibly drains. A real pool would use
// cycleDuration = 30 days; here one "cycle" is 120s.
const COMMON = {
  cycleDuration: 120n,
  seatCount: 6n,
  ownerBondRequired: u(30),
  memberBondRequired: u(2),
  proofValidity: 600n,
  reminderWindow: 20n,
  slashAmount: u(30),
};

const SEED_POOLS = [
  { platform: "spotify", region: "EU", plan: "Premium Family", seatPrice: u("4.25"), seatCount: 6n },
  { platform: "netflix", region: "US", plan: "Premium 4K", seatPrice: u("6.99"), seatCount: 5n },
  { platform: "youtube", region: "EU", plan: "Premium Family", seatPrice: u("4.99"), seatCount: 6n },
  { platform: "disney", region: "UK", plan: "Premium", seatPrice: u("3.50"), seatCount: 4n },
];

const ACCOUNT_LABELS = ["Owner", "Alice", "Bob", "Carla", "Dan", "Erin"];

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);

  // Sanity: is a chain up?
  try {
    await provider.getBlockNumber();
  } catch (e) {
    console.error(
      "\nCannot reach a chain at " + RPC_URL +
      ".\nStart one first in another terminal:\n  npm run chain\n"
    );
    process.exit(1);
  }

  // Derive the deterministic dev wallets.
  const accounts = [];
  for (let i = 0; i < ACCOUNT_LABELS.length; i++) {
    const w = ethers.HDNodeWallet.fromPhrase(MNEMONIC, undefined, `m/44'/60'/0'/0/${i}`).connect(provider);
    accounts.push({ label: ACCOUNT_LABELS[i], address: w.address, privateKey: w.privateKey, wallet: w });
  }
  // "Owner" hosts the seed pools. Wrap it in a NonceManager: ganache mines on a
  // fixed interval (`--miner.blockTime 1`), so `eth_getTransactionCount` can briefly
  // lag behind the pending pool and hand ethers a nonce that's already been used
  // ("tx doesn't have the correct nonce"). NonceManager tracks the next nonce
  // locally and increments it per send, so back-to-back txs never collide.
  const deployer = new ethers.NonceManager(accounts[0].wallet);

  async function deploy(name, signer, args = []) {
    const f = new ethers.ContractFactory(artifacts[name].abi, artifacts[name].bytecode, signer);
    const c = await f.deploy(...args);
    await c.waitForDeployment();
    return c;
  }

  console.log("Deploying core contracts…");
  const verifier = await deploy("MockProofVerifier", deployer);
  const arbitrator = await deploy("MockArbitrator", deployer);
  const token = await deploy("MockERC20", deployer);
  const factory = await deploy("SubscriptionPoolFactory", deployer, [
    await verifier.getAddress(),
    await arbitrator.getAddress(),
  ]);

  const tokenAddr = await token.getAddress();
  const factoryAddr = await factory.getAddress();

  console.log("Minting mUSD to dev accounts…");
  for (const a of accounts) {
    await (await token.mint(a.address, u(100000))).wait();
  }

  console.log("Seeding pools…");
  for (const sp of SEED_POOLS) {
    const metadata = JSON.stringify({
      platform: sp.platform,
      region: sp.region,
      plan: sp.plan,
    });
    const params = [
      tokenAddr,
      sp.seatPrice,
      COMMON.cycleDuration,
      sp.seatCount,
      COMMON.ownerBondRequired,
      COMMON.memberBondRequired,
      COMMON.proofValidity,
      COMMON.reminderWindow,
      COMMON.slashAmount,
      ethers.id(metadata), // bytes32 subscriptionRef
      metadata,
    ];
    await (await factory.connect(deployer).createPool(params)).wait();

    const count = await factory.poolCount();
    const poolAddr = await factory.allPools(count - 1n);

    // Owner posts the bond to activate the pool.
    await (await token.connect(deployer).approve(poolAddr, COMMON.ownerBondRequired)).wait();
    const pool = new ethers.Contract(poolAddr, artifacts["SubscriptionPool"].abi, deployer);
    await (await pool.fundOwnerBond()).wait();
    console.log(`  • ${sp.platform.padEnd(8)} ${poolAddr}`);
  }

  const network = await provider.getNetwork();

  const deployed = {
    mode: "local",
    rpcUrl: RPC_URL,
    chainId: Number(network.chainId),
    tokenDecimals: DEC,
    cycleDuration: Number(COMMON.cycleDuration),
    reminderWindow: Number(COMMON.reminderWindow),
    contracts: {
      factory: factoryAddr,
      token: tokenAddr,
      verifier: await verifier.getAddress(),
      arbitrator: await arbitrator.getAddress(),
    },
    accounts: accounts.map((a) => ({ label: a.label, address: a.address, privateKey: a.privateKey })),
  };

  const abis = {
    SubscriptionPoolFactory: artifacts["SubscriptionPoolFactory"].abi,
    SubscriptionPool: artifacts["SubscriptionPool"].abi,
    MockERC20: artifacts["MockERC20"].abi,
    MockProofVerifier: artifacts["MockProofVerifier"].abi,
  };

  const outDir = path.join(ROOT, "app", "src");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "deployed.json"), JSON.stringify(deployed, null, 2));
  fs.writeFileSync(path.join(outDir, "abis.json"), JSON.stringify(abis, null, 2));

  console.log("\nWrote app/src/deployed.json and app/src/abis.json");
  console.log("Factory:", factoryAddr);
  console.log("Token:  ", tokenAddr);
  console.log("\nNext:  cd app && npm install && npm run dev");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
