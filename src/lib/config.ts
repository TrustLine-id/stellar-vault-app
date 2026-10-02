// Deployment settings. Override at build time with VITE_* variables (see .env.example).
import { Asset } from "@stellar/stellar-sdk";
import type { Config } from "./chain";

// Vite injects import.meta.env in the browser; scripts run under Node read process.env.
const env: Record<string, string | undefined> =
  (import.meta as { env?: Record<string, string> }).env ?? (globalThis as { process?: { env: Record<string, string> } }).process?.env ?? {};

export const NETWORK = {
  name: env.VITE_NETWORK_NAME ?? "Stellar Testnet",
  passphrase: env.VITE_NETWORK_PASSPHRASE ?? "Test SDF Network ; September 2015",
  rpcUrl: env.VITE_RPC_URL ?? "https://soroban-testnet.stellar.org",
  explorer: env.VITE_EXPLORER_URL ?? "https://stellar.expert/explorer/testnet",
  isTestnet: (env.VITE_NETWORK_PASSPHRASE ?? "Test SDF Network ; September 2015").startsWith("Test"),
};

export const cfg: Config = {
  rpcUrl: NETWORK.rpcUrl,
  networkPassphrase: NETWORK.passphrase,
  backendChainId: env.VITE_BACKEND_CHAIN_ID ?? "2",
};

/** Trustline's Validation Engine code (sha256 of the WASM): each vault gets its own engine. */
export const WASM = {
  engine: env.VITE_WASM_ENGINE ?? "d975aa687bcc029bcce7fb8c293a5b4745cd7db980270ec10f32682d8256962e",
};

/** Earlier builds of the reference vault still recognised by name. */
export const EARLIER_CODE = {
  vault: [
    { hash: "65f7704a82c0c3921492a67e890965b439b4aededcf5e54ed98d1fe8c3616888", commit: "legacy build", note: "previous testnet build before the reproducible-build." },
    { hash: "1f11f04446a717bb3c2326e493de6605b8696b4496d573511e1c11097b748425", commit: "legacy build", note: "previous testnet build before the Trustline core WASM refresh." },
    { hash: "f72ed82574a02d24dd5e603bab41a64481b3625db0aa24ba89d1b393a6f2b57e", commit: "legacy build", note: "the same functions and roles, before its storage-lifetime update." },
  ],
};

/**
 * Trustline's reference SEP-56 vault (TrustLine-id/stellar-vault): the
 * code this app deploys, built from the commit below and uploaded to testnet. Vaults deployed
 * elsewhere may run another build; the app shows their code hash.
 */
export const REFERENCE_VAULT = {
  repo: "TrustLine-id/stellar-vault",
  commit: "80700c5",
  vault: env.VITE_WASM_VAULT ?? "ebdf2634891ab4f6d709541f22de32c5812da05433b584a9c9e6328679e13c4d",
  /** Its reference adapter (`dummy-adapter` in the same repository): holds what the vault allocates to it. */
  adapter: env.VITE_WASM_REFERENCE_ADAPTER ?? "5e3b9d8081d3c10d883b66ddb3441c88a08796c80d4994786e4e9902b8e00700",
};

export const TRUSTLINE = {
  /** Trustline's registry on this network: the engines read which oracle accounts may publish approvals. */
  registry: env.VITE_TRUSTLINE_REGISTRY ?? "CAOQSLSB4LGPE4JYWTCVURE76LQC5IZUOWLU3NLELXXD6ATNV6B6LHRT",
  /** Trustline's client dashboard, where a project registers its contracts and their policies. */
  dashboardUrl: env.VITE_TRUSTLINE_DASHBOARD_URL ?? "https://onboarding.trustline.id/",
};

/** Circle's testnet USDC (classic asset, used through its Stellar Asset Contract). */
export const TESTNET_USDC = { code: "USDC", issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" };

/** The Stellar Asset Contract of XLM on this network (a function of the network passphrase). */
export const NATIVE_TOKEN: string = Asset.native().contractId(NETWORK.passphrase);

export const explorer = {
  account: (a: string) => `${NETWORK.explorer}/${a.startsWith("C") ? "contract" : "account"}/${a}`,
  tx: (h: string) => `${NETWORK.explorer}/tx/${h}`,
};
