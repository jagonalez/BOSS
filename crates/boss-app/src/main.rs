use gpui::*;
use gpui_component::{Root, TitleBar, v_flex};

struct Hello;

impl Render for Hello {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        v_flex()
            .size_full()
            .child(TitleBar::new())
            .child(div().p_4().child("BOSS"))
    }
}

fn main() {
    tracing_subscriber::fmt::init();
    let app = gpui_platform::application().with_assets(gpui_component_assets::Assets);
    app.run(move |cx| {
        gpui_component::init(cx);
        cx.spawn(async move |cx| {
            let options = WindowOptions::default();
            cx.open_window(options, |window, cx| {
                let view = cx.new(|_| Hello);
                cx.new(|cx| Root::new(view, window, cx))
            })
            .unwrap();
        })
        .detach();
    });
}
