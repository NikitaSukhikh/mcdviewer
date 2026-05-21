# @mcd-nix/parser

TypeScript/JavaScript bindings for Markdown CSV Document packages.

```ts
import { openMcd } from "@mcd-nix/parser";

const doc = await openMcd(bytes);
const validation = doc.validate();
const markdown = doc.markdown({ expandTables: true });
```

The package embeds the MCD WebAssembly parser and does not require a separate
`mcd` CLI installation.
