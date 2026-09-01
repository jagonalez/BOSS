//! The six `boss_browser_*` bus tools: definitions (ported from `qa.ts`) and
//! argument parsing. No GPUI here so it is unit-testable.

use boss_core::BusTool;
use serde_json::{Value, json};

/// Names of the browser tools, in the order `qa.ts` lists them.
pub const BROWSER_TOOL_NAMES: [&str; 6] = [
    "boss_browser_tabs",
    "boss_browser_navigate",
    "boss_browser_snapshot",
    "boss_browser_screenshot",
    "boss_browser_click",
    "boss_browser_type",
];

/// Whether `name` is one of the browser tools.
pub fn is_browser_tool(name: &str) -> bool {
    BROWSER_TOOL_NAMES.contains(&name)
}

/// MCP definitions for the six browser tools, text taken from `qa.ts`.
pub fn browser_tool_definitions() -> Vec<BusTool> {
    let tab = json!({"type": "string"});
    let def = |name: &str, description: &str, properties: Value, required: &[&str]| BusTool {
        name: name.to_string(),
        description: description.to_string(),
        input_schema: json!({
            "type": "object",
            "properties": properties,
            "required": required,
            "additionalProperties": false
        }),
    };
    vec![
        def(
            "boss_browser_tabs",
            "Find out which web pages are open, and get the tabId every other browser tool needs. Start here whenever you want to look at a page. An empty list means the user has no browser open, so ask them to open one rather than assuming the page is unreachable.",
            json!({}),
            &[],
        ),
        def(
            "boss_browser_navigate",
            "Point an open browser tab at a URL, to reach a page that is not on screen yet. Needs Automatic QA. Snapshot afterwards to see what loaded.",
            json!({"tabId": tab, "url": {"type": "string"}}),
            &["tabId", "url"],
        ),
        def(
            "boss_browser_snapshot",
            "Read what a page actually says and what can be clicked on it. Use this to answer any question about a page, to check a change you made, or to find the element you are about to click or type into. Always available, no permission needed. Element refs stay valid until the page changes, so snapshot again after anything that reloads or navigates.",
            json!({"tabId": tab}),
            &["tabId"],
        ),
        def(
            "boss_browser_screenshot",
            "See how a page looks, rather than what it says. Use this for anything visual — layout, spacing, colour, whether something is cut off or overlapping — where the text alone would not tell you. Always available, no permission needed. For reading content or finding elements, boss_browser_snapshot is the better tool.",
            json!({"tabId": tab}),
            &["tabId"],
        ),
        def(
            "boss_browser_click",
            "Click something on a page, to walk through a flow or reach a state you cannot get to by looking. Takes a ref from boss_browser_snapshot, so snapshot first. Needs Automatic QA. Snapshot again afterwards: the click is not done until you have seen what it did.",
            json!({"tabId": tab, "ref": {"type": "string"}}),
            &["tabId", "ref"],
        ),
        def(
            "boss_browser_type",
            "Put text into a field on a page, to fill a form or search for something. Replaces what is there rather than appending. Takes a ref from boss_browser_snapshot, so snapshot first. Needs Automatic QA. Set submit to press Enter afterwards.",
            json!({"tabId": tab, "ref": {"type": "string"}, "text": {"type": "string"}, "submit": {"type": "boolean", "default": false}}),
            &["tabId", "ref", "text"],
        ),
    ]
}

/// A parsed browser tool call.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BrowserToolCall {
    /// `boss_browser_tabs`
    Tabs,
    /// `boss_browser_navigate`
    Navigate {
        /// Target tab.
        tab_id: String,
        /// Absolute http(s) URL to load.
        url: String,
    },
    /// `boss_browser_snapshot`
    Snapshot {
        /// Target tab.
        tab_id: String,
    },
    /// `boss_browser_screenshot`
    Screenshot {
        /// Target tab.
        tab_id: String,
    },
    /// `boss_browser_click`
    Click {
        /// Target tab.
        tab_id: String,
        /// Element ref from the last snapshot.
        ref_: String,
    },
    /// `boss_browser_type`
    Type {
        /// Target tab.
        tab_id: String,
        /// Element ref from the last snapshot.
        ref_: String,
        /// Replacement value.
        text: String,
        /// Press Enter / submit the form afterwards.
        submit: bool,
    },
}

