//! The BOSS palette, ported from the Electron app.
//!
//! The Electron renderer kept its look in CSS custom properties: a token set
//! per appearance (`boss-dark`, `boss-light` in
//! `src/renderer/src/lib/themes.ts`), plus radii, fonts and spacing in
//! `src/renderer/src/styles.css`. gpui-component keeps the same idea in
//! [`ThemeColor`], so the port is a mapping rather than a rewrite.
//!
//! [`apply`] writes a [`Palette`] onto the global theme.
//! [`crate::shell::apply_theme`] calls it after every
//! `Theme::change`/`sync_system_appearance`, because those reload colors from
//! the registry's theme config and would otherwise wash the palette out.
//!
//! Semantic names the views use beyond `ThemeColor` — the per-engine hues,
//! the recessed and raised surfaces the transcript needs — live on
//! [`Palette`] and are read through [`ActivePalette`].

use gpui::{App, Global, Hsla, Pixels, SharedString, px};
use gpui_component::Theme;

/// Colors the views need that `ThemeColor` has no field for. Everything else
/// is written straight onto the gpui-component theme by [`apply`].
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Palette {
    /// True for the dark palette; a few surfaces lighten instead of darken.
    pub dark: bool,
    /// Window background behind every pane.
    pub canvas: Hsla,
    /// Sidebar and chrome fill, a step darker than `canvas` in the dark
    /// palette and a step lighter in the light one.
    pub sidebar: Hsla,
    /// Card and pane fill.
    pub surface: Hsla,
    /// A card raised off `surface`: tool cards, the composer's request cards.
    pub surface_raised: Hsla,
    /// Recessed fill: code blocks, tool output, the composer field.
    pub inset: Hsla,
    /// Row hover.
    pub hover: Hsla,
    /// Selected row.
    pub selected: Hsla,
    /// Hairline between regions.
    pub border: Hsla,
    /// The heavier line, for a focused or dragged edge.
    pub border_strong: Hsla,
    /// Body text.
    pub text: Hsla,
    /// Secondary text: author lines, timestamps, tool titles.
    pub text_muted: Hsla,
    /// Tertiary text: hints and counts.
    pub text_subtle: Hsla,
    /// The one accent.
    pub accent: Hsla,
    /// Accent under the pointer.
    pub accent_hover: Hsla,
    /// A wash of the accent, for a selected chip or the user's own turn.
    pub accent_soft: Hsla,
    /// Text drawn on top of `accent`; not white on a light accent.
    pub accent_ink: Hsla,
    /// Success green.
    pub success: Hsla,
    /// A wash of `success`.
    pub success_soft: Hsla,
    /// Warning amber.
    pub warning: Hsla,
    /// A wash of `warning`.
    pub warning_soft: Hsla,
    /// Text on a warning fill.
    pub warning_ink: Hsla,
    /// Danger red.
    pub danger: Hsla,
    /// A wash of `danger`.
    pub danger_soft: Hsla,
    /// Text on a danger fill.
    pub danger_ink: Hsla,
    /// Purple, used for reasoning.
    pub purple: Hsla,
    /// Cyan, used for a local/worktree badge.
    pub cyan: Hsla,
    /// One hue per engine, so a backend reads the same in a badge and a tab.
    pub engine_claude: Hsla,
    /// See [`Palette::engine_claude`].
    pub engine_codex: Hsla,
    /// See [`Palette::engine_claude`].
    pub engine_pi: Hsla,
    /// See [`Palette::engine_claude`]. The Electron themes named three
    /// backends; opencode takes the remaining accent hue.
    pub engine_opencode: Hsla,
}

/// The palette in effect. Set by [`apply`]; read with [`ActivePalette`].
impl Global for Palette {}

/// `cx.palette()`, the companion to gpui-component's `cx.theme()`.
pub trait ActivePalette {
    /// The palette the window is drawing with.
    fn palette(&self) -> &Palette;
}

impl ActivePalette for App {
    fn palette(&self) -> &Palette {
        self.try_global::<Palette>().unwrap_or(&DARK)
    }
}

/// Radii, from `--radius` in `styles.css`. The Electron app moved off the
/// tighter pair because it made the window read as a utility, not an app.
pub const RADIUS: Pixels = px(9.);
/// Radius for a large surface: dialogs, the composer field, pane cards.
pub const RADIUS_LG: Pixels = px(12.);

