# Bun Publish

Description: Best practices for publishing packages using Bun.

## Usage

Use this skill when the user asks to publish the package or release a new version.

## Instructions

1.  **Pre-flight Check**: Ensure the project builds (`bun run build`) and tests pass (`bun test`).
2.  **Authentication Requirement**:
    *   **CRITICAL**: `bun publish` requires authentication with the registry (npm).
    *   **Action**: Before running `bun publish`, explicitly ask the user: "Are you authenticated with npm/bun registry?"
    *   **Authentication Method**: If the user needs to authenticate, advise them to run `npm login` in their terminal. This stores the necessary credentials in `~/.npmrc` which Bun will utilize.
    *   If the user says "no" or is unsure, explain that running `bun publish` will likely trigger an interactive browser-based login flow which they must complete.
3.  **Versioning**: Ensure the version in `package.json` is bumped correctly.
4.  **Execution**: Run `bun publish`.
