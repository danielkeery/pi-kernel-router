// Freemium Penny-Pincher — Free-First AI Model Router with interactive provider config
//
// Gateway check: when a request fails, pings the configured gateway.
//   - Gateway unreachable → stay on the SAME model (retry loop, don't switch)
//   - Gateway reachable   → proceed with fallback chain
//
// Commands:
//   /freemium configure  — Interactive TUI to select/reorder free providers
//   /freemium optimize   — Suggest best positioning based on capability/cost
//   /set-router-gateway   — Set the gateway IP for network-liveness checks
//
// Default free providers: Google Gemini → AMD TokenLab → Cline → Groq → Kilo → Xkiro → Requesty
// Paid fallback (always at end): Tycho → Clarke → Hal (via the freemium provider)

const { execSync } = require("child_process");

// ── Provider definitions ─────────────────────────────────────────
const ALL_PROVIDERS = [
  { id: "google",    name: "Google Gemini",        low: "gemini-2.5-flash",              high: "gemini-2.5-flash" },
  { id: "amd-tokenlab", name: "AMD TokenLab",      low: "DeepSeek-V4-Flash",             high: "DeepSeek-V4-Flash" },
  { id: "cline",     name: "Cline",                low: "cohere/north-mini-code:free",    high: "openrouter/free" },
  { id: "groq",      name: "Groq",                 low: "llama-3.1-8b-instant",         high: "llama-3.3-70b-specdec" },
  { id: "kilo",      name: "Kilo",                 low: "kilo-auto/free",                high: "kilo-auto/free" },
  { id: "xkiro",     name: "Xkiro",                low: "mistralai/ministral-14b",       high: "mistralai/codestral-2508" },
  { id: "requesty",  name: "Requesty",             low: "nvidia/nemotron-3-nano-30b-a3b", high: "google/gemma-4-31b-it" },
];

// ── Runtime config ───────────────────────────────────────────────
const config = {
  gatewayIp: "192.168.43.100",
  providers: ALL_PROVIDERS.map(p => p.id), // default: all free providers in order
};

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

function makeFallbackTiers() {
  return [...config.providers, "tycho", "clarke", "hal"];
}

// ── Suggest an optimised order ──────────────────────────────────
const CAPABILITY_RANK = [
  "google",       // Gemini 2.5 Flash — highest capability free model
  "groq",         // Groq Llama 3.3 70B — strong reasoning
  "amd-tokenlab", // DeepSeek V4 Flash — good coding
  "cline",        // Cline OpenRouter free
  "xkiro",        // Codestral/Ministral
  "kilo",         // Kilo auto
  "requesty",     // Nemotron/Gemma 4
];

function suggestOrder(selected) {
  // Sort selected providers by capability rank, keeping unranked at end
  const ranked = [...selected].sort((a, b) => {
    const ia = CAPABILITY_RANK.indexOf(a);
    const ib = CAPABILITY_RANK.indexOf(b);
    return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
  });
  return ranked;
}

