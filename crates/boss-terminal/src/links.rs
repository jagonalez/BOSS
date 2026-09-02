//! Finding URLs in terminal text so Cmd+click can open them.
//!
//! Two sources. A program can mark a run explicitly with OSC 8, which
//! alacritty records per cell; that always wins. Otherwise the visible row
//! is scanned for a plain URL. The scan is deliberately small: no regex
//! crate, no heuristics beyond a known scheme, so it never turns ordinary
//! prose into a link.

/// Schemes worth turning into a clickable link. Also the allow-list for
/// OSC 8 links, which arrive as arbitrary text from whatever the shell is
/// running: a program should not be able to make Cmd+click hand the OS a
/// `javascript:` or `vbscript:` URL.
pub const SCHEMES: [&str; 5] = ["https://", "http://", "file://", "mailto:", "ssh://"];

/// Characters that end a URL when they are the last thing on it. Prose puts
/// these after a link far more often than a URL ends with them.
const TRAILING: [char; 10] = ['.', ',', ':', ';', '!', '?', ')', ']', '}', '\''];

/// A URL found on one row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkSpan {
    /// First column of the URL, inclusive.
    pub start: usize,
    /// Last column of the URL, inclusive.
    pub end: usize,
    /// The URL itself.
    pub url: String,
}

impl LinkSpan {
    /// Does this span cover `col`?
    pub fn contains(&self, col: usize) -> bool {
        col >= self.start && col <= self.end
    }
}

/// Is this a URL BOSS is willing to hand to the OS?
pub fn is_openable(url: &str) -> bool {
    let url = url.trim();
    // Byte-wise, so a multibyte first character cannot panic a slice.
    SCHEMES.iter().any(|scheme| {
        url.len() > scheme.len() && url.as_bytes()[..scheme.len()].eq_ignore_ascii_case(scheme.as_bytes())
    })
}

/// Every URL on one row of text. `text` is one char per column, so byte
/// offsets are converted to columns before returning.
pub fn find_links(text: &str) -> Vec<LinkSpan> {
    let cols: Vec<char> = text.chars().collect();
    let mut out = Vec::new();
    let mut col = 0usize;
    while col < cols.len() {
        let Some(scheme_len) = scheme_at(&cols, col) else {
            col += 1;
            continue;
        };
        let mut end = col + scheme_len;
        while end < cols.len() && !is_boundary(cols[end]) {
            end += 1;
        }
        // The scheme alone is not a link.
        if end == col + scheme_len {
            col += scheme_len;
            continue;
        }
        // Drop punctuation that trails a link in prose, and any unbalanced
        // closer, so "(see https://x.dev/a)" links to ".../a".
        while end > col + scheme_len {
            let ch = cols[end - 1];
            let unbalanced = matches!(ch, ')' | ']' | '}')
                && count(&cols[col..end], opener_for(ch)) < count(&cols[col..end], ch);
            if TRAILING.contains(&ch) && (unbalanced || !matches!(ch, ')' | ']' | '}')) {
                end -= 1;
            } else {
                break;
            }
        }
        out.push(LinkSpan { start: col, end: end - 1, url: cols[col..end].iter().collect() });
        col = end;
    }
    out
}

/// The URL at `col` on this row, if any.
pub fn link_at(text: &str, col: usize) -> Option<String> {
    find_links(text).into_iter().find(|l| l.contains(col)).map(|l| l.url)
}

fn scheme_at(cols: &[char], col: usize) -> Option<usize> {
    // A scheme only starts a link at a word boundary, so "xhttps://" is not one.
    if col > 0 && !is_boundary(cols[col - 1]) {
        return None;
    }
    SCHEMES.iter().find(|scheme| starts_with(cols, col, scheme)).map(|scheme| scheme.len())
}

