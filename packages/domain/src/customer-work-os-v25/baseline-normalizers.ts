import type { BaselineRecordKind, BaselineSourceRecord } from "./baseline.js";
import {
  CustomerWorkOsV25Error,
  deterministicHash,
  normalizeText,
  record,
  required,
} from "./shared.js";

export type BaselineImportType = "NOTION_JSON" | "EMAIL_JSON" | "CALENDAR_JSON" | "FINANCE_CSV" | "GENERIC_JSON";

export interface BaselineNormalizationResult {
  records: BaselineSourceRecord[];
  snapshotHash: string;
  warnings: Array<{ row: number; code: string; message: string }>;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function objectArray(value: unknown, field: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new CustomerWorkOsV25Error("INVALID_IMPORT", `${field} must be an array`);
  return value.map((item, index) => record(item, `${field}[${index}]`));
}

function notionPropertyValue(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const property = value as Record<string, unknown>;
  const type = stringValue(property.type);
  if (!type) return value;
  const typed = property[type];
  switch (type) {
    case "title":
    case "rich_text":
      return Array.isArray(typed)
        ? typed.map((item) => {
            if (!item || typeof item !== "object") return "";
            const text = item as Record<string, unknown>;
            return stringValue(text.plain_text) ?? stringValue((text.text as Record<string, unknown> | undefined)?.content) ?? "";
          }).join("").trim()
        : "";
    case "number":
    case "checkbox":
    case "url":
    case "email":
    case "phone_number":
    case "created_time":
    case "last_edited_time":
      return typed ?? null;
    case "select":
    case "status":
      return typed && typeof typed === "object" ? stringValue((typed as Record<string, unknown>).name) : null;
    case "multi_select":
      return Array.isArray(typed)
        ? typed.map((item) => item && typeof item === "object" ? stringValue((item as Record<string, unknown>).name) : null).filter(Boolean)
        : [];
    case "date":
      return typed && typeof typed === "object"
        ? {
            start: stringValue((typed as Record<string, unknown>).start),
            end: stringValue((typed as Record<string, unknown>).end),
          }
        : null;
    case "relation":
      return Array.isArray(typed)
        ? typed.map((item) => item && typeof item === "object" ? stringValue((item as Record<string, unknown>).id) : null).filter(Boolean)
        : [];
    case "files":
      return Array.isArray(typed)
        ? typed.map((item) => {
            if (!item || typeof item !== "object") return null;
            const file = item as Record<string, unknown>;
            const external = file.external as Record<string, unknown> | undefined;
            const hosted = file.file as Record<string, unknown> | undefined;
            return {
              name: stringValue(file.name),
              url: stringValue(external?.url) ?? stringValue(hosted?.url),
            };
          }).filter(Boolean)
        : [];
    default:
      return typed ?? null;
  }
}

function flattenNotionRow(row: Record<string, unknown>): Record<string, unknown> {
  const properties = row.properties && typeof row.properties === "object" && !Array.isArray(row.properties)
    ? row.properties as Record<string, unknown>
    : row;
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (["id", "url", "created_time", "last_edited_time", "properties"].includes(key) && properties === row) continue;
    output[key] = notionPropertyValue(value);
  }
  const id = stringValue(row.id) ?? stringValue(row.pageId);
  if (id) output.notionPageId = id;
  const url = stringValue(row.url);
  if (url) output.notionUrl = url;
  return output;
}

function makeRecord(input: {
  workspaceId: string;
  sourceSystem: BaselineSourceRecord["sourceSystem"];
  sourceRef: string;
  kind: BaselineRecordKind;
  occurredAt: string | null;
  data: Record<string, unknown>;
  confidence?: number;
  idHint: string;
}): BaselineSourceRecord {
  const contentHash = deterministicHash({
    sourceSystem: input.sourceSystem,
    sourceRef: input.sourceRef,
    kind: input.kind,
    data: input.data,
  });
  return {
    id: `baseline-source-${deterministicHash({ workspaceId: input.workspaceId, idHint: input.idHint, contentHash }).slice(-16)}`,
    workspaceId: input.workspaceId,
    sourceSystem: input.sourceSystem,
    sourceRef: input.sourceRef,
    kind: input.kind,
    occurredAt: input.occurredAt,
    data: input.data,
    confidence: input.confidence ?? 0.9,
    contentHash,
  };
}

