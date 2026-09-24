export interface CsvRecord {
  /** The line the record starts on, counting the header as row 1, the way a spreadsheet numbers rows. */
  row: number;
  cells: string[];
}

export interface CsvProblem {
  row: number;
  message: string;
}

/**
 * Reads comma-separated text as a spreadsheet writes it: cells may be wrapped in double quotes,
 * a quoted cell may hold commas and line breaks, and "" inside quotes is one quote. Blank lines
 * are skipped. A cell that opens a quote and never closes it, or has text straight after its
 * closing quote, is reported with the row it starts on and that record is dropped.
 */
export function parseCsv(input: string): { records: CsvRecord[]; problems: CsvProblem[] } {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const records: CsvRecord[] = [];
  const problems: CsvProblem[] = [];

  let line = 1;
  let i = 0;
  while (i < text.length) {
    const startRow = line;
    const cells: string[] = [];
    let cell = "";
    let broken: string | null = null;
    let endOfRecord = false;

    while (!endOfRecord) {
      if (i < text.length && text[i] === '"' && cell === "") {
        i++;
        let closed = false;
        while (i < text.length) {
          const ch = text[i]!;
          if (ch === '"') {
            if (text[i + 1] === '"') {
              cell += '"';
              i += 2;
              continue;
            }
            i++;
            closed = true;
            break;
          }
          if (ch === "\n") line++;
          cell += ch;
          i++;
        }
        if (!closed) {
          broken ??= "a quoted cell never closes: add the missing closing quote";
          break;
        }
        // After a closing quote only a comma or the end of the line may follow.
        let tail = "";
        while (i < text.length && text[i] !== "," && text[i] !== "\n" && text[i] !== "\r") tail += text[i++];
        if (tail.trim() !== "") broken ??= "there is text after a closing quote: wrap the whole cell in quotes and double any quote inside it";
      } else {
        while (i < text.length && text[i] !== "," && text[i] !== "\n" && text[i] !== "\r") cell += text[i++];
      }

      cells.push(cell);
      cell = "";
      if (i >= text.length) {
        endOfRecord = true;
      } else if (text[i] === ",") {
        i++;
      } else {
        if (text[i] === "\r") i++;
        if (text[i] === "\n") i++;
        line++;
        endOfRecord = true;
      }
    }

    if (broken !== null) {
      problems.push({ row: startRow, message: broken });
      continue;
    }
    const blank = cells.length === 1 && cells[0]!.trim() === "";
    if (!blank) records.push({ row: startRow, cells });
  }
  return { records, problems };
}
