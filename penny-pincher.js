// Freemium Penny-Pincher — Free-First AI Model Router
//
// A Pi virtual model router that tries free providers first in your configured
// order, then falls back through any remaining providers. No provider registration —
// it just routes through whatever providers the model registry knows about.
//
// Commands:
//   /freemium configure  — Interactive TUI to select/reorder providers
//   /freemium optimize   — Suggest best ordering by capability
//   /set-router-gateway   — Set gateway IP for network-liveness checks

const { execSync } = require("child_process");

// ── Default known free providers ──────────────────────────────────
// These are the recommended defaults shipped with the extension.
// You can add/remove/reorder any registered provider via /freemium configure.
const DEFAULT_PROVIDERS = [
  { id: "google",       name: "Google Gemini",        low: "gemini-2.5-flash",              high: "gemini-2.5-flash" },
  { id: "amd-tokenlab", name: "AMD TokenLab",          low: "DeepSeek-V4-Flash",             high: "DeepSeek-V4-Flash" },
  { id: "cline",        name: "Cline",                 low: "cohere/north-mini-code:free",    high: "openrouter/free" },
  { id: "groq",         name: "Groq",                  low: "llama-3.1-8b-instant",         high: "llama-3.3-70b-specdec" },
  { id: "kilo",         name: "Kilo",                  low: "kilo-auto/free",                high: "kilo-auto/free" },
  { id: "xkiro",        name: "Xkiro",                 low: "mistralai/ministral-14b",       high: "mistralai/codestral-2508" },
  { id: "requesty",     name: "Requesty",              low: "nvidia/nemotron-3-nano-30b-a3b", high: "google/gemma-4-31b-it" },
];

// ── Runtime config ───────────────────────────────────────────────
const config = {
  gatewayIp: "192.168.43.100",
  // Ordered list of provider IDs to try, in priority order
  providers: DEFAULT_PROVIDERS.map(p => p.id),
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
  for (const p of DEFAULT_PROVIDERS) {
    if (id.includes(p.id)) return p.id;
  }
  // Also check for common provider names not in defaults
  if (id.includes("radium") || id.includes("anthropic") || id.includes("openai")) return id.split("/")[0];
  return null;
}

// ── Capability ranking for optimization ──────────────────────────
const CAPABILITY_RANK = [
  "google",       // Gemini 2.5 Flash
  "groq",         // Groq Llama 3.3 70B
  "amd-tokenlab", // DeepSeek V4 Flash
  "cline",        // Cline OpenRouter
  "xkiro",        // Codestral/Ministral
  "kilo",         // Kilo auto
  "requesty",     // Nemotron/Gemma 4
];

function suggestOrder(selected) {
  const ranked = [...selected].sort((a, b) => {
    const ia = CAPABILITY_RANK.indexOf(a);
    const ib = CAPABILITY_RANK.indexOf(b);
    return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
  });
  return ranked;
}

