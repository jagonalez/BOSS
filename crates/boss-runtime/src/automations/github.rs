//! GitHub webhook deliveries: which ones fire an automation, how they map
//! into prompt variables, and how they normalize into [`BossEvent`]s.
//!
//! Port of `src/shared/automation-trigger.ts` and
//! `src/shared/workflow-events.ts`. Pure, so the HTTP endpoint stays a thin
//! shell around these functions.

use super::types::*;
use serde_json::{Map, Value};
use std::collections::BTreeMap;

/// Per-value ceiling so one huge payload cannot flood the prompt.
const MAX_VARIABLE_LENGTH: usize = 2_000;

/// One delivery to BOSS's hook endpoint.
#[derive(Clone, Debug, PartialEq)]
pub struct GitHubDelivery {
    /// The `x-github-event` header value, e.g. `push`.
    pub event: String,
    /// The payload's `action`, e.g. `opened`. Absent for pushes.
    pub action: Option<String>,
    pub body: Map<String, Value>,
}

/// Parse a delivery, or `None` when it is not one BOSS can read.
pub fn parse_delivery(event_header: Option<&str>, body: &Value) -> Option<GitHubDelivery> {
    let event = event_header?.trim();
    if event.is_empty() {
        return None;
    }
    let body = body.as_object()?;
    let action = body.get("action").and_then(Value::as_str).map(str::to_owned);
    Some(GitHubDelivery { event: event.to_owned(), action, body: body.clone() })
}

/// `String(value)` as JavaScript does it, with `null`/absent as `""`.
fn str_of(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(other) => other.to_string(),
    }
}

fn record<'a>(value: Option<&'a Value>) -> Option<&'a Map<String, Value>> {
    value.and_then(Value::as_object)
}

fn field(body: &Map<String, Value>, object: &str, key: &str) -> String {
    str_of(record(body.get(object)).and_then(|o| o.get(key)))
}

/// `refs/heads/main` → `main`; anything else passes through untouched.
pub fn branch_from_ref(reference: &str) -> &str {
    reference.strip_prefix("refs/heads/").unwrap_or(reference)
}

fn repo_name(body: &Map<String, Value>) -> String {
    field(body, "repository", "full_name")
}

fn sender_name(body: &Map<String, Value>) -> String {
    field(body, "sender", "login")
}

fn delivery_branch(delivery: &GitHubDelivery) -> String {
    branch_from_ref(&str_of(delivery.body.get("ref"))).to_owned()
}

/// Whether this delivery may fire the given trigger.
///
/// Unsupported GitHub events never match — the endpoint exists for pushes
/// and pull requests only. A `None` trigger means the automation has no
/// webhook, so nothing fires it.
pub fn trigger_matches(trigger: Option<&AutomationWebhookTrigger>, delivery: &GitHubDelivery) -> bool {
    let Some(trigger) = trigger else { return false };
    let wants = |event: &str| trigger.events.is_empty() || trigger.events.iter().any(|e| e == event);
    let branch_ok = |actual: &str| trigger.branch.as_deref().filter(|b| !b.is_empty()).is_none_or(|b| b == actual);
    match delivery.event.as_str() {
        "push" => wants("push") && branch_ok(&delivery_branch(delivery)),
        "pull_request" => {
            let action = delivery.action.as_deref().unwrap_or("");
            if !PULL_REQUEST_ACTIONS.contains(&action) {
                return false;
            }
            if !wants("pull_request") {
                return false;
            }
            // A PR run is about work proposed against the base branch.
            let base = record(delivery.body.get("pull_request"))
                .and_then(|pr| pr.get("base"))
                .and_then(Value::as_object)
                .map(|base| str_of(base.get("ref")))
                .unwrap_or_default();
            branch_ok(&base)
        }
        _ => false,
    }
}

