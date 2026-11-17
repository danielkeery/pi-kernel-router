// Freemium Penny-Pincher — Free-First AI Model Router with configurable paid fallback
//
// Routes through free providers first in your configured order, then paid providers.
// Mark any provider as paid in /freemium configure — they get a 'p' tag and
// are tried only after all free providers are exhausted.
//
// Commands:
//   /freemium configure  — Interactive TUI to select/reorder free & paid providers
//   /freemium optimize   — Suggest best ordering by capability
//   /set-router-gateway   — Set gateway IP for network-liveness checks

const { execSync } = require("child_process");

// ── Default known provider model hints ──────────────────────────
const DEFAULT_PROVIDERS = [
  { id: "google",       name: "Google Gemini",        low: "gemini-2.5-flash",              high: "gemini-2.5-flash" },
  { id: "amd-tokenlab", name: "AMD TokenLab",          low: "DeepSeek-V4-Flash",             high: "DeepSeek-V4-Flash" },
  { id: "cline",        name: "Cline",                 low: "cohere/north-mini-code:free",    high: "openrouter/free" },
  { id: "groq",         name: "Groq",                  low: "llama-3.1-8b-instant",         high: "llama-3.3-70b-specdec" },
  { id: "kilo",         name: "Kilo",                  low: "kilo-auto/free",                high: "kilo-auto/free" },
  { id: "xkiro",        name: "Xkiro",                 low: "mistralai/ministral-14b",       high: "mistralai/codestral-2508" },
  { id: "requesty",     name: "Requesty",              low: "nvidia/nemotron-3-nano-30b-a3b", high: "google/gemma-4-31b-it" },
];

// ── Runtime config ──────────────────────────────────────────────
const config = {
  gatewayIp: "192.168.43.100",
  free: DEFAULT_PROVIDERS.map(p => p.id),
  paid: [],
};

function getProvDef(id) {
  return DEFAULT_PROVIDERS.find(p => p.id === id) || {
    id,
    name: id.charAt(0).toUpperCase() + id.slice(1),
    low: null,
    high: null,
  };
}

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
  const first = id.split("/")[0];
  return first || null;
}

// ── Capability ranking for optimization ─────────────────────────
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
  return [...selected].sort((a, b) => {
    const ia = CAPABILITY_RANK.indexOf(a);
    const ib = CAPABILITY_RANK.indexOf(b);
    return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
  });
}

