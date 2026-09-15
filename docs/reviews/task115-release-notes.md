# Agora Desktop — Installation and Environment Preview

Draft only. No release version or publication has been approved. The Go regression reasoning-field fix passed the final delivery gates; the original failures remain recorded in the acceptance evidence. The validation candidate uses source commit `891bc93420b6e7df0e18cae8d930c4d15394c61f`; its internal application version is `0.0.0`.

## Included in this preview

- Open Agora as a macOS application; it starts and manages its local service.
- Check local service readiness, secure credential availability and bundled development tools.
- Bundled Node 24.20.0, Git 2.53.0, npm 11.19.0, pnpm 9.15.9 and native helpers.
- Single-instance control, visible startup failures, explicit service restart and normal application shutdown.

Project development is not enabled in this preview. There is no Docker execution mode in the new desktop interface. Closing the window keeps Agora running in the background; choose **Agora → Quit Agora** to stop it.

## Platform and validation limits

Apple Silicon only. The application targets macOS 15.0 or later. This candidate was tested on macOS 26.5 (25F71); clean macOS 15 installation validation remains unverified under DEF-018. The project owner explicitly waived this unavailable-device check for the current Phase 11 acceptance; it does not block this preview candidate. Testing on the existing development machine does not establish clean-machine compatibility across the supported range.

This application uses ad-hoc signing and **has not been notarized by Apple**. macOS may prevent it from opening until you explicitly allow it in System Settings → Privacy & Security. Do not disable Gatekeeper or remove quarantine attributes. Only approve the exact application you downloaded from the intended release and verified against its checksum.

## Installation

When a release is approved, its assets will include an Apple Silicon DMG and SHA-256 checksums.

1. Download the DMG and checksum file from that release.
2. Optionally verify the download in Terminal with `shasum -a 256 -c SHA256SUMS`, using the DMG entry from the published checksum file.
3. Open the DMG and copy Agora to Applications. Quit an existing Agora instance before replacing its application bundle.
4. Open Agora. If macOS blocks this unnotarized application, follow its explicit user-authorization flow in Privacy & Security, then open it again.
5. Confirm that Local service, Secure credentials and Development tools show their ready states. If credentials are locked or access is denied, follow the recovery guidance; do not reset credentials to hide an access failure.

This candidate's downloaded DMG was tested through Safari and retained quarantine. The copied application ran through macOS App Translocation and displayed all three ready states. This was an existing user environment; no new first-open authorization dialog appeared during that run. GitHub-hosted download validation has not been performed because no release has been published.

## Updates and data

Updates are manual: quit the old app, replace the application bundle, then reopen it. The stable application state directory and credential identity are separate from the bundle. An unrecognized state format or incomplete migration blocks normal startup and requires recovery. Updates do not automatically resume model work. Legacy Docker task data is not imported or automatically removed.

Previous isolated Keychain tests exercised a changed helper's denied access, explicit human authorization, reuse of the original key, ciphertext preservation and lock/unlock recovery. The candidate retains identical Keychain helper and service bootstrap bytes. First-time installation and every possible macOS authorization prompt are separate validation cases.

## Candidate evidence

The tested binaries were removed after evidence archival at the owner's request to save disk space. The checksum below identifies the historical validation artifact; publication requires rebuilding and verifying the final release assets.

- DMG: `Agora-darwin-arm64.dmg` — 317,283,884 bytes.
- SHA-256: `ff770dd6523d77116bf13a25272099e7c177c5a5df51671c52848e026e6860e0`.
- Validation: Node 7/7 and Vitest 189 files / 1,340 tests passed with zero failures or skips; all three live OpenCode Go `deepseek-v4-flash` tests passed. Static checks passed. See the [Phase 11 acceptance report](task115-phase11-exit.md) for native, installation and remaining platform evidence.

Before publication, confirm the release version, apply the recorded Phase 11 acceptance exception and retain its platform disclosure, merge through the human-reviewed development/release workflow, and verify that the published assets match the final approved commit. A version change that changes packaged inputs requires corresponding rebuild and validation.
