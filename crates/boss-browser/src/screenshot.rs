//! Per-platform viewport capture. wry has no unified screenshot API.

use anyhow::Result;
use futures::channel::oneshot;

/// Captures the visible viewport as PNG and delivers it on `reply`.
///
/// macOS: `WKWebView takeSnapshotWithConfiguration:completionHandler:`.
/// Windows: WebView2 `CapturePreview` is not wired yet. Linux: no API.
pub(crate) fn capture_png(webview: &wry::WebView, reply: oneshot::Sender<Result<Vec<u8>>>) {
    platform::capture_png(webview, reply)
}

/// Reads width and height from a PNG's IHDR chunk.
pub(crate) fn png_dimensions(png: &[u8]) -> Option<(u32, u32)> {
    if png.len() < 24 || &png[..8] != b"\x89PNG\r\n\x1a\n" || &png[12..16] != b"IHDR" {
        return None;
    }
    let be = |i: usize| u32::from_be_bytes([png[i], png[i + 1], png[i + 2], png[i + 3]]);
    Some((be(16), be(20)))
}

#[cfg(target_os = "macos")]
mod platform {
    use std::sync::Mutex;

    use anyhow::{Result, anyhow};
    use block2::RcBlock;
    use futures::channel::oneshot;
    use objc2::runtime::AnyObject;
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImage};
    use objc2_foundation::{NSDictionary, NSError, NSString};
    use objc2_web_kit::WKWebView;
    use wry::WebViewExtMacOS;

    pub(super) fn capture_png(webview: &wry::WebView, reply: oneshot::Sender<Result<Vec<u8>>>) {
        let wk = webview.webview();
        let reply = Mutex::new(Some(reply));
        let block = RcBlock::new(move |image: *mut NSImage, error: *mut NSError| {
            // SAFETY: WebKit hands us either a live NSImage or a live NSError for
            // the duration of this callback; we only read them.
            let result = unsafe { convert(image, error) };
            if let Some(tx) = reply.lock().ok().and_then(|mut slot| slot.take()) {
                let _ = tx.send(result);
            }
        });
        let wk: &WKWebView = &wk;
        // SAFETY: called on the main thread with a live WKWebView; the block
        // outlives the call because WebKit retains it until completion.
        unsafe { wk.takeSnapshotWithConfiguration_completionHandler(None, &block) };
    }

    unsafe fn convert(image: *mut NSImage, error: *mut NSError) -> Result<Vec<u8>> {
        if image.is_null() {
            let message = if error.is_null() {
                "WKWebView snapshot returned no image".to_string()
            } else {
                unsafe { &*error }.localizedDescription().to_string()
            };
            return Err(anyhow!(message));
        }
        let image = unsafe { &*image };
        let tiff = image.TIFFRepresentation().ok_or_else(|| anyhow!("snapshot has no bitmap"))?;
        let rep = NSBitmapImageRep::imageRepWithData(&tiff)
            .ok_or_else(|| anyhow!("snapshot bitmap could not be decoded"))?;
        let properties: objc2::rc::Retained<NSDictionary<NSString, AnyObject>> = NSDictionary::new();
        let png = unsafe { rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &properties) }
            .ok_or_else(|| anyhow!("snapshot could not be encoded as PNG"))?;
        Ok(png.to_vec())
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    use anyhow::{Result, anyhow};
    use futures::channel::oneshot;

    pub(super) fn capture_png(_webview: &wry::WebView, reply: oneshot::Sender<Result<Vec<u8>>>) {
        let _ = reply.send(Err(anyhow!("not implemented on this platform")));
    }
}

#[cfg(test)]
mod tests {
    use super::png_dimensions;

    #[test]
    fn reads_ihdr() {
        let mut png = b"\x89PNG\r\n\x1a\n".to_vec();
        png.extend_from_slice(&13u32.to_be_bytes());
        png.extend_from_slice(b"IHDR");
        png.extend_from_slice(&800u32.to_be_bytes());
        png.extend_from_slice(&600u32.to_be_bytes());
        assert_eq!(png_dimensions(&png), Some((800, 600)));
        assert_eq!(png_dimensions(b"nope"), None);
    }
}