// ── Extension entry point ───────────────────────────────────────
export default function (pi) {
  // ── Slash command: /set-router-gateway ─────────────────────────
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

  // ── Command: /freemium ────────────────────────────────────────
  pi.registerCommand("freemium", {
    description: "Configure free provider selection, priority, and optimization",
    handler: async (args, ctx) => {
      const subcmd = args.trim().split(/\s+/)[0];

      // ── /freemium optimize ─────────────────────────────────────
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

      // ── /freemium configure ────────────────────────────────────
      if (subcmd === "configure" || subcmd === "") {
        if (ctx.mode !== "tui") {
          ctx.ui.notify("/freemium configure requires TUI mode", "error");
          return;
        }

        await ctx.ui.custom((tui, theme, keybindings, done) => {
          const configured = [...config.providers];
          let cursor = 0;
          let showAll = false;
          let cachedWidth = undefined;
          let cachedLines = undefined;
          let message = "";

          // All discoverable providers: merge defaults with registry
          function getAll() {
            const known = new Map();
            for (const p of DEFAULT_PROVIDERS) known.set(p.id, p);
            // Add any extra providers from the registry that aren't in defaults
            const registry = ctx.modelRegistry;
            // We can't enumerate all providers easily, so use the defaults plus
            // any the user has added to configured that aren't in defaults
            for (const pid of configured) {
              if (!known.has(pid)) {
                known.set(pid, { id: pid, name: pid.charAt(0).toUpperCase() + pid.slice(1), low: null, high: null });
              }
            }
            return Array.from(known.values());
          }

          function getVisible() {
            const all = getAll();
            if (showAll) {
              return all.map(p => ({
                ...p,
                inConfig: configured.includes(p.id),
                configIdx: configured.indexOf(p.id),
              }));
            }
            return all
              .filter(p => configured.includes(p.id))
              .map(p => ({
                ...p,
                inConfig: true,
                configIdx: configured.indexOf(p.id),
              }));
          }

          function clamp() { cursor = Math.max(0, Math.min(cursor, Math.max(0, getVisible().length - 1))); }

          function render(width) {
            if (cachedLines && cachedWidth === width) return cachedLines;
            cachedWidth = width;

            const items = getVisible();
            clamp();
            const lines = [];

            lines.push(theme.style("  Freemium Penny-Pincher — Provider Configuration", { fg: "accent", bold: true }));
            lines.push("");
            lines.push(theme.fg("dim", `  ${showAll ? "All providers" : "Configured"} — [Tab] toggle view  [Space] toggle  [↑↓/u/d] move  [o] optimize  [Enter] done`));
            lines.push("");

            const namePad = Math.max(...getAll().map(p => p.name.length), 0);

            for (let i = 0; i < items.length; i++) {
              const p = items[i];
              const arrow = i === cursor ? theme.fg("accent", " →") : "  ";
              const idx = p.configIdx >= 0 ? theme.fg("accent", `#${p.configIdx + 1}`) : "   ";
              const check = showAll ? (p.inConfig ? theme.fg("success", " ✓") : "  ") : "";
              const name = `${idx} ${p.name.padEnd(namePad)}`;
              const styled = i === cursor ? theme.bg("highlight", `${arrow} ${name}${check}`) : `  ${name}${check}`;
              lines.push(`  ${styled}`);
            }

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

            if (isUp && items.length > 1 && cursor > 0) {
              const curId = items[cursor].id;
              const targetId = items[cursor - 1].id;
              const ci = configured.indexOf(curId);
              const ti = configured.indexOf(targetId);
              if (ci >= 0 && ti >= 0) {
                [configured[ci], configured[ti]] = [configured[ti], configured[ci]];
                cursor--;
              }
            } else if (isDown && items.length > 1 && cursor < items.length - 1) {
              const curId = items[cursor].id;
              const targetId = items[cursor + 1].id;
              const ci = configured.indexOf(curId);
              const ti = configured.indexOf(targetId);
              if (ci >= 0 && ti >= 0) {
                [configured[ci], configured[ti]] = [configured[ti], configured[ci]];
                cursor++;
              }
            } else if (data === " ") {
              const p = items[cursor];
              if (configured.includes(p.id)) {
                configured.splice(configured.indexOf(p.id), 1);
              } else {
                configured.push(p.id);
              }
            } else if (data === "\t") {
              showAll = !showAll;
            } else if (data === "o") {
              const suggested = suggestOrder(configured);
              if (suggested.join(",") !== configured.join(",")) {
                configured.length = 0;
                configured.push(...suggested);
                message = "Suggested order applied!";
              } else {
                message = "Already optimal!";
              }
            } else if (data === "\r" || data === "\n") {
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

      // ── /freemium list ─────────────────────────────────────────
      if (subcmd === "list" || subcmd === "status") {
        ctx.ui.notify(
          `Chain: ${config.providers.join(" → ")}`,
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

  function getModelForProvider(ctx, pid, level) {
    const pdef = DEFAULT_PROVIDERS.find(p => p.id === pid);
    if (!pdef) return null;
    const isLow = level === "off" || level === "low";
    const modelId = isLow ? pdef.low : pdef.high;
    if (!modelId) return null;
    return find(ctx, pid, modelId);
  }

  function isContextOverflow(failed) {
    if (failed.message?.stopReason === "context_length_exceeded") return true;
    return /context.length|too many tokens/i.test(failed.message?.errorMessage || "");
  }

  function nextTier(ctx, failedModelId, level) {
    const tiers = config.providers;
    const current = getFailedProvider(failedModelId);
    const idx = current ? tiers.indexOf(current) : -1;
    const isLow = level === "off" || level === "low";

    for (let i = Math.max(idx + 1, 0); i < tiers.length; i++) {
      const m = getModelForProvider(ctx, tiers[i], level);
      if (m) {
        return {
          model: m,
          thinkingLevel: isLow ? "off" : level === "medium" ? "medium" : "low"
        };
      }
    }

    return null;
  }

  // ── Virtual model: freemium/penny-pincher ──────────────────────────
  pi.registerVirtualModel({
    provider: "freemium",
    id: "penny-pincher",
    name: "Penny-Pincher (free-first router)",
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
          // Context overflow: jump to the last provider (usually a high-context model)
          for (let i = config.providers.length - 1; i >= 0; i--) {
            const m = getModelForProvider(ctx, config.providers[i], level);
            if (m) return { model: m, thinkingLevel: "medium", state: { gateway: { ip: config.gatewayIp, status: "online" } } };
          }
        }

        const fallback = nextTier(ctx, failedModelId, level);
        if (fallback?.model) return { model: fallback.model, thinkingLevel: fallback.thinkingLevel, state: { gateway: { ip: config.gatewayIp, status: "online" } } };

        return {
          model: request.previous?.model,
          thinkingLevel: level,
          state: { gateway: { ip: config.gatewayIp, status: "online" } }
        };
      }

      // ── Continuation: sticky ────────────────────────────────────
      const sticky = request.failed ?? request.previous;
      if (request.reason !== "user" && sticky) {
        return {
          model: sticky.model,
          thinkingLevel: sticky.thinkingLevel ?? "medium"
        };
      }

      // ── Fresh user messages: try configured providers in order ──
      for (const pid of config.providers) {
        const modelId = isLow
          ? DEFAULT_PROVIDERS.find(p => p.id === pid)?.low
          : DEFAULT_PROVIDERS.find(p => p.id === pid)?.high;
        if (!modelId) continue;
        const m = find(ctx, pid, modelId);
        if (m) {
          return {
            model: m,
            thinkingLevel: isLow ? "off" : level === "medium" ? "medium" : "low"
          };
        }
      }

      // No provider available — return fallback
      return {
        model: request.previous?.model,
        thinkingLevel: level
      };
    }
  });
}