export function normalizeNotionRows(input: {
  workspaceId: string;
  databaseId: string;
  kind: BaselineRecordKind;
  rows: unknown;
}): BaselineNormalizationResult {
  const rows = objectArray(input.rows, "rows");
  const warnings: BaselineNormalizationResult["warnings"] = [];
  const records = rows.map((row, index) => {
    const pageId = stringValue(row.id) ?? stringValue(row.pageId) ?? `row-${index + 1}`;
    const data = flattenNotionRow(row);
    if (Object.keys(data).length === 0) warnings.push({ row: index + 1, code: "EMPTY_ROW", message: "Notion row has no extractable properties" });
    return makeRecord({
      workspaceId: input.workspaceId,
      sourceSystem: "NOTION",
      sourceRef: `notion://${required(input.databaseId, "databaseId")}/${pageId}`,
      kind: input.kind,
      occurredAt: stringValue(row.last_edited_time) ?? null,
      data,
      confidence: 0.98,
      idHint: pageId,
    });
  });
  return { records, snapshotHash: deterministicHash(records), warnings };
}

export function normalizeEmailMessages(input: {
  workspaceId: string;
  provider: "GMAIL" | "OUTLOOK";
  messages: unknown;
}): BaselineNormalizationResult {
  const messages = objectArray(input.messages, "messages");
  const warnings: BaselineNormalizationResult["warnings"] = [];
  const records = messages.map((message, index) => {
    const id = stringValue(message.id) ?? stringValue(message.messageId) ?? `message-${index + 1}`;
    const occurredAt = stringValue(message.occurredAt) ?? stringValue(message.date) ?? stringValue(message.receivedAt);
    if (!occurredAt) warnings.push({ row: index + 1, code: "DATE_MISSING", message: "Email date is missing" });
    const body = stringValue(message.body) ?? stringValue(message.text) ?? stringValue(message.snippet) ?? "";
    const data: Record<string, unknown> = {
      providerMessageId: id,
      subject: stringValue(message.subject) ?? "(제목 없음)",
      sender: stringValue(message.from) ?? stringValue(message.sender),
      recipients: message.to ?? message.recipients ?? [],
      summary: stringValue(message.summary) ?? body.slice(0, 1000),
      bodyDigest: deterministicHash(body),
      threadId: stringValue(message.threadId),
      attachmentRefs: Array.isArray(message.attachments) ? message.attachments : [],
    };
    return makeRecord({
      workspaceId: input.workspaceId,
      sourceSystem: input.provider,
      sourceRef: `${input.provider.toLocaleLowerCase()}://${id}`,
      kind: "ACTIVITY",
      occurredAt: occurredAt ?? null,
      data,
      confidence: body || data.subject ? 0.94 : 0.5,
      idHint: id,
    });
  });
  return { records, snapshotHash: deterministicHash(records), warnings };
}

