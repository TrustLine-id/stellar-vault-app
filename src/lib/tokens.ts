import { cfg, NATIVE_TOKEN } from "./config";
import { tokenInfo as read } from "./chain";

/** A token's symbol, name and decimals, on this app's network; `strict` rejects what cannot be read. */
export const tokenInfo = (token: string, strict = false) => read(cfg, token, NATIVE_TOKEN, strict);
