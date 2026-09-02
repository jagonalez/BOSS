//! The PWA shell, baked into the binary.
//!
//! These are the exact bytes the Electron app served. `mobile.html` and
//! `sw.js` were lifted out of the TypeScript template literals in
//! `src/shared/mobile-page.ts` and `src/shared/pwa-assets.ts` (unescaped, not
//! rewritten); `manifest.webmanifest` is the object `WEB_MANIFEST`
//! stringified; the icons are copies of `resources/icons/<n>x<n>.png`. They
//! are copied rather than referenced so the crate builds without the Electron
//! tree beside it.
//!
//! There is no build step: the page is one self-contained document that
//! fetches nothing but these files and the two API routes.

/// The phone site, served at `/`.
pub const MOBILE_PAGE: &str = include_str!("assets/mobile.html");

/// The PWA manifest, served at `/manifest.webmanifest`.
pub const WEB_MANIFEST: &str = include_str!("assets/manifest.webmanifest");

/// The service worker, served at `/sw.js`.
pub const SERVICE_WORKER: &str = include_str!("assets/sw.js");

/// Icons shipped in the binary, smallest first.
const ICONS: &[(u32, &[u8])] = &[
    (96, include_bytes!("assets/96x96.png")),
    (128, include_bytes!("assets/128x128.png")),
    (256, include_bytes!("assets/256x256.png")),
    (512, include_bytes!("assets/512x512.png")),
];

/// The smallest shipped icon at or above `size`, falling back to the largest.
///
/// The manifest asks for 192, which no file is; serving the next size up is
/// what lets the manifest name a size the resources folder does not have.
pub fn icon_at_least(size: u32) -> Option<&'static [u8]> {
    ICONS
        .iter()
        .find(|(candidate, _)| *candidate >= size)
        .or_else(|| ICONS.last())
        .map(|(_, bytes)| *bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_page_is_the_whole_document() {
        assert!(MOBILE_PAGE.starts_with("<!doctype html>"));
        assert!(MOBILE_PAGE.trim_end().ends_with("</html>"));
        // The template-literal escapes must have been unescaped, not carried
        // through: a stray backslash-backtick would be a syntax error in the
        // browser's copy of the script.
        assert!(!MOBILE_PAGE.contains("\\`"));
        assert!(!MOBILE_PAGE.contains("\\${"));
    }

    #[test]
    fn the_page_still_reaches_this_server() {
        assert!(MOBILE_PAGE.contains("/api/request"));
        assert!(MOBILE_PAGE.contains("/api/events"));
        assert!(MOBILE_PAGE.contains("/api/access"));
        assert!(MOBILE_PAGE.contains(r#"<link rel="manifest" href="./manifest.webmanifest">"#));
        assert!(MOBILE_PAGE.contains("navigator.serviceWorker.register('./sw.js')"));
        assert!(MOBILE_PAGE.contains("apple-mobile-web-app-capable"));
    }

    #[test]
    fn the_manifest_parses_and_names_its_icons() {
        let parsed: serde_json::Value = serde_json::from_str(WEB_MANIFEST).unwrap();
        assert_eq!(parsed["name"], "BOSS");
        assert_eq!(parsed["display"], "standalone");
        assert_eq!(parsed["start_url"], "./");
        let icons = parsed["icons"].as_array().unwrap();
        assert_eq!(icons.len(), 3);
        for icon in icons {
            let src = icon["src"].as_str().unwrap();
            let size = src.trim_start_matches("./icon-").trim_end_matches(".png");
            // Every size the manifest names must resolve to real bytes.
            assert!(icon_at_least(size.parse().unwrap()).is_some(), "{src}");
        }
    }

    #[test]
    fn the_service_worker_caches_the_shell_but_never_the_api() {
        assert!(SERVICE_WORKER.contains("boss-shell-v2"));
        assert!(SERVICE_WORKER.contains("'./', './manifest.webmanifest'"));
        assert!(SERVICE_WORKER.contains("url.pathname.indexOf('/api/') === 0"));
        assert!(SERVICE_WORKER.contains("addEventListener('push'"));
    }

    #[test]
    fn icons_are_real_pngs_in_ascending_order() {
        let mut previous = 0;
        for (size, bytes) in ICONS {
            assert!(*size > previous, "icons must be smallest first");
            previous = *size;
            assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n", "{size}x{size} is not a PNG");
        }
    }

    #[test]
    fn a_requested_size_rounds_up_then_clamps() {
        assert_eq!(icon_at_least(1).unwrap().len(), ICONS[0].1.len());
        assert_eq!(icon_at_least(96).unwrap().len(), ICONS[0].1.len());
        // 192 is what the manifest asks for and no file is.
        assert_eq!(icon_at_least(192).unwrap().len(), ICONS[2].1.len());
        assert_eq!(icon_at_least(512).unwrap().len(), ICONS[3].1.len());
        assert_eq!(icon_at_least(4096).unwrap().len(), ICONS[3].1.len());
    }
}
