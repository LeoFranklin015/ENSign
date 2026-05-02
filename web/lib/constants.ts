import { baseSepolia } from 'viem/chains'

export const PAYMASTER_URL = `https://rpc.etherspot.io/paymaster/?api-key=${process.env.NEXT_PUBLIC_ETHERSPOT_API_KEY}&useVp=true`
export const RPC_URL = process.env.NEXT_PUBLIC_JUSTANAME_RPC_URL as string
export const BUNDLER_URL = process.env.NEXT_PUBLIC_JUSTANAME_BUNDLER_URL as string
export const CHAIN = baseSepolia

export const FACTORY_ADDRESS = "0x1578f4A87243bA8413ee8F5acf2af29635ED09EC";
export const CONTRACT_NAME = "JustanAccount";
export const CONTRACT_VERSION = "1";