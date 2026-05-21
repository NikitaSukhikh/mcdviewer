import {
  openMcd,
  type Diagnostic,
  type DocumentBlock,
  type SourceSpan,
  type ValidationResult,
} from "@mcd/parser";
import DOMPurify from "dompurify";
import JSZip from "jszip";
import katex from "katex";
import { marked, type Tokens } from "marked";
import Papa from "papaparse";

import "katex/dist/katex.min.css";
import "./styles.css";

const MCD_MIMETYPE = "application/vnd.mcd+zip";
const UNSAVED_CHANGES_PROMPT = "Save changes?";
const DEFAULT_ENTRYPOINT = "content/main.md";
const HISTORY_LIMIT = 20;
const HISTORY_GROUP_IDLE_MS = 1200;
const EMPTY_FIRST_HEADING_ID = "mcd-empty-first-heading";
const RESERVED_ROW_HEADER_COLUMN = "row_header";
const MIN_PREVIEW_TABLE_SCROLL_HEIGHT = 180;
const LAZY_PREVIEW_TABLE_ROOT_MARGIN = 900;
const VIRTUAL_TABLE_ROW_HEIGHT = 38;
const VIRTUAL_TABLE_OVERSCAN_ROWS = 8;
const EDITOR_VIRTUAL_TABLE_ROW_HEIGHT = 35;
const EDITOR_VIRTUAL_TABLE_OVERSCAN_ROWS = 8;
const textDecoder = new TextDecoder();
type ActiveTab = "text" | "tables" | "annotations";

marked.use({
  gfm: true,
  breaks: true,
  renderer: {
    code({ text, lang }: Tokens.Code): string | false {
      if (lang?.trim().toLowerCase() === "math") {
        return renderMath(text, true);
      }
      return false;
    },
  },
  extensions: [
    {
      name: "displayMath",
      level: "block",
      start(src: string): number | void {
        return src.match(/\$\$/)?.index;
      },
      tokenizer(src: string): Tokens.Generic | undefined {
        const match = /^\$\$[ \t]*\n?([\s\S]+?)\n?\$\$(?:\n+|$)/.exec(src);
        if (!match) {
          return undefined;
        }
        return {
          type: "displayMath",
          raw: match[0],
          text: match[1]?.trim() ?? "",
        };
      },
      renderer(token: Tokens.Generic): string {
        return renderMath(String(token.text ?? ""), true);
      },
    },
    {
      name: "inlineMath",
      level: "inline",
      start(src: string): number | void {
        const dollar = src.indexOf("$");
        const paren = src.indexOf("\\(");
        if (dollar === -1) {
          return paren === -1 ? undefined : paren;
        }
        if (paren === -1) {
          return dollar;
        }
        return Math.min(dollar, paren);
      },
      tokenizer(src: string): Tokens.Generic | undefined {
        const parenMatch = /^\\\(([\s\S]+?)\\\)/.exec(src);
        if (parenMatch) {
          return {
            type: "inlineMath",
            raw: parenMatch[0],
            text: parenMatch[1]?.trim() ?? "",
          };
        }

        const dollarMatch = /^\$(?!\s|\$)((?:\\.|[^\\$\n])+?)(?<!\s)\$(?!\$)/.exec(src);
        if (!dollarMatch) {
          return undefined;
        }
        return {
          type: "inlineMath",
          raw: dollarMatch[0],
          text: dollarMatch[1]?.trim() ?? "",
        };
      },
      renderer(token: Tokens.Generic): string {
        return renderMath(String(token.text ?? ""), false);
      },
    },
  ],
});

interface Manifest {
  format: "MCD";
  version: "0.1";
  profile: string;
  entrypoint: string;
  title?: string;
  tables?: TableManifestEntry[];
  images?: ImageManifestEntry[];
  annotations?: AnnotationManifestEntry[];
  assets?: AssetManifestEntry[];
  layout?: LayoutManifestEntry;
  [key: string]: unknown;
}

interface LayoutManifestEntry {
  styles?: string;
  pageMap?: string;
  [key: string]: unknown;
}

interface PageMap {
  pages: PageMapPage[];
}

interface PageMapPage {
  number: number;
  label?: string;
  sourceRefs?: string[];
  assets?: string[];
  rendered?: string;
}

interface TableManifestEntry {
  id: string;
  data: string;
  schema: string;
  views?: Record<string, string>;
}

interface ImageManifestEntry {
  id: string;
  metadata: string;
}

interface AssetManifestEntry {
  id?: string;
  path: string;
}

interface AnnotationManifestEntry {
  id: string;
  metadata: string;
}

interface TableColumn {
  name: string;
  type: string;
  label?: string;
  nullable?: boolean;
}

interface TableSchema {
  id: string;
  columns: TableColumn[];
}

interface TableViewColumn {
  name: string;
  label?: string;
  format?: string;
  currency?: string;
  unit?: string;
  percent?: boolean;
}

interface TableChartEncoding {
  column: string;
  label?: string;
  format?: string;
  currency?: string;
  unit?: string;
  percent?: boolean;
}

interface TableView {
  id: string;
  table: string;
  display?: "table" | "chart";
  columns?: TableViewColumn[];
  style?: TableViewStyle;
  chart?: {
    x?: TableChartEncoding;
    y?: TableChartEncoding;
    series?: TableChartEncoding;
    grouping?: TableChartEncoding;
    markLabels?: Partial<TableChartEncoding> & { show?: boolean };
  };
}

interface TableViewStyle {
  showColumnHeaders?: boolean;
  showRowHeaders?: boolean;
  [key: string]: unknown;
}

interface EditableTable {
  manifest: TableManifestEntry;
  schema: TableSchema;
  views: Record<string, TableView>;
  rows: Record<string, string>[];
}

interface TablePlacement {
  table: string;
  view?: string;
  display: "table" | "chart";
  caption?: string;
  source?: SourceSpan;
}

interface PreviewLazyTable {
  placement: TablePlacement;
}

interface PreviewVirtualTable {
  table: EditableTable;
  placement: TablePlacement;
  columns: Array<TableViewColumn & { label: string; schema: TableColumn }>;
  tbody: HTMLTableSectionElement;
  wrapper: HTMLDivElement;
  rowHeight: number;
  visibleStart: number;
  visibleEnd: number;
}

interface EditorVirtualTable {
  table: EditableTable;
  tbody: HTMLTableSectionElement;
  wrapper: HTMLDivElement;
  rowHeight: number;
  visibleStart: number;
  visibleEnd: number;
}

interface InsertLineTarget {
  body: HTMLDivElement;
  y: number;
}

interface PendingInsertionAlignment {
  kind: "table" | "image";
  id: string;
  pageNumber: number;
  desiredTop: number;
}

type EditableTextBlock = Extract<
  DocumentBlock,
  { type: "heading" | "paragraph" | "list" | "quote" }
>;

interface InlineTableBinding {
  row: Record<string, string>;
  column: TableViewColumn & { label: string; schema: TableColumn };
}

interface InlineTableHeaderBinding {
  table: EditableTable;
  placement: TablePlacement;
  column: TableViewColumn & { label: string; schema: TableColumn };
}

interface InlineTextBinding {
  block?: EditableTextBlock;
  source?: SourceSpan;
  headingSplit?: InlineHeadingSplitBinding;
}

interface InlineHeadingSplitBinding {
  block: Extract<EditableTextBlock, { type: "heading" }>;
  source: SourceSpan;
  heading: HTMLElement;
  continuation: HTMLElement;
}

interface EditableAnnotation {
  id: string;
  metadata: string;
  targetText: string;
  page: string;
  line: string;
  kind: string;
  status: string;
  body: string;
  author: string;
  labels: string;
  created: string;
  originalMetadata?: string;
}

interface AnnotationPreviewItem {
  id: string;
  number: number;
  annotation: EditableAnnotation;
  line: number;
  hasInlineMarker: boolean;
  manualLocation?: { page: number; line: number };
}

interface RenderedLogicalLine {
  body: HTMLDivElement;
  top: number;
  bottom: number;
  sourceLine: number;
}

interface AnnotationPageLocation {
  page: number;
  line: number;
  top?: number;
  renderedPage?: number;
}

interface PackageState {
  fileName: string;
  zip: JSZip;
  manifest: Manifest;
  markdown: string;
  blocks: DocumentBlock[];
  tables: EditableTable[];
  annotations: EditableAnnotation[];
  pageMap?: PageMap;
  pageMapPath?: string;
  removedAnnotationPaths: Set<string>;
  dirty: boolean;
  plainMarkdownInput: boolean;
}

interface StateSnapshot {
  manifest: Manifest;
  markdown: string;
  tables: EditableTable[];
  annotations: EditableAnnotation[];
  pageMap?: PageMap;
  pageMapPath?: string;
  removedAnnotationPaths: string[];
  pendingMarginAnnotationId?: string;
  pendingWordAnnotationId?: string;
}

interface SaveFilePickerWindow extends Window {
  showSaveFilePicker?: (options: {
    suggestedName?: string;
    types?: Array<{
      description: string;
      accept: Record<string, string[]>;
    }>;
  }) => Promise<{
    createWritable: () => Promise<{
      write: (data: Blob) => Promise<void>;
      close: () => Promise<void>;
    }>;
  }>;
}

let state: PackageState | undefined;
let activeTab: ActiveTab = "text";
let renderTimer: number | undefined;
let assetUrls: string[] = [];
let expandedAnnotationIds = new Set<string>();
let previewEditMode = false;
let sidebarExpanded = false;
let inlineTextBindings = new WeakMap<HTMLElement, InlineTextBinding>();
let inlineTableBindings = new WeakMap<HTMLElement, InlineTableBinding>();
let inlineTableHeaderBindings = new WeakMap<HTMLElement, InlineTableHeaderBinding>();
let previewBlockSources = new WeakMap<HTMLElement, SourceSpan>();
let renderedAnnotationLocations = new Map<string, AnnotationPageLocation>();
let manualAnnotationLocations = new Map<string, AnnotationPageLocation>();
let renderedLogicalPageLines = new Map<number, RenderedLogicalLine[]>();
let locallySavedAnnotationIds = new Set<string>();
let pendingMarginAnnotationId: string | undefined;
let pendingWordAnnotationId: string | undefined;
let annotationWordPickArmed = false;
let pendingInsertionAlignments: PendingInsertionAlignment[] = [];
let undoStack: StateSnapshot[] = [];
let redoStack: StateSnapshot[] = [];
let activeHistoryGroupKey: string | undefined;
let historyGroupTimer: number | undefined;
let savedContentKey = "";
let activeModal: HTMLElement | undefined;
let previewAutoDoneTimer: number | undefined;
let previewTableRepaginateFrame: number | undefined;
let previewLazyTableObserver: IntersectionObserver | undefined;
let tablesEditorObserver: IntersectionObserver | undefined;
let previewLazyTables: PreviewLazyTable[] = [];
let previewVirtualTables = new WeakMap<HTMLDivElement, PreviewVirtualTable>();
let editorVirtualTables = new WeakMap<HTMLDivElement, EditorVirtualTable>();

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) {
  throw new Error("Missing #app root.");
}

app.innerHTML = `
  <div class="app-shell">
    <header class="topbar">
      <div class="brand">
        <img class="brand-logo" src="/MCD_logo_tight.png" alt="MCD" />
        <div class="brand-title">Viewer</div>
      </div>
      <div class="file-name" id="fileName"></div>
      <div class="toolbar">
        <button id="openButton" type="button">Upload</button>
        <button id="createButton" type="button">Create</button>
        <button id="topEditModeButton" type="button" disabled aria-pressed="false">Edit</button>
        <button id="topSaveButton" class="primary" type="button" disabled>Save</button>
      </div>
    </header>
    <main class="workspace is-sidebar-folded" id="workspace">
      <section class="editor-pane" id="editorPane">
        <div class="sidebar-strip">
          <div class="sidebar-control-stack">
            <button id="sidebarToggle" class="sidebar-toggle" type="button" aria-expanded="false" aria-label="Unfold sidebar" title="Unfold sidebar">
              <span class="sidebar-toggle-icon" aria-hidden="true"></span>
            </button>
            <button id="undoButton" class="sidebar-action" type="button" aria-label="Undo" title="Undo" disabled>
              <span class="sidebar-history-icon is-undo" aria-hidden="true"></span>
            </button>
            <button id="redoButton" class="sidebar-action" type="button" aria-label="Redo" title="Redo" disabled>
              <span class="sidebar-history-icon is-redo" aria-hidden="true"></span>
            </button>
            <button id="quickAnnotationButton" class="sidebar-action sidebar-annotation-action" type="button" aria-label="Add annotation" title="Add annotation" disabled>
              <span aria-hidden="true">+</span>
            </button>
          </div>
        </div>
        <div class="editor-content">
          <input id="fileInput" class="hidden-input" type="file" accept=".mcd,application/zip,application/vnd.mcd+zip,text/markdown,text/plain" />
          <div class="status-panel">
            <div class="status-line" id="statusLine"></div>
            <div class="diagnostics" id="diagnostics"></div>
          </div>
          <nav class="tabs" aria-label="Editor sections">
            <button class="tab" id="tabText" type="button" aria-selected="true">Text</button>
            <button class="tab" id="tabTables" type="button" aria-selected="false">Tables</button>
            <button class="tab" id="tabAnnotations" type="button" aria-selected="false">Annotations</button>
          </nav>
          <section class="panel is-active" id="textPanel">
            <div class="field">
              <label for="markdownEditor">Markdown entrypoint</label>
              <div class="markdown-editor-shell">
                <pre id="markdownHighlight" class="markdown-highlight" aria-hidden="true"></pre>
                <textarea id="markdownEditor" spellcheck="false" disabled></textarea>
              </div>
            </div>
          </section>
          <section class="panel" id="tablesPanel">
            <div class="list-stack" id="tablesEditor"></div>
          </section>
          <section class="panel" id="annotationsPanel">
            <div class="table-actions">
              <button id="addAnnotationButton" class="primary" type="button" disabled>Add annotation</button>
            </div>
            <div class="list-stack" id="annotationsEditor"></div>
          </section>
        </div>
      </section>
      <section class="preview-pane" id="previewPane">
        <article class="preview-document is-empty" id="preview">
          ${emptyDropZoneHtml()}
        </article>
      </section>
    </main>
    <div class="floating-actions" id="floatingActions" aria-label="Document actions" hidden>
      <button id="floatingEditModeButton" type="button" disabled aria-pressed="false">Edit</button>
      <button id="floatingSaveButton" class="primary" type="button" disabled>Save</button>
    </div>
  </div>
`;

const fileNameEl = byId<HTMLDivElement>("fileName");
const workspace = byId<HTMLElement>("workspace");
const fileInput = byId<HTMLInputElement>("fileInput");
const openButton = byId<HTMLButtonElement>("openButton");
const createButton = byId<HTMLButtonElement>("createButton");
const editModeButtons = [
  byId<HTMLButtonElement>("topEditModeButton"),
  byId<HTMLButtonElement>("floatingEditModeButton"),
];
const saveButtons = [
  byId<HTMLButtonElement>("topSaveButton"),
  byId<HTMLButtonElement>("floatingSaveButton"),
];
const sidebarToggle = byId<HTMLButtonElement>("sidebarToggle");
const foundSidebarStrip = sidebarToggle.closest<HTMLElement>(".sidebar-strip");
if (!foundSidebarStrip) {
  throw new Error("Missing sidebar strip.");
}
const sidebarStrip = foundSidebarStrip;
const undoButton = byId<HTMLButtonElement>("undoButton");
const redoButton = byId<HTMLButtonElement>("redoButton");
const quickAnnotationButton = byId<HTMLButtonElement>("quickAnnotationButton");
const statusLine = byId<HTMLDivElement>("statusLine");
const diagnosticsEl = byId<HTMLDivElement>("diagnostics");
const markdownHighlight = byId<HTMLPreElement>("markdownHighlight");
const markdownEditor = byId<HTMLTextAreaElement>("markdownEditor");
const tablesEditor = byId<HTMLDivElement>("tablesEditor");
const foundEditorContent = tablesEditor.closest<HTMLElement>(".editor-content");
if (!foundEditorContent) {
  throw new Error("Missing editor content.");
}
const editorContent = foundEditorContent;
const annotationsEditor = byId<HTMLDivElement>("annotationsEditor");
const addAnnotationButton = byId<HTMLButtonElement>("addAnnotationButton");
const previewPane = byId<HTMLElement>("previewPane");
const preview = byId<HTMLElement>("preview");
const floatingActions = byId<HTMLDivElement>("floatingActions");

openButton.addEventListener("click", () => fileInput.click());
createButton.addEventListener("click", () => {
  void createDocument();
});
sidebarToggle.addEventListener("click", () => {
  setSidebarExpanded(!sidebarExpanded);
});
undoButton.addEventListener("click", () => {
  void undoOperation();
});
redoButton.addEventListener("click", () => {
  void redoOperation();
});
quickAnnotationButton.addEventListener("click", () => {
  armWordAnnotationPick();
});

fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (file) {
    void loadFile(file);
  }
  fileInput.value = "";
});

for (const button of editModeButtons) {
  button.addEventListener("click", () => {
    setPreviewEditMode(!previewEditMode);
  });
}

for (const button of saveButtons) {
  button.addEventListener("click", () => {
    void saveDocument();
  });
}

previewPane.addEventListener("scroll", syncFloatingActions);
window.addEventListener("scroll", syncFloatingActions);
window.addEventListener("resize", syncPreviewTableScrollers);

window.addEventListener("beforeunload", (event) => {
  if (!state?.dirty) {
    return;
  }
  event.preventDefault();
  event.returnValue = UNSAVED_CHANGES_PROMPT;
});

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && activeModal) {
    closeActiveModal();
    return;
  }
  if (event.key === "Escape" && annotationWordPickArmed) {
    cancelWordAnnotationPick();
  }
});

preview.addEventListener("dragover", (event: DragEvent) => {
  if (state) return;
  const dropZone = preview.querySelector<HTMLDivElement>("#dropZone");
  if (!dropZone) return;
  event.preventDefault();
  dropZone.classList.add("is-active");
});

preview.addEventListener("dragleave", (event: DragEvent) => {
  if (state) return;
  const dropZone = preview.querySelector<HTMLDivElement>("#dropZone");
  if (!dropZone) return;
  if (!preview.contains(event.relatedTarget as Node)) {
    dropZone.classList.remove("is-active");
  }
});

preview.addEventListener("drop", (event: DragEvent) => {
  if (state) return;
  const dropZone = preview.querySelector<HTMLDivElement>("#dropZone");
  if (!dropZone) return;
  event.preventDefault();
  dropZone.classList.remove("is-active");
  const file = event.dataTransfer?.files[0];
  if (file) {
    void loadFile(file);
  }
});

preview.addEventListener("click", (event) => {
  const dropZone = (event.target as Element | null)?.closest<HTMLDivElement>("#dropZone");
  if (!state && dropZone && preview.contains(dropZone)) {
    fileInput.click();
    return;
  }

  const link = (event.target as Element | null)?.closest<HTMLAnchorElement>(
    'a[href^="#mcd-annotation"]',
  );
  if (!link) {
    createAnnotationFromWordClick(event);
    return;
  }
  const targetId = link.getAttribute("href")?.slice(1);
  if (!targetId) {
    return;
  }
  const target = document.getElementById(targetId);
  if (!target || !preview.contains(target)) {
    return;
  }
  event.preventDefault();
  target.setAttribute("tabindex", "-1");
  target.scrollIntoView({ behavior: "smooth", block: "center" });
  target.focus({ preventScroll: true });
});

preview.addEventListener("focusout", (event) => {
  if (!state || !previewEditMode) {
    return;
  }
  const target = event.target as Element | null;
  if (!target?.closest(".inline-editable, .inline-edit-target, .preview-table-wrap")) {
    return;
  }
  const next = event.relatedTarget as Element | null;
  if (next?.closest(".inline-editable, .inline-edit-target, .preview-table-wrap, .mcd-insert-text-target, .mcd-insert-plus")) {
    return;
  }
  schedulePreviewEditAutoDone();
});

preview.addEventListener("keydown", (event: KeyboardEvent) => {
  if (state) return;
  const dropZone = (event.target as Element | null)?.closest<HTMLDivElement>("#dropZone");
  if (!dropZone || !preview.contains(dropZone)) {
    return;
  }
  if (event.key !== "Enter" && event.key !== " ") {
    return;
  }
  event.preventDefault();
  fileInput.click();
});

markdownEditor.addEventListener("input", () => {
  syncMarkdownEditorHighlight();
  if (!state) {
    return;
  }
  if (state.markdown === markdownEditor.value) {
    return;
  }
  recordHistoryCheckpoint({ coalesceKey: "markdown-editor" });
  state.markdown = markdownEditor.value;
  markDirty();
});

markdownEditor.addEventListener("scroll", syncMarkdownEditorHighlightScroll);

for (const tab of ["Text", "Tables", "Annotations"] as const) {
  byId<HTMLButtonElement>(`tab${tab}`).addEventListener("click", () => {
    setActiveTab(tab.toLowerCase() as ActiveTab);
  });
}

addAnnotationButton.addEventListener("click", () => {
  armWordAnnotationPick();
});

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing #${id}.`);
  }
  return element as T;
}

function captureStateSnapshot(): StateSnapshot | undefined {
  if (!state) {
    return undefined;
  }
  return {
    manifest: cloneJson(state.manifest),
    markdown: state.markdown,
    tables: cloneJson(state.tables),
    annotations: cloneJson(state.annotations),
    pageMap: state.pageMap ? cloneJson(state.pageMap) : undefined,
    pageMapPath: state.pageMapPath,
    removedAnnotationPaths: [...state.removedAnnotationPaths].sort(),
    pendingMarginAnnotationId,
    pendingWordAnnotationId,
  };
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function snapshotKey(snapshot: StateSnapshot): string {
  return JSON.stringify(snapshot);
}

function contentKey(snapshot: StateSnapshot): string {
  return JSON.stringify({
    markdown: snapshot.markdown,
    tables: snapshot.tables,
    annotations: snapshot.annotations,
  });
}

function recordHistoryCheckpoint(options: { coalesceKey?: string } = {}): void {
  const snapshot = captureStateSnapshot();
  if (!snapshot) {
    return;
  }

  if (options.coalesceKey) {
    if (activeHistoryGroupKey === options.coalesceKey) {
      startHistoryGroup(options.coalesceKey);
      return;
    }
  } else {
    clearHistoryGroup();
  }

  pushHistorySnapshot(undoStack, snapshot);
  redoStack = [];
  if (options.coalesceKey) {
    startHistoryGroup(options.coalesceKey);
  }
  syncHistoryButtons();
}

function pushHistorySnapshot(stack: StateSnapshot[], snapshot: StateSnapshot): void {
  const previous = stack.at(-1);
  if (previous && snapshotKey(previous) === snapshotKey(snapshot)) {
    return;
  }
  stack.push(snapshot);
  if (stack.length > HISTORY_LIMIT) {
    stack.splice(0, stack.length - HISTORY_LIMIT);
  }
}

function startHistoryGroup(key: string): void {
  activeHistoryGroupKey = key;
  if (historyGroupTimer) {
    window.clearTimeout(historyGroupTimer);
  }
  historyGroupTimer = window.setTimeout(() => {
    if (activeHistoryGroupKey === key) {
      clearHistoryGroup();
    }
  }, HISTORY_GROUP_IDLE_MS);
}

function clearHistoryGroup(): void {
  activeHistoryGroupKey = undefined;
  if (historyGroupTimer) {
    window.clearTimeout(historyGroupTimer);
    historyGroupTimer = undefined;
  }
}

function resetHistory(): void {
  clearHistoryGroup();
  undoStack = [];
  redoStack = [];
  const snapshot = captureStateSnapshot();
  savedContentKey = snapshot ? contentKey(snapshot) : "";
  syncHistoryButtons();
}

async function undoOperation(): Promise<void> {
  if (!state || undoStack.length === 0) {
    return;
  }
  const current = captureStateSnapshot();
  const previous = undoStack.pop();
  if (!current || !previous) {
    return;
  }
  pushHistorySnapshot(redoStack, current);
  await restoreStateSnapshot(previous);
}

async function redoOperation(): Promise<void> {
  if (!state || redoStack.length === 0) {
    return;
  }
  const current = captureStateSnapshot();
  const next = redoStack.pop();
  if (!current || !next) {
    return;
  }
  pushHistorySnapshot(undoStack, current);
  await restoreStateSnapshot(next);
}

async function restoreStateSnapshot(snapshot: StateSnapshot): Promise<void> {
  if (!state) {
    return;
  }
  clearHistoryGroup();
  state.manifest = cloneJson(snapshot.manifest);
  state.markdown = snapshot.markdown;
  state.tables = cloneJson(snapshot.tables);
  state.annotations = cloneJson(snapshot.annotations);
  state.pageMap = snapshot.pageMap ? cloneJson(snapshot.pageMap) : undefined;
  state.pageMapPath = snapshot.pageMapPath;
  state.removedAnnotationPaths = new Set(snapshot.removedAnnotationPaths);

  const annotationIds = new Set(state.annotations.map((annotation) => annotation.id));
  expandedAnnotationIds = new Set([...expandedAnnotationIds].filter((id) => annotationIds.has(id)));
  locallySavedAnnotationIds = new Set(
    [...locallySavedAnnotationIds].filter((id) => annotationIds.has(id)),
  );
  renderedAnnotationLocations = new Map(
    [...renderedAnnotationLocations].filter(([id]) => annotationIds.has(id)),
  );
  manualAnnotationLocations = new Map(
    [...manualAnnotationLocations].filter(([id]) => annotationIds.has(id)),
  );
  pendingMarginAnnotationId =
    snapshot.pendingMarginAnnotationId && annotationIds.has(snapshot.pendingMarginAnnotationId)
      ? snapshot.pendingMarginAnnotationId
      : undefined;
  pendingWordAnnotationId =
    snapshot.pendingWordAnnotationId && annotationIds.has(snapshot.pendingWordAnnotationId)
      ? snapshot.pendingWordAnnotationId
      : undefined;
  renderedLogicalPageLines = new Map();

  const restored = captureStateSnapshot();
  state.dirty = restored ? contentKey(restored) !== savedContentKey : true;
  hydrateUiFromState();
  await renderAndValidate();
  syncHistoryButtons();
}

function syncHistoryButtons(): void {
  const hasState = Boolean(state);
  undoButton.disabled = !hasState || undoStack.length === 0;
  redoButton.disabled = !hasState || redoStack.length === 0;
}

async function loadFile(file: File): Promise<void> {
  setStatus(`Opening ${file.name}...`);
  clearDiagnostics();
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    state = await loadPackage(file.name, bytes);
    expandedAnnotationIds = new Set();
    locallySavedAnnotationIds = new Set();
    pendingMarginAnnotationId = undefined;
    pendingWordAnnotationId = undefined;
    renderedAnnotationLocations = new Map();
    manualAnnotationLocations = new Map();
    renderedLogicalPageLines = new Map();
    resetHistory();
    previewPane.scrollTop = 0;
    window.scrollTo({ top: 0, left: 0 });
    hydrateUiFromState();
    await renderAndValidate();
  } catch (error) {
    state = undefined;
    expandedAnnotationIds = new Set();
    locallySavedAnnotationIds = new Set();
    pendingMarginAnnotationId = undefined;
    pendingWordAnnotationId = undefined;
    renderedAnnotationLocations = new Map();
    manualAnnotationLocations = new Map();
    renderedLogicalPageLines = new Map();
    resetHistory();
    hydrateUiFromState();
    showError(error);
  }
}