fn starts_with(cols: &[char], col: usize, needle: &str) -> bool {
    let needle: Vec<char> = needle.chars().collect();
    cols.len() >= col + needle.len()
        && cols[col..col + needle.len()].iter().zip(&needle).all(|(a, b)| a.eq_ignore_ascii_case(b))
}

fn is_boundary(ch: char) -> bool {
    ch.is_whitespace() || matches!(ch, '"' | '\'' | '<' | '>' | '`' | '|' | '\u{0}')
}

fn opener_for(closer: char) -> char {
    match closer {
        ')' => '(',
        ']' => '[',
        _ => '{',
    }
}

fn count(cols: &[char], ch: char) -> usize {
    cols.iter().filter(|c| **c == ch).count()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn urls(text: &str) -> Vec<String> {
        find_links(text).into_iter().map(|l| l.url).collect()
    }

    #[test]
    fn plain_urls_are_found_with_their_columns() {
        let spans = find_links("see https://boss.dev/docs now");
        assert_eq!(spans.len(), 1);
        assert_eq!(spans[0].url, "https://boss.dev/docs");
        assert_eq!((spans[0].start, spans[0].end), (4, 24));
        assert!(spans[0].contains(4) && spans[0].contains(24));
        assert!(!spans[0].contains(3) && !spans[0].contains(25));
    }

    #[test]
    fn several_schemes_and_several_links_on_a_row() {
        assert_eq!(
            urls("http://a.io https://b.io/x mailto:me@b.io file:///tmp/x ssh://h"),
            vec!["http://a.io", "https://b.io/x", "mailto:me@b.io", "file:///tmp/x", "ssh://h"]
        );
    }

    #[test]
    fn prose_punctuation_is_trimmed_but_real_url_characters_are_kept() {
        assert_eq!(urls("go to https://boss.dev/docs."), vec!["https://boss.dev/docs"]);
        assert_eq!(urls("(see https://boss.dev/a)"), vec!["https://boss.dev/a"]);
        // A balanced paren belongs to the URL, as in wiki links.
        assert_eq!(urls("https://en.wikipedia.org/wiki/Rust_(language)"), vec!["https://en.wikipedia.org/wiki/Rust_(language)"]);
        // Query strings and fragments survive.
        assert_eq!(urls("https://x.dev/a?b=1&c=2#frag"), vec!["https://x.dev/a?b=1&c=2#frag"]);
    }

    #[test]
    fn non_links_are_left_alone() {
        assert!(urls("just some words here").is_empty());
        assert!(urls("https://").is_empty(), "a bare scheme is not a link");
        assert!(urls("xhttps://a.io").is_empty(), "a scheme mid-word is not a link");
        assert!(urls("no scheme boss.dev/docs").is_empty());
    }

    #[test]
    fn link_at_resolves_a_click_column() {
        let row = "run https://boss.dev/x then stop";
        assert_eq!(link_at(row, 10).as_deref(), Some("https://boss.dev/x"));
        assert_eq!(link_at(row, 0), None);
        assert_eq!(link_at(row, 30), None);
    }

    #[test]
    fn only_known_schemes_are_openable() {
        assert!(is_openable("https://boss.dev"));
        assert!(is_openable("HTTPS://BOSS.DEV"));
        assert!(is_openable("  mailto:me@boss.dev  "));
        // A program printing an OSC 8 link must not get these opened.
        assert!(!is_openable("javascript:alert(1)"));
        assert!(!is_openable("vbscript:x"));
        assert!(!is_openable("data:text/html,<script>"));
        assert!(!is_openable("https://"), "a bare scheme has no target");
        assert!(!is_openable(""));
        // A multibyte leading character must not panic the byte compare.
        assert!(!is_openable("日本語https://x.dev"));
    }

    #[test]
    fn quotes_and_angle_brackets_bound_a_url() {
        assert_eq!(urls("\"https://a.io/x\" and <https://b.io/y>"), vec!["https://a.io/x", "https://b.io/y"]);
    }
}
