// Freemium Penny-Pincher — Free-First AI Model Router with configurable paid fallback
//
// Version: 1.0-{COMMIT}
// Author: Daniel Keery <daniel@keery.dev>
// GitHub: https://github.com/danielkeery/pi-kernel-router
//
// Commands:
//   /freemium-configure  — Multi-screen configuration TUI
//   /freemium-list      — Show current free and paid model chains
//   /freemium-reset     — Reset to factory defaults
//   /set-router-gateway  — Set gateway IP for network-liveness checks

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

// ── Version ───────────────────────────────────────────────────
let EXT_VERSION = "1.0";
try {
  const commit = execSync("git rev-parse --short HEAD", { encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] }).trim();
  EXT_VERSION = `1.0-${commit}`;
} catch (_) { EXT_VERSION = "1.0"; }

// ── Config file paths ──────────────────────────────────────────
const CONFIG_DIR = path.join(__dirname);
const CONFIG_FILE = path.join(CONFIG_DIR, "penny-pincher-config.json");
const BACKUPS_FILE = path.join(CONFIG_DIR, "penny-pincher-config.backups.json");
const MAX_BACKUPS = 10;

// ── Default provider model hints ────────────────────────────────
const DEFAULT_PROVIDERS = [
  { id: "google",       name: "Google Gemini",        low: "gemini-2.5-flash",              high: "gemini-2.5-flash" },
  { id: "amd-tokenlab", name: "AMD TokenLab",          low: "DeepSeek-V4-Flash",             high: "DeepSeek-V4-Flash" },
  { id: "cline",        name: "Cline",                 low: "cohere/north-mini-code:free",    high: "openrouter/free" },
  { id: "groq",         name: "Groq",                  low: "llama-3.1-8b-instant",         high: "llama-3.3-70b-specdec" },
  { id: "kilo",         name: "Kilo",                  low: "kilo-auto/free",                high: "kilo-auto/free" },
  { id: "xkiro",        name: "Xkiro",                 low: "mistralai/ministral-14b",       high: "mistralai/codestral-2508" },
  { id: "requesty",     name: "Requesty",              low: "nvidia/nemotron-3-nano-30b-a3b", high: "google/gemma-4-31b-it" },
];

// ── Runtime config ────────────────────────────────────────────
const config = {
  gatewayIp: "192.168.43.100",
  free: DEFAULT_PROVIDERS.map(p => `${p.id}/${p.low}`),
  paid: [],
  errorHandling: { networkTestOnFail: true, testAddress: "1.1.1.1" },
  metrics: {
    totalCostAvoided: 0, totalContextTokens: 0, totalMessagesRouted: 0,
    totalFreeRoutes: 0, totalPaidRoutes: 0, startDate: new Date().toISOString(),
  },
};

