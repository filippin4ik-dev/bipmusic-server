import fs from 'fs';

/**
 * Sniff the first few bytes of a file to confirm it really is an audio file.
 * This blocks attacks where an attacker renames evil.exe → song.mp3.
 *
 * Supported magic byte signatures:
 *   - MP3 ID3v2 tag:           "ID3"
 *   - MP3 frame sync:          0xFF 0xFB / 0xFF 0xF3 / 0xFF 0xF2 / 0xFF 0xFA / 0xFF 0xE3
 *   - M4A / MP4 container:     bytes 4..7 == "ftyp"
 *   - FLAC:                    "fLaC"
 *   - OGG:                     "OggS"
 *   - WAV (RIFF/WAVE):         bytes 0..3 == "RIFF" && 8..11 == "WAVE"
 *   - AAC ADTS:                0xFF 0xF1 / 0xFF 0xF9
 */
export function isLikelyAudioFile(filePath: string): boolean {
  let buf: Buffer;
  try {
    const fd = fs.openSync(filePath, 'r');
    buf = Buffer.alloc(16);
    fs.readSync(fd, buf, 0, 16, 0);
    fs.closeSync(fd);
  } catch {
    return false;
  }

  // ID3
  if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return true;

  // MPEG audio frame sync (11 bits set: 0xFF 0xEx where E has top 3 bits set)
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return true;

  // MP4 container: "ftyp" at offset 4
  if (buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) return true;

  // FLAC
  if (buf[0] === 0x66 && buf[1] === 0x4c && buf[2] === 0x61 && buf[3] === 0x43) return true;

  // OGG
  if (buf[0] === 0x4f && buf[1] === 0x67 && buf[2] === 0x67 && buf[3] === 0x53) return true;

  // RIFF/WAVE
  if (
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x41 && buf[10] === 0x56 && buf[11] === 0x45
  ) return true;

  return false;
}