/// Flat variables a delivery exposes to the prompt via `{{name}}`.
pub fn payload_variables(delivery: &GitHubDelivery) -> BTreeMap<String, String> {
    let body = &delivery.body;
    let mut vars = BTreeMap::new();
    vars.insert("event".to_owned(), delivery.event.clone());
    vars.insert("action".to_owned(), delivery.action.clone().unwrap_or_default());
    vars.insert("repo".to_owned(), repo_name(body));
    vars.insert("sender".to_owned(), sender_name(body));
    match delivery.event.as_str() {
        "push" => {
            vars.insert("branch".to_owned(), delivery_branch(delivery));
            vars.insert("ref".to_owned(), str_of(body.get("ref")));
            vars.insert("pusher".to_owned(), field(body, "pusher", "name"));
            let commits = body.get("commits").and_then(Value::as_array).cloned().unwrap_or_default();
            vars.insert("commit_count".to_owned(), commits.len().to_string());
            let messages: Vec<String> = commits
                .iter()
                .map(|commit| first_line(&str_of(record(Some(commit)).and_then(|c| c.get("message")))))
                .filter(|line| !line.is_empty())
                .collect();
            vars.insert("commit_messages".to_owned(), messages.join("\n"));
            let head = commits
                .last()
                .map(|commit| first_line(&str_of(record(Some(commit)).and_then(|c| c.get("message")))))
                .unwrap_or_default();
            vars.insert("head_message".to_owned(), head);
        }
        "pull_request" => {
            let pr = record(body.get("pull_request")).cloned().unwrap_or_default();
            // GitHub puts the number on the envelope, not inside pull_request.
            let number = body.get("number").and_then(Value::as_i64).map(|n| n.to_string()).unwrap_or_default();
            vars.insert("pr_number".to_owned(), number);
            vars.insert("pr_title".to_owned(), str_of(pr.get("title")));
            vars.insert("pr_body".to_owned(), str_of(pr.get("body")));
            vars.insert("pr_author".to_owned(), sender_name(body));
            vars.insert("pr_branch".to_owned(), field(&pr, "head", "ref"));
            vars.insert("pr_base_branch".to_owned(), field(&pr, "base", "ref"));
            vars.insert("pr_url".to_owned(), str_of(pr.get("html_url")));
        }
        _ => {}
    }
    vars
}

fn first_line(text: &str) -> String {
    text.split('\n').next().unwrap_or("").to_owned()
}

