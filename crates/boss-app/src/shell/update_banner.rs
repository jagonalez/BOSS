//! The bar across the top of the workspace when a newer BOSS exists.
//!
//! The banner holds no logic of its own beyond the state machine below: it
//! emits [`UpdateBannerEvent`] and the app drives `boss_update` on the tokio
//! runtime, pushing each step back through [`UpdateBanner::set_stage`]. That
//! keeps the network and the `.app` swap off the UI thread and makes every
//! transition testable without a window.

use gpui::{
    Context, EventEmitter, IntoElement, ParentElement, Render, SharedString, Styled, Window,
    div, px,
};
use gpui_component::{
    ActiveTheme, IconName, Sizable,
    button::{Button, ButtonVariants},
    h_flex,
};
use std::path::PathBuf;

/// Where an offered update has got to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum UpdateStage {
    /// A release is available and nothing has been asked for yet.
    Available,
    /// Bytes are coming down. `(done, total)`; `total` is 0 when the server
    /// sent no length.
    Downloading {
        /// Bytes written so far.
        done: u64,
        /// Bytes expected, or 0 when unknown.
        total: u64,
    },
    /// The artifact is on disk and is being applied.
    Installing,
    /// The bundle was replaced; BOSS has to restart to run it.
    Restart,
    /// The download could not be applied automatically and is waiting at
    /// `path`.
    OpenManually {
        /// Where the download landed.
        path: PathBuf,
        /// One line explaining what to do with it.
        message: String,
    },
    /// Something went wrong; the text is what the updater said.
    Failed {
        /// Message from `boss_update`.
        error: String,
    },
}

/// What the banner asks the app to do.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum UpdateBannerEvent {
    /// Download the release and apply it.
    Install,
    /// Quit and come back on the new bundle.
    Restart,
    /// Reveal the file the user has to move themselves.
    Reveal(PathBuf),
    /// Stop offering this version for now.
    Dismiss,
}

/// Percentage text for a download, or `None` when the total is unknown.
///
/// The updater reports `total = 0` when the server sends no `Content-Length`,
/// which is common behind a CDN redirect, so bytes are shown instead of a
/// percentage that would be a lie.
pub fn progress_label(done: u64, total: u64) -> SharedString {
    const MB: f64 = 1024.0 * 1024.0;
    if total == 0 {
        return format!("Downloading… {:.1} MB", done as f64 / MB).into();
    }
    let percent = ((done as f64 / total as f64) * 100.0).clamp(0.0, 100.0);
    format!("Downloading… {percent:.0}% of {:.1} MB", total as f64 / MB).into()
}

/// The one line the banner shows for a stage.
pub fn stage_label(version: &str, stage: &UpdateStage) -> SharedString {
    match stage {
        UpdateStage::Available => format!("BOSS {version} is available.").into(),
        UpdateStage::Downloading { done, total } => progress_label(*done, *total),
        UpdateStage::Installing => "Installing…".into(),
        UpdateStage::Restart => format!("BOSS {version} is installed. Restart to use it.").into(),
        UpdateStage::OpenManually { message, .. } => message.clone().into(),
        UpdateStage::Failed { error } => format!("The update failed: {error}").into(),
    }
}

/// Which button the banner offers for a stage, as `(id, label)`.
///
/// A download in flight offers nothing: pressing "Download and install" twice
/// would run two downloads into the same file.
pub fn stage_action(stage: &UpdateStage) -> Option<(&'static str, &'static str)> {
    match stage {
        UpdateStage::Available => Some(("update-install", "Download and install")),
        UpdateStage::Downloading { .. } | UpdateStage::Installing => None,
        UpdateStage::Restart => Some(("update-restart", "Restart BOSS")),
        UpdateStage::OpenManually { .. } => Some(("update-reveal", "Show the download")),
        UpdateStage::Failed { .. } => Some(("update-retry", "Try again")),
    }
}

/// The update bar. Renders nothing until [`UpdateBanner::offer`] is called.
pub struct UpdateBanner {
    version: Option<String>,
    stage: UpdateStage,
    dismissed: bool,
}

impl Default for UpdateBanner {
    fn default() -> Self {
        Self::new()
    }
}

impl EventEmitter<UpdateBannerEvent> for UpdateBanner {}

impl UpdateBanner {
    /// A banner with nothing to offer.
    pub fn new() -> Self {
        Self { version: None, stage: UpdateStage::Available, dismissed: false }
    }

    /// Offer a release. A version the user already dismissed is offered
    /// again only if it is a different one.
    pub fn offer(&mut self, version: String, cx: &mut Context<Self>) {
        if self.version.as_deref() != Some(version.as_str()) {
            self.dismissed = false;
            self.stage = UpdateStage::Available;
        }
        self.version = Some(version);
        cx.notify();
    }

