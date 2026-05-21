import { wasmBase64 } from "./wasm-bytes.js";

export type BytesLike = Uint8Array | ArrayBuffer;

export interface Diagnostic {
  level: "error" | "warning" | "info";
  code: string;
  message: string;
  source?: string;
  related?: string[];
}

export interface ValidationResult {
  valid: boolean;
  diagnostics: Diagnostic[];
}

export interface AnnotationMetadata {
  id: string;
  target: Record<string, unknown>;
  kind: "comment" | "flag" | "proposed_change" | "question" | "todo";
  status: "open" | "accepted" | "rejected" | "resolved";
  body: string;
  author?: string;
  created?: string;
  labels?: string[];
  proposedChange?: {
    path: string;
    replace?: SourceSpan;
    text: string;
  };
}

export interface MarkdownOptions {
  expandTables?: boolean;
}

export type DocumentBlock =
  | HeadingBlock
  | ParagraphBlock
  | ListBlock
  | CodeBlock
  | QuoteBlock
  | MathBlock
  | TableRefBlock
  | ImageRefBlock;

export interface SourceSpan {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

export interface HeadingBlock {
  type: "heading";
  id: string;
  level: number;
  text: string;
  source?: SourceSpan;
  annotations?: AnnotationRef[];
}

export interface ParagraphBlock {
  type: "paragraph";
  id: string;
  text: string;
  source?: SourceSpan;
  annotations?: AnnotationRef[];
}

export interface ListBlock {
  type: "list";
  id: string;
  text: string;
  source?: SourceSpan;
  annotations?: AnnotationRef[];
}

export interface CodeBlock {
  type: "code_block";
  id: string;
  language?: string;
  text: string;
  source?: SourceSpan;
}

export interface QuoteBlock {
  type: "quote";
  id: string;
  text: string;
  source?: SourceSpan;
  annotations?: AnnotationRef[];
}

export interface MathBlock {
  type: "math_block";
  id: string;
  text: string;
  source?: SourceSpan;
}

export interface TableRefBlock {
  type: "table_ref";
  id: string;
  placement: Record<string, unknown>;
  source?: SourceSpan;
}

export interface ImageRefBlock {
  type: "image_ref";
  id: string;
  placement: Record<string, unknown>;
  source?: SourceSpan;
}

export interface AnnotationRef {
  id: string;
  textOffset?: number;
}

export class McdParserError extends Error {
  readonly diagnostic: Diagnostic;

  constructor(diagnostic: Diagnostic) {
    super(diagnostic.message);
    this.name = "McdParserError";
    this.diagnostic = diagnostic;
  }
}

export class McdDocument {
  readonly #bytes: Uint8Array;
  readonly #wasm: WasmExports;

  private constructor(bytes: Uint8Array, wasm: WasmExports) {
    this.#bytes = bytes;
    this.#wasm = wasm;
  }

  static async fromBytes(input: BytesLike): Promise<McdDocument> {
    return new McdDocument(toBytes(input), await loadWasm());
  }

  validate(): ValidationResult {
    return JSON.parse(callWasm(this.#wasm, "mcd_validate", this.#bytes));
  }

  blocks(): DocumentBlock[] {
    return JSON.parse(callWasm(this.#wasm, "mcd_blocks", this.#bytes));
  }

  annotations(): AnnotationMetadata[] {
    return JSON.parse(callWasm(this.#wasm, "mcd_annotations", this.#bytes))
      .annotations;
  }

  markdown(options: MarkdownOptions = {}): string {
    return callWasm(
      this.#wasm,
      "mcd_markdown",
      this.#bytes,
      options.expandTables === true ? 1 : 0,
    );
  }
}

export async function openMcd(input: BytesLike): Promise<McdDocument> {
  return McdDocument.fromBytes(input);
}

export async function pdfToMcd(input: BytesLike): Promise<Uint8Array> {
  return callWasmBytes(await loadWasm(), "mcd_pdf_to_mcd", toBytes(input));
}

type WasmOperation =
  | "mcd_validate"
  | "mcd_blocks"
  | "mcd_annotations"
  | "mcd_markdown"
  | "mcd_pdf_to_mcd";

type BinaryWasmOperation = "mcd_pdf_to_mcd";

interface WasmExports {
  memory: WebAssembly.Memory;
  mcd_alloc(len: number): number;
  mcd_free(ptr: number, len: number): void;
  mcd_output_ptr(): number;
  mcd_output_len(): number;
  mcd_validate(ptr: number, len: number): number;
  mcd_blocks(ptr: number, len: number): number;
  mcd_annotations(ptr: number, len: number): number;
  mcd_markdown(ptr: number, len: number, expandTables: number): number;
  mcd_pdf_to_mcd(ptr: number, len: number): number;
}

interface WasmErrorPayload {
  diagnostic: Diagnostic;
}

function callWasmBytes(
  wasm: WasmExports,
  operation: BinaryWasmOperation,
  bytes: Uint8Array,
): Uint8Array {
  const ptr = wasm.mcd_alloc(bytes.byteLength);
  try {
    new Uint8Array(wasm.memory.buffer).set(bytes, ptr);
    const status = wasm[operation](ptr, bytes.byteLength);
    const output = readOutputBytes(wasm);
    if (status !== 0) {
      throw errorFromPayload(new TextDecoder().decode(output));
    }
    return output;
  } finally {
    wasm.mcd_free(ptr, bytes.byteLength);
  }
}

let wasmPromise: Promise<WasmExports> | undefined;

async function loadWasm(): Promise<WasmExports> {
  wasmPromise ??= WebAssembly.compile(decodeBase64(wasmBase64)).then(
    async (module) =>
      (await WebAssembly.instantiate(module, {})).exports as unknown as WasmExports,
  );
  return wasmPromise;
}

function callWasm(
  wasm: WasmExports,
  operation: WasmOperation,
  bytes: Uint8Array,
  option = 0,
): string {
  const ptr = wasm.mcd_alloc(bytes.byteLength);
  try {
    new Uint8Array(wasm.memory.buffer).set(bytes, ptr);
    const status =
      operation === "mcd_markdown"
        ? wasm.mcd_markdown(ptr, bytes.byteLength, option)
        : wasm[operation](ptr, bytes.byteLength);
    const output = readOutput(wasm);
    if (status !== 0) {
      throw errorFromPayload(output);
    }
    return output;
  } finally {
    wasm.mcd_free(ptr, bytes.byteLength);
  }
}

function readOutput(wasm: WasmExports): string {
  return new TextDecoder().decode(readOutputBytes(wasm));
}

function readOutputBytes(wasm: WasmExports): Uint8Array {
  const ptr = wasm.mcd_output_ptr();
  const len = wasm.mcd_output_len();
  const bytes = new Uint8Array(wasm.memory.buffer, ptr, len);
  return new Uint8Array(bytes);
}

function errorFromPayload(output: string): McdParserError {
  try {
    return new McdParserError((JSON.parse(output) as WasmErrorPayload).diagnostic);
  } catch {
    return new McdParserError({
      level: "error",
      code: "wasm.error.decode",
      message: output,
    });
  }
}

function toBytes(input: BytesLike): Uint8Array {
  if (input instanceof Uint8Array) {
    return new Uint8Array(input);
  }
  return new Uint8Array(input.slice(0));
}

function decodeBase64(value: string): ArrayBuffer {
  const binary = globalThis.atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}
