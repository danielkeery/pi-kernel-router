// Freemium Penny-Pincher — Free-First AI Model Router with configurable paid fallback
//
// Version: 1.0-{COMMIT}
// Author: Daniel Keery <daniel@keery.dev>
// GitHub: https://github.com/danielkeery/pi-kernel-router
//
// Routes through free provider/models first in your configured order, then paid.
// /freemium-configure: multi-screen TUI with Provider/Model Selection, Priority,
//   Optimization, Error Handling, and About.
//
// Commands:
//   /freemium-configure  — Multi-screen configuration TUI
//   /freemium-optimize   — AI-powered model order optimization
//   /freemium-list       — Show current free and paid model chains
//   /freemium-status     — Alias for /freemium-list
//   /freemium-reset      — Reset configuration to factory defaults
//   /set-router-gateway   — Set gateway IP for network-liveness checks
//   /freemium            — Show usage help

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

// ── Version ───────────────────────────────────────────────────
let EXT_VERSION = "1.0";
try {
  const commit = execSync("git rev-parse --short HEAD 2>/dev/null || echo unknown", { encoding: "utf8", stdio: "pipe" }).trim();
  EXT_VERSION = `1.0-${commit}`;
} catch (_) { EXT_VERSION = "1.0"; }

// ── Config file paths ──────────────────────────────────────────
const CONFIG_DIR = path.join(__dirname);
const CONFIG_FILE = path.join(CONFIG_DIR, "penny-pincher-config.json");
const BACKUPS_FILE = path.join(CONFIG_DIR, "penny-pincher-config.backups.json");
const MAX_BACKUPS = 10;

// ── Legacy provider model hints ────────────────────────────────
const DEFAULT_PROVIDERS = [
  { id: "google",       name: "Google Gemini",        low: "gemini-2.5-flash",              high: "gemini-2.5-flash" },
  { id: "amd-tokenlab", name: "AMD TokenLab",          low: "DeepSeek-V4-Flash",             high: "DeepSeek-V4-Flash" },
  { id: "cline",        name: "Cline",                 low: "cohere/north-mini-code:free",    high: "openrouter/free" },
  { id: "groq",         name: "Groq",                  low: "llama-3.1-8b-instant",         high: "llama-3.3-70b-specdec" },
  { id: "kilo",         name: "Kilo",                  low: "kilo-auto/free",                high: "kilo-auto/free" },
  { id: "xkiro",        name: "Xkiro",                 low: "mistralai/ministral-14b",       high: "mistralai/codestral-2508" },
  { id: "requesty",     name: "Requesty",              low: "nvidia/nemotron-3-nano-30b-a3b", high: "google/gemma-4-31b-it" },
];

// ── Runtime config with persistence ────────────────────────────
const config = {
  gatewayIp: "192.168.43.100",
  free: DEFAULT_PROVIDERS.map(p => `${p.id}/${p.low}`),
  paid: [],
  errorHandling: {
    networkTestOnFail: true,
    testAddress: "1.1.1.1",
  },
  metrics: {
    totalCostAvoided: 0,
    totalContextTokens: 0,
    totalMessagesRouted: 0,
    totalFreeRoutes: 0,
    totalPaidRoutes: 0,
    startDate: new Date().toISOString(),
  },
};

const KEY_STYLE = { fg: "white", bold: true };

