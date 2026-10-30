import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { cfgComposerResources, cfgComposerTokenRate } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { NativeNode } from "@oh-my-pi/pi-tui/native/node";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

function hasResourceNode(root: NativeNode): boolean {
	return (
		(root.p && "role" in root.p && root.p.role === "omp.composer.resources") ||
		(root.c?.some(child => "k" in child && hasResourceNode(child)) ?? false)
	);
}

const nativeContext = {
	cols: 160,
	reduceMotion: true,
	dark: true,
	supports: () => true,
	feature: () => true,
};

describe("session resource visibility", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	let terminal: VirtualTerminal;

	beforeAll(async () => {
		await initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-resource-toggle-");
		const settings = await Settings.init({
			inMemory: true,
			cwd: tempDir.path(),
			overrides: { "startup.quiet": true, "composer.shape": "field", "composer.tokenRate": true },
		});
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 in registry");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings,
			modelRegistry,
		});
		terminal = new VirtualTerminal(160, 32);
		mode = new InteractiveMode(
			session,
			"test",
			undefined,
			() => {},
			undefined,
			undefined,
			undefined,
			new Composer({ terminal }),
		);
	});

	afterEach(async () => {
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	const text = () => terminal.getViewport().join("\n");

	it("starts hidden when disabled and enables independently of the generation rate", async () => {
		cfgComposerResources.override(session.settings, false);
		await mode.init({ suppressWelcomeIntro: true });
		mode.tokenRate.seed(800, 8_000);
		mode.editor.setText("DRAFT_STAYS_EDITABLE");
		mode.ui.requestRender();
		await terminal.waitForRender(() => text().includes("100.0 tok/s"));
		expect(text()).toContain("100.0 tok/s");
		expect(text()).not.toContain("CPU");
		expect(hasResourceNode(mode.editor.describe(nativeContext))).toBe(false);

		cfgComposerTokenRate.override(session.settings, false);
		cfgComposerResources.override(session.settings, true);
		await terminal.waitForRender(() => text().includes("RAM"));
		expect(text()).toContain("CPU");
		expect(text()).toContain("RAM");
		expect(text()).not.toContain("tok/s");
		expect(hasResourceNode(mode.editor.describe(nativeContext))).toBe(true);
		expect(mode.editor.getText()).toBe("DRAFT_STAYS_EDITABLE");
	});

	it("clears both renderers immediately and restarts after rapid toggles", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		mode.tokenRate.seed(800, 8_000);
		await terminal.waitForRender(() => text().includes("RAM") && text().includes("100.0 tok/s"));
		expect(text()).toMatch(/100\.0 tok\/s\s+CPU/);

		cfgComposerResources.override(session.settings, false);
		await terminal.waitForRender(() => !text().includes("CPU"));
		expect(text()).toContain("100.0 tok/s");
		expect(text()).not.toContain("RAM");
		expect(hasResourceNode(mode.editor.describe(nativeContext))).toBe(false);

		cfgComposerResources.override(session.settings, true);
		await Promise.resolve();
		cfgComposerResources.override(session.settings, false);
		await terminal.waitForRender();
		expect(mode.editor.resourceUsage).toBeUndefined();
		expect(text()).not.toContain("CPU");
		expect(hasResourceNode(mode.editor.describe(nativeContext))).toBe(false);

		cfgComposerResources.override(session.settings, true);
		await terminal.waitForRender(() => text().includes("RAM"));
		expect(text()).toMatch(/100\.0 tok\/s\s+CPU/);
		expect(hasResourceNode(mode.editor.describe(nativeContext))).toBe(true);
	});
});
