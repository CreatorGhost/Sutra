# Third-party notices

Sutra includes code adapted from the following projects.

## ViewCode / T3 Code

Source: https://github.com/CreatorGhost/viewcode (a fork of T3 Code by T3 Tools Inc.)

Ported (logic re-implemented in plain Node/TypeScript, without the Effect library) into:

- `frontend/electron/acp.ts` — the one-shot Agent Client Protocol client (from `AcpSessionRuntime`, `AcpTextGeneration`, the xAI prompt-complete fallback).
- `frontend/electron/proc.ts` — Windows PATHEXT lookup, known CLI directories and `cmd.exe` argument escaping (from `packages/shared/src/shell.ts`).
- `frontend/electron/engines.ts`, `frontend/src/shared/agentProtocol.ts` — how Claude Code, Cursor Agent, Grok, Droid and Command Code are invoked and probed (from `textGeneration/*TextGeneration.ts`, `provider/acp/*AcpSupport.ts`, `provider/commandCodeCli.ts`, `provider/Layers/*Provider.ts`).
- `frontend/src/shared/engineProbes.ts` — `parseCursorAboutOutput`, `parseGrokModelsCliOutput`, `parseDroidModelList`, `parseCommandCodeStatus`, `parseCommandCodeModelList`.
- `extractJson` in `frontend/src/shared/agentProtocol.ts` — after `extractJsonObject` (`packages/shared/src/schemaJson.ts`).

```
MIT License

Copyright (c) 2026 T3 Tools Inc.

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
