import { expect, test } from "bun:test";
import { projectCatalog, CatalogError } from "../src/catalog.ts";
import { DiscoveryManager } from "../src/health.ts";

test("runtime identities are exact and endpoint modalities stay truthful", () => {
	const projection = projectCatalog({ data: [
		{ id: "responses", owned_by: "openai", supported_endpoints: ["chat", "responses"], capabilities: { reasoning: true } },
		{ id: "chat", owned_by: "openai", supported_endpoints: ["chat"] },
		{ id: "images", owned_by: "openai", supported_endpoints: ["images"] },
		{ id: "default" },
	] });
	expect(projection.models.map(model => [model.id, model.api])).toEqual([
		["responses", "openai-responses"],
		["chat", "openai-completions"],
		["default", "openai-responses"],
	]);
	expect(projection.diagnostics.map(item => item.code)).toContain("specialty_only_route");
	expect(projection.diagnostics.map(item => item.code)).toContain("endpoint_unverified_default");
});

test("duplicate identity conflicts fail while property-order duplicates deduplicate", () => {
	const same = projectCatalog({ data: [{ id: "same", owned_by: "a" }, { owned_by: "a", id: "same" }] });
	expect(same.models.map(model => model.id)).toEqual(["same"]);
	expect(() => projectCatalog({ data: [{ id: "same", owned_by: "a" }, { id: "same", owned_by: "b" }] })).toThrow(CatalogError);
	expect(() => projectCatalog({ data: null })).toThrow("invalid_live_data");
});

test("catalog metadata enriches only exact owner and id", () => {
	const projection = projectCatalog(
		{ data: [{ id: "model", owned_by: "owner", context_length: -1 }] },
		{ metadata: { catalog: { owner: { models: [{ id: "model", context_length: 64000, max_output_tokens: 2000 }] }, other: { models: [{ id: "model", context_length: 1 }] } } } },
	);
	expect(projection.models[0]?.contextWindow).toBe(64000);
	expect(projection.models[0]?.maxTokens).toBe(2000);
});

test("discovery is single-flight and retains same-generation rows", async () => {
	let calls = 0;
	let fail = false;
	const manager = new DiscoveryManager(async (_binding, signal) => {
		calls++;
		if (signal.aborted) throw Object.assign(new Error("aborted"), { code: "aborted" });
		if (fail) throw Object.assign(new Error("offline"), { code: "timeout" });
		return { projection: projectCatalog({ data: [{ id: "live" }] }) };
	});
	manager.setBinding("https://one.example", "key", 1);
	const [first, second] = await Promise.all([manager.refresh(), manager.refresh()]);
	expect(first).toBe(second);
	expect(calls).toBe(1);
	fail = true;
	const stale = await manager.refresh();
	expect(stale?.stale).toBe(true);
	expect(stale?.projection.models[0]?.id).toBe("live");
	manager.setBinding("https://two.example", "other", 2);
	expect(manager.status.modelCount).toBe(0);
});

test("late discovery from an old endpoint generation is discarded", async () => {
	let releaseOld: (() => void) | undefined;
	const manager = new DiscoveryManager(async binding => {
		if (binding.endpoint.includes("one")) {
			await new Promise<void>(resolve => { releaseOld = resolve; });
			return { projection: projectCatalog({ data: [{ id: "old" }] }) };
		}
		return { projection: projectCatalog({ data: [{ id: "new" }] }) };
	});
	manager.setBinding("https://one.example", "old-key", 1);
	const old = manager.refresh();
	manager.setBinding("https://two.example", "new-key", 2);
	releaseOld?.();
	expect(await old).toBeUndefined();
	const fresh = await manager.refresh();
	expect(fresh?.projection.models[0]?.id).toBe("new");
});
