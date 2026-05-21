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
export type DocumentBlock = HeadingBlock | ParagraphBlock | ListBlock | CodeBlock | QuoteBlock | MathBlock | TableRefBlock | ImageRefBlock;
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
export declare class McdParserError extends Error {
    readonly diagnostic: Diagnostic;
    constructor(diagnostic: Diagnostic);
}
export declare class McdDocument {
    #private;
    private constructor();
    static fromBytes(input: BytesLike): Promise<McdDocument>;
    validate(): ValidationResult;
    blocks(): DocumentBlock[];
    annotations(): AnnotationMetadata[];
    markdown(options?: MarkdownOptions): string;
}
export declare function openMcd(input: BytesLike): Promise<McdDocument>;
export declare function pdfToMcd(input: BytesLike): Promise<Uint8Array>;
//# sourceMappingURL=index.d.ts.map