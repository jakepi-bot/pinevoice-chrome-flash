/* PineVoice preset-image flashing: fetch -> SHA-256 check -> per-segment
 * erase/write/verify through the shared BflbFlasher. Each segment is written
 * at its manifest address so boot2 (0x0-0xDFFF) and the kv/factory/user
 * partitions (0xFA0000+) are never erased or written. */
(function (root, factory) {
  "use strict";
  const isNode = typeof module !== "undefined" && module.exports;
  const api = factory(isNode);
  root.PineVoiceFlash = api;
  if (isNode) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : window, function (isNode) {
  "use strict";

  async function sha256Hex(data) {
    let digest;
    if (isNode) {
      const nodeCrypto = require("node:crypto");
      digest = new Uint8Array(nodeCrypto.createHash("sha256").update(data).digest());
    } else {
      if (!globalThis.crypto?.subtle) throw new Error("当前环境不支持 SHA-256");
      digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", data));
    }
    return Array.from(digest, (value) => value.toString(16).padStart(2, "0")).join("");
  }

  async function flashSegments(flasher, image, options) {
    if (!image || !Array.isArray(image.segments) || !image.segments.length) {
      throw new Error("预设镜像没有可写的段");
    }
    const total = image.segments.length;
    const results = [];
    const cache = new Map();
    for (let index = 0; index < total; index += 1) {
      const segment = image.segments[index];
      options.onSegment?.(index, total, segment, "start");
      let data = cache.get(segment.file);
      if (!data) {
        data = await options.loadFile(segment.file);
        if (!(data instanceof Uint8Array)) data = new Uint8Array(data);
        cache.set(segment.file, data);
      }
      if (data.length !== segment.size) {
        throw new Error(`镜像 ${segment.file} 大小不符：实际 ${data.length}，清单 ${segment.size}`);
      }
      const localSha = await sha256Hex(data);
      if (localSha !== String(segment.sha256).toLowerCase()) {
        throw new Error(`镜像 ${segment.file} SHA-256 不匹配：实际 ${localSha}，清单 ${segment.sha256}`);
      }
      const result = await flasher.flash(data, {
        chip: options.chip,
        address: parseInt(segment.address, 16) >>> 0,
        autoReset: index === 0 ? options.autoResetFirst !== false : false,
        eraseAll: false,
        runAfterFlash: false,
      });
      results.push({
        segment,
        sha256: localSha,
        elapsedMs: result.elapsedMs,
        jedec: result.jedec,
        flashSize: result.flashSize,
        flashConfig: result.flashConfig,
        flashPin: result.flashPin,
        bootInfo: result.bootInfo,
        version: result.version,
      });
      options.onSegment?.(index, total, segment, "done", result);
    }
    if (options.runAfterFlash !== false) await flasher.resetToRun();
    return results;
  }

  return Object.freeze({ flashSegments, sha256Hex });
});