    /// Move the banner to another stage.
    pub fn set_stage(&mut self, stage: UpdateStage, cx: &mut Context<Self>) {
        self.stage = stage;
        cx.notify();
    }

    /// Report download progress.
    pub fn set_progress(&mut self, done: u64, total: u64, cx: &mut Context<Self>) {
        self.set_stage(UpdateStage::Downloading { done, total }, cx);
    }

    /// The version being offered, if any.
    pub fn version(&self) -> Option<&str> {
        self.version.as_deref()
    }

    /// Where the banner is in the flow.
    pub fn stage(&self) -> &UpdateStage {
        &self.stage
    }

    /// Should anything be drawn at all?
    pub fn is_visible(&self) -> bool {
        self.version.is_some() && !self.dismissed
    }

    /// Stop showing this offer.
    pub fn dismiss(&mut self, cx: &mut Context<Self>) {
        self.dismissed = true;
        cx.notify();
    }

    fn on_action(&mut self, cx: &mut Context<Self>) {
        match self.stage.clone() {
            UpdateStage::Available | UpdateStage::Failed { .. } => {
                // Retrying starts from the top: `download` reuses a verified
                // file already on disk, so this is cheap when it was the
                // install that failed.
                self.set_stage(UpdateStage::Downloading { done: 0, total: 0 }, cx);
                cx.emit(UpdateBannerEvent::Install);
            }
            UpdateStage::Restart => cx.emit(UpdateBannerEvent::Restart),
            UpdateStage::OpenManually { path, .. } => cx.emit(UpdateBannerEvent::Reveal(path)),
            UpdateStage::Downloading { .. } | UpdateStage::Installing => {}
        }
    }
}

impl Render for UpdateBanner {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if !self.is_visible() {
            return div().into_any_element();
        }
        let version = self.version.clone().unwrap_or_default();
        let failed = matches!(self.stage, UpdateStage::Failed { .. });
        let mut bar = h_flex()
            .w_full()
            .flex_shrink_0()
            .items_center()
            .gap_2()
            .px_3()
            .py_1p5()
            .border_b_1()
            .border_color(cx.theme().border)
            .bg(if failed { cx.theme().danger } else { cx.theme().accent })
            .text_sm()
            .child(div().flex_1().min_w_0().truncate().child(stage_label(&version, &self.stage)));

        if let Some((id, label)) = stage_action(&self.stage) {
            bar = bar.child(
                Button::new(id).label(label).small().primary().on_click(cx.listener(|this, _, _, cx| this.on_action(cx))),
            );
        }

        bar.child(
            Button::new("update-dismiss")
                .icon(IconName::Close)
                .ghost()
                .xsmall()
                .tooltip("Dismiss")
                .on_click(cx.listener(|this, _, _, cx| {
                    this.dismiss(cx);
                    cx.emit(UpdateBannerEvent::Dismiss);
                })),
        )
        .min_h(px(32.))
        .into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::{AppContext as _, TestAppContext};

    #[test]
    fn progress_reads_as_bytes_when_the_server_sends_no_length() {
        assert_eq!(progress_label(5 * 1024 * 1024, 0), "Downloading… 5.0 MB");
        assert_eq!(progress_label(0, 0), "Downloading… 0.0 MB");
    }

    #[test]
    fn progress_reads_as_a_percentage_when_the_total_is_known() {
        let total = 200 * 1024 * 1024;
        assert_eq!(progress_label(0, total), "Downloading… 0% of 200.0 MB");
        assert_eq!(progress_label(total / 2, total), "Downloading… 50% of 200.0 MB");
        assert_eq!(progress_label(total, total), "Downloading… 100% of 200.0 MB");
        // A server that overshoots its own Content-Length cannot show 130%.
        assert_eq!(progress_label(total * 2, total), "Downloading… 100% of 200.0 MB");
    }

    #[test]
    fn every_stage_has_a_line_and_the_busy_ones_offer_no_button() {
        let stages = [
            UpdateStage::Available,
            UpdateStage::Downloading { done: 1, total: 2 },
            UpdateStage::Installing,
            UpdateStage::Restart,
            UpdateStage::OpenManually { path: PathBuf::from("/tmp/BOSS.zip"), message: "Move it".into() },
            UpdateStage::Failed { error: "no network".into() },
        ];
        for stage in &stages {
            assert!(!stage_label("1.2.3", stage).is_empty(), "{stage:?}");
        }
        assert_eq!(stage_action(&UpdateStage::Downloading { done: 1, total: 2 }), None);
        assert_eq!(stage_action(&UpdateStage::Installing), None);
        assert_eq!(stage_action(&UpdateStage::Available).unwrap().1, "Download and install");
        assert_eq!(stage_action(&UpdateStage::Restart).unwrap().1, "Restart BOSS");
        assert!(stage_label("1.2.3", &UpdateStage::Restart).contains("1.2.3"));
        assert_eq!(
            stage_label("1.2.3", &stages[4]),
            "Move it",
            "the installer's own wording is what the user sees"
        );
    }

