# Pi Penny-Pincher — Free-First AI Model Router for Pi Agent

A [Pi Coding Agent](https://pi.dev) virtual model router that auto-registers the **freemium** provider (Radium API) and routes requests across 7 free AI providers with a configurable fallback chain.

**Model: `freemium/penny-pincher`**

## Features

- **Free-first routing** — Google Gemini → AMD TokenLab → Cline → Groq → Kilo → Xkiro → Requesty before touching paid models
- **Self-registering provider** — Registers the `freemium` provider on install, no manual models.json edits needed
- **Four-tier fallback chain** — Free models → Tycho ($0.10/$1.50) → Clarke ($0.75/$4.50) → Hal ($2.00/$10.00)
- **Network gateway detection** — Pings a configurable gateway IP on failure. Gateway unreachable = stay on same model (retry loop). Gateway reachable = real failure → escalate
- **Rate-limit handling** — 429/402/context-overflow detection routes around exhausted quotas
- **Continuation stickiness** — Tool follow-ups stay on the same model to preserve prompt cache
- **Configurable** — `/set-router-gateway <IP>` to set the network check target

## Files

| File | Purpose |
|------|---------|
| `penny-pincher.js` | Pi virtual model router extension |
| `settings.json` | Pi project settings template |

## Setup

```bash
# 1. Set your freemium/Radium API key
export FREEMIUM_API_KEY="sk_..."

# 2. Add to your project's .pi/settings.json:
```

### Project .pi/settings.json

```json
{
  "defaultModel": "freemium/penny-pincher",
  "extensions": [".pi/extensions/penny-pincher.js"]
}
```

### Usage

```text
/model freemium/penny-pincher
/set-router-gateway 192.168.43.100
/thinking low    # → Fast free model → Tycho for build tasks
/thinking medium # → Balanced free → Clarke for coding
/thinking high   # → Best free → Hal for RE analysis
```

## Fallback Chain

```
User message → Free models (google → amd-tokenlab → cline → groq → kilo → xkiro → requesty)
                                      ↓ all exhausted
                                ╔══════════════════╗
                                ║  Ping gateway?    ║
                                ╠══════════════════╣
                                ║ OFFLINE → retry   ║
                                ║ ONLINE  → fall    ║
                                ╚══════════════════╝
                                      ↓
                                Tycho ($0.10/M)
                                      ↓
                                Clarke ($0.75/M)
                                      ↓
                                Hal ($2.00/M)
```

## License

MIT
