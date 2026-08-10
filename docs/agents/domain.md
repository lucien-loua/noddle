# Domain Docs

How engineering skills consume this repo's domain documentation.

## Before exploring, read these

1. **`CONTEXT.md`** — glossary / ubiquitous language
2. **`docs/adr/`** — decisions for the area you touch ([index](../adr/README.md))
3. **`.claude/CLAUDE.md`** — operating instructions only (hard rules, UI, phase, topology)

If a term or decision is missing, proceed from what exists and note the gap for
`/domain-modeling`. Do not invent parallel glossaries in chat or in `CLAUDE.md`.

New decisions → **`docs/adr/`**. New terms → **`CONTEXT.md`**. Update `CLAUDE.md`
only when an operating rule or measured hard constraint changes.

## File structure

```
/
├── CONTEXT.md
├── AGENTS.md                  ← Ultracite / Biome standards
├── docs/
│   ├── README.md              ← map
│   ├── adr/                   ← decisions + README index
│   └── agents/                ← this folder
├── .claude/CLAUDE.md          ← operating instructions
├── .scratch/                  ← local issue tracker (gitignored)
├── apps/
└── packages/
```

## Use the glossary's vocabulary

When naming a domain concept, use `CONTEXT.md`. Don't drift to synonyms listed
under `_Avoid_`. Missing term → gap for `/domain-modeling`.

## Flag ADR conflicts

If output contradicts an ADR, surface it:

> _Contradicts ADR-0001 (Docker Swarm orchestration) — but worth reopening because…_
