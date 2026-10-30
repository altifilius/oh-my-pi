import { beforeAll, describe, expect, it } from "bun:test";
import { CURSOR_MARKER } from "@oh-my-pi/pi-tui";
import { BUILTIN_EDITOR_BORDER_STYLES } from "@oh-my-pi/pi-tui/components/composer/types";
import type { DescribeContext, NativeNode } from "@oh-my-pi/pi-tui/native/node";
import { type ComposerResourceUsage, CustomEditor } from "@oh-my-pi/pi-tui/prompt/custom-editor";
import { getEditorTheme, initTheme } from "@oh-my-pi/pi-tui/theme";

const usage: ComposerResourceUsage = {
	cpuPercent: 236,
	memoryBytes: 768 * 1024 * 1024,
	swapBytes: 32 * 1024 * 1024,
	gpuPercent: 42,
	vramBytes: 2 * 1024 * 1024 * 1024,
	processCount: 7,
	partial: false,
};
const cx = (cols = 180): DescribeContext => ({
	cols,
	reduceMotion: true,
	dark: true,
	supports: () => true,
	feature: () => true,
});
const plain = (line: string): string => Bun.stripANSI(line.replace(CURSOR_MARKER, ""));
function nodes(root: NativeNode): NativeNode[] {
	const out = [root];
	for (const child of root.c ?? []) if ("k" in child) out.push(...nodes(child));
	return out;
}
function byRole(root: NativeNode, role: string): NativeNode | undefined {
	return nodes(root).find(child => child.p && "role" in child.p && child.p.role === role);
}
function resourceText(resource: NativeNode): string {
	if (resource.k !== "text" || !resource.p?.spans) throw new Error("Expected resource text spans");
	return resource.p.spans.map(span => span.t).join("");
}

beforeAll(async () => {
	await initTheme();
});

