export type QueryParameterType = 'text' | 'number' | 'boolean' | 'date' | 'datetime';
export type QueryType = 'soql' | 'sosl';

export interface QueryParameter {
    name: string;
    label: string;
    type: QueryParameterType;
    defaultValue?: string;
}

export interface SavedQuery {
    id: string;
    name: string;
    query: string;
    queryType: QueryType;
    parameters: QueryParameter[];
}

export { AuthenticatedOrg, parseOrgList, resolveDefaultUsername } from '../../core/authenticatedOrgs';

export interface QueryTableData {
    columns: string[];
    rows: Record<string, string>[];
    csv: string;
}

export function resolveSalesforceDirectory(sfdxDirectory?: string, sfDirectory?: string): string | undefined {
    return sfdxDirectory || sfDirectory;
}

export function getParameterNames(soql: string): string[] {
    const names = new Set<string>();
    const pattern = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
    for (const match of soql.matchAll(pattern)) names.add(match[1]);
    return [...names];
}

function isInsideSingleQuotedLiteral(soql: string, offset: number): boolean {
    let insideLiteral = false;
    for (let index = 0; index < offset; index++) {
        if (soql[index] === '\\') {
            index++;
        } else if (soql[index] === "'") {
            insideLiteral = !insideLiteral;
        }
    }
    return insideLiteral;
}

function formatParameterValue(parameter: QueryParameter, rawValue: unknown, insideLiteral = false): string {
    const value = String(rawValue ?? '').trim();
    if (!value) throw new Error(`Enter a value for ${parameter.label || parameter.name}.`);

    switch (parameter.type) {
        case 'text':
            {
                const escaped = value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
                return insideLiteral ? escaped : `'${escaped}'`;
            }
        case 'number': {
            const number = Number(value);
            if (!Number.isFinite(number)) throw new Error(`${parameter.label || parameter.name} must be a number.`);
            return String(number);
        }
        case 'boolean':
            if (!/^(true|false)$/i.test(value)) {
                throw new Error(`${parameter.label || parameter.name} must be true or false.`);
            }
            return value.toLowerCase();
        case 'date': {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
                throw new Error(`${parameter.label || parameter.name} must be a valid date.`);
            }
            const [year, month, day] = value.split('-').map(Number);
            const date = new Date(Date.UTC(year, month - 1, day));
            if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
                throw new Error(`${parameter.label || parameter.name} must be a valid date.`);
            }
            return value;
        }
        case 'datetime': {
            const date = new Date(value);
            if (Number.isNaN(date.getTime())) throw new Error(`${parameter.label || parameter.name} must be a valid date and time.`);
            return date.toISOString();
        }
        default:
            throw new Error(`Unsupported parameter type for ${parameter.name}.`);
    }
}

export function buildSoql(query: SavedQuery, values: Record<string, unknown>): string {
    const queryString = query.query.trim();
    if (!queryString) throw new Error('Enter a query.');

    const parameterNames = getParameterNames(queryString);
    const definitions = new Map(query.parameters.map(parameter => [parameter.name, parameter]));
    for (const name of parameterNames) {
        if (!definitions.has(name)) throw new Error(`Define a parameter for {{${name}}}.`);
    }

    return parameterNames.reduce((text, name) => {
        const token = new RegExp(`\\{\\{\\s*${name}\\s*\\}\\}`, 'g');
        return text.replace(token, (_match: string, offset: number) => {
            const parameter = definitions.get(name)!;
            // For SOSL queries, the searchTerm parameter is wrapped in braces, not quotes
            if (query.queryType === 'sosl' && name === 'searchTerm') {
                return `{${String(values[name] ?? '').trim()}}`;
            }
            const insideLiteral = isInsideSingleQuotedLiteral(text, offset);
            return formatParameterValue(parameter, values[name], insideLiteral);
        });
    }, queryString);
}

export function formatCliErrorOutput(stdout = '', stderr = ''): string | undefined {
    return [stdout, stderr].map(output => {
        const trimmed = output.trim();
        if (!trimmed) return '';
        try {
            return JSON.stringify(JSON.parse(trimmed), null, 2);
        } catch {
            return trimmed;
        }
    }).filter(Boolean).join('\n\n') || undefined;
}

function flattenRecord(record: Record<string, unknown>, prefix = '', result: Record<string, string> = {}) {
    for (const [key, value] of Object.entries(record)) {
        if (key === 'attributes' || value === undefined) continue;
        const column = prefix ? `${prefix}.${key}` : key;
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            flattenRecord(value as Record<string, unknown>, column, result);
        } else {
            result[column] = value === null ? '' : Array.isArray(value) ? JSON.stringify(value) : String(value);
        }
    }
    return result;
}

function csvCell(value: string): string {
    return `"${value.replace(/"/g, '""')}"`;
}

export function toQueryTableData(records: Record<string, unknown>[]): QueryTableData {
    const flattened = records.map(record => flattenRecord(record));
    const allColumns = [...new Set(flattened.flatMap(record => Object.keys(record)))];
    const columns = allColumns.filter(column => !allColumns.some(other => other.startsWith(`${column}.`)));
    const rows = flattened.map(record => Object.fromEntries(columns.map(column => [column, record[column] ?? ''])));
    const csv = [columns, ...rows.map(row => columns.map(column => row[column]))]
        .map(row => row.map(csvCell).join(','))
        .join('\r\n');
    return { columns, rows, csv: columns.length ? `\uFEFF${csv}` : '' };
}