    #[gpui::test]
    fn the_banner_is_hidden_until_a_release_is_offered(cx: &mut TestAppContext) {
        let banner = cx.new(|_| UpdateBanner::new());
        banner.read_with(cx, |b, _| assert!(!b.is_visible()));
        banner.update(cx, |b, cx| b.offer("1.4.0".into(), cx));
        banner.read_with(cx, |b, _| {
            assert!(b.is_visible());
            assert_eq!(b.version(), Some("1.4.0"));
            assert_eq!(b.stage(), &UpdateStage::Available);
        });
        banner.update(cx, |b, cx| b.dismiss(cx));
        banner.read_with(cx, |b, _| assert!(!b.is_visible()));
        // The same version stays dismissed; a newer one comes back.
        banner.update(cx, |b, cx| b.offer("1.4.0".into(), cx));
        banner.read_with(cx, |b, _| assert!(!b.is_visible()));
        banner.update(cx, |b, cx| b.offer("1.5.0".into(), cx));
        banner.read_with(cx, |b, _| assert!(b.is_visible()));
    }

    #[gpui::test]
    fn pressing_install_asks_the_app_and_shows_progress(cx: &mut TestAppContext) {
        let banner = cx.new(|_| UpdateBanner::new());
        let events = std::rc::Rc::new(std::cell::RefCell::new(Vec::new()));
        let seen = events.clone();
        let _sub = cx.update(|cx| {
            cx.subscribe(&banner, move |_, event: &UpdateBannerEvent, _| seen.borrow_mut().push(event.clone()))
        });

        banner.update(cx, |b, cx| {
            b.offer("1.4.0".into(), cx);
            b.on_action(cx);
        });
        cx.run_until_parked();
        assert_eq!(events.borrow().as_slice(), [UpdateBannerEvent::Install]);
        // The button is gone while the download runs, so a second press
        // cannot start a second one.
        banner.read_with(cx, |b, _| assert!(stage_action(b.stage()).is_none()));

        banner.update(cx, |b, cx| b.set_progress(50, 100, cx));
        banner.read_with(cx, |b, _| assert_eq!(stage_label("1.4.0", b.stage()), "Downloading… 50% of 0.0 MB"));

        banner.update(cx, |b, cx| {
            b.set_stage(UpdateStage::Restart, cx);
            b.on_action(cx);
        });
        cx.run_until_parked();
        assert_eq!(events.borrow().last(), Some(&UpdateBannerEvent::Restart));
    }

    #[gpui::test]
    fn a_manual_install_asks_for_the_file_to_be_revealed(cx: &mut TestAppContext) {
        let banner = cx.new(|_| UpdateBanner::new());
        let events = std::rc::Rc::new(std::cell::RefCell::new(Vec::new()));
        let seen = events.clone();
        let _sub = cx.update(|cx| {
            cx.subscribe(&banner, move |_, event: &UpdateBannerEvent, _| seen.borrow_mut().push(event.clone()))
        });
        let path = PathBuf::from("/tmp/BOSS-1.4.0.zip");
        banner.update(cx, |b, cx| {
            b.offer("1.4.0".into(), cx);
            b.set_stage(UpdateStage::OpenManually { path: path.clone(), message: "Move it in".into() }, cx);
            b.on_action(cx);
        });
        cx.run_until_parked();
        assert_eq!(events.borrow().as_slice(), [UpdateBannerEvent::Reveal(path)]);
    }

    #[gpui::test]
    fn a_failure_can_be_retried(cx: &mut TestAppContext) {
        let banner = cx.new(|_| UpdateBanner::new());
        let events = std::rc::Rc::new(std::cell::RefCell::new(Vec::new()));
        let seen = events.clone();
        let _sub = cx.update(|cx| {
            cx.subscribe(&banner, move |_, event: &UpdateBannerEvent, _| seen.borrow_mut().push(event.clone()))
        });
        banner.update(cx, |b, cx| {
            b.offer("1.4.0".into(), cx);
            b.set_stage(UpdateStage::Failed { error: "checksum".into() }, cx);
        });
        banner.read_with(cx, |b, _| {
            assert!(stage_label("1.4.0", b.stage()).contains("checksum"));
            assert_eq!(stage_action(b.stage()).unwrap().1, "Try again");
        });
        banner.update(cx, |b, cx| b.on_action(cx));
        cx.run_until_parked();
        assert_eq!(events.borrow().as_slice(), [UpdateBannerEvent::Install]);
        banner.read_with(cx, |b, _| assert!(matches!(b.stage(), UpdateStage::Downloading { .. })));
    }
}
