<h1 align="center">Airbot</h1>

<p align="center">
  <b>Self-evolving skills for your coding agent.</b><br>
  Your agent auto-creates and auto-improves its own skills as it works — no command, no trigger, no babysitting.
</p>

<p align="center">
  <a href="#-install-in-one-line"><img alt="install" src="https://img.shields.io/badge/install-one%20line-ff4d4d"></a>
  <img alt="node" src="https://img.shields.io/badge/node-%E2%89%A520-2ec27e">
  <img alt="deps" src="https://img.shields.io/badge/runtime%20deps-1-22b8cf">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-9b5de5">
</p>

---

## Why

Every coding agent starts every task from zero. It solves the same gnarly migration, re-derives the same release flow, re-learns the same repo quirk — and forgets it the moment the session ends.

**Airbot makes the forgetting stop.** It hooks into your agent so that, after real work, the agent reflects on what it just did and crystallizes the reusable parts into a **skill** — or improves a skill it already has. Over days, your agent gets measurably better at *your* codebase. That's a self-evolving agent, and it takes one line to turn on.

Inspired by the [Hermes Agent](https://github.com/NousResearch/hermes-agent) self-improvement loop, adapted to run on the hooks that Claude Code, Codex, and other agents already expose.

## ⚡ Install

**Requirement:** Node.js ≥ 20 (the CLI is a Node program). Check with `node -v`.

### Recommended — one line, works on any machine

```bash
npm i -g skillmaxxing && skillmaxxing plugin install
```

Installs the CLI globally and wires the hooks to it. Restart your agent session and you're done — **you never have to invoke anything.** Fast, persistent, and works on every laptop.

### No global install (npx)

```bash
npx skillmaxxing plugin install
```

Works without installing anything globally; the hooks fall back to a version-pinned `npx` call. Great for trying it out — for daily use prefer the global install (the `npx` hook adds a little latency at each turn-end).

### Claude Code marketplace (alternative)

```text
/plugin marketplace add Bennyoooo/Airbot
/plugin install skillmaxxing
```

### Codex / other agents

```bash
npm i -g skillmaxxing && skillmaxxing plugin install --agent codex
```

Codex has no programmatic stop hook, so self-evolution runs **in-session** via standing guidance written to `AGENTS.md`. Claude Code gets the full background loop below.

> **Pick one mechanism per agent.** For Claude Code, use either the marketplace plugin **or** `plugin install` — not both, or you'll get duplicate hooks.

Manage it any time:

```bash
skillmaxxing plugin status      # is it active?
skillmaxxing plugin uninstall   # remove the hooks
```

## 🧠 How it works

Airbot installs just two hooks. You do nothing — the loop runs itself.

```
┌──────────────────────────────────────────────────────────────┐
│  SessionStart   →  inject standing guidance                    │
│                    "crystallize reusable work; fix stale skills"│
│                                                                │
│  Stop (task done) → count tool calls in the transcript; if     │
│                     enough new work accrued, fork a background  │
│                     reflector: review the session and, if       │
│                     warranted, create ONE new skill or improve  │
│                     an existing one — autonomously, trusted:false│
└──────────────────────────────────────────────────────────────┘
```

There's no per-tool hook — work is counted from the session transcript at Stop — so the agent stays fast on every install path. This mirrors Hermes' layers:

| Hermes | Airbot |
|--------|--------------|
| Always-on system-prompt nudge | **SessionStart** hook injects skill-creation guidance |
| Background review after N iterations | **Stop** hook counts transcript tool calls and forks a headless reflector past a threshold |
| Provenance-gated curation | New/changed skills are recorded **`trusted: false`** until you approve them |

Two key Hermes ideas carry straight over: the reflector **prefers updating an existing skill over creating a near-duplicate**, and it is **conservative** — most sessions produce no skill at all.

### Two modes

| Mode | What happens on a substantial session | Pick it when |
|------|----------------------------------------|--------------|
| `auto` *(default)* | A **background** agent (`claude -p`, restricted to skill tools) reflects and writes/updates a skill while you keep working | You want truly hands-off self-evolution |
| `nudge` | The agent is reminded to crystallize the workflow itself, in-session | You want zero extra processes / full visibility |

```bash
npx skillmaxxing plugin install --mode nudge --threshold 12
```

The background reflector is **recursion-guarded** (it can never trigger itself) and **detached** (it never blocks your session). Every skill it writes is `trusted: false` and never auto-executes until you grant trust.

## 🔧 The two superpowers

Everything above is built on two CLI primitives the reflector (or you) can call directly. The CLI is **model-agnostic** — it does the deterministic work; your agent supplies the reasoning.

**Create** — turn a workflow into a tested skill:

```bash
skillmaxxing skillify --draft draft.json    # stage → smoke-test → review → --commit
```

**Improve** — make an existing skill measurably better, safely:

```bash
skillmaxxing optimize <score|apply|gate|promote|revert>
```

`optimize` is an **eval-gated** loop (rollout → reflect → bounded edit → validate): a candidate is promoted only on a strict score win with no regression, every version is retained, and any change is reversible.

## 🛟 Trust & safety

- **Untrusted by default.** Auto-created and improved skills are `trusted: false`; the sandbox refuses to run their code without your explicit `--allow-exec`.
- **Reversible.** Promotions are atomic and every prior version is retained — revert any time.
- **No surprise execution.** The background reflector writes skills; it does not run untrusted code or touch your project source.

## 📊 Privacy & telemetry

skillmaxxing collects **anonymous, aggregate** usage to know what to improve. You're asked once on first run (and can change your mind any time):

```bash
skillmaxxing telemetry status   # see what's on and where the config lives
skillmaxxing telemetry off      # opt out
skillmaxxing telemetry on       # opt back in
```

- **Collected:** a random install ID, version, OS, which agent, command names, and counts of skill create/optimize/promote/revert and error *types*.
- **Never collected:** your code, file paths, prompts, skill contents, or anything personal.
- **Always respected:** `DO_NOT_TRACK=1`, `CI`, and `SKILLMAX_TELEMETRY=off` disable it with no config needed. Nothing is sent from the background reflector's own CLI calls.

skillmaxxing also checks npm for a newer version at most once a day and prints a one-line update notice (it never self-updates). Disable with `SKILLMAX_NO_UPDATE_CHECK=1`.

## 🗺️ Roadmap

| Capability | Status |
|------------|--------|
| Auto-create skills (hook-driven) | ✅ v1 |
| Auto-improve skills (eval-gated) | ✅ v1 |
| Cross-agent install (Claude Code, Codex) | ✅ v1 |
| Discover skills from public sources | 🧰 CLI ready — landing in the plugin next |
| Team workspace: share + collaboratively optimize | 🧰 CLI ready — landing in the plugin next |

Discovery and team sharing already exist as CLI commands (`skillmaxxing discover`, `skillmaxxing workspace`); they're intentionally held out of the v1 plugin surface to keep the install dead-simple.

## 🛠️ Develop

```bash
npm install
npm run build      # tsc -> dist/
npm test           # node:test, 116 tests
node scripts/gen-hero.mjs   # regenerate the hero
```

Zero runtime dependencies beyond `yaml`. ESM, Node ≥ 20.

## License

MIT
