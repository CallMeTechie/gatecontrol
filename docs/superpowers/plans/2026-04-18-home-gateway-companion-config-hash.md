# Home Gateway Companion — Plan 1/3: Config-Hash npm-Paket

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Erstes Teilprojekt des Home-Gateway-Companion: das geteilte npm-Paket `@callmetechie/gatecontrol-config-hash`, das von Server und Gateway zur byte-identischen Config-Hash-Berechnung genutzt wird.

**Architecture:** Eigenes GitHub-Repo `gatecontrol-config-hash`, TypeScript-Library mit Dual-ESM/CJS-Build, publiziert in GitHub Package Registry unter `@callmetechie/gatecontrol-config-hash`. Implementiert RFC 8785 JSON Canonicalization Scheme plus projektspezifische Regeln (Drop-Null, Array-Sortierung nach kanonischer Repräsentation) aus Spec-Sektion 3.2.

**Tech Stack:** TypeScript 5.x · Jest 29 · fast-check 3.x (property-based) · tsup (Bundler) · Zod 3.x · Node 20+ · GitHub Actions · GitHub Package Registry

**Spec-Referenz:** `/root/gatecontrol/docs/superpowers/specs/2026-04-18-home-gateway-companion-design.md` Sektion 3.2 „Config-Hash Canonicalization-Spec"

---

## Voraussetzungen (User-Aktionen vor Start)

1. Leeres GitHub-Repo **`CallMeTechie/gatecontrol-config-hash`** auf github.com anlegen (Private, kein README/Gitignore/License vorbefüllen)
2. Persönlichen GitHub-Token mit `packages:write` scope bereitstellen (für späteres `npm publish`)
3. In Repo-Settings → Secrets → `NPM_TOKEN` als GitHub-Token hinterlegen

---

## Task 1: Repo-Scaffolding + TypeScript-Setup

**Files:**
- Create: `/root/gatecontrol-config-hash/package.json`
- Create: `/root/gatecontrol-config-hash/tsconfig.json`
- Create: `/root/gatecontrol-config-hash/.gitignore`
- Create: `/root/gatecontrol-config-hash/.npmrc`
- Create: `/root/gatecontrol-config-hash/README.md`

- [ ] **Step 1: Repo klonen**

```bash
cd /root && git clone git@github.com:CallMeTechie/gatecontrol-config-hash.git
cd gatecontrol-config-hash
```

- [ ] **Step 2: package.json anlegen**

Create `/root/gatecontrol-config-hash/package.json`:

```json
{
  "name": "@callmetechie/gatecontrol-config-hash",
  "version": "0.0.0",
  "description": "Shared canonicalization and hashing for GateControl Home Gateway config sync. RFC 8785 JCS with project-specific extensions.",
  "license": "UNLICENSED",
  "private": false,
  "type": "module",
  "main": "./dist/index.cjs",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
      "require": "./dist/index.cjs"
    }
  },
  "files": ["dist", "README.md"],
  "repository": {
    "type": "git",
    "url": "git+https://github.com/CallMeTechie/gatecontrol-config-hash.git"
  },
  "publishConfig": {
    "registry": "https://npm.pkg.github.com/"
  },
  "engines": { "node": ">=20.0.0" },
  "scripts": {
    "build": "tsup src/index.ts --format cjs,esm --dts --clean",
    "test": "NODE_OPTIONS=--experimental-vm-modules jest",
    "test:coverage": "NODE_OPTIONS=--experimental-vm-modules jest --coverage",
    "lint": "tsc --noEmit",
    "prepublishOnly": "npm run build"
  },
  "dependencies": {
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@types/jest": "^29.5.0",
    "@types/node": "^20.11.0",
    "fast-check": "^3.23.0",
    "jest": "^29.7.0",
    "ts-jest": "^29.1.0",
    "tsup": "^8.3.0",
    "typescript": "^5.5.0"
  }
}
```

- [ ] **Step 3: tsconfig.json anlegen**

Create `/root/gatecontrol-config-hash/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "esModuleInterop": true,
    "strict": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "outDir": "./dist",
    "rootDir": "./src",
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

- [ ] **Step 4: .gitignore anlegen**

Create `/root/gatecontrol-config-hash/.gitignore`:

```
node_modules/
dist/
coverage/
*.log
.DS_Store
.env
.env.*
!.env.example
```

- [ ] **Step 5: .npmrc anlegen für GitHub Package Registry**

Create `/root/gatecontrol-config-hash/.npmrc`:

```
@callmetechie:registry=https://npm.pkg.github.com/
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
```

- [ ] **Step 6: README.md Minimal-Stub**

Create `/root/gatecontrol-config-hash/README.md`:

```markdown
# @callmetechie/gatecontrol-config-hash

Shared canonicalization and hashing library for GateControl Home Gateway configuration sync.

Implements RFC 8785 (JSON Canonicalization Scheme) with project-specific rules per the Home Gateway Companion design spec v1.2.

