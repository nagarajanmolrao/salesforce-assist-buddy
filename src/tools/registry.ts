export const toolRegistry = [
    { id: 'log-viewer', label: 'Log Viewer', behavior: 'select' },
    { id: 'soql-runner', label: 'Query Runner', behavior: 'open-editor' },
    { id: 'experience-login', label: 'Experience Login URL', behavior: 'open-editor' }
] as const;

export type ToolId = typeof toolRegistry[number]['id'];

export const defaultToolId: ToolId = 'log-viewer';

export function isToolId(value: unknown): value is ToolId {
    return toolRegistry.some(tool => tool.id === value);
}