function saveConfig() {
  try {
    const data = {
      gatewayIp: config.gatewayIp,
      free: config.free,
      paid: config.paid,
      errorHandling: config.errorHandling,
      metrics: config.metrics,
      savedAt: new Date().toISOString(),
    };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2), "utf8");

    let backups = [];
    try {
      const raw = fs.readFileSync(BACKUPS_FILE, "utf8");
      backups = JSON.parse(raw);
      if (!Array.isArray(backups)) backups = [];
    } catch (_) { backups = []; }
    backups.unshift({
      gatewayIp: data.gatewayIp,
      free: data.free,
      paid: data.paid,
      errorHandling: data.errorHandling,
      savedAt: data.savedAt,
    });
    if (backups.length > MAX_BACKUPS) backups.length = MAX_BACKUPS;
    fs.writeFileSync(BACKUPS_FILE, JSON.stringify(backups, null, 2), "utf8");
  } catch (_) {}
}

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, "utf8");
    const data = JSON.parse(raw);
    if (data.gatewayIp !== undefined) config.gatewayIp = data.gatewayIp;
    if (Array.isArray(data.free)) config.free = data.free;
    if (Array.isArray(data.paid)) config.paid = data.paid;
    if (data.errorHandling) {
      if (data.errorHandling.networkTestOnFail !== undefined) config.errorHandling.networkTestOnFail = data.errorHandling.networkTestOnFail;
      if (data.errorHandling.testAddress) config.errorHandling.testAddress = data.errorHandling.testAddress;
    }
    if (data.metrics) {
      if (data.metrics.totalCostAvoided !== undefined) config.metrics.totalCostAvoided = data.metrics.totalCostAvoided;
      if (data.metrics.totalContextTokens !== undefined) config.metrics.totalContextTokens = data.metrics.totalContextTokens;
      if (data.metrics.totalMessagesRouted !== undefined) config.metrics.totalMessagesRouted = data.metrics.totalMessagesRouted;
      if (data.metrics.totalFreeRoutes !== undefined) config.metrics.totalFreeRoutes = data.metrics.totalFreeRoutes;
      if (data.metrics.totalPaidRoutes !== undefined) config.metrics.totalPaidRoutes = data.metrics.totalPaidRoutes;
      if (data.metrics.startDate) config.metrics.startDate = data.metrics.startDate;
    }
  } catch (_) {}
}

loadConfig();

function migrateConfig(registry) {
  const all = [...config.free, ...config.paid];
  if (all.length > 0 && !all[0].includes("/")) {
    config.free = config.free.map(pid => {
      const pdef = DEFAULT_PROVIDERS.find(p => p.id === pid);
      if (pdef?.low) return `${pid}/${pdef.low}`;
      try {
        const prov = registry?.getProvider?.(pid);
        if (prov?.getModels) { const m = prov.getModels()[0]; if (m) return `${pid}/${m.id}`; }
      } catch (_) {}
      return `${pid}/default`;
    });
    config.paid = config.paid.map(pid => {
      const pdef = DEFAULT_PROVIDERS.find(p => p.id === pid);
      if (pdef?.low) return `${pid}/${pdef.low}`;
      try {
        const prov = registry?.getProvider?.(pid);
        if (prov?.getModels) { const m = prov.getModels()[0]; if (m) return `${pid}/${m.id}`; }
      } catch (_) {}
      return `${pid}/default`;
    });
    saveConfig();
  }
}

