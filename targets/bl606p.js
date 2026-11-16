/* BL606P target definition (PineVoice), mirroring the bootrom-load config in
 * bflb_iot_tool chips/bl606p/eflash_loader/eflash_loader_cfg.ini (load_function = 2). */
(function (root, factory) {
  "use strict";
  const isNode = typeof module !== "undefined" && module.exports;
  const common = isNode ? require("./common.js") : root.BflbFlashTargetCommon;
  const api = factory(common);
  root.BflbFlashTargetBL606P = api;
  if (isNode) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : window, function (common) {
  "use strict";

  const CONFIG = common.uartConfig({
    chip: "bl606p",
    loadFunction: 2,        // LOAD_CFG load_function = 2 (bootrom load, no helper)
    flashClock: 0x41,       // FLASH_CFG flash_clock_cfg = 0x41
    flashClockDelay: 0,     // FLASH_CFG flash_clock_delay = 0
    flashIoMode: 1,         // FLASH_CFG flash_io_mode = 1
    flashPin: 0x80,         // FLASH_CFG flash_pin = 0x80 (bit7 = take pin from bootinfo)
    eraseTimeoutMs: 100000, // LOAD_CFG erase_time_out = 100000
    clockParameters: "targets/bl606p/clock_para.bin", // LOAD_CFG clock_para
    flashParameters: "targets/bl606p/flash_para.bin", // FLASH_CFG flash_para
  });

  // bflb_iot_tool does not validate the BL606P boot-info id, so accept any
  // boot info when BL606P is selected explicitly. autoDetect keeps this target
  // out of the auto-probe loop so the permissive matcher cannot hijack detection.
  function detectVersion(bootInfo) {
    if (!bootInfo || bootInfo.length < 12) throw new Error("Invalid BL606P BootInfo length");
    return "brom";
  }

  // bflb_iot_tool flash_get_pin_from_bootinfo(): bl606p falls through to 0x80.
  function flashPinFromBootInfo() {
    return 0x80;
  }

  // pin 0x80 | clock 0x41 << 8 | io mode 1 << 16 | clock delay 0 << 24 = 0x014180
  function flashConfigFromBootInfo(bootInfo) {
    return (0x01 << 16) | (0x41 << 8) | (flashPinFromBootInfo(bootInfo) & 0xff);
  }

  return Object.freeze({
    CHIP_NAME: "bl606p",
    CONFIG,
    autoDetect: false,
    detectVersion,
    flashPinFromBootInfo,
    flashConfigFromBootInfo,
  });
});
