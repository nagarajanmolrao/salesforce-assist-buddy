# Salesforce Assist Buddy

Salesforce developer tools for VS Code: inspect Apex logs, manage user trace flags, and run saved SOQL/SOSL queries across authenticated orgs.

## Tools and Views

| Tool or view | Purpose |
| --- | --- |
| [Log Viewer](#apex-log-workflow) | Browse recent logs, select multiple Operation types, and filter or sort the results. |
| [Log Details](#log-details) | Inspect execution events, search log content, and expand method blocks. |
| [Trace Flags](#trace-flags) | Find users and enable or disable their debug trace flags. |
| [Query Runner](#query-runner) | Select an org, run saved SOQL or SOSL queries with parameters, and export searchable results as CSV. |
| [Experience Login URL](#experience-login-url) | Generate an Experience Cloud login-as URL from a contact email and network selection. |

The screenshots below show the extension's webviews rendered with fictional sample data and a VS Code-style dark theme. They omit VS Code's surrounding tabs and title-bar actions; no live org data or credentials are shown.

## Requirements

- VS Code 1.100.0 or later.
- Salesforce CLI (`sf`) **version 2.87.0 or later** installed and available on PATH. The extension checks the CLI version on startup and shows an error if the installed version is too old.
- Authenticated Salesforce CLI orgs for the Query Runner. Log Viewer uses the configured target org in the Salesforce project's `.sf/config.json` or the user's global configuration.
- For development: Node.js 22 or later and npm.

## Install Locally

1. Build the VSIX using the development commands below.
2. Run **Extensions: Install from VSIX...** in VS Code and choose `salesforce-assist-buddy-1.0.0.vsix`.
3. Open an authenticated Salesforce project and the **Salesforce Assist Buddy** panel.

The GitHub repository is configured for documentation links; Marketplace publication is not configured.

## Apex Log Workflow

- Refresh the latest logs manually or enable automatic refresh while the panel is visible.
- Restrict results to the connected user or include other users.
- Filter and sort logs by user, operation, time, status, size, or duration.
- Select multiple **Log types** beside the tool selector to include exact Operation values. Starter options include `UniversalPerfLogger`, `/webruntime/api/execute`, `/aura`, and common Apex operations. New Operation values are added automatically as logs arrive and remembered per workspace, along with your selection. **All types** includes future types automatically; explicit selections do not. This filter combines with text search and applies to the latest 100 fetched records, not the entire org history.
- Open a log to download and cache it in the workspace `.logs` directory.
- Open **Log Details** for event navigation, expandable method blocks, search, and USER_DEBUG filtering.
- Clear downloaded files locally or delete remote Apex logs after confirmation.

Log Viewer filters and title-bar actions follow the panel's selected tool and visibility. Opening SOQL Query Runner or Experience Login in an editor leaves the panel picker on Log Viewer, so its controls remain available. Focusing a separate editor does not hide them or change the org or trace flags.

![Log Viewer showing sample users, operations, log durations, and three selected log types](https://i.postimg.cc/kXC7w4W5/log-viewer.png)

## Log Details

Open a downloaded `.log` file and select **Log Details** from the editor title bar. Expand or collapse method blocks, search execution events, hide heap-allocation entries, or show only `USER_DEBUG` messages.

![Log Details showing sample execution events, an expanded method block, and debug messages](https://i.postimg.cc/X7WnxJ94/log-details.png)

## Trace Flags

The flag-icon command, **Set TraceFlag for User**, opens a searchable list of up to 100 active users. Typing any part of a name or a username prefix queries the org after a 300 ms pause rather than downloading every user.

The person-add command, **Set TraceFlag by Username or Email**, first prompts for a keyword. Press Enter to search using `Username LIKE '%keyword%' OR Email LIKE '%keyword%'`, then choose a matching user. Results are limited to 100 users; narrow the keyword when necessary.

Both commands exclude the current user from the picker and check trace-flag status only for displayed users. Choosing a user enables their trace flag, or disables it when an active flag already exists. Enabled flags are renewed automatically. The current user's trace flag is initialized separately.

Log Viewer identifies the current user before querying, but sets up their trace flag in the background so existing logs can appear without waiting for trace-flag creation. Initial log retrieval starts once the webview is ready.

The trace-flag cleanup command removes expired flags for other users. Its existing command ID is `salesforce-assist-buddy.deleteAllTraceFlagsExceptCurrent`.

## Query Runner

Select **Query Runner** in the panel's tool selector to open a separate editor. It lists authenticated orgs from Salesforce CLI and defaults to the CLI-selected org when available. The list is cached for the editor session and refreshed only when requested. Queries run through a cached Salesforce Core connection for the selected username, independently of the default org used by Log Viewer.

![Query Runner showing a sample org selection, saved query, query type selector, and parameter inputs](https://i.postimg.cc/YGPJNWtF/soql-query-runner.png)

Saved queries are stored under `.sfdx/salesforce-assist-buddy/queries.json` when `.sfdx` exists, or under `.sf/salesforce-assist-buddy/queries.json` when only `.sf` exists. If neither directory exists, `.sfdx/salesforce-assist-buddy/queries.json` is created. The file is created with an Accounts example and a Contacts SOSL example the first time the editor opens; use **Open library** to edit it directly and **Reload library** to refresh the list.

The query type dropdown lets you switch between **SOQL** and **SOSL** queries. Query parameters use `{{parameterName}}` placeholders and are defined with a type in the saved query JSON; matching input controls appear in the editor. Text parameters can replace a complete literal (`Name = {{name}}`) or appear inside quotes (`Name LIKE '%{{brandName}}%'`). For SOSL queries, the search term is used directly in the FIND clause.

Query results are shown in a sortable table with global search and per-column filters. **Download CSV** exports the complete result set.

![Query results showing fictional records, column filters, global search, and the CSV download action](https://i.postimg.cc/ZBQ1PdJF/soql-results.png)

## Experience Login URL

Select **Experience Login URL** from the tool dropdown to open its editor. Choose an authenticated **Salesforce org**, enter the **Contact email**, and choose **Find contacts**. Select a matching **Contact / Experience user**, choose an **Experience network** loaded from that org, and select **Generate login URL**.

The org dropdown initially uses the default authenticated org and remembers your selection within the editor. **Refresh orgs** reloads CLI authentication entries; **Refresh networks** reloads the selected org's networks. Switching orgs clears contact selections and generated URLs, reloads networks, and uses an explicitly username-scoped connection for every lookup and URL generation. It never changes the configured default org or the Log Viewer's connection and trace flags.

The contact picker shows full names, account names when available, active usernames, and contact IDs to distinguish contacts sharing an email. Contacts without an active Experience user remain listed but cannot be selected for login. Changing the email clears the previous search and selection. The lookup is bounded to 100 contacts and 200 linked active users, with an explicit error if either limit is exceeded.

The tool performs Contact, Network, User, and Organization lookups directly through Salesforce APIs, revalidating that the selected active user belongs to the chosen contact and still matches the email before generating the URL. The authenticated admin must have permission to query these records and use Salesforce's Login As functionality. Network membership, session restrictions, and Login As permissions remain enforced by Salesforce.

**Copy URL** copies the result explicitly; **Open in browser** asks for confirmation before opening it. The generated frontdoor URL contains the authenticated session credential. It is held only in extension memory, never written to logs, query libraries, or webview state, and cleared when inputs change or the editor closes. Treat the clipboard and browser history as sensitive. Browser login may be refused by org session policies or API-only sessions; generation does not bypass those restrictions.

## Settings

Search VS Code settings for **Salesforce Assist Buddy**.

| Setting | Default | Purpose |
| --- | --- | --- |
| `salesforceAssistBuddy.autoRefresh` | `true` | Refresh while the log panel is visible. |
| `salesforceAssistBuddy.refreshInterval` | `5000` | Refresh interval in milliseconds; minimum 1000. |
| `salesforceAssistBuddy.currentUserOnly` | `true` | Limit logs to the connected user. |
| `salesforceAssistBuddy.traceFlagExpirationInterval` | `15` | Trace-flag expiration interval in minutes; minimum 5. |
| `salesforceAssistBuddy.showOutputOnStart` | `true` | Show the diagnostic output channel during startup. |
| `salesforceAssistBuddy.debugLevel` | `InternalAll` | Salesforce debug level; also supports `SFDC_DevConsole`. |

## Diagnostics

Open **View > Output > Salesforce Assist Buddy**. Normal output contains lifecycle milestones, failures, recovery attempts, and one warning when a tracked operation is still pending after 15 seconds. Pending warnings do not cancel work.

Use **Developer: Set Log Level...** to select Debug for operation breadcrumbs and timings. Return to Info after reproducing the issue. Identical warnings and errors are suppressed for 60 seconds, and known credential formats are redacted. Review diagnostics before sharing them.

The extension removes files older than 48 hours from its extension-specific log directory. SOQL query failures include full error details in the Output channel, with credential redaction applied. The editor shows a concise failure message directing you to those logs.

## Development

```powershell
npm.cmd ci
npm.cmd test
npm.cmd run compile
npx.cmd --no-install vsce package --no-dependencies --out salesforce-assist-buddy-1.0.0.vsix
```

On other platforms, use `npm` and `npx`. `npm test` runs TypeScript validation and the Node-based command, settings, logger, and SOQL query tests. `npm run compile` creates the bundled extension in `out`.

The VSIX includes TypeScript sources, build inputs, license, and notices. The configured GitHub repository URL lets VSCE resolve relative documentation links. Dependency advisories should be reviewed before distribution; do not apply breaking upgrades without regression testing.

## Repository Identity

- Extension: `Anmol.salesforce-assist-buddy`.
- Version: `1.0.0`.
- Command prefix: `salesforce-assist-buddy.`.
- Log view: `salesforceAssistBuddy.logs`.
- Details view: `salesforceAssistBuddy.logDetails`.

## Releases

See [CHANGELOG.md](CHANGELOG.md) for this repository's release notes.

## License and Attribution

Distributed under GNU GPL version 3 only (`GPL-3.0-only`). See [LICENSE](LICENSE) for the full terms and [NOTICE](NOTICE) for required attribution. Third-party dependencies retain their respective licenses.
