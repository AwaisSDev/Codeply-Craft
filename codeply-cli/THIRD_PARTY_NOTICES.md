# Third-party notices

"OpenAI", "ChatGPT" and the OpenAI Blossom logo (`assets/brand/openai-blossom-*.svg` in the desktop app, shown next to "Continue with ChatGPT") are trademarks of OpenAI, used unmodified under OpenAI's brand guidelines (https://openai.com/brand). They are not covered by this project's MIT license, and their use does not imply endorsement by OpenAI.

Parts of the Codeply engine (codeply-cli/lib) are adapted from the open-source projects below. Each adapted section is marked in the source with a comment naming the project.

## opencode

https://github.com/sst/opencode

Used in: `lib/edit-engine.js` (fallback edit matchers), `lib/agent.mjs` (compaction summary template, instruction-file lookup order), `lib/snapshot.js` (hidden git snapshots for undo), `lib/arity.js` and `lib/arity-table.json` (command-name table for scoped approvals, copied from `permission/arity.ts`), `lib/ai.js` (retry-after handling), `lib/permissions.js` (rule evaluation approach), `lib/commands.js` (command file layout).

```
MIT License

Copyright (c) 2025 opencode

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

## Hermes Agent

https://github.com/NousResearch/hermes-agent

Used in: `lib/terminal-hints.js` (failed-command hints, masked-success check), `lib/agent.mjs` (stall nudges, loop and failure-streak guards, fallback summary), `lib/tools.mjs` (task list design).

```
MIT License

Copyright (c) 2025 Nous Research

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
