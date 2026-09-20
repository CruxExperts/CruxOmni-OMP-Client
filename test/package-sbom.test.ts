import { expect, test } from "bun:test";
import { buildSbom, verifyPackage } from "../scripts/verify-package.ts";

function dependencyMap(sbom: { dependencies: Array<{ ref: string; dependsOn: string[] }> }) {
  return new Map(sbom.dependencies.map(edge => [edge.ref, edge.dependsOn]));
}

test("SBOM preserves current Bun nested selections and resolves every edge", async () => {
  const result = await verifyPackage();
  expect(result.sbom.bomFormat).toBe("CycloneDX");
  expect(result.sbom.specVersion).toBe("1.5");
  expect(result.sbom.version).toBe(1);
  expect(result.sbom.serialNumber).toMatch(/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
  const edges = dependencyMap(result.sbom);
  expect(edges.get("pkg:npm/onnxruntime-node@1.30.0")).toContain("pkg:npm/onnxruntime-common@1.30.0");
  expect(edges.get("pkg:npm/%40opentelemetry/exporter-metrics-otlp-http@0.220.0")).toContain("pkg:npm/%40opentelemetry/resources@2.9.0");
  expect(edges.get("pkg:npm/%40opentelemetry/resources@2.11.0")).toContain("pkg:npm/%40opentelemetry/core@2.11.0");
  const refs = new Set([result.sbom.metadata.component.purl, ...result.sbom.components.map(component => component.purl)]);
  for (const edge of result.sbom.dependencies) {
    expect(refs.has(edge.ref)).toBe(true);
    expect(edge.dependsOn.every(reference => refs.has(reference))).toBe(true);
  }
});

test("SBOM resolver prefers a synthetic parent-specific nested lock key", () => {
  const integrity = `sha512-${Buffer.from("fixture-integrity").toString("base64")}`;
  const purl = (name: string, version: string) => `pkg:npm/${name}@${version}`;
  const lockfile = {
    path: "bun.lock" as const,
    sha256: "0".repeat(64),
    lockfileVersion: 2,
    packages: [
      { key: "parent", name: "parent", version: "1.0.0", resolution: "parent@1.0.0", integrity, dependencies: { child: "1.0.0" }, purl: purl("parent", "1.0.0") },
      { key: "child", name: "child", version: "2.0.0", resolution: "child@2.0.0", integrity, dependencies: {}, purl: purl("child", "2.0.0") },
      { key: "parent/child", name: "child", version: "1.0.0", resolution: "child@1.0.0", integrity, dependencies: {}, purl: purl("child", "1.0.0") },
    ],
  };
  const sbom = buildSbom({ name: "root", version: "1.0.0", packageManager: "bun@1.4.2", dependencies: { parent: "1.0.0" } }, lockfile);
  expect(dependencyMap(sbom).get(purl("parent", "1.0.0"))).toEqual([purl("child", "1.0.0")]);
});
