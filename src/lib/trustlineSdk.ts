// Trustline, through its web SDK (@trustline.id/websdk) only: this app never calls Trustline's
// backend directly. `validate` opens a session, shows Trustline's hosted page for the email code
// when the vault's policy asks for one, and returns once the backend has published the approval
// on the vault's Validation Engine.
import { trustline, type TrustlineValidateResponse, type TrustlineWeb3ValidateParams } from "@trustline.id/websdk";

/**
 * The web SDK needs a client id. The backend takes the client from the vault's registration and
 * uses this one only for unregistered contracts; VITE_TRUSTLINE_CLIENT_ID overrides it.
 */
const TRUSTLINE_CLIENT_ID: string = (import.meta as { env?: Record<string, string> }).env?.VITE_TRUSTLINE_CLIENT_ID ?? "trustline-vault-app";
let sdkReady = false;

/** Positional JSON values; types come from `functionPrototype`. */
export type StructuredArg =
  | string
  | number
  | boolean
  | null
  | StructuredArg[]
  | { [key: string]: StructuredArg };

export type StructuredIntentData = {
  /** e.g. `deposit(i128,address,address,address)`, `submit(vec<symbol,address>)` */
  functionPrototype: string;
  args?: StructuredArg[];
};

/** The web SDK's parameters, with the structured form of `data`. */
export type ValidateParams = Omit<TrustlineWeb3ValidateParams, "data"> & { data: StructuredIntentData };

export type ValidateResult = {
  status: "approved";
  /** The intent id, as the engine stores the approval. */
  certId?: string;
  attestation?: { timestamp: string; policyHash: string };
};

/** Pre-validate one call with Trustline (the web SDK); throws when Trustline refuses it. */
export async function validate(params: ValidateParams): Promise<ValidateResult> {
  if (typeof HTMLElement === "undefined") throw new Error("Trustline's web SDK runs in a browser");
  if (!sdkReady) { trustline.init({ clientId: TRUSTLINE_CLIENT_ID }); sdkReady = true; }
  const res: TrustlineValidateResponse = await trustline.validate({ validationMode: "dapp", ...params });
  if ("error" in res) throw new Error(res.error.message || "Trustline validate failed");
  const r = res.result;
  if (r.status === "rejected") throw new Error(`${r.type || "REJECTED"}: ${r.reason || "validation rejected"}`);
  if (r.status === "approval_required") throw new Error("Trustline asks for a manual approval of this call; this app does not wait for one");
  if (r.status !== "approved") throw new Error(`Unexpected validate status: ${String((r as { status: unknown }).status)}`);
  return { status: r.status, certId: r.certId, attestation: r.attestation };
}
