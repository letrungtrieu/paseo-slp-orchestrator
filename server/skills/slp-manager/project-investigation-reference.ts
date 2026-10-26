// references/PROJECT_INVESTIGATION.md: the mandatory six-phase investigation an agent runs before generating .slp peers.
// Kept separate from SKILL.md so the procedure loads only when peers are being generated, not on every skill trigger.
export const PROJECT_INVESTIGATION_REFERENCE = `# Project Investigation (Mandatory Before Generating \`.slp/peers\`)

Every project has its own stack, test conventions and manual-test practice. Peers generated from generic templates write tests the team does not use, run commands that do not exist, and launch heavy tools (game engines, emulators, container stacks) in every parallel worktree until the host runs out of memory. This investigation prevents that. Do all six phases, in order, before creating or regrouping any peer.

## Ground Rules

- **Evidence, not assumptions.** Every finding cites a file path, a config key, or a command you actually ran with its measured result. Mark anything you could not verify as \`UNVERIFIED\` and say why.
- **Read-only, except for test runs.** Do not edit source code during the investigation. Running the existing build/test commands to measure them is required.
- **One heavy process at a time.** When a command you are measuring launches a heavy tool, run it alone and never in parallel with another measurement.
- **Ask only what the repository cannot answer.** Manual-test practice, target devices and release criteria are often undocumented: ask the human short, concrete questions instead of inventing answers.
- **Never copy secret values** (tokens, passwords, keys) into \`.slp/\`; reference the variable name or the file that holds them.

---

## Phase 1: Tech Stack and Architecture Fingerprint

1. **Detect every stack present** (monorepos usually have several; record each package/app separately):

   | Signal files | Stack |
   |---|---|
   | \`ProjectSettings/ProjectVersion.txt\`, \`Assets/\`, \`Packages/manifest.json\`, \`*.asmdef\` | Unity (record the editor version) |
   | \`*.uproject\`, \`Source/*.Build.cs\` | Unreal Engine |
   | \`project.godot\` | Godot |
   | \`package.json\` + lockfile (\`package-lock.json\`, \`pnpm-lock.yaml\`, \`yarn.lock\`, \`bun.lockb\`) | Node/TypeScript (read dependencies for React, Vue, Next, Vite, Electron, React Native, Expo, NestJS, ...) |
   | \`pyproject.toml\`, \`requirements*.txt\`, \`setup.cfg\`, \`Pipfile\` | Python |
   | \`pom.xml\`, \`build.gradle(.kts)\`, \`settings.gradle\` | JVM (look for \`com.android.application\` to detect Android) |
   | \`*.xcodeproj\`, \`*.xcworkspace\`, \`Package.swift\`, \`Podfile\` | Apple platforms |
   | \`pubspec.yaml\` | Flutter/Dart |
   | \`*.sln\`, \`*.csproj\` (outside a Unity project) | .NET |
   | \`go.mod\` / \`Cargo.toml\` / \`CMakeLists.txt\`, \`Makefile\` | Go / Rust / C, C++ |
   | \`Dockerfile\`, \`docker-compose*.yml\`, \`compose*.yaml\`, \`k8s/\`, \`*.tf\` | Containers and infrastructure |
   | \`*.ipynb\`, ML dependencies (\`torch\`, \`tensorflow\`, \`jax\`) | Data / ML |

2. **Read the intent documents:** README, CONTRIBUTING, \`docs/\`, specs (PRD, GDD, RFC, ADR). Note the product domain and the module boundaries they describe.
3. **Read the CI configuration first when it exists** (\`.github/workflows/\`, \`.gitlab-ci.yml\`, \`Jenkinsfile\`, \`azure-pipelines.yml\`, \`bitbucket-pipelines.yml\`, \`.circleci/\`). CI is the most reliable record of how the project is really built and tested: exact commands, required services, environment variables, and which jobs are slow or heavy.
4. **Map engine/framework-dependent code versus pure logic.** This decides how much can be tested cheaply. Examples: Unity assemblies with \`"noEngineReferences": true\` versus MonoBehaviour code; framework-free TypeScript modules versus UI components; domain services versus HTTP controllers.
5. **Check local project tooling** (\`tools/bin/\`, \`scripts/\`, \`Makefile\` targets, \`package.json\` scripts). Prefer the project's own commands over raw tool invocations.

## Phase 2: How Unit Tests Are Written and Run

1. **Locate existing tests and their frameworks.** Typical patterns: \`tests/\`, \`__tests__/\`, \`*.test.ts\`, \`*.spec.ts\`, \`test_*.py\`, \`*_test.go\`, \`src/test/java\`, \`*.Tests.csproj\`, Unity test assemblies (\`Assets/**/Tests/*.asmdef\` referencing \`UnityEngine.TestRunner\`, EditMode vs PlayMode \`includePlatforms\`).
2. **Extract the conventions from 3–5 representative tests** and record them concretely:
   - file location and naming (mirrored folders? suffix?), test naming style;
   - structure (Arrange-Act-Assert, Given-When-Then, table-driven);
   - fixtures, factories, builders, seed data;
   - mocking/stubbing library and how engine, network, filesystem, time and randomness are isolated;
   - assertion library, snapshot usage, async patterns.
3. **Find the exact commands** (CI steps, scripts, Makefile, \`tools/bin\`) and **run each one, alone**, measuring:
   - wall time and peak memory, for example \`/usr/bin/time -v <command>\` ("Elapsed (wall clock) time", "Maximum resident set size");
   - which processes it starts. Watch \`ps\`/\`top\` while it runs: does it launch an engine editor, emulator, simulator, browser, container or GPU job?
   - pass/fail/skip counts. Record the **baseline failures** so later peers are not blamed for pre-existing breakage.
4. **Classify by resource cost, not by name.** A Unity EditMode "unit test" runs \`Unity -batchmode -runTests\` and costs several GB, so it is an \`engine\` tier command, not \`fast\`. Note the cheap alternative if one exists (for example \`dotnet test\` over pure C# assemblies).
5. **If the project has no tests**, record that fact, propose the framework and conventions that fit the stack (see \`STACK_PLAYBOOKS.md\`), mark them \`PROPOSED (not yet verified)\`, and list them for the human to confirm.

## Phase 3: How Manual and Real-Environment Testing Is Done

1. **Search for existing QA material:** \`docs/qa\`, test plans, release or smoke checklists, playtest notes, bug/issue templates (\`.github/ISSUE_TEMPLATE\`), Storybook stories, demo or debug scenes, cheat/debug menus, seed-data scripts, API collections (Postman, Bruno, \`.http\` files), E2E folders (Playwright, Cypress, Detox, Appium, Maestro, Unity PlayMode, AltTester, GameDriver).
2. **Record how to bring up the real environment:** build command, run command, required services and their start order, environment variables (names only), test accounts and seed data, target devices, resolutions or browsers, and expected startup time and memory.
3. **Record how evidence is captured:** screenshots, video, logs, profiler captures, crash dumps, and where the project expects them.
4. **List the critical user journeys / gameplay loops** that must be verified on the merged build, each with preconditions, steps and expected observable outcome.
5. **If this is undocumented, ask the human** (keep it short and concrete), for example: "Which flows do you check by hand before a release?", "On which devices/resolutions?", "What counts as a pass?". Do not invent a manual-test process.

## Phase 4: Heavy Resource Inventory

1. **List every tool that is expensive to run:** engine editors, emulators/simulators, container stacks, browsers for E2E, GPU or ML jobs, large native builds.
2. **For each one record:** an \`id\`, how it is launched, its **process signatures** (executable names and distinctive command-line flags), measured or estimated peak memory, startup time, and whether parallel instances conflict (for example one Unity editor per project folder, and each Git worktree needs its own \`Library/\` import).
3. **Record the host budget:** total RAM and CPU cores (\`free -g\`, \`nproc\`), memory to keep free for the desktop and the agent CLIs (each agent process typically uses 0.5–1 GB), and the resulting safe \`max_concurrent\` per resource. Default to \`1\` for anything above about 2 GB.

## Phase 5: Classify Into Tiers and Write \`TEST_POLICY.md\`

| Tier | Definition | Where it runs |
|---|---|---|
| \`fast\` | Starts no heavy resource; fits a small memory budget (about 1–2 GB) and finishes in minutes | Inside every parallel feature pipeline |
| \`engine\` | Automated, but needs a heavy resource (engine batch mode, emulator, container stack, browser E2E) | Final QA pipeline only, one heavy resource at a time |
| \`integration\` | Real-environment manual, exploratory, performance or E2E verification of the merged build | Final QA pipeline only, one heavy resource at a time |

Write \`.slp/standards/TEST_POLICY.md\` from \`TEST_POLICY_TEMPLATE.md\`. Every \`fast\` command must have been run in Phase 2 with its measurements. Every heavy resource must list process signatures. When a command is ambiguous, choose the more expensive tier.

## Phase 6: Derive the Peers From the Findings

The engine runs every feature as \`[planning with advisors]? -> implement with one developer\` and grades the merged build in the QA pipeline. Derive the peers to fit that shape:

1. **Developers (\`kind: developer\`, \`tier: feature\`):** one per stack area with distinct conventions (for example gameplay logic versus UI, backend versus frontend). Only one developer works in a pipeline, so each developer must be able to deliver a whole feature slice in its area. Their workflows cite the exact \`fast\` commands, test folders, naming and mocking approach from \`TEST_POLICY.md\`, and list work needing a heavy resource as a hand-off in \`slp_stage_report\`.
2. **Advisors (\`kind: advisor\`, \`tier: feature\`):** only for concerns that need a design decision before coding (architecture, a hard algorithm, security, UX fidelity). One or two are usually enough. They recommend, they never write.
3. **QA graders (\`kind: qa\`, \`tier: integration\`):** an automation grader that runs the \`engine\`/\`integration\` suites on the merged build, and a real-environment grader that follows the Phase 3 bring-up procedure and critical journeys and captures the recorded evidence types. Add performance, security or device-compatibility graders only when the project has budgets or risks for them. Graders report a scorecard per criterion; they do not fix.
4. **Do not create peers for stacks that are not present,** and merge roles that would have almost no distinct work. Do not add a code-review peer to the build stage; code is checked by the QA graders against the brief.
5. **Report a summary to the human:** detected stacks, tier table, heavy resources with \`max_concurrent\`, generated peers with their \`kind\` and \`tier\`, and every \`UNVERIFIED\`/\`PROPOSED\` item that needs confirmation.

## Done Checklist

- [ ] Every stack and app in the repository is listed with versions and evidence paths.
- [ ] Unit-test conventions are extracted from real tests (or explicitly \`PROPOSED\` when none exist).
- [ ] Every \`fast\` command was run alone, with wall time, peak memory and baseline results recorded.
- [ ] The manual-test procedure and critical journeys come from project material or from the human, not from invention.
- [ ] Every heavy resource has process signatures, peak memory and \`max_concurrent\`.
- [ ] \`.slp/standards/TEST_POLICY.md\` exists and every generated peer declares \`kind\` and a matching \`tier\` and cites its exact commands.
- [ ] The catalog has a developer for every stack area features will touch and at least one \`qa\` grader.
`;
