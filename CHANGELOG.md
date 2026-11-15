# Change Log

## [1.3.0] - 2026-11-15

### Features
- **Query Runner** — The saved query dropdown is now searchable. Type to filter saved queries as the library grows; press Enter or click a match to select it.
- **Apex Debug Log Viewer** — new dedicated tool for inspecting Apex debug logs with call stack tree, virtualized log lines, filter chips, namespace filtering, and global search.
- Source navigation — class and method names are colored and **Ctrl+clickable** to open the source class at line when source is available.
- Added `salesforceAssistBuddy.apexDebugLogViewer.sourcePath` setting (default: `<workspace>/force-app/main/default/classes`) to configure the Apex source folder.
- Source scanning runs asynchronously and does not block log rendering.
- **Show Raw Log** — opens the current log as a file in the VS Code editor.
- Added `salesforceAssistBuddy.logViewer.defaultOpenIn` setting (`editor` | `apexDebugLogViewer`, default: `editor`) to configure where a downloaded log opens when clicked — either the default VS Code editor or the Apex Debug Log Viewer.
- **Dark/Light mode toggle** — Added `salesforceAssistBuddy.apexDebugLogViewer.theme` setting (`system` | `light` | `dark`, default: `system`) for the Apex Debug Log Viewer. An explicit toggle button in the viewer header lets users switch between system (OS-based), light, and dark modes independent of the OS theme.
- Added `salesforceAssistBuddy.apexDebug.sfCliPath` setting — full path to the Salesforce CLI executable (`sf`/`sfdx`). Leave empty to auto-detect from workspace `node_modules/.bin`, PATH, login shell, or well-known install locations.
- Added `salesforceAssistBuddy.apexDebug.targetOrg` setting — optional target org username or alias (`--target-org`) for CLI commands.

### Removed
- **Log Details** — Removed the `showLogDetails` command, editor title-bar entry, `detailsView` identity, docs page, and implementation files (`ApexLogDetails.*`). `docs/log-details.md` deleted.

### Fixed
- **Apex Debug Log Viewer color picker** — Clicking the colored dot now opens the native color picker at the dot position instead of the top-left corner of the screen. The hidden color input overlays the dot via absolute positioning with `opacity: 0`.
- **Apex Debug Log Viewer multi-line log filtering** — Continuation lines (no timestamp, e.g. JSON payloads in `USER_DEBUG` statements) now inherit the event type (`ev`), timestamp (`ts`), namespace (`ns`), and depth from the preceding log line. Filtering on any event type via Log Tags hides the entire multi-line statement together with its parent line.
- **Apex Debug Log Viewer Log Tags modal** — Added an **Apply** button. Checkbox toggles, Show All, and Hide All no longer apply filtering immediately; clicking Apply applies the filter, updates highlight counts, and closes the modal.
- **Apex Debug Log Viewer core rendering** — Aligned rendering with parserTool: replaced `renderRestWithSource()` with `applyHl(stripSids(ll.rest))`, removed the hover source button, removed ctrl+click handlers from tree node click events, and removed the extra `requestAnimationFrame` scroller refresh from `renderLogView`.
- **Apex Debug Log Viewer highlight slots** — Removed the separate visible `<input type="color">` box. Each slot now has only the colored dot which opens the hidden color input on click.

## [1.1.0] - 2026-10-30

### Features
- **Query Runner** (renamed from SOQL Query Runner) now supports both SOQL and SOSL queries
- Added query type dropdown to switch between SOQL and SOSL
- SOSL queries are executed using Salesforce's search API
- Added example SOSL query for contacts search
- Query library now stores query type (SOQL/SOSL) for each saved query
- Existing SOQL queries are preserved and continue to work

### Changed
- Tool renamed from "SOQL Query Runner" to "Query Runner" in the tool selector
- Updated UI to show query type selector dropdown
- Results export filename changed from `soql-results-*.csv` to `query-results-*.csv`

## [1.0.0] - 2026-10-20

Initial release of Salesforce Assist Buddy for VS Code.

### Features
- Browse Apex logs, manage trace flags, and inspect detailed log events.
- Run parameterized SOQL queries against authenticated Salesforce orgs and export results as CSV.
- Generate Experience Cloud login-as URLs with authenticated org selection and contact validation.
- Configure refresh behavior and diagnostic logging through VS Code settings.
