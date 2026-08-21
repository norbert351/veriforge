import { ethers } from 'ethers';
const p=new ethers.JsonRpcProvider('https://rpc.botchain.ai',677);
const F2='0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f';
const WBOT='0xD5452816194a3784dBa983426cCe7c122F4abd30';
const USDT='0xaBabc7Ddc03e501d190C676BF3d92ef0e6e87a3C';
console.log('v2 factory code?', (await p.getCode(F2)).length>2);
if((await p.getCode(F2)).length>2){
  const f=new ethers.Contract(F2,['function getPair(address,address) view returns (address)'],p);
  const pair=await f.getPair(WBOT,USDT);
  console.log('WBOT/USDT V2 pair:', pair, 'code?', (await p.getCode(pair)).length>2);
}
// probe known V2 router selectors on mainnet
const ROUTER='0xaE6ae8630f7A888dEc0B9195C85F7515d5887655';
const probe=['swapExactETHForTokens','swapExactTokensForTokens','swapExactTokensForTokensSupportingFeeOnTransferTokens','getAmountsOut','swapExactETHForTokensSupportingFeeOnTransferTokens'];
for(const name of probe){const sel=id4sig(name);const code=await p.getCode(ROUTER);if(code.includes(sel.blade... 
