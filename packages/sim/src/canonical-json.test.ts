import { describe, expect, test } from 'vitest';
import { canonicalJson } from './canonical-json.js';

describe('canonicalJson', () => {
  test('sorts object keys at every level', () => {
    const value = { z: -5, b: [1, { d: 'é', c: null }], a: true };
    expect(canonicalJson(value)).toBe('{"a":true,"b":[1,{"c":null,"d":"é"}],"z":-5}');
  });

  test('sorts keys by UTF-16 code unit, not by locale or code point', () => {
    // localeCompare would put "a" before "B"; code point order would put U+1F600 after U+FFFF.
    const value = { '￿': 1, '😀': 2, é: 3, aa: 4, a: 5, B: 6 };
    expect(canonicalJson(value)).toBe('{"B":6,"a":5,"aa":4,"é":3,"😀":2,"￿":1}');
  });

  test('sorts integer-like keys as strings, not in the engine’s numeric key order', () => {
    expect(canonicalJson({ 9: 'n', 10: 't', a: 'a' })).toBe('{"10":"t","9":"n","a":"a"}');
  });

  test('writes -0 as 0', () => {
    expect(canonicalJson(-0)).toBe('0');
    expect(canonicalJson({ x: [-0] })).toBe('{"x":[0]}');
  });

  test('writes strings, numbers, booleans and null as JSON does', () => {
    expect(canonicalJson(['a"\\\n', 2147483653, -1.5, false, null])).toBe('["a\\"\\\\\\n",2147483653,-1.5,false,null]');
  });

  test('escapes a lone surrogate, so the text is always well-formed', () => {
    expect(canonicalJson('\uD83D')).toBe('"\\ud83d"');
  });

  test.each([
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['-Infinity', -Infinity],
    ['NaN inside an object', { a: [1, NaN] }],
  ])('throws on a non-finite number: %s', (_name, value) => {
    expect(() => canonicalJson(value)).toThrow(/finite/);
  });

  test.each([
    ['undefined', undefined],
    ['undefined in an object', { a: undefined }],
    ['undefined in an array', [undefined]],
    ['a function', () => 1],
    ['a symbol', Symbol('s')],
    ['a bigint', 1n],
    ['a Date', new Date(0)],
    ['a Map', new Map()],
    ['a class instance', new (class Thing { readonly n = 1; })()],
    ['an object whose prototype has no constructor', Object.create(Object.create(null))],
  ])('throws on a value that is not plain JSON data: %s', (_name, value) => {
    expect(() => canonicalJson(value)).toThrow(/plain JSON/);
  });

  test('accepts an object without a prototype', () => {
    const value: Record<string, number> = Object.create(null);
    value['b'] = 2;
    value['a'] = 1;
    expect(canonicalJson(value)).toBe('{"a":1,"b":2}');
  });
});
