# Importer fixture corpus

Real-world files exercised by the importer parsers, organised by parser:

```
fixtures/corpus/
├── msproject/    *.xml            (MS Project XML exports)
├── excel/        *.xlsx           (Excel Gantt sheets)
└── pptx/         *.pptx           (PowerPoint diagrams)
```

Each fixture has a sibling `<name>.expected.json` snapshot of the parser's
`ImportResult`. The harness in `src/corpus.test.ts` walks these directories
and asserts each fixture parses to its snapshot. CI runs the same tests on
every PR.

## Why a corpus exists

The synthetic-fixture unit tests (in `excel.test.ts`, `pptx.test.ts`) build
their inputs in-memory using SheetJS / JSZip — the same libraries the parsers
read with. They pass even when the parser misreads files written by _real_
Microsoft Office, because real Office output differs in cell ordering,
optional XML parts, number formats, and dozens of other details.

The corpus closes that gap by holding genuine artefacts saved by the actual
authoring apps (Excel, PowerPoint, MS Project / ProjectLibre). Adding one
fixture that exercises a real-world quirk locks in protection against that
quirk forever.

## Adding a fixture

The Caladia repo can be cloned on the **Mac Studio** (or any Mac with the
authoring apps installed) and used as a fixture-authoring station. The
authoring apps themselves are not required by CI — only the resulting files.

### Per parser

#### MS Project XML (`fixtures/corpus/msproject/`)

**Authoring tool: ProjectLibre** (free, native macOS, runs on Apple Silicon)
or MS Project on Windows / a Windows VM.

1. Open ProjectLibre → File → New → build a project (or open a `.mpp`)
2. File → Save As → choose **MS Project XML (`.xml`)** — this matches the
   format MS Project itself produces
3. Save into `packages/importers/fixtures/corpus/msproject/<name>.xml`

> Note: ProjectLibre's XML output is byte-equivalent to MS Project's for
> fields the importer cares about (Tasks, PredecessorLinks, Resources,
> Assignments). It's the gold standard fixture source on macOS.

#### Excel (`fixtures/corpus/excel/`)

**Authoring tool: Microsoft Excel** (subscription, App Store install).

The parser supports two layouts. Add fixtures for both:

**Tabular** — one task per row, columns for Name / Duration / Predecessor /
Resource. Example sources:

- Vertex42 Gantt template (the most-cloned tabular layout in the wild)
- Microsoft's "Simple Gantt chart" template (slightly different conventions)

**Visual** — one task per row, columns for date periods, filled cells form
the bar. Example: any custom-built Gantt with `X` marks across day columns.

Workflow:

1. Open or build a sheet in Excel
2. **File → Save As → Excel Workbook (`.xlsx`)** (do _not_ use "Strict Open
   XML" — that produces a different schema)
3. Save into `packages/importers/fixtures/corpus/excel/<name>.xlsx`

#### PowerPoint (`fixtures/corpus/pptx/`)

**Authoring tool: Microsoft PowerPoint** (subscription, App Store install).

The parser recognises `prstGeom` shape primitives (`rect`, `diamond`,
`ellipse`, etc.) and `cxnSp` connectors. Two distinct authoring styles
to cover:

- **Drawn process** — manually placed shapes from Insert → Shapes, joined
  with arrows. Most decks in the wild look like this.
- **SmartArt process** — Insert → SmartArt → Process. Generates a different
  shape tree; worth testing separately.

Workflow:

1. Build the slide in PowerPoint
2. File → Save As → **PowerPoint Presentation (`.pptx`)**
3. Save into `packages/importers/fixtures/corpus/pptx/<name>.pptx`

### Generate the snapshot

After adding the file:

```bash
pnpm --filter @procsim/importers fixtures:update
```

This walks every parser's directory, runs the parser on each file, and
writes `<name>.expected.json` next to the source. Files whose snapshots
already match are left untouched.

Review the generated diff carefully — the snapshot is the contract. If the
output looks wrong, fix the parser, not the snapshot.

### Commit

```bash
git add packages/importers/fixtures/corpus/<parser>/<name>.{xml|xlsx|pptx} \
        packages/importers/fixtures/corpus/<parser>/<name>.expected.json
git commit -m "test(importers): add <parser> fixture <name>"
```

Source file and snapshot **must always be committed together** — the corpus
test fails loudly if a fixture has no snapshot, but won't catch a snapshot
that's been edited away from its source.

## Naming conventions

Use `kebab-case` filenames that describe what's being tested, not the
authoring app:

| Good                                 | Bad                          |
| ------------------------------------ | ---------------------------- |
| `vertex42-template.xlsx`             | `book1.xlsx`                 |
| `with-resources-and-assignments.xml` | `test-from-projectlibre.xml` |
| `smartart-process.pptx`              | `Presentation 2.pptx`        |

The filename is the first thing a future contributor reads when a snapshot
diff confuses them.

## Suggested initial fixtures

Targets to seed the corpus with — each exercises a known parser code path:

**msproject/**

- `simple.xml` — already in repo (hand-crafted)
- `projectlibre-export.xml` — non-trivial real export
- `with-resources-and-assignments.xml` — exercises `<Assignments>` parsing
- `non-fs-predecessors.xml` — SS / FF / SF dependencies

**excel/**

- `vertex42-template.xlsx`
- `microsoft-simple-gantt.xlsx`
- `visual-bars-with-X-marks.xlsx`
- `mixed-units-and-blanks.xlsx` — `5`, `5d`, `40h`, blank in same column

**pptx/**

- `kickoff-deck-drawn.pptx` — manual shapes + connectors
- `smartart-process.pptx` — Insert → SmartArt → Process

## Removing a fixture

1. Delete the source file (`<name>.xml` / `.xlsx` / `.pptx`)
2. Delete the matching `<name>.expected.json`
3. Commit both deletions together

The update script does not delete orphaned snapshots automatically — that's
intentional, to avoid losing snapshots when a source file is briefly
unstaged during a rename.
