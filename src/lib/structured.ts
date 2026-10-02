// A Soroban call described the way the Trustline backend rebuilds it (the structured-intent
// grammar of the web SDK's README): a `functionPrototype` whose parameter types say how to
// convert each positional JSON value, with nothing guessed from the values. The types are read from the actual argument
// values, so the backend rebuilds exactly the same ScVals and, encoding them as `intentData`
// does, exactly the bytes the contract hashes.
//   scalars: address, symbol, string, bool, u32, i32, u64, i64, u128, i128, u256, i256,
//            timepoint, duration, bytes (hex "0x…"), void (null)
//   vec<T> for a list of one type, vec<T1,T2,…> for a mixed list (a Vec<Val>, an enum variant
//   with its payload), vec<> for an empty list; map<K,V> as [[key, value], …] when keys and
//   values each have one type; struct{field:type,…} as a JSON object for a map with symbol keys
//   (a #[contracttype] struct, e.g. the vault's Fees), each field typed.
// Every description is re-encoded here exactly as the backend converts it (`backendScVal`) and
// used only if the result is the same ScVal; otherwise the call is not describable (null).
import { Address, nativeToScVal, scValToNative, xdr } from "@stellar/stellar-sdk";
import type { StructuredArg, StructuredIntentData } from "./trustlineSdk";

type Described = { type: string; value: StructuredArg };

function describe(v: xdr.ScVal): Described | null {
  const T = xdr.ScValType;
  const num = (type: string): Described => ({ type, value: String(scValToNative(v)) });
  switch (v.switch()) {
    case T.scvAddress(): return { type: "address", value: Address.fromScVal(v).toString() };
    case T.scvSymbol(): return { type: "symbol", value: v.sym().toString() };
    case T.scvString(): return { type: "string", value: v.str().toString() };
    case T.scvBool(): return { type: "bool", value: v.b() };
    case T.scvVoid(): return { type: "void", value: null };
    case T.scvU32(): return { type: "u32", value: v.u32() };
    case T.scvI32(): return { type: "i32", value: v.i32() };
    case T.scvU64(): return num("u64");
    case T.scvI64(): return num("i64");
    case T.scvU128(): return num("u128");
    case T.scvI128(): return num("i128");
    case T.scvU256(): return num("u256");
    case T.scvI256(): return num("i256");
    case T.scvTimepoint(): return num("timepoint");
    case T.scvDuration(): return num("duration");
    case T.scvBytes(): return { type: "bytes", value: "0x" + Buffer.from(v.bytes()).toString("hex") };
    case T.scvVec(): {
      const items = (v.vec() ?? []).map(describe);
      if (items.some((x) => !x)) return null;
      const ok = items as Described[];
      if (!ok.length) return { type: "vec<>", value: [] };
      const types = new Set(ok.map((x) => x.type));
      return { type: `vec<${types.size === 1 ? ok[0].type : ok.map((x) => x.type).join(",")}>`, value: ok.map((x) => x.value) };
    }
    case T.scvMap(): {
      const entries = (v.map() ?? []).map((e) => [e.key(), describe(e.val())] as const);
      if (entries.some(([, x]) => !x)) return null;
      if (entries.length && entries.every(([k]) => k.switch() === T.scvSymbol())) {
        // A struct: its fields by name, each with its type.
        const fields = entries.map(([k, x]) => [k.sym().toString(), x!] as const);
        return { type: `struct{${fields.map(([n, x]) => `${n}:${x.type}`).join(",")}}`, value: Object.fromEntries(fields.map(([n, x]) => [n, x.value])) };
      }
      const keys = entries.map(([k]) => describe(k));
      if (keys.some((k) => !k)) return null;
      const ks = new Set(keys.map((k) => k!.type)), vs = new Set(entries.map(([, x]) => x!.type));
      if (!entries.length || ks.size !== 1 || vs.size !== 1) return null;
      return { type: `map<${keys[0]!.type},${entries[0][1]!.type}>`, value: entries.map(([, x], i) => [keys[i]!.value, x!.value]) };
    }
    default: return null;
  }
}

/** `name(types…)` with positional values, or null when the backend would not rebuild an argument exactly. */
export function describeCall(name: string, args: xdr.ScVal[]): StructuredIntentData | null {
  const parts = args.map(describe);
  if (parts.some((p) => !p)) return null;
  const ok = parts as Described[];
  // Only what the backend rebuilds into the very same values.
  for (let i = 0; i < ok.length; i++) {
    try {
      if (backendScVal(ok[i].type, ok[i].value).toXDR("base64") !== args[i].toXDR("base64")) return null;
    } catch { return null; }
  }
  return { functionPrototype: `${name}(${ok.map((p) => p.type).join(",")})`, args: ok.map((p) => p.value) };
}

// ---- The backend's conversion, mirrored ----

