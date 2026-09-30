"use client";

import { useMemo, useState } from "react";
import { filterByQuery } from "./list-filter";

export interface RecordChip {
  text: string;
  tone?: "in" | "out";
}

export interface RecordItem {
  id: string;
  name: string;
  chips: RecordChip[];
  sub: string;
  amount?: string;
}

export function RecordList({
  items,
  placeholder,
  empty,
}: {
  items: RecordItem[];
  placeholder: string;
  empty: string;
}) {
  const [query, setQuery] = useState("");
  const visible = useMemo(() => {
    const indexes = new Set(filterByQuery(items.map((item) => item.name), query));
    return items.filter((_, index) => indexes.has(index));
  }, [items, query]);

  return (
    <div className="list-tools">
      <label className="search-label">
        <span className="visually-hidden">이름 검색</span>
        <input
          className="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={placeholder}
          type="search"
          enterKeyHint="search"
        />
      </label>
      {query.trim() ? <p className="meta">검색 {visible.length}건</p> : null}
      {visible.length === 0 ? <p className="empty">{empty}</p> : (
        <ul className="record-list">
          {visible.map((item) => (
            <li key={item.id}>
              <div className="record-row">
                <div className="record-main">
                  <div className="record-name">{item.name}</div>
                  <div className="record-sub">
                    {item.chips.map((chip) => (
                      <span className={chip.tone ? `chip chip-${chip.tone}` : "chip"} key={`${item.id}-${chip.text}`}>
                        {chip.text}
                      </span>
                    ))}
                    {item.sub ? <span className="record-subtext">{item.sub}</span> : null}
                  </div>
                </div>
                {item.amount ? (
                  <div className="record-amount">{item.amount}<span className="won">원</span></div>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
