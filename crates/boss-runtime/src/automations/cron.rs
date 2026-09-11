//! Minimal five-field cron (minute hour day-of-month month day-of-week),
//! local time. Port of `src/main/cron.ts`.
//!
//! Supports `*`, numbers, ranges (`1-5`), steps (`*/15`, `1-30/5`), and
//! lists (`1,15,30`). Standard cron semantics: when both day-of-month and
//! day-of-week are restricted, a date matches if *either* field matches.
//!
//! Times are milliseconds since the Unix epoch, matching the on-disk format
//! the Electron app wrote.

use std::collections::HashSet;
use time::{Duration, OffsetDateTime, UtcOffset};

/// A parsed expression. Cheap to clone; built once per evaluation.
#[derive(Clone, Debug, PartialEq)]
pub struct CronSpec {
    minute: HashSet<u8>,
    hour: HashSet<u8>,
    dom: HashSet<u8>,
    month: HashSet<u8>,
    dow: HashSet<u8>,
    dom_restricted: bool,
    dow_restricted: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Field {
    Minute,
    Hour,
    Dom,
    Month,
    Dow,
}

impl Field {
    fn bounds(self) -> (u8, u8) {
        match self {
            Field::Minute => (0, 59),
            Field::Hour => (0, 23),
            Field::Dom => (1, 31),
            Field::Month => (1, 12),
            Field::Dow => (0, 7),
        }
    }

    fn name(self) -> &'static str {
        match self {
            Field::Minute => "minute",
            Field::Hour => "hour",
            Field::Dom => "dom",
            Field::Month => "month",
            Field::Dow => "dow",
        }
    }
}

fn parse_field(field: &str, name: Field) -> Result<HashSet<u8>, String> {
    let (min, max) = name.bounds();
    let mut values = HashSet::new();
    for part in field.split(',') {
        let mut halves = part.splitn(2, '/');
        let range_part = halves.next().unwrap_or("");
        let step_part = halves.next();
        let step: i64 = match step_part {
            None => 1,
            Some(text) => text.trim().parse().map_err(|_| format!("Invalid step in \"{part}\"."))?,
        };
        if step < 1 {
            return Err(format!("Invalid step in \"{part}\"."));
        }
        let (from, to): (i64, i64) = if range_part == "*" || range_part.is_empty() {
            (min as i64, max as i64)
        } else if let Some((a, b)) = range_part.split_once('-') {
            let a = a.trim().parse::<i64>().map_err(|_| out_of_range(part, name))?;
            let b = b.trim().parse::<i64>().map_err(|_| out_of_range(part, name))?;
            (a, b)
        } else {
            let a = range_part.trim().parse::<i64>().map_err(|_| out_of_range(part, name))?;
            // `5/2` means "from 5 to the end of the field, every 2"; a bare
            // `5` is just 5.
            (a, if step_part.is_some() { max as i64 } else { a })
        };
        if from < min as i64 || to > max as i64 || from > to {
            return Err(out_of_range(part, name));
        }
        let mut value = from;
        while value <= to {
            // Cron allows both 0 and 7 for Sunday.
            values.insert(if name == Field::Dow && value == 7 { 0 } else { value as u8 });
            value += step;
        }
    }
    Ok(values)
}

fn out_of_range(part: &str, name: Field) -> String {
    let (min, max) = name.bounds();
    format!("Value out of range in \"{part}\" ({} allows {min}-{max}).", name.name())
}

/// Parse a five-field expression, or explain why it is not one.
pub fn parse_cron(expression: &str) -> Result<CronSpec, String> {
    let fields: Vec<&str> = expression.split_whitespace().collect();
    if fields.len() != 5 {
        return Err("A cron expression needs 5 fields: minute hour day month weekday.".to_owned());
    }
    Ok(CronSpec {
        minute: parse_field(fields[0], Field::Minute)?,
        hour: parse_field(fields[1], Field::Hour)?,
        dom: parse_field(fields[2], Field::Dom)?,
        month: parse_field(fields[3], Field::Month)?,
        dow: parse_field(fields[4], Field::Dow)?,
        dom_restricted: fields[2] != "*",
        dow_restricted: fields[4] != "*",
    })
}