async function createDocument(): Promise<void> {
  setStatus("Creating empty MCD document...");
  clearDiagnostics();
  state = createDefaultPackageState();
  expandedAnnotationIds = new Set();
  locallySavedAnnotationIds = new Set();
  pendingMarginAnnotationId = undefined;
  pendingWordAnnotationId = undefined;
  renderedAnnotationLocations = new Map();
  manualAnnotationLocations = new Map();
  renderedLogicalPageLines = new Map();
  previewEditMode = false;
  resetHistory();
  previewPane.scrollTop = 0;
  window.scrollTo({ top: 0, left: 0 });
  setActiveTab("text");
  setSidebarExpanded(true);
  hydrateUiFromState();
  await renderAndValidate();
  markdownEditor.focus();
  setStatus("Created empty MCD document.");
}

function createDefaultPackageState(): PackageState {
  const zip = new JSZip();
  const manifest: Manifest = {
    format: "MCD",
    version: "0.1",
    profile: "MCD-Core",
    entrypoint: DEFAULT_ENTRYPOINT,
    tables: [],
    images: [],
    annotations: [],
    assets: [],
  };

  zip.file("mimetype", `${MCD_MIMETYPE}\n`, { compression: "STORE" });
  zip.file("manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
  zip.file(DEFAULT_ENTRYPOINT, "");
  zip.folder("tables");
  zip.folder("images");
  zip.folder("assets");

  return {
    fileName: "untitled.mcd",
    zip,
    manifest,
    markdown: "",
    blocks: [],
    tables: [],
    annotations: [],
    removedAnnotationPaths: new Set(),
    dirty: false,
    plainMarkdownInput: false,
  };
}

async function loadPackage(fileName: string, bytes: Uint8Array): Promise<PackageState> {
  let zip: JSZip;
  let plainMarkdownInput = false;

  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    plainMarkdownInput = true;
    zip = new JSZip();
    zip.file("mimetype", `${MCD_MIMETYPE}\n`, { compression: "STORE" });
    zip.file(
      "manifest.json",
      JSON.stringify(
        {
          format: "MCD",
          version: "0.1",
          profile: "MCD-Core",
          entrypoint: DEFAULT_ENTRYPOINT,
        },
        null,
        2,
      ),
    );
    zip.file(DEFAULT_ENTRYPOINT, textDecoder.decode(bytes));
  }

  const manifest = await readManifest(zip);
  const markdown = await readText(zip, manifest.entrypoint);
  const blocks = plainMarkdownInput ? [] : await readDocumentBlocks(bytes);
  const tables = await readTables(zip, manifest.tables ?? []);
  const { pageMap, pageMapPath } = await readPageMap(zip, manifest);
  const annotations = await readAnnotations(
    zip,
    manifest.annotations ?? [],
    manifest.entrypoint,
    markdown,
    pageMap,
    blocks,
  );

  return {
    fileName,
    zip,
    manifest,
    markdown,
    blocks,
    tables,
    annotations,
    pageMap,
    pageMapPath,
    removedAnnotationPaths: new Set(),
    dirty: false,
    plainMarkdownInput,
  };
}

async function readManifest(zip: JSZip): Promise<Manifest> {
  const manifestText = await readText(zip, "manifest.json");
  return JSON.parse(manifestText) as Manifest;
}

async function readTables(
  zip: JSZip,
  entries: TableManifestEntry[],
): Promise<EditableTable[]> {
  const tables: EditableTable[] = [];
  for (const entry of entries) {
    const schema = JSON.parse(await readText(zip, entry.schema)) as TableSchema;
    const csv = await readText(zip, entry.data);
    tables.push({
      manifest: entry,
      schema,
      views: await readTableViews(zip, entry),
      rows: parseCsvRows(csv, schema.columns),
    });
  }
  return tables;
}

async function readTableViews(
  zip: JSZip,
  entry: TableManifestEntry,
): Promise<Record<string, TableView>> {
  const views: Record<string, TableView> = {};
  for (const [id, path] of Object.entries(entry.views ?? {})) {
    const file = zip.file(path);
    if (!file) {
      continue;
    }
    const view = JSON.parse(await file.async("string")) as TableView;
    views[id] = view;
  }
  return views;
}

async function readDocumentBlocks(bytes: Uint8Array): Promise<DocumentBlock[]> {
  try {
    const doc = await openMcd(bytes);
    return doc.blocks();
  } catch {
    return [];
  }
}

async function readAnnotations(
  zip: JSZip,
  entries: AnnotationManifestEntry[],
  entrypoint: string,
  markdown: string,
  pageMap?: PageMap,
  blocks: DocumentBlock[] = [],
): Promise<EditableAnnotation[]> {
  const annotations: EditableAnnotation[] = [];
  for (const entry of entries) {
    const raw = JSON.parse(await readText(zip, entry.metadata)) as Record<string, unknown>;
    const target = targetRecord(raw.target);
    const line =
      annotationTargetSourceLine(target, entrypoint, blocks) ??
      annotationMarkerLine(markdown, entry.id);
    const targetText =
      target?.type === "path" && target.path === entrypoint
        ? JSON.stringify(target, null, 2)
        : line
          ? JSON.stringify(sourceLineTarget(entrypoint, line), null, 2)
          : JSON.stringify(target ?? { type: "document" }, null, 2);
    annotations.push({
      id: String(raw.id ?? entry.id),
      metadata: entry.metadata,
      targetText,
      page: line ? inferPageForLine(markdown, line, pageMap) : "",
      line: line?.toString() ?? "",
      kind: String(raw.kind ?? "comment"),
      status: String(raw.status ?? "open"),
      body: String(raw.body ?? ""),
      author: String(raw.author ?? ""),
      labels: Array.isArray(raw.labels) ? raw.labels.join(", ") : "",
      created: String(raw.created ?? ""),
      originalMetadata: entry.metadata,
    });
  }
  return annotations;
}

function annotationMarkerLine(markdown: string, id: string): number | undefined {
  const marker = `[[annotation:${id}]]`;
  const lines = markdown.split(/\r\n|\r|\n/);
  const index = lines.findIndex((line) => line.includes(marker));
  return index >= 0 ? index + 1 : undefined;
}

function targetRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function targetSourceLine(
  target: Record<string, unknown> | undefined,
  entrypoint: string,
): number | undefined {
  if (!target || target.type !== "path" || target.path !== entrypoint) {
    return undefined;
  }
  const source = targetRecord(target.source);
  const line = Number(source?.startLine);
  return Number.isInteger(line) && line > 0 ? line : undefined;
}

function annotationTargetSourceLine(
  target: Record<string, unknown> | undefined,
  entrypoint: string,
  blocks: DocumentBlock[],
): number | undefined {
  return targetSourceLine(target, entrypoint) ?? blockSourceLineForTarget(target, blocks);
}

function blockSourceLineForTarget(
  target: Record<string, unknown> | undefined,
  blocks: DocumentBlock[],
): number | undefined {
  if (!target) {
    return undefined;
  }

  const block = blocks.find((candidate) => blockMatchesAnnotationTarget(candidate, target));
  return block?.source?.startLine;
}

function blockMatchesAnnotationTarget(
  block: DocumentBlock,
  target: Record<string, unknown>,
): boolean {
  if (target.type === "block") {
    return typeof target.id === "string" && block.id === target.id;
  }

  if (target.type === "placement") {
    return (
      (block.type === "table_ref" || block.type === "image_ref") &&
      placementField(block.placement, "ref") === target.ref
    );
  }

  if (target.type === "table") {
    return block.type === "table_ref" && placementField(block.placement, "table") === target.id;
  }

  if (target.type === "image") {
    return block.type === "image_ref" && placementField(block.placement, "image") === target.id;
  }

  return false;
}

function placementField(placement: Record<string, unknown>, field: string): string | undefined {
  const value = placement[field];
  return typeof value === "string" ? value : undefined;
}

function sourceLineTarget(path: string, line: number): Record<string, unknown> {
  return {
    type: "path",
    path,
    source: {
      startLine: line,
      startColumn: 1,
      endLine: line,
      endColumn: 1,
    },
  };
}

function sourceRangeTarget(
  path: string,
  start: { line: number; column: number },
  end: { line: number; column: number },
): Record<string, unknown> {
  return {
    type: "path",
    path,
    source: {
      startLine: start.line,
      startColumn: start.column,
      endLine: end.line,
      endColumn: end.column,
    },
  };
}

function markdownLineCount(markdown: string): number {
  return Math.max(1, markdown.split(/\r\n|\r|\n/).length);
}

function firstPageValue(packageState: PackageState): string {
  return String(pageChoices(packageState)[0]?.number ?? 1);
}

function pageChoices(packageState: PackageState): Array<{ number: number; label: string }> {
  const pages = (packageState.pageMap?.pages ?? []).filter(
    (page) => page.label?.toLowerCase() !== "annotations",
  );
  if (pages.length > 0) {
    return pages.map((page) => ({
      number: page.number,
      label: page.label ?? `Page ${page.number}`,
    }));
  }
  return [{ number: 1, label: "Page 1" }];
}

function annotationPageOptions(selected: string): string {
  if (!state) {
    return options(["1"], selected || "1");
  }
  return pageChoices(state)
    .map((page) => {
      const value = String(page.number);
      const selectedAttr = value === selected ? " selected" : "";
      return `<option value="${escapeAttr(value)}"${selectedAttr}>${escapeHtml(page.label)}</option>`;
    })
    .join("");
}

function normalizeLineInput(value: string, markdown: string): string {
  const line = Number(value);
  if (!Number.isInteger(line) || line < 1) {
    return "";
  }
  return String(Math.min(line, markdownLineCount(markdown)));
}

function normalizePageLineInput(
  value: string,
  markdown: string,
  page: number,
  pageMap?: PageMap,
): string {
  const line = Number(value);
  if (!Number.isInteger(line) || line < 1) {
    return "";
  }
  return String(Math.min(line, renderedLogicalPageLineCount(page) ?? pageLineCount(markdown, page, pageMap)));
}

function annotationLineInputValue(
  annotation: EditableAnnotation,
  packageState: PackageState,
): string {
  const location = annotationUiLocation(annotation);
  if (location) {
    return String(location.line);
  }

  const line = Number(annotation.line);
  if (!Number.isInteger(line) || line < 1) {
    return "";
  }
  return String(pageLineForSourceLine(packageState.markdown, line, packageState.pageMap));
}

function annotationLineInputMax(annotation: EditableAnnotation, packageState: PackageState): string {
  const page = Number(annotationPageInputValue(annotation, packageState));
  return String(
    renderedLogicalPageLineCount(page) ??
      pageLineCount(packageState.markdown, page, packageState.pageMap),
  );
}

function annotationPageInputValue(
  annotation: EditableAnnotation,
  packageState: PackageState,
): string {
  const location = annotationUiLocation(annotation);
  if (location) {
    return String(location.page);
  }

  return annotation.page || firstPageValue(packageState);
}

function annotationUiLocation(annotation: EditableAnnotation): AnnotationPageLocation | undefined {
  return manualAnnotationLocations.get(annotation.id) ?? renderedAnnotationLocations.get(annotation.id);
}

function inferPageForLine(markdown: string, line: number, pageMap?: PageMap): string {
  const starts = pageStartLines(markdown, pageMap);
  const match = starts
    .filter((start) => start.line <= line)
    .sort((left, right) => right.line - left.line)[0];
  if (match) {
    return String(match.page);
  }

  const pageCount = Math.max(1, pageMap?.pages.length ?? 1);
  const approximate = Math.ceil((line / markdownLineCount(markdown)) * pageCount);
  return String(Math.min(Math.max(1, approximate), pageCount));
}

function firstLineForPage(markdown: string, page: number, pageMap?: PageMap): number {
  const start = pageStartLines(markdown, pageMap).find((entry) => entry.page === page);
  if (start) {
    return start.line;
  }

  const pageCount = Math.max(1, pageMap?.pages.length ?? 1);
  const lineCount = markdownLineCount(markdown);
  return Math.max(1, Math.floor(((page - 1) / pageCount) * lineCount) + 1);
}

function pageLineForSourceLine(markdown: string, line: number, pageMap?: PageMap): number {
  const range = pageSourceRangeForSourceLine(markdown, line, pageMap);
  return Math.max(
    1,
    contentSourceLines(markdown, range.startLine, line).length,
  );
}

function sourceLineForPageLine(
  markdown: string,
  page: number,
  pageLine: number,
  pageMap?: PageMap,
): number {
  const range = pageSourceRange(markdown, page, pageMap);
  const lines = contentSourceLines(markdown, range.startLine, range.endLine);
  const index = Math.min(lines.length - 1, Math.max(0, pageLine - 1));
  return lines[index] ?? range.startLine;
}

function pageLineCount(markdown: string, page: number, pageMap?: PageMap): number {
  const range = pageSourceRange(markdown, page, pageMap);
  return Math.max(1, contentSourceLines(markdown, range.startLine, range.endLine).length);
}

function pageSourceRange(
  markdown: string,
  page: number,
  pageMap?: PageMap,
): { startLine: number; endLine: number } {
  const lineCount = markdownLineCount(markdown);
  const starts = pageStartLines(markdown, pageMap);
  const start = starts.find((entry) => entry.page === page);
  if (!start) {
    const fallbackStart = firstLineForPage(markdown, page, pageMap);
    const fallbackEnd = firstLineForPage(markdown, page + 1, pageMap) - 1;
    return {
      startLine: fallbackStart,
      endLine: Math.max(fallbackStart, Math.min(lineCount, fallbackEnd)),
    };
  }

  const nextStart = starts.find((entry) => entry.line > start.line);
  return {
    startLine: start.line,
    endLine: nextStart ? nextStart.line - 1 : lineCount,
  };
}

function pageStartForSourceLine(
  markdown: string,
  line: number,
  pageMap?: PageMap,
): { page: number; line: number } {
  return (
    pageStartLines(markdown, pageMap)
      .filter((start) => start.line <= line)
      .sort((left, right) => right.line - left.line)[0] ?? { page: 1, line: 1 }
  );
}

function pageSourceRangeForSourceLine(
  markdown: string,
  line: number,
  pageMap?: PageMap,
): { startLine: number; endLine: number } {
  const start = pageStartForSourceLine(markdown, line, pageMap);
  return pageSourceRange(markdown, start.page, pageMap);
}

function contentSourceLines(markdown: string, startLine: number, endLine: number): number[] {
  const lines = markdown.split(/\r\n|\r|\n/);
  const startIndex = Math.max(0, startLine - 1);
  const endIndex = Math.min(lines.length - 1, Math.max(startIndex, endLine - 1));
  const sourceLines: number[] = [];
  for (let index = startIndex; index <= endIndex; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim() && !isStandaloneGeneratedAnnotationLine(line)) {
      sourceLines.push(index + 1);
    }
  }
  return sourceLines;
}

function pageStartLines(markdown: string, pageMap?: PageMap): Array<{ page: number; line: number }> {
  const lines = markdown.split(/\r\n|\r|\n/);
  const pageNumbers = (pageMap?.pages ?? [{ number: 1 }]).map((page) => page.number);
  const starts: Array<{ page: number; line: number }> = [];

  for (const page of pageNumbers) {
    const headingPattern = new RegExp(`^#{1,6}\\s+Page\\s+0?${page}(?:\\b|:)`, "i");
    const headingIndex = lines.findIndex((line) => headingPattern.test(line.trim()));
    if (headingIndex >= 0) {
      starts.push({ page, line: headingIndex + 1 });
    }
  }

  if (starts.length > 0) {
    return starts.sort((left, right) => left.line - right.line);
  }

  return [{ page: pageNumbers[0] ?? 1, line: 1 }];
}

async function readPageMap(
  zip: JSZip,
  manifest: Manifest,
): Promise<{ pageMap?: PageMap; pageMapPath?: string }> {
  const pageMapPath = manifest.layout?.pageMap;
  if (!pageMapPath) {
    return {};
  }
  const file = zip.file(pageMapPath);
  if (!file) {
    return { pageMapPath };
  }
  const pageMap = JSON.parse(await file.async("string")) as PageMap;
  return { pageMap, pageMapPath };
}

async function readText(zip: JSZip, path: string): Promise<string> {
  const file = zip.file(path);
  if (!file) {
    throw new Error(`Package entry '${path}' is missing.`);
  }
  return file.async("string");
}

function parseCsvRows(csv: string, columns: TableColumn[]): Record<string, string>[] {
  const parsed = Papa.parse<string[]>(csv, {
    skipEmptyLines: "greedy",
  });
  const records = parsed.data;
  if (records.length === 0) {
    return [];
  }
  const headers = records[0] ?? [];
  return records.slice(1).map((record) => {
    const row: Record<string, string> = {};
    for (const column of columns) {
      const headerIndex = headers.indexOf(column.name);
      row[column.name] = headerIndex >= 0 ? (record[headerIndex] ?? "") : "";
    }
    return row;
  });
}

function hydrateUiFromState(): void {
  const hasState = Boolean(state);
  fileNameEl.textContent = state
    ? `${state.fileName}${state.dirty ? " (edited)" : ""}`
    : "";
  markdownEditor.disabled = !hasState;
  for (const button of editModeButtons) {
    button.disabled = !hasState;
  }
  for (const button of saveButtons) {
    button.disabled = !hasState;
  }
  addAnnotationButton.disabled = !hasState;
  quickAnnotationButton.disabled = !hasState;
  if (!hasState) {
    previewEditMode = false;
    annotationWordPickArmed = false;
  }
  syncEditModeButton();
  syncAnnotationPickUi();
  setMarkdownEditorValue(state?.markdown ?? "");
  renderTablesEditor();
  renderAnnotationsEditor();
  preview.classList.toggle("is-empty", !hasState);
  syncFloatingActions();
  syncHistoryButtons();
  if (!state) {
    setStatus("");
    preview.innerHTML = emptyDropZoneHtml();
  }
}

function setMarkdownEditorValue(value: string): void {
  markdownEditor.value = value;
  syncMarkdownEditorHighlight();
}

function syncMarkdownEditorHighlight(): void {
  markdownHighlight.innerHTML = markdownHighlightHtml(markdownEditor.value);
  syncMarkdownEditorHighlightScroll();
}

function syncMarkdownEditorHighlightScroll(): void {
  markdownHighlight.scrollTop = markdownEditor.scrollTop;
  markdownHighlight.scrollLeft = markdownEditor.scrollLeft;
}

function markdownHighlightHtml(markdown: string): string {
  const lines = markdown.split(/\r\n|\r|\n/);
  let fencedDirective: "table" | "image" | undefined;
  const highlighted = lines.map((line) => {
    const result = markdownHighlightLine(line, fencedDirective);
    fencedDirective = result.nextDirective;
    return result.html;
  });
  const html = highlighted.join("\n");
  return html || "\n";
}

function markdownHighlightLine(
  line: string,
  fencedDirective: "table" | "image" | undefined,
): { html: string; nextDirective: "table" | "image" | undefined } {
  const classes: Array<string | undefined> = Array.from({ length: line.length });
  const mark = (start: number, end: number, className: string): void => {
    for (let index = Math.max(0, start); index < Math.min(end, line.length); index += 1) {
      classes[index] ??= className;
    }
  };
  const markSyntax = (start: number, end: number): void => mark(start, end, "md-syntax");
  const markEmbedded = (start: number, end: number): void => mark(start, end, "md-embedded-syntax");
  const contentStart = line.match(/^\s*/)?.[0].length ?? 0;
  const content = line.slice(contentStart);
  let nextDirective = fencedDirective;

  const openingDirective = /^(:::(table|image)\b.*)$/.exec(content);
  if (openingDirective?.[1] && (openingDirective[2] === "table" || openingDirective[2] === "image")) {
    markEmbedded(contentStart, line.length);
    nextDirective = openingDirective[2];
  } else if (fencedDirective && /^:::\s*$/.test(content)) {
    markEmbedded(contentStart, contentStart + 3);
    nextDirective = undefined;
  } else if (fencedDirective) {
    const field = /^([A-Za-z][\w-]*)(\s*:)/.exec(content);
    if (field?.[1] && directiveFieldNames(fencedDirective).has(field[1])) {
      markEmbedded(contentStart, contentStart + field[1].length + field[2].length);
    }
  }

  markMarkdownLinks(line, markEmbedded);
  markMarkdownTableSyntax(line, markEmbedded);
  markBlockMarkdownSyntax(line, markSyntax);
  markInlineMarkdownSyntax(line, markSyntax);

  return { html: renderHighlightedLine(line, classes), nextDirective };
}

function directiveFieldNames(kind: "table" | "image"): Set<string> {
  return kind === "table"
    ? new Set(["table", "view", "display", "caption"])
    : new Set(["image", "alt", "caption"]);
}

function markMarkdownLinks(line: string, markEmbedded: (start: number, end: number) => void): void {
  for (const match of line.matchAll(/!?\[[^\]\n]*\]\([^\)\n]*\)/g)) {
    const text = match[0];
    const start = match.index ?? 0;
    markEmbedded(start, start + text.length);
  }

  for (const match of line.matchAll(/!?\[[^\]\n]*\]\[[^\]\n]*\]/g)) {
    const text = match[0];
    const start = match.index ?? 0;
    markEmbedded(start, start + text.length);
  }

  for (const match of line.matchAll(/<https?:\/\/[^>\s]+>/gi)) {
    markEmbedded(match.index ?? 0, (match.index ?? 0) + match[0].length);
  }
}

function markMarkdownTableSyntax(
  line: string,
  markEmbedded: (start: number, end: number) => void,
): void {
  if (!line.includes("|")) {
    return;
  }
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] === "|") {
      markEmbedded(index, index + 1);
    }
  }
  const separator = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.exec(line);
  if (!separator) {
    return;
  }
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] === "-" || line[index] === ":") {
      markEmbedded(index, index + 1);
    }
  }
}

function markBlockMarkdownSyntax(line: string, markSyntax: (start: number, end: number) => void): void {
  const heading = /^(\s{0,3})(#{1,6})(?=\s|$)/.exec(line);
  if (heading?.[2]) {
    markSyntax(heading[1].length, heading[1].length + heading[2].length);
  }

  const quote = /^(\s{0,3})(>+)(?=\s|$)/.exec(line);
  if (quote?.[2]) {
    markSyntax(quote[1].length, quote[1].length + quote[2].length);
  }

  const list = /^(\s*)([-+*]|\d+[.)])(?=\s+)/.exec(line);
  if (list?.[2]) {
    markSyntax(list[1].length, list[1].length + list[2].length);
  }

  const fence = /^(\s{0,3})(`{3,}|~{3,})/.exec(line);
  if (fence?.[2]) {
    markSyntax(fence[1].length, fence[1].length + fence[2].length);
  }

  const thematicBreak = /^(\s{0,3})([-*_])(?:\s*\2){2,}\s*$/.exec(line);
  if (thematicBreak) {
    for (let index = 0; index < line.length; index += 1) {
      if (line[index] === "-" || line[index] === "*" || line[index] === "_") {
        markSyntax(index, index + 1);
      }
    }
  }
}

function markInlineMarkdownSyntax(line: string, markSyntax: (start: number, end: number) => void): void {
  for (let index = 0; index < line.length; index += 1) {
    if ("*_~`".includes(line[index])) {
      markSyntax(index, index + 1);
    }
  }
}

function renderHighlightedLine(line: string, classes: Array<string | undefined>): string {
  if (!line) {
    return "";
  }
  let html = "";
  let index = 0;
  while (index < line.length) {
    const className = classes[index];
    let end = index + 1;
    while (end < line.length && classes[end] === className) {
      end += 1;
    }
    const text = escapeHtml(line.slice(index, end));
    html += className ? `<span class="${className}">${text}</span>` : text;
    index = end;
  }
  return html;
}

function emptyDropZoneHtml(): string {
  return `<div id="dropZone" class="drop-zone" role="button" tabindex="0" aria-label="Upload or drop an MCD file">
    <div class="drop-title">Click to upload or drop a .mcd file here</div>
    <div class="drop-copy">The file is parsed locally in this browser session.</div>
  </div>`;
}

function setActiveTab(tab: ActiveTab): void {
  activeTab = tab;
  for (const name of ["text", "tables", "annotations"] as const) {
    const selected = name === tab;
    byId<HTMLButtonElement>(`tab${capitalize(name)}`).setAttribute(
      "aria-selected",
      selected ? "true" : "false",
    );
    byId<HTMLElement>(`${name}Panel`).classList.toggle("is-active", selected);
  }
  if (tab === "tables") {
    renderTablesEditor();
  } else {
    resetTablesEditorObserver();
  }
}

function setSidebarExpanded(expanded: boolean): void {
  sidebarExpanded = expanded;
  workspace.classList.toggle("is-sidebar-folded", !expanded);
  workspace.classList.toggle("is-sidebar-expanded", expanded);
  sidebarToggle.setAttribute("aria-expanded", expanded ? "true" : "false");
  sidebarToggle.setAttribute("aria-label", expanded ? "Fold sidebar" : "Unfold sidebar");
  sidebarToggle.title = expanded ? "Fold sidebar" : "Unfold sidebar";
}

function syncFloatingActions(): void {
  const hasScrolledDocument = previewPane.scrollTop > 80 || window.scrollY > 80;
  const isVisible = Boolean(state) && hasScrolledDocument;
  floatingActions.hidden = !isVisible;
  floatingActions.classList.toggle("is-visible", isVisible);
  sidebarStrip.classList.toggle("is-pinned", hasScrolledDocument);
}

