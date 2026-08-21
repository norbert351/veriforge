import { ethers } from 'ethers';
const p=new ethers.JsonRpcProvider('https://rpc.botchain.ai',677);
const USDT='0xaBabc7Ddc03e501d190C676BF3d92ef0e6e87a3C';
const TOKEN='0x569ab13814bb10A0E661a1993c6372b40eEab57d';
const MKT='0x94cB67325217634da5B68b9DE953719057d59DA0';
const issuer=new ethers.Wallet(process.env.VERIFIER_PRIVATE_KEY,p);
const investor=new ethers.Wallet(process.env.E2E_INVESTOR_KEY,p);
const nf=async(w)=>p.getTransactionCount(w.address,'latest');
const snd=async(w,fn)=>{for(let i=0;i<8;i++){try{return await fn({nonce:await nf(w)})}catch(e){if(/nonce|replacement/i.test(String(e.message||''))){await new Promise(r=>setTimeout(r,900));continue}throw e}}throw new Error('nonce')};
const erc=['function approve(address,uint256)'];
// fund investor from issuer via transfer
await snd(issuer,o=>new ethers.Contract(USDT,['function transfer(address,uint256)'],issuer).transfer(investor.address,ethers.parseUnits('2.5',6),o)).then(t=>t.wait());
const u=new ethers.Contract(USDT,['function balanceOf(address) view returns (uint256)'],p);
const bal=await u.balanceOf(investor.address);
console.log('investor USDT after fund:', ethers.formatUnits(bal,6));
// investor buys 1 USDT primary
await snd(investor,o=>new ethers.Contract(USDT,erc,investor).approve(TOKEN,ethers.parseUnits('1',6),o)).then(t=>t.wait());
const tok=new ethers.Contract(TOKEN,['function buy(uint256) returns (uint256)','function balanceOf(address) view returns (uint256)'],p);
const r=await snd(investor,o=>new ethers.Contract(TOKEN,['function buy(uint256)'],investor).buy(ethers.parseUnits('1',6),o)).then(t=>t.wait()).catch(e=>{console.log('buy err',e.reason||e.message);process.exit(1)});
const invTok=await tok.balanceOf(investor.address);
console.log('investor units:', ethers.formatUnits(invTok,18));
// issuer holds some token? seed at exactly $10
const issTok=await tok.balanceOf(issuer.address);
console.log('issuer token:', ethers.formatUnits(issTok,18));
const SEED_T=ethers.parseUnits('0.2',18), SEED_U=ethers.parseUnits('2',6);
if(issTok<SEED_T){console.log('issuer buys token to seed');await snd(issuer,o=>new ethers.Contract(USDT,erc,issuer).approve(TOKEN,ethers.parseUnits('2',6),o)).then(t=>t.wait());await snd(issuer,o=>new ethers.Contract(TOKEN,['function buy(uint256)'],issuer).buy(ethers.parseUnits('2',6),o)).then(t=>t.wait());}
await snd(issuer,o=>new ethers.Contract(TOKEN,erc,issuer).approve(MKT,SEED_T,o)).then(t=>t.wait());
await snd(issuer,o=>new ethers.Contract(USDT,erc,issuer).approve(MKT,SEED_U,o)).then(t=>t.wait());
await snd(issuer,o=>new ethers.Contract(MKT,['function seed(uint256,uint256)'],issuer).seed(SEED_T,SEED_U,o)).then(t=>t.wait());
let price=ethers.formatUnits(await new ethers.Contract(MKT,['function price() view returns (uint256)'],p).price(),6);
console.log('SEEDED -> price',price,'USDT/unit (primary $10)');
// investor market BUY 1 USDT -> price up
await snd(investor,o=>new ethers.Contract(USDT,erc,investor).approve(MKT,ethers.parseUnits('1',6),o)).then(t=>t.wait());
await snd(investor,o=>new ethers.Contract(MKT,['function buy(uint256)'],investor).buy(ethers.parseUnits('1',6),o)).then(t=>t.wait());
price=ethers.formatUnits(await new ethers.Contract(MKT,['function price() view returns (uint256)'],p).price(),6);
console.log('after market BUY -> price',price);
// investor market SELL half -> price down
const ib=await tok.balanceOf(investor.address); const half=ib/2n;
await snd(investor,o=>new ethers.Contract(TOKEN,erc,investor).approve(MKT,half,o)).then(t=>t.wait());
await snd(investor,o=>new ethers.Contract(MKT,['function sell(uint256)'],investor).sell(half,o)).then(t=>t.wait());
price=ethers.formatUnits(await new ethers.Contract(MKT,['function price() view returns (uint256)'],p).price(),6);
console.log('after market SELL -> price',price);
console.log('DONE — market seeded at $10 with candle chart on mainnet #3');