export function normalizeCalendarEvents(input: {
  workspaceId: string;
  calendarId: string;
  events: unknown;
}): BaselineNormalizationResult {
  const events = objectArray(input.events, "events");
  const warnings: BaselineNormalizationResult["warnings"] = [];
  const records = events.map((event, index) => {
    const id = stringValue(event.id) ?? stringValue(event.eventId) ?? `event-${index + 1}`;
    const start = stringValue(event.start) ?? stringValue((event.start as Record<string, unknown> | undefined)?.dateTime) ?? stringValue((event.start as Record<string, unknown> | undefined)?.date);
    if (!start) warnings.push({ row: index + 1, code: "START_MISSING", message: "Calendar event start is missing" });
    const data: Record<string, unknown> = {
      eventId: id,
      title: stringValue(event.title) ?? stringValue(event.summary) ?? "(제목 없음)",
      description: stringValue(event.description),
      start,
      end: stringValue(event.end) ?? stringValue((event.end as Record<string, unknown> | undefined)?.dateTime) ?? stringValue((event.end as Record<string, unknown> | undefined)?.date),
      attendees: Array.isArray(event.attendees) ? event.attendees : [],
      location: stringValue(event.location),
    };
    return makeRecord({
      workspaceId: input.workspaceId,
      sourceSystem: "CALENDAR",
      sourceRef: `calendar://${required(input.calendarId, "calendarId")}/${id}`,
      kind: "CALENDAR_EVENT",
      occurredAt: start ?? null,
      data,
      confidence: start ? 0.98 : 0.6,
      idHint: id,
    });
  });
  return { records, snapshotHash: deterministicHash(records), warnings };
}

export function parseCsv(text: string, delimiter = ","): string[][] {
  if (delimiter.length !== 1) throw new CustomerWorkOsV25Error("INVALID_IMPORT", "CSV delimiter must be one character");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === delimiter) {
      row.push(field.trim());
      field = "";
    } else if (char === "\n") {
      row.push(field.trim());
      if (row.some((value) => value !== "")) rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") field += char;
  }
  if (quoted) throw new CustomerWorkOsV25Error("INVALID_IMPORT", "CSV contains an unclosed quoted field");
  row.push(field.trim());
  if (row.some((value) => value !== "")) rows.push(row);
  return rows;
}

function headerIndex(headers: string[], variants: string[]): number {
  const normalized = headers.map(normalizeText);
  return normalized.findIndex((header) => variants.some((variant) => header === normalizeText(variant)));
}

function cell(row: string[], index: number): string | null {
  return index >= 0 && row[index]?.trim() ? row[index]!.trim() : null;
}

function moneyString(value: string | null): string | null {
  if (!value) return null;
  const cleaned = value.replace(/[₩원,\s]/g, "").replace(/^\((.+)\)$/, "-$1");
  if (!/^-?\d+(?:\.\d+)?$/.test(cleaned)) return null;
  return Math.round(Number(cleaned)).toString();
}

