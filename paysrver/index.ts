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
async function waitForDeposit(fromAddress: string, minAmount: string | number) {
    // start scanning from the latest block
    let fromBlock = 25836273;
  
    // precompute topics
    const transferTopic = ethers.id("Transfer(address,address,uint256)");
    const fromTopic     = "0x000000000000000000000000c395bcab78eca2e43bf2e7095ba312483a607f51";
    const toTopic       = '0x0000000000000000000000001547ffb043f7c5bde7baf3a03d1342ccd8211a28';
  
    while (true) {
      // fetch only USDC Transfer logs from `fromAddress` → `TARGET_ADDRESS`
      const logs = await provider.getLogs({
        address:   USDC_ADDRESS,
        topics:    [transferTopic, fromTopic, toTopic],
        fromBlock,
        toBlock:   "latest"
      });
  
      for (const log of logs) {
        const parsed = usdc.interface.parseLog(log);
        const { args } = parsed;
        // args.value is a BigNumber
        if (args.value >= minAmount) {
          console.log("Deposit confirmed:", {
            from:   args.from,
            to:     args.to,
            amount: args.value.toString(),
          });
          return log;
        }
      }
  
      // move cursor forward so we don't re-scan old blocks
      fromBlock = (await provider.getBlockNumber()) + 1;
      await new Promise(r => setTimeout(r, 5_000));
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
function buildUpiIntent(params: Record<string,string|null>) {
    const parts: string[] = [];
    for (const [k, v] of Object.entries(params)) {
      if (v) parts.push(`${k}=${v}`);
    }
    return `phonepe://pay?${parts.join("&")}`;
  }
  

// ─── ROUTE ────────────────────────────────────────────────────────────────────
app.post("/process-upi", async (req: { body: { upiIntent: any; userEthAddress: any; }; }, res: { status: (arg0: number) => { (): any; new(): any; json: { (arg0: { status: string; upiintent: string; }): void; new(): any; }; }; }) => {
  try {
    // a) client sends their UPI intent and their wallet address
    const { upiIntent, userEthAddress } = req.body;
    const uri = new URL(upiIntent);
    const upiParams = {
      pa: uri.searchParams.get("pa"),
      am: uri.searchParams.get("am"),
      cu: uri.searchParams.get("cu"),
    };
    const inrAmount = parseFloat(upiParams.am);

    // b) convert INR → USDC
    const rate     = await getUsdcPerInr();
    console.log("1 USDC = ",1/rate, " INR");
    const amount = (inrAmount * rate * 1e6).toFixed(0);
    console.log("Amount in USDC: ", amount);

    // d) now wait for on-chain deposit
    await waitForDeposit(userEthAddress, amount);

    // e) once we see it, pay INR out to their UPI
    await payInrToUpi(upiParams.pa, inrAmount);

    // f) here you might send a push/WebSocket/message back to client
    //    with the final UPI intent so they can invoke it.
    //    For demo, we just log it:
    console.log("✅ Deposit confirmed. Now invoke:");
    console.log(buildUpiIntent(upiParams));

    // g) send a response back to the client
    res.status(200).json({
      status: "success",
      upiintent: buildUpiIntent(upiParams),
    });

  } catch (e) {
    console.error(e);
  }
});

app.get("/upi-redir", (req, res) => {
    const upi = req.query.uri as string;
    if (!upi) return res.status(400).send("Missing uri");
    res.redirect(upi);
  });

// start
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`🚀 Listening on http://localhost:${PORT}`)
);
