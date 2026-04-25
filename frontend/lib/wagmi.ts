import { injected } from "@wagmi/core";
import { defineChain, http } from "viem";
import { createConfig } from "wagmi";

export const arcTestnet = defineChain({
  id: Number(process.env.NEXT_PUBLIC_ARC_CHAIN_ID || 5042002),
  name: "Arc Testnet",
  nativeCurrency: {
    name: "USDC",
    symbol: "USDC",
    decimals: 18 // Arc native gas token uses 18 decimals; ERC-20 interface uses 6
  },
  rpcUrls: {
    default: {
      // Default to the Blockdaemon mirror — the public `rpc.testnet.arc.network`
      // and `rpc.quicknode.testnet.arc.network` mirrors share a node-level
      // mempool that fills up under hackathon load and rejects every tx with
      // "txpool is full". Blockdaemon's mempool is healthy. NEXT_PUBLIC_ARC_RPC_URL
      // overrides if the operator wants to pin elsewhere.
      http: [process.env.NEXT_PUBLIC_ARC_RPC_URL || "https://rpc.blockdaemon.testnet.arc.network"]
    }
  },
  blockExplorers: {
    default: {
      name: "ArcScan",
      url: "https://testnet.arcscan.app"
    }
  },
  contracts: {
    // USDC system contract — native gas token on Arc
    usdc: {
      address: "0x3600000000000000000000000000000000000000" as `0x${string}`
    }
  }
});

export const wagmiConfig = createConfig({
  chains: [arcTestnet],
  connectors: [
    injected({
      shimDisconnect: true
    })
  ],
  transports: {
    [arcTestnet.id]: http()
  },
  ssr: true
});
