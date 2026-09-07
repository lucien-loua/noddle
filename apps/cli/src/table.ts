export function table(headers: string[], rows: string[][]): string {
  if (rows.length === 0) {
    return "(none)";
  }
  const all = [headers, ...rows];
  const widths = headers.map((_, column) =>
    Math.max(...all.map((row) => (row[column] ?? "").length))
  );
  return all
    .map((row) =>
      row
        .map((cell, column) =>
          column === row.length - 1
            ? cell
            : (cell ?? "").padEnd(widths[column] as number)
        )
        .join("  ")
        .trimEnd()
    )
    .join("\n");
}
