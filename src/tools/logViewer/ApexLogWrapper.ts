// Wrapper class for the Salesforce API's ApexLog object.
import { Connection } from 'jsforce';

export interface ApexLogRecord {
    Id: string;
    Application: string;
    DurationMilliseconds: number;
    Location: string;
    LogLength: number;
    LogUser: {
        Name: string;
    };
    Operation: string;
    Request: string;
    StartTime: string;
    Status: string;
}

export class ApexLog {
    public get id(): string { return this.entry.Id; }
    public get application(): string { return this.entry.Application; }
    public get startTime(): Date { return new Date(this.entry.StartTime); }
    public get durationMilliseconds(): number { return this.entry.DurationMilliseconds; }
    public get location(): string { return this.entry.Location; }
    public get size(): number { return this.entry.LogLength; }
    public get user(): string { return this.entry.LogUser.Name; }
    public get operation(): string { return this.entry.Operation; }
    public get request(): string { return this.entry.Request; }
    public get status(): string { return this.entry.Status; }
    public uiStatus: string = '';

    constructor(
        private readonly entry: ApexLogRecord,
        private readonly connection: Connection
    ) {        
        this.uiStatus = entry.Status ?? '';
    }    
    
    // Get the log from the org as gzip; jsforce automatically decompresses it into a string.
    public async getBody(): Promise<string> {
        const result = await this.connection.tooling.request({
            method: 'GET',
            url: `${this.connection.tooling._baseUrl()}/sobjects/ApexLog/${this.entry.Id}/Body`,
            headers: {
                'Accept-Encoding': 'gzip',
                'Accept': 'text/plain'
            }
        }) as string;
        return result;
    }
}