function renderTablesEditor(): void {
  resetTablesEditorObserver();
  tablesEditor.innerHTML = "";
  if (!state) {
    tablesEditor.innerHTML = `<div class="empty-state">No document loaded.</div>`;
    return;
  }
  if (state.tables.length === 0) {
    tablesEditor.innerHTML = `<div class="empty-state">This document does not declare CSV-backed tables.</div>`;
    return;
  }

  for (const table of state.tables) {
    const card = document.createElement("section");
    card.className = "item-card";
    const title = table.schema.id || table.manifest.id;
    card.innerHTML = `
      <div class="item-header">
        <div class="item-title">${escapeHtml(title)}</div>
        <span class="file-name">${escapeHtml(table.manifest.data)}</span>
      </div>
      <div class="table-frame">
        <div class="table-wrap" data-table-index="${state.tables.indexOf(table)}">
          <div class="lazy-table-placeholder" role="status" aria-label="Table preview pending"></div>
        </div>
      </div>
      <div class="table-actions">
        <button type="button" data-action="add-row">Add row</button>
      </div>
    `;
    const tableFrame = card.querySelector<HTMLDivElement>(".table-frame");
    const tableWrap = card.querySelector<HTMLDivElement>(".table-wrap");
    if (!tableFrame || !tableWrap) {
      throw new Error("Missing table wrapper.");
    }
    card
      .querySelector<HTMLButtonElement>('[data-action="add-row"]')
      ?.addEventListener("click", () => {
        recordHistoryCheckpoint();
        const shouldRenumberRowHeaders = usesDefaultReservedRowHeaders(table);
        table.rows.push(createEmptyTableRow(table, table.rows.length));
        if (shouldRenumberRowHeaders) {
          renumberReservedRowHeaders(table);
        }
        renderTablesEditor();
        markDirty();
      });
    tablesEditor.appendChild(card);
    if (activeTab === "tables") {
      observeTablesEditorGrid(tableWrap, tableFrame, table);
    }
  }
}

function resetTablesEditorObserver(): void {
  tablesEditorObserver?.disconnect();
  tablesEditorObserver = undefined;
  editorVirtualTables = new WeakMap();
}

function observeTablesEditorGrid(
  tableWrap: HTMLDivElement,
  tableFrame: HTMLDivElement,
  table: EditableTable,
): void {
  if (!("IntersectionObserver" in window)) {
    renderEditorTableGrid(tableWrap, tableFrame, table);
    return;
  }

  tablesEditorObserver ??= new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) {
          continue;
        }
        const target = entry.target as HTMLDivElement;
        tablesEditorObserver?.unobserve(target);
        const frame = target.closest<HTMLDivElement>(".table-frame");
        const index = Number(target.dataset.tableIndex);
        const tableState = state?.tables[index];
        if (frame && tableState) {
          renderEditorTableGrid(target, frame, tableState);
        }
      }
    },
    { root: editorContent, rootMargin: "80px 0px" },
  );
  tablesEditorObserver.observe(tableWrap);
  window.requestAnimationFrame(() => {
    if (isElementNearScrollRoot(tableWrap, editorContent, 80)) {
      tablesEditorObserver?.unobserve(tableWrap);
      renderEditorTableGrid(tableWrap, tableFrame, table);
    }
  });
}

function renderEditorTableGrid(
  tableWrap: HTMLDivElement,
  tableFrame: HTMLDivElement,
  table: EditableTable,
): void {
  if (tableWrap.dataset.gridRendered === "true") {
    return;
  }
  tableWrap.dataset.gridRendered = "true";
  tableWrap.replaceChildren();
  const grid = renderTableGrid(table);
  tableWrap.appendChild(grid);
  setupEditorVirtualTable(tableWrap, table, grid);
  attachTableInsertControls(tableFrame, tableWrap, table, grid);
}

function renderTableGrid(table: EditableTable): HTMLTableElement {
  const grid = document.createElement("table");
  grid.className = "data-table";
  const thead = document.createElement("thead");
  const header = document.createElement("tr");
  for (const column of table.schema.columns) {
    const th = document.createElement("th");
    th.className = "data-table-cell";
    if (column.name !== RESERVED_ROW_HEADER_COLUMN) {
      th.appendChild(renderTableHeaderInput(table, column));
    } else {
      th.setAttribute("aria-label", "Row headers");
    }
    header.appendChild(th);
  }
  const actionTh = document.createElement("th");
  actionTh.className = "data-table-cell data-table-action-cell";
  actionTh.textContent = "";
  header.appendChild(actionTh);
  thead.appendChild(header);
  grid.appendChild(thead);

  const tbody = document.createElement("tbody");
  grid.appendChild(tbody);
  return grid;
}

function setupEditorVirtualTable(
  tableWrap: HTMLDivElement,
  table: EditableTable,
  grid: HTMLTableElement,
): void {
  const tbody = grid.querySelector<HTMLTableSectionElement>("tbody");
  if (!tbody) {
    throw new Error("Missing table body.");
  }
  const virtualTable: EditorVirtualTable = {
    table,
    tbody,
    wrapper: tableWrap,
    rowHeight: EDITOR_VIRTUAL_TABLE_ROW_HEIGHT,
    visibleStart: -1,
    visibleEnd: -1,
  };
  editorVirtualTables.set(tableWrap, virtualTable);
  tableWrap.addEventListener(
    "scroll",
    () => {
      if (tableWrap.contains(document.activeElement)) {
        return;
      }
      renderVirtualEditorTableRows(virtualTable);
    },
    { passive: true },
  );
  renderVirtualEditorTableRows(virtualTable);
  window.requestAnimationFrame(() => renderVirtualEditorTableRows(virtualTable));
}

function renderVirtualEditorTableRows(virtualTable: EditorVirtualTable): void {
  const rowCount = virtualTable.table.rows.length;
  const viewportHeight = Math.max(virtualTable.wrapper.clientHeight, 220);
  const visibleRows = Math.ceil(viewportHeight / virtualTable.rowHeight) + EDITOR_VIRTUAL_TABLE_OVERSCAN_ROWS * 2;
  const start = Math.max(
    0,
    Math.floor(virtualTable.wrapper.scrollTop / virtualTable.rowHeight) - EDITOR_VIRTUAL_TABLE_OVERSCAN_ROWS,
  );
  const end = Math.min(rowCount, start + visibleRows);
  if (start === virtualTable.visibleStart && end === virtualTable.visibleEnd) {
    return;
  }

  virtualTable.visibleStart = start;
  virtualTable.visibleEnd = end;
  virtualTable.tbody.replaceChildren();
  virtualTable.tbody.appendChild(
    tableSpacerRow(virtualTable.table.schema.columns.length + 1, start * virtualTable.rowHeight),
  );
  for (let rowIndex = start; rowIndex < end; rowIndex += 1) {
    virtualTable.tbody.appendChild(renderEditorTableRow(virtualTable.table, rowIndex));
  }
  virtualTable.tbody.appendChild(
    tableSpacerRow(
      virtualTable.table.schema.columns.length + 1,
      Math.max(0, rowCount - end) * virtualTable.rowHeight,
    ),
  );
}

function renderEditorTableRow(table: EditableTable, rowIndex: number): HTMLTableRowElement {
  const row = table.rows[rowIndex];
  const tr = document.createElement("tr");
  tr.dataset.rowIndex = String(rowIndex);
  for (const column of table.schema.columns) {
    const td = document.createElement("td");
    td.className = "data-table-cell";
    const input = document.createElement("input");
    input.value = row?.[column.name] ?? "";
    input.setAttribute("aria-label", `${table.manifest.id} ${column.name} row ${rowIndex + 1}`);
    input.addEventListener("input", () => {
      if (!row || (row[column.name] ?? "") === input.value) {
        return;
      }
      recordHistoryCheckpoint({
        coalesceKey: `table:${table.manifest.id}:${rowIndex}:${column.name}`,
      });
      row[column.name] = input.value;
      markDirty();
    });
    td.appendChild(input);
    tr.appendChild(td);
  }
  const actionTd = document.createElement("td");
  actionTd.className = "data-table-cell data-table-action-cell";
  const remove = document.createElement("button");
  remove.className = "danger";
  remove.type = "button";
  remove.textContent = "Remove";
  remove.addEventListener("click", () => {
    deleteTableRow(table, rowIndex);
  });
  actionTd.appendChild(remove);
  tr.appendChild(actionTd);
  return tr;
}

function tableSpacerRow(columnCount: number, height: number): HTMLTableRowElement {
  const row = document.createElement("tr");
  row.className = "virtual-table-spacer";
  row.setAttribute("aria-hidden", "true");
  const cell = document.createElement("td");
  cell.colSpan = Math.max(1, columnCount);
  cell.style.height = `${height}px`;
  cell.style.padding = "0";
  cell.style.border = "0";
  row.appendChild(cell);
  return row;
}

function renderTableHeaderInput(table: EditableTable, column: TableColumn): HTMLInputElement {
  const input = document.createElement("input");
  input.className = "data-table-header-input";
  input.value = column.label ?? column.name;
  input.setAttribute("aria-label", `${table.manifest.id} ${column.name} column name`);
  input.title = column.name;
  input.addEventListener("input", () => {
    const next = input.value.replace(/\s+/g, " ").trim();
    if (!next || next === (column.label ?? column.name)) {
      return;
    }
    recordHistoryCheckpoint({
      coalesceKey: `sidebar-table-header:${table.manifest.id}:${column.name}`,
    });
    setTableColumnLabelAcrossViews(table, column.name, next);
    markDirty();
  });
  input.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") {
      return;
    }
    event.preventDefault();
    input.blur();
  });
  return input;
}

function deleteTableRow(table: EditableTable, rowIndex: number): void {
  recordHistoryCheckpoint();
  const shouldRenumberRowHeaders = usesDefaultReservedRowHeaders(table);
  table.rows.splice(rowIndex, 1);
  if (shouldRenumberRowHeaders) {
    renumberReservedRowHeaders(table);
  }
  renderTablesEditor();
  markDirty();
}

function insertTableRow(table: EditableTable, insertIndex: number): void {
  recordHistoryCheckpoint();
  const shouldRenumberRowHeaders = usesDefaultReservedRowHeaders(table);
  table.rows.splice(insertIndex, 0, createEmptyTableRow(table, insertIndex));
  if (shouldRenumberRowHeaders) {
    renumberReservedRowHeaders(table);
  }
  renderTablesEditor();
  markDirty();
}

function createEmptyTableRow(table: EditableTable, rowIndex: number): Record<string, string> {
  return Object.fromEntries(
    table.schema.columns.map((column) => [
      column.name,
      column.name === RESERVED_ROW_HEADER_COLUMN ? String(rowIndex + 1) : "",
    ]),
  );
}

function insertTableColumn(table: EditableTable, insertIndex: number): void {
  recordHistoryCheckpoint();
  const column = nextTableColumn(table);
  table.schema.columns.splice(insertIndex, 0, column);
  for (const row of table.rows) {
    row[column.name] = "";
  }
  insertColumnIntoTableViews(table, column, insertIndex);
  renderTablesEditor();
  markDirty();
}

function deleteTableColumn(table: EditableTable, columnName: string): void {
  if (columnName === RESERVED_ROW_HEADER_COLUMN) {
    return;
  }
  const columnIndex = table.schema.columns.findIndex((column) => column.name === columnName);
  if (columnIndex < 0) {
    return;
  }

  recordHistoryCheckpoint();
  table.schema.columns.splice(columnIndex, 1);
  for (const row of table.rows) {
    delete row[columnName];
  }
  removeColumnFromTableViews(table, columnName);
  renderTablesEditor();
  markDirty();
}

function nextTableColumn(table: EditableTable): TableColumn {
  const existing = new Set(table.schema.columns.map((column) => column.name));
  let index = 1;
  while (existing.has(`column_${index}`)) {
    index += 1;
  }
  return {
    name: `column_${index}`,
    type: "string",
    label: `Column ${index}`,
    nullable: true,
  };
}

function insertColumnIntoTableViews(
  table: EditableTable,
  column: TableColumn,
  schemaInsertIndex: number,
): void {
  for (const view of Object.values(table.views)) {
    if (!view.columns) {
      continue;
    }
    const precedingColumns = new Set(
      table.schema.columns.slice(0, schemaInsertIndex).map((schemaColumn) => schemaColumn.name),
    );
    const viewInsertIndex = view.columns.filter((viewColumn) =>
      precedingColumns.has(viewColumn.name),
    ).length;
    view.columns.splice(viewInsertIndex, 0, {
      name: column.name,
      label: column.label,
    });
  }
}

function removeColumnFromTableViews(table: EditableTable, columnName: string): void {
  for (const view of Object.values(table.views)) {
    if (view.columns) {
      view.columns = view.columns.filter((column) => column.name !== columnName);
    }
    for (const key of ["x", "y", "series", "grouping", "markLabels"] as const) {
      const encoding = view.chart?.[key];
      if (encoding?.column === columnName && view.chart) {
        delete view.chart[key];
      }
    }
  }
}

function attachTableInsertControls(
  tableFrame: HTMLDivElement,
  tableWrap: HTMLDivElement,
  table: EditableTable,
  grid: HTMLTableElement,
): void {
  const columnControl = renderTableInsertControl("column");
  const rowControl = renderTableInsertControl("row");
  const deleteColumnControl = renderTableDeleteControl("column");
  const deleteRowControl = renderTableDeleteControl("row");
  tableFrame.append(columnControl, rowControl, deleteColumnControl, deleteRowControl);

  columnControl.addEventListener("click", () => {
    const insertIndex = Number(columnControl.dataset.insertIndex);
    if (Number.isInteger(insertIndex)) {
      insertTableColumn(table, insertIndex);
    }
  });
  rowControl.addEventListener("click", () => {
    const insertIndex = Number(rowControl.dataset.insertIndex);
    if (Number.isInteger(insertIndex)) {
      insertTableRow(table, insertIndex);
    }
  });
  deleteColumnControl.addEventListener("click", () => {
    const columnName = deleteColumnControl.dataset.columnName;
    if (columnName) {
      deleteTableColumn(table, columnName);
    }
  });
  deleteRowControl.addEventListener("click", () => {
    const rowIndex = Number(deleteRowControl.dataset.rowIndex);
    if (Number.isInteger(rowIndex)) {
      deleteTableRow(table, rowIndex);
    }
  });

  tableWrap.addEventListener("mousemove", (event) => {
    syncTableEdgeControls(
      event,
      tableFrame,
      tableWrap,
      grid,
      table,
      columnControl,
      rowControl,
      deleteColumnControl,
      deleteRowControl,
    );
  });
  tableFrame.addEventListener("mouseleave", () => {
    hideTableEdgeControls(columnControl, rowControl, deleteColumnControl, deleteRowControl);
  });
  tableWrap.addEventListener("scroll", () => {
    hideTableEdgeControls(columnControl, rowControl, deleteColumnControl, deleteRowControl);
  });
}

function renderTableInsertControl(kind: "column" | "row"): HTMLButtonElement {
  const button = document.createElement("button");
  button.className = `table-insert-control table-insert-${kind}`;
  button.type = "button";
  button.textContent = "+";
  button.title = kind === "column" ? "Insert column" : "Insert row";
  button.setAttribute("aria-hidden", "true");
  button.tabIndex = -1;
  return button;
}

function renderTableDeleteControl(kind: "column" | "row"): HTMLButtonElement {
  const button = document.createElement("button");
  button.className = `table-delete-control table-delete-${kind}`;
  button.type = "button";
  button.textContent = "-";
  button.title = kind === "column" ? "Delete column" : "Delete row";
  button.setAttribute("aria-hidden", "true");
  button.tabIndex = -1;
  return button;
}

function syncTableEdgeControls(
  event: MouseEvent,
  tableFrame: HTMLDivElement,
  tableWrap: HTMLDivElement,
  grid: HTMLTableElement,
  table: EditableTable,
  columnControl: HTMLButtonElement,
  rowControl: HTMLButtonElement,
  deleteColumnControl: HTMLButtonElement,
  deleteRowControl: HTMLButtonElement,
): void {
  if ((event.target as HTMLElement | null)?.closest(".table-insert-control, .table-delete-control")) {
    return;
  }

  const threshold = 8;
  const frameRect = tableFrame.getBoundingClientRect();
  const tableRect = grid.getBoundingClientRect();
  const columnDelete = nearestColumnDeleteEdge(event, grid, table, threshold);
  const rowDelete = nearestRowDeleteEdge(event, grid, threshold);
  const useColumnDelete =
    columnDelete &&
    (!rowDelete || columnDelete.distance <= rowDelete.distance) &&
    event.clientY >= tableRect.top &&
    event.clientY <= tableRect.bottom;
  const useRowDelete =
    rowDelete &&
    !useColumnDelete &&
    event.clientX >= tableRect.left &&
    event.clientX <= tableRect.right;

  if (useColumnDelete) {
    showTableDeleteControl(deleteColumnControl, {
      left: columnDelete.x - frameRect.left,
      top: columnDelete.y - frameRect.top,
      label: `Delete column ${columnDelete.label}`,
      columnName: columnDelete.columnName,
    });
    hideTableEdgeControls(columnControl, rowControl, deleteRowControl);
    return;
  }

  if (useRowDelete) {
    showTableDeleteControl(deleteRowControl, {
      left: rowDelete.x - frameRect.left,
      top: rowDelete.y - frameRect.top,
      label: `Delete row ${rowDelete.rowIndex + 1}`,
      rowIndex: rowDelete.rowIndex,
    });
    hideTableEdgeControls(columnControl, rowControl, deleteColumnControl);
    return;
  }

  const columnBoundary = nearestColumnEdge(event, grid, table.schema.columns.length, threshold);
  const rowBoundary = nearestRowEdge(event, grid, table.schema.columns.length, threshold);
  const useColumn =
    columnBoundary &&
    (!rowBoundary || columnBoundary.distance <= rowBoundary.distance) &&
    event.clientY >= tableRect.top &&
    event.clientY <= tableRect.bottom;
  const useRow =
    rowBoundary &&
    !useColumn &&
    event.clientX >= tableRect.left &&
    event.clientX <= tableRect.right;

  if (useColumn) {
    showTableInsertControl(columnControl, {
      insertIndex: columnBoundary.insertIndex,
      left: columnBoundary.x - frameRect.left,
      top: columnBoundary.y - frameRect.top,
      label: `Insert column before column ${columnBoundary.insertIndex + 1}`,
    });
    hideTableEdgeControls(rowControl, deleteColumnControl, deleteRowControl);
    return;
  }

  if (useRow) {
    showTableInsertControl(rowControl, {
      insertIndex: rowBoundary.insertIndex,
      left: rowBoundary.x - frameRect.left,
      top: rowBoundary.y - frameRect.top,
      label: `Insert row before row ${rowBoundary.insertIndex + 1}`,
    });
    hideTableEdgeControls(columnControl, deleteColumnControl, deleteRowControl);
    return;
  }

  hideTableEdgeControls(columnControl, rowControl, deleteColumnControl, deleteRowControl);
}

function nearestColumnEdge(
  event: MouseEvent,
  grid: HTMLTableElement,
  columnCount: number,
  threshold: number,
): { insertIndex: number; x: number; y: number; distance: number } | undefined {
  const rows = Array.from(grid.querySelectorAll<HTMLTableRowElement>("thead tr, tbody tr[data-row-index]"));
  let nearest: { insertIndex: number; x: number; y: number; distance: number } | undefined;
  for (const row of rows) {
    const cells = Array.from(row.children).slice(0, columnCount);
    for (let index = 1; index <= cells.length; index += 1) {
      const cell = cells[index] ?? cells[index - 1];
      const rect = cell?.getBoundingClientRect();
      if (!rect) {
        continue;
      }
      if (event.clientY < rect.top || event.clientY > rect.bottom) {
        continue;
      }
      const x = index === cells.length ? rect.right : rect.left;
      const distance = Math.abs(event.clientX - x);
      if (distance <= threshold && (!nearest || distance < nearest.distance)) {
        nearest = {
          insertIndex: index,
          x,
          y: rect.top + rect.height / 2,
          distance,
        };
      }
    }
  }
  return nearest;
}

function nearestColumnDeleteEdge(
  event: MouseEvent,
  grid: HTMLTableElement,
  table: EditableTable,
  threshold: number,
):
  | { columnName: string; label: string; x: number; y: number; distance: number }
  | undefined {
  const headers = Array.from(grid.querySelectorAll<HTMLTableCellElement>("thead th"));
  let nearest:
    | { columnName: string; label: string; x: number; y: number; distance: number }
    | undefined;
  table.schema.columns.forEach((column, index) => {
    if (column.name === RESERVED_ROW_HEADER_COLUMN) {
      return;
    }
    const rect = headers[index]?.getBoundingClientRect();
    if (!rect || event.clientX < rect.left || event.clientX > rect.right) {
      return;
    }
    const distance = Math.abs(event.clientY - rect.top);
    if (distance <= threshold && (!nearest || distance < nearest.distance)) {
      nearest = {
        columnName: column.name,
        label: column.label ?? column.name,
        x: rect.left + rect.width / 2,
        y: rect.top,
        distance,
      };
    }
  });
  return nearest;
}

function nearestRowEdge(
  event: MouseEvent,
  grid: HTMLTableElement,
  columnCount: number,
  threshold: number,
): { insertIndex: number; x: number; y: number; distance: number } | undefined {
  const rows = Array.from(grid.querySelectorAll<HTMLTableRowElement>("tbody tr[data-row-index]"));
  let nearest: { insertIndex: number; x: number; y: number; distance: number } | undefined;
  for (let index = 0; index <= rows.length; index += 1) {
    const row = rows[index] ?? rows[index - 1];
    const rowIndex = Number(row?.dataset.rowIndex);
    if (!Number.isInteger(rowIndex)) {
      continue;
    }
    const cells = Array.from(row?.children ?? []).slice(0, columnCount);
    for (const cell of cells) {
      const rect = cell.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right) {
        continue;
      }
      const y = index === rows.length ? rect.bottom : rect.top;
      const distance = Math.abs(event.clientY - y);
      if (distance <= threshold && (!nearest || distance < nearest.distance)) {
        nearest = {
          insertIndex: index === rows.length ? rowIndex + 1 : rowIndex,
          x: rect.left + rect.width / 2,
          y,
          distance,
        };
      }
    }
  }
  return nearest;
}

function nearestRowDeleteEdge(
  event: MouseEvent,
  grid: HTMLTableElement,
  threshold: number,
): { rowIndex: number; x: number; y: number; distance: number } | undefined {
  const rows = Array.from(grid.querySelectorAll<HTMLTableRowElement>("tbody tr[data-row-index]"));
  let nearest: { rowIndex: number; x: number; y: number; distance: number } | undefined;
  rows.forEach((row) => {
    const rowIndex = Number(row.dataset.rowIndex);
    if (!Number.isInteger(rowIndex)) {
      return;
    }
    const rect = row.children[0]?.getBoundingClientRect();
    if (!rect || event.clientY < rect.top || event.clientY > rect.bottom) {
      return;
    }
    const distance = Math.abs(event.clientX - rect.left);
    if (distance <= threshold && (!nearest || distance < nearest.distance)) {
      nearest = {
        rowIndex,
        x: rect.left,
        y: rect.top + rect.height / 2,
        distance,
      };
    }
  });
  return nearest;
}

function showTableInsertControl(
  control: HTMLButtonElement,
  options: { insertIndex: number; left: number; top: number; label: string },
): void {
  control.dataset.insertIndex = String(options.insertIndex);
  control.style.left = `${options.left}px`;
  control.style.top = `${options.top}px`;
  control.setAttribute("aria-label", options.label);
  control.classList.add("is-visible");
}

function showTableDeleteControl(
  control: HTMLButtonElement,
  options: {
    left: number;
    top: number;
    label: string;
    columnName?: string;
    rowIndex?: number;
  },
): void {
  control.style.left = `${options.left}px`;
  control.style.top = `${options.top}px`;
  control.setAttribute("aria-label", options.label);
  if (options.columnName) {
    control.dataset.columnName = options.columnName;
  } else {
    delete control.dataset.columnName;
  }
  if (typeof options.rowIndex === "number") {
    control.dataset.rowIndex = String(options.rowIndex);
  } else {
    delete control.dataset.rowIndex;
  }
  control.classList.add("is-visible");
}

function hideTableEdgeControls(...controls: HTMLButtonElement[]): void {
  for (const control of controls) {
    control.classList.remove("is-visible");
    delete control.dataset.insertIndex;
    delete control.dataset.columnName;
    delete control.dataset.rowIndex;
  }
}

function renumberReservedRowHeaders(table: EditableTable): void {
  if (!hasReservedRowHeaderColumn(table)) {
    return;
  }
  table.rows.forEach((row, rowIndex) => {
    row[RESERVED_ROW_HEADER_COLUMN] = String(rowIndex + 1);
  });
}

function usesDefaultReservedRowHeaders(table: EditableTable): boolean {
  return (
    hasReservedRowHeaderColumn(table) &&
    table.rows.every((row, rowIndex) => row[RESERVED_ROW_HEADER_COLUMN] === String(rowIndex + 1))
  );
}

function hasReservedRowHeaderColumn(table: EditableTable): boolean {
  return table.schema.columns.some((column) => column.name === RESERVED_ROW_HEADER_COLUMN);
}

