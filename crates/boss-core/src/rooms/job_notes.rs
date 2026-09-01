//! Job notes as a fresh agent reads them. Port of `src/shared/job-notes.ts`.

use super::room::JobNotes;

/// What a job agreed, decided, and changed, as text.
///
/// Shown to the user too, because this is a reviewer's whole brief: it reads
/// these notes and nothing else. Empty when nothing is recorded, rather than
/// a heading with nothing under it.
pub fn brief_of(notes: &JobNotes) -> String {
    let mut lines: Vec<String> = Vec::new();
    if !notes.agreed.is_empty() {
        lines.push("AGREED".to_owned());
        lines.extend(notes.agreed.iter().map(|item| format!("· {item}")));
    }
    if !notes.decided.is_empty() {
        if !lines.is_empty() {
            lines.push(String::new());
        }
        lines.push("DECIDED".to_owned());
        lines.extend(
            notes
                .decided
                .iter()
                .map(|item| format!("· {} ({})", item.text, item.by)),
        );
    }
    if !notes.changed.is_empty() {
        if !lines.is_empty() {
            lines.push(String::new());
        }
        lines.push("CHANGED".to_owned());
        lines.extend(notes.changed.iter().map(|item| format!("· {item}")));
    }
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ids::ParticipantId;
    use crate::rooms::room::JobDecision;
    use crate::rooms::room::tests::at;

    #[test]
    fn a_brief_holds_what_a_job_agreed_decided_and_changed() {
        let brief = brief_of(&JobNotes {
            agreed: vec!["inline warning, never an empty list".into()],
            decided: vec![JobDecision {
                text: "index stays in the existing layer".into(),
                at: at(5),
                by: ParticipantId::from("builder"),
            }],
            changed: vec!["11 files, 3 new tests".into()],
            updated_at: Some(at(9)),
        });
        assert!(brief.contains("AGREED"));
        assert!(brief.contains("inline warning, never an empty list"));
        assert!(brief.contains("index stays in the existing layer (builder)"));
        assert!(brief.contains("11 files, 3 new tests"));
    }

    #[test]
    fn a_job_with_nothing_recorded_has_an_empty_brief_not_a_bare_heading() {
        assert_eq!(brief_of(&JobNotes::default()), "");
    }

    #[test]
    fn a_brief_with_only_one_kind_of_entry_omits_the_other_headings() {
        let brief = brief_of(&JobNotes {
            agreed: vec!["no cap on saved searches".into()],
            ..JobNotes::default()
        });
        assert!(brief.contains("AGREED"));
        assert!(!brief.contains("DECIDED"));
        assert!(!brief.contains("CHANGED"));
    }
}