**Not for public use.** See the main GateControl repository for context.
```

- [ ] **Step 7: npm install ausführen + erste Commit**

```bash
cd /root/gatecontrol-config-hash
npm install
git add package.json tsconfig.json .gitignore .npmrc README.md package-lock.json
git commit -m "chore: scaffold @callmetechie/gatecontrol-config-hash"
git push origin main
```

Expected: Commit gepusht, `node_modules` vorhanden aber nicht im Repo.

---

## Task 2: Jest-Konfiguration

**Files:**
- Create: `/root/gatecontrol-config-hash/jest.config.js`

- [ ] **Step 1: Jest-Config erstellen**

Create `/root/gatecontrol-config-hash/jest.config.js`:

```javascript
/** @type {import('jest').Config} */
export default {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1'
  },
  transform: {
    '^.+\\.ts$': ['ts-jest', {
      useESM: true,
      tsconfig: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'bundler',
        esModuleInterop: true,
        strict: true,
        types: ['jest', 'node']
      }
    }]
  },
  testMatch: ['<rootDir>/tests/**/*.test.ts'],
  collectCoverageFrom: ['src/**/*.ts'],
  coverageThreshold: {
    global: { branches: 90, functions: 95, lines: 95, statements: 95 }
  }
};
```

- [ ] **Step 2: Leerer Test-Smoke um Setup zu verifizieren**

Create `/root/gatecontrol-config-hash/tests/smoke.test.ts`:

```typescript
describe('smoke', () => {
  it('jest runs typescript', () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 3: Test ausführen**

```bash
cd /root/gatecontrol-config-hash && npm test
```

Expected: `1 passed`.

- [ ] **Step 4: Commit**

```bash
git add jest.config.js tests/smoke.test.ts
git commit -m "chore: configure jest with ts-jest ESM"
git push
```

---

## Task 3: String-Canonicalization

**Files:**
- Create: `/root/gatecontrol-config-hash/src/primitives.ts`
- Create: `/root/gatecontrol-config-hash/tests/primitives.test.ts`

- [ ] **Step 1: Failing Test schreiben**

Create `/root/gatecontrol-config-hash/tests/primitives.test.ts`:

```typescript
import { canonicalizeString } from '../src/primitives';

describe('canonicalizeString', () => {
  it('returns JSON-escaped string with double quotes', () => {
    expect(canonicalizeString('hello')).toBe('"hello"');
  });

  it('escapes backslash', () => {
    expect(canonicalizeString('a\\b')).toBe('"a\\\\b"');
  });

  it('escapes double quote', () => {
    expect(canonicalizeString('a"b')).toBe('"a\\"b"');
  });

  it('escapes control character U+0000', () => {
    expect(canonicalizeString('\u0000')).toBe('"\\u0000"');
  });

  it('escapes control character U+001F', () => {
    expect(canonicalizeString('\u001f')).toBe('"\\u001f"');
  });

  it('passes through printable non-ASCII Unicode (U+0080 and above)', () => {
    expect(canonicalizeString('café')).toBe('"café"');
  });

  it('escapes newline, tab, return', () => {
    expect(canonicalizeString('\n\t\r')).toBe('"\\n\\t\\r"');
  });

  it('escapes backspace and form-feed', () => {
    expect(canonicalizeString('\b\f')).toBe('"\\b\\f"');
  });
});
```

- [ ] **Step 2: Test ausführen — muss failen**

```bash
npm test -- tests/primitives.test.ts
```

Expected: Test failt mit `Cannot find module '../src/primitives'`.

- [ ] **Step 3: Implementation schreiben**

Create `/root/gatecontrol-config-hash/src/primitives.ts`:

```typescript
/**
 * Canonicalize a string per RFC 8785 §3.2.2:
 * - Wrap in double quotes
 * - Escape control chars U+0000–U+001F as \uXXXX (lowercase hex) OR named (\n, \t, \r, \b, \f)
 * - Escape backslash and double quote
 * - Leave other Unicode (≥ U+0020) as-is (UTF-8)
 */
export function canonicalizeString(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x22) out += '\\"';
    else if (c === 0x5c) out += '\\\\';
    else if (c === 0x08) out += '\\b';
    else if (c === 0x09) out += '\\t';
    else if (c === 0x0a) out += '\\n';
    else if (c === 0x0c) out += '\\f';
    else if (c === 0x0d) out += '\\r';
    else if (c < 0x20) {
      out += '\\u' + c.toString(16).padStart(4, '0');
    } else {
      out += s[i];
    }
  }
  return out + '"';
}
```

- [ ] **Step 4: Test ausführen — muss grün sein**

```bash
npm test -- tests/primitives.test.ts
```

Expected: `8 passed`.

- [ ] **Step 5: Commit**

```bash
git add src/primitives.ts tests/primitives.test.ts
git commit -m "feat: add canonicalizeString per RFC 8785 §3.2.2"
git push
```

---

## Task 4: Number-Canonicalization

**Files:**
- Modify: `/root/gatecontrol-config-hash/src/primitives.ts`
- Modify: `/root/gatecontrol-config-hash/tests/primitives.test.ts`

- [ ] **Step 1: Failing Tests ergänzen**

Append to `/root/gatecontrol-config-hash/tests/primitives.test.ts`:

```typescript
import { canonicalizeNumber } from '../src/primitives';

describe('canonicalizeNumber', () => {
  it('serializes integer without decimal point', () => {
    expect(canonicalizeNumber(42)).toBe('42');
  });

  it('serializes zero as 0', () => {
    expect(canonicalizeNumber(0)).toBe('0');
  });

  it('serializes negative integer', () => {
    expect(canonicalizeNumber(-7)).toBe('-7');
  });

  it('serializes non-integer float', () => {
    expect(canonicalizeNumber(3.14)).toBe('3.14');
  });

  it('serializes integer-valued float without .0', () => {
    expect(canonicalizeNumber(5.0)).toBe('5');
  });

  it('rejects NaN', () => {
    expect(() => canonicalizeNumber(NaN)).toThrow(/NaN/);
  });

  it('rejects Infinity', () => {
    expect(() => canonicalizeNumber(Infinity)).toThrow(/Infinity/);
  });

  it('rejects -Infinity', () => {
    expect(() => canonicalizeNumber(-Infinity)).toThrow(/Infinity/);
  });

  it('rejects exponential notation (throws on unsafe numbers)', () => {
    expect(() => canonicalizeNumber(1e21)).toThrow(/exponential|unsafe/i);
  });
});
```

- [ ] **Step 2: Test ausführen — muss failen**

```bash
npm test -- tests/primitives.test.ts
```

Expected: Failures wegen `canonicalizeNumber is not a function`.

- [ ] **Step 3: Implementation ergänzen**

Append to `/root/gatecontrol-config-hash/src/primitives.ts`:

```typescript
/**
 * Canonicalize a number per Spec 3.2 Rule 5:
 * - Integers without decimal point
 * - No exponential notation
 * - Reject NaN, Infinity, -Infinity
 * - Reject unsafe integers that would force exponential notation
 */
export function canonicalizeNumber(n: number): string {
  if (Number.isNaN(n)) throw new Error('NaN is not allowed in canonicalized JSON');
  if (!Number.isFinite(n)) throw new Error('Infinity is not allowed in canonicalized JSON');

  if (Number.isInteger(n)) {
    if (Math.abs(n) >= 1e21) {
      throw new Error(`Number ${n} is outside safe integer range and would use exponential notation`);
    }
    return n.toString(10);
  }

  const str = n.toString(10);
  if (str.includes('e') || str.includes('E')) {
    throw new Error(`Number ${n} serializes to exponential notation (${str}), not allowed`);
  }
  return str;
}
```

- [ ] **Step 4: Test ausführen — muss grün sein**

```bash
npm test -- tests/primitives.test.ts
```

Expected: `17 passed` (8 String + 9 Number).

- [ ] **Step 5: Commit**

```bash
git add src/primitives.ts tests/primitives.test.ts
git commit -m "feat: add canonicalizeNumber with NaN/Infinity rejection and exp-notation guard"
git push
```

---

## Task 5: Value-Dispatcher (null/bool/string/number)

**Files:**
- Create: `/root/gatecontrol-config-hash/src/canonicalize.ts`
- Create: `/root/gatecontrol-config-hash/tests/canonicalize.test.ts`

- [ ] **Step 1: Failing Test schreiben**

Create `/root/gatecontrol-config-hash/tests/canonicalize.test.ts`:

```typescript
import { canonicalizeValue } from '../src/canonicalize';

describe('canonicalizeValue (primitives)', () => {
  it('canonicalizes true', () => {
    expect(canonicalizeValue(true)).toBe('true');
  });

  it('canonicalizes false', () => {
    expect(canonicalizeValue(false)).toBe('false');
  });

  it('canonicalizes string via canonicalizeString', () => {
    expect(canonicalizeValue('abc')).toBe('"abc"');
  });

  it('canonicalizes number via canonicalizeNumber', () => {
    expect(canonicalizeValue(123)).toBe('123');
  });

  it('returns null marker for null (caller drops)', () => {
    expect(canonicalizeValue(null)).toBe(null);
  });

  it('returns null marker for undefined (caller drops)', () => {
    expect(canonicalizeValue(undefined)).toBe(null);
  });

  it('throws on unsupported type (function)', () => {
    expect(() => canonicalizeValue((() => {}) as any)).toThrow(/unsupported/i);
  });

  it('throws on unsupported type (symbol)', () => {
    expect(() => canonicalizeValue(Symbol('x') as any)).toThrow(/unsupported/i);
  });

  it('throws on bigint', () => {
    expect(() => canonicalizeValue(BigInt(1) as any)).toThrow(/unsupported|bigint/i);
  });
});
```

- [ ] **Step 2: Test ausführen — muss failen**

```bash
npm test -- tests/canonicalize.test.ts
```

Expected: Failure wegen fehlendem Module.

- [ ] **Step 3: Implementation schreiben**

Create `/root/gatecontrol-config-hash/src/canonicalize.ts`:

```typescript
import { canonicalizeString, canonicalizeNumber } from './primitives.js';

export type CanonJson =
  | null
  | boolean
  | number
  | string
  | CanonJson[]
  | { [key: string]: CanonJson };

/**
 * Canonicalize a single value. Returns a canonical JSON string, or null
 * if the value should be dropped (null/undefined per Spec 3.2 Rule 7).
 * Arrays and objects are handled by dedicated canonicalizeArray/canonicalizeObject.
 */
export function canonicalizeValue(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'string') return canonicalizeString(v);
  if (typeof v === 'number') return canonicalizeNumber(v);
  if (Array.isArray(v)) return canonicalizeArray(v);
  if (typeof v === 'object') return canonicalizeObject(v as Record<string, unknown>);
  throw new Error(`Unsupported value type: ${typeof v}`);
}

// Forward declarations, implemented in subsequent tasks
export function canonicalizeArray(_a: unknown[]): string {
  throw new Error('canonicalizeArray not yet implemented');
}

export function canonicalizeObject(_o: Record<string, unknown>): string {
  throw new Error('canonicalizeObject not yet implemented');
}
```

- [ ] **Step 4: Test ausführen — muss grün sein**

```bash
npm test -- tests/canonicalize.test.ts
```

Expected: `9 passed`.

- [ ] **Step 5: Commit**

```bash
git add src/canonicalize.ts tests/canonicalize.test.ts
git commit -m "feat: add canonicalizeValue dispatcher for primitives + null-drop"
git push
```

---

## Task 6: Object-Canonicalization (Key-Sort + Drop-Null)

**Files:**
- Modify: `/root/gatecontrol-config-hash/src/canonicalize.ts`
- Modify: `/root/gatecontrol-config-hash/tests/canonicalize.test.ts`

- [ ] **Step 1: Failing Tests ergänzen**

Append to `/root/gatecontrol-config-hash/tests/canonicalize.test.ts`:

```typescript
import { canonicalizeObject } from '../src/canonicalize';

describe('canonicalizeObject', () => {
  it('empty object', () => {
    expect(canonicalizeObject({})).toBe('{}');
  });

  it('single key-value', () => {
    expect(canonicalizeObject({ a: 1 })).toBe('{"a":1}');
  });

  it('sorts keys alphabetically', () => {
    expect(canonicalizeObject({ b: 2, a: 1, c: 3 })).toBe('{"a":1,"b":2,"c":3}');
  });

  it('drops null-valued keys', () => {
    expect(canonicalizeObject({ a: 1, b: null, c: 3 })).toBe('{"a":1,"c":3}');
  });

  it('drops undefined-valued keys', () => {
    expect(canonicalizeObject({ a: 1, b: undefined, c: 3 } as any)).toBe('{"a":1,"c":3}');
  });

  it('handles nested objects (recursive sort)', () => {
    const input = { outer: { z: 2, a: 1 } };
    expect(canonicalizeObject(input)).toBe('{"outer":{"a":1,"z":2}}');
  });

  it('handles mixed types', () => {
    const input = { active: true, name: 'host', port: 8080 };
    expect(canonicalizeObject(input)).toBe('{"active":true,"name":"host","port":8080}');
  });

  it('key sort uses lexicographic UTF-16 code-unit comparison', () => {
    const input = { 'B': 1, 'a': 2 };
    expect(canonicalizeObject(input)).toBe('{"B":1,"a":2}');
  });

  it('no whitespace in output', () => {
    const input = { a: 1, b: 2 };
    const out = canonicalizeObject(input);
    expect(out).not.toMatch(/\s/);
  });
});
```

- [ ] **Step 2: Test ausführen — muss failen**

```bash
npm test -- tests/canonicalize.test.ts
```

Expected: Tests failen mit `canonicalizeObject not yet implemented`.

- [ ] **Step 3: Implementation ergänzen**

Replace the `canonicalizeObject` stub in `/root/gatecontrol-config-hash/src/canonicalize.ts`:

```typescript
export function canonicalizeObject(o: Record<string, unknown>): string {
  const keys = Object.keys(o).sort();
  const parts: string[] = [];
  for (const key of keys) {
    const v = o[key];
    const rendered = canonicalizeValue(v);
    if (rendered === null) continue;
    parts.push(`${canonicalizeString(key)}:${rendered}`);
  }
  return '{' + parts.join(',') + '}';
}
```

- [ ] **Step 4: Test ausführen — muss grün sein**

```bash
npm test -- tests/canonicalize.test.ts
```

Expected: `18 passed`.

- [ ] **Step 5: Commit**

```bash
git add src/canonicalize.ts tests/canonicalize.test.ts
git commit -m "feat: add canonicalizeObject with key-sort and null-drop"
git push
```

---

## Task 7: Array-Canonicalization (Sort by Canonical Representation)

**Files:**
- Modify: `/root/gatecontrol-config-hash/src/canonicalize.ts`
- Modify: `/root/gatecontrol-config-hash/tests/canonicalize.test.ts`

- [ ] **Step 1: Failing Tests ergänzen**

Append to `/root/gatecontrol-config-hash/tests/canonicalize.test.ts`:

```typescript
import { canonicalizeArray } from '../src/canonicalize';

describe('canonicalizeArray', () => {
  it('empty array', () => {
    expect(canonicalizeArray([])).toBe('[]');
  });

  it('sorts number array', () => {
    expect(canonicalizeArray([3, 1, 2])).toBe('[1,2,3]');
  });

  it('sorts string array lexicographically', () => {
    expect(canonicalizeArray(['banana', 'apple', 'cherry']))
      .toBe('["apple","banana","cherry"]');
  });

  it('sorts objects by canonical representation', () => {
    const input = [
      { id: 2, name: 'b' },
      { id: 1, name: 'a' }
    ];
    expect(canonicalizeArray(input)).toBe('[{"id":1,"name":"a"},{"id":2,"name":"b"}]');
  });

  it('same-content arrays produce same hash regardless of input order', () => {
    const a = [{ id: 2 }, { id: 1 }, { id: 3 }];
    const b = [{ id: 3 }, { id: 1 }, { id: 2 }];
    expect(canonicalizeArray(a)).toBe(canonicalizeArray(b));
  });

  it('sorts booleans (false before true)', () => {
    expect(canonicalizeArray([true, false, true])).toBe('[false,true,true]');
  });

  it('drops null elements before sorting', () => {
    expect(canonicalizeArray([1, null, 2])).toBe('[1,2]');
  });

  it('handles nested arrays recursively', () => {
    const input = [[2, 1], [4, 3]];
    expect(canonicalizeArray(input)).toBe('[[1,2],[3,4]]');
  });

  it('mixed primitives + objects', () => {
    const input: unknown[] = [{ a: 1 }, 5, 'x'];
    const out = canonicalizeArray(input);
    // sorted by canonical string: "x" < "{\"a\":1}" < 5? — compare UTF-16
    // "5" vs '"x"' vs '{"a":1}' — they must sort deterministically
    expect(out).toMatch(/^\[.+\]$/);
    // Verify determinism (same input, reshuffled)
    const reshuffled: unknown[] = ['x', { a: 1 }, 5];
    expect(canonicalizeArray(reshuffled)).toBe(out);
  });
});
```

- [ ] **Step 2: Test ausführen — muss failen**

```bash
npm test -- tests/canonicalize.test.ts
```

Expected: Tests failen mit `canonicalizeArray not yet implemented`.

- [ ] **Step 3: Implementation ergänzen**

Replace the `canonicalizeArray` stub in `/root/gatecontrol-config-hash/src/canonicalize.ts`:

```typescript
export function canonicalizeArray(a: unknown[]): string {
  const rendered: string[] = [];
  for (const item of a) {
    const r = canonicalizeValue(item);
    if (r === null) continue;
    rendered.push(r);
  }
  rendered.sort();
  return '[' + rendered.join(',') + ']';
}
```

- [ ] **Step 4: Test ausführen — muss grün sein**

```bash
npm test -- tests/canonicalize.test.ts
```

Expected: `27 passed`.

- [ ] **Step 5: Commit**

```bash
git add src/canonicalize.ts tests/canonicalize.test.ts
git commit -m "feat: add canonicalizeArray sorted by canonical representation"
git push
```

---

## Task 8: Public API (canonicalize + CONFIG_HASH_VERSION)

**Files:**
- Create: `/root/gatecontrol-config-hash/src/index.ts`
- Create: `/root/gatecontrol-config-hash/tests/api.test.ts`

- [ ] **Step 1: Failing Tests schreiben**

Create `/root/gatecontrol-config-hash/tests/api.test.ts`:

```typescript
import { canonicalize, CONFIG_HASH_VERSION } from '../src/index';

describe('public canonicalize API', () => {
  it('CONFIG_HASH_VERSION is 1', () => {
    expect(CONFIG_HASH_VERSION).toBe(1);
  });

  it('canonicalize on plain object', () => {
    expect(canonicalize({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
  });

  it('canonicalize on primitive top-level', () => {
    expect(canonicalize(42)).toBe('42');
  });

  it('canonicalize on null returns empty string', () => {
    expect(canonicalize(null)).toBe('');
  });

  it('canonicalize full config fixture', () => {
    const cfg = {
      peer_id: 3,
      routes: [
        { id: 2, domain: 'b.example', target_lan_host: '192.168.1.20' },
        { id: 1, domain: 'a.example', target_lan_host: '192.168.1.10' }
      ]
    };
    const out = canonicalize(cfg);
    expect(out).toBe(
      '{"peer_id":3,"routes":[' +
        '{"domain":"a.example","id":1,"target_lan_host":"192.168.1.10"},' +
        '{"domain":"b.example","id":2,"target_lan_host":"192.168.1.20"}' +
      ']}'
    );
  });
});
```

- [ ] **Step 2: Test ausführen — muss failen**

```bash
npm test -- tests/api.test.ts
```

Expected: Module not found.

- [ ] **Step 3: Implementation schreiben**

Create `/root/gatecontrol-config-hash/src/index.ts`:

```typescript
import { canonicalizeValue } from './canonicalize.js';

/**
 * Version of the canonicalization algorithm. Bumped on breaking changes.
 * Server includes this in config responses; Gateway with older version
 * treats hash as stale and performs full reload.
 */
export const CONFIG_HASH_VERSION = 1;

/**
 * Canonicalize a value to its deterministic JSON string representation.
 * For null/undefined top-level, returns empty string.
 */
export function canonicalize(value: unknown): string {
  const result = canonicalizeValue(value);
  return result === null ? '' : result;
}

export { canonicalizeValue } from './canonicalize.js';
export type { CanonJson } from './canonicalize.js';
```

- [ ] **Step 4: Test ausführen — muss grün sein**

```bash
npm test -- tests/api.test.ts
```

Expected: `5 passed`.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts tests/api.test.ts
git commit -m "feat: add public canonicalize API and CONFIG_HASH_VERSION constant"
git push
```

---

## Task 9: Hash-Funktion (SHA-256 mit sha256:-Prefix)

**Files:**
- Create: `/root/gatecontrol-config-hash/src/hash.ts`
- Modify: `/root/gatecontrol-config-hash/src/index.ts`
- Create: `/root/gatecontrol-config-hash/tests/hash.test.ts`

- [ ] **Step 1: Failing Tests schreiben**

Create `/root/gatecontrol-config-hash/tests/hash.test.ts`:

```typescript
import { computeHash } from '../src/index';

describe('computeHash', () => {
  it('returns sha256: prefixed 64-hex', () => {
    const out = computeHash({ a: 1 });
    expect(out).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('is deterministic for same input', () => {
    const cfg = { a: 1, b: [1, 2, 3] };
    expect(computeHash(cfg)).toBe(computeHash(cfg));
  });

  it('produces different hash for different inputs', () => {
    expect(computeHash({ a: 1 })).not.toBe(computeHash({ a: 2 }));
  });

  it('same content in different key order produces same hash', () => {
    expect(computeHash({ a: 1, b: 2 })).toBe(computeHash({ b: 2, a: 1 }));
  });

  it('same content in different array order produces same hash', () => {
    expect(computeHash({ xs: [3, 1, 2] })).toBe(computeHash({ xs: [1, 3, 2] }));
  });

  it('explicit null-value and missing-key produce same hash', () => {
    expect(computeHash({ a: 1, b: null })).toBe(computeHash({ a: 1 }));
  });

  it('known hash for empty object', () => {
    // sha256 of "{}" = 44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a
    expect(computeHash({})).toBe('sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a');
  });
});
```

- [ ] **Step 2: Test ausführen — muss failen**

```bash
npm test -- tests/hash.test.ts
```

Expected: `computeHash is not exported`.

- [ ] **Step 3: Hash-Implementation schreiben**

Create `/root/gatecontrol-config-hash/src/hash.ts`:

```typescript
import { createHash } from 'node:crypto';
import { canonicalize } from './index.js';

/**
 * Compute canonical hash of a value.
 * Returns "sha256:" + 64 hex chars.
 */
export function computeHash(value: unknown): string {
  const canonical = canonicalize(value);
  const digest = createHash('sha256').update(canonical, 'utf8').digest('hex');
  return `sha256:${digest}`;
}
```

- [ ] **Step 4: index.ts erweitern**

Append to `/root/gatecontrol-config-hash/src/index.ts`:

```typescript
export { computeHash } from './hash.js';
```

- [ ] **Step 5: Test ausführen — muss grün sein**

```bash
npm test -- tests/hash.test.ts
```

Expected: `7 passed`.

- [ ] **Step 6: Commit**

```bash
git add src/hash.ts src/index.ts tests/hash.test.ts
git commit -m "feat: add computeHash with sha256: prefix"
git push
```

---

## Task 10: Zod-Schema für Gateway-Config

**Files:**
- Create: `/root/gatecontrol-config-hash/src/schema.ts`
- Create: `/root/gatecontrol-config-hash/tests/schema.test.ts`

- [ ] **Step 1: Failing Tests schreiben**

Create `/root/gatecontrol-config-hash/tests/schema.test.ts`:

```typescript
import { GatewayConfigSchema } from '../src/schema';

describe('GatewayConfigSchema', () => {
  const valid = {
    config_hash_version: 1,
    peer_id: 3,
    routes: [
      {
        id: 1,
        domain: 'nas.example.com',
        target_kind: 'gateway',
        target_lan_host: '192.168.1.10',
        target_lan_port: 5001,
        protocol: 'http',
        wol_enabled: true,
        wol_mac: 'AA:BB:CC:DD:EE:FF'
      }
    ],
    l4_routes: [
      {
        id: 10,
        listen_port: 13389,
        target_lan_host: '192.168.1.30',
        target_lan_port: 3389
      }
    ]
  };

  it('accepts valid config', () => {
    expect(() => GatewayConfigSchema.parse(valid)).not.toThrow();
  });

  it('rejects missing peer_id', () => {
    const { peer_id: _, ...rest } = valid;
    expect(() => GatewayConfigSchema.parse(rest)).toThrow();
  });

  it('rejects invalid target_kind', () => {
    const bad = { ...valid, routes: [{ ...valid.routes[0], target_kind: 'unknown' }] };
    expect(() => GatewayConfigSchema.parse(bad)).toThrow();
  });

  it('rejects non-RFC1918 target_lan_host (allowed on gateway-side; schema does NOT enforce)', () => {
    // Schema only validates shape. RFC1918 check is runtime (in Gateway).
    const cfg = { ...valid, routes: [{ ...valid.routes[0], target_lan_host: '8.8.8.8' }] };
    expect(() => GatewayConfigSchema.parse(cfg)).not.toThrow();
  });

  it('strips unknown top-level keys', () => {
    const withExtra = { ...valid, unexpected_key: 'x' };
    const parsed = GatewayConfigSchema.parse(withExtra);
    expect('unexpected_key' in parsed).toBe(false);
  });

  it('strips unknown route keys', () => {
    const withExtra = {
      ...valid,
      routes: [{ ...valid.routes[0], extra: 'ignore' }]
    };
    const parsed = GatewayConfigSchema.parse(withExtra);
    expect('extra' in parsed.routes[0]).toBe(false);
  });

  it('wol_enabled defaults to false when omitted', () => {
    const { wol_enabled: _w, wol_mac: _m, ...route } = valid.routes[0];
    const cfg = { ...valid, routes: [route] };
    const parsed = GatewayConfigSchema.parse(cfg);
    expect(parsed.routes[0].wol_enabled).toBe(false);
  });

  it('config_hash_version must be integer >= 1', () => {
    expect(() => GatewayConfigSchema.parse({ ...valid, config_hash_version: 0 })).toThrow();
    expect(() => GatewayConfigSchema.parse({ ...valid, config_hash_version: 1.5 })).toThrow();
  });
});
```

- [ ] **Step 2: Test ausführen — muss failen**

```bash
npm test -- tests/schema.test.ts
```

Expected: Module not found.

- [ ] **Step 3: Schema-Implementation schreiben**

Create `/root/gatecontrol-config-hash/src/schema.ts`:

```typescript
import { z } from 'zod';

const MacAddress = z.string().regex(
  /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/,
  'must be colon-separated MAC address (AA:BB:CC:DD:EE:FF)'
);

const Port = z.number().int().min(1).max(65535);

const HttpRouteSchema = z.object({
  id: z.number().int().positive(),
  domain: z.string().min(1),
  target_kind: z.enum(['peer', 'gateway']),
  target_lan_host: z.string().min(1).nullish(),
  target_lan_port: Port.nullish(),
  protocol: z.enum(['http', 'https']).default('http'),
  wol_enabled: z.boolean().default(false),
  wol_mac: MacAddress.nullish()
}).strip();

const L4RouteSchema = z.object({
  id: z.number().int().positive(),
  listen_port: Port,
  target_lan_host: z.string().min(1),
  target_lan_port: Port,
  wol_enabled: z.boolean().default(false),
  wol_mac: MacAddress.nullish()
}).strip();

export const GatewayConfigSchema = z.object({
  config_hash_version: z.number().int().min(1),
  peer_id: z.number().int().positive(),
  routes: z.array(HttpRouteSchema).default([]),
  l4_routes: z.array(L4RouteSchema).default([])
}).strip();

export type GatewayConfig = z.infer<typeof GatewayConfigSchema>;
export type HttpRoute = z.infer<typeof HttpRouteSchema>;
export type L4Route = z.infer<typeof L4RouteSchema>;
```

- [ ] **Step 4: Schema aus index.ts exportieren**

Append to `/root/gatecontrol-config-hash/src/index.ts`:

```typescript
export { GatewayConfigSchema } from './schema.js';
export type { GatewayConfig, HttpRoute, L4Route } from './schema.js';
```

- [ ] **Step 5: Test ausführen — muss grün sein**

```bash
npm test -- tests/schema.test.ts
```

Expected: `8 passed`.

- [ ] **Step 6: Commit**

```bash
git add src/schema.ts src/index.ts tests/schema.test.ts
git commit -m "feat: add Zod GatewayConfigSchema with strip mode for unknown keys"
git push
```

---

## Task 11: `computeConfigHash` — validiert + hasht

**Files:**
- Modify: `/root/gatecontrol-config-hash/src/hash.ts`
- Modify: `/root/gatecontrol-config-hash/src/index.ts`
- Modify: `/root/gatecontrol-config-hash/tests/hash.test.ts`

- [ ] **Step 1: Failing Tests ergänzen**

Append to `/root/gatecontrol-config-hash/tests/hash.test.ts`:

```typescript
import { computeConfigHash } from '../src/index';

describe('computeConfigHash (schema + canonicalize + sha256)', () => {
  const baseConfig = {
    config_hash_version: 1,
    peer_id: 3,
    routes: [
      {
        id: 1,
        domain: 'nas.example.com',
        target_kind: 'gateway' as const,
        target_lan_host: '192.168.1.10',
        target_lan_port: 5001,
        wol_enabled: false
      }
    ],
    l4_routes: []
  };

  it('produces sha256: prefixed hash', () => {
    expect(computeConfigHash(baseConfig)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('is deterministic', () => {
    expect(computeConfigHash(baseConfig)).toBe(computeConfigHash(baseConfig));
  });

  it('throws on invalid config', () => {
    const bad = { ...baseConfig, peer_id: -1 };
    expect(() => computeConfigHash(bad)).toThrow();
  });

  it('strips unknown keys before hashing (stable hash with extras)', () => {
    const withExtra = { ...baseConfig, extra: 'ignored' };
    expect(computeConfigHash(withExtra as any)).toBe(computeConfigHash(baseConfig));
  });

  it('route shuffled produces same hash', () => {
    const a = {
      ...baseConfig,
      routes: [
        baseConfig.routes[0],
        { ...baseConfig.routes[0], id: 2, domain: 'plex.example.com' }
      ]
    };
    const b = { ...a, routes: [...a.routes].reverse() };
    expect(computeConfigHash(a)).toBe(computeConfigHash(b));
  });
});
```

- [ ] **Step 2: Test ausführen — muss failen**

```bash
npm test -- tests/hash.test.ts
```

Expected: `computeConfigHash is not exported`.

- [ ] **Step 3: Implementation ergänzen**

Append to `/root/gatecontrol-config-hash/src/hash.ts`:

```typescript
import { GatewayConfigSchema } from './schema.js';

/**
 * High-level wrapper: validates via Zod, canonicalizes, hashes.
 * Preferred entry point for Server and Gateway.
 */
export function computeConfigHash(rawConfig: unknown): string {
  const validated = GatewayConfigSchema.parse(rawConfig);
  return computeHash(validated);
}
```

Append to `/root/gatecontrol-config-hash/src/index.ts`:

```typescript
export { computeConfigHash } from './hash.js';
```

- [ ] **Step 4: Test ausführen — muss grün sein**

```bash
npm test -- tests/hash.test.ts
```

Expected: `12 passed` (7 vorher + 5 neue).

- [ ] **Step 5: Commit**

```bash
git add src/hash.ts src/index.ts tests/hash.test.ts
git commit -m "feat: add computeConfigHash wrapper (validate + canonicalize + sha256)"
git push
```

---

## Task 12: Contract-Test mit JSON-Fixtures

**Files:**
- Create: `/root/gatecontrol-config-hash/tests/fixtures/minimal.json`
- Create: `/root/gatecontrol-config-hash/tests/fixtures/single-http-route.json`
- Create: `/root/gatecontrol-config-hash/tests/fixtures/multi-routes.json`
- Create: `/root/gatecontrol-config-hash/tests/fixtures/mixed-l4-l7.json`
- Create: `/root/gatecontrol-config-hash/tests/fixtures/with-wol.json`
- Create: `/root/gatecontrol-config-hash/tests/fixtures/unicode-domain.json`
- Create: `/root/gatecontrol-config-hash/tests/fixtures/max-routes.json`
- Create: `/root/gatecontrol-config-hash/tests/fixtures/null-keys.json`
- Create: `/root/gatecontrol-config-hash/tests/fixtures/shuffled.json`
- Create: `/root/gatecontrol-config-hash/tests/fixtures/expected-hashes.json`
- Create: `/root/gatecontrol-config-hash/tests/contract.test.ts`

- [ ] **Step 1: Fixtures anlegen**

Create `/root/gatecontrol-config-hash/tests/fixtures/minimal.json`:

```json
{
  "config_hash_version": 1,
  "peer_id": 1,
  "routes": [],
  "l4_routes": []
}
```

Create `/root/gatecontrol-config-hash/tests/fixtures/single-http-route.json`:

```json
{
  "config_hash_version": 1,
  "peer_id": 3,
  "routes": [
    {
      "id": 1,
      "domain": "nas.example.com",
      "target_kind": "gateway",
      "target_lan_host": "192.168.1.10",
      "target_lan_port": 5001,
      "wol_enabled": false
    }
  ],
  "l4_routes": []
}
```

Create `/root/gatecontrol-config-hash/tests/fixtures/multi-routes.json`:

```json
{
  "config_hash_version": 1,
  "peer_id": 3,
  "routes": [
    {
      "id": 1,
      "domain": "a.example.com",
      "target_kind": "gateway",
      "target_lan_host": "192.168.1.10",
      "target_lan_port": 80,
      "wol_enabled": false
    },
    {
      "id": 2,
      "domain": "b.example.com",
      "target_kind": "gateway",
      "target_lan_host": "192.168.1.20",
      "target_lan_port": 8080,
      "wol_enabled": false
    },
    {
      "id": 3,
      "domain": "c.example.com",
      "target_kind": "gateway",
      "target_lan_host": "192.168.1.30",
      "target_lan_port": 443,
      "protocol": "https",
      "wol_enabled": false
    }
  ],
  "l4_routes": []
}
```

Create `/root/gatecontrol-config-hash/tests/fixtures/mixed-l4-l7.json`:

```json
{
  "config_hash_version": 1,
  "peer_id": 3,
  "routes": [
    {
      "id": 1,
      "domain": "nas.example.com",
      "target_kind": "gateway",
      "target_lan_host": "192.168.1.10",
      "target_lan_port": 5001,
      "wol_enabled": false
    }
  ],
  "l4_routes": [
    {
      "id": 10,
      "listen_port": 13389,
      "target_lan_host": "192.168.1.30",
      "target_lan_port": 3389,
      "wol_enabled": false
    },
    {
      "id": 11,
      "listen_port": 2222,
      "target_lan_host": "192.168.1.40",
      "target_lan_port": 22,
      "wol_enabled": false
    }
  ]
}
```

Create `/root/gatecontrol-config-hash/tests/fixtures/with-wol.json`:

```json
{
  "config_hash_version": 1,
  "peer_id": 3,
  "routes": [
    {
      "id": 1,
      "domain": "nas.example.com",
      "target_kind": "gateway",
      "target_lan_host": "192.168.1.10",
      "target_lan_port": 5001,
      "wol_enabled": true,
      "wol_mac": "AA:BB:CC:DD:EE:FF"
    }
  ],
  "l4_routes": [
    {
      "id": 10,
      "listen_port": 13389,
      "target_lan_host": "192.168.1.30",
      "target_lan_port": 3389,
      "wol_enabled": true,
      "wol_mac": "11:22:33:44:55:66"
    }
  ]
}
```

Create `/root/gatecontrol-config-hash/tests/fixtures/unicode-domain.json`:

```json
{
  "config_hash_version": 1,
  "peer_id": 3,
  "routes": [
    {
      "id": 1,
      "domain": "café.münchen.example",
      "target_kind": "gateway",
      "target_lan_host": "192.168.1.10",
      "target_lan_port": 443,
      "wol_enabled": false
    }
  ],
  "l4_routes": []
}
```

Create `/root/gatecontrol-config-hash/tests/fixtures/max-routes.json`:

```json
{
  "config_hash_version": 1,
  "peer_id": 3,
  "routes": [
    {"id":1,"domain":"r1.ex.com","target_kind":"gateway","target_lan_host":"192.168.1.1","target_lan_port":8081,"wol_enabled":false},
    {"id":2,"domain":"r2.ex.com","target_kind":"gateway","target_lan_host":"192.168.1.2","target_lan_port":8082,"wol_enabled":false},
    {"id":3,"domain":"r3.ex.com","target_kind":"gateway","target_lan_host":"192.168.1.3","target_lan_port":8083,"wol_enabled":false},
    {"id":4,"domain":"r4.ex.com","target_kind":"gateway","target_lan_host":"192.168.1.4","target_lan_port":8084,"wol_enabled":false},
    {"id":5,"domain":"r5.ex.com","target_kind":"gateway","target_lan_host":"192.168.1.5","target_lan_port":8085,"wol_enabled":false},
    {"id":6,"domain":"r6.ex.com","target_kind":"gateway","target_lan_host":"192.168.1.6","target_lan_port":8086,"wol_enabled":false},
    {"id":7,"domain":"r7.ex.com","target_kind":"gateway","target_lan_host":"192.168.1.7","target_lan_port":8087,"wol_enabled":false},
    {"id":8,"domain":"r8.ex.com","target_kind":"gateway","target_lan_host":"192.168.1.8","target_lan_port":8088,"wol_enabled":false},
    {"id":9,"domain":"r9.ex.com","target_kind":"gateway","target_lan_host":"192.168.1.9","target_lan_port":8089,"wol_enabled":false},
    {"id":10,"domain":"r10.ex.com","target_kind":"gateway","target_lan_host":"192.168.1.10","target_lan_port":8090,"wol_enabled":false}
  ],
  "l4_routes": []
}
```

Create `/root/gatecontrol-config-hash/tests/fixtures/null-keys.json`:

```json
{
  "config_hash_version": 1,
  "peer_id": 3,
  "routes": [
    {
      "id": 1,
      "domain": "nas.example.com",
      "target_kind": "gateway",
      "target_lan_host": "192.168.1.10",
      "target_lan_port": 5001,
      "wol_enabled": false,
      "wol_mac": null
    }
  ],
  "l4_routes": []
}
```

Create `/root/gatecontrol-config-hash/tests/fixtures/shuffled.json`:

```json
{
  "l4_routes": [],
  "routes": [
    {
      "wol_enabled": false,
      "target_lan_port": 5001,
      "target_lan_host": "192.168.1.10",
      "target_kind": "gateway",
      "domain": "nas.example.com",
      "id": 1
    }
  ],
  "peer_id": 3,
  "config_hash_version": 1
}
```

- [ ] **Step 2: Expected-Hashes-Datei vorerst leer anlegen**

Create `/root/gatecontrol-config-hash/tests/fixtures/expected-hashes.json`:

```json
{}
```

- [ ] **Step 3: Contract-Test schreiben (Teil 1 — Hash-Berechnung)**

Create `/root/gatecontrol-config-hash/tests/contract.test.ts`:

```typescript
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeConfigHash } from '../src/index';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, 'fixtures');
const EXPECTED_FILE = join(FIXTURES_DIR, 'expected-hashes.json');

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, name), 'utf8'));
}

function loadExpected(): Record<string, string> {
  return JSON.parse(readFileSync(EXPECTED_FILE, 'utf8'));
}

describe('contract: fixture → hash stability', () => {
  const fixtureFiles = readdirSync(FIXTURES_DIR)
    .filter(f => f.endsWith('.json') && f !== 'expected-hashes.json')
    .sort();

  const expected = loadExpected();

  it.each(fixtureFiles)('%s produces deterministic hash', (filename) => {
    const cfg = loadFixture(filename);
    const hash = computeConfigHash(cfg);
    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);

    // Deterministic: run twice, same result
    expect(computeConfigHash(cfg)).toBe(hash);

    // If recorded expected hash exists, it must match
    if (expected[filename]) {
      expect(hash).toBe(expected[filename]);
    }
  });

  it('shuffled.json produces same hash as single-http-route.json', () => {
    const a = loadFixture('single-http-route.json');
    const b = loadFixture('shuffled.json');
    expect(computeConfigHash(a)).toBe(computeConfigHash(b));
  });

  it('null-keys.json produces same hash as single-http-route.json (null-drop rule)', () => {
    const a = loadFixture('single-http-route.json');
    const b = loadFixture('null-keys.json');
    expect(computeConfigHash(a)).toBe(computeConfigHash(b));
  });

  // Eval helper (one-off): populate expected-hashes.json
  // To regenerate: `npm run test:update-hashes`
  const shouldUpdate = process.env.UPDATE_EXPECTED_HASHES === '1';
  if (shouldUpdate) {
    it('regenerates expected-hashes.json', () => {
      const next: Record<string, string> = {};
      for (const f of fixtureFiles) {
        next[f] = computeConfigHash(loadFixture(f));
      }
      writeFileSync(EXPECTED_FILE, JSON.stringify(next, null, 2) + '\n');
    });
  }
});
```

- [ ] **Step 4: Test erstmalig laufen lassen und expected-hashes.json befüllen**

```bash
cd /root/gatecontrol-config-hash && UPDATE_EXPECTED_HASHES=1 npm test -- tests/contract.test.ts
```

Expected: Tests laufen grün, `expected-hashes.json` wird mit Einträgen befüllt.

- [ ] **Step 5: Tests nochmal normal laufen lassen (ohne UPDATE-Flag) — Hashes müssen matchen**

```bash
npm test -- tests/contract.test.ts
```

Expected: Alle Tests grün, inkl. der Assertion-Checks gegen `expected-hashes.json`.

- [ ] **Step 6: package.json um `test:update-hashes`-Script erweitern**

Modify `/root/gatecontrol-config-hash/package.json` — ergänze im `scripts`-Block:

```json
    "test:update-hashes": "UPDATE_EXPECTED_HASHES=1 jest tests/contract.test.ts"
```

- [ ] **Step 7: Commit**

```bash
git add tests/fixtures/ tests/contract.test.ts package.json
git commit -m "test: add 9 contract fixtures with recorded expected hashes"
git push
```

---

## Task 13: Property-Based Tests (100 Permutationen pro Fixture)

**Files:**
- Create: `/root/gatecontrol-config-hash/tests/property.test.ts`

- [ ] **Step 1: Property-Test schreiben**

Create `/root/gatecontrol-config-hash/tests/property.test.ts`:

```typescript
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as fc from 'fast-check';
import { computeConfigHash } from '../src/index';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, 'fixtures');

