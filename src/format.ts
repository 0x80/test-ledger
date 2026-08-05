/** Renders rows as an aligned table, or a stated absence. */
export function table(rows: readonly Record<string, unknown>[], emptyMessage: string): string {
  if (rows.length === 0) return emptyMessage

  const columns = Object.keys(rows[0] ?? {})
  const rendered = rows.map((row) => columns.map((column) => renderCell(row[column])))
  const widths = columns.map((column, index) =>
    Math.max(column.length, ...rendered.map((cells) => (cells[index] ?? '').length)),
  )

  const line = (cells: readonly string[]): string =>
    cells
      .map((cell, index) => cell.padEnd(widths[index] ?? 0))
      .join('  ')
      .trimEnd()

  return [
    line(columns),
    line(widths.map((width) => '-'.repeat(width))),
    ...rendered.map((cells) => line(cells)),
  ].join('\n')
}

/** Renders one cell: empty for a nullish value, three decimals for a non-integer. */
function renderCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(3)
  if (typeof value === 'string') return value
  if (typeof value === 'boolean' || typeof value === 'bigint') return String(value)
  return JSON.stringify(value) ?? ''
}
