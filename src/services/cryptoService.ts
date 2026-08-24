import crypto from 'crypto';
import fs from 'fs';
import { Transform } from 'stream';

/**
 * Spotify-style track encryption.
 *
 * - Algorithm: AES-256-CTR (matches what the old web app used via WebCrypto).
 * - Per-track random 32-byte key and 12-byte nonce.
 * - File on disk is pure ciphertext (no IV header, no MAC).
 * - Key + nonce are stored in the DB on the Track row; client retrieves them
 *   via a separate, audited, rate-limited /key endpoint.
 * - Counter = nonce (12 bytes) || 0x00000000 (4 bytes block counter starting at 0).
 *
 * Threat model:
 *   - At-rest: if disk is exfiltrated, audio is useless without DB.
 *   - In-transit: HTTPS (in production) + the key endpoint can require fresh
 *     auth and is heavily rate-limited.
 *   - Replay: keys are logged per (user, track, timestamp) for audit.
 */

const ALGO = 'aes-256-ctr';
const KEY_BYTES = 32;
const NONCE_BYTES = 12;

export interface TrackKeyMaterial {
  keyHex: string;   // 64 hex chars
  nonceHex: string; // 24 hex chars
}

export function generateKeyMaterial(): TrackKeyMaterial {
  return {
    keyHex: crypto.randomBytes(KEY_BYTES).toString('hex'),
    nonceHex: crypto.randomBytes(NONCE_BYTES).toString('hex'),
  };
}

function buildCounter(nonceHex: string): Buffer {
  const nonce = Buffer.from(nonceHex, 'hex');
  if (nonce.length !== NONCE_BYTES) {
    throw new Error(`Invalid nonce length: ${nonce.length}`);
  }
  // 16-byte CTR counter: nonce(12) || counter(4 zero bytes, starts at 0)
  const counter = Buffer.alloc(16);
  nonce.copy(counter, 0);
  return counter;
}

/**
 * Encrypt a plaintext file on disk into a ciphertext file (streamed).
 * Removes the plaintext file when done if `deletePlaintext` is true.
 */
export async function encryptFile(
  plaintextPath: string,
  ciphertextPath: string,
  material: TrackKeyMaterial,
  { deletePlaintext = true }: { deletePlaintext?: boolean } = {}
): Promise<void> {
  const key = Buffer.from(material.keyHex, 'hex');
  if (key.length !== KEY_BYTES) {
    throw new Error(`Invalid key length: ${key.length}`);
  }
  const counter = buildCounter(material.nonceHex);

  await new Promise<void>((resolve, reject) => {
    const cipher = crypto.createCipheriv(ALGO, key, counter);
    const input = fs.createReadStream(plaintextPath);
    const output = fs.createWriteStream(ciphertextPath);
    input
      .on('error', reject)
      .pipe(cipher)
      .on('error', reject)
      .pipe(output)
      .on('error', reject)
      .on('finish', () => resolve());
  });

  if (deletePlaintext) {
    fs.unlinkSync(plaintextPath);
  }
}

/**
 * Build a streaming AES-CTR decryptor that accepts a byte-offset
 * (for HTTP Range requests). CTR is seekable: block N starts at byte 16*N,
 * and we set counter = nonce || u32be(N) and feed a slice prefix to align.
 */
export function buildDecryptStream(
  material: TrackKeyMaterial,
  byteOffset: number = 0
): { cipher: crypto.Cipher; skipBytes: number } {
  const key = Buffer.from(material.keyHex, 'hex');
  const nonce = Buffer.from(material.nonceHex, 'hex');

  const blockIndex = Math.floor(byteOffset / 16);
  const skipBytes = byteOffset % 16;

  const counter = Buffer.alloc(16);
  nonce.copy(counter, 0);
  counter.writeUInt32BE(blockIndex, 12);

  // Use createCipheriv (CTR is symmetric — decrypt == encrypt).
  const cipher = crypto.createCipheriv(ALGO, key, counter);
  return { cipher, skipBytes };
}

/**
 * Helper transform that drops the first N bytes of a stream
 * (used to align CTR block boundaries with a Range request).
 */
export function makeSkipTransform(n: number): Transform {
  let remaining = n;
  return new Transform({
    transform(chunk, _enc, cb) {
      if (remaining <= 0) {
        cb(null, chunk);
        return;
      }
      if (chunk.length <= remaining) {
        remaining -= chunk.length;
        cb();
        return;
      }
      const out = chunk.subarray(remaining);
      remaining = 0;
      cb(null, out);
    },
  });
}