type AnyObj = Record<string, unknown>;

function loadFixture(name: string): AnyObj {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, name), 'utf8'));
}

/**
 * Deeply shuffle a JSON value:
 * - Objects: shuffle key order (by constructing new object with keys in random order)
 * - Arrays: shuffle element positions
 * - Primitives: leave alone
 */
function deepShuffle<T>(v: T, rng: () => number): T {
  if (Array.isArray(v)) {
    const shuffled = [...v];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled.map(x => deepShuffle(x, rng)) as unknown as T;
  }
  if (v !== null && typeof v === 'object') {
    const obj = v as AnyObj;
    const keys = Object.keys(obj);
    // Fisher-Yates on keys
    for (let i = keys.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [keys[i], keys[j]] = [keys[j], keys[i]];
    }
    const out: AnyObj = {};
    for (const k of keys) out[k] = deepShuffle(obj[k], rng);
    return out as unknown as T;
  }
  return v;
}

function makeRng(seed: number): () => number {
  // xorshift32
  let x = seed | 0;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return ((x >>> 0) / 0x100000000);
  };
}

describe('property: hash is invariant under shuffling', () => {
  const fixtures = readdirSync(FIXTURES_DIR)
    .filter(f => f.endsWith('.json') && f !== 'expected-hashes.json');

  it.each(fixtures)('%s: 100 shuffled permutations produce same hash', (filename) => {
    const base = loadFixture(filename);
    const baseHash = computeConfigHash(base);

    fc.assert(
      fc.property(fc.integer({ min: 1, max: 0x7fffffff }), (seed) => {
        const shuffled = deepShuffle(base, makeRng(seed));
        expect(computeConfigHash(shuffled)).toBe(baseHash);
      }),
      { numRuns: 100 }
    );
  });
});
```

- [ ] **Step 2: Test ausführen — muss grün sein**

```bash
cd /root/gatecontrol-config-hash && npm test -- tests/property.test.ts
```

Expected: 9 Fixtures × 100 Permutations = 900 property-based Assertions, alle grün.

- [ ] **Step 3: Gesamt-Testlauf + Coverage**

```bash
npm run test:coverage
```

Expected: Alle Tests grün. Coverage ≥95% auf alle Metriken (muss sein — wir haben property-based Tests).

- [ ] **Step 4: Commit**

```bash
git add tests/property.test.ts
git commit -m "test: add property-based tests — 100 permutations per fixture invariance"
git push
```

---

## Task 14: Build prüfen + dist validieren

**Files:**
- Create: `/root/gatecontrol-config-hash/tests/integration/consumer.test.ts`

- [ ] **Step 1: Build ausführen**

```bash
cd /root/gatecontrol-config-hash && npm run build
```

Expected: `dist/` enthält `index.js`, `index.cjs`, `index.d.ts` und Source-Maps.

- [ ] **Step 2: Consumer-Test schreiben (importiert aus dist)**

Create `/root/gatecontrol-config-hash/tests/integration/consumer.test.ts`:

```typescript
// Deliberately imports from built dist, not from src — verifies the shipped artifact
import { computeConfigHash, canonicalize, CONFIG_HASH_VERSION, GatewayConfigSchema } from '../../dist/index.js';

