import http from 'node:http';
import type { AddressInfo } from 'node:net';
import net from 'node:net';
import { request } from 'undici';
import { afterEach, describe, expect, it } from 'vitest';
import {
  forwardCapture,
  forwardStream,
  forwardUpgrade,
  replay,
  UnreachableError,
} from './forward';

const TOKEN = 'node-token-node-token-node-token-node';
const servers: http.Server[] = [];
// Every accepted socket, upgraded ones included: http.Server#close waits
// for sockets it no longer tracks after an upgrade (the daemon's
// shutdown.ts has the reference), so teardown cuts them by hand.
const sockets = new Set<net.Socket>();
afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  await Promise.all(
    servers
      .splice(0)
      .map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
  );
});

async function listen(server: http.Server): Promise<string> {
  servers.push(server);
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** A gateway-shaped front: every request is forwarded to `endpoint` with the given options. */
async function front(
  endpoint: string,
  options: Partial<Parameters<typeof forwardStream>[2]> = {},
): Promise<string> {
  const server = http.createServer((req, res) => {
    void forwardStream(req, res, {
      target: { endpoint, token: TOKEN },
      credential: 'bearer',
      ...options,
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message }));
    });
  });
  return listen(server);
}

describe('forwardStream', () => {
  it('streams the answer frame by frame: the first frame reaches the client before the node writes the second', async () => {
    let releaseSecond: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const node = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.write('first\n');
      void gate.then(() => res.end('second\n'));
    });
    const router = await front(await listen(node));

    const res = await request(`${router}/execCommand`, { method: 'POST' });
    const chunks: string[] = [];
    const reader = res.body[Symbol.asyncIterator]();
    const first = await reader.next();
    chunks.push(String(first.value));
    // Proof of streaming: the client holds the first frame while the node
    // is still parked before its second. A buffering front could not get here.
    expect(chunks).toEqual(['first\n']);
    releaseSecond();
    for await (const chunk of { [Symbol.asyncIterator]: () => reader }) {
      chunks.push(String(chunk));
    }
    expect(chunks.join('')).toBe('first\nsecond\n');
    expect(res.headers['transfer-encoding']).toBe('chunked');
  });

  it("resolves with the node's status once the answer is relayed — the named verbs read a 404 off it", async () => {
    const node = http.createServer((_req, res) => {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"message":"no sandbox named \\"x\\""}');
    });
    const endpoint = await listen(node);
    let resolved: number | null | undefined;
    const front = http.createServer((req, res) => {
      void forwardStream(req, res, {
        target: { endpoint, token: TOKEN },
        credential: 'bearer',
      }).then((status) => {
        resolved = status;
      });
    });
    const url = await listen(front);
    const res = await request(`${url}/execCommand`, { method: 'POST' });
    expect(res.statusCode).toBe(404);
    await res.body.text();
    const deadline = Date.now() + 1_000;
    while (resolved === undefined && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(resolved).toBe(404);
  });

  it('keeps a fixed-length answer fixed-length and passes response headers through — pagination, cookies, CORS', async () => {
    const node = http.createServer((_req, res) => {
      res.writeHead(200, {
        'content-type': 'application/json',
        'content-length': '5',
        'x-next-token': 'abc',
        'set-cookie': ['a=1', 'b=2'],
        'access-control-allow-origin': '*',
      });
      res.end('hello');
    });
    const router = await front(await listen(node));
    const res = await request(`${router}/listSandboxes`, { method: 'POST' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-length']).toBe('5');
    expect(res.headers['transfer-encoding']).toBeUndefined();
    expect(res.headers['x-next-token']).toBe('abc');
    expect(res.headers['set-cookie']).toEqual(['a=1', 'b=2']);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(await res.body.text()).toBe('hello');
  });

  it('a client that goes away mid-stream takes the node connection down with it', async () => {
    let nodeSawClose: () => void = () => {};
    const closed = new Promise<void>((resolve) => {
      nodeSawClose = resolve;
    });
    const node = http.createServer((req, res) => {
      res.writeHead(200);
      res.write('tick\n');
      const timer = setInterval(() => res.write('tick\n'), 20);
      req.on('close', () => {
        clearInterval(timer);
        nodeSawClose();
      });
    });
    const router = await front(await listen(node));
    const res = await request(`${router}/stream`, { method: 'POST' });
    const reader = res.body[Symbol.asyncIterator]();
    await reader.next();
    res.body.destroy();
    await closed;
  });

  it('a client already gone when the forward begins is not sent to the node at all, and answers null', async () => {
    let requests = 0;
    const node = http.createServer((_req, res) => {
      requests += 1;
      res.end('{}');
    });
    const endpoint = await listen(node);
    // The shape forwardNamed produces: the lookup round took a while and
    // the caller hung up meanwhile — the response is destroyed before the
    // forward starts, so its 'close' has already fired and no abort would
    // ever follow.
    const gone = new http.IncomingMessage(new net.Socket());
    const res = new http.ServerResponse(gone);
    res.destroy();
    expect(
      await forwardStream(
        Object.assign(gone, {
          url: '/execCommand',
          method: 'POST',
          headers: {},
        }),
        res,
        {
          target: { endpoint, token: TOKEN },
          credential: 'bearer',
          body: Buffer.from('{"name":"x","command":"sleep 3600"}'),
        },
      ),
    ).toBeNull();
    expect(requests).toBe(0);
  });

  it('forwards the request verbatim — path, query, body — with the credential swapped and the Host renamed to the node unless the face keeps it', async () => {
    const seen: Array<{
      url?: string;
      headers: http.IncomingHttpHeaders;
      body: string;
    }> = [];
    const node = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => {
        body += c;
      });
      req.on('end', () => {
        seen.push({ url: req.url, headers: req.headers, body });
        res.writeHead(200);
        res.end();
      });
    });
    const endpoint = await listen(node);
    const router = await front(endpoint, { credential: 'bearer' });
    await request(`${router}/readFile?x=1`, {
      method: 'POST',
      headers: {
        host: '8000-2d5c6f0e-1111-4222-8333-444455556666.sbx.test',
        authorization: 'Bearer caller-secret',
        'content-type': 'application/json',
        connection: 'keep-alive',
      },
      body: '{"name":"alice"}',
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe('/readFile?x=1');
    expect(seen[0]?.body).toBe('{"name":"alice"}');
    // The Host named the gateway; the node is asked as itself, so a Caddy
    // in front of it that binds the gateway's domain never answers a 308.
    expect(seen[0]?.headers.host).toBe(new URL(endpoint).host);
    expect(seen[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(seen[0]?.headers['content-type']).toBe('application/json');

    // The E2B face swaps the other header; the credential-less faces touch none.
    const asE2b = await front(endpoint, { credential: 'x-api-key' });
    await request(`${asE2b}/sandboxes`, {
      method: 'POST',
      headers: { 'x-api-key': 'e2b_caller' },
    });
    expect(seen[1]?.headers['x-api-key']).toBe(`e2b_${TOKEN}`);
    const asEnvd = await front(endpoint, { credential: 'none' });
    await request(`${asEnvd}/e2b/envd/files`, {
      method: 'GET',
      headers: { authorization: 'Basic dXNlcjo=', 'x-access-token': 'hmac' },
    });
    expect(seen[2]?.headers.authorization).toBe('Basic dXNlcjo=');
    expect(seen[2]?.headers['x-access-token']).toBe('hmac');

    // The proxy face is the one that keeps the Host: it is the routing
    // key on the node as well.
    const asProxy = await front(endpoint, {
      credential: 'none',
      preserveHost: true,
    });
    await request(`${asProxy}/`, {
      method: 'GET',
      headers: { host: '8000-2d5c6f0e-1111-4222-8333-444455556666.sbx.test' },
    });
    expect(seen[3]?.headers.host).toBe(
      '8000-2d5c6f0e-1111-4222-8333-444455556666.sbx.test',
    );
  });

  it('sends the request target byte for byte — dot segments included — instead of a URL it resolved itself', async () => {
    const seen: string[] = [];
    const node = http.createServer((req, res) => {
      seen.push(req.url ?? '');
      res.writeHead(200);
      res.end();
    });
    const endpoint = await listen(node);
    const router = await front(endpoint);
    const url = new URL(router);
    // A client library would collapse the segments before they left; the
    // socket carries them as an attacker would.
    const path = '/e2b/api/sandboxes/some-id/../../sandboxes?x=1';
    await new Promise<void>((resolve, reject) => {
      const socket = net.connect(Number(url.port), url.hostname, () => {
        socket.write(
          `GET ${path} HTTP/1.1\r\nhost: router\r\nconnection: close\r\n\r\n`,
        );
      });
      socket.on('data', () => {});
      socket.on('end', resolve);
      socket.on('error', reject);
    });
    expect(seen).toEqual([path]);
  });

  it('drops the Expect header: the 100-continue handshake ended at the gateway, and undici refuses to carry it', async () => {
    const seen: http.IncomingHttpHeaders[] = [];
    const node = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        seen.push(req.headers);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      });
    });
    const endpoint = await listen(node);
    const router = await front(endpoint);
    // curl adds this to every body over 1024 bytes (undici's own client
    // refuses to send it, so the exam speaks node:http): Node's server
    // answered the 100 before forwardStream saw the request.
    const body = JSON.stringify({ name: 'big', content: 'x'.repeat(2048) });
    const res = await new Promise<{ status: number; text: string }>(
      (resolve, reject) => {
        const req = http.request(
          `${router}/writeFile`,
          {
            method: 'POST',
            headers: {
              expect: '100-continue',
              'content-type': 'application/json',
              'content-length': String(Buffer.byteLength(body)),
            },
          },
          (answer) => {
            let text = '';
            answer.on('data', (c) => {
              text += c;
            });
            answer.on('end', () =>
              resolve({ status: answer.statusCode ?? 0, text }),
            );
          },
        );
        req.on('continue', () => req.end(body));
        req.on('error', reject);
      },
    );
    expect(res.status).toBe(200);
    expect(JSON.parse(res.text)).toEqual({ ok: true });
    expect(seen[0]?.expect).toBeUndefined();
  });

  it('a node that does not answer is an UnreachableError, tried exactly once', async () => {
    let hits = 0;
    const node = http.createServer((req) => {
      hits += 1;
      req.socket.destroy();
    });
    const endpoint = await listen(node);
    const router = await front(endpoint);
    const cut = await request(`${router}/acquireSandbox`, { method: 'POST' });
    expect(cut.statusCode).toBe(502);
    expect((await cut.body.json()) as { message: string }).toMatchObject({
      message: expect.stringMatching(
        /^node http:\/\/127\.0\.0\.1:\d+ did not answer: /,
      ),
    });
    expect(hits).toBe(1);

    const refused = await front('http://127.0.0.1:9');
    const res = await request(`${refused}/acquireSandbox`, { method: 'POST' });
    expect(res.statusCode).toBe(502);
    expect(((await res.body.json()) as { message: string }).message).toMatch(
      /did not answer: ECONNREFUSED/,
    );
  });
});

