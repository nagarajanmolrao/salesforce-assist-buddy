(function () {
    const vscode = acquireVsCodeApi();
    const orgSelect = document.getElementById('org-select');
    const refreshOrgs = document.getElementById('refresh-orgs');
    let selectedUsername = (vscode.getState() || {}).selectedUsername || '';
    const email = document.getElementById('email');
    const findContacts = document.getElementById('find-contacts');
    const contact = document.getElementById('contact');
    const network = document.getElementById('network');
    const generate = document.getElementById('generate');
    const refresh = document.getElementById('refresh');
    const result = document.getElementById('result');
    const status = document.getElementById('status');
    let contactMatches = [];
    let busy = true;
    let networksReady = false;

    function selectedContact() {
        return contactMatches.find(match => match.userId && match.userId === contact.value);
    }

    function setBusy(value) {
        busy = value;
        orgSelect.disabled = orgSelect.options.length === 0;
        refreshOrgs.disabled = value && orgSelect.options.length > 0;
        email.disabled = value;
        findContacts.disabled = value || !networksReady || !selectedUsername;
        contact.disabled = value || contactMatches.length === 0;
        network.disabled = value || network.options.length === 0;
        generate.disabled = value || !networksReady || network.options.length === 0 || !selectedContact();
        refresh.disabled = value || !selectedUsername;
    }

    function clearContacts() {
        contactMatches = [];
        contact.replaceChildren();
        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.textContent = 'Find contacts by email';
        contact.appendChild(placeholder);
        contact.title = '';
        setBusy(busy);
    }

    function invalidate() {
        result.hidden = true;
        status.textContent = '';
        status.dataset.error = 'false';
        vscode.postMessage({ command: 'invalidate' });
    }

    function clearOrgData() {
        networksReady = false;
        network.replaceChildren();
        clearContacts();
        result.hidden = true;
        status.dataset.error = 'false';
    }

    orgSelect.addEventListener('change', () => {
        selectedUsername = orgSelect.value;
        vscode.setState({ selectedUsername });
        invalidate();
        clearOrgData();
        setBusy(true);
        status.textContent = 'Loading networks for the selected org...';
        vscode.postMessage({ command: 'selectOrg', username: selectedUsername });
    });

    refreshOrgs.addEventListener('click', () => {
        invalidate();
        clearOrgData();
        setBusy(true);
        status.textContent = 'Refreshing authenticated orgs...';
        vscode.postMessage({ command: 'refreshOrgs', username: selectedUsername });
    });

    email.addEventListener('input', () => {
        invalidate();
        clearContacts();
    });
    findContacts.addEventListener('click', () => {
        if (!email.reportValidity()) return;
        invalidate();
        clearContacts();
        setBusy(true);
        status.textContent = 'Finding matching contacts and active Experience users...';
        vscode.postMessage({ command: 'findContacts', username: selectedUsername, email: email.value.trim() });
    });
    contact.addEventListener('change', () => {
        invalidate();
        contact.title = contact.selectedOptions[0]?.textContent || '';
        setBusy(false);
    });
    network.addEventListener('change', invalidate);
    refresh.addEventListener('click', () => {
        invalidate();
        clearContacts();
        setBusy(true);
        status.textContent = 'Loading Experience Cloud networks...';
        networksReady = false;
        network.replaceChildren();
        vscode.postMessage({ command: 'refreshNetworks', username: selectedUsername });
    });
    document.getElementById('login-form').addEventListener('submit', event => {
        event.preventDefault();
        const selected = selectedContact();
        if (!selected) return;
        invalidate();
        setBusy(true);
        status.textContent = 'Generating login URL...';
        vscode.postMessage({
            command: 'generate', username: selectedUsername, email: email.value.trim(), networkId: network.value,
            contactId: selected.contactId, userId: selected.userId
        });
    });
    document.getElementById('copy').addEventListener('click', () => vscode.postMessage({ command: 'copy' }));
    document.getElementById('open').addEventListener('click', () => vscode.postMessage({ command: 'open' }));

    window.addEventListener('message', event => {
        const message = event.data;
        if (message.type === 'orgs') {
            orgSelect.replaceChildren();
            for (const org of message.orgs) {
                const option = document.createElement('option');
                option.value = org.username;
                option.textContent = org.alias ? `${org.alias} (${org.username})` : org.username;
                orgSelect.appendChild(option);
            }
            selectedUsername = message.selectedUsername;
            orgSelect.value = selectedUsername;
            vscode.setState({ selectedUsername });
            clearOrgData();
            setBusy(true);
            status.textContent = 'Loading networks for the selected org...';
        } else if (message.type === 'networks') {
            if (message.org !== selectedUsername) return;
            clearContacts();
            const previous = network.value;
            network.replaceChildren();
            for (const item of message.networks) {
                const option = document.createElement('option');
                option.value = item.id;
                option.textContent = item.name;
                network.appendChild(option);
            }
            if (Array.from(network.options).some(option => option.value === previous)) network.value = previous;
            result.hidden = true;
            status.dataset.error = 'false';
            status.textContent = network.options.length ? '' : 'No Experience Cloud networks are available in this org.';
            networksReady = true;
            setBusy(false);
        } else if (message.type === 'contacts') {
            contactMatches = message.contacts;
            contact.replaceChildren();
            const placeholder = document.createElement('option');
            placeholder.value = '';
            placeholder.textContent = contactMatches.length ? 'Select a contact / Experience user' : 'No matching contacts';
            contact.appendChild(placeholder);
            for (const match of contactMatches) {
                const option = document.createElement('option');
                option.value = match.userId || '';
                option.disabled = !match.userId;
                option.textContent = [match.contactName, match.accountName,
                    match.username || 'No active Experience user', match.contactId].filter(Boolean).join(' - ');
                contact.appendChild(option);
            }
            status.dataset.error = 'false';
            const count = new Set(contactMatches.map(match => match.contactId)).size;
            status.textContent = !contactMatches.length ? 'No contacts found with this email.'
                : !contactMatches.some(match => match.userId) ? 'Contacts found, but none has an active Experience user.'
                : `${count} matching contact${count === 1 ? '' : 's'} found. Select a contact/user to continue.`;
            setBusy(false);
        } else if (message.type === 'generated') {
            setBusy(false);
            result.hidden = false;
            status.textContent = '';
        } else if (message.type === 'copied') {
            status.textContent = 'Login URL copied to the clipboard. Treat it as a session credential.';
        } else if (message.type === 'error') {
            setBusy(false);
            result.hidden = true;
            status.dataset.error = 'true';
            status.textContent = message.message;
        }
    });

    setBusy(true);
    vscode.postMessage({ command: 'ready', username: selectedUsername });
})();