describe('built package can be consumed', () => {
  it('exports CONFIG_HASH_VERSION', () => {
    expect(CONFIG_HASH_VERSION).toBe(1);
  });

  it('exports canonicalize', () => {
    expect(canonicalize({ a: 1, b: 2 })).toBe('{"a":1,"b":2}');
  });

  it('exports computeConfigHash', () => {
    const cfg = { config_hash_version: 1, peer_id: 1, routes: [], l4_routes: [] };
    expect(computeConfigHash(cfg)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('exports GatewayConfigSchema', () => {
    expect(typeof GatewayConfigSchema.parse).toBe('function');
  });
});
```

- [ ] **Step 3: Test ausführen**

```bash
npm test -- tests/integration/consumer.test.ts
```

Expected: `4 passed`.

- [ ] **Step 4: Commit**

```bash
git add tests/integration/consumer.test.ts
git commit -m "test: add integration test consuming built dist artifact"
git push
```

---

## Task 15: GitHub-Actions — Test-Workflow

**Files:**
- Create: `/root/gatecontrol-config-hash/.github/workflows/test.yml`

- [ ] **Step 1: Verzeichnis anlegen**

```bash
cd /root/gatecontrol-config-hash && mkdir -p .github/workflows
```

- [ ] **Step 2: Test-Workflow schreiben**

Create `/root/gatecontrol-config-hash/.github/workflows/test.yml`:

```yaml
name: Test

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node: [20, 22]
    steps:
      - uses: actions/checkout@v4

      - name: Setup Node ${{ matrix.node }}
        uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}
          cache: npm

      - name: Install deps
        run: npm ci

      - name: Lint (tsc --noEmit)
        run: npm run lint

      - name: Unit + Contract + Property tests
        run: npm run test:coverage

      - name: Build
        run: npm run build

      - name: Consumer-integration test
        run: npm test -- tests/integration/consumer.test.ts

      - name: Upload coverage
        if: matrix.node == '22'
        uses: actions/upload-artifact@v4
        with:
          name: coverage
          path: coverage/
```

- [ ] **Step 3: Workflow committen und pushen — muss in GitHub Actions grün durchlaufen**

```bash
git add .github/workflows/test.yml
git commit -m "ci: add test workflow matrix Node 20+22 with lint/build/coverage"
git push
```

- [ ] **Step 4: In GitHub-Actions-Tab prüfen dass der Workflow grün durchläuft**

```bash
# User-Aktion: https://github.com/CallMeTechie/gatecontrol-config-hash/actions öffnen
# Erwartet: beide Matrix-Jobs (node 20 + 22) grün
```

---

## Task 16: GitHub-Actions — Release-Workflow (npm publish auf Tag-Push)

**Files:**
- Create: `/root/gatecontrol-config-hash/.github/workflows/release.yml`

- [ ] **Step 1: Release-Workflow schreiben**

Create `/root/gatecontrol-config-hash/.github/workflows/release.yml`:

```yaml
name: Release

on:
  push:
    tags:
      - 'v*'

jobs:
  publish:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/checkout@v4

      - name: Setup Node 22 + GH Packages
        uses: actions/setup-node@v4
        with:
          node-version: 22
          registry-url: https://npm.pkg.github.com/
          scope: '@callmetechie'
          cache: npm

      - name: Install deps
        run: npm ci

      - name: Lint
        run: npm run lint

      - name: Tests
        run: npm test

      - name: Build
        run: npm run build

      - name: Verify package.json version matches tag
        run: |
          TAG_VERSION="${GITHUB_REF_NAME#v}"
          PKG_VERSION=$(node -p "require('./package.json').version")
          if [ "$TAG_VERSION" != "$PKG_VERSION" ]; then
            echo "::error::Tag version ($TAG_VERSION) != package.json version ($PKG_VERSION)"
            exit 1
          fi

      - name: Publish to GitHub Packages
        run: npm publish
        env:
          NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }}

      - name: Create GitHub Release
        uses: softprops/action-gh-release@v2
        with:
          generate_release_notes: true
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "ci: add release workflow — publish to GitHub Packages on v* tag"
git push
```

---

## Task 17: README mit Usage-Beispielen

**Files:**
- Modify: `/root/gatecontrol-config-hash/README.md`

- [ ] **Step 1: README erweitern**

Replace `/root/gatecontrol-config-hash/README.md`:

```markdown
# @callmetechie/gatecontrol-config-hash