describe('forwardCapture + replay', () => {
  it('collects the answer whole and replays it verbatim, asks for it uncompressed, and reports a refused connection as unreachable', async () => {
    const encodings: Array<string | undefined> = [];
    const node = http.createServer((req, res) => {
      encodings.push(req.headers['accept-encoding']);
      res.writeHead(201, {
        'content-type': 'application/json',
        'x-extra': 'y',
      });
      res.end('{"sandboxID":"s-1"}');
    });
    const endpoint = await listen(node);
    const server = http.createServer((req, res) => {
      void forwardCapture(req, res, {
        target: { endpoint, token: TOKEN },
        credential: 'x-api-key',
      }).then(
        (answer) => {
          if (answer === null) throw new Error('the client did not leave');
          expect(answer.status).toBe(201);
          expect(JSON.parse(answer.body.toString())).toEqual({
            sandboxID: 's-1',
          });
          replay(res, answer);
        },
        (error: unknown) => {
          res.writeHead(502);
          res.end(error instanceof Error ? error.name : 'other');
        },
      );
    });
    const router = await listen(server);
    const res = await request(`${router}/sandboxes`, {
      method: 'POST',
      headers: { 'accept-encoding': 'gzip, br' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.headers['x-extra']).toBe('y');
    expect(res.headers['content-length']).toBe('19');
    expect(await res.body.json()).toEqual({ sandboxID: 's-1' });
    // A compressing hop between router and node would hand back bytes
    // the gateway cannot read the id out of.
    expect(encodings).toEqual(['identity']);

    const orphan = new http.IncomingMessage(new net.Socket());
    await expect(
      forwardCapture(
        Object.assign(orphan, { url: '/x', method: 'POST', headers: {} }),
        new http.ServerResponse(orphan),
        {
          target: { endpoint: 'http://127.0.0.1:9', token: TOKEN },
          credential: 'bearer',
          body: Buffer.from('{}'),
        },
      ),
    ).rejects.toBeInstanceOf(UnreachableError);
  });
});

describe('forwardCapture + replay — bodiless answers', () => {
  it('replays a 204 without inventing a content-length', async () => {
    const node = http.createServer((_req, res) => {
      res.writeHead(204);
      res.end();
    });
    const endpoint = await listen(node);
    const front = http.createServer((req, res) => {
      void forwardCapture(req, res, {
        target: { endpoint, token: TOKEN },
        credential: 'x-api-key',
      }).then((answer) => answer && replay(res, answer));
    });
    const url = await listen(front);
    const res = await request(`${url}/e2b/api/sandboxes/x`, {
      method: 'DELETE',
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers['content-length']).toBeUndefined();
    await res.body.text();
  });
});

describe('forwardStream — a client that leaves', () => {
  it('withdraws the request from the node when the client leaves before the node answered', async () => {
    let nodeSawClose: number | null = null;
    const node = http.createServer((req, res) => {
      const at = Date.now();
      req.on('close', () => {
        nodeSawClose = Date.now() - at;
      });
      // Answers late — the client will be gone by then.
      setTimeout(() => {
        if (!res.destroyed) {
          res.writeHead(200);
          res.end('late');
        }
      }, 1500);
    });
    const endpoint = await listen(node);
    const routerUrl = await front(endpoint);
    const url = new URL(routerUrl);
    const client = http.request({
      host: url.hostname,
      port: url.port,
      path: '/execCommand',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    client.on('error', () => {});
    client.end('{"name":"x"}');
    await new Promise((resolve) => setTimeout(resolve, 100));
    client.destroy();
    const deadline = Date.now() + 1_000;
    while (nodeSawClose === null && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    // Well before the node's own answer at 1.5s: the gateway aborted it.
    expect(nodeSawClose).not.toBeNull();
    expect(nodeSawClose as unknown as number).toBeLessThan(1_000);
  });
});

describe('forwardCapture — a client that leaves', () => {
  it('withdraws the request from the node when the client leaves before the node answered, and answers null; a client already gone is not sent at all', async () => {
    let nodeSawClose: number | null = null;
    let requests = 0;
    const node = http.createServer((req, res) => {
      requests += 1;
      const at = Date.now();
      req.on('close', () => {
        nodeSawClose = Date.now() - at;
      });
      setTimeout(() => {
        if (!res.destroyed) {
          res.writeHead(200);
          res.end('{}');
        }
      }, 1500);
    });
    const endpoint = await listen(node);
    const outcomes: Array<'null' | 'answer' | 'error'> = [];
    const front = http.createServer((req, res) => {
      void forwardCapture(req, res, {
        target: { endpoint, token: TOKEN },
        credential: 'bearer',
      }).then(
        (answer) => {
          outcomes.push(answer === null ? 'null' : 'answer');
          if (answer !== null) replay(res, answer);
        },
        () => outcomes.push('error'),
      );
    });
    const url = new URL(await listen(front));
    const client = http.request({
      host: url.hostname,
      port: url.port,
      path: '/acquireSandbox',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    client.on('error', () => {});
    client.end('{"name":"x"}');
    await new Promise((resolve) => setTimeout(resolve, 100));
    client.destroy();
    const deadline = Date.now() + 1_000;
    while (outcomes.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    // Well before the node's own answer at 1.5s: the gateway aborted it
    // and told the caller there is nothing to send.
    expect(outcomes).toEqual(['null']);
    expect(nodeSawClose).not.toBeNull();
    expect(nodeSawClose as unknown as number).toBeLessThan(1_000);

    // A verb whose client left while it waited for its slot: the response
    // is already gone when the capture begins, and the node hears nothing.
    const gone = new http.IncomingMessage(new net.Socket());
    const res = new http.ServerResponse(gone);
    res.destroy();
    expect(
      await forwardCapture(
        Object.assign(gone, { url: '/x', method: 'POST', headers: {} }),
        res,
        {
          target: { endpoint, token: TOKEN },
          credential: 'bearer',
          body: Buffer.from('{}'),
        },
      ),
    ).toBeNull();
    expect(requests).toBe(1);
  });
});

describe('forwardCapture — the head arrived, then the client left', () => {
  it('reads the small body to the end and answers it, so a 2xx that did land is still learned; replay writes nothing to nobody', async () => {
    let finishBody: () => void = () => {};
    let headOut: () => void = () => {};
    const headWritten = new Promise<void>((resolve) => {
      headOut = resolve;
    });
    const node = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"sandbox":{"id":"sb-1"', headOut);
      finishBody = () => res.end('}}');
    });
    const endpoint = await listen(node);
    let answer: Awaited<ReturnType<typeof forwardCapture>> | undefined;
    let clientGone: () => void = () => {};
    const gone = new Promise<void>((resolve) => {
      clientGone = resolve;
    });
    const front = http.createServer((req, res) => {
      res.once('close', () => clientGone());
      void forwardCapture(req, res, {
        target: { endpoint, token: TOKEN },
        credential: 'bearer',
      }).then((a) => {
        answer = a;
        if (a !== null) replay(res, a);
      });
    });
    const url = new URL(await listen(front));
    const client = http.request({
      host: url.hostname,
      port: url.port,
      path: '/acquireSandbox',
      method: 'POST',
    });
    client.on('error', () => {});
    client.end('{"name":"x"}');
    // The node's head is out; the body is not. The client gives up.
    await headWritten;
    client.destroy();
    await gone;
    finishBody();
    const deadline = Date.now() + 2_000;
    while (answer === undefined && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(answer).toBeDefined();
    expect(answer).not.toBeNull();
    expect(answer?.status).toBe(200);
    expect(JSON.parse(answer?.body.toString('utf8') ?? '')).toEqual({
      sandbox: { id: 'sb-1' },
    });
  });
});

describe('forwardUpgrade', () => {
  it('a node behind TLS is refused with a 502 before any dial — upgrades are plain TCP here', async () => {
    const router = http.createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    router.on('upgrade', (req, socket, head) =>
      forwardUpgrade(req, socket, head, {
        endpoint: 'https://node.example:443',
        token: TOKEN,
      }),
    );
    const routerUrl = await listen(router);
    const client = net.connect(Number(new URL(routerUrl).port), '127.0.0.1');
    const received: string[] = [];
    client.on('data', (chunk) => received.push(String(chunk)));
    const closed = new Promise<void>((resolve) => client.on('close', resolve));
    client.write(
      'GET /ws HTTP/1.1\r\nHost: 8000-2d5c6f0e-1111-4222-8333-444455556666.sbx.test\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
    );
    await closed;
    expect(received.join('')).toContain('HTTP/1.1 502 Bad Gateway');
    expect(received.join('')).toContain('not forwarded over TLS');
    expect(received.join('')).not.toContain('node.example');
  });

  it('a node that dies after the handshake cuts the client without writing an HTTP status into the upgraded stream', async () => {
    const node = http.createServer((_req, res) => {
      res.writeHead(426);
      res.end();
    });
    node.on('upgrade', (req, socket) => {
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: ${req.headers.upgrade}\r\nConnection: Upgrade\r\n\r\n`,
      );
      // RST from the node side: the router's upstream sees an error, not a FIN.
      socket.on('data', () => (socket as net.Socket).resetAndDestroy());
    });
    const endpoint = await listen(node);
    const router = http.createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    router.on('upgrade', (req, socket, head) =>
      forwardUpgrade(req, socket, head, { endpoint, token: TOKEN }),
    );
    const routerUrl = await listen(router);
    const client = net.connect(Number(new URL(routerUrl).port), '127.0.0.1');
    const received: string[] = [];
    client.on('data', (chunk) => received.push(String(chunk)));
    const closed = new Promise<void>((resolve) => client.on('close', resolve));
    client.write(
      'GET /ws HTTP/1.1\r\nHost: 8000-2d5c6f0e-1111-4222-8333-444455556666.sbx.test\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
    );
    await new Promise<void>((resolve) => {
      const check = () => {
        if (received.join('').includes('101')) resolve();
        else client.once('data', check);
      };
      check();
    });
    client.write('ping');
    await closed;
    expect(received.join('')).not.toContain('502');
  });

  it("a node that black-holes the dial is a 502 within the connect deadline, not the kernel's SYN budget", async () => {
    const router = http.createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    // TEST-NET-1 (RFC 5737) is never routed: the SYN is dropped, or the
    // network answers unreachable at once — a 502 either way, and without
    // the deadline the dropped case held this test for 75s on macOS.
    router.on('upgrade', (req, socket, head) =>
      forwardUpgrade(
        req,
        socket,
        head,
        { endpoint: 'http://192.0.2.1:80', token: TOKEN },
        500,
      ),
    );
    const routerUrl = await listen(router);
    const client = net.connect(Number(new URL(routerUrl).port), '127.0.0.1');
    const received: string[] = [];
    client.on('data', (chunk) => received.push(String(chunk)));
    const closed = new Promise<void>((resolve) => client.on('close', resolve));
    const started = Date.now();
    client.write(
      'GET /ws HTTP/1.1\r\nHost: 8000-2d5c6f0e-1111-4222-8333-444455556666.sbx.test\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
    );
    await closed;
    expect(received.join('')).toContain('HTTP/1.1 502 Bad Gateway');
    expect(received.join('')).toContain('did not answer the upgrade');
    expect(Date.now() - started).toBeLessThan(4000);
  });

  it('replays the upgrade handshake to the node and pipes both ways', async () => {
    const node = http.createServer((_req, res) => {
      res.writeHead(426);
      res.end();
    });
    let nodeSideClosed: () => void = () => {};
    const nodeClosed = new Promise<void>((resolve) => {
      nodeSideClosed = resolve;
    });
    node.on('upgrade', (req, socket) => {
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: ${req.headers.upgrade}\r\nConnection: Upgrade\r\nX-Seen-Host: ${req.headers.host}\r\n\r\n`,
      );
      socket.on('data', (chunk) => socket.write(`echo:${chunk}`));
      // A real upgraded peer (a WebSocket server in the sandbox) ends its
      // side when the other side does; http sockets allow half-open, so
      // without this the chain would hang on a peer that never answers FIN.
      socket.on('end', () => socket.end());
      socket.on('close', nodeSideClosed);
    });
    const endpoint = await listen(node);
    const router = http.createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    router.on('upgrade', (req, socket, head) =>
      forwardUpgrade(req, socket, head, { endpoint, token: TOKEN }),
    );
    const routerUrl = await listen(router);
    const port = Number(new URL(routerUrl).port);

    const client = net.connect(port, '127.0.0.1');
    const received: string[] = [];
    const done = new Promise<void>((resolve) => {
      client.on('data', (chunk) => {
        received.push(String(chunk));
        if (received.join('').includes('echo:ping')) resolve();
      });
    });
    client.write(
      'GET /ws HTTP/1.1\r\nHost: 8000-2d5c6f0e-1111-4222-8333-444455556666.sbx.test\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
    );
    await new Promise<void>((resolve) => {
      const check = () => {
        if (received.join('').includes('101')) resolve();
        else client.once('data', check);
      };
      check();
    });
    client.write('ping');
    await done;
    const all = received.join('');
    expect(all).toContain('HTTP/1.1 101 Switching Protocols');
    expect(all).toContain(
      'X-Seen-Host: 8000-2d5c6f0e-1111-4222-8333-444455556666.sbx.test',
    );
    expect(all).toContain('echo:ping');
    // The client leaving takes the node-side socket down with it.
    client.destroy();
    await nodeClosed;
  });
});
