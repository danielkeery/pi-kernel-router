// Freemium Penny-Pincher — Free-First AI Model Router with configurable paid fallback
//
// Routes through free provider/models first in your configured order, then paid.
// /freemium-configure: model-level selection and ordering with scrollable TUI.
//
// Commands:
//   /freemium-configure  — Interactive TUI to select/reorder free & paid models
//   /freemium-optimize   — Suggest best ordering by provider capability
//   /freemium-list       — Show current free and paid model chains
//   /freemium-status     — Alias for /freemium-list
//   /set-router-gateway   — Set gateway IP for network-liveness checks
//   /freemium            — Show usage help

const { execSync } = require("child_process");

// ── Legacy provider model hints (used for provider-ID-only fallbacks) ──
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
  free: DEFAULT_PROVIDERS.map(p => `${p.id}/${p.low}`),
  paid: [],
};

// Backward-compat: migrate legacy provider-only strings to provider/model
function migrateConfig(registry) {
  const all = [...config.free, ...config.paid];
  if (all.length > 0 && !all[0].includes("/")) {
    config.free = config.free.map(pid => {
      const pdef = DEFAULT_PROVIDERS.find(p => p.id === pid);
      if (pdef?.low) return `${pid}/${pdef.low}`;
      try {
        const prov = registry?.getProvider?.(pid);
        if (prov?.getModels) {
          const m = prov.getModels()[0];
          if (m) return `${pid}/${m.id}`;
        }
      } catch (_) {}
      return `${pid}/default`;
    });
    config.paid = config.paid.map(pid => {
      const pdef = DEFAULT_PROVIDERS.find(p => p.id === pid);
      if (pdef?.low) return `${pid}/${pdef.low}`;
      try {
        const prov = registry?.getProvider?.(pid);
        if (prov?.getModels) {
          const m = prov.getModels()[0];
          if (m) return `${pid}/${m.id}`;
        }
      } catch (_) {}
      return `${pid}/default`;
    });
  }
}

function pingGateway(ip) {
  try {
    execSync(`ping -c 1 -W 2 ${ip}`, { timeout: 3000, stdio: "ignore" });
    return "online";
  } catch {
    return "offline";
  }
}

// ── Capability ranking for optimization ─────────────────────────
const CAPABILITY_RANK = [
  "google", "groq", "amd-tokenlab", "cline", "xkiro", "kilo", "requesty",
];

function suggestOrder(selected) {
  return [...selected].sort((a, b) => {
    const pa = a.split("/")[0];
    const pb = b.split("/")[0];
    const ia = CAPABILITY_RANK.indexOf(pa);
    const ib = CAPABILITY_RANK.indexOf(pb);
    return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
  });
}

// ── Entry resolution ───────────────────────────────────────────
function resolveEntry(registry, entry) {
  if (!entry) return null;
  if (entry.includes("/")) {
    const [provider, ...rest] = entry.split("/");
    const modelId = rest.join("/");
    return registry.find(provider, modelId);
  }
  try {
    const prov = registry.getProvider(entry);
    if (prov?.getModels) {
      const m = prov.getModels()[0];
      if (m) return registry.find(entry, m.id);
    }
  } catch (_) {}
  return null;
}

function getFailedEntryIndex(failedModel) {
  if (!failedModel) return -1;
  const { provider, id } = failedModel;
  // Build the key as stored in config: "provider/model"
  const key = provider && id ? `${provider}/${id}` : null;
  const all = [...config.free, ...config.paid];
  if (key) {
    const idx = all.indexOf(key);
    if (idx >= 0) return idx;
  }
  // Fallback: match by provider prefix
  const prov = provider || (typeof failedModel === "string" ? failedModel.split("/")[0] : null);
  if (prov) {
    const idx = all.findIndex(e => e === prov || e.startsWith(prov + "/"));
    if (idx >= 0) return idx;
  }
  return -1;
}

function entryProvider(entry) {
  return entry.includes("/") ? entry.split("/")[0] : entry;
}

function entryLabel(entry, registry) {
  if (!entry) return "unknown";
  if (entry.includes("/")) {
    const [prov, ...rest] = entry.split("/");
    const modelId = rest.join("/");
    const m = registry?.find?.(prov, modelId);
    if (m?.name) return `${prov}/${m.name}`;
  }
  return entry;
}

