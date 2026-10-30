import { describe, expect, test } from "bun:test";
import {
	dispatchRpcControlFrame,
	type PendingExtensionRequest,
	requestRpcAskDialog,
	requestRpcEditor,
	requestRpcInput,
	type RpcInputFrameDeps,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import type { ExtensionAskDialogQuestion } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";

function fixture() {
	const pending = new Map<string, PendingExtensionRequest>();
	const frames: object[] = [];
	const output = (frame: object) => frames.push(frame);
	const deps: RpcInputFrameDeps = {
		pendingExtensionRequests: pending,
		output,
		handleCommand: async () => {
			throw new Error("UI responses must bypass the command queue");
		},
		errorResponse: (id, command, error) => ({ type: "response", id, command, success: false, error }),
		onHostToolResult: () => {},
		onHostToolUpdate: () => {},
		onHostUriResult: () => {},
	};
	function requestId() {
		const request = frames.find(frame => "type" in frame && frame.type === "extension_ui_request" && "id" in frame);
		if (!request || !("id" in request) || typeof request.id !== "string")
			throw new Error("Expected a real UI request");
		return request.id;
	}
	return { pending, frames, output, deps, requestId };
}

const question: ExtensionAskDialogQuestion = {
	id: "color",
	question: "Which color?",
	options: [{ label: "Blue" }, { label: "Green" }],
};

describe("RPC extension response acknowledgements", () => {
	test("acknowledges delivery under the response id and rejects a second answer without changing the first", async () => {
		const { pending, frames, output, deps, requestId } = fixture();
		const result = requestRpcAskDialog(pending, output, [question]);
		const id = requestId();
		expect(
			dispatchRpcControlFrame(
				{
					type: "extension_ui_response",
					id,
					responseId: "first",
					answers: [{ id: "color", selectedOptions: ["Green"] }],
				},
				deps,
			),
		).toBe(true);
		expect(await result).toMatchObject({ kind: "submit", results: [{ id: "color", selectedOptions: ["Green"] }] });
		expect(frames.at(-1)).toEqual({
			type: "response",
			id: "first",
			command: "extension_ui_response",
			success: true,
			data: { delivered: true },
		});
		dispatchRpcControlFrame(
			{
				type: "extension_ui_response",
				id,
				responseId: "second",
				answers: [{ id: "color", selectedOptions: ["Blue"] }],
			},
			deps,
		);
		expect(frames.at(-1)).toMatchObject({
			type: "response",
			id: "second",
			command: "extension_ui_response",
			success: false,
			code: "stale_interaction",
		});
	});

	test("legacy answers still resolve without an unsolicited response", async () => {
		const { pending, frames, output, deps, requestId } = fixture();
		const result = requestRpcInput(pending, output, "Input");
		dispatchRpcControlFrame({ type: "extension_ui_response", id: requestId(), value: "legacy" }, deps);
		expect(await result).toBe("legacy");
		expect(frames.filter(frame => "type" in frame && frame.type === "response")).toEqual([]);
	});

	test("an aborted dialog rejects a late answer under its own response id", async () => {
		const { pending, frames, output, deps, requestId } = fixture();
		const controller = new AbortController();
		const result = requestRpcInput(pending, output, "Input", undefined, { signal: controller.signal });
		const id = requestId();
		controller.abort();
		expect(await result).toBeUndefined();
		dispatchRpcControlFrame({ type: "extension_ui_response", id, responseId: "late", value: "too late" }, deps);
		expect(frames.at(-1)).toMatchObject({ id: "late", success: false, code: "stale_interaction" });
	});

	test("malformed correlation ids cannot consume the pending question", async () => {
		const { pending, output, deps, requestId } = fixture();
		const result = requestRpcInput(pending, output, "Input");
		const id = requestId();
		expect(() =>
			dispatchRpcControlFrame({ type: "extension_ui_response", id, responseId: 7, value: "wrong" }, deps),
		).toThrow();
		expect(pending.has(id)).toBe(true);
		dispatchRpcControlFrame({ type: "extension_ui_response", id, responseId: "valid", value: "correct" }, deps);
		expect(await result).toBe("correct");
	});

	test("acknowledges cancellation and editor answers without exposing answer text", async () => {
		const { pending, frames, output, deps, requestId } = fixture();
		const result = requestRpcEditor(pending, output, "Secret draft");
		dispatchRpcControlFrame(
			{ type: "extension_ui_response", id: requestId(), responseId: "editor", value: "sensitive draft" },
			deps,
		);
		expect(await result).toBe("sensitive draft");
		expect(frames.at(-1)).toEqual({
			type: "response",
			id: "editor",
			command: "extension_ui_response",
			success: true,
			data: { delivered: true },
		});
		const cancelled = requestRpcInput(pending, output, "Cancel input");
		const request = frames.findLast(
			frame =>
				"type" in frame && frame.type === "extension_ui_request" && "method" in frame && frame.method === "input",
		);
		if (!request || !("id" in request) || typeof request.id !== "string") throw new Error("Expected input request");
		dispatchRpcControlFrame(
			{ type: "extension_ui_response", id: request.id, responseId: "cancel", cancelled: true },
			deps,
		);
		expect(await cancelled).toBeUndefined();
		expect(frames.at(-1)).toEqual({
			type: "response",
			id: "cancel",
			command: "extension_ui_response",
			success: true,
			data: { delivered: true },
		});
	});
});
