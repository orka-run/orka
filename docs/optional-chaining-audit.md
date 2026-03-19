# Optional Chaining Audit

Scope: `packages/dashboard/src/`

Method:
- Grep for `?.`, `?? []`, `?? {}`, `?? ""`, `as any`, and `as unknown`
- Compare dashboard-local DTOs against `@orka/core`
- Check current `eslint.config.mjs` and dashboard/root `tsconfig.json`

## Executive summary

I found one genuine production risk and one concrete test-only reproduction of the same bug pattern.

- Genuine bug pattern:
  - `packages/dashboard/src/stores/sessionStore.ts:71` uses `session.allowedActions ?? []` even though `@orka/core` declares `SessionListResponse.allowedActions` as required.
  - `packages/dashboard/src/components/ChatView.tsx:47` then consumes `session?.allowedActions ?? []`, which silently disables chat actions if the field goes missing upstream.
- Why this compiles:
  - The dashboard shadows core session DTOs with its own `SessionSummary` in `packages/dashboard/src/stores/sessionStore.ts:9-29`.
  - That local type widens `allowedActions` to `string[]` instead of `SessionAction[]`.
  - The dashboard package excludes `src/**/*.test.ts` from TypeScript checking, so invalid fixtures are not caught.
- Concrete proof:
  - `packages/dashboard/src/stores/sessionStore.test.ts:33-54` returns a `SessionListResponse` fixture with no `allowedActions`.
  - `toSessionSummary()` swallows the missing field via `?? []`, so the test still passes.

Bottom line: the main problem is not optional chaining by itself. It is type drift plus fallbacks that convert invalid DTOs into plausible UI state.

## 1. Optional chaining on properties that should not be optional

### Genuine issue

1. `packages/dashboard/src/components/ChatView.tsx:47`
   - Code: `session?.allowedActions ?? []`
   - Current local type: `SessionSummary["allowedActions"]` from `packages/dashboard/src/stores/sessionStore.ts:28`
   - Core contract: `SessionListResponse.allowedActions` is required in `packages/core/src/service.ts:59-78`
   - Why risky:
     - If the store or RPC layer drops `allowedActions`, the UI quietly behaves as if there are no actions.
     - That turns a broken contract into disabled input/controls instead of a visible failure.
   - Classification: genuine bug pattern

### Equivalent root cause in store mapping

1. `packages/dashboard/src/stores/sessionStore.ts:71`
   - Code: `allowedActions: session.allowedActions ?? []`
   - Input type: `session: SessionListResponse`
   - Core contract: `allowedActions` is required in `packages/core/src/service.ts:62`
   - Why risky:
     - This explicitly masks invalid RPC data.
     - If lint/type checking were fully effective here, this should be treated as unnecessary.
   - Classification: genuine bug pattern

### What I did not find

- I did not find any other production `?.missingProp` accesses against correctly imported `@orka/core` types.
- The main failure mode is the dashboard's local shadow type making bad accesses look legitimate.

## 2. `?? []`, `?? {}`, and `?? ""` fallbacks

### `?? []`

1. `packages/dashboard/src/components/ChatView.tsx:47`
   - `session?.allowedActions ?? []`
   - Classification: bug pattern, see above

2. `packages/dashboard/src/stores/sessionStore.ts:71`
   - `session.allowedActions ?? []`
   - Classification: bug pattern, see above

3. `packages/dashboard/src/stores/sessionStore.ts:186`
   - `request.tags ?? []`
   - `SpawnRequest.tags` is optional in core.
   - Classification: intentional fallback

4. `packages/dashboard/src/components/DiffPanel.tsx:102`
   - `checkpointsQuery.data ?? []`
   - React Query data is absent before load.
   - Classification: intentional loading fallback

5. `packages/dashboard/src/components/DiffPanel.tsx:761`
   - `checkpointFiles ?? []`
   - `Checkpoint["files"]` is nullable in core.
   - Classification: intentional fallback

### `?? {}`

1. `packages/dashboard/src/components/WorkspaceDetailView.tsx:31`
   - `workspace.settings?.defaults ?? {}`
   - `WorkspaceInfo.settings` is nullable and `defaults` is optional.
   - Classification: intentional fallback

2. `packages/dashboard/src/components/WorkspaceDetailView.tsx:35`
   - `workspace.settings?.defaults ?? {}`
   - Same rationale as above.
   - Classification: intentional fallback

### `?? ""`

I found 38 string fallbacks. Most are renderer/UI normalization rather than contract masking. The main groups are:

1. UI/loading defaults on optional query or state data
   - `packages/dashboard/src/App.tsx:89,98,188,707`
   - `packages/dashboard/src/components/LogPanel.tsx:94,135`
   - `packages/dashboard/src/components/DiffPanel.tsx:178,179,190`
   - `packages/dashboard/src/components/WorkspaceDetailView.tsx:95,108,120`
   - `packages/dashboard/src/components/ConnectionSettingsDialog.tsx:24,25,31,32`
   - `packages/dashboard/src/components/DraftChatView.tsx:52,57,61`
   - `packages/dashboard/src/components/ChatInputComposer.tsx:29`
   - `packages/dashboard/src/components/Sidebar.tsx:418`
   - Classification: mostly intentional

