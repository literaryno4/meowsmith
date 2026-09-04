/**
 * meowsmith — English writing feedback for non-native speakers.
 *
 * Every time you submit a prompt, this extension asynchronously runs a quick
 * LLM check on your text (in parallel — it never delays the real task) and, if
 * there is anything to improve, shows it in a widget above the editor while
 * the agent works:
 *
 *   - grammar fixes (before → after with a short reason)
 *   - word-choice upgrades (blander/misused words → more natural choices)
 *   - a full "native rewrite" when the phrasing sounds translated
 *
 * Commands:
 *   /meowsmith         toggle on/off
 *   /meowsmith-style   pick a visual style (cat | minimal | card | box | diff)
 *   /meowsmith-debug   toggle debug notifications (why a prompt was skipped)
 *
 * Environment overrides:
 *   PI_MEOWSMITH_MODEL  checker model as "provider/model-id"
 *                     (defaults to your current session model)
 *   PI_MEOWSMITH_STYLE  default style if no saved choice exists
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { uuidv7 } from "@earendil-works/pi-ai";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	type Feedback,
	type Style,
	RENDERERS,
	STYLES,
	isQuiet,
	parseFeedback,
	renderCatChecking,
	renderCatFrame,
} from "./styles.ts";

const WIDGET_ID = "meowsmith";
const CONFIG_FILE = join(
	process.env.PI_CONFIG_DIR ?? join(process.env.HOME ?? "", ".pi"),
	"meowsmith.json",
);

const COACH_SYSTEM = `You are an English writing coach helping a non-native English speaker who is typing prompts to a coding assistant.

Analyze ONLY the user's prompt text for grammar mistakes, awkward or unclear phrasing, and word choices a native speaker would phrase differently. Ignore code, file paths, commands, and technical terms.

Reply with ONLY compact JSON (no markdown fences, no commentary):
{"corrected":"...","issues":[{"before":"...","after":"...","why":"..."}],"upgrades":[{"from":"...","to":"..."}],"native":"..."}

- "corrected": the full corrected version (grammar and clarity). Same meaning; do NOT answer the prompt. "" if no grammar or clarity problems.
- "issues": the 1-3 most important grammar/clarity fixes. "before" = short original fragment (a few words), "after" = fixed fragment, "why" = 2-6 words (e.g. "article needed", "subject-verb agreement").
- "upgrades": 1-3 words or short phrases that are correct but not what a native speaker would naturally choose here (e.g. "make a test" -> "run a test", "I want that you fix" -> "I'd like you to fix"). Only include when clearly more natural; "from" = original fragment, "to" = natural replacement. [] if none.
- "native": if the overall phrasing sounds translated or unnatural, a full rewrite of the whole prompt the way a native English-speaking developer would actually ask for this. Same meaning, do NOT answer the prompt. "" if the corrected version already sounds native.
- If everything is already correct and natural: {"corrected":"","issues":[],"upgrades":[],"native":""}`;

function shouldCheck(text: string): boolean {
	if (!text) return false;
	if (text.startsWith("/") || text.startsWith("!")) return false;
	if (text.length < 12 || text.length > 4000) return false;
	const words = text.split(/\s+/).filter((w) => /[a-zA-Z]/.test(w));
	if (words.length < 4) return false;
	// Skip prompts that are mostly code / symbols
	const letters = text.replace(/[^a-zA-Z]/g, "").length;
	if (letters / text.length < 0.45) return false;
	return true;
}

function loadStyle(): Style {
	try {
		if (existsSync(CONFIG_FILE)) {
			const saved = JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as { style?: string };
			if (saved.style && (STYLES as string[]).includes(saved.style)) return saved.style as Style;
		}
	} catch {
		/* ignore */
	}
	const env = process.env.PI_MEOWSMITH_STYLE as Style | undefined;
	if (env && (STYLES as string[]).includes(env)) return env;
	return "box";
}

function saveStyle(style: Style) {
	try {
		writeFileSync(CONFIG_FILE, JSON.stringify({ style }, null, 2) + "\n");
	} catch {
		/* ignore */
	}
}

