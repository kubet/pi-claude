# pi-claude

Run [Claude Code](https://code.claude.com) as a model provider inside [pi](https://github.com/badlogic/pi-mono) (and [omp](https://github.com/can1357/oh-my-pi)).

You pick `claude-code/sonnet` in pi. Claude Code becomes the engine; pi keeps everything that makes it pi: its tools (bash, read, edit, write, …), its session log, its extensions. Every tool call Claude Code makes is executed by pi, through pi's own tool implementations — Claude Code never touches your files itself.

This is the same bridge opencode ships as its Claude Agent provider, mapped onto pi's provider contract instead of the AI SDK's.

## Install

**pi**

```bash
pi install git:github.com/kubet/pi-claude
```

**omp**

```bash
omp plugin install git+ssh://git@github.com/kubet/pi-claude.git
```

From a local checkout: `pi -e ./pi-claude/src/index.ts`.

Requires a working `claude` CLI on your `PATH` (`claude --version`), authenticated however you already use it — subscription or API key. Nothing else; no API keys to configure.

## Use

```
pi --model claude-code/sonnet        # or /model claude-code/opus in the TUI
```

Models are aliases resolved by your local Claude Code: `default`, `sonnet`, `opus`, `haiku`. Thinking levels map to Claude Code effort: `--thinking high` → effort `high`, `xhigh`/`max` included.

## What happens

pi's provider contract is stateless per model call; Claude Code's agent loop is not. The bridge reconciles the two:

1. **One Claude Code process per conversation**, spawned through the claude-agent-sdk and kept alive across pi turns. User messages stream in; assistant messages stream out.
2. **pi's tools ride an in-process MCP server.** Claude Code's own tools are disabled; it sees pi's tools as `mcp__pi__read`, `mcp__pi__bash`, … and calls them like any MCP tool.
3. **Tool calls park.** The MCP `tools/call` parks unanswered; the provider emits a pi tool-call event and ends the turn. pi executes the tool — session log, extensions, everything — and the next model call resolves the parked MCP call from pi's tool result. Claude Code never notices.
4. **Divergence respawns.** Compaction, forks, or a changed system prompt break the replay; the bridge respawns Claude Code and replays the transcript as a rendered restore message.
5. **Subagents isolate.** Bridge selection prefix-matches the hashed user-message history, so parallel pi sessions and subagents each drive their own Claude Code process (up to 6, LRU).

Claude Code features that duplicate pi's are turned off (opencode parity): its CLAUDE.md/memory loading, auto-compaction, skills, and hooks; `dontAsk` permissions (pi already gates tools); effort env overrides. `ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` pass through if you set them.

## Configuration

| Env | Effect |
| --- | --- |
| `PI_CLAUDE_EXECUTABLE` | Path to the claude binary (default: first `claude` on `PATH`) |

## Costs

Turns ride your Claude Code subscription, so pi records zero catalog cost. Token usage is recorded per assistant message.

## Development

```bash
bun install
bun run check        # tsc --noEmit
bun test test/unit   # conversion + bridge orchestration (no claude needed)
PI_CLAUDE_E2E=1 bun test test/e2e   # real pi + real claude
```

The unit suite drives the bridge through a scripted query factory — no claude, no network. The e2e suite spawns the real pi CLI with the extension in scratch projects and asserts on observable outcomes: answers, files written through pi tools, multi-tool turns, memory across the parked-tool boundary, and recorded usage.

Design credit: the parked-MCP bridge, isolation env, and hook pairing mirror the claude-agent provider in [opencode](https://github.com/anomalyco/opencode); bugs are mine.
