# 🐾 meowsmith

[![npm](https://img.shields.io/npm/v/meowsmith)](https://www.npmjs.com/package/meowsmith)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**A cat that reviews your English while your [pi](https://pi.dev) agent works.**

meowsmith is a pi coding-agent extension for non-native English speakers. Every time you
submit a prompt, a little ASCII cat quietly checks your writing — grammar, awkward
phrasing, word choice — and reports back in a speech bubble above your editor. Your
prompt passes through **untouched and undelayed**; the cat works in parallel.

```text
          ╭─ 🐾 meowsmith · a native would say ──────────────────────╮
 /\_/\    │ Is there an extension that reviews my English while      │
( o.o )   │ still handling my task?                                  │
 > ^ < -  │   • article needed: a extension → of an extension        │
          ╰──────────────────────────────────────────────────────────╯
```

While your task runs, the cat helps out too — patting the bubble with alternating
paws, winking, and wagging its tail. When the task finishes, it stops and falls
asleep holding your feedback:

```text
 /\_/\       /\_/\       /\_/\        (sleeping when done)
( o.o )     ( -.o )     ( o.o )      /\_/\
 > ^ < /     > w < \     >/  < -     ( -.- ) zZ
   patting    meow!       wagging     > ^ < ~
```

## How it works

1. You submit a prompt → the real task starts **immediately** (zero added latency).
2. In parallel, a second, cheap LLM call analyzes your prompt text.
3. If there is anything worth fixing, the cat shows it in a widget above your editor:
   - **Grammar fixes** — `before → after` with a short reason
   - **Word-choice upgrades** — correct but unnatural → what a native speaker would pick
   - **A full native rewrite** — when your phrasing sounds translated
4. If your prompt is already fine, the cat stays **silent**. No nagging.

The checker replies with compact JSON; non-JSON output is gracefully treated as a
plain correction, so it works robustly across models.

## Install

**From npm** (also listed in the [pi package gallery](https://pi.dev/packages)):

```bash
pi install npm:meowsmith
```

**From git:**

```bash
pi install git:github.com/literaryno4/meowsmith
# or pin a version:
pi install git:github.com/literaryno4/meowsmith@v1.0.0
```

### Manually

Copy the extension folder into pi's extensions directory:

```bash
git clone https://github.com/literaryno4/meowsmith
mkdir -p ~/.pi/agent/extensions
cp -r meowsmith/extensions/meowsmith ~/.pi/agent/extensions/
```

Then restart pi (or run `/reload`). That's it — no dependencies to install; pi
bundles everything the extension needs.

## Commands

| Command | What it does |
|---|---|
| `/meowsmith` | toggle the cat on/off |
| `/meowsmith-style` | pick a visual style: `cat` (default), `minimal`, `card`, `box`, `diff` |
| `/meowsmith-debug` | toggle per-prompt diagnostics (see *why* the cat stayed quiet) |

## Configuration

**Environment variables:**

```bash
# pin a cheap, fast checker model instead of using your session model
export PI_MEOWSMITH_MODEL="anthropic/claude-haiku-4-5"

# default style if nothing is saved yet
export PI_MEOWSMITH_STYLE="cat"

# optional thinking-effort override for the checker call only (never affects
# the real task). Useful on always-thinking models where "low" is much faster.
export PI_MEOWSMITH_REASONING="low"
```

Your chosen style is persisted to `~/.pi/meowsmith.json`.

**Checker model:** by default meowsmith reuses your current session model. Any model
your pi setup can authenticate with works — a small fast model (Haiku-class) is plenty,
since the checker only sees your prompt text and returns compact JSON.

**Progressive display:** feedback streams into the cat bubble as it arrives —
the polished sentence types out live, and the full feedback frame appears when
the coach finishes. The real task is never waited on; the stream is consumed
in the background exactly like the old one-shot call.

## Privacy

Your prompt text is sent to the LLM provider you have already configured in pi for
the writing check. Nothing else is collected, and no code or files are sent — only
the prompt text itself. Use `PI_MEOWSMITH_MODEL` if you want the check to go to a
different (e.g. local) provider than your main session.

## Smart filtering

The cat doesn't check everything — prompts are skipped when they:

- start with `/` (a command) or `!` (a shell command)
- are very short (< 12 chars), very long (> 4000 chars), or mostly code/symbols
- contain fewer than 4 letter words

Everything else gets checked — fire-and-forget, never blocking your real task.

## Why "meowsmith"?

It started as a grammar checker, then grew a cat, a wagging tail, and a sleep pose.
A wordsmith that says meow. 🐾

## License

[MIT](LICENSE) © literaryno4 · also on [npm](https://www.npmjs.com/package/meowsmith)
