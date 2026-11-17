// Kernel Project Virtual Model Router
// Free-first (all providers) + Radium fallback chain + gateway network check + rate-limit handling
//
// Gateway check: when a request fails, pings the configured gateway.
//   - Gateway unreachable → stay on the SAME model (retry loop, don't switch)
//   - Gateway reachable   → proceed with fallback chain
//
// Configure: /set-router-gateway <IP>  (default: 192.168.43.100)
// Check status: gateway status shown in router state
//
// Tier 1 (Free):    Google Gemini → AMD TokenLab → Cline → Groq → Kilo → Xkiro → Requesty
// Tier 2 (Budget):  Tycho 1.0 ($0.10/$1.50) — fast builds, no reasoning
// Tier 3 (Balanced): Clarke 1.0 ($0.75/$4.50) — everyday coding, 200K ctx
// Tier 4 (Best):    Hal 1.0 ($2.00/$10.00) — heavy reasoning, RE analysis

const { execSync } = require("child_process");

// ── Config store for gateway IP ─────────────────────────────────────────
const config = { gatewayIp: "192.168.43.100" };

function pingGateway(ip) {
  try {
    execSync(`ping -c 1 -W 2 ${ip}`, { timeout: 3000, stdio: "ignore" });
    return "online";
  } catch {
    return "offline";
  }
}

function getFailedProvider(failedModelId) {
  if (!failedModelId) return null;
  const id = failedModelId.toLowerCase();
  if (id.includes("gemini") || id.includes("google")) return "google";
  if (id.includes("groq") || id.includes("llama")) return "groq";
  if (id.includes("cline")) return "cline";
  if (id.includes("kilo")) return "kilo";
  if (id.includes("tokenlab") || id.includes("amd")) return "amd-tokenlab";
  if (id.includes("xkiro")) return "xkiro";
  if (id.includes("requesty")) return "requesty";
  if (id.includes("tycho")) return "tycho";
  if (id.includes("clarke")) return "clarke";
  if (id.includes("hal")) return "hal";
  return null;
}

const FALLBACK_TIERS = ["google", "amd-tokenlab", "cline", "groq", "kilo", "xkiro", "requesty", "tycho", "clarke", "hal"];

