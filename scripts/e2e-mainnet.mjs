// VeriForge REAL MAINNET (677) trimmed e2e — small amounts to fit ~6 USDT budget.
import { ethers } from "ethers";
const RPC="https://rpc.botchain.ai", CHAIN_ID=677, API="http://localhost:4000";
const USDT="0xaBabc7Ddc03e501d190C676BF3d92ef0e6e87a3C";
const PAY_TO="0x73b16058d57a6337060677496d4A8e97A9554539";
const ISSUER_KEY=process.env.VERIFIER_PRIVATE_KEY;
const INVESTOR_KEY=process.env.E2E_INVESTOR_KEY;
const provider=new ethers.JsonRpcProvider(RPC,CHAIN_ID,{staticNetwork:true});
const issuer=new ethers.Wallet(ISSUER_KEY,provider);
const investor=new ethers.Wallet(INVESTOR_KEY,provider);
const ATTEST='0xF7ed39F4401062d9A5c45B7583d299887c5Cd560';
const EIP712={Payment:[{name:"scheme",type:"string"},{name:"network",type:"string"},{name:"chainId",type:"uint256"},{name:"asset",type:"address"},{name:"amount",type:"string"},{name:"payTo",type:"address"},{name:"maxTimeoutSeconds",type:"uint256"},{name:"description",type:"string"},{name:"extra",type:"string"}]};
const DOMAIN={name:"x402",version:"2",chainId:CHAIN_ID};

