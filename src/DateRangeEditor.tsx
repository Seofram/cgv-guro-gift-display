import { Fragment, useRef, useState } from "react";

type Dates = { startDate: string; endDate: string };

export function DateRangeEditor({ dates, movie, invalid, onCommit }: {
  dates: Dates;
  movie: string;
  invalid: boolean;
  onCommit: (dates: Dates) => void;
}) {
  const [draft, setDraft] = useState<Dates | null>(null);
  const draftRef = useRef<Dates | null>(null);
  const dirty = useRef(false);
  const current = draft ?? dates;

  const finish = () => {
    const value = draftRef.current;
    draftRef.current = null;
    setDraft(null);
    if (value && dirty.current) onCommit(value);
    dirty.current = false;
  };

  return <div className="date-range"
    onFocus={() => {
      if (!draftRef.current) {
        draftRef.current = { startDate: dates.startDate, endDate: dates.endDate };
        setDraft(draftRef.current);
      }
    }}
    onBlur={(event) => {
      if (event.relatedTarget && event.currentTarget.contains(event.relatedTarget)) return;
      const container = event.currentTarget;
      // Native date subfields can report a null relatedTarget. Inspect settled focus,
      // without an elapsed-time assumption, before committing the entire range.
      queueMicrotask(() => {
        if (!container.contains(document.activeElement)) finish();
      });
    }}>
    {(["startDate", "endDate"] as const).map((key, index) => <Fragment key={key}>
      {index === 1 && <span aria-hidden="true">—</span>}
      <input type="date" aria-label={`${movie} ${index === 0 ? "시작일" : "종료일"}`}
        aria-invalid={invalid} value={current[key]}
        onChange={(event) => {
          const next = {
            startDate: draftRef.current?.startDate ?? dates.startDate,
            endDate: draftRef.current?.endDate ?? dates.endDate,
            [key]: event.target.value,
          };
          draftRef.current = next;
          dirty.current = true;
          setDraft(next);
        }} />
    </Fragment>)}
  </div>;
}