function renderAnnotationsEditor(): void {
  annotationsEditor.innerHTML = "";
  if (!state) {
    annotationsEditor.innerHTML = `<div class="empty-state">No document loaded.</div>`;
    return;
  }
  if (state.annotations.length === 0) {
    annotationsEditor.innerHTML = `<div class="empty-state">This document has no manifest-declared annotations.</div>`;
    return;
  }

  const packageState = state;
  state.annotations.forEach((annotation, index) => {
    const expanded = expandedAnnotationIds.has(annotation.id);
    const panelId = `annotation-panel-${index}-${sanitizeId(annotation.id)}`;
    const annotationHistoryKey = annotation.originalMetadata ?? annotation.metadata ?? annotation.id;
    const card = document.createElement("section");
    card.className = `item-card annotation-card${expanded ? " is-expanded" : ""}`;
    card.innerHTML = `
      <div class="item-header">
        <button class="annotation-summary" type="button" data-field="toggle" aria-expanded="${expanded}" aria-controls="${escapeAttr(
          panelId,
        )}">
          <span class="item-title">${escapeHtml(annotation.id)}</span>
        </button>
        <div class="item-actions">
          <button class="disclosure-button" type="button" data-field="toggle" aria-label="${
            expanded ? "Collapse annotation" : "Expand annotation"
          }" aria-expanded="${expanded}" aria-controls="${escapeAttr(panelId)}">
            <span class="disclosure-icon" aria-hidden="true"></span>
          </button>
        </div>
      </div>
      ${expanded ? annotationDetailsHtml(annotation, packageState, panelId) : ""}
    `;

    bindAnnotationInput(card, annotation, "id", annotationHistoryKey, (value) => {
      const previousId = annotation.id;
      const previous = annotation.metadata;
      annotation.id = sanitizeId(value);
      annotation.metadata = `annotations/${annotation.id}.annotation.json`;
      if (previous !== annotation.metadata) {
        state?.removedAnnotationPaths.add(previous);
      }
      if (expandedAnnotationIds.delete(previousId)) {
        expandedAnnotationIds.add(annotation.id);
      }
      if (locallySavedAnnotationIds.delete(previousId)) {
        locallySavedAnnotationIds.add(annotation.id);
      }
      if (pendingMarginAnnotationId === previousId) {
        pendingMarginAnnotationId = annotation.id;
      }
      if (pendingWordAnnotationId === previousId) {
        pendingWordAnnotationId = annotation.id;
      }
      renameAnnotationMarkerInMarkdown(previousId, annotation.id);
      const renderedLocation = renderedAnnotationLocations.get(previousId);
      if (renderedLocation) {
        renderedAnnotationLocations.delete(previousId);
        renderedAnnotationLocations.set(annotation.id, renderedLocation);
      }
      const manualLocation = manualAnnotationLocations.get(previousId);
      if (manualLocation) {
        manualAnnotationLocations.delete(previousId);
        manualAnnotationLocations.set(annotation.id, manualLocation);
      }
    });
    bindAnnotationInput(card, annotation, "kind", annotationHistoryKey, (value) => {
      annotation.kind = value;
    });
    bindAnnotationInput(card, annotation, "status", annotationHistoryKey, (value) => {
      annotation.status = value;
    });
    bindAnnotationInput(card, annotation, "author", annotationHistoryKey, (value) => {
      annotation.author = value;
    });
    bindAnnotationInput(card, annotation, "body", annotationHistoryKey, (value) => {
      annotation.body = value;
    });
    bindAnnotationInput(card, annotation, "page", annotationHistoryKey, (value) => {
      annotation.page = value;
      if (state && value) {
        const page = Number(value);
        const sourceLine =
          sourceLineForRenderedLogicalPageLine(page, 1) ??
          sourceLineForPageLine(state.markdown, page, 1, state.pageMap);
        annotation.line = sourceLine.toString();
        manualAnnotationLocations.set(annotation.id, manualAnnotationLocationForPageLine(page, 1));
        const lineInput = card.querySelector<HTMLInputElement>('[data-field="line"]');
        if (lineInput) {
          lineInput.value = annotationLineInputValue(annotation, state);
          lineInput.max = annotationLineInputMax(annotation, state);
        }
      }
      updateAnnotationTargetFromLocation(annotation);
      updateAnnotationTargetTextarea(card, annotation);
    });
    bindAnnotationInput(card, annotation, "line", annotationHistoryKey, (value) => {
      if (state) {
        const page = Number(annotationPageInputValue(annotation, state));
        const pageLine = normalizePageLineInput(value, state.markdown, page, state.pageMap);
        if (pageLine) {
          const line = Number(pageLine);
          const sourceLine =
            sourceLineForRenderedLogicalPageLine(page, line) ??
            sourceLineForPageLine(state.markdown, page, line, state.pageMap);
          annotation.line = sourceLine.toString();
          manualAnnotationLocations.set(annotation.id, manualAnnotationLocationForPageLine(page, line));
        } else {
          annotation.line = "";
          manualAnnotationLocations.delete(annotation.id);
        }
      } else {
        annotation.line = normalizeLineInput(value, "");
      }
      if (state && annotation.line) {
        annotation.page = annotationPageInputValue(annotation, state);
        const pageInput = card.querySelector<HTMLSelectElement>('[data-field="page"]');
        if (pageInput) {
          pageInput.value = annotation.page;
        }
        const lineInput = card.querySelector<HTMLInputElement>('[data-field="line"]');
        if (lineInput) {
          lineInput.value = annotationLineInputValue(annotation, state);
          lineInput.max = annotationLineInputMax(annotation, state);
        }
      }
      updateAnnotationTargetFromLocation(annotation);
      updateAnnotationTargetTextarea(card, annotation);
    });
    bindAnnotationInput(card, annotation, "targetText", annotationHistoryKey, (value) => {
      annotation.targetText = value;
      syncAnnotationLocationFromTarget(annotation);
      updateAnnotationLocationInputs(card, annotation);
    });
    bindAnnotationInput(card, annotation, "labels", annotationHistoryKey, (value) => {
      annotation.labels = value;
    });
    bindAnnotationInput(card, annotation, "created", annotationHistoryKey, (value) => {
      annotation.created = value;
    });
    card
      .querySelector<HTMLButtonElement>('[data-field="save"]')
      ?.addEventListener("click", () => {
        void saveAnnotationLocally(annotation);
      });
    for (const toggle of Array.from(
      card.querySelectorAll<HTMLButtonElement>('[data-field="toggle"]'),
    )) {
      toggle.addEventListener("click", () => {
        if (expandedAnnotationIds.has(annotation.id)) {
          expandedAnnotationIds.delete(annotation.id);
          locallySavedAnnotationIds.delete(annotation.id);
        } else {
          expandedAnnotationIds.add(annotation.id);
        }
        renderAnnotationsEditor();
      });
    }
    card
      .querySelector<HTMLButtonElement>('[data-field="remove"]')
      ?.addEventListener("click", () => {
        recordHistoryCheckpoint();
        state?.removedAnnotationPaths.add(annotation.metadata);
        if (annotation.originalMetadata) {
          state?.removedAnnotationPaths.add(annotation.originalMetadata);
        }
        expandedAnnotationIds.delete(annotation.id);
        locallySavedAnnotationIds.delete(annotation.id);
        renderedAnnotationLocations.delete(annotation.id);
        manualAnnotationLocations.delete(annotation.id);
        if (pendingMarginAnnotationId === annotation.id) {
          pendingMarginAnnotationId = undefined;
        }
        if (pendingWordAnnotationId === annotation.id) {
          pendingWordAnnotationId = undefined;
        }
        removeAnnotationMarkerFromMarkdown(annotation.id);
        state?.annotations.splice(index, 1);
        renderAnnotationsEditor();
        markDirty();
      });
    annotationsEditor.appendChild(card);
  });
}

function annotationDetailsHtml(
  annotation: EditableAnnotation,
  packageState: PackageState,
  panelId: string,
): string {
  return `
    <div class="annotation-details" id="${escapeAttr(panelId)}">
      <div class="annotation-detail-actions">
        ${annotationSaveButtonHtml(annotation)}
        <button class="danger" type="button" data-field="remove">Delete</button>
      </div>
      <div class="compact-row">
        <div class="field">
          <label>ID</label>
          <input data-field="id" value="${escapeAttr(annotation.id)}" />
        </div>
        <div class="field">
          <label>Kind</label>
          <select data-field="kind">
            ${options(["comment", "flag", "proposed_change", "question", "todo"], annotation.kind)}
          </select>
        </div>
      </div>
      <div class="compact-row">
        <div class="field">
          <label>Status</label>
          <select data-field="status">
            ${options(["open", "accepted", "rejected", "resolved"], annotation.status)}
          </select>
        </div>
        <div class="field">
          <label>Author</label>
          <input data-field="author" value="${escapeAttr(annotation.author)}" />
        </div>
      </div>
      <div class="field">
        <label>Body</label>
        <textarea data-field="body">${escapeHtml(annotation.body)}</textarea>
      </div>
      <div class="compact-row">
        <div class="field">
          <label>Page</label>
          <select data-field="page">
            ${annotationPageOptions(annotationPageInputValue(annotation, packageState))}
          </select>
        </div>
        <div class="field">
          <label>Line</label>
          <input data-field="line" type="number" min="1" max="${annotationLineInputMax(
            annotation,
            packageState,
          )}" value="${escapeAttr(annotationLineInputValue(annotation, packageState))}" />
        </div>
      </div>
      <div class="field">
        <label>Target JSON</label>
        <textarea data-field="targetText">${escapeHtml(annotation.targetText)}</textarea>
      </div>
      <div class="compact-row">
        <div class="field">
          <label>Labels</label>
          <input data-field="labels" value="${escapeAttr(annotation.labels)}" />
        </div>
        <div class="field">
          <label>Created</label>
          <input data-field="created" value="${escapeAttr(annotation.created)}" />
        </div>
      </div>
    </div>
  `;
}

function annotationSaveButtonHtml(annotation: EditableAnnotation): string {
  if (locallySavedAnnotationIds.has(annotation.id)) {
    return `<button class="primary annotation-save-button is-saved" type="button" data-field="save">
      <span aria-hidden="true">✓</span>
      <span>Saved</span>
    </button>`;
  }
  return `<button class="primary annotation-save-button" type="button" data-field="save">Save</button>`;
}

function bindAnnotationInput(
  root: HTMLElement,
  annotation: EditableAnnotation,
  field: keyof EditableAnnotation,
  historyKey: string,
  update: (value: string) => void,
): void {
  const input = root.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
    `[data-field="${field}"]`,
  );
  if (!input) {
    return;
  }
  const handleChange = () => {
    const before = captureStateSnapshot();
    const undoLengthBefore = undoStack.length;
    recordHistoryCheckpoint({
      coalesceKey: `annotation:${historyKey}:${String(field)}`,
    });
    update(input.value);
    const after = captureStateSnapshot();
    if (before && after && snapshotKey(before) === snapshotKey(after)) {
      if (undoStack.length > undoLengthBefore) {
        undoStack.pop();
      }
      syncHistoryButtons();
      return;
    }
    if (field === "id") {
      const title = root.querySelector<HTMLDivElement>(".item-title");
      if (title) {
        title.textContent = annotation.id;
      }
    }
    locallySavedAnnotationIds.delete(annotation.id);
    resetAnnotationSaveButton(root);
    markDirty();
  };
  if (input instanceof HTMLSelectElement || field === "line") {
    input.addEventListener("change", handleChange);
  } else {
    input.addEventListener("input", handleChange);
  }
  if (field === "line") {
    input.addEventListener("keydown", (event) => {
      const keyboardEvent = event as KeyboardEvent;
      if (keyboardEvent.key !== "Enter") {
        return;
      }
      keyboardEvent.preventDefault();
      input.blur();
    });
  }
}

function resetAnnotationSaveButton(root: HTMLElement): void {
  const button = root.querySelector<HTMLButtonElement>('[data-field="save"]');
  if (!button?.classList.contains("is-saved")) {
    return;
  }
  button.classList.remove("is-saved");
  button.textContent = "Save";
}

function updateAnnotationTargetFromLocation(annotation: EditableAnnotation): void {
  if (!state || !annotation.line) {
    return;
  }
  const line = Number(annotation.line);
  if (!Number.isInteger(line) || line < 1) {
    return;
  }
  annotation.targetText = JSON.stringify(sourceLineTarget(state.manifest.entrypoint, line), null, 2);
}

function syncAnnotationLocationFromTarget(annotation: EditableAnnotation): void {
  if (!state) {
    return;
  }
  try {
    const target = targetRecord(JSON.parse(annotation.targetText));
    const line = annotationTargetSourceLine(target, state.manifest.entrypoint, state.blocks);
    annotation.line = line?.toString() ?? "";
    annotation.page = line ? inferPageForLine(state.markdown, line, state.pageMap) : "";
    manualAnnotationLocations.delete(annotation.id);
    renderedAnnotationLocations.delete(annotation.id);
  } catch {
    // Keep the user's in-progress JSON edit intact until it parses.
  }
}

function updateAnnotationTargetTextarea(root: HTMLElement, annotation: EditableAnnotation): void {
  const input = root.querySelector<HTMLTextAreaElement>('[data-field="targetText"]');
  if (input) {
    input.value = annotation.targetText;
  }
}

function updateAnnotationLocationInputs(root: HTMLElement, annotation: EditableAnnotation): void {
  const pageInput = root.querySelector<HTMLSelectElement>('[data-field="page"]');
  const lineInput = root.querySelector<HTMLInputElement>('[data-field="line"]');
  if (pageInput) {
    pageInput.value = state ? annotationPageInputValue(annotation, state) : annotation.page;
  }
  if (lineInput && state) {
    lineInput.value = annotationLineInputValue(annotation, state);
    lineInput.max = annotationLineInputMax(annotation, state);
  } else if (lineInput) {
    lineInput.value = annotation.line;
  }
}

function markDirty(options: { render?: boolean } = {}): void {
  if (!state) {
    return;
  }
  state.dirty = true;
  fileNameEl.textContent = `${state.fileName} (edited)`;
  syncHistoryButtons();
  if (options.render !== false) {
    queueRender();
  }
}

function setPreviewEditMode(enabled: boolean): void {
  if (!state) {
    enabled = false;
  }
  if (previewEditMode === enabled) {
    return;
  }
  previewEditMode = enabled;
  applyPreviewEditMode();
  syncEditModeButton();
  if (!enabled && state) {
    if (previewAutoDoneTimer) {
      window.clearTimeout(previewAutoDoneTimer);
      previewAutoDoneTimer = undefined;
    }
    closeActiveModal();
    cancelWordAnnotationPick();
    renderTablesEditor();
    queueRender();
  }
}

function syncEditModeButton(): void {
  for (const button of editModeButtons) {
    button.textContent = previewEditMode ? "Done" : "Edit";
    button.setAttribute("aria-pressed", previewEditMode ? "true" : "false");
    button.classList.toggle("primary", previewEditMode);
  }
}

function armWordAnnotationPick(): void {
  if (!state) {
    return;
  }
  annotationWordPickArmed = true;
  setActiveTab("annotations");
  setSidebarExpanded(true);
  syncAnnotationPickUi();
  setStatus("Click a word in the preview to attach the annotation.");
}

function cancelWordAnnotationPick(): void {
  if (!annotationWordPickArmed) {
    return;
  }
  annotationWordPickArmed = false;
  syncAnnotationPickUi();
  setStatus("");
}

function syncAnnotationPickUi(): void {
  quickAnnotationButton.classList.toggle("is-active", annotationWordPickArmed);
  addAnnotationButton.classList.toggle("is-active", annotationWordPickArmed);
  quickAnnotationButton.setAttribute("aria-pressed", annotationWordPickArmed ? "true" : "false");
  addAnnotationButton.setAttribute("aria-pressed", annotationWordPickArmed ? "true" : "false");
  preview.classList.toggle("is-annotation-pick-mode", annotationWordPickArmed);
}

function schedulePreviewEditAutoDone(): void {
  if (previewAutoDoneTimer) {
    window.clearTimeout(previewAutoDoneTimer);
  }
  previewAutoDoneTimer = window.setTimeout(() => {
    previewAutoDoneTimer = undefined;
    autoDonePreviewEdits();
  }, 80);
}

function autoDonePreviewEdits(): void {
  if (!state || !previewEditMode) {
    return;
  }
  const active = document.activeElement;
  if (
    active instanceof Element &&
    active.closest(
      ".inline-editable, .inline-edit-target, .preview-table-wrap, .mcd-insert-text-target, .mcd-insert-plus",
    )
  ) {
    return;
  }
  setPreviewEditMode(false);
}

function queueRender(): void {
  if (renderTimer) {
    window.clearTimeout(renderTimer);
  }
  renderTimer = window.setTimeout(() => {
    void renderAndValidate();
  }, 350);
}

async function renderAndValidate(): Promise<void> {
  if (!state) {
    return;
  }
  if (renderTimer) {
    window.clearTimeout(renderTimer);
    renderTimer = undefined;
  }
  clearDiagnostics();
  revokeAssetUrls();
  try {
    const bytes = await packageBytes();
    const doc = await openMcd(bytes);
    const validation = doc.validate();
    renderDiagnostics(validation);
    const blocks = validation.valid ? doc.blocks() : [];
    state.blocks = blocks;
    const markdown = validation.valid ? doc.markdown({ expandTables: false }) : state.markdown;
    await renderMarkdownPreview(markdown, blocks);
    setStatus(
      validation.valid ? "" : "Document has validation errors. Preview is rendered from the Markdown editor.",
    );
  } catch (error) {
    state.blocks = [];
    await renderMarkdownPreview(state.markdown);
    showError(error);
  }
}

function annotationPreviewItems(markdown: string): AnnotationPreviewItem[] {
  if (!state || state.annotations.length === 0) {
    return [];
  }

  const lineCount = markdownLineCount(markdown);
  const inlinePositions = inlineAnnotationPositions(markdown);
  const sortable = state.annotations.map((annotation, index) => {
    const manualLocation = manualAnnotationLocations.get(annotation.id);
    const inlinePosition = manualLocation ? undefined : inlinePositions.get(annotation.id);
    const targetLine = Number(annotation.line);
    const sourceLine = Number.isInteger(targetLine) && targetLine > 0 ? targetLine : 1;
    const line =
      inlinePosition?.line ??
      annotationPreviewSourceLine(annotation, sourceLine);
    const page =
      manualLocation?.renderedPage ??
      manualLocation?.page ??
      Number(inferPageForLine(markdown, line, state?.pageMap));
    const pageLine = manualLocation?.line ?? pageLineForSourceLine(markdown, line, state?.pageMap);
    return {
      id: annotation.id,
      annotation,
      line: Math.min(Math.max(1, line), lineCount),
      column: inlinePosition?.column ?? Number.MAX_SAFE_INTEGER,
      hasInlineMarker: Boolean(inlinePosition),
      manualLocation,
      page,
      pageLine,
      manifestIndex: index,
    };
  });

  sortable.sort((left, right) => {
    return (
      left.page - right.page ||
      left.pageLine - right.pageLine ||
      left.column - right.column ||
      left.manifestIndex - right.manifestIndex
    );
  });

  return sortable.map((item, index) => ({
    id: item.id,
    annotation: item.annotation,
    line: item.line,
    hasInlineMarker: item.hasInlineMarker,
    manualLocation: item.manualLocation,
    number: index + 1,
  }));
}

function annotationPreviewSourceLine(annotation: EditableAnnotation, sourceLine: number): number {
  const block =
    annotationTargetBlock(annotation) ??
    sourceLineBlock(sourceLine, state?.blocks ?? []);
  if (block?.source && (block.type === "table_ref" || block.type === "image_ref")) {
    return block.source.endLine;
  }
  return sourceLine;
}

function annotationTargetBlock(annotation: EditableAnnotation): DocumentBlock | undefined {
  if (!state) {
    return undefined;
  }

  try {
    const target = targetRecord(JSON.parse(annotation.targetText));
    return state.blocks.find((block) => blockMatchesAnnotationTarget(block, target ?? {}));
  } catch {
    return undefined;
  }
}

function sourceLineBlock(sourceLine: number, blocks: DocumentBlock[]): DocumentBlock | undefined {
  return blocks.find((block) => {
    const source = block.source;
    return Boolean(source && source.startLine <= sourceLine && sourceLine <= source.endLine);
  });
}

function inlineAnnotationPositions(markdown: string): Map<string, { line: number; column: number }> {
  const positions = new Map<string, { line: number; column: number }>();
  const lines = markdown.split(/\r\n|\r|\n/);
  const markerPattern = /\[\[annotation:([A-Za-z0-9][A-Za-z0-9_.-]*)\]\]/g;
  const bodyToId = new Map(state?.annotations.map((annotation) => [annotation.body, annotation.id]));
  const generatedPattern = /\(@annotation:\s*\[([^\]]*)\]\)/g;

  lines.forEach((line, lineIndex) => {
    markerPattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = markerPattern.exec(line)) !== null) {
      const id = match[1];
      if (id && !positions.has(id)) {
        positions.set(id, { line: lineIndex + 1, column: match.index + 1 });
      }
    }

    if (isStandaloneGeneratedAnnotationLine(line)) {
      return;
    }

    generatedPattern.lastIndex = 0;
    while ((match = generatedPattern.exec(line)) !== null) {
      const id = bodyToId.get(match[1] ?? "");
      if (id && !positions.has(id)) {
        positions.set(id, { line: lineIndex + 1, column: match.index + 1 });
      }
    }
  });

  return positions;
}

function annotatedPreviewMarkdown(markdown: string, items: AnnotationPreviewItem[]): string {
  const itemById = new Map(items.map((item) => [item.id, item]));
  const lineMarkers = new Map<number, AnnotationPreviewItem[]>();
  for (const item of items) {
    if (item.hasInlineMarker || item.manualLocation) {
      continue;
    }
    const markers = lineMarkers.get(item.line) ?? [];
    markers.push(item);
    lineMarkers.set(item.line, markers);
  }

  const lines = markdown.split(/\r\n|\r|\n/).map((line, index) => {
    if (isStandaloneGeneratedAnnotationLine(line)) {
      return "";
    }

    let withInlineMarkers = line.replace(
      /\[\[annotation:([A-Za-z0-9][A-Za-z0-9_.-]*)\]\]/g,
      (_raw, id: string) => {
        const item = itemById.get(id);
        return item ? annotationMarkerHtml(item) : "";
      },
    );
    withInlineMarkers = withInlineMarkers.replace(
      /\(@annotation:\s*\[([^\]]*)\]\)/g,
      (_raw, body: string) => {
        const item = items.find((candidate) => candidate.annotation.body === body);
        return item ? annotationMarkerHtml(item) : "";
      },
    );
    const markers = lineMarkers.get(index + 1);
    if (!markers || markers.length === 0) {
      return withInlineMarkers;
    }
    const markerHtml = markers
      .sort((left, right) => left.number - right.number)
      .map(annotationMarkerHtml)
      .join("");
    return withInlineMarkers.trim() ? `${withInlineMarkers} ${markerHtml}` : markerHtml;
  });

  return lines.join("\n");
}

function isStandaloneGeneratedAnnotationLine(line: string): boolean {
  return /^\s*\(@annotation:\s*\[[^\]]*\]\)\s*$/.test(line);
}

function annotationMarkerHtml(item: AnnotationPreviewItem): string {
  return `<sup id="mcd-annotation-ref-${escapeAttr(
    item.id,
  )}" class="mcd-annotation-marker"><a href="#mcd-annotation-${escapeAttr(
    item.id,
  )}" aria-label="Annotation ${item.number}">${item.number}</a></sup>`;
}

function annotationEndnotesNode(items: AnnotationPreviewItem[]): HTMLElement | undefined {
  if (items.length === 0) {
    return undefined;
  }

  const section = document.createElement("section");
  section.className = "mcd-annotations";
  section.setAttribute("aria-label", "Annotations");

  const heading = document.createElement("h2");
  heading.textContent = "Annotations";

  const list = document.createElement("ol");
  for (const item of items) {
    const entry = document.createElement("li");
    entry.id = `mcd-annotation-${item.id}`;

    const link = document.createElement("a");
    link.className = "mcd-annotation-backlink";
    link.href = `#mcd-annotation-ref-${item.id}`;
    link.setAttribute("aria-label", `Back to annotation ${item.number}`);

    const kind = document.createElement("span");
    kind.className = "mcd-annotation-kind";
    kind.textContent = item.annotation.kind;

    link.append(kind, document.createTextNode(`: ${item.annotation.body}`));
    entry.appendChild(link);
    list.appendChild(entry);
  }

  section.append(heading, list);
  return section;
}

function resetLazyPreviewTables(): void {
  previewLazyTableObserver?.disconnect();
  previewLazyTableObserver = undefined;
  previewLazyTables = [];
  previewVirtualTables = new WeakMap();
  if (previewTableRepaginateFrame !== undefined) {
    window.cancelAnimationFrame(previewTableRepaginateFrame);
    previewTableRepaginateFrame = undefined;
  }
}

function lazyPreviewTableMarkdown(markdown: string, blocks: DocumentBlock[]): string {
  const blockPlacements = tablePlacementsFromBlocks(blocks);
  let blockCursor = 0;
  const directivePattern = /(^|\n):::\s*table[^\n]*\n([\s\S]*?)\n:::/g;
  return markdown.replace(directivePattern, (raw, leading: string, body: string) => {
    const fields = directiveFields(body ?? "");
    const table = fields.get("table");
    if (!table) {
      return raw;
    }
    const placement: TablePlacement = {
      table,
      view: fields.get("view"),
      display: fields.get("display") === "chart" ? "chart" : "table",
      caption: fields.get("caption"),
    };
    const blockMatch = nextMatchingTablePlacement(blockPlacements, blockCursor, placement);
    if (blockMatch) {
      blockCursor = blockMatch.index + 1;
      placement.source = blockMatch.placement.source;
      placement.caption ??= blockMatch.placement.caption;
    }
    const index = previewLazyTables.push({ placement }) - 1;
    return `${leading}${lazyPreviewTableHtml(index, placement)}`;
  });
}

function nextMatchingTablePlacement(
  placements: TablePlacement[],
  startIndex: number,
  target: TablePlacement,
): { index: number; placement: TablePlacement } | undefined {
  for (let index = startIndex; index < placements.length; index += 1) {
    const placement = placements[index];
    if (
      placement.table === target.table &&
      placement.display === target.display &&
      (placement.view ?? "") === (target.view ?? "")
    ) {
      return { index, placement };
    }
  }
  return undefined;
}

function lazyPreviewTableHtml(index: number, placement: TablePlacement): string {
  const caption = placement.caption
    ? `<figcaption>${escapeHtml(placement.caption)}</figcaption>`
    : "";
  const view = placement.view ? ` data-mcd-view-id="${escapeAttr(placement.view)}"` : "";
  return `<figure class="mcd-table-figure mcd-lazy-table" data-mcd-lazy-table-index="${index}" data-mcd-table-id="${escapeAttr(
    placement.table,
  )}"${view} data-mcd-display="${placement.display}">
${caption}
<div class="mcd-lazy-table-placeholder" role="status" aria-label="Table preview pending"></div>
</figure>`;
}

async function renderMarkdownPreview(markdown: string, blocks: DocumentBlock[] = []): Promise<void> {
  resetLazyPreviewTables();
  const annotationItems = annotationPreviewItems(markdown);
  const lazyMarkdown = lazyPreviewTableMarkdown(
    annotatedPreviewMarkdown(markdown, annotationItems),
    blocks,
  );
  const rendered = marked.parse(lazyMarkdown, {
    async: false,
  }) as string;
  const sanitized = DOMPurify.sanitize(rendered, {
    USE_PROFILES: { html: true, mathMl: true },
    ADD_ATTR: [
      "aria-label",
      "data-mcd-display",
      "data-mcd-lazy-table-index",
      "data-mcd-table-id",
      "data-mcd-view-id",
      "role",
      "target",
    ],
  });
  renderPagedPreview(sanitized, annotationItems);
  renderEmptyFirstHeadingPlaceholder(markdown, blocks);
  enhancePreviewDom();
  await rewritePackageImageSources();
  await waitForPreviewImages();
  repaginatePreviewWithScrollableTables();
  enableInlinePreviewEditing(blocks);
  setupLazyPreviewTables();
  syncRenderedLogicalPageLines();
  renderManualAnnotationMarkers(annotationItems);
  syncRenderedAnnotationLocations();
  if (activeTab === "annotations" && !annotationsEditor.contains(document.activeElement)) {
    renderAnnotationsEditor();
  }
}

function syncRenderedLogicalPageLines(): void {
  renderedLogicalPageLines = new Map();
  if (!state) {
    return;
  }

  for (const page of pageChoices(state)) {
    const range = pageSourceRange(state.markdown, page.number, state.pageMap);
    renderedLogicalPageLines.set(page.number, renderedLogicalLinesForSourceRange(range));
  }
}

