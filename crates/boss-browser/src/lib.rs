//! boss-browser: the embedded browser tab and its automation surface.
//!
//! In Electron this was the `<webview>` tag plus `webContents.loadURL /
//! executeJavaScript / capturePage`. Here a [`BrowserView`] entity shows a
//! wry webview under its GPUI bounds, a [`PageHandle`] drives the page from
//! any thread through [`PageAutomation`], and a [`BrowserRegistry`] maps the
//! six `boss_browser_*` bus tools onto open tabs.

pub mod automation;
pub mod registry;
mod screenshot;
pub mod scripts;
pub mod tools;
pub mod view;
mod webview;

pub use automation::*;
pub use registry::*;
pub use tools::*;
pub use view::*;