function pingAddress(addr) {
  try {
    execSync(`ping -c 1 -W 2 ${addr}`, { timeout: 3000, stdio: "ignore" });
    return "online";
  } catch { return "offline"; }
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

function resolveEntry(registry, entry) {
  if (!entry) return null;
  if (entry.includes("/")) {
    const [provider, ...rest] = entry.split("/");
    return registry.find(provider, rest.join("/"));
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
  const key = provider && id ? `${provider}/${id}` : null;
  const all = [...config.free, ...config.paid];
  if (key) { const idx = all.indexOf(key); if (idx >= 0) return idx; }
  const prov = provider || (typeof failedModel === "string" ? failedModel.split("/")[0] : null);
  if (prov) { const idx = all.findIndex(e => e === prov || e.startsWith(prov + "/")); if (idx >= 0) return idx; }
  return -1;
}

function showUsage(ctx) {
  ctx.ui.notify(
    `Penny-Pincher v${EXT_VERSION}\n` +
    `  /freemium-configure — Multi-screen configuration TUI\n` +
    `  /freemium-optimize  — AI-powered model order optimization\n` +
    `  /freemium-list      — Show current free → paid chains\n` +
    `  /freemium-status    — Alias for /freemium-list\n` +
    `  /freemium-reset     — Reset to factory defaults\n` +
    `  /set-router-gateway <IP> — Set gateway for network checks`,
    "info"
  );
}

// ── TUI helpers ──────────────────────────────────────────────
function keyTag(text) {
  return { text: `[${text}]`, style: KEY_STYLE };
}

function legend(theme, parts) {
  return theme.fg("dim", parts.map(p => {
    if (typeof p === "object" && p.text) return theme.style(p.text, p.style);
    return p;
  }).join(" "));
}

function renderHelpBar(theme, items) {
  return theme.fg("dim", items.map(i => {
    return `${theme.style(`[${i.key}]`, KEY_STYLE)} ${i.label || ""}`;
  }).join("  "));
}

function truncate(line, width) {
  return line.length > width ? line.slice(0, width) : line;
}

export default function (pi) {
  // ── /set-router-gateway ──────────────────────────────────────
  pi.registerCommand("set-router-gateway", {
    description: "Set the gateway IP for network-liveness checks (usage: /set-router-gateway <IP>)",
    handler: async (args, ctx) => {
      const ip = args.trim();
      if (!ip) { ctx.ui.notify(`Current gateway: ${config.gatewayIp} — usage: /set-router-gateway <IP>`, "info"); return; }
      config.gatewayIp = ip;
      saveConfig();
      const status = pingAddress(ip);
      ctx.ui.notify(`Gateway ${ip}: ${status}`, status === "online" ? "info" : "warning");
    },
  });

  // ── /freemium-optimize ────────────────────────────────────────
  pi.registerCommand("freemium-optimize", {
    description: "AI-powered model order optimization",
    handler: async (_args, ctx) => {
      migrateConfig(ctx.modelRegistry);
      const suggested = suggestOrder(config.free);
      const current = config.free.join(" → ");
      const proposed = suggested.join(" → ");
      if (current === proposed) { ctx.ui.notify("Already optimal! ✓", "info"); return; }
      const ok = await ctx.ui.confirm("Optimize free model order?", `Current:  ${current}\nProposed: ${proposed}\n\n(Paid unchanged)`);
      if (ok) { config.free = suggested; saveConfig(); ctx.ui.notify(`Applied: ${proposed}`, "info"); }
    },
  });

  // ── /freemium-reset ───────────────────────────────────────────
  pi.registerCommand("freemium-reset", {
    description: "Reset configuration to factory defaults",
    handler: async (_args, ctx) => {
      const ok = await ctx.ui.confirm("Reset Penny-Pincher?", "This will restore factory defaults and clear all metrics.");
      if (!ok) return;
      config.gatewayIp = "192.168.43.100";
      config.free = DEFAULT_PROVIDERS.map(p => `${p.id}/${p.low}`);
      config.paid = [];
      config.errorHandling = { networkTestOnFail: true, testAddress: "1.1.1.1" };
      config.metrics = { totalCostAvoided: 0, totalContextTokens: 0, totalMessagesRouted: 0, totalFreeRoutes: 0, totalPaidRoutes: 0, startDate: new Date().toISOString() };
      saveConfig();
      ctx.ui.notify("Penny-Pincher reset to factory defaults ✓", "info");
    },
  });

  // ── /freemium-configure — multi-screen TUI ─────────────────────
  pi.registerCommand("freemium-configure", {
    description: "Multi-screen configuration TUI",
    handler: async (_args, ctx) => {
      migrateConfig(ctx.modelRegistry);
      if (ctx.mode !== "tui") { ctx.ui.notify("Requires TUI mode", "error"); return; }

      let allModels = [];
      try {
        allModels = (ctx.modelRegistry.getAll?.() ?? [])
          .filter(m => m.provider && m.id)
          .sort((a, b) => {
            const pc = (a.provider || "").localeCompare(b.provider || "");
            if (pc !== 0) return pc;
            return (a.name || a.id).localeCompare(b.name || b.id);
          });
      } catch (_) { allModels = []; }

      // ── Main menu loop ─────────────────────────────────────
      let free = [...config.free];
      let paid = [...config.paid];
      let errorHandling = { ...config.errorHandling };
      let screen = "menu";
      let cursor = 0;
      let moveMode = false;
      let addCursor = 0;
      let addScrollTop = 0;
      let mainScrollTop = 0;
      let undoStack = [];
      let cachedWidth = undefined;
      let cachedLines = undefined;
      let editingAddress = false;
      let addressBuf = "";

      const MENU_ITEMS = [
        { id: "select", label: "Provider/Model Selection", desc: "Add, remove, and toggle models" },
        { id: "priority", label: "Model Priority", desc: "Arrange free → paid order" },
        { id: "optimize", label: "Optimize Model Routing Order", desc: "Auto-sort by capability" },
        { id: "error", label: "Error Handling", desc: "Network test & failover settings" },
        { id: "about", label: "About Penny Pincher", desc: `Version ${EXT_VERSION}, credits & links` },
      ];
      const VIEWPORT = 16;

      function getItems() {
        const result = [];
        for (let i = 0; i < free.length; i++) result.push({ entry: free[i], section: "free" });
        for (let i = 0; i < paid.length; i++) result.push({ entry: paid[i], section: "paid" });
        return result;
      }

      function clamp() {
        if (screen === "select") {
          if (allModels.length === 0) addCursor = 0;
          else addCursor = Math.max(0, Math.min(addCursor, allModels.length - 1));
        } else if (screen === "priority") {
          const count = free.length + paid.length;
          cursor = count === 0 ? 0 : Math.max(0, Math.min(cursor, count - 1));
        }
      }

      function jumpByLetter(ch) {
        const chl = ch.toLowerCase();
        if (screen === "select") {
          for (let i = addCursor + 1; i < allModels.length; i++) {
            const name = (allModels[i].name || allModels[i].id || "").toLowerCase();
            if (name.startsWith(chl)) { addCursor = i; return true; }
          }
          for (let i = 0; i <= addCursor; i++) {
            const name = (allModels[i].name || allModels[i].id || "").toLowerCase();
            if (name.startsWith(chl)) { addCursor = i; return true; }
          }
        } else if (screen === "priority") {
          const items = getItems();
          for (let i = cursor + 1; i < items.length; i++) {
            const entry = items[i].entry.toLowerCase();
            if (entry.startsWith(chl) || entry.split("/").pop().startsWith(chl)) { cursor = i; return true; }
          }
          for (let i = 0; i <= cursor; i++) {
            const entry = items[i].entry.toLowerCase();
            if (entry.startsWith(chl) || entry.split("/").pop().startsWith(chl)) { cursor = i; return true; }
          }
        }
      }

      function isLetterKey(data) { return data.length === 1 && /[a-zA-Z]/.test(data); }

      function renderMenu(width) {
        const lines = [];
        lines.push(theme.style("  Freemium Penny-Pincher", { fg: "accent", bold: true }));
        lines.push(theme.fg("dim", `  v${EXT_VERSION} — Multi-Screen Configuration`));
        lines.push("");
        for (let i = 0; i < MENU_ITEMS.length; i++) {
          const item = MENU_ITEMS[i];
          const prefix = i === cursor ? theme.fg("accent", " →") : "  ";
          lines.push(`${prefix} ${item.label}`);
        }
        lines.push("");
        lines.push(renderHelpBar(theme, [
          { key: "↑↓", label: "navigate" },
          { key: "Enter", label: "open" },
          { key: "q", label: "quit" },
        ]));
        return lines.map(l => truncate(l, width));
      }

      function renderSelect(width) {
        const lines = [];
        let cursorLine = -1;
        lines.push(theme.style("  Provider/Model Selection", { fg: "accent", bold: true }));
        lines.push("");
        lines.push(theme.fg("dim", `  Toggle models into your pool`));
        lines.push("");

        let currentProv = null;
        for (let idx = 0; idx < allModels.length; idx++) {
          const m = allModels[idx];
          if (m.provider !== currentProv) { currentProv = m.provider; lines.push(theme.fg("dim", `  ── ${currentProv} ──`)); }
          if (idx === addCursor) cursorLine = lines.length;
          const inFree = free.includes(`${m.provider}/${m.id}`);
          const inPaid = paid.includes(`${m.provider}/${m.id}`);
          const sel = idx === addCursor;
          const check = inFree ? theme.fg("success", "[F]") : inPaid ? theme.fg("warning", "[P]") : "[ ]";
          const prefix = sel ? theme.fg("accent", "> ") : "  ";
          const label = m.name ? `${m.provider}/${m.name}` : `${m.provider}/${m.id}`;
          const row = `  ${prefix}${check} ${label}`;
          lines.push(sel ? theme.fg("accent", row) : row);
        }
        if (allModels.length === 0) { lines.push(theme.fg("dim", "  No models available in registry")); }

        if (cursorLine >= 0) {
          if (cursorLine < addScrollTop) addScrollTop = cursorLine;
          if (cursorLine >= addScrollTop + VIEWPORT) addScrollTop = cursorLine - VIEWPORT + 1;
        }
        lines.push("");
        lines.push(renderHelpBar(theme, [
          { key: "↑↓", label: "browse" }, { key: "Space", label: "toggle" }, { key: "f", label: "to free" },
          { key: "p", label: "to paid" }, { key: "a-z", label: "jump" }, { key: "Esc", label: "back" },
        ]));

        const visible = lines.slice(addScrollTop, addScrollTop + VIEWPORT);
        return visible.map(l => truncate(l, width));
      }

      function renderPriority(width) {
        const lines = [];
        let cursorLine = -1;
        const items = getItems();

        lines.push(theme.style("  Model Priority", { fg: "accent", bold: true }));
        lines.push("");

        if (items.length === 0) {
          lines.push(theme.fg("dim", "  No models — add some in Provider/Model Selection first"));
          lines.push("");
          lines.push(renderHelpBar(theme, [{ key: "Esc", label: "back" }]));
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
            lines.push(moving ? theme.style(`  ${label}  [↑↓] move  [Space] done`, { fg: "accent", bold: true }) : `  ${label}`);
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
            lines.push(moving ? theme.style(`  ${label}  [↑↓] move  [Space] done`, { fg: "accent", bold: true }) : `  ${label}`);
          });
        }

        if (cursorLine >= 0) {
          if (cursorLine < mainScrollTop) mainScrollTop = cursorLine;
          if (cursorLine >= mainScrollTop + VIEWPORT) mainScrollTop = cursorLine - VIEWPORT + 1;
        }
        lines.push("");
        lines.push(renderHelpBar(theme, [
          { key: "↑↓", label: "browse" }, { key: "Space", label: "move" },
          { key: "f", label: "→ free" }, { key: "p", label: "→ paid" },
          { key: "d", label: "delete" }, { key: "Ctrl+Z", label: "undo" },
          { key: "Esc", label: "back" }, { key: "Enter", label: "save" },
        ]));

        const visible = lines.slice(mainScrollTop, mainScrollTop + VIEWPORT);
        return visible.map(l => truncate(l, width));
      }

      function renderErrorConfig(width) {
        const lines = [];
        lines.push(theme.style("  Error Handling", { fg: "accent", bold: true }));
        lines.push("");
        const onoff = errorHandling.networkTestOnFail ? theme.fg("success", "ON") : theme.fg("warning", "OFF");
        const addr = editingAddress ? `${errorHandling.testAddress}█` : errorHandling.testAddress;
        lines.push(`  Network test on failure: ${onoff}`);
        lines.push(`  Address to test:         ${addr}`);
        lines.push("");
        if (editingAddress) {
          lines.push(theme.fg("dim", "  Type the IP address, Enter to confirm"));
        }
        lines.push("");
        lines.push(renderHelpBar(theme, [
          { key: "↑↓", label: "navigate" }, { key: "Space", label: "toggle ON/OFF" },
          { key: "Enter", label: "edit address" }, { key: "Esc", label: "back" },
        ]));
        return lines.map(l => truncate(l, width));
      }

      function renderAbout(width) {
        const lines = [];
        lines.push(theme.style("  About Penny Pincher", { fg: "accent", bold: true }));
        lines.push("");
        lines.push(`  Version:    ${EXT_VERSION}`);
        lines.push(`  Author:     Daniel Keery`);
        lines.push(`  Email:      daniel@keery.dev`);
        lines.push(`  GitHub:     https://github.com/danielkeery/pi-kernel-router`);
        lines.push("");
        const m = config.metrics;
        const uptime = (Date.now() - new Date(m.startDate).getTime());
        const days = Math.floor(uptime / 86400000);
        const hrs = Math.floor((uptime % 86400000) / 3600000);
        lines.push(theme.style("  Lifetime Metrics", { fg: "accent", bold: true }));
        lines.push(`  Messages routed:   ${m.totalMessagesRouted}`);
        lines.push(`  Free routes:       ${m.totalFreeRoutes}`);
        lines.push(`  Paid routes:      ${m.totalPaidRoutes}`);
        lines.push(`  Cost avoided:     $${m.totalCostAvoided.toFixed(4)}`);
        lines.push(`  Context tokens:   ${m.totalContextTokens.toLocaleString()}`);
        lines.push(`  Since:           ${new Date(m.startDate).toLocaleDateString()} (${days}d ${hrs}h)`);
        lines.push("");
        lines.push(renderHelpBar(theme, [{ key: "Esc", label: "back" }]));
        return lines.map(l => truncate(l, width));
      }

      function render(width) {
        if (cachedLines && cachedWidth === width) return cachedLines;
        cachedWidth = width;
        if (screen === "menu") cachedLines = renderMenu(width);
        else if (screen === "select") cachedLines = renderSelect(width);
        else if (screen === "priority") cachedLines = renderPriority(width);
        else if (screen === "error") cachedLines = renderErrorConfig(width);
        else if (screen === "about") cachedLines = renderAbout(width);
        return cachedLines;
      }

      function invalidate() { cachedWidth = undefined; cachedLines = undefined; }

      function handleInput(data) {
        // ── Menu screen ──
        if (screen === "menu") {
          const isUp = keybindings.matches(data, "tui.select.up");
          const isDown = keybindings.matches(data, "tui.select.down");
          if (isUp && cursor > 0) { cursor--; invalidate(); tui.requestRender(); return; }
          if (isDown && cursor < MENU_ITEMS.length - 1) { cursor++; invalidate(); tui.requestRender(); return; }
          if (data === "\r" || data === "\n") {
            // Open selected menu
            const id = MENU_ITEMS[cursor].id;
            if (id === "select") { screen = "select"; addCursor = 0; addScrollTop = 0; invalidate(); tui.requestRender(); return; }
            if (id === "priority") { screen = "priority"; cursor = 0; mainScrollTop = 0; invalidate(); tui.requestRender(); return; }
            if (id === "optimize") {
              const suggested = suggestOrder(free);
              const current = free.join(" → ");
              const proposed = suggested.join(" → ");
              if (current !== proposed) { free = suggested; }
              screen = "menu"; invalidate(); tui.requestRender(); return;
            }
            if (id === "error") { screen = "error"; editingAddress = false; cursor = 0; invalidate(); tui.requestRender(); return; }
            if (id === "about") { screen = "about"; invalidate(); tui.requestRender(); return; }
          }
          if (data === "q" || data === "Q") { done(null); return; }
          return;
        }

        // ── Select screen ──
        if (screen === "select") {
          clamp();
          const isUp = keybindings.matches(data, "tui.select.up");
          const isDown = keybindings.matches(data, "tui.select.down");
          if (isUp && addCursor > 0) { addCursor--; invalidate(); tui.requestRender(); return; }
          if (isDown && addCursor < allModels.length - 1) { addCursor++; invalidate(); tui.requestRender(); return; }

          if (data === " " && allModels.length > 0) {
            const m = allModels[addCursor];
            if (m) {
              const key = `${m.provider}/${m.id}`;
              const fi = free.indexOf(key);
              const pi = paid.indexOf(key);
              if (fi >= 0) { free.splice(fi, 1); }
              else if (pi >= 0) { paid.splice(pi, 1); }
              else { free.push(key); }
            }
            invalidate(); tui.requestRender();
            return;
          }

          if (data === "f" || data === "F") {
            const m = allModels[addCursor];
            if (m) {
              const key = `${m.provider}/${m.id}`;
              const fi = free.indexOf(key);
              const pi = paid.indexOf(key);
              if (fi >= 0) { if (addCursor < allModels.length - 1) addCursor++; }
              else if (pi >= 0) { paid.splice(pi, 1); free.push(key); }
              else { free.push(key); }
            }
            invalidate(); tui.requestRender();
            return;
          }
          if (data === "p" || data === "P") {
            const m = allModels[addCursor];
            if (m) {
              const key = `${m.provider}/${m.id}`;
              const fi = free.indexOf(key);
              const pi = paid.indexOf(key);
              if (pi >= 0) { if (addCursor < allModels.length - 1) addCursor++; }
              else if (fi >= 0) { free.splice(fi, 1); paid.push(key); }
              else { paid.push(key); }
            }
            invalidate(); tui.requestRender();
            return;
          }

          if (keybindings.matches(data, "tui.select.cancel")) { screen = "menu"; cursor = 0; invalidate(); tui.requestRender(); return; }
          if (data === "\r" || data === "\n") { screen = "menu"; invalidate(); tui.requestRender(); return; }

          if (isLetterKey(data)) { jumpByLetter(data); invalidate(); tui.requestRender(); return; }

          // Page up/down
          if (data === "\f" || data === "\x1b[5~" || data === "[\x1b[5~") { addCursor = Math.max(0, addCursor - VIEWPORT); invalidate(); tui.requestRender(); return; }
          if (data === "\x1b[6~") { addCursor = Math.min(allModels.length - 1, addCursor + VIEWPORT); invalidate(); tui.requestRender(); return; }

          return;
        }

        // ── Priority screen ──
        if (screen === "priority") {
          const items = getItems();
          clamp();

          if (data === "\r" || data === "\n") { config.free = free; config.paid = paid; saveConfig(); done(null); return; }

          if (keybindings.matches(data, "tui.select.cancel")) { screen = "menu"; moveMode = false; invalidate(); tui.requestRender(); return; }

          if (data === " " && items.length > 0) { moveMode = !moveMode; invalidate(); tui.requestRender(); return; }

          const isUp = keybindings.matches(data, "tui.select.up");
          const isDown = keybindings.matches(data, "tui.select.down");

          if (isUp && cursor > 0) {
            if (moveMode) {
              const cur = items[cursor]; const tgt = items[cursor - 1];
              if (cur.section === tgt.section) {
                const arr = cur.section === "free" ? free : paid;
                const ci = arr.indexOf(cur.entry); const ti = arr.indexOf(tgt.entry);
                if (ci >= 0 && ti >= 0) { [arr[ci], arr[ti]] = [arr[ti], arr[ci]]; cursor--; }
              }
            } else { cursor--; }
            invalidate(); tui.requestRender(); return;
          }
          if (isDown && cursor < items.length - 1) {
            if (moveMode) {
              const cur = items[cursor]; const tgt = items[cursor + 1];
              if (cur.section === tgt.section) {
                const arr = cur.section === "free" ? free : paid;
                const ci = arr.indexOf(cur.entry); const ti = arr.indexOf(tgt.entry);
                if (ci >= 0 && ti >= 0) { [arr[ci], arr[ti]] = [arr[ti], arr[ci]]; cursor++; }
              }
            } else { cursor++; }
            invalidate(); tui.requestRender(); return;
          }

          if (data === "d" || data === "D") {
            if (cursor < items.length) {
              undoStack.push({ action: "delete", entry: items[cursor].entry, section: items[cursor].section });
              const entry = items[cursor].entry;
              const fi = free.indexOf(entry);
              if (fi >= 0) free.splice(fi, 1);
              const pi = paid.indexOf(entry);
              if (pi >= 0) paid.splice(pi, 1);
              moveMode = false;
              if (cursor >= items.length - 1 && cursor > 0) cursor--;
              invalidate(); tui.requestRender();
            }
            return;
          }

          // Ctrl+Z undo
          if (data === "\x1a") {
            const last = undoStack.pop();
            if (last) {
              if (last.action === "delete") {
                if (last.section === "free") free.push(last.entry);
                else paid.push(last.entry);
              }
              invalidate(); tui.requestRender();
            }
            return;
          }

          if (data === "f" || data === "F") {
            if (cursor < items.length) {
              const entry = items[cursor].entry;
              const pi = paid.indexOf(entry);
              if (pi >= 0) { paid.splice(pi, 1); free.push(entry); }
            }
            moveMode = false; invalidate(); tui.requestRender();
            return;
          }
          if (data === "p" || data === "P") {
            if (cursor < items.length) {
              const entry = items[cursor].entry;
              const fi = free.indexOf(entry);
              if (fi >= 0) { free.splice(fi, 1); paid.push(entry); }
            }
            moveMode = false; invalidate(); tui.requestRender();
            return;
          }

          if (isLetterKey(data)) { jumpByLetter(data); invalidate(); tui.requestRender(); return; }
          return;
        }

        // ── Error Handling screen ──
        if (screen === "error") {
          if (editingAddress) {
            if (data === "\r" || data === "\n") { editingAddress = false; config.errorHandling.testAddress = errorHandling.testAddress; saveConfig(); invalidate(); tui.requestRender(); return; }
            if (data === "\x1b" || keybindings.matches(data, "tui.select.cancel")) { editingAddress = false; invalidate(); tui.requestRender(); return; }
            if (data === "\x7f" || data === "\b") { errorHandling.testAddress = errorHandling.testAddress.slice(0, -1); invalidate(); tui.requestRender(); return; }
            if (data.length === 1 && (data >= "0" && data <= "9" || data === ".")) { errorHandling.testAddress += data; invalidate(); tui.requestRender(); return; }
            return;
          }

          if (data === " ") { errorHandling.networkTestOnFail = !errorHandling.networkTestOnFail; invalidate(); tui.requestRender(); return; }
          if (data === "\r" || data === "\n") { editingAddress = true; invalidate(); tui.requestRender(); return; }
          if (keybindings.matches(data, "tui.select.cancel")) { config.errorHandling = { ...errorHandling }; saveConfig(); screen = "menu"; invalidate(); tui.requestRender(); return; }
          return;
        }

        // ── About screen ──
        if (screen === "about") {
          if (data === "\x1b" || keybindings.matches(data, "tui.select.cancel") || data === "\r" || data === "\n") { screen = "menu"; invalidate(); tui.requestRender(); return; }
          return;
        }
      }

      return { render, invalidate, handleInput };
    },
  });

  // ── /freemium-list ───────────────────────────────────────────
  pi.registerCommand("freemium-list", {
    description: "Show current free and paid model chains",
    handler: async (_args, ctx) => {
      migrateConfig(ctx.modelRegistry);
      ctx.ui.notify(`Free:  ${config.free.join(" → ")}\nPaid:  ${config.paid.join(" → ")}`, "info");
    },
  });

  pi.registerCommand("freemium-status", {
    description: "Alias for /freemium-list",
    handler: async (_args, ctx) => {
      migrateConfig(ctx.modelRegistry);
      ctx.ui.notify(`Free:  ${config.free.join(" → ")}\nPaid:  ${config.paid.join(" → ")}`, "info");
    },
  });



}