Shared canonicalization and hashing library for GateControl Home Gateway configuration sync.

Implements [RFC 8785 (JSON Canonicalization Scheme)](https://www.rfc-editor.org/rfc/rfc8785) with project-specific extensions per the Home Gateway Companion design spec v1.2:

- Object keys sorted alphabetically (recursive)
- Arrays sorted by canonical string of their elements (recursive, lexicographic)
- `null`/`undefined` values dropped from objects and arrays
- Numbers without exponential notation, NaN/Infinity rejected
- Strings: escape only control chars (< U+0020) + `"` and `\`, UTF-8 passthrough
- Output: `sha256:` + 64 hex

## Installation

Requires a GitHub personal access token with `packages:read`:

```bash
# .npmrc
@callmetechie:registry=https://npm.pkg.github.com/
//npm.pkg.github.com/:_authToken=${GH_PACKAGES_TOKEN}
```

```bash
npm install @callmetechie/gatecontrol-config-hash
```

## Usage

```typescript
import { computeConfigHash, canonicalize, CONFIG_HASH_VERSION, GatewayConfigSchema }
  from '@callmetechie/gatecontrol-config-hash';

const config = {
  config_hash_version: CONFIG_HASH_VERSION,
  peer_id: 3,
  routes: [
    {
      id: 1,
      domain: 'nas.example.com',
      target_kind: 'gateway',
      target_lan_host: '192.168.1.10',
      target_lan_port: 5001,
      wol_enabled: false
    }
  ],
  l4_routes: []
};

// High-level: validate + canonicalize + hash (recommended)
const hash = computeConfigHash(config);
// → "sha256:a3f1..."

// Low-level: just canonicalize
const canonical = canonicalize(config);
// → '{"config_hash_version":1,"l4_routes":[],"peer_id":3,"routes":[...]}'

// Just schema validation
const validated = GatewayConfigSchema.parse(config);
```

## Guarantees

- **Byte-identical output** in Server (Node.js) and Gateway (Node.js) — Contract-Tests enforce this in both consumer repos.
- **Permutation-invariant**: same content in different object key order or array element order produces same hash.
- **Unknown-key-tolerant**: Zod schema uses `strip`, so unknown keys are silently ignored (schema-forward-compat).

## Algorithm Version

`CONFIG_HASH_VERSION` is currently `1`. On breaking changes (new canonicalization rule, new field included in hash), version bumps and consumers must be updated in lockstep.

## License

UNLICENSED / private. Not for public consumption.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: expand README with usage examples and algorithm guarantees"
git push
```

---

## Task 18: Release v1.0.0

**Files:**
- Modify: `/root/gatecontrol-config-hash/package.json`
- Create: `/root/gatecontrol-config-hash/CHANGELOG.md`

- [ ] **Step 1: CHANGELOG erstellen**

Create `/root/gatecontrol-config-hash/CHANGELOG.md`:

```markdown
# Changelog

## [1.0.0] — 2026-04-18

### Added
- Initial release: `canonicalize`, `computeHash`, `computeConfigHash`, `CONFIG_HASH_VERSION`, `GatewayConfigSchema`
- RFC 8785 JCS implementation with project-specific rules (drop-null, array-sort-by-canonical, no-exp-notation)
- Zod schema for Gateway config validation
- 9 contract-test fixtures with recorded expected hashes
- Property-based tests (100 permutations per fixture, fast-check)
- GitHub Actions test matrix (Node 20, 22) + release workflow (publish to GH Packages on tag)
```

- [ ] **Step 2: package.json version auf 1.0.0 setzen**

Modify `/root/gatecontrol-config-hash/package.json` — ersetze `"version": "0.0.0"` durch:

```json
  "version": "1.0.0",
```

- [ ] **Step 3: Commit + Tag**

```bash
cd /root/gatecontrol-config-hash
git add package.json CHANGELOG.md
git commit -m "chore: release 1.0.0"
git tag v1.0.0
git push origin main
git push origin v1.0.0
```

- [ ] **Step 4: Release-Workflow überwachen**

```bash
# User-Aktion: https://github.com/CallMeTechie/gatecontrol-config-hash/actions ansehen
# Erwartet: Release-Workflow läuft, npm publish erfolgt an GitHub Packages,
# GitHub Release wird automatisch erstellt
```

- [ ] **Step 5: Veröffentlichung verifizieren**

```bash
# User-Aktion: https://github.com/CallMeTechie/gatecontrol-config-hash/packages öffnen
# Erwartet: Paket @callmetechie/gatecontrol-config-hash@1.0.0 ist sichtbar
```

---

## Abschluss

Nach Task 18 ist Plan 1 abgeschlossen. Das Paket ist installierbar für Plan 2 (Server) und Plan 3 (Gateway) via:

```bash
npm install @callmetechie/gatecontrol-config-hash
```

**Als Nächstes:** Plan 2 — GateControl-Server-Änderungen schreiben (Migration, Services, API, Caddy, UI).
