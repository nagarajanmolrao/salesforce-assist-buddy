import { AuthenticatedOrgService, OrgSelection } from '../../core/authenticatedOrgs';

export interface ExperienceNetwork {
    id: string;
    name: string;
}

export interface ExperienceContactMatch {
    contactId: string;
    contactName: string;
    accountName?: string;
    userId?: string;
    username?: string;
}

function validateEmail(email: string): string {
    const normalizedEmail = email.trim();
    if (normalizedEmail.length === 0) {
        throw new Error('Enter a contact email address.');
    }
    if (/\s/.test(normalizedEmail)) {
        throw new Error('Email must not contain spaces.');
    }
    if (normalizedEmail.length > 254) {
        throw new Error('Email is too long (max 254 characters).');
    }
    return normalizedEmail;
}

export function escapeSoqlText(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r/g, '\\r').replace(/\n/g, '\\n');
}

export function buildExperienceLoginUrl(
    instanceUrl: string,
    accessToken: string,
    organizationId: string,
    networkId: string,
    userId: string,
    contactId: string
): string {
    const domain = new URL(instanceUrl);
    if (domain.protocol !== 'https:' || domain.username || domain.password) {
        throw new Error('The Salesforce org must have a secure HTTPS URL.');
    }
    for (const id of [organizationId, networkId, userId, contactId]) {
        if (!/^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/.test(id)) throw new Error('Salesforce returned an invalid record ID.');
    }
    if (!accessToken || /[\r\n]/.test(accessToken)) throw new Error('The org session is unavailable. Reauthenticate and try again.');

    const loginAs = new URL('/servlet/servlet.su', domain.origin);
    loginAs.searchParams.set('oid', organizationId);
    loginAs.searchParams.set('retURL', `/${contactId}`);
    loginAs.searchParams.set('sunetworkid', networkId);
    loginAs.searchParams.set('sunetworkuserid', userId);

    const frontdoor = new URL('/secur/frontdoor.jsp', domain.origin);
    frontdoor.searchParams.set('sid', accessToken);
    frontdoor.searchParams.set('retURL', loginAs.toString());
    return frontdoor.toString();
}

export class ExperienceLoginService {
    private readonly orgService = new AuthenticatedOrgService('Experience Login');

    public async listOrgs(forceRefresh = false): Promise<OrgSelection> {
        return this.orgService.listOrgs(forceRefresh);
    }

    public async listNetworks(username: string): Promise<{ org: string; networks: ExperienceNetwork[] }> {
        try {
            const result = await this.orgService.run(username, async connection =>
                await connection.query<{ Id: string; Name: string }>('SELECT Id, Name FROM Network ORDER BY Name').autoFetch(true).maxFetch(10000)
            );
            if (!result.done) throw new Error('The network list exceeded 10,000 records. Contact your Salesforce administrator.');
            return { org: username, networks: result.records.map(network => ({ id: network.Id, name: network.Name })) };
        } catch (error) {
            const errorCode = (error as { errorCode?: string })?.errorCode;
            if (errorCode === 'INVALID_TYPE' || String(error).includes('sObject type \'Network\' is not supported')) {
                throw new Error('Experience Cloud networks are not available for this org. This org may not have Experience Cloud enabled.');
            }
            throw error;
        }
    }

    public async findContacts(
        username: string,
        email: string
    ): Promise<ExperienceContactMatch[]> {
        const normalizedEmail = validateEmail(email);

        return this.orgService.run(username, async connection => {
            const escapedEmail = escapeSoqlText(normalizedEmail);
            const contacts = await connection.query<{
                Id: string;
                Name: string;
                Account?: { Name?: string } | null;
            }>(
                `SELECT Id, Name, Account.Name FROM Contact WHERE Email = '${escapedEmail}' ORDER BY Id LIMIT 101`
            );

            if (contacts.records.length > 100) {
                throw new Error('More than 100 contacts');
            }

            if (contacts.records.length === 0) {
                return [];
            }

            contacts.records.sort((a, b) => a.Id.localeCompare(b.Id));

            const contactIds = contacts.records.map(c => `'${escapeSoqlText(c.Id)}'`).join(',');
            const users = await connection.query<{
                Id: string;
                ContactId: string;
                Username: string;
            }>(
                `SELECT Id, ContactId, Username FROM User WHERE ContactId IN (${contactIds}) AND IsActive = true`
            );

            const userMap = new Map<string, { Id: string; Username: string }>();
            for (const user of users.records) {
                if (user.ContactId) userMap.set(user.ContactId, user);
            }

            return contacts.records.map(contact => {
                const user = userMap.get(contact.Id);
                return {
                    contactId: contact.Id,
                    contactName: contact.Name,
                    accountName: contact.Account?.Name,
                    userId: user?.Id,
                    username: user?.Username
                };
            });
        });
    }

    public async generate(
        username: string,
        email: string,
        networkId: string,
        contactId: string,
        userId: string
    ): Promise<{ url: string }> {
        const normalizedEmail = validateEmail(email);
        if (!/^0DB[a-zA-Z0-9]{12}(?:[a-zA-Z0-9]{3})?$/.test(networkId)) throw new Error('Select an Experience Cloud network.');
        if (!/^003[a-zA-Z0-9]{12}(?:[a-zA-Z0-9]{3})?$/.test(contactId) ||
            !/^005[a-zA-Z0-9]{12}(?:[a-zA-Z0-9]{3})?$/.test(userId)) {
            throw new Error('Find contacts and select an active Experience user.');
        }

        return this.orgService.run(username, async connection => {
            const [networks, users, organizations] = await Promise.all([
                connection.query(`SELECT Id, Name FROM Network WHERE Id = '${networkId}' LIMIT 2`),
                connection.query(`SELECT Id, Username, ContactId FROM User WHERE Contact.Email = '${escapeSoqlText(normalizedEmail)}' AND IsActive = true LIMIT 2`),
                connection.query('SELECT Id FROM Organization LIMIT 1')
            ]);
            if (networks.records.length !== 1) throw new Error('The selected network is unavailable. Refresh the network list.');
            const user = users.records[0] as { Id: string; ContactId?: string } | undefined;
            if (users.records.length !== 1 || user?.ContactId !== contactId || user.Id !== userId) {
                throw new Error('The selected contact no longer has this active Experience user or matching email. Find contacts again.');
            }
            const organization = organizations.records[0] as { Id: string } | undefined;
            if (!organization) throw new Error('Could not determine the Salesforce organization.');
            
            const url = buildExperienceLoginUrl(
                connection.instanceUrl, connection.accessToken || '', organization.Id, networkId, user.Id, user.ContactId
            );
            return { url };
        });
    }
}