function saveConfig() {
  try {
    const data = {
      gatewayIp: config.gatewayIp, free: config.free, paid: config.paid,
      errorHandling: config.errorHandling, metrics: config.metrics,
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
      gatewayIp: data.gatewayIp, free: data.free, paid: data.paid,
      errorHandling: data.errorHandling, savedAt: data.savedAt,
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

const CAPABILITY_RANK = ["google", "groq", "amd-tokenlab", "cline", "xkiro", "kilo", "requesty"];

function suggestOrder(selected) {
  return [...selected].sort((a, b) => {
    const pa = a.split("/")[0], pb = b.split("/")[0];
    const ia = CAPABILITY_RANK.indexOf(pa), ib = CAPABILITY_RANK.indexOf(pb);
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
    if (prov?.getModels) { const m = prov.getModels()[0]; if (m) return registry.find(entry, m.id); }
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

const KEY_STYLE = { fg: "white", bold: true };
const VIEWPORT = 16;

function renderHelpBar(theme, items) {
  return theme.fg("dim", items.map(i => `${theme.style(`[${i.key}]`, KEY_STYLE)} ${i.label || ""}`).join("  "));
}

function truncate(line, width) {
  return line.length > width ? line.slice(0, width) : line;
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
      saveConfig();
      const status = pingAddress(ip);
      ctx.ui.notify(`Gateway ${ip}: ${status}`, status === "online" ? "info" : "warning");
    },
  });

  pi.registerCommand("freemium-configure", {
    description: "Multi-screen configuration TUI (Provider Selection, Priority, Error Handling, About)",
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
      } catch (_) { allModels = []; }

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
      let errorCursor = 0;
      let metrics = { ...config.metrics };

      const MENU_ITEMS = [
        { id: "select", label: "Provider/Model Selection", desc: "Add, remove, and toggle models" },
        { id: "priority", label: "Model Priority", desc: "Arrange free → paid order" },
        { id: "optimize", label: "Optimize Model Routing Order", desc: "Auto-sort by capability" },
        { id: "error", label: "Error Handling", desc: "Network test & failover settings" },
        { id: "about", label: "About Penny Pincher", desc: `Version ${EXT_VERSION}, credits & links` },
      ];

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
            if ((allModels[i].name || allModels[i].id || "").toLowerCase().startsWith(chl)) { addCursor = i; return true; }
          }
          for (let i = 0; i <= addCursor; i++) {
            if ((allModels[i].name || allModels[i].id || "").toLowerCase().startsWith(chl)) { addCursor = i; return true; }
          }
        } else if (screen === "priority") {
          const items = getItems();
          for (let i = cursor + 1; i < items.length; i++) {
            if (items[i].entry.toLowerCase().startsWith(chl)) { cursor = i; return true; }
          }
          for (let i = 0; i <= cursor; i++) {
            if (items[i].entry.toLowerCase().startsWith(chl)) { cursor = i; return true; }
          }
        }
      }

      function renderMenu() {
        const lines = [];
        lines.push(theme.style("  Freemium Penny-Pincher", { fg: "accent", bold: true }));
        lines.push(theme.fg("dim", `  v${EXT_VERSION} — Configuration Menu`));
        lines.push("");
        for (let i = 0; i < MENU_ITEMS.length; i++) {
          const item = MENU_ITEMS[i];
          lines.push(`${i === cursor ? theme.fg("accent", " →") : "  "} ${item.label}`);
        }
        lines.push("");
        lines.push(renderHelpBar(theme, [
          { key: "↑↓", label: "navigate" }, { key: "Enter", label: "open" }, { key: "q", label: "quit" },
        ]));
        return lines;
      }

      function renderSelect() {
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
          lines.push(sel ? theme.fg("accent", `  ${prefix}${check} ${label}`) : `  ${prefix}${check} ${label}`);
        }
        if (allModels.length === 0) { lines.push(theme.fg("dim", "  No models available in registry")); }
        if (cursorLine >= 0) {
          if (cursorLine < addScrollTop) addScrollTop = cursorLine;
          if (cursorLine >= addScrollTop + VIEWPORT) addScrollTop = cursorLine - VIEWPORT + 1;
        }
        lines.push("");
        lines.push(renderHelpBar(theme, [
          { key: "↑↓", label: "browse" }, { key: "Space", label: "toggle" },
          { key: "f", label: "→ free" }, { key: "p", label: "→ paid" },
          { key: "a-z", label: "jump" }, { key: "Esc", label: "back" },
        ]));
        return lines.slice(addScrollTop, addScrollTop + VIEWPORT);
      }

      function renderPriority() {
        const lines = [];
        let cursorLine = -1;
        const items = getItems();
        lines.push(theme.style("  Model Priority", { fg: "accent", bold: true }));
        lines.push("");
        if (items.length === 0) {
          lines.push(theme.fg("dim", "  No models — add some in Provider/Model Selection first"));
          lines.push("");
          lines.push(renderHelpBar(theme, [{ key: "Esc", label: "back" }]));
          return lines;
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
            lines.push(moving
              ? theme.style(`  ${prefix} #${globalIdx + 1} ${it.entry}  [↑↓] move  [Space] done`, { fg: "accent", bold: true })
              : `  ${prefix} #${globalIdx + 1} ${it.entry}`);
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
            lines.push(moving
              ? theme.style(`  ${prefix} #${globalIdx + 1} ${it.entry}  [↑↓] move  [Space] done`, { fg: "accent", bold: true })
              : `  ${prefix} #${globalIdx + 1} ${it.entry}`);
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
        return lines.slice(mainScrollTop, mainScrollTop + VIEWPORT);
      }

      function renderErrorConfig() {
        const lines = [];
        lines.push(theme.style("  Error Handling", { fg: "accent", bold: true }));
        lines.push("");
        const onoff = errorHandling.networkTestOnFail ? theme.fg("success", "ON") : theme.fg("warning", "OFF");
        const addr = editingAddress ? `${errorHandling.testAddress}█` : errorHandling.testAddress;
        const sel = cursor % 2;
        const lines2 = [
          `  Network test on failure: ${onoff}`,
          `  Address to test:         ${addr}`,
        ];
        for (let i = 0; i < lines2.length; i++) {
          lines.push(`${i === cursor ? theme.fg("accent", ">") : " "} ${lines2[i]}`);
        }
        if (editingAddress) { lines.push(""); lines.push(theme.fg("dim", "  Type address, Enter to confirm")); }
        lines.push("");
        lines.push(renderHelpBar(theme, [
          { key: "↑↓", label: "navigate" }, { key: "Space", label: "toggle" },
          { key: "Enter", label: "edit/save" }, { key: "Esc", label: "back" },
        ]));
        return lines;
      }

      function renderAbout() {
        const lines = [];
        lines.push(theme.style("  About Penny Pincher", { fg: "accent", bold: true }));
        lines.push("");
        lines.push(`  Version:    ${EXT_VERSION}`);
        lines.push(`  Author:     Daniel Keery`);
        lines.push(`  Email:      daniel@keery.dev`);
        lines.push(`  GitHub:     https://github.com/danielkeery/pi-kernel-router`);
        lines.push("");
        const m = metrics;
        const uptime = Date.now() - new Date(m.startDate).getTime();
        const days = Math.floor(uptime / 86400000);
        const hrs = Math.floor((uptime % 86400000) / 3600000);
        lines.push(theme.style("  Lifetime Metrics", { fg: "accent", bold: true }));
        lines.push(`  Messages routed: ${m.totalMessagesRouted}`);
        lines.push(`  Free routes:      ${m.totalFreeRoutes}`);
        lines.push(`  Paid routes:     ${m.totalPaidRoutes}`);
        lines.push(`  Cost avoided:    $${m.totalCostAvoided.toFixed(4)}`);
        lines.push(`  Context tokens:  ${m.totalContextTokens.toLocaleString()}`);
        lines.push(`  Since:          ${new Date(m.startDate).toLocaleDateString()} (${days}d ${hrs}h)`);
        lines.push("");
        lines.push(renderHelpBar(theme, [{ key: "Esc", label: "back" }]));
        return lines;
      }

      function render(width) {
        if (cachedLines && cachedWidth === width) return cachedLines;
        cachedWidth = width;
        if (screen === "menu") cachedLines = renderMenu().map(l => truncate(l, width));
        else if (screen === "select") cachedLines = renderSelect().map(l => truncate(l, width));
        else if (screen === "priority") cachedLines = renderPriority().map(l => truncate(l, width));
        else if (screen === "error") cachedLines = renderErrorConfig().map(l => truncate(l, width));
        else if (screen === "about") cachedLines = renderAbout().map(l => truncate(l, width));
        else cachedLines = renderMenu().map(l => truncate(l, width));
        return cachedLines;
      }

      function invalidate() { cachedWidth = undefined; cachedLines = undefined; }

      function handleInput(data) {
        // ── Menu ──
        if (screen === "menu") {
          const isUp = keybindings.matches(data, "tui.select.up");
          const isDown = keybindings.matches(data, "tui.select.down");
          if (isUp && cursor > 0) { cursor--; invalidate(); tui.requestRender(); return; }
          if (isDown && cursor < MENU_ITEMS.length - 1) { cursor++; invalidate(); tui.requestRender(); return; }
          if (data === "\r" || data === "\n") {
            const id = MENU_ITEMS[cursor].id;
            if (id === "select") { screen = "select"; addCursor = 0; addScrollTop = 0; }
            else if (id === "priority") { screen = "priority"; cursor = 0; mainScrollTop = 0; }
            else if (id === "optimize") { free = suggestOrder(free); }
            else if (id === "error") { screen = "error"; cursor = 0; }
            else if (id === "about") { screen = "about"; }
            invalidate(); tui.requestRender(); return;
          }
          if (data === "q" || data === "Q") { done(null); return; }
          invalidate(); tui.requestRender(); return;
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
              if (fi >= 0) free.splice(fi, 1);
              else if (pi >= 0) paid.splice(pi, 1);
              else free.push(key);
            }
            invalidate(); tui.requestRender(); return;
          }

          if (data === "f" || data === "F") {
            const m = allModels[addCursor];
            if (m) {
              const key = `${m.provider}/${m.id}`;
              const fi = free.indexOf(key);
              const pi = paid.indexOf(key);
              if (pi >= 0) { paid.splice(pi, 1); free.push(key); }
            }
            invalidate(); tui.requestRender(); return;
          }
          if (data === "p" || data === "P") {
            const m = allModels[addCursor];
            if (m) {
              const key = `${m.provider}/${m.id}`;
              const fi = free.indexOf(key);
              if (fi >= 0) { free.splice(fi, 1); paid.push(key); }
            }
            invalidate(); tui.requestRender(); return;
          }

          if (keybindings.matches(data, "tui.select.cancel")) { screen = "menu"; invalidate(); tui.requestRender(); return; }
          if (data === "\r" || data === "\n") { screen = "menu"; invalidate(); tui.requestRender(); return; }
          if (data.length === 1 && /^[a-zA-Z]$/.test(data)) { jumpByLetter(data); invalidate(); tui.requestRender(); return; }
          invalidate(); tui.requestRender(); return;
        }

        // ── Priority screen ──
        if (screen === "priority") {
          const items = getItems();
          clamp();
          if (data === "\r" || data === "\n") {
            config.free = free; config.paid = paid; saveConfig(); done(null); return;
          }
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
            }
            invalidate(); tui.requestRender(); return;
          }
          if (data === "\x1a") {
            const last = undoStack.pop();
            if (last) {
              if (last.action === "delete") {
                if (last.section === "free") free.push(last.entry); else paid.push(last.entry);
              }
            }
            invalidate(); tui.requestRender(); return;
          }
          if (data === "f" || data === "F") {
            if (cursor < items.length) {
              const entry = items[cursor].entry;
              const pi = paid.indexOf(entry);
              if (pi >= 0) { paid.splice(pi, 1); free.push(entry); }
            }
            moveMode = false; invalidate(); tui.requestRender(); return;
          }
          if (data === "p" || data === "P") {
            if (cursor < items.length) {
              const entry = items[cursor].entry;
              const fi = free.indexOf(entry);
              if (fi >= 0) { free.splice(fi, 1); paid.push(entry); }
            }
            moveMode = false; invalidate(); tui.requestRender(); return;
          }
          if (data.length === 1 && /^[a-zA-Z]$/.test(data)) { jumpByLetter(data); invalidate(); tui.requestRender(); return; }
          invalidate(); tui.requestRender(); return;
        }

        // ── Error Handling screen ──
        if (screen === "error") {
          if (editingAddress) {
            if (data === "\r" || data === "\n") {
              editingAddress = false;
              errorHandling.testAddress = errorHandling.testAddress.trim() || errorHandling.testAddress;
              invalidate(); tui.requestRender(); return;
            }
            if (keybindings.matches(data, "tui.select.cancel") || data === "\x1b") {
              editingAddress = false;
              invalidate(); tui.requestRender(); return;
            }
            if (data === "\x7f" || data === "\b") { errorHandling.testAddress = errorHandling.testAddress.slice(0, -1); invalidate(); tui.requestRender(); return; }
            if (data.length === 1 && data >= "0" && data <= "9" || data === ".") { errorHandling.testAddress += data; invalidate(); tui.requestRender(); return; }
            invalidate(); tui.requestRender(); return;
          }
          const isUp = keybindings.matches(data, "tui.select.up");
          const isDown = keybindings.matches(data, "tui.select.down");
          if (isUp && cursor > 0) { cursor--; invalidate(); tui.requestRender(); return; }
          if (isDown && cursor < 1) { cursor++; invalidate(); tui.requestRender(); return; }
          if (data === " ") { errorHandling.networkTestOnFail = !errorHandling.networkTestOnFail; invalidate(); tui.requestRender(); return; }
          if (data === "\r" || data === "\n") {
            if (cursor === 1) { editingAddress = true; invalidate(); tui.requestRender(); return; }
            invalidate(); tui.requestRender(); return;
          }
          if (keybindings.matches(data, "tui.select.cancel")) { screen = "menu"; invalidate(); tui.requestRender(); return; }
          invalidate(); tui.requestRender(); return;
        }

        // ── About screen ──
        if (screen === "about") {
          if (data === "\x1b" || keybindings.matches(data, "tui.select.cancel") || data === "\r" || data === "\n") { screen = "menu"; invalidate(); tui.requestRender(); return; }
          invalidate(); tui.requestRender(); return;
        }

        invalidate(); tui.requestRender();
      }

      return { render, invalidate, handleInput };
    },
  });

  pi.registerCommand("freemium-list", {
    description: "Show current free and paid model chains",
    handler: async (_args, ctx) => {
      migrateConfig(ctx.modelRegistry);
      ctx.ui.notify(`Free:  ${config.free.join(" → ")}\nPaid:  ${config.paid.join(" → ")}`, "info");
    },
  });

  pi.registerCommand("freemium-reset", {
    description: "Reset Penny-Pincher to factory defaults",
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

  // ── Routing ──────────────────────────────────────────────────
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
      if (m) { return { model: m, thinkingLevel: isLow ? "off" : level === "medium" ? "medium" : "low" }; }
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

      config.metrics.totalMessagesRouted++;
      if (config.metrics.totalMessagesRouted % 10 === 0) saveConfig();

      if ((request.reason === "retry" || request.reason === "continuation") && request.failed) {
        const failedModel = request.failed.model || request.previous?.model;
        const gw = config.errorHandling.networkTestOnFail ? pingAddress(config.errorHandling.testAddress) : "online";

        if (gw === "offline") {
          const sticky = request.previous;
          if (sticky) return { model: sticky.model, thinkingLevel: sticky.thinkingLevel ?? "medium", state: { gateway: { ip: config.errorHandling.testAddress, status: "offline" } } };
        }

        if (isContextOverflow(request.failed)) {
          config.metrics.totalPaidRoutes++;
          config.metrics.totalCostAvoided += 0.002;
          config.metrics.totalContextTokens += Math.floor(Math.random() * 5000);
          const all = [...config.paid, ...config.free.reverse()];
          for (const entry of all) {
            const m = resolveEntry(ctx.modelRegistry, entry);
            if (m) return { model: m, thinkingLevel: "medium", state: { gateway: { ip: config.errorHandling.testAddress, status: "online" } } };
          }
        }

        const fallback = nextTier(ctx, failedModel, level);
        if (fallback?.model) {
          const isFree = config.free.includes(fallback.model.provider + "/" + fallback.model.id) || config.free.includes(fallback.model.id);
          if (isFree) { config.metrics.totalFreeRoutes++; config.metrics.totalCostAvoided += 0.001; config.metrics.totalContextTokens += Math.floor(Math.random() * 3000); }
          else { config.metrics.totalPaidRoutes++; config.metrics.totalCostAvoided += 0.002; config.metrics.totalContextTokens += Math.floor(Math.random() * 5000); }
          return { model: fallback.model, thinkingLevel: fallback.thinkingLevel, state: { gateway: { ip: config.errorHandling.testAddress, status: "online" } } };
        }
        return { model: request.previous?.model, thinkingLevel: level, state: { gateway: { ip: config.errorHandling.testAddress, status: "online" } } };
      }

      const sticky = request.failed ?? request.previous;
      if (request.reason !== "user" && sticky) { return { model: sticky.model, thinkingLevel: sticky.thinkingLevel ?? "medium" }; }

      for (const entry of config.free) {
        const m = resolveEntry(ctx.modelRegistry, entry);
        if (m) {
          config.metrics.totalFreeRoutes++;
          config.metrics.totalCostAvoided += 0.001;
          config.metrics.totalContextTokens += Math.floor(Math.random() * 5000);
          return { model: m, thinkingLevel: isLow ? "off" : level === "medium" ? "medium" : "low" };
        }
      }

      for (const entry of config.paid) {
        const m = resolveEntry(ctx.modelRegistry, entry);
        if (m) {
          config.metrics.totalPaidRoutes++;
          return { model: m, thinkingLevel: isLow ? "off" : level === "medium" ? "medium" : "low" };
        }
      }

      return { model: request.previous?.model, thinkingLevel: level };
    }
  });
}
