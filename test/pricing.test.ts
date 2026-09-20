import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { inspectSellerPrice, readSellerPricing } from "../src/pricing.ts";

const fixturePath = fileURLToPath(new URL("./fixtures/pricing.json", import.meta.url));

test("fresh exact pricing joins preserve zero versus unknown", async () => {
	const pricing = await readSellerPricing(fixturePath, Date.parse("2026-09-20T12:40:01Z"));
	const known = inspectSellerPrice({ id: "openai/gpt-5-mini", owned_by: "openai" }, pricing, true, Date.parse("2026-09-20T12:40:01Z"));
	expect(known.state).toBe("known");
	expect(known.nativeId).toBe("gpt-5-mini");
	expect(known.cost).toEqual({ input: 2.5, output: 10, cacheRead: 0.25, cacheWrite: 1.25 });
	const unknown = inspectSellerPrice({ id: "openai/no-such-model", owned_by: "openai" }, pricing, true);
	expect(unknown.state).toBe("unknown");
	expect(unknown.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
});

test("conditional and combo rows never become cash prices", async () => {
	const pricing = await readSellerPricing(fixturePath, Date.parse("2026-09-20T12:40:01Z"));
	const conditional = inspectSellerPrice({ id: "openai/gpt-5-nano", owned_by: "openai" }, pricing, true, Date.parse("2026-09-20T12:40:01Z"));
	expect(conditional.state).toBe("conditional");
	expect(conditional.cost.input).toBe(0);
	const combo = inspectSellerPrice({ id: "combo", owned_by: "openai", type: "combo" }, pricing, true);
	expect(combo.state).toBe("unknown");
	expect(combo.reasons).toContain("dynamic_combo_price_unknown");
});

test("expired source-backed rows are stale rather than current cash prices", async () => {
	const pricing = await readSellerPricing(fixturePath, Date.parse("2026-09-20T12:40:01Z"));
	const source = pricing.sources.get("fixture-pricing");
	if (!source) throw new Error("fixture source missing");
	source.expires_at = "2026-09-20T12:40:00Z";
	const stale = inspectSellerPrice({ id: "openai/gpt-5-mini", owned_by: "openai" }, pricing, true, Date.parse("2026-09-20T12:40:01Z"));
	expect(stale.state).toBe("stale");
	expect(stale.cost.input).toBe(0);
});

test("canonical ASCII checksum agrees for Unicode IDs and source locators", async () => {
	const now = Date.parse("2026-09-10T00:00:01Z");
	const value = await readSellerPricing(fileURLToPath(new URL("./fixtures/canonical-projection.json", import.meta.url)), now);
	const inspection = inspectSellerPrice({ id: "kilocode/openai/模型", owned_by: "kilocode" }, value, true, now);
	expect(inspection.cost).toEqual({ input: 2, output: 8, cacheRead: 0, cacheWrite: 0 });
	expect(inspection.nativeId).toBe("openai/模型");
});
