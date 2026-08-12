/**
 * Minimal five-field cron (minute hour day-of-month month day-of-week), local time.
 * Supports: "*", numbers, ranges (1-5), steps (*\/15, 1-30/5), and lists (1,15,30).
 * Standard cron semantics: when both day-of-month and day-of-week are restricted,
 * a date matches if either field matches.
 */

interface CronSpec {
  minute: Set<number>
  hour: Set<number>
  dom: Set<number>
  month: Set<number>
  dow: Set<number>
  domRestricted: boolean
  dowRestricted: boolean
}

const BOUNDS = {
  minute: [0, 59],
  hour: [0, 23],
  dom: [1, 31],
  month: [1, 12],
  dow: [0, 7]
} as const

function parseField(field: string, name: keyof typeof BOUNDS): Set<number> {
  const [min, max] = BOUNDS[name]
  const values = new Set<number>()
  for (const part of field.split(',')) {
    const [rangePart, stepPart] = part.split('/')
    const step = stepPart === undefined ? 1 : Number(stepPart)
    if (!Number.isInteger(step) || step < 1) throw new Error(`Invalid step in "${part}".`)
    let from: number
    let to: number
    if (rangePart === '*' || rangePart === '') {
      from = min
      to = max
    } else if (rangePart.includes('-')) {
      const [a, b] = rangePart.split('-').map(Number)
      from = a
      to = b
    } else {
      from = Number(rangePart)
      to = stepPart === undefined ? from : max
    }
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < min || to > max || from > to) {
      throw new Error(`Value out of range in "${part}" (${name} allows ${min}-${max}).`)
    }
    for (let value = from; value <= to; value += step) {
      values.add(name === 'dow' && value === 7 ? 0 : value)
    }
  }
  return values
}

export function parseCron(expression: string): CronSpec {
  const fields = expression.trim().split(/\s+/)
  if (fields.length !== 5) throw new Error('A cron expression needs 5 fields: minute hour day month weekday.')
  return {
    minute: parseField(fields[0], 'minute'),
    hour: parseField(fields[1], 'hour'),
    dom: parseField(fields[2], 'dom'),
    month: parseField(fields[3], 'month'),
    dow: parseField(fields[4], 'dow'),
    domRestricted: fields[2] !== '*',
    dowRestricted: fields[4] !== '*'
  }
}

export function cronError(expression: string): string | null {
  try {
    parseCron(expression)
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

function matches(spec: CronSpec, date: Date): boolean {
  if (!spec.minute.has(date.getMinutes())) return false
  if (!spec.hour.has(date.getHours())) return false
  if (!spec.month.has(date.getMonth() + 1)) return false
  const domMatch = spec.dom.has(date.getDate())
  const dowMatch = spec.dow.has(date.getDay())
  if (spec.domRestricted && spec.dowRestricted) return domMatch || dowMatch
  return domMatch && dowMatch
}

/** The next fire time strictly after `after`, or null if none within ~13 months. */
export function nextCronTime(expression: string, after: number): number | null {
  const spec = parseCron(expression)
  const cursor = new Date(after)
  cursor.setSeconds(0, 0)
  const limit = after + 400 * 24 * 60 * 60 * 1_000
  do {
    cursor.setMinutes(cursor.getMinutes() + 1)
    if (matches(spec, cursor)) return cursor.getTime()
  } while (cursor.getTime() < limit)
  return null
}

/** How many fire times fall in (from, to]. Capped to avoid unbounded work. */
export function missedCronFires(expression: string, from: number, to: number, cap = 500): number {
  let count = 0
  let cursor = from
  while (count < cap) {
    const next = nextCronTime(expression, cursor)
    if (next === null || next > to) break
    count += 1
    cursor = next
  }
  return count
}