/// `None` when the expression is valid, the complaint otherwise.
pub fn cron_error(expression: &str) -> Option<String> {
    parse_cron(expression).err()
}

/// The machine's current UTC offset.
///
/// Read through `chrono` rather than `time`: `time` refuses to read the local
/// offset from a process that has already spawned threads, and BOSS always
/// has, so it would silently schedule every automation in UTC. Not cached —
/// the offset changes at a daylight-saving boundary, and a cached one would
/// slide every schedule by an hour twice a year.
pub fn local_offset() -> UtcOffset {
    let seconds = chrono::Local::now().offset().local_minus_utc();
    UtcOffset::from_whole_seconds(seconds).unwrap_or(UtcOffset::UTC)
}

fn matches(spec: &CronSpec, at: OffsetDateTime) -> bool {
    if !spec.minute.contains(&(at.minute())) {
        return false;
    }
    if !spec.hour.contains(&(at.hour())) {
        return false;
    }
    if !spec.month.contains(&(at.month() as u8)) {
        return false;
    }
    let dom_match = spec.dom.contains(&at.day());
    // `time` numbers Monday..Sunday as 0..6; cron numbers Sunday..Saturday as 0..6.
    let dow_match = spec.dow.contains(&(at.weekday().number_days_from_sunday()));
    if spec.dom_restricted && spec.dow_restricted {
        return dom_match || dow_match;
    }
    dom_match && dow_match
}

/// How far ahead `next_cron_time` will look before giving up: the TS version
/// used 400 days, which covers every yearly expression including Feb 29.
const HORIZON_DAYS: i64 = 400;

/// The next fire time strictly after `after` (epoch ms), or `None` if there
/// is none within ~13 months. Evaluated in `offset`.
pub fn next_cron_time_in(expression: &str, after: i64, offset: UtcOffset) -> Option<i64> {
    let spec = parse_cron(expression).ok()?;
    let start = OffsetDateTime::from_unix_timestamp_nanos((after as i128) * 1_000_000).ok()?.to_offset(offset);
    // Truncate to the minute, exactly like `cursor.setSeconds(0, 0)`.
    let mut cursor = start.replace_second(0).ok()?.replace_nanosecond(0).ok()?;
    let limit = after + HORIZON_DAYS * 24 * 60 * 60 * 1_000;
    loop {
        cursor += Duration::minutes(1);
        let stamp = (cursor.unix_timestamp_nanos() / 1_000_000) as i64;
        if matches(&spec, cursor) {
            return Some(stamp);
        }
        if stamp >= limit {
            return None;
        }
    }
}

/// `next_cron_time_in` in the machine's local zone.
pub fn next_cron_time(expression: &str, after: i64) -> Option<i64> {
    next_cron_time_in(expression, after, local_offset())
}

/// How many fire times fall in `(from, to]`. Capped so a long-closed app
/// cannot spend forever counting.
pub fn missed_cron_fires_in(expression: &str, from: i64, to: i64, cap: usize, offset: UtcOffset) -> usize {
    let mut count = 0;
    let mut cursor = from;
    while count < cap {
        match next_cron_time_in(expression, cursor, offset) {
            Some(next) if next <= to => {
                count += 1;
                cursor = next;
            }
            _ => break,
        }
    }
    count
}

/// `missed_cron_fires_in` in the machine's local zone, with the TS cap of 500.
pub fn missed_cron_fires(expression: &str, from: i64, to: i64) -> usize {
    missed_cron_fires_in(expression, from, to, 500, local_offset())
}

#[cfg(test)]
mod tests {
    use super::*;
    use time::macros::datetime;

    fn ms(at: OffsetDateTime) -> i64 {
        (at.unix_timestamp_nanos() / 1_000_000) as i64
    }

    #[test]
    fn rejects_wrong_field_count() {
        assert!(cron_error("* * * *").unwrap().contains("5 fields"));
        assert!(cron_error("* * * * * *").unwrap().contains("5 fields"));
        assert!(cron_error("* * * * *").is_none());
    }

