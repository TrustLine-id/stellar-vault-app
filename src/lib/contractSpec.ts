// A contract's interface (the contract spec embedded in its WASM), read from the chain. Used to
// write the vault's checked functions with their exact types, as Trustline's dashboard expects them.
import { Contract, contract, rpc, xdr } from "@stellar/stellar-sdk";
import type { Config } from "./chain";

export async function loadSpec(cfg: Config, id: string): Promise<contract.Spec> {
  const s = new rpc.Server(cfg.rpcUrl);
  const res = await s.getLedgerEntries(new Contract(id).getFootprint());
  if (!res.entries.length) throw new Error("No contract at this address on this network");
  const exe = res.entries[0].val.contractData().val().instance().executable();
  if (exe.switch() === xdr.ContractExecutableType.contractExecutableStellarAsset()) throw new Error("A Stellar Asset Contract, not a vault");
  return contract.Spec.fromWasm(Buffer.from(await s.getContractWasmByContractId(id)));
}
