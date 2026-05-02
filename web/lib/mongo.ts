import { MongoClient, type Db } from "mongodb";

/// Lazy MongoDB connection. Caches the client on `globalThis` so Next's
/// dev-mode hot reloads don't open a new connection per change.
declare global {
  // eslint-disable-next-line no-var
  var _mongoClient: MongoClient | undefined;
  // eslint-disable-next-line no-var
  var _mongoClientPromise: Promise<MongoClient> | undefined;
}

const URI = process.env.MONGODB_URI;
const DB_NAME = process.env.MONGODB_DB || "ensign";

if (!URI && process.env.NODE_ENV !== "test") {
  // Fail loudly at first call, not at module import — keeps `next build`
  // green when the env isn't present locally.
  console.warn("[mongo] MONGODB_URI not set — agent persistence will fail at runtime");
}

function getClientPromise(): Promise<MongoClient> {
  if (!URI) throw new Error("MONGODB_URI not set");
  if (process.env.NODE_ENV === "development") {
    if (!global._mongoClientPromise) {
      global._mongoClient = new MongoClient(URI);
      global._mongoClientPromise = global._mongoClient.connect();
    }
    return global._mongoClientPromise;
  }
  if (!global._mongoClientPromise) {
    global._mongoClient = new MongoClient(URI);
    global._mongoClientPromise = global._mongoClient.connect();
  }
  return global._mongoClientPromise;
}

export async function getDb(): Promise<Db> {
  const client = await getClientPromise();
  return client.db(DB_NAME);
}

/// Document shape stored in the `permissions` collection.
export type PermissionDoc = {
  userAccount: `0x${string}`;
  chainId: number;
  permissionHash: `0x${string}`;
  spender: `0x${string}`;
  label: string;
  parentNode: `0x${string}`;
  parentTokenId: string; // bigint serialized as decimal
  start: number;
  end: number;
  salt: string;
  calls: Array<{
    target: `0x${string}`;
    selector: `0x${string}`;
    checker: `0x${string}`;
  }>;
  spends: Array<{
    token: `0x${string}`;
    allowance: string;
    unit: number;
    multiplier: number;
  }>;
  createdAt: string;
  createTxHash: `0x${string}`;
  revokedAt: string | null;
  revokeTxHash: `0x${string}` | null;
  /// Each successful agent execution gets appended here so the dashboard
  /// can render a tx history under the agent without a chain scan.
  executions?: Array<{
    txHash: `0x${string}`;
    blockNumber: string;
    target: `0x${string}`;
    value: string;
    selector: `0x${string}` | null;
    at: string;
  }>;
};
