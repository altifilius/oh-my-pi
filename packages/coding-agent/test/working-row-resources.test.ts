import { beforeAll, describe, expect, it } from "bun:test";
import { workingRowTrailer } from "@oh-my-pi/pi-coding-agent/modes/working-row-trailer";
import { type TUI, visibleWidth } from "@oh-my-pi/pi-tui";
import { Loader } from "@oh-my-pi/pi-tui/components/loader";
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
beforeAll(async () => {
	await initTheme();
});

describe("above-input throughput and resource trailer", () => {
	it("keeps field resources beside tok/s on the active working row without adding an editor row", () => {
		const editor = new CustomEditor(getEditorTheme());
		editor.setBorderStyle("field");
		const baseline = editor.render(120);
		editor.resourceUsage = usage;
		const loader = new Loader(
			{ requestComponentRender() {} } as unknown as TUI,
			s => s,
			s => s,
			"Working",
			[" esc"],
		);
		loader.stop();
		loader.setTrailer(width =>
			workingRowTrailer(width, "35.5 tok/s", available => editor.resourceLabel(available), undefined),
		);
		const lines = loader.render(120);
		expect(lines).toHaveLength(2);
		const row = Bun.stripANSI(lines[1]!);
		expect(row).toContain("esc Working");
		expect(row).toMatch(/35\.5 tok\/s\s+CPU/);
		for (const metric of ["RAM", "SWAP", "GPU", "VRAM"]) expect(row).toContain(metric);
		expect(editor.render(120)).toEqual([...baseline]);
		for (let width = 30; width <= 120; width++) {
			const rendered = loader.render(width);
			for (const line of rendered) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			expect(Bun.stripANSI(rendered[1]!)).toContain("35.5 tok/s");
		}
		const narrow = Bun.stripANSI(loader.render(55)[1]!);
		expect(narrow).toContain("CPU");
		expect(narrow).toContain("RAM");
		loader.setTrailer(width =>
			workingRowTrailer(width, undefined, available => editor.resourceLabel(available), undefined),
		);
		expect(Bun.stripANSI(loader.render(120)[1]!)).toContain("CPU");
		editor.resourceUsage = undefined;
		expect(Bun.stripANSI(loader.render(120)[1]!)).not.toContain("CPU");
	});

	it("bounds idle and unmeasured-token trailers and reads switched or cleared snapshots lazily", () => {
		const editor = new CustomEditor(getEditorTheme());
		const resources = (width: number) => editor.resourceLabel(width);
		editor.resourceUsage = usage;
		for (const rate of [undefined, "35.5 tok/s"]) {
			for (let width = 0; width <= 120; width++) {
				const trailer = workingRowTrailer(width, rate, resources, "A long band session title");
				expect(visibleWidth(trailer ?? "")).toBeLessThanOrEqual(width);
				if (rate && width >= rate.length) expect(Bun.stripANSI(trailer!)).toStartWith(rate);
			}
		}
		expect(Bun.stripANSI(workingRowTrailer(120, undefined, resources, undefined)!)).toStartWith("CPU");
		editor.resourceUsage = { ...usage, cpuPercent: 12 };
		expect(Bun.stripANSI(workingRowTrailer(120, "35.5 tok/s", resources, undefined)!)).toContain("CPU 12%");
		editor.resourceUsage = undefined;
		expect(workingRowTrailer(120, "35.5 tok/s", resources, undefined)).toBe("35.5 tok/s");
		expect(workingRowTrailer(120, undefined, resources, undefined)).toBeUndefined();
	});
});
