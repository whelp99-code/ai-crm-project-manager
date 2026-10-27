declare module "pg" {
  export interface QueryResult<Row = Record<string, unknown>> {
    rows: Row[];
    rowCount: number | null;
  }

  export interface ClientConfig {
    connectionString?: string;
  }

  export class Client {
    constructor(config?: ClientConfig);
    connect(): Promise<void>;
    end(): Promise<void>;
    query<Row = Record<string, unknown>>(
      text: string,
      values?: readonly unknown[],
    ): Promise<QueryResult<Row>>;
  }
}
