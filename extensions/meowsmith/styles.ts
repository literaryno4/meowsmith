/**
 * meowsmith styles — rendering helpers shared by the meowsmith widget.
 */
export interface Issue {
	before: string;
	after: string;
	why: string;
}
export interface Upgrade {
	from: string;
	to: string;
}
export interface Feedback {
	corrected: string;
	issues: Issue[];
	upgrades: Upgrade[];
	native: string;
}
export type Style = "minimal" | "card" | "box" | "cat" | "diff";
export type Fg = (color: string, text: string) => string;

export const STYLES: Style[] = ["cat", "minimal", "card", "box", "diff"];

export function wrap(text: string, width: number): string[] {
	const out: string[] = [];
	for (const paragraph of text.split("\n")) {
		let line = "";
		for (const word of paragraph.split(/\s+/).filter(Boolean)) {
			if (line.length === 0) line = word;
			else if (line.length + 1 + word.length <= width) line += " " + word;
			else {
				out.push(line);
				line = word;
			}
		}
		if (line) out.push(line);
	}
	return out;
}

export function parseFeedback(raw: string): Feedback | undefined {
	const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");
	const fallback = (): Feedback | undefined => {
		const text = raw.trim();
		return text ? { corrected: text, issues: [], upgrades: [], native: "" } : undefined;
	};
	const start = raw.indexOf("{");
	const end = raw.lastIndexOf("}");
	if (start === -1 || end <= start) return fallback();
	try {
		const obj = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
		const issues = Array.isArray(obj.issues)
			? (obj.issues as Record<string, unknown>[])
					.slice(0, 3)
					.map((i) => ({ before: s(i?.before), after: s(i?.after), why: s(i?.why) }))
					.filter((i) => i.before || i.after)
			: [];
		const upgrades = Array.isArray(obj.upgrades)
			? (obj.upgrades as Record<string, unknown>[])
					.slice(0, 3)
					.map((u) => ({ from: s(u?.from), to: s(u?.to) }))
					.filter((u) => u.from && u.to)
			: [];
		return { corrected: s(obj.corrected), issues, upgrades, native: s(obj.native) };
	} catch {
		return fallback();
	}
}

/** Best available rewrite: prefer the fully native phrasing. */
export function bestVersion(fb: Feedback): string {
	return fb.native || fb.corrected;
}

export function isQuiet(fb: Feedback): boolean {
	return fb.corrected === "" && fb.native === "" && fb.issues.length === 0 && fb.upgrades.length === 0;
}

/** Unified fix bullets: grammar issues first, then word-choice upgrades. */
export function fixBullets(fb: Feedback, max = 5): { label: string; from: string; to: string }[] {
	const out: { label: string; from: string; to: string }[] = [];
	for (const i of fb.issues) out.push({ label: i.why, from: i.before, to: i.after });
	for (const u of fb.upgrades) out.push({ label: "more natural", from: u.from, to: u.to });
	return out.slice(0, max);
}

// ---------- style renderers ----------

function renderMinimal(fb: Feedback, fg: Fg, width: number): string[] {
	const lines: string[] = [];
	const body = wrap(bestVersion(fb), width - 3).slice(0, 3);
	for (const l of body) lines.push(fg("dim", "\ud83d\udc3e " + l));
	for (const b of fixBullets(fb)) {
		for (const l of wrap(`• ${b.label}: ${b.from} → ${b.to}`, width - 4)) lines.push(fg("dim", "  " + l));
	}
	return lines;
}

function renderCard(fb: Feedback, fg: Fg, width: number): string[] {
	const lines: string[] = [fg("warning", "\ud83d\udc3e meowsmith")];
	const body = wrap(bestVersion(fb), width - 9).slice(0, 3);
	if (fb.native) lines.push(fg("accent", "│ ⇢ native"));
	for (const l of body) lines.push(fg("text", "│ " + l));
	for (const b of fixBullets(fb, 4)) {
		const wrapped = wrap(`${b.label}: ${b.from} → ${b.to}`, width - 11);
		lines.push(fg("muted", "│   • " + wrapped[0]));
		for (const l of wrapped.slice(1)) lines.push(fg("muted", "│     " + l));
	}
	return lines;
}

interface Row {
	text: string;
	color: string | null;
}

function renderBox(fb: Feedback, fg: Fg, width: number): string[] {
	if (width < 12) return renderCard(fb, fg, width);
	const rows: Row[] = [];
	const body = wrap(bestVersion(fb), width - 4).slice(0, 3);
	if (fb.native) rows.push({ text: "native:", color: "accent" });
	for (const l of body) rows.push({ text: l, color: "text" });
	for (const b of fixBullets(fb, 4)) {
		for (const l of wrap(`• ${b.label}: ${b.from} → ${b.to}`, width - 6)) {
			rows.push({ text: "  " + l, color: "muted" });
		}
	}
	if (rows.length === 0) return [];

	// Full-width box, matching the width other blocks render at.
	const boxWidth = width;
	const bodyW = boxWidth - 4;
	const title = boxWidth >= dispWidth(" \ud83d\udc3e meowsmith ") + 6 ? " \ud83d\udc3e meowsmith " : "";
	const dash = Math.max(0, boxWidth - dispWidth(title) - 3);
	const lines = [fg("accent", "╭─" + title + "─".repeat(dash) + "╮")];
	for (const r of rows) {
		const text = r.text.length > bodyW ? r.text.slice(0, bodyW) : r.text;
		const pad = " ".repeat(bodyW - text.length);
		lines.push(fg("borderMuted", "│ ") + (r.color ? fg(r.color, text) : text) + pad + fg("borderMuted", " │"));
	}
	lines.push(fg("accent", "╰" + "─".repeat(boxWidth - 2) + "╯"));
	return lines;
}

