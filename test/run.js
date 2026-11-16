/* End-to-end test for the PineVoice Chrome flasher.
 *
 * Runs the real BflbFlasher + pvflash segment loop (the same code the browser
 * runs) against a mock BL606P BootROM that implements the bflb_iot_tool UART
 * protocol: handshake, GET_BOOT_INFO, CLOCK_SET, FLASH_SET_PARA, JEDEC,
 * ERASE, WRITE, WRITE_CHECK and XIP SHA-256 verify.
 *
 * The mock computes XIP SHA over the bytes it actually received, so a
 * successful run proves the written flash contents equal the manifest images
 * byte-for-byte, at the right addresses, without touching boot2 or kv.
 *
 * Run: node test/run.js
 */
"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const repoRoot = path.join(__dirname, "..");
const { BflbFlasher } = require(path.join(repoRoot, "loader.js"));
const { flashSegments } = require(path.join(repoRoot, "pvflash.js"));
const manifest = require(path.join(repoRoot, "images", "manifest.json"));

const FLASH_SIZE = 0x1000000;
const BOOT2_END = 0xe000;
const KV_START = 0xfa0000;
const BOOT2_SENTINEL = 0x5a;
const KV_SENTINEL = 0xc7;
const BOOT_CMDS = new Set([0x10, 0x11, 0x17, 0x18, 0x19, 0x1a, 0x23, 0x50]);

