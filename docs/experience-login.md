# Experience Login URL Guide

Generate an Experience Cloud login-as URL from a contact email and network selection.

## Opening Experience Login URL

Select **Experience Login URL** from the tool dropdown to open its editor.

## Steps

1. Choose an authenticated **Salesforce org** from the dropdown.
2. Enter the **Contact email** and choose **Find contacts**.
3. Select a matching **Contact / Experience user** from the results.
4. Choose an **Experience network** loaded from that org.
5. Select **Generate login URL**.

## Behavior

- The org dropdown initially uses the default authenticated org and remembers your selection within the editor.
- **Refresh orgs** reloads CLI authentication entries.
- **Refresh networks** reloads the selected org's networks.
- Switching orgs clears contact selections and generated URLs, reloads networks, and uses an explicitly username-scoped connection.
- Contacts without an active Experience user remain listed but cannot be selected for login.
- If a Contact has no email but its linked active User does, the Contact still appears in results when searching that email.
- The lookup is bounded to 100 contacts and 200 linked active users.

## Security

**Copy URL** copies the result explicitly; **Open in browser** asks for confirmation before opening it. The generated frontdoor URL contains the authenticated session credential — it is held only in extension memory, never written to logs or query libraries, and cleared when inputs change or the editor closes.
