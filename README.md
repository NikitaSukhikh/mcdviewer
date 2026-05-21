# mcdviewer

Open source web viewer and editor for `.mcd` (Markdown CSV Document) files.

Local-first browser viewer/editor for `.mcd` packages.

Current scope:

- Open a local `.mcd` package or plain Markdown `.mcd` file.
- Create a new empty `.mcd` package for Markdown entrypoint editing.
- Validate through the existing `@mcd/parser` WebAssembly binding.
- Render an expanded Markdown preview in the browser.
- Edit the Markdown entrypoint.
- Edit manifest-declared annotation JSON through structured fields.
- Edit CSV-backed table rows using the existing table schemas.
- Save the updated package as `.mcd`.

Image assets are preserved in the package and may render in preview, but this
app intentionally does not add, remove, or edit image metadata/assets yet.

## Run

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
```