/** Split at the commas of the top level (outside <…>, (…) and {…}). */
function splitTop(body: string): string[] {
  const out: string[] = []; let depth = 0, cur = "";
  for (const ch of body) {
    if (ch === "<" || ch === "(" || ch === "{") depth++;
    if (ch === ">" || ch === ")" || ch === "}") depth--;
    if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
/** The type arguments of `ctor<…>`, or null when there are no brackets. */
const generic = (t: string, ctor: string): string[] | null => {
  const rest = t.trim().slice(ctor.length).trim();
  return rest.startsWith("<") && rest.endsWith(">") ? splitTop(rest.slice(1, -1)) : null;
};
/** `struct{a:address,b:i128}` or `{a:address,b:i128}` as [name, type] pairs. */
function structFields(t: string): [string, string][] {
  const body = t.trim().replace(/^struct\s*/i, "");
  if (!body.startsWith("{") || !body.endsWith("}")) throw new Error("struct");
  const fields = splitTop(body.slice(1, -1)).map((part): [string, string] => {
    const colon = topLevelColon(part);
    if (colon <= 0) throw new Error("struct field");
    return [part.slice(0, colon).trim(), part.slice(colon + 1).trim()];
  });
  if (!fields.length) throw new Error("struct needs a field");
  return fields;
}
function topLevelColon(s: string): number {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "<" || ch === "(" || ch === "{") depth++;
    else if (ch === ">" || ch === ")" || ch === "}") depth--;
    else if (ch === ":" && depth === 0) return i;
  }
  return -1;
}
/** `amount:i128` is `i128`; a struct or a vec keeps its own colons. */
function stripName(t: string): string {
  const s = t.trim(), l = s.toLowerCase();
  if (l.startsWith("struct") || s.startsWith("{") || l.startsWith("vec") || l.startsWith("map") || l.startsWith("option") || l.startsWith("tuple") || s.startsWith("(")) return s;
  const colon = topLevelColon(s);
  return colon > 0 ? s.slice(colon + 1).trim() : s;
}
const big = (v: StructuredArg) => BigInt(typeof v === "number" ? v : String(v));
const bytesOf = (v: StructuredArg) => Buffer.from(String(v).replace(/^0x/i, ""), "hex");

function backendScVal(type: string, v: StructuredArg): xdr.ScVal {
  const t = stripName(type), l = t.toLowerCase();
  if (l === "void") { if (v !== null) throw new Error("void"); return xdr.ScVal.scvVoid(); }
  if (l === "val") throw new Error("val is not allowed");
  if (l.startsWith("option")) { const g = generic(t, "option"); if (!g || g.length !== 1) throw new Error("option"); return v === null ? xdr.ScVal.scvVoid() : backendScVal(g[0], v); }
  if (l.startsWith("map")) {
    const g = generic(t, "map");
    if (!g || g.length !== 2) throw new Error("map");
    const pairs = Array.isArray(v) ? (v as StructuredArg[][]) : Object.entries(v as object);
    return xdr.ScVal.scvMap(pairs.map(([k, x]) => new xdr.ScMapEntry({ key: backendScVal(g[0], k as StructuredArg), val: backendScVal(g[1], x as StructuredArg) })));
  }
  if (l.startsWith("struct") || t.startsWith("{")) {
    const fields = structFields(t);
    let byName: [string, StructuredArg][];
    if (Array.isArray(v)) {
      if (v.length !== fields.length) throw new Error("struct arity");
      byName = fields.map(([n], i) => [n, v[i]]);
    } else if (v && typeof v === "object") {
      const o = v as { [key: string]: StructuredArg };
      for (const k of Object.keys(o)) if (!fields.some(([n]) => n === k)) throw new Error(`unknown field ${k}`);
      byName = fields.map(([n]) => { if (!(n in o)) throw new Error(`missing field ${n}`); return [n, o[n]]; });
    } else throw new Error("struct value");
    // Soroban host: map keys sorted.
    return xdr.ScVal.scvMap(byName.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([n, x]) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(n), val: backendScVal(fields.find(([f]) => f === n)![1], x) })));
  }
  if (l.startsWith("vec")) {
    const inner = generic(t, "vec");
    if (!inner) throw new Error("bare vec is not allowed");
    const items = v as StructuredArg[];
    if (!Array.isArray(items)) throw new Error("vec value");
    if (inner.length === 0) { if (items.length) throw new Error("vec<> takes an empty list"); return xdr.ScVal.scvVec([]); }
    if (inner.length === 1) return xdr.ScVal.scvVec(items.map((x) => backendScVal(inner[0], x)));
    if (inner.length !== items.length) throw new Error("vec arity");
    return xdr.ScVal.scvVec(inner.map((p, i) => backendScVal(p, items[i])));
  }
  if (l.startsWith("tuple") || t.startsWith("(")) {
    const parts = t.startsWith("(") ? splitTop(t.slice(1, -1)) : generic(t, "tuple") ?? [];
    const items = v as StructuredArg[];
    if (parts.length !== items.length) throw new Error("tuple arity");
    return xdr.ScVal.scvVec(parts.map((p, i) => backendScVal(p, items[i])));
  }
  switch (l) {
    case "address": case "muxed_address": return new Address(String(v)).toScVal();
    case "symbol": return xdr.ScVal.scvSymbol(String(v));
    case "string": return xdr.ScVal.scvString(String(v));
    case "bool": if (typeof v !== "boolean") throw new Error("bool"); return xdr.ScVal.scvBool(v);
    case "i32": return xdr.ScVal.scvI32(Number(v));
    case "u32": return xdr.ScVal.scvU32(Number(v));
    case "i64": case "u64": case "timepoint": case "duration": case "i128": case "u128": case "i256": case "u256":
      return nativeToScVal(big(v), { type: l });
  }
  if (l === "bytes" || l.startsWith("bytesn") || l.startsWith("bytes_n")) return xdr.ScVal.scvBytes(bytesOf(v));
  throw new Error(`unknown type ${t}`);
}

/**
 * The intent bytes, as the backend and the contracts (`trustline_sdk::encode_call_data`) compute
 * them: utf8(name) followed by the XDR of the only argument, or of the vector of all arguments
 * (nothing when there are none).
 */
export function intentData(name: string, args: xdr.ScVal[]): Buffer {
  const encoded = args.length === 0 ? Buffer.alloc(0) : args.length === 1 ? args[0].toXDR() : xdr.ScVal.scvVec(args).toXDR();
  return Buffer.concat([Buffer.from(name, "utf8"), encoded]);
}

export const NOT_DESCRIBABLE =
  "Trustline cannot check this call: one of its arguments has a shape its backend cannot type (a map whose keys or values are of several types). Nothing was approved or spent.";