// ── Extension entry point ──────────────────────────────────────
export default function (pi) {
  // ── /set-router-gateway ──────────────────────────────────────
  pi.registerCommand("set-router-gateway", {
    description: "Set the gateway IP for network-liveness checks",
    handler: async (args, ctx) => {
      const ip = args.trim();
      if (!ip) {
        ctx.ui.notify(`Current gateway: ${config.gatewayIp} — usage: /set-router-gateway <IP>`, "info");
        return;
      }
      config.gatewayIp = ip;
      const status = pingGateway(ip);
      ctx.ui.notify(
        `Gateway ${ip}: ${status}`,
        status === "online" ? "info" : "warning"
      );
    },
  });

  // ── /freemium ────────────────────────────────────────────────
  pi.registerCommand("freemium", {
    description: "Configure provider selection, paid/free priority, and optimization",
    handler: async (args, ctx) => {
      const subcmd = args.trim().split(/\s+/)[0];

      if (subcmd === "optimize") {
        const suggested = suggestOrder(config.free);
        const current = config.free.join(" → ");
        const proposed = suggested.join(" → ");
        if (current === proposed) {
          ctx.ui.notify("Already optimal! ✓", "info");
          return;
        }
        const ok = await ctx.ui.confirm(
          "Optimize free provider order?",
          `Current:  ${current}\nProposed: ${proposed}\n\n(Paid providers unchanged)`
        );
        if (ok) {
          config.free = suggested;
          ctx.ui.notify(`Applied: ${proposed}", "info");
        }
        return;
      }

      if (subcmd === "configure" || subcmd === "") {
        if (ctx.mode !== "tui") {
          ctx.ui.notify("/freemium configure requires TUI mode", "error");
          return;
        }

        const providerCatalog = DEFAULT_PROVIDERS.slice();

        // Pick which providers to add via ctx.ui.select
        const chosen = await ctx.ui.select(
          "Pick providers to add (Space to select, Enter to confirm)",
          providerCatalog.map(p => ({
            value: p.id,
            label: `${p.name}${config.free.includes(p.id) || config.paid.includes(p.id) ? " ✓" : ""}`
          })),
          { multiple: true }
        );

        if (chosen && chosen.length > 0) {
          // Split chosen into free (if not already paid) and paid
          for (const pid of chosen) {
            if (!config.free.includes(pid) && !config.paid.includes(pid)) {
              config.free.push(pid);
            }
          }
        }

        // Now configure order via TUI
        await ctx.ui.custom((tui, theme, keybindings, done) => {
          let free = [...config.free].filter(id => {
            const def = DEFAULT_PROVIDERS.find(p => p.id === id) || true;
            return def;
          });
          let paid = [...config.paid].filter(id => {
            const def = DEFAULT_PROVIDERS.find(p => p.id === id) || true;
            return def;
          });
          let cursor = 0;
          let moveMode = false;
          let cachedWidth = undefined;
          let cachedLines = undefined;

          function getAllItems() {
            const result = [];
            for (let i = 0; i < free.length; i++) result.push({ id: free[i], section: "free" });
            for (let i = 0; i < paid.length; i++)  result.push({ id: paid[i], section: "paid" });
            return result;
          }

          function clamp() {
            const count = free.length + paid.length;
            if (count === 0) cursor = 0;
            else cursor = Math.max(0, Math.min(cursor, count - 1));
          }

          function render(width) {
            if (cachedLines && cachedWidth === width) return cachedLines;
            cachedWidth = width;
            const lines = [];
            const items = getAllItems();
            clamp();

            lines.push(theme.style("  Freemium Penny-Pincher — Configured Providers", { fg: "accent", bold: true }));
            lines.push("");

            if (items.length === 0) {
              lines.push(theme.fg("dim", "  No providers configured"));
            } else {
              const freeItems = free.map((id, i) => ({ id, section: "free", idx: i }));
              const paidItems = paid.map((id, i) => ({ id, section: "paid", idx: i }));

              if (freeItems.length > 0) {
                lines.push(theme.fg("dim", "  ─ Free (tried first) ─"));
                for (const entry of freeItems) {
                  const p = getProvDef(entry.id);
                  const idx2 = items.indexOf(entry);
                  const selected = idx2 === cursor && !moveMode;
                  const moving = idx2 === cursor && moveMode;
                  const prefix = moving ? theme.fg("accent", " ◉") : selected ? theme.fg("accent", " ○") : "  ";
                  const label = ` ${prefix} #${items.indexOf(entry) + 1} ${p.name}`;
                  lines.push(moving ? theme.bg("highlight", `  ${label}  [↑↓] move  [Space] done  [d] remove`) : `  ${label}`);
                }
              }
              if (paidItems.length > 0) {
                lines.push("");
                lines.push(theme.fg("dim", "  ─ Paid (fallback) ─"));
                for (const entry of paidItems) {
                  const p = getProvDef(entry.id);
                  const idx2 = items.indexOf(entry);
                  const selected = idx2 === cursor && !moveMode;
                  const moving = idx2 === cursor && moveMode;
                  const prefix = moving ? theme.fg("accent", " ◉") : selected ? theme.fg("accent", " ○") : "  ";
                  const label = ` ${prefix} #${items.indexOf(entry) + 1} ${p.name}`;
                  lines.push(moving ? theme.bg("highlight", `  ${label}  [↑↓] move  [Space] done  [d] remove`) : `  ${label}`);
                }
              }
            }

            lines.push("");
            lines.push(theme.fg("dim", "  [Space] select to move  [↑↓] move  [p] toggle paid  [d] delete  [Enter] done"));

            cachedLines = lines.map(l => l.length > width ? l.slice(0, width) : l);
            return cachedLines;
          }

          function invalidate() { cachedWidth = undefined; cachedLines = undefined; }

          function handleInput(data) {
            const items = getAllItems();
            clamp();

            if (data === "\r" || data === "\n") {
              config.free = free;
              config.paid = paid;
              done(null);
              return;
            }

            if (data === " " && items.length > 0) {
              moveMode = !moveMode;
              invalidate();
              tui.requestRender();
              return;
            }

            if (data === "d" || data === "D") {
              if (cursor < items.length) {
                const pid = items[cursor].id;
                const fi = free.indexOf(pid);
                if (fi >= 0) free.splice(fi, 1);
                const pi = paid.indexOf(pid);
                if (pi >= 0) paid.splice(pi, 1);
                moveMode = false;
                if (cursor >= free.length + paid.length && cursor > 0) cursor--;
                invalidate();
                tui.requestRender();
              }
              return;
            }

            if (data === "p" || data === "P") {
              if (cursor < items.length) {
                const pid = items[cursor].id;
                const fi = free.indexOf(pid);
                if (fi >= 0) {
                  free.splice(fi, 1);
                  paid.push(pid);
                } else {
                  const pi = paid.indexOf(pid);
                  if (pi >= 0) {
                    paid.splice(pi, 1);
                    free.push(pid);
                  }
                }
                moveMode = false;
                invalidate();
                tui.requestRender();
              }
              return;
            }

            if (moveMode && items.length > 1) {
              const isUp = keybindings.matches(data, "tui.select.up") || data === "u";
              const isDown = keybindings.matches(data, "tui.select.down");
              const cur = items[cursor];

              if (isUp && cursor > 0) {
                const tgt = items[cursor - 1];
                if (cur.section === tgt.section) {
                  const arr = cur.section === "free" ? free : paid;
                  const ci = arr.indexOf(cur.id);
                  const ti = arr.indexOf(tgt.id);
                  if (ci >= 0 && ti >= 0) {
                    [arr[ci], arr[ti]] = [arr[ti], arr[ci]];
                    cursor--;
                    invalidate();
                    tui.requestRender();
                  }
                }
                return;
              }
              if (isDown && cursor < items.length - 1) {
                const tgt = items[cursor + 1];
                if (cur.section === tgt.section) {
                  const arr = cur.section === "free" ? free : paid;
                  const ci = arr.indexOf(cur.id);
                  const ti = arr.indexOf(tgt.id);
                  if (ci >= 0 && ti >= 0) {
                    [arr[ci], arr[ti]] = [arr[ti], arr[ci]];
                    cursor++;
                    invalidate();
                    tui.requestRender();
                  }
                }
                return;
              }
            }
          }

          return { render, invalidate, handleInput };
        });

        const total = config.free.length + config.paid.length;
        ctx.ui.notify(`Providers: ${config.free.length} free + ${config.paid.length} paid = ${total} active`, "info");
        return;
      }

      if (subcmd === "list" || subcmd === "status") {
        ctx.ui.notify(
          `Free:  ${config.free.join(" → ")}\nPaid:  ${config.paid.join(" → ")}`,
          "info"
        );
        return;
      }

      ctx.ui.notify("Usage: /freemium {configure|optimize|list|status}", "info");
    },
  });

  // ── Router helpers ───────────────────────────────────────────
  function find(ctx, provider, id) {
    return ctx.modelRegistry.find(provider, id);
  }

  function getModelForProvider(ctx, pid, level) {
    const pdef = DEFAULT_PROVIDERS.find(p => p.id === pid);
    if (pdef) {
      const isLow = level === "off" || level === "low";
      const modelId = isLow ? pdef.low : pdef.high;
      if (modelId) {
        const m = find(ctx, pid, modelId);
        if (m) return m;
      }
    }
    // Fallback: use any model from this provider's registry
    try {
      const provider = ctx.modelRegistry.getProvider(pid);
      if (provider && provider.models && provider.models.length > 0) {
        return find(ctx, pid, provider.models[0].id);
      }
    } catch (_) {}
    return null;
  }

  function isContextOverflow(failed) {
    if (failed.message?.stopReason === "context_length_exceeded") return true;
    return /context.length|too many tokens/i.test(failed.message?.errorMessage || "");
  }

  function nextTier(ctx, failedModelId, level) {
    const current = getFailedProvider(failedModelId);
    const all = [...config.free, ...config.paid];
    const idx = current ? all.indexOf(current) : -1;
    const isLow = level === "off" || level === "low";

    for (let i = Math.max(idx + 1, 0); i < all.length; i++) {
      const m = getModelForProvider(ctx, all[i], level);
      if (m) {
        return {
          model: m,
          thinkingLevel: isLow ? "off" : level === "medium" ? "medium" : "low"
        };
      }
    }
    return null;
  }

  // ── Virtual model: freemium/penny-pincher ──────────────────────
  pi.registerVirtualModel({
    provider: "freemium",
    id: "penny-pincher",
    name: "Penny-Pincher (free-first + paid fallback router)",
    thinkingLevels: ["off", "low", "medium", "high", "xhigh", "max"],
    contextWindow: 200000,
    maxTokens: 32768,
    input: ["text", "image"],

    route(request, ctx) {
      const level = request.thinkingLevel;
      const isLow = level === "off" || level === "low";

      // ── Retry / failure: check gateway before switching ───────
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
          const all = [...config.paid, ...config.free.reverse()];
          for (const pid of all) {
            const m = getModelForProvider(ctx, pid, level);
            if (m) return { model: m, thinkingLevel: "medium", state: { gateway: { ip: config.gatewayIp, status: "online" } } };
          }
        }

        const fallback = nextTier(ctx, failedModelId, level);
        if (fallback?.model) return { model: fallback.model, thinkingLevel: fallback.thinkingLevel, state: { gateway: { ip: config.gatewayIp, status: "online" } } };

        return { model: request.previous?.model, thinkingLevel: level, state: { gateway: { ip: config.gatewayIp, status: "online" } } };
      }

      // ── Continuation: sticky ─────────────────────────────────
      const sticky = request.failed ?? request.previous;
      if (request.reason !== "user" && sticky) {
        return { model: sticky.model, thinkingLevel: sticky.thinkingLevel ?? "medium" };
      }

      // ── Fresh user messages: free first, then paid ────────────
      for (const pid of config.free) {
        const m = getModelForProvider(ctx, pid, level);
        if (m) {
          return {
            model: m,
            thinkingLevel: isLow ? "off" : level === "medium" ? "medium" : "low"
          };
        }
      }

      // All free exhausted → try paid
      for (const pid of config.paid) {
        const m = getModelForProvider(ctx, pid, level);
        if (m) {
          return {
            model: m,
            thinkingLevel: isLow ? "off" : level === "medium" ? "medium" : "low"
          };
        }
      }

      return { model: request.previous?.model, thinkingLevel: level };
    }
  });
}
