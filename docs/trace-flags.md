# Trace Flags — User Guide

Find users and enable or disable their debug trace flags.

## What this tool does

The **Trace Flags** tool lets you manage debug trace flags for users in your org. You can search for users by name or username, enable trace flags for debugging, and automatically renew them before expiration.

## Prerequisites

- An authenticated Salesforce org via the Salesforce CLI
- Permission to query and modify trace flags

## Step-by-step

### 1. Set TraceFlag for User

Click the flag-icon command **Set TraceFlag for User**. A searchable list of up to 100 active users opens. Type any part of a name or username prefix to filter results.

For example, to find **bill**, type `bill` and select the matching user.

### 2. Set TraceFlag by Username or Email

Click the person-add command **Set TraceFlag by Username or Email**. Enter a keyword and press Enter to search using:

```
Username LIKE '%keyword%' OR Email LIKE '%keyword%'
```

Choose a matching user from up to 100 results.

### 3. Enable or disable trace flags

Choosing a user enables their trace flag, or disables it when an active flag already exists. Enabled flags are renewed automatically before they expire.

Both commands exclude the current user from the picker and check trace-flag status only for displayed users.

### 4. Clean up expired flags

The trace-flag cleanup command removes expired flags for other users. Its command ID is `salesforce-assist-buddy.deleteAllTraceFlagsExceptCurrent`.

---

*Part of Salesforce Assist Buddy for VS Code.*
