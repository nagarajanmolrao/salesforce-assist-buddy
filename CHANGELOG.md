# Change Log

## [1.2.1] - 2026-11-05

### Changed
- **Experience Login URL** - Removed the browser selection dropdown and Incognito/Private mode toggle. The tool now always generates a session-bearing frontdoor URL (with `sid`), matching v1.0.0/v1.1.0 URL construction. "Open in browser" always opens the session-bearing URL.
- **URL construction reverted** - `buildExperienceLoginUrl()` always includes the session ID; the conditional `includeSessionId` parameter was removed.

## [1.2.0] - 2026-11-04

### Features
- **Experience Login URL** - Added browser selection dropdown with common browsers (Chrome, Firefox, Safari, Edge, Brave, Opera, Vivaldi, Arc)
- **Incognito/Private Mode Toggle** - Choose whether to open the login URL in incognito/private mode or normal mode
  - When enabled: Opens the session-bearing URL in an incognito/private window of the selected browser
  - When disabled: Generates a URL without the session ID and opens it in a normal browser window
- URL handling updated to support both modes with appropriate browser launch commands

### Changed
- Updated Experience Login URL webview with new browser selection controls
- **Network sObject error handling** - When an org does not support Experience Cloud, `listNetworks()` now shows a friendly message instead of the raw `sObject type 'Network' is not supported` error
- **Email validation relaxed** - Backend `validateEmail()` now only checks for non-empty, no-spaces, and max length; partial email lookups are supported via `LIKE` in the SOQL query

### Log Viewer
- **Log Details opens by default** - Clicking a log now opens the Log Details editor webview instead of a raw `.log` text file
- **Persistent column widths** - Column width adjustments in the Log Viewer grid are saved and restored across reloads
- **Full debug content** - Long debug statements with serialized JSON now wrap in the Log Details table and show the full content on hover
- **Faster initialization** - Logs are pulled immediately when the provider initializes and when switching orgs, without waiting for panel visibility

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