function renderedLogicalLinesForSourceRange(range: { startLine: number; endLine: number }): RenderedLogicalLine[] {
  const records: RenderedLogicalLine[] = [];
  for (const body of Array.from(preview.querySelectorAll<HTMLDivElement>(".preview-page-body"))) {
    const bodyTop = body.getBoundingClientRect().top;
    for (const element of Array.from(body.children)) {
      if (!(element instanceof HTMLElement) || !previewElementHasInsertionContent(element)) {
        continue;
      }

      const source = sourceForPreviewElement(element);
      if (!source || !sourceOverlapsRange(source, range)) {
        continue;
      }

      const rects = renderedLineRects(element);
      if (rects.length === 0) {
        const rect = element.getBoundingClientRect();
        if (rect.height > 0) {
          rects.push(rect);
        }
      }

      let localLineIndex = 0;
      for (const rect of rects) {
        if (rect.height <= 0) {
          continue;
        }

        const top = rect.top - bodyTop;
        const previous = records.at(-1);
        if (previous?.body === body && Math.abs(previous.top - top) < 3) {
          previous.bottom = Math.max(previous.bottom, rect.bottom - bodyTop);
          continue;
        }

        records.push({
          body,
          top,
          bottom: rect.bottom - bodyTop,
          sourceLine: Math.min(source.endLine, source.startLine + localLineIndex),
        });
        localLineIndex += 1;
      }
    }
  }
  return records;
}

function renderedLineRects(element: HTMLElement): DOMRect[] {
  const rects: DOMRect[] = [];
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    const parent = node.parentElement;
    if (
      node.textContent?.trim() &&
      !parent?.closest(".mcd-annotation-marker, .mcd-citation-ref")
    ) {
      const range = document.createRange();
      range.selectNodeContents(node);
      rects.push(
        ...Array.from(range.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0),
      );
      range.detach();
    }
    node = walker.nextNode();
  }
  return rects.sort((left, right) => left.top - right.top || left.left - right.left);
}

function sourceOverlapsRange(source: SourceSpan, range: { startLine: number; endLine: number }): boolean {
  return source.startLine <= range.endLine && source.endLine >= range.startLine;
}

function renderedLogicalPageLineCount(page: number): number | undefined {
  const count = renderedLogicalPageLines.get(page)?.length;
  return count ? Math.max(1, count) : undefined;
}

function manualAnnotationLocationForPageLine(page: number, line: number): AnnotationPageLocation {
  return {
    page,
    line,
    top: renderedLogicalPageLines.get(page)?.[line - 1]?.top,
  };
}

function renderManualAnnotationMarkers(items: AnnotationPreviewItem[]): void {
  preview
    .querySelectorAll<HTMLElement>(".mcd-rendered-annotation-marker")
    .forEach((marker) => marker.remove());

  const occupiedLines = new Map<string, number>();
  for (const item of items) {
    if (!item.manualLocation) {
      continue;
    }

    const target = manualAnnotationMarkerTarget(item.manualLocation);
    if (!target) {
      continue;
    }

    const lineKey = `${item.manualLocation.page}:${item.manualLocation.line}`;
    const offset = occupiedLines.get(lineKey) ?? 0;
    occupiedLines.set(lineKey, offset + 1);

    const marker = document.createElement("sup");
    marker.id = `mcd-annotation-ref-${item.id}`;
    marker.className = "mcd-annotation-marker mcd-rendered-annotation-marker";
    marker.style.top = `${Math.max(0, target.top)}px`;
    if (offset > 0) {
      marker.style.transform = `translateX(${offset * 0.85}rem)`;
    }

    const link = document.createElement("a");
    link.href = `#mcd-annotation-${item.id}`;
    link.setAttribute("aria-label", `Annotation ${item.number}`);
    link.textContent = String(item.number);
    marker.appendChild(link);
    target.body.appendChild(marker);
  }
}

function manualAnnotationMarkerTarget(
  location: AnnotationPageLocation,
): { body: HTMLDivElement; top: number } | undefined {
  const body = preview
    .querySelector<HTMLElement>(
      `.preview-page[data-page-number="${location.renderedPage ?? location.page}"]`,
    )
    ?.querySelector<HTMLDivElement>(".preview-page-body");
  if (body && typeof location.top === "number" && Number.isFinite(location.top)) {
    return { body, top: location.top };
  }

  const logicalLine = renderedLogicalPageLines.get(location.page)?.[location.line - 1];
  if (logicalLine) {
    return { body: logicalLine.body, top: logicalLine.top };
  }

  if (!body) {
    return undefined;
  }
  return {
    body,
    top: (Math.max(1, location.line) - 1) * previewInsertionLineHeight(body),
  };
}

function sourceLineForRenderedLogicalPageLine(page: number, line: number): number | undefined {
  const lines = renderedLogicalPageLines.get(page);
  if (!lines || lines.length === 0) {
    return undefined;
  }
  const index = Math.min(lines.length - 1, Math.max(0, line - 1));
  return lines[index]?.sourceLine;
}

function renderedLogicalLineForElement(
  page: number,
  element: HTMLElement,
  body: HTMLDivElement,
): number | undefined {
  const lines = renderedLogicalPageLines.get(page);
  if (!lines || lines.length === 0) {
    return undefined;
  }

  const rect = element.getBoundingClientRect();
  const bodyTop = body.getBoundingClientRect().top;
  const y = rect.top + rect.height / 2 - bodyTop;
  const index = lines.findIndex((line) => {
    return line.body === body && line.top - 2 <= y && y <= line.bottom + 2;
  });
  return index >= 0 ? index + 1 : undefined;
}

function syncRenderedAnnotationLocations(): void {
  renderedAnnotationLocations = new Map();
  for (const marker of Array.from(preview.querySelectorAll<HTMLElement>(".mcd-annotation-marker[id]"))) {
    const id = marker.id.replace(/^mcd-annotation-ref-/, "");
    if (!id) {
      continue;
    }

    const body = marker.closest<HTMLDivElement>(".preview-page-body");
    const page = marker.closest<HTMLElement>(".preview-page");
    if (!body || !page) {
      continue;
    }

    const pageNumber = Number(page.dataset.pageNumber);
    if (!Number.isInteger(pageNumber) || pageNumber < 1) {
      continue;
    }

    const annotation = state?.annotations.find((candidate) => candidate.id === id);
    const sourceLine = Number(annotation?.line);
    const logicalPage =
      Number.isInteger(sourceLine) && sourceLine > 0 && state
        ? Number(inferPageForLine(state.markdown, sourceLine, state.pageMap))
        : pageNumber;
    renderedAnnotationLocations.set(id, {
      page: logicalPage,
      line:
        renderedLogicalLineForElement(logicalPage, marker, body) ??
        (Number.isInteger(sourceLine) && sourceLine > 0 && state
          ? pageLineForSourceLine(state.markdown, sourceLine, state.pageMap)
          : renderedLineForElement(marker, body)),
    });
  }
}

function renderedLineForElement(element: HTMLElement, body: HTMLDivElement): number {
  const lineHeight = previewInsertionLineHeight(body);
  const elementRect = element.getBoundingClientRect();
  const bodyRect = body.getBoundingClientRect();
  const y = elementRect.top + elementRect.height / 2 - bodyRect.top;
  return Math.max(1, Math.floor(y / lineHeight) + 1);
}

function renderedPageLineCount(pageNumber: number): number | undefined {
  const body = preview
    .querySelector<HTMLElement>(`.preview-page[data-page-number="${pageNumber}"]`)
    ?.querySelector<HTMLDivElement>(".preview-page-body");
  if (!body) {
    return undefined;
  }

  return Math.max(1, Math.floor(previewPageBodyClientHeight(body) / previewInsertionLineHeight(body)));
}

function sourceLineForRenderedAnnotationLocation(pageNumber: number, line: number): number | undefined {
  const body = preview
    .querySelector<HTMLElement>(`.preview-page[data-page-number="${pageNumber}"]`)
    ?.querySelector<HTMLDivElement>(".preview-page-body");
  if (!body) {
    return undefined;
  }

  const lineHeight = previewInsertionLineHeight(body);
  return markdownInsertionLine({
    body,
    y: (Math.max(1, line) - 0.5) * lineHeight,
  });
}

function renderEmptyFirstHeadingPlaceholder(markdown: string, blocks: DocumentBlock[]): void {
  if (!state || markdown.trim() || blocks.length > 0) {
    return;
  }

  const pageBody = preview.querySelector<HTMLDivElement>(".preview-page-body");
  if (!pageBody) {
    return;
  }

  pageBody.querySelector(".empty-state")?.remove();
  const heading = document.createElement("h1");
  heading.id = EMPTY_FIRST_HEADING_ID;
  heading.className = "inline-empty-first-heading";
  heading.dataset.placeholder = "Title";
  pageBody.prepend(heading);
}

function enableInlinePreviewEditing(blocks: DocumentBlock[]): void {
  if (!state) {
    return;
  }
  inlineTextBindings = new WeakMap();
  inlineTableBindings = new WeakMap();
  inlineTableHeaderBindings = new WeakMap();
  previewBlockSources = new WeakMap();
  for (const marker of Array.from(
    preview.querySelectorAll<HTMLElement>(".mcd-annotation-marker, .mcd-citation-ref"),
  )) {
    marker.contentEditable = "false";
  }
  enableInlineTextEditing(blocks);
  enableInlineTableEditing(blocks);
  bindPreviewImageSources(blocks);
  applyTableHeaderPreferences(blocks);
  applyPreviewEditMode();
}

function enableInlineTextEditing(blocks: DocumentBlock[]): void {
  const candidates = editableTextCandidates();
  const boundElements = new Set<HTMLElement>();
  let cursor = 0;

  for (const block of blocks) {
    if (!isEditableTextBlock(block) || !block.source) {
      continue;
    }
    const blockText = normalizedEditableText(block.text);
    if (!blockText) {
      continue;
    }

    const matchIndex = candidates.findIndex(
      (candidate, index) => index >= cursor && candidateMatchesTextBlock(candidate, blockText),
    );
    if (matchIndex < 0) {
      continue;
    }

    const element = candidates[matchIndex];
    cursor = matchIndex + 1;
    bindInlineTextElement(element, block);
    boundElements.add(element);
  }

  for (const element of candidates) {
    if (boundElements.has(element) || inlineTextBindings.has(element)) {
      continue;
    }
    const emptyHeading = emptyFirstHeadingBlockForElement(element);
    bindInlineTextElement(element, emptyHeading);
  }
}

function editableTextCandidates(): HTMLElement[] {
  return Array.from(
    preview.querySelectorAll<HTMLElement>(
      ".preview-page-body h1, .preview-page-body h2, .preview-page-body h3, .preview-page-body h4, .preview-page-body h5, .preview-page-body h6, .preview-page-body p, .preview-page-body ul, .preview-page-body ol, .preview-page-body blockquote",
    ),
  ).filter((element) => {
    return !element.closest(".mcd-annotations, table, .mcd-math");
  });
}

function isEditableTextBlock(
  block: DocumentBlock,
): block is EditableTextBlock {
  return ["heading", "paragraph", "list", "quote"].includes(block.type);
}

function bindInlineTextElement(element: HTMLElement, block?: EditableTextBlock): void {
  element.tabIndex = 0;
  element.classList.add("inline-edit-target");
  inlineTextBindings.set(element, { block, source: block?.source });
  if (block?.source) {
    previewBlockSources.set(element, block.source);
  }

  element.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") {
      return;
    }
    const binding = inlineTextBindings.get(element);
    if (binding?.block?.type === "heading" && binding.source && previewEditMode) {
      splitHeadingInlineEdit(event, element, binding);
      return;
    }
    event.stopPropagation();
  });
  element.addEventListener("input", () => {
    if (!previewEditMode) {
      return;
    }
    const binding = inlineTextBindings.get(element);
    if (binding?.headingSplit) {
      updateMarkdownFromHeadingSplit(binding.headingSplit);
      renderInsertionGuides();
      return;
    }
    if (binding?.block) {
      updateMarkdownFromInlineText(element, binding);
      renderInsertionGuides();
    }
  });
}

function createAnnotationFromWordClick(event: MouseEvent): boolean {
  if (!state || !annotationWordPickArmed || event.button !== 0) {
    return false;
  }

  const target = event.target as Element | null;
  if (
    !target ||
    target.closest(
      "a, button, input, textarea, select, .mcd-annotation-marker, .mcd-citation-ref, .mcd-annotations, table",
    )
  ) {
    return false;
  }

  const element = target.closest<HTMLElement>(".inline-edit-target");
  const binding = element ? inlineTextBindings.get(element) : undefined;
  if (!element || !binding?.source) {
    return false;
  }

  const word = clickedWordAnchor(event, element);
  if (!word) {
    return false;
  }

  const inserted = createAnnotationAtWordAnchor(element, binding.source, word);
  if (!inserted) {
    return false;
  }

  annotationWordPickArmed = false;
  syncAnnotationPickUi();
  setStatus("");
  event.preventDefault();
  event.stopPropagation();
  return true;
}

interface ClickedWordAnchor {
  text: string;
  occurrenceIndex: number;
}

function clickedWordAnchor(event: MouseEvent, element: HTMLElement): ClickedWordAnchor | undefined {
  const caret = caretTextPositionFromPoint(event.clientX, event.clientY);
  if (!caret || !element.contains(caret.node)) {
    return undefined;
  }

  const text = caret.node.textContent ?? "";
  const bounds = wordBoundsAtOffset(text, caret.offset);
  if (!bounds) {
    return undefined;
  }

  const before = textBeforeNodeOffset(element, caret.node, bounds.start);
  return {
    text: text.slice(bounds.start, bounds.end),
    occurrenceIndex: wordTokens(before).length,
  };
}

function caretTextPositionFromPoint(x: number, y: number): { node: Text; offset: number } | undefined {
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const position = doc.caretPositionFromPoint?.(x, y);
  if (position?.offsetNode.nodeType === Node.TEXT_NODE) {
    return { node: position.offsetNode as Text, offset: position.offset };
  }

  const range = doc.caretRangeFromPoint?.(x, y);
  if (range?.startContainer.nodeType === Node.TEXT_NODE) {
    return { node: range.startContainer as Text, offset: range.startOffset };
  }
  return undefined;
}

function wordBoundsAtOffset(text: string, offset: number): { start: number; end: number } | undefined {
  if (!text) {
    return undefined;
  }

  let index = Math.min(Math.max(0, offset), text.length - 1);
  if (!isWordCharacter(text[index] ?? "") && index > 0 && isWordCharacter(text[index - 1] ?? "")) {
    index -= 1;
  }
  if (!isWordCharacter(text[index] ?? "")) {
    return undefined;
  }

  let start = index;
  let end = index + 1;
  while (start > 0 && isWordCharacter(text[start - 1] ?? "")) {
    start -= 1;
  }
  while (end < text.length && isWordCharacter(text[end] ?? "")) {
    end += 1;
  }
  return { start, end };
}

function isWordCharacter(value: string): boolean {
  return /^[\p{L}\p{N}_'-]$/u.test(value);
}

function textBeforeNodeOffset(root: HTMLElement, textNode: Text, offset: number): string {
  let text = "";
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    const parent = node.parentElement;
    if (!parent?.closest(".mcd-annotation-marker, .mcd-citation-ref")) {
      if (node === textNode) {
        return text + (node.textContent ?? "").slice(0, offset);
      }
      text += node.textContent ?? "";
    }
    node = walker.nextNode();
  }
  return text;
}

function wordTokens(value: string): string[] {
  return value.match(/[\p{L}\p{N}_]+(?:['-][\p{L}\p{N}_]+)*/gu) ?? [];
}

function createAnnotationAtWordAnchor(
  element: HTMLElement,
  source: SourceSpan,
  word: ClickedWordAnchor,
): boolean {
  if (!state) {
    return false;
  }

  const sourceText = markdownTextForSource(source);
  const wordMatch = rawWordMatch(sourceText.raw, word.text, word.occurrenceIndex);
  if (!wordMatch) {
    return false;
  }

  recordHistoryCheckpoint();
  discardPendingWordAnnotation();
  discardPendingMarginAnnotation();

  const id = nextAnnotationId(state);
  const marker = annotationMarkerToken(id);
  const insertionOffset = markdownInsertionOffsetAfterWord(sourceText.raw, wordMatch.end);
  state.markdown =
    state.markdown.slice(0, sourceText.globalStart + insertionOffset) +
    marker +
    state.markdown.slice(sourceText.globalStart + insertionOffset);
  setMarkdownEditorValue(state.markdown);

  const start = sourceLocationForOffset(source, sourceText.raw, wordMatch.start);
  const end = sourceLocationForOffset(source, sourceText.raw, wordMatch.end);
  const line = start.line;
  state.annotations.push({
    id,
    metadata: `annotations/${id}.annotation.json`,
    targetText: JSON.stringify(sourceRangeTarget(state.manifest.entrypoint, start, end), null, 2),
    page: inferPageForLine(state.markdown, line, state.pageMap),
    line: String(line),
    kind: "comment",
    status: "open",
    body: "New annotation",
    author: "",
    labels: "",
    created: new Date().toISOString(),
  });
  pendingWordAnnotationId = id;
  expandedAnnotationIds.add(id);
  setActiveTab("annotations");
  setSidebarExpanded(true);
  renderAnnotationsEditor();
  markDirty();
  return true;
}

function annotationMarkerToken(id: string): string {
  return `[[annotation:${id}]]`;
}

function markdownTextForSource(source: SourceSpan): { raw: string; globalStart: number } {
  const lines = state?.markdown.split(/\r\n|\r|\n/) ?? [];
  const startLine = Math.max(1, source.startLine);
  const endLine = Math.max(startLine, source.endLine);
  const globalStart =
    startLine <= 1 ? 0 : lines.slice(0, startLine - 1).join("\n").length + 1;
  return {
    raw: lines.slice(startLine - 1, endLine).join("\n"),
    globalStart,
  };
}

function rawWordMatch(
  raw: string,
  word: string,
  occurrenceIndex: number,
): { start: number; end: number } | undefined {
  const normalized = word.toLocaleLowerCase();
  const ignoredRanges = annotationMarkerRanges(raw);
  const pattern = /[\p{L}\p{N}_]+(?:['-][\p{L}\p{N}_]+)*/gu;
  let seen = 0;
  let fallback: { start: number; end: number } | undefined;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(raw)) !== null) {
    if (rangeOverlapsAny(match.index, pattern.lastIndex, ignoredRanges)) {
      continue;
    }
    if ((match[0] ?? "").toLocaleLowerCase() !== normalized) {
      continue;
    }
    const candidate = { start: match.index, end: pattern.lastIndex };
    fallback ??= candidate;
    if (seen === occurrenceIndex) {
      return candidate;
    }
    seen += 1;
  }
  return fallback;
}

function annotationMarkerRanges(raw: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  const pattern = /\[\[annotation:[A-Za-z0-9][A-Za-z0-9_.-]*\]\]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(raw)) !== null) {
    ranges.push({ start: match.index, end: pattern.lastIndex });
  }
  return ranges;
}

function rangeOverlapsAny(
  start: number,
  end: number,
  ranges: Array<{ start: number; end: number }>,
): boolean {
  return ranges.some((range) => start < range.end && range.start < end);
}

function markdownInsertionOffsetAfterWord(raw: string, wordEnd: number): number {
  let offset = wordEnd;
  if (raw.startsWith("](", offset)) {
    const close = raw.indexOf(")", offset + 2);
    if (close >= 0) {
      return close + 1;
    }
  }

  const closers = ["**", "__", "~~", "`", "*", "_"];
  let advanced = true;
  while (advanced) {
    advanced = false;
    for (const closer of closers) {
      if (raw.startsWith(closer, offset)) {
        offset += closer.length;
        advanced = true;
        break;
      }
    }
  }
  return offset;
}

function sourceLocationForOffset(
  source: SourceSpan,
  raw: string,
  offset: number,
): { line: number; column: number } {
  const prefix = raw.slice(0, Math.max(0, offset));
  const lines = prefix.split("\n");
  return {
    line: source.startLine + lines.length - 1,
    column: (lines.at(-1)?.length ?? 0) + 1,
  };
}

function emptyFirstHeadingBlockForElement(element: HTMLElement): EditableTextBlock | undefined {
  if (element.id !== EMPTY_FIRST_HEADING_ID) {
    return undefined;
  }
  return {
    type: "heading",
    id: EMPTY_FIRST_HEADING_ID,
    level: 1,
    text: "",
    source: {
      startLine: 1,
      startColumn: 1,
      endLine: 1,
      endColumn: 1,
    },
  };
}

function splitHeadingInlineEdit(
  event: KeyboardEvent,
  element: HTMLElement,
  binding: InlineTextBinding,
): void {
  if (!binding.block || binding.block.type !== "heading" || !binding.source) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();

  const split = editableSelectionSplit(element);
  element.textContent = split.before || editableText(element);

  const continuation = document.createElement("p");
  continuation.tabIndex = 0;
  continuation.className = "inline-edit-target inline-editable inline-editable-heading-continuation";
  continuation.contentEditable = "true";
  continuation.spellcheck = true;
  continuation.setAttribute("aria-label", "Editing text");
  continuation.textContent = split.after;
  element.insertAdjacentElement("afterend", continuation);

  const headingSplit: InlineHeadingSplitBinding = {
    block: binding.block,
    source: binding.source,
    heading: element,
    continuation,
  };
  binding.headingSplit = headingSplit;
  inlineTextBindings.set(continuation, { headingSplit });

  continuation.addEventListener("keydown", (continuationEvent) => {
    if (continuationEvent.key === "Enter") {
      continuationEvent.stopPropagation();
    }
  });
  continuation.addEventListener("input", () => {
    if (previewEditMode) {
      updateMarkdownFromHeadingSplit(headingSplit);
      renderInsertionGuides();
    }
  });

  updateMarkdownFromHeadingSplit(headingSplit);
  focusEditableEnd(continuation);
}

function editableSelectionSplit(element: HTMLElement): { before: string; after: string } {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    return { before: editableText(element), after: "" };
  }

  const range = selection.getRangeAt(0);
  if (!element.contains(range.commonAncestorContainer)) {
    return { before: editableText(element), after: "" };
  }

  const beforeRange = range.cloneRange();
  beforeRange.selectNodeContents(element);
  beforeRange.setEnd(range.startContainer, range.startOffset);

  const afterRange = range.cloneRange();
  afterRange.selectNodeContents(element);
  afterRange.setStart(range.endContainer, range.endOffset);

  return {
    before: normalizedRangeText(beforeRange),
    after: normalizedRangeText(afterRange),
  };
}

function normalizedRangeText(range: Range): string {
  return range.toString().replace(/\u00a0/g, " ").trim();
}