// ── Usage text for /freemium help command ──────────────────────
function showUsage(ctx) {
  ctx.ui.notify(
    `Penny-Pincher commands:\n` +
    `  /freemium-configure — Interactive model selection & ordering\n` +
    `  /freemium-optimize  — Auto-sort free chain by capability\n` +
    `  /freemium-list      — Show current free → paid chains\n` +
    `  /freemium-status    — Alias for /freemium-list\n` +
    `  /set-router-gateway <IP> — Set gateway for network checks`,
    "info"
  );
}

export default function (pi) {
  pi.registerCommand("set-router-gateway", {
    description: "Set the gateway IP for network-liveness checks (usage: /set-router-gateway <IP>)",
    handler: async (args, ctx) => {
      const ip = args.trim();
      if (!ip) {
        ctx.ui.notify(`Current gateway: ${config.gatewayIp} — usage: /set-router-gateway <IP>`, "info");
        return;
      }
      config.gatewayIp = ip;
      const status = pingGateway(ip);
      ctx.ui.notify(`Gateway ${ip}: ${status}`, status === "online" ? "info" : "warning");
    },
  });

  pi.registerCommand("freemium-optimize", {
    description: "Suggest best free model ordering by provider capability",
    handler: async (_args, ctx) => {
      migrateConfig(ctx.modelRegistry);
      const suggested = suggestOrder(config.free);
      const current = config.free.join(" → ");
      const proposed = suggested.join(" → ");
      if (current === proposed) {
        ctx.ui.notify("Already optimal! ✓", "info");
        return;
      }
      const ok = await ctx.ui.confirm(
        "Optimize free model order?",
        `Current:  ${current}\nProposed: ${proposed}\n\n(Paid models unchanged)`
      );
      if (ok) {
        config.free = suggested;
        ctx.ui.notify(`Applied: ${proposed}`, "info");
      }
    },
  });

  pi.registerCommand("freemium-configure", {
    description: "Interactive TUI to select/reorder free & paid models",
    handler: async (_args, ctx) => {
      migrateConfig(ctx.modelRegistry);
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/freemium-configure requires TUI mode", "error");
        return;
      }

      let allModels = [];
      try {
        allModels = (ctx.modelRegistry.getAll?.() ?? [])
          .filter(m => m.provider && m.id)
          .sort((a, b) => {
            const pc = (a.provider || "").localeCompare(b.provider || "");
            if (pc !== 0) return pc;
            return (a.name || a.id).localeCompare(b.name || b.id);
          });
      } catch (_) {
        allModels = [];
      }

      await ctx.ui.custom((tui, theme, keybindings, done) => {
        let free = [...config.free];
        let paid = [...config.paid];
        let screen = "main";
        let cursor = 0;
        let moveMode = false;
        let addCursor = 0;
        let addScrollTop = 0;
        let mainScrollTop = 0;
        let cachedWidth = undefined;
        let cachedLines = undefined;

        const VIEWPORT = 18;
        const pool = () => new Set([...free, ...paid]);

        function getItems() {
          const result = [];
          for (let i = 0; i < free.length; i++) result.push({ entry: free[i], section: "free" });
          for (let i = 0; i < paid.length; i++) result.push({ entry: paid[i], section: "paid" });
          return result;
        }

        function clampMain() {
          const count = free.length + paid.length;
          if (count === 0) cursor = 0;
          else cursor = Math.max(0, Math.min(cursor, count - 1));
        }
        function clampAdd() {
          if (allModels.length === 0) addCursor = 0;
          else addCursor = Math.max(0, Math.min(addCursor, allModels.length - 1));
        }

        function truncate(line, width) {
          return line.length > width ? line.slice(0, width) : line;
        }

        function renderAdd(width) {
          const lines = [];
          let cursorLine = -1;
          lines.push(theme.style("  Add Models to Router", { fg: "accent", bold: true }));
          lines.push("");
          lines.push(theme.fg("dim", "  [Space] toggle  [Enter/Esc] return"));
          lines.push("");

          let currentProv = null;
          for (let idx = 0; idx < allModels.length; idx++) {
            const m = allModels[idx];
            if (m.provider !== currentProv) {
              currentProv = m.provider;
              lines.push(theme.fg("dim", `  ── ${currentProv} ──`));
            }
            if (idx === addCursor) cursorLine = lines.length;
            const inPool = free.includes(`${m.provider}/${m.id}`) || paid.includes(`${m.provider}/${m.id}`);
            const sel = idx === addCursor;
            const prefix = sel ? theme.fg("accent", "> ") : "  ";
            const mark = inPool ? theme.fg("success", "[✓]") : "[ ]";
            const label = m.name ? `${m.provider}/${m.name}` : `${m.provider}/${m.id}`;
            const row = `  ${prefix}${mark} ${label}`;
            lines.push(sel ? theme.fg("accent", row) : row);
          }

          if (allModels.length === 0) {
            lines.push(theme.fg("dim", "  No models available in registry"));
          }

          if (cursorLine >= 0) {
            if (cursorLine < addScrollTop) addScrollTop = cursorLine;
            if (cursorLine >= addScrollTop + VIEWPORT) addScrollTop = cursorLine - VIEWPORT + 1;
          }

          const visible = lines.slice(addScrollTop, addScrollTop + VIEWPORT);
          return visible.map(l => truncate(l, width));
        }

        function renderMain(width) {
          const lines = [];
          let cursorLine = -1;
          const items = getItems();
          clampMain();

          lines.push(theme.style("  Freemium Penny-Pincher — Configured Models", { fg: "accent", bold: true }));
          lines.push("");

          if (items.length === 0) {
            lines.push(theme.fg("dim", "  No models configured — press Tab to add"));
            lines.push("");
            lines.push(theme.fg("dim", "  [Tab] add models  [Enter] done"));
            return lines.map(l => truncate(l, width));
          }

          const freeItems = items.filter(it => it.section === "free");
          const paidItems = items.filter(it => it.section === "paid");

          if (freeItems.length > 0) {
            lines.push(theme.fg("dim", "  ─ Free (tried first) ─"));
            freeItems.forEach(it => {
              const globalIdx = items.indexOf(it);
              if (globalIdx === cursor) cursorLine = lines.length;
              const selected = globalIdx === cursor && !moveMode;
              const moving = globalIdx === cursor && moveMode;
              const prefix = moving ? theme.fg("accent", " ◉") : selected ? theme.fg("accent", " ○") : "  ";
              const label = ` ${prefix} #${globalIdx + 1} ${it.entry}`;
              if (moving) {
                lines.push(theme.style(`  ${label}  [↑↓] move  [Space] done  [d] remove`, {fg: "accent", bold: true}));
              } else {
                lines.push(`  ${label}`);
              }
            });
          }

          if (paidItems.length > 0) {
            lines.push("");
            lines.push(theme.fg("dim", "  ─ Paid (fallback) ─"));
            paidItems.forEach(it => {
              const globalIdx = items.indexOf(it);
              if (globalIdx === cursor) cursorLine = lines.length;
              const selected = globalIdx === cursor && !moveMode;
              const moving = globalIdx === cursor && moveMode;
              const prefix = moving ? theme.fg("accent", " ◉") : selected ? theme.fg("accent", " ○") : "  ";
              const label = ` ${prefix} #${globalIdx + 1} ${it.entry}`;
              if (moving) {
                lines.push(theme.style(`  ${label}  [↑↓] move  [Space] done  [d] remove`, {fg: "accent", bold: true}));
              } else {
                lines.push(`  ${label}`);
              }
            });
          }

          lines.push("");
          lines.push(theme.fg("dim", "  [↑↓] move  [Space] toggle move  [p] free/paid  [d] delete  [Tab] add  [Enter] done"));

          if (cursorLine >= 0) {
            if (cursorLine < mainScrollTop) mainScrollTop = cursorLine;
            if (cursorLine >= mainScrollTop + VIEWPORT) mainScrollTop = cursorLine - VIEWPORT + 1;
          }

          const visible = lines.slice(mainScrollTop, mainScrollTop + VIEWPORT);
          return visible.map(l => truncate(l, width));
        }

        function render(width) {
          if (cachedLines && cachedWidth === width) return cachedLines;
          cachedWidth = width;
          cachedLines = screen === "add" ? renderAdd(width) : renderMain(width);
          return cachedLines;
        }

        function invalidate() { cachedWidth = undefined; cachedLines = undefined; }

        function handleInput(data) {
          if (screen === "add") {
            clampAdd();

            if (keybindings.matches(data, "tui.select.up")) {
              if (addCursor > 0) addCursor--;
            } else if (keybindings.matches(data, "tui.select.down")) {
              if (addCursor < allModels.length - 1) addCursor++;
            } else if (keybindings.matches(data, "tui.select.cancel")) {
              screen = "main";
              moveMode = false;
              invalidate();
              tui.requestRender();
              return;
            } else if (data === "\r" || data === "\n") {
              screen = "main";
              moveMode = false;
              invalidate();
              tui.requestRender();
              return;
            } else if (data === "\t") {
              screen = "main";
              moveMode = false;
              invalidate();
              tui.requestRender();
              return;
            } else if (data === " ") {
              const m = allModels[addCursor];
              if (m) {
                const key = `${m.provider}/${m.id}`;
                const fi = free.indexOf(key);
                const pi = paid.indexOf(key);
                if (fi >= 0) {
                  free.splice(fi, 1);
                } else if (pi >= 0) {
                  paid.splice(pi, 1);
                } else {
                  free.push(key);
                }
              }
            } else {
              return;
            }
            invalidate();
            tui.requestRender();
            return;
          }

          const items = getItems();
          clampMain();

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

          if (data === "\t") {
            screen = "add";
            addCursor = 0;
            addScrollTop = 0;
            moveMode = false;
            invalidate();
            tui.requestRender();
            return;
          }

          const isUp = keybindings.matches(data, "tui.select.up");
          const isDown = keybindings.matches(data, "tui.select.down");

          if (isUp && cursor > 0) {
            if (moveMode) {
              const cur = items[cursor];
              const tgt = items[cursor - 1];
              if (cur.section === tgt.section) {
                const arr = cur.section === "free" ? free : paid;
                const ci = arr.indexOf(cur.entry);
                const ti = arr.indexOf(tgt.entry);
                if (ci >= 0 && ti >= 0) { [arr[ci], arr[ti]] = [arr[ti], arr[ci]]; cursor--; }
              }
            } else {
              cursor--;
            }
            invalidate();
            tui.requestRender();
            return;
          }

          if (isDown && cursor < items.length - 1) {
            if (moveMode) {
              const cur = items[cursor];
              const tgt = items[cursor + 1];
              if (cur.section === tgt.section) {
                const arr = cur.section === "free" ? free : paid;
                const ci = arr.indexOf(cur.entry);
                const ti = arr.indexOf(tgt.entry);
                if (ci >= 0 && ti >= 0) { [arr[ci], arr[ti]] = [arr[ti], arr[ci]]; cursor++; }
              }
            } else {
              cursor++;
            }
            invalidate();
            tui.requestRender();
            return;
          }

          if (data === "d" || data === "D") {
            if (cursor < items.length) {
              const entry = items[cursor].entry;
              const fi = free.indexOf(entry);
              if (fi >= 0) free.splice(fi, 1);
              const pi = paid.indexOf(entry);
              if (pi >= 0) paid.splice(pi, 1);
              moveMode = false;
              if (cursor >= items.length - 1 && cursor > 0) cursor--;
              invalidate();
              tui.requestRender();
            }
            return;
          }

          if (data === "p" || data === "P") {
            if (cursor < items.length) {
              const entry = items[cursor].entry;
              const fi = free.indexOf(entry);
              if (fi >= 0) {
                free.splice(fi, 1);
                paid.push(entry);
              } else {
                const pi = paid.indexOf(entry);
                if (pi >= 0) { paid.splice(pi, 1); free.push(entry); }
              }
              moveMode = false;
              invalidate();
              tui.requestRender();
            }
            return;
          }
        }

        return { render, invalidate, handleInput };
      });

      const total = config.free.length + config.paid.length;
      ctx.ui.notify(`Models: ${config.free.length} free + ${config.paid.length} paid = ${total} active`, "info");
    },
  });

  pi.registerCommand("freemium-list", {
    description: "Show current free and paid model chains",
    handler: async (_args, ctx) => {
      migrateConfig(ctx.modelRegistry);
      ctx.ui.notify(
        `Free:  ${config.free.join(" → ")}\nPaid:  ${config.paid.join(" → ")}`,
        "info"
      );
    },
  });

  pi.registerCommand("freemium-status", {
    description: "Alias for /freemium-list — show current model chains",
    handler: async (_args, ctx) => {
      migrateConfig(ctx.modelRegistry);
      ctx.ui.notify(
        `Free:  ${config.free.join(" → ")}\nPaid:  ${config.paid.join(" → ")}`,
        "info"
      );
    },
  });

  // Legacy catch-all dispatcher for backward compatibility
  pi.registerCommand("freemium", {
    description: "Obsolete — use /freemium-configure, /freemium-optimize, /freemium-list",
    handler: async (args, ctx) => {
      const subcmd = args.trim().split(/\s+/)[0];
      if (subcmd === "configure" || subcmd === "") {
        ctx.ui.notify("Use /freemium-configure instead", "warning");
      } else if (subcmd === "optimize") {
        ctx.ui.notify("Use /freemium-optimize instead", "warning");
      } else if (subcmd === "list" || subcmd === "status") {
        ctx.ui.notify("Use /freemium-list instead", "warning");
      } else {
        showUsage(ctx);
      }
    },
  });

  // ── Router helpers ───────────────────────────────────────────
  function isContextOverflow(failed) {
    if (failed.message?.stopReason === "context_length_exceeded") return true;
    return /context.length|too many tokens/i.test(failed.message?.errorMessage || "");
  }

  function nextTier(ctx, failedModel, level) {
    const idx = getFailedEntryIndex(failedModel);
    const all = [...config.free, ...config.paid];
    const isLow = level === "off" || level === "low";

    for (let i = Math.max(idx + 1, 0); i < all.length; i++) {
      const m = resolveEntry(ctx.modelRegistry, all[i]);
      if (m) {
        return {
          model: m,
          thinkingLevel: isLow ? "off" : level === "medium" ? "medium" : "low"
        };
      }
    }
    return null;
  }

  pi.registerVirtualModel({
    provider: "freemium",
    id: "penny-pincher",
    name: "Penny-Pincher (free-first + paid fallback router)",
    thinkingLevels: ["off", "low", "medium", "high", "xhigh", "max"],
    contextWindow: 200000,
    maxTokens: 32768,
    input: ["text", "image"],

    route(request, ctx) {
      migrateConfig(ctx.modelRegistry);
      const level = request.thinkingLevel;
      const isLow = level === "off" || level === "low";

      if ((request.reason === "retry" || request.reason === "continuation") && request.failed) {
        const failedModel = request.failed.model || request.previous?.model;
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
          for (const entry of all) {
            const m = resolveEntry(ctx.modelRegistry, entry);
            if (m) return { model: m, thinkingLevel: "medium", state: { gateway: { ip: config.gatewayIp, status: "online" } } };
          }
        }

        const fallback = nextTier(ctx, failedModel, level);
        if (fallback?.model) return { model: fallback.model, thinkingLevel: fallback.thinkingLevel, state: { gateway: { ip: config.gatewayIp, status: "online" } } };

        return { model: request.previous?.model, thinkingLevel: level, state: { gateway: { ip: config.gatewayIp, status: "online" } } };
      }

      const sticky = request.failed ?? request.previous;
      if (request.reason !== "user" && sticky) {
        return { model: sticky.model, thinkingLevel: sticky.thinkingLevel ?? "medium" };
      }

      for (const entry of config.free) {
        const m = resolveEntry(ctx.modelRegistry, entry);
        if (m) {
          return {
            model: m,
            thinkingLevel: isLow ? "off" : level === "medium" ? "medium" : "low"
          };
        }
      }

      for (const entry of config.paid) {
        const m = resolveEntry(ctx.modelRegistry, entry);
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
