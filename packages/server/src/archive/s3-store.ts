import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  type GetObjectCommandOutput,
  S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { ArchiveObjectMissingError, type ArchiveStore } from './store';

export interface S3Settings {
  /** Full URL including scheme — MinIO speaks http, clouds speak https. */
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  /** MinIO and friends route by path; the clouds route by bucket subdomain. */
  forcePathStyle: boolean;
}

/**
 * The production store: any S3-compatible endpoint (AWS, R2, MinIO, OSS in
 * S3-compat mode). One deliberate setting pair, measured the hard way in
 * the predecessor system: the SDK's default flexible checksums send
 * streaming bodies aws-chunked with a trailer, which Aliyun OSS's compat
 * layer rejects with InvalidArgument — and a string-body test never
 * triggers it, only real file streams do. WHEN_REQUIRED on both directions
 * turns that machinery off; the store contract pins it against a mini S3
 * that refuses checksum negotiation exactly like OSS does.
 */
export class S3Store implements ArchiveStore {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(settings: S3Settings) {
    this.bucket = settings.bucket;
    this.client = new S3Client({
      endpoint: settings.endpoint,
      region: settings.region,
      forcePathStyle: settings.forcePathStyle,
      credentials: {
        accessKeyId: settings.accessKeyId,
        secretAccessKey: settings.secretAccessKey,
      },
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }

  async put(key: string, filePath: string): Promise<void> {
    // Upload instead of a bare PutObject: it buffers parts and switches to
    // multipart past the part size, so an archive over the single-request
    // 5 GiB ceiling (a well-fed disk of incompressible data) still lands.
    await new Upload({
      client: this.client,
      params: {
        Bucket: this.bucket,
        Key: key,
        Body: createReadStream(filePath),
      },
    }).done();
  }

  async get(
    key: string,
    destPath: string,
    onProgress?: (fraction: number) => void,
  ): Promise<void> {
    let response: GetObjectCommandOutput;
    try {
      response = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
    } catch (err) {
      if ((err as { name?: string }).name === 'NoSuchKey') {
        throw new ArchiveObjectMissingError(
          `archive object ${key} is not in bucket ${this.bucket}`,
        );
      }
      throw err;
    }
    const body = response.Body as NodeJS.ReadableStream | undefined;
    if (!body) {
      throw new Error(`downloading ${key} returned an empty body`);
    }
    // The meter and the pipeline attach in the same synchronous block, so
    // no chunk can slip between them.
    const total = response.ContentLength ?? 0;
    let consumed = 0;
    body.on('data', (chunk: Buffer) => {
      consumed += chunk.length;
      if (total > 0) onProgress?.(Math.min(consumed / total, 1));
    });
    await pipeline(body, createWriteStream(destPath));
    onProgress?.(1);
  }

  async delete(key: string): Promise<void> {
    // S3 DeleteObject is idempotent on its own: deleting nothing is 204.
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }
}