async function main(){
  // 1. probe + pay 1 USDT
  const docs=`Asset: Lagos Logistics Warehouse Fund (LLWF).\nBacking: 42,000 m2 warehousing in Lagos valued at 18.4M USDT by a 2026-07-15 JLL valuation with title deed refs LLT-4471/72/73 on file.\nRevenue model: Lease yield of 6.9% gross per annum from triple-net logistics leases, NOI 980k USDT p.a., distributed quarterly in USDT.\nLegal: Issued by Lagos Logistics Holdings Ltd, RC 4829102, under Nigerian SCA RWA guidance.\nTerms: 400,000 units at 10 USDT each. Quarterly distributions. No leverage.`;
  const upRes=await fetch(`${API}/v1/uploads`,{method:"POST",body:(()=>{const fd=new FormData();fd.append("file",new Blob([docs],{type:"text/plain"}),"llwf.txt");return fd;})()});
  const up=await upRes.json(); const docsUri=up.files[0].url;
  const assetMetadata={assetClass:"real-estate",jurisdiction:"NG-LA",legalEntity:"Lagos Logistics Holdings Ltd",backingProofType:"JLL valuation + title deed",backingProofUri:docsUri,assetPhotos:[]};
  const payloadJson=JSON.stringify({name:"Lagos Logistics Warehouse Fund",symbol:"LLWF",docsText:docs,docsUri,assetMetadata});
  const payloadHash=ethers.keccak256(ethers.toUtf8Bytes(payloadJson));
  const issuerSignature=await issuer.signMessage(payloadJson);
  console.log("1. signed declaration", payloadHash.slice(0,18)+"...");
  const body={name:"Lagos Logistics Warehouse Fund",symbol:"LLWF",pricePerTokenUsdt:10,docsText:docs,docsUri,assetMetadata,issuerAddress:issuer.address,issuerSignature};

  const probe=await fetch(`${API}/v1/issuances`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
  console.log("2. probe:",probe.status);
  const chall=JSON.parse(Buffer.from(probe.headers.get("payment-required")||"","base64").toString());
  const acc=chall.accepts.find(a=>Number(a.chainId)===CHAIN_ID)||chall.accepts[0];
  console.log("   challenge:",acc.amount,acc.payTo,acc.chainId);
  const amt=BigInt(acc.amount);
  const usdtInv=new ethers.Contract(USDT,["function transfer(address,uint256)"],investor);
  const payTx=await usdtInv.transfer(PAY_TO,amt); await payTx.wait();
  console.log("3. paid",ethers.formatUnits(amt,6),"USDT tx",payTx.hash);
  const msg={scheme:acc.scheme,network:acc.network,chainId:BigInt(acc.chainId),asset:acc.asset,amount:String(acc.amount),payTo:acc.payTo,maxTimeoutSeconds:BigInt(acc.maxTimeoutSeconds),description:acc.description,extra:typeof acc.extra==="string"?acc.extra:JSON.stringify(acc.extra||{})};
  const sig=await investor.signTypedData(DOMAIN,EIP712,msg);
  const header=Buffer.from(JSON.stringify({accepted:acc,signature:sig,payer:investor.address})).toString("base64");
  const res=await fetch(`${API}/v1/issuances`,{method:"POST",headers:{"Content-Type":"application/json","PAYMENT-SIGNATURE":header},body:JSON.stringify(body)});
  const data=await res.json();
  console.log("4. status",res.status,"listed",data.listed,"id",data.issuance_id);
  if(!data.listed){console.log("STOP",JSON.stringify(data));return;}
  console.log("   onChain:",JSON.stringify(data.onChain));
  const tokenAddr=data.onChain.token, distAddr=data.onChain.distributor, mktAddr=data.onChain.market;
  console.log("   dossier",data.dossier?.verdict,data.dossier?.score);

  // verify
  const ar=new ethers.Contract(ATTEST,["function getAttestation(address) view returns ((address target,uint96 score,uint8 verdict,uint64 findingsHash,string reportUri,bytes32 payloadHash,uint64 attestedAt,uint64 blockNumber))"],provider);
  const a=await ar.getAttestation(tokenAddr);
  console.log("5. on-chain attestation payloadHash match:", a.payloadHash===payloadHash);

  // buy 2 USDT primary
  const nf=async(w)=>provider.getTransactionCount(w.address,"latest");
  const snd=async(w,fn)=>{for(let i=0;i<8;i++){try{return await fn({nonce:await nf(w)})}catch(e){if(/nonce|replacement/i.test(String(e.message||""))){await new Promise(r=>setTimeout(r,900));continue}throw e}}throw new Error("nonce")};
  let invNonce=await nf(investor);
  await new ethers.Contract(USDT,["function approve(address,uint256)"],investor).approve(tokenAddr,ethers.parseUnits("2",6),{nonce:invNonce++}).then(t=>t.wait());
  const token=new ethers.Contract(tokenAddr,["function buy(uint256) returns (uint256)","function balanceOf(address) view returns (uint256)"],investor);
  await token.buy(ethers.parseUnits("2",6),{nonce:invNonce++}).then(t=>t.wait());
  console.log("6. investor bought 2 USDT ->",ethers.formatUnits(await token.balanceOf(investor.address),18),"units");

  // revenue deposit 2 USDT (issuer)
  await snd(issuer,(o)=>new ethers.Contract(USDT,["function approve(address,uint256)"],issuer).approve(distAddr,ethers.parseUnits("2",6),o)).then(t=>t.wait());
  await snd(issuer,(o)=>new ethers.Contract(distAddr,["function deposit(uint256)"],issuer).deposit(ethers.parseUnits("2",6),o)).then(t=>t.wait());
  console.log("7. issuer deposited 2 USDT revenue");

  // claim
  await new ethers.Contract(distAddr,["function claim() returns (uint256)"],investor).claim({nonce:invNonce++}).then(t=>t.wait());
  console.log("8. investor claimed");

  // secondary market
  if(mktAddr){
    await snd(issuer,(o)=>new ethers.Contract(USDT,["function approve(address,uint256)"],issuer).approve(tokenAddr,ethers.parseUnits("5",6),o)).then(t=>t.wait());
    await snd(issuer,(o)=>new ethers.Contract(tokenAddr,["function buy(uint256) returns (uint256)"],issuer).buy(ethers.parseUnits("5",6),o)).then(t=>t.wait());
    const issTok=await new ethers.Contract(tokenAddr,["function balanceOf(address) view returns (uint256)"],provider).balanceOf(issuer.address);
    const unit1=issTok/5n; const usd1=ethers.parseUnits("10",6); // 1 unit -> 10 usdt
    await snd(issuer,(o)=>new ethers.Contract(tokenAddr,["function approve(address,uint256)"],issuer).approve(mktAddr,unit1,o)).then(t=>t.wait());
    await snd(issuer,(o)=>new ethers.Contract(USDT,["function approve(address,uint256)"],issuer).approve(mktAddr,usd1,o)).then(t=>t.wait());
    await snd(issuer,(o)=>new ethers.Contract(mktAddr,["function seed(uint256,uint256)"],issuer).seed(unit1,usd1,o)).then(t=>t.wait());
    const mkt=new ethers.Contract(mktAddr,["function price() view returns (uint256)"],provider);
    console.log("9. market seeded, price",ethers.formatUnits(await mkt.price(),6));
  } else console.log("9. no market on this issuance");

  console.log("\nMAINNET LOOP OK  issuance_id",data.issuance_id,"token",tokenAddr);
}
main().catch(e=>{console.error("FAIL:",e?.reason||e?.shortMessage||e?.message||e);process.exit(1);});
