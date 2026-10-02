// Read-only facts about a vault's Validation Engine and code, from the chain (no backend call).
import { rpc } from "@stellar/stellar-sdk";
import { cfg, NETWORK } from "./config";
import { view } from "./chain";

/** Is the engine's Trustline validation switched on? (false = it approves everything). Null if unreadable. */
export async function oracleEnabled(engine: string): Promise<boolean | null> {
  try { return await view<boolean>(cfg, engine, "trustline_oracle_enabled"); } catch { return null; }
}

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

/** The sha256 of the code a contract runs, or null when it cannot be read. */
export async function codeHash(contract: string): Promise<string | null> {
  try {
    const code = await new rpc.Server(NETWORK.rpcUrl).getContractWasmByContractId(contract);
    return hex(await crypto.subtle.digest("SHA-256", code));
  } catch { return null; }
}
