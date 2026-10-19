// QR codes in numbered parts, as a reusable codec (phase 22 item 3).
//
// The multisig screens (phase 19 item 1) introduced the scheme: a payload
// that does not fit one reliable QR code is shown as 2 to N codes
// "<PREFIX><n>/<total>:<chunk>" whose chunks, joined in order, are exactly the
// payload; the scanner collects parts in any order. wallet/multisig.ts keeps
// its own copy for the "SW-MS:" prefix (its strings are pinned by
// scripts/check-multisig.mjs and stay byte-identical); this module is the same
// algorithm parameterised by the prefix and the damaged-code sentence, used by
// the cold-signing flow ("SW-CS:", wallet/cold-signing.ts). Nothing here
// trusts the content: callers hand a complete text to their own parser.
//
// Free of React Native so Node's type stripping can run it in the check
// scripts.

/**
 * The UTF-8 length of a text in bytes (each QR byte-mode character is one
 * byte), counted from code points without depending on TextEncoder (as
 * wallet/recovery.ts utf8Length does).
 */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/** The parts read so far of a multi-part code (index n − 1 holds part n). */
export interface QrPartScan {
  total: number;
  parts: (string | null)[];
}

export type QrPartScanResult =
  | { kind: 'complete'; text: string }
  | { kind: 'partial'; scan: QrPartScan; received: number; total: number; repeated: boolean };

export interface QrPartCodec {
  readonly prefix: string;
  readonly maxBytes: number;
  readonly maxParts: number;
  /** The codes for a payload: itself when it fits one code, else numbered parts; null when empty or too large. */
  split(payload: string): string[] | null;
  /** Takes one scanned text; see createQrPartCodec. */
  accept(scan: QrPartScan | null, data: string): QrPartScanResult;
  /** The part number and total when `text` is ONE part of a multi-part code, else null. */
  partOf(text: string): { n: number; total: number } | null;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Cuts `text` into chunks of at most `maxBytes` UTF-8 bytes, between code points. */
function cutByBytes(text: string, maxBytes: number): string[] {
  const out: string[] = [];
  let current = '';
  let size = 0;
  for (const ch of text) {
    const n = utf8ByteLength(ch);
    if (size + n > maxBytes && current !== '') {
      out.push(current);
      current = '';
      size = 0;
    }
    current += ch;
    size += n;
  }
  if (current !== '') out.push(current);
  return out;
}

/**
 * A codec for "<prefix><n>/<total>:<chunk>" parts, with the same rules as the
 * multisig scheme (wallet/multisig.ts splitMultisigQrParts and
 * acceptMultisigQrScan):
 *  - split: a payload that fits `maxBytes` is ONE plain code; otherwise 2 to
 *    `maxParts` parts cut between code points, as even as possible, each
 *    part (prefix included) within `maxBytes`;
 *  - accept: a text without the prefix is a whole payload, but only when no
 *    multi-part code is being read; a part must be well formed (1 ≤ n ≤
 *    total, 2 ≤ total ≤ maxParts, a non-empty chunk), have the same total
 *    as the parts read before it, and not contradict a part already read
 *    (the same part twice is fine). When every part is in, the joined text
 *    is complete.
 */
export function createQrPartCodec(options: {
  prefix: string;
  maxBytes: number;
  maxParts: number;
  /** The sentence for a part that has the prefix but cannot be read. */
  damagedSentence: string;
}): QrPartCodec {
  const { prefix, maxBytes, maxParts, damagedSentence } = options;
  if (maxParts < 2 || maxParts > 99) throw new Error('maxParts must be 2 to 99');
  const pattern = new RegExp(`^${escapeRegExp(prefix)}([1-9][0-9]?)\\/([1-9][0-9]?):([\\s\\S]+)$`);

  const split = (payload: string): string[] | null => {
    if (payload.length === 0) return null;
    const bytes = utf8ByteLength(payload);
    if (bytes <= maxBytes) return [payload];
    const budget = maxBytes - utf8ByteLength(`${prefix}${maxParts}/${maxParts}:`);
    if (budget <= 0) return null;
    const total = Math.ceil(bytes / budget);
    if (total > maxParts) return null;
    const chunks = cutByBytes(payload, Math.ceil(bytes / total));
    const finalChunks = chunks.length === total ? chunks : cutByBytes(payload, budget);
    if (finalChunks.length > maxParts) return null;
    const parts = finalChunks.map((c, i) => `${prefix}${i + 1}/${finalChunks.length}:${c}`);
    if (parts.some((part) => utf8ByteLength(part) > maxBytes)) return null;
    return parts;
  };

  const partOf = (text: string): { n: number; total: number } | null => {
    const m = pattern.exec(text.trim());
    return m ? { n: Number(m[1]), total: Number(m[2]) } : null;
  };

  const accept = (scan: QrPartScan | null, data: string): QrPartScanResult => {
    const text = data.trim();
    const received = scan ? scan.parts.filter((x) => x !== null).length : 0;
    if (!text.startsWith(prefix)) {
      if (scan && received > 0) {
        throw new Error(
          `This QR code is not part of the code being read (${received} of ${scan.total} parts read so far). ` +
            'Scan the next part of the same code, or tap Start over.',
        );
      }
      if (text === '') throw new Error('The QR code was empty.');
      return { kind: 'complete', text };
    }
    const m = pattern.exec(text);
    const n = m ? Number(m[1]) : NaN;
    const total = m ? Number(m[2]) : NaN;
    if (!m || total < 2 || total > maxParts || n > total) throw new Error(damagedSentence);
    const chunk = m[3]!;
    if (scan && received > 0 && scan.total !== total) {
      throw new Error(
        `This part belongs to a code in ${total} parts, but the code being read has ${scan.total}. ` +
          'Tap Start over to read a different code.',
      );
    }
    const parts = scan && received > 0 ? [...scan.parts] : new Array<string | null>(total).fill(null);
    const previous = parts[n - 1];
    if (previous !== null && previous !== undefined && previous !== chunk) {
      throw new Error(`Part ${n} was already read with different contents, so this is another code. Tap Start over to read a different code.`);
    }
    const repeated = previous === chunk;
    parts[n - 1] = chunk;
    const have = parts.filter((x) => x !== null).length;
    if (have === total) return { kind: 'complete', text: parts.join('') };
    return { kind: 'partial', scan: { total, parts }, received: have, total, repeated };
  };

  return { prefix, maxBytes, maxParts, split, accept, partOf };
}
