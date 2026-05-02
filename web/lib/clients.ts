import {
  createPublicClient,
  http,
} from 'viem'
import {
  createBundlerClient,
  type SmartAccount,
} from 'viem/account-abstraction'
import {RPC_URL, BUNDLER_URL, CHAIN} from './constants'
import {createCirclePaymaster} from './circlePaymaster'

const publicClient = createPublicClient({
  chain: CHAIN,
  transport: http(RPC_URL),
})

export function getPublicClient() {
  return publicClient
}

export function getBundlerClient(account: SmartAccount) {
  const paymaster = createCirclePaymaster(account, publicClient)
  return createBundlerClient({
    client: publicClient,
    transport: http(BUNDLER_URL),
    paymaster: paymaster
  })
}

export function createERC20PaymasterBundlerClient(account: SmartAccount) {
  const optimismUSDCAddress = "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85"
  const paymaster = createCirclePaymaster(account, publicClient)
  return createBundlerClient({
    client: publicClient,
    transport: http(BUNDLER_URL),
    paymaster: paymaster,
    paymasterContext: {
      mode: 'commonerc20',
      token: optimismUSDCAddress,
    }
  })
}