function focusEditableEnd(element: HTMLElement): void {
  element.focus();
  const range = document.createRange();
  range.selectNodeContents(element);
  range.collapse(false);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function focusEditableBeginning(element: HTMLElement): void {
  element.focus();
  const range = document.createRange();
  range.selectNodeContents(element);
  range.collapse(true);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function updateMarkdownFromHeadingSplit(binding: InlineHeadingSplitBinding): void {
  if (!state) {
    return;
  }
  const heading = editableText(binding.heading);
  const continuation = editableText(binding.continuation);
  const continuationLines = continuation
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const replacement = [
    `${"#".repeat(binding.block.level)} ${heading.trim()}`,
    ...continuationLines,
  ].join("\n");
  binding.source = replaceMarkdownSource(binding.source, replacement);
  markDirty({ render: false });
}

function updateMarkdownFromInlineText(element: HTMLElement, binding: InlineTextBinding): void {
  if (!state || !binding.block || !binding.source) {
    return;
  }

  const text = editableText(element);
  const replacement = markdownReplacementForInlineText(
    element,
    binding.block,
    binding.source,
    text,
  );
  binding.source = replaceMarkdownSource(binding.source, replacement);
  markDirty({ render: false });
}

function markdownReplacementForInlineText(
  element: HTMLElement,
  block: EditableTextBlock,
  source: SourceSpan,
  text: string,
): string {
  const lines = text
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const fallback = text.trim();

  if (block.type === "heading") {
    return `${"#".repeat(block.level)} ${fallback}`;
  }
  if (block.type === "quote") {
    return (lines.length > 0 ? lines : [fallback]).map((line) => `> ${line}`).join("\n");
  }
  if (block.type === "list") {
    return markdownListReplacement(element, source);
  }
  return fallback;
}

function markdownListReplacement(element: HTMLElement, source: SourceSpan): string {
  const itemTexts = Array.from(element.querySelectorAll<HTMLLIElement>("li"))
    .map((item) => editableText(item).trim())
    .filter(Boolean);
  if (itemTexts.length === 0) {
    return "";
  }
  const sourceLines = state?.markdown.split(/\r\n|\r|\n/).slice(source.startLine - 1, source.endLine) ?? [];
  const markers = sourceLines
    .map((line) => /^(\s*(?:[-*+]|\d+[.)])\s+)/.exec(line)?.[1])
    .filter((marker): marker is string => Boolean(marker));
  return itemTexts
    .map((item, index) => `${markers[index] ?? "- "}${item}`)
    .join("\n");
}

function replaceMarkdownSource(source: SourceSpan, replacement: string): SourceSpan {
  if (!state) {
    return source;
  }
  const lines = state.markdown.split(/\r\n|\r|\n/);
  const startIndex = Math.max(0, source.startLine - 1);
  const deleteCount = Math.max(1, source.endLine - source.startLine + 1);
  const existing = lines.slice(startIndex, startIndex + deleteCount).join("\n");
  if (existing === replacement) {
    return source;
  }
  recordHistoryCheckpoint({ coalesceKey: "preview-markdown" });
  const replacementLines = replacement.split("\n");
  lines.splice(startIndex, deleteCount, ...replacementLines);
  state.markdown = lines.join("\n");
  setMarkdownEditorValue(state.markdown);
  return {
    ...source,
    endLine: source.startLine + replacementLines.length - 1,
    endColumn: replacementLines.at(-1)?.length ?? source.startColumn,
  };
}

function editableText(element: HTMLElement): string {
  const clone = element.cloneNode(true) as HTMLElement;
  for (const ignored of Array.from(
    clone.querySelectorAll(".mcd-annotation-marker, .mcd-citation-ref"),
  )) {
    ignored.remove();
  }
  return editableNodeText(clone, clone)
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function editableNodeText(node: Node, root: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.textContent ?? "";
  }
  if (!(node instanceof HTMLElement)) {
    return Array.from(node.childNodes)
      .map((child) => editableNodeText(child, root))
      .join("");
  }
  if (node.tagName === "BR") {
    return "\n";
  }

  const text = Array.from(node.childNodes)
    .map((child) => editableNodeText(child, root))
    .join("");
  if (node !== root && isEditableLineBreakElement(node)) {
    return `\n${text}\n`;
  }
  return text;
}

function isEditableLineBreakElement(element: HTMLElement): boolean {
  return [
    "ADDRESS",
    "ARTICLE",
    "ASIDE",
    "BLOCKQUOTE",
    "DD",
    "DIV",
    "DL",
    "DT",
    "FIGCAPTION",
    "FIGURE",
    "FOOTER",
    "H1",
    "H2",
    "H3",
    "H4",
    "H5",
    "H6",
    "HEADER",
    "LI",
    "MAIN",
    "NAV",
    "OL",
    "P",
    "PRE",
    "SECTION",
    "TR",
    "UL",
  ].includes(element.tagName);
}

function normalizedEditableText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function candidateMatchesTextBlock(candidate: HTMLElement, blockText: string): boolean {
  const candidateText = normalizedEditableText(editableText(candidate));
  if (candidateText === blockText || candidateText.includes(blockText)) {
    return true;
  }

  const requiredWords = significantWords(blockText).slice(0, 8);
  if (requiredWords.length === 0) {
    return false;
  }
  const candidateWords = significantWords(candidateText);
  let cursor = 0;
  for (const word of requiredWords) {
    const index = candidateWords.indexOf(word, cursor);
    if (index < 0) {
      return false;
    }
    cursor = index + 1;
  }
  return true;
}

function significantWords(value: string): string[] {
  return value
    .toLowerCase()
    .match(/[a-z0-9]+/g)
    ?.filter((word) => word.length > 2) ?? [];
}

function applyPreviewEditMode(): void {
  preview.classList.toggle("is-edit-mode", previewEditMode);
  for (const element of Array.from(preview.querySelectorAll<HTMLElement>(".inline-edit-target"))) {
    const isEditable = previewEditMode && !element.closest(".mcd-annotations");
    element.contentEditable = isEditable ? "true" : "false";
    element.spellcheck = isEditable;
    element.classList.toggle("inline-editable", isEditable);
    element.setAttribute(
      "aria-label",
      isEditable
        ? inlineTableHeaderBindings.has(element)
          ? "Editing column name"
          : inlineTableBindings.has(element)
          ? "Editing table cell"
          : "Editing text"
        : inlineTableHeaderBindings.has(element)
          ? "Column name"
          : inlineTableBindings.has(element)
          ? "Table cell"
          : "Text block",
    );
  }
  renderInsertionGuides();
}

function enableInlineTableEditing(blocks: DocumentBlock[] = []): void {
  if (!state) {
    return;
  }

  const placements = tablePlacementsFromBlocks(blocks);
  if (placements.length === 0) {
    placements.push(...tablePlacementsFromMarkdown(state.markdown));
  }
  const previewTables = Array.from(
    preview.querySelectorAll<HTMLTableElement>(".preview-page-body table"),
  ).filter((table) => !table.closest(".mcd-annotations"));
  let tableCursor = 0;

  for (const placement of placements) {
    const tableState = state.tables.find((table) => table.manifest.id === placement.table);
    if (!tableState) {
      continue;
    }
    const columns = columnsForPlacement(tableState, placement);
    if (columns.length === 0) {
      continue;
    }

    const matchIndex = findPreviewTableForColumns(previewTables, tableCursor, columns);
    if (matchIndex < 0) {
      continue;
    }
    bindInlineTable(previewTables[matchIndex], tableState, placement, columns);
    applyPendingInsertionAlignment(
      "table",
      tableState.manifest.id,
      previewTables[matchIndex].closest<HTMLElement>(".preview-table-wrap") ?? previewTables[matchIndex],
    );
    if (placement.source) {
      const tableElement = previewTables[matchIndex];
      previewBlockSources.set(tableElement, placement.source);
      const wrapper = tableElement.closest<HTMLElement>(".preview-table-wrap");
      if (wrapper) {
        previewBlockSources.set(wrapper, placement.source);
      }
    }
    tableCursor = matchIndex + 1;
  }
}

function tablePlacementsFromBlocks(blocks: DocumentBlock[]): TablePlacement[] {
  return blocks.flatMap((block) => {
    if (block.type !== "table_ref") {
      return [];
    }
    const placement = block.placement as {
      table?: unknown;
      view?: unknown;
      display?: unknown;
      caption?: unknown;
    };
    if (typeof placement.table !== "string") {
      return [];
    }
    return [
      {
        table: placement.table,
        view: typeof placement.view === "string" ? placement.view : undefined,
        display: placement.display === "chart" ? "chart" : "table",
        caption: typeof placement.caption === "string" ? placement.caption : undefined,
        source: block.source,
      },
    ];
  });
}

function tablePlacementsFromMarkdown(markdown: string): TablePlacement[] {
  const placements: TablePlacement[] = [];
  const directivePattern = /(?:^|\n):::\s*table[^\n]*\n([\s\S]*?)\n:::/g;
  let match: RegExpExecArray | null;
  while ((match = directivePattern.exec(markdown)) !== null) {
    const fields = directiveFields(match[1] ?? "");
    const table = fields.get("table");
    if (!table) {
      continue;
    }
    placements.push({
      table,
      view: fields.get("view"),
      display: fields.get("display") === "chart" ? "chart" : "table",
      caption: fields.get("caption"),
    });
  }
  return placements;
}

function bindPreviewImageSources(blocks: DocumentBlock[]): void {
  const imageBlocks = blocks.filter(
    (block): block is Extract<DocumentBlock, { type: "image_ref" }> =>
      block.type === "image_ref" && Boolean(block.source),
  );
  if (imageBlocks.length === 0) {
    return;
  }

  const images = Array.from(
    preview.querySelectorAll<HTMLImageElement>(".preview-page-body img"),
  ).filter((image) => !image.closest(".mcd-annotations"));

  images.forEach((image, index) => {
    const block = imageBlocks[index];
    const source = block?.source;
    if (!block || !source) {
      return;
    }
    previewBlockSources.set(image, source);
    const topLevel = previewTopLevelElement(image);
    if (topLevel) {
      previewBlockSources.set(topLevel, source);
      const imageId = imageIdFromBlock(block);
      if (imageId) {
        applyPendingInsertionAlignment("image", imageId, topLevel);
      }
    }
  });
}

function imageIdFromBlock(block: Extract<DocumentBlock, { type: "image_ref" }>): string | undefined {
  const placement = block.placement as {
    image?: unknown;
    asset?: unknown;
  };
  return typeof placement.image === "string"
    ? placement.image
    : typeof placement.asset === "string"
      ? placement.asset
      : undefined;
}

function applyTableHeaderPreferences(blocks: DocumentBlock[]): void {
  if (!state) {
    return;
  }

  const placements = tablePlacementsFromBlocks(blocks);
  if (placements.length === 0) {
    placements.push(...tablePlacementsFromMarkdown(state.markdown));
  }

  const previewTables = Array.from(
    preview.querySelectorAll<HTMLTableElement>(".preview-page-body table"),
  ).filter((table) => !table.closest(".mcd-annotations"));
  let tableCursor = 0;

  for (const placement of placements) {
    const tableState = state.tables.find((table) => table.manifest.id === placement.table);
    if (!tableState) {
      continue;
    }
    const columns = columnsForPlacement(tableState, placement);
    if (columns.length === 0) {
      continue;
    }
    const matchIndex = findPreviewTableForColumns(previewTables, tableCursor, columns);
    if (matchIndex < 0) {
      continue;
    }
    const preferences = tableHeaderPreferences(tableState, placement);
    applyHeaderPreferencesToTable(previewTables[matchIndex], preferences);
    tableCursor = matchIndex + 1;
  }
}

function tableHeaderPreferences(
  table: EditableTable,
  placement: TablePlacement,
): { showColumnHeaders: boolean; showRowHeaders: boolean } {
  const view = placement.view ? table.views[placement.view] : undefined;
  return {
    showColumnHeaders: view?.style?.showColumnHeaders !== false,
    showRowHeaders: view?.style?.showRowHeaders === true,
  };
}

function applyHeaderPreferencesToTable(
  table: HTMLTableElement,
  preferences: { showColumnHeaders: boolean; showRowHeaders: boolean },
): void {
  if (!preferences.showRowHeaders) {
    removeReservedRowHeaderColumn(table);
  } else {
    convertReservedColumnToRowHeaders(table);
  }
  if (!preferences.showColumnHeaders) {
    table.querySelector("thead")?.remove();
  } else if (preferences.showRowHeaders) {
    clearRenderedCornerHeader(table);
  }
}

function clearRenderedCornerHeader(table: HTMLTableElement): void {
  const corner = table.querySelector<HTMLTableCellElement>("thead tr > :first-child");
  if (!corner) {
    return;
  }
  unbindInlineTableHeader(corner);
  corner.textContent = "";
  corner.removeAttribute("aria-label");
  corner.title = "";
}

function removeReservedRowHeaderColumn(table: HTMLTableElement): void {
  const header = table.querySelector<HTMLTableCellElement>("thead tr > :first-child");
  if (header) {
    unbindInlineTableHeader(header);
    header.remove();
  }
  Array.from(table.querySelectorAll<HTMLTableRowElement>("tbody tr")).forEach((row) => {
    const firstCell = row.querySelector<HTMLTableCellElement>("td, th");
    if (!firstCell) {
      return;
    }
    unbindInlineTableCell(firstCell);
    firstCell.remove();
  });
}

function convertReservedColumnToRowHeaders(table: HTMLTableElement): void {
  Array.from(table.querySelectorAll<HTMLTableRowElement>("tbody tr")).forEach((row, rowIndex) => {
    const firstCell = row.querySelector<HTMLTableCellElement>("td, th");
    if (!firstCell || firstCell.tagName === "TH") {
      return;
    }
    const header = document.createElement("th");
    header.scope = "row";
    for (const attribute of Array.from(firstCell.attributes)) {
      header.setAttribute(attribute.name, attribute.value);
    }
    header.innerHTML = firstCell.innerHTML;
    header.className = firstCell.className;
    header.tabIndex = firstCell.tabIndex;
    header.title = firstCell.title;
    const binding = inlineTableBindings.get(firstCell);
    if (binding) {
      bindInlineTableCell(header, binding, rowIndex);
    }
    firstCell.replaceWith(header);
  });
}

function previewTopLevelElement(element: HTMLElement): HTMLElement | undefined {
  let current: HTMLElement | null = element;
  while (current?.parentElement && !current.parentElement.classList.contains("preview-page-body")) {
    current = current.parentElement;
  }
  return current?.parentElement?.classList.contains("preview-page-body") ? current : undefined;
}

function directiveFields(body: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const line of body.split(/\r\n|\r|\n/)) {
    const [key, ...rest] = line.split(":");
    if (!key || rest.length === 0) {
      continue;
    }
    fields.set(key.trim(), rest.join(":").trim());
  }
  return fields;
}

function columnsForPlacement(
  table: EditableTable,
  placement: TablePlacement,
): Array<TableViewColumn & { label: string; schema: TableColumn }> {
  const view = placement.view ? table.views[placement.view] : undefined;
  const schemaByName = new Map(table.schema.columns.map((column) => [column.name, column]));
  const requested =
    placement.display === "chart" && view?.chart
      ? chartColumns(view.chart)
      : (view?.columns ?? table.schema.columns);

  return requested.flatMap((column) => {
    const schema = schemaByName.get(column.name);
    if (!schema) {
      return [];
    }
    return [
      {
        ...column,
        label: column.label ?? schema.label ?? column.name,
        schema,
      },
    ];
  });
}

function chartColumns(chart: NonNullable<TableView["chart"]>): TableViewColumn[] {
  const seen = new Set<string>();
  const columns: TableViewColumn[] = [];
  for (const column of [chart.x, chart.y, chart.series, chart.grouping, chart.markLabels]) {
    if (!column?.column || seen.has(column.column)) {
      continue;
    }
    seen.add(column.column);
    columns.push({
      name: column.column,
      label: column.label,
      format: column.format,
      currency: column.currency,
      unit: column.unit,
      percent: column.percent,
    });
  }
  return columns;
}

function findPreviewTableForColumns(
  tables: HTMLTableElement[],
  startIndex: number,
  columns: Array<TableViewColumn & { label: string; schema: TableColumn }>,
): number {
  const expected = columns.map((column) => normalizedEditableText(column.label));
  for (let index = startIndex; index < tables.length; index += 1) {
    const headers = Array.from(tables[index].querySelectorAll("thead th")).map((header) =>
      normalizedEditableText(header.textContent ?? ""),
    );
    if (
      headers.length === expected.length &&
      headers.every((header, columnIndex) => header === expected[columnIndex])
    ) {
      return index;
    }
  }
  return -1;
}

function bindInlineTable(
  tableElement: HTMLTableElement,
  tableState: EditableTable,
  placement: TablePlacement,
  columns: Array<TableViewColumn & { label: string; schema: TableColumn }>,
): void {
  tableElement.classList.add("inline-editable-table");
  bindInlineTableHeaders(tableElement, tableState, placement, columns);
  const rows = Array.from(tableElement.querySelectorAll<HTMLTableRowElement>("tbody tr"));
  rows.forEach((rowElement, rowIndex) => {
    const row = tableState.rows[rowIndex];
    if (!row) {
      return;
    }
    const cells = Array.from(rowElement.querySelectorAll<HTMLTableCellElement>("td"));
    cells.forEach((cell, columnIndex) => {
      const column = columns[columnIndex];
      if (!column) {
        return;
      }
      cell.tabIndex = 0;
      cell.classList.add("inline-edit-target");
      cell.title = `${tableState.manifest.id} ${column.name} row ${rowIndex + 1}`;
      bindInlineTableCell(cell, { row, column }, rowIndex);
    });
  });
}

function bindInlineTableHeaders(
  tableElement: HTMLTableElement,
  tableState: EditableTable,
  placement: TablePlacement,
  columns: Array<TableViewColumn & { label: string; schema: TableColumn }>,
): void {
  const headers = Array.from(tableElement.querySelectorAll<HTMLTableCellElement>("thead th"));
  headers.forEach((header, columnIndex) => {
    const column = columns[columnIndex];
    if (!column) {
      return;
    }
    header.tabIndex = 0;
    header.classList.add("inline-edit-target");
    header.title = `${tableState.manifest.id} ${column.name} column name`;
    bindInlineTableHeader(header, { table: tableState, placement, column });
  });
}

function bindInlineTableHeader(
  header: HTMLTableCellElement,
  binding: InlineTableHeaderBinding,
): void {
  inlineTableHeaderBindings.set(header, binding);
  header.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    header.blur();
  });
  header.addEventListener("input", () => {
    if (!previewEditMode) {
      return;
    }
    const next = editableText(header).replace(/\s+/g, " ").trim();
    if (!next || next === binding.column.label) {
      return;
    }
    recordHistoryCheckpoint({
      coalesceKey: `preview-table-header:${binding.table.manifest.id}:${binding.column.schema.name}`,
    });
    setTableColumnLabel(binding.table, binding.placement, binding.column.schema.name, next);
    binding.column.label = next;
    markDirty({ render: false });
  });
}

function setTableColumnLabel(
  table: EditableTable,
  placement: TablePlacement,
  columnName: string,
  label: string,
): void {
  const schemaColumn = table.schema.columns.find((column) => column.name === columnName);
  if (schemaColumn) {
    schemaColumn.label = label;
  }

  const view = placement.view ? table.views[placement.view] : undefined;
  if (view && placement.display === "table") {
    view.columns ??= table.schema.columns.map((column) => ({
      name: column.name,
      label: column.label ?? column.name,
    }));
    const viewColumn = view.columns.find((column) => column.name === columnName);
    if (viewColumn) {
      viewColumn.label = label;
    } else {
      view.columns.push({ name: columnName, label });
    }
    return;
  }
}

function setTableColumnLabelAcrossViews(
  table: EditableTable,
  columnName: string,
  label: string,
): void {
  const schemaColumn = table.schema.columns.find((column) => column.name === columnName);
  const previousLabel = schemaColumn?.label ?? columnName;
  if (schemaColumn) {
    schemaColumn.label = label;
  }

  for (const view of Object.values(table.views)) {
    const viewColumn = view.columns?.find((column) => column.name === columnName);
    if (viewColumn) {
      viewColumn.label = label;
    }
    for (const encoding of tableChartEncodings(view)) {
      if (encoding.column === columnName && (!encoding.label || encoding.label === previousLabel)) {
        encoding.label = label;
      }
    }
  }
}

function tableChartEncodings(view: TableView): TableChartEncoding[] {
  return [view.chart?.x, view.chart?.y, view.chart?.series, view.chart?.grouping].filter(
    (encoding): encoding is TableChartEncoding => Boolean(encoding),
  );
}

function bindInlineTableCell(
  cell: HTMLTableCellElement,
  binding: InlineTableBinding,
  rowIndex: number,
): void {
  inlineTableBindings.set(cell, binding);
  cell.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") {
      return;
    }
    event.stopPropagation();
  });
  cell.addEventListener("input", () => {
    if (!previewEditMode) {
      return;
    }
    const next = parseInlineTableValue(editableText(cell), binding.column);
    if ((binding.row[binding.column.name] ?? "") === next) {
      return;
    }
    recordHistoryCheckpoint({
      coalesceKey: `preview-table:${binding.column.name}:${rowIndex}`,
    });
    binding.row[binding.column.name] = next;
    markDirty({ render: false });
  });
}

function unbindInlineTableCell(cell: HTMLTableCellElement): void {
  inlineTableBindings.delete(cell);
  cell.classList.remove("inline-edit-target", "inline-editable");
  cell.contentEditable = "false";
  cell.removeAttribute("aria-label");
}

function unbindInlineTableHeader(header: HTMLTableCellElement): void {
  inlineTableHeaderBindings.delete(header);
  header.classList.remove("inline-edit-target", "inline-editable");
  header.contentEditable = "false";
  header.removeAttribute("aria-label");
  header.removeAttribute("tabindex");
  header.title = "";
}

function parseInlineTableValue(
  value: string,
  column: TableViewColumn & { schema: TableColumn },
): string {
  let next = value.replace(/\u00a0/g, " ").trim();
  const affix = column.currency ?? column.unit;
  if (affix) {
    next = next
      .replace(new RegExp(`^${escapeRegExp(affix)}\\s+`, "i"), "")
      .replace(new RegExp(`\\s+${escapeRegExp(affix)}$`, "i"), "");
  }
  if (column.percent || column.format === "percent") {
    next = next.replace(/%$/, "").trim();
  }
  if (
    ["integer", "decimal"].includes(column.schema.type) ||
    ["number", "currency", "percent", "integer", "decimal"].includes(column.format ?? "")
  ) {
    next = next.replace(/,/g, "");
  }
  return next;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function renderInsertionGuides(): void {
  for (const layer of Array.from(preview.querySelectorAll(".mcd-insert-lines"))) {
    layer.remove();
  }
  if (!state || !previewEditMode) {
    return;
  }

  for (const body of Array.from(preview.querySelectorAll<HTMLDivElement>(".preview-page-body"))) {
    const height = body.clientHeight;
    if (height <= 0) {
      continue;
    }
    const lineHeight = previewInsertionLineHeight(body);
    const lineCount = Math.max(1, Math.floor(height / lineHeight));
    const occupiedLines = previewOccupiedInsertionLines(body, lineHeight, lineCount);
    const layer = document.createElement("div");
    layer.className = "mcd-insert-lines";
    layer.setAttribute("aria-hidden", "false");

    for (let index = 0; index < lineCount; index += 1) {
      const line = document.createElement("div");
      line.className = "mcd-insert-line";
      line.style.top = `${index * lineHeight}px`;
      line.style.height = `${lineHeight}px`;
      line.style.pointerEvents = occupiedLines.has(index) ? "none" : "";
      const target: InsertLineTarget = {
        body,
        y: index * lineHeight + lineHeight / 2,
      };

      if (occupiedLines.has(index)) {
        layer.appendChild(line);
        continue;
      }

      const textTarget = document.createElement("button");
      textTarget.type = "button";
      textTarget.className = "mcd-insert-text-target";
      textTarget.setAttribute("aria-label", `Write text at line ${index + 1}`);
      textTarget.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        focusPlainTextAtLine(target);
      });

      const plus = document.createElement("button");
      plus.type = "button";
      plus.className = "mcd-insert-plus";
      plus.setAttribute("aria-label", `Insert table or image at line ${index + 1}`);
      plus.innerHTML = `<span aria-hidden="true">+</span>`;
      plus.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        showInsertTypePopup(target);
      });
      line.appendChild(textTarget);
      line.appendChild(plus);
      layer.appendChild(line);
    }

    body.appendChild(layer);
  }
}

function previewOccupiedInsertionLines(
  body: HTMLElement,
  lineHeight: number,
  lineCount: number,
): Set<number> {
  const occupied = new Set<number>();
  const bodyTop = body.getBoundingClientRect().top;

  for (const element of Array.from(body.children)) {
    if (!(element instanceof HTMLElement) || !previewElementHasInsertionContent(element)) {
      continue;
    }
    const rect = element.getBoundingClientRect();
    if (rect.height <= 0) {
      continue;
    }
    const top = Math.max(0, rect.top - bodyTop);
    const bottom = Math.max(top, rect.bottom - bodyTop);
    const firstLine = Math.max(0, Math.floor(top / lineHeight));
    const lastLine = Math.min(lineCount - 1, Math.floor(Math.max(top, bottom - 0.5) / lineHeight));
    for (let index = firstLine; index <= lastLine; index += 1) {
      occupied.add(index);
    }
  }

  return occupied;
}

function createAnnotationAtRenderedTarget(target: InsertLineTarget): void {
  if (!state) {
    return;
  }

  const location = renderedAnnotationLocationForTarget(target);
  const sourceLine =
    sourceLineForRenderedLogicalPageLine(location.page, location.line) ??
    markdownInsertionLine(target);
  createAnnotationAtSourceLine(sourceLine, location, { fromMargin: true });
}

function renderedAnnotationLocationForTarget(target: InsertLineTarget): AnnotationPageLocation {
  const pageNumber = Number(target.body.closest<HTMLElement>(".preview-page")?.dataset.pageNumber) || 1;
  const lineHeight = previewInsertionLineHeight(target.body);
  const gridLine = Math.max(1, Math.floor(target.y / lineHeight) + 1);
  const top = Math.max(0, target.y - lineHeight / 2);

  const matches = Array.from(renderedLogicalPageLines.entries())
    .flatMap(([page, lines]) =>
      lines.map((line, index) => ({
        page,
        line: index + 1,
        distance:
          line.body === target.body
            ? distanceFromRange(target.y, line.top, line.bottom)
            : Number.POSITIVE_INFINITY,
      })),
    )
    .filter((candidate) => Number.isFinite(candidate.distance))
    .sort((left, right) => left.distance - right.distance || left.line - right.line);

  const match = matches[0];
  return match && match.distance <= lineHeight
    ? { page: match.page, line: match.line, top, renderedPage: pageNumber }
    : { page: pageNumber, line: gridLine, top, renderedPage: pageNumber };
}

function distanceFromRange(value: number, start: number, end: number): number {
  if (value < start) {
    return start - value;
  }
  if (value > end) {
    return value - end;
  }
  return 0;
}

function createAnnotationAtSourceLine(
  sourceLine: number,
  location: AnnotationPageLocation,
  options: { fromMargin?: boolean } = {},
): void {
  if (!state) {
    return;
  }

  recordHistoryCheckpoint();
  if (options.fromMargin) {
    discardPendingMarginAnnotation();
    discardPendingWordAnnotation();
  }

  const id = nextAnnotationId(state);
  const line = Math.min(Math.max(1, sourceLine), markdownLineCount(state.markdown));
  const page = String(location.page || Number(inferPageForLine(state.markdown, line, state.pageMap)));
  state.annotations.push({
    id,
    metadata: `annotations/${id}.annotation.json`,
    targetText: JSON.stringify(sourceLineTarget(state.manifest.entrypoint, line), null, 2),
    page,
    line: String(line),
    kind: "comment",
    status: "open",
    body: "New annotation",
    author: "",
    labels: "",
    created: new Date().toISOString(),
  });
  expandedAnnotationIds.add(id);
  manualAnnotationLocations.set(id, {
    page: Number(page),
    line: Math.max(1, location.line),
    top: location.top,
    renderedPage: location.renderedPage,
  });
  if (options.fromMargin) {
    pendingMarginAnnotationId = id;
  }
  setActiveTab("annotations");
  setSidebarExpanded(true);
  renderAnnotationsEditor();
  markDirty();
}

function discardPendingMarginAnnotation(): void {
  if (!state || !pendingMarginAnnotationId) {
    return;
  }

  const id = pendingMarginAnnotationId;
  pendingMarginAnnotationId = undefined;
  if (locallySavedAnnotationIds.has(id)) {
    return;
  }

  const index = state.annotations.findIndex((annotation) => annotation.id === id);
  if (index < 0) {
    return;
  }

  const [annotation] = state.annotations.splice(index, 1);
  state.removedAnnotationPaths.add(annotation.metadata);
  if (annotation.originalMetadata) {
    state.removedAnnotationPaths.add(annotation.originalMetadata);
  }
  expandedAnnotationIds.delete(id);
  locallySavedAnnotationIds.delete(id);
  renderedAnnotationLocations.delete(id);
  manualAnnotationLocations.delete(id);
}

function discardPendingWordAnnotation(): void {
  if (!state || !pendingWordAnnotationId) {
    return;
  }

  const id = pendingWordAnnotationId;
  pendingWordAnnotationId = undefined;
  if (locallySavedAnnotationIds.has(id)) {
    return;
  }

  removeAnnotationMarkerFromMarkdown(id);
  const index = state.annotations.findIndex((annotation) => annotation.id === id);
  if (index < 0) {
    return;
  }

  const [annotation] = state.annotations.splice(index, 1);
  state.removedAnnotationPaths.add(annotation.metadata);
  if (annotation.originalMetadata) {
    state.removedAnnotationPaths.add(annotation.originalMetadata);
  }
  expandedAnnotationIds.delete(id);
  locallySavedAnnotationIds.delete(id);
  renderedAnnotationLocations.delete(id);
  manualAnnotationLocations.delete(id);
}

function removeAnnotationMarkerFromMarkdown(id: string): void {
  if (!state) {
    return;
  }
  const next = state.markdown.replaceAll(annotationMarkerToken(id), "");
  if (next === state.markdown) {
    return;
  }
  state.markdown = next;
  setMarkdownEditorValue(state.markdown);
}

function renameAnnotationMarkerInMarkdown(previousId: string, nextId: string): void {
  if (!state || previousId === nextId) {
    return;
  }
  const next = state.markdown.replaceAll(annotationMarkerToken(previousId), annotationMarkerToken(nextId));
  if (next === state.markdown) {
    return;
  }
  state.markdown = next;
  setMarkdownEditorValue(state.markdown);
}

