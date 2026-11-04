# Experience Login URL — User Guide

Generate an Experience Cloud "Login As" URL from a contact email and network selection, then open it in your browser (normal or incognito/private mode).

## What this tool does

The **Experience Login URL** tool lets an authenticated Salesforce admin generate a frontdoor login URL that logs into an Experience Cloud site as a specific contact user, without needing that user's password. The URL contains an authenticated session credential and is held only in extension memory — never written to logs, query libraries, or webview state.

## Prerequisites

- An authenticated Salesforce org via the Salesforce CLI (`sf org login ...`)
- The org must have **Experience Cloud** enabled (otherwise no networks will be listed)
- Your user must have permission to query Contact, Network, User, and Organization records, and to use Salesforce's **Login As** functionality

## Step-by-step

### 1. Open the tool

Open the **Salesforce Assist Buddy** panel, then select **Experience Login URL** from the tool dropdown. A new editor tab opens with the Experience Login webview.

### 2. Choose an org

The org dropdown initially shows your default authenticated org. To switch:

- Pick a different org from the dropdown, or
- Click **Refresh orgs** to reload CLI authentication entries

Switching orgs clears contact selections and generated URLs, reloads networks, and uses a fresh username-scoped connection.

### 3. Enter a contact email

Type part or all of a contact's email address in the **Contact email** field, then click **Find contacts**.

> You can enter a partial email (for example `bill` or `bill@example`). The tool uses a `LIKE` search, so you don't need the full address.

### 4. Select a contact / Experience user

The contact picker shows matching contacts with:

- Full name
- Account name (when available)
- Active username
- Contact ID

Select the contact you want to log in as. Contacts without an active Experience user are listed but cannot be selected for login.

### 5. Choose an Experience network

Click **Refresh networks** (or networks load automatically when you select an org), then choose the Experience Cloud network from the dropdown.

If no networks appear, the org may not have Experience Cloud enabled.

### 6. Generate the login URL

Click **Generate login URL**. The tool validates the selected user still matches the contact and email, then builds a frontdoor URL containing your authenticated session credential.

### 7. Copy or open in browser

- **Copy URL** — copies the frontdoor URL to your clipboard
- **Open in browser** — opens the URL in your chosen browser

### Browser and incognito mode

Use the **Browser** dropdown to choose Chrome, Firefox, Safari, Edge, Brave, Opera, Vivaldi, or Arc.

Use the **Incognito/Private mode** toggle:

| Toggle off (normal) | Toggle on (incognito/private) |
|---------------------|-------------------------------|
| Generates a URL **without** the session ID | Uses the session-bearing URL |
| Opens in a normal window of the selected browser | Opens in an incognito/private window of the selected browser |

When incognito is on, you'll be asked to confirm before opening, since the URL contains your authenticated session.

## Security

- The generated frontdoor URL contains your authenticated Salesforce session credential
- Session URLs are held only in extension memory — never logged or persisted
- URLs are cleared when inputs change or the editor closes
- Treat the clipboard and browser history as sensitive
- Browser login may be refused by org session policies or API-only sessions; generation does not bypass those restrictions

## Error messages

| Message | Cause |
|---------|-------|
| "Select an authenticated org." | No org selected in the dropdown |
| "Enter a contact email." | Email field is empty |
| "Email must not contain spaces." | Email contains whitespace |
| "Email is too long (max 254 characters)." | Email exceeds 254 characters |
| "Experience Cloud networks are not available for this org. This org may not have Experience Cloud enabled." | The selected org doesn't support the Network sObject |
| "More than 200 active users match this email." | Too many matching users; narrow the email |
| "Generate a login URL first." | Trying to copy/open without generating |
| "The URL action failed. Generate a fresh URL and try again." | Copy/open action failed; regenerate |

---

*Part of Salesforce Assist Buddy for VS Code.*
