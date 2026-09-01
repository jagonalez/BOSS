//! Cards an agent can put in a room, written as plain text. Port of
//! `src/shared/room-cards.ts`.
//!
//! Agents write text, so a card has to be something they can type. A fenced
//! `boss-card` block is the whole contract: a kind, a title, some lines, and
//! at most two things the user can do. An unparseable block stays exactly as
//! written rather than disappearing.

use crate::ids::ThreadId;
use serde::{Deserialize, Serialize};

/// What a card is for.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CardKind {
    /// Something to approve before work goes further.
    Gate,
    /// Something only the user can decide.
    Attention,
    /// What is agreed, or what happened against it.
    Plan,
    /// Anything else worth setting apart from the prose.
    Note,
}

impl CardKind {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "gate" => Some(CardKind::Gate),
            "attention" => Some(CardKind::Attention),
            "plan" => Some(CardKind::Plan),
            "note" => Some(CardKind::Note),
            _ => None,
        }
    }
}

/// A thread a card points at, so BOSS can quote a room and let the user
/// open it rather than describing where to look.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CardLink {
    /// What the link says.
    pub label: String,
    /// The thread it opens.
    pub thread_id: ThreadId,
}

/// A parsed card.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RoomCard {
    /// What the card is for.
    pub kind: CardKind,
    /// The heading. A card without one is not a card.
    pub title: String,
    /// Body lines, in the order written.
    pub lines: Vec<String>,
    /// At most two: one way forward and one way out.
    pub actions: Vec<String>,
    /// A thread this card points at.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub link: Option<CardLink>,
}

/// Read a card out of a fenced block, or nothing. Nothing is the important
/// case: a malformed card must still be readable, so the caller leaves the
/// text alone rather than swallowing it.
pub fn parse_card(body: &str) -> Option<RoomCard> {
    let mut kind = CardKind::Note;
    let mut title = String::new();
    let mut rest = Vec::new();
    let mut actions = Vec::new();
    let mut link = None;

    for line in body
        .split('\n')
        .map(str::trim)
        .filter(|line| !line.is_empty())
    {
        let (head, tail) = line.split_once(':').unwrap_or((line, ""));
        let key = head.trim().to_lowercase();
        let value = tail.trim();
        match key.as_str() {
            // An unknown kind is a body line, not a refusal.
            "kind" => match CardKind::parse(value) {
                Some(known) => kind = known,
                None => rest.push(line.to_owned()),
            },
            "title" if !value.is_empty() => title = value.to_owned(),
            // Capped rather than refused: a card with five buttons is still a
            // card, and dropping it over one extra would lose the message.
            "do" if !value.is_empty() => {
                if actions.len() < 2 {
                    actions.push(value.to_owned());
                }
            }
            "open" if !value.is_empty() => {
                if let Some(at) = value.rfind('@').filter(|at| *at > 0) {
                    link = Some(CardLink {
                        label: value[..at].trim().to_owned(),
                        thread_id: ThreadId::from(value[at + 1..].trim()),
                    });
                }
            }
            _ => rest.push(line.to_owned()),
        }
    }

    if title.is_empty() {
        return None;
    }
    Some(RoomCard {
        kind,
        title,
        lines: rest,
        actions,
        link,
    })
}

/// One piece of a message: prose, or a card.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum CardSegment {
    /// Prose, exactly as written.
    Text(String),
    /// A card that parsed.
    Card(RoomCard),
}

impl CardSegment {
    /// The card, if this segment is one.
    pub fn card(&self) -> Option<&RoomCard> {
        match self {
            CardSegment::Card(card) => Some(card),
            CardSegment::Text(_) => None,
        }
    }

    /// The prose, if this segment is text.
    pub fn text(&self) -> Option<&str> {
        match self {
            CardSegment::Text(text) => Some(text),
            CardSegment::Card(_) => None,
        }
    }
}

/// Split a message into prose and cards, keeping their order. An agent
/// explains a card before or after it; reordering would separate the two.
pub fn split_cards(text: &str) -> Vec<CardSegment> {
    const OPEN: &str = "```boss-card\n";
    const CLOSE: &str = "```";
    let mut segments = Vec::new();
    let mut last = 0;
    let mut search = 0;
    while let Some(offset) = text[search..].find(OPEN) {
        let start = search + offset;
        let body_start = start + OPEN.len();
        let Some(body_len) = text[body_start..].find(CLOSE) else {
            break;
        };
        let end = body_start + body_len + CLOSE.len();
        search = end;
        let Some(card) = parse_card(&text[body_start..body_start + body_len]) else {
            continue;
        };
        let before = &text[last..start];
        if !before.trim().is_empty() {
            segments.push(CardSegment::Text(before.to_owned()));
        }
        segments.push(CardSegment::Card(card));
        last = end;
    }
    if segments.is_empty() {
        return vec![CardSegment::Text(text.to_owned())];
    }
    let after = &text[last..];
    if !after.trim().is_empty() {
        segments.push(CardSegment::Text(after.to_owned()));
    }
    segments
}

/// How a marked body line renders.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LineMark {
    /// `✓` — done.
    Done,
    /// `≠` — off plan.
    Gap,
    /// `○` — waiting.
    Waiting,
}

/// How a body line renders: a marked row, or a paragraph.
pub fn line_mark(line: &str) -> (Option<LineMark>, &str) {
    if let Some(text) = line.strip_prefix("✓ ") {
        return (Some(LineMark::Done), text);
    }
    if let Some(text) = line.strip_prefix("≠ ") {
        return (Some(LineMark::Gap), text);
    }
    if let Some(text) = line.strip_prefix("○ ") {
        return (Some(LineMark::Waiting), text);
    }
    (None, line)
}

