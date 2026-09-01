//! Keystroke to terminal input bytes.
//!
//! Plain printable keys are not mapped here: they arrive through GPUI's
//! text input handler so IME, dead keys and Option-composed characters work.
//! This covers everything else — control keys, arrows, function keys,
//! editing keys — following the xterm control sequences.

use gpui::Keystroke;

/// Modes that change what a key sends.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct KeyModes {
    /// DECCKM: arrows and Home/End use the SS3 form.
    pub app_cursor: bool,
    /// Kitty keyboard protocol is active, so Shift+Enter can be disambiguated.
    pub disambiguate: bool,
}

/// Translate a keystroke to the bytes a terminal sends for it, if any.
///
/// `option_as_meta` makes Alt+letter send `ESC letter` on macOS, where Alt
/// otherwise composes characters. Returns `None` for keys the text input
/// path should handle, and for Command combinations, which belong to the app.
pub fn key_to_bytes(ks: &Keystroke, modes: KeyModes, option_as_meta: bool) -> Option<Vec<u8>> {
    let m = &ks.modifiers;
    if m.platform {
        return None;
    }
    let key = ks.key.as_str();
    let plain = !m.control && !m.alt && !m.shift;

    // Keys whose plain form is fixed.
    if plain {
        let bytes: Option<&[u8]> = match key {
            "enter" => Some(b"\r"),
            "tab" => Some(b"\t"),
            "escape" => Some(b"\x1b"),
            "backspace" | "back" => Some(b"\x7f"),
            "delete" => Some(b"\x1b[3~"),
            "insert" => Some(b"\x1b[2~"),
            "pageup" => Some(b"\x1b[5~"),
            "pagedown" => Some(b"\x1b[6~"),
            "f1" => Some(b"\x1bOP"),
            "f2" => Some(b"\x1bOQ"),
            "f3" => Some(b"\x1bOR"),
            "f4" => Some(b"\x1bOS"),
            _ => None,
        };
        if let Some(bytes) = bytes {
            return Some(bytes.to_vec());
        }
        if let Some(letter) = cursor_key_letter(key) {
            let prefix: &[u8] = if modes.app_cursor { b"\x1bO" } else { b"\x1b[" };
            let mut out = prefix.to_vec();
            out.push(letter);
            return Some(out);
        }
        if let Some(code) = tilde_key_code(key) {
            return Some(format!("\x1b[{code}~").into_bytes());
        }
        return None;
    }

    // Special cases with modifiers.
    match (key, m.control, m.alt, m.shift) {
        ("enter", false, false, true) => {
            return Some(if modes.disambiguate { b"\x1b[13;2u".to_vec() } else { b"\x1b\r".to_vec() });
        }
        ("enter", false, true, false) => return Some(b"\x1b\r".to_vec()),
        ("tab", false, false, true) => return Some(b"\x1b[Z".to_vec()),
        ("backspace", true, false, _) => return Some(b"\x08".to_vec()),
        ("backspace", false, true, _) => return Some(b"\x1b\x7f".to_vec()),
        ("backspace", false, false, true) => return Some(b"\x7f".to_vec()),
        ("space", true, false, _) => return Some(b"\x00".to_vec()),
        _ => {}
    }

    // Modified navigation and function keys: CSI 1;{mod}X or CSI {code};{mod}~
    let modifier = modifier_code(ks);
    if let Some(letter) = cursor_key_letter(key) {
        return Some(format!("\x1b[1;{modifier}{}", letter as char).into_bytes());
    }
    if let Some(letter) = f1_to_f4_letter(key) {
        return Some(format!("\x1b[1;{modifier}{}", letter as char).into_bytes());
    }
    if let Some(code) = tilde_key_code(key).or(match key {
        "insert" => Some(2),
        "delete" => Some(3),
        "pageup" => Some(5),
        "pagedown" => Some(6),
        _ => None,
    }) {
        return Some(format!("\x1b[{code};{modifier}~").into_bytes());
    }

    // Single-character keys with Control and/or Alt.
    let ch = single_char(key)?;
    if m.control {
        let ctrl = control_byte(ch)?;
        return Some(if m.alt && (option_as_meta || !cfg!(target_os = "macos")) {
            vec![0x1b, ctrl]
        } else {
            vec![ctrl]
        });
    }
    if m.alt && (option_as_meta || !cfg!(target_os = "macos")) {
        let ch = if m.shift { ch.to_ascii_uppercase() } else { ch };
        let mut out = vec![0x1b];
        let mut buf = [0u8; 4];
        out.extend_from_slice(ch.encode_utf8(&mut buf).as_bytes());
        return Some(out);
    }
    None
}

