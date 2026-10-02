// A vault's Validation Engine as the chain shows it, and its Trustline switch
// (`set_validation_configuration`, engine admin only). No backend call.
import { Address, Contract, nativeToScVal, rpc, scValToNative, xdr } from "@stellar/stellar-sdk";
import { cfg, WASM } from "./config";
import { view, type Signer } from "./chain";
import { codeHash } from "./trustline";
import { invoke } from "./vault";

export type EngineInfo = {
  address: string;
  codeHash: string | null;
  knownCode: boolean;
  version: number | null;
  admin: string | null;
  registry: string | null;
  trustlineOn: boolean | null;
  sanctionsOn: boolean | null;
  sanctionsKey: string | null;
};

/** The contract's instance storage, by key name. */
async function readInstance(id: string): Promise<Record<string, unknown>> {
  const res = await new rpc.Server(cfg.rpcUrl).getLedgerEntries(new Contract(id).getFootprint());
  if (!res.entries.length) throw new Error(`No contract ${id} on this network`);
  const out: Record<string, unknown> = {};
  for (const e of res.entries[0].val.contractData().val().instance().storage() ?? []) {
    const k = e.key();
    // contracttype unit variant = vec[Symbol]; symbol_short!() = Symbol.
    const name = k.switch() === xdr.ScValType.scvSymbol() ? k.sym().toString()
      : k.switch() === xdr.ScValType.scvVec() && k.vec()?.length === 1 && k.vec()![0].switch() === xdr.ScValType.scvSymbol() ? k.vec()![0].sym().toString()
      : k.toXDR("base64");
    try { out[name] = scValToNative(e.val()); } catch { out[name] = e.val().toXDR("base64"); }
  }
  return out;
}

const str = (v: unknown) => (typeof v === "string" ? v : null);
const bool = (v: unknown) => (typeof v === "boolean" ? v : null);

export async function readEngine(address: string): Promise<EngineInfo> {
  const [s, hash, version] = await Promise.all([
    readInstance(address).catch(() => ({} as Record<string, unknown>)),
    codeHash(address),
    view<number>(cfg, address, "version").catch(() => null),
  ]);
  return {
    address, codeHash: hash, knownCode: hash === WASM.engine, version: version == null ? null : Number(version),
    admin: str(s.Admin), registry: str(s.Registry),
    trustlineOn: bool(s.TrustlineOracleEnabled), sanctionsOn: bool(s.SanctionsOracleEnabled), sanctionsKey: str(s.SanctionsKey),
  };
}

/** Hand the engine's administration over (its `transfer_admin`). Signed by the current admin, not checked by Trustline. */
export async function transferEngineAdmin(e: EngineInfo, admin: string, newAdmin: string, sign: Signer): Promise<string> {
  return invoke(cfg, admin, e.address, "transfer_admin", [new Address(newAdmin).toScVal()], sign);
}

/** Switch the engine's Trustline check on or off, the sanctions settings kept as they are. Signed by the engine's admin. */
export async function switchTrustline(e: EngineInfo, admin: string, on: boolean, sign: Signer): Promise<string> {
  if (e.sanctionsOn && !e.sanctionsKey) throw new Error("Sanctions screening is on but its registry key is unreadable: cannot keep it");
  // (trustline_enabled, sanctions_enabled, sanctions_key: Option<String>)
  const args = [xdr.ScVal.scvBool(on), xdr.ScVal.scvBool(!!e.sanctionsOn), e.sanctionsKey ? nativeToScVal(e.sanctionsKey, { type: "string" }) : xdr.ScVal.scvVoid()];
  return invoke(cfg, admin, e.address, "set_validation_configuration", args, sign);
}