/// `--font-ui`. gpui resolves `.SystemUIFont` to the platform UI face, which
/// is what `-apple-system` gave the renderer.
pub const UI_FONT: &str = ".SystemUIFont";
/// `--font-mono`. `SF Mono` first, as in the CSS stack.
#[cfg(target_os = "macos")]
pub const MONO_FONT: &str = "SF Mono";
/// `--font-mono` off macOS.
#[cfg(not(target_os = "macos"))]
pub const MONO_FONT: &str = "monospace";

/// `--type-terminal`: code is read in columns, so it runs a step smaller
/// than prose.
pub const MONO_SIZE: Pixels = px(13.);

/// `boss-dark`: the default. Values are the Electron theme's, unchanged.
pub const DARK: Palette = Palette {
    dark: true,
    canvas: hsl(0x0d1117),
    sidebar: hsl(0x090d13),
    surface: hsl(0x161b22),
    surface_raised: hsl(0x21262d),
    inset: hsl(0x010409),
    hover: hsl(0x1f252d),
    selected: hsl(0x252d38),
    border: hsl(0x30363d),
    border_strong: hsl(0x484f58),
    text: hsl(0xf0f6fc),
    text_muted: hsl(0xb1bac4),
    text_subtle: hsl(0x7d8590),
    accent: hsl(0x58a6ff),
    accent_hover: hsl(0x79c0ff),
    accent_soft: hsla(0x388bfd, 0.17),
    accent_ink: hsl(0x08131f),
    success: hsl(0x3fb950),
    success_soft: hsla(0x2ea043, 0.16),
    warning: hsl(0xd29922),
    warning_soft: hsla(0xbb8009, 0.16),
    warning_ink: hsl(0x1a1400),
    danger: hsl(0xf85149),
    danger_soft: hsla(0xf85149, 0.16),
    danger_ink: hsl(0x1f0705),
    purple: hsl(0xbc8cff),
    cyan: hsl(0x39c5cf),
    engine_claude: hsl(0xd8916f),
    engine_codex: hsl(0x77c7a4),
    engine_pi: hsl(0xd4a75e),
    engine_opencode: hsl(0x8fb2f0),
};

/// `boss-light`.
pub const LIGHT: Palette = Palette {
    dark: false,
    canvas: hsl(0xf6f8fa),
    sidebar: hsl(0xf0f3f6),
    surface: hsl(0xffffff),
    surface_raised: hsl(0xf3f4f6),
    inset: hsl(0xeef1f4),
    hover: hsl(0xeaeef2),
    selected: hsl(0xdbeafe),
    border: hsl(0xd0d7de),
    border_strong: hsl(0xafb8c1),
    text: hsl(0x1f2328),
    text_muted: hsl(0x59636e),
    text_subtle: hsl(0x818b98),
    accent: hsl(0x0969da),
    accent_hover: hsl(0x0550ae),
    accent_soft: hsla(0x0969da, 0.11),
    accent_ink: hsl(0xffffff),
    success: hsl(0x1a7f37),
    success_soft: hsla(0x1a7f37, 0.11),
    warning: hsl(0x9a6700),
    warning_soft: hsla(0x9a6700, 0.11),
    warning_ink: hsl(0xffffff),
    danger: hsl(0xcf222e),
    danger_soft: hsla(0xcf222e, 0.10),
    danger_ink: hsl(0xffffff),
    purple: hsl(0x8250df),
    cyan: hsl(0x1b7c83),
    engine_claude: hsl(0xd8916f),
    engine_codex: hsl(0x77c7a4),
    engine_pi: hsl(0xd4a75e),
    engine_opencode: hsl(0x5c86d6),
};

impl Palette {
    /// The hue that stands for an engine, in a badge, a chip, or an author
    /// line. One place, so a backend never reads two ways.
    pub fn engine(&self, engine: boss_core::EngineId) -> Hsla {
        match engine {
            boss_core::EngineId::Claude => self.engine_claude,
            boss_core::EngineId::Codex => self.engine_codex,
            boss_core::EngineId::Opencode => self.engine_opencode,
            boss_core::EngineId::Pi => self.engine_pi,
        }
    }
}

/// The palette for an appearance.
pub fn for_mode(dark: bool) -> Palette {
    if dark { DARK } else { LIGHT }
}

