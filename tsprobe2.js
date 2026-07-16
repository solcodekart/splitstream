const ganache=require("ganache");const {ethers}=require("ethers");
async function run(opts,label){
  try{
  const server=ganache.provider({logging:{quiet:true},miner:{defaultGasPrice:0,...opts},wallet:{totalAccounts:3,defaultBalance:1000}});
  const p=new ethers.BrowserProvider(server);
  const inc=async s=>{await p.send("evm_increaseTime",[s]);await p.send("evm_mine",[]);};
  const ts=async()=>BigInt((await p.send("eth_getBlockByNumber",["latest",false])).timestamp);
  const a=await p.send("eth_accounts",[]);const s=await p.getSigner(a[0]);
  const t0=await ts();
  await inc(20);
  await (await s.sendTransaction({to:a[1],value:0})).wait();
  await (await s.sendTransaction({to:a[1],value:0})).wait();
  const t1=await ts();
  console.log(label,"elapsed:",(t1-t0).toString());
  }catch(e){console.log(label,"ERR:",e.message.slice(0,80));}
}
(async()=>{
  for(let i=0;i<4;i++) await run({timestampIncrement:0},"tsInc0");
})();