/// The final byte of a cursor-key sequence.
fn cursor_key_letter(key: &str) -> Option<u8> {
    Some(match key {
        "up" => b'A',
        "down" => b'B',
        "right" => b'C',
        "left" => b'D',
        "home" => b'H',
        "end" => b'F',
        _ => return None,
    })
}

fn f1_to_f4_letter(key: &str) -> Option<u8> {
    Some(match key {
        "f1" => b'P',
        "f2" => b'Q',
        "f3" => b'R',
        "f4" => b'S',
        _ => return None,
    })
}

/// The numeric code for `CSI code ~` keys (F5 and up).
fn tilde_key_code(key: &str) -> Option<u32> {
    Some(match key {
        "f5" => 15,
        "f6" => 17,
        "f7" => 18,
        "f8" => 19,
        "f9" => 20,
        "f10" => 21,
        "f11" => 23,
        "f12" => 24,
        "f13" => 25,
        "f14" => 26,
        "f15" => 28,
        "f16" => 29,
        "f17" => 31,
        "f18" => 32,
        "f19" => 33,
        "f20" => 34,
        _ => return None,
    })
}

/// xterm's modifier parameter: 1 + (shift:1, alt:2, ctrl:4).
fn modifier_code(ks: &Keystroke) -> u32 {
    let m = &ks.modifiers;
    1 + (m.shift as u32) + ((m.alt as u32) << 1) + ((m.control as u32) << 2)
}

fn single_char(key: &str) -> Option<char> {
    if key == "space" {
        return Some(' ');
    }
    let mut chars = key.chars();
    let ch = chars.next()?;
    chars.next().is_none().then_some(ch)
}

