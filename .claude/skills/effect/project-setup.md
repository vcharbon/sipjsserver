# Project Setup — Effect v4

This guide covers the Effect Language Service and local reference repositories for AI-assisted development.

## Effect Language Service

The [Effect Language Service](https://github.com/Effect-TS/language-service) provides editor diagnostics and compile-time type checking.

### Installation

```bash
bun add -d @effect/language-service
```

Add to `tsconfig.json`:

```json
{
  "$schema": "https://raw.githubusercontent.com/Effect-TS/language-service/refs/heads/main/schema.json",
  "compilerOptions": {
    "plugins": [
      { "name": "@effect/language-service" }
    ]
  }
}
```

### Editor Setup

Your editor must use the **workspace** TypeScript version (not its built-in one).

**VS Code / Cursor:**
1. Add to `.vscode/settings.json`:
   ```json
   {
     "typescript.tsdk": "./node_modules/typescript/lib",
     "typescript.enablePromptUseWorkspaceTsdk": true
   }
   ```
2. Press F1 → "TypeScript: Select TypeScript version" → "Use workspace version"

**JetBrains:** Settings → Languages & Frameworks → TypeScript → select workspace version.

### Build-Time Diagnostics

```bash
bunx effect-language-service patch
```

Add to `package.json` to persist:
```json
{
  "scripts": {
    "prepare": "effect-language-service patch"
  }
}
```

## Reference Repository

Clone the Effect v4 source locally so your agent can grep through real implementations:

```bash
git clone --depth 1 https://github.com/Effect-TS/effect-smol.git ~/.local/share/effect-solutions/effect
```

Update later: `git -C ~/.local/share/effect-solutions/effect pull --depth 1`

Add to `CLAUDE.md` or `AGENTS.md`:
```markdown
## Local Effect Source

The Effect v4 repository is cloned to `~/.local/share/effect-solutions/effect` for reference.
Use this to explore APIs, find usage examples, and understand implementation details.
```

The local source is already available at `~/.local/share/effect-solutions/effect` in this project.
