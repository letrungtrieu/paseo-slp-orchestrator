// references/STACK_PLAYBOOKS.md: per-stack hints on where fast, engine and integration tests usually live.
// Hints only guide the investigation; measured commands from the real repository always override them.
export const STACK_PLAYBOOKS_REFERENCE = `# Stack Playbooks (Starting Points, Not Answers)

Use these only to know **what to look for** during \`PROJECT_INVESTIGATION.md\`. The project's own CI, scripts and existing tests always win over this file. Every command below must be confirmed and measured in the actual repository before it goes into \`TEST_POLICY.md\`.

## Game Engines

### Unity
- **Fast:** pure C# logic in assemblies with \`"noEngineReferences": true\`, tested by a plain .NET test project (NUnit/xUnit) through \`dotnet test\` without opening the editor. If no such assemblies exist, record the gap and propose extracting game rules (combat math, inventory, economy, state machines) into them.
- **Engine:** Unity Test Framework EditMode/PlayMode via \`-batchmode -runTests -testPlatform EditMode|PlayMode -testResults <file>\` (do not add \`-quit\` together with \`-runTests\`). Each run opens a full editor (often 3–5 GB).
- **Integration:** a player build or Play Mode session driven by the project's automation (PlayMode tests, AltTester, GameDriver, debug/cheat menus), screenshots via \`ScreenCapture.CaptureScreenshot\` or the window, and the gameplay loops from the GDD or playtest notes.
- **Heavy signatures:** \`Unity\`, \`Unity.exe\`, \`-projectPath\`, helper processes \`UnityShaderCompiler\`, \`bee_backend\`, \`Unity.ILPP.Runner\`. One editor per project folder; every Git worktree imports its own \`Library/\`.
- **Typical peers:** \`gameplay-engineer\` and \`ui-engineer\` (feature), \`code-reviewer\` (feature, advisor), \`unity-test-automation\` and \`playtester\` (integration).

### Unreal Engine
- **Fast:** standalone C++ modules tested with GoogleTest/Catch2 when the project has them; otherwise only static checks.
- **Engine:** \`UnrealEditor-Cmd <Project>.uproject -ExecCmds="Automation RunTests <filter>; Quit" -unattended -nullrhi -nosplash\`.
- **Integration:** packaged build plus Gauntlet or manual playtest scripts.
- **Heavy signatures:** \`UnrealEditor\`, \`UnrealEditor-Cmd\`, \`ShaderCompileWorker\`, \`UnrealBuildTool\`.

### Godot
- **Fast or engine (measure it):** GUT or gdUnit4 through \`godot --headless\`; a headless run can be cheap enough for \`fast\`, but classify it by measured memory.
- **Heavy signatures:** \`godot\`, \`Godot_v*\`.

## Web and Services

### Web Frontend (React, Vue, Svelte, Angular, Next, Vite)
- **Fast:** Vitest/Jest with jsdom or happy-dom, Testing Library, type checking, linting.
- **Engine:** Playwright/Cypress E2E, Storybook test runner, visual regression. Each browser worker costs hundreds of MB; cap workers in the command itself.
- **Integration:** run the app against realistic data, walk critical journeys in a real browser, capture screenshots at the target breakpoints.
- **Heavy signatures:** \`chrome\`, \`chromium\`, \`headless_shell\`, \`firefox\`, \`msedge\`, \`playwright\`, \`cypress\`, plus the dev server if it spawns a full stack.

### Backend and Microservices (Node, Python, Go, JVM, .NET)
- **Fast:** unit tests with in-memory fakes or mocks for databases, queues and external APIs.
- **Engine:** integration tests that need real services through \`docker compose\` or Testcontainers. Containers run under the Docker daemon, so record compose project names and container labels as signatures too.
- **Integration:** full stack up, API collections (Postman, Bruno, \`.http\` files), contract and smoke checks, log and metric evidence.
- **Heavy signatures:** \`docker compose up\`, \`docker-compose\`, \`testcontainers\`, database or broker images (\`postgres\`, \`mysql\`, \`redis\`, \`kafka\`, \`elasticsearch\`).

### Desktop (Electron, Tauri)
- **Fast:** unit tests of main-process and renderer logic.
- **Engine:** Playwright for Electron, WebDriver-based app tests. **Heavy signatures:** \`electron\`, the packaged app binary.

## Mobile

### Android (Kotlin/Java)
- **Fast:** JVM unit tests (\`./gradlew test<Variant>UnitTest\`, Robolectric). Measure them: a Gradle daemon per worktree can itself cost 1–3 GB, so record its settings (\`org.gradle.jvmargs\`, \`org.gradle.workers.max\`, \`--no-daemon\`).
- **Engine:** instrumented tests on an emulator (\`connectedAndroidTest\`), Espresso, Maestro.
- **Integration:** install the build on an emulator or device, walk journeys, capture \`adb exec-out screencap -p\`.
- **Heavy signatures:** \`qemu-system-*\`, \`emulator\`, \`GradleDaemon\`, \`java ... GradleWorkerMain\`.

### iOS (Swift)
- **Fast:** \`swift test\` for Swift packages and logic targets that need no simulator.
- **Engine:** \`xcodebuild test -destination 'platform=iOS Simulator,...'\`, XCUITest. **Heavy signatures:** \`Simulator\`, \`launchd_sim\`, \`xcodebuild\`.

### Flutter / React Native
- **Fast:** \`flutter test\` (Dart VM, no device) / Jest for React Native.
- **Engine:** \`flutter test integration_test\`, Patrol, Detox or Maestro on an emulator or simulator.
- **Heavy signatures:** the emulator or simulator processes above, plus \`flutter_tester\` when measured as heavy.

## Data, ML and Embedded

### Data / ML
- **Fast:** unit tests on tiny fixtures on CPU, schema and data-contract checks.
- **Engine:** training or inference jobs on GPU, large dataset loads. Set \`max_concurrent\` from VRAM as well as RAM.
- **Heavy signatures:** the training or serving entry points, \`nvidia-smi\`-visible processes, Jupyter kernels running jobs.

### Embedded / Firmware
- **Fast:** host-side unit tests (Unity/CMock, GoogleTest) of hardware-independent code.
- **Engine:** QEMU or hardware-in-the-loop runs. **Heavy signatures:** \`qemu-system-*\`, flashing and debug probes (\`openocd\`, \`JLinkGDBServer\`).
`;
