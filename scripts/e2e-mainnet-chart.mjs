// VeriForge mainnet: FRESH issuance with the NEW SecondaryMarket (on-chain
// candle chart), seeded at exactly $10 (=primary), + buy/sell to fill the chart.
import { ethers } from 'ethers';
const RPC='https://rpc.botchain.ai', CHAIN_ID=677, API='http://localhost:4000';
const USDT='0xaBabc7Ddc03e501d190C676BF3d92ef0e6e87a3C';
const PAY_TO='0x73b16058d57a6337060677496d4A8e97A9554539';
const DOMAIN={name:'x402',version:'2',chainId:CHAIN_ID};
const EIP712={Payment:[{name:'scheme',type:'string'},{name:'network',type:'string'},{name:'chainId',type:'uint256'},{name:'asset',type:'address'},{name:'amount',type:'string'},{name:'payTo',type:'address'},{name:'maxTimeoutSeconds',type:'uint256'},{name:'description',type:'string'},{name:'extra',type:'string'}]};
const docs='Lagos Logistics Holdings operating a 50,000 sqm warehousing complex in Apapa, Lagos. JLL valuation USD 8.4m, title deed NG/LA/4521 registered. Net operating income USD 620k/yr. Custody: GeoTrust insurance + annual independent audit.';
async function main(){
  const issuer=new ethers.Wallet(process.env.VERIFIER_PRIVATE_KEY,new ethers.JsonRpcProvider(RPC));
  const investor=new ethers.Wallet(process.env.E2E_INVESTOR_KEY,issuer.provider);
  const up=await (await fetch(`${API}/v1/uploads`,{method:'POST',body:(()=>{const fd=new FormData();fd.append('file',new Blob([docs],{type:'text/plain'}),'llwf.txt');return fd;})()})).json();
  const docsUri=up.files[0].url;
  const am={assetClass:'real-estate',jurisdiction:'NG-LA',legalEntity:'Lagos Logistics Holdings Ltd',backingProofType:'JLL valuation + title deed',backingProofUri:docsUri,assetPhotos:[]};
  const payload=JSON.stringify({name:'Lagos Logistics Warehouse Fund',symbol:'LLWF',docsText:docs,docsUri,assetMetadata:am});
  const sig=await issuer.signMessage(payload);
  const body={name:'Lagos Logistics Warehouse Fund',symbol:'LLWF',pricePerTokenUsdt:10,docsText:docs,docsUri,assetMetadata:am,issuerAddress:issuer.address,issuerSignature:sig};

  const probe=await fetch(`${API}/v1/issuances`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const chall=JSON.parse(Buffer.from(probe.headers.get('payment-required')||'','base64').toString());
  const acc=chall.accepts.find(a=>Number(a.chainId)===CHAIN_ID)||chall.accepts[0];
  console.log('challenge:',acc.amount,'USDT ->',acc.payTo);
  const amt=BigInt(acc.amount);
  await new ethers.Contract(USDT,['function transfer(address,uint256)'],investor).transfer(PAY_TO,amt).then(t=>t.wait());
  const msg={scheme:acc.scheme,network:acc.network,chainId:BigInt(acc.chainId),asset:acc.asset,amount:String(acc.amount),payTo:acc.payTo,maxTimeoutSeconds:BigInt(acc.maxTimeoutSeconds),description:acc.description,extra:typeof acc.extra==='string'?acc.extra:JSON.stringify(acc.extra||{})};
  const hdr=Buffer.from(JSON.stringify({accepted:acc,signature:await investor.signTypedData(DOMAIN,EIP712,msg),payer:investor.address})).toString('base64');
  const res=await fetch(`${API}/v1/issuances`,{method:'POST',headers:{'Content-Type':'application/json','PAYMENT-SIGNATURE':hdr},body:JSON.stringify(body)});
  const data=await res.json();
  console.log('listed:',res.status,data.listed,'id',data.issuance_id);
  if(!data.listed){console.log('FAIL',JSON.stringify(data).slice(0,300));process.exit(1);}
  const {token:tokAddr,distributor:distAddr,market:mktAddr,explorer}=data.onChain;
  console.log('token',tokAddr,'market',mktAddr,'\nexplorer',explorer);
  const nf=async(w)=>issuer.provider.getTransactionCount(w.address,'latest');
  const snd=async(w,fn)=>{for(let i=0;i<8;i++){try{return await fn({nonce:await nf(w)})}catch(e){if(/nonce|replacement/i.test(String(e.message||''))){await new Promise(r=>setTimeout(r,900));continue}throw e}}throw new Error('nonce')};
  let invN=await nf(investor);
  // investor buys 1.5 USDT primary (investor started ~3, spent 1 fee -> ~1-2 left)
  await snd(investor,o=>new ethers.Contract(USDT,['function approve(address,uint256)'],investor).approve(tokAddr,ethers.parseUnits('1.5',6),o)).then(t=>t.wait());
  const tok=new ethers.Contract(tokAddr,['function buy(uint256) returns (uint256)','function balanceOf(address) view returns (uint256)'],investor);
  const u=await snd(investor,o=>tok.buy(ethers.parseUnits('1.5',6),o)).then(t=>t.wait());
  const invBal=await new ethers.Contract(tokAddr,['function balanceOf(address) view returns (uint256)'],issuer.provider).balanceOf(investor.address);
  console.log('investor bought units:',ethers.formatUnits(invBal,18));

  // issuer seeds market at EXACTLY $10: 0.2 token : 2 USDT
  const issTokBal=await new ethers.Contract(tokAddr,['function balanceOf(address) view returns (uint256)'],issuer.provider).balanceOf(issuer.address);
  console.log('issuer token bal:',ethers.formatUnits(issTokBal,18));
  const SEED_T=ethers.parseUnits('0.1',18); const SEED_U=ethers.parseUnits('1',6); // 1/0.1 = $10
  if(issTokBal < SEED_T){ console.log('issuer has no token to seed — buy some'); await snd(issuer,o=>new ethers.Contract(USDT,['function approve(address,uint256)'],issuer).approve(tokAddr,ethers.parseUnits('1',6),o)).then(t=>t.wait()); await snd(issuer,o=>new ethers.Contract(tokAddr,['function buy(uint256) returns (uint256)'],issuer).buy(ethers.parseUnits('1',6),o)).then(t=>t.wait()); }
  await snd(issuer,o=>new ethers.Contract(tokAddr,['function approve(address,uint256)'],issuer).approve(mktAddr,SEED_T,o)).then(t=>t.wait());
  await snd(issuer,o=>new ethers.Contract(USDT,['function approve(address,uint256)'],issuer).approve(mktAddr,SEED_U,o)).then(t=>t.wait());
  await snd(issuer,o=>new ethers.Contract(mktAddr,['function seed(uint256,uint256)'],issuer).seed(SEED_T,SEED_U,o)).then(t=>t.wait());
  let price=ethers.formatUnits(await new ethers.Contract(mktAddr,['function price() view returns (uint256)'],issuer.provider).price(),6);
  console.log('market seeded -> price',price,'USDT/unit  (primary $10)');

  // trade for the candle chart: investor buy 1 USDT, then sell part
  const sellBal=await new ethers.Contract(tokAddr,['function balanceOf(address) view returns (uint256)'],issuer.provider).balanceOf(investor.address);
  await snd(investor,o=>new ethers.Contract(USDT,['function approve(address,uint256)'],investor).approve(mktAddr,ethers.parseUnits('1',6),o)).then(t=>t.wait());
  await snd(investor,o=>new ethers.Contract(mktAddr,['function buy(uint256)'],investor).buy(ethers.parseUnits('1',6),o)).then(t=>t.wait());
  price=ethers.formatUnits(await new ethers.Contract(mktAddr,['function price() view returns (uint256)'],issuer.provider).price(),6);
  console.log('after buy -> price',price);
  const half=(await new ethers.Contract(tokAddr,['function balanceOf(address) view returns (uint256)'],issuer.provider).balanceOf(investor.address))/2n;
  await snd(investor,o=>new ethers.Contract(tokAddr,['function approve(address,uint256)'],investor).approve(mktAddr,half,o)).then(t=>t.wait());
  await snd(investor,o=>new ethers.Contract(mktAddr,['function sell(uint256)'],investor).sell(half,o)).then(t=>t.wait());
  price=ethers.formatUnits(await new ethers.Contract(mktAddr,['function price() view returns (uint256)'],issuer.provider).price(),6);
  console.log('after sell -> price',price);
  console.log('DONE — issuance',data.issuance_id,'with candle chart');
}
main().catch(e=>{console.error('ERR:',e.reason||e.shortMessage||e.message);process.exit(1)});