use boss_app::app::BossApp;
use boss_app::shell::{self, ShellActions};
use boss_runtime::Runtime;
use gpui::AppContext as _;
use std::sync::Arc;
use tracing_subscriber::EnvFilter;

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("boss=info,boss_app=info,boss_runtime=info")))
        .init();

    // Worker threads come up now, before the UI, so the first engine call
    // does not pay for it.
    let handle = shell::tokio_handle();
    let runtime = match handle.block_on(Runtime::start(None, handle.clone())) {
        Ok(rt) => rt,
        Err(err) => {
            eprintln!("BOSS could not start: {err:#}");
            std::process::exit(1);
        }
    };
    tracing::info!(bus = runtime.bus.url(), data = %runtime.data_dir.display(), "runtime ready");

    let app = gpui_platform::application().with_assets(gpui_component_assets::Assets);
    app.run(move |cx| {
        gpui_component::init(cx);
        shell::init(cx);
        cx.activate(true);

        let state = cx.new(|_| BossApp::initial_state(&runtime));
        let boss = BossApp::new(runtime.clone(), state.clone());
        boss.install();
        let actions: Arc<dyn ShellActions> = boss.clone();
        match shell::open_main_window(state, actions, cx) {
            Ok(window) => boss.attach_window(window, cx),
            Err(err) => {
                tracing::error!(%err, "could not open the main window");
                cx.quit();
                return;
            }
        }

        let runtime = runtime.clone();
        cx.on_window_closed(move |cx, _| {
            if cx.windows().is_empty() {
                let rt = runtime.clone();
                rt.handle.clone().block_on(async { rt.shutdown().await });
                cx.quit();
            }
        })
        .detach();
    });
}
