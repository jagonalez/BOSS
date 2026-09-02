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

    // Phone access: the relay client (E2E through the Fly relay) and the
    // Tailscale-fronted web server. Both start idle unless their config
    // files say `enabled`.
    let relay = boss_runtime::relay::RelayClient::start(
        runtime.clone(),
        boss_runtime::relay::RelayConfig { data_dir: runtime.data_dir.clone(), url: None },
    );
    let web_config = boss_runtime::web_access::WebAccessConfig::load(&runtime.data_dir);
    let web_access = match handle.block_on(boss_runtime::web_access::WebAccess::start(runtime.clone(), web_config)) {
        Ok(w) => Some(w),
        Err(err) => {
            tracing::warn!(%err, "web access did not start");
            None
        }
    };

    let app = gpui_platform::application().with_assets(gpui_component_assets::Assets);
    app.run(move |cx| {
        gpui_component::init(cx);
        shell::init(cx);
        cx.activate(true);

        let state = cx.new(|_| BossApp::initial_state(&runtime));
        let boss = BossApp::new(runtime.clone(), state.clone(), relay, web_access);
        boss.install();
        let actions: Arc<dyn ShellActions> = boss.clone();
        match shell::open_main_window_with_workspace(state, actions, cx) {
            Ok((window, workspace)) => boss.attach_window(window, workspace, cx),
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
