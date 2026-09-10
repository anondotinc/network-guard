# Anon installer icon

`AnonIcon.png` is the existing Anon brand icon, copied unchanged from
`anondotinc/kit` at commit `0a4fcc23dd608cc0aa95a29f150ad1d7afaf5956`, path
`assets/brand/generated/icon/icon-512x512.png`.

This artwork is **not relicensed under the helper code's MIT license**. The
original kit license is preserved verbatim in `assets/LICENSE` and bundled as
`BrandAssets-LICENSE`. No trademark rights are granted by the code license.
Anon requested its use in the official Network Guard installer; third-party
redistributors must review the artwork's separate license and brand permissions.

Builds derive the macOS `.icns` resource locally with Apple's `sips`/`iconutil`.
No image service, download, telemetry, or new runtime dependency is involved.
The generated icon stays in ignored build output, not source control.
