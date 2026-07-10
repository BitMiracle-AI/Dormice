import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A miniature S3 for exams: exactly the three object verbs the archive
 * store uses, over real HTTP, path-style (`/bucket/key...`). Auth is
 * ignored — the exam is the wire shape, not the signature.
 *
 * One deliberate strictness, copied from Aliyun OSS's S3-compat layer: any
 * upload that negotiates flexible checksums is refused. The AWS SDK's
 * default streams bodies aws-chunked with a checksum trailer — and with
 * buffered bodies it sends the checksum as a plain header instead — both
 * of which OSS rejects; this server rejects both too, so the store's
 * WHEN_REQUIRED configuration is pinned by CI forever, whichever body
 * shape the SDK picks. (Measured in the predecessor system, pit #8: a
 * string-body test stays green while real file streams fail.)
 *
 * A test double with a real socket — the fake executor's proxy-upstream
 * precedent. Shipped in dist behind the "./mini-s3" subpath so the e2e
 * suite can run the daemon against it; the package is private, so nothing
 * is published.
 */
export interface MiniS3 {
  /** http://127.0.0.1:<port> — hand it to DORMICE_S3_ENDPOINT (path style). */
  url: string;
  port: number;
  /** The live object table, for assertions. Keys are `<bucket>/<key>`. */
  objects: Map<string, Buffer>;
  close(): Promise<void>;
}

const CHECKSUM_NEGOTIATION_HEADERS = [
  'x-amz-trailer',
  'x-amz-sdk-checksum-algorithm',
];

function negotiatesChecksums(req: http.IncomingMessage): boolean {
  if (String(req.headers['content-encoding'] ?? '').includes('aws-chunked')) {
    return true;
  }
  return Object.keys(req.headers).some(
    (name) =>
      CHECKSUM_NEGOTIATION_HEADERS.includes(name) ||
      name.startsWith('x-amz-checksum-'),
  );
}

function xmlError(code: string, message: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>${code}</Code><Message>${message}</Message></Error>`;
}

export async function startMiniS3(): Promise<MiniS3> {
  const objects = new Map<string, Buffer>();

  const server = http.createServer(async (req, res) => {
    // Path style: /<bucket>/<key...>; the SDK appends query params (x-id).
    const pathname = new URL(req.url ?? '/', 'http://mini-s3').pathname.replace(
      /^\//,
      '',
    );

    if (req.method === 'PUT') {
      if (negotiatesChecksums(req)) {
        res.writeHead(400, { 'content-type': 'application/xml' });
        res.end(
          xmlError(
            'NotImplemented',
            'checksum negotiation is not supported (aws-chunked / x-amz-checksum headers) — the OSS-compat behavior this server mimics',
          ),
        );
        req.resume();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(chunk as Buffer);
      }
      objects.set(pathname, Buffer.concat(chunks));
      res.writeHead(200, { etag: '"mini-s3"' });
      res.end();
      return;
    }

    if (req.method === 'GET') {
      const body = objects.get(pathname);
      if (body === undefined) {
        res.writeHead(404, { 'content-type': 'application/xml' });
        res.end(xmlError('NoSuchKey', `no such key: ${pathname}`));
        return;
      }
      // content-length is load-bearing: the store's download progress meter
      // divides by it.
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': String(body.length),
      });
      res.end(body);
      return;
    }

    if (req.method === 'DELETE') {
      objects.delete(pathname);
      res.writeHead(204);
      res.end();
      return;
    }

    res.writeHead(405, { 'content-type': 'application/xml' });
    res.end(xmlError('MethodNotAllowed', `unsupported method ${req.method}`));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    objects,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}