// ── Extension entry point ───────────────────────────────────────
export default function (pi) {
  // ── Register the freemium provider (paid fallback models) ────────
  pi.registerProvider("freemium", {
    name: "Freemium (paid fallback)",
    baseUrl: "https://api.radium.cloud/v1",
    api: "openai-completions",
    apiKey: "$FREEMIUM_API_KEY",
    authHeader: true,
    models: [
      {
        id: "hal-1.0",
        name: "Freemium Hal 1.0 (Heavy Reasoning & Complex Code)",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 2.0, output: 10.0, cacheRead: 0.2, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 32768
      },
      {
        id: "clarke-1.0",
        name: "Freemium Clarke 1.0 (Balanced Coding & Tool Calls)",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 16384
      },
      {
        id: "tycho-1.0",
        name: "Freemium Tycho 1.0 (Fast Extraction & Classification)",
        reasoning: false,
        input: ["text"],
        cost: { input: 0.1, output: 1.5, cacheRead: 0.02, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 8192
      }
    ]
  });

  // ── Slash command: /set-router-gateway ─────────────────────────────
  pi.registerCommand("set-router-gateway", {
    description: "Set the gateway IP for network-liveness checks",
    handler: async (args, ctx) => {
      const ip = args.trim();
      if (!ip) {
        ctx.ui.notify(
          `Current gateway: ${config.gatewayIp} — usage: /set-router-gateway <IP>`,
          "info"
        );
        return;
      }
      config.gatewayIp = ip;
      const status = pingGateway(ip);
      ctx.ui.notify(
        `Gateway ${ip}: ${status}. Router will use ${ip} for network checks.`,
        status === "online" ? "info" : "warning"
      );
    },
  });

  // ── Slash command: /freemium configure ───────────────────────────
  pi.registerCommand("freemium", {
    description: "Configure free provider selection, priority, and optimization",
    handler: async (args, ctx) => {
      const subcmd = args.trim().split(/\s+/)[0];

      // ── /freemium optimize ──────────────────────────────────────
      if (subcmd === "optimize") {
        const suggested = suggestOrder(config.providers);
        const current = config.providers.join(" → ");
        const proposed = suggested.join(" → ");

        if (current === proposed) {
          ctx.ui.notify("Already optimal! ✓", "info");
          return;
        }

        const ok = await ctx.ui.confirm(
          "Optimize provider order?",
          `Current:  ${current}\nProposed: ${proposed}\n\nApply suggested order?`
        );
        if (ok) {
          config.providers = suggested;
          ctx.ui.notify(`Applied: ${proposed}`, "info");
        } else {
          ctx.ui.notify("Order unchanged", "info");
        }
        return;
      }

      // ── /freemium configure (default) ───────────────────────────
      if (subcmd === "configure" || subcmd === "") {
        if (ctx.mode !== "tui") {
          ctx.ui.notify("/freemium configure requires TUI mode", "error");
          return;
        }

        const result = await ctx.ui.custom((tui, theme, keybindings, done) => {
          const configured = [...config.providers];
          let cursor = 0;
          let showAll = false;       // false = configured only, true = all
          let cachedWidth = undefined;
          let cachedLines = undefined;
          let message = "";

          function getVisible() {
            if (showAll) {
              // All providers, with configured ones marked
              return ALL_PROVIDERS.map(p => ({
                ...p,
                inConfig: configured.includes(p.id),
                configIdx: configured.indexOf(p.id),
              }));
            }
            // Only configured, in order
            return ALL_PROVIDERS
              .filter(p => configured.includes(p.id))
              .map(p => ({
                ...p,
                inConfig: true,
                configIdx: configured.indexOf(p.id),
              }));
          }

          // Clamp cursor
          function clamp() { cursor = Math.max(0, Math.min(cursor, Math.max(0, getVisible().length - 1))); }

          function render(width) {
            if (cachedLines && cachedWidth === width) return cachedLines;
            cachedWidth = width;

            const items = getVisible();
            clamp();
            const lines = [];

            lines.push(theme.style("  Freemium Penny-Pincher — Provider Configuration", { fg: "accent", bold: true }));
            lines.push("");
            lines.push(theme.fg("dim", `  ${showAll ? "Configured" : "All available"} — [Tab] toggle view  [Space] toggle  [↑↓/u/d] move  [o] optimize  [Enter] done`));
            lines.push("");

            const namePad = Math.max(...ALL_PROVIDERS.map(p => p.name.length), 0);

            items.forEach((p, i) => {
              const arrow = i === cursor ? theme.fg("accent", " →") : "  ";
              const idx = p.configIdx >= 0 ? theme.fg("accent", `#${p.configIdx + 1}`) : "   ";
              const check = showAll ? (p.inConfig ? theme.fg("success", " ✓") : "  ") : "";
              const name = `${idx} ${p.name.padEnd(namePad)}`;
              const styled = i === cursor ? theme.bg("highlight", `${arrow} ${name}${check}`) : `  ${name}${check}`;
              lines.push(`  ${styled}`);
            });

            if (message) {
              lines.push("");
              lines.push(theme.fg("accent", `  ${message}`));
              lines.push(theme.fg("dim", "  [Enter] to confirm and exit"));
            }

            cachedLines = lines.map(l => {
              if (l.length > width) return l.slice(0, width);
              return l;
            });
            return cachedLines;
          }

          function invalidate() { cachedWidth = undefined; cachedLines = undefined; }

          function handleInput(data) {
            message = "";
            const items = getVisible();
            clamp();

            const isUp = keybindings.matches(data, "tui.select.up") || data === "u";
            const isDown = keybindings.matches(data, "tui.select.down") || data === "d";

            if (isUp && items.length > 1) {
              if (cursor > 0) {
                // Move provider up in priority
                const curId = items[cursor].id;
                const targetId = items[cursor - 1].id;
                const ci = configured.indexOf(curId);
                const ti = configured.indexOf(targetId);
                if (ci >= 0 && ti >= 0) {
                  [configured[ci], configured[ti]] = [configured[ti], configured[ci]];
                  cursor--;
                }
              }
            } else if (isDown && items.length > 1) {
              if (cursor < items.length - 1) {
                const curId = items[cursor].id;
                const targetId = items[cursor + 1].id;
                const ci = configured.indexOf(curId);
                const ti = configured.indexOf(targetId);
                if (ci >= 0 && ti >= 0) {
                  [configured[ci], configured[ti]] = [configured[ti], configured[ci]];
                  cursor++;
                }
              }
            } else if (data === " ") {
              // Space: toggle provider in/out of configured
              const p = items[cursor];
              if (configured.includes(p.id)) {
                configured.splice(configured.indexOf(p.id), 1);
              } else {
                configured.push(p.id);
              }
            } else if (data === "\t") {
              // Tab: toggle view mode
              showAll = !showAll;
            } else if (data === "o") {
              // o: suggest optimization
              const suggested = suggestOrder(configured);
              if (suggested.join(",") !== configured.join(",")) {
                configured.length = 0;
                configured.push(...suggested);
                message = `Suggested order applied!`;
              } else {
                message = "Already optimal!";
              }
            } else if (data === "\r" || data === "\n") {
              // Enter: confirm
              config.providers = configured;
              done(null);
              return;
            } else {
              return;
            }

            invalidate();
            tui.requestRender();
          }

          return { render, invalidate, handleInput };
        });

        ctx.ui.notify(`Providers saved (${config.providers.length} active)`, "info");
        return;
      }

      // ── /freemium list (quick status) ───────────────────────────
      if (subcmd === "list" || subcmd === "status") {
        const chain = [...config.providers, "tycho", "clarke", "hal"].join(" → ");
        ctx.ui.notify(
          `Free providers: ${config.providers.join(", ")}\nFull chain: ${chain}`,
          "info"
        );
        return;
      }

      ctx.ui.notify("Usage: /freemium {configure|optimize|list|status}", "info");
    },
  });

  // ── Helpers ──────────────────────────────────────────────────────
  function find(ctx, provider, id) {
    return ctx.modelRegistry.find(provider, id);
  }

  function getFreemiumModel(ctx, tier, level) {
    const isLow = level === "off" || level === "low";
    const isHigh = level === "high" || level === "xhigh" || level === "max";
    if (tier === "tycho") {
      return { model: find(ctx, "freemium", "tycho-1.0"), thinkingLevel: "off" };
    }
    if (tier === "clarke") {
      return {
        model: find(ctx, "freemium", "clarke-1.0"),
        thinkingLevel: isLow ? "off" : isHigh ? "high" : "medium"
      };
    }
    if (tier === "hal") {
      return { model: find(ctx, "freemium", "hal-1.0"), thinkingLevel: isLow ? "low" : level };
    }
    return null;
  }

  function isContextOverflow(failed) {
    if (failed.message?.stopReason === "context_length_exceeded") return true;
    return /context.length|too many tokens/i.test(failed.message?.errorMessage || "");
  }

  function nextTier(ctx, failedModelId, level) {
    const tiers = makeFallbackTiers();
    const current = getFailedProvider(failedModelId);
    const idx = current ? tiers.indexOf(current) : -1;
    const isLow = level === "off" || level === "low";

    if (current && tiers.indexOf(current) <= tiers.indexOf("requesty")) {
      for (let i = Math.max(idx + 1, 0); i <= tiers.indexOf("requesty"); i++) {
        const nextProv = tiers[i];
        const pdef = ALL_PROVIDERS.find(p => p.id === nextProv);
        if (!pdef) continue;
        const modelId = isLow ? pdef.low : pdef.high;
        const m = find(ctx, nextProv, modelId);
        if (m) {
          return {
            model: m,
            thinkingLevel: isLow ? "off" : level === "medium" ? "medium" : "low"
          };
        }
      }
    }

    for (let i = Math.max(idx + 1, tiers.indexOf("tycho")); i < tiers.length; i++) {
      const r = getFreemiumModel(ctx, tiers[i], level);
      if (r?.model) return r;
    }

    return {
      model: find(ctx, "freemium", "hal-1.0") || find(ctx, "freemium", "clarke-1.0"),
      thinkingLevel: level
    };
  }

  // ── Virtual model: freemium/penny-pincher ──────────────────────────
  pi.registerVirtualModel({
    provider: "freemium",
    id: "penny-pincher",
    name: "Penny-Pincher (free-first + fallback)",
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

        const gw = pingGateway(config.gatewayIp);

        if (gw === "offline") {
          const sticky = request.previous;
          if (sticky) {
            return {
              model: sticky.model,
              thinkingLevel: sticky.thinkingLevel ?? "medium",
              state: { gateway: { ip: config.gatewayIp, status: "offline" } }
            };
          }
        }

        if (isContextOverflow(request.failed)) {
          const target = find(ctx, "freemium", "clarke-1.0")
            || find(ctx, "freemium", "hal-1.0");
          if (target) return {
            model: target,
            thinkingLevel: "medium",
            state: { gateway: { ip: config.gatewayIp, status: "online" } }
          };
        }

        const fallback = nextTier(ctx, failedModelId, level);
        if (fallback?.model) return {
          model: fallback.model,
          thinkingLevel: fallback.thinkingLevel,
          state: { gateway: { ip: config.gatewayIp, status: "online" } }
        };

        return {
          model: find(ctx, "freemium", "hal-1.0") || find(ctx, "freemium", "clarke-1.0"),
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
        for (const pid of config.providers) {
          const p = ALL_PROVIDERS.find(x => x.id === pid);
          if (p) freeCandidates.push(find(ctx, pid, p.low));
        }
      } else if (isHigh) {
        for (const pid of config.providers) {
          const p = ALL_PROVIDERS.find(x => x.id === pid);
          if (p) freeCandidates.push(find(ctx, pid, p.high));
        }
      } else {
        for (const pid of config.providers) {
          const p = ALL_PROVIDERS.find(x => x.id === pid);
          if (p) freeCandidates.push(find(ctx, pid, p.high));
        }
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
          model: find(ctx, "freemium", "tycho-1.0") || find(ctx, "freemium", "clarke-1.0"),
          thinkingLevel: "off"
        };
      }

      if (level === "medium") {
        return {
          model: find(ctx, "freemium", "clarke-1.0") || find(ctx, "freemium", "hal-1.0"),
          thinkingLevel: "medium"
        };
      }

      return {
        model: find(ctx, "freemium", "hal-1.0") || find(ctx, "freemium", "clarke-1.0"),
        thinkingLevel: level
      };
    }
  });
}
