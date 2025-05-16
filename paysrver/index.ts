// server.js
require("dotenv").config();
import express from "express";
import axios from "axios";
import { ethers } from "ethers";

const app = express();
app.use(express.json());

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const {
  RPC_URL,               // e.g. https://sepolia.base.org
  USDC_ADDRESS,          // e.g. Base-Sepolia USDC contract
  USDC_DECIMALS = 6,     // USDC usually has 6 decimals
  TARGET_ADDRESS,        // where you want to collect deposits
  BEARER_TOKEN,        
} = process.env;

// minimal ABI for Transfer events
const ERC20_ABI = [
  "event Transfer(address indexed from, address indexed to, uint256 value)"
];

// ethers setup
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wssprovider = new ethers.WebSocketProvider("wss://base-sepolia.g.alchemy.com/v2/0fxbpb4OCXkkyHhFNPBRelJsFg7XdhML/ws");
const usdc     = new ethers.Contract(USDC_ADDRESS as string, ERC20_ABI, wssprovider);

// ─── HELPERS ──────────────────────────────────────────────────────────────────

// 1) fetch INR→USDC rate from Coingecko
async function getUsdcPerInr() {
  const res = await axios.get(
    "https://api.coingecko.com/api/v3/simple/price",
    { params: { ids: "usd-coin", vs_currencies: "inr" } }
  );
  // 1 USDC costs `res.data["usd-coin"].inr` INR
  return 1 / res.data["usd-coin"].inr;
}

// 2) wait for the user to send exactly (or at least) `amount` USDC
async function waitForDeposit(fromAddress: any, minAmount: string | number) {
    let block = await provider.getBlockNumber();
  
    while (true) {
      // fetch any matching logs since our last block
      const logs = await provider.getLogs({ fromBlock: 25833653, toBlock: "latest" });
      for (let log of logs) {
        const parsedLog = usdc.interface.parseLog(log);
        if (!parsedLog) continue;
        const { args } = parsedLog;
        if ((args.value >= minAmount) && args.to === TARGET_ADDRESS && args.from === fromAddress) {
            console.log("Deposit confirmed:", {
                from: args.from,
                to: args.to,
                amount: args.value.toString(),
            });
          return log;
        }
      }
  
      // advance the block cursor so we don’t re-scan
      block = (await provider.getBlockNumber()) + 1;
      await new Promise(r => setTimeout(r, 5_000));  // wait 5s
    }
  }
  
  

// 3) trigger INR payout via your UPI service
async function payInrToUpi(upiId: string | null, amountInr: number) {
    console.log("Paying INR to UPI ID:", upiId);
    console.log("Amount in INR:", amountInr);
    try {
        const response = await axios.post(
          'https://payout-gamma.cashfree.com/payout/v1/directTransfer',
          {
            amount: amountInr.toString(),
            transferId:Date.now().toString(),
            transferMode: 'upi',
            beneDetails: {
              name: 'test',
              phone: '9999999999',
              email: 'johndoe_1@cashfree.com',
              address1: '113/2 bc road',
              vpa: 'success@upi'
            }
          },
          {
            headers: {
              'Authorization': BEARER_TOKEN,
              'Content-Type': 'application/json'
            }
          }
        );
    
        console.log('Transfer Response:', response.data);
      } catch (err) {
        console.error('Transfer Error:', err.response?.data || err.message);
      }
}



// 4) rebuild the original UPI intent URI
function buildUpiIntent(params: { [s: string]: unknown; } | ArrayLike<unknown>) {
  const url = new URL("upi://pay");
  Object.entries(params).forEach(([k,v]) => url.searchParams.set(k, v));
  return url.toString();
}

// ─── ROUTE ────────────────────────────────────────────────────────────────────
app.post("/process-upi", async (req: { body: { upiIntent: any; userEthAddress: any; }; }, res: { status: (arg0: number) => { (): any; new(): any; json: { (arg0: { status: string; usdcAmount: any; target: string | undefined; }): void; new(): any; }; }; }) => {
  try {
    // a) client sends their UPI intent and their wallet address
    const { upiIntent, userEthAddress } = req.body;
    const uri = new URL(upiIntent);
    const upiParams = {
      pa: uri.searchParams.get("pa"),
      pn: uri.searchParams.get("pn"),
      am: uri.searchParams.get("am"),
      cu: uri.searchParams.get("cu"),
    };
    const inrAmount = parseFloat(upiParams.am);

    // b) convert INR → USDC
    const rate     = await getUsdcPerInr();
    console.log("1 USDC = ",1/rate, " INR");
    const amount = (inrAmount * rate * 1e6).toFixed(0);
    console.log("Amount in USDC: ", amount);
    

    // c) tell client how much USDC & where to send
    res.status(202).json({
      status: "pending_deposit",
      usdcAmount: amount,
      target: TARGET_ADDRESS
    });

    // d) now wait for on-chain deposit
    await waitForDeposit(userEthAddress, amount);

    // e) once we see it, pay INR out to their UPI
    await payInrToUpi(upiParams.pa, inrAmount);

    // f) here you might send a push/WebSocket/message back to client
    //    with the final UPI intent so they can invoke it.
    //    For demo, we just log it:
    console.log("✅ Deposit confirmed. Now invoke:");
    console.log(buildUpiIntent(upiParams));

  } catch (e) {
    console.error(e);
  }
});

// start
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`🚀 Listening on http://localhost:${PORT}`)
);