export default function (pi) {
  // ── Slash command: /set-router-gateway ─────────────────────────────
  pi.registerCommand("set-router-gateway", {
    description: "Set the gateway IP used by the kernel router for network-liveness checks. Ping result tells the router whether to retry (offline) or fall back (online).",
    handler: async (args, ctx) => {
      const ip = args.trim();
      if (!ip) {
        ctx.ui.notify(
          `Current gateway: ${config.gatewayIp} — usage: /set-router-gateway <IP>`,
          "info"
        );
        return;
      }
      const before = config.gatewayIp;
      config.gatewayIp = ip;
      const status = pingGateway(ip);
      ctx.ui.notify(
        `Gateway ${ip}: ${status}. Router will use ${ip} for network checks.`,
        status === "online" ? "info" : "warning"
      );
    },
  });

  // ── Helpers ──────────────────────────────────────────────────────
  function find(ctx, provider, id) {
    return ctx.modelRegistry.find(provider, id);
  }

  function getRadiumModel(ctx, tier, level) {
    const isLow = level === "off" || level === "low";
    const isHigh = level === "high" || level === "xhigh" || level === "max";
    if (tier === "tycho") {
      return { model: find(ctx, "radium", "tycho-1.0"), thinkingLevel: "off" };
    }
    if (tier === "clarke") {
      return {
        model: find(ctx, "radium", "clarke-1.0"),
        thinkingLevel: isLow ? "off" : isHigh ? "high" : "medium"
      };
    }
    if (tier === "hal") {
      return { model: find(ctx, "radium", "hal-1.0"), thinkingLevel: isLow ? "low" : level };
    }
    return null;
  }

  function isContextOverflow(failed) {
    if (failed.message?.stopReason === "context_length_exceeded") return true;
    return /context.length|too many tokens/i.test(failed.message?.errorMessage || "");
  }

  function nextTier(ctx, failedModelId, level) {
    const current = getFailedProvider(failedModelId);
    const idx = current ? FALLBACK_TIERS.indexOf(current) : -1;
    const isLow = level === "off" || level === "low";

    if (current && FALLBACK_TIERS.indexOf(current) <= FALLBACK_TIERS.indexOf("requesty")) {
      for (let i = Math.max(idx + 1, 0); i <= FALLBACK_TIERS.indexOf("requesty"); i++) {
        const nextProv = FALLBACK_TIERS[i];
        const idMap = {
          "google": { low: "gemini-2.5-flash", high: "gemini-2.5-flash" },
          "groq": { low: "llama-3.1-8b-instant", high: "llama-3.3-70b-specdec" },
          "cline": { low: "cohere/north-mini-code:free", high: "openrouter/free" },
          "kilo": { low: "kilo-auto/free", high: "kilo-auto/free" },
          "amd-tokenlab": { low: "DeepSeek-V4-Flash", high: "DeepSeek-V4-Flash" },
          "xkiro": { low: "mistralai/ministral-14b", high: "mistralai/codestral-2508" },
          "requesty": { low: "nvidia/nemotron-3-nano-30b-a3b", high: "google/gemma-4-31b-it" },
        };
        const m = idMap[nextProv] ? find(ctx, nextProv, idMap[nextProv].high) : null;
        if (m) {
          return {
            model: m,
            thinkingLevel: isLow ? "off" : level === "medium" ? "medium" : "low"
          };
        }
      }
    }

    for (let i = Math.max(idx + 1, FALLBACK_TIERS.indexOf("tycho")); i < FALLBACK_TIERS.length; i++) {
      const r = getRadiumModel(ctx, FALLBACK_TIERS[i], level);
      if (r?.model) return r;
    }

    return {
      model: find(ctx, "radium", "hal-1.0") || find(ctx, "radium", "clarke-1.0"),
      thinkingLevel: level
    };
  }

  // ── Virtual model ──────────────────────────────────────────────────
  pi.registerVirtualModel({
    provider: "radium",
    id: "kernel-auto",
    name: "Kernel Auto (free-first + fallback)",
    thinkingLevels: ["off", "low", "medium", "high", "xhigh", "max"],
    contextWindow: 200000,
    maxTokens: 32768,
    input: ["text", "image"],

    route(request, ctx) {
      const level = request.thinkingLevel;
      const isLow = level === "off" || level === "low";
      const isHigh = level === "high" || level === "xhigh" || level === "max";

      // ── Retry / failure: check gateway before switching ──────────
      if ((request.reason === "retry" || request.reason === "continuation") && request.failed) {
        const failedModelId = request.failed.model?.id || request.previous?.model?.id;

        // Ping the configured gateway
        const gw = pingGateway(config.gatewayIp);
        const gatewayMsg = `[Router] Gateway ${config.gatewayIp}: ${gw}`;

        if (gw === "offline") {
          // ── NETWORK DOWN: stay on the same model → Pi retry loop ──
          const sticky = request.previous;
          if (sticky) {
            return {
              model: sticky.model,
              thinkingLevel: sticky.thinkingLevel ?? "medium",
              state: { gateway: { ip: config.gatewayIp, status: "offline" } }
            };
          }
        }

        // ── NETWORK UP: real model failure → escalate ──────────────
        if (isContextOverflow(request.failed)) {
          const target = find(ctx, "radium", "clarke-1.0")
            || find(ctx, "radium", "hal-1.0");
          if (target) return {
            model: target,
            thinkingLevel: "medium",
            state: { gateway: { ip: config.gatewayIp, status: "online" } }
          };
        }

        // Normal fallback through the chain
        const fallback = nextTier(ctx, failedModelId, level);
        if (fallback?.model) return {
          model: fallback.model,
          thinkingLevel: fallback.thinkingLevel,
          state: { gateway: { ip: config.gatewayIp, status: "online" } }
        };

        return {
          model: find(ctx, "radium", "hal-1.0") || find(ctx, "radium", "clarke-1.0"),
          thinkingLevel: level,
          state: { gateway: { ip: config.gatewayIp, status: "online" } }
        };
      }

      // ── Continuation: sticky (no network check needed for happy path) ──
      const sticky = request.failed ?? request.previous;
      if (request.reason !== "user" && sticky) {
        return {
          model: sticky.model,
          thinkingLevel: sticky.thinkingLevel ?? "medium"
        };
      }

      // ── Fresh user messages: free-first ─────────────────────────
      const freeCandidates = [];

      if (isLow) {
        freeCandidates.push(
          find(ctx, "google", "gemini-2.5-flash"),
          find(ctx, "amd-tokenlab", "DeepSeek-V4-Flash"),
          find(ctx, "cline", "cohere/north-mini-code:free"),
          find(ctx, "groq", "llama-3.1-8b-instant"),
          find(ctx, "kilo", "kilo-auto/free"),
          find(ctx, "xkiro", "mistralai/ministral-14b"),
          find(ctx, "requesty", "nvidia/nemotron-3-nano-30b-a3b"),
          find(ctx, "groq", "llama-3.3-70b-specdec"),
          find(ctx, "amd-tokenlab", "Qwen3.8-27B"),
          find(ctx, "xkiro", "mistralai/codestral-2508"),
        );
      } else if (isHigh) {
        freeCandidates.push(
          find(ctx, "google", "gemini-2.5-flash"),
          find(ctx, "amd-tokenlab", "DeepSeek-V4-Flash"),
          find(ctx, "cline", "openrouter/free"),
          find(ctx, "groq", "llama-3.3-70b-specdec"),
          find(ctx, "kilo", "kilo-auto/free"),
          find(ctx, "xkiro", "mistralai/codestral-2508"),
          find(ctx, "groq", "llama-3.1-8b-instant"),
          find(ctx, "amd-tokenlab", "Qwen3.8-27B"),
        );
      } else {
        freeCandidates.push(
          find(ctx, "google", "gemini-2.5-flash"),
          find(ctx, "amd-tokenlab", "DeepSeek-V4-Flash"),
          find(ctx, "cline", "openrouter/free"),
          find(ctx, "groq", "llama-3.3-70b-specdec"),
          find(ctx, "kilo", "kilo-auto/free"),
          find(ctx, "xkiro", "mistralai/codestral-2508"),
          find(ctx, "groq", "llama-3.1-8b-instant"),
          find(ctx, "requesty", "nvidia/nemotron-3-nano-30b-a3b"),
          find(ctx, "amd-tokenlab", "Qwen3.8-27B"),
        );
      }

      for (const m of freeCandidates) {
        if (m) {
          return {
            model: m,
            thinkingLevel: isLow ? "off" : level === "medium" ? "medium" : "low"
          };
        }
      }

      if (isLow) {
        return {
          model: find(ctx, "radium", "tycho-1.0") || find(ctx, "radium", "clarke-1.0"),
          thinkingLevel: "off"
        };
      }

      if (level === "medium") {
        return {
          model: find(ctx, "radium", "clarke-1.0") || find(ctx, "radium", "hal-1.0"),
          thinkingLevel: "medium"
        };
      }

      return {
        model: find(ctx, "radium", "hal-1.0") || find(ctx, "radium", "clarke-1.0"),
        thinkingLevel: level
      };
    }
  });
}
