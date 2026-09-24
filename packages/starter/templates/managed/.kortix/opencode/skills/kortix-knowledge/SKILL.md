---
name: kortix-knowledge
description: How to find and use project documents in `.kortix/knowledge/` — contracts, specs, reports, spreadsheets, and notes that people uploaded for agents. Load this when a task may depend on project documents ("per our contract", "use the brand guide", "check the pricing sheet", "what does the spec say"), when the user mentions uploaded files or knowledge, or when you need to add a document to the project yourself.
---

<skill name="kortix-knowledge">

<overview>
Project knowledge is a folder in the project repository:

```
.kortix/knowledge/
├── INDEX.md              One line per document. Read this first.
├── brief.md
└── contracts/
    └── msa.pdf
```

Every session clones the repository, so every document is already on disk.
Nothing is injected into your prompt. When a task may need a project
document, read `.kortix/knowledge/INDEX.md`, pick the relevant files, and
read them. If the folder or the index does not exist, the project has no
knowledge documents.

People upload documents from the web app (project → Customize → Knowledge).
Each upload is one commit on the default branch that also rewrites
`INDEX.md`.
</overview>

<index-format>
`INDEX.md` lists one line per file, sorted by path. Paths are relative to
`.kortix/knowledge/`:

```
- [contracts/msa.pdf](<contracts/msa.pdf>) — pdf · 1.2 MB — Master services agreement
- [brief.md](<brief.md>) — md · 3.4 KB
```

Fields: path, type (lowercase extension), size, and an optional one-line
description. The web app regenerates this file on every write. It keeps the
description of each line whose path still exists and drops everything else,
so do not put prose or extra sections in it.
</index-format>

<reading>
- Text formats (`md`, `txt`, `csv`, `json`, `yaml`, `html`): read the file
  directly.
- Office documents and PDFs (`docx`, `doc`, `pptx`, `xlsx`, `odt`, `rtf`,
  `epub`, `pdf`): convert with `anydoc`, or load the
  `convert-documents-to-markdown` skill. For a large file, write to a file
  and read the parts you need:

  ```sh
  anydoc .kortix/knowledge/contracts/msa.pdf -o /tmp/msa.md
  ```

- Scanned PDFs have no text layer and `anydoc` exits `1`. Use the OCR path in
  the `pdf` skill.
- Cite the document path when an answer depends on it.
- Do not copy document contents into `.kortix/memory/`. Memory records durable
  facts about the project; knowledge holds the source documents.
</reading>

<adding>
Add a document only when the user asks for it or when a result is clearly
reference material for later sessions.

1. Write the file under `.kortix/knowledge/`. Use a descriptive name and a
   folder when it helps (`contracts/`, `research/`). No hidden files, no `..`,
   and no `[ ] < >` in names.
2. Add one line to `INDEX.md` in the format above, keeping lines sorted by
   path. Create the file with a `# Knowledge` heading if it does not exist.
3. Land it through a change request, like any other repository change:

   ```sh
   git add .kortix/knowledge
   git commit -m "knowledge: add contracts/msa.pdf"
   git push origin HEAD
   kortix cr open --title "knowledge: add contracts/msa.pdf" \
     --description "What the document is and why it belongs in knowledge."
   ```

Keep the folder small. Every session clones it. The web upload limits are
25 MB per file and 200 MB per project; stay well under them. Do not add
generated output, build artifacts, secrets, or personal data.
</adding>

</skill>
