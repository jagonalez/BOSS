import QRCode from 'qrcode'

/**
 * Renders a pairing code as a QR data URL.
 *
 * The `qrcode` package does the encoding. An earlier hand-written encoder
 * produced symbols that real decoders rejected, and QR masking and format
 * bits are not worth re-deriving for one screen.
 *
 * Level M tolerates roughly 15% damage, which is enough for a phone camera
 * pointed at a desktop display.
 */
export function pairingQrDataUrl(code: string): Promise<string> {
  return QRCode.toDataURL(code, {
    errorCorrectionLevel: 'M',
    margin: 2,
    scale: 6,
    color: { dark: '#0b0d10', light: '#ffffff' }
  })
}
