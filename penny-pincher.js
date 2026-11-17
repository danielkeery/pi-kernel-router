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

// ── Default known providers ─────────────────────────────────────
// Free (tried first, in order):
const FREE_PROVIDERS = [
  { id: "google",       name: "Google Gemini",        low: "gemini-2.5-flash",              high: "gemini-2.5-flash" },
  { id: "amd-tokenlab", name: "AMD TokenLab",          low: "DeepSeek-V4-Flash",             high: "DeepSeek-V4-Flash" },
  { id: "cline",        name: "Cline",                 low: "cohere/north-mini-code:free",    high: "openrouter/free" },
  { id: "groq",         name: "Groq",                  low: "llama-3.1-8b-instant",         high: "llama-3.3-70b-specdec" },
  { id: "kilo",         name: "Kilo",                  low: "kilo-auto/free",                high: "kilo-auto/free" },
  { id: "xkiro",        name: "Xkiro",                 low: "mistralai/ministral-14b",       high: "mistralai/codestral-2508" },
  { id: "requesty",     name: "Requesty",              low: "nvidia/nemotron-3-nano-30b-a3b", high: "google/gemma-4-31b-it" },
];

// Paid (tried after all free are exhausted, in order):
const PAID_PROVIDERS = [];

// ── Runtime config ──────────────────────────────────────────────
const config = {
  gatewayIp: "192.168.43.100",
  free: FREE_PROVIDERS.map(p => p.id),
  paid: PAID_PROVIDERS.map(p => p.id),
};

// All known provider definitions (free + paid combined)
const ALL_PROVIDERS = [...FREE_PROVIDERS, ...PAID_PROVIDERS];