/// Write `palette` onto the global gpui-component theme, then push it down to
/// the Base layer so the scrollbar and resize handles follow.
///
/// Call after every `Theme::change`: that reloads `ThemeColor` from the theme
/// config and drops anything written here.
pub fn apply(palette: Palette, cx: &mut App) {
    let p = palette;
    {
        let theme = Theme::global_mut(cx);
        let c = &mut theme.colors;

        c.background = p.canvas;
        c.foreground = p.text;
        c.border = p.border;
        c.drag_border = p.accent;
        c.drop_target = p.accent_soft;
        c.window_border = p.border;
        c.overlay = if p.dark {
            hsla(0x010409, 0.72)
        } else {
            hsla(0x1f2328, 0.32)
        };
        c.ring = p.accent;
        c.caret = p.accent;
        c.selection = p.accent_soft;
        c.skeleton = p.surface_raised;

        // Muted is the quiet fill under a chip or an inline code span; the
        // renderer used --surface-raised for both.
        c.muted = p.surface_raised;
        c.muted_foreground = p.text_muted;
        c.accent = p.hover;
        c.accent_foreground = p.text;

        // Cards and popovers sit on --surface.
        c.popover = p.surface;
        c.popover_foreground = p.text;
        c.accordion = p.surface;
        c.group_box = p.surface;
        c.group_box_foreground = p.text;
        c.tiles = p.canvas;

        // The composer field and every other input are recessed.
        c.input = p.border;

        c.primary = p.accent;
        c.primary_hover = p.accent_hover;
        c.primary_active = p.accent_hover;
        c.primary_foreground = p.accent_ink;

        c.secondary = p.surface_raised;
        c.secondary_hover = p.hover;
        c.secondary_active = p.selected;
        c.secondary_foreground = p.text;

        c.danger = p.danger;
        c.danger_hover = p.danger;
        c.danger_active = p.danger;
        c.danger_foreground = p.danger_ink;
        c.success = p.success;
        c.success_hover = p.success;
        c.success_active = p.success;
        // A green fill is light in the dark theme and dark in the light one,
        // so its text flips with it. The Electron tokens named no
        // `successInk`; these are the two ends of the same scale.
        c.success_foreground = if p.dark { hsl(0x04140a) } else { hsl(0xffffff) };
        c.warning = p.warning;
        c.warning_hover = p.warning;
        c.warning_active = p.warning;
        c.warning_foreground = p.warning_ink;
        c.info = p.accent;
        c.info_hover = p.accent_hover;
        c.info_active = p.accent_hover;
        c.info_foreground = p.accent_ink;

        // Buttons. The default button is the renderer's --surface-control:
        // a bordered control on the raised fill, not a filled one.
        c.button = p.surface_raised;
        c.button_hover = p.hover;
        c.button_active = p.selected;
        c.button_foreground = p.text;
        c.button_primary = p.accent;
        c.button_primary_hover = p.accent_hover;
        c.button_primary_active = p.accent_hover;
        c.button_primary_foreground = p.accent_ink;
        c.button_secondary = p.surface_raised;
        c.button_secondary_hover = p.hover;
        c.button_secondary_active = p.selected;
        c.button_secondary_foreground = p.text;
        c.button_danger = p.danger;
        c.button_danger_hover = p.danger;
        c.button_danger_active = p.danger;
        c.button_danger_foreground = p.danger_ink;
        c.button_success = p.success;
        c.button_success_hover = p.success;
        c.button_success_active = p.success;
        c.button_success_foreground = c.success_foreground;
        c.button_warning = p.warning;
        c.button_warning_hover = p.warning;
        c.button_warning_active = p.warning;
        c.button_warning_foreground = p.warning_ink;
        c.button_info = p.accent;
        c.button_info_hover = p.accent_hover;
        c.button_info_active = p.accent_hover;
        c.button_info_foreground = p.accent_ink;

        c.link = p.accent;
        c.link_hover = p.accent_hover;
        c.link_active = p.accent_hover;

        // Lists: the sidebar's rows and every menu.
        c.list = p.surface;
        c.list_even = p.surface;
        c.list_head = p.surface;
        c.list_hover = p.hover;
        c.list_active = p.selected;
        c.list_active_border = p.accent;

        c.sidebar = p.sidebar;
        c.sidebar_foreground = p.text;
        c.sidebar_border = p.border;
        c.sidebar_accent = p.hover;
        c.sidebar_accent_foreground = p.text;
        c.sidebar_primary = p.accent;
        c.sidebar_primary_foreground = p.accent_ink;

        // Tabs. An inactive tab melts into the bar; the active one is the
        // pane's own surface, so the tab and its content read as one sheet.
        c.tab_bar = p.canvas;
        c.tab_bar_segmented = p.surface_raised;
        c.tab = gpui::transparent_black().into();
        c.tab_foreground = p.text_muted;
        c.tab_active = p.surface;
        c.tab_active_foreground = p.text;

        c.title_bar = p.sidebar;
        c.title_bar_border = p.border;
        c.status_bar = p.sidebar;
        c.status_bar_border = p.border;

        c.table = p.surface;
        c.table_even = p.surface;
        c.table_hover = p.hover;
        c.table_active = p.selected;
        c.table_active_border = p.accent;
        c.table_row_border = p.border;
        c.table_head = p.surface_raised;
        c.table_head_foreground = p.text_muted;
        c.table_foot = p.surface_raised;
        c.table_foot_foreground = p.text_muted;
        c.description_list_label = p.surface_raised;
        c.description_list_label_foreground = p.text_muted;

        c.scrollbar = gpui::transparent_black().into();
        c.scrollbar_thumb = if p.dark {
            hsla(0xb1bac4, 0.28)
        } else {
            hsla(0x59636e, 0.30)
        };
        c.scrollbar_thumb_hover = if p.dark {
            hsla(0xb1bac4, 0.45)
        } else {
            hsla(0x59636e, 0.48)
        };

        c.progress_bar = p.accent;
        c.slider_bar = p.accent;
        c.slider_thumb = p.surface;
        c.switch = p.border_strong;
        c.switch_thumb = p.surface;

        // The base hues, used by charts and by any component reaching for a
        // named color. Terminal colors live in boss-terminal.
        c.red = p.danger;
        c.red_light = p.danger_soft;
        c.green = p.success;
        c.green_light = p.success_soft;
        c.blue = p.accent;
        c.blue_light = p.accent_soft;
        c.yellow = p.warning;
        c.yellow_light = p.warning_soft;
        c.magenta = p.purple;
        c.magenta_light = with_alpha(p.purple, 0.16);
        c.cyan = p.cyan;
        c.cyan_light = with_alpha(p.cyan, 0.16);
        c.chart_1 = p.accent;
        c.chart_2 = p.success;
        c.chart_3 = p.warning;
        c.chart_4 = p.purple;
        c.chart_5 = p.cyan;
        c.chart_bullish = p.success;
        c.chart_bearish = p.danger;

        theme.radius = RADIUS;
        theme.radius_lg = RADIUS_LG;
        // The renderer drew flat surfaces separated by hairlines, not shadows.
        theme.shadow = false;
        theme.mono_font_size = MONO_SIZE;

        // Components read `tokens`, not `colors`: a Button asks for
        // `tokens.button_primary`, never `colors.primary`. The tokens are
        // derived from the colors, so writing colors alone leaves every
        // button, tab and table painting with the theme we just replaced.
        theme.tokens = gpui_component::ThemeTokens::from(theme.colors);
    }
    cx.set_global(palette);
    Theme::sync_base(cx);
}

