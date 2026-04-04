# TypeScript Configuration — Effect v4

Effect projects benefit from strict TypeScript configuration.

## Key Settings

```jsonc
{
  "compilerOptions": {
    // Build Performance
    "incremental": true,      // Fast rebuilds via .tsbuildinfo cache
    "composite": true,        // Enables project references for monorepos

    // Type Safety
    "strict": true,
    "exactOptionalPropertyTypes": true,  // { x?: number } can't be { x: undefined }
    "noUnusedLocals": true,
    "noImplicitOverride": true,

    // Development
    "declarationMap": true,   // Jump-to-definition works for .d.ts
    "sourceMap": true,
    "skipLibCheck": true,     // Faster builds

    // Effect Language Service
    "plugins": [{ "name": "@effect/language-service" }]
  }
}
```

## Module Settings by Project Type

### Bundled Apps (Vite, Webpack, esbuild, Rollup)

```jsonc
{
  "compilerOptions": {
    "module": "preserve",
    "moduleResolution": "bundler",
    "noEmit": true
  }
}
```

Use when a build tool handles module transformation. TypeScript acts as type-checker only.
- Allows flexible import paths (with or without extensions)
- Assumes bundler handles package.json exports/imports
- Used for frontend apps

### Libraries & Node.js Apps

```jsonc
{
  "compilerOptions": {
    "module": "NodeNext",
    "target": "ES2022",
    "moduleDetection": "force",
    "verbatimModuleSyntax": true,
    "rewriteRelativeImportExtensions": true,

    // Libraries only:
    "declaration": true,
    "composite": true,      // monorepos
    "declarationMap": true  // monorepos
  }
}
```

Use when TypeScript is your compiler. Enforces Node.js module resolution:
- Requires `.js` extensions in relative imports
- Respects `package.json` `"type"` and `"exports"` fields

**Rule of thumb:** Build tool compiling your code? Use `preserve` + `bundler`. TypeScript compiling? Use `NodeNext`.