describe("CustomEditor session resources", () => {
	it("never adds ANSI rows or moves the caret, shape chrome, status facts or draft", () => {
		for (const shape of BUILTIN_EDITOR_BORDER_STYLES) {
			for (const maxHeight of [undefined, 3, 5]) {
				const editor = new CustomEditor(getEditorTheme());
				editor.setBorderStyle(shape);
				editor.setMaxHeight(maxHeight);
				editor.focused = true;
				editor.setText("one\ntwo\nthree\nfour\nfive\nsix");
				editor.setTopBorderProvider(width => ({
					content: `left fact${" ".repeat(Math.max(0, width - 19))}right fact`,
					width,
				}));
				const baseline = editor.render(120);
				const cursor = editor.getCursor();
				for (const sample of [usage, { ...usage, cpuPercent: 315, partial: true }, undefined]) {
					editor.resourceUsage = sample;
					const rendered = editor.render(120);
					expect(rendered).toEqual([...baseline]);
					expect(rendered.join("\n").split(CURSOR_MARKER)).toHaveLength(2);
					expect(editor.getCursor()).toEqual(cursor);
					expect(editor.getText()).toBe("one\ntwo\nthree\nfour\nfive\nsix");
				}
			}
		}
	});

	it("returns unpadded complete metric groups, prioritizing CPU and RAM without overflow", () => {
		const editor = new CustomEditor(getEditorTheme());
		expect(editor.resourceLabel(120)).toBeUndefined();
		for (const partial of [false, true]) {
			editor.resourceUsage = { ...usage, partial };
			const full = plain(editor.resourceLabel(120)!);
			const prefix = partial ? "~ " : "";
			const groups = full.slice(prefix.length).split(" · ");
			expect(groups.map(group => group.split(" ")[0])).toEqual(["CPU", "RAM", "SWAP", "GPU", "VRAM"]);
			for (let width = 0; width <= 120; width++) {
				const styled = editor.resourceLabel(width);
				if (width < Bun.stringWidth(prefix + groups[0]!)) {
					expect(styled).toBeUndefined();
					continue;
				}
				const label = plain(styled!);
				expect(Bun.stringWidth(styled!)).toBeLessThanOrEqual(width);
				expect(label.trim()).toBe(label);
				expect(label).not.toContain("\n");
				expect(label).not.toContain("\x1b");
				const shown = label.slice(prefix.length).split(" · ");
				expect(shown).toEqual(groups.slice(0, shown.length));
			}
			const cpuRam = prefix + groups.slice(0, 2).join(" · ");
			expect(plain(editor.resourceLabel(Bun.stringWidth(cpuRam))!)).toBe(cpuRam);
		}
		editor.resourceUsage = undefined;
		expect(editor.resourceLabel(120)).toBeUndefined();
	});

	it("distinguishes measured zero, unavailable readings and partial coverage", () => {
		const editor = new CustomEditor(getEditorTheme());
		editor.resourceUsage = { ...usage, cpuPercent: 0, memoryBytes: 0, swapBytes: 0, gpuPercent: 0, vramBytes: 0 };
		const zero = plain(editor.resourceLabel(120)!);
		for (const metric of ["CPU 0%", "RAM 0B", "SWAP 0B", "GPU 0%", "VRAM 0B"]) expect(zero).toContain(metric);
		editor.resourceUsage = {
			...usage,
			cpuPercent: null,
			memoryBytes: null,
			swapBytes: null,
			gpuPercent: null,
			vramBytes: null,
		};
		const unavailable = plain(editor.resourceLabel(120)!);
		for (const metric of ["CPU", "RAM", "SWAP", "GPU", "VRAM"]) expect(unavailable).toContain(`${metric} —`);
		expect(unavailable).not.toBe(zero);
		editor.resourceUsage = usage;
		const complete = plain(editor.resourceLabel(120)!);
		editor.resourceUsage = { ...usage, partial: true };
		const partial = plain(editor.resourceLabel(120)!);
		expect(partial).not.toBe(complete);
		expect(partial.endsWith(complete)).toBeTrue();
	});

	it("keeps autocomplete on the same input rows while samples update", async () => {
		const editor = new CustomEditor(getEditorTheme());
		const shown = Promise.withResolvers<void>();
		editor.setAutocompleteProvider({
			getSuggestions: () => Promise.resolve({ items: [{ label: "alpha.ts", value: "@alpha.ts" }], prefix: "@" }),
			applyCompletion: (lines, cursorLine, cursorCol) => ({ lines, cursorLine, cursorCol }),
		});
		editor.onAutocompleteUpdate = () => {
			if (editor.isShowingAutocomplete()) shown.resolve();
		};
		editor.handleInput("@");
		await shown.promise;
		const baseline = editor.render(100);
		const cursor = editor.getCursor();
		editor.resourceUsage = usage;
		expect(editor.render(100)).toEqual([...baseline]);
		editor.resourceUsage = { ...usage, cpuPercent: 315 };
		expect(editor.render(100)).toEqual([...baseline]);
		expect(editor.isShowingAutocomplete()).toBeTrue();
		expect(editor.getCursor()).toEqual(cursor);
	});

	it("places native metrics immediately beside tok/s in the existing bar with stable input and controls", () => {
		const editor = new CustomEditor(getEditorTheme());
		let rate: number | undefined = 31.8;
		editor.composerState = () => ({ running: false, thinking: "high", rate });
		editor.focused = true;
		editor.setText("native draft");
		const before = editor.describe(cx());
		const input = nodes(before).find(child => child.k === "editor")!;
		const cursor = editor.getCursor();
		editor.resourceUsage = { ...usage, partial: true, gpuPercent: null };
		const after = editor.describe(cx());
		const resources = byRole(after, "omp.composer.resources")!;
		const bar = byRole(after, "omp.composer.bar")!;
		const rateNode = byRole(after, "omp.composer.rate")!;
		expect(resources.k).toBe("text");
		expect(resources.p).toHaveProperty("wrap", "none");
		expect(resources.p).not.toHaveProperty("actions");
		expect(resources.p).not.toHaveProperty("grow");
		expect(bar.c!.indexOf(resources)).toBe(bar.c!.indexOf(rateNode) + 1);
		expect(after.c).toHaveLength(before.c!.length);
		expect(after.c).not.toContain(resources);
		expect(resourceText(resources)).toBe(plain(editor.resourceLabel(180)!));
		const title = resources.p?.title;
		if (typeof title !== "string") throw new Error("Expected resource tooltip");
		for (const metric of ["CPU", "RAM", "SWAP", "GPU", "VRAM"]) expect(title).toContain(metric);
		expect(title).toContain(String(usage.processCount));
		expect(resourceText(resources)).toContain("GPU —");
		expect(nodes(after).find(child => child.k === "editor")).toBe(input);
		expect(byRole(after, "omp.composer.send")).toBe(byRole(before, "omp.composer.send"));
		expect(editor.getCursor()).toEqual(cursor);
		expect(editor.getText()).toBe("native draft");
		expect(editor.describe(cx())).toBe(after);
		editor.resourceUsage = { ...usage, partial: true, gpuPercent: null };
		expect(editor.describe(cx())).toBe(after);
		rate = 32.4;
		const ticked = editor.describe(cx());
		expect(byRole(ticked, "omp.composer.resources")).toBe(resources);
		expect(nodes(ticked).find(child => child.k === "editor")).toBe(input);
		editor.resourceUsage = { ...usage, cpuPercent: 315 };
		const sampled = editor.describe(cx());
		expect(resourceText(byRole(sampled, "omp.composer.resources")!)).toContain("315%");
		expect(byRole(sampled, "omp.composer.bar")).not.toBe(byRole(ticked, "omp.composer.bar"));
		expect(nodes(sampled).find(child => child.k === "editor")).toBe(input);
		rate = undefined;
		const noRate = editor.describe(cx());
		const noRateBar = byRole(noRate, "omp.composer.bar")!;
		expect(byRole(noRate, "omp.composer.rate")).toBeUndefined();
		expect(noRateBar.c).toContain(byRole(noRate, "omp.composer.resources"));
		expect(nodes(noRate).find(child => child.k === "editor")).toBe(input);
		editor.resourceUsage = undefined;
		const cleared = editor.describe(cx());
		expect(byRole(cleared, "omp.composer.resources")).toBeUndefined();
		expect(nodes(cleared).find(child => child.k === "editor")).toBe(input);
	});

	it("fits complete native metric groups beside a preserved rate and hides them when too narrow", () => {
		const editor = new CustomEditor(getEditorTheme());
		editor.composerState = () => ({ running: false, rate: 31.8 });
		editor.resourceUsage = usage;
		const groups = plain(editor.resourceLabel(180)!).split(" · ");
		for (let cols = 1; cols <= 180; cols++) {
			const root = editor.describe(cx(cols));
			const bar = byRole(root, "omp.composer.bar")!;
			const rate = byRole(root, "omp.composer.rate")!;
			expect(rate.p).toHaveProperty("value", 31.8);
			const resources = byRole(root, "omp.composer.resources");
			if (!resources) continue;
			const label = resourceText(resources);
			expect(Bun.stringWidth(label) + Bun.stringWidth("31.8 tok/s")).toBeLessThanOrEqual(cols);
			expect(bar.c!.indexOf(resources)).toBe(bar.c!.indexOf(rate) + 1);
			const shown = label.split(" · ");
			expect(shown).toEqual(groups.slice(0, shown.length));
		}
		expect(byRole(editor.describe(cx(1)), "omp.composer.resources")).toBeUndefined();
	});
});