/// Replace `{{name}}` placeholders with delivery variables. Unknown names
/// are left in place, so a typo is visible instead of silently empty.
pub fn template_prompt(prompt: &str, vars: &BTreeMap<String, String>) -> String {
    let mut out = String::with_capacity(prompt.len());
    let bytes = prompt.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'{' && i + 1 < bytes.len() && bytes[i + 1] == b'{' {
            if let Some(end) = prompt[i + 2..].find("}}") {
                let name = prompt[i + 2..i + 2 + end].trim();
                // The TS pattern is [A-Za-z0-9_.]+ ; anything else is not a
                // placeholder and passes through as literal text.
                if !name.is_empty()
                    && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.')
                {
                    match vars.get(name) {
                        Some(value) => out.push_str(&cap_length(value)),
                        None => out.push_str(&prompt[i..i + 2 + end + 2]),
                    }
                    i += 2 + end + 2;
                    continue;
                }
            }
        }
        // Push whole characters, never half of one.
        let ch = prompt[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

fn cap_length(value: &str) -> String {
    let mut used = 0;
    let mut out = String::new();
    for ch in value.chars() {
        let width = ch.len_utf16();
        if used + width > MAX_VARIABLE_LENGTH {
            out.push('…');
            return out;
        }
        used += width;
        out.push(ch);
    }
    out
}

/// One-line description of a delivery for cards and run history.
pub fn describe_delivery(delivery: &GitHubDelivery) -> String {
    let mut parts = vec![delivery.event.clone()];
    if delivery.event == "push" {
        parts.push(delivery_branch(delivery));
    }
    if delivery.event == "pull_request" {
        if let Some(number) = delivery.body.get("number").and_then(Value::as_i64) {
            parts.push(format!("#{number}"));
        }
        if let Some(action) = &delivery.action {
            parts.push(action.clone());
        }
    }
    let repo = repo_name(&delivery.body);
    if !repo.is_empty() {
        parts.push(repo);
    }
    parts.retain(|part| !part.is_empty());
    parts.join(" · ")
}

/// Map a delivery to a [`BossEvent`], or `None` for events BOSS does not
/// normalize. Types follow `github.<event>` with the payload's
/// discriminating fields flattened into `data` for subscription filters.
pub fn delivery_event(delivery: &GitHubDelivery, id: String, at: i64) -> Option<BossEvent> {
    let body = &delivery.body;
    let mut data = Map::new();
    data.insert("repo".into(), Value::String(repo_name(body)));
    data.insert("sender".into(), Value::String(sender_name(body)));
    if let Some(action) = &delivery.action {
        data.insert("action".into(), Value::String(action.clone()));
    }
    let num = |value: Option<&Value>| value.and_then(Value::as_i64).map(Value::from);
    // A missing number reads as '' in the TS, which filters compare as the
    // empty string.
    let num_or_blank = |value: Option<&Value>| num(value).unwrap_or_else(|| Value::String(String::new()));
    let kind = match delivery.event.as_str() {
        "push" => {
            let reference = str_of(body.get("ref"));
            data.insert("branch".into(), Value::String(branch_from_ref(&reference).to_owned()));
            data.insert("ref".into(), Value::String(reference));
            "github.push"
        }
        "pull_request" => {
            let pr = record(body.get("pull_request")).cloned().unwrap_or_default();
            let number = num(body.get("number")).or_else(|| num(pr.get("number")));
            data.insert("prNumber".into(), number.unwrap_or_else(|| Value::String(String::new())));
            data.insert("title".into(), Value::String(str_of(pr.get("title"))));
            data.insert("author".into(), Value::String(field(&pr, "user", "login")));
            data.insert("headBranch".into(), Value::String(field(&pr, "head", "ref")));
            data.insert("baseBranch".into(), Value::String(field(&pr, "base", "ref")));
            data.insert("url".into(), Value::String(str_of(pr.get("html_url"))));
            data.insert("merged".into(), Value::Bool(pr.get("merged") == Some(&Value::Bool(true))));
            data.insert("draft".into(), Value::Bool(pr.get("draft") == Some(&Value::Bool(true))));
            "github.pull_request"
        }
        "pull_request_review" => {
            let pr = record(body.get("pull_request")).cloned().unwrap_or_default();
            let review = record(body.get("review")).cloned().unwrap_or_default();
            data.insert("prNumber".into(), num_or_blank(pr.get("number")));
            data.insert("author".into(), Value::String(field(&review, "user", "login")));
            data.insert("state".into(), Value::String(str_of(review.get("state"))));
            data.insert("body".into(), Value::String(str_of(review.get("body"))));
            data.insert("url".into(), Value::String(str_of(review.get("html_url"))));
            data.insert("headBranch".into(), Value::String(field(&pr, "head", "ref")));
            "github.pull_request_review"
        }
        "pull_request_review_comment" => {
            let pr = record(body.get("pull_request")).cloned().unwrap_or_default();
            let comment = record(body.get("comment")).cloned().unwrap_or_default();
            data.insert("prNumber".into(), num_or_blank(pr.get("number")));
            data.insert("author".into(), Value::String(field(&comment, "user", "login")));
            data.insert("body".into(), Value::String(str_of(comment.get("body"))));
            data.insert("path".into(), Value::String(str_of(comment.get("path"))));
            data.insert("url".into(), Value::String(str_of(comment.get("html_url"))));
            data.insert("headBranch".into(), Value::String(field(&pr, "head", "ref")));
            "github.pull_request_review_comment"
        }
        "issue_comment" => {
            let issue = record(body.get("issue")).cloned().unwrap_or_default();
            let comment = record(body.get("comment")).cloned().unwrap_or_default();
            data.insert("issueNumber".into(), num_or_blank(issue.get("number")));
            data.insert("isPullRequest".into(), Value::Bool(issue.contains_key("pull_request")));
            data.insert("author".into(), Value::String(field(&comment, "user", "login")));
            data.insert("body".into(), Value::String(str_of(comment.get("body"))));
            data.insert("url".into(), Value::String(str_of(comment.get("html_url"))));
            "github.issue_comment"
        }
        "workflow_run" => {
            let run = record(body.get("workflow_run")).cloned().unwrap_or_default();
            data.insert("name".into(), Value::String(str_of(run.get("name"))));
            data.insert("status".into(), Value::String(str_of(run.get("status"))));
            data.insert("conclusion".into(), Value::String(str_of(run.get("conclusion"))));
            data.insert("branch".into(), Value::String(str_of(run.get("head_branch"))));
            data.insert("runId".into(), num_or_blank(run.get("id")));
            data.insert("attempt".into(), num_or_blank(run.get("run_attempt")));
            data.insert("url".into(), Value::String(str_of(run.get("html_url"))));
            "github.workflow_run"
        }
        "check_suite" => {
            let suite = record(body.get("check_suite")).cloned().unwrap_or_default();
            data.insert("status".into(), Value::String(str_of(suite.get("status"))));
            data.insert("conclusion".into(), Value::String(str_of(suite.get("conclusion"))));
            data.insert("branch".into(), Value::String(str_of(suite.get("head_branch"))));
            "github.check_suite"
        }
        _ => return None,
    };
    Some(BossEvent { id, kind: kind.to_owned(), at, project_path: None, data })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn delivery(event: &str, body: Value) -> GitHubDelivery {
        parse_delivery(Some(event), &body).unwrap()
    }

    #[test]
    fn parse_rejects_anything_that_is_not_an_object_with_a_header() {
        assert!(parse_delivery(None, &json!({})).is_none());
        assert!(parse_delivery(Some("  "), &json!({})).is_none());
        assert!(parse_delivery(Some("push"), &json!([])).is_none());
        assert!(parse_delivery(Some("push"), &json!("text")).is_none());
        let parsed = parse_delivery(Some(" push "), &json!({ "action": "opened" })).unwrap();
        assert_eq!(parsed.event, "push");
        assert_eq!(parsed.action.as_deref(), Some("opened"));
    }

    #[test]
    fn branch_from_ref_strips_only_the_heads_prefix() {
        assert_eq!(branch_from_ref("refs/heads/main"), "main");
        assert_eq!(branch_from_ref("refs/tags/v1"), "refs/tags/v1");
        assert_eq!(branch_from_ref("main"), "main");
    }

    #[test]
    fn a_push_fires_only_on_the_wanted_branch() {
        let push = delivery("push", json!({ "ref": "refs/heads/main" }));
        let any = AutomationWebhookTrigger { events: vec![], branch: None };
        assert!(trigger_matches(Some(&any), &push));
        let main = AutomationWebhookTrigger { events: vec!["push".into()], branch: Some("main".into()) };
        assert!(trigger_matches(Some(&main), &push));
        let dev = AutomationWebhookTrigger { events: vec!["push".into()], branch: Some("dev".into()) };
        assert!(!trigger_matches(Some(&dev), &push));
        // A trigger that only wants pull requests ignores a push.
        let prs = AutomationWebhookTrigger { events: vec!["pull_request".into()], branch: None };
        assert!(!trigger_matches(Some(&prs), &push));
        // No webhook, nothing fires.
        assert!(!trigger_matches(None, &push));
    }

    #[test]
    fn a_pull_request_fires_only_on_opened_and_reopened() {
        let body = json!({ "action": "opened", "pull_request": { "base": { "ref": "main" } } });
        let opened = delivery("pull_request", body.clone());
        let trigger = AutomationWebhookTrigger { events: vec![], branch: Some("main".into()) };
        assert!(trigger_matches(Some(&trigger), &opened));
        for action in ["synchronize", "closed", "labeled"] {
            let mut noisy = body.clone();
            noisy["action"] = json!(action);
            assert!(!trigger_matches(Some(&trigger), &delivery("pull_request", noisy)), "{action} is repo noise");
        }
        // It is the base branch that must match, not the head.
        let other = json!({ "action": "reopened", "pull_request": { "base": { "ref": "dev" } } });
        assert!(!trigger_matches(Some(&trigger), &delivery("pull_request", other)));
    }

    #[test]
    fn an_unsupported_event_never_matches() {
        let star = delivery("star", json!({}));
        let any = AutomationWebhookTrigger { events: vec![], branch: None };
        assert!(!trigger_matches(Some(&any), &star));
    }

    #[test]
    fn push_variables_summarize_the_commits() {
        let push = delivery(
            "push",
            json!({
                "ref": "refs/heads/main",
                "repository": { "full_name": "octo/hello" },
                "sender": { "login": "jeremy" },
                "pusher": { "name": "jeremy" },
                "commits": [
                    { "message": "first\nbody" },
                    { "message": "second" }
                ]
            }),
        );
        let vars = payload_variables(&push);
        assert_eq!(vars["branch"], "main");
        assert_eq!(vars["repo"], "octo/hello");
        assert_eq!(vars["commit_count"], "2");
        assert_eq!(vars["commit_messages"], "first\nsecond", "only the first line of each");
        assert_eq!(vars["head_message"], "second");
        assert_eq!(vars["pusher"], "jeremy");
    }

    #[test]
    fn pull_request_variables_take_the_number_from_the_envelope() {
        let pr = delivery(
            "pull_request",
            json!({
                "action": "opened",
                "number": 204,
                "sender": { "login": "jeremy" },
                "pull_request": {
                    "title": "Add the thing",
                    "body": "why",
                    "head": { "ref": "feature" },
                    "base": { "ref": "main" },
                    "html_url": "https://example.test/pr/204"
                }
            }),
        );
        let vars = payload_variables(&pr);
        assert_eq!(vars["pr_number"], "204");
        assert_eq!(vars["pr_title"], "Add the thing");
        assert_eq!(vars["pr_branch"], "feature");
        assert_eq!(vars["pr_base_branch"], "main");
        assert_eq!(vars["pr_author"], "jeremy");
    }

    #[test]
    fn templating_fills_known_names_and_leaves_typos_visible() {
        let vars: BTreeMap<String, String> =
            [("branch".to_owned(), "main".to_owned()), ("repo".to_owned(), "octo/hello".to_owned())].into();
        assert_eq!(template_prompt("Check {{branch}} on {{repo}}.", &vars), "Check main on octo/hello.");
        assert_eq!(template_prompt("Check {{ branch }}.", &vars), "Check main.", "whitespace is trimmed");
        assert_eq!(template_prompt("Check {{nope}}.", &vars), "Check {{nope}}.");
        assert_eq!(template_prompt("No braces here.", &vars), "No braces here.");
        // Not a placeholder shape: passes through as text.
        assert_eq!(template_prompt("{{ not a name }}", &vars), "{{ not a name }}");
    }

    #[test]
    fn templating_caps_a_huge_value() {
        let long = "x".repeat(5_000);
        let vars: BTreeMap<String, String> = [("pr_body".to_owned(), long)].into();
        let out = template_prompt("{{pr_body}}", &vars);
        assert!(out.ends_with('…'));
        assert_eq!(out.chars().filter(|c| *c == 'x').count(), MAX_VARIABLE_LENGTH);
    }

    #[test]
    fn templating_keeps_multibyte_text_intact() {
        let vars: BTreeMap<String, String> = [("who".to_owned(), "Ünicode".to_owned())].into();
        assert_eq!(template_prompt("héllo {{who}} — ok", &vars), "héllo Ünicode — ok");
    }

    #[test]
    fn a_delivery_describes_itself_in_one_line() {
        let push = delivery("push", json!({ "ref": "refs/heads/main", "repository": { "full_name": "octo/hello" } }));
        assert_eq!(describe_delivery(&push), "push · main · octo/hello");
        let pr = delivery(
            "pull_request",
            json!({ "action": "opened", "number": 7, "repository": { "full_name": "octo/hello" } }),
        );
        assert_eq!(describe_delivery(&pr), "pull_request · #7 · opened · octo/hello");
        // Nothing to say beyond the event name.
        assert_eq!(describe_delivery(&delivery("push", json!({}))), "push");
    }

    #[test]
    fn a_push_normalizes_into_a_boss_event() {
        let push = delivery(
            "push",
            json!({ "ref": "refs/heads/main", "repository": { "full_name": "octo/hello" }, "sender": { "login": "j" } }),
        );
        let event = delivery_event(&push, "e1".into(), 100).unwrap();
        assert_eq!(event.kind, "github.push");
        assert_eq!(event.at, 100);
        assert_eq!(event.data["branch"], "main");
        assert_eq!(event.data["repo"], "octo/hello");
        assert_eq!(event.data["sender"], "j");
    }

    #[test]
    fn a_workflow_run_normalizes_with_its_conclusion() {
        let run = delivery(
            "workflow_run",
            json!({
                "action": "completed",
                "workflow_run": {
                    "name": "CI", "status": "completed", "conclusion": "failure",
                    "head_branch": "feature", "id": 42, "run_attempt": 2,
                    "html_url": "https://example.test/run/42"
                }
            }),
        );
        let event = delivery_event(&run, "e1".into(), 1).unwrap();
        assert_eq!(event.kind, "github.workflow_run");
        assert_eq!(event.data["conclusion"], "failure");
        assert_eq!(event.data["branch"], "feature");
        assert_eq!(event.data["runId"], 42);
        assert_eq!(event.data["action"], "completed");
        // And it matches a filter written against those fields.
        let pattern = EventPattern {
            kind: "github.workflow_run".into(),
            project_path: None,
            filters: Some([("branch".to_owned(), json!("feature")), ("conclusion".to_owned(), json!("failure"))].into()),
        };
        assert!(matches_pattern(&pattern, &event));
    }

    #[test]
    fn an_issue_comment_says_whether_it_is_on_a_pull_request() {
        let on_pr = delivery(
            "issue_comment",
            json!({ "issue": { "number": 3, "pull_request": {} }, "comment": { "body": "hi", "user": { "login": "j" } } }),
        );
        let event = delivery_event(&on_pr, "e".into(), 1).unwrap();
        assert_eq!(event.data["isPullRequest"], true);
        assert_eq!(event.data["issueNumber"], 3);

        let on_issue =
            delivery("issue_comment", json!({ "issue": { "number": 4 }, "comment": { "body": "hi" } }));
        assert_eq!(delivery_event(&on_issue, "e".into(), 1).unwrap().data["isPullRequest"], false);
    }

    #[test]
    fn a_pull_request_event_flags_merged_and_draft() {
        let merged = delivery(
            "pull_request",
            json!({ "action": "closed", "number": 9, "pull_request": { "merged": true, "draft": false } }),
        );
        let event = delivery_event(&merged, "e".into(), 1).unwrap();
        assert_eq!(event.data["merged"], true);
        assert_eq!(event.data["draft"], false);
        assert_eq!(event.data["prNumber"], 9);
    }

    #[test]
    fn a_missing_number_becomes_the_empty_string_filters_can_match() {
        let review = delivery("pull_request_review", json!({ "review": { "state": "approved" } }));
        let event = delivery_event(&review, "e".into(), 1).unwrap();
        assert_eq!(event.data["prNumber"], "");
        assert_eq!(event.data["state"], "approved");
    }

    #[test]
    fn an_event_boss_does_not_normalize_yields_nothing() {
        assert!(delivery_event(&delivery("star", json!({})), "e".into(), 1).is_none());
        assert!(delivery_event(&delivery("fork", json!({})), "e".into(), 1).is_none());
    }
}
