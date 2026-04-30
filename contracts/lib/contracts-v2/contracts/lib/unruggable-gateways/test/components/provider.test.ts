import { createServer } from 'node:http';
import { FetchRequest, JsonRpcProvider, JsonRpcPayload } from 'ethers';
import { test, afterAll, expect } from 'bun:test';
import { describe } from '../bun-describe-fix.js';

describe('providers', async () => {
  const maxAttempts = 10;

  const errors = {
    201: 'could not coalesce error',
    429: 'busy',
  };

  function createProvider(count = 0, code?: keyof typeof errors) {
    // simulate a rpc server
    const server = createServer(async (req, reply) => {
      const { id }: JsonRpcPayload = await new Promise((ful) => {
        const v: Uint8Array[] = [];
        req.on('data', (x) => v.push(x));
        req.on('end', () => ful(JSON.parse(Buffer.concat(v).toString('utf8'))));
      });
      if (count > 0) {
        if (!code) throw new Error('expected code');
        --count;
        reply.statusCode = code;
        reply.setHeader('retry-after', '1');
        reply.end(JSON.stringify({ id, error: errors[code] }));
      } else {
        reply.end(JSON.stringify({ id, result: '0x1' }));
      }
    });
    server.listen();
    afterAll(() => server.close());
    const fr = new FetchRequest(
      `http://localhost:${(server.address() as any).port}`
    );
    fr.setThrottleParams({ maxAttempts });
    return new JsonRpcProvider(fr, 1, { staticNetwork: true });
  }

  test('retry max', async () => {
    expect(
      createProvider(maxAttempts - 1, 429).send('X', [])
    ).resolves.toBeDefined();
  });

  test('retry exceeded', async () => {
    expect(createProvider(maxAttempts, 429).send('X', [])).rejects.toThrow();
  });
});
