# PineVoice Chrome Flash

Flash a Pine64 PineVoice (Bouffalo Lab BL606P) from desktop Chrome/Edge with no
toolchain, using the Web Serial API. This repo is a thin fork of Bouffalo Lab's
official [`bflb_flash_web`](https://github.com/bouffalolab/bflb_flash_web) with
**BL606P support added** and **preset images for this device** (0.9.2 okay-nabu
plus a 0.9.1 stock rollback image). The original whole.bin flow for
BL602/BL616/BL616CL/BL618DG is unchanged.

> **Status:** the BL606P target and the write plan are verified two ways (see
> [Verification](#verification)) — protocol parity against the `bflb_iot_tool`
> 1.10.0 source, and an end-to-end test against a mock BootROM. A run against
> real hardware has not happened yet; the first hardware run is the real test.

## Flash in Chrome

1. **Serve this directory** over localhost or HTTPS (Web Serial requires a
   secure context; `file://` does not work):

   ```bash
   git clone https://github.com/jakepi-bot/pinevoice-chrome-flash.git
   cd pinevoice-chrome-flash
   python3 -m http.server 8000
   ```

   (Or use the GitHub Pages build: <https://jakepi-bot.github.io/pinevoice-chrome-flash/>.)

2. Open `http://localhost:8000` in **desktop Chrome or Edge**.

3. **Put the device in the ROM bootloader**: power the PineVoice off, hold the
   **center ring**, keep holding, power it back on with the USB-C data cable
   connected to the PC. Leave the cable attached. (The page also tries the
   DTR/RTS auto-reset first — if the handshake fails, do the manual
   power-cycle above and click connect again.)

4. Click **Connect serial port** and pick the PineVoice serial port (a CDC/ACM device).

5. In **Firmware**, pick the image in **PineVoice preset image**:
   - `0.9.2-okay-nabu` — the new firmware (okay nabu wake word),
   - `0.9.1-stock` — the stock rollback image.

6. Click **Flash preset …** and wait. The page fetches each segment, checks its
   SHA-256 against `images/manifest.json`, erases/writes/verifies it, and
   reports success per segment. Use **Save log** to save the log as evidence.

7. When it finishes (and **Run via RTS when done** is checked) the device resets
   into the new firmware. If that checkbox was off, power-cycle it manually.

### If the flash fails

The device stays in the ROM bootloader — nothing is lost. Fix the cause
(cable/port), reconnect and retry. If the new firmware is on the device but
does not boot, run steps 3–6 again with the `0.9.1-stock` preset: that is the
documented rollback, and it writes the same layout back.

## What gets written (and what is never touched)

Each preset is five segments, byte-identical to what
`bflb_iot_tool --firmware … --pt … --media … --mfg …` writes (the write plan
comes from the tool's own generated `eflash_loader_cfg.ini`):

| Address   | File                | Contents                         |
| --------- | ------------------- | -------------------------------- |
| `0xE000`  | `partition.bin`     | partition table (copy A)         |
| `0xF000`  | `partition.bin`     | partition table (copy B)         |
| `0x10000` | `whole_img.bin`     | firmware image (BFNP header)     |
| `0x77C000`| `whole_img_mfg.bin` | manufacturing/calibration image  |
| `0xEE8000`| `media.bin`         | littlefs media (wake-word model) |

Never written: **boot2** (`0x0–0xDFFF`), **kv** (`0xFA0000+`, Wi-Fi
credentials — DHCP reservation and HA pairing survive), factory/user
(`0xFA2000+`). The test asserts all of this per byte.

## Verify after flashing

Serial console (no terminal emulator needed — raw `stty` + `cat`):

```bash
stty -F /dev/ttyACM0 115200 raw -echo   # if garbage, retry 2000000
cat /dev/ttyACM0 | tee ~/pinevoice-boot-0.9.2.log
```

The boot log must show:

- `DEFAULT_SOFTWARE_VER: 0.9.2` (was 0.9.1),
- the C906 wake-word engine loading `okay_nabu.json` / `okay_nabu.tflite` with
  tensor arena **26080** bytes (baseline hey_jarvis was 22860 — an alloc
  failure here means the wake word is dead → roll back),
- no reboot loop (3+ consecutive boots → stop and roll back).

Then network + Home Assistant:

```bash
ping -c3 192.168.4.176                                   # same IP (DHCP by MAC)
timeout 3 bash -c 'exec 3<>/dev/tcp/192.168.4.176/10700 && echo WYOMING_UP'
```

HA's **PineVoice** Wyoming entry reconnects on its own. Wake-word check at the
speaker: say **"okay nabu"** (should trigger, 5 tries), then **"hey jarvis"**
(must not trigger).

## Images and provenance

Built 2026-11-15 with the SDK's own flash tool (`bflb_iot_tool --build`, same
arguments as `flash.sh full`), so the segments are what a CLI flash would
write. Checksums: `images/SHA256SUMS`.

- `0.9.2-okay-nabu` — `pinevoice_smartspeaker_sdk` branch `okay-nabu`,
  root `38f7498`; `yoc_rfpa.bin` sha256 `5e682f50…`.
- `0.9.1-stock` — upstream `master` root `9619710` (stock rebuild);
  `yoc_rfpa.bin` sha256 `16643ff2…`.

## Verification

`node test/run.js` (no dependencies) drives the **real** `BflbFlasher` +
`pvflash` segment loop against a mock BL606P BootROM that implements the
`bflb_iot_tool` UART protocol and computes XIP SHA-256 over the bytes it
actually received. It asserts, for both images:

- every segment lands at its manifest address, byte-identical (XIP SHA match),
- boot2 and kv regions untouched (per-byte sentinel check),
- erase ranges stay inside `0xE000–0xF9FFFF`,
- `CLOCK_SET` = irq + 2000000 baud + the SDK `clock_para.bin` (28 B),
- `FLASH_SET_PARA` = `0x014180` (pin 0x80, clock 0x41, io mode 1, delay 0),
  with `flash_para.bin` appended only when JEDEC byte 3 ≠ 0x80,
- a corrupted manifest SHA-256 is rejected before any flash command.

Protocol parity was additionally checked line-by-line against the
`bflb-iot-tool` 1.10.0 source (PyPI): handshake, `GET_BOOT_INFO`,
`CLOCK_SET`, `FLASH_SET_PARA`, JEDEC, erase `(start, end-1)`, write chunks,
`FLASH_WRITE_CHECK`, XIP SHA `0x60/0x3e/0x61`, and the exact
file/address write list.

**Not yet verified:** a run against real hardware. First hardware run should be
watched end to end (page log + serial capture).

## Troubleshooting

- **Handshake fails / "Timed out waiting for device response"** — device is not in the ROM
  bootloader (still running its app) or the cable dropped. Redo the
  power-cycle-into-bootloader dance, keep the cable attached, reconnect.
- **Port missing after a power-cycle** — the CDC device re-enumerates; click
  connect again and re-pick it.
- **SHA-256 mismatch on fetch** — the served files do not match
  `images/manifest.json`; re-clone, do not edit image files by hand.
- **Erase/write error codes** (`0x0003`, `0x0006`, …) — retry once; if it
  repeats, re-enter the bootloader and retry. Do not power-cycle mid-write
  unless the port is stuck.
- The log panel records every protocol step; keep it (**Save log**) for any
  failure report.

## Upstream and changes

Files `protocol.js`, `loader.js`, `targets/{bl602,bl616,bl616cl,bl618dg}*` and
the page skeleton are Bouffalo Lab's (`bouffalolab/bflb_flash_web`, no license
file upstream; used here to flash Bouffalo hardware). Changes on top:

- `targets/bl606p.js` + `targets/bl606p/{clock,flash}_para.bin` — BL606P
  target from the SDK's `eflash_loader_cfg.ini` (`load_function = 2`).
- `targets/index.js` — register bl606p; bl606p is excluded from auto-detect
  (`autoDetect: false`) and must be selected explicitly (the CLI tool does not
  validate the BL606P boot-info id either, so detection is permissive).
- `loader.js` — skip `autoDetect: false` targets during auto-probe.
- `pvflash.js` — preset segment loop (fetch → SHA-256 → flash per address).
- `app.js` / `index.html` — preset selector, BL606P option, save-log button.
- `images/` — the two presets + manifest + checksums.
- `test/run.js` — mock-BootROM end-to-end test.