export function normalizeFinanceCsv(input: {
  workspaceId: string;
  sourceName: string;
  csv: string;
  delimiter?: string;
}): BaselineNormalizationResult {
  const rows = parseCsv(input.csv, input.delimiter ?? ",");
  if (rows.length < 2) throw new CustomerWorkOsV25Error("INVALID_IMPORT", "finance CSV requires a header and at least one data row");
  const headers = rows[0]!;
  const idx = {
    id: headerIndex(headers, ["id", "거래id", "거래번호", "transaction id"]),
    date: headerIndex(headers, ["일자", "거래일", "date", "실제 처리일"]),
    type: headerIndex(headers, ["구분", "거래구분", "type", "direction"]),
    net: headerIndex(headers, ["공급가액", "금액", "net", "net amount"]),
    vat: headerIndex(headers, ["부가세", "vat"]),
    gross: headerIndex(headers, ["합계", "합계금액", "총액", "gross", "gross amount"]),
    account: headerIndex(headers, ["거래처", "고객", "공급사", "account"]),
    project: headerIndex(headers, ["프로젝트", "프로젝트id", "project", "project key"]),
    memo: headerIndex(headers, ["적요", "메모", "내용", "memo", "description"]),
    status: headerIndex(headers, ["상태", "status"]),
  };
  if (idx.net < 0 && idx.gross < 0) throw new CustomerWorkOsV25Error("INVALID_IMPORT", "finance CSV requires an amount column");
  const warnings: BaselineNormalizationResult["warnings"] = [];
  const records: BaselineSourceRecord[] = [];
  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index]!;
    const id = cell(row, idx.id) ?? `row-${index}`;
    const net = moneyString(cell(row, idx.net));
    const vat = moneyString(cell(row, idx.vat));
    const gross = moneyString(cell(row, idx.gross));
    if (!net && !gross) {
      warnings.push({ row: index + 1, code: "AMOUNT_INVALID", message: "Finance row amount could not be parsed" });
      continue;
    }
    const type = normalizeText(cell(row, idx.type) ?? "");
    const direction = /매입|지급|출금|비용|out|debit/.test(type) ? "OUT" : /매출|수금|입금|in|credit/.test(type) ? "IN" : "UNKNOWN";
    const data: Record<string, unknown> = {
      transactionId: id,
      direction,
      netAmountKrw: net,
      vatAmountKrw: vat,
      grossAmountKrw: gross ?? (net && vat ? (BigInt(net) + BigInt(vat)).toString() : net),
      date: cell(row, idx.date),
      accountName: cell(row, idx.account),
      projectKey: cell(row, idx.project),
      memo: cell(row, idx.memo),
      status: cell(row, idx.status),
    };
    records.push(makeRecord({
      workspaceId: input.workspaceId,
      sourceSystem: "CSV",
      sourceRef: `csv://${required(input.sourceName, "sourceName")}/${id}`,
      kind: "FINANCIAL_ITEM",
      occurredAt: cell(row, idx.date),
      data,
      confidence: direction === "UNKNOWN" ? 0.65 : 0.94,
      idHint: id,
    }));
  }
  return { records, snapshotHash: deterministicHash(records), warnings };
}

export function normalizeGenericJson(input: {
  workspaceId: string;
  sourceName: string;
  kind: BaselineRecordKind;
  rows: unknown;
}): BaselineNormalizationResult {
  const rows = objectArray(input.rows, "rows");
  const records = rows.map((row, index) => {
    const id = stringValue(row.id) ?? `row-${index + 1}`;
    return makeRecord({
      workspaceId: input.workspaceId,
      sourceSystem: "MANUAL",
      sourceRef: `manual://${required(input.sourceName, "sourceName")}/${id}`,
      kind: input.kind,
      occurredAt: stringValue(row.occurredAt) ?? stringValue(row.date),
      data: row,
      confidence: 0.85,
      idHint: id,
    });
  });
  return { records, snapshotHash: deterministicHash(records), warnings: [] };
}

export function normalizeBaselineImport(input: {
  workspaceId: string;
  type: BaselineImportType;
  sourceName: string;
  content: unknown;
  kind?: BaselineRecordKind;
  delimiter?: string;
}): BaselineNormalizationResult {
  switch (input.type) {
    case "NOTION_JSON":
      return normalizeNotionRows({
        workspaceId: input.workspaceId,
        databaseId: input.sourceName,
        kind: input.kind ?? "ENGAGEMENT",
        rows: input.content,
      });
    case "EMAIL_JSON":
      return normalizeEmailMessages({
        workspaceId: input.workspaceId,
        provider: normalizeText(input.sourceName).includes("outlook") ? "OUTLOOK" : "GMAIL",
        messages: input.content,
      });
    case "CALENDAR_JSON":
      return normalizeCalendarEvents({ workspaceId: input.workspaceId, calendarId: input.sourceName, events: input.content });
    case "FINANCE_CSV":
      if (typeof input.content !== "string") throw new CustomerWorkOsV25Error("INVALID_IMPORT", "finance CSV content must be text");
      return normalizeFinanceCsv({ workspaceId: input.workspaceId, sourceName: input.sourceName, csv: input.content, ...(input.delimiter ? { delimiter: input.delimiter } : {}) });
    case "GENERIC_JSON":
      return normalizeGenericJson({ workspaceId: input.workspaceId, sourceName: input.sourceName, kind: input.kind ?? "ACTIVITY", rows: input.content });
  }
}
