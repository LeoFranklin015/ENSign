import { CHAINS } from "../../src/chains.js";
import { EthProver, toUnpaddedHex } from "../../src/index.js";
import { createProvider, providerURL } from "../providers.js";

console.log(providerURL(CHAINS.POLYGON_POS));

const p = createProvider(CHAINS.POLYGON_POS);

const b1 = await p.getBlockNumber();
let b = b1 - 1000;
//b = 61888148;
console.log(b1, b, b1 - b);

const prover = new EthProver(p, toUnpaddedHex(b));

// //0x5bbf0fd3dd8252ee03ba9c03cf92f33551584361
// console.log(await prover.getStorage(
// 	'0xe43d741e21d8bf30545a88c46e4ff5681518ebad', 
// 	0n,
// ));
