import { expect, test } from "bun:test";
import { DISPLAY_NAME, PACKAGE_NAME, PROVIDER_ID } from "../src/identity.ts";

test("new package identity preserves native provider identity", () => {
  expect(DISPLAY_NAME).toBe("CruxOmni-OMP-Client");
  expect(PACKAGE_NAME).toBe("@cruxexperts/cruxomni-omp-client");
  expect(PROVIDER_ID).toBe("omniroute");
});
