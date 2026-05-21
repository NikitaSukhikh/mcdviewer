import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { McdParserError, openMcd, pdfToMcd } from "./index.js";

const fixtureRoot = new URL("../../../tests/fixtures/conformance/", import.meta.url);

async function fixtureBytes(name: string): Promise<Uint8Array> {
  return readFile(new URL(name, fixtureRoot));
}

describe("@mcd-nix/parser", () => {
  it("opens MCD packages from ArrayBuffer bytes", async () => {
    const bytes = await fixtureBytes("valid-minimal.mcd");
    const arrayBuffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    );
    const doc = await openMcd(arrayBuffer);

    expect(doc.validate()).toEqual({ valid: true, diagnostics: [] });
    expect(doc.blocks()[0]).toMatchObject({
      type: "heading",
      text: "Minimal",
    });
    expect(doc.annotations()).toEqual([]);
    expect(doc.markdown({ expandTables: true })).toContain("# Minimal");
  });

  it("validates conformance fixtures from bytes", async () => {
    const fixtures = await readdir(fixtureRoot);
    const mcdFixtures = fixtures.filter((fixture) => fixture.endsWith(".mcd"));

    for (const fixture of mcdFixtures) {
      const doc = await openMcd(await fixtureBytes(fixture));
      const validation = doc.validate();

      expect(validation.valid, fixture).toBe(fixture.startsWith("valid-"));
      if (!fixture.startsWith("valid-")) {
        expect(validation.diagnostics.length, fixture).toBeGreaterThan(0);
        expect(validation.diagnostics[0]?.level, fixture).toBe("error");
      }
    }
  });

  it("throws structured diagnostics for document exports that cannot parse", async () => {
    const doc = await openMcd(await fixtureBytes("invalid-bad-mimetype.mcd"));

    expect(() => doc.blocks()).toThrow(McdParserError);
    try {
      doc.blocks();
    } catch (error) {
      expect((error as McdParserError).diagnostic.code).toBe(
        "package.mimetype.invalid",
      );
    }
  });

  it("converts PDF bytes to MCD bytes", async () => {
    const bytes = await pdfToMcd(minimalPdf("Hello from PDF"));
    const doc = await openMcd(bytes);

    expect(doc.validate()).toEqual({ valid: true, diagnostics: [] });
    expect(doc.markdown()).toContain("Hello from PDF");
  });
});

function minimalPdf(text: string): Uint8Array {
  const escaped = text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const content = `BT /F1 24 Tf 100 700 Td (${escaped}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  offsets.forEach((offset) => {
    pdf += `${offset.toString().padStart(10, "0")} 00000 n \n`;
  });
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}