function getProvDef(id) {
  return ALL_PROVIDERS.find(p => p.id === id) || {
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
  for (const p of ALL_PROVIDERS) {
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

// ── Discover provider IDs the registry knows about ──────────────
// Merge default known providers with any extra IDs the user has in their config
function getProviderCatalog(ctx) {
  const known = new Map();
  for (const p of ALL_PROVIDERS) known.set(p.id, p);
  // Add any extra providers from the user's configured lists not already known
  for (const pid of [...config.free, ...config.paid]) {
    if (!known.has(pid)) {
      known.set(pid, { id: pid, name: pid.charAt(0).toUpperCase() + pid.slice(1), low: null, high: null });
    }
  }
  return Array.from(known.values());
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

      // ── /freemium optimize ────────────────────────────────────
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
          `Current:  ${current}\nProposed: ${proposed}\n\n(Paid providers are unchanged)`
        );
        if (ok) {
          config.free = suggested;
          ctx.ui.notify(`Applied: ${proposed}`, "info");
        }
        return;
      }

      // ── /freemium configure ───────────────────────────────────
      if (subcmd === "configure" || subcmd === "") {
        if (ctx.mode !== "tui") {
          ctx.ui.notify("/freemium configure requires TUI mode", "error");
          return;
        }

        await ctx.ui.custom((tui, theme, keybindings, done) => {
          const free = [...config.free];
          const paid = [...config.paid];
          let section = 0; // 0 = free section, 1 = paid section
          let cursor = 0;
          let showAll = false;
          let cachedWidth = undefined;
          let cachedLines = undefined;
          let message = "";

          function getItems() {
            const catalog = getProviderCatalog(ctx);
            if (showAll) {
              return catalog.map(p => ({
                ...p,
                inFree: free.includes(p.id),
                freeIdx: free.indexOf(p.id),
                inPaid: paid.includes(p.id),
                paidIdx: paid.indexOf(p.id),
              }));
            }
            // Show only configured items, grouped by section
            const result = [];
            for (let i = 0; i < free.length; i++) {
              const p = getProvDef(free[i]);
              result.push({ ...p, section: "free", idx: i });
            }
            for (let i = 0; i < paid.length; i++) {
              const p = getProvDef(paid[i]);
              result.push({ ...p, section: "paid", idx: i });
            }
            return result;
          }

          function clamp() {
            const items = getItems();
            cursor = Math.max(0, Math.min(cursor, Math.max(0, items.length - 1)));
          }

          function render(width) {
            if (cachedLines && cachedWidth === width) return cachedLines;
            cachedWidth = width;

            const items = getItems();
            clamp();

            const lines = [];
            lines.push(theme.style("  Freemium Penny-Pincher — Provider Configuration", { fg: "accent", bold: true }));
            lines.push("");
            lines.push(theme.fg("dim",
              showAll
                ? "All providers — [Tab] toggle view  [Space] toggle  [p] tag paid  [Enter] done"
                : "Configured — [Tab] toggle view  [↑↓/u/d] move  [Enter] done"
            ));
            lines.push("");

            if (showAll) {
              // All-providers view: just free tag, p tag, and cursor
              const catalog = getProviderCatalog(ctx);
              for (let i = 0; i < catalog.length; i++) {
                const p = catalog[i];
                const inFree = free.includes(p.id);
                const inPaid = paid.includes(p.id);
                const tag = inPaid ? theme.fg("warning", " p") : inFree ? theme.fg("success", "  ") : "  ";
                const arrow = i === cursor ? theme.fg("accent", " →") : "  ";
                const label = `${arrow} ${p.name.padEnd(30)}${tag}`;
                lines.push(i === cursor ? theme.bg("highlight", `  ${label}`) : `  ${label}`);
              }
              const h = theme.fg("dim", "  [Space] toggle free  [p] toggle paid  [Enter] done");
              lines.push(lines.some(l => l.length > width) ? h : "");
            } else {
              // Configured view: two sections with headers
              const hasFree = free.length > 0;
              const hasPaid = paid.length > 0;

              if (hasFree) {
                lines.push(theme.fg("dim", "  ─ Free (tried first) ─"));
                for (let i = 0; i < free.length; i++) {
                  const p = getProvDef(free[i]);
                  const idx = i;
                  const arrow = i === cursor ? theme.fg("accent", " →") : "  ";
                  const num = theme.fg("accent", `#${idx + 1}`);
                  lines.push(`  ${arrow} ${num} ${p.name}`);
                }
              }

              if (hasFree && hasPaid) lines.push("");

              if (hasPaid) {
                lines.push(theme.fg("dim", "  ─ Paid (fallback) ─"));
                for (let i = 0; i < paid.length; i++) {
                  const p = getProvDef(paid[i]);
                  const idx = free.length + i;
                  const arrow = idx === cursor ? theme.fg("accent", " →") : "  ";
                  const num = theme.fg("warning", `#${idx + 1}`);
                  lines.push(`  ${arrow} ${num} p ${p.name}`);
                }
              }

              if (!hasFree && !hasPaid) {
                lines.push(theme.fg("dim", "  No providers configured — type Tab to add some"));
              }
            }

            if (message) {
              lines.push("");
              lines.push(theme.fg("accent", `  ${message}`));
            }

            cachedLines = lines.map(l => l.length > width ? l.slice(0, width) : l);
            return cachedLines;
          }

          function invalidate() { cachedWidth = undefined; cachedLines = undefined; }

          function handleInput(data) {
            message = "";

            const catalog = getProviderCatalog(ctx);
            const isUp = keybindings.matches(data, "tui.select.up") || data === "u";
            const isDown = keybindings.matches(data, "tui.select.down") || data === "d";

            if (showAll) {
              // ── All-providers view: toggle free/paid ──────────
              if (isUp && cursor > 0) { cursor--; }
              else if (isDown && cursor < catalog.length - 1) { cursor++; }
              else if (data === " ") {
                const pid = catalog[cursor].id;
                const fi = free.indexOf(pid);
                if (fi >= 0) free.splice(fi, 1);
                else free.push(pid);
                // Remove from paid if there
                const pi = paid.indexOf(pid);
                if (pi >= 0) paid.splice(pi, 1);
              } else if (data === "p") {
                const pid = catalog[cursor].id;
                const pi = paid.indexOf(pid);
                if (pi >= 0) paid.splice(pi, 1);
                else paid.push(pid);
                // Remove from free if there
                const fi = free.indexOf(pid);
                if (fi >= 0) free.splice(fi, 1);
              } else if (data === "\t") { showAll = false; }
              else if (data === "\r" || data === "\n") { config.free = free; config.paid = paid; done(null); return; }
              else return;
            } else {
              // ── Configured view: move items ─────────────────
              const items = [];
              for (const pid of free) items.push({ id: pid, section: "free" });
              for (const pid of paid) items.push({ id: pid, section: "paid" });
              clamp();

              if (isUp && cursor > 0) {
                const cur = items[cursor];
                const tgt = items[cursor - 1];
                // Swap within the same section only
                if (cur.section === tgt.section) {
                  const arr = cur.section === "free" ? free : paid;
                  const ci = arr.indexOf(cur.id);
                  const ti = arr.indexOf(tgt.id);
                  if (ci >= 0 && ti >= 0) {
                    [arr[ci], arr[ti]] = [arr[ti], arr[ci]];
                    cursor--;
                  }
                }
              } else if (isDown && cursor < items.length - 1) {
                const cur = items[cursor];
                const tgt = items[cursor + 1];
                if (cur.section === tgt.section) {
                  const arr = cur.section === "free" ? free : paid;
                  const ci = arr.indexOf(cur.id);
                  const ti = arr.indexOf(tgt.id);
                  if (ci >= 0 && ti >= 0) {
                    [arr[ci], arr[ti]] = [arr[ti], arr[ci]];
                    cursor++;
                  }
                }
              } else if (data === "\t") { showAll = true; }
              else if (data === "\r" || data === "\n") { config.free = free; config.paid = paid; done(null); return; }
              else return;
            }

            invalidate();
            tui.requestRender();
          }

          return { render, invalidate, handleInput };
        });

        const total = config.free.length + config.paid.length;
        ctx.ui.notify(`Providers: ${config.free.length} free + ${config.paid.length} paid = ${total} active`, "info");
        return;
      }

      // ── /freemium list ────────────────────────────────────────
      if (subcmd === "list" || subcmd === "status") {
        const freeChain = config.free.join(" → ");
        const paidChain = config.paid.join(" → ");
        ctx.ui.notify(
          `Free:  ${freeChain}\nPaid:  ${paidChain}`,
          "info"
        );
        return;
      }

      ctx.ui.notify("Usage: /freemium {configure|optimize|list|status}", "info");
    },
  });

  // ── Helpers ──────────────────────────────────────────────────
  function find(ctx, provider, id) {
    return ctx.modelRegistry.find(provider, id);
  }

  function getModelForProvider(ctx, pid, level) {
    const pdef = ALL_PROVIDERS.find(p => p.id === pid) || getProvDef(pid);
    const isLow = level === "off" || level === "low";
    const modelId = isLow ? pdef.low : pdef.high;
    if (modelId) {
      const m = find(ctx, pid, modelId);
      if (m) return m;
    }
    // If the specific model ID isn't known in defaults, try finding any model from this provider
    const provider = ctx.modelRegistry.getProvider(pid);
    if (provider && provider.models && provider.models.length > 0) {
      return find(ctx, pid, provider.models[0].id);
    }
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
          // Jump to the last configured provider (highest context window)
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
        const modelId = isLow
          ? (ALL_PROVIDERS.find(p => p.id === pid)?.low || null)
          : (ALL_PROVIDERS.find(p => p.id === pid)?.high || null);
        if (!modelId) continue;
        const m = find(ctx, pid, modelId);
        if (m) {
          return {
            model: m,
            thinkingLevel: isLow ? "off" : level === "medium" ? "medium" : "low"
          };
        }
      }

      // All free exhausted → try paid
      for (const pid of config.paid) {
        const modelId = isLow
          ? (ALL_PROVIDERS.find(p => p.id === pid)?.low || null)
          : (ALL_PROVIDERS.find(p => p.id === pid)?.high || null);
        if (!modelId) continue;
        const m = find(ctx, pid, modelId);
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