/// How an agent is told to write a card. Beside the parser so the two
/// cannot drift: a card that does not parse is silently just text.
pub const CARD_INSTRUCTIONS: &str = "When something needs a decision, an approval, or is a result worth setting apart, write a card instead of a paragraph:\n\
\n\
```boss-card\n\
kind: gate\n\
title: Ready to ship\n\
11 files changed · 3 new tests\n\
✓ 231 tests passed\n\
do: Ship it\n\
do: Hold\n\
open: Saved searches@<thread id>\n\
```\n\
\n\
kind is gate, attention, plan, or note. At most two `do:` lines — one way forward and one way out; more than that is a form, not a decision. A `do:` becomes a button that sends those exact words back as the user's reply, so phrase them as answers. `open:` links a thread by id, which is how you point at a room rather than describing where to look. Lines beginning ✓, ≠, or ○ render as done, off-plan, and waiting.";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_card_carries_a_kind_a_title_its_lines_and_what_to_do() {
        let card =
            parse_card("kind: gate\ntitle: Ready to ship\n11 files changed\ndo: Ship it\ndo: Hold")
                .expect("a card");
        assert_eq!(card.kind, CardKind::Gate);
        assert_eq!(card.title, "Ready to ship");
        assert_eq!(card.lines, vec!["11 files changed"]);
        assert_eq!(card.actions, vec!["Ship it", "Hold"]);
    }

    #[test]
    fn a_card_offers_at_most_two_things_to_do() {
        let card =
            parse_card("title: Pick\ndo: One\ndo: Two\ndo: Three\ndo: Four").expect("a card");
        assert_eq!(card.actions, vec!["One", "Two"]);
    }

    #[test]
    fn extra_actions_do_not_throw_the_whole_card_away() {
        let card = parse_card("title: Pick\ndo: One\ndo: Two\ndo: Three").expect("a card");
        assert_eq!(card.title, "Pick");
    }

    #[test]
    fn a_card_with_no_title_is_not_a_card() {
        assert_eq!(parse_card("kind: gate\nsome words"), None);
        assert_eq!(parse_card(""), None);
    }

    #[test]
    fn an_unknown_kind_falls_back_to_a_plain_note_rather_than_being_refused() {
        let card = parse_card("kind: explosion\ntitle: Something").expect("a card");
        assert_eq!(card.kind, CardKind::Note);
    }

    #[test]
    fn a_card_can_link_the_thread_it_names() {
        let card = parse_card("title: Reviewed\nopen: Saved searches@thread-42").expect("a card");
        assert_eq!(
            card.link,
            Some(CardLink {
                label: "Saved searches".into(),
                thread_id: ThreadId::from("thread-42")
            })
        );
    }

    #[test]
    fn a_link_with_no_thread_id_is_dropped_not_half_rendered() {
        let card = parse_card("title: Reviewed\nopen: Saved searches").expect("a card");
        assert_eq!(card.link, None);
    }

    #[test]
    fn a_message_with_no_card_is_left_exactly_as_written() {
        assert_eq!(
            split_cards("Just some prose."),
            vec![CardSegment::Text("Just some prose.".into())]
        );
    }

    #[test]
    fn prose_and_cards_keep_the_order_the_agent_wrote_them_in() {
        let segments = split_cards("Before.\n```boss-card\ntitle: A card\n```\nAfter.");
        assert_eq!(segments.len(), 3);
        assert!(segments[0].text().expect("text").contains("Before"));
        assert!(segments[1].card().is_some());
        assert!(segments[2].text().expect("text").contains("After"));
    }

    #[test]
    fn a_malformed_card_stays_visible_as_text() {
        let segments = split_cards("Look:\n```boss-card\nkind: gate\nno title here\n```");
        assert_eq!(segments.len(), 1);
        assert!(segments[0].text().expect("text").contains("no title here"));
    }

    #[test]
    fn two_cards_in_one_message_both_render() {
        let segments = split_cards("```boss-card\ntitle: One\n```\n```boss-card\ntitle: Two\n```");
        let titles: Vec<&str> = segments
            .iter()
            .filter_map(|s| s.card())
            .map(|c| c.title.as_str())
            .collect();
        assert_eq!(titles, vec!["One", "Two"]);
    }

    #[test]
    fn a_line_says_whether_it_is_done_off_plan_or_waiting() {
        assert_eq!(
            line_mark("✓ tests passed"),
            (Some(LineMark::Done), "tests passed")
        );
        assert_eq!(
            line_mark("≠ capped at 50"),
            (Some(LineMark::Gap), "capped at 50")
        );
        assert_eq!(
            line_mark("○ scroll position"),
            (Some(LineMark::Waiting), "scroll position")
        );
        assert_eq!(line_mark("just a line"), (None, "just a line"));
    }

    #[test]
    fn a_title_containing_a_colon_survives() {
        assert_eq!(
            parse_card("title: Ready: ship it").expect("a card").title,
            "Ready: ship it"
        );
    }

    #[test]
    fn what_an_agent_is_told_about_cards_is_a_card_this_parser_accepts() {
        let segments = split_cards(CARD_INSTRUCTIONS);
        let card = segments
            .iter()
            .find_map(|s| s.card())
            .expect("the instructions contain a card");
        assert_eq!(card.kind, CardKind::Gate);
        assert_eq!(card.title, "Ready to ship");
        assert_eq!(card.actions, vec!["Ship it", "Hold"]);
        assert_eq!(
            card.link.as_ref().map(|l| l.label.as_str()),
            Some("Saved searches")
        );
    }
}
