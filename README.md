# Pi Kernel Router — Free-First AI Model Router for Pi Agent

A [Pi Coding Agent](https://pi.dev) virtual model router that automatically routes requests across 7+ free AI providers with a configurable fallback chain to paid Radium models. Optimized for kernel reverse-engineering and embedded Linux development.

## Features

- **Free-first routing** — Tries Google Gemini → AMD TokenLab → Cline → Groq → Kilo → Xkiro → Requesty before touching paid models
- **Four-tier fallback chain** — Free models → Tycho ($0.10/$1.50) → Clarke ($0.75/$4.50) → Hal ($2.00/$10.00)
- **Network gateway detection** — Pings a configurable gateway IP on failure. Gateway unreachable = stay on same model (retry loop). Gateway reachable = real failure → escalate
- **Rate-limit handling** — 429/402/context-overflow detection routes around exhausted quotas
- **Continuation stickiness** — Tool follow-ups stay on the same model to preserve prompt cache
- **Configurable** — `/set-router-gateway <IP>` to set the network check target

## Files

| File | Purpose |
|------|---------|
| `optomizer.js` | Pi virtual model router extension |
| `settings.json` | Pi project settings template |

## Requirements

- [Pi Coding Agent](https://pi.dev) >= 0.86.0
- [pi-free](https://github.com/apmantza/pi-free) extension (for Cline, Kilo, AMD TokenLab, Xkiro, Requesty providers)
- API keys for desired free providers (see [pi-free docs](https://github.com/apmantza/pi-free))

## Setup

```bash
# 1. Clone and install pi-free
pi install npm:pi-free

# 2. Set free provider API keys
export GROQ_API_KEY="gsk_..."
export AMD_TOKENLAB_API_KEY="tl_..."
export CLINE_API_KEY="..."
export KILO_API_KEY="..."
export XKIRO_API_KEY="sk-xt-..."
export REQUESTY_API_KEY="..."

# 3. Add to your project's settings.json
```

### Project .pi/settings.json

```json
{
  "defaultModel": "radium/kernel-auto",
  "extensions": [".pi/extensions/optomizer.js"]
}
```

### Usage

Select the virtual model:

```text
/model radium/kernel-auto
```

Set the gateway for network-liveness checks:

```text
/set-router-gateway 192.168.43.100
```

Adjust thinking level to switch modes:

```text
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
