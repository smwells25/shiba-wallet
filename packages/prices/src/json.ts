/**
 * A small strict JSON parser (RFC 8259) that keeps every number as the exact
 * literal text it appeared as, instead of converting it to a float64 the way
 * JSON.parse does. Price APIs send prices as JSON numbers; parsing them with
 * JSON.parse and printing them again can change digits (and switches to
 * exponent notation below 1e-6), so providers use this parser to hand the
 * vendor's own digits to the exact decimal math in decimal.ts.
 *
 * Objects are returned as Maps, which avoids prototype-related key hazards
 * ("__proto__", "constructor") with untrusted input.
 */

export interface JsonNumber {
  readonly kind: 'number';
  /** The literal exactly as written, e.g. "0.093269" or "1.2e-7". */
  readonly literal: string;
}

export type JsonValue =
  | null
  | boolean
  | string
  | JsonNumber
  | JsonValue[]
  | Map<string, JsonValue>;

const MAX_DEPTH = 64;
// Anchored and without the sticky flag so the parser runs on any JS engine
// the app may use (including Hermes) without relying on newer RegExp features.
const NUMBER_RE = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const NUMBER_CHAR_RE = /[-+.eE0-9]/;

export function parseJsonLossless(text: string): JsonValue {
  let pos = 0;

  const fail = (message: string): never => {
    throw new SyntaxError(`Invalid JSON at offset ${pos}: ${message}`);
  };

  const skipWhitespace = (): void => {
    while (pos < text.length) {
      const c = text.charCodeAt(pos);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) pos++;
      else break;
    }
  };

  const parseString = (): string => {
    // Caller guarantees text[pos] === '"'.
    pos++;
    let out = '';
    for (;;) {
      if (pos >= text.length) fail('unterminated string');
      const c = text.charCodeAt(pos);
      if (c === 0x22) {
        pos++;
        return out;
      }
      if (c < 0x20) fail('control character in string');
      if (c !== 0x5c) {
        out += text[pos];
        pos++;
        continue;
      }
      const esc = text[pos + 1];
      pos += 2;
      switch (esc) {
        case '"': out += '"'; break;
        case '\\': out += '\\'; break;
        case '/': out += '/'; break;
        case 'b': out += '\b'; break;
        case 'f': out += '\f'; break;
        case 'n': out += '\n'; break;
        case 'r': out += '\r'; break;
        case 't': out += '\t'; break;
        case 'u': {
          const hex = text.slice(pos, pos + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail('bad unicode escape');
          out += String.fromCharCode(parseInt(hex, 16));
          pos += 4;
          break;
        }
        default:
          fail('bad escape');
      }
    }
  };

  const parseValue = (depth: number): JsonValue => {
    if (depth > MAX_DEPTH) fail('nesting too deep');
    skipWhitespace();
    const c = text[pos];
    if (c === '{') {
      pos++;
      const obj = new Map<string, JsonValue>();
      skipWhitespace();
      if (text[pos] === '}') {
        pos++;
        return obj;
      }
      for (;;) {
        skipWhitespace();
        if (text[pos] !== '"') fail('expected object key');
        const key = parseString();
        skipWhitespace();
        if (text[pos] !== ':') fail('expected ":"');
        pos++;
        obj.set(key, parseValue(depth + 1));
        skipWhitespace();
        if (text[pos] === ',') {
          pos++;
          continue;
        }
        if (text[pos] === '}') {
          pos++;
          return obj;
        }
        fail('expected "," or "}"');
      }
    }
    if (c === '[') {
      pos++;
      const arr: JsonValue[] = [];
      skipWhitespace();
      if (text[pos] === ']') {
        pos++;
        return arr;
      }
      for (;;) {
        arr.push(parseValue(depth + 1));
        skipWhitespace();
        if (text[pos] === ',') {
          pos++;
          continue;
        }
        if (text[pos] === ']') {
          pos++;
          return arr;
        }
        fail('expected "," or "]"');
      }
    }
    if (c === '"') return parseString();
    if (text.startsWith('true', pos)) {
      pos += 4;
      return true;
    }
    if (text.startsWith('false', pos)) {
      pos += 5;
      return false;
    }
    if (text.startsWith('null', pos)) {
      pos += 4;
      return null;
    }
    // Take the maximal run of number characters, then require the whole run
    // to be one valid JSON number (so "01", "1.", "1e" are rejected).
    let end = pos;
    while (end < text.length && NUMBER_CHAR_RE.test(text[end]!)) end++;
    const literal = text.slice(pos, end);
    if (literal.length > 0 && NUMBER_RE.test(literal)) {
      pos = end;
      return { kind: 'number', literal };
    }
    return fail('unexpected token');
  };

  const value = parseValue(0);
  skipWhitespace();
  if (pos !== text.length) fail('trailing characters');
  return value;
}

export function isJsonNumber(value: JsonValue | undefined): value is JsonNumber {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Map) &&
    value.kind === 'number'
  );
}

export function isJsonObject(value: JsonValue | undefined): value is Map<string, JsonValue> {
  return value instanceof Map;
}
