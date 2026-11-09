import { describe, expect, it } from "vitest";

import { canonicalJson } from "../canonicalJson.js";

describe("canonicalJson", () => {
	it("sorts object keys at every level", () => {
		const value = { z: -5, b: [1, { d: "é", c: null }], a: true };
		expect(canonicalJson(value)).toBe('{"a":true,"b":[1,{"c":null,"d":"é"}],"z":-5}');
	});

	it("sorts keys by UTF-16 code unit, not by locale or code point", () => {
		// localeCompare would put "a" before "B"; code point order would put U+1F600 after U+FFFF.
		// Built from entries: the keys are data, not names, so the naming rule doesn't apply.
		const value = Object.fromEntries([
			["￿", 1],
			["😀", 2],
			["é", 3],
			["aa", 4],
			["a", 5],
			["B", 6],
		]);
		expect(canonicalJson(value)).toBe('{"B":6,"a":5,"aa":4,"é":3,"😀":2,"￿":1}');
	});

	it("sorts integer-like keys as strings, not in the engine’s numeric key order", () => {
		expect(canonicalJson({ 9: "n", 10: "t", a: "a" })).toBe('{"10":"t","9":"n","a":"a"}');
	});

	it("writes -0 as 0", () => {
		expect(canonicalJson(-0)).toBe("0");
		expect(canonicalJson({ x: [-0] })).toBe('{"x":[0]}');
	});

	it("writes strings, numbers, booleans and null as JSON does", () => {
		expect(canonicalJson(['a"\\\n', 2147483653, -1.5, false, null])).toBe(
			'["a\\"\\\\\\n",2147483653,-1.5,false,null]',
		);
	});

	it("escapes a lone surrogate, so the text is always well-formed", () => {
		expect(canonicalJson("\uD83D")).toBe('"\\ud83d"');
	});

	it.each([
		["NaN", NaN],
		["Infinity", Infinity],
		["-Infinity", -Infinity],
		["NaN inside an object", { a: [1, NaN] }],
	])("throws on a non-finite number: %s", (_name, value) => {
		expect(() => canonicalJson(value)).toThrow(/finite/);
	});

	it.each([
		["undefined", undefined],
		["undefined in an object", { a: undefined }],
		["undefined in an array", [undefined]],
		["a function", () => 1],
		["a symbol", Symbol("s")],
		["a bigint", 1n],
		["a Date", new Date(0)],
		["a Map", new Map()],
		// What a class instance is to canonicalJson, without class syntax (banned in the sim, ADR-0005).
		[
			"an object with another prototype, as a class instance has",
			Object.create({ n: 1 }) as object,
		],
		["an object whose prototype has no constructor", Object.create(Object.create(null) as object)],
		// `.map` skips holes: [,] would read as [] and [,1] as the invalid text "[,1]".
		["a sparse array", Object.assign([], { 1: 1 })],
		["an array of holes only", new Array(3)],
		["a sparse array with an extra property", Object.assign([], { 1: 1, foo: 2 })],
		// JSON.stringify and Object.keys skip these silently, so two different values would hash alike.
		["an array with an extra property", Object.assign([1], { foo: 2 })],
		["an object with a symbol key", { a: 1, [Symbol("s")]: 2 }],
		["an array with a symbol key", Object.assign([1], { [Symbol("s")]: 2 })],
		[
			"an object with a non-enumerable property",
			Object.defineProperty({ a: 1 }, "hidden", { value: 2 }),
		],
		[
			"an object with a getter",
			{
				get a() {
					return 1;
				},
			},
		],
		["an array with a getter", Object.defineProperty([0], 0, { get: () => 1, enumerable: true })],
	])("throws on a value that is not plain JSON data: %s", (_name, value) => {
		expect(() => canonicalJson(value)).toThrow(/plain JSON/);
	});

	it("never calls a getter", () => {
		let calls = 0;
		const value = {
			get a() {
				calls++;
				return 1;
			},
		};
		expect(() => canonicalJson(value)).toThrow(/plain JSON/);
		expect(calls).toBe(0);
	});

	it("throws on a cycle, naming it, instead of overflowing the stack", () => {
		const object: Record<string, unknown> = { a: 1 };
		object["self"] = { back: object };
		const array: unknown[] = [1];
		array.push([array]);
		expect(() => canonicalJson(object)).toThrow(/cycle/);
		expect(() => canonicalJson(array)).toThrow(/cycle/);
	});

	it("accepts the same object twice when it is not a cycle", () => {
		const shared = { n: 1 };
		expect(canonicalJson({ a: shared, b: [shared, shared] })).toBe(
			'{"a":{"n":1},"b":[{"n":1},{"n":1}]}',
		);
	});

	it("accepts an object without a prototype", () => {
		const value = Object.create(null) as Record<string, number>;
		value["b"] = 2;
		value["a"] = 1;
		expect(canonicalJson(value)).toBe('{"a":1,"b":2}');
	});
});
