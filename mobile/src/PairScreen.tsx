import React, { useEffect, useState } from 'react'
import { ActivityIndicator, Linking, Pressable, StyleSheet, Text, View } from 'react-native'
import { CameraView, useCameraPermissions } from 'expo-camera'
import { decodePairing } from './relay'
import { theme } from './theme'

/**
 * Pairing by camera. A native scanner rather than a web one, because iOS
 * refuses camera access to an installed web app in some contexts and hides
 * crypto.subtle entirely on plain http — the two limits that made the web
 * client unusable for this on a phone.
 */
export function PairScreen({ onScanned, error }: {
  onScanned(payload: { r: string; d: string; s: string; j?: string }): void
  error?: string
}): React.JSX.Element {
  const [permission, requestPermission] = useCameraPermissions()
  const [scanned, setScanned] = useState(false)
  const [invalid, setInvalid] = useState<string | null>(null)

  useEffect(() => {
    if (permission && !permission.granted && permission.canAskAgain) void requestPermission()
  }, [permission])

  if (!permission) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={theme.accent} />
      </View>
    )
  }

  if (!permission.granted) {
    return (
      <View style={styles.center}>
        <Text style={styles.title}>Camera access needed</Text>
        <Text style={styles.body}>
          BOSS pairs by scanning the QR code shown in Settings → Remote access on your desktop.
        </Text>
        <Pressable
          style={styles.button}
          onPress={() => (permission.canAskAgain ? void requestPermission() : void Linking.openSettings())}
        >
          <Text style={styles.buttonText}>
            {permission.canAskAgain ? 'Allow camera' : 'Open Settings'}
          </Text>
        </Pressable>
      </View>
    )
  }

  return (
    <View style={styles.fill}>
      <CameraView
        style={styles.fill}
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={({ data }) => {
          // The camera fires repeatedly while the code is in frame.
          if (scanned) return
          const payload = decodePairing(data)
          if (!payload) {
            setInvalid('That QR code is not a BOSS pairing code.')
            return
          }
          setScanned(true)
          onScanned(payload)
        }}
      />
      <View style={styles.overlay} pointerEvents="none">
        <View style={styles.reticle} />
        <Text style={styles.hint}>
          Scan the QR code from Settings → Remote access
        </Text>
        {error || invalid ? <Text style={styles.error}>{error ?? invalid}</Text> : null}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: theme.bg },
  center: { flex: 1, backgroundColor: theme.bg, alignItems: 'center', justifyContent: 'center', padding: 28 },
  title: { color: theme.text, fontSize: 19, fontWeight: '600', marginBottom: 10 },
  body: { color: theme.muted, fontSize: 15, textAlign: 'center', lineHeight: 21 },
  button: {
    marginTop: 22,
    backgroundColor: theme.accent,
    paddingVertical: 12,
    paddingHorizontal: 22,
    borderRadius: 10
  },
  buttonText: { color: theme.bg, fontWeight: '700', fontSize: 15 },
  overlay: { position: 'absolute', inset: 0, alignItems: 'center', justifyContent: 'center' },
  reticle: {
    width: 240,
    height: 240,
    borderWidth: 2,
    borderColor: theme.accent,
    borderRadius: 18,
    backgroundColor: 'transparent'
  },
  hint: { color: theme.text, marginTop: 26, fontSize: 15, textAlign: 'center', paddingHorizontal: 30 },
  error: { color: theme.red, marginTop: 14, fontSize: 14, textAlign: 'center', paddingHorizontal: 30 }
})
