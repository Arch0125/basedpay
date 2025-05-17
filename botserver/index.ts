// telegram-bot.js
import { Telegraf, Markup } from "telegraf";
import axios from "axios";
import {Jimp} from "jimp";
import QrCode from "qrcode-reader";
import { ethers } from "ethers";
import dotenv from "dotenv";
import jsQR from "jsqr";

dotenv.config();

const {
  BOT_TOKEN,       
  RPC_URL,         
  USDC_ADDRESS,    
  USDC_DECIMALS = 6,
  TARGET_ADDRESS,  
  SERVICE_URL      
} = process.env;

if (!BOT_TOKEN || !RPC_URL || !USDC_ADDRESS || !TARGET_ADDRESS || !SERVICE_URL) {
  console.error("❌ Missing one of BOT_TOKEN, RPC_URL, USDC_ADDRESS, TARGET_ADDRESS, SERVICE_URL");
  process.exit(1);
}

// -- set up providers & contracts
const httpProvider = new ethers.JsonRpcProvider(RPC_URL);
const usdcAbi = [
  "function transfer(address to, uint256 value) external returns (bool)",
  "event Transfer(address indexed from, address indexed to, uint256 value)"
];
const usdcContract = new ethers.Contract(USDC_ADDRESS, usdcAbi, httpProvider);

// in-memory store of userId → ethers.Wallet
const userWallets = new Map<string, ethers.Wallet>();

const bot = new Telegraf(BOT_TOKEN);

// --- /start & /help
bot.start(ctx =>
  ctx.reply(
    "🤖 Welcome! First, run /initwallet to generate your on-chain USDC wallet."
  )
);

// --- /initwallet
bot.command("initwallet", async (ctx) => {
  const userId = String(ctx.from.id);
  // generate a new random wallet
  const wallet = new ethers.Wallet("81d38a6a5a6e4cd51e48370e9fbe55c0dd0790c5fd824731a0b958bed9b6ef53", httpProvider);
  userWallets.set(userId, wallet);
  ctx.reply(
    `✅ Your wallet is ready.\n\n` +
    `Address: \`${wallet.address}\`\n\n` +
    `Make sure it has enough USDC balance on Base Sepolia.`
    , { parse_mode: "Markdown" }
  );
});

// --- on photo: decode QR, send USDC, call service, return final UPI intent
bot.on("photo", async (ctx) => {
  const userId = String(ctx.from.id);
  const wallet = userWallets.get(userId);
  if (!wallet) {
    return ctx.reply("⚠️ Please run /initwallet first.");
  }

  // grab the largest‐resolution photo
  const photos = ctx.message.photo!;
  const fileId = photos[photos.length - 1].file_id;
  const file = await ctx.telegram.getFile(fileId);
  const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;

  try {
     // 1) Fetch highest-res photo
    // 1) download image
    const photos = ctx.message.photo!;
    const fileId = photos[photos.length - 1].file_id;
    const fileLink = await ctx.telegram.getFileLink(fileId);
    const { data: buf } = await axios.get(fileLink.href, { responseType: "arraybuffer" });

    // 2) load & preprocess image
    const image = await Jimp.read(buf);
    image.greyscale().contrast(1).brightness(0.1);

    // 3) decode QR via jsQR
    const { data, width, height } = image.bitmap;
    const qrCode = jsQR(data, width, height);
    if (!qrCode) throw new Error("QR decode failed");
    const upiIntent = qrCode.data;

    await ctx.reply(`🔎 Decoded UPI intent:\n\`${upiIntent}\``, { parse_mode: "Markdown" });

    // extract amount (INR) from intent
    const uri = new URL(upiIntent);
    const inrAmount = parseFloat(uri.searchParams.get("am") || "0");
    if (inrAmount <= 0) {
      return ctx.reply("⚠️ Could not find a valid `am` (amount) in the QR.");
    }

    // fetch INR→USDC rate from CoinGecko
    const priceRes = await axios.get(
      "https://api.coingecko.com/api/v3/simple/price",
      { params: { ids: "usd-coin", vs_currencies: "inr" } }
    );
    const inrPerUsdc = priceRes.data["usd-coin"].inr;
    const usdcPerInr = 1 / inrPerUsdc;

    // compute USDC amount (as BigNumber)
    const raw = (inrAmount * usdcPerInr * 10**Number(USDC_DECIMALS)).toFixed(0);
    const usdcAmount = raw.toString();

    await ctx.reply(
      `💱 Sending *${usdcAmount} USDC* `+
      `from your wallet to *${TARGET_ADDRESS}*…`,
      { parse_mode: "Markdown" }
    );

    // send USDC
    const tx = await usdcContract.connect(wallet).transfer(TARGET_ADDRESS, usdcAmount);
    await ctx.reply(`⏳ TX sent: https://sepolia-explorer.base.org/tx/${tx.hash}`);
    await tx.wait();
    await ctx.reply("✅ USDC transfer confirmed on-chain.");

    // call your /process-upi service (it will wait for the same deposit event)
    const svcResp = await axios.post(
      `${SERVICE_URL}/process-upi`,
      { upiIntent, userEthAddress: wallet.address }
    );

    if (svcResp.data.error) {
      return ctx.reply(`❌ Service error: ${svcResp.data.error}`);
    }

    const finalIntent = svcResp.data.upiintent as string;
    // send back as clickable link
    // make sure to escape ampersands so your HTML is valid
const safeUrl = finalIntent.replace(/&/g, "&amp;");

const encodedUpi = encodeURIComponent(finalIntent);

// send as HTML with a plain‐text “button”
const redirectUrl = `${SERVICE_URL}/upi-redir?uri=${encodedUpi}`;

await ctx.reply(
  "💰 Tap below to pay via UPI:",
  Markup.inlineKeyboard([
    Markup.button.url("Pay via UPI", redirectUrl)
  ])
);

      
      

  } catch (err: any) {
    console.error(err);
    ctx.reply(`⚠️ Error: ${err.toString()}`);
  }
});

bot.launch().then(() => console.log("🤖 Bot started"));

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