impl BrowserToolCall {
    /// Parses `args` for tool `name`. `Ok(None)` when `name` is not a browser
    /// tool; `Err` names the missing argument, matching the old `stringArg`.
    pub fn parse(name: &str, args: &Value) -> Result<Option<Self>, String> {
        let string = |key: &str| -> Result<String, String> {
            match args.get(key) {
                Some(Value::String(s)) if !s.is_empty() => Ok(s.clone()),
                _ => Err(format!("{name} requires a \"{key}\" string argument.")),
            }
        };
        let text = |key: &str| -> Result<String, String> {
            match args.get(key) {
                Some(Value::String(s)) => Ok(s.clone()),
                _ => Err(format!("{name} requires a \"{key}\" string argument.")),
            }
        };
        let call = match name {
            "boss_browser_tabs" => Self::Tabs,
            "boss_browser_navigate" => Self::Navigate { tab_id: string("tabId")?, url: string("url")? },
            "boss_browser_snapshot" => Self::Snapshot { tab_id: string("tabId")? },
            "boss_browser_screenshot" => Self::Screenshot { tab_id: string("tabId")? },
            "boss_browser_click" => Self::Click { tab_id: string("tabId")?, ref_: string("ref")? },
            "boss_browser_type" => Self::Type {
                tab_id: string("tabId")?,
                ref_: string("ref")?,
                text: text("text")?,
                submit: args.get("submit").and_then(Value::as_bool).unwrap_or(false),
            },
            _ => return Ok(None),
        };
        Ok(Some(call))
    }

    /// The tab the call targets, if any.
    pub fn tab_id(&self) -> Option<&str> {
        match self {
            Self::Tabs => None,
            Self::Navigate { tab_id, .. }
            | Self::Snapshot { tab_id }
            | Self::Screenshot { tab_id }
            | Self::Click { tab_id, .. }
            | Self::Type { tab_id, .. } => Some(tab_id),
        }
    }

    /// Whether the call changes the page (needs Automatic QA in the old app).
    pub fn mutates(&self) -> bool {
        matches!(self, Self::Navigate { .. } | Self::Click { .. } | Self::Type { .. })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn definitions_cover_the_six_tools() {
        let defs = browser_tool_definitions();
        let names: Vec<&str> = defs.iter().map(|d| d.name.as_str()).collect();
        assert_eq!(names, BROWSER_TOOL_NAMES);
        for def in &defs {
            assert!(is_browser_tool(&def.name));
            assert_eq!(def.input_schema["type"], "object");
            assert_eq!(def.input_schema["additionalProperties"], false);
        }
        assert_eq!(defs[5].input_schema["required"], json!(["tabId", "ref", "text"]));
        assert!(!is_browser_tool("boss_computer"));
    }

    #[test]
    fn parses_all_six() {
        let p = |n: &str, a: Value| BrowserToolCall::parse(n, &a).unwrap().unwrap();
        assert_eq!(p("boss_browser_tabs", json!({})), BrowserToolCall::Tabs);
        assert_eq!(
            p("boss_browser_navigate", json!({"tabId": "t1", "url": "https://x.y"})),
            BrowserToolCall::Navigate { tab_id: "t1".into(), url: "https://x.y".into() }
        );
        assert_eq!(p("boss_browser_snapshot", json!({"tabId": "t1"})), BrowserToolCall::Snapshot { tab_id: "t1".into() });
        assert_eq!(p("boss_browser_screenshot", json!({"tabId": "t1"})), BrowserToolCall::Screenshot { tab_id: "t1".into() });
        assert_eq!(
            p("boss_browser_click", json!({"tabId": "t1", "ref": "e3"})),
            BrowserToolCall::Click { tab_id: "t1".into(), ref_: "e3".into() }
        );
        assert_eq!(
            p("boss_browser_type", json!({"tabId": "t1", "ref": "e3", "text": "hi", "submit": true})),
            BrowserToolCall::Type { tab_id: "t1".into(), ref_: "e3".into(), text: "hi".into(), submit: true }
        );
        // submit defaults to false and empty text is allowed (clearing a field)
        assert_eq!(
            p("boss_browser_type", json!({"tabId": "t1", "ref": "e3", "text": ""})),
            BrowserToolCall::Type { tab_id: "t1".into(), ref_: "e3".into(), text: String::new(), submit: false }
        );
    }

    #[test]
    fn missing_or_wrong_args_are_errors() {
        let err = BrowserToolCall::parse("boss_browser_navigate", &json!({"tabId": "t1"})).unwrap_err();
        assert!(err.contains("url"));
        let err = BrowserToolCall::parse("boss_browser_click", &json!({"tabId": "t1", "ref": 3})).unwrap_err();
        assert!(err.contains("ref"));
        let err = BrowserToolCall::parse("boss_browser_snapshot", &json!({"tabId": ""})).unwrap_err();
        assert!(err.contains("tabId"));
        assert_eq!(BrowserToolCall::parse("boss_computer", &json!({})), Ok(None));
    }

    #[test]
    fn classifies_mutation_and_target() {
        let call = BrowserToolCall::parse("boss_browser_click", &json!({"tabId": "t9", "ref": "e1"})).unwrap().unwrap();
        assert!(call.mutates());
        assert_eq!(call.tab_id(), Some("t9"));
        assert!(!BrowserToolCall::Tabs.mutates());
        assert_eq!(BrowserToolCall::Tabs.tab_id(), None);
    }
}
