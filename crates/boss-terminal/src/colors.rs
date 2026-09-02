//! Terminal colours: the 16 ANSI colours, the 256-colour cube, and the
//! theme-derived defaults for text, background, cursor and selection.

use alacritty_terminal::term::color::Colors;
use alacritty_terminal::vte::ansi::{Color, NamedColor, Rgb};
use gpui::{Hsla, Rgba, rgb};
use gpui_component::theme::Theme;

/// Everything needed to turn a cell's colour into paint.
#[derive(Debug, Clone, PartialEq)]
pub struct Palette {
    /// The 16 ANSI colours: normal 0..8, bright 8..16.
    pub ansi: [Hsla; 16],
    /// Default text colour.
    pub foreground: Hsla,
    /// Default background.
    pub background: Hsla,
    /// Cursor colour.
    pub cursor: Hsla,
    /// Selection highlight.
    pub selection: Hsla,
    /// Render bold text in the eight base colours with their bright twin,
    /// the way xterm does. On against a dark background, where the bright
    /// set reads as emphasis; off against a light one, where brightening
    /// only washes the text out.
    pub bold_as_bright: bool,
}

/// ANSI colours tuned for dark backgrounds (the "One Dark"-ish set the
/// Electron app used by default).
const DARK_ANSI: [u32; 16] = [
    0x3b4252, 0xe06c75, 0x98c379, 0xe5c07b, 0x61afef, 0xc678dd, 0x56b6c2, 0xd0d4dc, 0x6c7380,
    0xef7a84, 0xa9d68a, 0xefd08a, 0x74bdf5, 0xd48ce7, 0x6cc7d1, 0xffffff,
];

/// ANSI colours tuned for light backgrounds.
const LIGHT_ANSI: [u32; 16] = [
    0x383a42, 0xe45649, 0x50a14f, 0xc18401, 0x0184bc, 0xa626a4, 0x0997b3, 0xa0a1a7, 0x4f525e,
    0xf0524a, 0x4db052, 0xd9a306, 0x1d90d4, 0xc03fbd, 0x0aa8c5, 0x000000,
];

impl Palette {
    /// Build a palette from the app theme: text, background, caret and
    /// selection come from the theme; the ANSI set is chosen by light/dark.
    pub fn from_theme(theme: &Theme) -> Self {
        let dark = theme.is_dark();
        let ansi = if dark { DARK_ANSI } else { LIGHT_ANSI };
        Self {
            ansi: ansi.map(|hex| rgb(hex).into()),
            foreground: theme.foreground,
            background: theme.background,
            cursor: theme.caret,
            selection: theme.selection,
            bold_as_bright: dark,
        }
    }

    /// A dark palette that needs no theme; used by tests and as a fallback.
    pub fn dark() -> Self {
        Self {
            ansi: DARK_ANSI.map(|hex| rgb(hex).into()),
            foreground: rgb(0xd0d4dc).into(),
            background: rgb(0x1e2127).into(),
            cursor: rgb(0x61afef).into(),
            selection: rgb(0x3e4451).into(),
            bold_as_bright: true,
        }
    }

    /// A light palette that needs no theme; bold does not brighten.
    pub fn light() -> Self {
        Self {
            ansi: LIGHT_ANSI.map(|hex| rgb(hex).into()),
            foreground: rgb(0x383a42).into(),
            background: rgb(0xfafafa).into(),
            cursor: rgb(0x0184bc).into(),
            selection: rgb(0xd6dae0).into(),
            bold_as_bright: false,
        }
    }

    /// Resolve a cell colour. `overrides` are the runtime OSC 4/10/11
    /// changes tracked by alacritty; `dim` applies SGR 2.
    pub fn resolve(&self, color: Color, overrides: &Colors, dim: bool) -> Hsla {
        let base = match color {
            Color::Spec(rgb) => rgb_to_hsla(rgb),
            Color::Indexed(index) => self.indexed(index as usize, overrides),
            Color::Named(named) => self.named(named, overrides),
        };
        if dim { dimmed(base) } else { base }
    }

    /// The foreground to use for a cell, honouring bold-as-bright for the
    /// eight base colours the way xterm does, when the theme asks for it.
    pub fn foreground_for(&self, color: Color, overrides: &Colors, bold: bool, dim: bool) -> Hsla {
        let bold = bold && self.bold_as_bright;
        let color = match color {
            Color::Named(named) if bold && (named as usize) < 8 => Color::Named(named.to_bright()),
            Color::Indexed(index) if bold && index < 8 => Color::Indexed(index + 8),
            other => other,
        };
        self.resolve(color, overrides, dim)
    }

