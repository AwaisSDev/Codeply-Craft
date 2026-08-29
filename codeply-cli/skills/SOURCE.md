# Where these skills came from

The skill library in this directory — all 281 of them — is vendored from
[affaan-m/ECC](https://github.com/affaan-m/ECC) ("Every Coding Copilot"), an
open-source collection of agent skills for Claude Code, Codex, and other
harnesses. It's their full `skills/` library, not a subset — every `SKILL.md`
and its `references/*.md` companions, unmodified.

Codeply loads its skill format directly from that project's convention: a
`SKILL.md` per skill with YAML frontmatter (`name`, `description`) and a
markdown body. See [lib/skills.js](../lib/skills.js) for the loader.

Only `SKILL.md` and `references/*.md` were vendored — each skill's
`agents/openai.yaml` (a tool schema for a different harness's native
function-calling) was left out, since Codeply calls skills through its own
text-based action protocol and has no use for it.

Not every one of the 281 is loaded into the agent's context by default —
`lib/skills.js` shows a curated "daily" subset (ECC's own `.agents/skills/`
curation of its full library) to keep the always-injected index small; the
rest are still fully installed and reachable with `list_skills <query>` or
`codeply skill show <name>`.

## License

ECC is MIT-licensed. Its license and copyright notice, reproduced here as MIT
requires when redistributing:

```
MIT License

Copyright (c) 2026 Affaan Mustafa

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Adding your own

Anything you drop in `~/.codeply/skills/<name>/SKILL.md` (same frontmatter
format) is picked up the same way, and takes priority over a bundled skill of
the same name. `codeply skill install <path-or-github-url>` automates that —
see `codeply skill --help`.
