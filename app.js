(function () {
  "use strict";

  const { concatBytes, bytesToHex, formatErrorCode } = window.BflbFlashProtocol;
  const { BflbFlasher, BAUD_RATE } = window.BflbFlasher;

  const elements = {
    supportNotice: document.querySelector("#support-notice"),
    connectButton: document.querySelector("#connect-button"),
    disconnectButton: document.querySelector("#disconnect-button"),
    fileInput: document.querySelector("#bin-file"),
    dropZone: document.querySelector("#drop-zone"),
    fileName: document.querySelector("#file-name"),
    fileMeta: document.querySelector("#file-meta"),
    chipSelect: document.querySelector("#chip-select"),
    pvRow: document.querySelector("#pv-row"),
    pvImageSelect: document.querySelector("#pv-image-select"),
    autoReset: document.querySelector("#auto-reset"),
    eraseAll: document.querySelector("#erase-all"),
    runAfterFlash: document.querySelector("#run-after-flash"),
    autoFlash: document.querySelector("#auto-flash"),
    flashButton: document.querySelector("#flash-button"),
    cancelButton: document.querySelector("#cancel-button"),
    statusDot: document.querySelector("#status-dot"),
    statusText: document.querySelector("#status-text"),
    stageText: document.querySelector("#stage-text"),
    progressBar: document.querySelector("#progress-bar"),
    progressValue: document.querySelector("#progress-value"),
    log: document.querySelector("#log"),
    clearLogButton: document.querySelector("#clear-log"),
    saveLogButton: document.querySelector("#save-log"),
  };

  let port = null;
  let lastPort = null;
  let connecting = false;
  let bootromLatched = false;
  let transport = null;
  let image = null;
  let manifest = null;
  let pvImage = null;
  let currentSegmentIndex = 0;
  let flashing = false;
  let cancelled = false;

  class SerialTransport {
    constructor(serialPort) {
      this.port = serialPort;
      this.reader = null;
      this.writer = null;
      this.buffer = new Uint8Array();
      this.waiters = new Set();
      this.readError = null;
      this.closed = false;
    }

    async open() {
      await this.port.open({
        baudRate: BAUD_RATE,
        dataBits: 8,
        stopBits: 1,
        parity: "none",
        flowControl: "none",
        bufferSize: 32768,
      });
      this.reader = this.port.readable.getReader();
      this.writer = this.port.writable.getWriter();
      this.baudRate = BAUD_RATE;
      this.closed = false;
      this.readLoop = this.pump();
    }

    async pump() {
      try {
        while (!this.closed) {
          const { value, done } = await this.reader.read();
          if (done) break;
          if (value && value.length) {
            this.buffer = concatBytes(this.buffer, value);
            this.wakeWaiters();
          }
        }
      } catch (error) {
        if (!this.closed) this.readError = error;
      } finally {
        this.wakeWaiters();
      }
    }

    wakeWaiters() {
      for (const resolve of this.waiters) resolve();
      this.waiters.clear();
    }

    async waitForData(timeoutMs) {
      if (this.readError) throw this.readError;
      return new Promise((resolve, reject) => {
        let timer;
        const wake = () => {
          clearTimeout(timer);
          this.waiters.delete(wake);
          resolve();
        };
        timer = setTimeout(() => {
          this.waiters.delete(wake);
          reject(new Error("Timed out waiting for device response"));
        }, timeoutMs);
        this.waiters.add(wake);
      });
    }

    async readExactly(length, timeoutMs = 3000) {
      const deadline = performance.now() + timeoutMs;
      while (this.buffer.length < length) {
        const remaining = deadline - performance.now();
        if (remaining <= 0) throw new Error("Timed out waiting for device response");
        await this.waitForData(remaining);
      }
      const result = this.buffer.slice(0, length);
      this.buffer = this.buffer.slice(length);
      return result;
    }

    async readUntil(sequence, timeoutMs = 3000) {
      const deadline = performance.now() + timeoutMs;
      while (true) {
        const index = findSequence(this.buffer, sequence);
        if (index >= 0) {
          const result = this.buffer.slice(0, index + sequence.length);
          this.buffer = this.buffer.slice(index + sequence.length);
          return result;
        }
        const remaining = deadline - performance.now();
        if (remaining <= 0) throw new Error("Timed out waiting for handshake response");
        await this.waitForData(remaining);
      }
    }

    async write(bytes) {
      await this.writer.write(bytes);
    }

    async setSignals(signals) {
      await this.port.setSignals(signals);
    }

    async releaseStreams() {
      let cleanupError = null;
      if (this.reader) {
        const reader = this.reader;
        try {
          await reader.cancel();
          if (this.readLoop) await this.readLoop;
        } catch (_) {
          // Still try to release the lock so writer cleanup is not skipped.
        }
        try {
          reader.releaseLock();
          this.reader = null;
        } catch (error) {
          cleanupError = error;
        }
      }
      if (this.writer) {
        try {
          this.writer.releaseLock();
          this.writer = null;
        } catch (error) {
          cleanupError ||= error;
        }
      }
      if (!this.reader) this.readLoop = null;
      if (cleanupError) throw cleanupError;
    }

    clearInput() {
      this.buffer = new Uint8Array();
    }

    async readAck(timeoutMs = 3000) {
      const ack = await this.readExactly(2, timeoutMs);
      const text = String.fromCharCode(ack[0], ack[1]);
      if (text === "OK" || text === "PD") return { status: text };
      if (text === "FL") {
        const errorBytes = await this.readExactly(2, timeoutMs);
        const code = errorBytes[0] | (errorBytes[1] << 8);
        throw new Error(`Device returned error ${formatErrorCode(code)}`);
      }
      throw new Error(`Invalid device response 0x${bytesToHex(ack)}`);
    }

    async readResponse(timeoutMs = 3000) {
      const ack = await this.readAck(timeoutMs);
      if (ack.status !== "OK") throw new Error(`Unexpected device response ${ack.status}`);
      const lengthBytes = await this.readExactly(2, timeoutMs);
      const length = lengthBytes[0] | (lengthBytes[1] << 8);
      return this.readExactly(length, timeoutMs);
    }

    async close() {
      this.closed = true;
      this.wakeWaiters();
      await this.releaseStreams();
      if (this.port.readable?.locked || this.port.writable?.locked) {
        throw new Error("Serial data stream is still locked");
      }
      if (this.port.readable || this.port.writable) await this.port.close();
    }
  }

  function findSequence(haystack, needle) {
    outer: for (let index = 0; index <= haystack.length - needle.length; index += 1) {
      for (let inner = 0; inner < needle.length; inner += 1) {
        if (haystack[index + inner] !== needle[inner]) continue outer;
      }
      return index;
    }
    return -1;
  }

  function formatSize(size) {
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KiB`;
    return `${(size / 1024 / 1024).toFixed(2)} MiB`;
  }

  function log(message, level = "info") {
    const row = document.createElement("div");
    row.className = `log-row log-${level}`;
    const time = new Date().toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
    row.textContent = `${time}  ${message}`;
    elements.log.append(row);
    elements.log.scrollTop = elements.log.scrollHeight;
  }

  function setStatus(kind, text) {
    elements.statusDot.dataset.status = kind;
    elements.statusText.textContent = text;
  }

  function setProgress(value, stage) {
    const normalized = Math.max(0, Math.min(100, value));
    elements.progressBar.value = normalized;
    elements.progressValue.textContent = `${Math.round(normalized)}%`;
    if (stage) elements.stageText.textContent = stage;
  }

  function updateControls() {
    const connected = Boolean(transport);
    const usable = connected && !transport.closed;
    elements.connectButton.disabled = connected || flashing;
    elements.disconnectButton.disabled = !connected || flashing;
    elements.fileInput.disabled = flashing;
    elements.chipSelect.disabled = flashing;
    elements.pvImageSelect.disabled = flashing;
    elements.eraseAll.disabled = flashing;
    elements.flashButton.disabled = !usable || (!image && !pvImage) || flashing;
    elements.flashButton.textContent = pvImage ? `Flash preset ${pvImage.id}` : "Flash whole.bin";
    elements.cancelButton.hidden = !flashing;
  }

  async function chooseFile(file) {
    if (!file) return;
    pvImage = null;
    elements.pvImageSelect.value = "";
    const data = new Uint8Array(await file.arrayBuffer());
    if (data.length < 256) throw new Error("File too small to be a valid whole.bin");
    if (String.fromCharCode(...data.slice(0, 4)) !== "BFNP") throw new Error("No Bouffalo Boot Header (BFNP) at file offset 0x0");
    image = data;
    elements.fileName.textContent = file.name;
    elements.fileMeta.textContent = `${formatSize(file.size)} · write address 0x00000000`;
    elements.dropZone.classList.add("has-file");
    setProgress(0, "File ready");
    log(`Loaded ${file.name}, ${file.size} bytes`);
    updateControls();
  }

  // Send the BootROM sync burst straight after the port opens. The BL606P
  // bootloader only listens for a short window after reset, so the host has to
  // start talking immediately instead of waiting for a human to click Flash.
  async function latchBootrom(current) {
    const flasher = new BflbFlasher(current, { onLog: (message, level) => log(message, level) });
    await flasher.handshake(false, 4, 6);
  }

  async function connect() {
    if (!navigator.serial || connecting || flashing) return;
    connecting = true;
    try {
      let target = null;
      const granted = await navigator.serial.getPorts();
      if (lastPort && granted.includes(lastPort)) target = lastPort;
      else if (granted.length === 1) target = granted[0];
      if (!target) target = await navigator.serial.requestPort();
      lastPort = target;
      port = target;
      transport = new SerialTransport(port);
      await transport.open();
      bootromLatched = false;
      // Leave the modem lines idle; they are only wired to BOOT/RESET on UART bridges.
      try { await port.setSignals({ dataTerminalReady: false, requestToSend: false }); } catch (_) { /* not supported */ }
      setStatus("connected", `Connected · ${transport.baudRate.toLocaleString()} baud`);
      log(`Serial port connected at ${transport.baudRate} baud`);
      try {
        await latchBootrom(transport);
        bootromLatched = true;
        setStatus("connected", "BootROM latched · ready to flash");
      } catch (error) {
        log(error.message, "warn");
        log("BootROM did not answer. Power the PineVoice on with the center ring held; this page reconnects and latches it automatically.", "warn");
      }
      updateControls();
      if (bootromLatched && elements.autoFlash?.checked && (pvImage || image)) {
        log("Auto-flash enabled - starting the flash now");
        await flash();
      }
    } catch (error) {
      transport = null;
      port = null;
      bootromLatched = false;
      if (error.name !== "NotFoundError") {
        setStatus("error", "Connection failed");
        log(error.message, "error");
      }
      updateControls();
    } finally {
      connecting = false;
    }
  }

  async function disconnect() {
    if (!transport) return;
    const current = transport;
    try {
      await current.close();
      transport = null;
      port = null;
      lastPort = null;
      bootromLatched = false;
      setStatus("idle", "Not connected");
      log("Serial port disconnected");
    } catch (error) {
      log(`Failed to close serial port: ${error.message}`, "error");
      setStatus("error", "Disconnect failed, try again");
    }
    updateControls();
  }

  const STAGE_NAMES = {
    handshake: "Enter BootROM",
    "boot-info": "Read chip info",
    "flash-config": "Configure flash",
    erase: "Erase flash",
    "erase-all": "Erase entire flash",
    verify: "Verify written data",
    hash: "Compute local SHA-256",
    done: "Flash complete",
  };

  function handleFlashProgress(value, stage, detail) {
    if (stage === "write" && detail) {
      setProgress(value, `Wrote ${formatSize(detail.written)} / ${formatSize(detail.total)}`);
      return;
    }
    setProgress(value, STAGE_NAMES[stage] || stage);
  }

  async function flashPineVoice() {
    const preset = pvImage;
    if (!transport || !preset || flashing) return;
    flashing = true;
    cancelled = false;
    updateControls();
    setStatus("working", "Flashing");
    setProgress(1, "Enter BootROM");
    try {
      const total = preset.segments.length;
      currentSegmentIndex = 0;
      const flasher = new BflbFlasher(transport, {
        onLog: (message, level) => {
          log(message, level);
          if (message.startsWith("Serial port at")) setStatus("working", "Flashing · 2,000,000 baud");
        },
        onProgress: (value, stage, detail) => handleFlashProgress(((currentSegmentIndex + value / 100) / total) * 100, stage, detail),
        isCancelled: () => cancelled,
      });
      const results = await PineVoiceFlash.flashSegments(flasher, preset, {
        chip: manifest?.chip || "bl606p",
        loadFile: async (file) => {
          const response = await fetch(`images/${file}`);
          if (!response.ok) throw new Error(`Could not read image ${file} (HTTP ${response.status})`);
          return new Uint8Array(await response.arrayBuffer());
        },
        onSegment: (index, count, segment, phase) => {
          if (phase === "start") {
            currentSegmentIndex = index;
            log(`[${index + 1}/${count}] ${segment.label} @ ${segment.address}（${formatSize(segment.size)}）`);
          } else {
            log(`[${index + 1}/${count}] ${segment.label} written and SHA-256 verified`, "success");
          }
        },
        autoResetFirst: elements.autoReset.checked && !bootromLatched,
        runAfterFlash: elements.runAfterFlash.checked,
      });
      const seconds = (results.reduce((sum, item) => sum + item.elapsedMs, 0) / 1000).toFixed(1);
      const first = results[0];
      setStatus("success", `${preset.id} flash complete · ${seconds} s`);
      bootromLatched = false;
      if (elements.autoFlash?.checked) {
        elements.autoFlash.checked = false;
        log("Auto-flash switched off so a later power-cycle cannot reflash by accident", "warn");
      }
      log(`All ${results.length} segments written and verified in ${seconds} s`, "success");
      log(`BootROM 0x${bytesToHex(first.bootInfo.slice(0, 4))} · Flash 0x${bytesToHex(first.jedec.slice(0, 3))} · config 0x${first.flashConfig.toString(16).padStart(8, "0")} · size ${formatSize(first.flashSize)}`);
      if (!elements.runAfterFlash.checked) log("Not started automatically: power-cycle the device to boot the new firmware", "warn");
    } catch (error) {
      const wasCancelled = error.name === "AbortError";
      setStatus(wasCancelled ? "idle" : "error", wasCancelled ? "Cancelled" : "Flash failed");
      elements.stageText.textContent = wasCancelled ? "Operation cancelled" : error.message;
      log(error.message, wasCancelled ? "warn" : "error");
      if (!wasCancelled) log("The device may still be in BootROM - fix the issue and retry directly. If the new firmware does not boot, roll back with the 0.9.1 stock preset (see README)", "warn");
    } finally {
      flashing = false;
      cancelled = false;
      updateControls();
    }
  }

  async function flash() {
    if (pvImage) {
      await flashPineVoice();
      return;
    }
    if (!transport || !image || flashing) return;
    flashing = true;
    cancelled = false;
    updateControls();
    setStatus("working", "Flashing");
    setProgress(1, "Enter BootROM");
    try {
      const flasher = new BflbFlasher(transport, {
        onLog: (message, level) => {
          log(message, level);
          if (message.startsWith("Serial port at")) setStatus("working", "Flashing · 2,000,000 baud");
        },
        onProgress: handleFlashProgress,
        isCancelled: () => cancelled,
      });
      const result = await flasher.flashWhole(image, {
        chip: elements.chipSelect.value || undefined,
        autoReset: elements.autoReset.checked && !bootromLatched,
        eraseAll: elements.eraseAll.checked,
        runAfterFlash: elements.runAfterFlash.checked,
      });
      const seconds = (result.elapsedMs / 1000).toFixed(1);
      setStatus("success", `${result.chip.toUpperCase()} flash complete · ${seconds} s`);
      bootromLatched = false;
      if (elements.autoFlash?.checked) {
        elements.autoFlash.checked = false;
        log("Auto-flash switched off so a later power-cycle cannot reflash by accident", "warn");
      }
      log(`Flash and verification complete in ${seconds} s`, "success");
    } catch (error) {
      const wasCancelled = error.name === "AbortError";
      setStatus(wasCancelled ? "idle" : "error", wasCancelled ? "Cancelled" : "Flash failed");
      elements.stageText.textContent = wasCancelled ? "Operation cancelled" : error.message;
      log(error.message, wasCancelled ? "warn" : "error");
    } finally {
      flashing = false;
      cancelled = false;
      updateControls();
    }
  }

  function initialize() {
    if (!navigator.serial) {
      elements.supportNotice.hidden = false;
      elements.connectButton.disabled = true;
      setStatus("error", "Browser does not support Web Serial");
    }

    elements.connectButton.addEventListener("click", connect);
    elements.disconnectButton.addEventListener("click", disconnect);
    elements.flashButton.addEventListener("click", flash);
    elements.chipSelect.addEventListener("change", () => {
      if (image) elements.fileMeta.textContent = `${formatSize(image.length)} · ${elements.chipSelect.value ? elements.chipSelect.value.toUpperCase() : "Auto-detect"} · write address 0x00000000`;
    });
    elements.cancelButton.addEventListener("click", () => {
      cancelled = true;
      elements.cancelButton.disabled = true;
      elements.stageText.textContent = "Stopping";
    });
    elements.clearLogButton.addEventListener("click", () => elements.log.replaceChildren());
    elements.saveLogButton.addEventListener("click", () => {
      const text = [...elements.log.querySelectorAll(".log-row")].map((row) => row.textContent).join("\n");
      const blob = new Blob([`${text}\n`], { type: "text/plain" });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = `bflb-flash-log-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`;
      link.click();
      URL.revokeObjectURL(link.href);
    });
    elements.pvImageSelect.addEventListener("change", () => {
      const selected = manifest?.images.find((entry) => entry.id === elements.pvImageSelect.value);
      pvImage = selected || null;
      if (pvImage) {
        image = null;
        elements.fileName.textContent = pvImage.label;
        const end = Math.max(...pvImage.segments.map((segment) => parseInt(segment.address, 16) + segment.size));
        elements.fileMeta.textContent = `${pvImage.segments.length} segments · writes 0x${parseInt(pvImage.segments[0].address, 16).toString(16).toUpperCase()}–0x${(end - 1).toString(16).toUpperCase()} · chip ${(manifest?.chip || "bl606p").toUpperCase()}`;
        elements.dropZone.classList.remove("has-file");
        setProgress(0, "Preset image ready");
        log(`Selected preset ${pvImage.label}`);
      } else {
        elements.fileName.textContent = "Select or drop whole.bin";
        elements.fileMeta.textContent = "whole.bin · write address 0x00000000";
      }
      updateControls();
    });
    fetch("images/manifest.json")
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      })
      .then((data) => {
        manifest = data;
        for (const entry of data.images) {
          const option = document.createElement("option");
          option.value = entry.id;
          option.textContent = entry.label;
          elements.pvImageSelect.append(option);
        }
        log(`Loaded ${data.images.length} PineVoice preset images (${data.images.map((entry) => entry.id).join(", ")})`);
      })
      .catch(() => {
        elements.pvRow.hidden = true;
      });
    elements.fileInput.addEventListener("change", async () => {
      try {
        await chooseFile(elements.fileInput.files[0]);
      } catch (error) {
        log(error.message, "error");
      }
    });
    elements.dropZone.addEventListener("dragover", (event) => {
      event.preventDefault();
      elements.dropZone.classList.add("dragging");
    });
    elements.dropZone.addEventListener("dragleave", () => elements.dropZone.classList.remove("dragging"));
    elements.dropZone.addEventListener("drop", async (event) => {
      event.preventDefault();
      elements.dropZone.classList.remove("dragging");
      try {
        await chooseFile(event.dataTransfer.files[0]);
      } catch (error) {
        log(error.message, "error");
      }
    });
    navigator.serial?.addEventListener("disconnect", (event) => {
      if (event.target === port) {
        transport = null;
        port = null;
        bootromLatched = false;
        flashing = false;
        setStatus("error", "Device disconnected");
        log("Serial device disconnected - power it on with the ring held and this page latches the BootROM again", "warn");
        updateControls();
      }
    });
    // Chrome fires this for the port once it has been granted, so a power-cycle
    // into BootROM is picked up without touching the page.
    navigator.serial?.addEventListener("connect", (event) => {
      if (event.target !== lastPort) return;
      if (transport && !transport.closed) return;
      log("Device appeared on USB - connecting and latching BootROM");
      connect();
    });
    updateControls();
  }

  initialize();
})();
