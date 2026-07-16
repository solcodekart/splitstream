const { ethers } = require("ethers");
(async () => {
  const RPC = "http://127.0.0.1:8545";
  const p = new ethers.JsonRpcProvider(RPC);
  const MN = "myth like bonus scare over problem client lizard pioneer submit female collect";
  const base = ethers.HDNodeWallet.fromPhrase(MN, undefined, "m/44'/60'/0'/0/0").connect(p);
  const dest = ethers.HDNodeWallet.fromPhrase(MN, undefined, "m/44'/60'/0'/0/1").address;
  async function blast(signer, label) {
    try {
      const txs = [];
      for (let i = 0; i < 8; i++) txs.push(signer.sendTransaction({ to: dest, value: 1n }));
      const sent = await Promise.all(txs);
      await Promise.all(sent.map(t => t.wait()));
      console.log(label + ": OK (8 rapid txs mined, no nonce collision)");
    } catch (e) {
      console.log(label + ": FAILED -> " + (e.shortMessage || e.message).split("\n")[0]);
    }
  }
  await blast(base, "raw signer      ");
  const base2 = ethers.HDNodeWallet.fromPhrase(MN, undefined, "m/44'/60'/0'/0/2").connect(p);
  await blast(new ethers.NonceManager(base2), "NonceManager    ");
})();
