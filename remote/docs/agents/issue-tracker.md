# Issue tracker — pi-remote

- **Tracker:** local markdown. Issues and specs live as files under
  `.scratch/<feature>/` in this repo. No remote exists; do not call `gh`/`glab`.
- **One directory per feature** (e.g. `.scratch/pi-remote/`), one markdown file
  per issue/spec: `NNN-slug.md`.
- **Labels:** written as a `Labels:` line in the file header. Vocabulary:
  `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`.
- **Domain docs:** single-context — `CONTEXT.md` (glossary) and `docs/adr/`
  at the repo root. Read both before implementing; the glossary is normative
  vocabulary, ADRs 0001–0005 are the architecture decisions.

Executable behavior scenarios live in `features/*.feature` (Gherkin) and are
the living specification the implementation is verified against.