/// Apply the user's font choices. `ui` and `mono` are the ids
/// `Settings.typography` stores; `"system"` means the platform face.
pub fn apply_fonts(ui: &str, mono: &str, cx: &mut App) {
    let theme = Theme::global_mut(cx);
    theme.font_family = font_family(ui, UI_FONT);
    theme.mono_font_family = font_family(mono, MONO_FONT);
    Theme::sync_base(cx);
}

/// A font id from settings, resolved to a family name.
fn font_family(id: &str, fallback: &'static str) -> SharedString {
    match id {
        "" | "system" | "default" => fallback.into(),
        other => SharedString::from(other.to_owned()),
    }
}

/// `color` at `alpha`, keeping its hue and lightness.
pub fn with_alpha(color: Hsla, alpha: f32) -> Hsla {
    Hsla { a: alpha, ..color }
}

/// An opaque color from a `0xRRGGBB` literal, usable in a `const`.
const fn hsl(rgb_hex: u32) -> Hsla {
    hsla(rgb_hex, 1.0)
}

/// A color from `0xRRGGBB` at `alpha`, usable in a `const`.
///
/// gpui's own `Rgba -> Hsla` conversion is not `const`, so the palettes could
/// not be constants if they went through it. This is the same arithmetic;
/// `hex_matches_gpui_conversion` holds the two together.
const fn hsla(rgb_hex: u32, alpha: f32) -> Hsla {
    let r = ((rgb_hex >> 16) & 0xff) as f32 / 255.0;
    let g = ((rgb_hex >> 8) & 0xff) as f32 / 255.0;
    let b = (rgb_hex & 0xff) as f32 / 255.0;

    let max = if r > g && r > b {
        r
    } else if g > b {
        g
    } else {
        b
    };
    let min = if r < g && r < b {
        r
    } else if g < b {
        g
    } else {
        b
    };
    let delta = max - min;

    let l = (max + min) / 2.0;
    let s = if l == 0.0 || l == 1.0 || delta == 0.0 {
        0.0
    } else if l < 0.5 {
        delta / (2.0 * l)
    } else {
        delta / (2.0 - 2.0 * l)
    };
    let h = if delta == 0.0 {
        0.0
    } else if max == r {
        let sixths = (g - b) / delta;
        // `rem_euclid` is not const; the value is in (-6, 6) here.
        (if sixths < 0.0 { sixths + 6.0 } else { sixths }) / 6.0
    } else if max == g {
        ((b - r) / delta + 2.0) / 6.0
    } else {
        ((r - g) / delta + 4.0) / 6.0
    };

    Hsla { h, s, l, a: alpha }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn approx(a: f32, b: f32) -> bool {
        (a - b).abs() < 0.01
    }

    #[test]
    fn hex_round_trips_through_hsla() {
        // #58a6ff, the dark accent.
        let c = hsl(0x58a6ff);
        let rgba = gpui::Rgba::from(c);
        assert!(approx(rgba.r, 0x58 as f32 / 255.), "r was {}", rgba.r);
        assert!(approx(rgba.g, 0xa6 as f32 / 255.), "g was {}", rgba.g);
        assert!(approx(rgba.b, 0xff as f32 / 255.), "b was {}", rgba.b);
        assert!(approx(rgba.a, 1.0));
    }

    /// The const conversion must agree with gpui's `Rgba -> Hsla`, which the
    /// rest of the app and gpui-component use. Checked over every color in
    /// both palettes plus the grey axis, where hue is undefined.
    #[test]
    fn hex_matches_gpui_conversion() {
        let hexes = [
            0x0d1117, 0x090d13, 0x161b22, 0x21262d, 0x010409, 0x1f252d, 0x252d38, 0x30363d,
            0x484f58, 0xf0f6fc, 0xb1bac4, 0x7d8590, 0x58a6ff, 0x79c0ff, 0x388bfd, 0x08131f,
            0x3fb950, 0x2ea043, 0xd29922, 0xbb8009, 0x1a1400, 0xf85149, 0x1f0705, 0xbc8cff,
            0x39c5cf, 0xd8916f, 0x77c7a4, 0xd4a75e, 0xf6f8fa, 0xf0f3f6, 0xffffff, 0xf3f4f6,
            0xeef1f4, 0xeaeef2, 0xdbeafe, 0xd0d7de, 0xafb8c1, 0x1f2328, 0x59636e, 0x818b98,
            0x0969da, 0x0550ae, 0x1a7f37, 0x9a6700, 0xcf222e, 0x8250df, 0x1b7c83, 0x000000,
            0x808080, 0xff0000, 0x00ff00, 0x0000ff,
        ];
        for hex in hexes {
            let mine = hsl(hex);
            let theirs: Hsla = gpui::rgb(hex).into();
            assert!(
                approx(mine.h, theirs.h)
                    && approx(mine.s, theirs.s)
                    && approx(mine.l, theirs.l)
                    && approx(mine.a, theirs.a),
                "#{hex:06x}: {mine:?} != {theirs:?}"
            );
        }
    }

    #[test]
    fn alpha_survives_the_conversion() {
        let soft = hsla(0x388bfd, 0.17);
        assert!(approx(soft.a, 0.17), "alpha was {}", soft.a);
        let opaque = hsl(0x388bfd);
        assert!(approx(soft.h, opaque.h) && approx(soft.s, opaque.s) && approx(soft.l, opaque.l));
    }

    #[test]
    fn the_two_palettes_differ_and_know_which_they_are() {
        assert!(DARK.dark);
        assert!(!LIGHT.dark);
        assert_ne!(DARK.canvas, LIGHT.canvas);
        assert_eq!(for_mode(true), DARK);
        assert_eq!(for_mode(false), LIGHT);
        // Dark text is light and light text is dark, or the port is inverted.
        assert!(DARK.text.l > 0.8 && DARK.canvas.l < 0.2);
        assert!(LIGHT.text.l < 0.2 && LIGHT.canvas.l > 0.8);
    }

    #[test]
    fn engine_hues_are_shared_by_both_palettes() {
        assert_eq!(DARK.engine_claude, LIGHT.engine_claude);
        assert_eq!(DARK.engine_codex, LIGHT.engine_codex);
        assert_eq!(DARK.engine_pi, LIGHT.engine_pi);
        assert_ne!(DARK.engine_opencode, LIGHT.engine_opencode);
    }

    #[test]
    fn font_ids_resolve_to_families() {
        assert_eq!(font_family("system", UI_FONT), SharedString::from(UI_FONT));
        assert_eq!(font_family("", UI_FONT), SharedString::from(UI_FONT));
        assert_eq!(font_family("Inter", UI_FONT), SharedString::from("Inter"));
    }
}