    #[test]
    fn rejects_out_of_range_and_bad_steps() {
        assert!(cron_error("60 * * * *").unwrap().contains("minute allows 0-59"));
        assert!(cron_error("* 24 * * *").unwrap().contains("hour allows 0-23"));
        assert!(cron_error("* * 0 * *").unwrap().contains("dom allows 1-31"));
        assert!(cron_error("*/0 * * * *").unwrap().contains("Invalid step"));
    }

    #[test]
    fn parses_lists_ranges_and_steps() {
        let spec = parse_cron("0,30 9-17 * * 1-5").unwrap();
        assert_eq!(spec.minute, HashSet::from([0, 30]));
        assert_eq!(spec.hour, (9..=17).collect());
        assert_eq!(spec.dow, HashSet::from([1, 2, 3, 4, 5]));
        let stepped = parse_cron("*/15 * * * *").unwrap();
        assert_eq!(stepped.minute, HashSet::from([0, 15, 30, 45]));
        // Sunday is both 0 and 7.
        assert_eq!(parse_cron("* * * * 7").unwrap().dow, HashSet::from([0]));
    }

    #[test]
    fn next_time_is_strictly_after() {
        // 2026-01-01 09:00:00 UTC, a Thursday.
        let at = ms(datetime!(2026-01-01 09:00:00 UTC));
        let next = next_cron_time_in("0 9 * * *", at, UtcOffset::UTC).unwrap();
        assert_eq!(next, ms(datetime!(2026-01-02 09:00:00 UTC)));
    }

    #[test]
    fn next_time_ignores_seconds_within_the_minute() {
        let at = ms(datetime!(2026-01-01 08:59:30 UTC));
        let next = next_cron_time_in("0 9 * * *", at, UtcOffset::UTC).unwrap();
        assert_eq!(next, ms(datetime!(2026-01-01 09:00:00 UTC)));
    }

    #[test]
    fn dom_and_dow_are_or_when_both_restricted() {
        // The 15th, or any Monday.
        let expr = "0 0 15 * 1";
        // 2026-01-01 is a Thursday.
        let at = ms(datetime!(2026-01-01 00:00:00 UTC));
        let first = next_cron_time_in(expr, at, UtcOffset::UTC).unwrap();
        // Monday 2026-01-05 comes before the 15th.
        assert_eq!(first, ms(datetime!(2026-01-05 00:00:00 UTC)));
    }

    #[test]
    fn dow_only_matches_every_such_weekday() {
        let at = ms(datetime!(2026-01-01 00:00:00 UTC));
        let next = next_cron_time_in("30 8 * * 0", at, UtcOffset::UTC).unwrap();
        // The first Sunday after 2026-01-01 is 2026-01-04.
        assert_eq!(next, ms(datetime!(2026-01-04 08:30:00 UTC)));
    }

    #[test]
    fn counts_missed_fires_between_two_times() {
        let from = ms(datetime!(2026-01-01 00:00:00 UTC));
        let to = ms(datetime!(2026-01-01 01:00:00 UTC));
        // Every 15 minutes: 00:15, 00:30, 00:45, 01:00.
        assert_eq!(missed_cron_fires_in("*/15 * * * *", from, to, 500, UtcOffset::UTC), 4);
    }

    #[test]
    fn missed_fires_respect_the_cap() {
        let from = ms(datetime!(2026-01-01 00:00:00 UTC));
        let to = ms(datetime!(2026-02-01 00:00:00 UTC));
        assert_eq!(missed_cron_fires_in("* * * * *", from, to, 10, UtcOffset::UTC), 10);
    }

    #[test]
    fn impossible_date_has_no_next_time() {
        // February 30th never comes.
        let at = ms(datetime!(2026-01-01 00:00:00 UTC));
        assert_eq!(next_cron_time_in("0 0 30 2 *", at, UtcOffset::UTC), None);
    }

    #[test]
    fn a_leap_day_is_found_within_the_horizon() {
        let at = ms(datetime!(2027-03-01 00:00:00 UTC));
        let next = next_cron_time_in("0 0 29 2 *", at, UtcOffset::UTC).unwrap();
        assert_eq!(next, ms(datetime!(2028-02-29 00:00:00 UTC)));
    }
}
