# Change Log

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
