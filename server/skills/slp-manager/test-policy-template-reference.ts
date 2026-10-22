// references/TEST_POLICY_TEMPLATE.md: the structure agents copy into .slp/standards/TEST_POLICY.md.
// The YAML block keys are a contract: later runtime guards will read heavy_resources from generated policies.
export const TEST_POLICY_TEMPLATE_REFERENCE = `# \`TEST_POLICY.md\` Template

Copy this structure to \`.slp/standards/TEST_POLICY.md\` and fill it with the evidence gathered in \`PROJECT_INVESTIGATION.md\`. Leads and peers read this file to decide which tests they may run where. The fenced \`yaml\` block is machine-readable so future runtime guards can read the heavy-resource list; keep its keys and fill every value with a measured number or \`UNVERIFIED\`.

\`\`\`\`markdown
# Test Policy

> Generated from the project investigation on <YYYY-MM-DD>. Re-run the investigation when the stack or test tooling changes.

## Machine-Readable Policy

\`\`\`yaml
host:
  ram_gb: 32                 # from \`free -g\`
  cpu_cores: 16              # from \`nproc\`
  reserved_headroom_gb: 8    # kept free for the desktop and the agent CLIs
tiers:
  fast:
    where: feature-pipelines
    commands:
      - id: logic-unit
        run: dotnet test Tests/Logic/Logic.Tests.csproj
        measured: { wall_seconds: 14, peak_rss_mb: 420, baseline: "212 passed, 0 failed" }
      - id: compile
        run: tools/bin/build --check
        measured: { wall_seconds: 35, peak_rss_mb: 900, baseline: "ok" }
  engine:
    where: integration-qa
    commands:
      - id: unity-editmode
        run: unity-editor -batchmode -projectPath . -runTests -testPlatform EditMode -testResults .slp-artifacts/editmode.xml
        resource: unity-editor
        measured: { wall_seconds: 240, peak_rss_mb: 3900, baseline: "88 passed, 2 failed (known: InventoryTests.Overflow)" }
  integration:
    where: integration-qa
    manual_procedure: "## Manual and Real-Environment Testing"   # section of this file
heavy_resources:
  - id: unity-editor
    process_signatures: ["Unity", "-projectPath"]
    peak_memory_gb: 4
    startup_seconds: 90
    max_concurrent: 1
    notes: "One editor per project folder; each worktree re-imports Library/ (~6 GB, ~8 min)."
\`\`\`

## Unit Test Conventions

- **Frameworks:** <framework + version, assertion and mocking libraries>
- **Location and naming:** <folders, mirroring rule, file suffix, test name style>
- **Structure:** <AAA / Given-When-Then / table-driven; fixtures, builders, seed data>
- **Isolation:** <how engine, network, filesystem, time, randomness are faked>
- **Reference tests:** <3–5 paths a peer should imitate>
- **Gaps:** <untestable areas and the extraction needed to make them \`fast\`-testable>

## Manual and Real-Environment Testing

- **Bring-up:** <build command> -> <run command>, required services in order, environment variable names, test accounts/seed data
- **Targets:** <devices, resolutions, browsers, OS versions>
- **Critical journeys:** for each journey: preconditions -> steps -> expected observable outcome
- **Evidence:** <screenshot/video/log/profiler capture method and output folder>

## Tier Rules

1. Feature pipelines (parallel worktrees) run only \`tiers.fast\` commands. A \`tier: feature\` peer that needs anything heavier records it as a hand-off item in \`slp_stage_report\`.
2. \`engine\` and \`integration\` tiers run only in the final QA pipeline on the merged integration branch, using at most \`max_concurrent\` instances of each heavy resource.
3. Never start a process matching a \`heavy_resources[].process_signatures\` entry outside the final QA pipeline, including indirectly through scripts, Makefiles or package scripts.

## Baseline and Known Issues

- <pre-existing failing or flaky tests with paths, so peers are not blamed for them>

## Unverified or Proposed Items

- <items marked UNVERIFIED or PROPOSED that the human must confirm>
\`\`\`\`
`;
