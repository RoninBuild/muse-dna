import express from "express";
import { privateKeyToAccount } from "viem/accounts";

const router = express.Router();

/**
 * Circle Bridge Kit / CCTP withdraw preview.
 *
 * Real Bridge Kit integration is a two-step cross-chain transfer:
 *   1. Burn USDC on source chain (Arc Testnet) via the Bridge Kit SDK.
 *   2. Submit attestation to the destination chain (Base / ETH Sepolia).
 *
 * For the hackathon demo we expose the preview endpoint so the UI can show
 * the user what the withdraw would cost and which destinations are supported.
 * The actual cross-chain submission requires a long-lived Bridge Kit signer
 * which is out-of-scope for the current MVP.
 */

// Only CCTP v2 testnet destinations — this is a testnet-only demo. Listing
// mainnet routes here is misleading because Arc Testnet USDC cannot actually
// settle to mainnet.
const SUPPORTED_DESTINATIONS = [
  { chainName: "Base Sepolia", chainId: 84532, cctp: true, nativeSymbol: "ETH" },
  { chainName: "Ethereum Sepolia", chainId: 11155111, cctp: true, nativeSymbol: "ETH" },
  { chainName: "Arbitrum Sepolia", chainId: 421614, cctp: true, nativeSymbol: "ETH" },
  { chainName: "Optimism Sepolia", chainId: 11155420, cctp: true, nativeSymbol: "ETH" },
  { chainName: "Polygon Amoy", chainId: 80002, cctp: true, nativeSymbol: "POL" }
];

router.get("/destinations", (_req, res) => {
  res.json({
    source: { chainName: "Arc Testnet", chainId: 5042002, nativeSymbol: "USDC" },
    destinations: SUPPORTED_DESTINATIONS,
    protocol: "CCTP v2 / Circle Bridge Kit"
  });
});

const MAX_PREVIEW_AMOUNT_USDC = Math.max(
  1,
  Number(process.env.BRIDGE_PREVIEW_MAX_USDC || 100_000)
);

router.post("/preview", async (req, res) => {
  try {
    const { amountUsdc, destinationChainId, destinationAddress } = req.body || {};
    const amount = Number(amountUsdc || 0);

    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: "amountUsdc must be > 0" });
    }

    if (amount > MAX_PREVIEW_AMOUNT_USDC) {
      // Guard against anonymous spam that pumps huge amounts through the
      // preview endpoint to discover fees / burn CPU. Caps the preview
      // surface to a reasonable demo ceiling; real settlement has its
      // own limits on the Gateway side.
      return res.status(400).json({
        error: `amountUsdc exceeds preview cap of ${MAX_PREVIEW_AMOUNT_USDC} USDC`
      });
    }

    const destination = SUPPORTED_DESTINATIONS.find(
      (d) => d.chainId === Number(destinationChainId)
    );
    if (!destination) {
      return res.status(400).json({ error: "Unsupported destinationChainId" });
    }

    if (!destinationAddress || !/^0x[0-9a-fA-F]{40}$/.test(destinationAddress)) {
      return res.status(400).json({ error: "destinationAddress must be a valid EVM address" });
    }
    // Reject the zero address and any all-zero / 0xdEaD style burn target
    // — sending CCTP-bridged USDC to those is unrecoverable.
    const lowered = destinationAddress.toLowerCase();
    if (
      lowered === "0x0000000000000000000000000000000000000000" ||
      lowered === "0x000000000000000000000000000000000000dead"
    ) {
      return res.status(400).json({ error: "destinationAddress cannot be the zero/burn address" });
    }

    // Resolve the source wallet address from the configured self-managed key.
    const pk = (process.env.MUSE_BUYER_PRIVATE_KEY || "").trim();
    const source = /^0x[0-9a-fA-F]{64}$/.test(pk) ? privateKeyToAccount(pk).address : null;

    // Fees in CCTP v2 are paid in USDC; per Circle docs the base fee is
    // ~0.0001 USDC + gas abstraction. We show a conservative estimate.
    const baseFeeUsdc = 0.0001;
    const gasAbstractionUsdc = 0.002;
    const totalFeeUsdc = Number((baseFeeUsdc + gasAbstractionUsdc).toFixed(6));
    const receiveUsdc = Math.max(0, amount - totalFeeUsdc);

    return res.json({
      source: {
        chainName: "Arc Testnet",
        chainId: 5042002,
        address: source
      },
      destination: {
        ...destination,
        address: destinationAddress
      },
      amountSentUsdc: amount,
      feeBreakdown: {
        protocolFeeUsdc: baseFeeUsdc,
        gasAbstractionUsdc,
        totalUsdc: totalFeeUsdc
      },
      amountReceivedUsdc: Number(receiveUsdc.toFixed(6)),
      estimatedSecondsToFinality: 20,
      note:
        "This is a preview. The actual cross-chain transfer will be submitted via Circle Bridge Kit once wired into the execute endpoint."
    });
  } catch (error) {
    console.error("Bridge preview failed:", error.message);
    return res.status(500).json({ error: "Bridge preview failed." });
  }
});

export default router;