function previewElementHasInsertionContent(element: HTMLElement): boolean {
  if (
    element.classList.contains("mcd-insert-lines") ||
    element.classList.contains("mcd-rendered-annotation-marker") ||
    element.classList.contains("empty-state")
  ) {
    return false;
  }
  if (element.classList.contains("mcd-transient-text-input")) {
    return Boolean(element.textContent?.trim());
  }
  if (element.matches("table, img, svg, canvas, video") || element.querySelector("table, img, svg, canvas, video")) {
    return true;
  }
  return Boolean(element.textContent?.trim());
}

function previewInsertionLineHeight(body: HTMLElement): number {
  const styles = window.getComputedStyle(body);
  const lineHeight = Number.parseFloat(styles.lineHeight);
  if (Number.isFinite(lineHeight) && lineHeight > 0) {
    return Math.max(20, lineHeight);
  }
  const fontSize = Number.parseFloat(styles.fontSize);
  return Math.max(20, (Number.isFinite(fontSize) ? fontSize : 16) * 1.45);
}

function showInsertTypePopup(target: InsertLineTarget): void {
  const line = markdownInsertionLine(target);
  showModal(`
    <div class="mcd-popup">
      <div class="mcd-popup-header">
        <div class="mcd-popup-title">Add content</div>
        <button class="mcd-popup-close" type="button" data-action="close" aria-label="Close">&times;</button>
      </div>
      <div class="mcd-popup-actions">
        <button class="primary" type="button" data-action="table">Table</button>
        <button type="button" data-action="image">Image</button>
      </div>
    </div>
  `);
  activeModal
    ?.querySelector<HTMLButtonElement>('[data-action="table"]')
    ?.addEventListener("click", () => showTableSizePopup(line, target));
  activeModal
    ?.querySelector<HTMLButtonElement>('[data-action="image"]')
    ?.addEventListener("click", () => showImagePopup(line, target));
}

function focusPlainTextAtLine(target: InsertLineTarget): void {
  if (!state) {
    return;
  }

  const insertLine = markdownInsertionLine(target);
  const editor = document.createElement("p");
  editor.className = "inline-edit-target inline-editable mcd-transient-text-input";
  editor.contentEditable = "true";
  editor.spellcheck = true;
  editor.tabIndex = 0;
  editor.setAttribute("aria-label", "Editing text");

  const anchor = previewElementForInsertionTarget(target);
  if (anchor.before) {
    target.body.insertBefore(editor, anchor.before);
  } else {
    target.body.insertBefore(editor, target.body.querySelector(".mcd-insert-lines"));
  }
  alignTransientTextInput(editor, target);

  let source: SourceSpan | undefined;
  let hasInsertedMarkdown = false;
  inlineTextBindings.set(editor, {});
  editor.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") {
      return;
    }
    event.stopPropagation();
  });
  editor.addEventListener("input", () => {
    if (!previewEditMode) {
      return;
    }
    const text = editableText(editor);
    if (!hasInsertedMarkdown) {
      if (!text.trim()) {
        return;
      }
      recordHistoryCheckpoint();
      source = insertMarkdownBlockAtLine(insertLine, text);
      hasInsertedMarkdown = true;
      markDirty({ render: false });
      renderInsertionGuides();
      return;
    }
    if (source) {
      source = replaceMarkdownSource(source, text);
      markDirty({ render: false });
      renderInsertionGuides();
    }
  });
  editor.addEventListener("blur", () => {
    if (hasInsertedMarkdown || editableText(editor).trim()) {
      return;
    }
    inlineTextBindings.delete(editor);
    editor.remove();
  });

  focusEditableBeginning(editor);
}

function alignTransientTextInput(editor: HTMLElement, target: InsertLineTarget): void {
  const lineHeight = previewInsertionLineHeight(target.body);
  const desiredTop = Math.max(0, target.y - lineHeight / 2);
  alignElementToPreviewTop(editor, target.body, desiredTop);
}

function alignElementToPreviewTop(element: HTMLElement, body: HTMLElement, desiredTop: number): void {
  element.style.marginTop = "";
  const bodyTop = body.getBoundingClientRect().top;
  const currentTop = element.getBoundingClientRect().top - bodyTop;
  const computedMarginTop = Number.parseFloat(window.getComputedStyle(element).marginTop);
  const baseMarginTop = Number.isFinite(computedMarginTop) ? computedMarginTop : 0;
  const offset = desiredTop - currentTop;
  if (Math.abs(offset) > 0.5) {
    element.style.marginTop = `${baseMarginTop + offset}px`;
    const adjustedTop = element.getBoundingClientRect().top - bodyTop;
    const correction = desiredTop - adjustedTop;
    if (Math.abs(correction) > 0.5) {
      element.style.marginTop = `${baseMarginTop + offset + correction}px`;
    }
  }
}

function queueInsertionAlignment(
  kind: PendingInsertionAlignment["kind"],
  id: string,
  target: InsertLineTarget,
): void {
  const lineHeight = previewInsertionLineHeight(target.body);
  const page = target.body.closest<HTMLElement>(".preview-page");
  const pageNumber = Number(page?.dataset.pageNumber) || 1;
  pendingInsertionAlignments = pendingInsertionAlignments.filter(
    (alignment) => alignment.kind !== kind || alignment.id !== id,
  );
  pendingInsertionAlignments.push({
    kind,
    id,
    pageNumber,
    desiredTop: Math.max(0, target.y - lineHeight / 2),
  });
}

function applyPendingInsertionAlignment(
  kind: PendingInsertionAlignment["kind"],
  id: string,
  element: HTMLElement,
): void {
  const body = element.closest<HTMLDivElement>(".preview-page-body");
  const page = element.closest<HTMLElement>(".preview-page");
  if (!body || !page) {
    return;
  }

  const pageNumber = Number(page.dataset.pageNumber) || 1;
  const alignmentIndex = pendingInsertionAlignments.findIndex(
    (alignment) =>
      alignment.kind === kind &&
      alignment.id === id &&
      alignment.pageNumber === pageNumber,
  );
  if (alignmentIndex < 0) {
    return;
  }

  const [alignment] = pendingInsertionAlignments.splice(alignmentIndex, 1);
  if (!alignment) {
    return;
  }
  alignElementToPreviewTop(element, body, alignment.desiredTop);
}

function previewElementForInsertionTarget(target: InsertLineTarget): { before?: HTMLElement } {
  const bodyTop = target.body.getBoundingClientRect().top;
  for (const element of Array.from(target.body.children)) {
    if (
      !(element instanceof HTMLElement) ||
      element.classList.contains("mcd-insert-lines") ||
      element.classList.contains("empty-state")
    ) {
      continue;
    }
    const rect = element.getBoundingClientRect();
    const midpoint = rect.top - bodyTop + rect.height / 2;
    if (target.y < midpoint) {
      return { before: element };
    }
  }
  return {};
}

function showTableSizePopup(insertLine: number, target: InsertLineTarget): void {
  showModal(`
    <form class="mcd-popup" id="tableCreateForm">
      <div class="mcd-popup-header">
        <div class="mcd-popup-title">Create table</div>
        <button class="mcd-popup-close" type="button" data-action="close" aria-label="Close">&times;</button>
      </div>
      <div class="mcd-popup-field-row">
        <div class="field">
          <label for="tableColumnCount">Columns</label>
          <input id="tableColumnCount" name="columns" type="number" min="1" max="24" step="1" value="3" required />
        </div>
        <label class="mcd-popup-check">
          <input name="columnHeaders" type="checkbox" checked />
          <span>with column headers</span>
        </label>
      </div>
      <div class="mcd-popup-field-row">
        <div class="field">
          <label for="tableRowCount">Rows</label>
          <input id="tableRowCount" name="rows" type="number" min="1" max="200" step="1" value="3" required />
        </div>
        <label class="mcd-popup-check">
          <input name="rowHeaders" type="checkbox" checked />
          <span>with row headers</span>
        </label>
      </div>
      <div class="mcd-popup-footer">
        <button class="primary" type="submit">Create</button>
      </div>
    </form>
  `);
  const form = activeModal?.querySelector<HTMLFormElement>("#tableCreateForm");
  form?.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const columns = quantityFromForm(data.get("columns"), 1, 24, 3);
    const rows = quantityFromForm(data.get("rows"), 1, 200, 3);
    createTableAtLine(
      insertLine,
      columns,
      rows,
      {
        showColumnHeaders: data.has("columnHeaders"),
        showRowHeaders: data.has("rowHeaders"),
      },
      target,
    );
    closeActiveModal();
  });
  activeModal?.querySelector<HTMLInputElement>("#tableColumnCount")?.focus();
}

function showImagePopup(insertLine: number, target: InsertLineTarget): void {
  showModal(`
    <form class="mcd-popup" id="imageCreateForm">
      <div class="mcd-popup-header">
        <div class="mcd-popup-title">Create image</div>
        <button class="mcd-popup-close" type="button" data-action="close" aria-label="Close">&times;</button>
      </div>
      <div class="field">
        <label for="imageFileInput">Image</label>
        <input id="imageFileInput" name="image" type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml" required />
      </div>
      <div class="field">
        <label for="imageAltInput">Alt text</label>
        <input id="imageAltInput" name="alt" type="text" required />
      </div>
      <div class="mcd-popup-footer">
        <button class="primary" type="submit">Create</button>
      </div>
    </form>
  `);
  const form = activeModal?.querySelector<HTMLFormElement>("#imageCreateForm");
  const fileInput = activeModal?.querySelector<HTMLInputElement>("#imageFileInput");
  const altInput = activeModal?.querySelector<HTMLInputElement>("#imageAltInput");
  fileInput?.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    if (file && altInput && !altInput.value.trim()) {
      altInput.value = file.name.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ");
    }
  });
  form?.addEventListener("submit", (event) => {
    event.preventDefault();
    const file = fileInput?.files?.[0];
    const alt = altInput?.value.trim() ?? "";
    if (!file || !alt) {
      return;
    }
    void createImageAtLine(insertLine, file, alt, target).then(() => closeActiveModal());
  });
  fileInput?.focus();
}

function showModal(html: string): void {
  closeActiveModal();
  const backdrop = document.createElement("div");
  backdrop.className = "mcd-popup-backdrop";
  backdrop.innerHTML = html;
  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) {
      closeActiveModal();
    }
  });
  backdrop.querySelector('[data-action="close"]')?.addEventListener("click", closeActiveModal);
  activeModal = backdrop;
  document.body.appendChild(backdrop);
}

function closeActiveModal(): void {
  activeModal?.remove();
  activeModal = undefined;
}

function quantityFromForm(value: FormDataEntryValue | null, min: number, max: number, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

function markdownInsertionLine(target: InsertLineTarget): number {
  if (!state) {
    return 1;
  }
  const elements = Array.from(target.body.children).filter(
    (child): child is HTMLElement =>
      child instanceof HTMLElement &&
      !child.classList.contains("mcd-insert-lines") &&
      !child.classList.contains("empty-state"),
  );
  if (elements.length === 0) {
    return 1;
  }

  const bodyTop = target.body.getBoundingClientRect().top;
  let previousSource: SourceSpan | undefined;
  let nextSource: SourceSpan | undefined;

  for (const element of elements) {
    const rect = element.getBoundingClientRect();
    const top = rect.top - bodyTop;
    const bottom = rect.bottom - bodyTop;
    const source = sourceForPreviewElement(element);
    if (target.y < top) {
      nextSource = source;
      break;
    }
    if (target.y <= bottom) {
      if (target.y < top + (bottom - top) / 2) {
        nextSource = source;
      } else {
        previousSource = source;
      }
      break;
    }
    previousSource = source ?? previousSource;
  }

  if (nextSource) {
    return Math.max(1, nextSource.startLine);
  }
  if (previousSource) {
    return previousSource.endLine + 1;
  }
  return markdownLineCount(state.markdown) + 1;
}

function sourceForPreviewElement(element: HTMLElement): SourceSpan | undefined {
  const direct =
    previewBlockSources.get(element) ??
    inlineTextBindings.get(element)?.source;
  if (direct) {
    return direct;
  }

  const nested = element.querySelector<HTMLElement>(".inline-edit-target, table, img");
  if (!nested) {
    return undefined;
  }
  return previewBlockSources.get(nested) ?? inlineTextBindings.get(nested)?.source;
}

function createTableAtLine(
  insertLine: number,
  columnCount: number,
  rowCount: number,
  preferences: { showColumnHeaders: boolean; showRowHeaders: boolean },
  target?: InsertLineTarget,
): void {
  if (!state) {
    return;
  }
  recordHistoryCheckpoint();
  const id = nextTableId(state);
  const viewPath = `tables/${id}.view.json`;
  const entry: TableManifestEntry = {
    id,
    data: `tables/${id}.csv`,
    schema: `tables/${id}.schema.json`,
    views: {
      default: viewPath,
    },
  };
  const schema: TableSchema = {
    id,
    columns: [
      {
        name: RESERVED_ROW_HEADER_COLUMN,
        type: "string",
        nullable: false,
      },
      ...Array.from({ length: columnCount }, (_, index) => ({
        name: `column_${index + 1}`,
        type: "string",
        label: `Column ${index + 1}`,
        nullable: true,
      })),
    ],
  };
  const view: TableView = {
    id: "default",
    table: id,
    display: "table",
    columns: schema.columns.map((column) => ({
      name: column.name,
      label: column.label,
    })),
    style: {
      showColumnHeaders: preferences.showColumnHeaders,
      showRowHeaders: preferences.showRowHeaders,
    },
  };
  const rows = Array.from({ length: rowCount }, (_unused, rowIndex) =>
    Object.fromEntries(
      schema.columns.map((column) => [
        column.name,
        column.name === RESERVED_ROW_HEADER_COLUMN ? String(rowIndex + 1) : "",
      ]),
    ),
  );
  const table: EditableTable = {
    manifest: entry,
    schema,
    views: {
      default: view,
    },
    rows,
  };

  state.manifest.tables ??= [];
  state.manifest.tables.push(entry);
  state.tables.push(table);
  state.zip.file(entry.schema, `${JSON.stringify(schema, null, 2)}\n`);
  state.zip.file(viewPath, `${JSON.stringify(view, null, 2)}\n`);
  state.zip.file(entry.data, tableToCsv(table));
  insertMarkdownBlockAtLine(insertLine, `:::table\ntable: ${id}\nview: default\n:::`);
  if (target) {
    queueInsertionAlignment("table", id, target);
  }
  renderTablesEditor();
  markDirty();
  setStatus(`Created table '${id}'.`);
}

async function createImageAtLine(
  insertLine: number,
  file: File,
  alt: string,
  target?: InsertLineTarget,
): Promise<void> {
  if (!state) {
    return;
  }
  const mediaType = imageMediaType(file);
  if (!mediaType) {
    setStatus("Unsupported image type.");
    return;
  }

  recordHistoryCheckpoint();
  const id = nextImageId(state, file.name);
  const extension = imageExtension(file, mediaType);
  const assetPath = `assets/${id}.${extension}`;
  const metadataPath = `images/${id}.image.json`;
  const metadata = {
    id,
    asset: assetPath,
    mediaType,
    role: "photo",
    alt,
  };

  state.manifest.images ??= [];
  state.manifest.images.push({ id, metadata: metadataPath });
  state.manifest.assets ??= [];
  state.manifest.assets.push({ id, path: assetPath });
  state.zip.file(assetPath, new Uint8Array(await file.arrayBuffer()));
  state.zip.file(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
  insertMarkdownBlockAtLine(insertLine, `:::image\nimage: ${id}\nalt: ${alt}\n:::`);
  if (target) {
    queueInsertionAlignment("image", id, target);
  }
  markDirty();
  setStatus(`Created image '${id}'.`);
}

function insertMarkdownBlockAtLine(insertLine: number, block: string): SourceSpan {
  if (!state) {
    return {
      startLine: 1,
      startColumn: 1,
      endLine: 1,
      endColumn: block.length,
    };
  }
  const lines = state.markdown.split(/\r\n|\r|\n/);
  const hasContent = state.markdown.trim().length > 0;
  if (!hasContent) {
    state.markdown = block;
    setMarkdownEditorValue(state.markdown);
    const blockLines = block.split("\n");
    return {
      startLine: 1,
      startColumn: 1,
      endLine: blockLines.length,
      endColumn: blockLines.at(-1)?.length ?? 1,
    };
  }

  const index = Math.min(Math.max(0, insertLine - 1), lines.length);
  const before = lines.slice(0, index).join("\n").trimEnd();
  const after = lines.slice(index).join("\n").trimStart();
  const startLine = before ? markdownLineCount(before) + 2 : 1;
  state.markdown = [before, block, after].filter(Boolean).join("\n\n");
  setMarkdownEditorValue(state.markdown);
  const blockLines = block.split("\n");
  return {
    startLine,
    startColumn: 1,
    endLine: startLine + blockLines.length - 1,
    endColumn: blockLines.at(-1)?.length ?? 1,
  };
}

function nextTableId(packageState: PackageState): string {
  const existing = new Set((packageState.manifest.tables ?? []).map((table) => table.id));
  for (let index = 1; ; index += 1) {
    const id = `table-${String(index).padStart(4, "0")}`;
    if (!existing.has(id)) {
      return id;
    }
  }
}

function nextImageId(packageState: PackageState, fileName: string): string {
  const existing = new Set((packageState.manifest.images ?? []).map((image) => image.id));
  const base = sanitizeId(fileName.replace(/\.[^.]+$/, "") || "image");
  for (let index = 1; ; index += 1) {
    const id = index === 1 ? base : `${base}-${index}`;
    if (!existing.has(id)) {
      return id;
    }
  }
}

function imageMediaType(file: File): string | undefined {
  const allowed = new Set(["image/svg+xml", "image/png", "image/jpeg", "image/webp", "image/gif"]);
  if (allowed.has(file.type)) {
    return file.type;
  }
  const extension = file.name.toLowerCase().split(".").at(-1);
  if (extension === "svg") return "image/svg+xml";
  if (extension === "png") return "image/png";
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "webp") return "image/webp";
  if (extension === "gif") return "image/gif";
  return undefined;
}

function imageExtension(file: File, mediaType: string): string {
  const extension = file.name.toLowerCase().split(".").at(-1);
  if (extension && ["svg", "png", "jpg", "jpeg", "webp", "gif"].includes(extension)) {
    return extension === "jpg" ? "jpeg" : extension;
  }
  if (mediaType === "image/svg+xml") return "svg";
  return mediaType.replace("image/", "").replace("jpeg", "jpeg");
}

function renderPagedPreview(html: string, annotationItems: AnnotationPreviewItem[] = []): void {
  const template = document.createElement("template");
  template.innerHTML = html;
  prepareLazyTablePlaceholders(template.content);
  const nodes = Array.from(template.content.childNodes).filter((node) => {
    return node.nodeType !== Node.TEXT_NODE || Boolean(node.textContent?.trim());
  });
  const annotationsNode = annotationEndnotesNode(annotationItems);
  if (annotationsNode) {
    nodes.push(annotationsNode);
  }

  preview.innerHTML = "";
  preview.classList.add("is-paged");

  const pageNumber = paginateNodes(nodes);
  if (nodes.length === 0) {
    const pageBody = preview.querySelector<HTMLDivElement>(".preview-page-body");
    if (pageBody) {
      pageBody.innerHTML = `<div class="empty-state">Document has no previewable content.</div>`;
    }
  }

  updatePageMapMetadata(pageNumber, annotationPreviewPageNumber());
}

function prepareLazyTablePlaceholders(root: DocumentFragment): void {
  for (const figure of Array.from(
    root.querySelectorAll<HTMLElement>(".mcd-lazy-table[data-mcd-lazy-table-index]"),
  )) {
    const entry = lazyPreviewTableEntry(figure);
    const placeholder = figure.querySelector<HTMLElement>(".mcd-lazy-table-placeholder");
    if (!entry || !placeholder) {
      continue;
    }
    const table = state?.tables.find((candidate) => candidate.manifest.id === entry.placement.table);
    const rowCount = table?.rows.length ?? 0;
    const reservedRows = Math.min(rowCount, 12);
    const estimatedHeight = Math.min(
      560,
      Math.max(MIN_PREVIEW_TABLE_SCROLL_HEIGHT, 54 + reservedRows * 34 + (rowCount > reservedRows ? 34 : 0)),
    );
    placeholder.style.minHeight = `${estimatedHeight}px`;
  }
}

function setupLazyPreviewTables(): void {
  const figures = Array.from(
    preview.querySelectorAll<HTMLElement>(".mcd-lazy-table[data-mcd-lazy-table-index]"),
  );
  if (figures.length === 0) {
    return;
  }

  if (!("IntersectionObserver" in window)) {
    for (const figure of figures) {
      renderLazyPreviewTable(figure);
    }
    return;
  }

  previewLazyTableObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) {
          continue;
        }
        const figure = entry.target as HTMLElement;
        previewLazyTableObserver?.unobserve(figure);
        renderLazyPreviewTable(figure);
      }
    },
    {
      root: previewLazyScrollRoot(),
      rootMargin: `${LAZY_PREVIEW_TABLE_ROOT_MARGIN}px 0px`,
    },
  );

  for (const figure of figures) {
    previewLazyTableObserver.observe(figure);
  }

  window.requestAnimationFrame(() => {
    for (const figure of figures) {
      if (isElementNearScrollRoot(figure, previewLazyScrollRoot(), LAZY_PREVIEW_TABLE_ROOT_MARGIN)) {
        previewLazyTableObserver?.unobserve(figure);
        renderLazyPreviewTable(figure);
      }
    }
  });
}

function previewLazyScrollRoot(): HTMLElement | null {
  return previewPane.scrollHeight > previewPane.clientHeight + 1 ? previewPane : null;
}

function lazyPreviewTableEntry(figure: HTMLElement): PreviewLazyTable | undefined {
  const index = Number(figure.dataset.mcdLazyTableIndex);
  if (!Number.isInteger(index) || index < 0) {
    return undefined;
  }
  return previewLazyTables[index];
}

function isElementNearScrollRoot(element: Element, root: Element | null, margin: number): boolean {
  const elementRect = element.getBoundingClientRect();
  const rootRect = root?.getBoundingClientRect() ?? {
    top: 0,
    bottom: window.innerHeight,
  };
  return elementRect.bottom >= rootRect.top - margin && elementRect.top <= rootRect.bottom + margin;
}

function renderLazyPreviewTable(figure: HTMLElement): void {
  if (figure.dataset.mcdLazyLoaded === "true") {
    return;
  }
  const entry = lazyPreviewTableEntry(figure);
  if (!entry || !state) {
    return;
  }
  const table = state.tables.find((candidate) => candidate.manifest.id === entry.placement.table);
  if (!table) {
    return;
  }
  const columns = renderedColumnsForPlacement(table, entry.placement);
  if (columns.length === 0) {
    return;
  }

  figure.dataset.mcdLazyLoaded = "true";
  const caption = entry.placement.caption ? figure.querySelector("figcaption")?.cloneNode(true) : undefined;
  const source = entry.placement.source;
  figure.replaceChildren();
  if (caption) {
    figure.appendChild(caption);
  }
  if (entry.placement.display === "chart") {
    figure.appendChild(chartMetadataNode(table, entry.placement));
  }

  const wrapper = document.createElement("div");
  wrapper.className = "preview-table-wrap";
  wrapper.setAttribute("role", "region");
  wrapper.setAttribute("tabindex", "0");
  wrapper.setAttribute("aria-label", `${table.manifest.id} table`);

  const tableElement = document.createElement("table");
  tableElement.className = "inline-editable-table";
  tableElement.appendChild(renderPreviewTableHead(table, entry.placement, columns));
  const tbody = document.createElement("tbody");
  tableElement.appendChild(tbody);
  wrapper.appendChild(tableElement);
  figure.appendChild(wrapper);

  if (source) {
    previewBlockSources.set(figure, source);
    previewBlockSources.set(wrapper, source);
    previewBlockSources.set(tableElement, source);
  }
  applyPendingInsertionAlignment("table", table.manifest.id, wrapper);
  setupPreviewTableScroller(wrapper);

  const virtualTable: PreviewVirtualTable = {
    table,
    placement: entry.placement,
    columns,
    tbody,
    wrapper,
    rowHeight: VIRTUAL_TABLE_ROW_HEIGHT,
    visibleStart: -1,
    visibleEnd: -1,
  };
  previewVirtualTables.set(wrapper, virtualTable);
  wrapper.addEventListener(
    "scroll",
    () => {
      if (wrapper.contains(document.activeElement)) {
        return;
      }
      renderVirtualPreviewTableRows(virtualTable);
    },
    { passive: true },
  );

  syncPreviewTableScrollState(wrapper);
  renderVirtualPreviewTableRows(virtualTable);
  applyPreviewEditMode();
  window.requestAnimationFrame(() => {
    syncPreviewTableScrollState(wrapper);
    renderVirtualPreviewTableRows(virtualTable);
    schedulePreviewTableRepagination();
  });
}

function renderedColumnsForPlacement(
  table: EditableTable,
  placement: TablePlacement,
): Array<TableViewColumn & { label: string; schema: TableColumn }> {
  const preferences = tableHeaderPreferences(table, placement);
  const columns = columnsForPlacement(table, placement);
  return preferences.showRowHeaders
    ? columns
    : columns.filter((column) => column.name !== RESERVED_ROW_HEADER_COLUMN);
}

function renderPreviewTableHead(
  table: EditableTable,
  placement: TablePlacement,
  columns: Array<TableViewColumn & { label: string; schema: TableColumn }>,
): HTMLTableSectionElement {
  const thead = document.createElement("thead");
  if (!tableHeaderPreferences(table, placement).showColumnHeaders) {
    return thead;
  }

  const row = document.createElement("tr");
  for (const column of columns) {
    const th = document.createElement("th");
    th.scope = "col";
    th.dataset.mcdColumn = column.name;
    setPreviewTableCellAlignment(th, column.schema);
    if (column.name === RESERVED_ROW_HEADER_COLUMN && tableHeaderPreferences(table, placement).showRowHeaders) {
      th.setAttribute("aria-label", "Row headers");
    } else {
      th.textContent = column.label;
      th.tabIndex = 0;
      th.classList.add("inline-edit-target");
      th.title = `${table.manifest.id} ${column.name} column name`;
      bindInlineTableHeader(th, { table, placement, column });
    }
    row.appendChild(th);
  }
  thead.appendChild(row);
  return thead;
}

function chartMetadataNode(table: EditableTable, placement: TablePlacement): HTMLDivElement {
  const node = document.createElement("div");
  node.className = "mcd-chart-metadata";
  const viewId = placement.view ?? "default";
  node.textContent = `Chart metadata: table ${table.manifest.id}, view ${viewId}.`;
  return node;
}

