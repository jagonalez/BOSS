//! `ThreadPane`: transcript over composer. This is what the shell mounts.

use crate::model::ThreadModel;
use crate::transcript::composer::{Composer, ComposerEvent};
use crate::transcript::view::{TranscriptEvent, TranscriptView};
use gpui::*;
use gpui_component::v_flex;

/// One thread's transcript and composer, stacked vertically.
pub struct ThreadPane {
    transcript: Entity<TranscriptView>,
    composer: Entity<Composer>,
    _subscriptions: Vec<Subscription>,
}

impl EventEmitter<ComposerEvent> for ThreadPane {}
impl EventEmitter<TranscriptEvent> for ThreadPane {}

impl ThreadPane {
    /// Build both views over `model` and forward their events.
    pub fn new(model: Entity<ThreadModel>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let transcript = cx.new(|cx| TranscriptView::new(model.clone(), cx));
        let composer = cx.new(|cx| Composer::new(model, window, cx));
        let subscriptions = vec![
            cx.subscribe(&composer, |_, _, event: &ComposerEvent, cx| cx.emit(event.clone())),
            cx.subscribe(&transcript, |_, _, event: &TranscriptEvent, cx| cx.emit(event.clone())),
        ];
        Self { transcript, composer, _subscriptions: subscriptions }
    }

    /// The message list.
    pub fn transcript(&self) -> &Entity<TranscriptView> {
        &self.transcript
    }

    /// The composer.
    pub fn composer(&self) -> &Entity<Composer> {
        &self.composer
    }
}

impl Render for ThreadPane {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        v_flex()
            .size_full()
            .child(div().flex_1().min_h_0().w_full().child(self.transcript.clone()))
            .child(self.composer.clone())
    }
}
