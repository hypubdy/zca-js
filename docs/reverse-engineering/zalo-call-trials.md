# Native calling trials and selected approach

Date: 2026-10-21. Host: macOS arm64, Node v24.22.0.
Target: installed Zalo Desktop 26.10.20.

**Selected approach: run the current ZaloCall helper as a sidecar, control it
through IPC, and bridge PCM through two isolated virtual audio devices.**
This is the strongest next implementation candidate from the local trials.
It is not yet a validated end-to-end calling solution.

## What actually ran

| Trial | Observed result | Meaning |
| --- | --- | --- |
| Load old `zcall_mac.node` in current Node | `ERR_DLOPEN_FAILED`: x86_64 binary incompatible with arm64 host | Direct loading fails in the current runtime; a matching x86 runtime was not tested |
| Launch installed `ZaloCall` with private socket paths | Both channels connected; decrypted `update/native-ready` at 125 ms | A Node process can host the helper's IPC without the Electron parent |
| Send synthetic offline init | Native returned a 3-byte ACK | Transport accepted the command; ACK alone does not prove all init fields are semantically valid |
| Copy the complete helper bundle to `/tmp` and launch | Both channels connected; `native-ready`, then ACK | The helper can start outside the original Zalo bundle location on this host |
| Query devices on copied helper | `response/listDevice` returned at 328 ms | An actual request/response exchange works, beyond startup |
| Select Teams virtual input/output, then query again | Engine returned both selected virtual device GUIDs at 237 ms | Device selection is exposed over IPC; this did not open a call |
| CoreAudio virtual-device loopback | Start succeeded; 96,256 float samples captured and sent in approximately 2 seconds | A local uncompressed audio path works on this machine |
| Frequency check of captured loopback | Sent 440 Hz at amplitude 0.1; captured amplitude 0.09945894; control 997 Hz amplitude 0.00000827 | Captured samples contain the generated tone, rather than merely some nonzero signal |
| Frida attach to the trial helper | `Unable to access process ... from the current user account` | PCM hooks could not be installed under current host permissions |

No credentials were supplied and no calls were placed. IPC used unique temporary
socket paths, never the running Zalo instance's sockets. Trial children were
terminated after ten seconds. Audio probing opened only the explicitly selected
Teams virtual device; it did not capture a physical microphone or change the
macOS default device.

The copy test reused the current machine's OS frameworks, installed audio
drivers and existing host environment. It does not establish clean-machine
portability or permission behavior on another Mac.

## Why this approach

Three necessary building blocks now have runtime evidence: standalone helper
startup, bidirectional control/device selection, and local PCM transport through
a virtual device. Reusing the current engine avoids first reconstructing the
network media protocol. Using OS audio devices also avoids depending on private
C++ object layouts or patching callback instructions.

Production routing must use **two independent virtual buses**:

```text
Remote audio -> ZaloCall speaker output -> bus RX -> app PCM readable
App PCM writable -> bus TX -> ZaloCall microphone input -> remote audio
```

The trial used one existing Teams virtual device solely to prove local loopback.
Using that same bus for both directions in a real call can create a feedback
path. The installed Teams driver is not a proposed production dependency;
isolated buses must be provisioned and tested before call integration.

## Other candidates

- **Helper IPC with direct PCM:** startup/control pass. No raw PCM IPC surface
  has been established; device I/O is the verified audio boundary so far.
- **Old Node addon:** direct load fails on this host. Static symbols also show
  direct V8 and `node_module_register` dependencies rather than N-API. Rosetta
  plus an older compatible runtime may be possible, but has not been tested.
- **Native hooks:** static symbols identify
  `zrtc::AudioDevice::RecordedDataIsAvailable` at preferred arm64 address
  `0x10024f420` and `NeedMorePlayData` at `0x10024fa80` (ASLR must be applied).
  The attach trial failed before any hook was installed. No code signing changes
  or elevated debugger attach were attempted.
- **Independent engine:** not implemented or runtime-tested. Presence of
  WebRTC-related symbols does not establish wire compatibility with a standard
  WebRTC client. No complete codec/transport/key negotiation reconstruction exists.

The current REA session had native inspection tools but no configured deep
decompiler. Static native findings here came from Mach-O inspection, `nm`,
`c++filt` and wrapper source; no native pseudocode reconstruction is claimed.

## Remaining acceptance gate

Authenticated inbound call -> answer -> remote speech captured as PCM -> app
test tone/TTS heard on the remote phone -> simultaneous full duplex -> end ->
next call. This requires a cooperating second account/device and working
signaling/session integration. It has **not** been tested.

Still unverified: web-session interoperability with the desktop engine, mapping
incoming controls to its native init requirements, audio routing during an
actual call, latency/echo, clean-machine packaging and behavior after updates.
Do not treat the local loopback result as remote call audio validation.

## Reproduce local experiments

The harness reads only the installed ASAR's bundled IPC transport constant;
it does not execute the bundled JavaScript. It uses AES-128-CBC with a zero IV,
hex encoding, `$` delimiters and ACKs, matching the inspected desktop bridge.
This bounded harness sends only unfragmented commands; it is not a production
IPC implementation.

```sh
node scripts/trial-zalo-call.mjs --init --devices
ditto /Applications/Zalo.app/Contents/ZaloHelper.app /tmp/StandaloneZaloHelper.app
node scripts/trial-zalo-call.mjs --executable /tmp/StandaloneZaloHelper.app/Contents/MacOS/ZaloCall --init --devices --virtual-devices
clang scripts/trial-audio-loopback.c -o /tmp/trial-audio-loopback -framework CoreAudio -framework CoreFoundation
/tmp/trial-audio-loopback MSLoopbackDriverDevice_UID
```

`--virtual-devices` selects only the trial helper's audio devices. The CoreAudio
probe rejects any UID other than the Teams virtual device. Without a UID it
only enumerates device formats. No installation is performed by these scripts.

For an already installed Frida module, the IPC harness also accepts
`--frida-module /absolute/path/to/frida/build/src/frida.js`. This only attempts
to attach observers to the child created by that run; it does not attach to
the user's running Zalo process or collect PCM contents.

## Evidence

- Sanitized per-trial events and audio measurements:
  [zalo-call-trial-results.json](./zalo-call-trial-results.json).
- Helper SHA-256:
  `f1ac81228f235e92d480dfe4619d568b0a84a5abd70fc73256dcab5f73aa3f3e`.
- REA Mach-O parent evidence:
  `ev_d82ff3ce166ada811ba092a02439a06a51ff32e1da309f46535b3c156adf8059`.
  Imports/exports are non-exhaustive; absent symbols do not prove absent behavior.
- Complete REA bundle: `/tmp/zalo-call-analysis/native-trial-rea-evidence.json`.
- Static audio inventory: `/tmp/zalo-call-analysis/native-audio-inventory.txt`.
- Raw runtime reports: paths recorded in the sanitized JSON. They include local
  device names/IDs and are deliberately kept outside the repository.