    fn indexed(&self, index: usize, overrides: &Colors) -> Hsla {
        if let Some(rgb) = overrides[index] {
            return rgb_to_hsla(rgb);
        }
        match index {
            0..=15 => self.ansi[index],
            16..=231 => {
                let i = index - 16;
                let component = |v: usize| if v == 0 { 0 } else { (v * 40 + 55) as u8 };
                let r = component(i / 36);
                let g = component((i % 36) / 6);
                let b = component(i % 6);
                rgb_to_hsla(Rgb { r, g, b })
            }
            232..=255 => {
                let v = (8 + (index - 232) * 10) as u8;
                rgb_to_hsla(Rgb { r: v, g: v, b: v })
            }
            _ => self.foreground,
        }
    }

    fn named(&self, named: NamedColor, overrides: &Colors) -> Hsla {
        if let Some(rgb) = overrides[named as usize] {
            return rgb_to_hsla(rgb);
        }
        let idx = named as usize;
        match named {
            _ if idx < 16 => self.ansi[idx],
            NamedColor::Foreground | NamedColor::BrightForeground => self.foreground,
            NamedColor::Background => self.background,
            NamedColor::Cursor => self.cursor,
            NamedColor::DimForeground => dimmed(self.foreground),
            NamedColor::DimBlack
            | NamedColor::DimRed
            | NamedColor::DimGreen
            | NamedColor::DimYellow
            | NamedColor::DimBlue
            | NamedColor::DimMagenta
            | NamedColor::DimCyan
            | NamedColor::DimWhite => dimmed(self.ansi[idx - NamedColor::DimBlack as usize]),
            _ => self.foreground,
        }
    }
}

/// Convert alacritty's byte RGB to GPUI's HSLA.
pub fn rgb_to_hsla(rgb: Rgb) -> Hsla {
    Rgba {
        r: rgb.r as f32 / 255.0,
        g: rgb.g as f32 / 255.0,
        b: rgb.b as f32 / 255.0,
        a: 1.0,
    }
    .into()
}

fn dimmed(color: Hsla) -> Hsla {
    Hsla { l: color.l * 0.66, ..color }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cube_and_grayscale_indices() {
        let p = Palette::dark();
        let none = Colors::default();
        // 196 is pure red in the 6x6x6 cube.
        let red = p.resolve(Color::Indexed(196), &none, false);
        let expected: Hsla = rgb(0xff0000).into();
        assert!((red.h - expected.h).abs() < 0.01 && (red.l - expected.l).abs() < 0.01);
        // 232 is the darkest gray, 255 the lightest.
        let dark: Rgba = p.resolve(Color::Indexed(232), &none, false).into();
        let light: Rgba = p.resolve(Color::Indexed(255), &none, false).into();
        assert!(dark.r < 0.05 && light.r > 0.9);
    }

    #[test]
    fn overrides_win() {
        let p = Palette::dark();
        let mut overrides = Colors::default();
        overrides[1] = Some(Rgb { r: 0, g: 255, b: 0 });
        let c: Rgba = p.resolve(Color::Named(NamedColor::Red), &overrides, false).into();
        assert!(c.g > 0.99 && c.r < 0.01);
    }

    #[test]
    fn bold_brightens_base_colours_only() {
        let p = Palette::dark();
        let none = Colors::default();
        assert_eq!(
            p.foreground_for(Color::Named(NamedColor::Red), &none, true, false),
            p.ansi[9]
        );
        assert_eq!(p.foreground_for(Color::Indexed(9), &none, true, false), p.ansi[9]);
        assert_eq!(p.foreground_for(Color::Indexed(200), &none, true, false), p.indexed(200, &none));
    }

    #[test]
    fn bold_as_bright_follows_the_theme() {
        let none = Colors::default();
        let light = Palette::light();
        assert!(!light.bold_as_bright);
        // Bold keeps the normal colour when the theme says so.
        assert_eq!(
            light.foreground_for(Color::Named(NamedColor::Red), &none, true, false),
            light.ansi[1]
        );
        // An explicitly bright colour is still bright.
        assert_eq!(light.foreground_for(Color::Indexed(9), &none, false, false), light.ansi[9]);
        assert!(Palette::dark().bold_as_bright);
    }
}