2. Renderer/text-normalization fallbacks
   - `packages/dashboard/src/components/ToolCallDetails.tsx:294,332,334,468,539,572`
   - `packages/dashboard/src/components/MarkdownContent.tsx:25`
   - `packages/dashboard/src/components/ComposerEditor.tsx:51,125,183,185`
   - `packages/dashboard/src/components/chat/eventsToEntries.ts:444,525,526,692`
   - Classification: intentional

Risk note:
- The only `?? ""` cases that touch authoritative RPC data are in `DiffPanel` and `LogPanel`.
- Those appear to be normal "not loaded yet" UI defaults, not schema-masking bugs, because the underlying core response fields are optional only through query state, not through the DTO shape itself.

## 3. `as any` / `as unknown` casts

All casts I found are test-only.

1. `packages/dashboard/src/lib/wsTransport.test.ts:40`
   - `as any` on the `onclose` event payload
   - Classification: intentional test shim, but unsafe

2. `packages/dashboard/src/lib/wsTransport.test.ts:75`
   - `MockWebSocket as unknown as typeof WebSocket`
   - Classification: intentional test shim, but bypasses assignability

3. `packages/dashboard/src/lib/wsTransport.test.ts:88`
   - `timer.id as unknown as ReturnType<typeof setTimeout>`
   - Classification: intentional test shim, but bypasses assignability

4. `packages/dashboard/src/lib/wsTransport.test.ts:89`
   - function cast `as unknown as typeof setTimeout`
   - Classification: intentional test shim, but bypasses assignability

5. `packages/dashboard/src/stores/sessionStore.test.ts:30`
   - `mock as unknown as RpcClient`
   - Classification: intentional test shim, but bypasses interface coverage

These are not production bugs, but they matter because the dashboard package excludes tests from TS type-checking. Combined with that exclusion, they allow invalid fixtures and mocks to drift away from real contracts.

## 4. Dashboard type drift vs `@orka/core`

### Genuine divergence

1. `packages/dashboard/src/stores/sessionStore.ts:9-29`
   - Defines a local `SessionSummary`
   - This shadows `@orka/core`'s `SessionSummary` in `packages/core/src/types.ts:135-143`
   - It does not actually model the same shape:
     - dashboard local type is closer to `SessionListResponse` plus `nodeId`
     - core `SessionSummary` is a smaller aggregation/cache shape

2. `packages/dashboard/src/stores/sessionStore.ts:28`
   - `allowedActions: string[]`
   - Core types use `SessionAction[]`:
     - `packages/core/src/service.ts:30`
     - `packages/core/src/service.ts:62`
     - `packages/core/src/types.ts:138`
   - Why risky:
     - any string becomes valid in dashboard code
     - invalid optimistic state such as a typo in an action name would compile

3. `packages/dashboard/src/stores/sessionStore.ts:188`
   - `allowedActions: ["sendTurn", "stop"]`
   - This is safe at runtime today, but it is not checked against `SessionAction[]` because the local type is only `string[]`.
   - Classification: type-safety gap

### Intentional overlap

1. `packages/dashboard/src/components/chat/eventsToEntries.ts:76`
   - Local `ChatEntry`
   - This intentionally differs from `@orka/core` `ChatEntry`; it is a dashboard-rendered timeline model, not the same DTO.
   - Classification: intentional

## 5. ESLint rules

Current config already enables several relevant rules in `eslint.config.mjs:13-46`:

- `@typescript-eslint/no-explicit-any`
- `@typescript-eslint/no-unnecessary-condition`
- `@typescript-eslint/no-unsafe-argument`
- `@typescript-eslint/no-unsafe-assignment`
- `@typescript-eslint/no-unsafe-call`
- `@typescript-eslint/no-unsafe-member-access`
- `@typescript-eslint/no-unsafe-return`
- `@typescript-eslint/consistent-type-assertions`

### Recommended additions / clarifications

1. Keep `@typescript-eslint/no-unnecessary-condition: "error"`
   - Official docs: <https://typescript-eslint.io/rules/no-unnecessary-condition/>
   - This rule explicitly flags unnecessary `?.` on non-nullable values and depends on real type information.

2. Add `@typescript-eslint/strict-boolean-expressions: "error"`
   - Official docs: <https://typescript-eslint.io/rules/strict-boolean-expressions/>
   - This does not directly catch `session?.allowedActions ?? []`, but it helps prevent adjacent "truthy/falsy means valid" patterns from creeping in.

3. Make `@typescript-eslint/no-unsafe-member-access` explicit with its default strict option
   - Official docs: <https://typescript-eslint.io/rules/no-unsafe-member-access/>
   - Recommended config:

```js
"@typescript-eslint/no-unsafe-member-access": ["error", { allowOptionalChaining: false }]
```

   - The rule docs specifically call out optional chaining on `any` as still unsafe.