/// The C0 byte for Control + `ch`, following the ASCII column rule.
fn control_byte(ch: char) -> Option<u8> {
    Some(match ch {
        'a'..='z' => (ch as u8) & 0x1f,
        'A'..='Z' => (ch.to_ascii_lowercase() as u8) & 0x1f,
        ' ' | '@' | '2' => 0x00,
        '[' | '3' => 0x1b,
        '\\' | '4' => 0x1c,
        ']' | '5' => 0x1d,
        '^' | '6' => 0x1e,
        '_' | '7' | '-' => 0x1f,
        '?' | '8' => 0x7f,
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::Modifiers;

    fn ks(key: &str, control: bool, alt: bool, shift: bool, platform: bool) -> Keystroke {
        Keystroke {
            modifiers: Modifiers { control, alt, shift, platform, function: false },
            key: key.to_string(),
            key_char: None,
        }
    }

    fn plain(key: &str) -> Keystroke {
        ks(key, false, false, false, false)
    }

    #[test]
    fn mapping_table() {
        let none = KeyModes::default();
        let app = KeyModes { app_cursor: true, ..KeyModes::default() };
        let cases: &[(Keystroke, KeyModes, &[u8])] = &[
            (plain("enter"), none, b"\r"),
            (plain("tab"), none, b"\t"),
            (plain("escape"), none, b"\x1b"),
            (plain("backspace"), none, b"\x7f"),
            (plain("delete"), none, b"\x1b[3~"),
            (plain("insert"), none, b"\x1b[2~"),
            (plain("pageup"), none, b"\x1b[5~"),
            (plain("pagedown"), none, b"\x1b[6~"),
            (plain("up"), none, b"\x1b[A"),
            (plain("down"), none, b"\x1b[B"),
            (plain("right"), none, b"\x1b[C"),
            (plain("left"), none, b"\x1b[D"),
            (plain("home"), none, b"\x1b[H"),
            (plain("end"), none, b"\x1b[F"),
            (plain("up"), app, b"\x1bOA"),
            (plain("left"), app, b"\x1bOD"),
            (plain("home"), app, b"\x1bOH"),
            (plain("end"), app, b"\x1bOF"),
            (plain("f1"), none, b"\x1bOP"),
            (plain("f4"), none, b"\x1bOS"),
            (plain("f5"), none, b"\x1b[15~"),
            (plain("f12"), none, b"\x1b[24~"),
            (ks("tab", false, false, true, false), none, b"\x1b[Z"),
            (ks("enter", false, false, true, false), none, b"\x1b\r"),
            (
                ks("enter", false, false, true, false),
                KeyModes { disambiguate: true, ..none },
                b"\x1b[13;2u",
            ),
            (ks("backspace", true, false, false, false), none, b"\x08"),
            (ks("backspace", false, true, false, false), none, b"\x1b\x7f"),
            (ks("space", true, false, false, false), none, b"\x00"),
            (ks("c", true, false, false, false), none, b"\x03"),
            (ks("z", true, false, false, false), none, b"\x1a"),
            (ks("a", true, false, true, false), none, b"\x01"),
            (ks("[", true, false, false, false), none, b"\x1b"),
            (ks("?", true, false, false, false), none, b"\x7f"),
            (ks("up", false, false, true, false), none, b"\x1b[1;2A"),
            (ks("left", true, false, false, false), none, b"\x1b[1;5D"),
            (ks("right", true, true, true, false), none, b"\x1b[1;8C"),
            (ks("delete", false, false, true, false), none, b"\x1b[3;2~"),
            (ks("f5", false, false, true, false), none, b"\x1b[15;2~"),
            (ks("f1", true, false, false, false), none, b"\x1b[1;5P"),
            (ks("home", false, true, false, false), none, b"\x1b[1;3H"),
        ];
        for (keystroke, modes, expected) in cases {
            let got = key_to_bytes(keystroke, *modes, false);
            assert_eq!(
                got.as_deref(),
                Some(*expected),
                "{keystroke:?} with {modes:?}"
            );
        }
    }

    #[test]
    fn printable_keys_are_left_to_text_input() {
        assert_eq!(key_to_bytes(&plain("a"), KeyModes::default(), false), None);
        assert_eq!(key_to_bytes(&plain("space"), KeyModes::default(), false), None);
        assert_eq!(key_to_bytes(&ks("a", false, false, true, false), KeyModes::default(), false), None);
        assert_eq!(key_to_bytes(&plain("🖖"), KeyModes::default(), false), None);
    }

    #[test]
    fn command_combinations_belong_to_the_app() {
        assert_eq!(key_to_bytes(&ks("c", false, false, false, true), KeyModes::default(), false), None);
        assert_eq!(key_to_bytes(&ks("left", false, false, false, true), KeyModes::default(), false), None);
    }

    #[test]
    fn alt_letter_is_meta_when_asked() {
        let alt_b = ks("b", false, true, false, false);
        assert_eq!(key_to_bytes(&alt_b, KeyModes::default(), true).as_deref(), Some(&b"\x1bb"[..]));
        let alt_shift_b = ks("b", false, true, true, false);
        assert_eq!(
            key_to_bytes(&alt_shift_b, KeyModes::default(), true).as_deref(),
            Some(&b"\x1bB"[..])
        );
        let ctrl_alt_a = ks("a", true, true, false, false);
        assert_eq!(
            key_to_bytes(&ctrl_alt_a, KeyModes::default(), true).as_deref(),
            Some(&b"\x1b\x01"[..])
        );
        if cfg!(target_os = "macos") {
            // Without option-as-meta, Option composes a character instead.
            assert_eq!(key_to_bytes(&alt_b, KeyModes::default(), false), None);
        }
    }
}
