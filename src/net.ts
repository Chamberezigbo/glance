/**
 * Network failure handling.
 *
 * glance makes one slow call over the network and then waits. Without a
 * timeout that wait is unbounded: a hung connection leaves the badge pulsing
 * beside the cursor forever, with no answer and no error — the same "failure
 * that looks like silence" this project has already been bitten by once.
 */

/** How long before a request is abandoned. Generous: the model itself is slow. */
export const REQUEST_TIMEOUT_MS = Number(process.env.GLANCE_TIMEOUT_MS ?? 120_000);

/**
 * When to admit it is taking longer than usual.
 *
 * Measured runs land at 16-20s on the subscription path, so 30s is clearly
 * abnormal without being trigger-happy. Saying so matters: a user who thinks
 * the tool is broken presses the hotkey again, which starts a second expensive
 * request alongside the first.
 */
export const SLOW_AFTER_MS = Number(process.env.GLANCE_SLOW_MS ?? 30_000);

export type NetworkFault =
  | "offline"      // no route to the internet at all
  | "unreachable"  // internet works, the service does not
  | "timeout"      // started, never finished
  | "ratelimited"
  | "server"       // the service returned 5xx
  | "auth"
  | null;          // not a network problem

/**
 * Is there any internet at all?
 *
 * Only ever called *after* a failure, to tell "you are offline" apart from
 * "the service is down" — two problems with completely different fixes. Never
 * called before a request, because a reachability check on the happy path is
 * latency spent to learn nothing.
 */
export async function isOnline(timeoutMs = 2500): Promise<boolean> {
  // Two different providers, so one operator's outage is not read as the user
  // being offline. Apple's endpoint is the one macOS itself uses.
  const probes = [
    "http://captive.apple.com/hotspot-detect.html",
    "https://cloudflare.com/cdn-cgi/trace",
  ];
  const results = await Promise.allSettled(
    probes.map((url) =>
      fetch(url, { method: "GET", signal: AbortSignal.timeout(timeoutMs) }),
    ),
  );
  return results.some((r) => r.status === "fulfilled" && r.value.ok);
}

/** What kind of network problem, if any, does this error represent? */
export function classify(err: unknown): NetworkFault {
  const e = err as {
    code?: string; status?: number; message?: string;
    killed?: boolean; signal?: string; name?: string; cause?: unknown;
  };
  const status = typeof e?.status === "number" ? e.status : undefined;

  // SDK errors wrap the real cause and report only "Connection error.", so walk
  // the cause chain and match on the whole thing. Without this the user sees a
  // raw library string instead of being told they are offline.
  let code = e?.code ?? "";
  let msg = String(e?.message ?? err ?? "");
  let name = e?.name ?? (err as object)?.constructor?.name ?? "";
  let cause: unknown = e?.cause;
  for (let depth = 0; depth < 5 && cause; depth++) {
    const c = cause as { code?: string; message?: string; name?: string; cause?: unknown };
    code += " " + (c.code ?? "");
    msg += " " + (c.message ?? "");
    name += " " + (c.name ?? "");
    cause = c.cause;
  }
  msg += " " + name;

  // execFile kills the child on timeout rather than reporting one.
  if (e?.killed || e?.signal === "SIGTERM" || /ETIMEDOUT/.test(code) ||
      /APIConnectionTimeoutError/i.test(name) ||
      /timed? ?out|ETIMEDOUT|AbortError|aborted/i.test(msg)) {
    return "timeout";
  }
  if (/ENOTFOUND|EAI_AGAIN|ENETDOWN|ENETUNREACH|EHOSTUNREACH|getaddrinfo/i.test(code + msg)) {
    return "offline";
  }
  // "Connection error." is what the Anthropic SDK surfaces for anything it
  // could not reach; APIConnectionError is the class behind it.
  if (/ECONNREFUSED|ECONNRESET|EPIPE|socket hang up|fetch failed|network error|connection error|APIConnectionError/i.test(code + msg)) {
    return "unreachable";
  }
  if (status === 429 || /rate.?limit|429|too many requests/i.test(msg)) return "ratelimited";
  if ((status && status >= 500) || /\b5\d\d\b|overloaded|internal server error/i.test(msg)) return "server";
  if (status === 401 || status === 403 || /unauthoriz|forbidden|invalid.*api.?key|authentication/i.test(msg)) {
    return "auth";
  }
  return null;
}

/**
 * Plain language for each fault, and what to do about it.
 *
 * `spoken` is deliberately short: it is read aloud, and the user is already
 * waiting. `shown` carries the actionable detail to the panel and the log.
 */
export function describe(fault: NetworkFault, online: boolean | null): { spoken: string; shown: string } | null {
  switch (fault) {
    case "offline":
      return {
        spoken: "You're offline. I can't reach Claude without a connection.",
        shown: "No internet connection. glance needs network access to reach Claude — speech recognition and capture are local, but the answer is not.",
      };
    case "unreachable":
      return online === false
        ? {
            spoken: "You're offline. I can't reach Claude without a connection.",
            shown: "No internet connection reachable.",
          }
        : {
            spoken: "I can reach the internet, but not Claude. It may be down.",
            shown: "The network is up but Claude could not be reached. Check status.anthropic.com, then try again.",
          };
    case "timeout":
      return {
        spoken: "That took too long and I gave up. Try again.",
        shown: `No response within ${Math.round(REQUEST_TIMEOUT_MS / 1000)}s. The network may be slow, or the request may have stalled. 'glance retry' asks the same question again without retyping it.`,
      };
    case "ratelimited":
      return {
        spoken: "You've hit a usage limit. Wait a little and try again.",
        shown: "Rate limited. On the subscription path this is your Claude usage window; it resets on its own. 'glance retry' when it does.",
      };
    case "server":
      return {
        spoken: "Claude is having trouble right now. Try again shortly.",
        shown: "The service returned a server error. This is usually brief — 'glance retry' in a minute.",
      };
    case "auth":
      return {
        spoken: "I couldn't authenticate. Check your API key or Claude login.",
        shown: "Authentication failed. For the API path check ANTHROPIC_API_KEY; for the subscription path run `claude` once and sign in.",
      };
    default:
      return null;
  }
}
