//! Opens a window with one terminal running the user's shell.

use boss_terminal::{TerminalEvent, TerminalView};
use gpui::{App, Bounds, Context, Focusable, IntoElement, Render, Window, WindowBounds, WindowOptions, div, prelude::*, px, size};
use gpui_component::{ActiveTheme, Root};

struct Shell {
    terminal: gpui::Entity<TerminalView>,
    status: String,
}

impl Shell {
    fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let terminal = cx.new(|cx| TerminalView::new(None, None, cx).expect("spawn shell"));
        cx.subscribe(&terminal, |this, terminal, event: &TerminalEvent, cx| {
            match event {
                TerminalEvent::Exit(code) => this.status = format!("exited: {code}"),
                TerminalEvent::ConfirmPaste { text } => {
                    // The real app asks first. The example reports the size
                    // and sends it, so the hook is exercised end to end.
                    let lines = text.lines().count();
                    this.status = format!("pasted {lines} lines");
                    let text = text.clone();
                    terminal.update(cx, |view, cx| view.paste_confirmed(&text, cx));
                }
                _ => return,
            }
            cx.notify();
        })
        .detach();
        terminal.update(cx, |view, _| view.set_confirm_multiline_paste(true));
        terminal.read(cx).focus_handle(cx).focus(window, cx);
        Self { terminal, status: String::from("running") }
    }
}

impl Render for Shell {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let title = self.terminal.read(cx).title();
        div()
            .flex()
            .flex_col()
            .size_full()
            .bg(cx.theme().background)
            .text_color(cx.theme().foreground)
            .child(
                div()
                    .px_3()
                    .py_1()
                    .text_sm()
                    .border_b_1()
                    .border_color(cx.theme().border)
                    .child(format!("{title} — {}", self.status)),
            )
            .child(div().flex_1().min_h_0().child(self.terminal.clone()))
    }
}

fn main() {
    tracing_subscriber::fmt::init();
    let app = gpui_platform::application().with_assets(gpui_component_assets::Assets);
    app.run(move |cx: &mut App| {
        gpui_component::init(cx);
        let bounds = Bounds::centered(None, size(px(960.), px(640.)), cx);
        let options = WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            ..Default::default()
        };
        cx.open_window(options, |window, cx| {
            let view = cx.new(|cx| Shell::new(window, cx));
            cx.new(|cx| Root::new(view, window, cx))
        })
        .expect("open window");
        cx.activate(true);
    });
}