4. Add `@typescript-eslint/no-unsafe-type-assertion: "error"`
   - Official docs: <https://typescript-eslint.io/rules/no-unsafe-type-assertion/>
   - This is the missing companion to the current cast rules and would make double assertions harder to justify.

5. Keep `@typescript-eslint/no-explicit-any: "error"`
   - Official docs: <https://typescript-eslint.io/rules/no-explicit-any/>
   - This remains the first defense against "property exists because the value became `any`".

### Suggested config block

```js
rules: {
  "@typescript-eslint/no-explicit-any": "error",
  "@typescript-eslint/no-unnecessary-condition": "error",
  "@typescript-eslint/strict-boolean-expressions": "error",
  "@typescript-eslint/no-unsafe-member-access": ["error", { allowOptionalChaining: false }],
  "@typescript-eslint/no-unsafe-type-assertion": "error",
  "@typescript-eslint/no-unsafe-assignment": "error",
  "@typescript-eslint/no-unsafe-call": "error",
  "@typescript-eslint/no-unsafe-return": "error",
}
```

Important limitation:
- These rules only help if ESLint is actually running with type information over the files in question.
- I could not verify local lint output in this worktree because `bunx eslint` failed to resolve `@eslint/js` in the current environment.

## 6. TSConfig recommendations

### `strictNullChecks`

- No change needed.
- The repo root already has `strict: true` in `tsconfig.json:8`, which implies `strictNullChecks`.
- TypeScript docs: <https://www.typescriptlang.org/tsconfig/strictNullChecks.html>

### `exactOptionalPropertyTypes`

- No change needed.
- Already enabled in `tsconfig.json:10`.
- TypeScript docs: <https://www.typescriptlang.org/tsconfig/exactOptionalPropertyTypes.html>

### `noUncheckedIndexedAccess`

- No change needed.
- Already enabled in `tsconfig.json:9`.
- TypeScript docs: <https://www.typescriptlang.org/tsconfig/noUncheckedIndexedAccess.html>

### `noPropertyAccessFromIndexSignature`

- No change needed.
- Already enabled in `tsconfig.json:11`.
- This helps prevent loose string-indexed objects from accepting fake dot-property access.
- TypeScript docs: <https://www.typescriptlang.org/tsconfig/noPropertyAccessFromIndexSignature.html>

### The actual missing guardrail

1. Stop excluding dashboard tests from TS checking
   - `packages/dashboard/tsconfig.json:16` excludes `src/**/*.test.ts`
   - That is why `packages/dashboard/src/stores/sessionStore.test.ts:33-54` can return a `SessionListResponse` without `allowedActions`.

2. Prefer deriving dashboard state from core DTOs instead of redefining them
   - Replace the local `SessionSummary` with either:
     - `type DashboardSessionSummary = SessionListResponse & { nodeId: string | null }`, or
     - an explicit `Pick<SessionListResponse, ...>` plus `nodeId`
   - Type `allowedActions` as `SessionAction[]`
   - Rename the local type so it does not shadow `@orka/core`'s `SessionSummary`

## 7. Recommended fixes

1. In `sessionStore.ts`, remove `?? []` from `session.allowedActions`
   - If the server violates the contract, fail loudly.

2. In `ChatView.tsx`, avoid defaulting missing `allowedActions` to `[]`
   - Prefer handling `session === null` separately, then use `session.allowedActions` directly.

3. Replace the dashboard-local `SessionSummary` with a type derived from `SessionListResponse`
   - Keep `nodeId` as the only dashboard-specific field.

4. Type-check dashboard tests
   - Either include `src/**/*.test.ts` in the dashboard package `tsconfig`, or add a dedicated `tsconfig.test.json` and run it in CI.

5. Add `@typescript-eslint/no-unsafe-type-assertion` and `@typescript-eslint/strict-boolean-expressions`

## Sources

- `@typescript-eslint/no-unnecessary-condition`: <https://typescript-eslint.io/rules/no-unnecessary-condition/>
- `@typescript-eslint/strict-boolean-expressions`: <https://typescript-eslint.io/rules/strict-boolean-expressions/>
- `@typescript-eslint/no-unsafe-member-access`: <https://typescript-eslint.io/rules/no-unsafe-member-access/>
- `@typescript-eslint/no-explicit-any`: <https://typescript-eslint.io/rules/no-explicit-any/>
- `@typescript-eslint/no-unsafe-type-assertion`: <https://typescript-eslint.io/rules/no-unsafe-type-assertion/>
- TypeScript `strictNullChecks`: <https://www.typescriptlang.org/tsconfig/strictNullChecks.html>
- TypeScript `exactOptionalPropertyTypes`: <https://www.typescriptlang.org/tsconfig/exactOptionalPropertyTypes.html>
- TypeScript `noUncheckedIndexedAccess`: <https://www.typescriptlang.org/tsconfig/noUncheckedIndexedAccess.html>
- TypeScript `noPropertyAccessFromIndexSignature`: <https://www.typescriptlang.org/tsconfig/noPropertyAccessFromIndexSignature.html>
