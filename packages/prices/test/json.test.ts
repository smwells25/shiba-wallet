import { describe, expect, it } from 'vitest';
import { isJsonNumber, isJsonObject, parseJsonLossless } from '../src/json.js';

describe('parseJsonLossless', () => {
  it('keeps number literals verbatim', () => {
    const value = parseJsonLossless(
      '{"a":0.1000000000000000055511151231257827,"b":1.23e-7,"c":-0,"d":83272}',
    );
    expect(isJsonObject(value)).toBe(true);
    const obj = value as Map<string, unknown>;
    expect(obj.get('a')).toEqual({ kind: 'number', literal: '0.1000000000000000055511151231257827' });
    expect(obj.get('b')).toEqual({ kind: 'number', literal: '1.23e-7' });
    expect(obj.get('c')).toEqual({ kind: 'number', literal: '-0' });
    expect(obj.get('d')).toEqual({ kind: 'number', literal: '83272' });
  });

  it('parses the full JSON grammar', () => {
    const value = parseJsonLossless(
      ' { "s" : "a\\"b\\\\c\\u00e9\\n" , "t" : true , "f" : false , "n" : null , "arr" : [ 1 , [ ] , { } ] } ',
    ) as Map<string, unknown>;
    expect(value.get('s')).toBe('a"b\\cé\n');
    expect(value.get('t')).toBe(true);
    expect(value.get('f')).toBe(false);
    expect(value.get('n')).toBe(null);
    const arr = value.get('arr') as unknown[];
    expect(arr).toHaveLength(3);
    expect(isJsonNumber(arr[0] as never)).toBe(true);
    expect(arr[1]).toEqual([]);
    expect(isJsonObject(arr[2] as never)).toBe(true);
  });

  it('treats __proto__ as an ordinary key', () => {
    const value = parseJsonLossless('{"__proto__":{"x":1}}') as Map<string, unknown>;
    expect(value.has('__proto__')).toBe(true);
    expect(({} as Record<string, unknown>)['x']).toBeUndefined();
  });

  it.each([
    '',
    '{',
    '{"a":1,}',
    '[1,]',
    "{'a':1}",
    '{"a":NaN}',
    '{"a":Infinity}',
    '{"a":01}',
    '{"a":1.}',
    '{"a":.5}',
    '{"a":1} x',
    '"unterminated',
    '"bad \\x escape"',
    '"raw \n newline"',
    '<html>rate limited</html>',
    '[' .repeat(100) + ']'.repeat(100),
  ])('rejects %j', (text) => {
    expect(() => parseJsonLossless(text)).toThrow(SyntaxError);
  });
});