/** Cat speech-bubble style: a little cat delivering the feedback. */
/**
 * Cat art for one animation frame. All rows are exactly 10 columns wide:
 * a 7-column body plus a 3-column tail zone.
 * While the agent works the cat pats the bubble (alternating paws),
 * winks and wags its tail fast. When the task is done the cat falls
 * asleep — a static frame with a little "zZ".
 */
export function catArt(hasIssues: boolean, frame: number, mode: "working" | "done"): [string, string, string] {
	const mod = (n: number, m: number) => ((n % m) + m) % m;
	if (mode === "done") {
		// Sleeping cat: eyes closed, a floating "zZ", tail curled around.
		return [" /\\_/\\    ", "( -.- ) zZ", " > ^ < ~  "];
	}
	// Tail: attached at the body's right edge, swings up → level → down → level.
	// Advances every 2nd working tick (fast wag).
	const tail = ["/  ", "-  ", "\\  ", "-  "][mod(Math.floor(frame / 2), 4)];
	const f = mod(frame, 6);
	const paws = [" > ^ < ", " >/  < ", " > ^ < ", " > \\ < ", " > ^ < ", " > w < "][f];
	const eyes = f === 5 ? "( -.o )" : "( o.o )"; // wink while saying "meow!"
	return [" /\\_/\\    ", eyes + "   ", paws + tail];
}

/** Display width of a string (emoji count as 2 columns, not JS length). */
function dispWidth(s: string): number {
	let w = 0;
	for (const ch of s) w += ch.codePointAt(0)! > 0xffff ? 2 : 1;
	return w;
}

/** One frame of the cat speech-bubble widget. */
export function renderCatFrame(
	fb: Feedback,
	fg: Fg,
	width: number,
	frame: number,
	mode: "working" | "done",
): string[] {
	const catW = 10; // cat art width (body + tail zone); trailing space is the gap
	if (width < catW + 22) return renderBox(fb, fg, width); // too narrow for the cat

	const cat = catArt(fb.issues.length > 0, frame, mode);

	const content: Row[] = [];
	for (const l of wrap(bestVersion(fb), width - catW - 5).slice(0, 4)) {
		content.push({ text: l, color: "text" });
	}
	for (const b of fixBullets(fb, 3)) {
		for (const l of wrap("\u2022 " + b.label + ": " + b.from + " \u2192 " + b.to, width - catW - 7)) {
			content.push({ text: "  " + l, color: "muted" });
		}
	}
	// Need at least 3 content rows so the cat's ears, face, and paws each sit
	// beside a bubble row.
	while (content.length < 3) content.push({ text: "", color: null });

	const bubbleW = width - catW;
	const innerW = bubbleW - 4;
	// The old intro row now lives in the border, after the title.
	const label = fb.native
		? "a native would say"
		: fb.corrected
			? "polished for you"
			: "tiny fixes I spotted";
	const fullTitle = " \ud83d\udc3e meowsmith \u00b7 " + label + " ";
	const shortTitle = " \ud83d\udc3e meowsmith ";
	const title = bubbleW >= fullTitle.length + 6 ? fullTitle : shortTitle;
	const top = "\u256d\u2500" + title + "\u2500".repeat(Math.max(0, bubbleW - dispWidth(title) - 3)) + "\u256e";
	const bottom = "\u2570" + "\u2500".repeat(bubbleW - 2) + "\u256f";
	const blankPrefix = " ".repeat(catW);
	const row = (r: Row) => {
		const text = r.text.length > innerW ? r.text.slice(0, innerW) : r.text;
		const pad = " ".repeat(innerW - text.length);
		return fg("borderMuted", "\u2502 ") + (r.color ? fg(r.color, text) : text) + pad + fg("borderMuted", " \u2502");
	};

	const lines: string[] = [blankPrefix + fg("borderMuted", top)];
	// Cat rows hook onto the first three content rows, like the cat is peeking
	// over the bubble's left edge.
	content.forEach((r, i) => {
		const prefix = i < 3 ? cat[i] : blankPrefix;
		lines.push(prefix + row(r));
	});
	lines.push(blankPrefix + fg("borderMuted", bottom));
	return lines;
}

/** Static cat render for the style list (frame 0, idle). */
function renderCat(fb: Feedback, fg: Fg, width: number): string[] {
	return renderCatFrame(fb, fg, width, 0, "done");
}

function renderDiff(fb: Feedback, fg: Fg, width: number): string[] {
	const lines: string[] = [];
	const bullets = fixBullets(fb, 4);
	for (const b of bullets) {
		for (const l of wrap(`- ${b.from}`, width - 4)) lines.push(fg("toolDiffRemoved", "  " + l));
		for (const l of wrap(`+ ${b.to}`, width - 4)) lines.push(fg("toolDiffAdded", "  " + l));
		if (b.label) for (const l of wrap(`· ${b.label}`, width - 5)) lines.push(fg("dim", "   " + l));
		lines.push("");
	}
	const best = bestVersion(fb);
	if (best) {
		if (bullets.length > 0) lines.push(fg("dim", "  ⇢ native way:"));
		for (const l of wrap(`+ ${best}`, width - 4)) lines.push(fg("toolDiffAdded", "  " + l));
	}
	while (lines.length && lines[lines.length - 1] === "") lines.pop();
	return lines;
}

export const RENDERERS: Record<Style, (fb: Feedback, fg: Fg, width: number) => string[]> = {
	minimal: renderMinimal,
	card: renderCard,
	box: renderBox,
	cat: renderCat,
	diff: renderDiff,
};
