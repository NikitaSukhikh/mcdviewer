var __classPrivateFieldSet = (this && this.__classPrivateFieldSet) || function (receiver, state, value, kind, f) {
    if (kind === "m") throw new TypeError("Private method is not writable");
    if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a setter");
    if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot write private member to an object whose class did not declare it");
    return (kind === "a" ? f.call(receiver, value) : f ? f.value = value : state.set(receiver, value)), value;
};
var __classPrivateFieldGet = (this && this.__classPrivateFieldGet) || function (receiver, state, kind, f) {
    if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a getter");
    if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot read private member from an object whose class did not declare it");
    return kind === "m" ? f : kind === "a" ? f.call(receiver) : f ? f.value : state.get(receiver);
};
var _McdDocument_bytes, _McdDocument_wasm;
import { wasmBase64 } from "./wasm-bytes.js";
export class McdParserError extends Error {
    constructor(diagnostic) {
        super(diagnostic.message);
        this.name = "McdParserError";
        this.diagnostic = diagnostic;
    }
}
export class McdDocument {
    constructor(bytes, wasm) {
        _McdDocument_bytes.set(this, void 0);
        _McdDocument_wasm.set(this, void 0);
        __classPrivateFieldSet(this, _McdDocument_bytes, bytes, "f");
        __classPrivateFieldSet(this, _McdDocument_wasm, wasm, "f");
    }
    static async fromBytes(input) {
        return new McdDocument(toBytes(input), await loadWasm());
    }
    validate() {
        return JSON.parse(callWasm(__classPrivateFieldGet(this, _McdDocument_wasm, "f"), "mcd_validate", __classPrivateFieldGet(this, _McdDocument_bytes, "f")));
    }
    blocks() {
        return JSON.parse(callWasm(__classPrivateFieldGet(this, _McdDocument_wasm, "f"), "mcd_blocks", __classPrivateFieldGet(this, _McdDocument_bytes, "f")));
    }
    annotations() {
        return JSON.parse(callWasm(__classPrivateFieldGet(this, _McdDocument_wasm, "f"), "mcd_annotations", __classPrivateFieldGet(this, _McdDocument_bytes, "f")))
            .annotations;
    }
    markdown(options = {}) {
        return callWasm(__classPrivateFieldGet(this, _McdDocument_wasm, "f"), "mcd_markdown", __classPrivateFieldGet(this, _McdDocument_bytes, "f"), options.expandTables === true ? 1 : 0);
    }
}
_McdDocument_bytes = new WeakMap(), _McdDocument_wasm = new WeakMap();
export async function openMcd(input) {
    return McdDocument.fromBytes(input);
}
export async function pdfToMcd(input) {
    return callWasmBytes(await loadWasm(), "mcd_pdf_to_mcd", toBytes(input));
}
function callWasmBytes(wasm, operation, bytes) {
    const ptr = wasm.mcd_alloc(bytes.byteLength);
    try {
        new Uint8Array(wasm.memory.buffer).set(bytes, ptr);
        const status = wasm[operation](ptr, bytes.byteLength);
        const output = readOutputBytes(wasm);
        if (status !== 0) {
            throw errorFromPayload(new TextDecoder().decode(output));
        }
        return output;
    }
    finally {
        wasm.mcd_free(ptr, bytes.byteLength);
    }
}
let wasmPromise;
async function loadWasm() {
    wasmPromise ?? (wasmPromise = WebAssembly.compile(decodeBase64(wasmBase64)).then(async (module) => (await WebAssembly.instantiate(module, {})).exports));
    return wasmPromise;
}
function callWasm(wasm, operation, bytes, option = 0) {
    const ptr = wasm.mcd_alloc(bytes.byteLength);
    try {
        new Uint8Array(wasm.memory.buffer).set(bytes, ptr);
        const status = operation === "mcd_markdown"
            ? wasm.mcd_markdown(ptr, bytes.byteLength, option)
            : wasm[operation](ptr, bytes.byteLength);
        const output = readOutput(wasm);
        if (status !== 0) {
            throw errorFromPayload(output);
        }
        return output;
    }
    finally {
        wasm.mcd_free(ptr, bytes.byteLength);
    }
}
function readOutput(wasm) {
    return new TextDecoder().decode(readOutputBytes(wasm));
}
function readOutputBytes(wasm) {
    const ptr = wasm.mcd_output_ptr();
    const len = wasm.mcd_output_len();
    const bytes = new Uint8Array(wasm.memory.buffer, ptr, len);
    return new Uint8Array(bytes);
}
function errorFromPayload(output) {
    try {
        return new McdParserError(JSON.parse(output).diagnostic);
    }
    catch {
        return new McdParserError({
            level: "error",
            code: "wasm.error.decode",
            message: output,
        });
    }
}
function toBytes(input) {
    if (input instanceof Uint8Array) {
        return new Uint8Array(input);
    }
    return new Uint8Array(input.slice(0));
}
function decodeBase64(value) {
    const binary = globalThis.atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
    }
    return bytes.buffer;
}