export default function (pi: ExtensionAPI) {
	let enabled = true;
	let style: Style = loadStyle();
	let checkId = 0;
	let debug = false; // /meowsmith-debug toggles per-prompt diagnostics
	// Cat animation state, shared across handlers so agent events can wake
	// the cat up and put it back to sleep.
	const CAT_SPEED = 240; // ms per frame while working (pats + tail wag)
	let mode: "working" | "done" = "done";
	let catFrame = 0;
	let catTimer: ReturnType<typeof setInterval> | null = null;
	let catTui: { requestRender(force?: boolean): void } | null = null;

	const stopCatTimer = () => {
		if (catTimer) {
			clearInterval(catTimer);
			catTimer = null;
		}
	};

	const startCatTimer = () => {
		stopCatTimer();
		catTimer = setInterval(() => {
			catFrame++;
			if (catTui) catTui.requestRender();
		}, CAT_SPEED);
	};

	const resolveModel = (ctx: Parameters<Parameters<typeof pi.on>[1]>[1]) => {
		const override = process.env.PI_MEOWSMITH_MODEL;
		if (override) {
			const [provider, ...rest] = override.split(/[/,]/);
			const id = rest.join("/");
			const model = ctx.modelRegistry.find(provider, id);
			if (model && ctx.modelRegistry.hasConfiguredAuth(model)) return model;
		}
		return ctx.model ?? undefined;
	};

	// The cat widget renders from shared state so it can appear instantly as
	// a "reading your prompt…" placeholder and swap to real feedback later.
	// quietText: shown when the coach found nothing to fix (cat stays, no nag).
	let checking = true;
	let quietText = false;
	let currentFb: Feedback | null = null;
	// Abort handle for the in-flight coach call — superseding a prompt stops
	// the old request so it stops consuming the provider's rate budget.
	let currentAbort: AbortController | null = null;
	// After repeated coach failures, pause checking briefly so a struggling
	// provider never gets hammered on every prompt (its rate budget is shared
	// with the real task).
	let failStreak = 0;
	let cooldownUntil = 0;
	// LRU of recent coach results by exact prompt text — retries of the same
	// prompt get instant feedback with zero extra calls.
	const coachCache = new Map<string, string>();
	const COACH_CACHE_MAX = 20;

	const mountCatWidget = (
		ctx: Parameters<Parameters<typeof pi.on>[1]>[1],
	) => {
		ctx.ui.setWidget(
			WIDGET_ID,
			(tui, theme) => {
				catTui = tui;
				return {
					render(width: number) {
						const fg = (color: string, text: string) => theme.fg(color as never, text);
						if (currentFb) return renderCatFrame(currentFb, fg, width, catFrame, mode);
						return renderCatChecking(
							fg,
							width,
							catFrame,
							mode,
							quietText ? "all good — purrfect as is!" : "reading your prompt\u2026",
						);
					},
					dispose() {
						catTui = null;
					},
				};
			},
			{ placement: "aboveEditor" },
		);
	};

	// Show the placeholder the instant a run begins — zero perceived latency.
	const startChecking = (ctx: Parameters<Parameters<typeof pi.on>[1]>[1]) => {
		mode = "working";
		catFrame = 0;
		checking = true;
		quietText = false;
		currentFb = null;
		mountCatWidget(ctx);
		startCatTimer();
	};

	const showFeedback = (fb: Feedback, ctx: Parameters<Parameters<typeof pi.on>[1]>[1]) => {
		if (isQuiet(fb)) {
			if (debug) ctx.ui.notify("meowsmith: prompt already fine — staying quiet", "info");
			// Swap the placeholder text instead of removing the widget, so the
			// cat keeps the user company without nagging about anything.
			checking = false;
			quietText = true;
			if (style === "cat" && enabled) mountCatWidget(ctx);
			return;
		}
		if (debug) ctx.ui.notify("meowsmith: showing feedback", "info");
		checking = false;
		quietText = false;
		currentFb = fb;

		// The cat style is animated: the widget reads the shared mode/frame
		// state, so agent events can wake the cat or put it to sleep.
		// Other styles render statically.
		if (style !== "cat") {
			ctx.ui.setWidget(
				WIDGET_ID,
				(_tui, theme) => ({
					render(width: number) {
						const fg = (color: string, text: string) => theme.fg(color as never, text);
						return RENDERERS[style](fb, fg, width);
					},
				}),
				{ placement: "aboveEditor" },
			);
			return;
		}

		mountCatWidget(ctx);
		// Animate only while a task is running. If the feedback arrives after
		// the task settled (mode "done"), show the sleeping cat statically —
		// no timer, it just naps until the next task wakes it.
		if (mode === "working") startCatTimer();
	};

	pi.on("before_agent_start", async (event, ctx) => {
		if (!enabled) {
			if (debug) ctx.ui.notify("meowsmith: disabled", "info");
			return;
		}

		const text = (event.prompt ?? "").trim();
		ctx.ui.setWidget(WIDGET_ID, undefined); // clear previous feedback

		if (!shouldCheck(text)) {
			if (debug) ctx.ui.notify(`meowsmith: skipped (heuristic filter, len=${text.length})`, "info");
			return;
		}
		if (Date.now() < cooldownUntil) {
			if (debug) ctx.ui.notify("meowsmith: cooling down after repeated coach failures", "info");
			return;
		}
		const model = resolveModel(ctx);
		if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) {
			if (debug) ctx.ui.notify("meowsmith: skipped (no model or no auth)", "info");
			return;
		}
		// Wake the cat immediately — the "reading your prompt…" bubble mounts
		// in the same tick as the real task, then swaps when the coach answers.
		startChecking(ctx);
		if (debug) ctx.ui.notify(`meowsmith: checking with ${model.id ?? model.provider ?? "model"}…`, "info");

		const id = ++checkId;

		// Stop any in-flight coach call — its result would be discarded anyway,
		// and every token it generates is budget the real task might want.
		currentAbort?.abort();
		const abort = new AbortController();
		currentAbort = abort;
		// Also die if the run itself is interrupted.
		if (ctx.signal.aborted) abort.abort();
		else ctx.signal.addEventListener("abort", () => abort.abort(), { once: true });

		// Same prompt as a recent check? Answer instantly from cache — the
		// real task never waits and no provider budget is spent twice.
		const cached = coachCache.get(text);
		if (cached !== undefined) {
			coachCache.delete(text);
			coachCache.set(text, cached); // LRU refresh
			const fb = parseFeedback(cached);
			if (fb) {
				if (debug) ctx.ui.notify("meowsmith: cache hit — instant feedback", "info");
				showFeedback(fb, ctx);
				return;
			}
			coachCache.delete(text); // stale junk from an older parse bug
		}

		// Fire-and-forget: never block the real task.
		void (async () => {
			try {
				const response = await ctx.modelRegistry.complete(
					model,
					{
						systemPrompt: COACH_SYSTEM,
						messages: [
							{
								role: "user",
								content: [{ type: "text", text }],
								timestamp: Date.now(),
							},
						],
					},
					{
						maxTokens: 400,
						temperature: 0.2,
						cacheRetention: "none",
						sessionId: uuidv7(),
						signal: abort.signal,
					},
				);
				if (id !== checkId) return; // superseded by a newer prompt
				if (debug) ctx.ui.notify("meowsmith: superseded by newer prompt", "info");

				const output = response.content
					.filter((c): c is { type: "text"; text: string } => c.type === "text")
					.map((c) => c.text)
					.join("");

				const fb = parseFeedback(output);
				if (debug) ctx.ui.notify(`meowsmith: got response (${output.length} chars)`, "info");
				if (fb) {
					failStreak = 0;
					coachCache.set(text, output);
					while (coachCache.size > COACH_CACHE_MAX) {
						coachCache.delete(coachCache.keys().next().value as string);
					}
					showFeedback(fb, ctx);
				} else {
					// Coach gave nothing usable — drop the placeholder so it
					// doesn't hang as "reading your prompt…".
					checking = false;
					currentFb = null;
					ctx.ui.setWidget(WIDGET_ID, undefined);
					if (debug) ctx.ui.notify("meowsmith: could not parse coach response", "info");
				}
			} catch (e) {
				// Aborted = superseded by a newer prompt or the run was interrupted.
				// The newer check owns the widget — touch nothing, count nothing.
				if (abort.signal.aborted) {
					if (debug) ctx.ui.notify("meowsmith: check aborted (superseded or run ended)", "info");
					return;
				}
				// Repeated failures → brief cooldown, so a struggling provider's
				// rate budget (shared with the real task) isn't hammered.
				failStreak++;
				if (failStreak >= 2) {
					cooldownUntil = Date.now() + 5 * 60_000;
					failStreak = 0;
					if (debug) ctx.ui.notify("meowsmith: cooling down 5 min after repeated failures", "warning");
				}
				// Coach failures must never disturb the real task — only clear the
				// placeholder if this check is still the current one (a stale
				// callback must not wipe a newer run's widget).
				if (id === checkId && checking) {
					checking = false;
					currentFb = null;
					ctx.ui.setWidget(WIDGET_ID, undefined);
				}
				if (debug) ctx.ui.notify(`meowsmith: check failed — ${e instanceof Error ? e.message : String(e)}`, "warning");
			}
		})();

		return; // let the real task proceed immediately
	});

	// Task starts → cat wakes up and animates. Task settles → timer stops
	// and the widget repaints once into the sleeping-cat frame.
	pi.on("agent_start", async () => {
		mode = "working";
		if (style === "cat" && enabled) startCatTimer();
	});

	pi.on("agent_settled", async () => {
		mode = "done";
		stopCatTimer();
		if (catTui) catTui.requestRender();
	});

	pi.registerCommand("meowsmith", {
		description: "Toggle the meowsmith widget",
		handler: async (_args, ctx) => {
			enabled = !enabled;
			if (!enabled) {
				checkId++; // invalidate any in-flight check
				currentAbort?.abort(); // and stop it, don't just ignore it
				ctx.ui.setWidget(WIDGET_ID, undefined);
			}
			ctx.ui.notify(`meowsmith ${enabled ? "enabled" : "disabled"}`, "info");
		},
	});

	pi.registerCommand("meowsmith-style", {
		description: "Meowsmith visual style (cat|minimal|card|box|diff)",
		handler: async (args, ctx) => {
			const arg = (args ?? "").trim().toLowerCase() as Style;
			if (arg && (STYLES as string[]).includes(arg)) {
				style = arg;
				saveStyle(style);
				ctx.ui.notify(`meowsmith style: ${style}`, "info");
				return;
			}
			const picked = await ctx.ui.select("Meowsmith style:", STYLES);
			if (picked) {
				style = picked as Style;
				saveStyle(style);
				ctx.ui.notify(`meowsmith style: ${style}`, "info");
			}
		},
	});

	pi.registerCommand("meowsmith-debug", {
		description: "Toggle meowsmith debug notifications",
		handler: async (_args, ctx) => {
			debug = !debug;
			ctx.ui.notify(`meowsmith debug ${debug ? "on" : "off"}`, "info");
		},
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		currentAbort?.abort();
		ctx.ui.setWidget(WIDGET_ID, undefined);
	});
}