function findSequence(haystack, needle) {
  outer: for (let index = 0; index <= haystack.length - needle.length; index += 1) {
    for (let inner = 0; inner < needle.length; inner += 1) {
      if (haystack[index + inner] !== needle[inner]) continue outer;
    }
    return index;
  }
  return -1;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class MockBrom {
  constructor(options = {}) {
    this.baudRate = 2000000;
    this.readError = null;
    this.rx = [];
    this.flash = new Uint8Array(FLASH_SIZE).fill(0xff);
    this.flash.fill(BOOT2_SENTINEL, 0, BOOT2_END);
    this.flash.fill(KV_SENTINEL, KV_START, KV_START + 64);
    this.bootInfo = new Uint8Array([0x01, 0x00, 0x06, 0x06, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    this.jedec = new Uint8Array([0xef, 0x40, 0x18, options.jedec3 ?? 0x80]);
    this.clockSetPayloads = [];
    this.setParaPayloads = [];
    this.eraseRanges = [];
    this.writeRanges = [];
    this.commands = [];
  }

  push(bytes) {
    for (const byte of bytes) this.rx.push(byte);
  }

  pushAck(status = "OK") {
    this.push(Array.from(Buffer.from(status, "ascii")));
  }

  pushResponse(payload) {
    this.pushAck("OK");
    this.push([payload.length & 0xff, (payload.length >>> 8) & 0xff]);
    this.push(payload);
  }

  async waitForBytes(count, timeoutMs, what) {
    const deadline = Date.now() + timeoutMs;
    while (this.rx.length < count) {
      if (Date.now() > deadline) {
        throw new Error(`MockBrom timeout waiting for ${what} (have ${this.rx.length}, want ${count})`);
      }
      await sleep(2);
    }
  }

  clearInput() {
    this.rx = [];
  }

  async readUntil(sequence, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const index = findSequence(this.rx, sequence);
      if (index >= 0) {
        const out = this.rx.splice(0, index + sequence.length);
        return new Uint8Array(out);
      }
      if (Date.now() > deadline) throw new Error("MockBrom: handshake response timeout");
      await sleep(2);
    }
  }

  async readAck(timeoutMs = 3000) {
    await this.waitForBytes(2, timeoutMs, "ack");
    const text = String.fromCharCode(this.rx[0], this.rx[1]);
    if (text === "OK" || text === "PD") {
      this.rx.splice(0, 2);
      return { status: text };
    }
    if (text === "FL") {
      await this.waitForBytes(4, timeoutMs, "error code");
      const code = this.rx[2] | (this.rx[3] << 8);
      this.rx.splice(0, 4);
      throw new Error(`Device returned error 0x${code.toString(16).padStart(4, "0")}`);
    }
    const raw = this.rx.splice(0, 2);
    throw new Error(`MockBrom: invalid ack 0x${raw.map((b) => b.toString(16).padStart(2, "0")).join("")}`);
  }

  async readResponse(timeoutMs = 3000) {
    const ack = await this.readAck(timeoutMs);
    if (ack.status !== "OK") throw new Error(`MockBrom: unexpected status ${ack.status}`);
    await this.waitForBytes(2, timeoutMs, "response length");
    const length = this.rx[0] | (this.rx[1] << 8);
    this.rx.splice(0, 2);
    await this.waitForBytes(length, timeoutMs, "response payload");
    return new Uint8Array(this.rx.splice(0, length));
  }

  async setSignals() {
    /* DTR/RTS ignored by the mock */
  }

  async write(bytes) {
    if (bytes.every((byte) => byte === 0x55)) {
      this.pushAck("OK");
      return;
    }
    const command = bytes[0];
    const declared = bytes[2] | (bytes[3] << 8);
    assert.strictEqual(bytes.length, 4 + declared, `frame length mismatch for cmd 0x${command.toString(16)}`);
    const payload = bytes.slice(4);
    let expected = 0;
    if (!BOOT_CMDS.has(command)) {
      expected = (bytes[2] + bytes[3] + payload.reduce((sum, byte) => sum + byte, 0)) & 0xff;
    } else {
      expected = 0;
    }
    if (bytes[1] !== expected) {
      this.pushAck("FL");
      this.push([0x03, 0x01]); // CMD_CRC_ERROR
      return;
    }
    this.commands.push(command);
    switch (command) {
      case 0x10: // GET_BOOT_INFO
        this.pushResponse(this.bootInfo);
        return;
      case 0x22: // CLOCK_SET
        this.clockSetPayloads.push(payload.slice());
        this.pushAck("OK");
        return;
      case 0x3b: // FLASH_SET_PARA
        this.setParaPayloads.push(payload.slice());
        this.pushAck("OK");
        return;
      case 0x36: // FLASH_READ_JEDEC_ID
        this.pushResponse(this.jedec);
        return;
      case 0x30: { // FLASH_ERASE
        const start = payload[0] | (payload[1] << 8) | (payload[2] << 16) | (payload[3] << 24);
        const end = payload[4] | (payload[5] << 8) | (payload[6] << 16) | (payload[7] << 24);
        this.eraseRanges.push([start, end]);
        assert.ok(start <= end, `erase start ${start} > end ${end}`);
        assert.ok(start >= BOOT2_END, `erase 0x${start.toString(16)} touches boot2 region`);
        assert.ok(end < KV_START, `erase end 0x${end.toString(16)} touches kv region`);
        this.flash.fill(0xff, start, end + 1);
        this.pushAck("OK");
        return;
      }
      case 0x31: { // FLASH_WRITE
        const address = payload[0] | (payload[1] << 8) | (payload[2] << 16) | (payload[3] << 24);
        const data = payload.slice(4);
        this.writeRanges.push([address, data.length]);
        assert.ok(address >= BOOT2_END, `write 0x${address.toString(16)} touches boot2 region`);
        assert.ok(address + data.length <= KV_START, `write ending0x${(address + data.length).toString(16)} touches kv region`);
        this.flash.set(data, address);
        this.pushAck("OK");
        return;
      }
      case 0x3a: // FLASH_WRITE_CHECK
      case 0x33: // FLASH_BOOT
      case 0x23: // SET_TIMEOUT
      case 0x50: // MEMORY_WRITE
      case 0x60: // FLASH_XIP_READ_START
      case 0x61: // FLASH_XIP_READ_FINISH
        this.pushAck("OK");
        return;
      case 0x3e: { // FLASH_XIP_READ_SHA
        const start = payload[0] | (payload[1] << 8) | (payload[2] << 16) | (payload[3] << 24);
        const length = payload[4] | (payload[5] << 8) | (payload[6] << 16) | (payload[7] << 24);
        const digest = crypto.createHash("sha256").update(this.flash.subarray(start, start + length)).digest();
        this.pushResponse(new Uint8Array(digest));
        return;
      }
      default:
        this.pushAck("FL");
        this.push([0x01, 0x01]); // CMD_ID_ERROR
        throw new Error(`MockBrom: unexpected command 0x${command.toString(16)}`);
    }
  }
}

function loadSegmentFile(relative) {
  return new Uint8Array(fs.readFileSync(path.join(repoRoot, "images", relative)));
}

function flashEqualsManifestSegment(mock, segment) {
  const address = parseInt(segment.address, 16);
  const expected = loadSegmentFile(segment.file);
  const actual = mock.flash.subarray(address, address + expected.length);
  assert.ok(Buffer.from(actual).equals(Buffer.from(expected)), `flash contents at ${segment.address} differ from ${segment.file}`);
}

async function runImage(image, options = {}) {
  const mock = new MockBrom(options);
  const logs = [];
  const flasher = new BflbFlasher(mock, {
    onLog: (message) => logs.push(message),
    onProgress: () => {},
    isCancelled: () => false,
  });
  const results = await flashSegments(flasher, image, {
    chip: manifest.chip,
    loadFile: loadSegmentFile,
    autoResetFirst: false,
    runAfterFlash: true,
    onSegment: () => {},
  });
  return { mock, flasher, results, logs };
}

async function testImage(image) {
  const { mock, results } = await runImage(image);

  assert.strictEqual(results.length, image.segments.length, "segment count");
  assert.strictEqual(results[0].flashSize, FLASH_SIZE, "flash size from JEDEC");
  assert.strictEqual(results[0].flashConfig, 0x014180, "flash config word");

  for (const result of results) {
    assert.strictEqual(result.sha256, result.segment.sha256.toLowerCase(), `segment ${result.segment.label} sha`);
    flashEqualsManifestSegment(mock, result.segment);
  }

  // boot2 and kv regions must be untouched
  for (let offset = 0; offset < BOOT2_END; offset += 1) {
    assert.strictEqual(mock.flash[offset], BOOT2_SENTINEL, `boot2 byte ${offset} modified`);
  }
  for (let offset = KV_START; offset < KV_START + 64; offset += 1) {
    assert.strictEqual(mock.flash[offset], KV_SENTINEL, `kv byte ${offset} modified`);
  }

  // erase ranges stay inside the partition window
  for (const [start, end] of mock.eraseRanges) {
    assert.ok(start >= BOOT2_END && end < KV_START, `erase range 0x${start.toString(16)}-0x${end.toString(16)} out of bounds`);
  }

  // CLOCK_SET: irq=1, baud=2000000, then the SDK clock_para.bin (28 bytes)
  const clockPara = fs.readFileSync(path.join(repoRoot, "targets", "bl606p", "clock_para.bin"));
  assert.ok(mock.clockSetPayloads.length >= 1, "CLOCK_SET sent");
  for (const payload of mock.clockSetPayloads) {
    assert.strictEqual(payload.length, 8 + clockPara.length, "CLOCK_SET payload length");
    assert.deepStrictEqual(Array.from(payload.slice(0, 4)), [1, 0, 0, 0], "CLOCK_SET irq flag");
    assert.strictEqual(payload[4] | (payload[5] << 8) | (payload[6] << 16) | (payload[7] << 24), 2000000, "CLOCK_SET baud");
    assert.ok(Buffer.from(payload.slice(8)).equals(clockPara), "CLOCK_SET clock_para bytes");
  }

  // FLASH_SET_PARA: with jedec[3] == 0x80 only the 4-byte config word is sent
  for (const payload of mock.setParaPayloads) {
    assert.strictEqual(payload.length, 4, "SET_PARA payload length (jedec[3]=0x80 path)");
    assert.deepStrictEqual(Array.from(payload), [0x80, 0x41, 0x01, 0x00], "SET_PARA config word 0x014180");
  }

  // the sequence ends with a run reset
  console.log(`  ok ${image.id}: ${results.length} segments, ${mock.eraseRanges.length} erases, ${mock.writeRanges.length} writes, config 0x014180`);
}

async function testFlashParametersPath() {
  // jedec[3] != 0x80 must trigger the second SET_PARA with flash_para.bin appended
  const image = manifest.images[0];
  const { mock } = await runImage(image, { jedec3: 0x01 });
  const flashPara = fs.readFileSync(path.join(repoRoot, "targets", "bl606p", "flash_para.bin"));
  const withPara = mock.setParaPayloads.filter((payload) => payload.length > 4);
  assert.ok(withPara.length >= 1, "SET_PARA with flash parameters sent when jedec[3] != 0x80");
  for (const payload of withPara) {
    assert.strictEqual(payload.length, 4 + flashPara.length, "SET_PARA+para payload length");
    assert.ok(Buffer.from(payload.slice(4)).equals(flashPara), "SET_PARA flash_para.bin bytes");
  }
  console.log("  ok jedec[3]!=0x80 path: flash_para.bin appended to FLASH_SET_PARA");
}

async function testCorruptedImageRejected() {
  const image = JSON.parse(JSON.stringify(manifest.images[0]));
  image.segments[0].sha256 = "0".repeat(64);
  const mock = new MockBrom();
  const flasher = new BflbFlasher(mock, { onLog: () => {}, onProgress: () => {}, isCancelled: () => false });
  await assert.rejects(
    () => flashSegments(flasher, image, {
      chip: manifest.chip,
      loadFile: loadSegmentFile,
      autoResetFirst: false,
      runAfterFlash: false,
      onSegment: () => {},
    }),
    /SHA-256 mismatch/,
    "corrupted manifest entry must be rejected before flashing",
  );
  assert.strictEqual(mock.commands.length, 0, "no flash commands issued for a corrupted image");
  console.log("  ok corrupted image rejected before any flash command");
}

async function main() {
  console.log(`PineVoice flasher test — chip ${manifest.chip}, ${manifest.images.length} images`);
  for (const image of manifest.images) {
    await testImage(image);
  }
  await testFlashParametersPath();
  await testCorruptedImageRejected();
  console.log("ALL TESTS PASSED");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
