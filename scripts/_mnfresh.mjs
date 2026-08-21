// VeriForge mainnet: create a FRESH issuance using the NEW SecondaryMarket
// contract, seed at $10 (=primary), add buy+sell so the candle chart populates.
import { ethers } from 'ethers';
const RPC='https://rpc.botchain.ai', CHAIN=677, API='http://localhost:4000';
const USDT='0xaBabc7Ddc03e501d190C676BF3d92ef0e6e87a3C';
async function main(){
  const issuerMsg=JSON.parse(process.env.E2E_ISSUER_JSON||'{}');
  // ... placeholder
}
main().catch(e=>console.error('ERR',e.message));