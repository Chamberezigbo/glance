import type { Config } from "../config.js";
import type { Provider } from "./types.js";
import { SubscriptionProvider } from "./subscription.js";
import { ApiProvider } from "./api.js";

export function createProvider(cfg: Config): Provider {
  return cfg.provider === "api"
    ? ApiProvider.create(cfg.model)
    : SubscriptionProvider.create(cfg.model);
}

export * from "./types.js";
