# Pull Request Merge Gate

Every Pactum pull request must satisfy this gate before merge.

1. Check all PR review comments and inline review threads.
2. Validate every comment against the exact current PR head; do not apply stale feedback blindly.
3. Address every actionable finding with code, tests, documentation, or an explicit technical rationale as appropriate.
4. Resolve every addressed review thread.
5. Run and verify CI on the exact head SHA that will be merged. Required checks include:
   - formatting and Clippy
   - Rust and JavaScript unit tests
   - Anchor production and test-hook builds
   - fuzz/property suites when present
   - Surfpool/mainnet-fork integration tests
   - DFlow CPI tests
   - compute-unit / fee regression checks
   - program bytecode size budgets when present
6. Do not merge while any required CI check is red or pending, or while actionable review feedback remains unresolved.
7. Merge only with GitHub's expected-head-SHA guard so a moved head cannot be merged accidentally.
8. After merge, verify the fresh `main` workflow. A green PR workflow is not sufficient if the merge commit changes the tested tree.

## Operational rule

If new commits are pushed after review or CI validation, restart the gate from step 1 against the new head SHA.

The merge decision must always name the validated head SHA.
