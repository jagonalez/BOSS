//! One BrowserView at https://example.com. Prints the snapshot once loaded.
//!
//! Run with a hard timeout: `perl -e 'alarm 8; exec @ARGV' -- ./target/debug/examples/browser`

use boss_browser::{BrowserEvent, BrowserRegistry, BrowserTabId, BrowserView, PageAutomation};
use gpui::*;
use gpui_component::Root;

struct Shell {
    browser: Entity<BrowserView>,
}

impl Render for Shell {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div().size_full().child(self.browser.clone())
    }
}

fn main() {
    let app = gpui_platform::application().with_assets(gpui_component_assets::Assets);
    app.run(move |cx| {
        gpui_component::init(cx);
        cx.spawn(async move |cx| {
            let bounds = cx.update(|cx| Bounds::centered(None, size(px(1000.), px(700.)), cx));
            let options = WindowOptions { window_bounds: Some(WindowBounds::Windowed(bounds)), ..Default::default() };
            cx.open_window(options, |window, cx| {
                let browser = cx.new(|cx| BrowserView::new(BrowserTabId::from("example"), Some("https://example.com"), window, cx));
                let mut registry = BrowserRegistry::new();
                registry.open(browser.clone(), cx);
                let tools = registry.bus_tools();

                // Snapshot from another thread once the first load finishes,
                // the way a bus tool call would.
                let snapped = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
                cx.subscribe(&browser, move |_, event: &BrowserEvent, _| {
                    if let BrowserEvent::Navigated(state) = event
                        && !state.loading
                        && !state.url.is_empty()
                        && !snapped.swap(true, std::sync::atomic::Ordering::SeqCst)
                    {
                        let tools = tools.clone();
                        std::thread::spawn(move || {
                            let handle = tools.get(&BrowserTabId::from("example")).expect("tab registered");
                            match futures::executor::block_on(handle.snapshot()) {
                                Ok(snapshot) => println!("{snapshot}"),
                                Err(error) => eprintln!("snapshot failed: {error}"),
                            }
                            println!("tabs: {}", serde_json::to_string(&tools.tabs()).unwrap());
                        });
                    }
                })
                .detach();

                let shell = cx.new(|_| Shell { browser });
                cx.new(|cx| Root::new(shell, window, cx))
            })
            .expect("open window");
        })
        .detach();
    });
}
