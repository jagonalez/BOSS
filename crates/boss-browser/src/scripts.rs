//! JavaScript injected into pages, ported verbatim from `src/main/browse.ts`.
//!
//! The snapshot tags every actionable element with a numbered ref attribute;
//! click and type then find their target by that attribute.

/// The attribute the snapshot stamps on elements and click/type look up.
pub const REF_ATTR: &str = "data-boss-agent-ref";

/// Upper bound on characters accepted by one `type_text` call.
pub const TYPE_LIMIT: usize = 8_000;

/// Returns an accessibility-style outline: url, title, visible text, and
/// numbered actionable elements with bounds. Evaluates to a JSON object.
pub const SNAPSHOT_JS: &str = r#"(() => {
      const visible = (element) => {
        const style = getComputedStyle(element)
        const rect = element.getBoundingClientRect()
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0
      }
      const label = (element) => {
        const labelledBy = element.getAttribute('aria-labelledby')
        const labelled = labelledBy ? labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ') : ''
        return (element.getAttribute('aria-label') || labelled || element.getAttribute('alt') || element.getAttribute('title') || element.getAttribute('placeholder') || element.textContent || element.value || '').replace(/\s+/g, ' ').trim().slice(0, 180)
      }
      const selector = 'a,button,input,textarea,select,summary,[role="button"],[role="link"],[role="checkbox"],[role="tab"],[contenteditable="true"],[tabindex]:not([tabindex="-1"])'
      const elements = [...document.querySelectorAll(selector)].filter(visible).slice(0, 250).map((element, index) => {
        const ref = 'e' + (index + 1)
        element.setAttribute('data-boss-agent-ref', ref)
        const rect = element.getBoundingClientRect()
        return {
          ref,
          tag: element.tagName.toLowerCase(),
          role: element.getAttribute('role') || '',
          name: label(element),
          type: element.getAttribute('type') || '',
          disabled: Boolean(element.disabled || element.getAttribute('aria-disabled') === 'true'),
          bounds: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }
        }
      })
      return {
        url: location.href,
        title: document.title,
        text: (document.body?.innerText || '').replace(/\n{3,}/g, '\n\n').slice(0, 18000),
        elements
      }
    })()"#;

fn json(value: impl serde::Serialize) -> String {
    serde_json::to_string(&value).expect("string/bool serialize")
}

/// Script that clicks the element carrying `ref_`. Evaluates to `{ok, ref}` or `{ok:false, error}`.
pub fn click_js(ref_: &str) -> String {
    format!(
        r#"(() => {{
      const ref = {ref}
      const element = [...document.querySelectorAll('[data-boss-agent-ref]')].find((item) => item.getAttribute('data-boss-agent-ref') === ref)
      if (!element) return {{ ok: false, error: 'Element ref not found. Take a fresh snapshot.' }}
      if (element.disabled || element.getAttribute('aria-disabled') === 'true') return {{ ok: false, error: 'Element is disabled.' }}
      element.scrollIntoView({{ block: 'center', inline: 'center' }})
      element.focus()
      element.click()
      return {{ ok: true, ref }}
    }})()"#,
        ref = json(ref_)
    )
}

/// Script that replaces the value of the element carrying `ref_` with `text`,
/// firing input/change and optionally submitting. Evaluates like [`click_js`].
pub fn type_js(ref_: &str, text: &str, submit: bool) -> String {
    format!(
        r#"(() => {{
      const ref = {ref}
      const text = {text}
      const submit = {submit}
      const element = [...document.querySelectorAll('[data-boss-agent-ref]')].find((item) => item.getAttribute('data-boss-agent-ref') === ref)
      if (!element) return {{ ok: false, error: 'Element ref not found. Take a fresh snapshot.' }}
      element.scrollIntoView({{ block: 'center', inline: 'center' }})
      element.focus()
      if (element.isContentEditable) {{
        element.textContent = text
      }} else if ('value' in element) {{
        const proto = Object.getPrototypeOf(element)
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
        if (setter) setter.call(element, text)
        else element.value = text
      }} else {{
        return {{ ok: false, error: 'Element is not editable.' }}
      }}
      element.dispatchEvent(new Event('input', {{ bubbles: true }}))
      element.dispatchEvent(new Event('change', {{ bubbles: true }}))
      if (submit) {{
        element.dispatchEvent(new KeyboardEvent('keydown', {{ key: 'Enter', code: 'Enter', bubbles: true }}))
        element.closest('form')?.requestSubmit()
        element.dispatchEvent(new KeyboardEvent('keyup', {{ key: 'Enter', code: 'Enter', bubbles: true }}))
      }}
      return {{ ok: true, ref }}
    }})()"#,
        ref = json(ref_),
        text = json(text),
        submit = json(submit)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scripts_are_non_empty_and_share_the_ref_attribute() {
        let click = click_js("e1");
        let typed = type_js("e1", "hello", false);
        for script in [SNAPSHOT_JS, &click, &typed] {
            assert!(!script.trim().is_empty());
            assert!(script.contains(REF_ATTR), "script must reference {REF_ATTR}");
        }
        assert!(SNAPSHOT_JS.contains(&format!("setAttribute('{REF_ATTR}'")));
    }

    #[test]
    fn arguments_are_json_escaped() {
        let click = click_js("e'1");
        assert!(click.contains(r#"const ref = "e'1""#));
        let typed = type_js("e2", "it's \"quoted\"\nnew line", true);
        assert!(typed.contains(r#"const text = "it's \"quoted\"\nnew line""#));
        assert!(typed.contains("const submit = true"));
        assert!(type_js("e2", "x", false).contains("const submit = false"));
    }

    #[test]
    fn snapshot_keeps_the_regexes_from_browse_ts() {
        assert!(SNAPSHOT_JS.contains(r"split(/\s+/)"));
        assert!(SNAPSHOT_JS.contains(r"replace(/\s+/g, ' ')"));
        assert!(SNAPSHOT_JS.contains(r"replace(/\n{3,}/g, '\n\n')"));
    }
}
