---
description: Comprehensive code review, cleanup, and optimization pass
---

# Comprehensive Code Review & Optimization

Perform an in-depth analysis and cleanup of the codebase. This is a multi-phase review process.

---

## Phase 1: Dead Code & Unused Dependencies

### 1.1 Unused Imports & Exports
- Scan all TypeScript/JavaScript files for unused imports
- Identify exports that are never imported elsewhere
- Check for commented-out code blocks that should be removed
- Look for TODO/FIXME comments that reference completed or abandoned work

### 1.2 Orphaned Files
- Find files that are not imported or referenced anywhere
- Identify test files for components/modules that no longer exist
- Look for duplicate or near-duplicate files (copy-paste remnants)

### 1.3 Unused Dependencies
- Check `package.json` for dependencies not used in any source file
- Identify devDependencies that could be pruned
- Look for deprecated packages that should be replaced

### 1.4 Dead Feature Flags & Config
- Find feature flags or config options that are always true/false
- Identify environment variables that are defined but never read

---

## Phase 2: Code Quality & Patterns

### 2.1 Inconsistent Patterns
- Check for mixed async patterns (callbacks vs promises vs async/await)
- Look for inconsistent error handling approaches
- Identify places where newer patterns should replace legacy code
- Find duplicate logic that could be consolidated into utilities

### 2.2 Type Safety (TypeScript)
- Look for excessive use of `any` types
- Find places where types could be narrowed or made more specific
- Check for missing return types on functions
- Identify interfaces/types that are defined but never used

### 2.3 React-Specific (if applicable)
- Find components with redundant re-renders (missing memoization)
- Look for useEffect dependencies that are incorrect or missing
- Check for prop drilling that could use context
- Identify large components that should be split

### 2.4 ESP32/Arduino (if applicable)
- Check for unused #define macros
- Look for commented-out sensor code or features
- Find duplicate initialization logic
- Identify magic numbers that should be constants

---

## Phase 3: Performance Optimization

### 3.1 Bundle Size
- Identify large imports that could be tree-shaken
- Look for heavy dependencies with lighter alternatives
- Check for dynamic imports that could be added for code splitting

### 3.2 Runtime Performance
- Find expensive operations in render paths
- Look for missing caching opportunities (useMemo, useCallback)
- Identify repeated calculations that could be memoized
- Check for n+1 query patterns or redundant API calls

### 3.3 Memory Leaks
- Look for event listeners not being cleaned up
- Find subscriptions without unsubscribe logic
- Check for intervals/timeouts not being cleared
- Identify refs holding onto stale data

---

## Phase 4: Architecture & Organization

### 4.1 File/Folder Structure
- Identify misplaced files (wrong directory for their purpose)
- Look for circular dependencies
- Check barrel exports (index.ts) for completeness
- Find opportunities to consolidate related modules

### 4.2 API/Interface Consistency
- Check for inconsistent naming conventions
- Look for similar functions with different signatures
- Identify opportunities to unify related interfaces

---

## Phase 5: Documentation & Maintainability

### 5.1 Missing Documentation
- Find public APIs/functions without JSDoc comments
- Look for complex logic blocks without explanatory comments
- Check for outdated comments that no longer match the code

### 5.2 Test Coverage Gaps
- Identify critical paths without test coverage
- Find tests that are skipped or commented out
- Look for test files that test deleted functionality

---

## Output Format

After completing the review, provide:

1. **Summary Dashboard** - Quick stats on issues found per category
2. **Critical Issues** - Things that could cause bugs or major problems
3. **Recommended Removals** - Dead code safe to delete
4. **Optimization Opportunities** - Performance improvements ranked by impact
5. **Technical Debt** - Items to address in future iterations
6. **Action Plan** - Prioritized list of changes to make

For each finding, include:
- File path and line numbers
- Severity (Critical / High / Medium / Low)
- Effort estimate (Quick fix / Moderate / Significant)
- Recommendation with code sample if applicable

---

## Execution Notes

- Start with Phase 1 (dead code) as it's the lowest-risk cleanup
- Get user approval before making bulk deletions
- Create a backup branch before major changes
- Run tests after each phase to catch regressions
- Document any breaking changes