function renderVirtualPreviewTableRows(virtualTable: PreviewVirtualTable): void {
  const rowCount = virtualTable.table.rows.length;
  const viewportHeight = Math.max(virtualTable.wrapper.clientHeight, MIN_PREVIEW_TABLE_SCROLL_HEIGHT);
  const visibleRows = Math.ceil(viewportHeight / virtualTable.rowHeight) + VIRTUAL_TABLE_OVERSCAN_ROWS * 2;
  const start = Math.max(
    0,
    Math.floor(virtualTable.wrapper.scrollTop / virtualTable.rowHeight) - VIRTUAL_TABLE_OVERSCAN_ROWS,
  );
  const end = Math.min(rowCount, start + visibleRows);
  if (start === virtualTable.visibleStart && end === virtualTable.visibleEnd) {
    return;
  }

  virtualTable.visibleStart = start;
  virtualTable.visibleEnd = end;
  virtualTable.tbody.replaceChildren();
  virtualTable.tbody.appendChild(spacerTableRow(virtualTable.columns.length, start * virtualTable.rowHeight));
  for (let rowIndex = start; rowIndex < end; rowIndex += 1) {
    virtualTable.tbody.appendChild(renderPreviewTableRow(virtualTable, rowIndex));
  }
  virtualTable.tbody.appendChild(
    spacerTableRow(virtualTable.columns.length, Math.max(0, rowCount - end) * virtualTable.rowHeight),
  );
}

function spacerTableRow(columnCount: number, height: number): HTMLTableRowElement {
  const row = document.createElement("tr");
  row.className = "mcd-virtual-table-spacer";
  row.setAttribute("aria-hidden", "true");
  const cell = document.createElement("td");
  cell.colSpan = Math.max(1, columnCount);
  cell.style.height = `${height}px`;
  cell.style.padding = "0";
  cell.style.border = "0";
  row.appendChild(cell);
  return row;
}

function renderPreviewTableRow(
  virtualTable: PreviewVirtualTable,
  rowIndex: number,
): HTMLTableRowElement {
  const tr = document.createElement("tr");
  tr.dataset.rowIndex = String(rowIndex);
  const row = virtualTable.table.rows[rowIndex];
  const showRowHeaders = tableHeaderPreferences(virtualTable.table, virtualTable.placement).showRowHeaders;
  for (const column of virtualTable.columns) {
    const isRowHeader = showRowHeaders && column.name === RESERVED_ROW_HEADER_COLUMN;
    const cell = document.createElement(isRowHeader ? "th" : "td") as HTMLTableCellElement;
    if (isRowHeader) {
      cell.scope = "row";
    }
    cell.textContent = formatPreviewTableValue(row?.[column.name] ?? "", column);
    setPreviewTableCellAlignment(cell, column.schema);
    cell.tabIndex = 0;
    cell.classList.add("inline-edit-target");
    cell.title = `${virtualTable.table.manifest.id} ${column.name} row ${rowIndex + 1}`;
    if (row) {
      bindInlineTableCell(cell, { row, column }, rowIndex);
    }
    tr.appendChild(cell);
  }
  return tr;
}

function setPreviewTableCellAlignment(cell: HTMLTableCellElement, column: TableColumn): void {
  if (["integer", "decimal"].includes(column.type)) {
    cell.dataset.align = "right";
  } else if (column.type === "boolean") {
    cell.dataset.align = "center";
  }
}

function formatPreviewTableValue(
  value: string,
  column: TableViewColumn & { schema: TableColumn },
): string {
  if (!value) {
    return "";
  }
  if (column.format === "currency") {
    return column.currency ? `${column.currency} ${value}` : value;
  }
  if (column.format === "percent" || column.percent) {
    return `${value}%`;
  }
  const unit = column.unit ?? (column.format !== "currency" ? column.currency : undefined);
  return unit ? `${value} ${unit}` : value;
}

function appendPreviewPage(pageNumber: number): { page: HTMLElement; body: HTMLDivElement } {
  const page = document.createElement("section");
  page.className = "preview-page";
  page.setAttribute("aria-label", `Page ${pageNumber}`);
  page.dataset.pageNumber = String(pageNumber);

  const body = document.createElement("div");
  body.className = "preview-page-body";

  const footer = document.createElement("footer");
  footer.className = "preview-page-number";
  footer.textContent = `Page ${pageNumber}`;

  page.append(body, footer);
  preview.appendChild(page);
  return { page, body };
}

function repaginatePreview(): void {
  const pages = Array.from(preview.querySelectorAll<HTMLElement>(".preview-page"));
  if (pages.length === 0) {
    return;
  }

  const nodes = pages.flatMap((page) =>
    Array.from(page.querySelector<HTMLDivElement>(".preview-page-body")?.childNodes ?? []),
  );
  preview.innerHTML = "";

  const pageNumber = paginateNodes(nodes);
  updatePageMapMetadata(pageNumber, annotationPreviewPageNumber());
}

function repaginatePreviewWithScrollableTables(): void {
  syncPreviewTableScrollers();
  repaginatePreview();
  syncPreviewTableScrollers();
  repaginatePreview();
  syncPreviewTableScrollers();
}

function schedulePreviewTableRepagination(): void {
  if (previewTableRepaginateFrame !== undefined) {
    return;
  }
  previewTableRepaginateFrame = window.requestAnimationFrame(() => {
    previewTableRepaginateFrame = undefined;
    repaginatePreviewWithScrollableTables();
    syncRenderedLogicalPageLines();
    if (state) {
      renderManualAnnotationMarkers(annotationPreviewItems(state.markdown));
    }
    syncRenderedAnnotationLocations();
    if (activeTab === "annotations" && !annotationsEditor.contains(document.activeElement)) {
      renderAnnotationsEditor();
    }
  });
}

function paginateNodes(nodes: Node[]): number {
  let cursor: PreviewPageCursor = {
    pageNumber: 1,
    page: appendPreviewPage(1),
  };

  for (const node of nodes) {
    cursor = appendNodeToPreviewPage(node, cursor);
  }

  return cursor.pageNumber;
}

interface PreviewPageCursor {
  pageNumber: number;
  page: { page: HTMLElement; body: HTMLDivElement };
}

function appendNodeToPreviewPage(node: Node, cursor: PreviewPageCursor): PreviewPageCursor {
  if (isForcedPreviewPageBreak(node) && cursor.page.body.childNodes.length > 0) {
    cursor = nextPreviewPage(cursor);
  }

  cursor.page.body.appendChild(node);
  if (!isPreviewPageOverflowing(cursor.page.body)) {
    return cursor;
  }

  const heading = previousHeadingForOverflowingNode(cursor.page.body, node);
  if (heading) {
    cursor.page.body.removeChild(node);
    cursor.page.body.removeChild(heading);
    cursor = appendNodeToPreviewPage(heading, nextPreviewPage(cursor));
    return appendNodeToPreviewPage(node, cursor);
  }

  if (cursor.page.body.childNodes.length > 1) {
    cursor.page.body.removeChild(node);
    return appendNodeToPreviewPage(node, nextPreviewPage(cursor));
  }

  cursor.page.page.classList.add("is-oversized");
  return cursor;
}

function nextPreviewPage(cursor: PreviewPageCursor): PreviewPageCursor {
  const pageNumber = cursor.pageNumber + 1;
  return {
    pageNumber,
    page: appendPreviewPage(pageNumber),
  };
}

function isForcedPreviewPageBreak(node: Node): boolean {
  return node instanceof HTMLElement && node.classList.contains("mcd-annotations");
}

function isPreviewPageOverflowing(body: HTMLDivElement): boolean {
  return body.scrollHeight > body.clientHeight + 1;
}

function splitParagraphElementToFit(
  body: HTMLDivElement,
  element: HTMLElement,
): HTMLElement | undefined {
  if (element.tagName !== "P") {
    return undefined;
  }

  const original = element.cloneNode(true) as HTMLElement;
  const breakpoints = textBreakOffsets(original.textContent ?? "");
  if (breakpoints.length === 0) {
    return undefined;
  }

  let low = 1;
  let high = breakpoints.length;
  let best = 0;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const prefix = cloneElementTextRange(original, 0, breakpoints[mid - 1]);
    replaceElementChildren(element, prefix);
    if (isPreviewPageOverflowing(body)) {
      high = mid - 1;
    } else {
      best = mid;
      low = mid + 1;
    }
  }

  if (best === 0) {
    replaceElementChildren(element, original);
    return undefined;
  }

  const splitOffset = breakpoints[best - 1];
  const prefix = cloneElementTextRange(original, 0, splitOffset);
  const remainder = cloneElementTextRange(original, splitOffset, textLength(original));
  trimEdgeText(prefix, "end");
  trimEdgeText(remainder, "start");

  if (!remainder.textContent?.trim()) {
    replaceElementChildren(element, original);
    return undefined;
  }

  replaceElementChildren(element, prefix);
  return remainder;
}

function textBreakOffsets(text: string): number[] {
  const offsets: number[] = [];
  let cursor = 0;
  for (const segment of text.match(/\S+\s*/g) ?? []) {
    cursor += segment.length;
    if (cursor < text.length) {
      offsets.push(cursor);
    }
  }
  return offsets;
}

function cloneElementTextRange(source: HTMLElement, start: number, end: number): HTMLElement {
  const clone = source.cloneNode(false) as HTMLElement;
  const position = { value: 0 };
  for (const child of Array.from(source.childNodes)) {
    const clonedChild = cloneTextRange(child, start, end, position);
    if (clonedChild) {
      clone.appendChild(clonedChild);
    }
  }
  return clone;
}

function cloneTextRange(
  node: Node,
  start: number,
  end: number,
  position: { value: number },
): Node | undefined {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.textContent ?? "";
    const nodeStart = position.value;
    const nodeEnd = nodeStart + text.length;
    position.value = nodeEnd;
    const sliceStart = Math.max(start, nodeStart);
    const sliceEnd = Math.min(end, nodeEnd);
    if (sliceStart >= sliceEnd) {
      return undefined;
    }
    return document.createTextNode(text.slice(sliceStart - nodeStart, sliceEnd - nodeStart));
  }

  if (!(node instanceof HTMLElement)) {
    return undefined;
  }

  const clone = node.cloneNode(false) as HTMLElement;
  for (const child of Array.from(node.childNodes)) {
    const clonedChild = cloneTextRange(child, start, end, position);
    if (clonedChild) {
      clone.appendChild(clonedChild);
    }
  }
  return clone.childNodes.length > 0 ? clone : undefined;
}

function textLength(root: Node): number {
  let length = 0;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    length += walker.currentNode.textContent?.length ?? 0;
  }
  return length;
}

function replaceElementChildren(target: HTMLElement, source: HTMLElement): void {
  target.replaceChildren(...Array.from(source.childNodes).map((node) => node.cloneNode(true)));
}

function trimEdgeText(root: HTMLElement, edge: "start" | "end"): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  while (walker.nextNode()) {
    textNodes.push(walker.currentNode as Text);
  }
  const node = edge === "start" ? textNodes[0] : textNodes.at(-1);
  if (!node) {
    return;
  }
  node.textContent = edge === "start" ? node.data.trimStart() : node.data.trimEnd();
}

function previousHeadingForOverflowingNode(
  body: HTMLDivElement,
  node: Node,
): HTMLElement | undefined {
  if (!(node instanceof HTMLElement) || body.childNodes.length <= 2) {
    return undefined;
  }

  const previous = node.previousElementSibling;
  if (!previous || !/^H[1-6]$/.test(previous.tagName)) {
    return undefined;
  }

  return previous as HTMLElement;
}

function enhancePreviewDom(): void {
  for (const link of Array.from(preview.querySelectorAll<HTMLAnchorElement>("a[href]"))) {
    const href = link.getAttribute("href") ?? "";
    if (/^https?:\/\//i.test(href)) {
      link.target = "_blank";
      link.rel = "noopener noreferrer";
    }
  }
  enhanceCitationLinks();

  for (const table of Array.from(preview.querySelectorAll<HTMLTableElement>("table"))) {
    if (table.parentElement?.classList.contains("preview-table-wrap")) {
      continue;
    }
    const wrapper = document.createElement("div");
    wrapper.className = "preview-table-wrap";
    wrapper.setAttribute("role", "region");
    wrapper.setAttribute("tabindex", "0");
    wrapper.setAttribute("aria-label", "Scrollable table");
    table.replaceWith(wrapper);
    wrapper.appendChild(table);
    setupPreviewTableScroller(wrapper);
  }
  syncPreviewTableScrollers();

  for (const math of Array.from(preview.querySelectorAll<HTMLElement>(".mcd-math"))) {
    math.setAttribute("tabindex", "0");
  }
}

function setupPreviewTableScroller(wrapper: HTMLDivElement): void {
  if (wrapper.dataset.mcdTableScroller === "true") {
    return;
  }
  wrapper.dataset.mcdTableScroller = "true";
  wrapper.addEventListener("scroll", () => syncPreviewTableScrollState(wrapper), {
    passive: true,
  });
}

function syncPreviewTableScrollers(): void {
  const wrappers = Array.from(
    preview.querySelectorAll<HTMLDivElement>(".preview-table-wrap"),
  );
  for (const wrapper of wrappers) {
    setupPreviewTableScroller(wrapper);
    syncPreviewTableScrollState(wrapper);
  }
}

function syncPreviewTableScrollState(wrapper: HTMLDivElement): void {
  syncPreviewTableMaxHeight(wrapper);

  const isScrollable = wrapper.scrollWidth > wrapper.clientWidth + 1;
  const isYScrollable = wrapper.scrollHeight > wrapper.clientHeight + 1;
  const atStart = wrapper.scrollLeft <= 1;
  const atEnd = wrapper.scrollLeft + wrapper.offsetWidth >= wrapper.scrollWidth - 1;
  wrapper.classList.toggle("is-scrollable", isScrollable);
  wrapper.classList.toggle("is-y-scrollable", isYScrollable);
  wrapper.classList.toggle("at-start", !isScrollable || atStart);
  wrapper.classList.toggle("at-end", !isScrollable || atEnd);
}

function syncPreviewTableMaxHeight(wrapper: HTMLDivElement): void {
  const body = wrapper.closest<HTMLDivElement>(".preview-page-body");
  if (!body) {
    wrapper.style.maxHeight = "";
    return;
  }

  const wrapperStyle = window.getComputedStyle(wrapper);
  const marginBottom = Number.parseFloat(wrapperStyle.marginBottom) || 0;
  const availableHeight = Math.floor(
    previewPageBodyClientHeight(body) - wrapper.offsetTop - marginBottom,
  );

  if (availableHeight < MIN_PREVIEW_TABLE_SCROLL_HEIGHT) {
    wrapper.style.maxHeight = "";
    return;
  }

  wrapper.style.maxHeight = `${availableHeight}px`;
}

function previewPageBodyClientHeight(body: HTMLDivElement): number {
  const page = body.closest<HTMLElement>(".preview-page");
  if (!page?.classList.contains("is-oversized")) {
    return body.clientHeight;
  }

  page.classList.remove("is-oversized");
  const height = body.clientHeight;
  page.classList.add("is-oversized");
  return height;
}

function enhanceCitationLinks(): void {
  for (const link of Array.from(preview.querySelectorAll<HTMLAnchorElement>("a[href]"))) {
    if (link.closest("sup, pre, code, .mcd-annotation-marker, .mcd-citation-ref")) {
      continue;
    }
    const citation = numericCitationLabel(link);
    if (!citation) {
      continue;
    }

    link.textContent = `[${citation}]`;
    link.setAttribute("aria-label", `Reference ${citation}`);
    const marker = document.createElement("sup");
    marker.className = "mcd-citation-ref";
    link.replaceWith(marker);
    marker.appendChild(link);
  }
}

function numericCitationLabel(link: HTMLAnchorElement): string | undefined {
  const text = (link.textContent ?? "").trim();
  const bracketed = /^\[(\d+)\]$/.exec(text);
  if (bracketed?.[1]) {
    return bracketed[1];
  }

  const href = link.getAttribute("href") ?? "";
  const bare = /^(\d+)$/.exec(text);
  if (bare?.[1] && /(?:^|[#/?=&-])cite(?:_|-)?note(?:$|[#/?=&-])/i.test(href)) {
    return bare[1];
  }

  return undefined;
}

async function waitForPreviewImages(): Promise<void> {
  const images = Array.from(preview.querySelectorAll<HTMLImageElement>("img"));
  await Promise.all(
    images.map((image) => {
      if (image.complete) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        image.addEventListener("load", () => resolve(), { once: true });
        image.addEventListener("error", () => resolve(), { once: true });
      });
    }),
  );
}

function annotationPreviewPageNumber(): number | undefined {
  const annotationPage = preview.querySelector<HTMLElement>(".mcd-annotations")?.closest<HTMLElement>(
    ".preview-page",
  );
  if (!annotationPage) {
    return undefined;
  }
  const pageNumber = Number(annotationPage.dataset.pageNumber);
  if (!Number.isInteger(pageNumber) || pageNumber < 1) {
    return undefined;
  }
  annotationPage.setAttribute("aria-label", "Annotations");
  annotationPage.querySelector(".preview-page-number")?.replaceChildren("Annotations");
  return pageNumber;
}

function updatePageMapMetadata(pageCount: number, annotationPageNumber?: number): void {
  if (!state) {
    return;
  }

  const previousPages = state.pageMap?.pages ?? [];
  const pageMapPath = state.pageMapPath ?? state.manifest.layout?.pageMap ?? "layout/page-map.json";
  state.pageMapPath = pageMapPath;
  state.manifest.layout = {
    ...(state.manifest.layout ?? {}),
    pageMap: pageMapPath,
  };
  state.pageMap = {
    pages: Array.from({ length: pageCount }, (_, index) => {
      const number = index + 1;
      const previous = previousPages[index];
      return {
        number,
        label: number === annotationPageNumber ? "Annotations" : (previous?.label ?? `Page ${number}`),
        ...(previous?.sourceRefs ? { sourceRefs: previous.sourceRefs } : {}),
        ...(previous?.assets ? { assets: previous.assets } : {}),
        ...(previous?.rendered ? { rendered: previous.rendered } : {}),
      };
    }),
  };
}

async function rewritePackageImageSources(): Promise<void> {
  if (!state) {
    return;
  }
  const images = Array.from(preview.querySelectorAll<HTMLImageElement>("img"));
  for (const image of images) {
    const source = image.getAttribute("src");
    if (!source || source.includes(":") || source.startsWith("/")) {
      continue;
    }
    const file = state.zip.file(source);
    if (!file) {
      continue;
    }
    const blob = await file.async("blob");
    const objectUrl = URL.createObjectURL(blob);
    assetUrls.push(objectUrl);
    image.src = objectUrl;
  }
}

function renderDiagnostics(validation: ValidationResult): void {
  clearDiagnostics();
  for (const diagnostic of validation.diagnostics) {
    diagnosticsEl.appendChild(diagnosticNode(diagnostic));
  }
}

function diagnosticNode(diagnostic: Diagnostic): HTMLDivElement {
  const node = document.createElement("div");
  node.className = "diagnostic";
  const source = diagnostic.source ? ` (${diagnostic.source})` : "";
  node.textContent = `${diagnostic.code}${source}: ${diagnostic.message}`;
  return node;
}

async function packageBytes(): Promise<Uint8Array> {
  if (!state) {
    throw new Error("No document is loaded.");
  }
  applyStateToZip(state);
  return state.zip.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
    mimeType: MCD_MIMETYPE,
  });
}

function applyStateToZip(packageState: PackageState): void {
  packageState.zip.file("mimetype", `${MCD_MIMETYPE}\n`, { compression: "STORE" });
  packageState.zip.file(packageState.manifest.entrypoint, packageState.markdown);
  packageState.manifest.annotations = packageState.annotations.map((annotation) => ({
    id: annotation.id,
    metadata: annotation.metadata,
  }));
  for (const path of packageState.removedAnnotationPaths) {
    packageState.zip.remove(path);
  }

  for (const table of packageState.tables) {
    packageState.zip.file(table.manifest.schema, `${JSON.stringify(table.schema, null, 2)}\n`);
    packageState.zip.file(table.manifest.data, tableToCsv(table));
    for (const [viewId, view] of Object.entries(table.views)) {
      const path = table.manifest.views?.[viewId];
      if (path) {
        packageState.zip.file(path, `${JSON.stringify(view, null, 2)}\n`);
      }
    }
  }
  for (const annotation of packageState.annotations) {
    packageState.zip.file(
      annotation.metadata,
      `${JSON.stringify(annotationToJson(annotation), null, 2)}\n`,
    );
  }
  if (packageState.pageMapPath && packageState.pageMap) {
    packageState.zip.file(
      packageState.pageMapPath,
      `${JSON.stringify(packageState.pageMap, null, 2)}\n`,
    );
  }
  packageState.zip.file("manifest.json", `${JSON.stringify(packageState.manifest, null, 2)}\n`);
}

function tableToCsv(table: EditableTable): string {
  const fields = table.schema.columns.map((column) => column.name);
  const data = table.rows.map((row) => fields.map((field) => row[field] ?? ""));
  return `${Papa.unparse({ fields, data }, { newline: "\n" })}\n`;
}

function renderMath(tex: string, displayMode: boolean): string {
  const expression = tex.trim();
  const tag = displayMode ? "div" : "span";
  const className = displayMode ? "mcd-math" : "mcd-inline-math";
  if (!expression) {
    return displayMode ? "" : "$$";
  }

  try {
    const rendered = katex.renderToString(expression, {
      displayMode,
      output: "htmlAndMathml",
      throwOnError: false,
      trust: false,
      strict: "warn",
      maxSize: 20,
      maxExpand: 1000,
    });
    return `<${tag} class="${className}" data-mcd-math="${displayMode ? "display" : "inline"}">${rendered}</${tag}>`;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid math expression.";
    if (displayMode) {
      return `<pre class="mcd-math mcd-math-fallback" data-mcd-math="display" data-mcd-math-error="${escapeAttr(
        message,
      )}"><code>${escapeHtml(expression)}</code></pre>`;
    }
    return `<code class="mcd-inline-math mcd-math-fallback" data-mcd-math="inline" title="${escapeAttr(
      message,
    )}">${escapeHtml(expression)}</code>`;
  }
}

function annotationToJson(annotation: EditableAnnotation): Record<string, unknown> {
  const line = Number(annotation.line);
  const parsedTarget = safeAnnotationTarget(annotation.targetText);
  const output: Record<string, unknown> = {
    id: annotation.id,
    target:
      parsedTarget ??
      (state && Number.isInteger(line) && line > 0
        ? sourceLineTarget(state.manifest.entrypoint, line)
        : { type: "document" }),
    kind: annotation.kind,
    status: annotation.status,
    body: annotation.body,
  };
  if (annotation.author.trim()) {
    output.author = annotation.author.trim();
  }
  if (annotation.created.trim()) {
    output.created = annotation.created.trim();
  }
  const labels = annotation.labels
    .split(",")
    .map((label) => label.trim())
    .filter(Boolean);
  if (labels.length > 0) {
    output.labels = [...new Set(labels)];
  }
  return output;
}

function safeAnnotationTarget(targetText: string): Record<string, unknown> | undefined {
  try {
    return targetRecord(JSON.parse(targetText));
  } catch {
    return undefined;
  }
}

async function saveAnnotationLocally(annotation: EditableAnnotation): Promise<void> {
  if (!state) {
    return;
  }
  try {
    applyStateToZip(state);
    locallySavedAnnotationIds.add(annotation.id);
    if (pendingMarginAnnotationId === annotation.id) {
      pendingMarginAnnotationId = undefined;
    }
    if (pendingWordAnnotationId === annotation.id) {
      pendingWordAnnotationId = undefined;
    }
    state.dirty = true;
    fileNameEl.textContent = `${state.fileName} (edited)`;
    await renderAndValidate();
    renderAnnotationsEditor();
    setStatus(
      `Saved annotation '${annotation.id}' locally in this browser session. Save .mcd to write the full file.`,
    );
  } catch (error) {
    showError(error);
  }
}

async function saveDocument(): Promise<void> {
  if (!state) {
    return;
  }
  try {
    await renderAndValidate();
    const bytes = await packageBytes();
    const doc = await openMcd(bytes);
    const validation = doc.validate();
    renderDiagnostics(validation);
    if (!validation.valid) {
      setStatus("Fix validation errors before saving.");
      return;
    }
    const blobBytes = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(blobBytes).set(bytes);
    const blob = new Blob([blobBytes], { type: MCD_MIMETYPE });
    const suggestedName = outputFileName(state.fileName, state.plainMarkdownInput);
    const picker = (window as SaveFilePickerWindow).showSaveFilePicker;
    if (picker) {
      const handle = await picker({
        suggestedName,
        types: [
          {
            description: "MCD document",
            accept: { [MCD_MIMETYPE]: [".mcd"] },
          },
        ],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
    } else {
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = suggestedName;
      link.click();
      URL.revokeObjectURL(link.href);
    }
    state.dirty = false;
    pendingMarginAnnotationId = undefined;
    pendingWordAnnotationId = undefined;
    const snapshot = captureStateSnapshot();
    savedContentKey = snapshot ? contentKey(snapshot) : savedContentKey;
    fileNameEl.textContent = state.fileName;
    syncHistoryButtons();
    setStatus("Saved current package bytes.");
  } catch (error) {
    showError(error);
  }
}

function outputFileName(fileName: string, forceMcd: boolean): string {
  if (forceMcd || !fileName.toLowerCase().endsWith(".mcd")) {
    return `${fileName.replace(/\.[^.]+$/, "") || "document"}.mcd`;
  }
  return fileName;
}

function setStatus(message: string): void {
  statusLine.textContent = message;
}

function clearDiagnostics(): void {
  diagnosticsEl.innerHTML = "";
}

function showError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  setStatus(message);
  const node = document.createElement("div");
  node.className = "diagnostic";
  node.textContent = message;
  diagnosticsEl.appendChild(node);
}

function revokeAssetUrls(): void {
  for (const url of assetUrls) {
    URL.revokeObjectURL(url);
  }
  assetUrls = [];
}

function nextAnnotationId(packageState: PackageState): string {
  const existing = new Set(packageState.annotations.map((annotation) => annotation.id));
  for (let index = 1; ; index += 1) {
    const id = `annotation-${String(index).padStart(4, "0")}`;
    if (!existing.has(id)) {
      return id;
    }
  }
}

function sanitizeId(value: string): string {
  const cleaned = value
    .trim()
    .replace(/^[^A-Za-z0-9]+/, "")
    .replace(/[^A-Za-z0-9_.-]/g, "-");
  return cleaned || "annotation";
}

function capitalize(value: string): string {
  return `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`;
}

function options(values: string[], selected: string): string {
  return values
    .map(
      (value) =>
        `<option value="${escapeAttr(value)}"${value === selected ? " selected" : ""}>${escapeHtml(
          value,
        )}</option>`,
    )
    .join("");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replaceAll('"', "&quot;");
}
